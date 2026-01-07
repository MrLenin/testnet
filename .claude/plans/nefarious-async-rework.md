# Nefarious IRCd Async Rework Plan

## Executive Summary

Nefarious already has a well-architected event-driven I/O system using epoll/kqueue. The main blocking bottleneck is **CPU-bound password hashing** (bcrypt/PBKDF2) during SASL authentication, which blocks the event loop for 50-200ms per auth attempt.

## Current Architecture Assessment

### What's Already Async (No Changes Needed)

| Component | Location | Status |
|-----------|----------|--------|
| DNS Resolution | `ircd_res.c` | Fully async UDP-based |
| Network I/O | `s_bsd.c`, `engine_epoll.c` | Non-blocking sockets |
| SSL/TLS | `ssl.c` | Event-driven with retry |
| Timer System | `ircd_events.c` | Callback-based |
| IAuth Communication | `s_auth.c` | Event-driven after fork |
| GeoIP Lookups | `ircd_geoip.c` | Memory-mapped, <1ms |
| LMDB Operations | `history.c`, `metadata.c` | MVCC reads, minimal blocking |

### Blocking Operations Requiring Attention

| Operation | Location | Blocking Time | Frequency | Priority |
|-----------|----------|---------------|-----------|----------|
| bcrypt() | `ircd_crypt_bcrypt.c:145` | 50-100ms | Per OPER/SASL | **CRITICAL** |
| PBKDF2 | `ircd_crypt_pbkdf2.c:345` | 10-50ms | Per SASL | **CRITICAL** |
| Config Rehash | `s_conf.c` | 100ms-1s | Admin command | LOW |
| Log file write() | `ircd_log.c` | <10ms | Per event | LOW |
| Startup I/O | Various | Variable | Once | ACCEPTABLE |

---

## Implementation Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 - Thread pool infrastructure | ✅ Complete | `thread_pool.c/h`, 4 workers with self-pipe signaling |
| 2 - Async password verification | ✅ Complete | `ircd_crypt_async.c`, callback-based API |
| 3 - SASL integration | ✅ N/A | SASL delegates to services |
| 3b - IAUTH investigation | ✅ Complete | IAUTH uses plaintext strcmp, not bcrypt |
| 4 - OPER authentication | ✅ Complete | `m_oper.c` async with FLAG_OPER_PENDING |
| 5 - Async logging (optional) | ✅ Complete | Dedicated writer thread, ring buffer |
| Config - THREAD_POOL_SIZE | ✅ Complete | Feature added to ircd_features |
| Config - ASYNC_LOGGING | ✅ Complete | Boolean feature flag (disabled by default) |

### Implementation Details

**Phase 1 files created:**
- `include/thread_pool.h` - Thread pool API with stub macros for non-pthread builds
- `ircd/thread_pool.c` - Full implementation with HAVE_PTHREAD guard
- Updated all event engines: `engine_epoll.c`, `engine_kqueue.c`, `engine_poll.c`, `engine_select.c`, `engine_devpoll.c`
- Updated `ircd.c` for init/shutdown
- Updated `configure.in` for pthread detection
- Updated `Makefile.in` to build thread_pool.c

**Phase 2 files:**
- `ircd/ircd_crypt_async.c` - Async verification wrapper
- `include/ircd_crypt.h` - Added async API declarations

**Phase 4 changes:**
- `include/client.h` - Added FLAG_OPER_PENDING and accessors
- `ircd/m_oper.c` - Async OPER with callback, falls back to sync if pool unavailable

---

## Phase 3b: IAUTH and Remaining Password Paths Investigation

### Overview

This section provides a comprehensive analysis of IAUTH and all remaining password verification paths in Nefarious IRCd that could potentially block the event loop.

### IAUTH Architecture

#### What is IAUTH?

IAUTH (IRC Authentication) is an external authentication daemon that communicates with the IRCd via IPC (Inter-Process Communication). It's designed to offload authentication decisions to an external process, enabling:
- External authentication backends (LDAP, databases, etc.)
- Custom policy decisions during client registration
- SASL authentication delegation

#### Communication Model

```
┌──────────────┐    socketpair()    ┌──────────────┐
│   Nefarious  │◄──────────────────►│    IAuth     │
│    IRCd      │   async messages   │   Daemon     │
└──────────────┘                    └──────────────┘
```

**Key files:**
- `ircd/s_auth.c` - IAUTH protocol handling and client registration
- `include/s_auth.h` - IAUTH API declarations

**IAuth Protocol Commands (IRCd → IAuth):**
| Command | Format | Purpose |
|---------|--------|---------|
| `C` | `C <ip> <port> <localip> <localport>` | New client connection |
| `N` | `N <hostname>` | DNS resolution complete |
| `d` | `d` | DNS lookup done marker |
| `P` | `P :<password>` | Client PASS command |
| `U` | `U <user> <host> <server> :<realname>` | Client USER command |
| `n` | `n <nick>` | Client NICK command |
| `W` | `W <pass> <user> <host> <ip> [:<opts>]` | WEBIRC request |
| `w` | `w <pass> <user> <host> <ip> [:<opts>]` | Trusted WEBIRC request |
| `A S` | `A S <mech> [:<certfp>]` | SASL start |
| `A H` | `A H :<user@host:ip>` | SASL host info |
| `a` | `a :<data>` | SASL data continuation |
| `D` | `D` | Client disconnected |
| `H` | `H <class>` | Registration "hurry up" |
| `R` | `R <account>` | Account assignment (from SASL/LOC) |

