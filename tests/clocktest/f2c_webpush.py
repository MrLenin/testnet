#!/usr/bin/env python3
"""Tier C F2-c — WEBPUSH subscription convergence over the mesh (acceptance gate).

Pre-F2-c: push subscriptions live in a per-server LMDB store, synced only by
the P10 WP tree broadcast/burst. A subscription registered on the hub never
reaches an overlay-only leaf and does not survive a tree-cut partition — so a
mobile push for a user whose bouncer session / missed message lands on such a
node silently fails. F2-c mirrors the subscription into the CRDT doc; the
leaf's reconcile materializes it into its own webpush_store.

This driver forces the DOC to be the only delivery path (the p1_doconly
recipe) and proves the cut leaf materializes the subscription:

 1. client A auths on hub nef3, WEBPUSH REGISTER endpoint E1 -> converges to
    nef4 while the tree is up (baseline).
 2. cut the nef3<->nef4 tree link (netshoot sidecar in nef4's netns). The doc
    still flows nef4 --overlay-- nef5 --tree-- nef3; the P10 WP broadcast
    cannot cross (nef4's only tree path to nef3 is the cut link).
 3. REGISTER a SECOND endpoint E2 on nef3 -> doc-only path to nef4.
 4. assert nef4's reconcile log shows E2 materialized into its store (the
    "CRDT F2-c: webpush reconcile applied" line), and mesh mdigest converges.
 5. UNREGISTER E2 on nef3 -> the tombstone converges -> nef4 reconcile reaps it.
 6. restore the link; mesh reconverges.

Observability: there is no client-facing "list my subscriptions", so the gate
reads nef4's reconcile log (applied/removed counts) + the mesh digest (the
convergence oracle). No real push delivery is exercised.
"""
import subprocess
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

E1 = 'https://push.example.com/f2c/%d-one' % int(time.time())
E2 = 'https://push.example.com/f2c/%d-two' % int(time.time())
KEYS = 'p256dh=BJxF2cP256dhKeyExampleValue0123456789abcdef;auth=authSecret012345'
SIDECAR = 'f2ccut'


def ip_of(container):
    r = subprocess.run(
        ['docker', 'inspect', '-f',
         '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container],
        capture_output=True, text=True)
    return r.stdout.strip()


def sidecar_exec(args):
    return subprocess.run(['docker', 'exec', SIDECAR] + args,
                          capture_output=True, text=True)


def cut_link(nef3_ip):
    subprocess.run(['docker', 'rm', '-f', SIDECAR], capture_output=True, text=True)
    subprocess.run(
        ['docker', 'run', '--rm', '-d', '--name', SIDECAR,
         '--net=container:nefarious4', '--cap-add', 'NET_ADMIN',
         'nicolaka/netshoot', 'sleep', '900'], capture_output=True, text=True)
    time.sleep(2)
    sidecar_exec(['iptables', '-I', 'INPUT', '-s', nef3_ip, '-j', 'DROP'])
    sidecar_exec(['iptables', '-I', 'OUTPUT', '-d', nef3_ip, '-j', 'DROP'])
    sidecar_exec(['ss', '-K', 'dst', nef3_ip])


def restore_link(nef3_ip):
    r = subprocess.run(['docker', 'ps', '-q', '-f', 'name=' + SIDECAR],
                       capture_output=True, text=True)
    if not r.stdout.strip():
        subprocess.run(
            ['docker', 'run', '--rm', '-d', '--name', SIDECAR,
             '--net=container:nefarious4', '--cap-add', 'NET_ADMIN',
             'nicolaka/netshoot', 'sleep', '60'], capture_output=True, text=True)
        time.sleep(2)
    sidecar_exec(['iptables', '-D', 'INPUT', '-s', nef3_ip, '-j', 'DROP'])
    sidecar_exec(['iptables', '-D', 'OUTPUT', '-d', nef3_ip, '-j', 'DROP'])
    subprocess.run(['docker', 'rm', '-f', SIDECAR], capture_output=True, text=True)


def auth(c, acct='testadmin', pw='testadmin123', tries=4):
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


def nef4_reconcile_hits(since_s, needle):
    """Count 'webpush reconcile applied/removed' log lines mentioning needle activity."""
    lg = subprocess.run(['docker', 'logs', '--since', '%ds' % since_s, 'nefarious4'],
                        capture_output=True, text=True)
    return [l for l in (lg.stdout + lg.stderr).splitlines()
            if 'F2-c: webpush reconcile' in l and needle in l]


nef3_ip = ip_of('nefarious3')
verdict = False
A = None
t_start = time.time()
try:
    A = Irc('nef3', 'wpA').connect()
    A.cap_req('draft/webpush')
    ok_auth = auth(A)
    print('A authed=%s' % ok_auth)

    # 1. baseline register (tree up). NB nef4 materializes E1 from the fast P10
    #    WP broadcast, NOT the doc reconcile (the echo-guard then skips it) — so
    #    the doc-only proof is deliberately E2 AFTER the cut, not E1. Baseline
    #    here just confirms REGISTER works (server echoes it).
    reg_ok = [False]

    def w1(p):
        if p['cmd'] == 'WEBPUSH' and E1 in (p['args'] or []):
            reg_ok[0] = True
    A.send('WEBPUSH REGISTER %s %s' % (E1, KEYS))
    try:
        A.wait(lambda p: reg_ok[0], 6, on_line=w1)
    except TimeoutError:
        pass
    baseline = reg_ok[0]
    print('baseline REGISTER E1 echoed: %s' % ('PASS' if baseline else 'FAIL'))
    time.sleep(4)

    # 2. cut nef3<->nef4 tree link
    print('cutting nef3<->nef4 tree link (%s)...' % nef3_ip)
    cut_link(nef3_ip)
    time.sleep(6)

    # 3. register E2 on nef3 -> doc-only path to nef4
    t_cut = time.time()
    A.send('WEBPUSH REGISTER %s %s' % (E2, KEYS))
    A.drain(2.0)
    print('registered E2 on nef3 (tree link cut; doc-only to nef4)')

    # 4. nef4 must materialize E2 via the doc (reconcile-applied log after the cut)
    doc_applied = False
    for _ in range(20):
        if nef4_reconcile_hits(int(time.time() - t_cut) + 2, 'applied'):
            doc_applied = True
            break
        time.sleep(3)
    print('E2 doc-only -> nef4 reconcile applied: %s' % ('PASS' if doc_applied else 'FAIL'))

    # 5. unregister E2 -> tombstone converges -> nef4 reconcile removes it
    t_del = time.time()
    A.send('WEBPUSH UNREGISTER %s' % E2)
    A.drain(2.0)
    doc_removed = False
    for _ in range(20):
        if nef4_reconcile_hits(int(time.time() - t_del) + 2, 'removed'):
            doc_removed = True
            break
        time.sleep(3)
    print('E2 unregister -> nef4 reconcile removed: %s' % ('PASS' if doc_removed else 'FAIL'))

    # 6. restore + mesh reconverges
    print('restoring nef3<->nef4 link...')
    restore_link(nef3_ip)
    time.sleep(8)
    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='wpM')
    conv, tc, _ = wait_converged(opers, timeout=150)
    close_all(opers)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = (ok_auth and baseline and doc_applied and doc_removed and conv)
    print('\nF2C-WEBPUSH %s  (auth=%s baseline=%s doc_applied=%s doc_removed=%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', ok_auth, baseline, doc_applied,
             doc_removed, conv))
finally:
    restore_link(nef3_ip)
    try:
        if A:
            A.close()
    except Exception:
        pass

sys.exit(0 if verdict else 1)
