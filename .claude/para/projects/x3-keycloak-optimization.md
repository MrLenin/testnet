# X3 Keycloak Integration Optimization Plan

## Status: Phase 4 Complete - Testing

## Goal

**Primary objective**: Integrate `curl_multi` with X3's ioset event loop to make Keycloak HTTP requests non-blocking. This eliminates the fundamental bottleneck where X3's entire event loop stalls during authentication.

Phases 1-3 are incremental improvements that reduce blocking duration. Phase 4 eliminates blocking entirely.

## Problem Statement

SASL tests have ~70% pass rate due to Keycloak authentication latency:
- Valid auth: ~100-500ms typical, can spike to 20s+ under load
- Invalid auth: ~3-6s typical (password verification failure)
- Each auth creates new TCP+TLS connection (no connection reuse)

## Root Cause: X3 Event Loop Blocking

**Critical finding**: X3's entire event loop blocks during Keycloak HTTP requests.

### Blocking Chain
```
ioset_run()                          ← Main event loop
  └── engine->loop(&timeout)         ← Wait for I/O (epoll/select)
      └── cmd_sasl                   ← SASL message from IRCd
          └── handle_sasl_input      ← nickserv.c:7811
              └── sasl_packet        ← nickserv.c:7895
                  └── loc_auth()     ← nickserv.c:7751
                      └── kc_check_auth()
                          └── keycloak_get_user_token()
                              └── curl_easy_perform()  ← BLOCKS UP TO 30s
```

**Impact**: While one user authenticates with Keycloak:
- All other SASL auths queue up
- Channel ops, messages, other P10 commands wait
- Multiple rapid SASL attempts compound delays

## Current Architecture

### Authentication Flow
```
Client → IRCd → X3 (SASL) → Keycloak (HTTP/blocking) → X3 → IRCd → Client
```

### X3 Keycloak Code ([keycloak.c](../../x3/src/keycloak.c))
- `curl_perform()` - Creates fresh CURL handle per request (line 90)
- `keycloak_get_user_token()` - OAuth password grant (line 574)
- `curl_easy_perform()` - Synchronous/blocking call (line 187)
- 30s total timeout (line 186)
- No connection pooling

## Proposed Optimizations

### Phase 1: Quick Wins (Trivial Changes)

#### 1.1 Add TCP_NODELAY
**File**: `x3/src/keycloak.c`
**Change**: Add after `curl_easy_init()`
```c
curl_easy_setopt(curl, CURLOPT_TCP_NODELAY, 1L);
```
**Impact**: Eliminates Nagle algorithm delays for small HTTP requests

#### 1.2 Add Connection Timeout
**File**: `x3/src/keycloak.c`
**Change**: Add separate connection timeout
```c
curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);  // 5s for TCP+TLS
curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);        // 30s total (existing)
```
**Impact**: Faster failure detection if Keycloak is unreachable

### Phase 2: Connection Pooling (Medium Complexity)

#### 2.1 Persistent CURL Handle
**File**: `x3/src/keycloak.c`
**Change**: Keep a global/static CURL handle instead of init/cleanup each request
```c
static CURL *kc_curl_handle = NULL;

void keycloak_init(void) {
    kc_curl_handle = curl_easy_init();
    curl_easy_setopt(kc_curl_handle, CURLOPT_TCP_NODELAY, 1L);
    curl_easy_setopt(kc_curl_handle, CURLOPT_TCP_KEEPALIVE, 1L);
    // ... other persistent settings
}

void keycloak_cleanup(void) {
    if (kc_curl_handle) {
        curl_easy_cleanup(kc_curl_handle);
        kc_curl_handle = NULL;
    }
}
```
**Impact**: Reuses TCP+TLS connections, saves ~100-200ms per request

#### 2.2 Thread Safety Consideration
X3 is single-threaded, so a single static handle is safe. Add:
```c
curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);  // Required for non-main threads
```

### Phase 3: Response Caching (Low-Medium Complexity)

#### 3.1 Negative Auth Cache
**Purpose**: Avoid hitting Keycloak repeatedly for known-bad credentials
**Implementation**:
```c
struct auth_cache_entry {
    char username[128];
    char password_hash[65];  // SHA256 hash, not plaintext
    time_t expires;
    int result;  // KC_SUCCESS or KC_FORBIDDEN
};
```
**TTL**: 30-60 seconds for failures
**Security**: Only cache hash of password, not plaintext

#### 3.2 Token Caching for Admin Operations
Already partially implemented with `kc_admin_token` - verify it's working correctly.

### Phase 4: Async HTTP with curl_multi + ioset (Long-term Fix)

**This is the proper fix** for the event loop blocking issue.

#### Overview
Replace `curl_easy_perform()` (blocking) with `curl_multi` interface integrated into X3's ioset event loop. This allows Keycloak HTTP requests to be non-blocking.

#### Implementation Approach

