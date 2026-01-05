# Password Hashing Upgrade Plan

## Problem Statement

X3 currently uses a custom MD5-based password hashing scheme that:
1. Is cryptographically weak (MD5 is broken for security purposes)
2. Incompatible with Keycloak credential import (Keycloak needs plaintext to hash)
3. Creates inconsistent registration flow when Keycloak is enabled

## Goals

1. Support modern, secure password hashing algorithms
2. Enable Keycloak credential import (hash format Keycloak understands)
3. Support OpenLDAP password formats for LDAP integration
4. Maintain backward compatibility with existing MD5-hashed passwords
5. Enable lazy migration to new hash format on login

## Algorithm Support Matrix

| Algorithm | OpenSSL 3.0 | Keycloak | OpenLDAP | Priority |
|-----------|-------------|----------|----------|----------|
| PBKDF2-SHA256 | ✅ EVP_KDF | ✅ | ✅ {PBKDF2-SHA256} | **Primary** |
| PBKDF2-SHA512 | ✅ EVP_KDF | ✅ | ✅ {PBKDF2-SHA512} | Primary |
| bcrypt | ❌ (libcrypt) | ✅ | ✅ {BCRYPT} | Secondary |
| Argon2 | ✅ (3.0+) | ✅ | ✅ {ARGON2} | Future |
| MD5 (legacy) | ✅ | ❌ | ❌ | Legacy only |

**Recommendation**: Use PBKDF2-SHA256 as primary - it's supported everywhere via OpenSSL EVP_KDF, no extra dependencies needed.

## Hash Format Design

Use a modular crypt format that encodes algorithm, parameters, salt, and hash:

```
$algorithm$params$salt$hash

Examples:
$pbkdf2-sha256$i=100000$BASE64_SALT$BASE64_HASH
$pbkdf2-sha512$i=100000$BASE64_SALT$BASE64_HASH
$2b$12$BASE64_SALT_AND_HASH                       # bcrypt
$argon2id$v=19$m=65536,t=3,p=4$SALT$HASH          # argon2
$1$SEED$HASH                                      # legacy X3 MD5
$MD5_HEX                                          # legacy plain MD5
```

The `$algorithm$` prefix enables format detection for:
- Lazy migration on login
- Multi-algorithm support
- Future algorithm upgrades

## Keycloak Credential Import Format

When creating users in Keycloak with pre-hashed passwords:

```json
{
  "username": "user",
  "credentials": [{
    "type": "password",
    "credentialData": "{\"algorithm\":\"pbkdf2-sha256\",\"hashIterations\":100000}",
    "secretData": "{\"value\":\"BASE64_HASH\",\"salt\":\"BASE64_SALT\"}"
  }]
}
```

## Implementation Phases

### Phase 1: Core Password Module

Create new `src/password.c` and `src/password.h`:

```c
/* Algorithm identifiers */
enum pw_algorithm {
    PW_ALG_UNKNOWN = 0,
    PW_ALG_MD5_LEGACY,      /* Legacy X3 MD5 */
    PW_ALG_MD5_PLAIN,       /* Plain MD5 hex */
    PW_ALG_PBKDF2_SHA256,   /* PBKDF2-SHA256 (recommended) */
    PW_ALG_PBKDF2_SHA512,   /* PBKDF2-SHA512 */
    PW_ALG_BCRYPT,          /* bcrypt (requires libcrypt) */
    PW_ALG_ARGON2ID,        /* Argon2id (requires OpenSSL 3.2+) */
};

/* Configuration */
struct pw_config {
    enum pw_algorithm default_algorithm;
    int pbkdf2_iterations;       /* Default: 100000 */
    int bcrypt_cost;             /* Default: 12 */
    int enable_lazy_migration;   /* Rehash on successful login */
};

/* API */
int pw_hash(const char *password, char *output, size_t output_len);
int pw_verify(const char *password, const char *hash);
int pw_needs_rehash(const char *hash);
enum pw_algorithm pw_detect_algorithm(const char *hash);
int pw_export_keycloak(const char *hash, char *cred_data, char *secret_data);
int pw_export_ldap(const char *hash, char *ldap_hash);
```

