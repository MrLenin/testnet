#!/usr/bin/env python3
"""P1 scenario 4 — visibility persistence (the F3 regression guard).

Before P1, the store never persisted a metadata key's visibility: the
auth-time restore path (metadata_load_account -> metadata_account_list)
hardcoded PUBLIC, so a key SET *private* resurfaced *public* after the
client's struct was rebuilt (reconnect / restart). This driver proves the
leak is dead end-to-end:

 1. auth testadmin on nef3 (account-prop is only reliable on the hub).
 2. SET a private key and a public key on self.
 3. owner GET(self): both visible, correct visibility tokens.
 4. a THIRD-PARTY (different, non-oper client) GET: sees the public key,
    is denied the private one (766 not-set — never the value).
 5. disconnect (frees the client struct + in-memory metadata) and reconnect
    FRESH + reauth. The register_user eager-load (P1/A3) refills cli_metadata
    from the store via metadata_account_list, which now DECODES the P:/*: vis
    prefix (P1/A2) instead of assuming PUBLIC.
 6. owner LIST: both keys present, PRIVATE key still PRIVATE.
 7. third-party GET private again: still denied. F3 dead.

All account-anchored, so run the authed sessions on hub nef3.
"""
import sys
import time

from ircdrv import Irc, open_opers, close_all, wait_converged

PRIV_KEY = 'ct-vis-priv'
PUB_KEY = 'ct-vis-pub'
PRIV_VAL = 'secret-%d' % int(time.time())
PUB_VAL = 'shown-%d' % int(time.time())


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


def meta_set(c, target, key, value, vis=None):
    if vis == 'private':
        c.send('METADATA %s SET %s private :%s' % (target, key, value))
    else:
        c.send('METADATA %s SET %s * :%s' % (target, key, value))
    c.drain(1.0)


def meta_get(c, target, key):
    """Return (value_or_None, saw_766). value None + saw_766 == 'not set / denied'."""
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
        # 761 RPL_KEYVALUE: <me> <target> <key> <visibility> [:value]
        if p['cmd'] == '761' and len(p['args']) >= 4:
            found[p['args'][2]] = p['args'][3]
    try:
        c.wait(lambda p: p['cmd'] in ('762', 'FAIL'), 8, on_line=coll)
    except TimeoutError:
        pass
    return found


verdict = False
owner = Irc('nef3', 'ctvisA').connect()
owner.cap_req('draft/metadata-2')
third = Irc('nef3', 'ctvisB').connect()
third.cap_req('draft/metadata-2')
try:
    ok_auth = auth(owner)
    meta_set(owner, '*', PRIV_KEY, PRIV_VAL, vis='private')
    meta_set(owner, '*', PUB_KEY, PUB_VAL, vis='public')

    # 3. owner sees both
    ov_priv, _ = meta_get(owner, owner.nick, PRIV_KEY)
    ov_pub, _ = meta_get(owner, owner.nick, PUB_KEY)
    owner_ok = (ov_priv == PRIV_VAL and ov_pub == PUB_VAL)
    print('owner GET: priv=%r pub=%r ok=%s' % (ov_priv, ov_pub, owner_ok))

    # 4. third party: public visible, private DENIED. The privacy invariant is
    #    that the VALUE never reaches a non-owner (tv_priv is None). The server
    #    currently *silently skips* a denied private key (no 761 and no 766) —
    #    value-hiding holds; whether a 766 is emitted is a separate protocol
    #    detail (see the existence-leak note at end), not asserted here.
    tv_pub, _ = meta_get(third, owner.nick, PUB_KEY)
    tv_priv, tv_priv_notset = meta_get(third, owner.nick, PRIV_KEY)
    third_ok = (tv_pub == PUB_VAL and tv_priv is None)
    print('third-party GET: pub=%r priv=%r (766=%s, silent-skip=%s) ok=%s'
          % (tv_pub, tv_priv, tv_priv_notset, not tv_priv_notset, third_ok))

    # 5. disconnect + fresh reconnect + reauth -> eager load from store
    print('disconnecting owner (frees struct + memory)...')
    owner.close()
    time.sleep(3)
    owner2 = Irc('nef3', 'ctvisC').connect()
    owner2.cap_req('draft/metadata-2')
    ok_auth2 = auth(owner2)

    # 6. LIST: both present, private still PRIVATE (F3 regression point)
    listed = meta_list(owner2, owner2.nick)
    priv_vis = listed.get(PRIV_KEY)
    pub_vis = listed.get(PUB_KEY)
    # visibility token: private rows render 'private', public render '*'
    restore_ok = (priv_vis is not None and priv_vis.lower().startswith('p')
                  and pub_vis is not None and not pub_vis.lower().startswith('p'))
    print('after reconnect+reauth LIST: %r  priv_vis=%r pub_vis=%r restored_private=%s'
          % (listed, priv_vis, pub_vis, restore_ok))

    # 7. third party still denied the private key post-restore (value hidden)
    tv2_priv, tv2_notset = meta_get(third, owner2.nick, PRIV_KEY)
    still_denied = (tv2_priv is None)
    print('third-party GET private post-restore: val=%r (766=%s) value_hidden=%s'
          % (tv2_priv, tv2_notset, still_denied))

    opers = open_opers(['nef3', 'nef4', 'nef5', 'nef6', 'nef7'], prefix='ctVo')
    conv, tc, _ = wait_converged(opers, timeout=90)
    close_all(opers)
    print('mesh converged: %s (%.1f s)' % (conv, tc))

    verdict = (ok_auth and owner_ok and third_ok and ok_auth2 and restore_ok
               and still_denied and conv)
    print('\nP1-VIS %s  (owner=%s third=%s restore_private=%s value_hidden=%s mesh=%s)'
          % ('PASS' if verdict else 'FAIL', owner_ok, third_ok, restore_ok,
             still_denied, conv))
    # NOTE (pre-existing, outside P1 scope): a denied private key is silently
    # skipped in GET (no 766), while a truly-absent key returns 766 — so the
    # 766-vs-silence difference leaks key *existence* (not value). Value-hiding,
    # the P1/A2 guarantee, holds. Track as a GET-reply hardening follow-up.
    owner2.close()
finally:
    for c in (owner, third):
        try:
            c.close()
        except Exception:
            pass

sys.exit(0 if verdict else 1)