**4.1 Create async HTTP infrastructure**
```c
// keycloak_async.c
#include <curl/multi.h>
#include "ioset.h"
#include "timeq.h"

static CURLM *curl_multi = NULL;

/* Per-socket tracking */
struct curl_sock_info {
    curl_socket_t sockfd;
    struct io_fd *io_fd;
    int action;  /* CURL_POLL_IN, CURL_POLL_OUT, etc */
};

/* Called by curl when socket state changes */
static int curl_socket_cb(CURL *easy, curl_socket_t s, int what,
                          void *userp, void *sockp) {
    struct curl_sock_info *si = sockp;

    if (what == CURL_POLL_REMOVE) {
        if (si && si->io_fd) {
            ioset_close(si->io_fd, 1);
            free(si);
        }
        curl_multi_assign(curl_multi, s, NULL);
        return 0;
    }

    if (!si) {
        /* New socket - register with ioset */
        si = calloc(1, sizeof(*si));
        si->sockfd = s;
        si->io_fd = ioset_add(s);
        si->io_fd->state = IO_CONNECTED;  /* Skip handshake */
        si->io_fd->readable_cb = curl_socket_ready;
        si->io_fd->data = si;
        curl_multi_assign(curl_multi, s, si);
    }

    si->action = what;
    ioset_update(si->io_fd);  /* Update poll flags */
    return 0;
}

/* Called when ioset reports socket ready */
static void curl_socket_ready(struct io_fd *fd) {
    struct curl_sock_info *si = fd->data;
    int running;
    curl_multi_socket_action(curl_multi, si->sockfd,
                             CURL_CSELECT_IN | CURL_CSELECT_OUT,
                             &running);
    curl_check_completed();  /* Check for finished transfers */
}

/* Called by curl when timeout changes */
static int curl_timer_cb(CURLM *multi, long timeout_ms, void *userp) {
    if (timeout_ms < 0) {
        timeq_del(0, curl_timeout_fired, NULL, TIMEQ_IGNORE_WHEN);
    } else {
        time_t when = now + (timeout_ms / 1000) + 1;
        timeq_del(0, curl_timeout_fired, NULL, TIMEQ_IGNORE_WHEN);
        timeq_add(when, curl_timeout_fired, NULL);
    }
    return 0;
}

/* Called by timeq when curl timeout fires */
static void curl_timeout_fired(void *data) {
    int running;
    curl_multi_socket_action(curl_multi, CURL_SOCKET_TIMEOUT, 0, &running);
    curl_check_completed();
}
```

**4.2 Completion handling and request tracking**
```c
/* Track pending auth requests */
struct kc_async_request {
    CURL *easy;
    struct SASLSession *session;
    struct memory response;       /* Response buffer */
    void (*callback)(struct SASLSession *, int result, struct handle_info *);
};

/* Check for completed transfers */
static void curl_check_completed(void) {
    CURLMsg *msg;
    int msgs_left;

    while ((msg = curl_multi_info_read(curl_multi, &msgs_left))) {
        if (msg->msg == CURLMSG_DONE) {
            CURL *easy = msg->easy_handle;
            struct kc_async_request *req;
            curl_easy_getinfo(easy, CURLINFO_PRIVATE, &req);

            /* Process result */
            struct handle_info *hi = NULL;
            int result = KC_ERROR;
            if (msg->data.result == CURLE_OK) {
                long http_code;
                curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &http_code);
                if (http_code == 200) {
                    result = KC_SUCCESS;
                    /* Parse token, lookup/create handle_info */
                } else if (http_code == 401) {
                    result = KC_FORBIDDEN;
                }
            }

            /* Invoke callback */
            req->callback(req->session, result, hi);

            /* Cleanup */
            curl_multi_remove_handle(curl_multi, easy);
            curl_easy_cleanup(easy);
            free(req->response.response);
            free(req);
        }
    }
}

/* Start async auth request */
int kc_check_auth_async(const char *handle, const char *password,
                        struct SASLSession *session,
                        void (*callback)(struct SASLSession *, int, struct handle_info *)) {
    struct kc_async_request *req = calloc(1, sizeof(*req));
    req->session = session;
    req->callback = callback;

    /* Setup CURL easy handle */
    req->easy = curl_easy_init();
    /* ... configure URL, POST data, etc ... */
    curl_easy_setopt(req->easy, CURLOPT_PRIVATE, req);
    curl_easy_setopt(req->easy, CURLOPT_WRITEFUNCTION, curl_write_cb);
    curl_easy_setopt(req->easy, CURLOPT_WRITEDATA, &req->response);

    /* Add to multi handle - returns immediately */
    curl_multi_add_handle(curl_multi, req->easy);
    return 0;
}
```

