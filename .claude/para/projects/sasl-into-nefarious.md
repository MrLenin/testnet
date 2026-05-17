# Plan: Move SASL Authentication into Nefarious IRCd ✅ COMPLETE

## Status

All phases implemented and committed on `feat/sasl-local-keycloak`:
- **Phase 1a**: SASL PLAIN ✅ (commit `987d32f`)
- **Phase 1b**: SASL EXTERNAL ✅ (commit `fe29704`)
- **Phase 2**: SASL OAUTHBEARER ✅ (commit `11c53a2`) — includes JWKS cache priming + client credentials priming at startup
- **Phase 3**: SCRAM-SHA-256 + ECDSA-NIST256P-CHALLENGE ✅ (commit `bf03278`)

**Remaining — Phase 4: Auth Caches + Webhooks**:
- **Phase 4a**: Auth caches (negative + positive) ✅ — in-memory SipHash tables, feature flags
- **Phase 4b**: Keycloak webhook handler ✅ — libkc `kc_webhook_init()` callback, cache invalidation, forced deauth (AC U) + optional kill
- **Phase 4c**: SPI multi-URL ✅ — comma-separated URL support in WebhookConfig, fan-out delivery with independent retry per endpoint

**Deferred**:
- SCRAM credential cache (pre-warm via webhook, avoid `kc_user_get()` round-trip on SCRAM auth)
- Fingerprint cache (pre-warm via webhook, avoid `kc_user_search()` round-trip on EXTERNAL auth)
- OAUTHBEARER session/token revocation via webhook
- Lazy SCRAM credential generation on successful PLAIN auth (compute + store in Keycloak for users without SCRAM creds)
- Negative auth cache TTL auto-scaling (increase TTL on repeated failures from same IP — progressive backoff)
- Testing all mechanisms against live Keycloak

## Overview

Move SASL authentication from X3 services relay into the Nefarious IRCd, validating credentials directly against Keycloak via the existing libkc shared library. This is the first step of merging X3 into Nefarious.

**Investigation**: [SASL_INTO_NEFARIOUS_INVESTIGATION.md](docs/investigations/SASL_INTO_NEFARIOUS_INVESTIGATION.md)

**Approach**: Option C — Direct Keycloak via libkc (already integrated into Nefarious for webpush)

**Target**: Our IRCv3 Nefarious branch. Zero changes to legacy X3. P10 relay preserved as fallback.

**Legacy X3 compatibility**: Legacy X3 continues using LDAP (or SAXDB) for account credentials. Keycloak is deployed with LDAP User Federation pointing at the same LDAP server, so Nefarious validates SASL via Keycloak → LDAP. Both X3 and Nefarious see the same credential store. No changes to X3.

---

## Audit Findings & Prerequisites

*Audit performed 2026-03-07 against current codebase.*

### libkc API Status

The plan relies on libkc (`libkc/src/kc_keycloak.c`). Current implementation status:

| Function | Status | Needed By |
|----------|--------|-----------|
| `kc_keycloak_init()` | **Working** | Phase 1 (all) |
| `kc_user_verify_password()` | **Working** (ROPC grant) | Phase 1 PLAIN |
| `kc_user_search()` | **Stub** (`TODO: Phase C`) | Phase 1 EXTERNAL |
| `kc_token_introspect()` | **Working** | Phase 2 OAUTHBEARER |
| `kc_jwt_validate_local()` | **Working** (in `kc_jwt.c`) | Phase 2 OAUTHBEARER offline |
| `kc_token_verify_offline()` | **Stub** (thin wrapper needed) | Phase 2 |
| `kc_jwks_refresh()` | **Partial** (HTTP fires, response not parsed/cached) | Phase 2 |
| `kc_user_get()` | **Working** | Phase 3 SCRAM |

**Reference implementation**: X3's `keycloak.c` (~9400 lines) has working implementations of all these operations including user search and fingerprint lookup. Use as reference when filling libkc stubs.

### Prerequisites Before Implementation

1. **Create `FEAT_KEYCLOAK_*` feature flags** — `FEAT_KEYCLOAK_URL`, `FEAT_KEYCLOAK_REALM`, `FEAT_KEYCLOAK_CLIENT_ID`, `FEAT_KEYCLOAK_CLIENT_SECRET`. These do NOT exist today. The plan originally assumed webpush created them — it didn't. Webpush only uses `kc_init()` (transport layer), not `kc_keycloak_init()` (REST API layer).

2. **Refactor libkc initialization in `ircd.c`** — Currently `kc_init()` is called only inside `#ifdef USE_LIBKC` gated by `FEAT_CAP_draft_webpush`. Both `kc_init()` and `kc_keycloak_init()` need to be called unconditionally when `USE_LIBKC` is defined and Keycloak features are configured, independent of webpush.

