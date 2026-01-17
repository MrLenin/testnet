# Web Push Notifications

Implementation of `draft/webpush` IRCv3 extension for mobile and web client push notifications.

## Overview

Web push enables IRC servers to send push notifications to mobile apps and web browsers when users receive messages while offline or backgrounded. Implements RFC 8291 (Message Encryption for Web Push).

## Architecture

```
┌─────────┐                    ┌──────────┐                    ┌────┐
│ Push    │◄─HTTP POST────────│    X3    │                    │    │
│ Service │                    │          │◄─WP P──────────────│Nef │
│(FCM/APNs)                   │          │                    │    │
└────┬────┘                    └──────────┘                    └────┘
     │                              │
     ▼                              │
┌─────────┐                    ┌────▼────┐
│ Client  │                    │  LMDB   │
│ (App)   │                    │ (subs)  │
└─────────┘                    └─────────┘
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_webpush` | TRUE | Enable `draft/webpush` capability |

## VAPID Keys

X3 generates and broadcasts a VAPID (Voluntary Application Server Identification) public key on startup. This key is used by clients to verify push notifications.

```
Server: CAP * LS :draft/webpush=vapid=BNcRdreALRFX...
```

## P10 Protocol

### WP Token (WEBPUSH)

**Subcommands**:

| Subcmd | Format | Direction | Purpose |
|--------|--------|-----------|---------|
| `V` | `WP V :<vapid_key>` | X3 → All | VAPID broadcast |
| `R` | `WP R <user> <endpoint> <p256dh> <auth>` | Server → X3 | Register subscription |
| `U` | `WP U <user> <endpoint>` | Server → X3 | Unregister subscription |
| `P` | `WP P <account> :<message>` | Server → X3 | Push request |
| `E` | `WP E <user> <code> :<message>` | X3 → Server | Error response |

## Client Commands

### WEBPUSH Subcommands

```
WEBPUSH REGISTER <endpoint> <p256dh> <auth>
WEBPUSH UNREGISTER <endpoint>
WEBPUSH LIST
WEBPUSH TEST
```

### Parameters

- `endpoint`: Push service URL (FCM, APNs, etc.)
- `p256dh`: Client public key (base64)
- `auth`: Authentication secret (base64)

### Example

```
WEBPUSH REGISTER https://fcm.googleapis.com/fcm/send/xyz BPxyz... secretauth
:server WEBPUSH OK :Subscription registered
```

## Subscription Storage

X3 stores subscriptions in LMDB (and optionally Keycloak):

**LMDB Key**:
```
webpush:<account>:<endpoint_hash>
```

**Value**:
```
<endpoint>|<p256dh>|<auth>|<created_timestamp>
```

**Keycloak Attribute**:
```
webpush.<endpoint_hash> = "<endpoint>|<p256dh>|<auth>"
```

## Push Flow

1. User A sends message to offline User B
2. Nefarious checks if User B is offline/away
3. Nefarious sends `WP P userb :Message from User A`
4. X3 looks up User B's subscriptions
5. X3 encrypts message per RFC 8291
6. X3 POSTs to each subscription endpoint
7. Push service delivers to User B's devices

## RFC 8291 Encryption

X3 implements the full Web Push encryption spec:

1. **ECDH Key Agreement**: Generate ephemeral P-256 key pair
2. **HKDF Key Derivation**: Derive content encryption key
3. **AES-GCM Encryption**: Encrypt message payload
4. **Header Construction**: Add `Encryption` and `Crypto-Key` headers

**Required Libraries**:
- OpenSSL 3.x (ECDH, HKDF, AES-GCM)
- libcurl (HTTP POST)

## Error Handling

| Code | Meaning |
|------|---------|
| `INVALID_SUB` | Subscription format invalid |
| `NO_SUBS` | No subscriptions for account |
| `PUSH_FAILED` | Push service returned error |
| `NOT_AUTHED` | Must be authenticated |

## Push Message Format

```json
{
  "title": "IRC Notification",
  "body": "<sender>: <message>",
  "data": {
    "sender": "<nick>",
    "target": "<channel or nick>",
    "msgid": "<msgid>",
    "timestamp": "<iso8601>"
  }
}
```

## Rate Limiting

To prevent push spam:
- Max 10 push requests per user per minute
- Aggregate messages during burst
- Respect push service rate limits

## ISUPPORT Advertisement

```
VAPID=BNcRdreALRFX...
```

The VAPID public key is advertised via ISUPPORT for clients that don't use CAP negotiation.

## Example Configuration

X3 generates VAPID keys automatically. No explicit configuration needed beyond enabling the capability.

```
features {
    "CAP_webpush" = "TRUE";
};
```

## Build Requirements

**X3**:
- OpenSSL 3.x (for ECDH/HKDF/AES-GCM)
- libcurl (for HTTP POST)

```bash
./configure --with-ssl --with-keycloak  # Keycloak implies curl
```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*