### Phase 2: PBKDF2 Implementation

Using OpenSSL 3.0 EVP_KDF API:

```c
#include <openssl/evp.h>
#include <openssl/kdf.h>

int pbkdf2_sha256(const char *pass, const unsigned char *salt,
                  size_t salt_len, int iterations,
                  unsigned char *out, size_t out_len) {
    EVP_KDF *kdf = EVP_KDF_fetch(NULL, "PBKDF2", NULL);
    EVP_KDF_CTX *ctx = EVP_KDF_CTX_new(kdf);

    OSSL_PARAM params[] = {
        OSSL_PARAM_construct_utf8_string("digest", "SHA256", 0),
        OSSL_PARAM_construct_octet_string("pass", (void*)pass, strlen(pass)),
        OSSL_PARAM_construct_octet_string("salt", (void*)salt, salt_len),
        OSSL_PARAM_construct_int("iter", &iterations),
        OSSL_PARAM_construct_end()
    };

    int ret = EVP_KDF_derive(ctx, out, out_len, params);

    EVP_KDF_CTX_free(ctx);
    EVP_KDF_free(kdf);
    return ret;
}
```

### Phase 3: Lazy Migration Integration

Modify `checkpass()` in nickserv.c:

```c
int checkpass_with_migration(const char *pass, struct handle_info *hi) {
    if (!pw_verify(pass, hi->passwd))
        return 0;  /* Wrong password */

    /* Successful login - check if rehash needed */
    if (pw_config.enable_lazy_migration && pw_needs_rehash(hi->passwd)) {
        char new_hash[PW_MAX_HASH_LEN];
        if (pw_hash(pass, new_hash, sizeof(new_hash)) == 0) {
            safestrncpy(hi->passwd, new_hash, sizeof(hi->passwd));
            /* Note: Database will be written on next sync */
        }
    }

    return 1;  /* Password valid */
}
```

### Phase 4: Keycloak Integration

Modify `kc_do_add()` to use credential import:

```c
int kc_do_add_with_hash(const char *handle, const char *hash, const char *email) {
    char cred_data[256], secret_data[512];

    if (pw_export_keycloak(hash, cred_data, secret_data) != 0) {
        /* Unsupported hash format, can't import */
        return KC_ERROR;
    }

    /* Build JSON with credentials */
    cJSON *user = cJSON_CreateObject();
    cJSON *creds = cJSON_CreateArray();
    cJSON *cred = cJSON_CreateObject();

    cJSON_AddStringToObject(cred, "type", "password");
    cJSON_AddRawToObject(cred, "credentialData", cred_data);
    cJSON_AddRawToObject(cred, "secretData", secret_data);
    cJSON_AddItemToArray(creds, cred);
    cJSON_AddItemToObject(user, "credentials", creds);

    /* POST to Keycloak admin API */
    return kc_create_user_with_json(user);
}
```

### Phase 5: Cookie Activation Fix

With PBKDF2 hashes that Keycloak understands:

1. **Registration**: Hash password with PBKDF2, store in cookie
2. **Cookie stores**: The PBKDF2 hash (not plaintext)
3. **Activation**: Import hash to Keycloak via credential API
4. **Result**: Consistent flow, no plaintext ever sent to Keycloak

### Phase 6: Configuration

Add to nickserv.conf:

```
"password_algorithm" "pbkdf2-sha256";  /* pbkdf2-sha256, pbkdf2-sha512, bcrypt */
"password_pbkdf2_iterations" "100000";
"password_bcrypt_cost" "12";
"password_lazy_migration" "1";         /* Rehash old passwords on login */
```

### Phase 7: Migration Tools

Create `tools/migrate-passwords.py`:

