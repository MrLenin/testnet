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
| `FEAT_REGISTER_SERVER` | "*" | Target server for REGISTER command routing (use `*` for auto-detect services) |
| `FEAT_CAP_read_marker` | TRUE | Enable `draft/read-marker` capability |
| `FEAT_CAP_channel_rename` | TRUE | Enable `draft/channel-rename` capability |
| `FEAT_CAP_metadata` | TRUE | Enable `draft/metadata-2` capability |
| `FEAT_CAP_webpush` | TRUE | Enable `draft/webpush` capability |

### Multiline Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_MULTILINE_MAX_BYTES` | 4096 | Maximum total bytes in multiline message |
| `FEAT_MULTILINE_MAX_LINES` | 24 | Maximum lines in multiline message |

### Multiline Flood Protection

The multiline batch system includes comprehensive flood protection to prevent abuse while rewarding legitimate multiline usage.

**Lag Discounting**: Instead of applying fake lag immediately for each PRIVMSG in a batch, lag is accumulated during the batch and applied with a configurable discount when the batch ends. This recognizes that batched messages are transmitted simultaneously per the IRCv3 multiline spec.

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_MULTILINE_LAG_DISCOUNT` | 50 | Percentage of lag applied for DMs (0-100) |
| `FEAT_MULTILINE_CHANNEL_LAG_DISCOUNT` | 75 | Percentage of lag applied for channels (higher since more users affected) |
| `FEAT_MULTILINE_MAX_LAG` | 30 | Maximum accumulated lag in seconds (prevents extremely long batches from building massive lag debt) |
| `FEAT_MULTILINE_RECIPIENT_DISCOUNT` | TRUE | If all recipients support draft/multiline (no fallback needed), halve the discount percentage |
| `FEAT_BATCH_RATE_LIMIT` | 10 | Maximum batches per minute per client (0 = disabled) |
| `FEAT_CLIENT_BATCH_TIMEOUT` | 30 | Seconds before incomplete batch is auto-cleared |

**Discount Values**:
- `100` = Full lag (no benefit to multiline, like regular messages)
- `50` = 50% lag (default for DMs - rewards multiline while preventing abuse)
- `75` = 75% lag (default for channels - higher since more users affected)
- `0` = No lag (dangerous - allows unlimited flooding)

**Recipient-Aware Discounting**: When `MULTILINE_RECIPIENT_DISCOUNT` is enabled and ALL recipients support draft/multiline (no fallback to individual PRIVMSGs was needed), the lag discount is halved. This rewards clients for sending multiline to recipients who can properly receive it as a batch.

### WebSocket Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_DRAFT_WEBSOCKET` | TRUE | Enable WebSocket protocol support |
| `FEAT_WEBSOCKET_RECVQ` | 8192 | Receive queue size for WebSocket clients (higher than regular clients since WS frames can bundle multiple IRC lines) |

### Chat History Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_CHATHISTORY_MAX` | 100 | Maximum messages returned per request |
| `FEAT_CHATHISTORY_DB` | "history" | LMDB database directory path |
| `FEAT_CHATHISTORY_RETENTION` | 7 | Days to keep messages (0 = disable purge) |
| `FEAT_CHATHISTORY_PRIVATE` | FALSE | Enable private message (DM) history |
| `FEAT_CHATHISTORY_PRIVATE_CONSENT` | 2 | PM consent mode (0=global, 1=single-party, 2=multi-party) |
| `FEAT_CHATHISTORY_ADVERTISE_PM` | FALSE | Include `pm=` in capability value |
| `FEAT_CHATHISTORY_PM_NOTICE` | FALSE | Send policy notice on connect |
| `FEAT_CHATHISTORY_FEDERATION` | TRUE | Enable S2S chathistory queries to other servers |
| `FEAT_CHATHISTORY_TIMEOUT` | 5 | Seconds to wait for S2S federation responses |

