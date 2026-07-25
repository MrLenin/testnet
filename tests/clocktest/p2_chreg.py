#!/usr/bin/env python3
"""P2 scenarios 1+3 — +R channel metadata: create/converge/visibility, then
the -R mesh-wide reap + the re-+R resurrection-guard (Metadata P2, channel
tier).

Flow:
 1. oper on the HUB nef3 creates+joins `#p2reg`, OPMODE `+R` (a local OPMODE
    from an oper IS the mesh entry node — Global Constraints' entry-node
    predicate), METADATA SET a public key and a private key.
 2. poll an OPER on the overlay-reached leaf nef7 (bypasses the vis check in
    every code path, so this proves the VALUES converged, decoupled from
    the visibility-permission question) until both keys read back correctly.
 3. a plain (non-oper, non-chanop) client joins `#p2reg` on nef7 -- second
    joiner to an already-existing channel, so it does NOT auto-op -- and
    exercises the discovered channel-metadata visibility rule (see below).
 4. OPMODE `-R` on nef3 -> poll LIST on ALL FIVE nodes until both rows are
    reaped (B3's -R hook clears store on every node + memory+notify on
    every node, per the Task-4 fix-pass).
 5. re-OPMODE `+R` on nef3 WITHOUT re-SETting -> assert GET returns not-set
    for both keys (the resurrection regression T4's review caught and
    fixed: before the fix, -R only wiped memory at the entry node, so a
    remote node's still-populated chptr->metadata would get re-persisted
    over the tombstones by the next +R's "persist-memory-first" pass).
 6. mesh mdigest still converges.

DISCOVERED CHANNEL-VIS RULE (read from source, ircd/m_metadata.c at
nefarious-crdt 30eef94 -- not guessed):
  `can_view_metadata(viewer, owner, entry)` (m_metadata.c:331) is the rule
  both GET's live-memory branch (:465) and LIST (:959) apply for a channel
  target: `owner` is passed as NULL for every channel entry (:465, :959),
  so a PRIVATE entry's "visible to owner" arm can never match and the rule
  collapses to "IsOper(viewer) only" -- there is NO chanop exception in
  either of those two paths, even though the *separate*, only-used-when-
  not-yet-materialized-into-memory GET LMDB-fallback branch (:553-563)
  explicitly grants chanops the same access as opers ("Private channel
  metadata - visible to chanops and opers only"). Those two GET code paths
  therefore disagree for a chanop-who-is-not-an-oper viewer, depending on
  whether the entry already lives in chptr->metadata (materialized -> oper
  only) or is still being fetched from the store cache (not yet
  materialized -> chanop-or-oper). Because this scenario always lets the
  doc converge (and therefore B4's reconcile materialize) before either
  viewer reads, the live-memory branch is what actually answers GET/LIST
  here in practice. To keep the assertion unambiguous or (i.e. not depend
  on which of the two inconsistent branches happens to fire), this driver
  uses only the two viewer roles both branches agree on: an oper (passes
  in both) and a plain non-chanop member (denied in both). The chanop-only
  divergence is a real, source-verified inconsistency worth a follow-up,
  but it is not this driver's PASS/FAIL gate.
"""
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

CHAN = '#p2reg'
PUB_KEY = 'ct-chreg-pub'
PRIV_KEY = 'ct-chreg-priv'
PUB_VAL = 'pub-%d' % int(time.time())
PRIV_VAL = 'priv-%d' % int(time.time())


def meta_set(c, target, key, value, vis=None):
    if vis == 'private':
        c.send('METADATA %s SET %s private :%s' % (target, key, value))
    else:
        c.send('METADATA %s SET %s * :%s' % (target, key, value))
    c.drain(1.0)


def meta_get(c, target, key):
    """Return (value_or_None, saw_766)."""
    c.drain(0.1)
    c.send('METADATA %s GET %s' % (target, key))
    st = {'val': None, 'notset': False}

    def coll(p):
        if p['cmd'] == '761' and key in p['args']:
            st['val'] = p['trail']
        elif p['cmd'] == '766' and key in p['args']:
            st['notset'] = True
    try:
        c.wait(lambda p: (p['cmd'] in ('762', 'FAIL')) or
               (p['cmd'] == '761' and key in p['args']) or
               (p['cmd'] == '766' and key in p['args']), 8, on_line=coll)
    except TimeoutError:
        pass
    return st['val'], st['notset']


def meta_list(c, target):
    """Return {key: visibility_token} from a LIST (761 lines carry the vis)."""
    c.drain(0.1)
    c.send('METADATA %s LIST' % target)
    found = {}

    def coll(p):
        if p['cmd'] == '761' and len(p['args']) >= 4:
            found[p['args'][2]] = p['args'][3]
    try:
        c.wait(lambda p: p['cmd'] in ('762', 'FAIL'), 8, on_line=coll)
    except TimeoutError:
        pass
    return found


