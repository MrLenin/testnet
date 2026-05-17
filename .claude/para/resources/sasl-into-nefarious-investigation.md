# Investigation: Moving SASL Authentication from X3 into Nefarious

## Executive Summary

Currently, SASL authentication in Nefarious is a **transparent relay**: the IRCd forwards `AUTHENTICATE` messages to X3 via P10, X3 validates credentials, and responses flow back. The IRCd never touches credentials. This investigation examines what would be required to move SASL authentication directly into the Nefarious IRCd, designed to work with **legacy/upstream X3** (minimal X3 changes).

**Scope**: Changes go into our IRCv3 Nefarious branch. Legacy X3 gets only the minimum changes needed to interoperate. We can modify legacy X3, but we're trying to be minimal.

---

## 1. Current Architecture

### 1.1 The SASL Relay (Nefarious Side)

Nefarious currently has **zero SASL processing logic** — it is purely a message router.

**Key files**:
- [m_authenticate.c](nefarious/ircd/m_authenticate.c) — `m_authenticate()` handler (~294 lines)
- [m_sasl.c](nefarious/ircd/m_sasl.c) — `ms_sasl()` handler for P10 SASL responses
- [m_cap.c](nefarious/ircd/m_cap.c) — CAP SASL advertisement, `sasl_server_available()`
- [s_auth.c](nefarious/ircd/s_auth.c) — IAuth SASL bridge (alternative relay path)

**Relay flow**:
```
Client                    Nefarious                    X3
  |                          |                          |
  | AUTHENTICATE PLAIN       |                          |
  |------------------------->|                          |
  |                          | SASL Az AB!3.42 S PLAIN  |
  |                          |------------------------->|
  |                          | SASL Az AB!3.42 H :...   |
  |                          |------------------------->|
  |                          |                          |
  |                          | SASL AB AB!3.42 C :+     |
  |                          |<-------------------------|
  | AUTHENTICATE +           |                          |
  |<-------------------------|                          |
  |                          |                          |
  | AUTHENTICATE dXNlcjpwd== |                          |
  |------------------------->|                          |
  |                          | SASL Az AB!3.42 C :d...  |
  |                          |------------------------->|
  |                          |                          |
  |                          | SASL AB AB!3.42 L acct 0 |
  |                          |<-------------------------|
  | :srv 900 * acct :logged  |                          |
  |<-------------------------|                          |
  |                          | SASL AB AB!3.42 D S      |
  |                          |<-------------------------|
  | :srv 903 * :SASL ok      |                          |
  |<-------------------------|                          |
```

**Token format**: `[SERVER]![FD].[COOKIE]` — e.g., `AB!3.42` identifies server AB, fd 3, cookie 42. Cookie is a random 31-bit integer generated per SASL session, used to prevent stale responses after FD reuse.

**Two relay paths exist**:

1. **P10 relay** (default): `m_authenticate()` → `sendcmdto_one(&me, CMD_SASL, ...)` → X3
2. **IAuth relay** (alternative): `m_authenticate()` → `auth_send_sasl_*()` → external IAuth daemon

Decision logic in `m_authenticate()` line 162: `if (auth_iauth_handles_sasl()) { /* route to iauth */ } else { /* route via P10 */ }`

### 1.2 SASL Availability Detection