**Retention Purge**: Messages older than `CHATHISTORY_RETENTION` days are automatically deleted via an hourly timer (`history_purge_callback`). Set to 0 to disable automatic purging.

**Federation**: When enabled, if local LMDB results are incomplete (fewer messages than requested or gaps detected), the server will query all other servers for additional messages. Results are merged and deduplicated by msgid before returning to the client. This allows clients to access history even if their connected server was down when messages were sent.

**PM Consent Modes** (CHATHISTORY_PRIVATE_CONSENT):
- **0 = Global**: All PMs stored unless either party explicitly opts out via `METADATA * SET chathistory.pm * :0`
- **1 = Single-party**: Store if sender OR recipient has opted in (explicit opt-out always overrides)
- **2 = Multi-party (default)**: Store only if BOTH sender AND recipient have opted in (most privacy-respecting)

**User Opt-In/Out**: Users control PM history storage via metadata:
```
METADATA * SET chathistory.pm * :1     # Opt-in
METADATA * SET chathistory.pm * :0     # Explicit opt-out (blocks storage in all modes)
METADATA * CLEAR chathistory.pm        # Clear preference (use server default)
```

**PM Policy Advertisement** (CHATHISTORY_ADVERTISE_PM): When enabled, adds `pm=<mode>` to the `draft/chathistory` capability value:
```
draft/chathistory=limit=100,pm=multi
draft/chathistory=limit=100,pm=single
draft/chathistory=limit=100,pm=global
```

**Connection Notice** (CHATHISTORY_PM_NOTICE): When enabled, sends a NOTE (standard-replies) or NOTICE on connect informing users of the PM storage policy and how to opt-in/out.

### Metadata Caching Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_METADATA_CACHE_ENABLED` | TRUE | Enable LMDB metadata caching |
| `FEAT_METADATA_X3_TIMEOUT` | 60 | Seconds to wait for X3 before using cache-only mode |
| `FEAT_METADATA_QUEUE_SIZE` | 1000 | Maximum pending writes when X3 is unavailable |
| `FEAT_METADATA_BURST` | TRUE | Send metadata during netburst to linking servers |
| `FEAT_METADATA_DB` | "metadata" | LMDB database directory path for metadata storage |

**Cache-Aware Metadata**: When enabled, Nefarious maintains an LMDB-backed cache for metadata:
- **X3 Detection**: Automatically detects X3 availability via heartbeat on METADATA updates
- **Write Queue**: Queues writes when X3 is unavailable, replays when reconnected
- **Netburst**: Sends user/channel metadata to linking servers during netburst
- **LMDB Path**: Configurable via `METADATA_DB` feature (default: `metadata/` relative to ircd dir)

### Compression Configuration (Nefarious)

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_COMPRESS_THRESHOLD` | 256 | Minimum value size (bytes) to trigger zstd compression |
| `FEAT_COMPRESS_LEVEL` | 3 | zstd compression level (1-22, higher = better ratio, slower) |

**Compression**: When built with `--with-zstd`, Nefarious automatically compresses LMDB-stored values (metadata, chathistory) that exceed the threshold.

**Compression Levels:**
- Level 1: Fastest, ~60% of max compression
- Level 3: Default, good balance (recommended)
- Level 9: Similar to zlib -9
- Level 19-22: Maximum compression, much slower

**Compression Passthrough (Z flag)**: When X3 sends metadata responses via the P10 `MD` token with the `Z` flag, Nefarious stores the pre-compressed data directly without recompression:
```
Az MD ABAAB avatar * Z :KLUv/QBYpQEAaHR0cHM6Ly9...
```
This eliminates unnecessary decompress/recompress cycles between services.

### Presence Aggregation Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_PRESENCE_AGGREGATION` | FALSE | Enable multi-connection presence aggregation |
| `FEAT_AWAY_STAR_MSG` | "Away" | Fallback message stored for away-star connections |
| `FEAT_AWAY_THROTTLE` | 0 | Minimum seconds between AWAY status changes (0 = disabled) |