def join_chan(c, chan, timeout=10):
    c.drain(0.1)
    c.send('JOIN ' + chan)
    c.wait(lambda p: p['cmd'] == '366', timeout)
    c.drain(0.3)


def opmode(op, chan, modestr):
    op.drain(0.1)
    op.send('OPMODE %s %s' % (chan, modestr))
    op.drain(1.5)


verdict = False
opers = {}
B = None
try:
    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='ctCRo')
    for o in opers.values():
        o.cap_req('draft/metadata-2')
    op3, op7 = opers['nef3'], opers['nef7']

    # 1. create + register + SET on the hub (entry node)
    join_chan(op3, CHAN)
    opmode(op3, CHAN, '+R')
    meta_set(op3, CHAN, PUB_KEY, PUB_VAL, vis='public')
    meta_set(op3, CHAN, PRIV_KEY, PRIV_VAL, vis='private')
    print('nef3: created+registered %s, SET pub=%s priv=%s' % (CHAN, PUB_VAL, PRIV_VAL))

    # 2. converge to the overlay-reached leaf: oper view bypasses vis in
    #    every code path, so this proves VALUES converged, decoupled from
    #    the permission question tested next.
    op7_pub = op7_priv = None
    for _ in range(25):
        op7_pub, _ = meta_get(op7, CHAN, PUB_KEY)
        op7_priv, _ = meta_get(op7, CHAN, PRIV_KEY)
        if op7_pub == PUB_VAL and op7_priv == PRIV_VAL:
            break
        time.sleep(3)
    oper_sees_both = (op7_pub == PUB_VAL and op7_priv == PRIV_VAL)
    print('nef7 oper GET (convergence proof): pub=%r priv=%r -> %s'
          % (op7_pub, op7_priv, 'PASS' if oper_sees_both else 'FAIL'))

    # 3. plain (non-chanop, non-oper) member joins nef7 -- channel is
    #    already fully materialized there (step 2 confirmed it), so no
    #    join-vs-doc-convergence race.
    B = Irc('nef7', 'ctCRb').connect()
    B.cap_req('draft/metadata-2')
    join_chan(B, CHAN)

    b_pub, _ = meta_get(B, CHAN, PUB_KEY)
    b_priv, b_priv_notset = meta_get(B, CHAN, PRIV_KEY)
    b_list = meta_list(B, CHAN)
    vis_ok = (b_pub == PUB_VAL and b_priv is None and b_priv_notset
              and PUB_KEY in b_list and PRIV_KEY not in b_list)
    print('nef7 plain-member GET: pub=%r priv=%r(766=%s)  LIST keys=%s -> %s'
          % (b_pub, b_priv, b_priv_notset, sorted(b_list), 'PASS' if vis_ok else 'FAIL'))

    # 4. -R: mesh-wide reap (store wipe + doc tombstones at nef3, memory
    #    clear + unset notify on EVERY node per the T4 fix-pass)
    opmode(op3, CHAN, '-R')
    reaped = {}
    t0 = time.time()
    all_reaped = False
    while time.time() - t0 < 90:
        reaped = {n: meta_list(o, CHAN) for n, o in opers.items()}
        all_reaped = all(PUB_KEY not in lst and PRIV_KEY not in lst
                          for lst in reaped.values())
        if all_reaped:
            break
        time.sleep(3)
    print('-R reap LIST per node: %s -> %s'
          % ({n: sorted(l) for n, l in reaped.items()},
             'PASS' if all_reaped else 'FAIL'))

    # 5. resurrection guard: re-+R with NO re-SET must NOT bring the keys
    #    back (both memory and store were wiped mesh-wide by -R).
    opmode(op3, CHAN, '+R')
    time.sleep(5)
    r3_pub, _ = meta_get(op3, CHAN, PUB_KEY)
    r3_priv, _ = meta_get(op3, CHAN, PRIV_KEY)
    r7_pub, _ = meta_get(op7, CHAN, PUB_KEY)
    r7_priv, _ = meta_get(op7, CHAN, PRIV_KEY)
    no_resurrect = (r3_pub is None and r3_priv is None
                    and r7_pub is None and r7_priv is None)
    print('post re-+R GET (resurrection guard): nef3 pub=%r priv=%r  nef7 pub=%r priv=%r -> %s'
          % (r3_pub, r3_priv, r7_pub, r7_priv,
             'PASS' if no_resurrect else 'FAIL'))

    # 6. mesh still converges
    conv, tc, _ = wait_converged(opers, timeout=90)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = (oper_sees_both and vis_ok and all_reaped and no_resurrect and conv)
    print('\nP2-CHREG %s  (converge=%s vis=%s reap=%s no_resurrect=%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', oper_sees_both, vis_ok, all_reaped,
             no_resurrect, conv))
finally:
    close_all(opers)
    if B:
        try:
            B.close()
        except Exception:
            pass

sys.exit(0 if verdict else 1)
