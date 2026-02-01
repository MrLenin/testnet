# IRCv3 Gaps Implementation Plan

## Overview

Comprehensive plan to address all identified IRCv3 compliance gaps in Nefarious and X3.

**Total Effort Estimate**: 115-180 hours (✅ ALL COMPLETE)

**Progress**:
- ✅ TARGMAX ISUPPORT (completed)
- ✅ Client tags on PRIVMSG/NOTICE (completed)
- ✅ STS - Strict Transport Security (completed)
- ✅ SNI - Server Name Indication (completed - SSL {} config block syntax)
- ✅ ECDSA-NIST256P-CHALLENGE SASL (completed)
- ✅ MONITOR (completed - shares WATCH infrastructure)
- ✅ network-icon (completed - draft/ICON ISUPPORT)
- ✅ UTF8ONLY (completed - full enforcement with warn/strict modes)
- ✅ WebSocket (completed - subprotocol support, autodetection, UTF-8 validation)

---

## Phase 1: Quick Wins (2-4 hours) ✅ COMPLETE

### 1.1 TARGMAX ISUPPORT Token ✅

**Component**: Nefarious
**Effort**: 1-2 hours
**Files**: `ircd/s_user.c`
**Status**: IMPLEMENTED

Add TARGMAX to ISUPPORT advertisement:

```c
// In init_isupport() after other add_isupport calls
add_isupport_s("TARGMAX", "PRIVMSG:4,NOTICE:4,KICK:4,JOIN:,PART:,NAMES:1,WHOIS:1");
```

**Values to determine**:
- Check `MAXTARGETS` constant for PRIVMSG/NOTICE limits
- Check kick/join/part target limits
- Empty value (e.g., `JOIN:`) means unlimited

**Testing**:
- Connect client, verify ISUPPORT 005 includes TARGMAX
- Verify values match actual server limits

---

## Phase 2: Client Tags on PRIVMSG/NOTICE (4-8 hours) ✅ COMPLETE

### 2.1 Problem Statement

Client-only tags (prefixed with `+`) are extracted by `parse.c` and stored in `cli_client_tags()`, but only TAGMSG uses them. PRIVMSG and NOTICE should relay these tags to recipients with `message-tags` capability.

**Component**: Nefarious
**Effort**: 4-8 hours
**Files**: `ircd/ircd_relay.c`, `ircd/send.c`
**Status**: IMPLEMENTED

**Implementation Details**:
- Added `sendcmdto_channel_butone_with_client_tags()` to `send.c`
- Modified `relay_channel_message()` and `relay_channel_notice()` to use new function
- Modified `relay_private_message()` and `relay_private_notice()` for PM support
- Modified server relay functions for full coverage

### 2.2 Implementation Steps

#### Step 1: Modify relay_channel_message()

```c
void relay_channel_message(struct Client* sptr, const char* name,
                           const char* text, int count)
{
  struct Channel *chptr;
  const char *client_tags = cli_client_tags(sptr);

  // ... existing channel lookup code ...

  if (client_tags && *client_tags) {
    /* Use client tags version for recipients with message-tags */
    sendcmdto_channel_client_tags(sptr, CMD_PRIVMSG, chptr, sptr,
                                  SKIP_DEAF | SKIP_BURST, client_tags,
                                  "%H :%s", chptr, text);
  } else {
    /* Original path for no client tags */
    sendcmdto_channel_butone(sptr, CMD_PRIVMSG, chptr, sptr,
                             SKIP_DEAF | SKIP_BURST,
                             "%H :%s", chptr, text);
  }
}
```

#### Step 2: Modify relay_channel_notice()

Same pattern as PRIVMSG.

#### Step 3: Modify relay_directed_message() (PM to user)