**Presence Aggregation**: When enabled, the IRCd tracks all connections per account and computes an "effective" presence using "most-present-wins" logic:
1. If any connection is PRESENT → account is PRESENT
2. If all connections are AWAY (with message) → account is AWAY
3. If all connections are AWAY-STAR → account is hidden

**Away-Star**: Special away state (`AWAY *`) for hidden/background connections (e.g., mobile apps when backgrounded). These don't count toward presence.

**Away Throttle**: When `AWAY_THROTTLE` is set to a value > 0, users are rate-limited on how frequently they can change their away status. This prevents abuse and reduces network traffic from clients that rapidly toggle away state. The value represents the minimum seconds between AWAY command changes.

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
    "CHATHISTORY_FEDERATION" = "TRUE"; # Enable S2S chathistory queries
    "CHATHISTORY_TIMEOUT" = "5";       # Seconds to wait for S2S responses

    # Metadata caching
    "METADATA_DB" = "metadata";        # LMDB database directory
    "METADATA_BURST" = "TRUE";         # Send metadata during netburst

    # Compression (requires --with-zstd)
    "COMPRESS_THRESHOLD" = "256";      # Compress values > 256 bytes
    "COMPRESS_LEVEL" = "3";            # zstd level (1-22)

    # Presence Aggregation
    "PRESENCE_AGGREGATION" = "FALSE";  # Enable for multi-connection presence
    "AWAY_STAR_MSG" = "Away";          # Fallback for away-star storage
    "AWAY_THROTTLE" = "0";             # Seconds between AWAY changes (0 = disabled)

    # Account Registration
    "CAP_account_registration" = "TRUE";
    "REGISTER_SERVER" = "*";           # Services server for REGISTER (* = auto-detect)
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

### SASL Authentication Architecture

X3 implements a unique dual-credential SASL system that supports both account passwords and session tokens. This provides enhanced security and flexibility for IRC authentication.

#### Supported SASL Mechanisms

| Mechanism | Description |
|-----------|-------------|
| `PLAIN` | Username/password authentication (account password OR session token) |
| `EXTERNAL` | Certificate fingerprint authentication |
| `SCRAM-SHA-1` | Salted Challenge Response (session tokens and account passwords) |
| `SCRAM-SHA-256` | SCRAM with SHA-256 (recommended) |
| `SCRAM-SHA-512` | SCRAM with SHA-512 (strongest) |

#### Session Token Authentication (Unique to X3)

When a user authenticates via AuthServ (`AUTH` command), X3 generates a **session token** - a random credential that can be used for subsequent SASL authentication instead of the account password.

**Benefits:**
- Clients can store the session token instead of the plaintext password
- Session tokens can be revoked without changing the account password
- Reduced exposure of the primary password
- Enables SCRAM authentication even when account was registered with weak hash

**Flow:**
1. User authenticates: `PRIVMSG AuthServ :AUTH <account> <password>`
2. X3 validates password, generates session token, stores in LMDB
3. X3 responds with: `NOTICE <nick> :Your session cookie is: <token>`
4. Client stores token for future SASL authentication
5. On reconnect, client uses SASL PLAIN with `<account>\0<account>\0<token>`

**Session Token Storage (LMDB):**
```
Key: session:<account>
Value: <token_hash>:<created_timestamp>:<last_used_timestamp>
```

#### SCRAM Credential Storage

When LMDB and SSL are enabled, X3 generates SCRAM credentials for both session tokens and account passwords. This allows secure challenge-response authentication without transmitting passwords.

**Session Token SCRAM (created on AUTH):**
```
Key: scram:<hash_type>:<account>
Value: <salt>:<iterations>:<stored_key>:<server_key>
```

**Account Password SCRAM (created on registration/password change):**
```
Key: scram_acct:<hash_type>:<account>
Value: <salt>:<iterations>:<stored_key>:<server_key>
```

