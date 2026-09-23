# Step 5: PR drafts and push commands (2026-09-23)

**Done 2026-09-23 (nefarious + x3 Part A branch).** `fix/authenticate-reauth-dispatch`
and `fix/wire-keycloak-id` were siblings off 4de99fa (neither contained the other), so the
per-branch sequence below could not fast-forward past the second push. What was pushed:
the re-auth branch as listed (4de99fa..c33c50d), then one conventional merge commit
`75d8101` ("Merge branch 'fix/bouncer-deauth-correctness' into ircv3.2-hardening",
carrying fix/wire-keycloak-id and the deauth branch on top of it), to both fork branches
on both remotes. All four tips are 75d8101. x3 `fix/ac-account-change` is on
MrLenin/x3 (5ee1a88); the PR is yours to open with the body below. The Part C branch
stays local until step 4 merges.

Order: the nefarious pushes carry no PR (ircv3-only); the x3 Part A PR is independent;
the x3 Part C PR opens only after step 4 merges.

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

## nefarious: fix/bouncer-deauth-correctness, after fix/wire-keycloak-id

13 commits (9fb2c6e .. fe82551) on top of fix/wire-keycloak-id's fe8f65d: the bouncer
deauth correctness plan (`2026-09-22-bouncer-deauth-correctness.md`) plus its review
fix pass. Fork-only paths (bouncer, Keycloak webhook, oper CHECK), so direct pushes to
both fork branches on both remotes, one command per branch, AFTER the step-5 pushes
above (the branch fast-forwards on top of them).

```bash
git push origin   fix/bouncer-deauth-correctness:ircv3.2-hardening
git push origin   fix/bouncer-deauth-correctness:ircv3.2-upgrade
git push upstream fix/bouncer-deauth-correctness:ircv3.2-hardening
git push upstream fix/bouncer-deauth-correctness:ircv3.2-upgrade
```

Behaviour change worth a line in the announcement: an account disable/delete event
now deauths every server's sessions from whichever server receives it (AC U), takes
a held session's ghost with the session, and `WEBHOOK_KILL_ON_DELETE` defaults to
off (deauth) -- a kill takes the whole session down first, aliases on other servers
included.

## nefarious: fix/webhook-subject-by-id (webhook plan 2), after the pushes above

9 commits (70f1a09 .. 7b65b7a) on top of 75d8101 (the tip both fork branches are at):
the subject of a USER admin event resolved by Keycloak id, cache purge by id and the
`CI <name|*> [<id>]` form, the handler rewrite, the review fix pass (sub-resource
paths are not the user, credential removal purges, the module gated on the Keycloak
build, names from the purged cache reach id-less sessions, synthetic fixtures).
Fork-only paths, so direct pushes to both fork branches on both remotes, one command
per branch; the branch fast-forwards on top of 75d8101.

```bash
cd /home/ibutsu/testnet/nefarious
git push origin   fix/webhook-subject-by-id:ircv3.2-hardening
git push origin   fix/webhook-subject-by-id:ircv3.2-upgrade
git push upstream fix/webhook-subject-by-id:ircv3.2-hardening
git push upstream fix/webhook-subject-by-id:ircv3.2-upgrade
```

Announcement lines: a Keycloak delete, disable, admin password reset or credential
removal now reaches the ircd by the user's Keycloak id (no username needed); `CI`
carries the id; sessions authenticated through X3, a legacy hop, or restored from the
bouncer DB carry no id and are reached only through a name (a warning names the id);
`--disable-keycloak` builds again include none of it.

## keycloak-webhook-spi: docs/ircd-contract → evilnet/keycloak-webhook-spi main

2 commits (c195c7a, f8a6e1c) off main 6c2c54d, documentation only: the README's event
formats and a consumer-contract table for the ircd, Java comments re-anchored from X3
to the ircd. The repository's only remote is evilnet itself, so the branch has to be
pushed there to open the PR:

```bash
cd /home/ibutsu/testnet/keycloak-webhook-spi
git push origin docs/ircd-contract
```

**Title:** docs: the payload contract is the Nefarious ircd's, not X3's

**Body:** X3 stopped consuming these events; the README and the code comments still
described what X3's resolver expected. Document what the ircd reads: the subject of a
USER admin event is the resourcePath uuid (only the bare `users/<uuid>` path is the
user; a credential removal purges; other sub-resources are nothing), authDetails is the
acting admin, only credential user events carry a username, and which sessions a
nameless event reaches. No payload change.

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
