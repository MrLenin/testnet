#!/usr/bin/env python3
"""P2 scenario 2 — full-bed restart survival for +R channel metadata
(Metadata P2, channel tier).

Setup on the hub nef3: `#p2reg` (+R, a public + a private key) and
`#p2eph` (ordinary, NOT +R, one key) -- confirm both converge to a second
node BEFORE the destructive restart. Then restart the FULL 5-node bed in
health-gated waves of <=2 (nef3+nef4 -> nef5+nef6 -> nef7, the standard
depth-2-tree bring-up order) and wait for the tree + mesh to re-form.

What "restart" does to each channel's LIVE object, concretely: neither
channel's live Channel struct is guaranteed to survive on any given node --
sub1_from_channel/destruct_channel (ircd/channel.c:351/439) tear a channel
down the moment it goes empty REGARDLESS of MODE_REGISTERED (there is no
R-aware exemption there -- only Apass / EXMODE_PERSIST / bouncer-aliases
keep an empty channel alive), and every client connection is severed when
its container restarts. Whether a *remote* node's copy survives via the
Tier-2 "hold the departed server's users, don't cascade-tombstone" split
handling (so the OR-Set member count never actually hits 0 on nodes that
stayed up during a given wave) is exactly the ambiguity Task 6's own brief
flags and does not resolve either way -- so this driver does not depend on
the answer. The recovery action is unconditionally: reconnect, JOIN
#p2reg again (a no-op merge if the channel/membership survived somewhere,
a fresh recreate if it did not -- CRDT ctime is a min-register incarnation,
so a recreate merges with any surviving incarnation rather than orphaning
it), then OPMODE +R again (a no-op if R was never lost, or the real
trigger for B3's "load" half -- metadata_channel_load hydrating
chptr->metadata from THIS node's own on-disk store row, which is untouched
by any of the above since B1 makes every node persist its own store row
independently of the doc/channel-object lifecycle). Either way the keys
must come back correct -- this IS the designed restart path (see the
Task 6 brief's own reasoning).

`#p2eph` never had a store row to begin with (B5: unregistered-channel
writes are memory + S2S-relay only, spec Sec C3) -- so however its live
object's survival shakes out, the KEY must not reappear anywhere once
every node has cycled through its own restart (each node's own restart
wipes ITS in-memory chptr->metadata at least once during the staged
sequence, and there is no replicated doc state to bring a non-+R key
back). The check deliberately does NOT rejoin/recreate #p2eph first --
doing so would make "the key is gone" trivially true regardless of
whether the persistence bug B5 fixed stayed fixed, since a freshly
created channel starts empty either way.
"""
import subprocess
import sys
import threading
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

REG_CHAN = '#p2reg'
EPH_CHAN = '#p2eph'
PUB_KEY = 'ct-restart-pub'
PRIV_KEY = 'ct-restart-priv'
EPH_KEY = 'ct-restart-eph'
PUB_VAL = 'pub-%d' % int(time.time())
PRIV_VAL = 'priv-%d' % int(time.time())
EPH_VAL = 'eph-%d' % int(time.time())

NODES = ['nef3', 'nef4', 'nef5', 'nef6', 'nef7']
CONTAINERS = {'nef3': 'nefarious3', 'nef4': 'nefarious4', 'nef5': 'nefarious5',
              'nef6': 'nefarious6', 'nef7': 'nefarious7'}
WAVES = [['nef3', 'nef4'], ['nef5', 'nef6'], ['nef7']]


def meta_set(c, target, key, value, vis=None):
    if vis == 'private':
        c.send('METADATA %s SET %s private :%s' % (target, key, value))
    else:
        c.send('METADATA %s SET %s * :%s' % (target, key, value))
    c.drain(1.0)


def meta_get(c, target, key):
    """Return (value_or_None, saw_766, saw_FAIL)."""
    c.drain(0.1)
    c.send('METADATA %s GET %s' % (target, key))
    st = {'val': None, 'notset': False, 'fail': False}

    def coll(p):
        if p['cmd'] == '761' and key in p['args']:
            st['val'] = p['trail']
        elif p['cmd'] == '766' and key in p['args']:
            st['notset'] = True
        elif p['cmd'] == 'FAIL':
            st['fail'] = True
    try:
        c.wait(lambda p: (p['cmd'] in ('762', 'FAIL')) or
               (p['cmd'] == '761' and key in p['args']) or
               (p['cmd'] == '766' and key in p['args']), 8, on_line=coll)
    except TimeoutError:
        pass
    return st['val'], st['notset'], st['fail']