3. **Implement `kc_user_search()`** — Required for EXTERNAL. ~60 lines following the pattern of `kc_user_get()`: build `GET /admin/realms/{realm}/users?search={query}` URL, parse array response. Reference: X3's `keycloak_find_user_by_fingerprint_async()`.

4. **Keycloak client must have "Direct Access Grants" enabled** — `kc_user_verify_password()` uses the Resource Owner Password Credentials grant. This is the correct approach for SASL PLAIN (server-side credential verification).

### Critical Design Corrections

**Callback safety (use-after-free prevention)**: All async libkc callbacks MUST NOT receive raw `struct Client *` pointers. If the client disconnects while a Keycloak request is in flight, the pointer is dangling. Instead, pass a heap-allocated context struct `{fd, cookie}`. In the callback:
```c
struct sasl_cb_ctx { unsigned int fd; unsigned int cookie; };

static void sasl_plain_cb(int result, const struct kc_access_token *token, void *data)
{
    struct sasl_cb_ctx *ctx = (struct sasl_cb_ctx *)data;
    struct Client *acptr = LocalClientArray[ctx->fd];

    if (!acptr || cli_saslcookie(acptr) != ctx->cookie) {
        free(ctx);
        return;  /* Client gone or FD reused */
    }
    free(ctx);
    /* ... proceed safely ... */
}
```
This matches the existing P10 relay's `server!fd.cookie` safety pattern.

**Registration blocking**: The local SASL path must call `auth_sasl_start(cli_auth(sptr))` to set `AR_SASL_PENDING`, blocking `register_user()` until `auth_sasl_done()` is called on success/fail/abort. The existing IAuth and P10 paths both do this. Without it, a client can complete registration while a Keycloak request is in flight.

**Timer reuse**: Do NOT add a `struct Timer` to `SASLSession`. The client already has `cli_sasltimeout(cptr)` with an existing timeout callback infrastructure. Reuse it.

**Shared login completion function**: `sasl_success()` must replicate everything `ms_sasl()` does on `D S` (lines 255-314 of `m_sasl.c`). This is substantial — metadata load, account-notify, extended AC format, hidden host, bouncer alias update, `auth_sasl_done()`. **Extract a shared `sasl_complete_login()` from `ms_sasl()`** that both the P10 path and local path call, rather than reimplementing.

**Mechanism advertisement**: When `FEAT_SASL_LOCAL` is active, `get_effective_sasl_mechanisms()` must prefer local mechanisms and ignore P10 `SASL * * M` broadcasts (which call `set_sasl_mechanisms()` and would overwrite the local list).

**Keycloak availability check**: Check at `sasl_start()` time, not mid-session. If Keycloak is unavailable when the client sends `AUTHENTICATE PLAIN`, fall through to P10 immediately. Don't start a local session and then try to fail over after the async request times out — the SASL state machines are incompatible.

### authzid Impersonation Support

SASL PLAIN sends `authzid\0authcid\0password`. When authzid differs from authcid, it's an authorization identity assertion — "I am authcid, but log me in as authzid."

**Historical use**: ZNC bouncer used a shared service account (`authcid=znc-service`) to authenticate on behalf of users (`authzid=actual_user`), avoiding storing individual passwords in ZNC config.

**Design**: Support authzid != authcid. Authorization model: authcid must be a designated service account (e.g., specific Keycloak role or oper level) to assert a different authzid. Implementation can start simple (oper level check) and be refined later. Not blocking for initial PLAIN MVP — ship with authzid==authcid first, add impersonation as fast follow.

---

## Phase 1: PLAIN → EXTERNAL

### Step 1: SASL Session State Infrastructure

**Files**: `nefarious/include/sasl_auth.h` (new), `nefarious/include/client.h` (modify)

Create the SASL session data structures:

```c
/* sasl_auth.h */
enum sasl_mechanism {
    SASL_MECH_NONE,
    SASL_MECH_PLAIN,
    SASL_MECH_EXTERNAL,
    SASL_MECH_OAUTHBEARER,  /* Phase 2 */
    SASL_MECH_SCRAM_SHA256, /* Phase 3 */
    SASL_MECH_ECDSA,        /* Phase 3 */
};

enum sasl_state {
    SASL_STATE_NONE,
    SASL_STATE_INIT,           /* Mechanism selected, waiting for data */
    SASL_STATE_WAITING_DATA,   /* Accumulating chunked data */
    SASL_STATE_WAITING_KC,     /* Async Keycloak request in flight */
    SASL_STATE_COMPLETE,
    SASL_STATE_FAILED,
};

struct SASLSession {
    enum sasl_mechanism mech;
    enum sasl_state state;
    char *accumulated_data;
    size_t data_len;
    size_t data_alloc;
    int chunks_received;
    char authcid[ACCOUNTLEN + 1];   /* Saved for callback context */
    char authzid[ACCOUNTLEN + 1];   /* Authorization identity (may differ from authcid) */
    /* SCRAM state (Phase 3) */
};
```

