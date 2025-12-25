# IRCv3 Feature Flags and Configuration Reference

This document provides a comprehensive reference for all feature flags and configuration options added during the IRCv3.2+ upgrade project for Nefarious IRCd and X3 Services.

---

## Table of Contents

1. [Nefarious IRCd Features](#nefarious-ircd-features)
2. [Nefarious Capability Flags](#nefarious-capability-flags)
3. [X3 Services Configuration](#x3-services-configuration)
4. [Keycloak Integration](#keycloak-integration)
5. [Build Configuration](#build-configuration)

---

## Nefarious IRCd Features

Feature flags are configured in the `features {}` block of the IRCd config file.

### Core IRCv3 Features

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_MSGID` | TRUE | Generate unique message IDs for all messages |
| `FEAT_SERVERTIME` | TRUE | Add server-time tags to messages |

### Capability Features

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_CAP_setname` | TRUE | Enable `setname` capability |
| `FEAT_CAP_batch` | TRUE | Enable `batch` capability |
| `FEAT_CAP_labeled_response` | TRUE | Enable `labeled-response` capability |
| `FEAT_CAP_standard_replies` | TRUE | Enable `standard-replies` capability |
| `FEAT_CAP_message_tags` | TRUE | Enable `message-tags` capability |
| `FEAT_CAP_echo_message` | TRUE | Enable `echo-message` capability |
| `FEAT_CAP_account_tag` | TRUE | Enable `account-tag` capability |
| `FEAT_CAP_chghost` | TRUE | Enable `chghost` capability |
| `FEAT_CAP_invite_notify` | TRUE | Enable `invite-notify` capability |

### Draft Extension Features

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_CAP_no_implicit_names` | TRUE | Enable `draft/no-implicit-names` capability |
| `FEAT_CAP_extended_isupport` | TRUE | Enable `draft/extended-isupport` capability |
| `FEAT_CAP_pre_away` | TRUE | Enable `draft/pre-away` capability |
| `FEAT_CAP_multiline` | TRUE | Enable `draft/multiline` capability |
| `FEAT_CAP_chathistory` | TRUE | Enable `draft/chathistory` capability |
| `FEAT_CAP_event_playback` | TRUE | Enable `draft/event-playback` capability |
| `FEAT_CAP_message_redaction` | TRUE | Enable `draft/message-redaction` capability |
| `FEAT_CAP_account_registration` | TRUE | Enable `draft/account-registration` capability |
| `FEAT_CAP_read_marker` | TRUE | Enable `draft/read-marker` capability |
| `FEAT_CAP_channel_rename` | TRUE | Enable `draft/channel-rename` capability |
| `FEAT_CAP_metadata` | TRUE | Enable `draft/metadata-2` capability |
| `FEAT_CAP_webpush` | TRUE | Enable `draft/webpush` capability |

### Multiline Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_MULTILINE_MAX_BYTES` | 4096 | Maximum total bytes in multiline message |
| `FEAT_MULTILINE_MAX_LINES` | 100 | Maximum lines in multiline message |

### Chat History Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_CHATHISTORY_MAX` | 100 | Maximum messages returned per request |
| `FEAT_CHATHISTORY_DB` | "history" | LMDB database directory path |
| `FEAT_CHATHISTORY_RETENTION` | 7 | Days to keep messages (0 = disable purge) |
| `FEAT_CHATHISTORY_PRIVATE` | FALSE | Enable private message (DM) history |

**Retention Purge**: Messages older than `CHATHISTORY_RETENTION` days are automatically deleted via an hourly timer (`history_purge_callback`). Set to 0 to disable automatic purging.

### Metadata Caching Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_METADATA_CACHE_ENABLED` | TRUE | Enable LMDB metadata caching |
| `FEAT_METADATA_X3_TIMEOUT` | 60 | Seconds to wait for X3 before using cache-only mode |
| `FEAT_METADATA_QUEUE_SIZE` | 1000 | Maximum pending writes when X3 is unavailable |
| `FEAT_METADATA_BURST` | TRUE | Send metadata during netburst to linking servers |

**Cache-Aware Metadata**: When enabled, Nefarious maintains an LMDB-backed cache for metadata:
- **X3 Detection**: Automatically detects X3 availability via heartbeat on METADATA updates
- **Write Queue**: Queues writes when X3 is unavailable, replays when reconnected
- **Netburst**: Sends user/channel metadata to linking servers during netburst

### Presence Aggregation Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_PRESENCE_AGGREGATION` | FALSE | Enable multi-connection presence aggregation |
| `FEAT_AWAY_STAR_MSG` | "Away" | Fallback message stored for away-star connections |

**Presence Aggregation**: When enabled, the IRCd tracks all connections per account and computes an "effective" presence using "most-present-wins" logic:
1. If any connection is PRESENT → account is PRESENT
2. If all connections are AWAY (with message) → account is AWAY
3. If all connections are AWAY-STAR → account is hidden

**Away-Star**: Special away state (`AWAY *`) for hidden/background connections (e.g., mobile apps when backgrounded). These don't count toward presence.

**LMDB Persistence**: The `last_present` timestamp for each account is persisted via the METADATA LMDB backend using the reserved key `$last_present`.

**Virtual METADATA Keys**:
- `$presence` - Returns current effective presence ("present", "away:message", or "away-star")
- `$last_present` - Returns Unix timestamp of when account was last present

### Example Configuration

```
features {
    # Core IRCv3
    "MSGID" = "TRUE";
    "SERVERTIME" = "TRUE";

    # Capabilities
    "CAP_setname" = "TRUE";
    "CAP_batch" = "TRUE";
    "CAP_labeled_response" = "TRUE";
    "CAP_standard_replies" = "TRUE";

    # Draft extensions
    "CAP_multiline" = "TRUE";
    "CAP_chathistory" = "TRUE";
    "CAP_message_redaction" = "TRUE";
    "CAP_account_registration" = "TRUE";
    "CAP_read_marker" = "TRUE";
    "CAP_channel_rename" = "TRUE";
    "CAP_metadata" = "TRUE";
    "CAP_webpush" = "TRUE";

    # Limits
    "MULTILINE_MAX_BYTES" = "4096";
    "MULTILINE_MAX_LINES" = "100";
    "CHATHISTORY_MAX" = "100";
    "CHATHISTORY_DB" = "history";
    "CHATHISTORY_RETENTION" = "7";
    "CHATHISTORY_PRIVATE" = "FALSE";

    # Presence Aggregation
    "PRESENCE_AGGREGATION" = "FALSE";  # Enable for multi-connection presence
    "AWAY_STAR_MSG" = "Away";          # Fallback for away-star storage
};
```

---

## Nefarious Capability Flags

Capabilities are defined in `include/capab.h` and automatically advertised based on feature flags.

### Standard Capabilities

| Capability | Enum | CAP Name |
|------------|------|----------|
| `CAP_NAMESX` | 1 | `multi-prefix` |
| `CAP_UHNAMES` | 2 | `userhost-in-names` |
| `CAP_EXTJOIN` | 3 | `extended-join` |
| `CAP_AWAYNOTIFY` | 4 | `away-notify` |
| `CAP_ACCNOTIFY` | 5 | `account-notify` |
| `CAP_SASL` | 6 | `sasl` |
| `CAP_CAPNOTIFY` | 7 | `cap-notify` |
| `CAP_SERVERTIME` | 8 | `server-time` |
| `CAP_ECHOMSG` | 9 | `echo-message` |
| `CAP_ACCOUNTTAG` | 10 | `account-tag` |
| `CAP_CHGHOST` | 11 | `chghost` |
| `CAP_INVITENOTIFY` | 12 | `invite-notify` |
| `CAP_LABELEDRESP` | 13 | `labeled-response` |
| `CAP_BATCH` | 14 | `batch` |
| `CAP_SETNAME` | 15 | `setname` |
| `CAP_STANDARDREPLIES` | 16 | `standard-replies` |

### Draft Capabilities

| Capability | Enum | CAP Name |
|------------|------|----------|
| `CAP_DRAFT_NOIMPLICITNAMES` | 17 | `draft/no-implicit-names` |
| `CAP_DRAFT_EXTISUPPORT` | 18 | `draft/extended-isupport` |
| `CAP_DRAFT_PREAWAY` | 19 | `draft/pre-away` |
| `CAP_DRAFT_MULTILINE` | 20 | `draft/multiline` |
| `CAP_DRAFT_CHATHISTORY` | 21 | `draft/chathistory` |
| `CAP_DRAFT_EVENTPLAYBACK` | 22 | `draft/event-playback` |
| `CAP_DRAFT_REDACT` | 23 | `draft/message-redaction` |
| `CAP_DRAFT_ACCOUNTREG` | 24 | `draft/account-registration` |
| `CAP_DRAFT_READMARKER` | 25 | `draft/read-marker` |
| `CAP_DRAFT_CHANRENAME` | 26 | `draft/channel-rename` |
| `CAP_DRAFT_METADATA2` | 27 | `draft/metadata-2` |
| `CAP_DRAFT_WEBPUSH` | 28 | `draft/webpush` |

---

## X3 Services Configuration

X3 configuration is in `x3.conf` or environment variables for Docker.

### Keycloak Integration

| Setting | Environment | Description |
|---------|-------------|-------------|
| `keycloak_enable` | `X3_KEYCLOAK_ENABLE` | Enable Keycloak integration |
| `keycloak_url` | `X3_KEYCLOAK_URL` | Keycloak server URL |
| `keycloak_realm` | `X3_KEYCLOAK_REALM` | Keycloak realm name |
| `keycloak_client_id` | `X3_KEYCLOAK_CLIENT_ID` | OAuth client ID |
| `keycloak_client_secret` | `X3_KEYCLOAK_CLIENT_SECRET` | OAuth client secret |

### SASL Configuration

| Setting | Description |
|---------|-------------|
| `sasl_enable` | Enable SASL authentication |
| `sasl_timeout` | SASL authentication timeout (seconds) |

### Account Registration

| Setting | Description |
|---------|-------------|
| `email_enabled` | Require email for registration |
| `email_verify` | Require email verification |
| `email_verify_timeout` | Verification code expiry (seconds) |

### Example x3.conf Section

```
"nickserv" {
    "keycloak_enable" = "1";
    "keycloak_url" = "https://keycloak.example.com";
    "keycloak_realm" = "irc";
    "keycloak_client_id" = "x3-services";
    "keycloak_client_secret" = "secret-here";

    "sasl_enable" = "1";
    "sasl_timeout" = "30";

    "email_enabled" = "1";
    "email_verify" = "1";
    "email_verify_timeout" = "86400";
};
```

---

## Keycloak Integration

When Keycloak is enabled, X3 stores and retrieves data from Keycloak user attributes.

### User Attributes

| Attribute Prefix | Purpose |
|------------------|---------|
| `metadata.*` | IRCv3 metadata-2 key-value pairs |
| `webpush.*` | Web push subscription data |
| `readmarker.*` | Read marker timestamps |

### Attribute Format

**Metadata**:
```
metadata.avatar = "https://example.com/avatar.png"
metadata.timezone = "America/New_York"
```

**Web Push Subscriptions**:
```
webpush.{hash} = "endpoint|p256dh_base64|auth_base64"
```

**Read Markers**:
```
readmarker.#channel = "1703334400.123456"
readmarker.$nick = "1703334500.654321"
```

---

## Build Configuration

### Nefarious Configure Options

| Option | Description |
|--------|-------------|
| `--enable-websocket` | Enable WebSocket support |
| `--with-ssl` | Enable SSL/TLS support |
| `--with-geoip` | Enable GeoIP support |

### X3 Configure Options

| Option | Description |
|--------|-------------|
| `--with-keycloak` | Enable Keycloak integration (requires libcurl) |
| `--with-lmdb` | Enable LMDB metadata cache (requires liblmdb) |
| `--with-ssl` | Enable SSL/TLS support |
| `--with-ldap` | Enable LDAP support |

### X3 LMDB Configuration

When LMDB is enabled, X3 uses it as a cache layer for metadata:

| Setting | Description |
|---------|-------------|
| `services/x3/lmdb_path` | Path to LMDB database directory (default: `x3data/lmdb`) |

LMDB provides:
- **Read-through caching**: Check LMDB first, query Keycloak on cache miss
- **Write-through caching**: Write to LMDB immediately, propagate to Keycloak
- **Offline resilience**: Continue operating with cached data when Keycloak is unavailable

### Required Libraries for Web Push

| Library | Version | Purpose |
|---------|---------|---------|
| OpenSSL | 3.x+ | ECDH, AES-GCM, HKDF for RFC 8291 encryption |
| libcurl | Any | HTTP POST to push services |

### Compile-Time Checks

The `webpush.c` file checks for OpenSSL 3.x at compile time:

```c
#include <openssl/opensslv.h>
#if OPENSSL_VERSION_NUMBER >= 0x30000000L
#define HAVE_WEBPUSH_CRYPTO 1
#endif
```

If OpenSSL 3.x is not available, stub implementations are used that return errors.

---

## ISUPPORT Tokens

The following ISUPPORT tokens are advertised:

### Static Tokens

| Token | Example | Description |
|-------|---------|-------------|
| `CHATHISTORY` | `CHATHISTORY=500` | Max history messages |
| `MSGREFTYPES` | `MSGREFTYPES=timestamp,msgid` | Supported reference types |
| `ACCOUNTEXTBAN` | `ACCOUNTEXTBAN=a,R` | Account extban types |

### Dynamic Tokens

| Token | Source | Description |
|-------|--------|-------------|
| `VAPID` | X3 → Nefarious | VAPID public key for web push |

The VAPID token is set dynamically when X3 connects and broadcasts its VAPID key.

---

## P10 Protocol Extensions

### METADATAQUERY (MDQ) Token

The MDQ token enables on-demand metadata synchronization between Nefarious and X3.

**Format:**
```
[SOURCE] MDQ <target> <key|*>
```

**Examples:**
```
AB MDQ accountname *       → Query all metadata for account
AB MDQ accountname avatar  → Query specific key for account
AB MDQ #channel *          → Query all metadata for channel
AB MDQ #channel url        → Query specific key for channel
```

**Response:** Standard MD (METADATA) tokens containing the requested data.

**Use Cases:**
- Retrieving metadata for offline users from X3's storage
- On-demand sync when IRCd's LMDB cache doesn't have the data
- Channel metadata queries for registered channels

**Flow:**
1. Nefarious receives METADATA GET from client for offline user
2. Nefarious sends MDQ to X3 if data not in local cache
3. X3 looks up data in Keycloak/LMDB and responds with MD tokens
4. Nefarious caches response and forwards to client

### MARKREAD (MR) Token

The MR token enables read marker synchronization through X3 as the authoritative source.

**Formats:**
```
[SERVER] MR S <user_numeric> <target> <timestamp>  → Set marker (to X3)
[SERVER] MR G <user_numeric> <target>              → Get marker (to X3)
[X3] MR R <server> <user_numeric> <target> <ts>    → Reply (from X3)
[X3] MR <account> <target> <timestamp>             → Broadcast (from X3)
```

**Architecture:**
- X3 is the authoritative storage for read markers (LMDB + Keycloak)
- Nefarious maintains a local LMDB cache for fast lookups
- All SET operations are routed to X3, which validates and broadcasts
- Multi-device sync is natural: X3 broadcasts to all servers with matching accounts

**Flow (Set):**
1. Client sends `MARKREAD #channel timestamp=...`
2. Nefarious forwards `MR S <numeric> #channel <ts>` toward X3
3. X3 validates timestamp is newer, stores in LMDB/Keycloak
4. X3 broadcasts `MR <account> #channel <ts>` to all servers
5. Each server caches locally and notifies matching local clients

**Flow (Get):**
1. Client sends `MARKREAD #channel` (no timestamp)
2. Nefarious checks local LMDB cache first
3. If not found, forwards `MR G <numeric> #channel` to X3
4. X3 responds with `MR R <server> <numeric> #channel <ts>`
5. Response is routed back to client

**Multi-Hop Routing:**
In networks with multiple servers between client and X3, each intermediate server forwards MR S/G messages toward X3 (services server). Only X3 broadcasts, ensuring consistent ordering.

---

## Environment Variables (Docker)

### Nefarious

| Variable | Description |
|----------|-------------|
| `IRCD_SERVER_NAME` | Server name |
| `IRCD_SERVER_DESC` | Server description |
| `IRCD_UPLINK_PASSWORD` | Password for uplink connection |

### X3

| Variable | Description |
|----------|-------------|
| `X3_KEYCLOAK_ENABLE` | Enable Keycloak (1/0) |
| `X3_KEYCLOAK_URL` | Keycloak server URL |
| `X3_KEYCLOAK_REALM` | Realm name |
| `X3_KEYCLOAK_CLIENT_ID` | Client ID |
| `X3_KEYCLOAK_CLIENT_SECRET` | Client secret |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | December 2024 | Initial documentation |
| 1.1 | December 2024 | Added MDQ and MARKREAD P10 protocol documentation |

---

*This document is part of the Nefarious IRCd IRCv3.2+ upgrade project.*
