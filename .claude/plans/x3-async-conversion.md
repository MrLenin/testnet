# X3 Async Conversion Plan

## Executive Summary

X3 IRC services has **partial async support** with a well-designed `curl_multi` infrastructure integrated into the ioset event loop. However, many operations remain synchronous, blocking the event loop during HTTP requests to Keycloak. This plan provides a comprehensive inventory of blocking operations and a prioritized conversion strategy.

---

## 1. Current Async Infrastructure

### 1.1 curl_multi + ioset Integration

**Location:** `x3/src/keycloak.c` lines 1244-1956

The infrastructure consists of:
- **Handle pool:** `kc_handle_pool[]` - Reuses CURL handles (pool of 8) to avoid repeated `curl_easy_init()` calls
- **Socket callbacks:** `kc_curl_socket_cb()` - Registers curl sockets with ioset event loop
- **Timer callbacks:** `kc_curl_timer_cb()` - Uses timeq for sub-second poll hints via `ioset_set_poll_hint_ms()`
- **Completion checking:** `kc_curl_check_completed()` - Dispatches results based on `kc_async_request.type`

### 1.2 Async Request Types (enum kc_async_type)

```c
KC_ASYNC_AUTH,          // Password authentication
KC_ASYNC_FINGERPRINT,   // Certificate fingerprint lookup
KC_ASYNC_INTROSPECT,    // Token introspection
KC_ASYNC_SET_ATTR,      // Set user attribute
KC_ASYNC_GROUP_ADD,     // Add user to group
KC_ASYNC_GROUP_REMOVE,  // Remove user from group
KC_ASYNC_WEBPUSH,       // WebPush notification delivery
KC_ASYNC_CREATE_USER,   // User creation
KC_ASYNC_GROUP_INFO,    // Get group info
KC_ASYNC_GROUP_MEMBERS  // Get group members
```

### 1.3 Already Async Functions

| Function | File:Line | Use Case |
|----------|-----------|----------|
| `kc_check_auth_async()` | keycloak.c:1963 | SASL PLAIN authentication |
| `keycloak_find_user_by_fingerprint_async()` | keycloak.c:2053 | SASL EXTERNAL auth |
| `keycloak_introspect_token_async()` | keycloak.c:2123 | OAUTHBEARER validation |
| `keycloak_set_user_attribute_async()` | keycloak.c:2209 | Async attribute updates |
| `keycloak_set_email_verified_async()` | keycloak.c:2301 | Email verification sync |
| `keycloak_add_user_to_group_async()` | keycloak.c:2385 | ChanServ access sync |
| `keycloak_remove_user_from_group_async()` | keycloak.c:2445 | ChanServ access sync |
| `kc_webpush_send_async()` | keycloak.c:2514 | WebPush delivery |
| `keycloak_create_user_async()` | keycloak.c:2601 | Async user creation |
| `keycloak_get_group_info_async()` | keycloak.c:5625 | Batch channel sync |
| `keycloak_get_group_members_async()` | keycloak.c:5683 | Batch channel sync |

### 1.4 Async Command Pattern (SASL Example)

The SASL async pattern in nickserv.c demonstrates the correct approach:

1. **Session state machine:** `sasl_async_ctx` with validation via sequence numbers
2. **State tracking:** `SASL_STATE_AUTHENTICATING`, `SASL_STATE_CANCELLED`, `SASL_STATE_FAILED`
3. **Callback invocation:** `sasl_async_auth_callback()` at keycloak.c:1620-1621
4. **Cleanup handling:** Session validation in callback detects cancelled/reused UIDs

---

## 2. Blocking Operations Inventory

### 2.1 Synchronous curl_easy_perform() Calls

| Location | Function | Called By | Frequency | Impact |
|----------|----------|-----------|-----------|--------|
| keycloak.c:466 | `jwks_refresh()` | JWT validation | Low (cached) | 100-500ms |
| keycloak.c:2813 | `curl_perform()` | 26 keycloak_* functions | **High** | 50-200ms per call |
| webpush.c:606 | `webpush_send()` | Notification delivery | Medium | 200-2000ms |

### 2.2 Synchronous curl_perform() Wrapper Calls (keycloak.c)

**HIGH FREQUENCY (user commands):**

| Line | Function | Call Chain | When Used |
|------|----------|------------|-----------|
| 3231 | `keycloak_get_client_token()` | All admin ops | Every Keycloak operation |
| 3310 | `keycloak_get_user_token()` | `kc_check_auth()` | AUTH, LOC commands |
| 3382 | `keycloak_get_users()` | User lookup | REGISTER, AUTH |
| 4685 | `keycloak_introspect_token()` | Token validation | OAUTHBEARER (sync path) |
| 5114 | `keycloak_find_user_by_fingerprint()` | Cert auth | SASL EXTERNAL (sync path) |

**MEDIUM FREQUENCY (user management):**

| Line | Function | Call Chain | When Used |
|------|----------|------------|-----------|
| 3659 | `keycloak_update_user()` (email) | `kc_do_modify()` | SET EMAIL, COOKIE |
| 3713 | `keycloak_update_user()` (password) | `kc_do_modify()` | SET PASSWORD, COOKIE |
| 3792 | `keycloak_update_user_credentials()` | Password sync | COOKIE activation |
| 3887 | `keycloak_update_user_representation()` | Batch update | Account modification |
| 3936 | `keycloak_delete_user()` | `kc_do_delete()` | UNREGISTER |
| 4003 | `keycloak_set_user_attribute()` | oslevel sync | OSET LEVEL |
| 4081 | `keycloak_set_user_attribute_array()` | Fingerprint sync | ADDCERT, DELCERT |
| 4135 | `keycloak_get_user_attribute()` | Attribute read | Metadata sync |

**MEDIUM FREQUENCY (channel sync):**

| Line | Function | Call Chain | When Used |
|------|----------|------------|-----------|
| 4342 | `keycloak_add_user_to_group()` | Bidirectional sync (fallback) | ADDUSER |
| 4389 | `keycloak_remove_user_from_group()` | Bidirectional sync (fallback) | DELUSER |
| 4447 | `keycloak_get_group_by_name()` | Group lookup | Channel sync |
| 4519 | `keycloak_get_group_by_path()` | Hierarchical lookup | Channel sync |
| 4764 | `keycloak_get_group_members()` | Keycloak->X3 sync | Background sync |
| 4904 | `keycloak_get_group_info()` | Group metadata | Channel sync |
| 5229 | `keycloak_create_group()` | Channel registration | REGISTER |
| 5312 | `keycloak_create_subgroup()` | Hierarchical groups | REGISTER |
| 5432 | `keycloak_set_group_attribute()` | Access level | ADDUSER level change |
| 5485 | `keycloak_delete_group()` | Channel unregister | DROP |

### 2.3 NickServ Blocking Call Chains

**AUTH command (cmd_auth @ nickserv.c:2785):**
```
cmd_auth()
  -> kc_check_auth() @ 2877
     -> keycloak_get_user_token() @ 6178 [BLOCKING]
  -> kc_get_user_info() @ 2880 (if autocreate)
     -> keycloak_get_user() @ 6197 [BLOCKING]
```

**COOKIE command (cmd_cookie @ nickserv.c:3269):**
```
cmd_cookie()
  -> kc_do_modify() @ 3370, 3395
     -> keycloak_get_user() [BLOCKING]
     -> keycloak_update_user_representation() [BLOCKING]
```

**REGISTER command (cmd_register @ nickserv.c:1621):**
```
cmd_register()
  -> kc_do_add() @ indirect
     -> keycloak_create_user() or keycloak_create_user_with_hash() [BLOCKING]
```

**SET PASSWORD command:**
```
cmd_set()
  -> kc_check_auth() [BLOCKING] (verify old password)
  -> kc_do_modify() [BLOCKING] (set new password)
```

**OSET LEVEL command:**
```
cmd_oset()
  -> kc_set_oslevel() @ 4509
     -> keycloak_get_user() [BLOCKING]
     -> keycloak_set_user_attribute() [BLOCKING]
     -> kc_add2group() / kc_delfromgroup()
        -> keycloak_get_group_by_name() [BLOCKING]
        -> keycloak_add_user_to_group() [BLOCKING]
```

### 2.4 ChanServ Blocking Call Chains

**ADDUSER/DELUSER (chanserv_push_keycloak_access @ chanserv.c:11374):**
```
chanserv_push_keycloak_access()
  -> keycloak_get_client_token() @ 11407 [BLOCKING]
  -> keycloak_get_user() @ 11415 [BLOCKING]
  -> keycloak_get_group_by_path() @ 11427 [BLOCKING]
  -> keycloak_create_channel_group() @ 11473 [BLOCKING]
     -> keycloak_get_group_by_path() [BLOCKING]
     -> keycloak_ensure_channels_parent()
        -> keycloak_get_group_by_name() [BLOCKING]
        -> keycloak_create_group() [BLOCKING]
     -> keycloak_create_subgroup() [BLOCKING]
  -> keycloak_set_group_attribute() @ 11483 [BLOCKING]
  -> keycloak_add_user_to_group_async() @ 11496 (async with sync fallback)
```