```c
void relay_directed_message(struct Client* sptr, char* name, char* server, const char* text)
{
  struct Client *acptr;
  const char *client_tags = cli_client_tags(sptr);

  // ... existing user lookup code ...

  if (MyConnect(acptr)) {
    if (client_tags && *client_tags && CapActive(acptr, CAP_MSGTAGS)) {
      sendcmdto_one_client_tags(sptr, CMD_PRIVMSG, acptr, client_tags,
                                "%C :%s", acptr, text);
    } else {
      sendcmdto_one(sptr, CMD_PRIVMSG, acptr, "%C :%s", acptr, text);
    }
  }
  // ... remote user handling ...
}
```

#### Step 4: Modify relay_directed_notice()

Same pattern as directed message.

#### Step 5: S2S Propagation

Ensure client tags are included in P10 messages to other servers:
```c
sendcmdto_serv_butone(sptr, CMD_PRIVMSG, cptr, "@%s %s :%s",
                      client_tags, target, text);
```

### 2.3 Testing

1. Client A with message-tags sends: `@+reply=abc123 PRIVMSG #test :hello`
2. Verify Client B with message-tags receives the `+reply` tag
3. Verify Client C without message-tags receives message without tag prefix
4. Test PM (PRIVMSG to user) with client tags
5. Test NOTICE with client tags
6. Test cross-server relay

---

## Phase 3: STS - Strict Transport Security (32-48 hours) ✅ COMPLETE

### 3.1 Overview

STS forces clients to use TLS by advertising secure port on insecure connections.

**Component**: Nefarious
**Effort**: 32-48 hours (actual: ~2 hours)
**Status**: IMPLEMENTED

**Implementation Summary**:
- Added `FEAT_CAP_sts`, `FEAT_STS_PORT`, `FEAT_STS_DURATION`, `FEAT_STS_PRELOAD` feature flags
- Added `CAP_STS` to capability enum with `CAPFL_PROHIBIT`
- Dynamic value generation in `send_caplist()`:
  - Secure connection: `sts=duration=<seconds>` with optional `,preload`
  - Insecure connection: `sts=port=<port>`
- STS only advertised for CAP 302+ (values required)

### 3.2 Implementation Steps

#### Step 1: Feature Flags (2-3 hours)

**File**: `include/ircd_features.h`, `ircd/ircd_features.c`

```c
// Features
FEAT_CAP_sts,           /* Enable STS capability */
FEAT_STS_PORT,          /* Secure port to advertise */
FEAT_STS_DURATION,      /* Policy duration in seconds */
FEAT_STS_PRELOAD,       /* Consent for preload lists */
```

```c
// Feature definitions
F_B(CAP_sts, 0, 0, NULL),
F_I(STS_PORT, 0, 6697, NULL),
F_I(STS_DURATION, 0, 2592000, NULL),  /* 30 days */
F_B(STS_PRELOAD, 0, 0, NULL),
```

#### Step 2: Capability Enum (1 hour)

**File**: `include/capab.h`

```c
CAP_STS,                /* sts - Strict Transport Security */
```

#### Step 3: Connection Type Detection (4-6 hours)

**File**: `ircd/listener.c`, `include/client.h`

Need to track whether a connection is using TLS:

```c
// In client.h - already exists as FLAG_SSL
#define IsSSL(x)        HasFlag(x, FLAG_SSL)
```

Verify `FLAG_SSL` is set correctly for TLS listeners.

#### Step 4: Capability Advertisement (8-12 hours)

**File**: `ircd/m_cap.c`

```c
// In cap_ls_msg or equivalent
if (feature_bool(FEAT_CAP_sts)) {
  if (IsSSL(cptr)) {
    /* Secure connection - advertise duration */
    int duration = feature_int(FEAT_STS_DURATION);
    if (feature_bool(FEAT_STS_PRELOAD)) {
      snprintf(sts_value, sizeof(sts_value), "duration=%d,preload", duration);
    } else {
      snprintf(sts_value, sizeof(sts_value), "duration=%d", duration);
    }
  } else {
    /* Insecure connection - advertise port */
    snprintf(sts_value, sizeof(sts_value), "port=%d",
             feature_int(FEAT_STS_PORT));
  }
  /* Add sts=<value> to capability list */
}
```

