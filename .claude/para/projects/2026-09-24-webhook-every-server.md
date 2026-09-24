# Webhook plan 4: every server receives, one deduped relay per event, catch-up on link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every ircd receives every Keycloak event directly from the SPI and applies it to the clients and caches it owns; a server the SPI could not reach, or that was split, learns the event from any peer through one id-keyed relay and a catch-up on link; no server applies an event twice.

**Architecture:** The SPI already posts to every URL in its list, so delivery becomes "list every ircd" (config). Each receiver acts locally: it purges its own caches and deauths only the clients it owns (the `AC U` each local deauth broadcasts still clears replicas everywhere, unchanged). Instead of walking remote clients, the receiver sends one relay per event, the existing `CI` token extended with the Keycloak event id and a kind letter. Every server keeps a bounded log of applied event ids: a direct delivery or a relay whose id is in the log is "already applied" (answered, counted, not relayed again), so N direct receivers do not multiply the broadcasts and relays cannot loop. At the end of a peer's burst a server sends that peer the log entries of the last window as relay lines (the same shape as the strict-presence sync), so a rejoining half converges; the peer drops what it has and relays what it lacks onward.

**Tech Stack:** C (nefarious fork: `ircd/sasl_webhook.c`, `ircd/bouncer_deauth.c`, `ircd/m_endburst.c`, a new pure module), CMocka, Vitest on the linked bed (primary + leaf), the Keycloak webhook SPI (config only).

**Spec:** the user's direction of 2026-09-24 (register row "Direction (user, 2026-09-24)" in `.claude/para/areas/deferred-items.md`; memory `project_keycloak_webhook_audit.md`): "ideally it should hit all servers, the fan-out just covers misses at best; that way even a split-but-not-down server gets an opportunity", the agreed recommendation "local action plus one id-keyed relay per event", and "the re-link catch-up seems important as well". The audit's P1-4 row (no redundancy) is the finding this plan answers.

## Design (what the direction implies)

- **D1 Delivery.** The SPI's URL list names every ircd. Bed: `http://nefarious:9090/keycloak-webhook,http://nefarious2:9091/keycloak-webhook` (the leaf's listener is on 9091 in `data/ircd2.conf`). No SPI code changes: it already posts to each URL with its own retries, and each ircd verifies the signature and its own replay ring as today.
- **D2 Local action.** A receiver purges its own caches and deauths (or kills, under the existing switches) only clients it owns (`MyConnect`), including its local aliases and held ghosts. Remote replicas are left to their home server, which gets the same event directly or through the relay. Today's classifier returns "clear the account" for a remote client; that becomes SKIP unless a rollout switch says otherwise (decision 1).
- **D3 One relay per event.** `CI <username|*> <kc_id|*> <event_id> <kind>` to every IRCv3-aware server (`sendcmdto_serv_butone_v3`; legacy peers and X3 never see `CI`). Kinds: `D` delete, `X` disable, `R` admin password reset, `C` credential removed, `E` enable, `P` purge only (credential-change user events). A receiver of the five-parameter form dedupes by the event id, purges by name and id, runs the local deauth walk for `D` and `X`, and forwards the line unchanged if the id was new. The one- and two-parameter forms keep today's meaning (purge, forward, no dedupe), so a pre-plan-4 fork server in a mixed network still purges.
- **D4 Applied-events log.** A pure ring in the ircd (`ircd/webhook_eventlog.c`): entries of `{event id, kind, kc_id, username, applied at}`, capacity `WEBHOOK_EVENTLOG_SIZE` (default 1024), replay window `WEBHOOK_EVENTLOG_WINDOW` (default 86400 s). Both a direct delivery (at dispatch, after the subject resolves) and a relay go through it. This is distinct from libkc's HTTP replay ring, which stays as the transport guard: the HTTP ring never sees relays, the log sees both paths.
- **D5 Catch-up on link.** In `ms_end_of_burst`, where `presence_burst_sync(sptr)` already runs for a directly connected IRCv3-aware peer, the server sends that peer its log entries of the last window, oldest first, as five-parameter `CI` lines addressed to that peer only (`sendcmdto_one`), bounded by the log size. The peer applies what it lacks and forwards it (so a whole rejoining half converges) and drops what it has. Both sides of a relink do this, so events applied on either side of a split converge.
- **D6 Observability.** `STATS webhook` gains: events applied here from a direct delivery, from a relay, from a catch-up; deliveries and relays already applied (dropped); catch-up lines sent and received; log occupancy and oldest entry age.
- **D7 What stays uncovered.** An event no server received within the SPI's retries is lost (P1-4's redelivery from Keycloak's own event store stays in the register). A server that relinks after a split longer than the window gets no catch-up for the older events; the positive cache's TTL bounds the password exposure, a live session of a deleted account on that server is the residue (documented).

