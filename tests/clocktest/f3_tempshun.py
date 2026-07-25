#!/usr/bin/env python3
"""Tier C F3 — TEMPSHUN over the mesh (acceptance gate).

Pre-F3: TEMPSHUN is applied ONLY on the victim's home server, and the P10
TS token is USER-sourced (oper or X3's OpServ) — so under tree-retirement
it is fake-direction-dropped beyond one tree hop (the live-confirmed gap-A
class). A hub oper tempshunning a victim homed on nef7 (2 hops out, whose
tree knowledge is truncated to its parent) silently never landed.

F3 carries the flip in a dedicated LWW doc register (entry-server minted,
home-server applied by the reconcile suite), so the shun reaches the home
server via the mesh regardless of tree horizon.

Gate:
 1. victim V on nef7, observer O on nef3, both in #f3ts; V's baseline
    message reaches O.
 2. oper on nef3: TEMPSHUN +V -> within a convergence window V's messages
    STOP reaching O (the flag landed on nef7, where parse-time enforcement
    lives).
 3. TEMPSHUN -V -> V's messages flow again (the un-shun replicates as
    active=0, not a delete).
 4. mesh mdigest converges.
"""
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

CHAN = '#f3ts%d' % (int(time.time()) % 10000)


def wait_msg(rx, marker, timeout):
    got = [False]

    def w(p):
        if p['cmd'] == 'PRIVMSG' and p['trail'] and marker in p['trail']:
            got[0] = True
    try:
        rx.wait(lambda p: got[0], timeout, on_line=w)
    except TimeoutError:
        pass
    return got[0]


verdict = False
V = O = op3 = None
try:
    op3 = Irc('nef3', 'f3op').connect().oper()
    V = Irc('nef7', 'f3vic').connect()
    O = Irc('nef3', 'f3obs').connect()
    V.send('JOIN %s' % CHAN)
    O.send('JOIN %s' % CHAN)
    V.drain(1.5)
    O.drain(1.5)

    # 1. baseline delivery
    V.send('PRIVMSG %s :baseline-hello' % CHAN)
    base = wait_msg(O, 'baseline-hello', 10)
    print('baseline V->O delivery: %s' % ('PASS' if base else 'FAIL'))

    # 2. shun from the hub; poll until V's probes stop arriving at O
    op3.send('TEMPSHUN +%s :f3 gate' % V.nick)
    op3.drain(1.0)
    shunned = False
    for i in range(15):                      # up to ~45s for doc + reconcile
        marker = 'probe-%d' % i
        V.send('PRIVMSG %s :%s' % (CHAN, marker))
        if not wait_msg(O, marker, 3):
            # one silent probe could be transit noise; confirm with a second
            marker2 = 'probe-%d-confirm' % i
            V.send('PRIVMSG %s :%s' % (CHAN, marker2))
            if not wait_msg(O, marker2, 3):
                shunned = True
                break
        time.sleep(1)
    print('shun enforced on home server (V msgs stop): %s'
          % ('PASS' if shunned else 'FAIL'))

    # 3. un-shun; poll until delivery resumes
    op3.send('TEMPSHUN -%s :appealed' % V.nick)
    op3.drain(1.0)
    unshunned = False
    for i in range(15):
        marker = 'resume-%d' % i
        V.send('PRIVMSG %s :%s' % (CHAN, marker))
        if wait_msg(O, marker, 3):
            unshunned = True
            break
        time.sleep(2)
    print('un-shun restores delivery: %s' % ('PASS' if unshunned else 'FAIL'))

    # 4. mesh convergence
    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='f3m')
    conv, tc, _ = wait_converged(opers, timeout=120)
    close_all(opers)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = base and shunned and unshunned and conv
    print('\nF3-TEMPSHUN %s  (baseline=%s shunned=%s unshunned=%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', base, shunned, unshunned, conv))
finally:
    for c in (V, O, op3):
        try:
            if c:
                c.close()
        except Exception:
            pass

sys.exit(0 if verdict else 1)