**Immediate Channel Sync (chanserv_queue_keycloak_sync @ chanserv.c:11953):**
```
chanserv_queue_keycloak_sync() [for IMMEDIATE priority]
  -> chanserv_sync_keycloak_channel() @ 11978 [BLOCKING - should use async]
```

### 2.5 Webhook-Triggered Sync (Currently Blocking!)

```
keycloak_webhook.c: handle_keycloak_event()
  -> chanserv_queue_keycloak_sync(channel, KC_SYNC_PRIORITY_IMMEDIATE)
     -> chanserv_sync_keycloak_channel() [BLOCKING]
```

**This is the most critical issue** - webhooks trigger blocking syncs, defeating the purpose of async webhook processing.

### 2.6 LDAP Blocking Operations (x3ldap.c)

**All LDAP operations are synchronous!** If `ldap_enable=1`, these block the event loop:

| Line | Function | When Used |
|------|----------|-----------|
| 85 | `ldap_simple_bind_s()` | Every LDAP auth check |
| 387 | `ldap_add_ext_s()` | User creation |
| 415 | `ldap_delete_s()` | User deletion |
| 434 | `ldap_modrdn2_s()` | Account rename |
| 531, 573 | `ldap_modify_s()` | Password/attribute changes |
| 633, 661 | `ldap_modify_s()` | Group membership |

**Note:** LDAP has async APIs (`ldap_simple_bind()` without `_s`), but X3 doesn't use them.

### 2.7 DNS Blocking in ioset_connect()

**Location:** `ioset.c:274`

```c
res = getaddrinfo(peer, portnum, &hints, &ai);  // BLOCKING!
```

SAR (async DNS resolver) exists but `ioset_connect()` doesn't use it. Affects:
- `mod-sockcheck.c:666` - Client verification
- `mail-smtp.c:437` - Email sending
- `proto-common.c:142` - IRCd uplink connection

### 2.8 Dead Code to Remove

| Location | Function | Status |
|----------|----------|--------|
| keycloak.c:3743 | `keycloak_update_user_credentials()` | Defined, never called |
| tools.c:1128 | `getipbyname()` | Defined, never called |

### 2.9 Other Blocking Operations (Low Priority)

| Category | Status | Notes |
|----------|--------|-------|
| **File I/O (saxdb.c)** | OK | Scheduled via timeq, not blocking commands |
| **LMDB (x3_lmdb.c)** | OK | Memory-mapped, very fast |
| **SMTP (mail-smtp.c)** | OK | Uses ioset after connect, but connect is blocking |
| **Sleep (keycloak.c:2785)** | Issue | `nanosleep()` in sync HTTP retry loop |
| **Fork (mail-sendmail.c)** | OK | `fork()` is fast, child does blocking work |

---

## 3. Prioritized Conversion Plan

### Priority 1: CRITICAL - Webhook Channel Sync (Blocks Async Webhooks)

**Problem:** `chanserv_queue_keycloak_sync()` calls sync `chanserv_sync_keycloak_channel()` for immediate priority, blocking the entire async webhook pipeline.

**Solution:** Route immediate syncs through async infrastructure.

| Task | Complexity | Files |
|------|------------|-------|
| Modify `chanserv_queue_keycloak_sync()` to use async path | Medium | chanserv.c |
| Add single-channel async sync entry point | Low | chanserv.c |
| Test webhook -> async sync pipeline | Medium | - |

### Priority 2: HIGH - AUTH Command (Blocks Every Login)

**Problem:** Every `/msg AuthServ AUTH` blocks while verifying password with Keycloak.

| Task | Complexity | Files |
|------|------------|-------|
| Create `keycloak_get_user_token_async()` | Medium | keycloak.c/h |
| Add `KC_ASYNC_USER_TOKEN` request type | Low | keycloak.c/h |
| Create `auth_async_ctx` state structure | Medium | nickserv.c |
| Implement `auth_async_callback()` | Medium | nickserv.c |
| Modify `cmd_auth()` to use async path | High | nickserv.c |
| Handle user disconnect during auth | Medium | nickserv.c |

### Priority 3: HIGH - COOKIE Activation (Blocks Account Activation)

**Problem:** Account activation blocks during password sync to Keycloak.

| Task | Complexity | Files |
|------|------------|-------|
| Create `keycloak_update_user_representation_async()` | Medium | keycloak.c/h |
| Add callback for COOKIE completion | Medium | nickserv.c |
| Handle async password hash sync | Medium | nickserv.c |

### Priority 4: MEDIUM - ChanServ ADDUSER/DELUSER

**Problem:** `chanserv_push_keycloak_access()` has multiple blocking calls in sequence.

| Task | Complexity | Files |
|------|------------|-------|
| Create async user lookup wrapper | Medium | keycloak.c |
| Create async group creation pipeline | High | keycloak.c |
| Chain async operations with state machine | High | chanserv.c |
| Remove sync fallbacks in group operations | Medium | chanserv.c |

### Priority 5: MEDIUM - REGISTER Command

**Problem:** Account registration blocks during Keycloak user creation.

| Task | Complexity | Files |
|------|------------|-------|
| Use existing `keycloak_create_user_async()` | Low | Already exists |
| Create register async context | Medium | nickserv.c |
| Modify `cmd_register()` for async | High | nickserv.c |

### Priority 6: LOW - Admin Commands (OSET, UNREGISTER)

**Problem:** Admin commands block but are rarely used.

| Task | Complexity | Files |
|------|------------|-------|
| Create async wrappers for admin ops | Medium | keycloak.c |
| Modify admin command handlers | Medium | nickserv.c, opserv.c |

### Priority 7: DEFERRED - LDAP Async

**Status:** LDAP is being deprecated in favor of Keycloak. Do not invest time here.

**Problem:** All LDAP operations use synchronous `_s` suffix functions that block.

**If needed later:** OpenLDAP has async APIs (`ldap_simple_bind()` without `_s`) that could be integrated with ioset.

### Priority 8: MEDIUM - DNS Async in ioset_connect()

**Problem:** `ioset_connect()` uses blocking `getaddrinfo()` despite SAR existing.

| Task | Complexity | Files |
|------|------------|-------|
| Create `ioset_connect_async()` using SAR | Medium | ioset.c |
| Add connect callback for async resolution | Medium | ioset.c |
| Migrate sockcheck to async connect | Low | mod-sockcheck.c |
| Migrate SMTP to async connect | Low | mail-smtp.c |

**Pattern:**
```c
void ioset_connect_async(const char *peer, unsigned int port,
                         void *data, ioset_connect_cb callback) {
    struct connect_ctx *ctx = /* ... */;
    sar_getaddr(peer, port_str, &hints, dns_resolved_cb, ctx);
}

static void dns_resolved_cb(void *ctx, struct addrinfo *ai) {
    /* Now do non-blocking connect() */
}
```

### Priority 9: LOW - Dead Code Removal

| Task | Complexity | Files |
|------|------------|-------|
| Remove `keycloak_update_user_credentials()` | Low | keycloak.c/h |
| Remove `getipbyname()` | Low | tools.c, common.h |
| Remove sync LDAP fallbacks after async conversion | Low | x3ldap.c |

### Priority 10: LOW - Background Operations

| Task | Status | Notes |
|------|--------|-------|
| JWKS refresh | Keep sync | Rare, cached |
| Batch sync | Already async | Done |
| WebPush sync | Has async version | Use `kc_webpush_send_async()` |

---

## 4. Implementation Details

### 4.1 Async Command Pattern Template

```c
/* Context structure for async command */
struct cmd_async_ctx {
    struct userNode *user;           /* User who issued command */
    struct svccmd *cmd;              /* Command context for reply */
    char handle[NICKSERV_HANDLE_LEN+1];
    uint64_t seq;                    /* Sequence number for validation */
    int state;                       /* State machine position */
    /* ... command-specific data ... */
};

/* Start async operation */
static int
cmd_foo_async(struct userNode *user, struct svccmd *cmd, ...) {
    struct cmd_async_ctx *ctx = calloc(1, sizeof(*ctx));
    ctx->user = user;
    ctx->cmd = cmd;
    ctx->seq = user->numeric;  /* For validation */

    /* Start async Keycloak operation */
    if (keycloak_foo_async(ctx, cmd_foo_callback) < 0) {
        reply("NSMSG_KEYCLOAK_ERROR");
        free(ctx);
        return 0;
    }

    return 1;  /* Async started, reply deferred */
}

/* Callback when async completes */
static void
cmd_foo_callback(void *data, int result, ...) {
    struct cmd_async_ctx *ctx = data;

    /* Validate session still valid */
    if (!ctx->user || ctx->user->numeric != ctx->seq) {
        /* User disconnected, cleanup */
        free(ctx);
        return;
    }

    if (result == KC_SUCCESS) {
        send_message(ctx->user, nickserv, "NSMSG_FOO_SUCCESS");
    } else {
        send_message(ctx->user, nickserv, "NSMSG_FOO_FAILED");
    }

    free(ctx);
}
```