## Open decisions (mine to propose, the user's to make)

1. **Remote deauth during a mixed rollout.** With D2, a pre-plan-4 fork server's clients are deauthed by nobody until it upgrades (it ignores the kind and does not walk). Recommendation: no switch; prod deploys the chain in lockstep, the window is minutes, and the old server's clients are cleared by the `AC U` its neighbours broadcast only if those neighbours still walk remote clients. Alternative: a feature `WEBHOOK_DEAUTH_REMOTE` (default no) that restores today's network-wide walk for a slow rollout, then goes off.
2. **Log bounds.** 1024 entries, 24 h window. Alternative: size by time only.
3. **Catch-up direction.** Symmetric (each side sends its window to the other at end of burst; the dedupe makes the overlap free). Alternative: hub-only.
4. **Wire form.** Extend `CI` (already fork-only, already relayed, already skipped by legacy peers and X3). Alternative: a new token, which needs the message table, the P10 reference and the skills touched for the same bytes.
5. **SPI-side redelivery.** Deferred: it needs per-endpoint persistent delivery state inside Keycloak (P1-4). Alternative: in this plan.

## Global Constraints

- `ircd/kc/*` untouched by this plan (the HTTP ring stays as is); the new module lives in `ircd/` and includes ircd headers freely.
- The bouncer invariants (`bouncer-architecture` skill, invariant 12) govern the walk change: Task 1's analysis runs before Task 3's code.
- One vitest process at a time from `tests/`, `IRC_HOST=localhost`; `x3-account-change` needs `X3_AC_CHANGE=1`; never the whole suite.
- Edit `data/ircd*.conf` in place (per-file bind mounts), never `sed -i`.
- Deploy: SPI env change through `scripts/dc.sh up -d --force-recreate --no-deps keycloak`; ircds by merging into `bed-deploy`, building BOTH images, recreating both, waiting for X3 and the leaf (120 s after the link before cross-server suites).
- Commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; nothing is pushed by the executor; the SPI needs no commit (config only, plus one README line).
- Plain, defensive language.

## Review Focus

1. A five-parameter `CI` with an unknown kind letter or a malformed event id (too long, non-printable) must purge only, forward nothing it cannot validate, and never crash; Task 4 cmocka `test_relay_parse_rejects_junk`, bed case "a junk relay is purge-only".
2. A catch-up must not deauth a user who re-registered under the same name after the event: the walk matches by Keycloak id when both sides carry one, and a re-created user has a new id; a name-only log entry (synthetic events) still matches by name, which the doc states; Task 5 bed case "catch-up does not touch a re-created account".
3. The log must evict the oldest entry at capacity and never grow; Task 2 cmocka `test_log_evicts_oldest_at_capacity`.
4. The same event arriving on two servers at once must not loop: each server relays its first sighting once and drops the other's copy without forwarding; Task 4 bed case "delivered to both servers: applied once per server, relays do not loop" (STATS: one direct, one already-applied on each, no growth afterwards).
5. A relink after a split longer than the window gets no catch-up for the older events; Task 5 cmocka `test_since_stops_at_window` and a doc sentence.

## File structure