**4.3 SASL session state machine**
```c
enum sasl_state {
    SASL_STATE_INIT,
    SASL_STATE_WAITING_KEYCLOAK,  /* Async HTTP in progress */
    SASL_STATE_COMPLETE
};

struct SASLSession {
    /* ... existing fields ... */
    enum sasl_state state;
};

/* Modified sasl_packet() for PLAIN mechanism */
/* In nickserv.c:7751 area */
if (!strcmp(session->mech, "PLAIN")) {
    /* ... parse credentials ... */

    /* Instead of blocking loc_auth(): */
    session->state = SASL_STATE_WAITING_KEYCLOAK;
    kc_check_auth_async(authcid, passwd, session, sasl_auth_callback);
    return;  /* Don't delete session yet - wait for callback */
}

/* Callback when Keycloak responds */
static void sasl_auth_callback(struct SASLSession *session, int result,
                                struct handle_info *hi) {
    if (result == KC_SUCCESS && hi) {
        char buffer[256];
        snprintf(buffer, sizeof(buffer), "%s " FMT_TIME_T,
                 hi->handle, hi->registered);
        irc_sasl(session->source, session->uid, "L", buffer);
        irc_sasl(session->source, session->uid, "D", "S");
    } else {
        irc_sasl(session->source, session->uid, "D", "F");
    }
    sasl_delete_session(session);
}
```

**4.4 Edge case: Client disconnects mid-auth**
```c
/* When client disconnects, IRCd sends SASL D A (abort) */
/* In handle_sasl_input(), subcmd "D": */
if (!strcmp(subcmd, "D")) {
    if (sess->state == SASL_STATE_WAITING_KEYCLOAK) {
        /* Mark session as cancelled - callback will check this */
        sess->state = SASL_STATE_CANCELLED;
        /* Don't delete yet - let callback clean up */
    } else {
        sasl_delete_session(sess);
    }
    return;
}

/* In sasl_auth_callback(): */
static void sasl_auth_callback(struct SASLSession *session, ...) {
    if (session->state == SASL_STATE_CANCELLED) {
        /* Client already disconnected, just cleanup */
        sasl_delete_session(session);
        return;
    }
    /* ... normal processing ... */
}
```

#### Files to Modify
- `x3/src/keycloak.c` - Add curl_multi infrastructure, async API
- `x3/src/keycloak.h` - Async API declarations
- `x3/src/nickserv.c` - Refactor `sasl_packet()` to async pattern, state machine
- `x3/src/ioset.h` - May need to expose `ioset_update()` for write interest changes

#### Complexity
- High effort (~2-3 days for experienced C developer)
- Requires understanding of both X3 ioset and libcurl multi API
- Need to handle error cases (Keycloak timeout, connection errors)
- Session cleanup if client disconnects mid-auth
- Connection pooling comes free with curl_multi (reuses connections)

#### Benefits
- X3 event loop never blocks on Keycloak
- Multiple SASL auths can be in-flight simultaneously
- Other IRC operations continue during auth
- Dramatically improved responsiveness under load

## Implementation Order

**Quick wins (reduce blocking duration):**
1. [x] Phase 1.1: TCP_NODELAY ✅
2. [x] Phase 1.2: CONNECTTIMEOUT ✅
3. [x] Phase 2.1: Connection pooling ✅

**Brute force protection:**
4. [x] Phase 3.1: Negative cache ✅
   - MD5 hash of username:password for cache key (`authfail:` prefix)
   - 60-second TTL on failed auth cache entries
   - Checked before Keycloak call, cached on failure in callback
   - Prevents repeated Keycloak calls for same bad credentials

**Goal (eliminate blocking):**
5. [x] Phase 4: curl_multi + ioset integration ✅
   - Implemented async HTTP infrastructure in keycloak.c
   - SASL session state machine (INIT, WAITING_KEYCLOAK, CANCELLED)
   - Impersonation support in async callback
   - SASL EXTERNAL (fingerprint lookup) now async
   - SASL OAUTHBEARER (token introspection) now async
   - All three SASL mechanisms use non-blocking Keycloak calls

**Performance optimization:**
6. [x] Phase 5: Local JWT Validation ✅
   - JWKS cache with 1-hour TTL
   - Base64url decoding for JWT parsing
   - RSA public key construction from JWKS n/e values (OpenSSL 1.1 and 3.0 compatible)
   - RS256 signature verification with EVP_DigestVerify
   - JWT claims parsing (exp, iat, sub, preferred_username, email, x3_opserv_level)
   - Hybrid flow: local validation first, fallback to introspection if needed

7. [x] Phase 6: LMDB Fingerprint Cache ✅
   - SASL EXTERNAL fingerprint→username cache in LMDB (`fp:` prefix)
   - 3-tier lookup: LMDB cache → local sslfps → Keycloak HTTP
   - 1-hour TTL on cache entries (format: `timestamp:username`)
   - Expired entries auto-deleted on read
   - Generic `x3_lmdb_get/set/delete` functions implemented