### 4.2 State Machine for Multi-Step Async

For operations requiring multiple Keycloak calls:

```c
enum adduser_state {
    ADDUSER_GET_USER,      /* Looking up user */
    ADDUSER_GET_GROUP,     /* Looking up group */
    ADDUSER_CREATE_GROUP,  /* Creating group if needed */
    ADDUSER_ADD_MEMBER,    /* Adding user to group */
    ADDUSER_SET_LEVEL,     /* Setting access level */
    ADDUSER_DONE
};

struct adduser_async_ctx {
    /* ... common fields ... */
    enum adduser_state state;
    char *user_id;
    char *group_id;
    unsigned short level;
};

static void adduser_state_machine(struct adduser_async_ctx *ctx, int result) {
    switch (ctx->state) {
    case ADDUSER_GET_USER:
        if (result != KC_SUCCESS) { /* error */ }
        ctx->state = ADDUSER_GET_GROUP;
        keycloak_get_group_async(ctx, adduser_state_machine);
        break;
    case ADDUSER_GET_GROUP:
        if (result == KC_NOT_FOUND) {
            ctx->state = ADDUSER_CREATE_GROUP;
            keycloak_create_group_async(ctx, adduser_state_machine);
        } else {
            ctx->state = ADDUSER_ADD_MEMBER;
            keycloak_add_user_async(ctx, adduser_state_machine);
        }
        break;
    /* ... etc ... */
    }
}
```

### 4.3 Token Caching Strategy

Convert `kc_ensure_token()` to async-aware:

```c
/* Token state */
static struct {
    struct access_token *token;
    time_t expires;
    int refresh_pending;
    struct pending_op *waiters;  /* Operations waiting for token */
} token_cache;

int kc_ensure_token_async(kc_token_callback cb, void *data) {
    if (token_cache.token && now < token_cache.expires - 60) {
        /* Token valid, proceed immediately */
        cb(data, KC_SUCCESS, token_cache.token);
        return 0;
    }

    if (token_cache.refresh_pending) {
        /* Add to waiters list */
        add_token_waiter(cb, data);
        return 0;
    }

    /* Start async refresh */
    token_cache.refresh_pending = 1;
    return keycloak_get_client_token_async(token_refresh_callback, NULL);
}

static void token_refresh_callback(void *data, int result, struct access_token *token) {
    token_cache.refresh_pending = 0;
    if (result == KC_SUCCESS) {
        token_cache.token = token;
        token_cache.expires = now + token->expires_in;
    }

    /* Notify all waiters */
    notify_token_waiters(result, token);
}
```

---

## 5. Challenges and Mitigations

### 5.1 User Disconnect During Async

**Challenge:** User may disconnect before async completes.

**Mitigation:**
- Store `user->numeric` (UID) in context
- Validate UID matches in callback
- Use sequence numbers for reused UIDs

### 5.2 Command Flooding

**Challenge:** User spams commands, creates many pending contexts.

**Mitigation:**
- Track pending operations per user
- Limit concurrent async ops per user
- Return error if limit exceeded

### 5.3 Keycloak Unavailable

**Challenge:** Keycloak down causes all async ops to fail.

**Mitigation:**
- Implement circuit breaker pattern
- Track failure rate
- Fast-fail new requests if circuit open
- Periodic health checks to close circuit

### 5.4 Memory Pressure

**Challenge:** Many pending contexts consume memory.

**Mitigation:**
- Use fixed-size context pool
- Timeout stale contexts (30s default)
- Log warnings at high usage

### 5.5 Testing Complexity

**Challenge:** Async code harder to test.

**Mitigation:**
- Mock Keycloak responses in tests
- Test timeout/failure paths explicitly
- Load test with concurrent operations

---

## 6. Implementation Phases

### Phase 1: Webhook Sync Fix (1-2 days) ✅
- [x] Modify `chanserv_queue_keycloak_sync()` to use async for immediate priority
  - Added `kc_async_standalone` flag to distinguish standalone syncs from batch
  - Created `chanserv_sync_keycloak_channel_async_standalone()` wrapper
  - Modified `kc_async_sync_channel_done()` to handle standalone completion
  - Updated `chanserv_queue_keycloak_sync()` to use async path for all priorities when no batch running
- [ ] Test webhook -> async sync -> completion flow
- [ ] Verify no blocking in webhook handler path

### Phase 2: AUTH Command (3-4 days) ✅ COMPLETED

**Problem:** `cmd_auth()` calls `kc_check_auth()` which synchronously calls `keycloak_get_user_token()` (keycloak.c:3310), blocking 50-200ms per AUTH.

**Implementation (Completed Jan 2026):**

Note: Reuses existing `kc_check_auth_async()` infrastructure (KC_ASYNC_AUTH type) instead of adding new KC_ASYNC_USER_TOKEN type.

#### 2.1 Async Infrastructure ✅
- [x] Already exists: `kc_check_auth_async()` with `KC_ASYNC_AUTH` type
- [x] Already exists: `kc_async_callback` callback type
- [x] Already exists: Dispatch case in `kc_curl_check_completed()`

#### 2.2 Create Async Context (nickserv.c) ✅
- [x] Created `struct auth_async_ctx` at nickserv.c:6338-6346:
  ```c
  struct auth_async_ctx {
      char handle[NICKSERV_HANDLE_LEN + 1];
      char nick[NICKLEN + 1];
      char numeric[COMBO_NUMERIC_LEN + 1];  /* For disconnect validation */
      struct userNode *user;
      struct svccmd *cmd;
      int pw_arg;
      time_t started;
  };
  ```
- [x] Added forward declaration at nickserv.c:287

#### 2.3 Implement Callback (nickserv.c) ✅
- [x] Created `auth_async_callback()` at nickserv.c:6375-6539
- [x] `auth_async_validate_user()` validates user via numeric lookup
- [x] Handles KC_SUCCESS (with autocreate), KC_FORBIDDEN, KC_ERROR
- [x] Performs all cmd_auth checks: hostmask, suspended, activation, max logins
- [x] Sends appropriate messages via `send_message_type()`

#### 2.4 Modify cmd_auth() (nickserv.c:2896) ✅
- [x] Added async path in Keycloak section
- [x] Only uses async for users with numerics (pre-registration users fall to sync)
- [x] Falls back to sync on async start failure
- [x] Masks password arg on async start

#### 2.5 Testing
- [ ] Single AUTH completes successfully
- [ ] Concurrent AUTH commands (5+) don't block each other
- [ ] User disconnect during async handled gracefully
- [ ] Invalid password returns proper error
- [ ] Event loop latency stays under 10ms during AUTH

### Phase 3: COOKIE Command (2-3 days)

**Problem:** `cmd_cookie()` calls `kc_do_modify()` with two blocking calls: `keycloak_get_user()` and `keycloak_update_user_representation()`.

**Implementation Steps:**

#### 3.1 Add Async Types (keycloak.c/h)
- [ ] Add `KC_ASYNC_GET_USER` and `KC_ASYNC_UPDATE_USER` to enum
- [ ] Add callback types:
  ```c
  typedef int (*kc_get_user_callback)(void *session, int result, struct kc_user *user);
  typedef int (*kc_update_user_callback)(void *session, int result);
  ```

#### 3.2 Create Async Functions (keycloak.c)
- [ ] Create `keycloak_get_user_async()` - single user lookup
- [ ] Create `keycloak_update_user_representation_async()`
- [ ] Add dispatch cases in `kc_curl_check_completed()`

#### 3.3 Two-Phase State Machine (nickserv.c)
- [ ] Create `struct cookie_async_ctx`:
  ```c
  struct cookie_async_ctx {
      struct userNode *user;
      uint64_t user_numeric;
      struct handle_info *hi;
      char *user_id;  /* From lookup phase */
      char password[128];
      enum { COOKIE_STATE_LOOKUP, COOKIE_STATE_UPDATE, COOKIE_STATE_DONE } state;
  };
  ```
- [ ] Create `cookie_async_lookup_callback()` - stores user_id, starts update
- [ ] Create `cookie_async_update_callback()` - completes activation

#### 3.4 Modify cmd_cookie() (nickserv.c:3295)
- [ ] Add async path for ACTIVATION case
- [ ] Handle PASSWORD_CHANGE case similarly

#### 3.5 Testing
- [ ] ACTIVATION cookie flow completes
- [ ] PASSWORD_CHANGE cookie flow
- [ ] User disconnect during lookup/update phases
- [ ] Keycloak user not found error

### Phase 4: ChanServ ADDUSER (4-5 days)

**Problem:** `chanserv_push_keycloak_access()` has complex multi-step blocking flow: token → user lookup → group lookup → create parent → create group → set level → add user.

**Implementation Steps:**

