# Webhook plan 5: TLS on the listener — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ircd's webhook listener speaks TLS with the ircd's own certificate, the SPI delivers over `https` and verifies the certificate (a public CA through Java's default trust, a private CA through a PEM bundle it is given), and nothing goes live in plaintext.

**Architecture:** libkc gains a small TLS connection layer over OpenSSL (`kc_tls.c`) that drives the handshake, reads with the pending-data drain, and writes a whole response, reporting what it waits for (read or write) so the existing event adapter can wait on either; the listener uses it per connection when the ircd hands it an `SSL_CTX`. The ircd builds that context from `SSL_CERTFILE` / `SSL_KEYFILE` by default, or from `Webhook { tlscert; tlskey }`, through its existing per-certificate context helper, and swaps it on rehash without dropping the listener. The SPI builds its HTTP client with an SSL context that trusts the JVM's default anchors plus the certificates in an optional PEM bundle (`trust-cert-pem`); hostname verification stays on, so each URL names the host the certificate is issued to. No mutual TLS: the signature already authenticates the SPI.

**Tech Stack:** C with OpenSSL (already linked: the HMAC uses it), CMocka over BIO pairs, the ircd's `ssl.c` context helpers, Java 17 (`javax.net.ssl`), Vitest with `node:https` from the host, the linked bed (primary + leaf, each with its own certificate volume and a network alias equal to its certificate name).

**Spec:** the user's decisions of 2026-09-24: TLS on the listener before going live (reversing plan 3 decision 3); reuse the ircd's certificate by default; a PEM option for private CAs; no mTLS. Register row "TLS on the webhook listener: REQUIRED before going live" in `.claude/para/areas/deferred-items.md`. Feedback `ssl-pending-drain` (drain `SSL_pending` after the handshake and after every read) applies.

## Design

- **D1 The TLS layer (libkc).** `kc_tls_conn` wraps one `SSL` in accept state on a non-blocking fd. `kc_tls_step()` drives `SSL_do_handshake` and returns READY, WANT_READ, WANT_WRITE or ERROR. `kc_tls_read()` returns the bytes available, draining `SSL_pending` into the caller's buffer before it returns, and says what it waits for when nothing is available. `kc_tls_write_all()` writes a whole buffer, resuming from where it stopped when it waited for write. A client that speaks plaintext to a TLS port fails the handshake with an SSL error: ERROR, counted, closed, no crash. A test-only constructor takes read and write BIOs so the suite can drive a client `SSL` over a BIO pair, including a tiny pair buffer that forces WANT_WRITE.
- **D2 The listener.** `kc_webhook_config.tls_ctx` (an `SSL_CTX *`, NULL = plaintext). A connection on a TLS listener steps the handshake on readability (and on writability when the step asked for it, through `socket_update`), then reads requests through the layer and writes the response through it, keeping the connection registered for write until the response is fully written, then closes. `kc_webhook_set_tls_ctx()` swaps the context for new connections on rehash; an `SSL` holds a reference to the context it was made with, so the ircd may free the old context after the swap. Stats: handshakes completed, handshakes failed. The startup line and `STATS webhook` say TLS or plaintext.
- **D3 The ircd's config.** `Webhook { tls = yes; tlscert = "..."; tlskey = "..."; }`. `tls = no` is the default (an explicit go-live requirement, documented). With `tls = yes`, the context comes from `tlscert`/`tlskey` when set, else from `SSL_CERTFILE`/`SSL_KEYFILE`, built through `ssl_create_ctx_for_cert` (its options: no SSLv3/TLSv1 per the features, the configured ciphers, ECDH); a minimum of TLS 1.2 is set explicitly. A context that cannot be built with `tls = yes` is a failed listener start: logged, noticed to opers, `STATS webhook` NOT RUNNING, and no plaintext listener in its place. A rehash that changes only the certificate paths swaps the context and keeps the listener and its counters (like the secret-only path); any other change re-inits as today.
- **D4 The SPI.** Option `trust-cert-pem` (`KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_TRUST_CERT_PEM`): a path to a PEM bundle. When set, the client's `SSLContext` trusts the JVM's default anchors plus every certificate in the bundle; when unset, the default context. Hostname verification is never disabled. Failures to load the bundle are logged and the provider keeps the default trust (a delivery to a private-CA host then fails loudly in the existing retry log).
- **D5 The bed.** Both ircds get a `Webhook {}` block (replacing the deprecated `WEBHOOK_PORT`/`WEBHOOK_SECRET` features in `data/ircd.conf` and `data/ircd2.conf`, edited in place) with `tls = yes`. A script extracts the primary's root certificate and the leaf's self-signed certificate from their volumes into `data/webhook-trust.pem`, bind-mounted read-only into Keycloak at `/opt/keycloak/conf/webhook-trust.pem`; the SPI's URL list becomes `https://testnet.fractalrealities.net:9090/keycloak-webhook,https://leaf.fractalrealities.net:9091/keycloak-webhook` (the compose network aliases already resolve those names). From the host, the test helper posts with `node:https`, connecting to the container IP with `servername` set to the certificate name and `ca` set to the same bundle, so verification runs the way the SPI's does.
- **D6 Rollout.** Per server: set `tls = yes` and rehash, then flip that server's URL to `https` in the SPI's list and restart Keycloak. On prod the certificates are the ircds' public-CA certificates and the URLs name their hosts, so no bundle is needed; a private CA anywhere gets the bundle option. A server whose URL is still `http` while its listener is TLS refuses every delivery (handshake failures in STATS, `attempt N failed` in Keycloak's log), which is the signal to flip the URL.

