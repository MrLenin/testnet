# Deferred items register

One line per item that a plan, a review or an audit set aside on purpose. Each names where
the full text lives and what closes it. Add to this file whenever something is deferred;
strike a line (do not delete it) when the item ships, with the commit. Started 2026-09-23.

Legend: **owner** = the plan or pass expected to close it. Prod has no legacy (non-fork) peers; the only ones are on the test bed (user, 2026-09-23), so "legacy hop" rows are bed-only concerns. "5c" = account-timestamp step 5c
(`account-timestamp-authority-2026-09.md`). "plan 3" = webhook audit plan 3 (P0-3/P0-4).

## From the webhook audit (`keycloak-webhook-audit-2026-09.md`), not yet planned

| Item | Source | Owner |
|---|---|---|
| ~~Webhook transport: the `Webhook {}` config's vhost/path/limits are discarded by `sasl_webhook_init`; listener binds 0.0.0.0; plaintext HTTP; static secret header; no body signature, timestamp or nonce (a replayed `USER/DELETE` is now a live deauth primitive); no realm check~~ closed by plan 3 (nefarious `fix/webhook-transport` cde1b99..2e921c6, SPI `feature/signed-events` ad0a2dd): the block is threaded in full, HMAC signature + 300 s window + replay ring + realm check. TLS on the listener stays open (row below) | P0-3 | ~~plan 3~~ |
| ~~No operator-visible surface: `STATS` entry for the libkc transport and business counters; loud notice on secret rejection~~ closed by plan 3: `STATS webhook`, `SNO_UNAUTH` notice once per cause per minute | P0-4 | ~~plan 3~~ |
| ~~The secret is still named `x3-webhook-secret` in all seven ircd confs and `data/x3.conf`; the dead `keycloak_webhook_*` block in `data/x3.conf`~~ closed f226c497 (bed) | P0-3, cutover 6 | ~~plan 3~~ |
| SPI ships SCRAM verifier material in every credential event; the ircd parses `event.scram` and never reads it: drop it or consume it deliberately under TLS | P1-3 | decision, then plan |
| SPI resource model: `HttpClient` per provider instance, delivery on the ForkJoinPool common pool with blocking sleeps, no cap on in-flight deliveries, no reconciliation after four failed attempts (a missed delete is permanent divergence) | P1-4 | SPI plan |
| **Direction (user, 2026-09-24): every ircd should receive every event directly from the SPI; the network fan-out (`CI`, `AC U`) then only covers misses, and a server that is split but not down still gets its own delivery.** Needs: the SPI URL list naming every server; a network-wide dedupe key (the Keycloak event id) on the relayed messages so N direct receivers do not multiply the broadcasts; a decision on local-only action per receiver versus today's network-wide walk. Planned: `2026-09-24-webhook-every-server.md` (executing 2026-09-24) | direction | plan 4 |
| The applied-events log of plan 4 is a first version (user, 2026-09-24: "will probably need some more work later, but it's a fair start"): an in-memory ring of 1024 entries with a 24 h window, no persistence across restarts (a restarted server relies on the catch-up from its peers), no per-kind retention, linear scans | plan 4 | later |
| SCRAM attribute lifecycle: attributes written from a password-policy `validate()` side effect; policy-bypassing password changes leave them stale; keep `SCRAM-SHA-256` out of prod's `SASL_LOCAL_MECHANISMS` until owned | P1-5 | decision |
| SPI's only test is plan 3's signing vector (`WebhookSignatureTest`); the event formatters are untested and CMocka still mirrors `dispatch_event`'s field mapping instead of driving it | P1-2 | SPI plan / later |
| ~~Untrusted `event->username` goes onto the P10 wire and into the cache lookups unvalidated (length, charset)~~ closed by plan 3 0ada9cd (`username_usable`: at most 32 bytes, no space, colon, control or DEL; a bad name is dropped, the id still resolves) | P2 | ~~plan 3~~ |
| `CI` cannot cross a legacy hop (`sendcmdto_serv_butone_v3` on emit and relay). Bed-only: prod has no legacy peers (user, 2026-09-23) | P2 | none unless prod gains a legacy peer |
| Dead branches: credential-event `DELETE` arm needs a representation Keycloak never sends; `handle_session_event` wants `DELETE` while the SPI maps `LOGOUT` to `ACTION`; `WATCHED_RESOURCE_TYPES` omits `CREDENTIAL` and watches `REALM_ROLE_MAPPING` undocumented (plan 3 did not touch them) | P2 | later (hygiene) |
| `kc_webhook.c` HTTP edge cases: a read that exactly fills the buffer is a 400; `Content-Length` via `atoi` accepts negatives (~~`events_received` counted before authentication~~ fixed by plan 3: counted after the signature and realm checks) | P2 | later |
| `ScramCredentialProvider.java` is dead but named as the lockstep counterpart in `kc_cred_derive.c/.h`; `pom.xml` targets 26.0.0 while the bed runs 26.4.7 | P2 | SPI plan |
| ~~`scripts/setup-keycloak.sh` short-circuits on "webhook-events already enabled" and skips the admin-events writes~~ closed 420cc1ee | P2 | ~~plan 3~~ |
| ~~Rehash churn: any `wh_changed()` field rebinds the listener and resets the stats; `kc_webhook_set_secret()` is never called~~ closed by plan 3 82378b3: a secret-only change goes through `kc_webhook_set_secret` and keeps the listener and every counter; a change to any other item re-inits, which keeps the handler's counters and zeroes libkc's listener counters | P2 | ~~plan 3~~ |
| Prod cutover 7-9: keep SCRAM off; keep `send-all-events=false` on any realm whose URL list includes an ircd; verify the realm's listener and admin-event settings | cutover | prod cutover |
| Plan 3 rollout on prod: the signing SPI goes in before the ircd (or `Webhook { legacysecret = yes; }` covers the window, then comes out); the Keycloak block's `realm` and the SPI's realm name must agree | plan 3 decision 2 | prod cutover |
| TLS on the webhook listener: not built (plan 3 decision 3); the posture is a private `vhost` plus the signature. Requirement if the link is ever shared: TLS in libkc's listener or an authenticated tunnel in front of it | plan 3 decision 3 | decision, then plan |
| A payload without `realmName` (a pre-signing SPI) is accepted and counted (plan 3 decision 4); refusing it too is the alternative once the signing SPI is deployed everywhere | plan 3 decision 4 | later, after the SPI ships |
| The bed's seven ircd confs still set `WEBHOOK_PORT`/`WEBHOOK_SECRET` as features (a CONFIG warning on every rehash says migrate to a `Webhook {}` block); the new items ride on defaults there | plan 3 | bed chore |
| The nefarious tree's `.claude/skills` mirrors (sasl-keycloak, bouncer-architecture, nefarious-codebase) have drifted from the testnet copies (last synced at 7bc4751; 38/32/68 lines differ on 2026-09-23); CLAUDE.md says to mirror every edit. Sync them in a chore commit, not inside a feature branch | found during plan 3 | hygiene |