**SCRAM Parameters:**
- Salt: 32 random bytes (base64 encoded)
- Iterations: 4096 (PBKDF2)
- Hash types: SHA-1, SHA-256, SHA-512

#### Registration Flow with SCRAM

X3 supports two registration paths, both designed to enable SCRAM credentials:

**X3 Native Flow (AuthServ REGISTER/COOKIE):**

When email verification is enabled:
1. `PRIVMSG AuthServ :REGISTER <account> <password> <email>`
   - Password is hashed and stored in cookie data
2. User receives activation email with cookie code
3. `PRIVMSG AuthServ :COOKIE <account> <cookie> <password>`
   - Password required at activation for confirmation AND SCRAM creation
   - Confirms user didn't mistype password during registration
   - Provides plaintext for SCRAM credential generation
4. Account is activated with both legacy hash and SCRAM credentials

When email verification is disabled:
1. `PRIVMSG AuthServ :REGISTER <account> <password> <email>`
2. Account is created immediately with SCRAM credentials

**IRCv3 Native Flow (REGISTER/VERIFY commands):**

Per the IRCv3 `draft/account-registration` specification:
1. `REGISTER * <email> <password>` - Password provided at registration
2. `VERIFY <account> <code>` - No password in VERIFY command

For SCRAM support with email verification:
- Password is stored temporarily in `pending_scram_dict` (memory)
- On VERIFY, pending password is retrieved and SCRAM credentials created
- Pending passwords auto-expire after 24 hours
- Secure cleanup wipes password from memory

**Configuration:**
```
"nickserv" {
    "email_enabled" = "1";      // Require email for registration
    "email_verify" = "1";       // Require email verification
};
```

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

### ChanServ Keycloak Group Sync

ChanServ can synchronize channel access from Keycloak groups, using LMDB as the primary storage with periodic sync from Keycloak.

| Setting | Default | Description |
|---------|---------|-------------|
| `keycloak_access_sync` | 0 | Enable Keycloak group sync for channel access |
| `keycloak_hierarchical_groups` | 0 | Use hierarchical group paths instead of flat names |
| `keycloak_use_group_attributes` | 0 | Use `x3_access_level` group attribute for flexible access levels |
| `keycloak_bidirectional_sync` | 0 | Enable bidirectional sync (X3 changes pushed to Keycloak) |
| `keycloak_group_prefix` | (auto) | Group name/path prefix (defaults based on mode) |
| `keycloak_access_level_attr` | x3_access_level | Attribute name for numeric access level |
| `keycloak_sync_frequency` | 3600 | Sync interval in seconds (0 = startup only) |

#### Group Naming Modes

**Legacy Suffix Mode** (default, `keycloak_use_group_attributes = 0`):

Groups are named with a suffix indicating the access level:

- **Flat mode** (default): Groups named `<prefix><channel>-<level>`
  - Example: `irc-channel-#help-owner`, `irc-channel-#help-op`
  - Default prefix: `irc-channel-`

- **Hierarchical mode**: Groups at path `/<prefix>/<channel>/<level>`
  - Example: `/irc-channels/#help/owner`, `/irc-channels/#help/op`
  - Default prefix: `irc-channels`

**Access Levels** (mapped from Keycloak group suffixes):

| Suffix | Access Level | Value |
|--------|--------------|-------|
| `owner` | UL_OWNER | 500 |
| `coowner` | UL_COOWNER | 400 |
| `manager` | UL_MANAGER | 300 |
| `op` | UL_OP | 200 |
| `halfop` | UL_HALFOP | 150 |
| `peon` | UL_PEON | 1 |

#### Attribute-Based Mode (Recommended)

When `keycloak_use_group_attributes = 1`, groups use the `x3_access_level` attribute to specify any numeric access level (1-500). This provides full flexibility for custom access levels.

- **Flat mode**: Groups named `<prefix><channel>` with `x3_access_level` attribute
  - Example: `irc-channel-#help` with attribute `x3_access_level = 350`

