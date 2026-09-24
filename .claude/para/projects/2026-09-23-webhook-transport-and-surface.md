# Webhook plan 3: transport, replay, realm, and an operator surface (P0-3, P0-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A webhook event acts on the ircd only when it was signed by the SPI with the shared secret, is fresh, is not a replay, and comes from the ircd's own realm; the `Webhook {}` config is honoured in full; an oper can see the listener's health with `STATS webhook` and hears about rejections.

**Architecture:** The SPI signs every payload (HMAC-SHA256 over `<t>.<body>` with the shared secret, sent as `X-Webhook-Signature: t=<unix>,v1=<hex>`) and adds `realmName`. A small pure module in libkc (`kc_webhook_sig.c`) verifies the signature within a time window and keeps a ring of recent event ids to refuse replays; `kc_webhook.c` calls it before queueing, checks `realmName` against the configured realm before dispatch, counts every rejection by cause, and tells the ircd through a callback. The ircd threads the whole `Webhook {}` block into libkc (today only port and secret survive), adds three items (`signaturewindow`, `legacysecret`, `realm`), reports both counter sets under `STATS webhook`, and raises a rate-limited server notice on rejections. Plan 2's subject decision also validates the payload's `username` before it reaches the wire.

**Tech Stack:** C (nefarious fork; libkc vendored in `ircd/kc/`, OpenSSL HMAC already linked), CMocka, Vitest, Java 17 (keycloak-webhook-spi, JUnit 5 present in the pom), Keycloak 26.4.7.

**Spec:** `.claude/para/projects/keycloak-webhook-audit-2026-09.md`, findings P0-3 and P0-4, plus P2 "untrusted username", "rehash churn", "setup-keycloak.sh short-circuit", and cutover items 2, 3 and 6. The transport rows of `.claude/para/areas/deferred-items.md` are closed by this plan.

## Open decisions (mine to propose, the user's to make)

1. **Signature scheme.** `X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>`; accepted when `|now - t| <= signaturewindow` (default 300 s); the event `id` is remembered for the window and a second copy is refused. The secret is the existing shared one. Alternative: a separate signing key (`Webhook { signingsecret }`) so the header secret can be retired independently.
2. **Rollout.** The SPI keeps sending `X-Webhook-Secret` and adds the signature; the ircd requires the signature whenever a secret is configured, unless `Webhook { legacysecret = yes; }` (default no). Deploy the SPI first on prod, then the ircd; on the bed both go together. The switch is a default-off safety for the minutes between those two deploys, nothing more: prod has no legacy peers (the user, 2026-09-23: the only legacy peers are on the test bed), so the `CI *` relay through a pre-branch peer and every other "legacy hop" concern in this plan applies to the bed alone.
3. **TLS.** Not built into libkc's listener here: the posture is a private link (bind `vhost` to the private interface, which the config threading makes real) plus the signature. TLS on the listener stays a deferred item with the requirement written down.
4. **Realm.** The check keys on the Keycloak block's `realm` by default, overridable with `Webhook { realm = "..."; }`; a payload whose `realmName` differs is refused (403); a payload without one (an old SPI) is accepted and counted, so the transition does not go dark. Alternative: refuse payloads without `realmName` too, once the SPI is deployed everywhere.
5. **Secret rename.** `x3-webhook-secret` is renamed to `ircd-webhook-secret` in the seven bed ircd confs, `.env`, `.env.local` and the SPI env; the dead `keycloak_webhook_*` block leaves `data/x3.conf`. Cosmetic, ten files, one commit. Alternative: leave the name.
6. **Notice channel.** Rejections go to `SNO_UNAUTH` ("unauthorized connections"), at most one notice per cause per 60 s, with the count since boot. Alternative: a new snomask bit.

## Global Constraints

- `ircd/kc/*.c` includes no ircd header (`make check-kc-boundary`); the ircd talks to libkc through `struct kc_webhook_config` and callbacks. New kc sources and cmocka programs ride configure's `KC_SRC` / `KC_CMOCKA_TESTPROGS` (plan 2, Important 3), and `configure` is regenerated with `configure.in`.
- Constant-time comparison for anything secret (`CRYPTO_memcmp`, as the existing secret check does).
- Every rejection is counted by cause and reported; nothing about a rejection is silent.
- The synthetic-event tests of plans 1 and 2 keep working: `tests/src/helpers/webhook-post.ts` becomes the one place that signs.
- One vitest process at a time from `tests/`, `IRC_HOST=localhost`; never the whole suite.
- Deploy: SPI jar through `scripts/dc.sh up -d --force-recreate keycloak-spi-build` then `scripts/dc.sh up -d --force-recreate --no-deps keycloak` (memory `keycloak-spi-stale-build`); ircds by merging into `bed-deploy`, building BOTH images, recreating both, waiting for X3 and the leaf.
- Commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; nothing is pushed; the SPI change is a branch for the user's PR (its only remote is evilnet).
- Plain, defensive language.

## Review Focus

1. A request signed with the right secret but a timestamp outside the window must be refused (401 "stale"), counted, and noticed; Task 2 cmocka `test_stale_timestamp_is_refused`, Task 6 bed case "stale".
2. The same signed request delivered twice within the window must be refused the second time (replay), even though its signature is valid; Task 2 `test_replay_is_refused`, Task 6 bed case "replay".
3. A payload from another realm with a valid signature must not act; Task 2 has no realm (transport-agnostic), Task 6 bed case "wrong realm" asserts 403 and no deauth.
4. A `username` in a payload that is longer than `ACCOUNTLEN` or contains a space, colon or control character must never reach `CI` or the deauth walk; Task 4 cmocka `test_bad_username_is_dropped`.
5. A rehash that changes only the secret must not drop the listener or reset the counters; Task 3 bed check with `REHASH` and `STATS webhook` before and after.

## File structure