```python
#!/usr/bin/env python3
"""
Analyze password hash distribution in x3.db
Report how many accounts use each algorithm
Optionally force migration for accounts that haven't logged in
"""
```

## Testing Plan

1. **Unit tests** for password module:
   - Hash generation for each algorithm
   - Verification with known test vectors
   - Cross-verification (hash with one, verify with another fails)
   - Keycloak export format validation
   - LDAP export format validation

2. **Integration tests**:
   - Register with new algorithm, verify login works
   - Login with legacy MD5 hash, verify migration occurs
   - Keycloak credential import works
   - Cookie activation with PBKDF2 hash

3. **Performance tests**:
   - Measure hash time for different iteration counts
   - Ensure login doesn't become too slow under load

## Rollout Strategy

1. **Phase 1**: Deploy with lazy migration disabled, new algorithm for new accounts
2. **Phase 2**: Enable lazy migration, existing users migrate on login
3. **Phase 3**: After X months, run migration tool for dormant accounts
4. **Phase 4**: Eventually deprecate MD5 support (major version)

## Security Considerations

- PBKDF2 with 100,000 iterations is OWASP-recommended minimum (2023)
- Salt should be 16+ bytes of cryptographically random data
- Never log passwords or hashes in debug output
- Constant-time comparison for hash verification
- Rate limiting on login attempts (already exists)

## Dependencies

**Required** (already available):
- OpenSSL 3.0+ (Debian 12 has 3.0.17)
- libcrypt (for bcrypt) - already in Debian 12 base system

**Optional**:
- libargon2 (for argon2 on older OpenSSL) - `apt install libargon2-dev`

## Code Reuse from Nefarious

Nefarious has a modular `ircd_crypt` system we can adapt:

**Files to reference:**
| File | Purpose |
|------|---------|
| `nefarious/ircd/ircd_crypt_bcrypt.c` | Clean bcrypt using system `crypt()` |
| `nefarious/ircd/ircd_crypt.c` | Modular dispatcher with constant-time comparison |
| `nefarious/include/ircd_crypt.h` | Mechanism registration API |

**Key patterns to adopt:**
1. **Token-based detection** - `$2y$` for bcrypt, `$pbkdf2-sha256$` for PBKDF2
2. **`CRYPTO_memcmp`** - OpenSSL's constant-time comparison (prevents timing attacks)
3. **Salt generation** - Uses `/dev/urandom` directly
4. **Modular registration** - Each algorithm registers via `crypt_mech_t` struct

**Bcrypt implementation highlights (from `ircd_crypt_bcrypt.c`):**
- Uses system `crypt()` which supports bcrypt on modern Linux
- Generates 16 random bytes for salt from `/dev/urandom`
- Encodes to bcrypt's custom base64 alphabet (`./A-Za-z0-9`)
- Supports `$2a$`, `$2b$`, `$2y$` variants
- Default cost factor 12 (4096 iterations)

This means bcrypt support is essentially free - we adapt the Nefarious code for X3's build system.

**Updated Algorithm Support Matrix:**

| Algorithm | OpenSSL 3.0 | libcrypt | Keycloak | OpenLDAP | Priority |
|-----------|-------------|----------|----------|----------|----------|
| bcrypt | - | ✅ (Nef code) | ✅ | ✅ | **Primary** |
| PBKDF2-SHA256 | ✅ EVP_KDF | - | ✅ | ✅ | Primary |
| PBKDF2-SHA512 | ✅ EVP_KDF | - | ✅ | ✅ | Primary |
| Argon2 | ✅ (3.2+) | - | ✅ | ✅ | Future |
| MD5 (legacy) | ✅ | - | ❌ | ❌ | Legacy only |

**Revised Recommendation**: Use **bcrypt** as primary since we have working code from Nefarious. Add PBKDF2 as secondary for Keycloak credential import flexibility.

## Files to Modify