- **Hierarchical mode**: Groups at path `/<prefix>/<channel>` with attribute
  - Example: `/irc-channels/#help` with attribute `x3_access_level = 350`

**Keycloak Group Attribute Setup**:

In Keycloak Admin Console:
1. Navigate to Groups
2. Create or select a group (e.g., `irc-channel-#help`)
3. Go to the "Attributes" tab
4. Add attribute: `x3_access_level` = `350`

Or via Keycloak Admin API:
```json
POST /admin/realms/{realm}/groups
{
  "name": "irc-channel-#help",
  "attributes": {
    "x3_access_level": ["350"]
  }
}
```

**Example Keycloak Group Hierarchies**:

```
Legacy Suffix Mode (keycloak_use_group_attributes = 0):
  irc-channel-#help-owner      → members get access level 500
  irc-channel-#help-op         → members get access level 200
  irc-channel-#support-halfop  → members get access level 150

Attribute Mode (keycloak_use_group_attributes = 1):
  irc-channel-#help-seniors    (x3_access_level=350) → level 350
  irc-channel-#help-juniors    (x3_access_level=250) → level 250
  irc-channel-#support         (x3_access_level=200) → level 200
```

**Example x3.conf Section**:

```
"chanserv" {
    // Enable Keycloak group sync
    "keycloak_access_sync" = "1";

    // Use hierarchical groups (optional, default is flat)
    "keycloak_hierarchical_groups" = "1";

    // Use attribute-based access levels (recommended for flexibility)
    "keycloak_use_group_attributes" = "1";

    // Custom prefix (optional, has smart defaults)
    "keycloak_group_prefix" = "irc-channels";

    // Custom attribute name (optional, default is x3_access_level)
    // "keycloak_access_level_attr" = "x3_access_level";

    // Sync every hour (0 = sync at startup only)
    "keycloak_sync_frequency" = "3600";
};
```

**Sync Behavior**:

1. **Startup Delay**: Initial sync runs 30 seconds after X3 starts
2. **Periodic Sync**: If `keycloak_sync_frequency > 0`, syncs repeat at that interval
3. **LMDB Primary**: All access lookups use LMDB for speed
4. **Fallback Integration**: ChanServ `_GetChannelUser()` checks LMDB if user not in SAXDB

#### Bidirectional Sync (X3 → Keycloak)

When `keycloak_bidirectional_sync = 1`, changes made through ChanServ commands are automatically pushed to Keycloak:

**Automatic Actions**:
- `ADDUSER` → Creates channel group in Keycloak, sets access level, adds user
- `CLVL` → Updates user's group membership with new access level
- `DELUSER` → Removes user from the channel group
- `UNREGISTER` → Deletes the channel group from Keycloak

**Group Structure**:
Bidirectional sync uses hierarchical paths:
```
/irc-channels/#channelname
    └── Attribute: x3_access_level = <numeric level>
    └── Members: users with access to this channel
```

**Example x3.conf with Bidirectional Sync**:

```
"chanserv" {
    "keycloak_access_sync" = "1";
    "keycloak_bidirectional_sync" = "1";
    "keycloak_use_group_attributes" = "1";
    "keycloak_hierarchical_groups" = "1";
    "keycloak_sync_frequency" = "3600";
};
```

**How It Works**:
1. User runs `/msg ChanServ ADDUSER #help JohnDoe 350`
2. X3 adds JohnDoe to internal channel access (SAXDB/LMDB)
3. X3 creates `/irc-channels/#help` group in Keycloak (if not exists)
4. X3 sets `x3_access_level = 350` attribute on the group
5. X3 adds JohnDoe to the Keycloak group
6. Periodic sync keeps Keycloak → X3 in sync (other direction)

**Note**: Bidirectional sync requires Keycloak client credentials with admin API access to create groups and manage memberships

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

### Metadata TTL (Time-To-Live)

X3 supports automatic expiration of metadata entries to prevent unbounded growth and stale data accumulation.