**Completed enhancements:**
- [x] X3-issued session tokens for SASL PLAIN optimization ✅
  - After successful PLAIN auth, issue session token to client
  - Token can be used as password in subsequent PLAIN auths
  - X3 detects token format (`x3tok:...`) and validates locally
  - LMDB storage: `session:<token_id>` → `expiry:version:username`
  - No Keycloak call needed for reconnects
  - Session versioning for bulk revocation (`sessver:` prefix)
  - Automatic revocation on password changes

- [x] Keycloak webhook for real-time cache invalidation ✅
  - HTTP listener on configurable port (`keycloak_webhook_port`)
  - Shared secret authentication (`keycloak_webhook_secret`)
  - Handles Keycloak Admin Events:
    - USER DELETE: Invalidates all caches for user
    - USER UPDATE: Logs update (auth cache auto-refreshes)
    - CREDENTIAL DELETE: Removes fingerprint from cache
    - CREDENTIAL UPDATE/CREATE: Logs password change
    - USER_SESSION DELETE: Revokes X3 session tokens
  - Files: `keycloak_webhook.c`, `keycloak_webhook.h`
  - Statistics tracking for monitoring

**Implemented enhancements:**
- [x] SCRAM-SHA-256 for session tokens (enhanced security) - IMPLEMENTED 2026-01-05
  - Instead of token-as-plaintext-password, use SCRAM exchange
  - After PLAIN auth, generate SCRAM verifier for session token
  - LMDB storage: `scram:<token_id>` → `expiry:iteration:salt:storedkey:serverkey:username`
  - Token never sent in plaintext, replay-resistant via nonces
  - Works with WeeChat and other SCRAM-SHA-256 capable clients
  - Client uses username `x3scram:tokenid` for SCRAM auth
  - Files: `x3_lmdb.h`, `x3_lmdb.c`, `nickserv.c`

### Phase 5: Local JWT Validation (High Impact)

**Problem**: Token introspection requires an HTTP round-trip to Keycloak for every OAUTHBEARER auth. Even with async, we're still waiting for Keycloak to respond.

**Solution**: Validate JWT tokens locally using Keycloak's public key from the JWKS endpoint. Only fall back to introspection for edge cases (revocation checks).

#### 5.1 JWKS Public Key Caching
```c
// keycloak.c
struct jwks_cache {
    char *kid;           // Key ID
    EVP_PKEY *pkey;      // Parsed public key
    time_t fetched;      // When we fetched it
    time_t expires;      // Cache expiry (e.g., 1 hour)
};

static struct jwks_cache jwks_cache = {0};

/* Fetch JWKS from: {keycloak_url}/realms/{realm}/protocol/openid-connect/certs */
int keycloak_refresh_jwks(void);
```

#### 5.2 Local Token Validation
```c
/* Validate JWT signature locally without calling Keycloak */
int keycloak_validate_jwt_local(const char *token, struct kc_token_info *info) {
    /* 1. Base64-decode header, get "kid" */
    /* 2. Look up public key from jwks_cache */
    /* 3. Verify RS256 signature using OpenSSL */
    /* 4. Check exp, iat, iss claims */
    /* 5. Extract preferred_username, sub, etc into info */
    return KC_SUCCESS;  /* or KC_ERROR if invalid */
}
```

#### 5.3 Hybrid Approach
```c
int keycloak_introspect_or_validate(const char *token, struct kc_token_info **info) {
    /* Try local validation first */
    if (keycloak_validate_jwt_local(token, *info) == KC_SUCCESS) {
        return KC_SUCCESS;  /* No HTTP call needed! */
    }

    /* Fall back to introspection for:
     * - Opaque tokens
     * - Key rotation (unknown kid)
     * - Explicit revocation checks
     */
    return keycloak_introspect_token(...);
}
```

#### Benefits
- **Eliminates HTTP latency** for valid JWT tokens
- **Offline validation** - works even if Keycloak is temporarily slow
- **Reduced Keycloak load** - only introspect when necessary
- Public key cached for hours (JWKS rarely changes)

#### Dependencies
- OpenSSL (already linked for TLS)
- JSON parsing (already have jansson)
- Base64 decoding (already have)

#### Complexity
- Medium effort (~1-2 days)
- Need to handle key rotation gracefully
- RS256 signature verification with OpenSSL EVP API

## Testing Strategy

After each phase, run 30 SASL tests:
```bash
cd /home/ibutsu/testnet/tests && for i in {1..30}; do echo "=== Run $i ===" && IRC_HOST=localhost npm test -- src/ircv3/sasl.test.ts --reporter=basic 2>&1 | grep -E 'Tests|FAIL|✓|×'; done
```

Target: 90%+ pass rate

## Files to Modify

- `x3/src/keycloak.c` - Main implementation
- `x3/src/keycloak.h` - Add init/cleanup function declarations if needed
- `x3/src/nickserv.c` - Call keycloak_init() at startup

## Risks