## From the webhook plan 3 review (2026-09-23; fix pass closed findings 1-6, these remain)

| Item | Owner |
|---|---|
| ~~**Decision:** `SNO_UNAUTH` (32) is not in `SNO_OPERDEFAULT`, so a default oper hears no refusal notice until the mask is set; add it to the default mask, or leave it opt-in? (review finding 7)~~ DECIDED 2026-09-24: no, the notices stay opt-in; the doc says how to enable the mask | ~~user decision~~ closed |
| ~~**Decision:** an SPI retry of an event the ircd applied but whose 200 was lost is refused "replay" three times with `SNO_UNAUTH` notices; the reviewer's refinement: same id + newer `t` + valid signature = 200 "duplicate" (counted, not acted), byte-identical = 401 replay (finding 8)~~ DECIDED 2026-09-24: yes; shipped as nefarious 32e3664 (`kc_replay_ring_check` verdicts, `Duplicates` under STATS, transport case) | ~~user decision~~ closed |
| ~~**Decision:** the SPI branch `feature/signed-events` carries two subjects; split into two PRs per the one-subject rule, or ship as one? (finding 20)~~ DECIDED 2026-09-24: split; `docs/ircd-contract` (f8a6e1c) and `feature/signed-events` (rebased onto main: 47963e0, 86213bc) are independent PRs; the second to merge needs a rebase (README and the Java file overlap) | ~~user decision~~ closed |
| The replay ring is reset on every listener re-init (a captured request becomes replayable after a port/vhost/limit rehash); drop the reset from init, reset in shutdown (9) | later |
| ~~Foreign-realm events occupy ring slots before the realm check, so a second foreign delivery reads "replay" not "realm"; check the realm first~~ closed by 32e3664 (realm before the ring). Still open: document that `webhook-events` belongs on the ircd's realm only (each foreign event costs the SPI four attempts) (10) | docs |
| A fixed 256-slot ring cycles under bulk admin operations (a few hundred users in five minutes evict every earlier id); expire by time or warn on evicting a young entry (11) | later |
| A signed payload without `id` is replay-exempt (`x3-account-change.test.ts` posts one); keying the ring on the `v1` digest removes the JSON dependency (12) | later |
| A rehash that changes only the Keycloak block's `realm` never reaches the listener: `wh_changed()` ignores the effective realm (13) | later |
| `sasl_conf_keycloak_realm()` has no callers (14); X3 attribution still in `kc_webhook.h:8-9` / `kc_webhook.c:5`; stale "KILL_ON_DELETE defaults on" comment in `x3-account-change.test.ts:18` | hygiene |
| In the deploy window a wrong plain secret without a signature is reported as "missing" (15) | later |
| `kc_log_warning` per refused request is unbounded; only the notice is rate-limited (an attacker on the link grows the log; memory `bed-disk-full`) (16) | later |
| Docs: no clock-sync note (skew beyond `signaturewindow` refuses everything as "stale"); `kc_webhook.h:122` still says "NULL = no auth"; `doc/example.conf` documents neither the Keycloak nor the Webhook block (pre-existing) (17) | docs |
| Untested: `legacysecret = yes`; the three grammar items (`signaturewindow`, `legacysecret`, `realm`) are parsed by no bed conf (the bed uses the feature form) (18) | tests |
| `scripts/setup-keycloak.sh` PUTs `eventsListeners`/`enabledEventTypes` wholesale on every run, clobbering hand additions; read-merge-write (19) | bed |
| Listener: GET/HEAD/wrong-path requests are answered 200 without authentication (a probe surface); IPv4-only listener and peer string (pre-existing, declined by the reviewer) | later |

