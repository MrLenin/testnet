# Keycloak webhook subsystem audit — 2026-09-22

**Scope:** `keycloak-webhook-spi` (producer) → `libkc kc_webhook` (transport) → `nefarious ircd/sasl_webhook.c` (consumer) → `CI`/`CACHEINVAL` P10 fan-out.

**The ircd is the only consumer.** X3 is no longer a webhook target. That is load-bearing for this audit: the SPI's payload contract is still written *to X3's* shape, and re-pointing the subsystem at the ircd without re-deriving that contract is the direct cause of P0-1 below.
**Trees audited:** `nefarious` @ `01d2d04` (`bed-deploy` == `origin/ircv3.2-hardening`, the non-CRDT prod branch), `nefarious-crdt` @ `3a1306f` (`crdt-mesh`), `keycloak-webhook-spi` @ `634f383`, `x3` @ `4d29d8e` (`feature/ldap-identity-binding`).
**Driver:** prod-test is about to get a real prod Keycloak. Catch this before it does.

## Verdict

The subsystem is **inert end-to-end today, and has never run green on the bed**. On top of that, the two events that carry security weight — account **delete** and account **disable** — are **dead code paths even when delivery works**, because Keycloak does not put a username in those payloads and the handler returns early without one. The only live path is credential-change (password) invalidation.

Nothing here is a regression; it is a subsystem that was built against one consumer, re-pointed at another, and never had its contract re-derived. It needs work before a prod Keycloak points at it.

**One finding is live in prod today and has nothing to do with the webhook being inert:** `bounce_emit_alias_update` has no `"account"` case, so every X3-initiated deauth strands *local* aliases with a stale account (B-1). That path runs constantly. Fix it independently of everything else here.

## Live evidence (bed, 2026-09-22)

| Check | Result |
|---|---|
| ircd webhook listener | up, `0.0.0.0:9090` inside the container, not published on the host |
| realm `testnet` events config | `webhook-events` listener enabled, `adminEventsEnabled: true`, `adminEventsDetailsEnabled: true` — correct |
| Keycloak SPI secret (container env) | `changeme` |
| ircd expected secret (`data/ircd.conf:518`) | `x3-webhook-secret` |
| Keycloak delivery log, 72h | **100% failure.** `nefarious:9090` → `400 Bad Request` ×4 attempts; `x3:9080` → connection error (`null`) ×4 attempts |
| `x3:9080` endpoint | **phantom — X3 is not a consumer any more.** Still first in the SPI URL list (`.env.local:62`) and the only entry in committed `.env:81`. `x3` tree has zero webhook code, nothing listens on 9080, and `data/x3.conf:323-325` still configures a port/secret for it. Every event burns 4 attempts against it |
| Probe: `POST /keycloak-webhook` w/ `x3-webhook-secret`, `CREDENTIAL/UPDATE` + root `username` | `200 OK`, ircd logs `WEBHOOK: Password change for … — invalidating auth caches` ✅ |
| Probe: same secret, `USER/DELETE` shaped exactly as Keycloak emits it | `200 OK`, **no handler log line, no cache invalidation, no CI** ❌ |
| Live realm admin-event store (400 events) | `USER/DELETE` ×128: `resourcePath` + `authDetails` only — **no representation, no username**. `USER/UPDATE` ×23: representation is a **partial diff** (`{"emailVerified":…,"requiredActions":…}`) — never carries `username`, never carries `enabled` |

## Findings

Severity: **P0** = fix before a prod Keycloak is pointed at this. **P1** = fix before relying on the feature. **P2** = correctness/hygiene.

### P0-1 — Account delete and disable are dead paths

`ircd/sasl_webhook.c:handle_user_event()` opens with `if (!event->username) return;`, before the DELETE/UPDATE branches. Keycloak's `USER/DELETE` admin event carries **no** username and **no** representation (verified: 128 live samples). `USER/UPDATE` carries a **partial** representation that never includes `username` (23/23 live samples). The username fallback chain in `kc_webhook.c` is: root `username` → `authDetails.username` → `representation.username`; the SPI only injects root `username` for *user* credential events (`addUserScramCredentials`), never for admin events, and Keycloak's `AuthDetails` has **no username field at all** (live payloads carry only `realmId`/`clientId`/`userId`/`ipAddress`).