- Create `include/webhook_eventlog.h`, `ircd/webhook_eventlog.c` — the applied-events log and the kind letters; pure (no sockets, no globals beyond its own ring).
- Create `ircd/test/webhook_eventlog_cmocka.c`.
- Modify `include/bouncer_deauth.h`, `ircd/bouncer_deauth.c`, `ircd/test/bouncer_deauth_cmocka.c` — `remote_ok` on the subject; SKIP for a remote client unless set.
- Modify `ircd/sasl_webhook.c` — dedupe at dispatch, local walk, `relay_event`, the five-parameter `ms_cacheinval`, `sasl_webhook_link_catchup`, STATS lines; `include/sasl_webhook.h` — the catch-up prototype and stats fields.
- Modify `ircd/m_endburst.c` — the catch-up call beside `presence_burst_sync`.
- Modify `ircd/ircd_features.c`, `include/ircd_features.h` — `WEBHOOK_EVENTLOG_SIZE`, `WEBHOOK_EVENTLOG_WINDOW` (and `WEBHOOK_DEAUTH_REMOTE` if decision 1 says so).
- Modify `ircd/Makefile.in` / `configure.in` — the new source and cmocka program (IRCD_SRC, not KC_SRC).
- Modify `tests/src/services/keycloak-webhook-transport.test.ts` or create `tests/src/services/keycloak-webhook-fanout.test.ts`; modify `tests/src/services/keycloak-webhook-e2e.test.ts` (the leaf receives real events too).
- Modify `.env`, `.env.local` (the URL list), `FEATURE_FLAGS_CONFIG.md`, `P10_PROTOCOL_REFERENCE.md`, the `p10-protocol`, `sasl-keycloak`, `service-debugging`, `test-writing` skills; the SPI README (one line: list every ircd).

---

### Task 1: The bouncer-analyst pass on a local-only deauth walk

**Files:** none changed; report saved as `.claude/para/projects/2026-09-24-webhook-every-server-bouncer-pass.md`.

**Interfaces:** Produces the rulings Task 3 and Task 4 apply: whether a local-only walk keeps invariant 12 (account-level deauth reaches every session and alias), what a local primary's `bounce_account_deauth_apply` still emits to remote aliases (BX U) and whether that is enough for a remote alias whose home server has not yet applied the event, what happens to a held ghost on a remote server when only its home server acts, and whether two servers acting on the same account within the same second race on the session record.

- [ ] **Step 1:** Dispatch the `bouncer-analyst` agent with: the D2 text above, `ircd/sasl_webhook.c` (`deauth_client`, `deauth_action_for`, `handle_sessions_for_account`, `deauth_subject`), `ircd/bouncer_deauth.c` (`bounce_deauth_classify`), `bounce_account_deauth_apply` in `ircd/bouncer_session.c`, and invariant 12 of the `bouncer-architecture` skill. Ask for: hazards, the classifier rule for a remote client, and whether anything beyond SKIP-remote is needed.
- [ ] **Step 2:** Save the report; record each of its rulings in the ledger as `Task 1: Ruling: ...`. A hazard that needs code goes into Task 3's steps before Task 3 starts.

Expected: a report with no blocking hazard, or a concrete addition to Task 3.

---

### Task 2: The applied-events log, pure

**Files:** create `include/webhook_eventlog.h`, `ircd/webhook_eventlog.c`, `ircd/test/webhook_eventlog_cmocka.c`; modify `ircd/Makefile.in` (`IRCD_SRC`), `ircd/test/Makefile.in` (program), `configure.in` if the test list lives there.

**Interfaces:** Produces

```c
#define WH_EVENT_ID_LEN 40                 /* Keycloak ids are 36-char uuids */
#define WH_EVENTLOG_DEFAULT_SIZE 1024
#define WH_EVENTLOG_DEFAULT_WINDOW 86400

enum WebhookRelayKind {                    /* the wire letter */
  WH_RELAY_PURGE = 'P', WH_RELAY_DELETE = 'D', WH_RELAY_DISABLE = 'X',
  WH_RELAY_RESET = 'R', WH_RELAY_CREDENTIAL = 'C', WH_RELAY_ENABLE = 'E'
};

struct WebhookEventLogEntry {
  char   id[WH_EVENT_ID_LEN];
  char   kind;
  char   kc_id[ACCOUNT_ID_LEN + 1];        /* "" when unknown */
  char   username[ACCOUNTLEN + 1];         /* "" when unknown */
  time_t applied;
};

void   webhook_eventlog_init(unsigned int capacity);      /* frees and re-sizes; keeps nothing */
int    webhook_eventlog_valid_id(const char *id);         /* 1..39 chars of [A-Za-z0-9._:-] */
int    webhook_eventlog_valid_kind(char kind);
/* 0 = recorded now; 1 = already there (nothing changed). NULL/empty id: 0, not recorded. */
int    webhook_eventlog_record(const char *id, char kind, const char *kc_id,
                               const char *username, time_t now);
int    webhook_eventlog_seen(const char *id);
/* Entries applied at or after `oldest`, oldest first, at most `max`; returns the count emitted. */
unsigned int webhook_eventlog_since(time_t oldest,
                                    void (*emit)(const struct WebhookEventLogEntry *, void *),
                                    void *data, unsigned int max);
unsigned int webhook_eventlog_count(void);
time_t webhook_eventlog_oldest(void);                     /* 0 when empty */
char   webhook_relay_kind_for(enum WebhookSubjectKind k); /* 0 = not relayed (NONE, LOGOUT) */
enum WebhookSubjectKind webhook_subject_kind_for_relay(char kind);  /* NONE for junk */
```

