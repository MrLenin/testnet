# Deferred items register

One line per item that a plan, a review or an audit set aside on purpose. Each names where
the full text lives and what closes it. Add to this file whenever something is deferred;
strike a line (do not delete it) when the item ships, with the commit. Started 2026-09-23.

Legend: **owner** = the plan or pass expected to close it. "5c" = account-timestamp step 5c
(`account-timestamp-authority-2026-09.md`). "plan 3" = webhook audit plan 3 (P0-3/P0-4).

## From the webhook audit (`keycloak-webhook-audit-2026-09.md`), not yet planned

| Item | Source | Owner |
|---|---|---|
| Webhook transport: the `Webhook {}` config's vhost/path/limits are discarded by `sasl_webhook_init`; listener binds 0.0.0.0; plaintext HTTP; static secret header; no body signature, timestamp or nonce (a replayed `USER/DELETE` is now a live deauth primitive); no realm check | P0-3 | plan 3 |
| No operator-visible surface: `STATS` entry for the libkc transport and business counters; loud notice on secret rejection | P0-4 | plan 3 |
| The secret is still named `x3-webhook-secret` in all seven ircd confs and `data/x3.conf`; the dead `keycloak_webhook_*` block in `data/x3.conf` | P0-3, cutover 6 | plan 3 |
| SPI ships SCRAM verifier material in every credential event; the ircd parses `event.scram` and never reads it: drop it or consume it deliberately under TLS | P1-3 | decision, then plan |
| SPI resource model: `HttpClient` per provider instance, delivery on the ForkJoinPool common pool with blocking sleeps, no cap on in-flight deliveries, no reconciliation after four failed attempts (a missed delete is permanent divergence) | P1-4 | SPI plan |
| SCRAM attribute lifecycle: attributes written from a password-policy `validate()` side effect; policy-bypassing password changes leave them stale; keep `SCRAM-SHA-256` out of prod's `SASL_LOCAL_MECHANISMS` until owned | P1-5 | decision |
| SPI has no `src/test`; CMocka does not drive `dispatch_event` (plan 2 mirrors its field mapping) | P1-2 | plan 3 or SPI plan |
| Untrusted `event->username` goes onto the P10 wire and into the cache lookups unvalidated (length, charset) | P2 | plan 3 |
| `CI` cannot cross a legacy hop (`sendcmdto_serv_butone_v3` on emit and relay) | P2 | with the next legacy-hop pass |
| Dead branches: credential-event `DELETE` arm needs a representation Keycloak never sends; `handle_session_event` wants `DELETE` while the SPI maps `LOGOUT` to `ACTION`; `WATCHED_RESOURCE_TYPES` omits `CREDENTIAL` and watches `REALM_ROLE_MAPPING` undocumented | P2 | plan 3 hygiene |
| `kc_webhook.c` HTTP edge cases: a read that exactly fills the buffer is a 400; `Content-Length` via `atoi` accepts negatives; `events_received` counted before authentication | P2 | plan 3 |
| `ScramCredentialProvider.java` is dead but named as the lockstep counterpart in `kc_cred_derive.c/.h`; `pom.xml` targets 26.0.0 while the bed runs 26.4.7 | P2 | SPI plan |
| `scripts/setup-keycloak.sh` short-circuits on "webhook-events already enabled" and skips the admin-events writes | P2 | plan 3 |
| Rehash churn: any `wh_changed()` field rebinds the listener and resets the stats; `kc_webhook_set_secret()` is never called | P2 | plan 3 |
| Prod cutover 7-9: keep SCRAM off; keep `send-all-events=false` on any realm whose URL list includes an ircd; verify the realm's listener and admin-event settings | cutover | prod cutover |

## From webhook plan 2 (`2026-09-23-webhook-subject-by-id.md`, execution record)

| Item | Owner |
|---|---|
| Durable cover for id-less sessions: persist Keycloak id to account at every id-carrying login; store `kc_id` in the bounce-DB session record so restored ghosts carry it (today: X3-authenticated, relayed-without-id, legacy-hop and restored sessions are reached only through a name; the log warns with the id) | 5c |
| A bare API re-enable (`{"enabled":true}`, no name) leaves a refused password in the negative cache for up to `SASL_NEGCACHE_TTL` (60 s); remembering the names resolved at DISABLE would let the bare ENABLE purge them | later |
| Under `WEBHOOK_KILL_ON_*` a name-only match can disconnect an id-less client of a reused name (rename + id-less login + the switch on); no feature documentation file carries the note | doc |
| The cross-server id purge (`CI * <id>`) has no bed observer; a pre-branch v3 peer relays `CI *` without the id (rollout window) | plan 3 tests |
| The cmocka suite mirrors the parser's field mapping instead of driving `dispatch_event` | plan 3 |
| Bouncer observation, UNVERIFIED: a client revived from a held ghost still read `IsBouncerHold` two seconds later and a deauth exited it (memory `project_bouncer_revived_ghost_hold_flag.md`) | bouncer-analyst pass |

## From bouncer deauth plan 1 (`2026-09-22-bouncer-deauth-correctness.md`, execution record)

| Item | Owner |
|---|---|
| Legacy-accounts gate in `bounce_emit_alias_update` sits after the local alias apply (unreachable today) | later |
| `bounce_null_alias_primary_pointing_at` walks GlobalClientList three times per exit, remote exits included (O(n^2) on a netsplit) | later |
| The LIVE-DEAUTHED discriminator also matches a recycled slot holding a fresh unauthenticated user; `cli_session_id` vs `hs_sessid` would discriminate | later |
| `wh_stats.sessions_killed` counts deauths and ghost destroys alike | plan 3 (STATS) |
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
| The fail-open when the grant reply lacks `id_token` logs at DEBUG only | plan 3 (STATS/notice) |
| D3 needs a trusted-authzid bed config; the OAUTHBEARER test helper's error-challenge branch is unreachable | tests |
| Positive cache carried identity for `SASL_POSCACHE_TTL` after a delete | ~~closed by plan 2 (purge by id)~~ |

## Elsewhere (tracked in memory `MEMORY.md`, not repeated here)

Credential scoping and the SPI certfp grant (`keycloak-certfp-grant-and-credential-scoping-2026-09.md`), the `/REGISTER` decision, the event-core master PR, the logger over-read (`project_log_vwrite_overread.md`), the crdt-mesh catch-up, `project_bouncer_orphan_reap_characterization.md`.