- Connection pooling: Handle stale connections (Keycloak restart)
- Caching: Security implications of caching auth results
- Thread safety: X3 is single-threaded but verify no async callbacks

## Metrics

| Metric | Before | After Phase 1 | After Phase 2 |
|--------|--------|---------------|---------------|
| Pass rate | 70% | TBD | TBD |
| Avg auth time | ~500ms | TBD | TBD |
| P99 auth time | ~6s | TBD | TBD |

---

## Channel Access Sync Architecture

### Overview

X3 can synchronize channel access levels with Keycloak groups, using LMDB as a local cache. This allows:
1. Keycloak to be the authoritative source for channel access
2. Access levels to persist even if SAXDB data is lost
3. Admins to manage IRC access through Keycloak's group UI

### Configuration Options

```conf
"chanserv" {
    "keycloak_access_sync" "1";        // Enable Keycloak → X3 sync
    "keycloak_bidirectional_sync" "1"; // Enable X3 → Keycloak sync
    "keycloak_hierarchical_groups" "1"; // Use path-based groups
    "keycloak_use_group_attributes" "0"; // Use x3_access_level attribute
    "keycloak_group_prefix" "irc-channels"; // Group prefix/path
    "keycloak_sync_frequency" "3600";  // Sync interval in seconds
};
```

### Two Sync Modes

#### 1. Suffix Mode (Default, `keycloak_use_group_attributes=0`)

Uses multiple groups per channel with predefined access level suffixes:

**Hierarchical (`keycloak_hierarchical_groups=1`):**
```
/irc-channels/#help/owner     → 500 (owner)
/irc-channels/#help/coowner   → 480 (co-owner)
/irc-channels/#help/manager   → 400 (manager)
/irc-channels/#help/op        → 200 (op)
/irc-channels/#help/halfop    → 100 (halfop)
/irc-channels/#help/peon      → 1   (peon)
```

**Flat (`keycloak_hierarchical_groups=0`):**
```
irc-channel-#help-owner
irc-channel-#help-op
...etc
```

**Pros:**
- Works with standard Keycloak groups
- Easy to audit group membership
- No custom attributes required

**Cons:**
- Limited to predefined levels (1, 100, 200, 400, 480, 500)
- No fine-grained levels (e.g., 150, 250)
- Multiple groups per channel

#### 2. Attribute Mode (`keycloak_use_group_attributes=1`)

Uses a single group per channel with `x3_access_level` attribute on members:

**Structure:**
```
/irc-channels/#help            → Group for channel
  └── user1 (x3_access_level=500)
  └── user2 (x3_access_level=200)
  └── user3 (x3_access_level=150)  ← Custom level!
```

**Pros:**
- Any access level 1-500 supported
- Single group per channel
- More flexible access control

**Cons:**
- Requires custom user attribute in Keycloak
- More complex Keycloak configuration
- Attribute must be set on group membership, not user

**Note:** Currently `x3_access_level` support is experimental. The attribute needs to be properly configured in Keycloak as a group-member attribute.

### Data Flow

```
┌─────────────┐     sync      ┌──────────┐    cache    ┌──────────┐
│  Keycloak   │ ───────────►  │   LMDB   │ ◄─────────► │   X3     │
│  (groups)   │               │ (cache)  │             │ (memory) │
└─────────────┘               └──────────┘             └──────────┘
      ▲                                                      │
      │                   bidirectional                      │
      └──────────────────────────────────────────────────────┘
```

### Storage Division: LMDB vs SAXDB

LMDB stores **specific cached/optimized data** only:

| LMDB Prefix | Purpose |
|-------------|---------|
| `chanaccess:` | Keycloak-synced channel access levels |
| `meta:` | User/channel metadata (with compression) |
| `fp:` | SASL EXTERNAL fingerprint→username cache |
| `authfail:` | Failed auth attempt cache (brute force protection) |
| `fpfail:` | Failed fingerprint lookup cache |

SAXDB remains the **primary persistent store** for:
- Full account data (`handle_info` - passwords, email, settings)
- Channel registrations (`chanData` - modes, settings, bans)
- User-channel relationships (`userData` - access levels, info strings)
- Module state (ChanServ, NickServ, OpServ configurations)

**Key point:** LMDB channel access entries are a **cache layer** that can override SAXDB when Keycloak sync is enabled. They don't replace SAXDB - they augment it with Keycloak-sourced data.

### Cache TTL Validation

- Cache entries include timestamps
- Entries older than `sync_frequency * 2` are considered stale
- Stale entries trigger a warning log but fall back to X3's data

### Authority Model

#### Channel Access
**X3 is authoritative for channel state.** Keycloak/LMDB is the storage backend.

| Scenario | Behavior |
|----------|----------|
| User in X3 only | X3's value is used |
| User in LMDB only | Imported from Keycloak (user added via Keycloak UI) |
| User in both | **X3 wins** - LMDB is ignored |
| LMDB cache stale | Entry ignored, X3 value used (or not found) |