| File | Changes |
|------|---------|
| `src/password.c` | **New** - Core password hashing module |
| `src/password.h` | **New** - Header file |
| `src/Makefile.am` | Add password.c to build |
| `src/nickserv.c` | Replace cryptpass/checkpass calls, add migration |
| `src/md5.c` | Keep for legacy support, deprecate |
| `src/keycloak.c` | Add credential import support |
| `src/conf.h` | Add password config options |
| `configure.ac` | Check for OpenSSL KDF support |

## Estimated Complexity

- Phase 1-2 (Core + PBKDF2): Medium - OpenSSL API is well-documented
- Phase 3 (Migration): Low - Simple wrapper around existing code
- Phase 4 (Keycloak): Medium - Need to understand Keycloak admin API
- Phase 5 (Cookie fix): Low - Just change what's stored in cookie
- Phase 6-7 (Config/Tools): Low

## Open Questions

1. Should we support argon2id immediately or defer?
2. What iteration count to use? (100k is OWASP 2023 minimum)
3. Should bcrypt be optional (requires libcrypt) or mandatory?
4. How long to support legacy MD5? Deprecation timeline?

---

## Nefarious PBKDF2 Implementation

Adding PBKDF2 support to Nefarious follows the existing modular crypt pattern. This enables consistent password hashing between Nefarious (oper passwords) and X3 (user passwords).

### Files to Create

| File | Purpose |
|------|---------|
| `ircd/ircd_crypt_pbkdf2.c` | PBKDF2-SHA256/512 implementation using OpenSSL EVP_KDF |
| `include/ircd_crypt_pbkdf2.h` | Header with `ircd_register_crypt_pbkdf2()` declaration |

### Implementation Pattern

Follow the bcrypt module structure:

```c
/* ircd_crypt_pbkdf2.c */
#include "config.h"
#include "ircd_crypt.h"
#include "ircd_crypt_pbkdf2.h"
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/params.h>
#include <openssl/rand.h>

#define PBKDF2_SALT_LEN 16
#define PBKDF2_HASH_LEN 32
#define PBKDF2_ITERATIONS 100000

/* Token: $PBKDF2$ for mechanism detection */
const char* ircd_crypt_pbkdf2(const char* key, const char* salt);
void ircd_register_crypt_pbkdf2(void);
```

### Hash Format

```
$PBKDF2$iterations$base64_salt$base64_hash

Example:
$PBKDF2$100000$cHJvamVjdF9zYWx0X18$aGFzaGVkX3Bhc3N3b3Jk...
```

### Build System Changes

**Makefile.in** (line ~76-81):
```makefile
CRYPTO_SRC = \
    ircd_md5.c \
    ircd_crypt_plain.c \
    ircd_crypt_smd5.c \
    ircd_crypt_native.c \
    ircd_crypt_bcrypt.c \
    ircd_crypt_pbkdf2.c   # Add this
```

**Dependency rule** (add near line 519):
```makefile
ircd_crypt_pbkdf2.o: ircd_crypt_pbkdf2.c ../config.h ../include/ircd_crypt.h \
  ../include/ircd_crypt_pbkdf2.h ../include/ircd_log.h ../include/s_debug.h \
  ../include/ircd_alloc.h
```

### Registration Points

**ircd_crypt.c** (`ircd_crypt_init()`, line ~259):
```c
ircd_register_crypt_smd5();
ircd_register_crypt_plain();
ircd_register_crypt_native();
ircd_register_crypt_bcrypt();
ircd_register_crypt_pbkdf2();  /* Add this */
```

**umkpasswd.c** (line ~280):
```c
ircd_register_crypt_native();
ircd_register_crypt_smd5();
ircd_register_crypt_plain();
ircd_register_crypt_bcrypt();
ircd_register_crypt_pbkdf2();  /* Add this */
```

### OpenSSL Dependencies

Already satisfied - `configure.in` links `-lssl -lcrypto` when SSL is enabled (default).