#### Step 5: CAP Value Integration (4-6 hours)

Integrate STS into the capability value system used for CAP LS 302.

#### Step 6: Configuration Documentation (2-3 hours)

```
features {
    "CAP_sts" = "TRUE";
    "STS_PORT" = "6697";
    "STS_DURATION" = "2592000";  /* 30 days */
    "STS_PRELOAD" = "FALSE";
};
```

### 3.3 Testing

1. Connect on plaintext port, verify `sts=port=6697` in CAP LS
2. Connect on TLS port, verify `sts=duration=2592000` in CAP LS
3. Test with WeeChat/The Lounge STS support
4. Verify policy caching behavior
5. Test `duration=0` policy removal

---

## Phase 4: SNI - Server Name Indication (12-17 hours)

### 5.1 Overview

SNI allows server to host multiple TLS certificates and select based on client-requested hostname.

**Component**: Nefarious
**Effort**: 12-17 hours
**Documentation**: https://ircv3.net/docs/sni

### 4.2 Why It Matters

- Server can have different certs for `irc.example.net` vs `server.example.net`
- Required for reverse proxy routing decisions
- Modern TLS best practice

### 4.3 Implementation Steps

#### Step 1: Certificate Storage Structure (3-4 hours)

**File**: `include/ssl.h`, `ircd/ssl.c`

```c
struct ssl_cert {
    char *hostname;        /* NULL for default */
    SSL_CTX *ctx;          /* Context with this cert loaded */
    char *cert_file;
    char *key_file;
    struct ssl_cert *next;
};

static struct ssl_cert *ssl_certs = NULL;
```

#### Step 2: SNI Callback (2-3 hours)

```c
static int sni_callback(SSL *ssl, int *al, void *arg)
{
    const char *hostname = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
    struct ssl_cert *cert;

    if (!hostname)
        return SSL_TLSEXT_ERR_NOACK;

    /* Find matching certificate */
    for (cert = ssl_certs; cert; cert = cert->next) {
        if (cert->hostname && !strcasecmp(cert->hostname, hostname)) {
            SSL_set_SSL_CTX(ssl, cert->ctx);
            return SSL_TLSEXT_ERR_OK;
        }
    }

    /* No match - use default */
    return SSL_TLSEXT_ERR_NOACK;
}
```

#### Step 3: Register Callback (2-3 hours)

```c
SSL_CTX *ssl_init_server_ctx(void)
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
    /* ... existing setup ... */
    SSL_CTX_set_tlsext_servername_callback(ctx, sni_callback);
    return ctx;
}
```

#### Step 4: Configuration Parsing (3-4 hours)

**File**: `ircd/ircd_parser.y`, `ircd/s_conf.c`

Add grammar for multi-cert SSL blocks:

```
SSL {
    default {
        certificate = "certs/default.crt";
        key = "certs/default.key";
    };
    "irc.example.net" {
        certificate = "certs/irc.example.net.crt";
        key = "certs/irc.example.net.key";
    };
};
```

### 4.4 Testing

```bash
# Test with specific hostname
openssl s_client -connect irc.example.net:6697 -servername irc.example.net

# Test default (no SNI)
openssl s_client -connect irc.example.net:6697 -noservername
```

---

## Phase 5: ECDSA-NIST256P-CHALLENGE SASL (24-40 hours)

### 5.1 Overview

Passwordless SASL using ECDSA public key signatures.

**Component**: X3
**Effort**: 24-40 hours

### 5.2 Implementation Steps

#### Step 1: Database Schema (2-3 hours)

**File**: `src/nickserv.c`, SAXDB/LMDB storage

Add `pubkey` field to account structure:

```c
struct handle_info {
    // ... existing fields ...
    char *ecdsa_pubkey;  /* Base64 X9.62 compressed public key */
};
```

SAXDB key: `"pubkey"` under account record

#### Step 2: NickServ SET PUBKEY Command (4-6 hours)