## Open decisions (mine to propose, the user's to make)

1. **Minimum TLS version** for the listener: TLS 1.2 set explicitly on the context (`SSL_CTX_set_min_proto_version`), whatever the ircd's client-facing features say. Alternative: follow the features only.
2. **Default of `tls`**: no, explicit yes required (the docs say go-live requires it; the bed sets it). Alternative: yes whenever a certificate loads, which would break a plaintext SPI URL silently on upgrade.
3. **The bed confs move to a `Webhook {}` block** (closing the register's bed chore): yes, both confs, in place. Alternative: add `WEBHOOK_TLS` features to the deprecated path too.

## Global Constraints

- `ircd/kc/*.c` and `include/kc/*.h` include only `<kc/...>`, `<openssl/...>`, `<curl/...>`, `<jansson.h>` and system headers in angle form (`make check-kc-boundary`); new kc sources and cmocka programs ride `KC_SRC` / `KC_CMOCKA_TESTPROGS`, the test rule links `$(SSL_LIBS)`.
- `SSL_pending` is drained after the handshake and after every read (feedback `ssl-pending-drain`).
- One vitest process at a time from `tests/`, `IRC_HOST=localhost`; `x3-account-change` needs `X3_AC_CHANGE=1`; never the whole suite. Edit `data/ircd*.conf` and `.env*` in place.
- Deploy: SPI jar through `scripts/dc.sh up -d --force-recreate keycloak-spi-build` then `--force-recreate --no-deps keycloak`; ircds by merging into `bed-deploy`, building BOTH images, recreating both, then waiting for the leaf BY NAME as an oper (it can take ten minutes) and 120 s more before any cross-server suite.
- Commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; nothing is pushed by the executor; the SPI change is a branch on evilnet for a direct push when the user says so.
- Plain, defensive language.

## Review Focus

1. A plaintext HTTP request to the TLS listener must be refused (handshake error), counted, and the connection closed, with no crash and no hang; Task 1 cmocka `test_plaintext_client_fails_the_handshake`, Task 5 bed case "a plaintext post to the TLS listener is refused".
2. A client that stalls mid-handshake must be dropped by the existing slow-client timer, not leak a connection; Task 2 keeps the timer armed from accept to close; Task 5 bed case "a stalled TLS client is dropped".
3. The response must be written in full before the close even when the write path asks to wait; Task 1 cmocka `test_write_all_resumes_after_want_write`, Task 2 keeps the connection until the response is flushed.
4. A rehash that changes only the certificate must not drop the listener or in-flight connections; Task 3 hand check with `REHASH` and `STATS webhook` before and after, a delivery in flight.
5. `tls = yes` without a loadable certificate must leave no plaintext listener up and must be loud; Task 3 bed check with a wrong `tlscert` path.

## File structure

- Create `include/kc/kc_tls.h`, `ircd/kc/kc_tls.c` (the layer; OpenSSL only), `ircd/test/kc_tls_cmocka.c`.
- Modify `include/kc/kc_webhook.h`, `ircd/kc/kc_webhook.c` (`tls_ctx`, per-connection TLS, write-until-flushed, stats, `kc_webhook_set_tls_ctx`).
- Modify `ircd/sasl_conf.c`, `include/sasl_conf.h`, `ircd/ircd_parser.y`, `ircd/ircd_lexer.l` (`tls`, `tlscert`, `tlskey`), `ircd/sasl_webhook.c` (the context build, the startup line, STATS lines), `include/sasl_webhook.h`.
- Modify `configure.in`, `ircd/test/Makefile.in` (the source and the program).
- Modify keycloak-webhook-spi: `WebhookConfig.java`, `WebhookEventListenerProviderFactory.java`, `WebhookEventListenerProvider.java`, new `src/test/java/.../WebhookTrustTest.java`, `README.md`.
- Modify testnet: `data/ircd.conf`, `data/ircd2.conf` (the block), `.env`, `.env.local` (https URLs, the PEM env), `docker-compose.yml` (the bind mount and env), new `scripts/webhook-trust.sh`, `tests/src/helpers/webhook-post.ts` (TLS-aware posting), `tests/src/services/keycloak-webhook-transport.test.ts` (two cases), `FEATURE_FLAGS_CONFIG.md`, the `sasl-keycloak`, `service-debugging`, `test-writing` skills.

---

### Task 1: The TLS connection layer, pure

**Files:** create `include/kc/kc_tls.h`, `ircd/kc/kc_tls.c`, `ircd/test/kc_tls_cmocka.c`; modify `configure.in` (`KC_SRC` += `kc/kc_tls.c`, `KC_CMOCKA_TESTPROGS` += `kc_tls_cmocka`), `ircd/test/Makefile.in` (the program, linked with `$(CMOCKA_LIBS) $(SSL_LIBS)`).

**Interfaces:** Produces

```c
enum kc_tls_state { KC_TLS_READY = 0, KC_TLS_WANT_READ, KC_TLS_WANT_WRITE, KC_TLS_ERROR };

struct kc_tls_conn;                                   /* opaque */
struct kc_tls_conn *kc_tls_accept_fd(SSL_CTX *ctx, int fd);          /* non-blocking fd, accept state */
struct kc_tls_conn *kc_tls_accept_bio(SSL_CTX *ctx, BIO *rbio, BIO *wbio); /* tests: a BIO pair */
enum kc_tls_state   kc_tls_step(struct kc_tls_conn *c);              /* drive the handshake */
int                 kc_tls_handshake_done(const struct kc_tls_conn *c);
/* >0 bytes read (SSL_pending drained into buf up to len); 0 = the peer closed;
 * -1 = nothing now, *want says what to wait for; -2 = error */
int                 kc_tls_read(struct kc_tls_conn *c, void *buf, size_t len, enum kc_tls_state *want);
/* 1 = everything written; 0 = stopped, *want says what to wait for (call again with
 * the same buffer, it resumes at its own offset); -1 = error */
int                 kc_tls_write_all(struct kc_tls_conn *c, const void *buf, size_t len, enum kc_tls_state *want);
void                kc_tls_close(struct kc_tls_conn *c);              /* best-effort shutdown, free */
const char         *kc_tls_last_error(const struct kc_tls_conn *c);   /* for the log line */
```

- [ ] **Step 1: Write the failing tests** in `ircd/test/kc_tls_cmocka.c`. The suite makes a server context with a self-signed EC certificate generated in the test (`EVP_PKEY_Q_keygen`/`X509_sign`, no fixture files), a client context with verification off, and drives both ends over `BIO_new_bio_pair`. Cases: `test_handshake_completes_over_bio_pair` (step both sides until READY, then a client `SSL_write` of a small request is returned whole by one `kc_tls_read`); `test_read_drains_pending_records` (the client writes two records before the server reads: one read returns both); `test_write_all_resumes_after_want_write` (a 64-byte pair buffer, a 4 KB response: `kc_tls_write_all` returns 0 with WANT_WRITE, the client drains, repeated calls finish with 1 and the client receives every byte); `test_plaintext_client_fails_the_handshake` (the client BIO carries `POST / HTTP/1.1\r\n\r\n`: `kc_tls_step` returns ERROR and `kc_tls_last_error` is non-empty); `test_peer_close_is_zero` (client `SSL_shutdown`: the read returns 0).
- [ ] **Step 2: Run to verify RED.** Run: `make -C ircd/test kc_tls_cmocka`. Expected: build fails, the header does not exist.
- [ ] **Step 3: Implement** the layer: `SSL_new` on the context (the `SSL` up-refs it), `SSL_set_accept_state`, `SSL_set_fd` or `SSL_set_bio`; `kc_tls_step` maps `SSL_get_error` to the states; `kc_tls_read` loops `SSL_read` while `SSL_pending()` and space remains; `kc_tls_write_all` keeps `offset` in the struct and uses `SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER` off (the caller passes the same buffer). `kc_tls_close` does one `SSL_shutdown` without waiting.
- [ ] **Step 4: Run to verify GREEN.** Run: `make -C ircd/test kc_tls_cmocka && (cd ircd/test && ./kc_tls_cmocka)`. Expected: 5 tests passed; `make` at the top links; `make -C ircd check-kc-boundary` clean.
- [ ] **Step 5: Commit** `kc: a TLS connection layer for the listener (pure, tested)`.

---

### Task 2: The listener speaks TLS when it is given a context

**Files:** modify `include/kc/kc_webhook.h` (`SSL_CTX *tls_ctx` in the config; `tls_handshakes`, `tls_handshake_failures` in the stats; `void kc_webhook_set_tls_ctx(SSL_CTX *)`; `int kc_webhook_is_tls(void)`), `ircd/kc/kc_webhook.c`.

**Interfaces:** Consumes Task 1. Produces the config field, the setter, the stats, and the behaviour: a TLS connection is stepped on readability and writability, read through the layer, answered through the layer until flushed, then closed; a plaintext connection on a TLS listener is closed after the handshake error and counted.

- [ ] **Step 1: Write the failing bed cases** in `tests/src/services/keycloak-webhook-transport.test.ts` (they stay red until Task 5 turns the bed's listeners on; written here so their shape is fixed): "a plaintext post to the TLS listener is refused" (a plain `http` post to the container IP: the connection is closed without an HTTP response, `STATS webhook` `TLS handshakes failed` grew by one, the listener line says TLS); "a stalled TLS client is dropped" (open a TCP connection to the listener, send one byte of a ClientHello and nothing more, wait 12 s: the socket is closed by the server, `connections active` is back to 0).
- [ ] **Step 2: Implement** in `kc_webhook.c`: `cfg_tls_ctx`; `struct wh_conn` gains `struct kc_tls_conn *tls`, `int tls_ready`, `char *response`, `size_t response_len` (the pending response); `listener_readable` creates the TLS connection when the context is set and registers READ; `conn_readable(fd, events)` first steps the handshake (WANT_WRITE → `socket_update(fd, KC_EVENT_WRITE)`, WANT_READ → READ, ERROR → `tls_handshake_failures++`, log the cause once a minute, close; READY → `tls_handshakes++`), then reads through `kc_tls_read` into the request buffer (the existing size checks apply), then after `process_request` builds the response into `conn->response` and calls a `conn_flush()` that writes through the layer and, on WANT_WRITE, registers WRITE and returns; the write-ready callback flushes again; only a flushed response closes the connection. The plaintext path is unchanged when `cfg_tls_ctx` is NULL. `kc_webhook_set_tls_ctx` swaps `cfg_tls_ctx` (the caller frees the old one). `kc_webhook_init` logs "listening on port %d (TLS)" when set.
- [ ] **Step 3: Build.** Run: `make` and `make -C ircd check-kc-boundary`. Expected: clean; the cmocka suites unchanged (`kc_webhook_sig` 6/6, `webhook_eventlog` 11/11).
- [ ] **Step 4: Commit** `kc: the webhook listener speaks TLS when the ircd hands it a context`.

---

### Task 3: The ircd builds the context; the Webhook block says `tls`

**Files:** modify `ircd/ircd_lexer.l` (`TOKEN(TLS)`, `TOKEN(TLSCERT)`, `TOKEN(TLSKEY)`), `ircd/ircd_parser.y` (`webhooktls: TLS '=' yesorno ';'`, `webhooktlscert: TLSCERT '=' QSTRING ';'`, `webhooktlskey: TLSKEY '=' QSTRING ';'`), `ircd/sasl_conf.c` / `include/sasl_conf.h` (`tls`, `tlscert[SC_PATH_LEN]`, `tlskey[SC_PATH_LEN]` in `webhook_state`, setters, `wh_changed`, the certificate-only rehash path), `ircd/sasl_webhook.c` / `include/sasl_webhook.h` (`sasl_webhook_init` builds the context: `ssl_create_ctx_for_cert(cert ? cert : feature_str(FEAT_SSL_CERTFILE), key ? key : feature_str(FEAT_SSL_KEYFILE))`, sets `SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION)`, keeps the context in a static and frees the previous after the swap; the startup line says "TLS" or "PLAINTEXT"; the STATS listener line says which and a line `TLS: N handshakes, N failed`), `FEATURE_FLAGS_CONFIG.md` (the three items; `tls = yes` required for go-live).

**Interfaces:** Consumes Task 2's `tls_ctx`, `kc_webhook_set_tls_ctx`, `kc_webhook_is_tls`, the stats. `ssl_create_ctx_for_cert` is in `ircd/ssl.c` and logs its failures with an "SNI:" prefix; a thin wrapper here logs the webhook's own line.

- [ ] **Step 1: Write the failing check** as a bed script `scripts/webhook-tls-check.sh` (kept as a diagnostic, not a test): reads `STATS webhook` from the oper, prints the listener line; run it. Expected: the line has no TLS word (red).
- [ ] **Step 2: Implement** the tokens, the productions, the state and setters, `wh_changed`, the certificate-only rehash (only `tlscert`/`tlskey` differ, `tls` on both sides: build the new context, `kc_webhook_set_tls_ctx`, free the old, log "certificate changed; listener and counters kept"), the init path (`tls = yes` and the context fails to build: the failed-start path of plan 3, no plaintext fallback), the lines.
- [ ] **Step 3: Build and the cmocka suites.** Run: `make`, `make -C ircd check-kc-boundary`, the three suites. Expected: clean, green. Also a `--disable-keycloak` build in a scratch worktree links (the block's items parse in both variants).
- [ ] **Step 4: Commit** `webhook: the Webhook block's tls, tlscert and tlskey; the ircd builds the listener's TLS context and swaps it on rehash`.

---

### Task 4: The SPI trusts a PEM bundle beside the JVM's defaults

**Files:** modify `WebhookConfig.java` (`trustCertPem`), `WebhookEventListenerProviderFactory.java` (`configScope.get("trust-cert-pem")`, env `WEBHOOK_TRUST_CERT_PEM` fallback like the others), `WebhookEventListenerProvider.java` (a static `SSLContext trustContext(String pemPath)`: the default `TrustManagerFactory` anchors plus the bundle's certificates in one `KeyStore`, or the default context when the path is null; `HttpClient.newBuilder().sslContext(...)`); create `src/test/java/net/afternet/keycloak/webhook/WebhookTrustTest.java`; modify `README.md`.

**Interfaces:** Produces `WebhookConfig.getTrustCertPem()` and `static SSLContext WebhookEventListenerProvider.trustContext(String pemPath) throws Exception` (package-private for the test).

- [ ] **Step 1: Write the failing tests**: `WebhookTrustTest`: `bundleCertificatesAreTrusted` (a self-signed certificate generated in the test, written to a temp PEM: the context's trust manager accepts it as a trusted anchor, `checkServerTrusted` passes), `defaultAnchorsStillTrusted` (the context still holds the JVM's default anchors: `getAcceptedIssuers().length` is larger than the bundle's count), `garbageBundleFails` (a file with no certificate: `trustContext` throws).
- [ ] **Step 2: Run to verify RED.** Run: `docker run --rm -v "$PWD":/src -w /src -v spi-m2:/root/.m2 maven:3.9-eclipse-temurin-17 mvn -o -B -q test`. Expected: compile failure, no `trustContext`.
- [ ] **Step 3: Implement.** Run to verify GREEN: the same command, all tests pass (the signature test too).
- [ ] **Step 4: Commit** `spi: an optional PEM bundle of trusted certificates for https deliveries`.

---

### Task 5: The bed goes TLS: confs, trust bundle, URLs, helper, deploy, green

**Files:** modify `data/ircd.conf`, `data/ircd2.conf` (in place: replace `"WEBHOOK_PORT"`/`"WEBHOOK_SECRET"` with a `Webhook { port; secret; vhost = ""; tls = yes; }` block, ports 9090 and 9091), `.env`, `.env.local` (`https://testnet.fractalrealities.net:9090/keycloak-webhook,https://leaf.fractalrealities.net:9091/keycloak-webhook` and `KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_TRUST_CERT_PEM=/opt/keycloak/conf/webhook-trust.pem`), `docker-compose.yml` (keycloak: `- ./data/webhook-trust.pem:/opt/keycloak/conf/webhook-trust.pem:ro` and the env passthrough), create `scripts/webhook-trust.sh` (extracts the LAST certificate block of the primary's `ircd.pem` and the only block of the leaf's, through `docker exec`, into `data/webhook-trust.pem`; idempotent; printed fingerprints), modify `tests/src/helpers/webhook-post.ts` (`webhookEndpoint` reads the block form too, `tls: yes` → post with `node:https`, `servername` = the target's server name, `ca` = `data/webhook-trust.pem`, connecting to the container IP), the transport suite (Task 2's two cases turn green).

- [ ] **Step 1: Run to verify RED**: `keycloak-webhook-transport` on the current bed: the two TLS cases fail (no TLS listener), the rest pass.
- [ ] **Step 2: Bed plumbing**: the two confs in place; `scripts/webhook-trust.sh` run; the compose mount and env; `.env`/`.env.local`; `scripts/dc.sh up -d --force-recreate keycloak-spi-build` (Task 4's jar), `scripts/dc.sh up -d --force-recreate --no-deps keycloak`; `docker exec keycloak sh -c 'echo $KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_TRUST_CERT_PEM; head -1 /opt/keycloak/conf/webhook-trust.pem'` shows both.
- [ ] **Step 3: Deploy the ircds** (merge into `bed-deploy`, build both, recreate both, wait for the leaf by name, 120 s); `docker logs nefarious | grep 'webhook listener'` says TLS.
- [ ] **Step 4: Run to verify GREEN**: transport (11/11 with the two TLS cases), fan-out 8/8 (all posts now over `https`), e2e 3/3 (the SPI delivering over `https` to both), bouncer-deauth local-alias 2/2 and cross-server 3/3, x3-account-change 2/2, sasl-reauth 4/4. Expected: all green; Keycloak's log has no `attempt N failed` for the https URLs.
- [ ] **Step 5: Hand checks (Review Focus 4 and 5)**: change only `tlscert` in `data/ircd.conf` to a copy of the same file and `REHASH`: `STATS webhook` counters intact, "certificate changed; listener and counters kept" logged, a signed post 200; then a wrong path and `REHASH`: the listener is NOT RUNNING, the notice fired, a post is refused (connection refused, no plaintext); revert and `REHASH`.
- [ ] **Step 6: Commit** `bed: the webhook listeners speak TLS; the SPI delivers over https with the bed's trust bundle`.

---

### Task 6: Docs and the rollout rule

**Files:** `FEATURE_FLAGS_CONFIG.md` (the `Webhook {}` block gains `tls`, `tlscert`, `tlskey`; the posture paragraph is rewritten: TLS required for go-live, the certificate defaults, the rehash rule, the SPI's `trust-cert-pem`, the per-server flip order, the "plaintext post refused" signal), `P10_PROTOCOL_REFERENCE.md` unchanged, the SPI `README.md` (the option and the URL form), the `sasl-keycloak`, `service-debugging` (the TLS lines under STATS, the trust script, the alias hostnames), `test-writing` (the TLS-aware helper) skills; the register (strike the TLS row; the bed-confs-to-block row closes).

- [ ] **Step 1:** Write the docs as listed. Expected: `FEATURE_FLAGS_CONFIG.md` example block parses as written (`tls = yes;`).
- [ ] **Step 2: Commit** `docs: TLS on the webhook listener, the trust bundle, the rollout order`.

---

## Self-review

**1. Spec coverage.** TLS on the listener before go-live (Tasks 1-3, 5); reuse the ircd's certificate by default with overrides (Task 3); the PEM option for private CAs (Task 4), used by the bed (Task 5); no mTLS (design); the rollout order (Task 6).

**2. Placeholder scan.** Every code step names its functions, states and tests; the bed steps carry their commands and expected observables.

**3. Type consistency.** `kc_tls_conn` and the four state values in Tasks 1 and 2; `tls_ctx` / `kc_webhook_set_tls_ctx` / `kc_webhook_is_tls` in Tasks 2 and 3; `trustContext(String)` in Task 4 only; the URL and env names in Tasks 5 and 6.

**4. Review focus.** 1 → Task 1 cmocka + Task 5 bed; 2 → Task 5 bed; 3 → Task 1 cmocka + Task 2's flush; 4 and 5 → Task 5 hand checks.

**To verify at execution time:** whether `ssl_create_ctx_for_cert` is usable from `sasl_webhook.c` without pulling `ssl.c`'s SNI logging (else a sibling helper in `ssl.c`); whether the bed's `IsIRCv3Aware`/`Webhook` block parsing has a `VHOST` token already (yes, plan 3); whether Keycloak 26 sets a default `SSLContext` from `--truststore-paths` (if so the bundle option is still the explicit path, and the README says either works); whether `node:https` from the host verifies the leaf's self-signed certificate with `ca` set to it (a self-signed leaf is its own anchor); the leaf's certificate CN is `leaf.fractalrealities.net` (compose line 129 uses `IRCD_GENERAL_NAME`).
