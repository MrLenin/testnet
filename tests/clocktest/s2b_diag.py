#!/usr/bin/env python3
"""Diagnose: does a held +o (set on a +30-skewed member) keep the doc digest
diverged until removed? Prints per-node digest state every ~5 s through
join -> +o -> hold -> PART -> hold."""
import time

from ircdrv import Irc, open_opers, close_all, mesh_digests

CHAN = '#ctdg%d' % int(time.time())


def sweep(opers, tag):
    d = mesh_digests(opers)
    vals = {}
    for n, s in sorted(d.items()):
        vals.setdefault((s['digest'], s['mdigest']), []).append(n)
    uniq = len(vals)
    line = ' | '.join('%s:%s' % ('+'.join(nodes), '%s/%s' % k[:2])
                      for k, nodes in sorted(vals.items(), key=lambda kv: -len(kv[1])))
    print('%-12s groups=%d  %s' % (tag, uniq, line))
    return uniq == 1


opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'])
anchor = Irc('nef3', 'ctdgA').connect()
a1 = Irc('nef4', 'ctdgB').connect()
try:
    sweep(opers, 'baseline')
    anchor.send('JOIN ' + CHAN)
    a1.send('JOIN ' + CHAN)
    anchor.drain(0.5)
    a1.drain(0.5)
    anchor.send('MODE %s +o ctdgB' % CHAN)
    anchor.drain(0.5)
    t0 = time.time()
    for i in range(16):
        sweep(opers, '+o held %ds' % int(time.time() - t0))
        end = time.time() + 5
        while time.time() < end:
            for c in opers.values():
                c.drain(0.05)
            anchor.drain(0.05)
            a1.drain(0.05)
            time.sleep(0.5)
    a1.send('PART %s :diag' % CHAN)
    a1.drain(0.5)
    t1 = time.time()
    for i in range(6):
        sweep(opers, 'parted %ds' % int(time.time() - t1))
        time.sleep(5)
finally:
    a1.close()
    anchor.close()
    close_all(opers)