This ensures ChanServ commands always take precedence. LMDB only fills gaps for users that were added through Keycloak's admin UI before they connected to IRC.

#### User Accounts
Users have **dual-origin creation**:

| Origin | Flow |
|--------|------|
| IRC registration | `AUTH REGISTER` → X3 creates → pushes to Keycloak |
| Keycloak web flow | User registers in Keycloak → X3 imports on first SASL auth |
| Keycloak admin | Admin creates user → X3 imports on first SASL auth |

For accounts, Keycloak is effectively the "source of truth" for authentication (passwords, OAuth tokens), while X3 maintains runtime state (nicks, hostmasks, flags).

### Improvements Made (2026-01-05)

1. **Fixed hardcoded prefix** - `chanserv_delete_keycloak_channel()` now uses config prefix
2. **Added cache TTL** - LMDB entries include timestamps for staleness detection
3. **Correct authority model** - X3 is authoritative; LMDB only imports users not in X3
4. **Sync conflict logging** - Logs when Keycloak sync overwrites existing LMDB values

---

## Phase 7: Positive Auth Caching (NEW)

### Status: IMPLEMENTED ✅ (2026-01-12)

### Problem Statement

Every AUTH command and SASL PLAIN triggers a Keycloak token endpoint call, even for recently-validated credentials. With the webhook infrastructure already in place, we can safely cache successful authentications.

### Current State (What We Have)

| Component | Status |
|-----------|--------|
| Password change detection in SPI | ✅ Fires UPDATE_CREDENTIAL/RESET_PASSWORD |
| Webhook delivery to X3 | ✅ Async with retry |
| Cache invalidation on webhook | ✅ `x3_lmdb_scram_revoke_all()` called |
| Negative auth cache | ✅ `authfail:` prefix, 60s TTL |
| **Positive auth cache** | ❌ Missing |

### Design

Since password changes trigger webhooks that invalidate caches, we can safely cache successful auth results with longer TTLs.

#### 7.1 Auth Success Cache Structure

```c
// LMDB storage: authsuccess:<account_lower> → timestamp:password_hash
// password_hash = MD5(password) - for cache key matching, not security

#define AUTH_SUCCESS_CACHE_TTL 3600  // 1 hour (safe with webhook invalidation)
#define AUTH_SUCCESS_PREFIX "authsuccess:"

struct auth_success_entry {
    time_t timestamp;
    char password_hash[33];  // MD5 hex string
};
```

#### 7.2 Cache Lookup Flow

```c
int kc_check_auth_cached(const char *account, const char *password) {
    char key[256];
    char password_hash[33];

    // Compute MD5 of password for cache key matching
    compute_md5(password, password_hash);

    // Check success cache first
    snprintf(key, sizeof(key), AUTH_SUCCESS_PREFIX "%s", account);
    char *cached = x3_lmdb_get(key);

    if (cached) {
        time_t cached_time;
        char cached_hash[33];
        if (sscanf(cached, "%ld:%32s", &cached_time, cached_hash) == 2) {
            // Check TTL
            if (now - cached_time < AUTH_SUCCESS_CACHE_TTL) {
                // Check password hash matches
                if (strcmp(password_hash, cached_hash) == 0) {
                    free(cached);
                    return KC_SUCCESS;  // Cache hit!
                }
            }
        }
        free(cached);
    }

    return KC_CACHE_MISS;  // Not in cache, call Keycloak
}
```

#### 7.3 Cache Population (on successful auth)

```c
void kc_cache_auth_success(const char *account, const char *password) {
    char key[256];
    char value[256];
    char password_hash[33];

    compute_md5(password, password_hash);
    snprintf(key, sizeof(key), AUTH_SUCCESS_PREFIX "%s", account);
    snprintf(value, sizeof(value), "%ld:%s", (long)now, password_hash);

    x3_lmdb_set(key, value);
}
```

#### 7.4 Cache Invalidation (on password change webhook)

```c
// In keycloak_webhook.c, when CREDENTIAL/UPDATE with type=password:
void invalidate_auth_caches(const char *username) {
    char key[256];

    // Invalidate success cache
    snprintf(key, sizeof(key), AUTH_SUCCESS_PREFIX "%s", username);
    x3_lmdb_delete(key);

    // Existing: invalidate SCRAM caches
    x3_lmdb_scram_revoke_all(username);
    x3_lmdb_scram_acct_delete_all(username);

    // Existing: invalidate session tokens
    // (already handled by session versioning)
}
```

### Integration Points

| File | Changes |
|------|---------|
| `x3/src/keycloak.c` | Add `kc_check_auth_cached()`, `kc_cache_auth_success()` |
| `x3/src/keycloak_webhook.c` | Call `invalidate_auth_caches()` on CREDENTIAL/UPDATE |
| `x3/src/nickserv.c` | Check cache in `loc_auth()` before Keycloak call |

### Expected Impact