#### Account Metadata TTL (NickServ)

| Setting | Default | Description |
|---------|---------|-------------|
| `metadata_ttl_enabled` | 1 | Enable metadata expiry (1/0) |
| `metadata_default_ttl` | 2592000 | Default TTL in seconds (30 days) |
| `metadata_purge_frequency` | 3600 | Purge interval in seconds (1 hour) |
| `metadata_immutable_keys` | "avatar pronouns bot homepage" | Space-separated keys that never expire |

#### Channel Metadata TTL (ChanServ)

| Setting | Default | Description |
|---------|---------|-------------|
| `channel_metadata_ttl_enabled` | 1 | Enable channel metadata expiry (1/0) |
| `channel_metadata_default_ttl` | 2592000 | Default TTL in seconds (30 days) |
| `channel_immutable_keys` | "url website rules description" | Space-separated keys that never expire |

**TTL Behavior:**

- **Default TTL**: Non-immutable metadata entries expire after the configured TTL (default 30 days)
- **Immutable Keys**: Keys listed in `*_immutable_keys` never expire, ideal for user profile data (avatar, pronouns) or channel identity (url, rules)
- **Lazy Expiry**: Expired entries are deleted on read (cache miss triggers deletion)
- **Periodic Purge**: Background timer (hourly by default) sweeps and removes all expired entries
- **TTL Refresh**: Account metadata TTL is refreshed when the key is written (e.g., on metadata SET)

**Value Format (Internal):**

TTL is encoded as a prefix in the stored value:
```
[T:timestamp:][P:]value

Examples:
  T:1735689600:myvalue        → Public, expires 2025-01-01
  T:1735689600:P:myvalue      → Private, expires 2025-01-01
  myvalue                     → Public, never expires (legacy)
  P:myvalue                   → Private, never expires (legacy)
```

**Example x3.conf Section:**

```
"nickserv" {
    // Enable metadata TTL (default: enabled)
    "metadata_ttl_enabled" = "1";

    // 30 days default TTL
    "metadata_default_ttl" = "2592000";

    // Purge expired entries hourly
    "metadata_purge_frequency" = "3600";

    // These keys never expire
    "metadata_immutable_keys" = "avatar pronouns bot homepage";
};

"chanserv" {
    // Enable channel metadata TTL
    "channel_metadata_ttl_enabled" = "1";

    // 30 days default TTL
    "channel_metadata_default_ttl" = "2592000";

    // These channel keys never expire
    "channel_immutable_keys" = "url website rules description";
};
```

### X3 SSL/TLS S2S Connection

X3 supports TLS-encrypted connections to Nefarious IRCd for server-to-server (S2S) communication.

#### Uplink SSL Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `ssl` | 0 | Enable SSL for this uplink (1/0) |
| `ssl_cert` | (none) | Path to client certificate file (PEM) |
| `ssl_key` | (none) | Path to client private key file (PEM) |
| `ssl_ca` | (none) | Path to CA certificate file for server verification |
| `ssl_verify` | 0 | Verify server certificate (1/0, default off for self-signed) |
| `ssl_fingerprint` | (none) | Expected server certificate fingerprint (SHA256, hex) |

**TLS Configuration:**
- **Minimum Version**: TLS 1.2 (enforced via `SSL_CTX_set_min_proto_version()`)
- **Non-Blocking Handshake**: SSL handshake is non-blocking, compatible with X3's event loop
- **Fingerprint Verification**: Optional SHA256 fingerprint verification for self-signed certificates

**Example x3.conf Uplink Block:**

```
"uplinks" {
    "hub.example.org" {
        "address" "10.1.2.2";
        "port" "9998";
        "password" "linkpass";
        "their_password" "linkpass";
        "enabled" "1";
        "max_tries" "3";

        // SSL configuration
        "ssl" "1";
        "ssl_cert" "/data/x3.crt";           // Optional client cert
        "ssl_key" "/data/x3.key";            // Optional client key
        "ssl_verify" "0";                     // Don't verify (self-signed)
        "ssl_fingerprint" "";                 // Optional fingerprint check
    };
};
```

