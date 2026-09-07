# Native Account Registration (Keycloak) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/REGISTER` real — accounts born in Keycloak with in-house-derived credentials (PBKDF2 import + SCRAM attributes), optional link-based email verification as pure Keycloak-side policy, and the dead RG/VF/RR relay deleted.

**Architecture:** `m_register` answers locally on every server via libkc (same posture as SASL). All credential material is derived in the ircd at REGISTER time — no plaintext in the create payload. Verification state lives entirely in Keycloak (`emailVerified` + `VERIFY_EMAIL` required action); the server keeps zero pending-registration state. The webhook SPI keeps the reverse direction (web-flow password sets).

**Spec:** `docs/superpowers/specs/2026-08-05-account-registration-design.md` — read it first; every task below implements a section of it.

**Tech Stack:** C (nefarious fork, autotools), libkc (vendored, curl/jansson), OpenSSL libcrypto (PBKDF2/HMAC/SHA-256), CMocka, Java (keycloak-webhook-spi, Maven), Vitest E2E.

## Global Constraints

- Submodule branches: create `feature/account-registration` in `nefarious/` (base: current `feature/channel-relocate` HEAD or its merge target — ask the user which base at Task 1 commit time if unclear); SPI work on a branch in `keycloak-webhook-spi/`; testnet changes on `main`.
- `nefarious/ircd/kc/*` and `nefarious/include/kc/*` must NOT include ircd headers — `make check-kc-boundary` runs on every make and must stay green. New kc files must be added to its allow-list (find it: `grep -rn "check-kc-boundary" nefarious/Makefile.in nefarious/ircd/Makefile.in`).
- Feature-table trap (fleet-crash class): the `F_B`/`F_S` registration order in `ircd/ircd_features.c` MUST match the enum order in `include/ircd_features.h` — a boot assert fires otherwise. Every feature edit touches both files at the SAME position.
- Host build works (deps installed): `cd nefarious && ./configure --enable-debug --with-maxcon=4096 --with-rocksdb=/usr --with-zstd=/usr --enable-keycloak && make`. Docker stays the canonical gate.
- Canonical SCRAM parameters (lockstep with SPI): SHA-256, 4096 iterations, 16-byte salt, attributes `scram_sha256_{salt,iterations,stored_key,server_key}` (base64 values, iterations as decimal string).
- Keycloak PBKDF2 import parameters (verified by Task 0): `algorithm "pbkdf2-sha256"`, 27500 iterations, 32-byte derived key.
- Testing never asserts SMTP/email delivery — flag-state only. The send-verify-email call must be non-fatal on failure.
- Do not push or open PRs without asking the user first. Commits inside submodules per task are fine.

---

### Task 0: Probe — pre-hashed import format + LDAP write-through

The spec's verification task. No production code; produces recorded facts that Tasks 2/4 depend on and a spec amendment. Everything runs against the live bed (Keycloak on the compose network; admin creds in `.env`/`.env.local` — find them: `grep -i 'KEYCLOAK_ADMIN' .env .env.local`).

**Files:**
- Create: `/tmp/claude-1000/-home-ibutsu-testnet/*/scratchpad/prehash-probe.sh` (scratch — NOT committed, per no-diagnostic-tooling rule)
- Modify: `docs/superpowers/specs/2026-08-05-account-registration-design.md` (record outcomes)

**Interfaces:**
- Produces: confirmed `credentialData`/`secretData` JSON shape and PBKDF2 key size for Task 1's `kc_pbkdf2_cred_build()`; confirmed LDAP write-through behavior for Task 6's assertions and the spec's accepted-limitation 1.

- [ ] **Step 1: Generate a PBKDF2 credential for a test password**

```bash
python3 - <<'EOF'
import hashlib, base64, os, json
password = b"probe-password-1"
salt = os.urandom(16)
dk = hashlib.pbkdf2_hmac('sha256', password, salt, 27500, dklen=32)
print(json.dumps({"hashIterations": 27500, "algorithm": "pbkdf2-sha256", "additionalParameters": {}}))
print(json.dumps({"value": base64.b64encode(dk).decode(), "salt": base64.b64encode(salt).decode()}))
EOF
```

- [ ] **Step 2: Create a user with that pre-hashed credential via admin REST**

Get an admin token (mirror the pattern in `scripts/setup-keycloak.sh` — it fetches `access_token` from `/realms/master/protocol/openid-connect/token` with the admin client). Then:

```bash
curl -sf -X POST "$KC_BASE/admin/realms/$REALM/users" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"prehashprobe","enabled":true,"email":"probe@test.invalid",
       "credentials":[{"type":"password",
         "credentialData":"<step-1 line 1, JSON-escaped>",
         "secretData":"<step-1 line 2, JSON-escaped>"}]}'
```

Note: `credentialData`/`secretData` are JSON **strings containing JSON** — escape accordingly (this mirrors what `kc_user_create` posts, `nefarious/ircd/kc/kc_keycloak.c:1079-1097`).

- [ ] **Step 3: Verify ROPC login works against the imported hash**

```bash
curl -s -X POST "$KC_BASE/realms/$REALM/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" \
  --data-urlencode "username=prehashprobe" --data-urlencode "password=probe-password-1"
```

Expected: 200 with an access token. If 401 with the correct password, the key size or JSON shape is wrong — try `dklen=64`, and record which one Keycloak accepts. **The accepted parameters become Task 1's constants.**

- [ ] **Step 4: Inspect the LDAP write-through**

```bash
docker exec openldap ldapsearch -x -H ldap://localhost -D "$LDAP_ADMIN_DN" -w "$LDAP_ADMIN_PW" \
  -b "ou=users,dc=fractalrealities,dc=net" "(uid=prehashprobe)" userPassword objectClass
```

Record: entry present? `userPassword` present, and in what scheme? Then attempt a bind as the probe user:

```bash
docker exec openldap ldapwhoami -x -D "uid=prehashprobe,ou=users,dc=fractalrealities,dc=net" -w "probe-password-1"
```