**IAuth Protocol Responses (IAuth → IRCd):**
| Response | Purpose |
|----------|---------|
| `D` | Done - allow client |
| `R` | Reject - kill client |
| `k` | Soft reject - kill with reason |
| `O` | Change policy options |
| `U` | Force username |
| `o` | Set operator flags |
| `N` | Force hostname |
| `I` | Force IP |
| `M` | Add client mark |
| `C` | Challenge user (for PASS response) |
| `A D` | SASL done (success) |
| `A F` | SASL failed |
| `A C` | SASL continue (more data needed) |
| `A M` | SASL mechanisms list |

#### IAUTH Features/Flags

The `sendto_iauth()` function checks various `IAUTH_*` flags before sending messages:
- `IAUTH_ADDLINFO` - Send additional info (password via `P` command)
- `IAUTH_WEBIRC` - Handle WEBIRC via IAuth
- `IAUTH_SASL` - Handle SASL via IAuth
- `IAUTH_ACCOUNT` - Receive account assignments
- `IAUTH_REQUIRED` - IAuth must approve all clients
- `IAUTH_UNDERNET` - Undernet-specific extensions

---

### Password Verification Path Analysis

#### Path 1: I-line Connection Passwords (CONFIRMED NON-BLOCKING)

**Location:** `s_auth.c:558-565`

```c
if (aconf
    && !EmptyString(aconf->passwd)
    && strcmp(cli_passwd(auth->client), aconf->passwd))
{
  ServerStats->is_ref++;
  send_reply(auth->client, ERR_PASSWDMISMATCH);
  return exit_client(auth->client, auth->client, &me, "Bad Password");
}
```

**Analysis:**
- Uses **plaintext `strcmp()`**, NOT cryptographic hashing
- Executes instantly (<1 microsecond)
- Password is stored in plaintext in the I-line config
- **NO ASYNC CONVERSION NEEDED** - already non-blocking

**When called:** During `check_auth_finished()`, after DNS/ident lookups complete, before registration.

---

#### Path 2: WEBIRC Password Verification (POTENTIALLY BLOCKING)

**Location:** `s_conf.c:872` in `find_webirc_conf()`

```c
crypted = ircd_crypt(passwd, wconf->passwd);

if (!crypted)
  continue;

res = strcmp(crypted, wconf->passwd);
MyFree(crypted);

if (0 == res) {
  *status = 0;
  return wconf;
}
```

**Call chain:**
```
m_webirc() [m_webirc.c:158]
  └─► find_webirc_conf() [s_conf.c:845-887]
        └─► ircd_crypt() [s_conf.c:872]
```

**Analysis:**
- Uses `ircd_crypt()` which supports bcrypt/PBKDF2
- **BLOCKING if bcrypt is used** (50-100ms per hash)
- Called during pre-registration when client sends WEBIRC command
- Client state: `AR_IAUTH_PENDING` may or may not be set

**Typical usage:**
- WebSocket/CGI:IRC gateways authenticate with WEBIRC
- High-volume deployments may see many WEBIRC requests
- Passwords are often simple shared secrets (not bcrypt)

**IAUTH interaction:**
- If `IAUTH_WEBIRC` is set, the password is **forwarded to IAuth** via `auth_set_webirc()`:
  ```c
  ares = auth_set_webirc(cli_auth(cptr), password, username, hostname, ipaddr, options);
  if (!ares)
    return 0;  /* IAuth handles it - no local password check */
  ```
- If IAuth handles WEBIRC, the local `find_webirc_conf()` password check is **bypassed**
- Only if IAuth doesn't handle it (`ares == -1`) does local verification occur

**Blocking impact:**
| Password Type | Blocking Time | Impact |
|---------------|---------------|--------|
| None (`""`) | 0 | No blocking |
| Plaintext/DES | <1ms | Negligible |
| bcrypt cost=10 | ~100ms | **Blocks event loop** |
| bcrypt cost=12 | ~400ms | **Severe blocking** |
| PBKDF2 100k iterations | ~50ms | **Blocks event loop** |

---

#### Path 3: SpoofHost Password Verification (POTENTIALLY BLOCKING)

**Location:** `s_conf.c:965` in `find_shost_conf()`

```c
if (!EmptyString(passwd) && !EmptyString(sconf->passwd)) {
  crypted = ircd_crypt(passwd, sconf->passwd);
  if (!crypted)
    continue;

  res = strcmp(crypted, sconf->passwd);
  MyFree(crypted);
}
```

**Call chains:**
```
m_sethost() [m_sethost.c:129] - user command
  └─► find_shost_conf() [s_conf.c:922-980]
        └─► ircd_crypt() [s_conf.c:965]

mo_sethost() [m_sethost.c:192] - oper command (no password check if PRIV_FREEFORM)
  └─► find_shost_conf() [s_conf.c:922-980]

register_user() → s_user.c:428 - auto-apply spoofhost (NULL password)
  └─► find_shost_conf(sptr, NULL, NULL, &res)
        └─► No ircd_crypt() call (password is NULL)
```

**Analysis:**
- Uses `ircd_crypt()` which supports bcrypt/PBKDF2
- **BLOCKING if bcrypt is used** (50-100ms per hash)
- Called when:
  1. User sends `SETHOST <host> <password>` command (m_sethost.c:129)
  2. Oper sends `SETHOST` without PRIV_FREEFORM (m_sethost.c:192)
  3. Auto-apply spoofhost during registration (s_user.c:428) - **NO PASSWORD CHECK**

**Blocking impact:** Same as WEBIRC path

**Client state during call:**
- For `m_sethost()`: Client is fully registered (post-registration command)
- For auto-apply: During `register_user()`, client is transitioning to registered state

---

#### Path 4: DIE/RESTART Password Verification (LOW PRIORITY)

**Locations:**
- `m_die.c:115`: `oper_password_match(password, diepass)`
- `m_restart.c:110`: `oper_password_match(password, restartpass)`