def join_chan(c, chan, timeout=10):
    c.drain(0.1)
    c.send('JOIN ' + chan)
    c.wait(lambda p: p['cmd'] == '366', timeout)
    c.drain(0.3)


def opmode(op, chan, modestr):
    op.drain(0.1)
    op.send('OPMODE %s %s' % (chan, modestr))
    op.drain(1.5)


def restart_wave(containers, health_timeout=240, poll=3):
    print('  restart wave: %s' % containers)
    procs = [subprocess.Popen(['docker', 'restart', c]) for c in containers]
    for p in procs:
        p.wait()
    t0 = time.time()
    pending = set(containers)
    while pending and time.time() - t0 < health_timeout:
        for c in list(pending):
            r = subprocess.run(['docker', 'inspect', '-f',
                                 '{{.State.Health.Status}}', c],
                               capture_output=True, text=True)
            if r.stdout.strip() == 'healthy':
                pending.discard(c)
        if pending:
            time.sleep(poll)
    ok = not pending
    print('    health: %s (%.0fs)%s'
          % ('all healthy' if ok else 'TIMED OUT', time.time() - t0,
             '' if ok else ' still pending: %s' % sorted(pending)))
    return ok


def reconnect_oper(node, nick, tries=30, delay=3):
    for _ in range(tries):
        try:
            c = Irc(node, nick).connect(timeout=8)
            c.oper()
            c.cap_req('draft/metadata-2')
            return c
        except Exception:
            time.sleep(delay)
    return None


def reconnect_all(nodes, prefix, tries=30, delay=3):
    """Reconnect every node CONCURRENTLY (threaded) -- after a full-bed
    restart, sequential per-node retry budgets would stack (worst case
    nodes * tries * delay); each node gets its own socket/thread so the
    wall-clock cost is bounded by the SLOWEST node, not the sum."""
    results = {}

    def worker(n):
        results[n] = reconnect_oper(n, prefix + n[-1], tries, delay)
    threads = [threading.Thread(target=worker, args=(n,)) for n in nodes]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


