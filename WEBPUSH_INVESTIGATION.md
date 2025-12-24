# IRCv3 Web Push Extension Investigation

## Status: INVESTIGATING (Draft Specification)

**Specification**: https://github.com/ircv3/ircv3-specifications/pull/471

**Capability**: `draft/webpush`

---

## Specification Summary

The Web Push extension enables IRC clients to receive push notifications when disconnected or backgrounded. This is critical for:
- Mobile clients (iOS, Android) with background restrictions
- Web browser clients
- Battery-constrained devices
- Users who don't maintain persistent connections

Instead of requiring always-on TCP connections, clients register a push endpoint and receive notifications via the standard Web Push protocol.

---

## How It Works

### Architecture Overview

```
┌─────────┐     IRC      ┌─────────────┐    HTTP POST    ┌──────────────┐
│  User   │◄────────────►│  Nefarious  │────────────────►│ Push Service │
│ Client  │              │   (IRCd)    │                 │ (FCM/APNs/   │
└─────────┘              └─────────────┘                 │  UnifiedPush)│
     ▲                                                   └──────────────┘
     │                                                          │
     │              Push Notification                           │
     └──────────────────────────────────────────────────────────┘
```

1. Client connects to IRC, negotiates `draft/webpush`
2. Client registers push endpoint (from browser/OS push API)
3. Client disconnects (or backgrounds)
4. Message arrives for user
5. Server encrypts message, POSTs to push endpoint
6. Push service delivers notification to client
7. Client optionally reconnects to fetch full history via chathistory

---

## Underlying Standards

