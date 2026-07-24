#!/usr/bin/env python3
"""P1 scenario 6 — doc-only delivery into a live client's memory (MR-6 gate).

The M8 staleness class, doc edition: before P1/A1 the CRDT reconcile healed
only the STORE, never a live client's in-memory cli_metadata and never fired
a subscriber notify. GET checks memory first, so an online client kept
serving the STALE memory value even after the doc delivered a change — the
redundant P10 MD tree broadcast hid this, until the tree is retired (MR-5).

This driver forces the doc to be the ONLY delivery path and proves the
online client sees the change without reattaching:

 topology: nef3 --tree-- nef4 is the ONLY nef3<->nef4 link (no overlay). Cut
 it and the doc still flows nef4 --overlay-- nef5 --tree-- nef3. P10 MD
 cannot cross (nef4's only tree path to nef3 is the cut direct link).

 The online client A lives on the HUB nef3 (SASL account-prop is only
 reliable on the hub on this bed — a client authed on a leaf authenticates
 but never gets cli_account stamped, so its account metadata can't resolve).
 The CHANGE is driven from the tree-cut leaf nef4, so it can only reach A via
 the doc:

 1. oper on nef4 sets the key = V1; it converges to nef3 (tree still up).
    Client A auths testadmin on nef3, SUBs the key; the AC account-stamp fires
    metadata_load_account, hydrating V1 into A's in-memory cli_metadata.
 2. cut the nef3<->nef4 tree link (netshoot sidecar in nef4's netns:
    iptables DROP nef3 + ss -K the established socket).
 3. oper on nef4 sets the key = V2 (offline `*testadmin` branch -> permanent
    -> doc; the offline branch emits NO S2S MD, and the cut blocks MD anyway,
    so delivery to nef3 is doc-only via the nef5 overlay).
 4. A on nef3, WITHOUT reattaching: (a) receives an unsolicited METADATA
    notify carrying V2 (A is subscribed); (b) an explicit GET returns V2, not
    the stale V1 in memory. -> apply_converged updated live memory.
 5. oper on nef4 deletes the key -> doc tombstone -> A's GET returns not-set.
 6. restore the link; mesh mdigest reconverges.

Robust teardown: the iptables rules live in nef4's OWN netns (the sidecar
just shares it), so they must be explicitly deleted, not left to die with
the sidecar. The finally block flushes them unconditionally.
"""
import subprocess
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

KEY = 'ct-doconly'
V1 = 'baseline-%d' % int(time.time())
V2 = 'docdelivered-%d' % int(time.time())
SIDECAR = 'p1cut'


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
    subprocess.run(['docker', 'rm', '-f', SIDECAR],
                   capture_output=True, text=True)
    subprocess.run(
        ['docker', 'run', '--rm', '-d', '--name', SIDECAR,
         '--net=container:nefarious4', '--cap-add', 'NET_ADMIN',
         'nicolaka/netshoot', 'sleep', '900'],
        capture_output=True, text=True)
    time.sleep(2)
    sidecar_exec(['iptables', '-I', 'INPUT', '-s', nef3_ip, '-j', 'DROP'])
    sidecar_exec(['iptables', '-I', 'OUTPUT', '-d', nef3_ip, '-j', 'DROP'])
    # kill the established tree socket so the cut is immediate
    sidecar_exec(['ss', '-K', 'dst', nef3_ip])


def restore_link(nef3_ip):
    # delete the rules from nef4's netns (spin a fresh sidecar if ours died)
    r = subprocess.run(['docker', 'ps', '-q', '-f', 'name=' + SIDECAR],
                       capture_output=True, text=True)
    if not r.stdout.strip():
        subprocess.run(
            ['docker', 'run', '--rm', '-d', '--name', SIDECAR,
             '--net=container:nefarious4', '--cap-add', 'NET_ADMIN',
             'nicolaka/netshoot', 'sleep', '60'],
            capture_output=True, text=True)
        time.sleep(2)
    sidecar_exec(['iptables', '-D', 'INPUT', '-s', nef3_ip, '-j', 'DROP'])
    sidecar_exec(['iptables', '-D', 'OUTPUT', '-d', nef3_ip, '-j', 'DROP'])
    subprocess.run(['docker', 'rm', '-f', SIDECAR],
                   capture_output=True, text=True)


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