#### 4.1 State Machine Design
```c
enum adduser_state {
    ADDUSER_ENSURE_TOKEN,   /* Phase 5 dependency */
    ADDUSER_LOOKUP_USER,    /* Get Keycloak user UUID */
    ADDUSER_LOOKUP_GROUP,   /* Find channel group */
    ADDUSER_CREATE_PARENT,  /* Create /irc-channels if needed */
    ADDUSER_CREATE_GROUP,   /* Create channel group if needed */
    ADDUSER_SET_LEVEL,      /* Set access level attribute */
    ADDUSER_ADD_USER,       /* Final step (already async!) */
    ADDUSER_DONE
};
```

#### 4.2 Add Async Types (keycloak.c/h)
- [ ] Add `KC_ASYNC_GET_GROUP_BY_PATH`, `KC_ASYNC_CREATE_GROUP`, `KC_ASYNC_CREATE_SUBGROUP`, `KC_ASYNC_SET_GROUP_ATTR`
- [ ] Add callback types for group operations

#### 4.3 Create Async Functions (keycloak.c)
- [ ] `keycloak_get_group_by_path_async()`
- [ ] `keycloak_create_group_async()`
- [ ] `keycloak_create_subgroup_async()`
- [ ] `keycloak_set_group_attribute_async()`

#### 4.4 State Machine (chanserv.c)
- [ ] Create `struct adduser_async_ctx` with channel, username, access_level, state, intermediate IDs
- [ ] Create `adduser_state_machine()` driver function
- [ ] Implement callbacks for each state transition
- [ ] Handle partial failure (idempotent design)

#### 4.5 Testing
- [ ] ADDUSER with existing channel group
- [ ] ADDUSER with new channel (creates hierarchy)
- [ ] DELUSER (removal path)
- [ ] CLVL (level change)
- [ ] Concurrent ADDUSER to same/different channels
- [ ] Network error mid-operation recovery
- [ ] LMDB cache consistency

### Phase 5: Token Cache Async (2 days) ✅ COMPLETED

**Problem:** `kc_ensure_token()` blocks when token expires. Multiple concurrent operations may all try to refresh simultaneously.

**Design:** Waiter queue pattern - first caller starts refresh, others wait, all notified on completion.

**Implementation (Completed Jan 2026):**

#### 5.1 Add Token Waiter Structure (nickserv.c) ✅
- [x] Created waiter structure and queue in nickserv.c:269-279:
  ```c
  typedef void (*kc_token_waiter_cb)(void *ctx, int result, struct access_token *token);
  struct kc_token_waiter {
      kc_token_waiter_cb callback;
      void *context;
      struct kc_token_waiter *next;
  };
  static struct kc_token_waiter *kc_token_waiters = NULL;
  static int kc_token_refresh_pending = 0;
  ```

#### 5.2 Create kc_ensure_token_async() (nickserv.c) ✅
- [x] Implemented at nickserv.c:6253-6310
- [x] Returns 1 if token valid (callback called immediately)
- [x] Returns 0 if refresh started/pending (callback queued)
- [x] Returns -1 on error

#### 5.3 Add keycloak_get_client_token_async() (keycloak.c) ✅
- [x] Added `KC_ASYNC_CLIENT_TOKEN` to enum at keycloak.c:1307
- [x] Added callback type `kc_client_token_callback` at keycloak.h:582-589
- [x] Implemented async function at keycloak.c:2076-2135
- [x] Added dispatch case at keycloak.c:1825-1846

#### 5.4 Create Token Refresh Callback ✅
- [x] `kc_token_refresh_callback()` at nickserv.c:6216-6241 - stores new token, notifies waiters
- [x] `kc_notify_token_waiters()` at nickserv.c:6191-6211 - iterates waiter list, invokes callbacks

#### 5.5 Migration Strategy
- [x] Keep sync `kc_ensure_token()` for remaining sync paths
- [ ] Update Phase 2-4 async operations to use `kc_ensure_token_async()` as first step (pending Phase 2-4)
- [ ] Eventually deprecate sync version (future)

#### 5.6 Testing
- [ ] Token refresh during single operation
- [ ] Multiple operations waiting on same refresh
- [ ] Token refresh failure notification
- [ ] Rapid consecutive calls (token still valid)

### Phase Dependencies

```
Phase 5 (Token Cache) ←── Foundation for all others
        ↓
Phase 2 (AUTH) ←── Simplest, proves pattern
        ↓
Phase 3 (COOKIE) ←── Two-step async
        ↓
Phase 4 (ChanServ) ←── Full state machine
```

**Recommended Order:** 5 → 2 → 3 → 4 (token cache enables all others)
**Alternative:** 2 → 3 → 4 → 5 (use sync token initially, optimize later)

### Phase 6: DNS Async (2-3 days)
- [ ] Create `ioset_connect_async()` using SAR
- [ ] Implement DNS resolution callback
- [ ] Migrate sockcheck module
- [ ] Migrate SMTP module
- [ ] Test with slow/failing DNS

### Phase 7: Dead Code Removal (1 day) ✅
- [x] Remove `keycloak_update_user_credentials()` - removed from keycloak.c/h
- [x] Remove `getipbyname()` - removed from tools.c and common.h
- [ ] Remove any remaining sync fallbacks
- [ ] Audit for other dead code

### Phase 8: Cleanup & Testing (2 days)
- [ ] Add metrics/logging for all async ops
- [ ] Update documentation
- [ ] Integration testing with concurrent operations
- [ ] Load testing

### DEFERRED: LDAP Async
LDAP is being deprecated. If ever needed:
- Convert `ldap_*_s()` functions to async equivalents
- Integrate LDAP socket with ioset
- Implement `ldap_result()` polling

---

## 7. Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Event loop blocks during AUTH | 100-200ms | 0ms |
| Event loop blocks during webhook | 50-500ms | 0ms |
| Concurrent SASL auths supported | ~5-10 | 100+ |
| Memory per pending async op | N/A | <1KB |

---

## 8. Files to Modify

| File | Changes | Priority |
|------|---------|----------|
| `x3/src/keycloak.c` | New async functions, token cache async, remove dead code | High |
| `x3/src/keycloak.h` | Function declarations, callback types, async enums | High |
| `x3/src/nickserv.c` | AUTH/COOKIE async, context structs | High |
| `x3/src/chanserv.c` | ADDUSER async, webhook sync fix | High |
| `x3/src/keycloak_webhook.c` | Already done (event queue) | Done |
| `x3/src/ioset.c` | Add `ioset_connect_async()` using SAR | Medium |
| `x3/src/ioset.h` | Async connect declarations | Medium |
| `x3/src/mod-sockcheck.c` | Use async connect | Medium |
| `x3/src/mail-smtp.c` | Use async connect | Medium |
| `x3/src/tools.c` | Remove dead `getipbyname()` | Low |
| `x3/src/common.h` | Remove `getipbyname()` declaration | Low |
| `x3/src/x3ldap.c` | DEFERRED - LDAP deprecated | Deferred |

---

## Appendix: Quick Reference

### Existing Async Pattern (SASL)
- Context: `sasl_async_ctx` in nickserv.c
- Callback: `sasl_async_auth_callback()` in keycloak.c
- Validation: Sequence number in `pending_sasl_t`

### Adding New Async Operation
1. Add `KC_ASYNC_*` enum in keycloak.h
2. Create `keycloak_*_async()` function in keycloak.c
3. Add case in `kc_curl_check_completed()` dispatch
4. Create callback type and context struct
5. Implement command handler async path

---

## 9. Performance Audit: X3 vs Nefarious2 Comparison

Deep performance analysis comparing X3 to Nefarious2 (IRCd) identified **23 additional bottlenecks** beyond HTTP blocking. This section documents findings to achieve performance parity.

### 9.1 Event Loop Architecture

| Aspect | Nefarious2 | X3 | Impact |
|--------|-----------|-----|--------|
| Event engine | epoll/kqueue/poll/select (configurable) | select only | O(n) vs O(1) for many FDs |
| Thread model | Optional thread pool | Single-threaded | Can't utilize multiple cores |
| Message queue | Batched send queue | Immediate sends | Network syscall overhead |
| Timer resolution | Sub-millisecond | timeq (second precision) | Latency for fast operations |

**Recommendation:** Add epoll/kqueue support to ioset, consider select->epoll migration path.

### 9.2 Critical Bottlenecks Found

#### 9.2.1 Blocking HTTP (Already in Plan)
- **Location:** `keycloak.c:2813` - `curl_easy_perform()`
- **Impact:** 50-200ms blocks per Keycloak call
- **Status:** Addressed in Phases 1-5

#### 9.2.2 LMDB Per-Operation Transactions
- **Location:** `x3_lmdb.c` - Every read/write opens new transaction
- **Impact:** ~0.1-1ms overhead per operation, adds up with many ops
- **Pattern Found:**
  ```c
  // Current: New txn per operation
  rc = mdb_txn_begin(lmdb_env, NULL, 0, &txn);
  mdb_put(txn, dbi, &key, &data, 0);
  mdb_txn_commit(txn);

  // Better: Batch multiple operations
  rc = mdb_txn_begin(lmdb_env, NULL, 0, &txn);
  for each operation:
      mdb_put(txn, dbi, &key, &data, 0);
  mdb_txn_commit(txn);  // Single commit
  ```
- **Recommendation:** Add transaction batching API for burst operations