```c
// m_die.c:113-117
if (!EmptyString(diepass)) {
  password = parc > 1 ? parv[1] : 0;
  if (!oper_password_match(password, diepass))
    return send_reply(sptr, ERR_PASSWDMISMATCH);
}
```

**Analysis:**
- Uses `oper_password_match()` which calls `ircd_crypt()`
- **BLOCKING if bcrypt is used**
- Called only by IRC operators with `PRIV_DIE`/`PRIV_RESTART`
- Extremely rare operations (server maintenance only)

**Recommendation:** **NO ASYNC CONVERSION NEEDED**
- These are intentionally disruptive operations
- Called at most a few times per year
- 100ms blocking during DIE is irrelevant - server is shutting down

---

### Async Conversion Recommendations

#### Priority Matrix

| Path | Blocking Risk | Frequency | Async Benefit | Priority |
|------|---------------|-----------|---------------|----------|
| I-line passwords | None (plaintext) | Every client | N/A | ❌ None |
| WEBIRC | High (if bcrypt) | WebSocket gateways | High | ⚠️ Medium |
| SpoofHost | High (if bcrypt) | User command | Medium | ⚠️ Medium |
| DIE/RESTART | High (if bcrypt) | Rare admin | None | ❌ None |

#### Recommendation 1: WEBIRC Async Conversion

**Should implement if:**
- Network uses WebSocket gateways with high volume
- WEBIRC passwords use bcrypt/PBKDF2
- IAuth is NOT handling WEBIRC

**Implementation approach:**
```c
/* m_webirc.c - async WEBIRC verification */

struct webirc_verify_ctx {
  int fd;                    /* Client fd for lookup */
  char password[PASSWDLEN];  /* Copy of password */
  char username[USERLEN+1];  /* Copy of username */
  char hostname[HOSTLEN+1];  /* Copy of hostname */
  char ipaddr[SOCKIPLEN+1];  /* Copy of IP */
  char options[256];         /* Copy of options */
};

static void webirc_verified(int result, void *arg);

int m_webirc(...) {
  /* ... existing validation ... */

  /* Check if IAuth handles WEBIRC first */
  if (cli_auth(cptr) && IAuthHas(iauth, IAUTH_WEBIRC)) {
    ares = auth_set_webirc(cli_auth(cptr), password, ...);
    if (!ares)
      return 0;  /* IAuth handles it */
  }

  /* Try async verification */
  if (ircd_crypt_async_available()) {
    struct webirc_verify_ctx *ctx = MyMalloc(sizeof(*ctx));
    /* ... copy parameters ... */

    /* Find matching WebIRC block (without password check) */
    wconf = find_webirc_conf_by_host(cptr);
    if (wconf && !EmptyString(wconf->passwd)) {
      if (ircd_crypt_verify_async(password, wconf->passwd,
                                   webirc_verified, ctx) == 0) {
        SetWebIRCPending(cptr);
        return 0;  /* Async started */
      }
    }
    MyFree(ctx);
  }

  /* Fall back to sync */
  wline = find_webirc_conf(cptr, password, &res);
  /* ... existing handling ... */
}
```

**Complexity: MEDIUM**
- Need to add `FLAG_WEBIRC_PENDING` flag to client
- Need to split `find_webirc_conf()` into host-match and password-verify phases
- Need callback to complete WEBIRC IP/host rewrite
- Must handle client disconnect during async verification

#### Recommendation 2: SpoofHost Async Conversion

**Should implement if:**
- SpoofHost passwords use bcrypt/PBKDF2
- Users frequently use SETHOST command

**Implementation approach:**
```c
/* m_sethost.c - async SETHOST verification */

struct sethost_verify_ctx {
  int fd;
  char hostmask[USERLEN + HOSTLEN + 2];
  struct SHostConf *sconf;  /* Matched config block */
};

static void sethost_verified(int result, void *arg);

int m_sethost(...) {
  /* ... existing validation ... */

  /* Find matching SHost block first */
  sconf = find_shost_conf_by_host(sptr, parv[1]);
  if (!sconf) {
    return send_reply(sptr, ERR_HOSTUNAVAIL, parv[1]);
  }

  /* If password required, try async */
  if (!EmptyString(sconf->passwd) && ircd_crypt_async_available()) {
    struct sethost_verify_ctx *ctx = MyMalloc(sizeof(*ctx));
    /* ... copy parameters ... */
    ctx->sconf = sconf;

    if (ircd_crypt_verify_async(parv[2], sconf->passwd,
                                 sethost_verified, ctx) == 0) {
      SetSetHostPending(sptr);
      sendcmdto_one(&me, CMD_NOTICE, sptr,
                    "%C :Verifying sethost password...", sptr);
      return 0;
    }
    MyFree(ctx);
  }

  /* Fall back to sync */
  /* ... existing code ... */
}
```

**Complexity: MEDIUM**
- Need to add `FLAG_SETHOST_PENDING` flag to client
- Simpler than WEBIRC since client is already registered
- Must handle client disconnect during async verification

---

### Implementation Plan for WEBIRC/SpoofHost Async

#### Phase 6a: WEBIRC Async (Optional)

**Prerequisites:**
- Thread pool infrastructure (Phase 1) ✅
- Async crypt API (Phase 2) ✅

**New files:**
- None (modify existing)

**Modified files:**
- `include/client.h` - Add `FLAG_WEBIRC_PENDING`
- `ircd/m_webirc.c` - Async verification with callback
- `ircd/s_conf.c` - Add `find_webirc_conf_by_host()` helper

**Estimated effort:** 4-6 hours

#### Phase 6b: SpoofHost Async (Optional)

