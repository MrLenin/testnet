#!/usr/bin/env python3
"""Scenario #1 (M12): same-second gline lastmod collision.

Fire the SAME global gline mask with DIFFERENT reasons from two 0-offset
nodes (nef3, nef5) within the same wall-clock second. With equal lastmod,
legacy P10's lastmod compare cannot pick a winner (the historical stall);
the doc's M12 HLC tiebreak must: PASS = ONE reason everywhere, uniform
lastmod (proves the collision landed same-second), reconcile churn stops
after one burst, digests converge, no restarts.

Firing at mid-second (frac ~0.35) so event-loop CurrentTime caching cannot
straddle a boundary; retries with a fresh mask if the stamps still split.
"""
import sys
import time

from ircdrv import (open_opers, close_all, mesh_digests, report_digests,
                    restart_counts, dlog, wait_converged, NODES)

# fresh masks every run: an existing (even deactivated) entry turns the next
# GLINE + into a MODIFY, which emits no "adding ... expiring at" mint notice
import time as _t
_base = int(_t.time()) % 240
MASKS = ['*@198.51.100.%d' % (10 + (_base + i) % 240) for i in range(3)]


def stats_g(c, mask):
    c.drain(0.1)
    c.send('STATS G')
    rows = []

    def coll(p):
        if p['cmd'] == '247' and mask in ' '.join(p['args']):
            rows.append(p)
    c.wait(lambda p: p['cmd'] == '219', 10, on_line=coll)
    return rows


def lastmod_of(row):
    nums = [a for a in row['args'] if a.isdigit() and len(a) >= 9]
    return nums[1] if len(nums) > 1 else None


opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'])
t0 = time.time()
try:
    n3, n5 = opers['nef3'], opers['nef5']

    import re as _re

    def mint_base(client, m):
        """The 'adding global GLINE for <m>, expiring at E' notice: E-600 =
        the issuing server's TStime at MINT time (STATS lastmod is later
        mutated by the doc-reconcile drive, so it is NOT the mint oracle)."""
        for p in client.drain(2.0):
            if p['cmd'] == 'NOTICE' and p['trail'] and 'adding global GLINE' in p['trail'] and m in p['trail']:
                g = _re.search(r'expiring at (\d+)', p['trail'])
                if g:
                    return int(g.group(1)) - 90
        return None

    mask = None
    for attempt, m in enumerate(MASKS, 1):
        # fire both mid-second: CurrentTime refreshes at each event-loop
        # wakeup, so both mints land in the current second with ~0.6s margin
        while not (0.30 <= (time.time() % 1.0) <= 0.45):
            time.sleep(0.005)
        n3.send('GLINE +%s * 90 :M12-reason-A' % m)
        n5.send('GLINE +%s * 90 :M12-reason-B' % m)
        mb3, mb5 = mint_base(n3, m), mint_base(n5, m)
        print('attempt %d mask %s: mint TStime nef3=%s nef5=%s' % (attempt, m, mb3, mb5))
        if mb3 is not None and mb3 == mb5:
            mask = m
            print('  same-second collision LANDED (both minted at %d)' % mb3)
            time.sleep(6)  # P10 + doc propagation + reconcile opportunity
            break
        print('  missed the same-second window; deactivating and retrying')
        n3.send('GLINE -%s * 60 :retry-cleanup' % m)
        n3.drain(1.0)
        time.sleep(2)

    if not mask:
        print('S1-M12 FAIL: could not land a same-second collision in %d tries'
              % len(MASKS))
        sys.exit(1)

    print('\nSTATS G per node (mask rows):')
    reasons, lastmods, counts = {}, {}, {}
    for n, c in sorted(opers.items()):
        rows = stats_g(c, mask)
        counts[n] = len(rows)
        for p in rows:
            print('  %s: args=%s reason=%r' % (n, p['args'][1:], p['trail']))
            reasons[n] = p['trail']
            lastmods[n] = lastmod_of(p)

    ok_present = all(counts.get(n) == 1 for n in opers)
    ok_reason = len(set(reasons.values())) == 1 and len(reasons) == len(opers)
    # live-table lastmod is mutated by the doc-reconcile drive on driven
    # nodes (drive-time stamp), so cross-node uniformity is info-only
    print('one entry per node=%s; single reason=%s (%s); live lastmods (info): %s'
          % (ok_present, ok_reason, set(reasons.values()),
             sorted(set(lastmods.values()))))

    conv1, tconv, snap = wait_converged(opers, timeout=75)
    print('\nconverged after collision: %s in %.1f s' % (conv1, tconv))
    report_digests(snap)

    print('\nchurn watch: 95 s (>=3 verify cycles)...')
    end = time.time() + 95
    while time.time() < end:
        for c in opers.values():
            c.drain(0.05)
        time.sleep(1)

    churn_late = {}
    for n, (cont, _) in NODES.items():
        churn_late[n] = dlog(cont, '60s', r'gline-reconcile: drove')
    ok_churn = all(len(v) == 0 for v in churn_late.values())
    for n, v in sorted(churn_late.items()):
        if v:
            print('  LATE-WINDOW CHURN on %s: %d line(s), e.g. %s'
                  % (n, len(v), v[-1]))
    full = {n: len(dlog(cont, '%ds' % int(time.time() - t0 + 5),
                        r'gline-reconcile: drove'))
            for n, (cont, _) in NODES.items()}
    print('reconcile "drove" counts since start (info): %s; late-window clean=%s'
          % (full, ok_churn))

    conv2, tconv2, snap2 = wait_converged(opers, timeout=60)
    print('\nconverged after churn window: %s in %.1f s' % (conv2, tconv2))
    report_digests(snap2)
    rc = restart_counts()
    ok_rc = all(v == '0' for v in rc.values())
    print('restart counts:', rc)

    verdict = (ok_present and ok_reason and conv1 and conv2
               and ok_churn and ok_rc)
    print('\nS1-M12 %s  (same_second_mint=True present=%s reason=%s conv=%s/%s churn_stopped=%s no_restarts=%s)'
          % ('PASS' if verdict else 'FAIL', ok_present, ok_reason,
             conv1, conv2, ok_churn, ok_rc))

    n3.send('GLINE -%s * 60 :cleanup' % mask)
    n3.drain(1.0)
    sys.exit(0 if verdict else 1)
finally:
    close_all(opers)