- Create `ircd/kc/kc_webhook_sig.c`, `include/kc/kc_webhook_sig.h` -- signature parse/verify and the replay ring; pure (OpenSSL only).
- Create `ircd/test/kc_webhook_sig_cmocka.c` -- vectors, window, replay ring.
- Modify `include/kc/kc_webhook.h`, `ircd/kc/kc_webhook.c` -- config items (`signature_window`, `legacy_secret`, `realm_name`, `on_reject`, `reject_data`), signature and realm checks, counters, no stats reset on re-init.
- Modify `ircd/sasl_conf.c`, `include/sasl_conf.h`, `ircd/ircd_parser.y`, `ircd/ircd_lexer.l` -- three new Webhook items, realm accessor, full config threading, secret-only rehash.
- Modify `ircd/sasl_webhook.c`, `include/sasl_webhook.h` -- `sasl_webhook_init(const struct kc_webhook_config *)`, reject notice, `sasl_webhook_report_stats`, counters.
- Modify `ircd/s_stats.c` -- the `webhook` entry.
- Modify `ircd/webhook_subject.c`, `ircd/test/webhook_subject_cmocka.c` -- username validation.
- Modify `configure.in`, `ircd/test/Makefile.in` -- the new kc source and cmocka program.
- Modify `keycloak-webhook-spi`: `WebhookEventListenerProvider.java` (signature, `realmName`), `WebhookConfig.java` (nothing new unless decision 1's alternative), new `src/test/java/.../WebhookSignatureTest.java`, README.
- Modify `tests/src/helpers/webhook-post.ts` (signs), create `tests/src/services/keycloak-webhook-transport.test.ts`.
- Modify `scripts/setup-keycloak.sh` (admin-events writes always), bed confs and env (decision 5), `data/x3.conf`.

---

### Task 1: The SPI signs and names the realm

**Files:**
- Modify: `keycloak-webhook-spi/src/main/java/net/afternet/keycloak/webhook/WebhookEventListenerProvider.java` (`formatAdminEvent`, `formatUserEvent`, `sendWebhook`)
- Create: `keycloak-webhook-spi/src/test/java/net/afternet/keycloak/webhook/WebhookSignatureTest.java`
- Modify: `keycloak-webhook-spi/README.md`

**Interfaces:**
- Produces: header `X-Webhook-Signature: t=<unix seconds>,v1=<lowercase hex HMAC-SHA256(secret, t + "." + body)>` on every delivery (beside the existing `X-Webhook-Secret`); `"realmName": "<realm name>"` on every admin and user payload; `static String sign(String secret, long t, String body)` (package-private, for the test).

- [ ] **Step 1: Write the failing JUnit test**

```java
package net.afternet.keycloak.webhook;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class WebhookSignatureTest {
    /* Vector shared with the ircd's cmocka suite (kc_webhook_sig_cmocka.c). */
    static final String SECRET = "x3-webhook-secret";
    static final long T = 1790200000L;
    static final String BODY = "{\"id\":\"e1\",\"resourceType\":\"USER\",\"operationType\":\"DELETE\","
        + "\"resourcePath\":\"users/0b4a2f0e-1d4c-4c4a-9a1e-000000000001\",\"realmName\":\"testnet\"}";

    @Test
    void signsTimestampDotBodyWithHmacSha256() {
        assertEquals("b8eb25dedf41b9e88b658f97537f5ec2cce9dcbd7c1915edbaf01e1b5e15e4f6",
            WebhookEventListenerProvider.sign(SECRET, T, BODY));
    }

    @Test
    void headerValueCarriesTimestampAndVersionedDigest() {
        assertEquals("t=1790200000,v1=b8eb25dedf41b9e88b658f97537f5ec2cce9dcbd7c1915edbaf01e1b5e15e4f6",
            WebhookEventListenerProvider.signatureHeader(SECRET, T, BODY));
    }
}
```

- [ ] **Step 2: Run it red** (maven in the builder image; the host has no maven)

Run: `cd /home/ibutsu/testnet/keycloak-webhook-spi && docker run --rm -v "$PWD":/src -w /src maven:3.9-eclipse-temurin-17 mvn -q -o test 2>&1 | tail -15 || docker run --rm -v "$PWD":/src -w /src maven:3.9-eclipse-temurin-17 mvn -q test 2>&1 | tail -15`
Expected: compilation error, `sign` and `signatureHeader` undefined.

- [ ] **Step 3: Sign, and name the realm**

In `WebhookEventListenerProvider.java` add (imports `javax.crypto.Mac`, `javax.crypto.spec.SecretKeySpec`, `java.nio.charset.StandardCharsets`, `java.time.Instant`, `org.keycloak.models.RealmModel`):

```java
    /** HMAC-SHA256 over "<t>.<body>", lowercase hex; the ircd verifies the same. */
    static String sign(String secret, long t, String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] d = mac.doFinal((t + "." + body).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }

    static String signatureHeader(String secret, long t, String body) {
        return "t=" + t + ",v1=" + sign(secret, t, body);
    }

    /** The realm's name (events carry only its uuid); null when unknown. */
    private String realmName(String realmId) {
        try {
            RealmModel realm = session.realms().getRealm(realmId);
            return realm == null ? null : realm.getName();
        } catch (Exception e) {
            return null;
        }
    }
```

In `formatAdminEvent` and `formatUserEvent`, right after `json.addProperty("realmId", ...)`: `String rn = realmName(event.getRealmId()); if (rn != null) json.addProperty("realmName", rn);`.

In `sendWebhook`, inside the `if (config.getWebhookSecret() != null ...)` block, after the `X-Webhook-Secret` header:

```java
            requestBuilder.header("X-Webhook-Signature",
                signatureHeader(config.getWebhookSecret(), Instant.now().getEpochSecond(), payload));
```

README: under "Consumer contract", add "Every delivery carries `X-Webhook-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256 over `<t>.<body>` with the shared secret) and `realmName`; the ircd refuses unsigned, stale, replayed or other-realm events."

- [ ] **Step 4: Green, then build the jar**

Run: the Step 2 command. Expected: `Tests run: 2, Failures: 0`.
Run: `cd /home/ibutsu/testnet && scripts/dc.sh up -d --force-recreate keycloak-spi-build && docker logs keycloak-spi-build 2>&1 | tail -1`
Expected: `Webhook SPI JAR built and copied to providers`.

- [ ] **Step 5: Commit** (branch `feature/signed-events` off `origin/main` in a worktree, as plan 2's docs branch)

```
spi: sign every delivery and name the realm

X-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>
beside the existing secret header, and realmName on every payload.  The
ircd refuses unsigned, stale, replayed and other-realm events from now
on; the plain header alone is accepted only during its transition.
```

---

### Task 2: Signature verification and the replay ring, pure

**Files:**
- Create: `include/kc/kc_webhook_sig.h`, `ircd/kc/kc_webhook_sig.c`, `ircd/test/kc_webhook_sig_cmocka.c`
- Modify: `configure.in` (`KC_SRC` += `kc/kc_webhook_sig.c`; `KC_CMOCKA_TESTPROGS` += `kc_webhook_sig_cmocka`), `ircd/test/Makefile.in` (program rule), `configure` regenerated

**Interfaces:**
- Produces:
  ```c
  enum kc_sig_result { KC_SIG_OK = 0, KC_SIG_MISSING, KC_SIG_MALFORMED, KC_SIG_STALE, KC_SIG_MISMATCH };
  enum kc_sig_result kc_webhook_sig_verify(const char *secret, const char *header,
                                           const char *body, size_t body_len,
                                           long long now, int window_s, long long *t_out);
  const char *kc_sig_result_name(enum kc_sig_result r);   /* "ok" "missing" "malformed" "stale" "mismatch" */
  #define KC_REPLAY_RING 256
  struct kc_replay_ring { char id[KC_REPLAY_RING][40]; long long t[KC_REPLAY_RING]; int next; };
  void kc_replay_ring_init(struct kc_replay_ring *r);
  /* 1 when id was seen within window_s of now (a replay), else remembers it and returns 0 */
  int  kc_replay_ring_seen(struct kc_replay_ring *r, const char *id, long long now, int window_s);
  ```

- [ ] **Step 1: Write the failing test**

```c
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <string.h>
#include <cmocka.h>
#include "../../include/kc/kc_webhook_sig.h"

/* Shared with the SPI's WebhookSignatureTest. */
#define SECRET "x3-webhook-secret"
#define T      1790200000LL
#define BODY   "{\"id\":\"e1\",\"resourceType\":\"USER\",\"operationType\":\"DELETE\"," \
               "\"resourcePath\":\"users/0b4a2f0e-1d4c-4c4a-9a1e-000000000001\",\"realmName\":\"testnet\"}"
#define GOOD   "t=1790200000,v1=b8eb25dedf41b9e88b658f97537f5ec2cce9dcbd7c1915edbaf01e1b5e15e4f6"
#define OTHER  "t=1790200000,v1=c527185925ca061a29c6a9fa7c2a8488537f282486af4ccb550cca49a8dacf95"

static void test_good_signature_within_window(void **s)
{
  long long t = 0; (void)s;
  assert_int_equal(kc_webhook_sig_verify(SECRET, GOOD, BODY, strlen(BODY), T + 10, 300, &t), KC_SIG_OK);
  assert_true(t == T);
  assert_int_equal(kc_webhook_sig_verify(SECRET, GOOD, BODY, strlen(BODY), T - 299, 300, NULL), KC_SIG_OK);
}

static void test_stale_timestamp_is_refused(void **s)
{
  (void)s;   /* Review focus 1 */
  assert_int_equal(kc_webhook_sig_verify(SECRET, GOOD, BODY, strlen(BODY), T + 301, 300, NULL), KC_SIG_STALE);
  assert_int_equal(kc_webhook_sig_verify(SECRET, GOOD, BODY, strlen(BODY), T - 301, 300, NULL), KC_SIG_STALE);
}

static void test_wrong_secret_body_or_shape(void **s)
{
  (void)s;
  assert_int_equal(kc_webhook_sig_verify("another", GOOD, BODY, strlen(BODY), T, 300, NULL), KC_SIG_MISMATCH);
  assert_int_equal(kc_webhook_sig_verify(SECRET, OTHER, BODY, strlen(BODY), T, 300, NULL), KC_SIG_MISMATCH);
  assert_int_equal(kc_webhook_sig_verify(SECRET, GOOD, BODY "x", strlen(BODY) + 1, T, 300, NULL), KC_SIG_MISMATCH);
  assert_int_equal(kc_webhook_sig_verify(SECRET, NULL, BODY, strlen(BODY), T, 300, NULL), KC_SIG_MISSING);
  assert_int_equal(kc_webhook_sig_verify(SECRET, "", BODY, strlen(BODY), T, 300, NULL), KC_SIG_MISSING);
  assert_int_equal(kc_webhook_sig_verify(SECRET, "v1=b8eb", BODY, strlen(BODY), T, 300, NULL), KC_SIG_MALFORMED);
  assert_int_equal(kc_webhook_sig_verify(SECRET, "t=1790200000,v1=zz", BODY, strlen(BODY), T, 300, NULL), KC_SIG_MALFORMED);
  assert_int_equal(kc_webhook_sig_verify(SECRET, "t=abc,v1=b8eb25dedf41b9e88b658f97537f5ec2cce9dcbd7c1915edbaf01e1b5e15e4f6", BODY, strlen(BODY), T, 300, NULL), KC_SIG_MALFORMED);
  assert_string_equal(kc_sig_result_name(KC_SIG_STALE), "stale");
}

static void test_replay_is_refused(void **s)
{
  struct kc_replay_ring r; int i; char id[40]; (void)s;   /* Review focus 2 */
  kc_replay_ring_init(&r);
  assert_int_equal(kc_replay_ring_seen(&r, "e1", T, 300), 0);
  assert_int_equal(kc_replay_ring_seen(&r, "e1", T + 5, 300), 1);
  assert_int_equal(kc_replay_ring_seen(&r, "e2", T + 5, 300), 0);
  assert_int_equal(kc_replay_ring_seen(&r, "e1", T + 400, 300), 0);   /* outside the window: not a replay */
  for (i = 0; i < KC_REPLAY_RING + 5; i++) { snprintf(id, sizeof(id), "x%d", i); kc_replay_ring_seen(&r, id, T, 300); }
  assert_int_equal(kc_replay_ring_seen(&r, "x0", T, 300), 0);         /* evicted, remembered again */
  assert_int_equal(kc_replay_ring_seen(&r, "x0", T, 300), 1);
  assert_int_equal(kc_replay_ring_seen(&r, NULL, T, 300), 0);
}

int main(void)
{
  const struct CMUnitTest tests[] = {
    cmocka_unit_test(test_good_signature_within_window),
    cmocka_unit_test(test_stale_timestamp_is_refused),
    cmocka_unit_test(test_wrong_secret_body_or_shape),
    cmocka_unit_test(test_replay_is_refused),
  };
  return cmocka_run_group_tests(tests, NULL, NULL);
}
```
(`#include <stdio.h>` for `snprintf`.)

- [ ] **Step 2: Wire the build and run red**

`configure.in`: append ` kc/kc_webhook_sig.c` to `KC_SRC` and ` kc_webhook_sig_cmocka` to `KC_CMOCKA_TESTPROGS`. `ircd/test/Makefile.in`, after the `webhook_subject_cmocka` rule:

```make
# kc_webhook_sig tests - signature verification and the replay ring (pure, OpenSSL)
KC_WEBHOOK_SIG_CMOCKA_OBJS = kc_webhook_sig_cmocka.o ../kc/kc_webhook_sig.o
kc_webhook_sig_cmocka: $(KC_WEBHOOK_SIG_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(KC_WEBHOOK_SIG_CMOCKA_OBJS) $(CMOCKA_LIBS) $(SSL_LIBS)
```
and `kc_webhook_sig_cmocka.c \` in the source list. Then `autoreconf -fi && ./configure <the usual flags> && make -C ircd/test kc_webhook_sig_cmocka 2>&1 | grep -m1 error`.
Expected: `fatal error: ../../include/kc/kc_webhook_sig.h: No such file or directory`.

- [ ] **Step 3: Write the module**

`include/kc/kc_webhook_sig.h`:

```c
/*
 * kc_webhook_sig.h - signature check and replay ring for the webhook listener.
 *
 * The SPI signs every delivery: X-Webhook-Signature: t=<unix>,v1=<hex
 * HMAC-SHA256(secret, "<t>." + body)>.  Verify in constant time, within a
 * window, and remember event ids for the window so a captured request cannot
 * be played back.  Pure: OpenSSL only, no ircd or libkc transport headers.
 */
#ifndef KC_WEBHOOK_SIG_H
#define KC_WEBHOOK_SIG_H
#include <stddef.h>

enum kc_sig_result { KC_SIG_OK = 0, KC_SIG_MISSING, KC_SIG_MALFORMED, KC_SIG_STALE, KC_SIG_MISMATCH };

enum kc_sig_result kc_webhook_sig_verify(const char *secret, const char *header,
                                         const char *body, size_t body_len,
                                         long long now, int window_s, long long *t_out);
const char *kc_sig_result_name(enum kc_sig_result r);

#define KC_REPLAY_RING 256
struct kc_replay_ring {
    char      id[KC_REPLAY_RING][40];
    long long t[KC_REPLAY_RING];
    int       next;
};
void kc_replay_ring_init(struct kc_replay_ring *r);
/* 1 = id seen within window_s of now (a replay).  0 = new; remembered. */
int  kc_replay_ring_seen(struct kc_replay_ring *r, const char *id, long long now, int window_s);
#endif
```

`ircd/kc/kc_webhook_sig.c`:

```c
#include "kc/kc_webhook_sig.h"
#include <openssl/hmac.h>
#include <openssl/crypto.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdio.h>

static int hexval(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

enum kc_sig_result kc_webhook_sig_verify(const char *secret, const char *header,
                                         const char *body, size_t body_len,
                                         long long now, int window_s, long long *t_out)
{
    const char *p, *v;
    char tbuf[24];
    size_t i, tl;
    long long t;
    unsigned char given[32], mac[32];
    unsigned int mac_len = 0;
    HMAC_CTX *ctx;

    if (!secret || !secret[0]) return KC_SIG_MISMATCH;
    if (!header || !header[0]) return KC_SIG_MISSING;
    if (strncmp(header, "t=", 2) != 0) return KC_SIG_MALFORMED;
    p = header + 2;
    for (tl = 0; p[tl] && p[tl] != ','; tl++)
        if (!isdigit((unsigned char)p[tl]) || tl >= sizeof(tbuf) - 1) return KC_SIG_MALFORMED;
    if (tl == 0 || p[tl] != ',') return KC_SIG_MALFORMED;
    memcpy(tbuf, p, tl); tbuf[tl] = '\0';
    t = strtoll(tbuf, NULL, 10);
    v = p + tl + 1;
    if (strncmp(v, "v1=", 3) != 0) return KC_SIG_MALFORMED;
    v += 3;
    if (strlen(v) != 64) return KC_SIG_MALFORMED;
    for (i = 0; i < 32; i++) {
        int hi = hexval(v[2 * i]), lo = hexval(v[2 * i + 1]);
        if (hi < 0 || lo < 0) return KC_SIG_MALFORMED;
        given[i] = (unsigned char)(hi * 16 + lo);
    }
    if (window_s > 0 && (now - t > window_s || t - now > window_s)) return KC_SIG_STALE;

    ctx = HMAC_CTX_new();
    if (!ctx) return KC_SIG_MISMATCH;
    if (HMAC_Init_ex(ctx, secret, (int)strlen(secret), EVP_sha256(), NULL) != 1
        || HMAC_Update(ctx, (const unsigned char *)tbuf, tl) != 1
        || HMAC_Update(ctx, (const unsigned char *)".", 1) != 1
        || HMAC_Update(ctx, (const unsigned char *)body, body_len) != 1
        || HMAC_Final(ctx, mac, &mac_len) != 1) {
        HMAC_CTX_free(ctx);
        return KC_SIG_MISMATCH;
    }
    HMAC_CTX_free(ctx);
    if (mac_len != 32 || CRYPTO_memcmp(mac, given, 32) != 0) return KC_SIG_MISMATCH;
    if (t_out) *t_out = t;
    return KC_SIG_OK;
}

const char *kc_sig_result_name(enum kc_sig_result r)
{
    switch (r) {
    case KC_SIG_OK: return "ok";
    case KC_SIG_MISSING: return "missing";
    case KC_SIG_MALFORMED: return "malformed";
    case KC_SIG_STALE: return "stale";
    case KC_SIG_MISMATCH: default: return "mismatch";
    }
}

void kc_replay_ring_init(struct kc_replay_ring *r)
{
    memset(r, 0, sizeof(*r));
}

int kc_replay_ring_seen(struct kc_replay_ring *r, const char *id, long long now, int window_s)
{
    int i;
    if (!r || !id || !id[0]) return 0;
    for (i = 0; i < KC_REPLAY_RING; i++) {
        if (r->id[i][0] && strcmp(r->id[i], id) == 0) {
            if (window_s <= 0 || (now - r->t[i] <= window_s && r->t[i] - now <= window_s))
                return 1;
            break;              /* an old sighting: remember afresh below */
        }
    }
    snprintf(r->id[r->next], sizeof(r->id[r->next]), "%s", id);
    r->t[r->next] = now;
    r->next = (r->next + 1) % KC_REPLAY_RING;
    return 0;
}
```
(Verify the timestamp digits BEFORE the HMAC so a garbage header never reaches the key; the stale check comes before the HMAC too -- a stale request is cheap to refuse.)

- [ ] **Step 4: Green**

Run: `make -C ircd/test kc_webhook_sig_cmocka && (cd ircd/test && ./kc_webhook_sig_cmocka); echo rc=$?; make -C ircd check-kc-boundary`
Expected: 4 tests PASSED, rc=0, boundary clean (the file includes only `kc/` and OpenSSL headers; add it to the guard's allow-list if the guard names files explicitly -- read `ircd/Makefile.in`'s `KC_BOUNDARY_FILES`).

- [ ] **Step 5: Commit** -- `kc: verify the webhook signature and refuse replays (pure, tested)`.

---

### Task 3: The listener enforces it, and the ircd's config reaches it

**Files:**
- Modify: `include/kc/kc_webhook.h` (config + stats), `ircd/kc/kc_webhook.c` (header parse, checks, callback, counters, no stats reset), `include/sasl_webhook.h`, `ircd/sasl_webhook.c` (`sasl_webhook_init(const struct kc_webhook_config *)`, reject callback, counters), `ircd/sasl_conf.c`, `include/sasl_conf.h`, `ircd/ircd_parser.y`, `ircd/ircd_lexer.l` (items `signaturewindow`, `legacysecret`, `realm`; realm accessor; secret-only rehash)

**Interfaces:**
- Consumes: Task 2's verify and ring.
- Produces: `struct kc_webhook_config` gains `int signature_window; int legacy_secret; const char *realm_name; void (*on_reject)(const char *peer, const char *cause, void *data); void *reject_data;`; `struct kc_webhook_stats` gains `events_rejected_auth, events_rejected_realm, events_replayed, events_unsigned_legacy` and `time_t last_reject_time; char last_reject_cause[32];`; `int sasl_webhook_init(const struct kc_webhook_config *cfg)`; `const char *sasl_conf_keycloak_realm(void)`.

- [ ] **Step 1: Red is Task 5's transport suite** (written next, run before this task's deploy). Also Review Focus 5's rehash check is bed-observed in Task 6.

- [ ] **Step 2: libkc listener**

In `include/kc/kc_webhook.h`, `struct kc_webhook_config`: add after `batch_size`:

```c
    int         signature_window;   /* Accept t within +/- seconds (0 = 300) */
    int         legacy_secret;      /* 1 = accept the plain X-Webhook-Secret header alone (transition) */
    const char *realm_name;         /* Refuse payloads whose realmName differs (NULL = no check) */
    void      (*on_reject)(const char *peer, const char *cause, void *data);  /* every refusal, by cause */
    void       *reject_data;
```
`struct kc_webhook_stats`: add `unsigned long events_rejected_auth, events_rejected_realm, events_replayed, events_unsigned_legacy; time_t last_reject_time; char last_reject_cause[32];`. Add `#include "kc/kc_webhook_sig.h"`.

In `ircd/kc/kc_webhook.c`:
- statics: `cfg_signature_window`, `cfg_legacy_secret`, `cfg_realm_name` (strdup), `cfg_on_reject`, `cfg_reject_data`, `static struct kc_replay_ring replay_ring;` set in `kc_webhook_init` from the config (window 0 -> 300), freed in shutdown; `kc_replay_ring_init` at init.
- `struct wh_conn`: add `char signature_header[160];` and `char peer[64];` (filled from `accept`'s address with `inet_ntop`).
- header parse: `else if (strncasecmp(p, "X-Webhook-Signature:", 20) == 0) { copy trimmed value into conn->signature_header; }`.
- a helper:
  ```c
  static void reject(struct wh_conn *conn, int status, const char *cause)
  {
      stats.last_reject_time = time(NULL);
      snprintf(stats.last_reject_cause, sizeof(stats.last_reject_cause), "%s", cause);
      kc_log_warning("kc_webhook: rejected request from %s: %s", conn->peer, cause);
      if (cfg_on_reject) cfg_on_reject(conn->peer, cause, cfg_reject_data);
      send_response(conn->fd, status, cause);
  }
  ```
- in `process_request`, replace the secret block: the body is located FIRST (it is needed for the signature), then:
  ```c
      if (!cfg_secret || !cfg_secret[0]) { stats.events_invalid++; reject(conn, 401, "no secret configured"); return -1; }
      {
          enum kc_sig_result r = kc_webhook_sig_verify(cfg_secret, conn->signature_header, body, body_len,
                                                       (long long)time(NULL), cfg_signature_window, NULL);
          if (r != KC_SIG_OK) {
              if (r == KC_SIG_MISSING && cfg_legacy_secret
                  && strlen(conn->secret_header) == strlen(cfg_secret)
                  && CRYPTO_memcmp(conn->secret_header, cfg_secret, strlen(cfg_secret)) == 0) {
                  stats.events_unsigned_legacy++;          /* transition only */
              } else {
                  stats.events_rejected_auth++;
                  reject(conn, 401, kc_sig_result_name(r));
                  return -1;
              }
          }
      }
  ```
  (`events_received++` moves to after this point so the counter means "authenticated".)
- in `dispatch_event`, after `root` is parsed and the `id` read: replay -- `if (kc_replay_ring_seen(&replay_ring, event.id, (long long)time(NULL), cfg_signature_window)) { stats.events_replayed++; stats.last_reject_time = time(NULL); snprintf(stats.last_reject_cause, ..., "replay"); kc_log_warning("kc_webhook: replayed event %s", event.id); if (cfg_on_reject) cfg_on_reject("-", "replay", cfg_reject_data); goto done; }`; realm -- `if (cfg_realm_name) { json_t *rn = json_object_get(root, "realmName"); if (rn && json_is_string(rn) && strcmp(json_string_value(rn), cfg_realm_name) != 0) { stats.events_rejected_realm++; ... "realm" ...; goto done; } }` (`done:` is the existing cleanup at the end of `dispatch_event`; make sure `json_decref` still runs).
- `kc_webhook_stats_get` copies the new fields; `kc_webhook_init` must NOT zero `stats` when called for a re-init that only changes the secret -- that path no longer reaches init (below).

- [ ] **Step 3: The ircd threads the whole block and reports rejections**

`include/sasl_webhook.h`: `extern int sasl_webhook_init(const struct kc_webhook_config *cfg);` (forward-declare `struct kc_webhook_config`), and in `struct sasl_webhook_stats` add `unsigned long rejections; time_t last_rejection; char last_reject_cause[32];`.

`ircd/sasl_webhook.c`:
```c
static void webhook_reject_notice(const char *peer, const char *cause, void *data)
{
  static time_t last_notice[8]; static const char *causes[8] = { "missing", "malformed", "stale", "mismatch", "replay", "realm", "no secret configured", "other" };
  int i;
  (void)data;
  wh_stats.rejections++;
  wh_stats.last_rejection = CurrentTime;
  ircd_strncpy(wh_stats.last_reject_cause, cause, sizeof(wh_stats.last_reject_cause));
  for (i = 0; i < 7; i++) if (0 == strcmp(cause, causes[i])) break;
  if (CurrentTime - last_notice[i] < 60)     /* one notice per cause per minute */
    return;
  last_notice[i] = CurrentTime;
  sendto_opmask_butone(0, SNO_UNAUTH, "WEBHOOK: request from %s rejected: %s (%lu rejections since boot)",
                       peer, cause, wh_stats.rejections);
}

int sasl_webhook_init(const struct kc_webhook_config *cfg_in)
{
  struct kc_webhook_config cfg = *cfg_in;
  if (cfg.port <= 0) return 0;
  cfg.on_reject = webhook_reject_notice;
  cfg.reject_data = NULL;
  if (kc_webhook_init(&cfg, nef_webhook_handle_event, NULL) != 0) { log_write(...); return -1; }
  /* wh_stats is NOT reset here: a rehash keeps the counters. */
  webhook_initialized = 1;
  log_write(LS_SYSTEM, L_INFO, 0, "WEBHOOK: listening on %s:%d, signature %s, realm %s",
            cfg.bind_address ? cfg.bind_address : "*", cfg.port,
            cfg.legacy_secret ? "required (plain secret accepted during transition)" : "required",
            cfg.realm_name ? cfg.realm_name : "(not checked)");
  return 0;
}
```
(`sasl_webhook.c` already includes `client.h`, `send.h`; `sendto_opmask_butone` is in `send.h`; `SNO_UNAUTH` in `client.h`.)

`ircd/sasl_conf.c`: add to the pending/active webhook struct `int signature_window; int legacy_secret; char realm[SC_REALM_LEN];`; setters `sasl_conf_webhook_set_signature_window(int)`, `sasl_conf_webhook_set_legacy_secret(int)`, `sasl_conf_webhook_set_realm(const char *)`; `wh_changed()` compares them; `const char *sasl_conf_keycloak_realm(void) { return kc_active.realm; }`; `wh_apply_now`:

```c
  cfg.signature_window = wh_pending.signature_window;
  cfg.legacy_secret    = wh_pending.legacy_secret;
  cfg.realm_name       = wh_pending.realm[0] ? wh_pending.realm
                       : (kc_pending.realm[0] ? kc_pending.realm : NULL);

  /* A secret-only change keeps the listener and its counters. */
  if (wh_active.port == wh_pending.port && wh_active.port != 0
      && 0 == strcmp(wh_active.vhost, wh_pending.vhost) && 0 == strcmp(wh_active.path, wh_pending.path)
      && wh_active.max_connections == wh_pending.max_connections
      && wh_active.max_request_size == wh_pending.max_request_size
      && wh_active.queue_max == wh_pending.queue_max && wh_active.batch_size == wh_pending.batch_size
      && wh_active.signature_window == wh_pending.signature_window
      && wh_active.legacy_secret == wh_pending.legacy_secret
      && 0 == strcmp(wh_active.realm, wh_pending.realm)) {
    kc_webhook_set_secret(cfg.secret);
    memcpy(&wh_active, &wh_pending, sizeof(wh_active));
    return;
  }
  if (sasl_webhook_init(&cfg) != 0) return;
```
(`wh_apply_now` runs only when `wh_changed()`, so the remaining case is "something other than the secret changed": full re-init as today.)

`ircd/ircd_parser.y`: three items `webhooksigwindow: SIGNATUREWINDOW '=' NUMBER ';'`, `webhooklegacysecret: LEGACYSECRET '=' YES|NO ';'` (use the grammar's existing yes/no production, see `sasl_conf_keycloak`'s boolean items), `webhookrealm: REALM '=' QSTRING ';'` (`REALM` may already be a token for the Keycloak block; reuse). `ircd/ircd_lexer.l`: tokens `signaturewindow`, `legacysecret`.

- [ ] **Step 4: Build, boundary, cmocka; commit** -- `webhook: signed, fresh, unreplayed, own-realm events only; the Webhook block reaches the listener` (one commit for the listener and the ircd side, since neither works without the other).

---

### Task 4: `STATS webhook`, the username gate, and hygiene

**Files:**
- Modify: `ircd/s_stats.c` (entry), `ircd/sasl_webhook.c` (`sasl_webhook_report_stats`, both the libkc and the stub build), `include/sasl_webhook.h`, `ircd/webhook_subject.c`, `ircd/test/webhook_subject_cmocka.c`, `scripts/setup-keycloak.sh`

- [ ] **Step 1: Failing cmocka for the username gate** (Review Focus 4), in `webhook_subject_cmocka.c`:

```c
static void test_bad_username_is_dropped(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  load(&f, "user-delete-root-username.json");
  f.ev.username = "has space";
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);     /* no id, no usable name */
  f.ev.username = "colon:inside";
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  f.ev.username = "ctrl\x01char";
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  f.ev.username = "this-name-is-far-longer-than-any-account-name-the-ircd-will-ever-carry";
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  f.ev.username = "fine_name-1";
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 1);
  assert_string_equal(s.username, "fine_name-1");
  unload(&f);
}
```
Run red (register it in `main`). Expected: the "has space" case returns 1 today.

- [ ] **Step 2: The gate** in `ircd/webhook_subject.c` (`ACCOUNTLEN` is an ircd constant the pure module must not include; use the wire's practical bound, 32, and say so):

```c
/* A name that can travel on the P10 wire and match a cache entry: no
 * space, colon or control character, at most WH_USERNAME_MAX bytes (the
 * ircd's ACCOUNTLEN is 12 on ircu, larger on this fork; the wire tolerates
 * anything shorter than a token).  Anything else is not a name. */
#define WH_USERNAME_MAX 32
static int username_usable(const char *u)
{
  size_t i;
  if (!u || !u[0]) return 0;
  for (i = 0; u[i]; i++) {
    unsigned char c = (unsigned char)u[i];
    if (i >= WH_USERNAME_MAX || c <= ' ' || c == ':' || c == 0x7f) return 0;
  }
  return 1;
}
```
and `out->username = username_usable(ev->username) ? ev->username : NULL;`. Green; commit -- `webhook: a payload username is a name only if it can travel the wire`.

- [ ] **Step 3: `STATS webhook`**

`ircd/s_stats.c`, next to the `webpush` entry: `{ ' ', "webhook", STAT_FLAG_OPERFEAT, FEAT_LAST_F, sasl_webhook_report_stats, 0, "Keycloak webhook listener: transport, rejections, handler counters." },` and `#include "sasl_webhook.h"`.

`ircd/sasl_webhook.c` (libkc build):
```c
void sasl_webhook_report_stats(struct Client *to, const struct StatDesc *sd, char *param)
{
  struct kc_webhook_stats t;
  (void)sd; (void)param;
  if (!webhook_initialized) {
    send_reply(to, SND_EXPLICIT | RPL_STATSDEBUG, "W :WEBHOOK listener not running (no Webhook block, or port 0)");
    return;
  }
  kc_webhook_stats_get(&t);
  send_reply(to, SND_EXPLICIT | RPL_STATSDEBUG, "W :WEBHOOK listener: %lu connections (%lu active, %lu refused), %lu bytes",
             t.connections_total, t.connections_active, t.connections_rejected, t.bytes_received);
  send_reply(to, SND_EXPLICIT | RPL_STATSDEBUG, "W :  Events: %lu authenticated, %lu processed, %lu invalid, %lu dropped (queue %lu)",
             t.events_received, t.events_processed, t.events_invalid, t.events_dropped, t.queue_depth);
  send_reply(to, SND_EXPLICIT | RPL_STATSDEBUG, "W :  Refused: %lu bad or missing signature, %lu replayed, %lu other realm, %lu plain-secret (transition)",
             t.events_rejected_auth, t.events_replayed, t.events_rejected_realm, t.events_unsigned_legacy);
  if (t.last_reject_time)
    send_reply(to, SND_EXPLICIT | RPL_STATSDEBUG, "W :  Last refusal: %s, %lld s ago", t.last_reject_cause, (long long)(CurrentTime - t.last_reject_time));
  send_reply(to, SND_EXPLICIT | RPL_STATSDEBUG, "W :  Handler: %lu user events, %lu credential events, %lu session events; %lu cache purges, %lu deauths/kills",
             wh_stats.user_events, wh_stats.credential_events, wh_stats.session_events, wh_stats.cache_invalidations, wh_stats.sessions_killed);
  if (t.last_event_time)
    send_reply(to, SND_EXPLICIT | RPL_STATSDEBUG, "W :  Last event: %lld s ago", (long long)(CurrentTime - t.last_event_time));
}
```
Stub build: one line, `"W :WEBHOOK built without libkc (--disable-keycloak): no listener"`. Declare in `sasl_webhook.h` (forward `struct StatDesc`).

- [ ] **Step 4: `scripts/setup-keycloak.sh`** -- the "already enabled" branch still PUTs `adminEventsEnabled` / `adminEventsDetailsEnabled` (move the PUT out of the `else`).

- [ ] **Step 5: Build; commit** -- `webhook: STATS webhook; setup always enables admin events`.

---

### Task 5: The bed speaks the new contract: helper signs, transport suite red

**Files:**
- Modify: `tests/src/helpers/webhook-post.ts` (sign), `tests/src/services/x3-account-change.test.ts` (use the helper instead of its own fetch)
- Create: `tests/src/services/keycloak-webhook-transport.test.ts`

- [ ] **Step 1: The helper signs** (node `crypto`):

```ts
import { createHmac } from 'node:crypto';
...
export function signWebhook(secret: string, t: number, body: string): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** POST a Keycloak-shaped event to an ircd, signed like the SPI signs; resolves to the HTTP status. */
export async function postWebhook(body: unknown, target: WebhookTarget = 'nefarious',
                                  opts: { t?: number; secret?: string; unsigned?: boolean } = {}): Promise<number> {
  const { port, secret } = webhookEndpoint(target);
  const payload = JSON.stringify(body);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret };
  if (!opts.unsigned) headers['X-Webhook-Signature'] = signWebhook(opts.secret ?? secret, t, payload);
  const res = await fetch(`http://${containerIp(target)}:${port}/keycloak-webhook`, { method: 'POST', headers, body: payload });
  return res.status;
}
```
Every event builder adds `realmName: 'testnet'` (the bed realm). `x3-account-change.test.ts` calls `postWebhook(...)` instead of its own `fetch`.

- [ ] **Step 2: The transport suite** (`keycloak-webhook-transport.test.ts`), using a pool account with a logged-in client and `whoisAccount`:

```ts
it('refuses an unsigned event and does not act', ...)       // postWebhook(disable, 'nefarious', { unsigned: true }) -> 401; account still on the client
it('refuses a stale signature', ...)                         // { t: now - 400 } -> 401; no deauth
it('refuses a replay of a valid event', ...)                 // same body, same t, posted twice: 200 then 401; first one acted (account gone)
it('refuses an event from another realm', ...)               // realmName: 'other' -> 403; no deauth
it('refuses a wrong secret', ...)                            // { secret: 'nope' } -> 401
it('STATS webhook shows the refusals to an oper', ...)       // createOperClient(); send 'STATS webhook'; wait for /Refused: \d+ bad or missing signature/ and assert the count grew
it('a rehash that changes only the secret keeps the counters', ...)   // optional: needs a conf edit + REHASH; do it by hand in Task 6 if the harness cannot edit data/ircd.conf safely
```
Each "no deauth" case posts, waits 1.5 s, and asserts `whoisAccount(client, nick) === account`. The replay case uses `accountDisabledEvent` with a fixed `id` and passes the same `t` twice.

- [ ] **Step 3: Run red on the current build.** Expected: unsigned/stale/replay/realm/wrong-secret cases fail (the current listener accepts anything with the plain secret header; the wrong-secret case already passes), STATS case fails (no such STATS).

- [ ] **Step 4: Commit** -- `tests: the webhook helper signs; transport suite (red)`.

---

### Task 6: Deploy both sides and turn the bed green

- [ ] **Step 1: SPI first** (Task 1 Step 4 already built the jar): `scripts/dc.sh up -d --force-recreate --no-deps keycloak`; wait healthy; `docker logs keycloak --since 3m | grep -c "Sending admin event"` after a probe user create/delete; then `docker logs nefarious --since 3m | grep WEBHOOK` shows the events accepted by the OLD ircd (the plain header still satisfies it).
- [ ] **Step 2: ircds**: merge into `bed-deploy`, build both, recreate both, X3 and leaf relink.
- [ ] **Step 3: Green**: `keycloak-webhook-transport` all cases; `keycloak-webhook-e2e` 3/3 (real events are now signed and realm-named); `bouncer-deauth-local-alias` 2/2, `bouncer-deauth-cross-server` 3/3, `x3-account-change` 2/2 (through the signing helper), `sasl-reauth` 4/4.
- [ ] **Step 4: Review Focus 5 by hand**: `STATS webhook` from the oper; change only `secret` in `data/ircd.conf` to a second value and `REHASH`; `STATS webhook` again -- the counters are intact and the listener still answers (post a signed event with the new secret: 200).  Change it back and `REHASH`.

---

### Task 7: The names, the dead block, the docs

**Files:** the seven `data/ircd*.conf`, `.env`, `.env.local`, `data/x3.conf`, `keycloak-webhook-spi/README.md` (done in Task 1), this plan's execution record

- [ ] **Step 1 (decision 5):** `sed -i 's/x3-webhook-secret/ircd-webhook-secret/'` across the ten files; remove the `keycloak_webhook_*` block from `data/x3.conf`; recreate Keycloak (env) and `REHASH` both ircds (or recreate them); re-run `keycloak-webhook-e2e` once.
- [ ] **Step 2:** `FEATURE_FLAGS_CONFIG.md`: a `Webhook {}` section listing every item and its default (port, secret, vhost, path, maxconnections, maxrequestsize, queuemax, batchsize, signaturewindow 300, legacysecret no, realm = the Keycloak block's), the signature contract, the realm rule, `STATS webhook`, the `SNO_UNAUTH` notice; the prod posture (bind `vhost` to the private interface; TLS on the listener is deferred).
- [ ] **Step 3:** Commit -- `bed: the webhook secret is the ircd's; x3.conf loses its dead webhook block; Webhook block documented`.

---

## Self-review

**1. Spec coverage.** P0-3: config threading (Task 3), private bind made real (Task 3 + docs), signature + window + replay (Tasks 1, 2, 3), realm check (Tasks 1, 3), secret rename (Task 7); TLS deliberately deferred (decision 3). P0-4: `STATS webhook` and the rejection notice (Tasks 3, 4). P2: username gate (Task 4), rehash churn (Task 3), setup script (Task 4). Cutover 2, 3, 6 covered; 7-9 remain operator items in the deferred register.

**2. Placeholder scan.** The transport suite's cases are listed as one-liners with their expected statuses and observables rather than full code; the executor writes them in the shape of `keycloak-webhook-e2e.test.ts` (same helpers). Everything else carries its code.

**3. Type consistency.** `kc_webhook_sig_verify(secret, header, body, body_len, now, window_s, t_out)` in Tasks 2 and 3; `kc_replay_ring_seen(ring, id, now, window_s)` in Tasks 2 and 3; `sasl_webhook_init(const struct kc_webhook_config *)` in Task 3 and `wh_apply_now`; `signatureHeader(secret, t, body)` in Task 1 only; the wire form `t=<unix>,v1=<hex>` identical in Tasks 1, 2 and 5.

**4. Review focus.** 1 -> `test_stale_timestamp_is_refused` + bed "stale"; 2 -> `test_replay_is_refused` + bed "replay"; 3 -> bed "wrong realm"; 4 -> `test_bad_username_is_dropped`; 5 -> Task 6 Step 4 by hand (a harness edit of `data/ircd.conf` is not safe to automate).

**To verify at execution time:** the grammar's boolean production name for `legacysecret` and whether `REALM` is already a token; whether `KC_BOUNDARY_FILES` in `ircd/Makefile.in` lists kc files explicitly (then `kc/kc_webhook_sig.c` must be added); whether the maven builder image can run `mvn test` offline (Step 2 of Task 1 tries `-o` first); `HMAC_CTX_new` availability under the tree's OpenSSL (1.1+; the tree already uses `PKCS5_PBKDF2_HMAC`).

---

## Execution record (2026-09-23)

Executed inline (`superpowers:executing-plans`), then one fresh-context review (Agent, model fable) over the three ranges and ONE fix pass. Nothing pushed; push commands and PR text in `step5-pr-drafts-2026-09-23.md`.

**Commits.**
- nefarious `fix/webhook-transport` on 7b65b7a (plan 2's tip): cde1b99 kc signature module + cmocka; 82378b3 listener enforces signature/window/replay/realm at HTTP time, full `Webhook {}` threading, secret-only rehash, `SNO_UNAUTH` notice; 0ada9cd username gate; 2e921c6 `STATS webhook`; ead82a8 eight feature-less STATS entries oper-only (review 2); e48d764 review fix pass (1, 3, 4, 5). bed-deploy merge b6a8ee7.
- keycloak-webhook-spi `feature/signed-events` on f8a6e1c (`docs/ircd-contract`, superseded): ad0a2dd signs every delivery, `realmName`, JUnit vector; 7b5db8a warns when the realm cannot be named (review 4).
- testnet main: 420cc1ee setup script asserts admin events; d94c96a2 helper signs + transport suite; 821c1eb0 Webhook block docs; f226c497 secret renamed `ircd-webhook-secret`, x3.conf's dead block gone; 8d197e58 review tests + doc corrections; then the records commit.

**Proof on the bed** (images from b6a8ee7): transport 8/8 (unsigned, stale, other secret, other realm, replay, STATS count, non-oper 481, realmName-less counted), e2e 3/3 (real disable / admin reset / delete, signed and realm-named, the no-realm count untouched), bouncer-deauth local-alias 2/2 and cross-server 3/3, x3-account-change 2/2 (needs `X3_AC_CHANGE=1`), sasl-reauth 4/4; cmocka `kc_webhook_sig` 6/6, `webhook_subject` 10/10; JUnit 2/2; a full `--disable-keycloak` build links. By hand: a secret-only `REHASH` kept the listener and every counter (new secret 200, old 401, revert 200); a busy-port `REHASH` produced the oper notice and `STATS webhook` "NOT RUNNING", the revert brought the listener back (signed post 200).

**Review findings.** Critical 1 (stub build broken by `RPL_STATSDEBUG` without `numeric.h`) fixed. Critical 2 (a non-oper's `STATS webhook` -- and `webpush`, `authtoken`, `chathistory`, `metadata`, `dnsbl`, `gitsync`, `chathistoryads` -- aborted the server through `feature_bool(FEAT_LAST_F)`'s type assert; asserts are on in the image) fixed for all eight entries: a prod crash vector until deployed. Important 3 (replay ring: an id re-signed after its window was appended behind its stale slot, so a replay of the new sighting passed; and the ring lived by receipt time, so a skewed SPI clock shortened the refusal window) fixed: the ring lives by the signature's `t`, refresh in place. Important 4 (decision 4's "accepted and counted" for a missing `realmName` was not implemented and the deviation was not ledgered) fixed: `events_no_realm`, the "Without realmName" STATS line, SPI warning. Important 5 (a failed re-init left `STATS` reporting stale counters as a live listener and a later rehash with the old values was a no-op) fixed: initialized flag cleared, oper notice, NOT RUNNING, active state forgotten so the next rehash retries. Important 6 (`64k` does not parse) and 7 (`SNO_UNAUTH` is not in the default oper mask) fixed in the docs; 7's default-mask half and 8 (an SPI retry of an applied event whose 200 was lost is refused as a replay three times; the reviewer's refinement: same id + newer `t` + valid signature = 200 duplicate) are the user's decisions in the register. Minors 9-20 deferred to the register.

**Rulings** (each with what it costs if wrong; the ledger had the full lines):
1. The six open proposals were taken as decided by "rest looks good" -- cost: each is a contained change.
2. The nefarious branch is cut from plan 2's unpushed tip; the SPI branch from `docs/ircd-contract` so one PR carries docs + signing (the docs branch is not opened on its own; whether to split is now a register decision) -- cost: a rebase if plan 2 changes.
3. kc code includes its own headers in angle form only -- cost: none.
4. Replay and realm checks moved from dispatch time to HTTP time so the SPI gets 401/403 -- cost: one extra `json_loadb` per accepted request.
5. `process_request` returns the HTTP status and a message -- cost: none.
6. `send_reply`/`SND_EXPLICIT` come from `ircd_reply.h` in the common block -- cost: none.
7. The docs commit landed before the rename commit (two commits, not the plan's one) -- cost: none.
8. Finding 2's fix covers the seven older entries with the same flags; its RED could not be run against the shared bed -- cost: none (an abort became 481).
9. Finding 5 verified by hand, no automated test (the plan's own ruling on conf edits) -- cost: a regression of the dead-listener report goes unnoticed until an operator hits it.
10. Finding 7: doc fix now, the default-mask change is the user's -- cost: a default oper hears no refusal notices until the mask is set.
11. Finding 8 recorded for the user, nothing changed -- cost: a lost 200 makes the SPI retry into three "replay" refusals with notices.
12. Finding 17's wrong `legacysecret` sentence corrected within 7's doc edit; the rest deferred -- cost: none.
13. The reviewer's declined-to-judge list stands as set aside (TLS, `atoi` Content-Length, connection-hold DoS, unauthenticated GET/HEAD 200, `authDetails.username` log name, legacy timing shape, X3 attribution, SCRAM material, `doc/example.conf` gap, a stale test comment, IPv4-only listener, the bed's feature-form confs), each now a register row where it was not one -- cost: as each row says.

**Traps learned.** The listener's 9090 is not published on the host (post to the container IP); never `sed -i` a `data/ircd*.conf` (per-file bind mounts); `x3-account-change` is gated on `X3_AC_CHANGE=1`; a non-oper STATS request aborts any image older than ead82a8; the SPI submodule checkout is detached at the branch tip because the bed's builder mounts it; the ircd's skill mirrors under `nefarious/.claude/skills` have drifted from the testnet copies (register).

### Addendum, 2026-09-24: the three decisions

The user decided: (1) no, `SNO_UNAUTH` stays out of the default oper mask (refusal notices are opt-in; the doc says how to enable the mask); (2) yes, the retry refinement; (3) yes, the SPI branch splits into two PRs.

**Retry refinement** (nefarious 32e3664; test-first: cmocka red on the missing verdict API, bed red with the second post answered 401). `kc_replay_ring_check(r, id, t)` returns NEW, DUPLICATE or REPLAY: the ring holds the accepted ids with their newest signature time; a copy signed no later than that is a replay (401); a copy the SPI signed again later can only be its own retry of an event already queued, so it is answered 200, counted as `Duplicates` under `STATS webhook`, and not queued again. The realm check now runs before the ring (a refused foreign event takes no slot; the first half of minor 10 closes), and an id the queue could not take (503) is forgotten so the SPI's retry is new. Bed proof on bed-deploy c06291e: transport 9/9 (the new case: the original 200 and acted, the re-signed copy 200, `Duplicates` +1, the handler's user-event count unchanged), e2e 3/3, bouncer-deauth local-alias 2/2 and cross-server 3/3, x3-account-change 2/2, sasl-reauth 4/4; cmocka `kc_webhook_sig` 6/6. testnet 5139bfae carries the tests, the doc paragraphs and the skills.

**SPI split.** `feature/signed-events` was rebased onto main 6c2c54d (47963e0 signing + `realmName` + JUnit; 86213bc realm warning); the README conflict was resolved to the signing paragraph alone, consumer-neutral, and that paragraph now also states the retry answer (the X3 snippet stays for the docs PR to replace). `docs/ircd-contract` (c195c7a, f8a6e1c) is its own PR. JUnit 2/2 on the rebased branch; the bed's SPI checkout is at 86213bc, the jar rebuilt and deployed. Whichever PR merges second needs a rebase: both touch `README.md` and the Java file.

**Records.** The register closes the three decision rows; the push drafts list nefarious's seven commits (`cde1b99..32e3664`) and the two SPI push sections.
