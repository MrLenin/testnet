#!/usr/bin/env python3
"""Regression guard for the metadata read-promotion removal: prove that a
FRESH client struct with empty in-memory metadata still gets its persisted
account metadata back via metadata_load_account (the eager auth-time load),
now that the lazy GET store->memory promotion is gone.

All on hub nef3 (account-prop is only reliable on the hub). Flow:
 1. connect + auth testadmin, SET a permanent key -> memory+store hold it.
 2. GET(self) == VAL (served from memory).
 3. DISCONNECT -> client struct freed, memory gone, store persists.
 4. reconnect FRESH + re-auth -> metadata_load_account fills memory from the
    store at auth; with the lazy promotion removed this is the ONLY restore
    path. GET(self) == VAL proves it still works (removal is safe).
 5. CLEAR now propagates (the F2 fix) -> key gone on a second node too.
"""
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

KEY = 'ct-restore-key'
VAL = 'restore-%d' % int(time.time())


def meta_get(c, target, key):
    c.drain(0.1)
    c.send('METADATA %s GET %s' % (target, key))
    val = [None]

    def coll(p):
        if p['cmd'] == '761' and key in p['args'] and p['trail'] is not None:
            val[0] = p['trail']
    try:
        c.wait(lambda p: p['cmd'] in ('762', '766', 'FAIL') or
               (p['cmd'] == '761' and key in p['args']), 8, on_line=coll)
    except TimeoutError:
        pass
    return val[0]


def auth(c, acct='testadmin', pw='testadmin123', tries=3):
    for _ in range(tries):
        c.send('PRIVMSG AuthServ :AUTH %s %s' % (acct, pw))
        ok = [False]

        def w(p):
            if p['cmd'] == 'NOTICE' and p['trail']:
                t = p['trail'].lower()
                if 'recognize' in t or 'authenticated' in t or 'now authed' in t:
                    ok[0] = True
        try:
            c.wait(lambda p: ok[0], 12, on_line=w)
        except TimeoutError:
            pass
        if ok[0]:
            time.sleep(1.5)
            return True
        time.sleep(2)
    return False


verdict = False
c1 = Irc('nef3', 'ctrsa').connect()
c1.cap_req('draft/metadata-2')
try:
    ok_auth1 = auth(c1)
    c1.send('METADATA * SET %s :%s' % (KEY, VAL))
    c1.drain(1.5)
    ok_set = meta_get(c1, 'ctrsa', KEY) == VAL
    print('setup: authed=%s SET+GET(memory)=%s' % (ok_auth1, ok_set))

    print('disconnecting (frees the client struct + its in-memory metadata)...')
    c1.close()
    time.sleep(3)

    # fresh struct, empty memory: only metadata_load_account can restore it
    c2 = Irc('nef3', 'ctrsb').connect()
    c2.cap_req('draft/metadata-2')
    ok_auth2 = auth(c2)
    restored = meta_get(c2, c2.nick, KEY)
    ok_restore = restored == VAL
    print('fresh reconnect + reauth: authed=%s GET(self)=%r restored=%s'
          % (ok_auth2, restored, ok_restore))

    # F2 fix intact: CLEAR propagates to another node
    probe5 = Irc('nef5', 'ctrsp').connect()
    probe5.cap_req('draft/metadata-2')
    seen5 = False
    for _ in range(20):
        if meta_get(probe5, 'testadmin', KEY) == VAL:
            seen5 = True
            break
        time.sleep(2)
    c2.send('METADATA * CLEAR')
    c2.drain(1.5)
    gone5 = False
    for _ in range(20):
        if meta_get(probe5, 'testadmin', KEY) is None:
            gone5 = True
            break
        time.sleep(2)
    print('CLEAR propagation: converged-to-nef5=%s then gone-on-nef5=%s' % (seen5, gone5))
    probe5.close()
    c2.close()

    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='ctRSo')
    conv, tc, _ = wait_converged(opers, timeout=90)
    close_all(opers)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = ok_auth1 and ok_set and ok_auth2 and ok_restore and seen5 and gone5 and conv
    print('\nS5C-RESTORE %s  (set=%s restore_via_load_account=%s clear_prop=%s/%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', ok_set, ok_restore, seen5, gone5, conv))
finally:
    try:
        c1.close()
    except Exception:
        pass

sys.exit(0 if verdict else 1)