Add a `struct SASLSession *` pointer to the client's connection state (in `client.h` or the `struct Connection`). Reuse existing `cli_saslcookie()` for callback correlation and `cli_sasltimeout()` for the timeout timer — do NOT duplicate these in SASLSession.

### Step 2: Feature Flags

**Files**: `nefarious/include/ircd_features.h`, `nefarious/ircd/ircd_features.c`

Add:
- `FEAT_SASL_LOCAL` — bool, default TRUE. When TRUE and Keycloak is available, handle SASL locally. When FALSE, relay to X3 via P10.
- `FEAT_KEYCLOAK_URL` — string, e.g. `"http://keycloak:8080"`
- `FEAT_KEYCLOAK_REALM` — string, e.g. `"master"`
- `FEAT_KEYCLOAK_CLIENT_ID` — string
- `FEAT_KEYCLOAK_CLIENT_SECRET` — string

These are all **new** — webpush does not create them (it only uses the libkc HTTP transport layer, not the Keycloak REST API layer).

### Step 3: SASL Mechanism Framework

**Files**: `nefarious/ircd/sasl_auth.c` (new)

Core framework functions:

```c
/* Start a local SASL session */
int sasl_start(struct Client *sptr, const char *mechanism);

/* Process AUTHENTICATE data (may be chunked) */
int sasl_continue(struct Client *sptr, const char *data);

/* Abort/cleanup */
int sasl_abort(struct Client *sptr);
void sasl_session_free(struct Client *sptr);

/* Completion helpers (called from Keycloak callbacks) */
void sasl_success(struct Client *sptr, const char *account, time_t ts);
void sasl_fail(struct Client *sptr, int numeric);

/* Mechanism list for CAP advertisement */
const char *sasl_local_mechanisms(void);

/* Check if local SASL is available */
int sasl_local_available(void);
```

**sasl_start()** logic:
1. Check Keycloak availability — if unavailable, return failure so `m_authenticate` falls through to P10
2. Validate mechanism is in the supported list
3. Allocate `SASLSession`, attach to client
4. Generate `cli_saslcookie()`, set `cli_saslstart()`, call `auth_sasl_start(cli_auth(sptr))` to block registration
5. Start timeout via existing `cli_sasltimeout()` timer
6. For PLAIN/OAUTHBEARER: send `AUTHENTICATE +` (ready for data)
7. For EXTERNAL: send `AUTHENTICATE +` (client sends authzid or `+`)

**sasl_continue()** logic:
1. Validate session exists and state is correct
2. Handle chunked data accumulation:
   - If data is exactly 400 bytes, accumulate and wait for more
   - If data is `+`, it means the previous 400-byte chunk was final
   - Otherwise, append data and dispatch to mechanism handler
3. Dispatch to mechanism-specific handler (PLAIN → `sasl_handle_plain()`, etc.)

**Chunk accumulation** (existing relay handles this, but for local processing):
- Decode base64 chunks as they arrive
- If chunk is exactly 400 base64 chars, more data follows
- Final chunk: < 400 chars, or `+` after a 400-char chunk

### Step 4: PLAIN Mechanism Handler

**Files**: `nefarious/ircd/sasl_auth.c`

```c
static int sasl_handle_plain(struct Client *sptr, const char *data, size_t len)
{
    /* Decode base64 */
    /* Parse: authzid\0authcid\0password */
    /* Validate: authcid is non-empty, password is non-empty */
    /* Save authcid and authzid in session for callback use */
    ircd_strncpy(session->authcid, authcid, sizeof(session->authcid));
    if (authzid[0] && ircd_strcmp(authzid, authcid) != 0)
        ircd_strncpy(session->authzid, authzid, sizeof(session->authzid));

    /* Set state to WAITING_KC */
    session->state = SASL_STATE_WAITING_KC;

    /* Allocate callback context — NEVER pass raw Client pointer to async callback */
    struct sasl_cb_ctx *ctx = malloc(sizeof(*ctx));
    ctx->fd = cli_fd(sptr);
    ctx->cookie = cli_saslcookie(sptr);

    /* Call libkc — verifies password via ROPC grant */
    kc_user_verify_password(authcid, password, sasl_plain_cb, ctx);
    return 0;
}

static void sasl_plain_cb(int result, const struct kc_access_token *token, void *data)
{
    struct sasl_cb_ctx *ctx = (struct sasl_cb_ctx *)data;
    struct Client *acptr = LocalClientArray[ctx->fd];

    /* Validate client still exists and cookie matches (FD reuse protection) */
    if (!acptr || cli_saslcookie(acptr) != ctx->cookie) {
        free(ctx);
        return;  /* Client disconnected or FD reused */
    }
    free(ctx);

    struct SASLSession *session = cli_sasl_session(acptr);
    if (!session || session->state != SASL_STATE_WAITING_KC)
        return;

    if (result == KC_SUCCESS) {
        /* Use authzid if set (impersonation), otherwise authcid */
        const char *login_as = session->authzid[0] ? session->authzid : session->authcid;
        sasl_complete_login(acptr, login_as, CurrentTime);
    } else if (result == KC_FORBIDDEN || result == KC_NOT_FOUND) {
        sasl_fail(acptr, ERR_SASLFAIL);
    } else {
        /* KC_TIMEOUT, KC_UNAVAILABLE */
        sasl_fail(acptr, ERR_SASLFAIL);
    }
}
```

