#!/usr/bin/env python3
"""Scenario #4 (M2 + U6 core) v2: beacon poisoning, both directions.

Forward leg: runtime clockstep nef6 +300 -> future-stamped beacons AND nef6's
own stored recv_ts instantly look 300 s old to itself (the U6 self-mass-reap
hazard). Peers and nef6 itself must reap nothing: staleness is judged on
LOCAL recv_ts / miss_ticks, never emit_ts or wall gaps.

Backward leg: recreate nef6 with a BOOT-time -300 offset (temporary compose
fragment) -> past-stamped beacons with CONSISTENT timers. (A runtime backward
step is invalid for this: it leaves the node's absolute-time verify timer
armed in the future, so it genuinely stops beaconing and peers CORRECTLY reap
it — v1 proved that the hard way.)

PASS both legs: "mesh reachable" stays at baseline everywhere probed, stub
count stays 0, no "mesh beacon stale" reaps (benign "retired on relink"
resolutions are excluded); mesh converges after nef6 returns to offset 0.
"""
import re
import subprocess
import sys
import time

from ircdrv import Irc, open_opers, close_all, report_digests, wait_converged, dlog, NODES

STALE_RX = r'mesh beacon stale'   # genuine staleness reaps only
NEG_FRAG = '/tmp/claude-1000/-home-ibutsu-testnet/842f6c1f-3146-45a4-ab1a-28c0a1c7c5f6/scratchpad/ct-nef6-neg.yml'
CF_BASE = 'docker-compose.yml:docker-compose.libkc-dev.yml:docker-compose.clocktest.yml'


def sh(*args, **kw):
    return subprocess.run(list(args), capture_output=True, text=True, **kw)


def recreate_nef6(offset):
    """Recreate nef6 with the given boot offset (None = overlay default 0)."""
    cf = CF_BASE
    if offset is not None:
        open(NEG_FRAG, 'w').write(
            'services:\n  nefarious6:\n    environment:\n'
            '      - IRCD_FAKE_CLOCK_OFFSET=%+d\n      - NEFARIOUS_VALGRIND=0\n' % offset)
        cf += ':' + NEG_FRAG
    env = dict(__import__('os').environ, COMPOSE_FILE=cf)
    r = subprocess.run(['scripts/dc.sh', '--profile', 'multi', 'up', '-d',
                        '--no-deps', 'nefarious6'],
                       cwd='/home/ibutsu/testnet', env=env,
                       capture_output=True, text=True)
    if r.returncode != 0:
        print('recreate failed: %s' % r.stderr[-300:])
        return False
    for _ in range(30):
        try:
            import socket
            socket.create_connection(('127.0.0.1', 6673), timeout=1).close()
            return True
        except OSError:
            time.sleep(1)
    return False


def status_counts(c):
    s = c.crdt_status()
    txt = '\n'.join(s['lines'])
    g = lambda rx: (lambda m: int(m.group(1)) if m else None)(re.search(rx, txt))
    return {'reachable': g(r'mesh reachable=(\d+)'), 'stubs': g(r'(\d+) stub')}


def probe(opers, n):
    try:
        return status_counts(opers[n])
    except (TimeoutError, OSError):
        try:
            opers[n].close()
        except Exception:
            pass
        opers[n] = Irc(n, 'ctM2%s%d' % (n[-1], int(time.time()) % 100)).connect().oper()
        return status_counts(opers[n])


def settled(opers, timeout=200):
    """Bed pre-flight: every node stubs==0 and mdigest converged."""
    end = time.time() + timeout
    while time.time() < end:
        views = {n: probe(opers, n) for n in opers}
        if all((v['stubs'] or 0) == 0 and v['reachable'] is not None
               for v in views.values()):
            conv, _, _ = wait_converged(opers, timeout=40)
            if conv:
                return views
        time.sleep(10)
    return None