| RFC | Name | Purpose |
|-----|------|---------|
| [RFC 8030](https://datatracker.ietf.org/doc/html/rfc8030) | Generic Event Delivery Using HTTP Push | Core push protocol |
| [RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291) | Message Encryption for Web Push | End-to-end encryption |
| [RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292) | VAPID | Server identification |

### Encryption (RFC 8291)

- Uses Elliptic Curve Diffie-Hellman (ECDH) on P-256 curve
- `aes128gcm` content encoding
- Client generates keypair and 16-byte auth secret
- Only the intended recipient can decrypt

### VAPID (RFC 8292)

- Server signs requests with ECDSA P-256 key
- Allows push services to identify/contact the IRC server operator
- Prevents unauthorized use of push subscriptions

---

## Capability and ISUPPORT

### Capability

```
CAP REQ :draft/webpush
```

### ISUPPORT Token

```
VAPID=<base64-encoded-public-key>
```

The server advertises its VAPID public key so clients can verify push notification signatures.

---

## WEBPUSH Commands

### WEBPUSH REGISTER

**Syntax**: `WEBPUSH REGISTER <endpoint> <keys>`

| Parameter | Description |
|-----------|-------------|
| `<endpoint>` | HTTPS URL of push service |
| `<keys>` | Message-tag format with encryption keys |

**Keys format**:
```
p256dh=<base64-client-public-key>;auth=<base64-auth-secret>
```

**Example**:
```
WEBPUSH REGISTER https://fcm.googleapis.com/fcm/send/abc123 p256dh=BNcR...;auth=tBH...
```

**Success Response**:
```
WEBPUSH REGISTER https://fcm.googleapis.com/fcm/send/abc123
```

**Behavior**:
- Registering same endpoint replaces previous subscription
- Requires authenticated (logged-in) user

### WEBPUSH UNREGISTER

**Syntax**: `WEBPUSH UNREGISTER <endpoint>`

**Example**:
```
WEBPUSH UNREGISTER https://fcm.googleapis.com/fcm/send/abc123
```

**Behavior**:
- Silently succeeds if endpoint not registered (race condition safe)
- Echoes command on success

---

## Error Responses

| Error Code | Condition |
|------------|-----------|
| `INVALID_PARAMS` | Malformed command or parameters |
| `INTERNAL_ERROR` | Server-side failure |
| `MAX_REGISTRATIONS` | Too many subscriptions for user |

**Example**:
```
FAIL WEBPUSH MAX_REGISTRATIONS :Too many push registrations
```

---

## Push Message Delivery

### What Gets Pushed

Server-defined subset, typically:
- Private messages (PRIVMSG/NOTICE to user)
- Channel highlights (messages mentioning user's nick)
- Invites

### Message Format

- Exactly one IRC message per notification
- No trailing CRLF
- Same capability context as registration
- Tags may be stripped except `msgid`

**Example push payload** (after decryption):
```
@time=2025-12-24T12:00:00.000Z;msgid=AB-123-1 :sender!u@h PRIVMSG yournick :Hey, are you there?
```

### Size Constraints

| Limit | Value |
|-------|-------|
| RFC 8030 | ~4096 bytes |
| Firebase (FCM) | 4096 bytes |
| APNs | 4096 bytes |

Server may need to truncate or drop tags to fit.

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| SASL / Authentication | Complete |
| `message-tags` | Complete |
| `msgid` | Complete |
| `server-time` | Complete |
| HTTP client library | Not present |
| Crypto libraries (ECDH, AES-GCM) | Not present |

### New Dependencies Required

- **libcurl** or similar HTTP client
- **OpenSSL** (already used for TLS, has ECDH/AES)
- VAPID key generation and storage

---

## Implementation Architecture

### Option A: Native in Nefarious

```
Nefarious IRCd
├── Push subscription storage (per-user)
├── VAPID key management
├── Message encryption (RFC 8291)
├── HTTP POST to push services
└── Rate limiting
```

**Pros**: Lowest latency, direct control
**Cons**: Significant C code, HTTP client integration

### Option B: X3 Services Integration

```
Client <--IRC--> Nefarious <--P10--> X3 <--HTTP--> Push Services
```

X3 handles:
- Subscription storage (with accounts)
- Push delivery
- VAPID keys

**Pros**: Account-linked, centralized
**Cons**: P10 changes, X3 complexity

### Option C: External Push Daemon

```
Client <--IRC--> Nefarious <--IPC--> webpush-daemon <--HTTP--> Push Services
```

Separate daemon handles:
- Subscription storage
- Encryption
- HTTP delivery

**Pros**: Separation of concerns, can be any language
**Cons**: IPC overhead, additional process

### Option D: Bouncer-Only (Recommended Initially)

Deploy soju bouncer with webpush support:

```
Client <--IRC--> soju (bouncer) <--IRC--> Nefarious
                   |
                   +--HTTP--> Push Services
```

**Pros**: No IRCd changes, proven implementation
**Cons**: Requires bouncer, not native

---

## P10 Protocol Design (Option B)

### New Token: `WP` (WEBPUSH)

**Registration**:
```
[USER_NUMERIC] WP R <endpoint> <p256dh> <auth>
```

**Unregistration**:
```
[USER_NUMERIC] WP U <endpoint>
```

**Push Request** (X3 → Nefarious, for offline user):
```
[SERVER] WP P <user_account> <endpoint>
```

---

## Files to Modify (Native Implementation)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_WEBPUSH` |
| `include/ircd_features.h` | Add webpush features |
| `ircd/ircd_features.c` | Register features |
| `ircd/m_cap.c` | Add `draft/webpush` capability |
| `include/msg.h` | Add `MSG_WEBPUSH` |
| `include/handlers.h` | Add handler declarations |
| `ircd/m_webpush.c` | New file: WEBPUSH command handler |
| `ircd/parse.c` | Register WEBPUSH command |
| `ircd/webpush.c` | New file: Push delivery, encryption |
| `include/webpush.h` | Data structures, API |
| `ircd/s_serv.c` | ISUPPORT VAPID token |
| `configure.in` | libcurl detection |

---

## Data Structures

```c
struct WebPushSubscription {
    char endpoint[512];          /* Push service URL */
    unsigned char p256dh[65];    /* Client public key (uncompressed) */
    unsigned char auth[16];      /* Auth secret */
    time_t created;
    time_t expires;
    struct WebPushSubscription *next;
};

struct WebPushConfig {
    unsigned char vapid_private[32];  /* ECDSA private key */
    unsigned char vapid_public[65];   /* ECDSA public key */
    char vapid_contact[256];          /* mailto: or https: */
    int max_registrations;            /* Per-user limit */
    int ttl;                          /* Message TTL seconds */
};
```

---

## Implementation Phases

### Phase 1: Bouncer Deployment (No Code Changes)

1. Deploy soju bouncer with webpush support
2. Configure users to connect via bouncer
3. Test with Goguma/gamja clients

**Effort**: Low (4-8 hours ops work)

### Phase 2: X3 Subscription Storage

1. Add subscription storage to X3 (account-linked)
2. Add P10 WP command for sync
3. Nefarious stores subscriptions in memory, syncs to X3

**Effort**: Medium (24-32 hours)

### Phase 3: Native Push Delivery

1. Add libcurl dependency
2. Implement RFC 8291 encryption
3. Implement VAPID signing
4. HTTP POST to push services

**Effort**: High (40-60 hours)

### Phase 4: Full Integration

1. Message filtering (what triggers push)
2. Rate limiting
3. Subscription expiry handling
4. VAPID key rotation

**Effort**: Medium (16-24 hours)

---

## Configuration Options

```
features {
    "CAP_webpush" = "TRUE";
    "WEBPUSH_MAX_REGISTRATIONS" = "5";
    "WEBPUSH_TTL" = "86400";              /* 24 hours */
    "WEBPUSH_VAPID_CONTACT" = "mailto:admin@example.com";
    "WEBPUSH_RATE_LIMIT" = "60";          /* per minute */
};
```

---

## Security Considerations

1. **HTTPS only**: Reject non-HTTPS endpoints
2. **No internal IPs**: Block loopback, private ranges
3. **Rate limiting**: Prevent notification spam
4. **Subscription limits**: Max registrations per user
5. **Encryption**: End-to-end, only client can decrypt
6. **VAPID**: Identify server to push services
7. **Expiry**: Auto-expire stale subscriptions

---

## Push Service Compatibility

| Service | Platform | Endpoint Format |
|---------|----------|-----------------|
| Firebase Cloud Messaging | Android/Web | `https://fcm.googleapis.com/fcm/send/...` |
| Apple Push Notification | iOS/macOS | `https://api.push.apple.com/...` |
| Mozilla Push | Firefox | `https://updates.push.services.mozilla.com/...` |
| UnifiedPush | Self-hosted | Varies |

---

## Relationship to Other Extensions

### Chathistory

Web push + chathistory work together:
1. Push notification alerts user to new message
2. User opens app, connects
3. App fetches full history via `CHATHISTORY LATEST`

Push can indicate "you have N new messages" without full content.

### Read-Marker

Push could include read-marker updates:
- "Messages read on another device"
- Sync notification state across clients

### Pre-Away

With `draft/pre-away`:
1. Client connects with `AWAY *`
2. Registers push subscription
3. Fetches chathistory
4. Disconnects
5. Receives pushes while "away"

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Bouncer deployment | Low | Low |
| Subscription storage | Medium | Low |
| P10 protocol | Medium | Medium |
| RFC 8291 encryption | High | High |
| VAPID signing | Medium | Medium |
| HTTP client integration | High | Medium |
| Rate limiting | Low | Low |

**Total**:
- Bouncer approach: Low (4-8 hours)
- Native approach: Very High (80-124 hours)

---

## Recommendation

1. **Start with bouncer**: Deploy soju for immediate webpush support
2. **Evaluate native later**: After chathistory is implemented
3. **Consider X3 integration**: For account-linked subscriptions
4. **Use existing libraries**: Don't implement crypto from scratch

### Priority

Medium-High for mobile user experience, but:
- Complex crypto requirements
- HTTP client dependency
- Bouncer provides immediate solution

---

## Client Support

| Client | Platform | Status |
|--------|----------|--------|
| Goguma | Android | Supported |
| gamja | Web | Supported |
| IRCCloud | iOS/Android/Web | Proprietary push |

---

## Server Support

| Server | Status |
|--------|--------|
| soju | Full support (bouncer) |
| Ergo | Implementation exists |
| Nefarious | Not implemented |

---

## References

- **IRCv3 PR**: https://github.com/ircv3/ircv3-specifications/pull/471
- **RFC 8030**: https://datatracker.ietf.org/doc/html/rfc8030 (HTTP Push)
- **RFC 8291**: https://datatracker.ietf.org/doc/html/rfc8291 (Encryption)
- **RFC 8292**: https://datatracker.ietf.org/doc/html/rfc8292 (VAPID)
- **soju**: https://soju.im/ (Reference implementation)
- **webpush-go**: https://github.com/SherClockHolmes/webpush-go (Go library)
- **Web Push Guide**: https://www.thinktecture.com/en/pwa/http-web-push/