**sasl_complete_login()** — **shared function** extracted from `ms_sasl()` D/S handler (m_sasl.c:255-314). Both the P10 relay path and local SASL call this. It does:
1. Set `cli_saslaccount(sptr)` to account name
2. Send `RPL_LOGGEDIN` (900) to client
3. `SetSASLComplete(sptr)` / `SetAccount(sptr)`
4. `metadata_load_account()` — load account-linked metadata BEFORE setting flag
5. `bounce_emit_alias_update()` — notify bouncer aliases
6. `sendcmdto_common_channels_capab_butone()` — account-notify to channel members
7. Broadcast `AC` to network — extended format (`FEAT_EXTENDED_ACCOUNTS`) with R/M type
8. If `FEAT_SASL_AUTOHIDEHOST`: apply hidden host via `hide_hostmask()`
9. `auth_sasl_done(cli_auth(sptr))` — unblock registration
10. Clean up SASL session state and timer

**sasl_fail()** does:
1. Send `ERR_SASLFAIL` (904) to client
2. `auth_sasl_done(cli_auth(sptr))` — unblock registration
3. Clean up SASL session state and timer
4. Increment bad-auth counter (for throttling, if applicable)

### Step 5: EXTERNAL Mechanism Handler

**Prerequisite**: `kc_user_search()` must be implemented in libkc first (~60 LOC, following the pattern of `kc_user_get()`). Reference: X3's `keycloak_find_user_by_fingerprint_async()` in `keycloak.c`. **Note**: Keycloak's Admin REST API `GET /users?search=` only searches username/firstName/lastName/email — custom attribute search (`x3_fingerprint`) requires using the `q` parameter (Keycloak 15+) or `GET /users?q=x3_fingerprints:{fp}`. Verify against your Keycloak version.

**Files**: `nefarious/ircd/sasl_auth.c`

```c
static int sasl_handle_external(struct Client *sptr, const char *data, size_t len)
{
    const char *fingerprint = cli_sslclifp(sptr);

    if (!fingerprint || !*fingerprint) {
        sasl_fail(sptr, ERR_SASLFAIL);  /* No client certificate */
        return 0;
    }

    session->state = SASL_STATE_WAITING_KC;

    /* Allocate callback context — same safety pattern as PLAIN */
    struct sasl_cb_ctx *ctx = malloc(sizeof(*ctx));
    ctx->fd = cli_fd(sptr);
    ctx->cookie = cli_saslcookie(sptr);

    /* Search for user with matching x3_fingerprint attribute */
    char query[256];
    snprintf(query, sizeof(query), "x3_fingerprints:%s", fingerprint);
    kc_user_search(query, true, sasl_external_cb, ctx);
    return 0;
}

static void sasl_external_cb(int result, const struct kc_user *users, int count, void *data)
{
    struct sasl_cb_ctx *ctx = (struct sasl_cb_ctx *)data;
    struct Client *acptr = LocalClientArray[ctx->fd];

    if (!acptr || cli_saslcookie(acptr) != ctx->cookie) {
        free(ctx);
        return;
    }
    free(ctx);

    if (result == KC_SUCCESS && count == 1) {
        sasl_complete_login(acptr, users[0].username, CurrentTime);
    } else if (count == 0 || result == KC_NOT_FOUND) {
        sasl_fail(acptr, ERR_SASLFAIL);
    } else if (count > 1) {
        /* Fingerprint collision — security issue, log and fail */
        log_write(LS_SYSTEM, L_WARNING, 0,
                  "SASL EXTERNAL: fingerprint collision, %d users matched", count);
        sasl_fail(acptr, ERR_SASLFAIL);
    } else {
        sasl_fail(acptr, ERR_SASLFAIL);
    }
}
```

### Step 6: m_authenticate.c Refactor

**Files**: `nefarious/ircd/m_authenticate.c`