**File**: `src/nickserv.c`

```c
static NICKSERV_FUNC(cmd_set_pubkey)
{
    const char *pubkey = argv[1];

    if (!strcmp(pubkey, "*")) {
        /* Remove public key */
        free(hi->ecdsa_pubkey);
        hi->ecdsa_pubkey = NULL;
        reply("NSMSG_PUBKEY_REMOVED");
        return 1;
    }

    /* Validate public key format */
    if (!validate_ecdsa_pubkey(pubkey)) {
        reply("NSMSG_INVALID_PUBKEY");
        return 0;
    }

    /* Store public key */
    free(hi->ecdsa_pubkey);
    hi->ecdsa_pubkey = strdup(pubkey);
    reply("NSMSG_PUBKEY_SET");
    return 1;
}
```

#### Step 3: ECDSA Validation Functions (4-6 hours)

**File**: `src/ecdsa.c` (new file)

```c
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/obj_mac.h>

/* Validate base64-encoded compressed public key */
int validate_ecdsa_pubkey(const char *base64_pubkey);

/* Generate 32-byte random challenge */
int generate_ecdsa_challenge(unsigned char *challenge);

/* Verify ECDSA signature */
int verify_ecdsa_signature(const char *base64_pubkey,
                           const unsigned char *challenge, size_t challenge_len,
                           const unsigned char *signature, size_t sig_len);
```

#### Step 4: SASL Handler (8-12 hours)

**File**: `src/proto-p10.c` (SA handler)

Add states for ECDSA flow:

```c
enum sasl_state {
    // ... existing states ...
    SASL_STATE_ECDSA_WAIT_ACCOUNT,
    SASL_STATE_ECDSA_CHALLENGE_SENT,
    SASL_STATE_ECDSA_WAIT_SIGNATURE,
};

/* In handle_sasl_message() */
case SASL_STATE_ECDSA_WAIT_ACCOUNT: {
    /* Decode account name */
    char *account = base64_decode(payload);

    /* Lookup account and get pubkey */
    struct handle_info *hi = get_handle_info(account);
    if (!hi || !hi->ecdsa_pubkey) {
        sasl_fail(user, "Unknown account or no pubkey");
        return;
    }

    /* Generate and send challenge */
    generate_ecdsa_challenge(user->ecdsa_challenge);
    char *b64_challenge = base64_encode(user->ecdsa_challenge, 32);
    send_sasl_continue(user, b64_challenge);
    user->sasl_state = SASL_STATE_ECDSA_WAIT_SIGNATURE;
    break;
}

case SASL_STATE_ECDSA_WAIT_SIGNATURE: {
    /* Decode signature */
    size_t sig_len;
    unsigned char *signature = base64_decode_binary(payload, &sig_len);

    /* Verify signature */
    if (verify_ecdsa_signature(hi->ecdsa_pubkey,
                               user->ecdsa_challenge, 32,
                               signature, sig_len)) {
        sasl_success(user, hi);
    } else {
        sasl_fail(user, "Signature verification failed");
    }
    break;
}
```

#### Step 5: Mechanism Advertisement (2-3 hours)

Add `ECDSA-NIST256P-CHALLENGE` to SASL mechanism list sent to IRCd.

#### Step 6: Keycloak Integration (Optional) (4-6 hours)

Store pubkey as user attribute in Keycloak:
```
x3.ecdsa_pubkey = <base64-key>
```

### 5.3 Testing

1. Generate keypair with ecdsatool
2. Register pubkey: `/msg NickServ SET PUBKEY <key>`
3. Test SASL auth with WeeChat ECDSA support
4. Test invalid signature rejection
5. Test unknown account handling
6. Test pubkey removal with `SET PUBKEY *`

---

## Phase 5: MONITOR (24-40 hours) ✅ COMPLETE

### 5.1 Overview

MONITOR is the IRCv3 standard for client-side presence monitoring. Nefarious has WATCH which serves the same purpose but with different syntax.