def watch_leg(opers, label, base, secs_watch, ticks_desc):
    t0 = time.time()
    ok = True
    while time.time() - t0 < secs_watch:
        time.sleep(20)
        views = {n: probe(opers, n) for n in ('nef3', 'nef4', 'nef6')}
        bad = {n: v for n, v in views.items()
               if v['reachable'] is None or v['reachable'] < base[n]['reachable']
               or (v['stubs'] or 0) > 0}
        print('  [%s] +%3.0f s: %s%s' % (label, time.time() - t0,
              {n: (v['reachable'], v['stubs']) for n, v in views.items()},
              '  DEGRADED %s' % bad if bad else ''))
        if bad:
            ok = False
    stale = {n: dlog(cont, '%ds' % int(time.time() - t0 + 5), STALE_RX)
             for n, (cont, _) in NODES.items()}
    fired = {n: v for n, v in stale.items() if v}
    for n, v in fired.items():
        print('  [%s] GENUINE STALE-REAP on %s: %s' % (label, n, v[-1]))
    print('[%s] %s: views stable=%s, stale-reaps=%s' % (label, ticks_desc, ok, not fired))
    return ok and not fired


opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='ctM2o')
verdict = False
try:
    base = settled(opers)
    if not base:
        print('S4-M2 FAIL: bed never settled (leftover stubs/divergence)')
        sys.exit(1)
    base = {n: base[n] for n in ('nef3', 'nef4', 'nef6')}
    print('baseline (settled): %s' % {n: (v['reachable'], v['stubs']) for n, v in base.items()})

    # ---- forward leg: runtime +300 on nef6 ----
    try:
        print('clockstep +300 on nef6 ->', opers['nef6'].clockstep(+300))
    except (TimeoutError, OSError):
        print('clockstep reply lost (client dropped) — continuing')
    ok_fwd = watch_leg(opers, 'fwd', base, 110, '3+ ticks under +300')

    print('restoring nef6 to offset 0 (recreate)...')
    if not recreate_nef6(None):
        sys.exit(1)
    if not settled(opers):
        print('bed did not resettle after nef6 restart')
        sys.exit(1)

    # ---- backward leg: BOOT-time -300 on nef6 ----
    print('recreating nef6 with boot offset -300...')
    if not recreate_nef6(-300):
        sys.exit(1)
    warn = dlog('nefarious6', '90s', r'FAKE CLOCK OFFSET')
    print('nef6 boot warning: %s' % (warn[-1].split('SYSTEM')[-1].strip() if warn else 'MISSING'))
    ok_boot = bool(warn) and '-300' in (warn[-1] if warn else '')
    base_b = settled(opers, timeout=240)
    if not base_b:
        print('bed did not settle with nef6 at -300 (past beacons)')
        ok_back = False
    else:
        b = {n: base_b[n] for n in ('nef3', 'nef4', 'nef6')}
        print('settled with nef6 at -300: %s' % {n: (v['reachable'], v['stubs']) for n, v in b.items()})
        ok_back = watch_leg(opers, 'back', b, 110, '3+ ticks of past-stamped beacons')

    print('restoring nef6 to offset 0...')
    if not recreate_nef6(None):
        sys.exit(1)
    conv_views = settled(opers, timeout=240)
    conv = conv_views is not None
    print('final resettle: %s' % conv)
    if conv:
        _, _, snap = wait_converged(opers, timeout=40)
        report_digests(snap)
    rc = {n: sh('docker', 'inspect', '-f', '{{.RestartCount}}', c).stdout.strip()
          for n, (c, _) in NODES.items()}
    ok_rc = all(v == '0' for v in rc.values())
    print('restart counts:', rc)

    verdict = ok_fwd and ok_boot and ok_back and conv and ok_rc
    print('\nS4-M2 %s  (fwd=%s boot_warn=%s back=%s conv=%s no_restarts=%s)'
          % ('PASS' if verdict else 'FAIL', ok_fwd, ok_boot, ok_back, conv, ok_rc))
finally:
    close_all(opers)

sys.exit(0 if verdict else 1)