OpenSSL 3.0 EVP_KDF API required:
- `EVP_KDF_fetch(NULL, "PBKDF2", NULL)`
- `EVP_KDF_CTX_new()` / `EVP_KDF_CTX_free()`
- `EVP_KDF_derive()`
- `OSSL_PARAM` for parameters

Salt generation: Use `RAND_bytes()` from OpenSSL (preferred over `/dev/urandom` for portability).

**Note**: Existing salted mechanisms use `/dev/urandom` directly:
- `ircd_crypt_bcrypt.c` - `get_random_bytes()` reads from `/dev/urandom`
- `ircd_crypt_smd5.c` - likely similar pattern for salt generation

For consistency, all salted mechanisms should be updated to use `RAND_bytes()`. This is a minor refactor but ensures uniform random number generation across all crypt modules and better portability.

### Testing

Add to `ircd/test/ircd_crypt_cmocka.c`:

```c
/* Test vectors from RFC 6070 */
static void test_pbkdf2_rfc6070_vector1(void **state) {
    /* P = "password", S = "salt", c = 1, dkLen = 20 */
    /* Expected: 0c60c80f961f0e71f3a9b524af6012062fe037a6 */
}

static void test_pbkdf2_hash_and_verify(void **state) {
    const char *password = "testpassword123";
    char *hash = ircd_crypt_pbkdf2(password, "$PBKDF2$");
    assert_non_null(hash);
    assert_true(strncmp(hash, "$PBKDF2$", 8) == 0);

    /* Verify */
    char *verify = ircd_crypt_pbkdf2(password, hash);
    assert_string_equal(hash, verify);
}
```

### Complexity Assessment

- **Core implementation**: Low-Medium - OpenSSL EVP_KDF is straightforward
- **Base64 encoding**: Low - Can reuse existing `to64()` pattern or standard base64
- **Testing**: Low - Known test vectors available from RFC 6070
- **Build integration**: Low - Follow existing bcrypt pattern exactly

### Benefits

1. **Consistency** - Same algorithm available in both Nefarious and X3
2. **Keycloak compatibility** - PBKDF2-SHA256 can be imported to Keycloak
3. **Future-proofing** - Modern algorithm, OWASP-recommended
4. **No new dependencies** - Uses existing OpenSSL linkage

---

## Status

- [x] Phase 1: Core Password Module (X3)
- [x] Phase 2: PBKDF2 Implementation (X3)
- [x] Phase 3: Lazy Migration (X3)
- [x] Phase 4: Keycloak Credential Import (X3)
- [x] Phase 5: Cookie Activation Fix (X3) - resolved by Phase 4
- [x] Phase 6: Configuration (X3)
- [ ] Phase 7: Migration Tools (X3)
- [x] Phase 8: Nefarious PBKDF2 Module

### Phase 1 & 2 Implementation Details (2026-01-05)

**Files created:**
- `src/password.h` - Complete API with enums, config struct, and function declarations
- `src/password.c` - Full PBKDF2-SHA256 implementation using OpenSSL EVP_KDF

**Files modified:**
- `src/Makefile.am` - Added password.c and password.h to x3_SOURCES
- `src/main.c` - Added `#include "password.h"` and `pw_init()` call

**API implemented:**
- `pw_init()` - Initialize module with default config
- `pw_hash()` / `pw_hash_with()` - Hash password with default or specific algorithm
- `pw_verify()` - Verify password with automatic algorithm detection
- `pw_needs_rehash()` - Check if hash needs upgrade
- `pw_detect_algorithm()` - Detect algorithm from hash format
- `pw_export_keycloak()` - Export in Keycloak credential import format
- `pw_export_ldap()` - Export in OpenLDAP password format
- `pw_cryptpass()` / `pw_checkpass()` - Compatibility wrappers for legacy code

**Hash format:** `$pbkdf2-sha256$i=100000$base64_salt$base64_hash`

**Parameters:**
- Algorithm: PBKDF2-SHA256
- Iterations: 100,000 (OWASP 2023 minimum)
- Salt: 16 bytes (128 bits) via `RAND_bytes()`
- Hash: 32 bytes (256 bits)
- Constant-time comparison via `CRYPTO_memcmp()`