**Prerequisites:**
- Thread pool infrastructure (Phase 1) ✅
- Async crypt API (Phase 2) ✅

**New files:**
- None (modify existing)

**Modified files:**
- `include/client.h` - Add `FLAG_SETHOST_PENDING`
- `ircd/m_sethost.c` - Async verification with callback
- `ircd/s_conf.c` - Add `find_shost_conf_by_host()` helper

**Estimated effort:** 3-4 hours

---

### Decision Matrix: When to Implement WEBIRC/SpoofHost Async

| Condition | Recommendation |
|-----------|----------------|
| WEBIRC passwords are plaintext/DES | ❌ No async needed |
| WEBIRC passwords use bcrypt | ✅ Implement async |
| IAuth handles WEBIRC | ❌ No async needed (already delegated) |
| High WebSocket traffic | ✅ Implement async |
| SpoofHost rarely used | ❌ No async needed |
| SpoofHost with bcrypt passwords | ⚠️ Consider async |

---

### Conclusion

The IAUTH investigation reveals that:

1. **I-line passwords** use plaintext `strcmp()` - no async needed
2. **IAUTH delegation** already provides async authentication for SASL and optionally WEBIRC
3. **WEBIRC and SpoofHost** are the only remaining paths that call `ircd_crypt()` and could block
4. **DIE/RESTART** are rare admin operations not worth making async

**Current recommendation:** The existing async implementation (OPER authentication) covers the most critical path. WEBIRC/SpoofHost async conversion should be implemented only if:
- The network uses bcrypt/PBKDF2 for these passwords
- Performance issues are observed during WebSocket gateway connections
- IAuth is not being used to handle WEBIRC

---

## IAUTH Code Quality Audit

Beyond async concerns, a comprehensive audit of the IAUTH implementation reveals several areas for improvement.

### Buffer Safety Issues

#### Issue 1: Unsafe `strcpy()` Usage (LOW)

**Location:** `s_auth.c:1134`
```c
strcpy(cli_sockhost(auth->client), cli_name(&me));
```

**Analysis:**
- Uses `strcpy()` without explicit length check
- Both `cli_sockhost` and server names are bounded by HOSTLEN (63+1)
- **Risk:** Low - sizes match, but bad practice

**Recommendation:** Replace with `ircd_strncpy()` for consistency:
```c
ircd_strncpy(cli_sockhost(auth->client), cli_name(&me), HOSTLEN + 1);
```

---

#### Issue 2: Partial Line Buffer Truncation (MEDIUM)

**Location:** `s_auth.c:2751-2754`
```c
iauth->i_count = strlen(sol);
if (iauth->i_count > BUFSIZE)
  iauth->i_count = BUFSIZE;
memcpy(iauth->i_buffer, sol, iauth->i_count);
```

**Analysis:**
- If IAuth sends a line > BUFSIZE (512) chars without newline, data is silently truncated
- Could cause protocol parsing errors or lost messages
- `i_buffer` is BUFSIZE+1, so one-off errors possible

**Recommendation:** Log when truncation occurs for debugging:
```c
iauth->i_count = strlen(sol);
if (iauth->i_count > BUFSIZE) {
  log_write(LS_IAUTH, L_WARNING, 0,
            "IAuth line truncated: %u > %u bytes", iauth->i_count, BUFSIZE);
  iauth->i_count = BUFSIZE;
}
```

---

### Memory Management Issues

#### Issue 3: Memory Leak in `auth_close_unused()` (MEDIUM)

**Location:** `s_auth.c:1730-1743`

**Analysis:**
The function frees `i_argv` but does NOT free:
- `iauth->i_version` - allocated by `DupString()` in `iauth_cmd_version()`
- `iauth->i_config` - linked list allocated by `iauth_cmd_config()`
- `iauth->i_stats` - linked list allocated by `iauth_cmd_stats()`

**Recommendation:** Add cleanup before `MyFree(iauth)`:
```c
void auth_close_unused(void)
{
  if (IAuthHas(iauth, IAUTH_CLOSING)) {
    int ii;
    struct SLink *node, *next;

    iauth_disconnect(iauth);

    /* Free version string */
    MyFree(iauth->i_version);

    /* Free config list */
    for (node = iauth->i_config; node; node = next) {
      next = node->next;
      MyFree(node->value.cp);
      free_link(node);
    }

    /* Free stats list */
    for (node = iauth->i_stats; node; node = next) {
      next = node->next;
      MyFree(node->value.cp);
      free_link(node);
    }

    /* Free argv */
    if (iauth->i_argv) {
      for (ii = 0; iauth->i_argv[ii]; ++ii)
        MyFree(iauth->i_argv[ii]);
      MyFree(iauth->i_argv);
    }
    MyFree(iauth);
  }
}
```

---

#### Issue 4: Unbounded Config/Stats List Growth (LOW)

**Location:** `s_auth.c:1979-1992`, `2026-2038`

**Analysis:**
- `iauth_cmd_config()` and `iauth_cmd_stats()` append to linked lists without limit
- Malicious or buggy IAuth could grow lists indefinitely
- No cleanup until IAuth restarts

**Recommendation:** Add configurable limit (e.g., 1000 entries):
```c
#define IAUTH_MAX_CONFIG_ENTRIES 1000

static int iauth_cmd_config(struct IAuth *iauth, struct Client *cli,
                            int parc, char **params)
{
  struct SLink *node;
  int count = 0;

  /* Count existing entries */
  for (node = iauth->i_config; node; node = node->next)
    if (++count >= IAUTH_MAX_CONFIG_ENTRIES) {
      sendto_opmask_butone(NULL, SNO_AUTH,
                           "IAuth config limit reached (%d)", count);
      return 0;
    }
  /* ... rest of function ... */
}
```

---

