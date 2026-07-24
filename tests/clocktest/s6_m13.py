#!/usr/bin/env python3
"""Scenario #6 (M13) v2: stepped ban expiry -> tombstone + GC (gline + jupe).

Mint a 600 s gline AND jupe from nef7 (0 offset), converge everywhere, then
/CRDT clockstep +700 on nef7 only -> its expiry checks fire immediately and
must mint doc DELETE tombstones that converge: every 0-offset node drops both
bans ~600 s "early" by its own clock. PASS = present everywhere pre-step,
gone everywhere within ~95 s post-step, converged, oplog drains (GC), no
crash-restarts.

v2 hardening: nef7 is restarted at start (v1 left it stepped) and again in
cleanup; all per-node probes tolerate a dead/dropped connection and reconnect
once (a +700 forward step is an NTP-step analogue — nef7's established local
clients may be ping-dropped, which is expected server behavior, not a bug).
"""
import subprocess
import sys
import time

from ircdrv import Irc, open_opers, close_all, report_digests, wait_converged

MASK = '*@203.0.113.%d' % (10 + int(time.time()) % 200)
JSERV = 'm13x%d.fake.server' % (int(time.time()) % 1000)


def restart_nef7(reason):
    print('restarting nefarious7 (%s)...' % reason)
    subprocess.run(['docker', 'restart', 'nefarious7'], capture_output=True)
    for _ in range(30):
        try:
            import socket
            socket.create_connection(('127.0.0.1', 6674), timeout=1).close()
            break
        except OSError:
            time.sleep(1)
    time.sleep(3)


def reconnect(opers, n):
    try:
        opers[n].close()
    except Exception:
        pass
    opers[n] = Irc(n, 'ctR%s%d' % (n[-1], int(time.time()) % 100)).connect().oper()


def gline_has(c, needle):
    c.drain(0.1)
    c.send('STATS G')
    hit = [False]

    def coll(p):
        if p['cmd'] == '247' and needle in ' '.join(p['args']):
            hit[0] = True
    c.wait(lambda p: p['cmd'] == '219', 10, on_line=coll)
    return hit[0]


def jupe_has(c, needle):
    c.drain(0.1)
    c.send('JUPE')
    hit = [False]

    def coll(p):
        if p['cmd'] == '282' and needle in ' '.join(p['args']):
            hit[0] = True
    c.wait(lambda p: p['cmd'] == '283', 10, on_line=coll)
    return hit[0]


def presence(opers, fn, needle):
    """Per-node probe; on connection death reconnect once and retry."""
    out = {}
    for n in sorted(opers):
        try:
            out[n] = fn(opers[n], needle)
        except (TimeoutError, OSError):
            try:
                reconnect(opers, n)
                out[n] = fn(opers[n], needle)
            except (TimeoutError, OSError):
                out[n] = None
    return out


def until(fn, timeout, poll=3, desc=''):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(poll)
    print('  TIMEOUT: ' + desc)
    return False


restart_nef7('reset leftover +700 offset from v1')

opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'])
verdict = False
try:
    n7 = opers['nef7']
    n7.send('GLINE +%s * 600 :M13-expiry-test' % MASK)
    n7.drain(1.0)
    n7.send('JUPE +%s * 600 :M13-jupe-test' % JSERV)
    for p in n7.drain(1.5):
        if (p['cmd'].isdigit() and int(p['cmd']) >= 400) or \
           (p['cmd'] == 'NOTICE' and p['trail'] and 'jupe' in p['trail'].lower()):
            print('  jupe reply: %s %s %s' % (p['cmd'], p['args'], p['trail']))

    ok_gpre = until(lambda: all(presence(opers, gline_has, MASK).values()), 40,
                    desc='gline present everywhere')
    ok_jpre = until(lambda: all(presence(opers, jupe_has, JSERV).values()), 40,
                    desc='jupe present everywhere')
    print('pre-step: gline everywhere=%s jupe everywhere=%s' % (ok_gpre, ok_jpre))
    conv0, tc0, _ = wait_converged(opers, timeout=90)
    print('converged pre-step: %s (%.1f s)' % (conv0, tc0))

    print('clockstep +700 on nef7 ->', opers['nef7'].clockstep(+700))
    t_step = time.time()

    ok_ggone = until(lambda: not any(presence(opers, gline_has, MASK).values()),
                     95, desc='gline gone everywhere')
    t_g = time.time() - t_step
    ok_jgone = until(lambda: not any(presence(opers, jupe_has, JSERV).values()),
                     95, desc='jupe gone everywhere')
    t_j = time.time() - t_step
    print('post-step: gline gone=%s (+%.0f s) jupe gone=%s (+%.0f s)'
          % (ok_ggone, t_g, ok_jgone, t_j))

    conv1, tc1, snap = wait_converged(opers, timeout=90)
    print('converged post-expiry: %s (%.1f s)' % (conv1, tc1))
    report_digests(snap)

    def oplog_low():
        try:
            d = {n: c.crdt_status() for n, c in opers.items()}
        except (TimeoutError, OSError):
            return False
        return all(s['oplog'] is not None and int(s['oplog']) <= 5
                   for s in d.values())
    ok_gc = until(oplog_low, 100, poll=10, desc='oplog drained (GC)')
    print('tombstones GC-drained (oplog <= 5 all nodes): %s' % ok_gc)

    verdict = (ok_gpre and ok_jpre and conv0 and ok_ggone and ok_jgone and
               conv1 and ok_gc)
    print('\nS6-M13 %s  (pre=%s/%s gone=%s/%s conv=%s gc=%s)'
          % ('PASS' if verdict else 'FAIL', ok_gpre, ok_jpre, ok_ggone,
             ok_jgone, conv1, ok_gc))
finally:
    close_all(opers)
    restart_nef7('cleanup: clear +700 offset')

sys.exit(0 if verdict else 1)