#### 9.2.3 O(n²) Ban Matching
- **Location:** `opserv.c` - GLINE/SHUN matching against all users
- **Impact:** Grows quadratically with user count and ban list size
- **Root Cause:** Linear scan of ban list for each user, or vice versa
- **Nefarious Pattern:** Uses hash tables for O(1) exact matches, radix trees for CIDR
- **Recommendation:** Add hash index for exact host matches, radix tree for CIDR bans

#### 9.2.4 Blocking Sleep in Reconnect
- **Location:** `main-common.c:289,360` - `sleep()` during uplink reconnect
- **Impact:** 5-60 second blocks during reconnection attempts
- **Current Code:**
  ```c
  sleep(reconnect_delay);  // Blocks entire event loop!
  ```
- **Recommendation:** Use timeq callback for delayed reconnect

### 9.3 High-Priority Bottlenecks

#### 9.3.1 strlen() Inefficiency
- **Location:** Multiple files - repeated `strlen()` on same strings
- **Pattern:**
  ```c
  // Bad: strlen called twice
  if (strlen(str) > MAX) return;
  memcpy(dest, str, strlen(str));

  // Better: Cache length
  size_t len = strlen(str);
  if (len > MAX) return;
  memcpy(dest, str, len);
  ```
- **Files Affected:** nickserv.c, chanserv.c, tools.c
- **Recommendation:** Audit and cache string lengths

#### 9.3.2 dict.c Hash Table Growth
- **Location:** `dict.c` - Hash table resizing during add
- **Impact:** Occasional O(n) rehash during inserts
- **Nefarious Pattern:** Pre-sizes hash tables, uses incremental rehashing
- **Recommendation:** Add `dict_reserve()` for known-size collections

### 9.4 Medium-Priority Bottlenecks

#### 9.4.1 HelpServ Queue Scanning
- **Location:** `mod-helpserv.c` - Linear scan of all queues
- **Impact:** O(n) for queue lookup, O(n²) for bulk operations
- **Recommendation:** Add index by queue ID

#### 9.4.2 Memory Allocation in Hot Paths
- **Location:** Various - `malloc()` in message handlers
- **Pattern:** Allocate/free per message instead of pool
- **Nefarious Pattern:** Uses memory pools for frequent allocations
- **Recommendation:** Add object pools for `userNode`, `chanNode`, message buffers

#### 9.4.3 saxdb Write Performance
- **Location:** `saxdb.c` - Synchronous database writes
- **Impact:** 10-100ms during periodic saves
- **Current:** Blocks event loop during write
- **Recommendation:** Consider async write with `pwrite()` or background thread

### 9.5 Comparison: Nefarious Event Engine Selection

```c
// ircd/engine.c - Nefarious event engine selection (priority order)
#if USE_DEVPOLL
    engine_devpoll_init();  // Solaris /dev/poll
#elif USE_EPOLL
    engine_epoll_init();    // Linux epoll - O(1)
#elif USE_KQUEUE
    engine_kqueue_init();   // BSD/macOS kqueue - O(1)
#elif USE_POLL
    engine_poll_init();     // poll() - O(n)
#else
    engine_select_init();   // select() - O(n), 1024 FD limit
#endif
```

X3's ioset.c only implements `select()`, limiting scalability.

### 9.6 Additional Async Opportunities

| Operation | Current | Recommendation | Priority |
|-----------|---------|----------------|----------|
| JWKS refresh | Sync (rare) | Keep sync | Low |
| WebPush batch | Has async | Use consistently | Medium |
| Email verification | Sync HTTP | Use async HTTP | Medium |
| Fingerprint lookup | Has async | Already done | Done |
| Group sync | Partial async | Complete async | High |
| Uplink reconnect | Blocking sleep | timeq callback | High |

### 9.7 Updated Implementation Phases

**Add to existing phases:**

#### Phase 1b: Reconnect Sleep Fix (0.5 days) ✅
- [x] Replace `sleep()` in main-common.c with timeq callback
  - Changed `uplink_select()` to return delay instead of sleeping (returns 0 on success, >0 for delay seconds, -1 on fatal)
  - Added `reconnect_pending` flag and `uplink_reconnect_callback()` for deferred reconnection
  - Modified `uplink_connect()` to use exponential backoff via timeq instead of inline sleep
  - Updated ioset_run() to not spin when reconnect is pending
  - Updated all callers (opserv.c cmd_jump, uplink_update) to handle new return value
- [ ] Test reconnection behavior

#### Phase 9: LMDB Transaction Batching (2-3 days)
- [ ] Create `lmdb_batch_begin()` / `lmdb_batch_commit()` API
- [ ] Identify burst operation patterns
- [ ] Batch metadata updates
- [ ] Batch channel sync operations
- [ ] Benchmark improvement

#### Phase 10: Ban Matching Optimization (3-4 days)
- [ ] Add hash index for exact host matches
- [ ] Evaluate radix tree for CIDR matching
- [ ] Benchmark with large ban lists (1000+ entries)

#### Phase 11: Event Engine Upgrade (5-7 days)
- [ ] Abstract ioset backend interface
- [ ] Implement epoll backend for Linux
- [ ] Implement kqueue backend for BSD/macOS
- [ ] Add compile-time/runtime selection
- [ ] Benchmark FD scalability

### 9.8 Deferred Optimizations - Implementation Status

| Item | Status | Notes |
|------|--------|-------|
| Thread pool | ✅ **IMPLEMENTED** | `threadpool.c/h` - POSIX threads, priority queues, eventfd notification |
| Memory pools | ✅ **IMPLEMENTED** | `mempool.c/h` - Slab allocator, global pools for msgbuf/strings/curl |
| Incremental dict rehash | ⏭️ **SKIPPED** | X3 uses splay trees, not hash tables - no rehashing needed |
| HelpServ queue index | ⏭️ **SKIPPED** | Already has dict-based indices (`hs->requests`, `helpserv_reqs_by*_dict`) |

---

## 10. Summary: All Identified Bottlenecks

| Category | Count | Critical | High | Medium | Low |
|----------|-------|----------|------|--------|-----|
| HTTP Blocking | 26+ | ✓ | | | |
| LMDB Transactions | 1 | ✓ | | | |
| Ban Matching | 1 | ✓ | | | |
| Reconnect Sleep | 1 | | ✓ | | |
| strlen Inefficiency | 5+ | | ✓ | | |
| Dict Rehashing | 1 | | | ✓ | |
| HelpServ Scanning | 1 | | | ✓ | |
| Memory Allocation | 3+ | | | ✓ | |
| saxdb Writes | 1 | | | ✓ | |
| Event Engine (select) | 1 | | | ✓ | |
| DNS Blocking | 1 | | | ✓ | |
| Dead Code | 2 | | | | ✓ |
| **Total** | **44+** | **3** | **6+** | **7+** | **2** |

---

## 11. Advanced Optimizations: Detailed Implementation Plans

### 11.1 Thread Pool Implementation

**Goal:** Offload CPU-intensive work from the event loop to worker threads.

#### 11.1.1 Architecture Design

```
┌─────────────────────────────────────────────────────────────┐
│                     Main Event Loop                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │  ioset  │  │  timeq  │  │ signals │  │ curl_m  │        │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘        │
│       └───────────┬┴───────────┴┬───────────┘              │
│                   ▼              ▼                          │
│           ┌──────────────┐  ┌──────────────┐               │
│           │ Task Submit  │  │ Result Queue │               │
│           │   (lockfree) │  │  (lockfree)  │               │
│           └──────┬───────┘  └──────▲───────┘               │
└──────────────────┼─────────────────┼───────────────────────┘
                   │                 │
     ┌─────────────┼─────────────────┼─────────────────┐
     │             ▼                 │                 │
     │  ┌──────────────────────────────────────────┐  │
     │  │              Worker Threads               │  │
     │  │  ┌────────┐ ┌────────┐ ┌────────┐       │  │
     │  │  │Worker 1│ │Worker 2│ │Worker N│       │  │
     │  │  └───┬────┘ └───┬────┘ └───┬────┘       │  │
     │  │      │          │          │             │  │
     │  │      ▼          ▼          ▼             │  │
     │  │  ┌──────────────────────────────────┐   │  │
     │  │  │     Shared Work Queue (MPMC)     │   │  │
     │  │  └──────────────────────────────────┘   │  │
     │  └──────────────────────────────────────────┘  │
     │                Thread Pool                      │
     └─────────────────────────────────────────────────┘
```

#### 11.1.2 Data Structures