### Performance Issues

#### Issue 5: O(n) Linked List Append (LOW)

**Location:** `s_auth.c:1984-1986`, `2030-2032`

```c
for (node = iauth->i_config; node->next; node = node->next) ;
node = node->next = make_link();
```

**Analysis:**
- Traverses entire list to find end on each append
- O(n²) for building list with n entries
- Unlikely to be significant in practice (small lists)

**Recommendation:** Add tail pointer for O(1) append:
```c
struct IAuth {
  /* ... existing fields ... */
  struct SLink *i_config;
  struct SLink *i_config_tail;  /* NEW: tail pointer */
  struct SLink *i_stats;
  struct SLink *i_stats_tail;   /* NEW: tail pointer */
};
```

---

#### Issue 6: Per-Message MsgBuf Allocation (LOW)

**Location:** `s_auth.c:1782-1810` (`sendto_iauth`)

**Analysis:**
- Each message to IAuth allocates a `MsgBuf`
- High allocation rate during busy periods
- `msgq` system handles pooling, so impact is minimal

**Recommendation:** Consider batching messages during burst periods, but likely not worth the complexity.

---

### Protocol Robustness Issues

#### Issue 7: Integer Parsing Without Overflow Check (LOW)

**Location:** `s_auth.c:2680`, `2698`
```c
id = strtol(params[0], NULL, 10);
addr.port = strtol(params[2], NULL, 10);
```

**Analysis:**
- No check for `ERANGE` or invalid input
- Negative IDs handled by bounds check on line 2683
- Port overflow would be caught by mismatch check

**Recommendation:** Add explicit validation for production hardening:
```c
char *endptr;
errno = 0;
id = strtol(params[0], &endptr, 10);
if (errno == ERANGE || endptr == params[0] || *endptr != '\0') {
  sendto_iauth(NULL, "E Invalid :Bad client ID [%s]", params[0]);
  return;
}
```

---

### Error Handling Issues

#### Issue 8: Client Limbo During IAuth Restart (MEDIUM)

**Location:** `s_auth.c:1494-1506` (`iauth_do_spawn`)

**Analysis:**
- If IAuth crashes, there's a 5-second anti-rapid-restart check
- Clients with `AR_IAUTH_PENDING` remain pending during restart
- With `IAUTH_REQUIRED`, these clients eventually timeout

**Current behavior:**
1. IAuth crashes → `ET_EOF` triggers `iauth_disconnect()`
2. `ET_DESTROY` triggers `iauth_do_spawn()` if not closing
3. 5-second check: if crash < 5s ago, IAuth stays dead
4. Pending clients eventually hit `auth_ping_timeout()`

**Recommendation:** Consider adding:
1. Notification to opers when IAuth dies with pending clients
2. Option to immediately release pending clients on IAuth death
3. Configurable retry interval (currently hardcoded 5s)

```c
/* In iauth_disconnect() */
if (FlagHas(&auth->flags, AR_IAUTH_PENDING)) {
  unsigned int pending_count = 0;
  struct AuthRequest *auth;
  /* Count and optionally release pending clients */
  for (auth = ...; auth; auth = auth->next) {
    if (FlagHas(&auth->flags, AR_IAUTH_PENDING))
      pending_count++;
  }
  if (pending_count > 0)
    sendto_opmask_butone(NULL, SNO_AUTH,
                         "IAuth died with %u clients pending", pending_count);
}
```

---

### Security Considerations

#### Issue 9: Complete Trust in IAuth Process (INFORMATIONAL)

**Analysis:**
IAuth has full authority to:
- Force any username on any client (`o`/`U` commands)
- Force any hostname on any client (`N` command)
- Force any IP address on any client (`I` command)
- Set oper flags on any client (`M` command)
- Kill any client (`K`/`k` commands)
- Set user accounts (`R` command)

**Mitigation:** IAuth is spawned as a child process from a configured path in ircd.conf. The trust model assumes the admin controls the IAuth binary.

**Recommendation:** Document the trust model clearly. Consider adding:
1. Optional logging of all IAuth-forced changes
2. Rate limiting on IP/host changes per client
3. Optional whitelist of allowed hostnames/IPs

---

#### Issue 10: IAUTH_REQUIRED DoS Risk (INFORMATIONAL)

**Analysis:**
- With `IAUTH_REQUIRED` enabled, all clients must be approved by IAuth
- If IAuth hangs (not crashes), clients queue indefinitely
- No circuit breaker to disable requirement if IAuth becomes unresponsive

**Recommendation:** Add health check and auto-disable:
```c
/* In auth_ping_timeout() or periodic timer */
if (IAuthHas(iauth, IAUTH_REQUIRED)) {
  unsigned int pending = count_iauth_pending();
  if (pending > IAUTH_PENDING_THRESHOLD) {
    sendto_opmask_butone(NULL, SNO_AUTH,
        "IAuth has %u pending clients, disabling REQUIRED mode", pending);
    IAuthClr(iauth, IAUTH_REQUIRED);
  }
}
```

---

### Summary of Recommendations

| Issue | Severity | Effort | Priority | Status |
|-------|----------|--------|----------|--------|
| #1 strcpy → strncpy | Low | 5 min | ⚪ Low | ✅ Complete |
| #2 Log buffer truncation | Medium | 10 min | 🟡 Medium | ✅ Complete |
| #3 Memory leak in close | Medium | 30 min | 🟡 Medium | ✅ Complete |
| #4 Config list limit | Low | 20 min | ⚪ Low | ✅ Complete |
| #5 O(n) list append | Low | 30 min | ⚪ Low | ✅ Complete |
| #6 MsgBuf allocation | Low | N/A | ⚪ Skip | ⏭️ Skipped |
| #7 Integer validation | Low | 15 min | ⚪ Low | ✅ Complete |
| #8 Client limbo handling | Medium | 1 hour | 🟡 Medium | ✅ Complete |
| #9 IAuth change logging | Info | 30 min | ⚪ Low | ✅ Complete |
| #10 REQUIRED DoS protection | Info | 1 hour | 🟡 Medium | ✅ Complete |