Record success/failure. Also test the unverified variant: repeat Steps 2-4 with `"emailVerified":false,"requiredActions":["VERIFY_EMAIL"]` added, confirm ROPC now returns 400 and capture the exact JSON error body (this is Task 2's classifier input — expected: `{"error":"invalid_grant","error_description":"Account is not fully set up"}`).

- [ ] **Step 5: Clean up and record**

Delete both probe users via admin REST (and verify gone from LDAP). Update the spec: fill the LDAP write-through outcome into "Accepted limitations" item 1 (does the bypass narrow?) and adjust the E2E expectations in the Testing section if reality differs. Delete the scratch script.

- [ ] **Step 6: Commit the spec amendment**

```bash
cd /home/ibutsu/testnet && git add docs/superpowers/specs/2026-08-05-account-registration-design.md
git commit -m "spec: record pre-hash import + LDAP write-through probe results"
```

---

### Task 1: Credential derivation module (kc_cred_derive) + CMocka

Pure derivation code, placed under `kc/` so it is boundary-clean (no ircd headers), links jansson + libcrypto, and slots into the keycloak-conditional CMocka list.

**Files:**
- Create: `nefarious/include/kc/kc_cred_derive.h`, `nefarious/ircd/kc/kc_cred_derive.c`
- Create: `nefarious/ircd/test/kc_cred_derive_cmocka.c`
- Modify: `nefarious/configure.in` (add suite to `KC_CMOCKA_TESTPROGS`), `nefarious/ircd/test/Makefile.in` (build rule, mirror `kc_url_cmocka`), kc-boundary allow-list, `nefarious/ircd/Makefile.in` (compile the new object with the other kc objects)

**Interfaces:**
- Produces (consumed by Tasks 2 and 4):

```c
/* include/kc/kc_cred_derive.h */
#define SCRAM_SHA256_SALT_LEN   16
#define SCRAM_SHA256_KEY_LEN    32
#define SCRAM_SHA256_ITERATIONS 4096
/* Keycloak PBKDF2 import — constants CONFIRMED BY TASK 0; adjust if the probe said otherwise */
#define KC_PBKDF2_ITERATIONS    27500
#define KC_PBKDF2_KEY_LEN       32

struct scram_sha256_creds {
    char salt_b64[32];        /* 16 bytes -> 24 b64 chars + NUL */
    int  iterations;
    char stored_key_b64[48];  /* 32 bytes -> 44 b64 chars + NUL */
    char server_key_b64[48];
};

/* RFC 5802/7677: SaltedPassword=PBKDF2; ClientKey=HMAC(SP,"Client Key");
 * StoredKey=H(ClientKey); ServerKey=HMAC(SP,"Server Key"). Returns 0 / -1. */
int scram_sha256_derive(const char *password, const unsigned char *salt,
                        size_t salt_len, int iterations,
                        struct scram_sha256_creds *out);
/* RAND_bytes salt + canonical iteration count. */
int scram_sha256_derive_random(const char *password,
                               struct scram_sha256_creds *out);
/* Builds Keycloak credentialData/secretData JSON strings (malloc'd; caller
 * frees both). Returns 0 / -1. */
int kc_pbkdf2_cred_build(const char *password, char **cred_data,
                         char **secret_data);
```

- [ ] **Step 1: Generate the reference test vectors**

```bash
python3 - <<'EOF'
import hashlib, hmac, base64
# Vector A: RFC 7677 example inputs
for pw, salt_b64, iters in [(b"pencil", "W22ZaJ0SNY7soEsUEjb6gQ==", 4096),
                            (b"probe-password-1", "AAAAAAAAAAAAAAAAAAAAAA==", 4096)]:
    salt = base64.b64decode(salt_b64)
    sp = hashlib.pbkdf2_hmac('sha256', pw, salt, iters, dklen=32)
    ck = hmac.new(sp, b"Client Key", hashlib.sha256).digest()
    sk = hmac.new(sp, b"Server Key", hashlib.sha256).digest()
    print(pw, salt_b64, base64.b64encode(hashlib.sha256(ck).digest()).decode(),
          base64.b64encode(sk).decode())
EOF
```

This derivation is byte-identical to the SPI's (`keycloak-webhook-spi/.../ScramCredentialProvider.java:176-197`) — that identity is the lockstep guard. Paste the four output values into the test in Step 2.

- [ ] **Step 2: Write the failing CMocka test**

`nefarious/ircd/test/kc_cred_derive_cmocka.c` (mirror the includes/main shape of `kc_url_cmocka.c`):

```c
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>
#include <string.h>
#include <jansson.h>
#include "kc/kc_cred_derive.h"
#include "kc/kc_base64.h"

static void test_scram_fixed_vector(void **state) {
    /* RFC 7677 inputs: password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 */
    unsigned char salt[SCRAM_SHA256_SALT_LEN];
    size_t slen = sizeof(salt);
    struct scram_sha256_creds c;
    assert_true(kc_base64_decode("W22ZaJ0SNY7soEsUEjb6gQ==", 24, (char*)salt, &slen));
    assert_int_equal(0, scram_sha256_derive("pencil", salt, slen, 4096, &c));
    assert_string_equal(c.stored_key_b64, "<PASTE stored_key from Step 1>");
    assert_string_equal(c.server_key_b64, "<PASTE server_key from Step 1>");
    assert_int_equal(c.iterations, 4096);
    assert_string_equal(c.salt_b64, "W22ZaJ0SNY7soEsUEjb6gQ==");
}

static void test_scram_random_salt_differs(void **state) {
    struct scram_sha256_creds a, b;
    assert_int_equal(0, scram_sha256_derive_random("hunter22", &a));
    assert_int_equal(0, scram_sha256_derive_random("hunter22", &b));
    assert_string_not_equal(a.salt_b64, b.salt_b64);
    assert_string_not_equal(a.stored_key_b64, b.stored_key_b64);
    assert_int_equal(a.iterations, SCRAM_SHA256_ITERATIONS);
}

static void test_pbkdf2_cred_shape(void **state) {
    char *cred = NULL, *secret = NULL;
    json_error_t err;
    assert_int_equal(0, kc_pbkdf2_cred_build("hunter22", &cred, &secret));
    json_t *cj = json_loads(cred, 0, &err), *sj = json_loads(secret, 0, &err);
    assert_non_null(cj); assert_non_null(sj);
    assert_int_equal(json_integer_value(json_object_get(cj, "hashIterations")), KC_PBKDF2_ITERATIONS);
    assert_string_equal(json_string_value(json_object_get(cj, "algorithm")), "pbkdf2-sha256");
    assert_non_null(json_object_get(sj, "value"));
    assert_non_null(json_object_get(sj, "salt"));
    json_decref(cj); json_decref(sj); free(cred); free(secret);
}

static void test_null_inputs(void **state) {
    struct scram_sha256_creds c;
    assert_int_equal(-1, scram_sha256_derive(NULL, (unsigned char*)"x", 1, 1, &c));
    assert_int_equal(-1, scram_sha256_derive_random("pw", NULL));
    assert_int_equal(-1, kc_pbkdf2_cred_build(NULL, NULL, NULL));
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(test_scram_fixed_vector),
        cmocka_unit_test(test_scram_random_salt_differs),
        cmocka_unit_test(test_pbkdf2_cred_shape),
        cmocka_unit_test(test_null_inputs),
    };
    return cmocka_run_group_tests(tests, NULL, NULL);
}
```

- [ ] **Step 3: Wire the suite and run it to verify it fails**

Add `kc_cred_derive_cmocka` to `KC_CMOCKA_TESTPROGS` in `configure.in` (grep for `kc_url_cmocka` there), add a build rule in `ircd/test/Makefile.in` copying `kc_url_cmocka`'s (link `kc_cred_derive.o kc_base64.o` + `-ljansson -lcrypto -lcmocka`). Run `autoreconf -fi && ./configure <flags>` then:

Run: `make -C ircd/test kc_cred_derive_cmocka`
Expected: FAIL to compile/link — `kc_cred_derive.h` not found.

- [ ] **Step 4: Implement `kc_cred_derive.c`**

```c
/* ircd/kc/kc_cred_derive.c — registration-time credential derivation.
 * MUST stay ircd-header-free (kc boundary). Lockstep contract: the SCRAM
 * derivation here is byte-identical to keycloak-webhook-spi's
 * ScramCredentialProvider (SHA-256, 4096 iterations, 16-byte salt); both
 * write scram_sha256_* attributes. Change one, change both. */
#include <kc/kc_cred_derive.h>
#include <kc/kc_base64.h>
#include <jansson.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <string.h>
#include <stdlib.h>

static void b64_fixed(const unsigned char *in, size_t inlen, char *out, size_t outsz) {
    kc_base64_encode((const char *)in, inlen, out, outsz);
}

int scram_sha256_derive(const char *password, const unsigned char *salt,
                        size_t salt_len, int iterations,
                        struct scram_sha256_creds *out)
{
    unsigned char sp[SCRAM_SHA256_KEY_LEN];
    unsigned char client_key[SCRAM_SHA256_KEY_LEN], stored_key[SCRAM_SHA256_KEY_LEN];
    unsigned char server_key[SCRAM_SHA256_KEY_LEN];
    unsigned int len;

    if (!password || !salt || !salt_len || iterations < 1 || !out)
        return -1;
    if (!PKCS5_PBKDF2_HMAC(password, strlen(password), salt, salt_len,
                           iterations, EVP_sha256(), sizeof(sp), sp))
        return -1;
    if (!HMAC(EVP_sha256(), sp, sizeof(sp), (const unsigned char *)"Client Key", 10,
              client_key, &len))
        return -1;
    SHA256(client_key, sizeof(client_key), stored_key);
    if (!HMAC(EVP_sha256(), sp, sizeof(sp), (const unsigned char *)"Server Key", 10,
              server_key, &len))
        return -1;
    b64_fixed(salt, salt_len, out->salt_b64, sizeof(out->salt_b64));
    b64_fixed(stored_key, sizeof(stored_key), out->stored_key_b64, sizeof(out->stored_key_b64));
    b64_fixed(server_key, sizeof(server_key), out->server_key_b64, sizeof(out->server_key_b64));
    out->iterations = iterations;
    return 0;
}

int scram_sha256_derive_random(const char *password, struct scram_sha256_creds *out)
{
    unsigned char salt[SCRAM_SHA256_SALT_LEN];
    if (!password || !out || RAND_bytes(salt, sizeof(salt)) != 1)
        return -1;
    return scram_sha256_derive(password, salt, sizeof(salt),
                               SCRAM_SHA256_ITERATIONS, out);
}

int kc_pbkdf2_cred_build(const char *password, char **cred_data, char **secret_data)
{
    unsigned char salt[16], dk[KC_PBKDF2_KEY_LEN];
    char salt_b64[32], dk_b64[64];
    json_t *cj, *sj;

    if (!password || !cred_data || !secret_data)
        return -1;
    if (RAND_bytes(salt, sizeof(salt)) != 1)
        return -1;
    if (!PKCS5_PBKDF2_HMAC(password, strlen(password), salt, sizeof(salt),
                           KC_PBKDF2_ITERATIONS, EVP_sha256(), sizeof(dk), dk))
        return -1;
    b64_fixed(salt, sizeof(salt), salt_b64, sizeof(salt_b64));
    b64_fixed(dk, sizeof(dk), dk_b64, sizeof(dk_b64));

    cj = json_pack("{sisss{}}", "hashIterations", KC_PBKDF2_ITERATIONS,
                   "algorithm", "pbkdf2-sha256", "additionalParameters");
    sj = json_pack("{ssss}", "value", dk_b64, "salt", salt_b64);
    if (!cj || !sj) { if (cj) json_decref(cj); if (sj) json_decref(sj); return -1; }
    *cred_data = json_dumps(cj, JSON_COMPACT);
    *secret_data = json_dumps(sj, JSON_COMPACT);
    json_decref(cj); json_decref(sj);
    if (!*cred_data || !*secret_data) {
        free(*cred_data); free(*secret_data);
        *cred_data = *secret_data = NULL;
        return -1;
    }
    return 0;
}
```

Check `kc_base64_encode`'s exact semantics (`include/kc/kc_base64.h:34`) — if it does not NUL-terminate or has a different arg order, adjust `b64_fixed` accordingly. Add `kc_cred_derive.o` next to the other kc objects in `ircd/Makefile.in`, and add both new files to the check-kc-boundary allow-list.

- [ ] **Step 5: Run tests to verify they pass**

Run: `make -C ircd/test kc_cred_derive_cmocka && ircd/test/kc_cred_derive_cmocka`
Expected: 4 tests PASS. Also run `make check-kc-boundary` — green.

- [ ] **Step 6: Commit**

```bash
cd nefarious && git checkout -b feature/account-registration
git add include/kc/kc_cred_derive.h ircd/kc/kc_cred_derive.c ircd/test/kc_cred_derive_cmocka.c \
        configure.in ircd/test/Makefile.in ircd/Makefile.in <boundary-allowlist-file>
git commit -m "kc: registration-time credential derivation (SCRAM-SHA-256 + Keycloak PBKDF2 import)"
```

---

### Task 2: libkc extensions — create_full, send-verify-email, error classifier, attr read order

**Files:**
- Modify: `nefarious/include/kc/kc_keycloak.h` (enum + new API), `nefarious/ircd/kc/kc_keycloak.c` (create_full, new op, dispatch arms, parse_user read order), `nefarious/include/kc/kc_url.h` + `nefarious/ircd/kc/kc_url.c` (new builder)
- Create: `nefarious/ircd/kc/kc_error_classify.c`, `nefarious/include/kc/kc_error_classify.h`, `nefarious/ircd/test/kc_error_classify_cmocka.c`
- Modify: `configure.in` / `ircd/test/Makefile.in` / boundary allow-list (new suite + object)

**Interfaces:**
- Consumes: nothing from other tasks (cred strings are opaque `char *`).
- Produces (consumed by Tasks 3/4):

```c
/* kc_keycloak.h additions */
KC_UNVERIFIED = -10,  /* credentials OK-shaped but account not fully set up (pending required action) */
KC_CONFLICT   = -11,  /* create: username/email already exists (HTTP 409) */

struct kc_user_create_req {
    const char *username;            /* required */
    const char *email;               /* optional */
    const char *cred_data;           /* required: Task 1 kc_pbkdf2_cred_build output */
    const char *secret_data;         /* required */
    int set_email_verified;          /* 1 => include emailVerified:false + requiredActions */
    const char *const *attr_keys;    /* optional parallel arrays (SCRAM attrs) */
    const char *const *attr_values;
    size_t n_attrs;
};
int kc_user_create_full(const struct kc_user_create_req *req,
                        kc_result_cb cb, void *data);
int kc_user_send_verify_email(const char *id, kc_result_cb cb, void *data);

/* kc_error_classify.h */
#include <jansson.h>
/* Classify a 400/401 password-grant error body. Returns KC_UNVERIFIED when
 * error_description matches Keycloak's "Account is not fully set up"
 * (substring "not fully set up", case-insensitive), else KC_FORBIDDEN.
 * NULL json => KC_FORBIDDEN. */
int kc_classify_grant_error(json_t *json);
```

- [ ] **Step 1: Write the failing classifier CMocka test**

`nefarious/ircd/test/kc_error_classify_cmocka.c`:

```c
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>
#include <jansson.h>
#include "kc/kc_keycloak.h"
#include "kc/kc_error_classify.h"

static void check(const char *body, int expect) {
    json_t *j = body ? json_loads(body, 0, NULL) : NULL;
    assert_int_equal(kc_classify_grant_error(j), expect);
    if (j) json_decref(j);
}

static void test_classify(void **state) {
    check("{\"error\":\"invalid_grant\",\"error_description\":\"Account is not fully set up\"}", KC_UNVERIFIED);
    check("{\"error\":\"invalid_grant\",\"error_description\":\"Invalid user credentials\"}", KC_FORBIDDEN);
    check("{\"error\":\"invalid_grant\"}", KC_FORBIDDEN);      /* no description */
    check("{\"error_description\":\"ACCOUNT IS NOT FULLY SET UP\"}", KC_UNVERIFIED); /* case-insensitive */
    check(NULL, KC_FORBIDDEN);
    check("[1,2]", KC_FORBIDDEN);                              /* non-object */
}

int main(void) {
    const struct CMUnitTest tests[] = { cmocka_unit_test(test_classify) };
    return cmocka_run_group_tests(tests, NULL, NULL);
}
```

Wire the suite exactly as in Task 1 Step 3. Run: `make -C ircd/test kc_error_classify_cmocka` — expected FAIL (header missing).

- [ ] **Step 2: Implement the classifier**

`ircd/kc/kc_error_classify.c` — pure, boundary-clean:

```c
#include <kc/kc_keycloak.h>
#include <kc/kc_error_classify.h>
#include <string.h>
#include <ctype.h>

static int contains_ci(const char *haystack, const char *needle) {
    size_t nl = strlen(needle);
    for (; *haystack; haystack++)
        if (!strncasecmp(haystack, needle, nl))
            return 1;
    return 0;
}

int kc_classify_grant_error(json_t *json)
{
    json_t *desc;
    const char *s;
    if (!json || !json_is_object(json))
        return KC_FORBIDDEN;
    desc = json_object_get(json, "error_description");
    if (!desc || !json_is_string(desc))
        return KC_FORBIDDEN;
    s = json_string_value(desc);
    if (s && contains_ci(s, "not fully set up"))
        return KC_UNVERIFIED;
    return KC_FORBIDDEN;
}
```

Run: `make -C ircd/test kc_error_classify_cmocka && ircd/test/kc_error_classify_cmocka` — PASS.

- [ ] **Step 3: Use the classifier in the ROPC dispatch**

`ircd/kc/kc_keycloak.c` `OP_VERIFY_PASSWORD` case (currently `:718-737`): replace the 400/401 arm:

```c
        } else if (resp->status_code == 401 || resp->status_code == 400) {
            ctx->cb.token(kc_classify_grant_error(resp->json), NULL, ctx->cb_data);
        } else {
```

(Confirm `resp->json` is populated for non-200 responses — grep how `resp->json` is filled in the HTTP completion path; if it is only parsed for 200, parse the raw body here with `json_loads` and decref after.)

- [ ] **Step 4: Add `kc_user_create_full` + 409 handling**

In `kc_keycloak.c`, generalize the body builder (current `kc_user_create`, `:1063-1121`):

```c
int kc_user_create_full(const struct kc_user_create_req *req,
                        kc_result_cb cb, void *data)
{
    json_t *user_repr;
    size_t i;

    if (!req || !req->username || !req->cred_data || !req->secret_data || !cb)
        return -1;

    user_repr = json_object();
    json_object_set_new(user_repr, "username", json_string(req->username));
    json_object_set_new(user_repr, "enabled", json_true());
    if (req->email && req->email[0])
        json_object_set_new(user_repr, "email", json_string(req->email));

    if (req->set_email_verified) {
        json_object_set_new(user_repr, "emailVerified", json_false());
        json_t *ra = json_array();
        json_array_append_new(ra, json_string("VERIFY_EMAIL"));
        json_object_set_new(user_repr, "requiredActions", ra);
    }

    if (req->n_attrs) {
        json_t *attrs = json_object();
        for (i = 0; i < req->n_attrs; i++) {
            json_t *arr = json_array();
            json_array_append_new(arr, json_string(req->attr_values[i]));
            json_object_set_new(attrs, req->attr_keys[i], arr);
        }
        json_object_set_new(user_repr, "attributes", attrs);
    }

    /* credentials: same nested-JSON-strings shape as kc_user_create */
    {
        json_error_t err;
        json_t *cred_obj = json_loads(req->cred_data, 0, &err);
        json_t *secret_obj = json_loads(req->secret_data, 0, &err);
        if (!cred_obj || !secret_obj) {
            if (cred_obj) json_decref(cred_obj);
            if (secret_obj) json_decref(secret_obj);
            json_decref(user_repr);
            return -1;
        }
        json_t *cred = json_object();
        json_object_set_new(cred, "type", json_string("password"));
        json_object_set(cred, "credentialData", cred_obj);
        json_object_set(cred, "secretData", secret_obj);
        json_t *creds = json_array();
        json_array_append_new(creds, cred);
        json_object_set_new(user_repr, "credentials", creds);
        json_decref(cred_obj); json_decref(secret_obj);
    }

    /* tail identical to kc_user_create: dumps, ctx alloc, OP_CREATE_USER, POST kc_url_users */
    ...
}
```

Reimplement `kc_user_create` as a thin wrapper over `kc_user_create_full` (DRY). In the `OP_CREATE_USER` dispatch case, add `409 → ctx->cb.result(KC_CONFLICT, ...)` alongside the existing arms.

- [ ] **Step 5: Add the send-verify-email operation**

`kc_url.c`/`kc_url.h`: `char *kc_url_user_send_verify_email(struct kc_realm r, const char *user_id)` returning `<admin-users-base>/<id>/send-verify-email` (copy the shape of `kc_url_user_reset_password`, `kc_url.h:26`). New `OP_SEND_VERIFY_EMAIL` enum member + dispatch case (204/200 → `KC_SUCCESS`, else `KC_ERROR`), and:

```c
int kc_user_send_verify_email(const char *id, kc_result_cb cb, void *data)
/* ctx->method = "PUT"; ctx->body = NULL; url from the new builder */
```

Extend `kc_url_cmocka.c` with a case asserting the new builder's output string (follow its existing test pattern).

- [ ] **Step 6: New attribute names first in parse_user**

`kc_keycloak.c:211-230`: for each of the four SCRAM fields, insert a first-tier lookup of `scram_sha256_{salt,stored_key,server_key,iterations}` ahead of the existing `x3_scram_*` → `x3_scram_sha256_*` fallbacks. Update the comment to name the SPI as the co-writer and the lockstep contract.

- [ ] **Step 7: Build + full kc test pass**

Run: `make` (full — runs check-kc-boundary) and `make -C ircd/test kc_url_cmocka kc_error_classify_cmocka kc_cred_derive_cmocka` then execute all three.
Expected: build green, suites PASS.

- [ ] **Step 8: Commit**

```bash
cd nefarious && git add include/kc ircd/kc ircd/test configure.in
git commit -m "kc: create_full (attrs/requiredActions/pre-hashed cred), send-verify-email, grant-error classifier, scram_sha256_* read order"
```

---

### Task 3: SASL enforcement — KC_UNVERIFIED path + SCRAM verification gate

**Files:**
- Modify: `nefarious/ircd/sasl_auth.c` (PLAIN callback ~`:700-760`; SCRAM creds callback `:1299-1380`)

**Interfaces:**
- Consumes: `KC_UNVERIFIED` (Task 2), `struct kc_user.email_verified` (exists, `kc_keycloak.h:65`), `FEAT_REGISTER_VERIFY_EMAIL` (Task 4 — until Task 4 lands, guard with `#ifdef` absent? No: Task 4 must merge before this compiles; SEE ORDERING NOTE below).

**ORDERING NOTE:** the feature enum lands in Task 4. To keep every task independently buildable, this task references the feature via a forward-declared helper it defines locally:

```c
/* sasl_auth.c — replaced by feature_bool(FEAT_REGISTER_VERIFY_EMAIL) in Task 4 */
static int register_verify_email_policy(void) { return 0; }
```

Task 4 Step 6 swaps this stub for the real feature check. (Written down here so it is not a silent defer.)

- [ ] **Step 1: PLAIN callback — distinct KC_UNVERIFIED arm**

In the PLAIN result callback (the `else` branch at `sasl_auth.c:729-759`), before the existing failure handling add:

```c
    if (result == KC_UNVERIFIED) {
      /* Account exists and Keycloak is healthy — the account has a pending
       * required action (email verification). Do NOT negcache (the password
       * may be correct) and do NOT mark unhealthy. */
      log_write(LS_SYSTEM, L_INFO, 0,
                "SASL PLAIN: unverified account %s (client %C)",
                session->authcid, acptr);
      send_fail(acptr, "AUTHENTICATE", "VERIFICATION_REQUIRED", NULL,
                "Your account email is not verified - check your email for "
                "the verification link, then try again");
      send_reply(acptr, ERR_SASLFAIL, "");
      /* fall into the shared cleanup below (state/cookie/timers/session) */
    }
```

Structure it so KC_UNVERIFIED skips `sasl_mark_unhealthy` and the `negcache_insert` at `:741-744` (it must satisfy neither `result == KC_FORBIDDEN` nor `KC_NOT_FOUND` tests — verify by reading the final arrangement), but shares the cleanup tail (`:751-758`). `send_fail` degrades gracefully for non-standard-replies clients (`send.c:3720-3723` — always sends), matching the spec's "verify your email, then try again" requirement.

- [ ] **Step 2: SCRAM creds callback — verification gate**

In the SCRAM credential callback (`sasl_auth.c:1299+`), after the existing "credentials exist" check (`:1326-1334`) add:

```c
  /* Spec: SCRAM verifies locally and bypasses the ROPC required-action gate,
   * so enforce email verification here when registration policy demands it. */
  if (register_verify_email_policy() && user && !user->email_verified) {
    log_write(LS_SYSTEM, L_INFO, 0,
              "SASL SCRAM: unverified account %s (client %C)",
              session->authcid, acptr);
    send_fail(acptr, "AUTHENTICATE", "VERIFICATION_REQUIRED", NULL,
              "Your account email is not verified - check your email for "
              "the verification link, then try again");
    send_reply(acptr, ERR_SASLFAIL, "");
    goto scram_fail_cleanup;   /* reuse the function's existing failure exit */
  }
```

Match the function's actual failure-exit idiom (read it; if it uses early `return` + inline cleanup rather than a label, mirror that instead of inventing a label).

- [ ] **Step 3: Build and eyeball the audit rule**

Run: `make`
Expected: clean. Then `grep -n 'KC_FORBIDDEN\|KC_NOT_FOUND' ircd/sasl_auth.c` and confirm every health/negcache decision still treats KC_UNVERIFIED as neither.

- [ ] **Step 4: Commit**

```bash
cd nefarious && git add ircd/sasl_auth.c
git commit -m "sasl: distinct unverified-account failure (KC_UNVERIFIED) for PLAIN + SCRAM verification gate"
```

---

### Task 4: m_register — local Keycloak flow, relay deletion, policy feature, CAP value

The core task. `m_register.c` is rewritten around libkc; the RG/VF/RR relay dies.

**Files:**
- Modify: `nefarious/ircd/m_register.c` (rewrite), `nefarious/include/ircd_features.h` + `nefarious/ircd/ircd_features.c` (feature swap), `nefarious/ircd/m_cap.c` (value setter + static value), `nefarious/ircd/parse.c` (delete REGREPLY block at `:1013-1019`), `nefarious/include/msg.h` (delete MSG_/TOK_/CMD_REGREPLY at `:546-549`)
- Grep-and-clean: `grep -rn 'REGREPLY\|REGISTER_SERVER\|send_register_rg\|ms_regreply' nefarious/ircd nefarious/include nefarious/doc` — every hit must be dealt with (including `doc/readme.features` if it documents REGISTER_SERVER).

**Interfaces:**
- Consumes: `kc_user_search` (`kc_keycloak.h:153`), `kc_user_create_full`/`kc_user_send_verify_email`/`KC_CONFLICT` (Task 2), `scram_sha256_derive_random`/`kc_pbkdf2_cred_build` (Task 1), cookie pattern (`m_authenticate.c:190-193`).
- Produces: `FEAT_REGISTER_VERIFY_EMAIL` (swaps Task 3's stub), `cap_set_value()` in m_cap.c.

- [ ] **Step 1: Feature swap (both files, same position)**

`include/ircd_features.h:366`: replace `FEAT_REGISTER_SERVER,` with `FEAT_REGISTER_VERIFY_EMAIL,`. In `ircd/ircd_features.c` at the exactly corresponding table row (`:1211`): replace `F_S(REGISTER_SERVER, 0, "*", 0)`-style entry with `F_B(REGISTER_VERIFY_EMAIL, 0, 0, feature_notify_accountreg_capvalue)` (notify function added in Step 2; copy the exact `F_S`/`F_B` argument shapes from neighboring lines — read them, the signatures here are from memory). Build will assert at boot if order drifts — that is the guard working.

- [ ] **Step 2: CAP value plumbing**

`ircd/m_cap.c`: change the static value at `:364` to
`"before-connect,custom-account-name,min-password-length=5,max-password-length=300"`,
and add (near the capab list helpers):

```c
/* Overwrite a capability's advertised value at runtime (fits entry->value,
 * m_cap.c:135). Used by draft/account-registration to toggle email-required. */
void cap_set_value(unsigned int cap, const char *value)
{
  int i;
  for (i = 0; capab_list[i].name; i++) {
    if (capab_list[i].cap == cap) {
      ircd_strncpy(capab_list[i].value, value, sizeof(capab_list[i].value) - 1);
      return;
    }
  }
}
```

(Adapt the array/type names to what `m_cap.c` actually calls them — the entry struct with `value[]` is at `:135` context.) Declare in the header where other m_cap externs live (grep `cli_capab` users / `include/capab.h`). Then in `m_register.c`:

```c
void feature_notify_accountreg_capvalue(void)
{
  cap_set_value(CAP_DRAFT_ACCOUNTREG,
                feature_bool(FEAT_REGISTER_VERIFY_EMAIL)
                ? "before-connect,custom-account-name,email-required,"
                  "min-password-length=5,max-password-length=300"
                : "before-connect,custom-account-name,"
                  "min-password-length=5,max-password-length=300");
}
```

(Confirm the notify hook signature by reading an existing `F_B(..., notify)` user — e.g. the CAP feature notify at `ircd_features.c:591`.)

- [ ] **Step 3: Rewrite m_register.c — the local flow**

Replace the relay machinery wholesale. Core structure (full code — adapt names only where existing helpers differ):

```c
/* Async registration context. No plaintext: all credential material is
 * derived before the first async hop. Client refind is fd+cookie (the SASL
 * pattern) — the callback tolerates the client being gone. */
struct reg_ctx {
  int fd;
  unsigned int cookie;
  int stage;                       /* 0=search, 1=create, 2=verify-email */
  int verify_email;                /* policy snapshot at REGISTER time */
  char account[ACCOUNTLEN + 1];
  char email[201];
  char *cred_data, *secret_data;   /* Task 1 outputs; freed in ctx free */
  struct scram_sha256_creds scram;
};

static struct Client *reg_ctx_client(struct reg_ctx *ctx)
{
  struct Client *acptr;
  if (ctx->fd < 0 || ctx->fd >= MAXCONNECTIONS)
    return NULL;
  acptr = LocalClientArray[ctx->fd];
  if (!acptr || cli_saslcookie(acptr) != ctx->cookie)
    return NULL;
  return acptr;
}

static void reg_ctx_free(struct reg_ctx *ctx)
{
  if (ctx->cred_data) free(ctx->cred_data);
  if (ctx->secret_data) free(ctx->secret_data);
  memset(&ctx->scram, 0, sizeof(ctx->scram));
  MyFree(ctx);
}

/* Completion tail — the old ms_regreply 'S' arm, verbatim semantics
 * (m_register.c:415-445 pre-rewrite). */
static void register_complete_success(struct Client *acptr, const char *account)
{
  if (IsRegistered(acptr)) {
    if (!IsAccount(acptr) && cli_user(acptr)) {
      ircd_strncpy(cli_user(acptr)->account, account,
                   sizeof(cli_user(acptr)->account) - 1);
      SetAccount(acptr);
      metadata_load_account(acptr, cli_user(acptr)->account);
      sendrawto_one(acptr, "REGISTER SUCCESS %s :Account registered", account);
      sendcmdto_common_channels_capab_butone(acptr, CMD_ACCOUNT, acptr,
                                             CAP_ACCNOTIFY, CAP_NONE,
                                             "%s", account);
    }
  } else {
    ircd_strncpy(cli_saslaccount(acptr), account, ACCOUNTLEN + 1);
    SetSASLComplete(acptr);
    if (cli_auth(acptr))
      auth_set_account(cli_auth(acptr), account);
    sendrawto_one(acptr, "REGISTER SUCCESS %s :Account registered", account);
  }
}

/* stage 2 — verify-email trigger result: ALWAYS non-fatal */
static void reg_email_cb(int result, void *data)
{
  struct reg_ctx *ctx = data;
  struct Client *acptr = reg_ctx_client(ctx);
  if (result != KC_SUCCESS)
    log_write(LS_SYSTEM, L_WARNING, 0,
              "REGISTER: send-verify-email failed for %s (result %d) - "
              "account state is correct; verification completable out-of-band",
              ctx->account, result);
  if (acptr)
    sendrawto_one(acptr, "REGISTER VERIFICATION_REQUIRED %s :Account created - "
                  "check your email for a verification link, then log in "
                  "normally (SASL)", ctx->account);
  reg_ctx_free(ctx);
}

/* stage 1 — create result */
static void reg_create_cb(int result, void *data)
{
  struct reg_ctx *ctx = data;
  struct Client *acptr = reg_ctx_client(ctx);

  if (result != KC_SUCCESS) {
    if (acptr) {
      if (result == KC_CONFLICT)
        send_fail(acptr, "REGISTER", "ACCOUNT_EXISTS", ctx->account,
                  "Account already exists");
      else
        send_fail(acptr, "REGISTER", "TEMPORARILY_UNAVAILABLE", ctx->account,
                  "Registration is temporarily unavailable");
    }
    reg_ctx_free(ctx);
    return;
  }

  if (ctx->verify_email) {
    /* Need the new user's id for the send-verify-email URL: search by the
     * exact username we just created. */
    ctx->stage = 2;
    if (kc_user_search(ctx->account, 1, reg_verify_lookup_cb, ctx) != 0)
      reg_email_cb(KC_ERROR, ctx);   /* still non-fatal: state is correct */
    return;
  }

  if (acptr)
    register_complete_success(acptr, ctx->account);
  reg_ctx_free(ctx);
}
```

Plus `reg_verify_lookup_cb` (a `kc_user_cb` receiving the `struct kc_user *`; on success calls `kc_user_send_verify_email(user->id, reg_email_cb, ctx)`, on failure `reg_email_cb(KC_ERROR, ctx)`), and stage 0:

```c
/* stage 0 — existence check result (kc_user_cb) */
static void reg_search_cb(int result, struct kc_user *user, void *data)
{
  struct reg_ctx *ctx = data;
  struct Client *acptr = reg_ctx_client(ctx);
  struct kc_user_create_req req;
  const char *keys[4] = { "scram_sha256_salt", "scram_sha256_iterations",
                          "scram_sha256_stored_key", "scram_sha256_server_key" };
  char iterbuf[16];
  const char *vals[4];

  if (result == KC_SUCCESS && user) {          /* name taken */
    if (acptr)
      send_fail(acptr, "REGISTER", "ACCOUNT_EXISTS", ctx->account,
                "Account already exists");
    reg_ctx_free(ctx);
    return;
  }
  if (result != KC_NOT_FOUND) {                /* connectivity trouble */
    if (acptr)
      send_fail(acptr, "REGISTER", "TEMPORARILY_UNAVAILABLE", ctx->account,
                "Registration is temporarily unavailable");
    reg_ctx_free(ctx);
    return;
  }

  ircd_snprintf(0, iterbuf, sizeof(iterbuf), "%d", ctx->scram.iterations);
  vals[0] = ctx->scram.salt_b64;   vals[1] = iterbuf;
  vals[2] = ctx->scram.stored_key_b64; vals[3] = ctx->scram.server_key_b64;

  memset(&req, 0, sizeof(req));
  req.username = ctx->account;
  req.email = ctx->email[0] ? ctx->email : NULL;
  req.cred_data = ctx->cred_data;
  req.secret_data = ctx->secret_data;
  req.set_email_verified = ctx->verify_email;
  req.attr_keys = keys; req.attr_values = vals; req.n_attrs = 4;

  ctx->stage = 1;
  if (kc_user_create_full(&req, reg_create_cb, ctx) != 0) {
    if (acptr)
      send_fail(acptr, "REGISTER", "TEMPORARILY_UNAVAILABLE", ctx->account,
                "Registration is temporarily unavailable");
    reg_ctx_free(ctx);
  }
}
```

Check the exact `kc_user_search` callback typedef in `kc_keycloak.h` (it may deliver a list; adapt: any hit ⇒ taken, `KC_NOT_FOUND`/empty ⇒ free). The new `m_register()` body keeps the existing gates (`:162-221`) and adds, in order: account-name grammar (each char `IsNickChar()` from `ircd_chattr.h`, reject otherwise with `BAD_ACCOUNT_NAME`); email handling (policy on: `*`/empty ⇒ `send_fail(..., "INVALID_EMAIL", ...)`; non-empty must contain `@` and no spaces and fit `ctx->email`); then, replacing `find_services_server()`+`send_register_rg`:

```c
  if (!sasl_local_available()) {   /* kc not configured/initialized */
    send_fail(sptr, "REGISTER", "TEMPORARILY_UNAVAILABLE", account,
              "Registration service is not available");
    return 0;
  }
  if (!cli_saslcookie(cptr)) {     /* real cookie for async refind (SASL pattern) */
    do {
      cli_saslcookie(cptr) = ircrandom() & 0x7fffffff;
    } while (!cli_saslcookie(cptr));
  }
  ctx = (struct reg_ctx *)MyMalloc(sizeof(*ctx));
  memset(ctx, 0, sizeof(*ctx));
  ctx->fd = cli_fd(cptr);
  ctx->cookie = cli_saslcookie(cptr);
  ctx->verify_email = feature_bool(FEAT_REGISTER_VERIFY_EMAIL);
  ircd_strncpy(ctx->account, account, sizeof(ctx->account) - 1);
  if (email && strcmp(email, "*") != 0)
    ircd_strncpy(ctx->email, email, sizeof(ctx->email) - 1);
  if (scram_sha256_derive_random(password, &ctx->scram) != 0 ||
      kc_pbkdf2_cred_build(password, &ctx->cred_data, &ctx->secret_data) != 0) {
    send_fail(sptr, "REGISTER", "TEMPORARILY_UNAVAILABLE", account,
              "Registration is temporarily unavailable");
    reg_ctx_free(ctx);
    return 0;
  }
  /* plaintext no longer needed past this point */
  if (kc_user_search(ctx->account, 1, reg_search_cb, ctx) != 0) {
    send_fail(sptr, "REGISTER", "TEMPORARILY_UNAVAILABLE", account,
              "Registration is temporarily unavailable");
    reg_ctx_free(ctx);
  }
  return 0;
```

`m_verify()` becomes the graceful decline (keep the feature/params/`ALREADY_AUTHENTICATED` gates):

```c
  send_fail(sptr, "VERIFY", "INVALID_CODE", account,
            "Verification is completed via the link in your email - "
            "after clicking it, log in normally (SASL)");
  return 0;
```

Delete: `find_services_server`, `send_register_rg`, `send_verify_vf`, `ms_regreply`, `find_prereg_client` (its job is now `reg_ctx_client`), the `LocalClientArray` extern stays (used by `reg_ctx_client`). Update the file header comment (no more relay). Add includes: `kc/kc_keycloak.h`, `kc/kc_cred_derive.h`, `ircd_chattr.h`.

- [ ] **Step 4: Delete the wire tokens**

`include/msg.h:546-549`: remove `MSG_REGREPLY`/`TOK_REGREPLY`/`CMD_REGREPLY`. `ircd/parse.c:1013-1019`: remove the REGREPLY message-table block. Keep the REGISTER/VERIFY blocks (client commands) — their MSG_/TOK_ defines stay. Run the grep from the Files section; fix every remaining hit including docs.

- [ ] **Step 5: Swap Task 3's stub**

In `sasl_auth.c`, replace `register_verify_email_policy()`'s body with `return feature_bool(FEAT_REGISTER_VERIFY_EMAIL);` (or inline the call and delete the stub).

- [ ] **Step 6: Build + boot smoke**

Run: `make` — clean, boundary check green. Boot smoke: the feature-order assert passes (start the binary against a scratch conf or lean on the Docker gate in Task 6).

- [ ] **Step 7: Commit**

```bash
cd nefarious && git add ircd/m_register.c ircd/m_cap.c ircd/parse.c ircd/sasl_auth.c \
        ircd/ircd_features.c include/ircd_features.h include/msg.h include/capab.h doc/
git commit -m "register: local Keycloak flow (in-house creds, link verification, policy CAP value); delete RG/VF/RR relay"
```

---

### Task 5: SPI adaptation — attribute rename + contract re-point

**Files:**
- Modify: `keycloak-webhook-spi/src/main/java/net/afternet/keycloak/webhook/ScramCredentialProvider.java` (`:57-60` constants, class javadoc `:27-44`), `ScramPasswordPolicyProvider.java` (`:52-56` constants, javadoc `:21-39`), `WebhookEventListenerProvider.java` (its scram-attribute reads for credential-change events, `:151-158` — update names)

**Interfaces:**
- Consumes: canonical names from Global Constraints. Produces: SPI writing `scram_sha256_*`.

- [ ] **Step 1: Rename the attribute constants**

In both provider files change the four constants' values (`x3_scram_salt` → `scram_sha256_salt`, `x3_scram_iterations` → `scram_sha256_iterations`, `x3_scram_stored_key` → `scram_sha256_stored_key`, `x3_scram_server_key` → `scram_sha256_server_key`). Update `WebhookEventListenerProvider`'s reads to reference the provider constants rather than string literals if they don't already (grep `x3_scram` across `src/`— zero hits when done).

- [ ] **Step 2: Re-point the contract commentary**

Replace the "so X3 can update its SCRAM cache" javadoc framing in both providers with the real contract: *consumed by the Nefarious ircd's SASL SCRAM-SHA-256 path; derivation parameters (SHA-256, 4096 iterations, 16-byte salt) are in lockstep with `nefarious/ircd/kc/kc_cred_derive.c` — change one, change both.* Same note goes in the README if it mentions the old names.

- [ ] **Step 3: Build the SPI and redeploy**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build keycloak-spi-build && scripts/dc.sh up -d keycloak
```

(Confirm the SPI build/deploy flow from `docker-compose.yml`'s `keycloak-spi-build` service definition — if it is a build-stage-only service, the sequence may be `scripts/dc.sh up keycloak-spi-build` then restart `keycloak`.) Verify via `scripts/dc.sh logs keycloak | grep -i scram` that the providers registered.

- [ ] **Step 4: Sanity: web-flow password change writes new names**

Change the seeded test user's password via admin REST (`PUT /users/{id}/reset-password` with a plaintext value — this traverses the credential chain), then `GET /users/{id}` and assert attributes now include `scram_sha256_*`.

- [ ] **Step 5: Commit**

```bash
cd keycloak-webhook-spi && git checkout -b feature/scram-attr-rename
git add src README.md && git commit -m "scram: rename attributes to scram_sha256_* and re-point contract at the ircd"
```

---

### Task 6: Deploy + E2E suite

**Files:**
- Create: `tests/src/ircv3/account-registration.test.ts`
- Modify: `tests/src/ircv3/sasl.test.ts:288-291` (unskip + adapt), one leaf server conf in `data/` for the verification-on leg (pick `ircd2.conf` (user-ratified: nefarious2, NOT the CRDT-fleet nefarious4); add `"REGISTER_VERIFY_EMAIL" = "TRUE";` to its Features block — copy the syntax of existing feature lines in that file)

**Interfaces:**
- Consumes: helpers `getKeycloakAdminToken` (`tests/src/helpers/keycloak-sync.ts:281`), `performSaslAuth`/`authenticateSaslPlain` (`tests/src/helpers/sasl.ts`), the ircv3 client helpers used by neighboring tests in `tests/src/ircv3/` (open one — e.g. `channel-relocate.test.ts` — and copy its connection/setup idiom).

- [ ] **Step 1: Rebuild and deploy the affected servers**

BED TRAP (from memory): each nefarious3-7 has its OWN compose image; scope builds and `up -d` to exactly the touched services. For this suite: `nefarious` (C-mode tests) and the chosen verification-on server (user-ratified: `nefarious2`):

```bash
scripts/dc.sh -l build nefarious nefarious2 && scripts/dc.sh -l up -d nefarious nefarious2
```

Confirm boot (no feature-order assert): `scripts/dc.sh logs nefarious | tail -20`.

- [ ] **Step 2: Write the C-mode (verification off) E2E — run it, expect fail before deploy verified**

`tests/src/ircv3/account-registration.test.ts` — skeleton (fill connection boilerplate from a neighboring suite; assert shapes shown are the contract):

```typescript
// C-mode: REGISTER -> SUCCESS -> Keycloak/LDAP state -> SASL PLAIN + SCRAM on fresh conn
it('registers an account end-to-end (verification off)', async () => {
  const acct = uniqueName('regtest');
  const client = await connectRawWithCaps(['draft/account-registration']);
  await client.send(`REGISTER ${acct} reg-${acct}@test.invalid hunter22xyz`);
  const reply = await client.waitFor(/^REGISTER SUCCESS /, 15000);
  expect(reply).toContain(`REGISTER SUCCESS ${acct}`);

  // Keycloak state: user exists, scram attributes seeded with NEW names
  const token = await getKeycloakAdminToken();
  const user = await kcGetUserByUsername(token, acct);      // small local helper via fetch
  expect(user).toBeTruthy();
  for (const k of ['scram_sha256_salt', 'scram_sha256_iterations',
                   'scram_sha256_stored_key', 'scram_sha256_server_key'])
    expect(user.attributes?.[k]?.[0]).toBeTruthy();

  // LDAP write-through observation point (Task 0 recorded the expectation)
  const ldif = execSync(`docker exec openldap ldapsearch -x ... "(uid=${acct})"`).toString();
  expect(ldif).toContain(`uid=${acct}`);

  // Fresh connections: PLAIN and SCRAM both log in
  await expectSaslPlainSuccess(acct, 'hunter22xyz');
  await expectSaslScramSuccess(acct, 'hunter22xyz');
});
```

Also: duplicate REGISTER ⇒ `FAIL REGISTER ACCOUNT_EXISTS`; bad name ⇒ `BAD_ACCOUNT_NAME`; short password ⇒ `WEAK_PASSWORD`; `VERIFY` ⇒ `FAIL VERIFY INVALID_CODE`; CAP value contains `min-password-length=5`. Pre-reg leg: send REGISTER before completing connection registration, then finish NICK/USER and assert the connection carries the account (numeric 900/ACCOUNT per the S-arm path).

Run: `IRC_HOST=localhost npm test -- src/ircv3/account-registration.test.ts`

- [ ] **Step 3: Verification-on leg (against the feature-on server)**

Same file, separate describe targeting the verification-on server's port:

```typescript
it('gates unverified accounts (verification on)', async () => {
  const acct = uniqueName('regv');
  // REGISTER -> VERIFICATION_REQUIRED (email required in this mode)
  // Admin REST: emailVerified === false, requiredActions includes VERIFY_EMAIL
  // SASL PLAIN fails; failure line mentions verification, NOT a bare wrong-password
  // Flip via admin REST: emailVerified true + requiredActions []  (what the emailed link does)
  // SASL PLAIN now succeeds; SCRAM also succeeds
  // REGISTER with email '*' => FAIL REGISTER INVALID_EMAIL
});
```

Note in the test header: the send-verify-email call fails against the mailer-less realm by design — assert registration still returned `VERIFICATION_REQUIRED` (non-fatality is thereby proven). CAP value on this server must contain `email-required`.

- [ ] **Step 4: Unskip the sasl.test.ts registration test**

Remove `.skip` at `tests/src/ircv3/sasl.test.ts:288-291`, delete the stale "X3 does not support" comment, and align its expectations with the new reply shapes (it expects numeric 920 — check what the S-arm actually emits and fix the expectation to `REGISTER SUCCESS`).

- [ ] **Step 5: Run the full new suite 3× (flake check)**

Run: `IRC_HOST=localhost npm test -- src/ircv3/account-registration.test.ts src/ircv3/sasl.test.ts` (three consecutive runs)
Expected: green ×3.

- [ ] **Step 6: irctest conformance cross-check**

Run the upstream conformance file (`nefarious/.irctest/irctest/server_tests/account_registration.py`) per the irctest harness's README in `.irctest/`. NEVER edit irctest files; divergences are fixed server-side or documented.

- [ ] **Step 7: Commit (testnet)**

```bash
cd /home/ibutsu/testnet
git add tests/src/ircv3/account-registration.test.ts tests/src/ircv3/sasl.test.ts data/ircd2.conf
git commit -m "tests: account-registration E2E (C-mode + verification-on leg); unskip sasl REGISTER test"
```

- [ ] **Step 8: STOP — report to user**

Report: suite results, LDAP write-through findings vs Task 0, and ask about pushing branches / PR targets / whether to fold `FEAT_CAP_draft_account_registration` default-on into bed confs beyond the current state. Do not push anything.

---

## Self-review (done at plan-writing time)

- **Spec coverage:** flow steps 1-5 → Task 4; SCRAM seeding + rename → Tasks 1/2/4/5; enforcement (KC_UNVERIFIED, SCRAM gate, no-negcache) → Tasks 2/3; relay deletion → Task 4; CAP value/policy knob → Task 4; LDAP write-through + import-format verification → Task 0 (+ Task 6 observation); testing section → Tasks 1/2/6; accepted-limitation updates → Task 0 Step 5.
- **Known soft spots (deliberate):** exact `F_B`/`F_S` argument shapes, `kc_user_search` callback typedef, kc HTTP `resp->json` population for non-200, capab entry field names, SPI deploy sequence — each is marked with a read-first instruction at the point of use rather than guessed signatures.
- **Type consistency:** `scram_sha256_creds`/`kc_user_create_req`/`kc_classify_grant_error` names match across Tasks 1-4; attribute names match Global Constraints everywhere.