- [ ] **Step 1: Write the failing tests** in `ircd/test/webhook_eventlog_cmocka.c`: `test_record_then_seen` (record → seen 1, record again → 1, other id → 0, NULL/empty → 0 and not stored), `test_log_evicts_oldest_at_capacity` (init 4, record five, the first is gone, the last four seen), `test_since_orders_oldest_first_and_stops_at_window` (record at T, T+10, T+20; since(T+5) emits two in order; since(T+21) emits none), `test_since_honours_max`, `test_valid_id_and_kind` (36-char uuid ok; 40 chars refused; a space refused; `D` `X` `R` `C` `E` `P` ok; `Z` refused), `test_kind_round_trip` (every subject kind maps to a letter and back; NONE and LOGOUT map to 0).
- [ ] **Step 2: Run to verify RED.** Run: `make -C ircd/test webhook_eventlog_cmocka`. Expected: build fails, the header does not exist.
- [ ] **Step 3: Implement** the module (a heap array of entries, a `next` index, linear scans: the log is at most a few thousand entries and the walk is rare).
- [ ] **Step 4: Run to verify GREEN.** Run: `make -C ircd/test webhook_eventlog_cmocka && ./ircd/test/webhook_eventlog_cmocka`. Expected: 6 tests passed. Also `make` at the top: the ircd links.
- [ ] **Step 5: Commit** `webhook: the applied-events log (pure, tested)`.

---

### Task 3: A remote client is not this server's to deauth

**Files:** modify `include/bouncer_deauth.h`, `ircd/bouncer_deauth.c`, `ircd/test/bouncer_deauth_cmocka.c`, `ircd/sasl_webhook.c` (`deauth_action_for`), `ircd/ircd_features.c` + `include/ircd_features.h` only if decision 1 keeps the switch.

**Interfaces:** Consumes Task 1's rulings. Produces `struct BounceDeauthSubject` with a new field `int remote_ok;` (1 = act on a remote client as today: clear the account; 0 = SKIP it). `deauth_action_for` sets `remote_ok` from the decision-1 switch or 0.