Refactor to add local dispatch path. Key considerations:
- Existing `CapActive(cptr, CAP_SASL)` check, `IsSASLComplete` re-auth guard, and `strlen > 400` validation remain unchanged at the top
- Local path takes priority but `sasl_start()` can return failure if Keycloak is unavailable, causing fallthrough to IAuth/P10
- The existing re-auth logic for OAUTHBEARER token refresh (lines 142-160) applies to local SASL too

```c
int m_authenticate(struct Client* cptr, struct Client* sptr, int parc, char* parv[])
{
    /* ... existing CAP_SASL check, parc check, strlen > 400 check ... */

    /* Handle abort */
    if (!strcmp(parv[1], "*")) {
        if (cli_sasl_session(sptr))
            return sasl_abort(sptr);     /* local session abort */
        /* ... existing abort handling for relay/iauth ... */
    }

    /* ... existing IsSASLComplete re-auth guard (OAUTHBEARER exemption) ... */

    /* Path 1: Local Keycloak-based SASL (NEW) */
    if (sasl_local_available()) {
        if (!cli_sasl_session(sptr)) {
            /* sasl_start() checks Keycloak availability at session start.
             * Returns 0 on success, -1 if unavailable (fall through to P10) */
            if (sasl_start(sptr, parv[1]) == 0)
                return 0;
            /* Keycloak unavailable — fall through to IAuth/P10 */
        } else {
            return sasl_continue(sptr, parv[1]);
        }
    }

    /* Path 2: IAuth SASL (existing) */
    if (auth_iauth_handles_sasl()) {
        /* ... existing IAuth handling unchanged ... */
    }

    /* Path 3: P10 relay to X3 (existing fallback) */
    /* ... existing P10 relay code unchanged ... */
}
```

Important: the existing relay code for IAuth and P10 stays intact. The new local path is an **additional** branch that takes priority when Keycloak is available. If Keycloak is down at session start, the fallthrough to P10 is seamless — no mid-session failover complexity.

### Step 7: CAP SASL Advertisement Updates

**Files**: `nefarious/ircd/m_cap.c`

Update `sasl_server_available()`:
```c
int sasl_server_available(void)
{
    /* NEW: Local Keycloak SASL — only if Keycloak is actually reachable.
     * Per IRCv3 spec: "Servers MUST NOT advertise the sasl capability
     * if the authentication layer is unavailable." */
    if (sasl_local_available())
        return 1;

    /* Existing: IAuth or P10 services */
    if (auth_iauth_handles_sasl() && auth_iauth_sasl_mechs())
        return 1;
    /* ... existing P10 check ... */
}
```

Update `get_effective_sasl_mechanisms()`:
```c
const char *get_effective_sasl_mechanisms(void)
{
    /* NEW: Local mechanisms take priority.
     * This intentionally overrides any P10 SASL M broadcast from X3
     * (which calls set_sasl_mechanisms() and would conflict). */
    if (sasl_local_available())
        return sasl_local_mechanisms();  /* "PLAIN" or "PLAIN,EXTERNAL" */

    /* Existing: IAuth, P10, fallback */
    /* ... */
}
```

**Note**: When `FEAT_SASL_LOCAL` is active, X3 may still broadcast `SASL * * M :PLAIN,EXTERNAL,...` via P10. This calls `set_sasl_mechanisms()` which writes to the global mechanism string. The local path must take priority in `get_effective_sasl_mechanisms()` to avoid the P10 broadcast overriding the local list. The global string from `set_sasl_mechanisms()` is only consulted when the local path is not active.

### Step 8: Keycloak Initialization

**Files**: `nefarious/ircd/ircd.c`

Currently (ircd.c:1100-1112), libkc is initialized ONLY for webpush inside `#ifdef USE_LIBKC` gated by `FEAT_CAP_draft_webpush`. Webpush calls `kc_init()` (transport layer) but NOT `kc_keycloak_init()` (Keycloak REST API layer). Refactor to:

```c
#ifdef USE_LIBKC
  /* Initialize libkc transport — needed by both webpush and local SASL */
  int kc_needed = feature_bool(FEAT_CAP_draft_webpush)
               || feature_bool(FEAT_SASL_LOCAL);

  if (kc_needed) {
    ircd_kc_adapter_init();
    if (kc_init(ircd_kc_get_event_ops(), ircd_kc_get_log_ops()) != 0) {
      log_write(LS_SYSTEM, L_WARNING, 0,
                "Failed to initialize libkc HTTP transport");
    } else {
      /* Initialize Keycloak REST API layer if SASL_LOCAL is configured */
      if (feature_bool(FEAT_SASL_LOCAL)) {
        struct kc_config kc_cfg = {
          .base_url      = feature_str(FEAT_KEYCLOAK_URL),
          .realm         = feature_str(FEAT_KEYCLOAK_REALM),
          .client_id     = feature_str(FEAT_KEYCLOAK_CLIENT_ID),
          .client_secret = feature_str(FEAT_KEYCLOAK_CLIENT_SECRET),
        };
        if (kc_keycloak_init(&kc_cfg) != 0)
          log_write(LS_SYSTEM, L_WARNING, 0,
                    "Failed to initialize Keycloak — local SASL unavailable");
      }

      /* Initialize webpush if enabled */
      if (feature_bool(FEAT_CAP_draft_webpush))
        webpush_setup();
    }
  }
#endif
```