**Algorithm detection supports:**
- `$pbkdf2-sha256$` - PBKDF2-SHA256 ✅
- `$pbkdf2-sha512$` - PBKDF2-SHA512 ✅
- `$2a$`, `$2b$`, `$2y$` - bcrypt ✅ (reused from Nefarious ircd_crypt_bcrypt.c)
- `$argon2id$` - Argon2id (future)
- `$XXXXXXXX...` - Legacy X3 seeded MD5
- 32-char hex - Plain MD5

**bcrypt implementation (reused from Nefarious):**
- Uses system `crypt()` function with libcrypt
- Generates 16-byte random salt via `RAND_bytes()` or `/dev/urandom`
- Default cost factor: 12 (2^12 = 4096 iterations)
- Supports `$2a$`, `$2b$`, `$2y$` variants
- Constant-time comparison via `CRYPTO_memcmp()` when OpenSSL available

**Next steps:**
- Phase 7: Migration Tools (X3) - optional

---

### Phase 3 Implementation Details (2026-01-05)

**Files modified:**
- `src/common.h` - Added PASSWD_LEN constant (256 bytes) for modern hash formats
- `src/nickserv.h` - Updated `handle_info.passwd` buffer from MD5_CRYPT_LENGTH+1 to PASSWD_LEN
- `src/nickserv.c` - Full lazy migration integration

**Changes to nickserv.c:**

1. **Added password.h include** - Access to new password module API

2. **Created `checkpass_migrate()` helper function:**
   ```c
   static int checkpass_migrate(const char *password, struct handle_info *hi)
   ```
   - Uses `pw_verify()` for algorithm-agnostic verification
   - Checks `pw_config.enable_lazy_migration` and `pw_needs_rehash()` after successful login
   - Upgrades legacy hashes to PBKDF2-SHA256 automatically
   - Logs hash upgrades at INFO level

3. **Updated all checkpass() calls to checkpass_migrate():**
   - `cmd_auth()` (line 2464)
   - `cmd_resetpass()` (line 2888)
   - `cmd_cookie()` for CREDENTIAL type (line 2891)
   - `cmd_pass()` (line 3411)
   - `cmd_ounregister()` (line 4511)
   - `cmd_merge()` (line 5317)

4. **Updated all cryptpass() calls to pw_cryptpass():**
   - `register_handle()` (line 1317)
   - `nickserv_make_cookie()` for password change (line 1694)
   - `cmd_resetpass()` (line 2951)
   - `cmd_cookie()` for allowauth (line 3182)
   - `cmd_pass()` (line 3417)
   - `cmd_set_password()` (line 3914)
   - `cmd_osetpassword()` (line 8120)
   - `saxdb_read()` for migration path (line 9707)

5. **Updated all local buffer sizes:**
   - All `char crypted[MD5_CRYPT_LENGTH]` → `char crypted[PASSWD_LEN]`
   - Ensures buffers can hold PBKDF2-SHA256/512 and bcrypt hashes

**Lazy migration behavior:**
- On successful login, if `pw_config.enable_lazy_migration` is true (default)
- `pw_needs_rehash()` detects legacy MD5 hashes and weaker algorithms
- Password is automatically re-hashed with default algorithm (PBKDF2-SHA256)
- Hash upgrade is logged for auditing
- Database updated on next saxdb write cycle

---

### Phase 4 & 5 Implementation Details (2026-01-05)

**Phase 4: Keycloak Credential Import**

Uses Keycloak's credential import API to pass pre-hashed PBKDF2 passwords instead of plaintext.
This ensures both X3 and Keycloak have identical password hashes.

**Files modified:**
- `src/keycloak.h` - Added `keycloak_create_user_with_hash()` declaration
- `src/keycloak.c` - Added `json_build_user_with_hash()` and `keycloak_create_user_with_hash()`
- `src/nickserv.c` - Added `kc_do_add_with_hash()` wrapper, updated `nickserv_register()`