### Implementation Summary

All IAUTH code quality fixes have been implemented in `ircd/s_auth.c`:

**Security Fixes:**
- #1: Replaced `strcpy()` with `ircd_strncpy()` for hostname copy
- #7: Added proper `strtol()` validation with errno/endptr checks for client ID and port parsing
- #9: Added audit logging for IAuth hostname/IP/username changes

**Memory & Resource Fixes:**
- #3: Fixed memory leak in `auth_close_unused()` - now frees i_version, i_config, i_stats lists
- #4: Added IAUTH_LIST_MAX (1000) limit to prevent unbounded config/stats list growth
- #5: Added tail pointers to IAuth struct for O(1) list append instead of O(n)

**Reliability Fixes:**
- #2: Added log warnings when IAuth line buffers are truncated
- #8: Added client release logic to `iauth_disconnect()` - pending clients no longer stuck in limbo
- #10: Implemented circuit breaker pattern with threshold of 10 consecutive timeouts before bypassing IAUTH_REQUIRED

**New struct members added to `struct IAuth`:**
- `i_config_tail`, `i_stats_tail` - tail pointers for O(1) append
- `i_config_count`, `i_stats_count` - list size counters
- `i_timeout_count` - consecutive timeout counter for circuit breaker
- `i_circuit_open` - circuit breaker state flag

**New constants:**
- `IAUTH_LIST_MAX` (1000) - max config/stats entries
- `IAUTH_CIRCUIT_BREAKER_THRESHOLD` (10) - timeouts before bypass

---

## Phase 1: Thread Pool Infrastructure

### Goal
Add a lightweight thread pool for CPU-bound operations that cannot be made event-driven.

### Design

```c
/* ircd/thread_pool.h */

#define THREAD_POOL_SIZE 4  /* Worker threads for CPU-bound tasks */

typedef void (*thread_task_callback)(void *result, void *ctx);

struct thread_task {
    void *(*work_func)(void *arg);  /* Function to run in thread */
    void *work_arg;                  /* Argument to work function */
    thread_task_callback callback;   /* Called in main thread when done */
    void *callback_ctx;              /* Context for callback */
    void *result;                    /* Result from work_func */
    struct thread_task *next;        /* Queue linkage */
};

/* API */
int thread_pool_init(void);
void thread_pool_shutdown(void);
int thread_pool_submit(void *(*work)(void *), void *arg,
                       thread_task_callback callback, void *ctx);
void thread_pool_poll(void);  /* Called from event loop */
```

### Implementation Details

**File**: `ircd/thread_pool.c`

1. **Worker Threads**: 4 pthread workers (configurable)
2. **Task Queue**: Mutex-protected linked list of pending tasks
3. **Result Pipe**: Self-pipe trick to signal main thread
4. **Completion Queue**: Results waiting for main-thread callback
5. **Integration**: `thread_pool_poll()` called after `epoll_wait()`

```c
/* Worker thread main loop */
static void *worker_thread(void *arg) {
    struct thread_pool *pool = arg;

    while (pool->running) {
        pthread_mutex_lock(&pool->queue_mutex);
        while (!pool->task_queue && pool->running)
            pthread_cond_wait(&pool->queue_cond, &pool->queue_mutex);

        struct thread_task *task = pool->task_queue;
        if (task)
            pool->task_queue = task->next;
        pthread_mutex_unlock(&pool->queue_mutex);

        if (task) {
            task->result = task->work_func(task->work_arg);

            /* Move to completion queue and signal main thread */
            pthread_mutex_lock(&pool->done_mutex);
            task->next = pool->done_queue;
            pool->done_queue = task;
            pthread_mutex_unlock(&pool->done_mutex);

            /* Wake main thread via pipe */
            char c = 1;
            write(pool->signal_pipe[1], &c, 1);
        }
    }
    return NULL;
}

/* Called from main event loop */
void thread_pool_poll(void) {
    char buf[64];
    struct thread_task *task;

    /* Drain signal pipe */
    while (read(pool.signal_pipe[0], buf, sizeof(buf)) > 0)
        ;

    /* Process completed tasks */
    pthread_mutex_lock(&pool.done_mutex);
    while ((task = pool.done_queue)) {
        pool.done_queue = task->next;
        pthread_mutex_unlock(&pool.done_mutex);

        /* Invoke callback in main thread context */
        if (task->callback)
            task->callback(task->result, task->callback_ctx);

        free(task);
        pthread_mutex_lock(&pool.done_mutex);
    }
    pthread_mutex_unlock(&pool.done_mutex);
}
```

### Integration Points

**engine_epoll.c** (after line 340):
```c
/* After processing epoll events and timers */
timer_run();
thread_pool_poll();  /* NEW: Process completed async tasks */
```

**ircd.c** (startup):
```c
thread_pool_init();  /* After event_init() */
```

**ircd.c** (shutdown):
```c
thread_pool_shutdown();  /* Before event cleanup */
```

---

## Phase 2: Async Password Verification

### Goal
Move bcrypt and PBKDF2 password verification off the main thread.

### New API

```c
/* ircd/ircd_crypt.h additions */

typedef void (*crypt_verify_callback)(int result, void *ctx);

/* Async password verification - returns immediately, calls callback when done */
int ircd_crypt_verify_async(const char *password, const char *hash,
                            crypt_verify_callback callback, void *ctx);

/* Result codes for callback */
#define CRYPT_VERIFY_MATCH     1   /* Password matches */
#define CRYPT_VERIFY_NOMATCH   0   /* Password doesn't match */
#define CRYPT_VERIFY_ERROR    -1   /* Error during verification */
```