`sasl_local_available()` checks both `FEAT_SASL_LOCAL` and whether `kc_keycloak_init()` succeeded (e.g., via a static flag or `kc_token_cached() != NULL` probe).

### Step 9: Client Cleanup

**Files**: `nefarious/ircd/s_misc.c` or wherever client exit cleanup happens

When a client disconnects (or registration completes), clean up any pending SASL session:
```c
if (cli_sasl_session(client))
    sasl_session_free(client);
```

This is critical to prevent use-after-free if a Keycloak callback fires after the client has disconnected. The callback must check that the client and session still exist.

**Safety pattern**: Use the existing `cli_saslcookie()` (random 31-bit cookie) to validate callbacks. On callback, verify the cookie matches before proceeding. On disconnect, clear the cookie so stale callbacks are rejected.

### Step 10: Build Integration

**Files**: `nefarious/Makefile.in` (or equivalent)

Add `sasl_auth.c` to the build. It should be compiled unconditionally. Inside the file, gate all Keycloak calls with `#ifdef USE_LIBKC`:

```c
#ifdef USE_LIBKC
#include <kc/kc_keycloak.h>
#endif

static int kc_sasl_healthy = 0;  /* Set by health check, cleared on failure */

int sasl_local_available(void)
{
#ifdef USE_LIBKC
    return feature_bool(FEAT_SASL_LOCAL) && kc_sasl_healthy;
#else
    return 0;
#endif
}
```

**Keycloak health tracking**: `kc_sasl_healthy` is the live health signal. It's driven by the client credentials token lifecycle:
- **Set to 1** when `kc_keycloak_init()` succeeds and first `kc_token_ensure()` returns `KC_SUCCESS`
- **Cleared to 0** when token refresh fails (`KC_TIMEOUT`, `KC_UNAVAILABLE`)
- **Restored to 1** on next successful token refresh

A periodic timer (e.g., every 30s) calls `kc_token_ensure()` as a heartbeat. On state transitions:
- `healthy → unhealthy`: call `send_cap_notify("sasl", 0, NULL)` → clients get `CAP DEL sasl`
- `unhealthy → healthy`: call `send_cap_notify("sasl", 1, sasl_local_mechanisms())` → clients get `CAP NEW sasl=PLAIN`

This satisfies the IRCv3 spec requirement: *"Servers MUST NOT advertise the sasl capability if the authentication layer is unavailable."*

The framework compiles cleanly without libkc — `sasl_local_available()` returns 0 and `m_authenticate` falls through to IAuth/P10 as before.

---

## Phase 2: OAUTHBEARER + Caching

### Step 11: OAUTHBEARER Handler

**Files**: `nefarious/ircd/sasl_oauth.c` (new) or extend `sasl_auth.c`

OAUTHBEARER (RFC 7628) flow:
1. Client sends: `n,a=<authzid>,\x01auth=Bearer <token>\x01\x01`
2. Nefarious extracts bearer token
3. Try local JWKS validation first: `kc_jwt_validate_local(realm, token, &info)` *(implemented in `kc_jwt.c:492`)*
   - If valid (`KC_SUCCESS`): extract `info->username`, call `sasl_complete_login()`, then `kc_jwt_token_info_free(info)`
   - If invalid (signature fail, expired, no cached JWKS — returns `KC_ERROR`):
4. Fall back to introspection: `kc_token_introspect(token, sasl_oauth_cb, ctx)` *(async, uses `sasl_cb_ctx`)*
   - Async HTTP to Keycloak
   - On `{"active": true}`: success
   - On `{"active": false}` or error: fail

**API note**: `kc_token_verify_offline()` in `kc_keycloak.h` is a stub. Use `kc_jwt_validate_local()` from `kc_jwt.h` directly — it has a different signature (takes `struct kc_realm`, returns `struct kc_token_info **` that must be freed with `kc_jwt_token_info_free()`). The stub can be wired up later as a convenience wrapper.

### Step 12: JWKS Cache Warm-Up

On startup (or on first OAUTHBEARER attempt), call `kc_jwks_refresh()` to populate the JWKS cache for offline JWT validation. Set up a periodic refresh (e.g., every hour).