`sasl_server_available()` in [m_cap.c:221](nefarious/ircd/m_cap.c#L221):
1. If IAuth handles SASL: check `auth_iauth_sasl_mechs() != NULL`
2. If no mechanisms available (from any source): return 0
3. If `FEAT_SASL_SERVER` is `"*"`: check any server exists
4. Otherwise: check specific named server is connected

`get_effective_sasl_mechanisms()` in [m_cap.c:200](nefarious/ircd/m_cap.c#L200):
- IAuth active → return IAuth's mechanism list
- P10 services broadcast mechanisms → return `SaslMechanisms[]` global
- Fallback: `FEAT_SASL_DEFAULT_MECHANISMS` feature string

### 1.3 SASL Feature Flags (Nefarious)

| Feature | Type | Default | Purpose |
|---------|------|---------|---------|
| `FEAT_SASL_SERVER` | string | `"*"` | Target server for SASL relay (`*` = broadcast) |
| `FEAT_SASL_TIMEOUT` | int | `10` | Seconds before SASL auth times out |
| `FEAT_SASL_SENDHOST` | bool | `1` | Send H (host) subcmd with user@host:ip |
| `FEAT_SASL_AUTOHIDEHOST` | bool | `1` | Auto-hide host on SASL login |
| `FEAT_SASL_DEFAULT_MECHANISMS` | string | `""` | Fallback mechanism list if no dynamic broadcast |

### 1.4 P10 SASL Wire Format

| Subcmd | Direction | Format | Purpose |
|--------|-----------|--------|---------|
| S | IRCd→X3 | `SASL <dest> <token> S <mech> [:<sslclifp>]` | Start, select mechanism |
| H | IRCd→X3 | `SASL <dest> <token> H :<user@host:ip>` | Hostname info |
| C | Both | `SASL <dest> <token> C :<base64_data>` | Challenge/response data |
| D | X3→IRCd | `SASL <dest> <token> D <S\|F\|A>` | Done: Success/Fail/Abort |
| L | X3→IRCd | `SASL <dest> <token> L <account> <timestamp>` | Login notification |
| M | X3→IRCd | `SASL * * M :<mechanism_list>` | Mechanism broadcast |

**Chunking**: Data > 400 bytes split into 400-byte chunks. If final chunk is exactly 400 bytes, `C :+` continuation signal follows. `*` = abort.

### 1.5 P10 Account (AC) Wire Format

| Subcmd | Direction | Format | Purpose |
|--------|-----------|--------|---------|
| R | Both | `AC <user_numeric> R <account> <timestamp>` | Account registration broadcast |
| M | Both | `AC <user_numeric> M <new_account> <timestamp>` | Account rename |
| U | Both | `AC <user_numeric> U` | Account unregister |
| A | X3→IRCd | `AC <server> A <cookie> <timestamp>` | Auth success (LOC) |
| D | X3→IRCd | `AC <server> D <cookie> [:<reason>]` | Auth deny (LOC) |
| C | IRCd→X3 | `AC <x3> C <cookie> <account> :<password>` | Auth check (LOC) |
| H | IRCd→X3 | `AC <x3> H <cookie> <host> <account> :<password>` | Auth check with host |
| S | IRCd→X3 | `AC <x3> S <cookie> <host> <authzid> <account> :<password>` | Auth check SASL-style |

### 1.6 P10 Registration (RG/VF/RR) Wire Format

| Token | Direction | Format | Purpose |
|-------|-----------|--------|---------|
| RG | IRCd→X3 | `RG <x3> <token> <account> <email> :<password>` | Register account |
| VF | IRCd→X3 | `VF <x3> <token> <account> <code>` | Verify email |
| RR | X3→IRCd | `RR <token> <S\|V\|F> <account> :<message>` | Registration result |

### 1.7 Client-Side Fields (Nefarious)

```c
// client.h — SASL relay state
cli_saslagent(cli)      // Pinned SASL server for this client
cli_saslagentref(cli)   // Reference count on pinned server
cli_saslaccount(cli)    // Account name from SASL L subcmd
cli_saslacccreate(cli)  // Account creation timestamp
cli_saslcookie(cli)     // Random cookie for session matching
cli_saslstart(cli)      // Timestamp of SASL start
cli_sasltimeout(cli)    // Timer for SASL timeout

// Account state
cli_account(cli)        // → cli_user(cli)->account
IsAccount(cli)          // FLAG_ACCOUNT set
SetAccount(cli)         // Set FLAG_ACCOUNT
IsSASLComplete(cli)     // FLAG_SASLCOMPLETE set
```

---

## 2. X3 SASL Implementation (Our Fork)

### 2.1 Supported SASL Mechanisms

| Mechanism | Build Requires | Description |
|-----------|---------------|-------------|
| PLAIN | always | Username/password (RFC 4616) |
| EXTERNAL | always | Certificate fingerprint (RFC 4422) |
| OAUTHBEARER | `WITH_KEYCLOAK` | OAuth2 bearer token (RFC 7628) |
| SCRAM-SHA-1/256/512 | `WITH_MDBX + WITH_SSL` | Challenge-response (RFC 5802/7677) |
| ECDSA-NIST256P-CHALLENGE | `WITH_SSL` | Public key signature |

**Upstream X3 baseline**: PLAIN only. All other mechanisms are our fork's additions.

### 2.2 SASL State Machine (X3)

```c
enum sasl_state {
    SASL_STATE_NONE,
    SASL_STATE_INIT,                 // Session created
    SASL_STATE_MECH_SELECTED,        // Mechanism chosen
    SASL_STATE_AUTHENTICATING,       // Async auth in progress
    SASL_STATE_PENDING_RESULT,       // Auth complete, sending response
    SASL_STATE_COMPLETE,
    SASL_STATE_FAILED,
    SASL_STATE_CANCELLED,
    SASL_STATE_TIMEOUT,
    SASL_STATE_SCRAM_CHALLENGE,      // SCRAM: sent server-first
    SASL_STATE_SCRAM_VERIFY,         // SCRAM: verifying client proof
    SASL_STATE_SCRAM_FETCH,          // SCRAM: fetching from Keycloak
    SASL_STATE_ECDSA_CHALLENGE       // ECDSA: sent challenge
};
```

### 2.3 PLAIN Mechanism Flow (X3)

1. Client sends base64: `[authzid]\0authcid\0password`
2. X3 decodes, extracts fields
3. **Keycloak path** (if enabled):
   - Check negative cache (MD5 of username:password) → fast reject
   - Check positive cache → fast accept
   - `kc_check_auth_async()` → non-blocking HTTP to Keycloak
   - Session tokens (`x3tok:` prefix) validated in LMDB first
4. **Local path** (Keycloak disabled):
   - `loc_auth(sslclifp, authcid, passwd, hostmask)` → password hash verification
   - `checkpass_migrate()` → `pw_verify()` with lazy rehash

### 2.4 EXTERNAL Mechanism Flow (X3)

1. Client sends optional authzid
2. X3 uses SSL certificate fingerprint from P10 S subcmd
3. Fingerprint→account lookup (LMDB cache → Keycloak user attributes)
4. Negative cache: 60-second TTL for unknown fingerprints

### 2.5 SCRAM-SHA-256 Flow (X3)

RFC 5802 three-message exchange:
1. **Client-first**: `n,,n=<username>,r=<client_nonce>` → X3 responds with `r=<combined>,s=<salt>,i=<iterations>`
2. **Client-final**: `c=<binding>,r=<combined>,p=<proof>` → X3 verifies proof, responds `v=<server_sig>`
3. Credential sources: LMDB cache → Keycloak user attributes (`x3_scram_{hash}_*`)

### 2.6 OAUTHBEARER Flow (X3)

RFC 7628 format: `n,a=<authzid>,\x01auth=Bearer <token>\x01\x01`
- **Local JWT validation**: JWKS cache, signature/expiration check, no HTTP round-trip
- **Fallback**: Token introspection via Keycloak REST API

### 2.7 Password Hashing (X3)

| Algorithm | Format | Default | Notes |
|-----------|--------|---------|-------|
| PBKDF2-SHA256 | `$pbkdf2-sha256$i=N$salt$hash` | **Yes** | 10,000 iterations |
| PBKDF2-SHA512 | `$pbkdf2-sha512$i=N$salt$hash` | No | Alternative |
| bcrypt | `$2y$XX$...` | No | Cost 12 |
| MD5 legacy | `$XXXXXXXX...` | No | Backward compat only |
| Argon2id | `$argon2id$...` | No | Placeholder |

**Lazy migration**: On login, detects old hash format, re-hashes to current default.
**Async hashing**: `pw_hash_async()` / `pw_verify_async()` use threadpool for CPU-intensive operations.

### 2.8 Account Model (X3)

```c
struct handle_info {
    char *handle;           // Account name (unique)
    char passwd[256];       // Password hash
    char *email_addr;       // Email
    char *fakehost;         // Fake hostname
    char *ecdsa_pubkey;     // ECDSA public key (base64)
    time_t registered;      // Registration timestamp
    time_t lastseen;        // Last login
    unsigned short flags;   // HI_FLAG_* (SUSPENDED, FROZEN, IMPERSONATE, etc.)
    unsigned short opserv_level; // Oper level (0-1000)
    unsigned short maxlogins;    // Max concurrent logins
    struct handle_cookie *cookie; // Pending verification
    struct string_list *masks;    // Hostmasks
    struct string_list *sslfps;   // SSL fingerprints
    struct userData *channels;    // Channel access list
    // ... more fields
};
```

**Storage**: SAXDB (flat file serialization in `data/nickserv.db`)

### 2.9 Mechanism Advertisement (X3 → Nefarious)

`nickserv_update_sasl_mechanisms()` → `irc_sasl_mechs_broadcast()`:
- Sends `SASL * * M :PLAIN,EXTERNAL,...` via P10
- Triggered on: server startup, Keycloak availability change, mechanism list change
- Change detection: compares against `last_sasl_mechs` static cache

### 2.10 Caching Architecture (X3)

| Cache | TTL | Purpose |
|-------|-----|---------|
| Auth negative (MD5) | 60s | Reject known-bad credentials immediately |
| Auth positive | configurable | Skip Keycloak for recently validated creds |
| Fingerprint→account | 1 hour | LMDB cache for EXTERNAL lookups |
| Fingerprint negative | 60s | Skip lookup for unknown certs |
| Session tokens | hours | LMDB one-time auth tokens |
| Keycloak user repr | per-request | Prevent field loss on PUT |
| SCRAM credentials | persistent | LMDB per-account per-hash-type |

---

## 3. IAuth SASL Integration (Existing Alternative Path)

Nefarious already has a **second SASL path** through IAuth that bypasses P10 entirely. This is relevant because it demonstrates the IRCd can handle SASL without services.

**Key functions in [s_auth.c](nefarious/ircd/s_auth.c)**:
- `auth_iauth_handles_sasl()` — returns true if IAuth advertises SASL capability
- `auth_send_sasl_start()` — sends SASL start to IAuth daemon
- `auth_send_sasl_data()` — sends challenge/response data
- `auth_send_sasl_host()` — sends hostname info
- `iauth_cmd_sasl_challenge()` — receives challenge from IAuth → forwards to client
- `iauth_cmd_sasl_loggedin()` — receives login success → sets account on client
- `iauth_cmd_sasl_fail()` — receives failure → sends ERR_SASLFAIL
- `iauth_cmd_sasl_mechs()` — receives mechanism list from IAuth
- `iauth_cmd_sasl_global_mechs()` — receives global mechanism broadcast

**IAuth SASL is structurally identical to what we want**: the IRCd receives AUTHENTICATE, dispatches to a handler, and processes the result (set account, send numerics). The only difference is that IAuth is an external process communicating via pipes, while we want the handler to be **in-process**.

---

## 4. What Moving SASL Into Nefarious Requires

### 4.1 Core Architecture Decision

Instead of relaying AUTHENTICATE to X3, Nefarious would:
1. Parse the SASL mechanism and credentials locally
2. Validate against **Keycloak directly** via libkc (async HTTP)
3. Set the account directly on the client
4. Broadcast AC to the network (so X3 and other servers know)
5. Send SASL numerics (900-907) to the client

### 4.2 Credential Backend: Direct Keycloak via libkc

| Backend | Pros | Cons | X3 Changes |
|---------|------|------|------------|
| A: Query X3 via P10 | Minimal change, X3 retains credential store | Still a relay (just a different one), adds latency | Add new P10 subcmd for credential lookup |
| B: Shared database (MDBX) | Fast, no network round-trip | Complex sync, X3 must write credentials in shared format | X3 writes to shared MDBX on account create/password change |
| **C: Direct Keycloak** | **X3 completely out of SASL path** | **Adds Keycloak dependency to IRCd** | **None (X3 uninvolved in SASL)** |
| D: Embedded credential store | Simplest, fully self-contained | Credential duplication, sync problem | X3 notifies IRCd of account changes |

**Selected: Option C (Direct Keycloak via libkc)** — Keycloak is the authoritative credential store. Nefarious validates directly against Keycloak using the libkc shared library that is **already integrated** into Nefarious via `ircd_kc_adapter.c`.

**Why Option C wins**:
- **No credential sync**: Eliminates the entire CS protocol, MDBX credential tables, and password.c port
- **No X3 changes**: X3 is completely uninvolved in the SASL path (zero legacy X3 changes for auth)
- **Already integrated**: libkc is already linked into Nefarious and bridged to the event loop for webpush
- **Single source of truth**: Keycloak is authoritative — no sync, no staleness, no race conditions
- **All mechanisms**: Keycloak APIs cover PLAIN (password grant), EXTERNAL (user attribute query), OAUTHBEARER (token introspection/JWKS), and even SCRAM (user credential attributes)

**Trade-off**: Keycloak becomes a hard dependency for SASL auth. If Keycloak is down, SASL fails. Mitigation: P10 relay fallback to X3 (existing path preserved), plus libkc caching.

**Note on libkc maturity**: The libkc/`ircd_kc_adapter.c` integration is deployed in our testnet for webpush but is not yet production-tested at scale. The code paths are exercised but have not been through production hardening.

### 4.3 libkc — The Foundation

libkc (`/home/ibutsu/testnet/libkc/`, 4,832 LOC) is a standalone async Keycloak REST API client library extracted from X3's `keycloak.c`. It provides:

**Core API** ([kc_keycloak.h](libkc/include/kc_keycloak.h)):
```c
/* Configuration */
struct kc_config { base_url, realm, client_id, client_secret };

/* Lifecycle */
int kc_keycloak_init(const struct kc_config *config);
void kc_keycloak_shutdown(void);

/* Password verification (Resource Owner Password Grant) */
int kc_user_verify_password(const char *username, const char *password,
                            kc_token_cb cb, void *data);

/* User lookup */
int kc_user_get(const char *username, kc_user_cb cb, void *data);
int kc_user_get_by_id(const char *id, kc_user_cb cb, void *data);
int kc_user_search(const char *query, bool exact, kc_users_cb cb, void *data);

/* Token introspection (for OAUTHBEARER) */
int kc_token_introspect(const char *token, kc_introspect_cb cb, void *data);

/* Offline JWT validation (for OAUTHBEARER, no HTTP round-trip) */
int kc_token_verify_offline(const char *token, struct kc_token_info *info);
int kc_jwks_refresh(kc_result_cb cb, void *data);

/* Error codes */
enum kc_error { KC_SUCCESS, KC_FORBIDDEN, KC_NOT_FOUND, KC_TIMEOUT, ... };
```

**Already integrated into Nefarious** via [ircd_kc_adapter.c](nefarious/ircd/ircd_kc_adapter.c) (362 LOC):
- Maps libkc's `kc_event_ops` (socket add/update/remove, timer add/cancel) to Nefarious's `socket_add()`/`timer_add()` API
- Maps libkc's `kc_log_ops` to Nefarious's `log_write(LS_SYSTEM, ...)`
- Maintains 256-slot fd→Socket mapping for libcurl's curl_multi sockets
- Rounds libkc millisecond timers to Nefarious's 1-second granularity
- Used by [webpush.c](nefarious/ircd/webpush.c) for async web push delivery

**Build integration**: `./configure --with-keycloak=/path/to/libkc`, guarded by `#ifdef USE_LIBKC`.

### 4.4 SASL Mechanism → Keycloak API Mapping

| SASL Mechanism | Keycloak API | libkc Function | Latency | Phase |
|---------------|-------------|----------------|---------|-------|
| **PLAIN** | Resource Owner Password Grant | `kc_user_verify_password()` | ~45ms (HTTP) | 1 |
| **EXTERNAL** | User attribute query (`x3_fingerprint`) | `kc_user_search("x3_fingerprint:FP")` | ~45ms (HTTP) | 1 |
| **OAUTHBEARER** | Offline JWT validation (JWKS cache) | `kc_token_verify_offline()` | <1ms (local) | 2 |
| **OAUTHBEARER** (fallback) | Token introspection endpoint | `kc_token_introspect()` | ~45ms (HTTP) | 2 |
| **SCRAM-SHA-256** | User attribute query (stored credentials) | `kc_user_get()` → parse `x3_scram_*` attrs | ~45ms (first msg) | 3 |
| **ECDSA-NIST256P** | User attribute query (public key) | `kc_user_get()` → parse `ecdsa_pubkey` attr | ~45ms (challenge) | 3 |

**Key insight**: PLAIN and EXTERNAL require only one HTTP round-trip (~45ms avg). OAUTHBEARER with JWKS cache requires zero HTTP (local JWT verification). No CPU-intensive password hashing in the IRCd — Keycloak handles it.

### 4.5 Authentication Flows (Keycloak-Based)

**PLAIN** (`kc_user_verify_password`):
```
Client → AUTHENTICATE PLAIN
  Nefarious → AUTHENTICATE + (ready for data)
Client → AUTHENTICATE <base64: \0authcid\0password>
  Nefarious decodes → extracts username, password
  Nefarious → kc_user_verify_password(username, password, callback, sasl_session)
    libkc → POST /realms/{realm}/protocol/openid-connect/token
            grant_type=password&username=X&password=Y
            (HTTP Basic auth with client_id:client_secret)
    Keycloak → 200 + access_token (success) or 401 (failure)
  callback fires:
    KC_SUCCESS → set account, send 900/903, broadcast AC
    KC_FORBIDDEN → send 904 ERR_SASLFAIL
    KC_TIMEOUT/KC_UNAVAILABLE → fall back to P10 relay (if X3 connected)
```

**EXTERNAL** (fingerprint → user attribute lookup):
```
Client → AUTHENTICATE EXTERNAL
  Nefarious → AUTHENTICATE + (ready for authzid)
Client → AUTHENTICATE <base64: authzid or +>
  Nefarious extracts cli_sslclifp(sptr)
  Nefarious → kc_user_search("x3_fingerprint:<fp>", true, callback, sasl_session)
    libkc → GET /admin/realms/{realm}/users?q=x3_fingerprint:{fp}
            (Bearer token auth)
  callback fires:
    count=1 → extract username, set account, send 900/903
    count=0 → send 904 ERR_SASLFAIL (fingerprint not registered)
    count>1 → send 904 (collision — security issue)
```

**OAUTHBEARER** (`kc_token_verify_offline` / `kc_token_introspect`):
```
Client → AUTHENTICATE OAUTHBEARER
  Nefarious → AUTHENTICATE + (ready for token)
Client → AUTHENTICATE <base64: n,a=authzid,\x01auth=Bearer <token>\x01\x01>
  Nefarious extracts bearer token
  Nefarious → kc_token_verify_offline(token, &info)  // try local JWKS first
    if succeeds: extract username from JWT claims, set account
    if fails (no cached JWKS, signature invalid):
  Nefarious → kc_token_introspect(token, callback, sasl_session)  // HTTP fallback
    libkc → POST /realms/{realm}/protocol/openid-connect/token/introspect
            token=X&token_type_hint=access_token
    Keycloak → {"active": true, "username": "..."} or {"active": false}
  callback fires: same pattern as PLAIN
```

### 4.6 Async Architecture

**No CPU-intensive work in Nefarious**: Keycloak handles password hashing (PBKDF2, bcrypt, etc.) server-side. The IRCd only does:
- Base64 decode (fast, in-process)
- HTTP request via libkc (non-blocking, curl_multi integrated into event loop)
- JWT signature verification for OAUTHBEARER (fast, in-process, OpenSSL)

**Async pattern** (same as webpush, already proven):
```
SASL handler
  → call kc_user_verify_password(username, password, sasl_plain_cb, session)
  → returns immediately (non-blocking)
  → libkc submits curl_multi request
  → ircd_kc_adapter registers curl sockets with Nefarious event loop
  → when HTTP response arrives, curl_multi processes it
  → libkc parses JSON, invokes sasl_plain_cb(result, token, session)
  → callback sends SASL numerics, sets account, broadcasts AC
```

**Thread pool**: Nefarious already has `thread_pool.h` (pthread-based). Not needed for Keycloak HTTP, but could be used for SCRAM-SHA-256's PBKDF2 derivation if we ever need to compute SCRAM server credentials locally (unlikely with Keycloak).

**Timeout handling**: Existing `FEAT_SASL_TIMEOUT` (default 10s) applies. If the Keycloak HTTP request hasn't completed within the timeout, the SASL session is aborted. libkc's curl requests have their own 30s timeout, but the SASL timeout fires first.

### 4.7 What X3 Still Handles

Even with SASL in Nefarious, X3 retains:
- **Account registration** (AuthServ REGISTER) — creates accounts in its credential store
- **Account management** (password change, email change, suspension)
- **Channel services** (ChanServ) — all channel registration/access
- **Operator services** (OpServ) — network management
- **Account metadata** — opserv levels, flags, channel access lists

### 4.8 Legacy X3 Migration via Keycloak LDAP Federation

**Zero changes required to legacy X3** — the bridge is Keycloak's built-in LDAP User Federation.

Legacy X3 uses LDAP (or SAXDB) for its credential store — it does not speak Keycloak. Rather than surgically modifying legacy X3 to write to Keycloak, we use Keycloak's native LDAP federation feature to bridge the gap:

```
Legacy X3 → LDAP (unchanged, keeps writing accounts/passwords as always)
Keycloak → LDAP Federation (reads/syncs users from the same LDAP server)
Nefarious SASL → Keycloak (via libkc) → validates against LDAP-federated users
```

**How Keycloak LDAP Federation works**:
- Keycloak is configured with an "LDAP Provider" pointing at the same LDAP server X3 uses
- Users are imported/synced from LDAP into Keycloak (on-demand or periodic sync)
- Password validation is delegated to LDAP (Keycloak binds as the user to verify)
- User attributes (fingerprints, SCRAM credentials, etc.) can be mapped via LDAP attribute mappers
- Keycloak can optionally write back to LDAP (bidirectional sync)

#### 4.8.1 Legacy Password Format: SMD5

**Legacy X3 password storage in LDAP** (from `x3ldap.c`):

Legacy X3 stores passwords in LDAP's `userPassword` attribute using **Salted MD5 (SMD5)** — a standard LDAP password scheme supported by OpenLDAP for 20+ years:

1. `cryptpass(password)` → `$SSSSSSSS<32-hex-chars>` (8-char hex salt + MD5 digest)
2. `make_password(crypted)` → packs hex to binary → base64-encodes → prepends `{MD5}` scheme tag
3. Stored in LDAP as: `{MD5}<base64(salt+digest)>` — recognized by OpenLDAP as SMD5

**During LDAP federation: No problem.** Keycloak delegates password verification to the LDAP server via LDAP bind. OpenLDAP's `{SMD5}` scheme handler verifies the salted hash natively. This has been standard LDAP functionality for decades.

**Impact on each path**:

| Path | Works? | Notes |
|------|--------|-------|
| LDAP bind (federation coexistence) | **Yes** | OpenLDAP handles SMD5 verification natively during bind |
| Keycloak ROPC (direct, no LDAP) | **No** | Keycloak doesn't support MD5/SMD5 in its native credential store (only PBKDF2/bcrypt/Argon2) |
| P10 relay fallback | **Yes** | X3 verifies using `checkpass()` in application code |

#### 4.8.2 Retiring LDAP: Credential Migration

The SMD5 problem only surfaces when **retiring LDAP** — moving from Keycloak+LDAP federation to Keycloak-native credential storage. Keycloak cannot verify SMD5 hashes without LDAP.

**Option 1: Keycloak Credential Provider SPI (Recommended)**

Write a small Java plugin (Keycloak SPI) that teaches Keycloak to verify SMD5:
- Implements `CredentialProvider` SPI
- Parses SMD5 format → extracts salt → recomputes hash → compares
- On successful verification, transparently re-hashes password as PBKDF2 (Keycloak's native format)
- Standard Keycloak pattern for legacy credential migration (~200 lines of Java)
- Effect: all existing SMD5 accounts work immediately, passwords lazily upgraded to PBKDF2

**Option 2: Lazy rehash on successful auth**

During LDAP federation, on each successful LDAP bind, Keycloak can be configured to capture and re-store the credential in its native format (PBKDF2). Over time, all active accounts are upgraded. When all (or enough) accounts have native credentials, LDAP federation can be retired.

**Option 3: Bulk password reset**

Import users without passwords, force reset on first login. Last resort for inactive accounts.

**Modern X3 fork**: Already has `password.c` with PBKDF2-SHA256/SHA512/bcrypt support and `pw_export_ldap()` that stores `{PBKDF2-SHA256}` in LDAP. New accounts created by our modern fork don't have the SMD5 problem — only legacy accounts need migration.

#### 4.8.3 Coexistence Architecture

**Coexistence during migration**:
- Legacy X3 continues writing to LDAP — no code changes, no awareness of Keycloak
- Keycloak reads from the same LDAP — sees all accounts X3 creates/modifies
- Keycloak SPI plugin handles MD5-hashed passwords from legacy accounts
- Nefarious validates SASL against Keycloak — which resolves to LDAP-federated users
- Both authentication paths work simultaneously:
  - Direct: Client → Nefarious SASL → Keycloak (+ SPI for MD5) → LDAP federation → validates
  - Fallback: Client → Nefarious relay → X3 → LDAP → validates (existing P10 path)

**Migration phases**:
1. **Deploy Keycloak with LDAP federation + MD5 SPI plugin** pointing at existing LDAP server
2. **Enable `FEAT_SASL_LOCAL`** on Nefarious — SASL validates via Keycloak (backed by LDAP)
3. **X3 keeps running unchanged** — handles registration, account management, channels
4. **Over time**: MD5 passwords lazily rehashed to PBKDF2 as users authenticate
5. **Later**: Migrate X3 to speak Keycloak directly (our modern X3 fork already does this)
6. **Eventually**: LDAP federation + MD5 SPI can be retired once all passwords are PBKDF2 and X3 writes directly to Keycloak

**For networks using SAXDB (no LDAP)**:
- SASL falls back to P10 relay to X3 (existing behavior, no Keycloak)
- OR: deploy Keycloak standalone (no LDAP federation) and migrate accounts into Keycloak
- The P10 relay fallback path (`FEAT_SASL_LOCAL = FALSE`) always works

**Summary**: Zero changes to legacy X3. Keycloak LDAP federation bridges the credential gap. MD5 SPI plugin handles legacy password format. Both paths coexist during migration.

### 4.9 Nefarious Changes Summary

| Component | New/Modified | Estimated LOC | Phase |
|-----------|-------------|---------------|-------|
| SASL mechanism framework | New module (`sasl_auth.c`) | ~500 | 1 |
| PLAIN handler (Keycloak) | New (in `sasl_auth.c`) | ~200 | 1 |
| EXTERNAL handler (Keycloak) | New (in `sasl_auth.c`) | ~150 | 1 |
| m_authenticate.c refactor | Modified (relay → local dispatch) | ~250 (rewrite) | 1 |
| m_cap.c updates | Modified (`sasl_server_available`) | ~50 | 1 |
| Keycloak config (features) | Modified (`ircd_features.c/h`) | ~80 | 1 |
| SASL session state | Modified (`client.h`) | ~30 | 1 |
| OAUTHBEARER handler | New (in `sasl_auth.c` or `sasl_oauth.c`) | ~300 | 2 |
| Negative auth cache | New | ~150 | 2 |
| SCRAM-SHA-256 handler | New (`sasl_scram.c`) | ~400 | 3 |
| ECDSA handler | New (`sasl_ecdsa.c`) | ~200 | 3 |

**Total Phase 1**: ~1,260 LOC new/modified in Nefarious. Zero LOC in X3.

---

## 5. Detailed Component Analysis

### 5.1 m_authenticate.c Refactor

**Current**: 294 lines, purely relay. Two paths (IAuth, P10).

**New structure** — three paths: local Keycloak (new), IAuth (existing), P10 relay (existing fallback):
```c
int m_authenticate(struct Client* cptr, struct Client* sptr, int parc, char* parv[])
{
    if (parc < 2)
        return need_more_params(sptr, "AUTHENTICATE");

    // Handle abort
    if (!strcmp(parv[1], "*"))
        return sasl_abort(sptr);

    // Decision: which SASL path?
    if (feature_bool(FEAT_SASL_LOCAL) && kc_keycloak_available()) {
        // NEW: Local Keycloak-based SASL
        if (!cli_saslcookie(sptr))
            return sasl_start(sptr, parv[1]);
        return sasl_continue(sptr, parv[1]);
    }
    else if (auth_iauth_handles_sasl()) {
        // Existing: IAuth path
        return auth_send_sasl_data(...);
    }
    else {
        // Existing: P10 relay to X3
        return sendcmdto_one(&me, CMD_SASL, ...);
    }
}
```

**sasl_start()** would:
1. Validate mechanism is supported (from Keycloak-capable list)
2. Allocate SASL session state on the client (or separate struct)
3. For PLAIN: send `AUTHENTICATE +` (ready for data)
4. For EXTERNAL: extract fingerprint, initiate Keycloak lookup immediately
5. For OAUTHBEARER: send `AUTHENTICATE +` (ready for token)
6. For SCRAM: generate server-first challenge

**sasl_continue()** would:
1. Accumulate chunks (400-byte boundary handling, `+` continuation)
2. Dispatch to mechanism-specific handler
3. Mechanism handler calls libkc async function → returns
4. On callback: set account, send numerics, broadcast AC

### 5.2 libkc Integration Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Client      │     │  Nefarious   │     │  Keycloak        │
│  (IRC)       │     │  (IRCd)      │     │  (HTTP/REST)     │
│              │     │              │     │                  │
│ AUTHENTICATE ├────►│ m_auth.c     │     │                  │
│              │     │   ↓          │     │                  │
│              │     │ sasl_auth.c  │     │                  │
│              │     │   ↓ (async)  │     │                  │
│              │     │ libkc ───────┼────►│ /token (ROPC)    │
│              │     │   ↓ callback │     │ /users (attr)    │
│              │     │ sasl_auth.c  │     │ /introspect      │
│              │     │   ↓          │     │ /certs (JWKS)    │
│ 900/903      │◄────┤ numerics     │     │                  │
│              │     │   ↓          │     │                  │
│              │     │ AC broadcast ├────►│ (network-wide)   │
└─────────────┘     └──────────────┘     └──────────────────┘
                    ┌──────────────┐
                    │ ircd_kc_     │
                    │ adapter.c    │  ← Bridges libkc sockets/timers
                    │ (362 LOC)    │     to Nefarious event loop
                    └──────────────┘     (already exists for webpush)
```

**libkc internal layers**:
- `kc_http.c` — curl_multi wrapper, non-blocking HTTP
- `kc_jwt.c` — JWKS fetching, JWT signature verification
- `kc_cache.c` — User ID and representation caching
- `kc_url.c` — Keycloak endpoint URL construction
- `kc_keycloak.c` — High-level operations (verify_password, introspect, user_get, etc.)

**No new HTTP client code needed in Nefarious** — libkc and the adapter handle everything.

### 5.3 Keycloak REST Endpoints Used

| Endpoint | Method | Auth | Purpose | SASL Mechanism |
|----------|--------|------|---------|---------------|
| `/realms/{r}/protocol/openid-connect/token` | POST | Basic (client creds) | Password grant (ROPC) | PLAIN |
| `/admin/realms/{r}/users?q=x3_fingerprint:{fp}` | GET | Bearer | Fingerprint→user lookup | EXTERNAL |
| `/admin/realms/{r}/users?username={u}&exact=true` | GET | Bearer | User attribute lookup | SCRAM, ECDSA |
| `/realms/{r}/protocol/openid-connect/token/introspect` | POST | Basic | Token validation | OAUTHBEARER |
| `/realms/{r}/protocol/openid-connect/certs` | GET | None | JWKS (public keys) | OAUTHBEARER (offline) |
| `/realms/{r}/protocol/openid-connect/token` | POST | Basic | Client credentials grant | Admin token refresh |

**Admin token lifecycle**: libkc maintains a cached admin token (client_credentials grant) for admin API calls (user search, attribute lookup). Token is refreshed automatically when expired. PLAIN auth uses the password grant directly (no admin token needed).

### 5.4 SASL Session State

New fields on the client connection (or a separate allocation):

```c
struct SASLSession {
    enum sasl_mechanism mech;     /* PLAIN, EXTERNAL, OAUTHBEARER, SCRAM, ECDSA */
    enum sasl_state state;        /* INIT, WAITING_DATA, WAITING_KC, COMPLETE, FAILED */
    char *accumulated_data;       /* For chunked AUTHENTICATE (400-byte boundary) */
    size_t data_len;
    size_t data_alloc;
    int chunks_received;          /* Track 400-byte boundary for continuation */

    /* SCRAM-specific state (Phase 3) */
    char *client_first_bare;      /* Saved for channel binding */
    char *server_nonce;           /* Combined nonce */
    char *salt_b64;               /* From Keycloak user attributes */
    int iterations;

    /* Cleanup */
    struct Timer timeout;         /* FEAT_SASL_TIMEOUT timer */
};
```

**Lifecycle**: Allocated on `sasl_start()`, freed on completion/failure/timeout/abort. While waiting for Keycloak callback, `state = WAITING_KC` prevents processing further AUTHENTICATE messages.

### 5.5 Interaction with Bouncer Sessions

Bouncer session resume currently relies on SASL auth to identify the user. With SASL in Nefarious:

- `bounce_auto_resume()` runs after SASL sets the account — no change needed
- Account is set earlier in registration (before N message to network) — same timing
- Session `hs_account` matching works identically

**Benefit**: SASL auth completes faster (no P10 round-trip to X3 — though Keycloak HTTP adds ~45ms), so bouncer resume may be slightly faster.

**Keycloak-down scenario**: If Keycloak is unreachable and we fall back to P10 relay, bouncer resume timing is unchanged from current behavior.

### 5.6 Interaction with `draft/account-registration`

The `draft/account-registration` CAP uses RG/VF/RR P10 messages routed to X3. This **stays unchanged** — account registration remains in X3 (which creates the account in its credential store — LDAP for legacy X3, Keycloak for modern X3).

**No credential sync needed**: After X3 creates the account (in LDAP or Keycloak), the next SASL PLAIN auth hits Keycloak, which resolves the user via LDAP federation (legacy) or directly (modern). LDAP federation performs on-demand lookups, so newly created accounts are visible immediately.

### 5.7 Feature Configuration

New/modified features:

```c
FEAT_SASL_LOCAL          /* bool, default TRUE — use local Keycloak SASL */
FEAT_KEYCLOAK_URL        /* string — Keycloak base URL (e.g. "http://keycloak:8080") */
FEAT_KEYCLOAK_REALM      /* string — Keycloak realm name */
FEAT_KEYCLOAK_CLIENT_ID  /* string — OAuth2 client ID */
FEAT_KEYCLOAK_CLIENT_SECRET /* string — OAuth2 client secret */
```

**Note**: Some of these may already exist if `USE_LIBKC` is configured for webpush. Need to check whether the existing Keycloak config is shared or per-feature.

---

## 6. Migration Strategy

### Phase 1: PLAIN + EXTERNAL via Keycloak (MVP)
- Implement SASL mechanism framework in `sasl_auth.c`
- Refactor `m_authenticate.c` to dispatch locally when `FEAT_SASL_LOCAL` is enabled
- PLAIN handler: `kc_user_verify_password()` → callback → set account + numerics
- EXTERNAL handler: `kc_user_search()` with fingerprint attribute → callback → set account
- Update `sasl_server_available()` / `get_effective_sasl_mechanisms()` for local mode
- Keep P10 relay as fallback (Keycloak down or `FEAT_SASL_LOCAL = FALSE`)
- Add Keycloak config features to `ircd_features.c/h`
- **Zero X3 changes. Zero breaking changes. Existing setups work unchanged.**

### Phase 2: OAUTHBEARER + Caching
- OAUTHBEARER handler: `kc_token_verify_offline()` (local JWKS) with `kc_token_introspect()` fallback
- Negative auth cache: short-lived cache of failed username/password pairs (avoid hammering Keycloak)
- JWKS cache warm-up on startup via `kc_jwks_refresh()`
- Advertise `OAUTHBEARER` in CAP SASL mechanism list

### Phase 3: SCRAM + ECDSA
- SCRAM-SHA-256: Multi-step challenge-response using Keycloak user attributes (`x3_scram_sha256_*`)
  - Client-first → fetch stored credentials from Keycloak → server-first → client-final → verify
  - Requires one HTTP round-trip (user attribute lookup) on first message
- ECDSA-NIST256P-CHALLENGE: Fetch public key from Keycloak user attributes, verify signature locally

### Legacy X3 Compatibility (via Keycloak LDAP Federation)
- **Zero changes to legacy X3** — it keeps writing to LDAP as always
- Keycloak configured with LDAP User Federation → reads users from same LDAP server
- Nefarious validates via Keycloak → Keycloak resolves via LDAP federation
- **Coexistence**: Legacy X3 → LDAP (writes), Nefarious → Keycloak → LDAP (reads) — both work simultaneously
- P10 relay remains as fallback at all phases
- `FEAT_SASL_LOCAL = FALSE` reverts to pure relay behavior (current behavior, no Keycloak)
- Networks without Keycloak or LDAP: use P10 relay to X3 with SAXDB (no change from today)
- **Migration to Keycloak-direct**: When X3 is later migrated to speak Keycloak (our modern fork does), LDAP federation can be retired

---

## 7. Risk Analysis

### 7.1 Keycloak Availability
**Risk**: Keycloak goes down → SASL auth fails for all users.
**Mitigation**: P10 relay fallback to X3 when Keycloak is unreachable. libkc tracks Keycloak availability state. `kc_keycloak_available()` returns false after connection failures → automatic fallback. Keycloak typically has ~99.9% uptime with proper deployment.

### 7.2 Keycloak Latency
**Risk**: ~45ms average HTTP round-trip adds latency vs. previous P10 relay (~5ms local).
**Mitigation**: 45ms is imperceptible to users (IRC handshake already takes seconds). Outlier latency (~1s max observed) is handled by SASL timeout. libkc connection reuse and TCP keepalive minimize per-request overhead.

**Note**: The P10 relay path was also async with comparable latency (P10 → X3 processing → P10 response). Direct Keycloak may actually be faster in practice (one HTTP round-trip vs. P10 relay + X3 SASL state machine + X3's own Keycloak call for our fork).

### 7.3 Security Surface
**Risk**: IRCd now makes HTTP requests containing plaintext passwords (to Keycloak's ROPC endpoint).
**Mitigation**: Keycloak connection should use HTTPS in production (TLS-encrypted). In testnet, HTTP on Docker network is acceptable (internal traffic). The password is sent to Keycloak for hashing — it's never stored or logged by the IRCd. The ROPC grant is the standard OAuth2 pattern for this use case.

### 7.4 Keycloak Configuration Security
**Risk**: Client secret for Keycloak is stored in `ircd.conf` (potentially readable by opers via STATS).
**Mitigation**: Feature flags for credentials should use `FEAT_LAST_F` protection (not visible in STATS). Same pattern as existing TLS key paths. The client secret grants admin API access — it must be protected.

### 7.5 Account Registration Race
**Risk**: User registers via X3 REGISTER (which creates account in LDAP), immediately SASL auths before Keycloak's LDAP federation has seen the new account.
**Mitigation**: Keycloak LDAP federation performs **on-demand lookups** — when a user not in Keycloak's cache attempts to authenticate, Keycloak queries LDAP in real-time. The new account will be found immediately. There is no periodic sync delay for authentication lookups. For modern X3 (writing directly to Keycloak), the HTTP 201 response confirms creation before the client can attempt SASL. No race in either case.

### 7.6 SMD5 Legacy Credential Migration
**Risk**: Legacy X3 stores passwords as SMD5 (Salted MD5) in LDAP. During LDAP federation coexistence, this is not a problem — OpenLDAP handles SMD5 verification natively via LDAP bind. The risk emerges when **retiring LDAP**: Keycloak's native credential store doesn't support MD5/SMD5 (only PBKDF2/bcrypt/Argon2), so accounts with SMD5-only credentials can't authenticate without LDAP.
**Mitigation**: Keycloak Credential Provider SPI plugin (~200 LOC Java) to verify and lazily rehash SMD5 → PBKDF2. Standard Keycloak migration pattern. Alternatively, Keycloak can be configured to capture credentials on successful LDAP bind and re-store natively. P10 relay fallback ensures auth always works regardless. Over time, all active accounts are upgraded to PBKDF2. Modern X3 fork already creates accounts with PBKDF2.

### 7.7 libkc Maturity
**Risk**: libkc + ircd_kc_adapter integration has not been production-tested at scale.
**Mitigation**: The adapter is 362 lines of straightforward socket/timer mapping. webpush exercises the same code paths. Phased rollout with P10 fallback means any libkc issues are non-fatal. Extensive testnet validation before production deployment.

---

## 8. Existing Webhook Infrastructure

The project already has a complete Keycloak webhook pipeline across three layers. This infrastructure is not required for Phase 1 (SASL MVP) but becomes important for Phase 2+ (negative cache invalidation, real-time account suspension, SCRAM credential sync).

### 8.1 libkc Webhook Server (`kc_webhook.h/c`)

Generic async TCP/HTTP webhook receiver already in libkc:
- Configurable bind address, port, path, `X-Webhook-Secret` header validation
- Async event queue with batch processing (`queue_max`, `batch_size`, `batch_interval_ms`)
- Resource types: `USER`, `CREDENTIAL`, `GROUP_MEMBERSHIP`, `GROUP`, `USER_SESSION`, `ADMIN_EVENT`
- Event struct includes: resource type, operation (CREATE/UPDATE/DELETE), resource ID, JSON representation, timestamp

Since libkc is already linked into Nefarious for webpush, the webhook server is available with zero additional library dependencies.

### 8.2 X3 Webhook Handler (`keycloak_webhook.h/c`)

X3-specific business logic that processes webhook events from libkc's server:
- **Credential changes**: Invalidates SCRAM cache on password update, regenerates SCRAM-SHA-256 stored credentials
- **User deletion/suspension**: Removes auth cache entries, disconnects active sessions
- **x509 fingerprint updates**: Syncs certificate fingerprints for EXTERNAL auth
- **Group membership changes**: ChanServ access update queue (batch 20, 1s interval, deduplication, 5000 max queue)
- **Session revocation**: Processes Keycloak session logout events

This is the reference implementation for what Nefarious would need — its own webhook handler for SASL-relevant events.

### 8.3 Keycloak Webhook SPI (`keycloak-webhook-spi/`)

Java Keycloak plugin already deployed in the testnet:
- `WebhookEventListenerProvider.java` — listens to admin/user events, POSTs JSON to configured endpoints with async delivery, exponential backoff, retry
- `ScramCredentialProvider.java` — generates SCRAM-SHA-256 credentials on password change, stores in user attributes
- Config via env vars: `KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL`, `SECRET`, etc.

The SPI supports multiple webhook endpoints — Nefarious can register its own endpoint alongside X3's without any SPI changes.

### 8.4 Nefarious Webhook Handler (Future)

For Phase 2+, Nefarious would need a webhook handler analogous to X3's `keycloak_webhook.c`:
- **Negative auth cache invalidation**: On credential change, clear cached auth failures so users can re-authenticate immediately
- **Account suspension**: On user disable/delete, reject in-flight SASL and optionally disconnect sessions
- **SCRAM credential sync**: On password change, the SPI generates new SCRAM-SHA-256 credentials — Nefarious needs to know to invalidate any cached SCRAM state
- **OAUTHBEARER token revocation**: On session logout, invalidate cached token validations

The libkc webhook server handles all the network/HTTP plumbing. Nefarious only needs to implement the `kc_webhook_event_cb` callback with its own business logic (~200-400 LOC estimated).

---

## 9. Open Questions

1. **Shared Keycloak config**: Nefarious may already have Keycloak config for webpush. Should SASL reuse the same `kc_config` or have separate config features? (Likely: shared — same Keycloak instance, same realm, same client.)

2. **Account locking/suspension**: Keycloak has its own user enabled/disabled state. Should Nefarious check `kc_user.enabled` on SASL auth? X3 uses `HI_FLAG_SUSPENDED` — Keycloak has a direct equivalent via the user representation's `enabled` field. The ROPC grant will fail if the user is disabled, which naturally handles this.

3. **Negative caching**: How aggressively to cache auth failures? Too aggressive → locked-out users can't retry. Too permissive → Keycloak gets hammered by brute-force. X3 uses 60s MD5-of-username:password negative cache. Similar approach for Nefarious.

4. **Max logins enforcement**: X3 counts concurrent logins per account. With SASL in Nefarious, who tracks login count? Nefarious can count locally via the existing `cli_account()` tracking. Cross-server count requires P10 coordination (future work, not a SASL concern per se).

5. **Mechanism advertisement**: When `FEAT_SASL_LOCAL` is active, Nefarious should advertise its own mechanism list (not wait for X3's `SASL * * M` broadcast). The list is static: `PLAIN,EXTERNAL` in Phase 1, adding `OAUTHBEARER` in Phase 2, etc.

6. **SCRAM without Keycloak-stored credentials**: If accounts don't have `x3_scram_sha256_*` attributes in Keycloak, SCRAM-SHA-256 can't work. Should Nefarious compute and store SCRAM credentials in Keycloak on successful PLAIN auth? (This is what X3 does — lazy SCRAM credential generation.)

7. **LDAP attribute mapping for SASL mechanisms**: EXTERNAL requires a fingerprint attribute, SCRAM/ECDSA require custom credential attributes. Keycloak's LDAP federation can map LDAP attributes to Keycloak user attributes — need to verify that legacy X3's LDAP schema includes the necessary attributes (fingerprints, SCRAM stored credentials) and that Keycloak's LDAP mappers can surface them. If legacy X3 doesn't store fingerprints in LDAP, EXTERNAL auth via LDAP federation won't work (PLAIN still will via LDAP bind).

8. **LDAP federation sync mode**: Keycloak supports several LDAP sync modes — "import" (cache in Keycloak DB), "on-demand" (query LDAP per request), and periodic sync. For coexistence with legacy X3, on-demand or short-TTL periodic sync is needed to ensure password changes in LDAP are reflected quickly in Keycloak. The default Keycloak LDAP federation mode handles this well.

9. **SMD5 → PBKDF2 migration timeline**: During LDAP federation, LDAP bind handles SMD5 natively — no SPI needed. The SPI (or Keycloak credential capture on bind) is only needed for the LDAP retirement phase. How long should LDAP federation run before retiring it? Depends on what percentage of active users have been lazily rehashed to PBKDF2. Need monitoring to track migration progress.

---

## 10. Files Reference

### Nefarious (to modify)
| File | Purpose |
|------|---------|
| [m_authenticate.c](nefarious/ircd/m_authenticate.c) | Client AUTHENTICATE handler — refactor from relay to local dispatch |
| [m_cap.c](nefarious/ircd/m_cap.c) | CAP SASL advertisement — update `sasl_server_available()` for local mode |
| [m_sasl.c](nefarious/ircd/m_sasl.c) | P10 SASL response handler — keep for fallback relay |
| [s_auth.c](nefarious/ircd/s_auth.c) | IAuth SASL bridge — keep as alternative path |
| [m_account.c](nefarious/ircd/m_account.c) | P10 AC handler — keep for account state broadcast |
| [ircd_features.h](nefarious/include/ircd_features.h) | Add FEAT_SASL_LOCAL, FEAT_KEYCLOAK_* |
| [ircd_features.c](nefarious/ircd/ircd_features.c) | Feature defaults |
| [client.h](nefarious/include/client.h) | SASL session state fields |
| [ircd.c](nefarious/ircd/ircd.c) | Keycloak init (may already exist for webpush) |

### Nefarious (new files)
| File | Purpose |
|------|---------|
| `ircd/sasl_auth.c` | SASL mechanism framework + PLAIN/EXTERNAL handlers + Keycloak callbacks |
| `include/sasl_auth.h` | SASL auth API (sasl_start, sasl_continue, sasl_abort, mechanism enum) |
| `ircd/sasl_oauth.c` | OAUTHBEARER handler (Phase 2) |
| `ircd/sasl_scram.c` | SCRAM-SHA-256 handler (Phase 3) |

### Existing infrastructure (no changes needed)
| File | Purpose |
|------|---------|
| [ircd_kc_adapter.c](nefarious/ircd/ircd_kc_adapter.c) | libkc↔Nefarious event loop bridge (362 LOC, already exists) |
| [ircd_kc_adapter.h](nefarious/include/ircd_kc_adapter.h) | Adapter API (already exists) |
| [webpush.c](nefarious/ircd/webpush.c) | Example libkc consumer in Nefarious (reference implementation) |
| [thread_pool.h](nefarious/include/thread_pool.h) | Thread pool (available if needed, not required for Keycloak) |

### libkc (no changes needed)
| File | Purpose |
|------|---------|
| [kc_keycloak.h](libkc/include/kc_keycloak.h) | Public API — all SASL-relevant functions |
| [kc_keycloak.c](libkc/src/kc_keycloak.c) | Implementation (38K, user ops, password verify, introspect) |
| [kc_http.c](libkc/src/kc_http.c) | Async HTTP client (curl_multi wrapper) |
| [kc_jwt.c](libkc/src/kc_jwt.c) | JWKS + JWT validation (for OAUTHBEARER offline) |
| [kc_cache.c](libkc/src/kc_cache.c) | User/token caching |

### libkc Webhook (no changes needed — reuse as-is for Phase 2+)
| File | Purpose |
|------|---------|
| [kc_webhook.h](libkc/include/kc_webhook.h) | Webhook server API — config, start, stop, event types |
| [kc_webhook.c](libkc/src/kc_webhook.c) | Async TCP/HTTP webhook server implementation |

### X3 Webhook (reference implementation — not used by Nefarious)
| File | Purpose |
|------|---------|
| [keycloak_webhook.h](x3/src/keycloak_webhook.h) | X3 webhook handler API |
| [keycloak_webhook.c](x3/src/keycloak_webhook.c) | Business logic: SCRAM cache, ChanServ sync, session revocation |

### Keycloak SPI (no changes needed — register additional endpoint for Nefarious)
| File | Purpose |
|------|---------|
| [WebhookEventListenerProvider.java](keycloak-webhook-spi/) | Event listener + JSON POST to webhook endpoints |
| [ScramCredentialProvider.java](keycloak-webhook-spi/) | SCRAM-SHA-256 credential generation on password change |

### X3 (no changes needed for SASL)
| File | Notes |
|------|-------|
| `src/nickserv.c` | SASL handler stays as-is (P10 relay fallback path) |
| `src/proto-p10.c` | No new P10 messages needed |