### Implementation

**File**: `ircd/ircd_crypt_async.c`

```c
struct crypt_verify_ctx {
    char *password;
    char *hash;
    crypt_verify_callback callback;
    void *user_ctx;
};

/* Work function - runs in thread pool */
static void *crypt_verify_work(void *arg) {
    struct crypt_verify_ctx *ctx = arg;
    int *result = malloc(sizeof(int));

    /* This is the slow part - now off main thread */
    const char *computed = ircd_crypt(ctx->password, ctx->hash);
    *result = (computed && strcmp(computed, ctx->hash) == 0)
              ? CRYPT_VERIFY_MATCH : CRYPT_VERIFY_NOMATCH;

    return result;
}

/* Completion callback - runs in main thread */
static void crypt_verify_done(void *result, void *ctx) {
    struct crypt_verify_ctx *vctx = ctx;
    int *presult = result;

    /* Invoke user callback */
    vctx->callback(*presult, vctx->user_ctx);

    /* Cleanup */
    free(presult);
    MyFree(vctx->password);
    MyFree(vctx->hash);
    free(vctx);
}

int ircd_crypt_verify_async(const char *password, const char *hash,
                            crypt_verify_callback callback, void *ctx) {
    struct crypt_verify_ctx *vctx;

    vctx = malloc(sizeof(*vctx));
    if (!vctx)
        return -1;

    vctx->password = DupString(password);
    vctx->hash = DupString(hash);
    vctx->callback = callback;
    vctx->user_ctx = ctx;

    return thread_pool_submit(crypt_verify_work, vctx,
                              crypt_verify_done, vctx);
}
```

---

## Phase 3: SASL Integration

### Current SASL Flow (Blocking)

```
Client -> AUTHENTICATE PLAIN
Server -> Parse credentials
Server -> ircd_crypt() verify [BLOCKS 50-200ms]
Server -> SASL result
```

### New SASL Flow (Async)

```
Client -> AUTHENTICATE PLAIN
Server -> Parse credentials
Server -> ircd_crypt_verify_async() [Returns immediately]
Server -> [Continues event loop]
...
[Thread completes verification]
...
Server -> Callback invoked in main thread
Server -> SASL result
```

### Implementation

**File**: `ircd/m_authenticate.c` or SASL handler

```c
/* SASL verification context */
struct sasl_verify_ctx {
    struct Client *cptr;           /* Client being authenticated */
    char account[ACCOUNTLEN + 1];  /* Account name */
    /* Other SASL state... */
};

/* Callback when password verification completes */
static void sasl_password_verified(int result, void *ctx) {
    struct sasl_verify_ctx *sctx = ctx;
    struct Client *cptr = sctx->cptr;

    /* Check if client still connected */
    if (!cptr || IsDead(cptr)) {
        free(sctx);
        return;
    }

    if (result == CRYPT_VERIFY_MATCH) {
        /* Authentication successful */
        sasl_auth_success(cptr, sctx->account);
    } else {
        /* Authentication failed */
        sasl_auth_failure(cptr, "Bad credentials");
    }

    free(sctx);
}

/* Modified SASL PLAIN handler */
static int sasl_plain_authenticate(struct Client *cptr,
                                   const char *authzid,
                                   const char *authcid,
                                   const char *passwd) {
    struct sasl_verify_ctx *ctx;
    const char *stored_hash;

    /* Look up account and get stored hash */
    stored_hash = lookup_account_password(authcid);
    if (!stored_hash)
        return sasl_auth_failure(cptr, "Unknown account");

    /* Allocate verification context */
    ctx = malloc(sizeof(*ctx));
    ctx->cptr = cptr;
    ircd_strncpy(ctx->account, authcid, ACCOUNTLEN);

    /* Mark client as "awaiting auth" */
    SetAuthPending(cptr);

    /* Start async verification - returns immediately */
    if (ircd_crypt_verify_async(passwd, stored_hash,
                                 sasl_password_verified, ctx) < 0) {
        free(ctx);
        return sasl_auth_failure(cptr, "Internal error");
    }

    /* Return "in progress" - don't send result yet */
    return SASL_IN_PROGRESS;
}
```

### Client State Management

Need to track clients awaiting async auth:

```c
/* client.h additions */
#define FLAG_AUTH_PENDING  0x80000000  /* Awaiting async auth result */
#define SetAuthPending(x)  ((x)->flags |= FLAG_AUTH_PENDING)
#define ClearAuthPending(x) ((x)->flags &= ~FLAG_AUTH_PENDING)
#define IsAuthPending(x)   ((x)->flags & FLAG_AUTH_PENDING)
```

**Important**: When client disconnects while auth pending, the callback must check `IsDead(cptr)` before accessing client data.

---

## Phase 4: OPER Authentication

### Current OPER Flow (Blocking)

```
Client -> OPER username password
Server -> Find oper block
Server -> ircd_crypt() verify [BLOCKS 50-200ms]
Server -> OPER result
```

### New OPER Flow (Async)

Similar to SASL - use async verification with callback.

**File**: `ircd/m_oper.c`

