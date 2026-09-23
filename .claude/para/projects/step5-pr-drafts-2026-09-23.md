# Step 5: PR drafts and push commands (2026-09-23)

Everything below is unpushed. Order: the nefarious pushes carry no PR (ircv3-only);
the x3 Part A PR is independent; the x3 Part C PR opens only after step 4 merges.

## nefarious: direct pushes, no PR

Both branches are off `origin/ircv3.2-hardening` 4de99fa. Push each to both fork
branches on both remotes, one command per branch and remote (worktrees are under the
session scratchpad, or run these from the bed checkout; `bed-deploy` already carries
the merges).

```bash
cd /home/ibutsu/testnet/nefarious
# fix/authenticate-reauth-dispatch (c045c2d, fd1142b, c33c50d)
git push origin   fix/authenticate-reauth-dispatch:ircv3.2-hardening
git push origin   fix/authenticate-reauth-dispatch:ircv3.2-upgrade
git push upstream fix/authenticate-reauth-dispatch:ircv3.2-hardening
git push upstream fix/authenticate-reauth-dispatch:ircv3.2-upgrade
# fix/wire-keycloak-id (27be7e6 .. fe8f65d)
git push origin   fix/wire-keycloak-id:ircv3.2-hardening
git push origin   fix/wire-keycloak-id:ircv3.2-upgrade
git push upstream fix/wire-keycloak-id:ircv3.2-hardening
git push upstream fix/wire-keycloak-id:ircv3.2-upgrade
```

If `ircv3.2-upgrade` has diverged from hardening, push the branches to hardening and
merge hardening into upgrade as usual.

## x3 PR 1: `fix/ac-account-change` → evilnet/x3 master (2 commits off 5d7fadb)

**Title:** proto-p10: follow the ircd's AC M and AC U, and pass the timestamp and id through

**Body:**

`cmd_account` handled only the C/H/S/R subcommands; every other letter fell through
to `call_account_func(user, argv[2])`, the letter itself as an account name. An
account change (`AC M`) left the user on the previous handle, an account removal
(`AC U`) left the user bound, and the A/D replies to X3's own S/H requests were looked
up as handles.

- `M` drops the old binding and binds `argv[3]` through the same path as `R`, so the
  same checks apply. `U` unbinds only: `FLAGS_STAMPED` is deliberately never cleared
  (one account per session), as after UNREGISTER. `A` and `D` are ignored. The legacy
  two-argument form `AC <user> <account> [ts]` is still accepted. `R`/`M` with no
  account are ignored instead of reading past `argv`.
- `R` and `M` now hand nickserv what the ircd sent, in the burst's form
  `account[:timestamp[:id]]`, so the timestamp and anything after it reach
  `handle_account` the way they do from `+r`. Today `handle_account` reads the
  timestamp and ignores the rest.
- `nickserv_unbind_user()` is the small exported entry point; the binding helper
  itself stays static.

Tested on the Afternet testnet (Vitest, gated `X3_AC_CHANGE=1`): an OAUTHBEARER
re-authentication to another account makes X3 follow (`AC M`); the ircd's webhook
deauth (`AC U`) leaves the user unbound.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## x3 PR 2: `feature/keycloak-id-binding` → evilnet/x3 master (6 commits off step 4's 77bd045)

Open after step 4 (`nickserv: LOCAL flag`) merges, then rebase onto master. Do not
stack it on step 4's PR.

**Title:** nickserv: bind a handle to its Keycloak user id; refuse a different one

**Body:**

The ircd now announces each account with the user's Keycloak id: `AC R|M <account>
<ts> <id>` and, in the burst, `+r account:ts:id` (the id is the 16 UUID bytes as 22
unpadded base64url characters). X3 uses it as the identity behind a name:

- `handle_info.kc_id`, persisted in saxdb as `kc_id` (the legacy key `id` is dead and
  stays unused), freed with the handle.
- `handle_account` parses the id. A handle with none adopts it once the login goes
  through (after the timestamp and suspension checks, and also for a handle the LDAP
  autocreate made on that login). The same id is accepted. A different id is a
  different Keycloak user with this name, typically the name deleted and recreated in
  Keycloak, and is refused with the LOCAL rule: refused only during a burst, since the
  announcement may replay a legitimate login; refused and disconnected otherwise,
  because X3 cannot take back an account the ircd already set. No id on the wire
  leaves the handle alone, so older servers and services relays behave as before.
- `REBIND <*account> <keycloak-uuid|*>` (oper level 800, through `get_victim_oper`'s
  outranking; deliberately not an OSET option, which SEARCH SET could apply without
  that check) sets the id from the admin console or clears it so the next login
  adopts one. For an account whose Keycloak user was legitimately recreated.
- ACCOUNTINFO shows the id in the oper-gated part of the reply.

**Operator note:** a service that already has saved command bindings does not pick up
a module's new commands on restart; bind the new one once:
`/msg O3 BIND AuthServ REBIND *nickserv.rebind`.

Tested on the Afternet testnet (Vitest, gated `KC_ID_BIND=1`): adopt on first login
and across logins; refusal and disconnect of a recreated user, on connect and on a
post-registration authentication; refusal without disconnect during a burst, across a
hop and a relink; REBIND to a UUID and to `*`; ACCOUNTINFO. The step-4 LOCAL suite
still passes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