**New functions:**
- `json_build_user_with_hash()` - Builds JSON with credentialData/secretData for credential import
- `keycloak_create_user_with_hash()` - Creates user with pre-hashed password via Admin API
- `kc_do_add_with_hash()` - NickServ wrapper that calls `pw_export_keycloak()` then imports

**Keycloak credential import format:**
```json
{
  "credentials": [{
    "type": "password",
    "credentialData": "{\"algorithm\":\"pbkdf2-sha256\",\"hashIterations\":100000}",
    "secretData": "{\"value\":\"<base64_hash>\",\"salt\":\"<base64_salt>\"}",
    "temporary": false
  }]
}
```

**Phase 5: Deferred Keycloak User Creation**

Keycloak user creation is now deferred to cookie activation, matching the non-Keycloak flow:

**Before (broken):**
1. Registration → Keycloak user created with password immediately
2. User could authenticate via Keycloak SASL before email verification
3. ACTIVATION check in `cmd_auth` added as workaround (commit d6418ebf)

**After (fixed):**
1. Registration → hash stored in X3 and cookie only, no Keycloak user yet
2. Keycloak SASL auth fails naturally (user doesn't exist)
3. Cookie activation → `kc_do_add_with_hash()` creates Keycloak user with hash
4. Both X3 AUTH and Keycloak SASL now work

**Changes:**
- Removed `kc_do_add_with_hash()` from `nickserv_register()`
- Added `kc_do_add_with_hash()` to ACTIVATION case in `cmd_cookie()`
- ACTIVATION check in `cmd_auth` remains for X3 AUTH path (defense-in-depth)

---

### Phase 6 Implementation Details (2026-01-05)

**Files modified:**
- `src/nickserv.h` - Added config fields to `nickserv_config` struct
- `src/nickserv.c` - Added KEY definitions and config parsing in `nickserv_conf_read()`

**Config options added:**
```
"password_algorithm" "pbkdf2-sha256";  /* pbkdf2-sha256, pbkdf2-sha512, bcrypt */
"password_pbkdf2_iterations" "100000"; /* OWASP 2023 minimum */
"password_bcrypt_cost" "12";           /* 2^12 = 4096 iterations */
"password_lazy_migration" "1";         /* Rehash legacy passwords on login */
```

**Implementation:**
- Config is parsed in `nickserv_conf_read()` after metadata section
- Values are applied directly to `pw_config` global struct
- Algorithm string is mapped to `enum pw_algorithm`
- Logged at INFO level on startup for visibility

---

### Phase 8 Implementation Details (2026-01-05)

**Files created:**
- `include/ircd_crypt_pbkdf2.h` - Header with registration functions (SHA256 and SHA512)
- `ircd/ircd_crypt_pbkdf2.c` - Full PBKDF2 implementation using OpenSSL EVP_KDF

**Files modified:**
- `ircd/Makefile.in` - Added ircd_crypt_pbkdf2.c to CRYPTO_SRC and dependencies
- `ircd/ircd_crypt.c` - Added include and registration calls in ircd_crypt_init()
- `ircd/umkpasswd.c` - Added include and registration calls in load_mechs()

**Hash formats:**
- SHA256: `$PBKDF2$100000$base64_salt$base64_hash`
- SHA512: `$PBKDF2-SHA512$100000$base64_salt$base64_hash`

**Parameters:**
- Algorithm: PBKDF2-SHA256 or PBKDF2-SHA512
- Iterations: 100,000 (OWASP 2023 minimum)
- Salt: 16 bytes (128 bits)
- Hash: 32 bytes (SHA256) or 64 bytes (SHA512)

**Testing:**
- Unit tests deferred (requires OpenSSL linking in test build)
- Can be tested manually with `umkpasswd -m pbkdf2` or `umkpasswd -m pbkdf2-sha512`
- Integration testing via oper password verification