```c
struct oper_verify_ctx {
    struct Client *sptr;
    struct ConfItem *aconf;  /* Oper block */
    char name[NICKLEN + 1];
};

static void oper_password_verified(int result, void *ctx) {
    struct oper_verify_ctx *octx = ctx;
    struct Client *sptr = octx->sptr;

    if (!sptr || IsDead(sptr)) {
        free(octx);
        return;
    }

    ClearAuthPending(sptr);

    if (result == CRYPT_VERIFY_MATCH) {
        /* Grant oper privileges */
        do_oper(sptr, octx->aconf);
    } else {
        send_reply(sptr, ERR_PASSWDMISMATCH);
        sendto_opmask(0, SNO_OLDREALOP, "Failed OPER attempt by %s",
                      cli_name(sptr));
    }

    free(octx);
}

/* Modified m_oper handler */
int m_oper(struct Client *cptr, struct Client *sptr, int parc, char *parv[]) {
    struct ConfItem *aconf;
    struct oper_verify_ctx *ctx;

    /* ... existing validation code ... */

    aconf = find_conf_exact(parv[1], cli_user(sptr)->username,
                            cli_sockhost(sptr), CONF_OPERATOR);
    if (!aconf)
        return send_reply(sptr, ERR_NOOPERHOST);

    /* Allocate context */
    ctx = malloc(sizeof(*ctx));
    ctx->sptr = sptr;
    ctx->aconf = aconf;
    ircd_strncpy(ctx->name, parv[1], NICKLEN);

    SetAuthPending(sptr);

    /* Start async verification */
    if (ircd_crypt_verify_async(parv[2], aconf->passwd,
                                 oper_password_verified, ctx) < 0) {
        ClearAuthPending(sptr);
        free(ctx);
        return send_reply(sptr, ERR_PASSWDMISMATCH);
    }

    return 0;  /* Result sent via callback */
}
```

---

## Phase 5: Async Logging (Optional)

### Goal
Move log file writes off main thread to prevent I/O blocking.

### Design

```c
/* Async log buffer */
struct log_entry {
    char *message;
    int level;
    struct log_entry *next;
};

static struct {
    struct log_entry *head;
    struct log_entry *tail;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    pthread_t thread;
    int running;
    int fd;
} async_log;

/* Log writer thread */
static void *log_writer_thread(void *arg) {
    while (async_log.running) {
        pthread_mutex_lock(&async_log.mutex);
        while (!async_log.head && async_log.running)
            pthread_cond_wait(&async_log.cond, &async_log.mutex);

        struct log_entry *entry = async_log.head;
        if (entry)
            async_log.head = entry->next;
        pthread_mutex_unlock(&async_log.mutex);

        if (entry) {
            write(async_log.fd, entry->message, strlen(entry->message));
            free(entry->message);
            free(entry);
        }
    }
    return NULL;
}
```

**Priority**: LOW - Current logging is fast enough for most deployments.

---

## Files to Create/Modify

### New Files
- `ircd/thread_pool.c` - Thread pool implementation
- `ircd/thread_pool.h` - Thread pool API
- `ircd/ircd_crypt_async.c` - Async password verification wrapper

### Modified Files
- `ircd/engine_epoll.c` - Add `thread_pool_poll()` call
- `ircd/engine_kqueue.c` - Add `thread_pool_poll()` call
- `ircd/engine_poll.c` - Add `thread_pool_poll()` call
- `ircd/ircd.c` - Thread pool init/shutdown
- `ircd/ircd_crypt.h` - Add async API declarations
- `ircd/m_oper.c` - Use async password verification
- `ircd/s_auth.c` or SASL handler - Use async password verification
- `ircd/client.h` - Add FLAG_AUTH_PENDING
- `ircd/Makefile.in` - Add new source files
- `configure.ac` - Add pthread detection

---

## Configuration Options

```c
/* features.def additions */
F_I(THREAD_POOL_SIZE, 0, 4)      /* Worker threads (0 = sync mode) */
```

**Fallback**: If `THREAD_POOL_SIZE` is 0, use synchronous password verification (legacy behavior).

---

## Testing Strategy

### Unit Tests
1. Thread pool submit/complete cycle
2. Password verification async wrapper
3. Callback invocation in main thread

### Integration Tests
1. Multiple simultaneous OPER attempts
2. Multiple simultaneous SASL auths
3. Client disconnect during pending auth
4. Thread pool shutdown with pending tasks

### Performance Tests
1. Measure event loop latency during auth load
2. Compare sync vs async SASL throughput
3. Stress test with 100+ concurrent auths

---

## Rollout Plan

1. **Feature flag**: `THREAD_POOL_SIZE` = 0 disables async (sync fallback)
2. **Gradual enablement**: Start with THREAD_POOL_SIZE=2
3. **Monitoring**: Log async task queue depth
4. **Rollback**: Set THREAD_POOL_SIZE=0 to revert

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Event loop latency during SASL | 50-200ms | <5ms |
| SASL throughput | ~5 auth/sec | 100+ auth/sec |
| OPER response time | 50-100ms | <5ms (async) |
| Event loop stalls | Frequent during auth | None |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Thread safety bugs | HIGH | Careful mutex usage, testing |
| Client disconnect during auth | MEDIUM | Check IsDead() in callbacks |
| Memory leaks in async paths | MEDIUM | RAII patterns, cleanup handlers |
| Deadlock | MEDIUM | Lock ordering, timeout on cond_wait |
| Performance regression | LOW | Sync fallback via feature flag |

---

## Dependencies

- **pthreads**: Required for thread pool
- **pipe()**: Self-pipe trick for thread→main signaling
- Existing: OpenSSL (for PBKDF2), bcrypt library

---

## Timeline Estimate

| Phase | Effort |
|-------|--------|
| Phase 1 - Thread pool | 1-2 days |
| Phase 2 - Async password | 1 day |
| Phase 3 - SASL integration | 1-2 days |
| Phase 4 - OPER integration | 1 day |
| Phase 5 - Async logging | Optional |
| Testing & debugging | 2-3 days |
| **Total** | **6-9 days** |
