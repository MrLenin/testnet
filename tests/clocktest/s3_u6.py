#!/usr/bin/env python3
"""Scenario #3 (U6): forward-step must not mass-reap stubs/overlays.

Manufacture a REAL mesh stub: netns-sidecar partition of nef6's P10 socket to
nef4 (its overlay to nef3 stays up, so nef6 remains mesh-reachable and its
beacons keep arriving at nef4 relayed via the mesh). nef4 converts nef6 to a
mesh stub. Then clockstep nef4 +120: under wall-clock staleness math the
stub's beacon age instantly reads 120-150 s > the 90 s stale threshold and
would be retired on the next check; the U6 fix keys retirement on miss_ticks
(consecutive beaconless verify ticks), which stay 0 because beacons still
arrive. PASS = stub survives 3+ ticks under the step, no retire logs, heal
restores the link and the stub resolves, mesh converges, no crash-restarts.

Cleanup: heal rules, remove sidecar, docker-restart nef4 (stepped +120).
"""
import re
import subprocess
import sys
import time

from ircdrv import Irc, open_opers, close_all, report_digests, wait_converged, dlog, NODES

NEF4_IP = '172.29.0.7'
SIDECAR = 'ctns_nefarious6'
RETIRE_RX = r'mesh beacon stale|retiring mesh stub|retire.*stub'


def sh(*args):
    return subprocess.run(list(args), capture_output=True, text=True)


def status_counts(c):
    s = c.crdt_status()
    txt = '\n'.join(s['lines'])
    g = lambda rx: (lambda m: int(m.group(1)) if m else None)(re.search(rx, txt))
    part = re.search(r'partitioned=(\S+)', txt)
    return {'reachable': g(r'mesh reachable=(\d+)'),
            'stubs': g(r'(\d+) stub'),
            'partitioned': part.group(1) if part else None}


def probe(opers, n):
    try:
        return status_counts(opers[n])
    except (TimeoutError, OSError):
        try:
            opers[n].close()
        except Exception:
            pass
        opers[n] = Irc(n, 'ctU6%s%d' % (n[-1], int(time.time()) % 100)).connect().oper()
        return status_counts(opers[n])


def until(fn, timeout, poll=5, desc=''):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(poll)
    print('  TIMEOUT: ' + desc)
    return False


def partition_up():
    sh('docker', 'rm', '-f', SIDECAR)
    r = sh('docker', 'run', '-d', '--name', SIDECAR,
           '--net=container:nefarious6', '--cap-add', 'NET_ADMIN',
           'nicolaka/netshoot', 'sleep', 'infinity')
    if r.returncode != 0:
        print('sidecar start FAILED: %s' % r.stderr.strip())
        return False
    for chain, flag in (('OUTPUT', '-d'), ('INPUT', '-s')):
        sh('docker', 'exec', SIDECAR, 'iptables-nft', '-A', chain, flag, NEF4_IP, '-j', 'DROP')
    sh('docker', 'exec', SIDECAR, 'ss', '-K', 'dst', NEF4_IP)
    return True


def partition_heal():
    for chain, flag in (('OUTPUT', '-d'), ('INPUT', '-s')):
        sh('docker', 'exec', SIDECAR, 'iptables-nft', '-D', chain, flag, NEF4_IP, '-j', 'DROP')


def partition_down():
    sh('docker', 'rm', '-f', SIDECAR)


opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='ctU6o')
verdict = False
try:
    base = {n: probe(opers, n) for n in ('nef3', 'nef4')}
    print('baseline: %s' % base)
    ok_base = all(v['reachable'] is not None and (v['stubs'] or 0) == 0
                  for v in base.values())

    print('partitioning nef6 <-> nef4 (P10 socket; overlay via nef3 stays)...')
    if not partition_up():
        sys.exit(1)

    ok_stub = until(lambda: (probe(opers, 'nef4').get('stubs') or 0) >= 1, 90,
                    desc='nef4 converts nef6 to a mesh stub')
    v4 = probe(opers, 'nef4')
    v3 = probe(opers, 'nef3')
    print('post-partition: nef4=%s nef3=%s' % (v4, v3))
    stub_base = v4['stubs'] or 0
    ok_reach = v3['reachable'] == base['nef3']['reachable']
    print('stub formed=%s; nef6 still mesh-reachable (nef3 view)=%s' % (ok_stub, ok_reach))

    t_step = time.time()
    try:
        print('clockstep +120 on nef4 ->', opers['nef4'].clockstep(+120))
    except (TimeoutError, OSError):
        print('clockstep reply lost; continuing (log will confirm)')

    ok_survive = True
    while time.time() - t_step < 115:   # > 3 verify ticks
        time.sleep(20)
        v4 = probe(opers, 'nef4')
        el = time.time() - t_step
        print('  +%3.0f s nef4: stubs=%s reachable=%s' % (el, v4['stubs'], v4['reachable']))
        if (v4['stubs'] or 0) < stub_base:
            ok_survive = False
    retires = dlog('nefarious4', '%ds' % int(time.time() - t_step + 5), RETIRE_RX)
    for l in retires[-2:]:
        print('  RETIRE LOG on nef4: %s' % l)
    ok_noretire = not retires
    print('stub survived the +120 step 3 ticks=%s; retire-log clean=%s'
          % (ok_survive, ok_noretire))

    print('healing partition...')
    partition_heal()
    def relinked():
        v = probe(opers, 'nef4')
        return (v['stubs'] or 0) == 0
    ok_heal = until(relinked, 150, desc='P10 relink + stub resolution')
    if not ok_heal:
        # force the uplink from nef6's side, then wait again
        try:
            opers['nef6'].send('CONNECT leaf2.fractalrealities.net')
            opers['nef6'].drain(1.0)
        except (TimeoutError, OSError):
            pass
        ok_heal = until(relinked, 120, desc='forced relink')
    print('healed (stub resolved on nef4): %s' % ok_heal)

    conv, tc, snap = wait_converged(opers, timeout=120)
    print('converged: %s (%.1f s)' % (conv, tc))
    report_digests(snap)
    rc = {n: sh('docker', 'inspect', '-f', '{{.RestartCount}}', c).stdout.strip()
          for n, (c, _) in NODES.items()}
    ok_rc = all(v == '0' for v in rc.values())
    print('restart counts:', rc)

    verdict = (ok_base and ok_stub and ok_reach and ok_survive and ok_noretire
               and ok_heal and conv and ok_rc)
    print('\nS3-U6 %s  (stub=%s reach=%s survive=%s noretire=%s heal=%s conv=%s no_restarts=%s)'
          % ('PASS' if verdict else 'FAIL', ok_stub, ok_reach, ok_survive,
             ok_noretire, ok_heal, conv, ok_rc))
finally:
    close_all(opers)
    partition_down()

print('cleanup: restarting nefarious4 (reset +120 offset)...')
sh('docker', 'restart', 'nefarious4')
sys.exit(0 if verdict else 1)