Consequences on prod:
- Deleting a Keycloak account leaves every logged-in session authenticated to it indefinitely, keeps the positive auth cache serving it for up to `SASL_POSCACHE_TTL` (300s), and broadcasts no `CI`.
- Disabling an account does nothing at all.
- `FEAT_WEBHOOK_KILL_ON_DELETE` / `FEAT_WEBHOOK_KILL_ON_DISABLE` are unreachable.

**Root cause, not just symptom:** the payload was shaped for X3's resolver, and the SPI still says so in the code. `formatUserEvent` is documented "matching X3's expected format"; the root-level `username` injection is commented `// Add username for X3 lookup`; the whole `mapEventTypeToResourceType` / `mapEventTypeToOperationType` layer exists `// For X3 compatibility`; `formatAdminEvent`'s javadoc still specifies what `X3's keycloak_webhook.c expects` (11 such references in SPI source, `WebhookEventListenerProvider.java:121-362`). Nobody re-derived the contract against what `sasl_webhook.c` actually requires when the ircd became the consumer — and the ircd requires a username on exactly the events X3 could resolve without one.

**So the first fix is a contract, not a patch:** write down what the ircd's handlers need per resource/operation type, make the SPI satisfy it, and re-anchor those comments to `sasl_webhook.c`. Then P0-1 and P0-2 fall out of it.

This is the mechanism behind the standing `project_x3_name_reuse_escalation` hazard.

**Fix direction:** resolve the subject by UUID, not username. `event->user_id` *is* already parsed out of `resourcePath` (`kc_webhook_extract_user_id`) and is present on every one of these events. Options, in order of preference:
1. Have the SPI inject `username` (and `realmName`) into **admin** events too — it has the `KeycloakSession` and already does exactly this for user events. For DELETE it must read the user *before* the transaction commits, or capture it from the representation Keycloak holds.
2. Failing that, the ircd keeps a `kc_uuid → account` map (populated at SASL success) and resolves DELETE/disable by UUID. This also survives the rename case.
3. Reorder `handle_user_event` so the `enabled:false` check is reachable via UUID even when username is absent.

Also fix the `authDetails.username` fallback in `kc_webhook.c:dispatch_event()`: `authDetails` is the **acting admin**, never the subject. If any producer ever populates it, a delete performed by admin `ibutsu` would deauth/kill *ibutsu's* sessions. Drop that fallback or restrict it to events where subject == actor.

### P0-2 — Admin password reset does not invalidate the auth cache

Live store shows admin-initiated resets arrive as `USER` / **`ACTION`** / `resourcePath: users/<uuid>/reset-password`, with no representation and no username. `handle_user_event` handles only `DELETE` and `UPDATE`, so nothing happens. Keycloak emits **no** user-level `UPDATE_PASSWORD` event for an admin REST reset, so there is no second chance.

Result: after an admin resets a password, the **old** password keeps authenticating via the positive cache for up to 300s. Add a `KC_WH_OP_ACTION` branch keyed on `resource_path` ending in `/reset-password` (and `/logout`, `/execute-actions-email` as appropriate).

### P0-3 — Webhook endpoint is unauthenticated-by-network, plaintext, replayable — and the config knob that would fix it is silently ignored

`ircd/sasl_conf.c:wh_apply_now()` builds a full `struct kc_webhook_config` from the parsed `Webhook {}` block — `vhost`, `path`, `maxrequestsize`, `maxconnections`, `queuemax`, `batchsize` — and then calls `sasl_webhook_init(cfg.port, cfg.secret)`, which **discards everything but port and secret** and re-derives a zeroed config inside `sasl_webhook.c`. The parser accepts all six items (`ircd/ircd_parser.y:2135-2172`), `wh_changed()` compares all six, and `wh_active` records all six — so an operator who writes `vhost = "127.0.0.1";` gets a listener on `0.0.0.0` with no error, and believes otherwise. Verified live: `/proc/net/tcp` shows `00000000:2382`.