**Component**: Nefarious
**Effort**: 24-40 hours (actual: ~2 hours)
**Priority**: Low (WATCH exists)
**Status**: IMPLEMENTED

### 5.2 Implementation Summary

Implemented MONITOR command (Option A - sharing WATCH infrastructure):

**Files Created**:
- `ircd/m_monitor.c` - Full MONITOR command handler with batched responses

**Files Modified**:
- `include/numeric.h` - Added RPL_MONONLINE (730), RPL_MONOFFLINE (731), RPL_MONLIST (732), RPL_ENDOFMONLIST (733), ERR_MONLISTFULL (734)
- `ircd/s_err.c` - Format strings for MONITOR numerics
- `include/msg.h` - MSG_MONITOR, TOK_MONITOR defines
- `include/handlers.h` - m_monitor() declaration
- `ircd/parse.c` - MONITOR command registration
- `ircd/s_user.c` - Added `MONITOR=<limit>` to ISUPPORT (shares MAXWATCHS limit)
- `ircd/Makefile.in` - Added m_monitor.o to build

### 5.3 Key Differences from WATCH

| Feature | WATCH | MONITOR |
|---------|-------|---------|
| Add target | `WATCH +nick` | `MONITOR + nick1,nick2` |
| Remove target | `WATCH -nick` | `MONITOR - nick1,nick2` |
| Clear all | `WATCH C` | `MONITOR C` |
| List targets | `WATCH L` | `MONITOR L` |
| Status query | `WATCH S` | `MONITOR S` |
| Limit token | `WATCH=<n>` | `MONITOR=<n>` |

### 5.4 Notification Numerics ✅ FIXED

Online/offline notifications now use the correct numeric format based on how the watch entry was added:
- **WATCH clients**: Receive 604/605 (RPL_NOWON/RPL_NOWOFF) format with separate fields
- **MONITOR clients**: Receive 730/731 (RPL_MONONLINE/RPL_MONOFFLINE) format with nick!user@host

Implementation:
- Added `WATCH_FLAG_MONITOR` flag to track MONITOR entries in `watch.h`
- Modified `add_nick_watch()` to accept flags parameter
- Modified `check_status_watch()` to check flag and send appropriate format

### 5.5 Testing

```
MONITOR + friend1,friend2,friend3
:server 730 nick :friend1!user@host,friend2!user@host
:server 731 nick :friend3

MONITOR L
:server 732 nick :friend1,friend2,friend3
:server 733 nick :End of MONITOR list

MONITOR S
:server 730 nick :friend1!user@host
:server 731 nick :friend2,friend3
:server 733 nick :End of MONITOR list

MONITOR - friend1
(no response per spec)

MONITOR C
(no response per spec)
```

---

## Phase 6: network-icon (4-8 hours) ✅ COMPLETE

### 6.1 Overview

Allows networks to advertise a branding icon URL.

**Component**: Nefarious
**Effort**: 4-8 hours (actual: ~5 minutes)
**Priority**: Very Low
**Status**: IMPLEMENTED

### 6.2 Implementation Summary

**ISUPPORT Token**: `draft/ICON=<url>` (per IRCv3 spec)

**Files Modified**:
- `include/ircd_features.h` - Added `FEAT_NETWORK_ICON`
- `ircd/ircd_features.c` - Feature definition (string, default empty)
- `ircd/s_user.c` - Adds `draft/ICON` to ISUPPORT when set

**Configuration**:
```
features {
    "NETWORK_ICON" = "https://example.com/network-icon.png";
};
```

Only advertised when `NETWORK_ICON` is non-empty.

---

## Phase 7: UTF8ONLY (8-16 hours) ✅ COMPLETE

### 7.1 Overview

Advertises that the server only accepts UTF-8 encoded messages.

**Component**: Nefarious
**Effort**: 8-16 hours (actual: ~3 hours)
**Priority**: Lowest
**Status**: IMPLEMENTED

### 7.2 Implementation Summary

Implemented full UTF-8 enforcement with two configurable modes:

