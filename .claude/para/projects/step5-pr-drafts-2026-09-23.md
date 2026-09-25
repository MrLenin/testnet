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

**PUSHED 2026-09-24** as part of the fix/webhook-transport push (32e3664 contains it).

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

## nefarious: fix/webhook-transport (webhook plan 3), after fix/webhook-subject-by-id

**PUSHED 2026-09-24:** the four fork branches (origin and upstream, ircv3.2-hardening and ircv3.2-upgrade) fast-forwarded 75d8101 -> 32e3664, which carries plan 2's nine commits and plan 3's seven. The section below is the record of what went.

7 commits (cde1b99 .. 32e3664) on top of 7b65b7a (plan 2's tip): the four task commits,
the review fix pass (ead82a8: eight feature-less STATS entries were a non-oper server
abort through feature_bool's assert, now oper-only 481 -- this one touches
webpush/authtoken/chathistory/metadata/dnsbl/gitsync too; e48d764: stub build, replay
ring, realmName-less payloads counted, a failed listener start is loud) and the user's
retry decision (32e3664: the SPI's re-signed retry of an accepted event is a duplicate,
answered 200 and not acted on; a same-timestamp copy stays a 401 replay; the realm check
runs before the ring; an id the queue could not take is forgotten): libkc verifies the SPI's signature (HMAC-SHA256 over
`<t>.<body>`, 300 s window, a ring of recent event ids refuses replays), the listener
refuses unsigned/stale/replayed (401) and other-realm (403) deliveries at HTTP time and
counts each cause, the whole `Webhook {}` block reaches the listener (`vhost`, `path`,
limits) plus `signaturewindow`, `legacysecret` (default no) and `realm` (default: the
Keycloak block's), a secret-only REHASH keeps the listener and its counters,
`STATS webhook` and a per-cause `SNO_UNAUTH` notice, and a payload username is used
only if it can travel the wire. Fork-only paths, so direct pushes to both fork branches
on both remotes, one command per branch; the branch fast-forwards on top of
`fix/webhook-subject-by-id`.

```bash
cd /home/ibutsu/testnet/nefarious
git push origin   fix/webhook-transport:ircv3.2-hardening
git push origin   fix/webhook-transport:ircv3.2-upgrade
git push upstream fix/webhook-transport:ircv3.2-hardening
git push upstream fix/webhook-transport:ircv3.2-upgrade
```

Rollout on prod (SPI first): the ircd refuses every unsigned delivery once deployed,
so the signing SPI (`feature/signed-events`) goes into Keycloak before the ircd, or the
ircd's `Webhook {}` block carries `legacysecret = yes;` for the minutes between (then
drop it). The realm check keys on the Keycloak block's `realm`; the SPI sends the
realm's name, so the two must agree (`Webhook { realm = "..."; }` overrides). The bed's
confs still use the deprecated `WEBHOOK_PORT`/`WEBHOOK_SECRET` features (a CONFIG
warning says so); prod should move to a `Webhook {}` block with `vhost` on the private
interface. `STATS webhook` shows the counters; refusals reach opers on the
"unauthorized connections" snomask once per cause per minute.

## nefarious: feature/webhook-every-server (webhook plan 4), after fix/webhook-transport

**PUSHED 2026-09-24:** the four fork branches (origin and upstream, ircv3.2-hardening and ircv3.2-upgrade) fast-forwarded 32e3664 -> 028de05. The SPI README commit 063e616 went straight to evilnet main (a340a9d -> 063e616). The section below is the record.

7 commits (68e3b6f .. 028de05) on top of 32e3664 (the tip every fork branch is at since
the 2026-09-24 push): the applied-events log; the relay parser and kind letters; the
deauth classifier's `remote_ok` (a remote client is its home server's job); one relay per
event (`CI <names|*> <kc_id|*> <event_id> <kind>`) deduped by the event id, the receiver
applying to what it owns; the catch-up at end of burst with enable-supersedes-disable
compaction; a bare enable relayed; the review fix pass (the catch-up carries the resolved
names, compaction keeps insertion order, the KILL fallback stays local). Fork-only paths:
direct pushes to both fork branches on both remotes, one command per branch; the branch
fast-forwards on top of 32e3664.

```bash
cd /home/ibutsu/testnet/nefarious
git push origin   feature/webhook-every-server:ircv3.2-hardening
git push origin   feature/webhook-every-server:ircv3.2-upgrade
git push upstream feature/webhook-every-server:ircv3.2-hardening
git push upstream feature/webhook-every-server:ircv3.2-upgrade
```

