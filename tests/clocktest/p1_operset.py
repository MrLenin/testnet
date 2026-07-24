#!/usr/bin/env python3
"""P1 scenario 7 — oper `METADATA *account SET` on an OFFLINE account.

Before P1/A4 the offline branch wrote a TTL-stamped row: not doc-converged
(the CRDT mirror skips TTL writes) and purge-swept in ~4h, so the change
never reached other nodes and silently self-destructed. P1/A4 makes it a
PERMANENT write, so the doc chokepoint converges it mesh-wide and every
node materialises it into its own store (P1/A1 reconcile).

Flow (testadmin must be OFFLINE everywhere — no authed session):
 1. oper on nef3 sets `METADATA *testadmin SET <key> :<val>` (offline branch).
 2. probe on nef5 (an overlay/tree-distant node): GET *testadmin <key>
    resolves via its own materialised store row -> returns <val>.
    (Convergence is via the doc, not a TTL cache, so it does not decay.)
 3. restart nef5; reconnect; GET again -> still <val> (permanent, on disk).
 4. mesh mdigest converges.

The GET target is the bare account name; an offline-account GET probes the
local store (metadata_account_get) on whichever node answers.
"""
import subprocess
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

KEY = 'ct-operset'
VAL = 'oper-%d' % int(time.time())


def meta_get_account(c, account, key):
    # Read-back of an offline-account row uses the BARE account name as the
    # GET target (the `*account` star form is SET-oper-only syntax; GET's
    # offline path probes metadata_account_list(target) with target verbatim).
    c.drain(0.1)
    c.send('METADATA %s GET %s' % (account, key))
    st = {'val': None}

    def coll(p):
        if p['cmd'] == '761' and key in p['args']:
            st['val'] = p['trail']
    try:
        c.wait(lambda p: p['cmd'] in ('762', '766', 'FAIL') or
               (p['cmd'] == '761' and key in p['args']), 8, on_line=coll)
    except TimeoutError:
        pass
    return st['val']


verdict = False
op3 = Irc('nef3', 'ctOSo').connect().oper()
op3.cap_req('draft/metadata-2')
probe5 = Irc('nef5', 'ctOSp').connect().oper()
probe5.cap_req('draft/metadata-2')
try:
    # 1. oper offline-SET on nef3
    op3.send('METADATA *testadmin SET %s :%s' % (KEY, VAL))
    op3.drain(1.5)
    print('oper SET *testadmin %s = %s on nef3' % (KEY, VAL))

    # 2. converge to nef5 via the doc (permanent, so it must arrive + stick)
    seen5 = None
    for _ in range(20):
        seen5 = meta_get_account(probe5, 'testadmin', KEY)
        if seen5 == VAL:
            break
        time.sleep(2)
    conv5 = (seen5 == VAL)
    print('nef5 GET *testadmin %s -> %r converged=%s' % (KEY, seen5, conv5))

    # 3. restart nef5, reconnect, GET again -> permanent store survives
    print('restarting nefarious5...')
    probe5.close()
    subprocess.run(['docker', 'restart', 'nefarious5'],
                   capture_output=True, text=True)
    # wait for the listener back (valgrind boot is slow)
    back = False
    for _ in range(45):
        try:
            probe5b = Irc('nef5', 'ctOSp2').connect(timeout=8)
            back = True
            break
        except Exception:
            time.sleep(3)
    survived = False
    if back:
        probe5b.cap_req('draft/metadata-2')
        got = None
        for _ in range(10):
            got = meta_get_account(probe5b, 'testadmin', KEY)
            if got == VAL:
                break
            time.sleep(2)
        survived = (got == VAL)
        print('after nef5 restart: GET *testadmin %s -> %r survived=%s'
              % (KEY, got, survived))
        probe5b.close()
    else:
        print('nef5 did not come back in time')

    # 4. mesh reconverges (nef5 rejoined)
    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='ctOSm')
    conv, tc, _ = wait_converged(opers, timeout=120)
    close_all(opers)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = conv5 and survived and conv
    print('\nP1-OPERSET %s  (converged_nef5=%s restart_survived=%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', conv5, survived, conv))
finally:
    for c in (op3, probe5):
        try:
            c.close()
        except Exception:
            pass

sys.exit(0 if verdict else 1)