```c
/* x3/src/threadpool.h */

#ifndef THREADPOOL_H
#define THREADPOOL_H

#include <pthread.h>
#include <stdatomic.h>

/* Task priority levels */
typedef enum {
    TP_PRIORITY_LOW = 0,
    TP_PRIORITY_NORMAL = 1,
    TP_PRIORITY_HIGH = 2,
    TP_PRIORITY_CRITICAL = 3,
    TP_PRIORITY_COUNT
} tp_priority_t;

/* Task state */
typedef enum {
    TP_STATE_PENDING,
    TP_STATE_RUNNING,
    TP_STATE_COMPLETED,
    TP_STATE_CANCELLED,
    TP_STATE_FAILED
} tp_state_t;

/* Task function signatures */
typedef void *(*tp_work_func)(void *arg);
typedef void (*tp_callback_func)(void *result, void *user_data, tp_state_t state);

/* Task handle (opaque to callers) */
typedef struct tp_task tp_task_t;

/* Task descriptor */
struct tp_task {
    tp_work_func work;              /* Function to execute in worker */
    tp_callback_func callback;       /* Called in main thread when done */
    void *arg;                       /* Argument to work function */
    void *user_data;                 /* Passed to callback */
    void *result;                    /* Result from work function */
    tp_state_t state;                /* Current state */
    tp_priority_t priority;          /* Scheduling priority */
    unsigned long task_id;           /* Unique task ID for tracking */
    time_t submit_time;              /* When task was submitted */
    time_t start_time;               /* When worker started */
    time_t complete_time;            /* When worker finished */
    struct tp_task *next;            /* Queue linkage */
};

/* Thread pool configuration */
struct tp_config {
    unsigned int min_threads;        /* Minimum worker threads (default: 2) */
    unsigned int max_threads;        /* Maximum worker threads (default: CPU cores) */
    unsigned int queue_size;         /* Max pending tasks (default: 1000) */
    unsigned int idle_timeout_ms;    /* Shrink idle threads after ms (default: 60000) */
    const char *name;                /* Pool name for logging */
};

/* Thread pool statistics */
struct tp_stats {
    atomic_ulong tasks_submitted;
    atomic_ulong tasks_completed;
    atomic_ulong tasks_cancelled;
    atomic_ulong tasks_failed;
    atomic_ulong total_wait_time_ms;
    atomic_ulong total_exec_time_ms;
    atomic_uint active_threads;
    atomic_uint idle_threads;
    atomic_uint queue_depth;
    atomic_uint queue_high_water;
};

/* API Functions */

/**
 * Initialize thread pool with configuration
 * @return 0 on success, -1 on failure
 */
int threadpool_init(const struct tp_config *config);

/**
 * Shutdown thread pool, cancelling pending tasks
 * @param wait_ms Max time to wait for running tasks (0 = don't wait)
 */
void threadpool_shutdown(unsigned int wait_ms);

/**
 * Submit a task to the thread pool
 * @param work Function to execute in worker thread
 * @param arg Argument passed to work function
 * @param callback Function called in main thread when done (can be NULL)
 * @param user_data Passed to callback
 * @param priority Task priority
 * @return Task handle, or NULL on failure
 */
tp_task_t *threadpool_submit(tp_work_func work, void *arg,
                              tp_callback_func callback, void *user_data,
                              tp_priority_t priority);

/**
 * Cancel a pending task (no-op if already running)
 * @return 1 if cancelled, 0 if already running/complete
 */
int threadpool_cancel(tp_task_t *task);

/**
 * Check task state
 */
tp_state_t threadpool_task_state(tp_task_t *task);

/**
 * Process completed task callbacks (call from main event loop)
 * @param max_callbacks Max callbacks to process (0 = all)
 * @return Number of callbacks processed
 */
int threadpool_process_callbacks(unsigned int max_callbacks);

/**
 * Get file descriptor for completion notification
 * (for integration with select/epoll)
 */
int threadpool_get_notify_fd(void);

/**
 * Get statistics
 */
const struct tp_stats *threadpool_get_stats(void);

#endif /* THREADPOOL_H */
```

#### 11.1.3 Implementation Steps

**✅ IMPLEMENTED** - See `x3/src/threadpool.c` and `x3/src/threadpool.h`

**Phase 1: Core Infrastructure** ✅
- [x] Create `threadpool.c` with POSIX threads implementation
- [x] Implement mutex-protected queues for task submission (simple approach, sufficient for expected load)
- [x] Implement completed queue for result return to main thread
- [x] Add eventfd (Linux) / pipe (portable) for waking main thread on completion
- [x] Provide `threadpool_get_notify_fd()` for ioset integration
- [x] Add `threadpool_process_callbacks()` to main loop

**Phase 2: Task Management** ✅
- [x] Implement priority queue (4 levels: LOW, NORMAL, HIGH, CRITICAL)
- [x] Add task cancellation support
- [x] Add task ID tracking for debugging
- [x] Implement graceful shutdown with configurable timeout

**Phase 3: Dynamic Scaling** (Deferred - simple fixed pool for now)
- [x] Fixed thread pool (min_threads to max_threads)
- [ ] Dynamic thread spawning on demand (future enhancement)
- [ ] Idle thread reaping after timeout (future enhancement)
- [x] Backpressure when queue full (returns NULL from submit)

**Phase 4: Integration** (Future work)
- [ ] Wrap PBKDF2 password hashing in threadpool task
- [ ] Wrap bcrypt operations
- [ ] Add async JSON parsing for large Keycloak responses
- [ ] Wrap zstd compression/decompression
- [ ] Update statistics/metrics

**Phase 5: Testing (2 days)**
- [ ] Unit tests for queue operations
- [ ] Stress test with concurrent submissions
- [ ] Test cancellation and shutdown paths
- [ ] Valgrind/TSAN for race conditions
- [ ] Benchmark password hashing throughput

#### 11.1.4 Integration Points

```c
/* Example: Async password hashing */

struct hash_task_ctx {
    char *password;
    char *result_hash;
    struct userNode *user;
    void (*callback)(struct userNode *, const char *hash, int success);
};

static void *hash_password_worker(void *arg) {
    struct hash_task_ctx *ctx = arg;
    ctx->result_hash = pbkdf2_hash(ctx->password);
    return ctx;
}

static void hash_password_complete(void *result, void *user_data, tp_state_t state) {
    struct hash_task_ctx *ctx = result;
    if (state == TP_STATE_COMPLETED && ctx->result_hash) {
        ctx->callback(ctx->user, ctx->result_hash, 1);
    } else {
        ctx->callback(ctx->user, NULL, 0);
    }
    free(ctx->password);
    free(ctx->result_hash);
    free(ctx);
}

void hash_password_async(struct userNode *user, const char *password,
                         void (*callback)(struct userNode *, const char *, int)) {
    struct hash_task_ctx *ctx = malloc(sizeof(*ctx));
    ctx->password = strdup(password);
    ctx->user = user;
    ctx->callback = callback;
    threadpool_submit(hash_password_worker, ctx, hash_password_complete,
                      NULL, TP_PRIORITY_NORMAL);
}
```

---

### 11.2 Memory Pool Implementation

**Goal:** Eliminate malloc/free overhead for frequently allocated objects.

#### 11.2.1 Pool Types

| Pool | Object Size | Typical Count | Allocation Frequency |
|------|-------------|---------------|---------------------|
| `mp_msgbuf` | 512 bytes | 1000 | Very high (every message) |
| `mp_string` | 64 bytes | 5000 | High (temp strings) |
| `mp_usernode` | ~200 bytes | 1000 | Medium (connect/disconnect) |
| `mp_channode` | ~150 bytes | 500 | Low (join/part) |
| `mp_curl_ctx` | ~100 bytes | 50 | Medium (HTTP requests) |

#### 11.2.2 Data Structures

```c
/* x3/src/mempool.h */

#ifndef MEMPOOL_H
#define MEMPOOL_H

#include <stddef.h>

/* Memory pool handle */
typedef struct mempool mempool_t;

/* Pool statistics */
struct mempool_stats {
    size_t object_size;          /* Size of each object */
    size_t alignment;            /* Alignment requirement */
    unsigned long total_objects; /* Total objects in pool */
    unsigned long free_objects;  /* Currently available */
    unsigned long alloc_count;   /* Total allocations */
    unsigned long free_count;    /* Total frees */
    unsigned long grow_count;    /* Times pool expanded */
    unsigned long peak_usage;    /* Maximum concurrent allocations */
    size_t memory_used;          /* Total bytes allocated from system */
};

/**
 * Create a memory pool
 * @param name Pool name (for debugging)
 * @param object_size Size of each object
 * @param alignment Required alignment (0 = default)
 * @param initial_count Initial objects to preallocate
 * @param max_count Maximum objects (0 = unlimited)
 * @param grow_count Objects to add when pool exhausted
 * @return Pool handle, or NULL on failure
 */
mempool_t *mempool_create(const char *name, size_t object_size,
                          size_t alignment, unsigned int initial_count,
                          unsigned int max_count, unsigned int grow_count);

/**
 * Destroy a memory pool
 * @param pool Pool to destroy
 * @param check_leaks If true, warn about unreturned objects
 */
void mempool_destroy(mempool_t *pool, int check_leaks);

/**
 * Allocate an object from the pool
 * @return Object pointer, or NULL if pool exhausted
 */
void *mempool_alloc(mempool_t *pool);

/**
 * Return an object to the pool
 */
void mempool_free(mempool_t *pool, void *obj);

/**
 * Zero-fill and allocate (like calloc)
 */
void *mempool_zalloc(mempool_t *pool);

/**
 * Get pool statistics
 */
void mempool_get_stats(mempool_t *pool, struct mempool_stats *stats);

/**
 * Shrink pool by releasing unused memory
 * @param keep_free Minimum free objects to keep
 * @return Bytes released
 */
size_t mempool_shrink(mempool_t *pool, unsigned int keep_free);

/**
 * Debug: Dump all pools to log
 */
void mempool_dump_all(void);

/* Global pools (initialized at startup) */
extern mempool_t *mp_msgbuf;     /* IRC message buffers */
extern mempool_t *mp_string64;   /* 64-byte strings */
extern mempool_t *mp_string256;  /* 256-byte strings */
extern mempool_t *mp_usernode;   /* struct userNode */
extern mempool_t *mp_channode;   /* struct chanNode */
extern mempool_t *mp_curl_ctx;   /* CURL request contexts */

/**
 * Initialize global memory pools
 * Call once at startup before any allocations
 */
int mempool_init_global(void);

/**
 * Cleanup global memory pools
 */
void mempool_cleanup_global(void);

#endif /* MEMPOOL_H */
```