**Feature Flags**:
- `FEAT_UTF8ONLY` - Enable UTF-8 enforcement (adds UTF8ONLY to ISUPPORT)
- `FEAT_UTF8ONLY_STRICT` - If true, reject invalid messages; if false, sanitize and warn

**Modes**:
- **Strict mode** (`UTF8ONLY_STRICT=TRUE`): Invalid UTF-8 is rejected with FAIL INVALID_UTF8
- **Warn mode** (`UTF8ONLY_STRICT=FALSE`): Invalid UTF-8 is truncated at first invalid byte, WARN INVALID_UTF8 sent

**Files Modified**:
- `include/ircd_features.h` - Added FEAT_UTF8ONLY, FEAT_UTF8ONLY_STRICT
- `ircd/ircd_features.c` - Feature definitions (both boolean, default false)
- `ircd/s_user.c` - Adds UTF8ONLY to ISUPPORT when enabled
- `include/ircd_string.h` - Added string_sanitize_utf8() declaration
- `ircd/ircd_string.c` - Added string_sanitize_utf8() function
- `ircd/ircd_relay.c` - UTF-8 validation in relay_channel_message(), relay_channel_notice(), relay_private_message(), relay_private_notice()
- `ircd/m_topic.c` - UTF-8 validation for TOPIC command

### 7.3 Configuration

```
features {
    "UTF8ONLY" = "TRUE";        /* Enable UTF-8 enforcement */
    "UTF8ONLY_STRICT" = "FALSE"; /* Warn mode (truncate + warn) */
};
```

Or for strict enforcement:
```
features {
    "UTF8ONLY" = "TRUE";
    "UTF8ONLY_STRICT" = "TRUE"; /* Strict mode (reject messages) */
};
```

### 7.4 Standard Replies

Uses IRCv3 standard-replies format:
- `FAIL PRIVMSG INVALID_UTF8 :Message contains invalid UTF-8 and was rejected`
- `WARN PRIVMSG INVALID_UTF8 :Message contained invalid UTF-8 and was sanitized`

Same pattern for NOTICE and TOPIC commands.

### 7.5 U+FFFD Replacement ✅ IMPLEMENTED

Invalid UTF-8 byte sequences are replaced with U+FFFD (Unicode Replacement Character, 0xEF 0xBF 0xBD in UTF-8) rather than truncating. This provides more graceful handling:
- Each invalid byte becomes U+FFFD
- Valid portions of the message are preserved
- Ensures output never truncates mid-codepoint (per spec requirement)

---

## Implementation Order

### Sprint 1: Quick Wins (Week 1)
- [ ] TARGMAX ISUPPORT (1-2 hours)
- [ ] Client tags on PRIVMSG/NOTICE (4-8 hours)

### Sprint 2: Security & TLS (Weeks 2-4)
- [ ] STS - Strict Transport Security (32-48 hours)
- [ ] SNI - Server Name Indication (12-17 hours)

### Sprint 3: SASL Enhancement (Weeks 5-6)
- [ ] ECDSA-NIST256P-CHALLENGE (24-40 hours)

### Sprint 4: Low Priority (As time permits)
- [ ] MONITOR (24-40 hours)
- [ ] network-icon (4-8 hours)
- [ ] UTF8ONLY (8-16 hours)

---

## Dependencies

```
TARGMAX ─────────────────────────────────────────────► (none)
Client Tags ─────────────────────────────────────────► (none)
STS ─────────────────────────────────────────────────► TLS working
SNI ─────────────────────────────────────────────────► TLS working, OpenSSL 1.0+
ECDSA SASL ──────────────────────────────────────────► OpenSSL EC APIs
MONITOR ─────────────────────────────────────────────► (none, can reuse WATCH)
network-icon ────────────────────────────────────────► (none)
UTF8ONLY ────────────────────────────────────────────► (none)
```

---

## Testing Strategy

### Unit Tests
- ECDSA key validation
- ECDSA signature verification
- UTF-8 validation (if enforcement added)

