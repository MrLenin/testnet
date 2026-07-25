#!/usr/bin/env python3
"""Account-prop leaf defect — acceptance gate (2026-07-24).

Pre-fix: the P10 `AC` (account stamp) relayed from services down the tree was
dropped on tree-retired CRDT leaves by parse.c's fake-direction guard: under
tree-retirement the leaf resolves the services numeric (DH) to a synthetic
mesh anchor whose cli_from is a self dead-sink, never the arriving hub link.
Result: a client that authed while connected to a leaf NEVER got cli_account
set on its OWN server (WHOIS 330 empty), and leaves never learned any
client's account — silently breaking every account-anchored feature there
(metadata load/persist, read-markers, bouncer, chathistory presence).

Fix under test: CrdtAcceptBeyondHorizonSource exemption at both parse.c
guard sites (mesh-anchor source + trusted CRDT server link only) plus
ms_account accepting an IsMeshStub sptr.

Gate:
 1. Client A on LEAF nef4 auths testadmin       -> WHOIS 330 on nef4 itself
    (the local leg: pre-fix this was empty forever).
 2. nef4's downstream leaf nef6 sees A's account -> the accepted AC relays on.
 3. Client B on HUB nef3 auths                   -> nef4's view of B has 330
    (the remote leg) and the hub still stamps (regression).
 4. nef4 docker logs since the test start show NO "Fake direction: ... AC"
    drops (the pre-fix smoking gun).
 5. Mesh mdigest converges across all 5 nodes at the end.
"""
import subprocess
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

ACCT = 'testadmin'
PW = 'testadmin123'


def auth(c, acct=ACCT, pw=PW, tries=4):
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


def whois_330(c, nick):
    """Local-view WHOIS from c's server; returns the 330 account or None."""
    c.drain(0.2)
    c.send('WHOIS %s' % nick)
    st = {'acct': None}

    def coll(p):
        if p['cmd'] == '330' and len(p['args']) > 2:
            st['acct'] = p['args'][2]
    try:
        c.wait(lambda p: p['cmd'] in ('318', '401'), 8, on_line=coll)
    except TimeoutError:
        pass
    return st['acct']


def wait_acct(c, nick, want=ACCT, tries=15):
    """Poll a server's local view until nick's 330 shows the account."""
    got = None
    for _ in range(tries):
        got = whois_330(c, nick)
        if got == want:
            return got
        time.sleep(2)
    return got


t0 = time.time()
verdict = False
A = B = None
op6 = op3v = None
try:
    # 1. the local leg: auth ON the leaf, ask the leaf itself
    A = Irc('nef4', 'laA').connect()
    a_ok = auth(A)
    a_330 = wait_acct(A, A.nick)
    leaf_local = (a_330 == ACCT)
    print('A on nef4: authed=%s  nef4 WHOIS 330=%r  -> leaf-local %s'
          % (a_ok, a_330, 'PASS' if leaf_local else 'FAIL'))

    # 2. the relay-on leg: nef4's downstream nef6 must also see it
    op6 = Irc('nef6', 'laO6').connect().oper()
    d_330 = wait_acct(op6, A.nick)
    downstream = (d_330 == ACCT)
    print('nef6 view of A: 330=%r -> downstream %s'
          % (d_330, 'PASS' if downstream else 'FAIL'))

    # 3. the remote leg + hub regression: auth on the hub, ask the leaf
    B = Irc('nef3', 'laB').connect()
    b_ok = auth(B)
    hub_330 = wait_acct(B, B.nick)
    op3v = Irc('nef4', 'laO4').connect().oper()
    r_330 = wait_acct(op3v, B.nick)
    hub_reg = (hub_330 == ACCT)
    leaf_remote = (r_330 == ACCT)
    print('B on nef3: authed=%s  hub 330=%r (%s)  nef4 view 330=%r (%s)'
          % (b_ok, hub_330, 'PASS' if hub_reg else 'FAIL',
             r_330, 'PASS' if leaf_remote else 'FAIL'))

    # 4. the smoking gun must be gone: no fake-direction AC drops on nef4
    win = int(time.time() - t0) + 5
    lg = subprocess.run(['docker', 'logs', '--since', '%ds' % win, 'nefarious4'],
                        capture_output=True, text=True)
    drops = [l for l in (lg.stdout + lg.stderr).splitlines()
             if 'Fake direction' in l and ' AC ' in l]
    no_drops = not drops
    print('nef4 fake-direction AC drops in window: %d -> %s'
          % (len(drops), 'PASS' if no_drops else 'FAIL'))
    for l in drops[:3]:
        print('   ' + l.strip())

    # 5. mesh still converges
    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='laM')
    conv, tc, _ = wait_converged(opers, timeout=150)
    close_all(opers)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = (a_ok and leaf_local and downstream and b_ok and hub_reg
               and leaf_remote and no_drops and conv)
    print('\nLEAFAUTH-330 %s  (local=%s downstream=%s remote=%s hub=%s '
          'nodrops=%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', leaf_local, downstream,
             leaf_remote, hub_reg, no_drops, conv))
finally:
    for c in (A, B, op6, op3v):
        try:
            if c:
                c.close()
        except Exception:
            pass

sys.exit(0 if verdict else 1)