Stacked on that:
- Auth is a **static shared secret in a plaintext header** over **HTTP**, with no body HMAC, no timestamp, no nonce → observable and **replayable indefinitely**. A replayed `USER/DELETE` (once P0-1 is fixed) is a mass-deauth/KILL primitive.
- The ircd never checks `realmId`. A prod Keycloak hosting other realms, or a listener enabled realm-wide, means events from **any** realm act on ircd accounts by name.
- The secret is still named for the departed consumer — `"WEBHOOK_SECRET" = "x3-webhook-secret"` in all seven ircd confs (`data/ircd.conf:518`, `ircd2:317`, `ircd3:222`, `ircd4:185`, `ircd5:185`, `ircd6:185`, `ircd7:193`) and in `data/x3.conf:324`. Cosmetic, but it is the thing an operator greps for during a prod incident.

**Fix direction:** thread the whole config through `sasl_webhook_init` (change its signature to take `const struct kc_webhook_config *`); bind to loopback or a private address by default; require TLS or a private link on prod; add an HMAC-SHA256 body signature with a timestamp window to the SPI and verify it in `kc_webhook.c`; have the SPI emit `realmName` and make the ircd reject events from other realms.

### P0-4 — No operator-visible surface; failures are silent

`sasl_webhook_stats_get()`, `sasl_cache_stats_get()` and `kc_webhook_stats_get()` have **zero callers in the entire tree** — the stats structs are written and never read. There is no `STATS` character for the webhook, and nothing on a snomask. The only signal that the whole subsystem is dead is a `WARNING` log line, and per `feedback_prod_limited_logging` log-grep diagnostics are not available on prod.

That is exactly how the bed sat at 100% delivery failure without anyone noticing. Wire a `STATS` entry following the existing `webpush` precedent at `ircd/s_stats.c:745` (`STAT_FLAG_OPERFEAT`) exposing both the libkc transport counters (received / invalid / dropped / rejected / queue depth / last event time) and the business-logic counters. Add a snomask notice on sustained secret rejection — a wrong secret should be loud, not a debug line.

### P1-1 — Bed secret mismatch; webhook path has never run green

`.env.local` sets `KC_SPI_..._SECRET=changeme`; `data/ircd.conf:518` and `data/x3.conf:324` both expect `x3-webhook-secret`. Every delivery has been rejected. Nothing in the bed or in CI exercises the path, so P0-1/P0-2 were invisible.

Fix the secret in one place (prefer templating `data/ircd.conf` from `.env.local` — note `project_sasl_config_secrets_blocker`), then add coverage.

Two config items travel with it, both from the X3 era:
- **Committed `.env:81` points only at `x3:9080`** and omits the ircd endpoint entirely — anyone running without a `.env.local` gets no ircd delivery at all, and no error that says so.
- **`.env.local:62` still lists `x3:9080` first.** It is a phantom: nothing listens there. Removing it is a one-line change that halves the retry load and eliminates the connection-error half of the current failure. Also drop the dead `keycloak_webhook_*` block from `data/x3.conf:323-325`.

### P1-2 — Zero test coverage

No Vitest test, no CMocka suite, no fixture exercises the webhook or the `CI` token — `grep -rl webhook tests/` returns only two incidental comment mentions, and `grep -rl CACHEINVAL tests/ nefarious/tests/` returns nothing. The SPI has **no `src/test` directory at all** despite the README documenting `mvn test`.

Minimum viable coverage, and the natural TDD shape for the P0 fixes:
- CMocka over `dispatch_event` + the handlers with **captured real payloads** (the 400-event live store is the fixture source): assert DELETE/disable/reset-password each reach invalidation, assert `authDetails.username` is never taken as the subject, assert realm mismatch is rejected.
- A bed integration test that drives a real Keycloak account through delete/disable/admin-reset and asserts the ircd's observable reaction (deauth notice, `ACCOUNT *`, `CI` on the peer link — `nefarious2` is already configured on port 9091 with the same secret).
- SPI unit tests over `formatAdminEvent` / `formatUserEvent` / the `WATCHED_*` filters.

### P1-3 — SPI ships SCRAM verifier material in cleartext to a consumer that ignores it