**Nefarious SSL Configuration:**

On the Nefarious side, enable SSL in the Connect block for X3:

```
Connect {
    name = "services.example.org";
    host = "10.1.2.3";
    password = "linkpass";
    port = 9998;
    class = "Server";
    ssl = yes;           // Enable SSL for this connection
};
```

**Build Requirement:**

SSL support requires OpenSSL and is enabled automatically when `--with-ssl` is used during configure.

### Metadata Compression (zstd)

X3 supports optional Zstandard (zstd) compression for metadata values stored in LMDB. This reduces storage requirements for large metadata values.

**Why zstd?**
- 10-20% better compression ratio than zlib
- 3-5x faster decompression than zlib
- Adjustable compression levels (1-22)
- Used by Linux kernel, PostgreSQL, MySQL, MongoDB

#### Compression Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `metadata_compress_threshold` | 256 | Minimum value size (bytes) to trigger compression |
| `metadata_compress_level` | 3 | Compression level (1-22, higher = better ratio, slower) |

**Compression Levels:**
- Level 1: Fastest, ~60% of max compression
- Level 3: Default, good balance (recommended)
- Level 9: Similar to zlib -9
- Level 19-22: Maximum compression, much slower

**Example x3.conf Configuration:**

```
"nickserv" {
    /* ... existing config ... */

    // Metadata compression (requires WITH_ZSTD)
    "metadata_compress_threshold" "256";  // Compress values > 256 bytes
    "metadata_compress_level" "3";        // zstd level 1-22
};
```

**How It Works:**
- Values below threshold are stored uncompressed
- Compressed values are prefixed with a magic byte (0x1F) for detection
- Decompression is automatic and transparent on read
- Falls back to uncompressed if compression doesn't save space
- Backward compatible: old uncompressed data is read correctly

**Compression Passthrough:**
When responding to MDQ queries from Nefarious, X3 uses `irc_metadata_raw()` to send compressed data with the P10 `Z` flag:
```
Az MD ABAAB avatar * Z :KLUv/QBYpQEAaHR0cHM6Ly9...
```
This allows Nefarious to store pre-compressed data directly in its LMDB cache without recompression, eliminating CPU overhead on both sides.

**Build Requirement:**

Compression support requires libzstd and is enabled with `--with-zstd` during configure:
```bash
./configure --with-zstd
```

Package: `libzstd-dev` (Debian/Ubuntu) or `libzstd-devel` (RHEL/Fedora)

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
| 1.2 | December 2024 | Added ChanServ Keycloak Group Sync documentation |
| 1.3 | December 2024 | Added Metadata TTL (Time-To-Live) documentation |
| 1.4 | December 2024 | Added X3 SSL/TLS S2S connection documentation |
| 1.5 | December 2024 | Added Metadata Compression (zstd) documentation |
| 1.6 | December 2024 | Added FEAT_COMPRESS_THRESHOLD, FEAT_COMPRESS_LEVEL, FEAT_METADATA_DB for Nefarious |
| 1.7 | December 2024 | Added FEAT_REGISTER_SERVER, FEAT_AWAY_THROTTLE |
| 1.8 | December 2024 | Added FEAT_CHATHISTORY_FEDERATION, FEAT_CHATHISTORY_TIMEOUT for S2S federation |
| 1.9 | December 2024 | Added Keycloak group attribute-based access levels (keycloak_use_group_attributes) |
| 2.0 | December 2024 | Added Keycloak bidirectional sync (keycloak_bidirectional_sync) - X3 auto-creates groups |
| 2.1 | January 2025 | Added SASL Authentication Architecture documentation (session tokens, SCRAM, registration flows) |

---

*This document is part of the Nefarious IRCd IRCv3.2+ upgrade project.*