| Scenario | Before | After |
|----------|--------|-------|
| Repeat auth (same password) | ~100-500ms (Keycloak) | <1ms (LMDB) |
| Auth after password change | ~100-500ms | ~100-500ms (cache miss) |
| Test suite pool accounts | 15-20s first auth | <1ms subsequent |

### Security Considerations

1. **Password not stored** - Only MD5 hash stored (for matching), not recoverable password
2. **Webhook invalidation** - Password changes immediately invalidate cache
3. **TTL safety net** - Even if webhook fails, cache expires in 1 hour
4. **Per-account granularity** - Cache key includes account name

### Implementation Notes (2026-01-12)

**Files modified:**
- `x3/src/x3_lmdb.h` - Added `LMDB_PREFIX_AUTHSUCCESS` constant
- `x3/src/nickserv.h` - Added `invalidate_authsuccess_cache()` declaration
- `x3/src/nickserv.c`:
  - Added `AUTHSUCCESS_CACHE_TTL` (3600 seconds = 1 hour)
  - Added `check_authsuccess_cache()` - checks cache and validates password hash
  - Added `cache_authsuccess()` - stores timestamp:password_hash by username
  - Added `invalidate_authsuccess_cache()` - deletes cache entry by username
  - Integrated cache check in SASL PLAIN handler (after negative cache, before Keycloak)
  - Integrated cache population in async callback (on successful non-impersonating auth)
- `x3/src/keycloak_webhook.c` - Added `invalidate_authsuccess_cache()` call on password change

**Key design decisions:**
- Cache key: `authsuccess:<username_lower>` (enables O(1) invalidation by username)
- Cache value: `<timestamp>:<password_hash>` (MD5 hash for cache matching)
- Password hash computed as MD5(username:password) - same as negative cache
- Only non-impersonating users populate cache (impersonation auth not cached)
- Cache hit fast-tracks to success without Keycloak call

---

## Phase 8: SCRAM Generation in Keycloak SPI (NEW)

### Status: PLANNED

### Problem Statement

When a password changes in Keycloak, the webhook notifies X3 which invalidates SCRAM caches. However, X3 must then regenerate SCRAM credentials on-demand during the next SASL auth, adding latency.

**Current flow (suboptimal):**
```
Password change → Webhook → X3 invalidates SCRAM → User auths →
X3 calls Keycloak → Regenerate SCRAM → Cache
```

**Desired flow:**
```
Password change → SPI generates SCRAM → Webhook delivers SCRAM →
X3 pre-populates cache → User auths → Instant SCRAM validation
```

### The Challenge

Keycloak's Admin Events don't include the plaintext password - they only notify that a password changed. SCRAM generation requires the plaintext to compute:
- Salt (random)
- StoredKey = H(ClientKey)
- ServerKey = HMAC(SaltedPassword, "Server Key")

### Solution: CredentialInputUpdater SPI

Keycloak's `CredentialInputUpdater` interface lets us intercept credential updates BEFORE Keycloak hashes the password. We can generate SCRAM at that point and store it in user attributes.

#### 8.1 New Java Class: ScramCredentialGenerator

```java
// keycloak-webhook-spi/src/main/java/.../ScramCredentialGenerator.java
package net.afternet.keycloak.webhook;

import org.keycloak.credential.CredentialInputUpdater;
import org.keycloak.credential.CredentialInput;
import org.keycloak.credential.CredentialModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

public class ScramCredentialGenerator implements CredentialInputUpdater {

    private static final int SCRAM_ITERATIONS = 4096;
    private static final int SALT_LENGTH = 16;

    @Override
    public boolean supportsCredentialType(String credentialType) {
        return CredentialModel.PASSWORD.equals(credentialType);
    }

    @Override
    public boolean updateCredential(RealmModel realm, UserModel user,
                                    CredentialInput input) {
        if (!CredentialModel.PASSWORD.equals(input.getType())) {
            return false;  // Not a password, don't consume
        }

        String plaintext = input.getChallengeResponse();
        if (plaintext == null || plaintext.isEmpty()) {
            return false;
        }

        try {
            // Generate SCRAM-SHA-256 credentials
            byte[] salt = new byte[SALT_LENGTH];
            new SecureRandom().nextBytes(salt);

            byte[] saltedPassword = pbkdf2("SHA-256", plaintext.getBytes("UTF-8"),
                                           salt, SCRAM_ITERATIONS, 32);

            byte[] clientKey = hmac("HmacSHA256", saltedPassword, "Client Key".getBytes());
            byte[] storedKey = sha256(clientKey);
            byte[] serverKey = hmac("HmacSHA256", saltedPassword, "Server Key".getBytes());

            // Store in user attributes (webhook will pick these up)
            String saltB64 = Base64.getEncoder().encodeToString(salt);
            String storedKeyB64 = Base64.getEncoder().encodeToString(storedKey);
            String serverKeyB64 = Base64.getEncoder().encodeToString(serverKey);

            user.setSingleAttribute("x3_scram_salt", saltB64);
            user.setSingleAttribute("x3_scram_iterations", String.valueOf(SCRAM_ITERATIONS));
            user.setSingleAttribute("x3_scram_stored_key", storedKeyB64);
            user.setSingleAttribute("x3_scram_server_key", serverKeyB64);

            return false;  // Don't consume - let default handler also process

        } catch (Exception e) {
            // Log error but don't block password change
            return false;
        }
    }

    // ... PBKDF2, HMAC, SHA256 helper methods ...
}
```