`WebhookEventListenerProvider.addUserScramCredentials()` embeds `salt`, `iterations`, `storedKey`, `serverKey` in the body of every credential-change event, to **all** configured endpoints, over plaintext HTTP. The ircd parses them into `event.scram` and then **never reads them** — `handle_credential_event` only invalidates caches (the SPI's own javadoc already admits this). StoredKey/ServerKey are RFC 5802 verifier material: enough for server impersonation and for an offline dictionary attack.

With the ircd as the only consumer this is now a clean either/or, no per-endpoint negotiation needed:
- **Drop the `scram` block from the payload.** Simplest, and matches today's behaviour — the ircd already fetches these attributes over admin REST when it needs them.
- **Or consume it deliberately** as a cache pre-warm (which is what the SPI comment says it was for) and require TLS on the endpoint. Worth a decision either way: pre-warming removes an admin-REST round trip from the first SCRAM auth after a password change.

What is not acceptable is the status quo — password-equivalent verifier material on a cleartext wire, parsed into `event.scram` and then discarded.

### P1-4 — SPI resource model will not survive prod load

- **`HttpClient` is constructed per provider instance** (`WebhookEventListenerProvider` constructor), and Keycloak calls `create(KeycloakSession)` **per session**. Java 17's `HttpClient` has no `close()` and each instance owns a selector thread plus a connection pool, released only on GC. On a prod-volume realm this is continuous thread/FD churn. Make it a single `static final` client owned by the factory.
- **Delivery runs on the ForkJoinPool common pool with blocking `send()` + `Thread.sleep()`** (`sendWithRetry`). Confirmed in the bed logs: `ForkJoinPool.commonPool-worker-*` threads held ~7s per failed endpoint (1s+2s+4s backoff), ×2 endpoints, ×every event. The common pool is shared with the rest of the JVM and sized to cores−1. A dead or slow consumer starves it — and today **half of that burned time is the phantom `x3:9080` endpoint** (see P1-1), so removing it is also the cheapest mitigation available. Use a dedicated bounded executor and `sendAsync` with a backoff scheduler, and shed load when the queue is full.
- **No cap on in-flight deliveries.** With `send-all-events=true` (which the README actively recommends for SIEM/audit) every `LOGIN`/`LOGIN_ERROR` becomes a POST to the ircd. Do not enable that while the ircd is in the URL list.
- **No delivery guarantee and no reconciliation.** After 4 attempts the event is dropped with an `ERROR` log. An ircd restart during a password change means a stale cache (bounded, 300s, tolerable); a missed *delete* is permanent divergence (unbounded). Fire-and-forget needs a periodic reconciliation pass, not just retries.

### P1-5 — SCRAM attribute lifecycle is not owned; stale attributes outlive the password

Derivation is genuinely in lockstep — `ScramPasswordPolicyProvider` (SHA-256, 4096 iterations, 16-byte salt, `Client Key`/`Server Key`, StoredKey=H(ClientKey)) matches `nefarious/ircd/kc/kc_cred_derive.c` exactly. Two real problems around it:

1. **Attributes are written from a password-policy `validate()` call as a side effect.** `validate()` runs *before* the password change is committed and before later policies in the chain have passed. The bed realm's `passwordPolicy` is literally just `scramSha256`, so nothing else can reject — but prod will add `length(…)`, `notUsername`, history, etc. If a later policy rejects and the attribute write commits anyway, the new password becomes usable via SCRAM-SHA-256 while Keycloak never stored it and PLAIN correctly rejects it. **Needs a live test on prod-shaped policy config before SCRAM is enabled there.** The structurally correct hook is the credential-update lifecycle, not `validate()`.
2. **Any password change that bypasses password policies leaves the attributes stale**, i.e. the *old* password stays valid via SCRAM forever. Pre-hashed credential imports / partial imports are the concrete case.

Note `SASL_LOCAL_MECHANISMS` defaults to `PLAIN,OAUTHBEARER` (SCRAM off), but the bed enables `PLAIN,OAUTHBEARER,SCRAM-SHA-256` in both `data/ircd.conf:515` and `data/ircd2.conf:315`. **Recommend: keep SCRAM-SHA-256 off on prod** until the attribute lifecycle is owned end-to-end.

### P2 — Correctness and hygiene

- **Untrusted username straight onto the P10 wire.** `handle_credential_event` / `handle_user_event` pass `event->username` verbatim to `sendcmdto_serv_butone_v3(… "%s", username)` and to the cache invalidators. Nothing validates length or character set. A username over `ACCOUNTLEN` silently fails to match any cache entry (entries are `char username[ACCOUNTLEN+1]`), and a username containing a space truncates the `CI` parameter on the peer. Validate against the account-name grammar and length before both the cache op and the emit.
- **`CI` cannot cross a legacy hop.** Both the origin emit and the `ms_cacheinval` relay use `sendcmdto_serv_butone_v3`, which skips non-IRCv3-aware peers. `fork — legacy — fork` leaves the far fork's positive cache stale for the full 300s. Same class as `bouncer-alias-hunt-egress`. Matters if prod keeps a legacy or upstream-slot server mid-topology.
- **Unreachable branches.** (a) `handle_credential_event`'s `KC_WH_OP_DELETE` arm requires `event->representation`, but Keycloak emits **no** `CREDENTIAL` resourceType admin events at all (0 in 400 live samples) and user events never carry a representation — so the x509-revocation branch is dead. (b) `handle_session_event` requires `KC_WH_OP_DELETE`, but the SPI maps `LOGOUT` → `ACTION`, so the logout path is dead too. (c) `REMOVE_CREDENTIAL` is in `WATCHED_USER_EVENTS` but `isCredentialChangeEvent()` excludes it, so it ships without a username and invalidates nothing.
- **`WATCHED_RESOURCE_TYPES` omits `CREDENTIAL`** while the README claims credential operations are sent. Harmless today only because Keycloak 26 does not emit that resourceType. `REALM_ROLE_MAPPING` is watched but undocumented.
- **HTTP parsing edge cases** in `kc_webhook.c`: a read that exactly fills the buffer is rejected `400` (`parse_http_headers` bails on `buf_used >= buf_size`); `Content-Length` via `atoi` accepts a negative value that casts to a huge `size_t` and stalls the connection until the 10s timer; `stats.events_received++` is incremented before authentication, so the counter conflates real events with probes. No chunked-encoding support (fine for the Java client, which always sets `Content-Length`).
- **X3 attribution drift throughout.** The SPI still documents itself as an X3 integration: 11 source references (`WebhookEventListenerProvider.java:121-362`) plus 10 README lines, an entire `## X3 IRC Services Integration` section prescribing `x3.conf` settings, and a `META-INF/services` comment justifying the disabled credential provider in terms of "X3's pre-hashed credential imports". `kc_webhook.h:8` / `kc_webhook.c:5` still read "Extracted from X3's keycloak_webhook.c to allow both X3 and Nefarious to receive Keycloak admin events". This is not cosmetic — it is the documented contract, and it describes a consumer that no longer exists (see P0-1).
- **Dead code + lockstep drift.** `ScramCredentialProvider.java` (256 lines) is deregistered via a comment-only `META-INF/services` file, yet **both** lockstep comments in `kc_cred_derive.c`/`.h` name `ScramCredentialProvider` as the counterpart — the live producer is `ScramPasswordPolicyProvider`. Someone maintaining lockstep would edit the dead class. `pom.xml` targets `keycloak.version 26.0.0` against a running 26.4.7. The README's "Event Formats" section documents payload fields the ircd cannot receive.
- **`scripts/setup-keycloak.sh:892`** short-circuits on "`webhook-events` already enabled" and therefore skips the `adminEventsEnabled` / `adminEventsDetailsEnabled` writes. A realm where the listener was added by hand stays silently without admin events.
- **Rehash churn.** Any `wh_changed()` field — including the ones that are discarded — tears down and rebinds the listener, and `sasl_webhook_init` memsets the business-logic stats each time. `kc_webhook_set_secret()` exists for exactly this and is never called.

## Consumer-side session handling (bouncer-analyst pass, claims re-verified)

A dedicated bouncer-analyst pass over `handle_sessions_for_account()` / `deauth_client()` returned nine findings. I independently re-verified the five load-bearing ones against the source; the verdicts below distinguish what I confirmed from what still needs field data.

**Sequencing note that changes the priority order:** every one of these lives *behind* P0-1 — `handle_user_event` returns before `handle_sessions_for_account` is ever reached, so none of the webhook-side ones can fire today. **They become live the moment P0-1 is fixed**, so they must be fixed *in the same change*, not queued after it. The one exception is B-1, which is live in prod right now by a different route.

### B-1 (High, **LIVE IN PROD TODAY**) — `bounce_emit_alias_update` has no `"account"` case, so local aliases never lose the account

✅ **Verified.** `bouncer_session.c:6774-6789`'s local-apply block handles `host`, `realhost`, `realname`, `fakehost`, `cloakhost`, `cloakip`, `username` — and **no `account`**. The S2S `BX U <numeric> account=` at `:6792` does go out, and its receiver `bounce_alias_update` (`:8692-8698`) *does* handle `account` (string + `ClearAccount`). So **remote aliases are cleared and local aliases are not** — the exact opposite of what the skip in `sasl_webhook.c:119-124` assumes ("aliases mirror the primary's account via the BX U emit"). `ClearAccount` has only two call sites outside the webhook (`m_account.c:206`, `bouncer_session.c:8697`); nothing clears a local alias.

**This is not webhook-specific and does not depend on any webhook fix.** `ms_account`'s `'U'` branch calls the same helper at `m_account.c:203`, so **every X3-initiated deauth — logout, persistence detach, any `AC <numeric> U` — strands local aliases on the receiving server with a stale `FLAG_ACCOUNT` and account string.** That path runs constantly in prod. A stale alias still passes `+r`/`+R`/`+D`/`ACCOUNTONLY` gates, still shows an account in WHOIS/`CHECK`, and still resolves through `bounce_find_by_account`.

Channel `authusers` does **not** underflow — alias memberships are symmetric and `channel_account_adjust` skips `IsMemberAlias` (`channel.c:924`) — so that class is clean.

Fix: add the `account` case to the local block, mirroring `:8692-8698`. The two apply blocks are structurally duplicated; a shared `bounce_apply_alias_field()` would stop the next field from being half-implemented the same way.

### B-2 (Critical **once P0-1 lands**, default-on) — the kill path exits *remote* clients: no KILL, wrong-direction QUIT, split-brain

✅ **Verified, including the default.** `F_B`'s third argument is `def_int`, not the current value (`ircd_features.c:944-946` against the struct at `:957-972`; cross-checked with `F_I(BUFFERPOOL, 0, 27000000, 0)`, whose documented default is 27000000). So **`F_B(WEBHOOK_KILL_ON_DELETE, 0, 1, 0)` defaults to TRUE**, and no bed conf overrides it. Account *deletion* therefore takes the **kill** path by default; disable takes deauth. Note the in-code comment at `sasl_webhook.c:167` ("Default: deauth (AC U). KILL_ON_DELETE escalates to disconnect") **contradicts its own feature table** — worth fixing on its own.

The loop at `sasl_webhook.c:114-131` has **no `MyConnect`/`MyUser` gate** and `GlobalClientList` is network-wide. For a remote victim, `exit_client` (`s_misc.c:1028-1052`):
- emits **no `CMD_KILL`** — verified, the only S2S emissions on the path are `BX X` (aliases/holds) and the `Q`;
- sends a **victim-sourced `QUIT` on every downlink**: the exclusion is `dlp->value.cptr != cli_from(killer)` with `killer == &me`, and `cli_from(&me)` is never a real link, so nothing is excluded;
- tears the victim down locally.

Peers routing the victim *through* us accept the Q and drop the user; peers on the victim's side — **including its home server** — see it arriving from the wrong direction and discard it. Net: the account holder stays connected and in channels on their own server, vanishes on part of the network, and no oper ever sees a KILL. Permanent split-brain until a netsplit.

The deauth path does not have this problem: `AC U` from `&me` propagates legally and the home server runs the full `ms_account 'U'`.

### B-3 (High) — the webhook server keeps the session, metadata and DB record that every peer destroys

✅ **Verified by direct comparison.** `ms_account 'U'` destroys every session for the account (`m_account.c:176-180`) and calls `metadata_clear_client` (`:182`). `deauth_client` does **neither**. So after one webhook deauth on server A: A keeps the sessions, the `bounce_db` record and the persisted metadata; every peer destroys theirs. The deleted account stays revivable on A, and `bounce_db_restore` re-creates a ghost with `SetAccount()` at restart with no validation (already tracked as `project_bounce_db_restore_validation`).

**Privilege chain worth stating plainly:** `bounce_apply_oper_grant` (`bouncer_session.c:6959-7017`) re-grants oper from `sess->hs_oper_name` against the local O:line with **no account re-verification**. Compose with `project_x3_name_reuse_escalation`: Keycloak delete → webhook deauth → session + oper grant survive on the webhook server and in `bounce_db` → the account name is re-registered by someone else → `bounce_auto_resume` revives → oper is restored. This is the same escalation P0-1 feeds, one layer deeper.

Also: the peers' destroy loop is **account-wide**, while the webhook loop emits one `AC U` per matched client — so a held ghost plus a live primary means peers nuke both replicas while A keeps both.

### B-4 (High) — under legacy accounts the deauth half-applies

✅ **Verified structurally.** `sasl_webhook.c:96-97` suppresses `AC U` when `FEAT_EXTENDED_ACCOUNTS` is off, but the `BX U <numeric> account=` emit at `bouncer_session.c:6792` is **outside any such gate**. Result: the primary's account clears only locally while every peer and X3 still see them authenticated, yet *remote aliases of the same session do* lose their account. One session whose connections disagree about their own account, and a network that disagrees with the deauthing server. For a remote user the next link burst re-teaches the account from the peer's N token, silently undoing the local clear.

The reasoning in that comment is sound (legacy `AC` genuinely has no unregister form), so the honest conclusion is that **deauth is not implementable under legacy accounts**: escalate to kill, or refuse and log — do not half-apply.

### B-5 (High) — clearing the account detaches the client from its own session

`bounce_get_session()` early-returns on `!IsAccount(cptr)` (`bouncer_session.c:9836`), so after `ClearAccount` the live client is permanently detached from the session while `hs_client` still points at it. The analyst traces the fallout to: no BX N emit and no local-alias rename on a subsequent `/NICK` (both gated on `IsAccount(sptr)`, `s_user.c:1367`/`:1390` — an **invariant #2** breach, alias UIs stuck on the old nick); the legacy-face cleanup and session cleanup at exit both skipped (`s_misc.c:616-627`, `:642`); and `bounce_session_assert_invariant` false-positiving on a live client and defensively nulling `hs_client`, which can leave `bounce_hold_expire` with `ghost == NULL` and an immortal accountless ghost holding a nick.

⚠️ **I did not re-verify the immortal-ghost tail, and the analyst flags it as needing instrumentation.** The tell is `session_invariant[transition.*]: … heap-aliased dangling pointer; nulling defensively` in the logs. Keep it at "instrument, don't size a fix yet"; the observable signature is an accountless client stuck in a channel or a nick that can't be reused.

### B-6 (Medium) — held ghosts are matched with no `IsBouncerHold` gate

The walk gates on `IsUser && IsAccount` and skips only aliases, so a held ghost matches. On the deauth path that runs `ClearAccount` on a ghost that *is* the session's `hs_client` (straight into B-5) and broadcasts an `AC U` that makes every peer destroy all sessions for the account. On the kill path, `exit_client_msg(ghost)` takes the `IsBouncerHold` branch but `FLAG_KILLED` is unset, so `bounce_kill_session` never runs and the session stays HOLDING with the DB record intact — "kill on delete" does not kill the session.

### B-7 — iterator safety: safe today, latent

The loop saves `next = cli_next(cptr)` and the analyst traced every cross-client exit in the teardown chain to a `FLAG_KILLED` gate that `exit_client_msg` never sets (`s_misc.c:357-379`, `:426-430`, `:648-670`, `:690-704`). So **no use-after-free today** — but `add_client_to_list` inserts at the head, so aliases are always walked before their primary, and if anyone ever makes this path set `FLAG_KILLED` (arguably the right fix for B-6) then killing an alias immediately exits the primary — which is the client saved in `next`. The `F-CN2` comment at `s_misc.c:361-371` documents a prior UAF of exactly that shape. ⚠️ Trace passed through as reported; I did not re-walk all four gates.

**Separate pre-existing bug it surfaced (not webhook):** there is a universal sweep for `hs_client` (`bounce_null_hs_client_pointing_at`, from `list.c:556` and `free_client`) but **no equivalent for `cli_user(alias)->alias_primary`**. Any `exit_client_msg` on a primary with aliases where hold is disabled (G-line/K-line enforcement, `bounce_should_hold()` returning NULL) leaves a surviving alias pointing at a recycled struct → UAF at the next alias→primary rewrite (`ircd_relay.c:601/757/856/944`). Worth its own item.

### B-8 (Low) — duplicate `AC U` → DESYNCH wallops

If more than one server runs a webhook listener — and the bed configures all seven — a second `AC U` for the same numeric hits `m_account.c:169-171` → `protocol_violation` → `WALL_DESYNCH`. Non-fatal, but it will look alarming.

### Shape of the fix

**Planned:** `.claude/para/projects/2026-09-22-bouncer-deauth-correctness.md` — 9 TDD tasks covering B-1, B-2, B-3, B-4, B-6 and B-7's `alias_primary` side bug, with B-5 instrumentation-only and B-8 deferred behind the network-kill design decision.

The analyst's recommendation, which I agree with: **express deauth and kill as account/session-level operations, not per-Client loops over `GlobalClientList`.** Concretely — scope the walk to `MyConnect` (kills B-2 and the whole remote-client class); route one shared account-level deauth helper from both the webhook and `ms_account 'U'` so session destroy, metadata clear, local-alias clear and presence/authusers adjustment cannot drift again (B-1 and B-3 exist *because* the logic is duplicated); add the `account` case to the local alias-apply block; skip `IsBouncerHold` clients and tear their session down explicitly; and refuse rather than half-apply under legacy accounts.

**Scope decision for you:** B-1 bites the much-more-common X3 path, so the shared-helper refactor is the correct target rather than patching the webhook copy — but that is a bigger diff than "the webhook is broken" implies. Worth an explicit call before any code.


## CRDT branch delta

`nefarious-crdt` @ `3a1306f` is **identical** to prod for `kc_webhook.c` and `sasl_conf.c`, and differs in `sasl_webhook.c` only by the dual-plane `ci_broadcast()` helper (tree `CI` + one mesh `CR M 'I'` flood, S2S-audit gap B, `2b1283d`). Every finding above applies to both branches unchanged. The CRDT side is strictly ahead here: prod's tree-only `CI` still cannot reach an overlay-only or tree-retired peer, and cannot cross a legacy hop (P2). When the prod fork eventually needs mesh reach, `ci_broadcast` is the shape to cherry-pick.

## Prod cutover checklist

Before a prod Keycloak is pointed at an ircd:

0. **Independent of the webhook, fix B-1 now** — local aliases keep their account on every X3 deauth in prod today.
1. Fix P0-1 (delete/disable subject resolution) and P0-2 (admin reset) — otherwise the feature's security purpose is unmet. **Fix B-2 in the same change**: P0-1 makes the kill walk reachable, and it defaults to on and exits remote clients.
2. Fix P0-3: thread the full `Webhook {}` config through; bind private; TLS or private link; body HMAC + timestamp; realm check; distinct per-consumer secrets.
3. Fix P0-4: `STATS` surface + a loud notice on secret rejection. Do not deploy a silent security subsystem to a host where log-grep is unavailable.
4. Land P1-2 coverage against captured real payloads, red first.
5. Reconcile the secret across `.env`/`.env.local`/`data/ircd.conf` and get one green end-to-end run on the bed.
6. Remove the phantom `x3:9080` endpoint from `.env.local`, add the ircd endpoint to committed `.env`, drop the dead webhook block from `data/x3.conf`, and re-anchor the SPI's payload contract + README from X3 to the ircd.
7. Keep `SCRAM-SHA-256` out of `SASL_LOCAL_MECHANISMS` on prod until P1-5 is resolved.
8. Keep `send-all-events=false` on any realm whose URL list includes an ircd.
9. On the prod realm, verify: `webhook-events` in `eventsListeners`, `adminEventsEnabled` **and** `adminEventsDetailsEnabled` true, and `scramSha256` in `passwordPolicy` only if SCRAM is intended.
