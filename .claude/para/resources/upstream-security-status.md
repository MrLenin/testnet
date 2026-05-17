# Security Issues: Upstream vs Local Status

**Date:** 2026-01-19

This document compares security issues against the specified upstream commits:
- **Nefarious**: `ec573a681ea65fe3e464a3504b7d6018781233fa`
- **X3**: `9e93668b0ae721e548267b671ebc7de3808476ec`

---

## Summary

| Severity | Issue | Upstream Status | Notes |
|----------|-------|-----------------|-------|
| 🔴 Critical | m_sasl.c bounds check | **PRESENT** | No bounds check in either version |
| 🔴 Critical | LDAP injection (x3ldap.c) | **PRESENT** | No escaping in upstream |
| 🟠 High | Server auth timing (s_conf.c) | **PRESENT** | Both use strcmp |
| 🟠 High | SpamServ alloca() | **PRESENT** | Module disabled by default |
| 🟡 Medium | Cookie timing (nickserv.c) | **PRESENT** | Uses strcmp |
| 🟡 Medium | MD5 in x3ldap.c | **PRESENT** | Legacy code |
| 🟡 Medium | strcat chains (mod-track/snoop) | **PRESENT** | Bounds checking missing |
| 🟡 Medium | Password clearing (s_auth.c) | **PRESENT** | Uses memset |
| ✅ Fixed | Password timing (ircd_crypt.c) | **ALREADY FIXED** | Uses CRYPTO_memcmp |
| ✅ Fixed | PRNG salt (m_mkpasswd.c) | **ALREADY FIXED** | Uses ircrandom() |
| ✅ Fixed | SSL cipher overflow (ssl.c) | **ALREADY FIXED** | Uses ircd_snprintf |
| ✅ Fixed | WHO buffer overflow (m_who.c) | **ALREADY FIXED** | Has bounds check |
| ✅ Fixed | Signal handler race (ircd_signal.c) | **ALREADY FIXED** | Uses volatile sig_atomic_t |
| ✅ Fixed | X3 password timing (password.c) | N/A | File added after upstream commit |

---

## Detailed Analysis

### 🔴 CRITICAL - PRESENT AT UPSTREAM

#### 1. m_sasl.c Out-of-Bounds Array Access

**Location:** `ircd/m_sasl.c:166` (upstream), `ircd/m_sasl.c:182` (current)

**Upstream code:**
```c
fd = atoi(fdstr);
cookie = atoi(cookiestr);

if (!(acptr = LocalClientArray[fd]) || (cli_saslcookie(acptr) != cookie))
    return 0;
```

**Current code:** Identical logic, just with better logging. Still no bounds check.

**Status:** 🔴 **OPEN IN BOTH** - Needs fix before production

---

#### 2. LDAP Injection in X3

**Location:** `x3/src/x3ldap.c:149`

**Upstream code:**
```c
snprintf(filter, MAXLEN, "(&%s(%s=%s))", nickserv_conf.ldap_filter,
         nickserv_conf.ldap_field_account, account);
```

**Status:** 🔴 **OPEN IN BOTH** - No escaping of user input

---

### 🟠 HIGH - PRESENT AT UPSTREAM

#### 3. Server Authentication Timing Attacks

**Location:** `ircd/s_conf.c`, `ircd/m_server.c`

Server password comparisons use `strcmp()` instead of constant-time comparison.

**Status:** 🟠 **OPEN IN BOTH**

---

#### 4. SpamServ alloca() Stack Overflow

**Location:** `x3/src/spamserv.c:1051`

Uses `alloca()` with user-influenced size.

**Status:** 🟠 **OPEN IN BOTH** (but module is disabled)

---

### 🟡 MEDIUM - PRESENT AT UPSTREAM

#### 5. Cookie Timing Attack (nickserv.c)

**Location:** `x3/src/nickserv.c:2828` (upstream line numbering)

```c
if (strcmp(cookie, hi->cookie->cookie)) {
```

**Status:** 🟡 **OPEN IN BOTH** - CRYPTO_memcmp not used

---

#### 6. MD5 for LDAP Passwords

**Location:** `x3/src/x3ldap.c:287-291`

**Status:** 🟡 **OPEN IN BOTH** - MD5 is cryptographically broken

---

#### 7. strcat Chains (mod-track.c, mod-snoop.c)

**Location:** `x3/src/mod-track.c:333-416`, `x3/src/mod-snoop.c:175-271`

**Status:** 🟡 **OPEN IN BOTH**

---

#### 8. Password Memory Clearing (s_auth.c)

**Location:** `ircd/s_auth.c:654`

Uses `memset()` which may be optimized away.

**Status:** 🟡 **OPEN IN BOTH**

---

### ✅ ALREADY FIXED AT UPSTREAM

These issues were already fixed at the specified upstream commits:

| Issue | File | Evidence |
|-------|------|----------|
| Password timing | ircd/ircd_crypt.c:293 | Uses `CRYPTO_memcmp()` |
| Weak PRNG salt | ircd/m_mkpasswd.c:51-52 | Uses `ircrandom()` |
| SSL cipher overflow | ircd/ssl.c:563 | Uses `ircd_snprintf()` |
| WHO buffer overflow | ircd/m_who.c:325-331 | Has length check before memcpy |
| Signal handler race | ircd/ircd_signal.c:51-54 | Uses `volatile sig_atomic_t` |

---

### New Since Upstream

The following security improvements were added after the upstream commits:

**X3 (9e93668 → HEAD):**
- `password.c` - New file with PBKDF2 hashing and CRYPTO_memcmp
- SCRAM-SHA authentication support
- Async password hashing
- Memory pool improvements

**Nefarious (ec573a6 → HEAD):**
- Enhanced SASL session logging (though vulnerability still exists)
- PBKDF2-SHA256/SHA512 password support
- SNI multi-certificate TLS
- Certificate expiry tracking

---

## Recommendations

### Before Merging to Upstream

If contributing these fixes to upstream:

1. **m_sasl.c bounds check** - Add before LocalClientArray access:
   ```c
   if (fd < 0 || fd >= MAXCONNECTIONS) {
       log_write(LS_DEBUG, L_DEBUG, 0, "SASL: Invalid fd %d", fd);
       return 0;
   }
   ```

2. **LDAP filter escaping** - Implement `ldap_escape_filter()` function

3. **Cookie timing attack** - Replace `strcmp` with constant-time comparison

### Production Deployment

All CRITICAL and HIGH issues should be fixed before production, regardless of upstream status.

---

*Generated by Claude Code security audit, 2026-01-19*