- [ ] **Step 1: Write the failing tests** in `ircd/test/bouncer_deauth_cmocka.c`: `test_remote_client_is_skipped_by_default` (is_user, is_account, account_matches, !is_local, remote_ok 0 → SKIP; with do_kill too), `test_remote_client_cleared_when_remote_ok` (same with remote_ok 1 → CLEAR_ACCOUNT).
- [ ] **Step 2: Run to verify RED.** Run: `make -C ircd/test bouncer_deauth_cmocka`. Expected: build fails, no `remote_ok` member.
- [ ] **Step 3: Implement**: the field; in `bounce_deauth_classify`: `if (!s->is_local) return s->remote_ok ? BOUNCE_DEAUTH_CLEAR_ACCOUNT : BOUNCE_DEAUTH_SKIP;` with the comment rewritten (B-2 stays true: sockets are never exited remotely; the account clear of a remote replica is now its home server's job, reached by the direct delivery or the relay). In `deauth_action_for`: `subj.remote_ok = 0;` (or the feature).
- [ ] **Step 4: Run to verify GREEN.** Run: `./ircd/test/bouncer_deauth_cmocka`. Expected: 13 passed (11 + 2).
- [ ] **Step 5: Commit** `bouncer: a remote client's account clear is its home server's job (webhook plan 4)`.

---

### Task 4: One relay per event, deduped by the event id

**Files:** modify `ircd/sasl_webhook.c`, `include/sasl_webhook.h`, `ircd/ircd_features.c`, `include/ircd_features.h` (`WEBHOOK_EVENTLOG_SIZE`, `WEBHOOK_EVENTLOG_WINDOW`), `ircd/sasl_conf.c` or the init path (`webhook_eventlog_init(feature_int(FEAT_WEBHOOK_EVENTLOG_SIZE))` at startup and on a size change), `tests/src/services/keycloak-webhook-transport.test.ts` (or a new `keycloak-webhook-fanout.test.ts`), `tests/src/helpers/webhook-post.ts`.

**Interfaces:** Consumes Task 2's log and Task 3's classifier. Produces the wire form `CI <username|*> <kc_id|*> <event_id> <kind>`; `static void relay_event(const char *username, const char *kc_id, const char *event_id, char kind)` (replaces the two `sendcmdto_serv_butone_v3` calls in `cache_invalidate_subject`); `static void apply_relay(const char *username, const char *kc_id, const char *event_id, char kind, const char *origin)` shared by `ms_cacheinval` and Task 5's catch-up receiver; `struct sasl_webhook_stats` gains `applied_direct, applied_relay, applied_catchup, already_applied_direct, already_applied_relay, relays_sent, relays_forwarded, catchup_sent, catchup_received` (Task 5 fills the catch-up ones).

- [ ] **Step 1: Write the failing bed cases** (helpers: `postWebhook(event, 'nefarious2')` already targets the leaf's listener from `data/ircd2.conf`; add `statsWebhookNumber` patterns for the new lines; a leaf login helper through `SECONDARY_SERVER` / `IRC_PORT2` as `bouncer-deauth-cross-server.test.ts` does):
  - "the leaf acts on its own delivery": pool account logged in on the leaf; post a disable to `nefarious2`; the leaf client's WHOIS loses the 330 within 5 s; the primary's replica of that client shows no account either (the leaf's own `AC U`).
  - "an event delivered to one server reaches the other through the relay": pool account logged in on the primary; post a disable to `nefarious2` only; the primary client loses its account; the primary's STATS `applied via relay` grew by one and its `deauths` by one; the leaf's `deauths` did not grow (it owned no client).
  - "delivered to both servers: applied once per server, relays do not loop": one event id posted to both listeners; on each server exactly one of `applied directly` / `already applied` grew by one; the handler's user-event count grew by one on each; ten seconds later no counter moved again.
  - "a junk relay is purge-only": from an oper on the primary this cannot be injected (servers only), so the cmocka case below carries it; the bed case posts a synthetic event whose `id` is 60 characters: 200, applied (no dedupe possible), the log did not record it (`log entries` unchanged), no crash.
- [ ] **Step 2: Run to verify RED.** Run from `tests/`: `IRC_HOST=localhost npm test -- src/services/keycloak-webhook-fanout.test.ts`. Expected: the relay and both-servers cases fail on the missing STATS lines (timeout on `applied via relay`); the leaf case passes today (the old network-wide walk) and is kept as a regression guard.
- [ ] **Step 3: Write the failing cmocka case** `test_relay_parse_rejects_junk` in a small pure parser `webhook_relay_parse(parc, parv, &out)` placed in `webhook_eventlog.c` (returns 0 for a junk id or kind, fills a struct otherwise); Run: the cmocka program. Expected: fails to build.
- [ ] **Step 4: Implement**:
  - `handle_user_event`: after `webhook_subject_resolve`, `if (event->id && webhook_eventlog_record(event->id, webhook_relay_kind_for(s.kind), s.kc_id, s.username, CurrentTime)) { wh_stats.already_applied_direct++; log L_DEBUG; return; }` else `wh_stats.applied_direct++`. Credential events (`handle_credential_event`) do the same with kind `P`.
  - `cache_invalidate_subject` → local purge only, then `relay_event(username, kc_id, event_id, kind)`; `deauth_subject` and the credential path pass the event id and kind through.
  - `deauth_action_for`: `remote_ok = 0` (Task 3).
  - `ms_cacheinval`: `parc >= 5` → `webhook_relay_parse`; junk → purge by name/id only, no forward, `L_WARNING` once per minute; valid → `apply_relay(...)`: `if (webhook_eventlog_record(id, kind, kc_id, name, CurrentTime)) { wh_stats.already_applied_relay++; return; }` then purge, then for `D`/`X` `handle_sessions_for_account(name, reason for kind, feature_bool(kill feature for kind), kc_id)` for the payload name and for every local client carrying the id (`subject_account_names` restricted to `MyConnect`), then forward with `sendcmdto_serv_butone_v3(sptr, CMD_CACHEINVAL, cptr, "%s %s %s %c", ...)`, `wh_stats.relays_forwarded++`. `parc < 5` → today's body.
  - STATS: `W :  Applied: %lu direct, %lu via relay, %lu via catch-up; already applied: %lu direct, %lu relay` and `W :  Relays: %lu sent, %lu forwarded; catch-up %lu sent, %lu received; log %u entries, oldest %lld s`.
  - `webhook_eventlog_init` at `sasl_webhook_init` (first init only) with the feature value.
- [ ] **Step 5: Run cmocka GREEN**, then host `make`, then deploy (merge into `bed-deploy`, build BOTH, recreate both, wait), then the bed cases. Expected: fanout suite green; `keycloak-webhook-transport` 9/9, `keycloak-webhook-e2e` 3/3, `bouncer-deauth-local-alias` 2/2, `bouncer-deauth-cross-server` 3/3 (this one exercises the remote path: read its assertions against D2 before running; a case that asserted the primary's walk cleared a leaf client now relies on the leaf's own application through the relay, which is the same observable), `x3-account-change` 2/2, `sasl-reauth` 4/4.
- [ ] **Step 6: Commit** `webhook: one relay per event, deduped by the Keycloak event id; a receiver acts on what it owns`.

---

### Task 5: Catch-up on link

**Files:** modify `ircd/sasl_webhook.c`, `include/sasl_webhook.h` (`void sasl_webhook_link_catchup(struct Client *cptr);`), `ircd/m_endburst.c`, `ircd/test/webhook_eventlog_cmocka.c` (the window case is Task 2's; add `test_since_max_bounds_catchup` if not covered), `tests/src/services/keycloak-webhook-fanout.test.ts`.

**Interfaces:** Consumes `webhook_eventlog_since` and `apply_relay`. Produces the catch-up sender and the `applied via catch-up` / `catch-up sent, received` counters (a catch-up line is a five-parameter `CI` from a directly connected server whose burst just ended; the receiver counts it as catch-up when `IsBurstAck`-adjacent state says the link is fresh: simplest is a sixth optional parameter `B` marking a catch-up line, which the receiver counts and applies like a relay).

- [ ] **Step 1: Write the failing bed case** "an event applied during a split reaches the leaf after relink": oper on the primary; pool account logged in on the leaf; `SQUIT leaf.fractalrealities.net :webhook catch-up test`; wait until the primary's `LINKS` no longer lists the leaf; post a disable for that account to the primary only (the primary owns no client: it logs and relays to nobody); `CONNECT leaf.fractalrealities.net`; wait for the link (the pattern in `chathistory-presence-replication.test.ts` lines 237-298); within 20 s the leaf client's WHOIS loses the 330; the leaf's STATS `applied via catch-up` grew by one and the primary's `catch-up sent` by at least one.
  Also "catch-up does not touch a re-created account" (Review Focus 2): the same split; post a delete (with a Keycloak-id-carrying synthetic event, id X) to the primary during the split; on the leaf, before relink, log the pool account out and in again (its Keycloak id is unchanged on the bed, so use a synthetic event with a DIFFERENT `resourcePath` uuid than the account's real id: the walk must not touch a client whose id differs); after relink the leaf client keeps its account, `already applied` and `applied via catch-up` show the line arrived.
- [ ] **Step 2: Run to verify RED.** Expected: after relink the leaf client keeps its account (no catch-up exists); the STATS line is missing.
- [ ] **Step 3: Implement** `sasl_webhook_link_catchup(cptr)`: `if (!IsIRCv3Aware(cptr)) return;` iterate `webhook_eventlog_since(CurrentTime - feature_int(FEAT_WEBHOOK_EVENTLOG_WINDOW), emit, cptr, feature_int(FEAT_WEBHOOK_EVENTLOG_SIZE))` with `emit` sending `sendcmdto_one(&me, CMD_CACHEINVAL, cptr, "%s %s %s %c B", name or *, kc_id or *, id, kind)`; `wh_stats.catchup_sent += n`; one `L_INFO` line with the count. Call it in `ms_end_of_burst` inside `if (MyConnect(sptr))` next to `presence_burst_sync(sptr)`. Receiver: `parc >= 6 && parv[5][0] == 'B'` → `wh_stats.catchup_received++` and `applied_catchup` instead of `applied_relay` when new; forwarding strips the `B` (downstream servers see a plain relay).
- [ ] **Step 4: Run to verify GREEN**: cmocka, host build, deploy both, the fanout suite, then the neighbours as in Task 4 Step 5. Expected: all green.
- [ ] **Step 5: Commit** `webhook: a newly linked peer is caught up on the events applied while it was away`.

---

### Task 6: Every ircd in the SPI's list; docs

**Files:** `.env`, `.env.local` (`KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL=http://nefarious:9090/keycloak-webhook,http://nefarious2:9091/keycloak-webhook`), `tests/src/services/keycloak-webhook-e2e.test.ts`, `FEATURE_FLAGS_CONFIG.md`, `P10_PROTOCOL_REFERENCE.md`, `keycloak-webhook-spi/README.md` (one line), the `p10-protocol`, `sasl-keycloak`, `service-debugging`, `test-writing` skills.

- [ ] **Step 1: Write the failing e2e assertion**: in the disable case, read the LEAF's STATS `applied directly` before and after the real Keycloak event (an oper on `SECONDARY_SERVER`); expect +1. Run: the e2e suite. Expected: the leaf's count does not move (the SPI posts to the primary only).
- [ ] **Step 2:** Edit both env files in place (r+ rewrite), `scripts/dc.sh up -d --force-recreate --no-deps keycloak`, wait healthy; `docker exec keycloak sh -c 'echo $KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL'` shows both.
- [ ] **Step 3: Run to verify GREEN**: the e2e suite 3/3 with the new assertion; then `keycloak-webhook-fanout` again (real fan-out plus synthetic).
- [ ] **Step 4: Docs**: `FEATURE_FLAGS_CONFIG.md` (the URL list rule "list every ircd", the two features, the STATS lines, the `CI` five-parameter form, the uncovered cases of D7); `P10_PROTOCOL_REFERENCE.md` and the `p10-protocol` skill (`CI` grammar with the event id, kind letters and the `B` marker); `sasl-keycloak` (D2..D5 in three sentences); `service-debugging` (the new STATS lines as oracles; posting to the leaf's 9091); `test-writing` (the fanout suite and the split/relink pattern); SPI README: "list every ircd; each verifies and dedupes on its own".
- [ ] **Step 5: Commit** `bed: the SPI posts to every ircd; docs for the relay, the log and the catch-up`.

---

## Self-review

**1. Spec coverage.** Every server receives (D1, Task 6). Fan-out covers misses (D3 relay, Task 4). Split-but-not-down server acts on its own delivery (D2, Tasks 3-4) and, when the SPI could not reach it, is caught up on relink (D5, Task 5). No double application (D4, Task 4's dedupe on both paths). Uncovered cases named (D7, Task 6 docs).

**2. Placeholder scan.** Task 1 is an analysis task with a concrete deliverable; Task 4's bed cases are listed with their observables; every code step names its functions and counters.

**3. Type consistency.** `webhook_eventlog_record(id, kind, kc_id, username, now)` in Tasks 2, 4, 5; `apply_relay(username, kc_id, event_id, kind, origin)` in Tasks 4 and 5; `remote_ok` in Tasks 3 and 4; the wire form `CI <username|*> <kc_id|*> <event_id> <kind> [B]` in Tasks 4, 5, 6.

**4. Review focus.** 1 → Task 4 Step 3 cmocka + bed junk case; 2 → Task 5 bed case; 3 → Task 2 cmocka; 4 → Task 4 bed case; 5 → Task 2 cmocka + Task 6 doc sentence.

**To verify at execution time:** whether `bouncer-deauth-cross-server.test.ts` asserts anything that only the old remote walk produced (Task 4 Step 5 note); whether `presence_burst_sync`'s placement runs before or after the peer's `EOB` ack matters for a `CI` sent in the same tick (it does not: `CI` needs no burst state); the leaf's oper block for the STATS reads on `SECONDARY_SERVER`; whether `event->id` is populated for synthetic events without an `id` (the helper always sets one).

---

## Execution record (2026-09-24)

Executed inline (`superpowers:executing-plans`) after the user's "the log will probably need some more work later, but it's a fair start", with the five recommendations taken as decided (ledgered ruling). One bouncer-analyst pass before the walk changed (Task 1, report `2026-09-24-webhook-every-server-bouncer-pass.md`), one fresh-context review (Agent, model fable) at the end, one fix pass. Nothing pushed; push commands in `step5-pr-drafts-2026-09-23.md`.

**Commits.** nefarious `feature/webhook-every-server` on 32e3664 (the pushed tip of every fork branch): 68e3b6f the applied-events log (pure, cmocka); 44fb502 the relay parser and the kind letters; 651f87c the deauth classifier's `remote_ok` (a remote client is its home server's job); 8fb32ef one relay per event with the resolved names, the receiver applying to what it owns, the KILL-path fallback, STATS; 9a5c091 the catch-up at end of burst with enable-supersedes-disable compaction; e47e5ad a bare enable relayed; 028de05 the review fix pass. testnet main 20b2f9f3..d4edfbaf: the plan and the bouncer pass, the fan-out suite (eight cases) and helpers, the e2e assertion, `.env` listing both ircds, docs (`FEATURE_FLAGS_CONFIG.md`, `P10_PROTOCOL_REFERENCE.md`, four skills). SPI: one local README commit 063e616.

**Bouncer pass (Task 1).** SKIP-remote keeps invariant 12 provided every server applies the event, and is required once the SPI fans out (two receivers with the old walk send two `AC U` per client, the second a DESYNCH). Applied: H1 the relay carries the resolved names (payload, cache-dropped, every client carrying the id; resolution global, action local); H2 a killed primary's aliases are exited by pointer when a sibling's `AC U` already destroyed the session (local aliases only, after the review); H5 the catch-up sends a superseded disable as a purge; H4 is decision 1's cost (register).

**Review.** No Critical. Important 1: the direct delivery's log entry held only the payload name, so a catch-up carried none for a real delete or disable; fixed with `webhook_eventlog_set_names` from both paths. Important 2: compaction tied on equal timestamps (unstable sort, wrapped ring); fixed with an insertion sequence as the tie-break. Important 3: the KILL fallback exited remote aliases (a `BX X` that never reaches the alias's home); local aliases only now. Important 4: the re-created-user rule had no test; a bed case and a doc sentence. Minors 5-11 deferred to the register.

**Rulings** (the ledger had the full lines, each with its cost if wrong): the five recommendations as decisions; the branch cut from the pushed tip; the kind mapping lives in `webhook_subject.c` so the log stays free of jansson; the Makefile wiring precedes a red run; Task 3 waited for Task 1 while Task 4's independent pieces went first; Task 3's commit is the pure classifier, the walk's changes ride Task 4's commit; the log is sized at first use (a feature change takes effect at restart); the H1 bed case is a regression guard (whether an AuthServ login is id-less on this bed is unverified); the receiver forwards the list it received; a build without the Keycloak client purges and forwards only; the `B` marker travels one link; compaction keys on the Keycloak id when both entries carry one, else on the names; an enable is relayed even when it names nobody; the split case's catch-up count is a floor; the reviewer's declined-to-judge list stands as set aside.

**Traps learned.** After recreating both ircds the leaf can take up to ten minutes to link: wait for it by name, as an oper (`LINKS` is restricted for non-opers, and the bed lists nine servers under the mesh profile, so never count). A chain that skips that wait runs the two-server suites on a split bed and every relay case fails for lack of a link. `x3-account-change` needs `X3_AC_CHANGE=1`. A `NaN` from a missing STATS line satisfies `toBe`; the counters helper throws instead.

**Proof on the bed** (images from bed-deploy 2e23ac1, feature tip 028de05): fan-out 8/8 (the leaf acts on its own delivery; a relay reaches the other server; delivered to both servers it is applied once each with no loop; a real-shaped id-only event reaches a name-only AuthServ session on the other server; a split-time event reaches the leaf after relink through the catch-up; a disable superseded by an enable during the split does not deauth after relink; an event for another Keycloak id leaves an id-carrying session alone; a junk id is applied but not logged), e2e 3/3 (the leaf receives real Keycloak events directly), transport 9/9, bouncer-deauth local-alias 2/2 and cross-server 3/3, x3-account-change 2/2, sasl-reauth 4/4; cmocka `webhook_eventlog` 11/11, `webhook_subject` 11/11, `bouncer_deauth` 12/12; host build and the kc boundary guard clean.

**Pushed, 2026-09-24.** nefarious: `feature/webhook-every-server` 028de05 fast-forwarded all four fork branches (origin and upstream, ircv3.2-hardening and ircv3.2-upgrade) from 32e3664. SPI: the README commit 063e616 went straight to evilnet main. The bed's SPI checkout is at 063e616 (no jar rebuild needed: docs only).