**Note**: `kc_jwks_refresh()` currently fires the HTTP request but the response handler (`kc_keycloak.c:687`) calls `cb(KC_SUCCESS)` without parsing or caching the JWKS keys. The actual JWKS parsing and key caching logic exists in `kc_jwt.c` (used by `kc_jwt_validate_local`). These need to be wired together — the `kc_keycloak.c` JWKS response handler should feed the fetched JSON into `kc_jwt.c`'s key cache.

### Step 13: Negative Auth Cache

Short-lived in-memory cache of recently failed auth attempts. Prevents hammering Keycloak on repeated bad passwords.

Key: hash(username + password). Value: timestamp. TTL: 60 seconds.

---

## Phase 3: SCRAM-SHA-256 + ECDSA

### Step 14: SCRAM-SHA-256

**Files**: `nefarious/ircd/sasl_scram.c` (new)

Multi-message exchange (RFC 5802):
1. **Client-first**: `n,,n=<user>,r=<nonce>` → Nefarious fetches stored credentials from Keycloak via `kc_user_get()` (user attributes `x3_scram_sha256_salt`, `x3_scram_sha256_iterations`, `x3_scram_sha256_stored_key`, `x3_scram_sha256_server_key`)
2. **Server-first**: `r=<combined>,s=<salt>,i=<iterations>` → SASL state holds fetched credentials
3. **Client-final**: `c=<binding>,r=<combined>,p=<proof>` → Verify proof using stored key (HMAC + comparison, no PBKDF2 at auth time)
4. **Server-final**: `v=<server_sig>` → Verify server signature

**Requires**: OpenSSL HMAC/SHA-256 (already linked for TLS).

**Challenge**: Keycloak must have SCRAM credentials (`x3_scram_salt`, `x3_scram_iterations`, `x3_scram_stored_key`, `x3_scram_server_key`) stored as user attributes. If they don't exist, SCRAM auth fails for that user. Three paths generate these:

1. **Keycloak SPI** (`x3Scram` password policy in `keycloak-webhook-spi/`): Generates SCRAM credentials automatically during interactive password flows (web registration, admin password changes). Hooks into `PasswordPolicyProvider.validate()` as a side effect. Covers users created through Keycloak's web UI or API with plaintext passwords.
2. **LDAP-imported users**: No SCRAM credentials generated — LDAP federation handles password validation at bind time, never exposing the plaintext to the SPI. These users can only SCRAM-auth after a password change through Keycloak, or via lazy generation.
3. **Lazy generation on PLAIN auth**: On first successful PLAIN auth (where we have the plaintext password), compute and store SCRAM credentials in Keycloak so subsequent SCRAM auths work. Covers LDAP users and any users who predate the SPI deployment.

Native Keycloak account registration (IRCv3 REGISTER integration) would ensure all new users get SCRAM credentials at creation time, but that's out of scope for this plan.

### Step 15: ECDSA-NIST256P-CHALLENGE

**Files**: extend `sasl_auth.c` or new file

1. Client sends authcid
2. Nefarious generates random challenge, sends it
3. Client signs challenge with ECDSA private key
4. Nefarious fetches public key from Keycloak user attributes (`ecdsa_pubkey`), verifies signature

**Requires**: OpenSSL ECDSA (already linked).

---

## Implementation Notes

### Client Lifetime vs. Async Callbacks

The biggest implementation risk is a Keycloak callback firing after the client has disconnected. **All async callbacks use the `sasl_cb_ctx {fd, cookie}` pattern** (see Audit Findings section and Step 4). Never pass raw `struct Client *` to libkc callbacks.

Defense-in-depth layers:
1. **FD + cookie lookup**: Callback resolves `LocalClientArray[fd]`, validates `cli_saslcookie(acptr) == cookie`
2. **State validation**: Callback checks `session->state == SASL_STATE_WAITING_KC`
3. **Disconnect cleanup**: `sasl_session_free()` on disconnect clears `cli_saslcookie()` to 0, so stale callbacks see cookie mismatch and bail

### Account Broadcast After Success

Handled by `sasl_complete_login()` (shared function extracted from `ms_sasl()` D/S handler). Includes extended AC format, metadata load, bouncer alias update, account-notify, hidden host — see Step 4 for full list.

### Keycloak Config

`kc_init()` (transport) and `kc_keycloak_init()` (REST API) are separate init calls. Both webpush and SASL share the transport layer. Only SASL needs the Keycloak REST layer. See Step 8 for the refactored initialization.

### Testing Strategy

- Unit test SASL PLAIN with valid/invalid credentials against testnet Keycloak
- Unit test SASL EXTERNAL with matching/non-matching fingerprints
- Test fallback: disable `FEAT_SASL_LOCAL`, verify P10 relay still works
- Test Keycloak-down scenario: stop Keycloak container, verify graceful degradation
- Test concurrent SASL sessions (multiple clients authenticating simultaneously)
- Test SASL timeout (slow/unresponsive Keycloak)
- Test client disconnect during pending Keycloak request