## X3 side (account-timestamp steps 4 and 5)

| Item | Owner |
|---|---|
| **Held (user, 2026-09-24): the LOCAL break-glass flag (x3 step 4, `feature/local-handle-flag` 77bd045) is not sent upstream for now.** Rubin does not care about non-LDAP accounts (he did not say X3 ignores them), so it is a maintenance-appetite question, parked. x3 PR 2 (`feature/keycloak-id-binding`, six commits on 77bd045) waits with it or is reworked to stand alone; x3 PR 1 (`fix/ac-account-change`) is independent and ready | user |
| **Rubin (relayed by the user 2026-09-24) is in favour of culling saxdb accounts that are not in LDAP.** That is the upstream-endorsed shape of the fix for the name-reuse escalation (a Keycloak delete strands the X3 handle, a re-registration inherits its privileges) and it runs against the held LOCAL flag. Not planned; a design needs a report/dry-run mode, an x3.db backup before any deletion, exemptions (services' accounts, opers) and the user's sign-off on the criteria | user decision, then plan |
| x3 PR 1 must land on prod with or before the ircd chain: prod X3 (upstream master 5d7fadb) looks up a handle named "U" on `AC <user> U` and keeps the user bound after a webhook deauth | prod cutover |

## From webhook plan 4 (`2026-09-24-webhook-every-server.md`, executed 2026-09-24; residue and the review's minors)

| Item | Owner |
|---|---|
| Mixed rollout (decision 1, no switch): a held ghost on a pre-plan-4 server is stranded forever (its session destroyed by a new server's `AC U`, its hold timer gone, its `ms_cacheinval` never walks); a pre-plan-4 server in the middle of a chain forwards the two-parameter `CI` and strips the id and kind for everything behind it. Lockstep deploy avoids both | prod cutover |
| Whether an AuthServ (X3) login on the bed leaves the client without a Keycloak id is unverified (`CHECK` shows no id); the fan-out suite's name-only case is a regression guard either way, the name-list plumbing is cmocka-covered | bed |
| Under `WEBHOOK_KILL_ON_*`, a remote alias of a killed primary whose session record a sibling's `AC U` already destroyed is left to its home server (the fallback exits local aliases only); its home skips it in its own KILL pass because the account is already cleared, so it keeps an open socket with no account (pre-plan-4 residue, consistent network-wide) | later |
| The receiver applies a caught-up disable without checking its own log for a later enable of the subject: a split where the disable reached one side and the enable the other deauths the re-enabled user once at relink (review minor 5) | later |
| `names_add` truncates a name longer than `ACCOUNTLEN` (15) to a prefix that can be another account, and the relay and the log now carry it; `username_usable` admits 32 bytes (review minor 6; pre-existing) | later |
| The catch-up's line cap comes from `WEBHOOK_EVENTLOG_SIZE` rather than the ring's count, so lowering the feature at runtime would drop the newest entries; the log is sized at first use (review minor 7) | later |
| `relay_deauth` with no names logs nothing, unlike the direct path's operator cue (review minor 8) | later |
| Docs: a caught-up entry gets a fresh applied time here and lives another window in this server's catch-ups (harmless, dedupe); the name-only compaction caveat (a name-only disable and an id-carrying enable of the same user do not compact) is not in the feature doc (review minor 10) | docs |
| `relay_event`'s old-form fallback sends a comma-joined list as one name when the event id is junk; an old receiver purges the literal string (review minor 11) | later |
| The applied-events log is in memory only: a restarted server relies on its peers' catch-up; the SPI's retries remain the only cover for an event no server received (D7) | later / P1-4 |

## From webhook plan 2 (`2026-09-23-webhook-subject-by-id.md`, execution record)

| Item | Owner |
|---|---|
| Durable cover for id-less sessions: persist Keycloak id to account at every id-carrying login; store `kc_id` in the bounce-DB session record so restored ghosts carry it (today: X3-authenticated, relayed-without-id and restored sessions are reached only through a name; the log warns with the id. The legacy-hop case is bed-only: prod has no legacy peers) | 5c |
| A bare API re-enable (`{"enabled":true}`, no name) leaves a refused password in the negative cache for up to `SASL_NEGCACHE_TTL` (60 s); remembering the names resolved at DISABLE would let the bare ENABLE purge them | later |
| Under `WEBHOOK_KILL_ON_*` a name-only match can disconnect an id-less client of a reused name (rename + id-less login + the switch on); no feature documentation file carries the note | doc |
| The cross-server id purge (`CI * <id>`) has no bed observer; a pre-branch v3 peer relays `CI *` without the id (rollout window only; prod deploys the chain in lockstep). Plan 3 did not add the observer | later (tests) |
| The cmocka suite mirrors the parser's field mapping instead of driving `dispatch_event` (untouched by plan 3) | later |
| Bouncer observation, UNVERIFIED: a client revived from a held ghost still read `IsBouncerHold` two seconds later and a deauth exited it (memory `project_bouncer_revived_ghost_hold_flag.md`) | bouncer-analyst pass |

## From bouncer deauth plan 1 (`2026-09-22-bouncer-deauth-correctness.md`, execution record)

| Item | Owner |
|---|---|
| Legacy-accounts gate in `bounce_emit_alias_update` sits after the local alias apply (unreachable today) | later |
| `bounce_null_alias_primary_pointing_at` walks GlobalClientList three times per exit, remote exits included (O(n^2) on a netsplit) | later |
| The LIVE-DEAUTHED discriminator also matches a recycled slot holding a fresh unauthenticated user; `cli_session_id` vs `hs_sessid` would discriminate | later |
| `wh_stats.sessions_killed` counts deauths and ghost destroys alike; plan 3's `STATS webhook` prints it as one "deauths or kills" figure | later |
| The deauth bed tests sleep a fixed time then CHECK once; bounded polling would be flake-proof | later |
| The multi-session emit loop in `bounce_account_deauth_apply` has no bed test (one session per account in the profile model); sibling held ghosts are not exited inside the body (each gets its own walk entry or AC U) | bouncer-analyst pass |
| Network-wide forced disconnect for remote primaries (kill = deauth everywhere + local sockets + the killed primary's aliases everywhere); B-8 duplicate `AC U` wallops | design decision |

## From step 5 (`plan-step5-wire-keycloak-id-2026-09-22.md`, execution record) and its review

| Item | Owner |
|---|---|
| Restored bouncer ghosts never regain a Keycloak id; the BX U "account" receiver keeps the previous account's id/ts on aliases (a later promotion + relink bursts `newname:oldts:oldid`); same-name re-auth leaves the stored id stale and sends no `AC` | 5c |
| ACCOUNTINFO shows the id to the account's own owner too (plan said opers) | X3, later |
| X3 checks the third field's (id) length only, not its alphabet | X3, later |
| `isalnum` in `account_id.c` is locale-dependent | later |
| `sasl_id_for` sits outside the `USE_LIBKC` block (unused-function warning in a `--disable-keycloak` build) | later |
| X3 Part A's legacy fall-through still binds unknown single-letter subcommands | X3, later |
| LOC reply `A` keeps a stale `acc_create` when `parc <= 4` | later |
| `keycloak-id-binding.test.ts` asserts only "disconnected", not the kill reason; REBIND must be BOUND on existing deployments (`/msg O3 BIND AuthServ REBIND *nickserv.rebind`) | tests / operator note |
| The fail-open when the grant reply lacks `id_token` logs at DEBUG only (plan 3's notice covers webhook refusals only) | later |
| D3 needs a trusted-authzid bed config; the OAUTHBEARER test helper's error-challenge branch is unreachable | tests |
| Positive cache carried identity for `SASL_POSCACHE_TTL` after a delete | ~~closed by plan 2 (purge by id)~~ |

## Elsewhere (tracked in memory `MEMORY.md`, not repeated here)

Credential scoping and the SPI certfp grant (`keycloak-certfp-grant-and-credential-scoping-2026-09.md`), the `/REGISTER` decision, the event-core master PR, the logger over-read (`project_log_vwrite_overread.md`), the crdt-mesh catch-up, `project_bouncer_orphan_reap_characterization.md`.