#### 8.2 Register SPI Provider

```
// META-INF/services/org.keycloak.credential.CredentialInputUpdater
net.afternet.keycloak.webhook.ScramCredentialGenerator
```

#### 8.3 Webhook Enhancement

When the webhook fires for CREDENTIAL/UPDATE, include the SCRAM attributes if present:

```java
// In WebhookEventListenerProvider.java
private String getUserRepresentation(UserModel user) {
    JsonObject repr = new JsonObject();
    repr.addProperty("username", user.getUsername());
    repr.addProperty("email", user.getEmail());

    // Include SCRAM credentials if present
    String scramSalt = user.getFirstAttribute("x3_scram_salt");
    if (scramSalt != null) {
        repr.addProperty("x3_scram_salt", scramSalt);
        repr.addProperty("x3_scram_iterations",
            user.getFirstAttribute("x3_scram_iterations"));
        repr.addProperty("x3_scram_stored_key",
            user.getFirstAttribute("x3_scram_stored_key"));
        repr.addProperty("x3_scram_server_key",
            user.getFirstAttribute("x3_scram_server_key"));
    }

    return repr.toString();
}
```

#### 8.4 X3 Webhook Handler Enhancement

```c
// In keycloak_webhook.c, handle_credential_update():
void handle_credential_update(json_t *event) {
    const char *username = get_username_from_event(event);
    json_t *repr = json_object_get(event, "representation");

    // Check for SCRAM credentials in representation
    const char *scram_salt = json_string_value(json_object_get(repr, "x3_scram_salt"));
    const char *scram_iterations = json_string_value(json_object_get(repr, "x3_scram_iterations"));
    const char *scram_stored_key = json_string_value(json_object_get(repr, "x3_scram_stored_key"));
    const char *scram_server_key = json_string_value(json_object_get(repr, "x3_scram_server_key"));

    if (scram_salt && scram_iterations && scram_stored_key && scram_server_key) {
        // Pre-populate SCRAM cache
        x3_lmdb_scram_set(username,
                          atoi(scram_iterations),
                          scram_salt,
                          scram_stored_key,
                          scram_server_key);
        log_module(MAIN_LOG, LOG_INFO,
                   "Pre-populated SCRAM cache for %s via webhook", username);
    } else {
        // No SCRAM in webhook, invalidate and let regenerate on-demand
        x3_lmdb_scram_revoke_all(username);
        x3_lmdb_scram_acct_delete_all(username);
    }
}
```

### Files to Modify

| File | Changes |
|------|---------|
| `keycloak-webhook-spi/src/.../ScramCredentialGenerator.java` | **NEW** - Generate SCRAM on password change |
| `keycloak-webhook-spi/src/.../WebhookEventListenerProvider.java` | Include SCRAM attrs in representation |
| `keycloak-webhook-spi/META-INF/services/...CredentialInputUpdater` | **NEW** - Register SPI |
| `x3/src/keycloak_webhook.c` | Parse SCRAM from webhook, pre-populate cache |

### Implementation Order

1. Implement ScramCredentialGenerator in SPI
2. Test SCRAM attribute generation on password change
3. Update webhook to include SCRAM in representation
4. Update X3 webhook handler to pre-populate cache
5. Verify SCRAM auth works immediately after password change

### Security Considerations

1. **SCRAM verifiers, not password** - Only StoredKey/ServerKey stored (cannot recover password)
2. **Attributes are read-only to users** - Only admins can see x3_scram_* attributes
3. **Webhook authentication** - SCRAM delivered over authenticated webhook channel
4. **No plaintext in logs** - SCRAM values are cryptographic, not sensitive

### Expected Impact

| Scenario | Before | After |
|----------|--------|-------|
| First SCRAM auth after password change | ~200-500ms (regenerate) | <1ms (pre-cached) |
| SCRAM auth flow | X3 generates on-demand | SPI pre-generates |

---

## Implementation Priority

| Phase | Task | Effort | Impact | Dependencies |
|-------|------|--------|--------|--------------|
| 7 | Auth success cache | Low | High | Webhook infrastructure (done) |
| 8 | SCRAM generation in SPI | Medium | Medium | Phase 7 (for testing) |

Phase 7 should be implemented first as it provides immediate benefit for the test suite and production auth load. Phase 8 is an enhancement for SCRAM-specific optimization.
