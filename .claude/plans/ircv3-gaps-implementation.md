# IRCv3 Gaps Implementation Plan

## Overview

Comprehensive plan to address all identified IRCv3 compliance gaps in Nefarious and X3.

**Total Effort Estimate**: 100-160 hours

**Priority Order**:
1. TARGMAX ISUPPORT (quick win)
2. Client tags on PRIVMSG/NOTICE (easy, high impact)
3. STS - Strict Transport Security (security critical)
4. ECDSA-NIST256P-CHALLENGE SASL (new capability)
5. MONITOR (alternative to WATCH)
6. network-icon (nice to have)
7. UTF8ONLY (lowest priority)

---

## Phase 1: Quick Wins (2-4 hours)

### 1.1 TARGMAX ISUPPORT Token

**Component**: Nefarious
**Effort**: 1-2 hours
**Files**: `ircd/s_user.c`

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

## Phase 2: Client Tags on PRIVMSG/NOTICE (4-8 hours)

### 2.1 Problem Statement

Client-only tags (prefixed with `+`) are extracted by `parse.c` and stored in `cli_client_tags()`, but only TAGMSG uses them. PRIVMSG and NOTICE should relay these tags to recipients with `message-tags` capability.

**Component**: Nefarious
**Effort**: 4-8 hours
**Files**: `ircd/ircd_relay.c`, `ircd/send.c`

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

## Phase 3: STS - Strict Transport Security (32-48 hours)

### 3.1 Overview

STS forces clients to use TLS by advertising secure port on insecure connections.

**Component**: Nefarious
**Effort**: 32-48 hours

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

## Phase 4: ECDSA-NIST256P-CHALLENGE SASL (24-40 hours)

### 4.1 Overview

Passwordless SASL using ECDSA public key signatures.

**Component**: X3
**Effort**: 24-40 hours

### 4.2 Implementation Steps

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

### 4.3 Testing

1. Generate keypair with ecdsatool
2. Register pubkey: `/msg NickServ SET PUBKEY <key>`
3. Test SASL auth with WeeChat ECDSA support
4. Test invalid signature rejection
5. Test unknown account handling
6. Test pubkey removal with `SET PUBKEY *`

---

## Phase 5: MONITOR (24-40 hours)

### 5.1 Overview

MONITOR is the IRCv3 standard for client-side presence monitoring. Nefarious has WATCH which serves the same purpose but with different syntax.

**Component**: Nefarious
**Effort**: 24-40 hours
**Priority**: Low (WATCH exists)

### 5.2 Key Differences from WATCH

| Feature | WATCH | MONITOR |
|---------|-------|---------|
| Add target | `WATCH +nick` | `MONITOR + nick1,nick2` |
| Remove target | `WATCH -nick` | `MONITOR - nick1,nick2` |
| Clear all | `WATCH C` | `MONITOR C` |
| List targets | `WATCH L` | `MONITOR L` |
| Status query | `WATCH S` | `MONITOR S` |
| Limit token | `WATCH=<n>` | `MONITOR=<n>` |

### 5.3 Implementation Approach

**Option A**: Implement MONITOR as alias to WATCH internals
- Reuse watch.c data structures
- Add m_monitor.c command parser
- Map MONITOR commands to WATCH operations

**Option B**: Full separate implementation
- New monitor.c with separate data structures
- More work but cleaner separation

**Recommendation**: Option A - leverage existing WATCH infrastructure.

### 5.4 Files to Modify/Create

- `ircd/m_monitor.c` (new) - MONITOR command handler
- `ircd/watch.c` - Export internal functions for MONITOR use
- `include/msg.h` - Add MONITOR token
- `ircd/parse.c` - Register MONITOR command
- `ircd/s_user.c` - Add `MONITOR=<n>` to ISUPPORT

---

## Phase 6: network-icon (4-8 hours)

### 6.1 Overview

Allows networks to advertise a branding icon URL.

**Component**: Nefarious
**Effort**: 4-8 hours
**Priority**: Very Low

### 6.2 Implementation

Add to ISUPPORT:

```c
add_isupport_s("NETWORK_ICON", feature_str(FEAT_NETWORK_ICON));
```

Feature:
```c
F_S(NETWORK_ICON, 0, "", NULL),
```

Configuration:
```
features {
    "NETWORK_ICON" = "https://example.com/network-icon.png";
};
```

---

## Phase 7: UTF8ONLY (8-16 hours)

### 7.1 Overview

Advertises that the server only accepts UTF-8 encoded messages.

**Component**: Nefarious
**Effort**: 8-16 hours
**Priority**: Lowest

### 7.2 Implementation Options

**Option A**: Advertisement only (no enforcement)
- Add `UTF8ONLY` to ISUPPORT
- Document that network expects UTF-8
- Minimal effort

**Option B**: Full enforcement
- Validate all incoming text as valid UTF-8
- Reject invalid sequences with error
- More complex, potential compatibility issues

**Recommendation**: Start with Option A, consider enforcement later.

### 7.3 Implementation (Option A)

```c
// Feature
F_B(UTF8ONLY, 0, 0, NULL),

// In init_isupport()
if (feature_bool(FEAT_UTF8ONLY)) {
    add_isupport("UTF8ONLY");
}
```

---

## Implementation Order

### Sprint 1: Quick Wins (Week 1)
- [ ] TARGMAX ISUPPORT (1-2 hours)
- [ ] Client tags on PRIVMSG/NOTICE (4-8 hours)

### Sprint 2: Security (Weeks 2-3)
- [ ] STS - Strict Transport Security (32-48 hours)

### Sprint 3: SASL Enhancement (Weeks 4-5)
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
- ECDSA SASL with WeeChat
- Client tag relay between servers
- MONITOR command with compatible client

### Clients for Testing
- **WeeChat**: STS, ECDSA, client tags
- **The Lounge**: STS, client tags
- **Irssi**: ECDSA (with cap_sasl.pl)
- **catgirl**: MONITOR

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
4. **ECDSA**: Passwordless SASL working with WeeChat
5. **MONITOR**: Basic presence monitoring with MONITOR command
6. **network-icon**: Icon URL in ISUPPORT
7. **UTF8ONLY**: Token in ISUPPORT (enforcement optional)