### Integration Tests
- STS upgrade flow with real client
- SNI certificate selection with openssl s_client
- ECDSA SASL with WeeChat
- Client tag relay between servers
- MONITOR command with compatible client

### Clients for Testing
- **WeeChat**: STS, ECDSA, client tags
- **The Lounge**: STS, client tags
- **Irssi**: ECDSA (with cap_sasl.pl)
- **catgirl**: MONITOR
- **openssl s_client**: SNI testing

---

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| STS misconfiguration | Users locked out | Test thoroughly, document recovery |
| ECDSA crypto errors | Auth failures | Use well-tested OpenSSL APIs |
| Client tag compatibility | Older clients confused | Only relay to message-tags capable |
| MONITOR vs WATCH | Confusion | Document both, consider deprecating WATCH later |

---

## Success Criteria

1. **TARGMAX**: ISUPPORT shows correct limits
2. **Client tags**: +typing/+reply work on PRIVMSG
3. **STS**: Clients auto-upgrade to TLS
4. **SNI**: Correct certificate selected based on hostname
5. **ECDSA**: Passwordless SASL working with WeeChat
6. **MONITOR**: Basic presence monitoring with MONITOR command
7. **network-icon**: Icon URL in ISUPPORT
8. **UTF8ONLY**: Token in ISUPPORT (enforcement optional)
9. **WebSocket**: Proper subprotocol handling and UTF-8 output validation

---

## Phase 10: WebSocket Compliance ✅ COMPLETE

### 10.1 Overview

WebSocket support in Nefarious needed several fixes for full IRCv3 WebSocket spec compliance.

**Component**: Nefarious
**Status**: IMPLEMENTED

### 10.2 Issues Addressed

1. **Subprotocol tracking**: Clients negotiating `text.ircv3.net` vs `binary.ircv3.net` now get the correct frame type for outgoing messages.

2. **Legacy client support**: Clients that don't negotiate a subprotocol now have their mode autodetected based on the first incoming frame type, per spec recommendation.

3. **UTF-8 output validation**: Text mode WebSocket frames now validate UTF-8 and replace invalid bytes with U+FFFD, as required by RFC 6455 to prevent browser disconnection.

4. **Trailing \r\n**: Already handled - code strips \r\n from message ends before framing.

### 10.3 Implementation Details

**Files Modified**:
- `include/client.h` - Added FLAG_WSTEXT, FLAG_WSAUTODETECT flags with Is/Set/Clear macros
- `ircd/websocket.c` - Store subprotocol preference after handshake
- `ircd/s_bsd.c` - Autodetection logic, UTF-8 sanitization for text mode

**Key Logic**:
```c
/* After handshake, store subprotocol preference */
if (subproto == WS_SUBPROTO_TEXT)
  SetWSText(cptr);
else if (subproto == WS_SUBPROTO_NONE)
  SetWSAutodetect(cptr);  /* Detect from first incoming frame */

/* On receiving first data frame for legacy clients */
if (IsWSAutodetect(cptr)) {
  if (opcode == WS_OPCODE_TEXT)
    SetWSText(cptr);
  ClearWSAutodetect(cptr);
}

/* On sending data, use client's mode and validate UTF-8 for text */
int text_mode = IsWSText(cptr);
if (text_mode && !string_is_valid_utf8(data))
  string_sanitize_utf8(data);  /* Replace invalid bytes with U+FFFD */
websocket_encode_frame(data, len, frame, text_mode);
```

### 10.4 Spec Compliance

| Requirement | Status |
|-------------|--------|
| Support text.ircv3.net subprotocol | ✅ |
| Support binary.ircv3.net subprotocol | ✅ |
| Support legacy clients (no subprotocol) | ✅ Autodetect |
| Use correct frame type for outgoing | ✅ |
| No trailing \r\n in messages | ✅ Already handled |
| No non-UTF-8 in text frames | ✅ Sanitize with U+FFFD |