#### 11.2.3 Implementation (Slab Allocator Style)

```c
/* Internal structure */
struct mempool {
    const char *name;
    size_t object_size;          /* Actual size of objects */
    size_t slot_size;            /* Size including header */
    size_t alignment;

    /* Free list (LIFO for cache locality) */
    void *free_list;
    unsigned int free_count;

    /* Slabs (chunks of memory) */
    struct slab {
        struct slab *next;
        unsigned int capacity;
        unsigned int used;
        char data[];             /* Flexible array member */
    } *slabs;

    /* Configuration */
    unsigned int grow_count;
    unsigned int max_count;

    /* Statistics */
    struct mempool_stats stats;

    /* Debug support */
#ifndef NDEBUG
    unsigned int magic;          /* For corruption detection */
    struct {
        void *ptr;
        const char *file;
        int line;
    } *alloc_trace;              /* Track allocation sites */
#endif
};

/* Object header (hidden before user data) */
struct pool_obj_header {
    mempool_t *pool;             /* Owner pool */
#ifndef NDEBUG
    unsigned int magic;
    unsigned int alloc_seq;      /* Allocation sequence number */
#endif
};
```

#### 11.2.4 Implementation Steps

**✅ IMPLEMENTED** - See `x3/src/mempool.c` and `x3/src/mempool.h`

**Phase 1: Core Pool** ✅
- [x] Implement `mempool_create()` with slab allocation
- [x] Implement `mempool_alloc()` with LIFO free list (cache locality)
- [x] Implement `mempool_free()` with validation
- [x] Add debug magic numbers (MEMPOOL_MAGIC, MEMPOOL_FREE_MAGIC, MEMPOOL_ALLOC_MAGIC)
- [x] Implement `mempool_destroy()` with leak checking

**Phase 2: Growth and Shrink** ✅
- [x] Implement pool growth when exhausted (`mempool_add_slab()`)
- [x] Implement `mempool_shrink()` (stub - slab consolidation is complex)
- [x] Add max_count enforcement
- [x] Add statistics tracking (alloc_count, free_count, peak_usage, memory_used)

**Phase 3: Global Pools** ✅
- [x] Define standard pool sizes (mp_msgbuf=512, mp_string64, mp_string256, mp_curl_ctx=128)
- [x] Implement `mempool_init_global()` and `mempool_cleanup_global()`
- [x] Add pools to startup/shutdown sequence in main.c/main-common.c
- [x] Create `pool_strdup()` / `pool_strfree()` helpers

**Phase 4: Integration** (Future work)
- [ ] Replace `malloc(512)` message buffers with `mp_msgbuf`
- [ ] Replace `struct userNode` allocations
- [ ] Replace `struct chanNode` allocations
- [ ] Replace CURL context allocations

**Phase 5: Testing** (Future work)
- [ ] Unit tests for alloc/free cycles
- [ ] Test pool exhaustion behavior
- [ ] Test debug corruption detection
- [ ] Stress test with concurrent access
- [ ] Benchmark vs malloc

---

### 11.3 Incremental Dict Rehash Implementation

**⏭️ SKIPPED** - X3 uses **splay trees** (not hash tables) for its dict implementation. Splay trees self-balance via splaying during access operations, so there is no rehashing step that causes latency spikes. This optimization is not applicable.

**Original Goal:** Spread hash table resize cost over time to avoid latency spikes.

#### 11.3.1 Modified Dict Structure

```c
/* Modified x3/src/dict-splay.c */

struct dict {
    /* Two hash tables for incremental rehash */
    struct {
        struct dict_node **table;
        unsigned int size;
        unsigned int used;
    } ht[2];

    /* Rehash state */
    int rehashing;               /* -1 = not rehashing, >= 0 = current bucket */
    unsigned long rehash_ops;    /* Operations since rehash started */

    /* Existing fields */
    int refs;
    free_f free_keys;
    free_f free_data;
    compare_f compare;

    /* Statistics */
    unsigned long inserts;
    unsigned long lookups;
    unsigned long deletes;
    unsigned long rehash_count;
};

/* Load factor thresholds */
#define DICT_EXPAND_RATIO 2      /* Expand when used/size > 2 */
#define DICT_SHRINK_RATIO 8      /* Shrink when size/used > 8 */
#define DICT_REHASH_BATCH 10     /* Buckets to rehash per operation */
```

#### 11.3.2 Incremental Rehash Algorithm

```c
/**
 * Perform one step of incremental rehashing
 * Called implicitly during dict operations
 */
static void dict_rehash_step(struct dict *dict) {
    if (!dict->rehashing >= 0)
        return;

    int processed = 0;
    while (processed < DICT_REHASH_BATCH && dict->ht[0].used > 0) {
        struct dict_node *node, *next;

        /* Skip empty buckets */
        while (dict->ht[0].table[dict->rehashing] == NULL) {
            dict->rehashing++;
            if (dict->rehashing >= dict->ht[0].size) {
                /* Rehash complete */
                free(dict->ht[0].table);
                dict->ht[0] = dict->ht[1];
                dict->ht[1].table = NULL;
                dict->ht[1].size = 0;
                dict->ht[1].used = 0;
                dict->rehashing = -1;
                dict->rehash_count++;
                return;
            }
        }

        /* Rehash all nodes in this bucket */
        node = dict->ht[0].table[dict->rehashing];
        while (node) {
            next = node->next;

            /* Compute new bucket in ht[1] */
            unsigned int h = node->hash & (dict->ht[1].size - 1);
            node->next = dict->ht[1].table[h];
            dict->ht[1].table[h] = node;

            dict->ht[0].used--;
            dict->ht[1].used++;
            node = next;
        }
        dict->ht[0].table[dict->rehashing] = NULL;
        dict->rehashing++;
        processed++;
    }

    dict->rehash_ops++;
}

/**
 * Start incremental rehash to new size
 */
static int dict_expand(struct dict *dict, unsigned int new_size) {
    /* Can't expand while already rehashing */
    if (dict->rehashing >= 0)
        return -1;

    /* Round up to power of 2 */
    new_size = next_power_of_2(new_size);

    /* Allocate new table */
    dict->ht[1].table = calloc(new_size, sizeof(struct dict_node *));
    if (!dict->ht[1].table)
        return -1;

    dict->ht[1].size = new_size;
    dict->ht[1].used = 0;
    dict->rehashing = 0;

    return 0;
}

/**
 * Find with incremental rehash
 */
struct dict_node *dict_find(struct dict *dict, const char *key) {
    if (dict->rehashing >= 0)
        dict_rehash_step(dict);

    unsigned int hash = dict_hash(key);

    /* Check both tables during rehash */
    for (int i = 0; i <= (dict->rehashing >= 0 ? 1 : 0); i++) {
        unsigned int idx = hash & (dict->ht[i].size - 1);
        struct dict_node *node = dict->ht[i].table[idx];
        while (node) {
            if (dict->compare(node->key, key) == 0)
                return node;
            node = node->next;
        }
    }

    dict->lookups++;
    return NULL;
}

/**
 * Insert with incremental rehash
 */
int dict_insert(struct dict *dict, void *key, void *data) {
    if (dict->rehashing >= 0)
        dict_rehash_step(dict);

    /* Check if expansion needed */
    if (dict->ht[0].used >= dict->ht[0].size * DICT_EXPAND_RATIO) {
        if (dict->rehashing < 0) {
            dict_expand(dict, dict->ht[0].size * 2);
        }
    }

    /* Insert into appropriate table */
    struct {
        struct dict_node **table;
        unsigned int size;
    } *ht = (dict->rehashing >= 0) ? &dict->ht[1] : &dict->ht[0];

    unsigned int hash = dict_hash(key);
    unsigned int idx = hash & (ht->size - 1);

    struct dict_node *node = malloc(sizeof(*node));
    node->key = key;
    node->data = data;
    node->hash = hash;
    node->next = ht->table[idx];
    ht->table[idx] = node;
    ht->used++;

    dict->inserts++;
    return 0;
}
```