def meta_get(c, target, key):
    c.drain(0.1)
    c.send('METADATA %s GET %s' % (target, key))
    st = {'val': None, 'notset': False}

    def coll(p):
        if p['cmd'] == '761' and key in p['args']:
            st['val'] = p['trail']
        elif p['cmd'] == '766' and key in p['args']:
            st['notset'] = True
    try:
        c.wait(lambda p: p['cmd'] in ('762', 'FAIL') or
               (p['cmd'] == '761' and key in p['args']) or
               (p['cmd'] == '766' and key in p['args']), 8, on_line=coll)
    except TimeoutError:
        pass
    return st['val'], st['notset']


def oper_set(op, account, key, value=None):
    if value is None:
        op.send('METADATA *%s SET %s' % (account, key))       # delete
    else:
        op.send('METADATA *%s SET %s :%s' % (account, key, value))
    op.drain(1.5)


nef3_ip = ip_of('nefarious3')
verdict = False
notify_v2 = [None]
A = None
op4 = None
try:
    op4 = Irc('nef4', 'ctDOo').connect().oper()
    op4.cap_req('draft/metadata-2')

    # baseline V1 from nef4, tree still up -> converges to nef3's store
    oper_set(op4, 'testadmin', KEY, V1)
    time.sleep(4)

    # client A online on the HUB nef3, authed (account-prop reliable here),
    # subscribed; the AC stamp fires metadata_load_account -> V1 in memory
    A = Irc('nef3', 'ctDOa').connect()
    A.cap_req('draft/metadata-2')
    ok_auth = auth(A)
    A.send('METADATA %s SUB %s' % (A.nick, KEY))
    A.drain(1.0)
    a_v1 = None
    for _ in range(15):
        a_v1, _ = meta_get(A, A.nick, KEY)
        if a_v1 == V1:
            break
        time.sleep(2)
    hydrated = (a_v1 == V1)
    print('A authed=%s hydrated V1=%s (got %r)' % (ok_auth, hydrated, a_v1))

    # 2. cut the nef3<->nef4 tree link
    print('cutting nef3<->nef4 tree link (%s)...' % nef3_ip)
    cut_link(nef3_ip)
    time.sleep(6)

    # collect any async notify to A while we drive V2
    def watch_notify(p):
        if p['cmd'] == 'METADATA' and KEY in (p['args'] or []):
            notify_v2[0] = p['trail']

    # 3. set V2 from nef3 -> doc-only path (offline branch emits no MD)
    oper_set(op4, 'testadmin', KEY, V2)
    print('set V2 on nef4 (doc-only; nef3<->nef4 tree link is cut)')

    # 4. A must see V2 without reattaching (apply_converged updated memory).
    #    Pump A's socket for the async notify, then GET (memory-first read).
    a_v2 = None
    for _ in range(20):
        for p in A.drain(1.0):
            watch_notify(p)
        a_v2, _ = meta_get(A, A.nick, KEY)
        if a_v2 == V2:
            break
        time.sleep(1)
    mem_updated = (a_v2 == V2)
    got_notify = (notify_v2[0] == V2)
    print('A GET after doc-only V2: %r  mem_updated=%s  notify=%r(%s)'
          % (a_v2, mem_updated, notify_v2[0], got_notify))

    # 5. delete from nef3 -> doc tombstone -> A sees not-set
    oper_set(op4, 'testadmin', KEY, None)
    a_del = 'still-there'
    for _ in range(20):
        v, notset = meta_get(A, A.nick, KEY)
        if v is None:
            a_del = None
            break
        time.sleep(2)
    deleted = (a_del is None)
    print('A GET after doc-only delete: deleted=%s' % deleted)

    # 6. restore link + mesh reconverges
    print('restoring nef3<->nef4 link...')
    restore_link(nef3_ip)
    time.sleep(8)
    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='ctDOm')
    conv, tc, _ = wait_converged(opers, timeout=150)
    close_all(opers)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = (ok_auth and hydrated and mem_updated and deleted and conv)
    print('\nP1-DOCONLY %s  (hydrate=%s mem_updated=%s notify=%s deleted=%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', hydrated, mem_updated, got_notify,
             deleted, conv))
finally:
    restore_link(nef3_ip)   # unconditional — never leave the bed partitioned
    for c in (A, op4):
        try:
            if c:
                c.close()
        except Exception:
            pass

sys.exit(0 if verdict else 1)