---

## Success Criteria

### Phase 1 PLAIN (MVP)
1. `AUTHENTICATE PLAIN` works end-to-end against Keycloak without X3 involvement
2. Existing P10 relay path works unchanged when `FEAT_SASL_LOCAL = FALSE`
3. Graceful degradation when Keycloak is unreachable at session start (fall through to P10 relay)
4. No use-after-free from client disconnect during pending Keycloak request (fd+cookie validation)
5. CAP LS 302 advertises `sasl=PLAIN` when local SASL is active
6. Account properly broadcast via AC (extended format) after successful local SASL
7. `auth_sasl_done()` correctly unblocks registration on success/fail/abort
8. Bouncer session resume works correctly with local SASL
9. P10 mechanism broadcasts from X3 don't override local mechanism list

### Phase 1 EXTERNAL (after kc_user_search)
10. `AUTHENTICATE EXTERNAL` works for registered fingerprints via Keycloak attribute search
11. CAP LS 302 advertises `sasl=PLAIN,EXTERNAL` when both are available

---

## Estimated Effort

| Phase | Components | Est. LOC | Complexity |
|-------|-----------|----------|------------|
| 1a (MVP) | Feature flags + KC init + framework + PLAIN + sasl_complete_login extraction + m_authenticate refactor + CAP updates + build | ~1,000 | Medium |
| 1b | libkc `kc_user_search()` + EXTERNAL handler | ~200 | Low (boilerplate) |
| 2 | OAUTHBEARER + wire `kc_jwks_refresh` to `kc_jwt.c` + negative cache | ~600 | Medium |
| 3 | SCRAM-SHA-256 + ECDSA | ~600 | High (crypto) |
| **Total** | | **~2,400** | |

X3 changes: **0 LOC** (at all phases). Keycloak LDAP federation bridges legacy X3's LDAP credential store.

---

## Dependencies

### Infrastructure (already in place)
- libkc compiled and linked (`USE_LIBKC` defined in config.h)
- `ircd_kc_adapter.c` functional (bridges Nefarious event engine to libkc)
- Keycloak running with correct realm/client configuration
- Keycloak client must have **"Direct Access Grants" enabled** (required for ROPC used by `kc_user_verify_password()`)

### New code required before Phase 1 PLAIN
- `FEAT_KEYCLOAK_*` feature flags (Step 2)
- `kc_keycloak_init()` call in `ircd.c` (Step 8)
- `sasl_complete_login()` extracted from `ms_sasl()` (Step 4)

### New code required before Phase 1 EXTERNAL
- `kc_user_search()` implemented in libkc (~60 LOC, reference: X3's `keycloak.c`)

### Network-specific
- **For legacy X3 networks**: Keycloak configured with LDAP User Federation pointing at X3's LDAP server. Password validation via LDAP bind — OpenLDAP handles legacy SMD5 (Salted MD5) passwords natively. When retiring LDAP later, a Keycloak Credential Provider SPI (~200 LOC Java) is needed to verify/rehash SMD5 → PBKDF2.
- **For modern X3 networks**: Keycloak user accounts created directly by X3 (already works)
- For EXTERNAL: users must have `x3_fingerprints` attribute in Keycloak (or LDAP-mapped equivalent)
- For OAUTHBEARER: JWKS endpoint accessible, `kc_jwks_refresh()` response handler wired to `kc_jwt.c` key cache
- For SCRAM: `x3_scram_*` attributes populated in Keycloak or LDAP (X3 does this on PLAIN auth)
- **Note**: PLAIN auth via LDAP federation works out of the box (Keycloak delegates password check to LDAP bind). EXTERNAL/SCRAM/ECDSA require custom LDAP attributes that legacy X3 may or may not store in LDAP — PLAIN is the baseline.

---

## Future Work: Keycloak Webhooks

Not required for Phase 1, but important for Phase 2+ hardening.

**Existing infrastructure** (zero new code needed in these layers):
- **libkc**: `kc_webhook.h/c` — generic async HTTP webhook server, already linked into Nefarious
- **Keycloak SPI**: `keycloak-webhook-spi/` — event listener + SCRAM credential generation, supports multiple endpoints

**Nefarious webhook handler** (new, ~200-400 LOC, analogous to X3's `keycloak_webhook.c`):
- Negative auth cache invalidation on credential change
- Account suspension/deletion → reject SASL, optionally disconnect sessions
- SCRAM credential sync on password change
- OAUTHBEARER token revocation on session logout

**Reference**: X3's `keycloak_webhook.c` handles the same event types — SCRAM cache invalidation, ChanServ sync, fingerprint updates, session revocation. Nefarious handler would be simpler (no ChanServ logic).