verdict = False
all_conns = []
p1 = p2 = p3 = None
try:
    # -- setup ---------------------------------------------------------
    setup = open_opers(NODES, prefix='ctRSs')
    all_conns.extend(setup.values())
    op3 = setup['nef3']
    op3.cap_req('draft/metadata-2')

    join_chan(op3, REG_CHAN)
    opmode(op3, REG_CHAN, '+R')
    meta_set(op3, REG_CHAN, PUB_KEY, PUB_VAL, vis='public')
    meta_set(op3, REG_CHAN, PRIV_KEY, PRIV_VAL, vis='private')
    print('nef3: %s +R, SET pub=%s priv=%s' % (REG_CHAN, PUB_VAL, PRIV_VAL))

    join_chan(op3, EPH_CHAN)
    meta_set(op3, EPH_CHAN, EPH_KEY, EPH_VAL, vis='public')
    print('nef3: %s (unregistered), SET eph=%s' % (EPH_CHAN, EPH_VAL))

    # -- baseline convergence check (before the destructive restart) ---
    # +R keys are probed on nef7 (2 tree hops out): they converge via the DOC,
    # which is exactly what P2 built. The eph key is probed on nef4 (1 hop,
    # within the source's tree horizon) NOT nef7: unregistered-channel
    # metadata is memory + tree-relayed S2S only (spec Sec C3, no doc), and
    # under tree-retirement a USER-sourced P10 token from a beyond-horizon
    # server is fake-direction-dropped (the user's cli_from is a mesh anchor)
    # -- the known S2S-audit gap A, live-confirmed 2026-07-25 on this bed
    # (nef4 max-debug: "Fake direction: (AGAAB MD ...)"), slated for the
    # MR-6 CR-M-fallback work, not a P2 defect. The baseline only needs the
    # eph key to provably EXIST off-origin before the restart erases it.
    op7 = setup['nef7']
    op7.cap_req('draft/metadata-2')
    op4 = setup['nef4']
    op4.cap_req('draft/metadata-2')
    base_ok = False
    for _ in range(25):
        p1, _, _ = meta_get(op7, REG_CHAN, PUB_KEY)
        p2, _, _ = meta_get(op7, REG_CHAN, PRIV_KEY)
        p3, _, _ = meta_get(op4, EPH_CHAN, EPH_KEY)
        if p1 == PUB_VAL and p2 == PRIV_VAL and p3 == EPH_VAL:
            base_ok = True
            break
        time.sleep(3)
    print('baseline: nef7 doc-served pub=%r priv=%r; nef4 tree-served eph=%r -> %s'
          % (p1, p2, p3, 'PASS' if base_ok else 'FAIL'))

    # -- full-bed staged restart (old `setup` sockets die here; abandoned,
    #    not explicitly closed -- their containers are about to restart) --
    print('restarting the full bed in waves of <=2...')
    wave_ok = True
    for wave in WAVES:
        if not restart_wave([CONTAINERS[n] for n in wave]):
            wave_ok = False
    print('all waves healthy: %s' % wave_ok)

    # -- reconnect (concurrent across nodes) ------------------------------
    post = reconnect_all(NODES, 'ctRSp')
    all_conns.extend(c for c in post.values() if c)
    reconnected = {n: (c is not None) for n, c in post.items()}
    all_reconnected = all(reconnected.values())
    print('post-restart reconnect: %s -> %s'
          % (reconnected, 'PASS' if all_reconnected else 'FAIL'))

    live_post = {n: c for n, c in post.items() if c}

    # -- tree + mesh reconvergence ---------------------------------------
    if live_post:
        conv, tc, _ = wait_converged(live_post, timeout=300)
    else:
        conv, tc = False, 0.0
    print('mesh converged post-restart: %s (%.1f s)' % (conv, tc))

    # -- recovery: unconditional JOIN + re-OPMODE +R on the hub -----------
    restored = False
    node_ok = {}
    if post.get('nef3'):
        op3b = post['nef3']
        join_chan(op3b, REG_CHAN)
        opmode(op3b, REG_CHAN, '+R')

        # poll GET on every reconnected node; PASS needs >=2 correct per
        # the brief -- print the full per-node breakdown regardless.
        t0 = time.time()
        while time.time() - t0 < 90:
            for n, c in live_post.items():
                if node_ok.get(n):
                    continue
                v_pub, _, _ = meta_get(c, REG_CHAN, PUB_KEY)
                v_priv, _, _ = meta_get(c, REG_CHAN, PRIV_KEY)
                node_ok[n] = (v_pub == PUB_VAL and v_priv == PRIV_VAL)
            if sum(node_ok.values()) >= 2 or all(node_ok.values()):
                break
            time.sleep(3)
        ok_count = sum(node_ok.values())
        restored = ok_count >= 2
        print('post-restart %s restore per node: %s (%d/%d) -> %s'
              % (REG_CHAN, node_ok, ok_count, len(live_post),
                 'PASS' if restored else 'FAIL'))
    else:
        print('nef3 never reconnected -- cannot drive the recovery JOIN/OPMODE')

    # -- #p2eph: key must be gone everywhere -------------------------------
    eph_state = {}
    for n, c in live_post.items():
        val, notset, failed = meta_get(c, EPH_CHAN, EPH_KEY)
        if val is not None:
            eph_state[n] = 'VALUE-LEAKED:%r' % val
        elif notset:
            eph_state[n] = 'gone(766)'
        elif failed:
            eph_state[n] = 'gone(no-such-chan)'
        else:
            eph_state[n] = 'UNKNOWN'
    eph_gone = bool(eph_state) and all(v.startswith('gone') for v in eph_state.values())
    print('%s key post-restart per node: %s -> %s'
          % (EPH_CHAN, eph_state, 'PASS' if eph_gone else 'FAIL'))

    verdict = (base_ok and wave_ok and all_reconnected and conv and restored and eph_gone)
    print('\nP2-RESTART %s  (baseline=%s waves=%s reconnect=%s mesh=%s restored=%s eph_gone=%s)'
          % ('PASS' if verdict else 'FAIL', base_ok, wave_ok, all_reconnected, conv,
             restored, eph_gone))
finally:
    for c in all_conns:
        try:
            if c:
                c.close()
        except Exception:
            pass

sys.exit(0 if verdict else 1)
