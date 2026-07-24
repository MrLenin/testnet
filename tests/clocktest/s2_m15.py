#!/usr/bin/env python3
"""Scenario #2 (m15): skew delete-on-leave.

nef4 runs +30 s ahead (static boot skew). A user homed on nef4 gets +o on a
channel (member_status SET stamped ~+30 s in the future), then PARTs -> nef4
mints the m15 delete-on-leave DELETE (also future-stamped). The user then
reconnects on nef5 (0 offset, 30 s "behind" those stamps) and rejoins.

PASS:
 - after rejoin, the user is NOT opped anywhere (no stale +o materializes);
 - a fresh re-op issued from a 0-offset node lands and STICKS through two
   verify cycles on the +30 node too (the doc accepts a SET whose HLC
   physical is ~30 s lower than the neighboring tombstone's — receive-
   advance ordering, no spurious suppression);
 - the orphan member-meta reap does NOT fire (delete-on-leave already
   cleaned the doc; the reap is the backstop that would catch a failure);
 - digests converge; no restarts.
"""
import sys
import time

from ircdrv import (Irc, open_opers, close_all, report_digests, restart_counts,
                    dlog, wait_converged, NODES)

CHAN = '#ct%d' % int(time.time())


def names(c, chan):
    c.drain(0.1)
    c.send('NAMES ' + chan)
    nicks = []

    def coll(p):
        if p['cmd'] == '353' and p['trail']:
            nicks.extend(p['trail'].split())
    c.wait(lambda p: p['cmd'] == '366', 10, on_line=coll)
    return nicks


def plain(n):
    return n.lstrip('@+%~&!')


def has(ns, nick):
    return any(plain(x) == nick for x in ns)


def opped(ns, nick):
    return any(x.startswith('@') and plain(x) == nick for x in ns)


def until(fn, timeout=15, poll=0.5, desc=''):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(poll)
    print('  TIMEOUT waiting for: ' + desc)
    return False


opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'])
anchor = Irc('nef3', 'ctm15anc').connect()
a1 = Irc('nef4', 'ctm15a').connect()
t0 = time.time()
try:
    n4o, n5o = opers['nef4'], opers['nef5']

    anchor.send('JOIN ' + CHAN)
    anchor.wait(lambda p: p['cmd'] == 'JOIN', 10)
    a1.send('JOIN ' + CHAN)
    a1.wait(lambda p: p['cmd'] == 'JOIN', 10)
    ok_seen = until(lambda: has(names(anchor, CHAN), 'ctm15a'),
                    15, desc='A visible on nef3')

    anchor.send('MODE %s +o ctm15a' % CHAN)
    ok_op1 = until(lambda: opped(names(n5o, CHAN), 'ctm15a'), 15,
                   desc='@A propagated to nef5')
    print('setup: A joined on nef4 and opped; visible cross-server=%s op=%s'
          % (ok_seen, ok_op1))

    conv0, tc0, _ = wait_converged(opers, timeout=75)
    print('doc converged with +o in place: %s (%.1f s)' % (conv0, tc0))

    t_part = time.time()
    a1.send('PART %s :m15-part' % CHAN)
    a1.drain(1.0)
    a1.close()
    ok_gone = until(lambda: not has(names(anchor, CHAN), 'ctm15a'),
                    15, desc='A gone from channel on nef3')

    conv1, tc1, _ = wait_converged(opers, timeout=75)
    print('doc converged after PART: %s (%.1f s); A gone=%s' % (conv1, tc1, ok_gone))

    # rejoin from the clock-behind node
    a2 = Irc('nef5', 'ctm15b').connect()
    a2.send('JOIN ' + CHAN)
    a2.wait(lambda p: p['cmd'] == 'JOIN', 10)
    until(lambda: has(names(anchor, CHAN), 'ctm15b'), 15,
          desc='A2 visible on nef3')

    stale = {}
    for label, cli in (('nef3', anchor), ('nef4', n4o), ('nef5', n5o)):
        ns = names(cli, CHAN)
        stale[label] = opped(ns, 'ctm15b')
        print('  %s NAMES: %s' % (label, ns))
    ok_nostale = not any(stale.values())
    print('no stale +o after rejoin: %s' % ok_nostale)

    # legit re-op from the clock-behind side
    anchor.send('MODE %s +o ctm15b' % CHAN)
    ok_reop = until(lambda: opped(names(n4o, CHAN), 'ctm15b'), 15,
                    desc='re-op materialized on the +30 node')
    print('re-op landed on nef4 (+30 node): %s' % ok_reop)

    print('retention watch: 65 s (2 verify cycles)...')
    end = time.time() + 65
    while time.time() < end:
        for c in opers.values():
            c.drain(0.05)
        anchor.drain(0.05)
        a2.drain(0.05)
        time.sleep(1)

    keep4 = opped(names(n4o, CHAN), 'ctm15b')
    keep5 = opped(names(n5o, CHAN), 'ctm15b')
    ok_keep = keep4 and keep5
    print('re-op retained after 2 cycles: nef4=%s nef5=%s' % (keep4, keep5))

    reap = {n: dlog(cont, '%ds' % int(time.time() - t_part + 5),
                    r'orphan member-meta')
            for n, (cont, _) in NODES.items()}
    ok_noreap = all(len(v) == 0 for v in reap.values())
    for n, v in sorted(reap.items()):
        if v:
            print('  REAP FIRED on %s: %s' % (n, v[-1]))
    print('orphan member-meta reap silent (delete-on-leave did the cleanup): %s'
          % ok_noreap)

    conv2, tc2, snap = wait_converged(opers, timeout=75)
    print('final convergence: %s (%.1f s)' % (conv2, tc2))
    report_digests(snap)
    rc = restart_counts()
    ok_rc = all(v == '0' for v in rc.values())
    print('restart counts:', rc)

    verdict = (ok_seen and ok_op1 and conv0 and conv1 and ok_gone and
               ok_nostale and ok_reop and ok_keep and ok_noreap and conv2 and ok_rc)
    print('\nS2-M15 %s  (nostale=%s reop=%s retained=%s reap_silent=%s conv=%s no_restarts=%s)'
          % ('PASS' if verdict else 'FAIL', ok_nostale, ok_reop, ok_keep,
             ok_noreap, conv2, ok_rc))

    a2.send('PART %s :done' % CHAN)
    a2.drain(0.5)
    a2.close()
    sys.exit(0 if verdict else 1)
finally:
    anchor.close()
    close_all(opers)
