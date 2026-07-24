#!/usr/bin/env python3
"""Dense-observation rerun of the M8 CLEAR: exactly when does each node's
mirror drop the cleared key, and what does its reconcile log around then?"""
import subprocess
import time

from ircdrv import Irc, NODES

KEY = 'ct-m8b-key'
VAL = 'm8b-%d' % int(time.time())


def meta_get(c, target, key):
    c.drain(0.1)
    c.send('METADATA %s GET %s' % (target, key))
    val = [None]

    def coll(p):
        if p['cmd'] == '761' and key in p['args'] and p['trail'] is not None:
            val[0] = p['trail']
    try:
        c.wait(lambda p: p['cmd'] in ('762', '766') or p['cmd'] == 'FAIL' or
               (p['cmd'] == '761' and key in p['args']), 8, on_line=coll)
    except TimeoutError:
        pass
    return val[0]


def meta_list(c, target):
    c.drain(0.1)
    c.send('METADATA %s LIST' % target)
    keys = []

    def coll(p):
        if p['cmd'] == '761' and len(p['args']) >= 3:
            keys.append((p['args'][2], p['trail']))
    try:
        c.wait(lambda p: p['cmd'] in ('762', '766') or p['cmd'] == 'FAIL',
               8, on_line=coll)
    except TimeoutError:
        pass
    return keys


c1 = Irc('nef3', 'ctm8x').connect()
c1.cap_req('draft/metadata-2')
c1.send('PRIVMSG AuthServ :AUTH testadmin testadmin123')
time.sleep(2.5)
c1.drain(0.5)

probes = {}
for node in ('nef5', 'nef6'):
    p = Irc(node, 'ctmx' + node[-1]).connect()
    p.cap_req('draft/metadata-2')
    probes[node] = p

print('baseline LIST on nef3:', meta_list(c1, 'ctm8x'))

c1.send('METADATA * SET %s :%s' % (KEY, VAL))
c1.drain(1.0)
t = time.time()
while time.time() - t < 40:
    if meta_get(probes['nef5'], 'ctm8x', KEY) == VAL:
        break
    time.sleep(2)
print('SET converged to nef5 after %.0f s' % (time.time() - t))
print('pre-CLEAR LIST on nef3:', meta_list(c1, 'ctm8x'))

t_clear = time.time()
c1.send('METADATA * CLEAR')
c1.drain(1.0)
print('CLEAR issued at +0.0 s')

state = {n: 'stale' for n in ('nef3', 'nef5', 'nef6')}
first_clean = {}
last_log = time.time()
while time.time() - t_clear < 480:
    el = time.time() - t_clear
    vals = {'nef3': meta_get(c1, 'ctm8x', KEY),
            'nef5': meta_get(probes['nef5'], 'ctm8x', KEY),
            'nef6': meta_get(probes['nef6'], 'ctm8x', KEY)}
    for n, v in vals.items():
        if v is None and n not in first_clean:
            first_clean[n] = el
            print('+%5.0f s: %s went CLEAN' % (el, n))
    if all(v is None for v in vals.values()):
        print('+%5.0f s: all probed nodes clean' % el)
        break
    if time.time() - last_log >= 30:
        last_log = time.time()
        for n, (cont, _) in NODES.items():
            r = subprocess.run(['docker', 'logs', '--since', '35s', cont],
                               capture_output=True, text=True)
            for l in (r.stdout + r.stderr).splitlines():
                if 'metadata-reconcile' in l:
                    print('  [%s] %s' % (n, l.split('SYSTEM')[-1].strip()))
        print('+%5.0f s: state %s' % (el, {n: (v[:12] if v else None) for n, v in vals.items()}))
    time.sleep(10)

print('first-clean times:', {n: round(v) for n, v in first_clean.items()})
for c in probes.values():
    c.close()
c1.close()
