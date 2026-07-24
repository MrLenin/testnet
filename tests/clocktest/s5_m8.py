#!/usr/bin/env python3
"""Scenario #5 (M8): metadata CLEAR must not resurrect.

An authed account (testadmin, via AuthServ so no Keycloak dependency) sets a
permanent metadata key on nef3, verifies it converges to nef5, then CLEARs
it. The M8 bug: the mirror left the doc SET intact and the per-tick
reconcile_metadata_set_cb SET-healed the cleared key back into metadata_cf.
PASS = after CLEAR the key is gone on both nodes AND STAYS gone through 2+
verify cycles (each cycle would re-heal it if the doc DELETE were missing);
mesh converges; no restarts.
"""
import sys
import time

from ircdrv import (Irc, open_opers, close_all, report_digests, restart_counts,
                    wait_converged)

KEY = 'ct-m8-key'
VAL = 'm8-value-%d' % int(time.time())


def meta_get(c, target, key):
    """Returns the key's value via 761, or None if not set (766/FAIL/end)."""
    c.drain(0.1)
    c.send('METADATA %s GET %s' % (target, key))
    val = [None]

    def coll(p):
        if p['cmd'] == '761' and key in p['args'] and p['trail'] is not None:
            val[0] = p['trail']
    try:
        c.wait(lambda p: p['cmd'] in ('762', '766') or p['cmd'] == 'FAIL' or
               (p['cmd'] == '761' and key in p['args']), 10, on_line=coll)
    except TimeoutError:
        pass
    c.drain(0.3)
    return val[0]


def until(fn, timeout=40, poll=2, desc=''):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(poll)
    print('  TIMEOUT waiting for: ' + desc)
    return False


opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'])
c1 = Irc('nef3', 'ctm8a').connect()
c2 = Irc('nef5', 'ctm8b').connect()
try:
    ok_cap = c1.cap_req('draft/metadata-2') and c2.cap_req('draft/metadata-2')
    print('caps acked: %s' % ok_cap)

    c1.send('PRIVMSG AuthServ :AUTH testadmin testadmin123')
    authed = [False]

    def auth_watch(p):
        if p['cmd'] == 'NOTICE' and p['trail']:
            t = p['trail'].lower()
            if 'recognize' in t or 'authenticated' in t or 'now authed' in t:
                authed[0] = True
    try:
        c1.wait(lambda p: authed[0], 15, on_line=auth_watch)
    except TimeoutError:
        pass
    print('authed as testadmin: %s' % authed[0])
    time.sleep(1.5)  # let the AC token settle on the ircd

    c1.send('METADATA * SET %s :%s' % (KEY, VAL))
    for p in c1.drain(2.0):
        if p['cmd'] in ('761', '762', '766', 'FAIL') or \
           (p['cmd'] == 'METADATA'):
            print('  SET reply: %s %s %s' % (p['cmd'], p['args'], p['trail']))

    ok_local = until(lambda: meta_get(c1, c1.nick, KEY) == VAL, 15,
                     desc='key visible locally on nef3')
    ok_remote = until(lambda: meta_get(c2, c1.nick, KEY) == VAL, 45,
                      desc='key converged to nef5')
    print('SET visible: local=%s remote(nef5)=%s' % (ok_local, ok_remote))

    t_clear = time.time()
    c1.send('METADATA * CLEAR')
    for p in c1.drain(2.0):
        if p['cmd'] in ('761', '762', '766', 'FAIL'):
            print('  CLEAR reply: %s %s %s' % (p['cmd'], p['args'], p['trail']))

    ok_gone_local = until(lambda: meta_get(c1, c1.nick, KEY) is None, 20,
                          desc='key gone locally')
    ok_gone_remote = until(lambda: meta_get(c2, c1.nick, KEY) is None, 45,
                           desc='key gone on nef5')
    print('CLEAR effective: local=%s remote=%s' % (ok_gone_local, ok_gone_remote))

    print('resurrect watch: 70 s (2+ verify cycles, each would SET-heal if the doc DELETE were missing)...')
    end = time.time() + 70
    while time.time() < end:
        for c in opers.values():
            c.drain(0.05)
        c1.drain(0.05)
        c2.drain(0.05)
        time.sleep(1)

    res_local = meta_get(c1, c1.nick, KEY)
    res_remote = meta_get(c2, c1.nick, KEY)
    ok_nores = res_local is None and res_remote is None
    print('after watch: local=%r remote=%r  no_resurrect=%s'
          % (res_local, res_remote, ok_nores))

    conv, tc, snap = wait_converged(opers, timeout=90)
    print('converged: %s (%.1f s)' % (conv, tc))
    report_digests(snap)
    rc = restart_counts()
    ok_rc = all(v == '0' for v in rc.values())
    print('restart counts:', rc)

    verdict = (ok_cap and authed[0] and ok_local and ok_remote and
               ok_gone_local and ok_gone_remote and ok_nores and conv and ok_rc)
    print('\nS5-M8 %s  (set_conv=%s clear=%s/%s no_resurrect=%s conv=%s no_restarts=%s)'
          % ('PASS' if verdict else 'FAIL', ok_remote, ok_gone_local,
             ok_gone_remote, ok_nores, conv, ok_rc))
    sys.exit(0 if verdict else 1)
finally:
    c1.close()
    c2.close()
    close_all(opers)