#### 11.3.3 Implementation Steps

**Phase 1: Dual Table Structure (1 day)**
- [ ] Add `ht[2]` array to dict structure
- [ ] Add `rehashing` state variable
- [ ] Update `dict_new()` to initialize dual tables
- [ ] Update `dict_delete()` to clean both tables

**Phase 2: Incremental Rehash (2 days)**
- [ ] Implement `dict_rehash_step()`
- [ ] Implement `dict_expand()` for gradual expansion
- [ ] Modify `dict_find()` to check both tables
- [ ] Modify `dict_insert()` to use correct table
- [ ] Modify `dict_remove()` to check both tables

**Phase 3: Shrinking (1 day)**
- [ ] Add `dict_shrink()` for memory reclamation
- [ ] Add shrink threshold check
- [ ] Implement shrink during low load periods

**Phase 4: API Additions (1 day)**
- [ ] Add `dict_reserve(dict, size)` for presizing
- [ ] Add `dict_is_rehashing(dict)` query
- [ ] Add `dict_rehash_progress(dict)` for monitoring
- [ ] Add statistics tracking

**Phase 5: Testing (1 day)**
- [ ] Unit tests for insert/find during rehash
- [ ] Test remove during rehash
- [ ] Verify no data loss during rehash
- [ ] Benchmark rehash latency distribution
- [ ] Test with 100k+ entries

---

### 11.4 HelpServ Queue Index Implementation

**⏭️ SKIPPED** - HelpServ already has dict-based indices:
- `hs->requests` - per-bot request lookup by ID
- `helpserv_reqs_bynick_dict` - global lookup by nick
- `helpserv_reqs_byhand_dict` - global lookup by handler

These provide O(1) lookup. No additional indexing needed.

**Original Goal:** O(1) request lookup by ID instead of O(n) list scan.

#### 11.4.1 Modified Data Structure

```c
/* Modified x3/src/mod-helpserv.c */

struct helpserv_request {
    unsigned long id;                /* Unique request ID */
    struct helpserv_user *user;      /* User who opened request */
    struct helpserv_user *helper;    /* Assigned helper (if any) */
    char *text;                      /* Request text */
    time_t opened;                   /* When opened */
    time_t assigned;                 /* When assigned */
    enum request_state state;        /* OPEN, ASSIGNED, CLOSED, etc. */

    /* List linkage (for ordering) */
    struct helpserv_request *next;
    struct helpserv_request *prev;

    /* Index entry (for O(1) lookup) */
    struct dict_node *index_node;    /* Points to our dict entry */
};

struct helpserv_bot {
    const char *nick;
    struct chanNode *helpee_channel;
    struct chanNode *helper_channel;

    /* Request list (ordered by time) */
    struct helpserv_request *requests_head;
    struct helpserv_request *requests_tail;
    unsigned int request_count;

    /* Index by request ID (O(1) lookup) */
    struct dict *request_index;      /* id -> request mapping */

    /* Index by user (for "my requests") */
    struct dict *requests_by_user;   /* account -> list of requests */

    /* Next request ID */
    unsigned long next_id;

    /* Statistics */
    unsigned long total_requests;
    unsigned long total_closed;
    time_t avg_response_time;
};
```

#### 11.4.2 Index Operations

```c
/**
 * Create a new request with index entry
 */
struct helpserv_request *helpserv_request_create(struct helpserv_bot *hs,
                                                   struct helpserv_user *user,
                                                   const char *text) {
    struct helpserv_request *req = calloc(1, sizeof(*req));
    if (!req) return NULL;

    req->id = hs->next_id++;
    req->user = user;
    req->text = strdup(text);
    req->opened = now;
    req->state = REQUEST_OPEN;

    /* Add to ordered list (tail = newest) */
    req->prev = hs->requests_tail;
    req->next = NULL;
    if (hs->requests_tail) {
        hs->requests_tail->next = req;
    } else {
        hs->requests_head = req;
    }
    hs->requests_tail = req;
    hs->request_count++;

    /* Add to ID index - O(1) */
    char id_str[32];
    snprintf(id_str, sizeof(id_str), "%lu", req->id);
    dict_insert(hs->request_index, strdup(id_str), req);

    /* Add to user index */
    struct helpserv_reqlist *user_reqs = dict_find(hs->requests_by_user,
                                                    user->handle->handle);
    if (!user_reqs) {
        user_reqs = calloc(1, sizeof(*user_reqs));
        dict_insert(hs->requests_by_user, strdup(user->handle->handle), user_reqs);
    }
    reqlist_append(user_reqs, req);

    hs->total_requests++;
    return req;
}

/**
 * Find request by ID - O(1) instead of O(n)
 */
struct helpserv_request *helpserv_request_find(struct helpserv_bot *hs,
                                                 unsigned long id) {
    char id_str[32];
    snprintf(id_str, sizeof(id_str), "%lu", id);
    return dict_find(hs->request_index, id_str);
}

/**
 * Find all requests for a user - O(1)
 */
struct helpserv_reqlist *helpserv_user_requests(struct helpserv_bot *hs,
                                                  struct handle_info *hi) {
    return dict_find(hs->requests_by_user, hi->handle);
}

/**
 * Close and remove a request
 */
void helpserv_request_close(struct helpserv_bot *hs,
                            struct helpserv_request *req) {
    /* Remove from ordered list */
    if (req->prev) req->prev->next = req->next;
    else hs->requests_head = req->next;
    if (req->next) req->next->prev = req->prev;
    else hs->requests_tail = req->prev;
    hs->request_count--;

    /* Remove from ID index */
    char id_str[32];
    snprintf(id_str, sizeof(id_str), "%lu", req->id);
    dict_remove(hs->request_index, id_str);

    /* Remove from user index */
    struct helpserv_reqlist *user_reqs = dict_find(hs->requests_by_user,
                                                    req->user->handle->handle);
    if (user_reqs) {
        reqlist_remove(user_reqs, req);
        if (user_reqs->count == 0) {
            dict_remove(hs->requests_by_user, req->user->handle->handle);
            free(user_reqs);
        }
    }

    /* Update stats */
    hs->total_closed++;

    /* Free request */
    free(req->text);
    free(req);
}
```

#### 11.4.3 Implementation Steps

**Phase 1: Add Index Structures (0.5 days)**
- [ ] Add `request_index` dict to `helpserv_bot`
- [ ] Add `requests_by_user` dict to `helpserv_bot`
- [ ] Initialize indices in `helpserv_bot_create()`
- [ ] Clean up indices in `helpserv_bot_destroy()`

**Phase 2: Index Maintenance (0.5 days)**
- [ ] Update `helpserv_request_create()` to add to indices
- [ ] Update request close to remove from indices
- [ ] Handle request state changes

**Phase 3: Update Lookups (1 day)**
- [ ] Replace all `find_request_by_id()` linear scans with dict lookup
- [ ] Add `helpserv_user_requests()` for user's open requests
- [ ] Update commands: CLOSE, PICKUP, REASSIGN, etc.

**Phase 4: Bulk Operations (0.5 days)**
- [ ] Optimize CLOSEALL using index iteration
- [ ] Optimize user disconnect cleanup
- [ ] Add batch close by age

**Phase 5: Testing (0.5 days)**
- [ ] Test with 1000+ concurrent requests
- [ ] Verify no orphaned index entries
- [ ] Benchmark lookup performance
- [ ] Test edge cases (request reopening, etc.)

---

### 11.5 Implementation Priority and Dependencies

```
                    ┌──────────────────┐
                    │ Phase 11: epoll  │
                    │  (5-7 days)      │
                    └────────┬─────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ 11.1 Thread Pool│ │ 11.2 Mem Pools  │ │ 11.3 Dict Rehash│
│   (10-12 days)  │ │   (7-9 days)    │ │   (5-6 days)    │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────▼────────┐
                    │11.4 HelpServ Idx│
                    │   (3 days)      │
                    └─────────────────┘
```

**Recommended Order:**
1. **Dict Rehash** (5-6 days) - Simplest, no external dependencies
2. **HelpServ Index** (3 days) - Simple, isolated to one module
3. **Memory Pools** (7-9 days) - Foundational for thread pool
4. **Thread Pool** (10-12 days) - Requires memory pools for efficiency
5. **Event Engine** (5-7 days) - Can be done in parallel

**Total Estimated Effort:** 30-40 days

---

### 11.6 Success Metrics

| Optimization | Metric | Before | Target |
|--------------|--------|--------|--------|
| Thread Pool | Password hash latency | 50-100ms blocking | <1ms (async) |
| Memory Pools | Allocations/sec | 10k malloc/s | 1M pool/s |
| Dict Rehash | Max rehash latency | 10-50ms | <1ms |
| HelpServ Index | Request lookup | O(n) | O(1) |

### 11.7 Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Thread safety bugs | Use TSAN, extensive testing, code review |
| Memory corruption | Debug magic numbers, valgrind, ASAN |
| Performance regression | Benchmark before/after, keep old code path |
| API breakage | Maintain compatibility wrappers |