Rollout on prod (if the push ships at all — Rubin 2026-09-24 does not want it now): the SPI's URL list names at least one hub (every ircd is the most reliable shape, not a requirement) (`KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL`
is comma-separated; a Keycloak restart reads it); the whole ircd chain deploys together (a
server without this code purges on a relay but deauths nobody, and a new server's `AC U`
can strand a held ghost it owns); `WEBHOOK_KILL_ON_DELETE` / `_DISABLE` must be set the
same on every server. New features `WEBHOOK_EVENTLOG_SIZE` (1024) and
`WEBHOOK_EVENTLOG_WINDOW` (86400 s); `STATS webhook` gains the applied / already-applied /
relays / catch-up lines. SPI: one README commit (063e616, local, unpushed: "list every
ircd") for a direct push to main when convenient.

## keycloak-webhook-spi: two PRs, both off main 6c2c54d (decision 2026-09-24: one subject each)

**PUSHED DIRECTLY 2026-09-24 (user: "spi can be directly pushed"):** main 6c2c54d -> f8a6e1c (the docs commits) -> a340a9d (the signing commits rebased on top: 94535e2, a340a9d). No PRs. The sections below are the record.

Neither branch is based on the other (the user's rule: never stack). Both touch
`README.md` and the Java file, so whichever merges second needs a rebase onto the new
main before its merge; the executor rebases on request. The repository's only remote is
evilnet itself, so each branch is pushed there to open its PR.

### PR A: docs/ircd-contract (f8a6e1c, 2 commits: c195c7a, f8a6e1c)

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

### PR B: feature/signed-events (86213bc, 2 commits: 47963e0, 86213bc)

```bash
cd /home/ibutsu/testnet/keycloak-webhook-spi
git push origin feature/signed-events
```

**Title:** spi: sign every delivery and name the realm

**Body:** A consumer that only checked the static `X-Webhook-Secret` header could be fed
a captured delivery again (a replayed USER delete is a deauth), a stale one, or one from
another realm. Each delivery now carries `X-Webhook-Signature: t=<unix seconds>,v1=<hex>`
where the digest is HMAC-SHA256 over `<t>.<body>` with the shared secret, and every
payload names its realm (`realmName`); when the realm cannot be resolved the SPI logs a
warning and sends the event without it. The plain secret header is still sent, so an
older consumer keeps working; the Nefarious ircd (fork branch `fix/webhook-transport`)
requires the signature, refuses a timestamp outside its window, a played-back copy of an
accepted event and another realm's events, and answers this SPI's own re-signed retries
of an accepted event with 200 without acting twice. Deploy this SPI before that ircd (or
run the ircd with `Webhook { legacysecret = yes; }` for the window). JUnit: `mvn test`
(`WebhookSignatureTest`, a fixed vector and a wrong-secret vector).

## x3 PR 1: `fix/ac-account-change` → evilnet/x3 master (2 commits off 5d7fadb)

**OPENED 2026-09-24: https://github.com/evilnet/x3/pull/62** (from MrLenin:fix/ac-account-change, 5742fc8 + 5ee1a88, against master 5d7fadb). Prod ordering: it lands with or before the ircd chain.

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

## x3 PR 2: `feature/keycloak-identity` → evilnet/x3 master (5 commits off 5d7fadb) — REWORKED 2026-09-24

Replaces the held `feature/keycloak-id-binding` (which needed step 4's LOCAL machinery).
Stands alone on master; not stacked on #62 (`fix/ac-account-change`), which only makes the
AC path carry the id to it. Bed: `bed-x3-identity` = master + #62 + this. Worktree
`scratchpad/x3-identity`. Commits: `14931a0` timestamp check as before a52968b, `b156d6f`
kc_id field + saxdb, `7ac40e9` ACCOUNTINFO line, `03ade7f` REBIND, `bedb654` bind + reset
+ remembered previous id. **Opening it is the user's call.** Deploy order on prod: the
nefarious change below first or together (with it, SASL logins carry no timestamp, so the
restored check never sees a directory date).

**Title:** nickserv: identity by Keycloak id; the timestamp check as it was before the directory reconciliation

**Body:**

Two things about how X3 decides that an announced account is the handle it knows.

The timestamp check goes back to what it was before a52968b. That commit turned it into
a reconciliation against the directory: when the wire agreed with LDAP it overwrote X3's
own registration date, when LDAP could not be read it adopted any plausible wire value,
and it refused only in between. In the one case the check exists for -- a directory entry
destroyed and recreated underneath X3 -- it adopted the new timestamp and bound anyway,
and it destroyed the registration date of every account whose directory entry had ever
been recreated. Legacy servers still authenticate through X3, which stamps them with its
own date, so the check stays: a wire timestamp that differs from X3's date refuses the
bind, the date is never rewritten, no directory lookup is in the path. The ircd side
(nefarious) stops stamping Keycloak's creation time on SASL logins, so on that path the
wire carries no timestamp and X3 checks only what it stamped itself.

The Keycloak user id is the identity behind a name. The ircd announces it with the account
(`AC R|M <account> <ts> <id>`, burst `+r account:ts:id`; 22 unpadded base64url characters
of the UUID):

- `handle_info.kc_id`, saxdb `kc_id`. A handle with none adopts the announced id once the
  login goes through (after the timestamp and suspension checks; also for a handle the LDAP
  autocreate made on that login). No id on the wire leaves the handle alone.
- A different id under a bound name is a recreated Keycloak account, and the handle starts
  over: the modules' unregister hooks run (channel access, memos, ...), the registered
  nicks and everything on the record go, the directory is left alone (the entry belongs to
  the new user), a fresh handle of the same name is created with X3's own date and bound to
  the new id, the users logged in to the old handle are carried over without being
  re-stamped, and opers are told. Nobody is disconnected, in or out of a burst.
- The reset remembers the id it replaced (saxdb `kc_id_prev`). Sessions from before the
  recreate keep announcing the old id -- a burst replays them with it, a bouncer alias
  attach copies it, the ircd's login cache answers with it for a few minutes -- and such an
  announcement is bound to the fresh record instead of taken for yet another recreate.
  Nobody can newly obtain the old id.
- `REBIND <*account> <keycloak-uuid|*>` (oper level 800, through `get_victim_oper`'s
  outranking; deliberately not an OSET option) sets the stored id by hand or clears it so
  the next login adopts one; it forgets the remembered id. ACCOUNTINFO shows both to opers.

**Operator note:** a service that already has saved command bindings does not pick up a
module's new commands on restart; bind the new one once:
`/msg O3 BIND AuthServ REBIND *nickserv.rebind`.

Tested on the Afternet testnet (Vitest): a recreated user is let in, bound to the new id,
with its channel access gone and X3's fresh date; an older session rides along; a login the
ircd answers from its cache with the old id binds without another reset; the same in a
burst across a hop and a relink; REBIND; ACCOUNTINFO; an AuthServ-made stamp replayed after
saxdb was changed is refused and the date is never rewritten; a SASL login carries no
timestamp and binds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## nefarious: `fix/no-ircd-account-timestamp` (f607b31 off 028de05) — direct push, no PR (2026-09-24)

One hunk in `sasl_auth.c`: a SASL login stamps `acc_create = 0` instead of Keycloak's
creation time (the id keeps its own field; the burst emits `account:0:id`). ircv3/fork-only
→ direct push to both fork branches on both remotes, one command per branch, when the user
says push:

```
git -C nefarious push origin fix/no-ircd-account-timestamp:ircv3.2-hardening
git -C nefarious push origin fix/no-ircd-account-timestamp:ircv3.2-upgrade
git -C nefarious push upstream fix/no-ircd-account-timestamp:ircv3.2-hardening
git -C nefarious push upstream fix/no-ircd-account-timestamp:ircv3.2-upgrade
```
(`ircv3.2-upgrade` may need the branch merged rather than fast-forwarded; check first.)

## nefarious: `fix/pm-conversation-nick` (e1554fc + 1a0f3a4 off 028de05) — direct push, no PR (2026-09-24)

`ircd/replay.c`, `ircd_relay.c`, `m_chathistory.c`: a PM conversation is named after the nick it
was held with (newest row they sent, else the nick the caller addressed) while that nick is still
theirs; every PM row now stores both parties' session ids (server-internal tags, stripped on
playback), and only the SAME SESSION under its current nick may stand in for a stored nick — never
a same-account connection outside it; TARGETS reads the rows first. Prod symptom
(2026-09-24): a conversation held with `Rubin` listed as `Rub[1]n`, his same-account alt on a
legacy server. Test: `tests/src/ircv3/chathistory-targets-account-alt.test.ts` (red on the old
bed, green after). chathistory/fork-only → direct push to both fork branches on both remotes
when the user says push:

```
git -C nefarious push origin fix/pm-conversation-nick:ircv3.2-hardening
git -C nefarious push origin fix/pm-conversation-nick:ircv3.2-upgrade
git -C nefarious push upstream fix/pm-conversation-nick:ircv3.2-hardening
git -C nefarious push upstream fix/pm-conversation-nick:ircv3.2-upgrade
```
(also `fix/oauthbearer-introspection` 829a587+56ac1c4, same shape; `fix/no-ircd-account-timestamp`
08ce54b above; the three are independent of each other and of the merge order.)
