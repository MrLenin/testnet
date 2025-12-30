# P10 Protocol Reference

## Document Purpose

This document provides a comprehensive reference for the P10 server-to-server protocol as implemented in Nefarious IRCd, including all extensions added during the IRCv3.2+ upgrade project (December 2024).

**Target Audience**: IRC server developers, services developers, and anyone working with P10 protocol implementation.

---

## Table of Contents

1. [Protocol Overview](#protocol-overview)
2. [Message Format](#message-format)
3. [Numeric System](#numeric-system)
4. [Token Reference](#token-reference)
5. [New IRCv3 Extensions](#new-ircv3-extensions)
6. [SASL Protocol](#sasl-protocol)
7. [Message Tags](#message-tags)
8. [Backward Compatibility](#backward-compatibility)

---

## Protocol Overview

P10 is the server-to-server protocol used by Undernet-derived IRC servers including Nefarious IRCd. It uses numeric identifiers for servers and users, and short tokens for commands to minimize bandwidth.

### Key Characteristics

- **Numeric-based**: Servers and users identified by short alphanumeric codes
- **Token-based**: Commands use 1-2 character tokens (e.g., `P` for PRIVMSG)
- **Stateful**: Maintains network state including users, channels, modes
- **Burst model**: New server connections receive full network state

### Server Numerics

- 2-character base64 string (64 possible values per character)
- Examples: `AB`, `Az`, `00`
- Range: 0-4095 servers possible

### User Numerics

- 3-character base64 string appended to server numeric
- Full format: `ABAAB` (server `AB`, user `AAB`)
- Each server can have up to 262,144 users

### Base64 Alphabet

```
ABCDEFGHIJKLMNOPQRSTUVWXYZ
abcdefghijklmnopqrstuvwxyz
0123456789[]
```

---

## Message Format

### Standard Format

```
[ORIGIN] [TOKEN] [PARAMETERS] :[TRAILING]
```

- **ORIGIN**: Server or user numeric
- **TOKEN**: 1-2 character command identifier
- **PARAMETERS**: Space-separated arguments
- **TRAILING**: Final parameter (may contain spaces), prefixed with `:`

### With Message Tags (IRCv3 Extension)

```
@tag1=value;tag2;+clienttag [ORIGIN] [TOKEN] [PARAMETERS] :[TRAILING]
```

Tags are optional and appear at the start of the line, prefixed with `@`.

### Examples

```
# Server AB sends PING to server CD
AB G !1703334400.123456 CD

# User ABAAB sends PRIVMSG to #channel
ABAAB P #channel :Hello world

# User ABAAB sends PRIVMSG with tags
@time=2024-12-23T12:00:00.000Z;msgid=AB-1703334400-1 ABAAB P #channel :Hello
```

---

## Numeric System

### Server Registration

When servers connect, they exchange:

```
# Server introduces itself
PASS :password
SERVER servername 1 timestamp starttime numeric :description
```

### User Introduction

```
[SERVER] N nick hops timestamp ident host [+modes [mode_params...]] B64IP numeric :realname
```

Parameters are position-counted from the end:
- `-3`: Base64 IP address
- `-2`: User numeric (SSCCC format)
- `-1`: Realname/fullname

Mode parameters (when `+modes` present) appear between the modes and the final 3 parameters. **Parameter order is fixed** (regardless of mode string order):
1. `+r`: Account name (indicates user is logged in)
2. `+h`: Virtual user@host
3. `+f`: Fake host
4. `+C`: Cloaked host
5. `+c`: Cloaked IP

For example, both `+hr` and `+rh` have parameters in order: account, then vhost.

### Nick Change

```
[USER] N newnick timestamp
```

- Source is the user numeric changing their nick
- Timestamp is when the nick change occurred (Unix timestamp)
- If nick changes only in case (e.g., "Nick" → "NICK"), the existing TS is preserved

Example:
```
ABAAB N NewNick 1703334500
```

### User Introduction Examples
```
# User without modes
AB N TestUser 1 1703334400 user example.com AAAAAA ABAAB :Test User

# User with +i mode (no parameters)
AB N TestUser 1 1703334400 user example.com +i AAAAAA ABAAB :Test User

# User with +r mode (account parameter)
AB N TestUser 1 1703334400 user example.com +r TestAccount AAAAAA ABAAB :Test User

# User with +ir modes (account parameter for +r)
AB N TestUser 1 1703334400 user example.com +ir TestAccount AAAAAA ABAAB :Test User
```

### Channel Introduction

```
[SERVER] B #channel timestamp mode [limit] [key] users :%voices
```

Example:
```
AB B #test 1703334400 +nt ABAAB,ABAAC:o :%ABAAD
```

---

## Token Reference

### Core Protocol Tokens

| Token | Command | Direction | Description |
|-------|---------|-----------|-------------|
| `G` | PING | Both | Keepalive/lag check |
| `Z` | PONG | Both | Response to PING |
| `N` | NICK | Both | User introduction/nick change |
| `Q` | QUIT | Both | User disconnect |
| `B` | BURST | S→S | Channel state during burst |
| `EB` | END_OF_BURST | S→S | Burst completion signal |
| `EA` | EOB_ACK | S→S | Burst acknowledgment |
| `SQ` | SQUIT | Both | Server disconnect |
| `S` | SERVER | Both | Server introduction |
| `J` | JOIN | Both | Channel join |
| `L` | PART | Both | Channel part |
| `K` | KICK | Both | Channel kick |
| `M` | MODE | Both | Mode change |
| `P` | PRIVMSG | Both | Private message |
| `O` | NOTICE | Both | Notice message |
| `T` | TOPIC | Both | Topic change |
| `I` | INVITE | Both | Channel invitation |
| `W` | WHOIS | Both | User query |
| `X` | WHO | Both | Channel/user list |
| `A` | AWAY | Both | Away status |
| `AC` | ACCOUNT | Both | Account state change |
| `FA` | FAKEHOST | Both | Virtual host change |

### New IRCv3 Extension Tokens

| Token | Command | Direction | Description |
|-------|---------|-----------|-------------|
| `SE` | SETNAME | Both | Realname change (Phase 12) |
| `TM` | TAGMSG | Both | Tag-only message (Phase 17) |
| `BT` | BATCH | Both | Batch coordination (Phase 13d) |
| `CH` | CHATHISTORY | Both | Message history with S2S federation (Phase 32) |
| `RD` | REDACT | Both | Message redaction (Phase 27) |
| `RG` | REGISTER | Both | Account registration (Phase 24) |
| `VF` | VERIFY | Both | Account verification (Phase 24) |
| `RR` | REGREPLY | X3→Nef | Registration reply (Phase 24) |
| `MR` | MARKREAD | Both | Read marker sync (Phase 25) |
| `RN` | RENAME | Both | Channel rename (Phase 28) |
| `MD` | METADATA | Both | User/channel metadata (Phase 29) |
| `MDQ` | METADATAQUERY | Both | Metadata query to services (Phase 29) |
| `WP` | WEBPUSH | Both | Web push notifications (Phase 30) |
| `ML` | MULTILINE | Both | S2S multiline batch propagation (Phase 31) |

### SASL Tokens

| Token | Command | Direction | Description |
|-------|---------|-----------|-------------|
| `SA` | SASL | Both | SASL authentication |

---

## New IRCv3 Extensions

### SETNAME (SE) - Phase 12

**Purpose**: Allow users to change their realname (GECOS) mid-session.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/setname

#### P10 Format

```
[USER_NUMERIC] SE :[NEW_REALNAME]
```

#### Examples

```
# User ABAAB changes realname
ABAAB SE :New Real Name

# Maximum length: REALLEN (50 characters)
```

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| USER_NUMERIC | String(5) | 5-character user numeric |
| NEW_REALNAME | String(1-50) | New realname, truncated if too long |

#### Processing

**Sender (Nefarious)**:
1. Client sends `SETNAME :new name`
2. Validate length (max 50 chars)
3. Update `cli_info(sptr)`
4. Send `SE :[name]` to all servers
5. Notify local channel members with `setname` capability

**Receiver (Nefarious)**:
1. Parse SE command from server
2. Validate sender is not a server
3. Update `cli_info(sptr)`
4. Propagate to other servers
5. Notify local channel members

**Services (X3)**:
- Can safely ignore SE commands
- Realname changes are informational only

---

### TAGMSG (TM) - Phase 17

**Purpose**: Send messages containing only tags (no text content). Used for typing indicators, reactions, and other metadata.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/message-tags

#### P10 Format

```
[USER_NUMERIC] TM @[TAGS] [TARGET]
```

#### Examples

```
# Typing indicator to channel
ABAAB TM @+typing=active #channel

# Typing indicator to user
ABAAB TM @+typing=paused BBAAC

# Multiple tags
ABAAB TM @+typing=active;+react=thumbsup #channel
```

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| USER_NUMERIC | String(5) | 5-character sender numeric |
| @TAGS | Tag string | Client-only tags (must be prefixed with `+`) |
| TARGET | String | Channel name or user numeric |

#### Tag Format

Tags follow IRCv3 message-tags specification:
- Semicolon-separated key=value pairs
- Client-only tags MUST be prefixed with `+`
- Values are optional (e.g., `+typing` without value is valid)
- Special characters escaped per IRCv3 spec

#### Common Tags

| Tag | Values | Purpose |
|-----|--------|---------|
| `+typing` | `active`, `paused`, `done` | Typing indicator |
| `+reply` | msgid reference | Reply to specific message |
| `+react` | emoji or text | Reaction to message |

#### Processing

**Sender (Nefarious)**:
1. Client sends `@+typing=active TAGMSG #channel`
2. Extract client-only tags from message
3. Validate target exists and is accessible
4. Relay to local recipients with `message-tags` capability
5. Send `TM @+typing=active #channel` to servers

**Receiver (Nefarious)**:
1. Parse TM command with @tags parameter
2. Validate target (channel or user numeric)
3. Relay to local recipients with `message-tags` capability
4. Propagate to other servers

**Services (X3)**:
- Ignores TAGMSG commands
- No action needed for typing indicators

---

### BATCH (BT) - Phase 13d

**Purpose**: Coordinate batch markers across servers for grouped events like netjoin/netsplit.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/batch

#### P10 Format

**Start Batch**:
```
[SERVER_NUMERIC] BT +[BATCH_ID] [TYPE] [PARAMS...]
```

**End Batch**:
```
[SERVER_NUMERIC] BT -[BATCH_ID]
```

#### Examples

```
# Server AB starts netjoin batch
AB BT +AB1703334400 netjoin CD irc.remote.com

# Server AB ends netjoin batch
AB BT -AB1703334400

# Netsplit batch
AB BT +AB1703334401 netsplit CD irc.remote.com
AB BT -AB1703334401
```

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| SERVER_NUMERIC | String(2) | 2-character server numeric |
| +BATCH_ID | String | Unique identifier prefixed with `+` for start |
| -BATCH_ID | String | Batch identifier prefixed with `-` for end |
| TYPE | String | Batch type (`netjoin` or `netsplit`) |
| PARAMS | String... | Type-specific parameters |

#### Batch ID Format

```
[SERVER_NUMERIC][TIMESTAMP_OR_SEQUENCE]
```

Example: `AB1703334400` (server AB, timestamp-based)

#### Batch Types

| Type | Parameters | Description |
|------|------------|-------------|
| `netjoin` | server_numeric server_name | Server reconnecting to network |
| `netsplit` | server_numeric server_name | Server disconnecting from network |

#### Processing

**Netjoin (Automatic)**:
1. Server connects with junction flag
2. `send_netjoin_batch_start()` generates batch ID
3. Batch ID stored in `struct Server->batch_id`
4. All user introductions tagged with `@batch=id` for local clients
5. On END_OF_BURST: `send_netjoin_batch_end()`

**Netsplit (Automatic)**:
1. SQUIT received
2. `send_netsplit_batch_start()` generates batch ID
3. All QUIT messages tagged with `@batch=id` for local clients
4. After processing: `send_netsplit_batch_end()`

**Services (X3)**:
- Ignores BT commands
- Batch markers are for client display only

---

### CHATHISTORY (CH) - Phase 23

**Purpose**: Query message history for playback to clients, with S2S federation for distributed access.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/chathistory

#### Architecture

Chathistory uses a **federated query** model:
- Each server stores all channel messages in local LMDB (messages are relayed S2S)
- Clients query their connected server via the `CHATHISTORY` client command
- When local results are incomplete, servers query peers for additional messages
- Results are merged and deduplicated by msgid before returning to client
- X3 does not participate in chathistory

#### Client Command Format

```
CHATHISTORY <subcommand> <target> [params...]
```

#### Client Subcommands

| Subcommand | Parameters | Description |
|------------|------------|-------------|
| `LATEST` | target \* limit | Latest messages |
| `BEFORE` | target msgid/timestamp limit | Messages before reference |
| `AFTER` | target msgid/timestamp limit | Messages after reference |
| `AROUND` | target msgid/timestamp limit | Messages around reference |
| `BETWEEN` | target start end limit | Messages in range |
| `TARGETS` | timestamp timestamp limit | Recent conversation targets |

#### Reference Format

References can be:
- `*` - No reference (for LATEST)
- `timestamp=1735128000` - Unix timestamp
- `msgid=AB-1703334400-123` - Message ID

#### S2S P10 Protocol

The S2S format is optimized for efficiency (single-char subcmd, compact reference format).

**Query** - Request history from other servers:
```
[SERVER] CH Q <target> <subcmd> <ref> <limit> <reqid>
```

**Response** - Send messages back to requester:
```
[SERVER] CH R <reqid> <msgid> <timestamp> <type> <sender> <account> :<content>
```

**End** - Signal end of response:
```
[SERVER] CH E <reqid> <count>
```

#### S2S Subcmd Codes

| Code | Client Command | Description |
|------|----------------|-------------|
| `L` | LATEST | Latest messages |
| `B` | BEFORE | Messages before reference |
| `A` | AFTER | Messages after reference |
| `R` | AROUND | Messages around reference |
| `W` | BETWEEN | Messages between two references |
| `T` | TARGETS | Channels with recent activity |

#### S2S Reference Format

| Format | Description | Example |
|--------|-------------|---------|
| `*` | No reference | `*` |
| `<timestamp>` | Unix timestamp (starts with digit) | `1735689600.123` |
| `<msgid>` | Message ID (starts with server numeric) | `AB-1703334400-123` |

**Disambiguation**: Timestamps always start with a digit (0-9), while msgids start with a server numeric (A-Z, a-z). No prefix needed.

#### S2S Fields

| Field | Type | Description |
|-------|------|-------------|
| SERVER | String(2) | Server numeric |
| target | String | Channel name |
| subcmd | Char(1) | Single-char code (L/B/A/R/W/T) |
| ref | String | Reference (`*`, timestamp, or msgid) |
| limit | Number | Maximum messages requested |
| reqid | String | Request ID for correlating responses |
| msgid | String | Unique message ID |
| timestamp | Number | Unix timestamp (seconds.milliseconds) |
| type | Number | Message type (0=PRIVMSG, 1=NOTICE, 2=JOIN, etc.) |
| sender | String | nick!user@host |
| account | String | Account name or `*` if none |
| content | String | Message content |

#### S2S Message Types

| Value | Type | Description |
|-------|------|-------------|
| 0 | PRIVMSG | Channel/private message |
| 1 | NOTICE | Notice |
| 2 | JOIN | User joined channel |
| 3 | PART | User left channel |
| 4 | QUIT | User disconnected |
| 5 | KICK | User was kicked |
| 6 | MODE | Channel mode change |
| 7 | TOPIC | Topic change |
| 8 | TAGMSG | Tag-only message |

#### S2S Examples

```
# Server AB requests latest 50 messages for #channel (L=LATEST, *=no ref)
AB CH Q #channel L * 50 AB1735300000

# Server AB requests messages before a timestamp (B=BEFORE)
AB CH Q #channel B 1735299000.500 50 AB1735300001

# Server AB requests messages after a msgid (A=AFTER)
AB CH Q #channel A CD-1735299000-1 50 AB1735300002

# Server CD responds with messages
CD CH R AB1735300000 CD-1735299000-1 1735299000.123 0 nick!user@host account :Hello world
CD CH R AB1735300000 CD-1735299001-2 1735299001.456 0 other!u@h * :Hi there
CD CH E AB1735300000 2

# Server EF has no additional messages
EF CH E AB1735300000 0
```

#### Federation Flow

1. Client sends `CHATHISTORY LATEST #channel * 50`
2. Server queries local LMDB, gets N messages
3. If N < limit or gaps detected, broadcast `CH Q` (with efficient format) to all servers
4. Each server queries its LMDB and responds with `CH R` messages
5. Requester collects responses until timeout or all `CH E` received
6. Merge all messages, deduplicate by msgid, sort by timestamp
7. Send final result batch to client

#### Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_CHATHISTORY_MAX` | 100 | Maximum messages per request |
| `FEAT_CHATHISTORY_DB` | "history" | LMDB database directory |
| `FEAT_CHATHISTORY_RETENTION` | 7 | Days to keep messages (0 = forever) |
| `FEAT_CHATHISTORY_PRIVATE` | FALSE | Enable private message history |
| `FEAT_CHATHISTORY_FEDERATION` | TRUE | Enable S2S chathistory queries |
| `FEAT_CHATHISTORY_TIMEOUT` | 5 | Seconds to wait for S2S responses |

---

### REDACT (RD) - Phase 27

**Purpose**: Request deletion of a previously sent message.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/message-redaction

#### P10 Format

```
[USER_NUMERIC] RD [TARGET] [MSGID] :[REASON]
```

#### Example

```
ABAAB RD #channel AB-1703334400-123 :Removing inappropriate content
```

---

### REGISTER (RG) - Phase 24

**Purpose**: Account registration during IRC connection.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/account-registration

#### P10 Format

```
[SERVER] RG [USER_NUMERIC] [ACCOUNT] [EMAIL] :[PASSWORD_HASH]
```

---

### VERIFY (VF) - Phase 24

**Purpose**: Account verification code submission.

#### P10 Format

```
[SERVER] VF [USER_NUMERIC] [ACCOUNT] [CODE]
```

---

### REGREPLY (RR) - Phase 24

**Purpose**: Registration result from services.

#### P10 Format

```
[X3] RR [TARGET_SERVER] [USER_NUMERIC] [RESULT] :[MESSAGE]
```

#### Result Codes

| Code | Meaning |
|------|---------|
| `OK` | Registration successful |
| `VERIFY` | Verification needed |
| `FAIL` | Registration failed |

---

### MARKREAD (MR) - Phase 25

**Purpose**: Synchronize read marker position across clients via X3 services.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/read-marker

Read markers are routed through X3 as the authoritative storage, enabling natural multi-device synchronization.

#### P10 Format

**Set Marker** (Nefarious → X3):
```
[SERVER] MR S [USER_NUMERIC] [TARGET] [TIMESTAMP]
```

**Get Marker** (Nefarious → X3):
```
[SERVER] MR G [USER_NUMERIC] [TARGET]
```

**Get Response** (X3 → Nefarious):
```
[X3] MR R [TARGET_SERVER] [USER_NUMERIC] [TARGET] [TIMESTAMP]
```

**Broadcast Update** (X3 → All Servers):
```
[X3] MR [ACCOUNT] [TARGET] [TIMESTAMP]
```

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| USER_NUMERIC | String(5) | 5-character user numeric |
| TARGET | String | Channel name or nick |
| TIMESTAMP | Number | Unix timestamp (or `*` if unknown) |
| TARGET_SERVER | String(2) | Server numeric to route reply to |
| ACCOUNT | String | Account name for broadcast |

#### Examples

```
# Client sets read marker - Nefarious forwards to X3
AB MR S ABAAB #channel 1735689600

# X3 stores and broadcasts to all servers
Az MR accountname #channel 1735689600

# Client queries read marker - Nefarious forwards to X3
AB MR G ABAAB #channel

# X3 replies with stored timestamp
Az MR R AB ABAAB #channel 1735689600
```

#### Multi-Hop Routing

MARKREAD messages route through intermediate servers toward X3:

```
Client → ServerA → ServerB → X3
           |          |
           +--(MR S)--+----> X3 stores, broadcasts
                             |
X3 → ServerB → ServerA → Client (MR broadcast)
```

Each intermediate server:
1. Receives `MR S` or `MR G` - forwards toward X3 (services server)
2. Receives broadcast `MR <account>` - notifies local clients, propagates to other servers

#### Processing

**Nefarious (m_markread - client handler)**:
1. Client sends `MARKREAD #channel timestamp=...`
2. Find services server
3. Send `MR S <numeric> #channel <timestamp>` to X3
4. Also store locally in LMDB cache (if available)
5. Notify local clients with same account

**Nefarious (ms_markread - server handler)**:
1. Parse MR subcommand (S, G, R, or broadcast)
2. For S/G: forward toward X3 if not from services
3. For R: route reply to user's server, deliver to client
4. For broadcast: cache locally, notify local clients, propagate

**X3 (cmd_markread)**:
1. For S: Validate newer timestamp, store in LMDB and Keycloak, broadcast
2. For G: Look up in LMDB, send R reply with timestamp (or `*`)

---

### RENAME (RN) - Phase 28

**Purpose**: Channel rename operation.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/channel-rename

#### P10 Format

```
[USER_NUMERIC] RN [OLD_CHANNEL] [NEW_CHANNEL] :[REASON]
```

#### Example

```
ABAAB RN #oldname #newname :Rebranding
```

---

### METADATA (MD) - Phase 29

**Purpose**: User and channel metadata synchronization with visibility support.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/metadata

#### P10 Format

**Set Metadata with Visibility**:
```
[SOURCE] MD [TARGET] [KEY] [VISIBILITY] :[VALUE]
```

**Set Metadata with Compression Passthrough (Z flag)**:
```
[SOURCE] MD [TARGET] [KEY] [VISIBILITY] Z :[BASE64_COMPRESSED_VALUE]
```

**Clear Metadata**:
```
[SOURCE] MD [TARGET] [KEY]
```

#### Visibility Tokens

| Token | Meaning |
|-------|---------|
| `*` | Public - visible to everyone |
| `P` | Private - visible only to owner and opers |

#### Compression Flag (Z)

The optional `Z` flag indicates:
- Value is zstd-compressed
- Value is base64-encoded (for safe P10 transmission)
- Receiver should decode + store directly without recompression

This enables compressed data passthrough between X3 and Nefarious LMDB caches, eliminating unnecessary decompress/recompress cycles.

#### Examples

```
# Set user avatar (public)
ABAAB MD ABAAB avatar * :https://example.com/avatar.png

# Set private user data
ABAAB MD ABAAB secret P :private-value

# Set channel description (public)
AB MD #channel description * :Welcome to our channel

# Set compressed metadata (Z flag)
Az MD ABAAB avatar * Z :KLUv/QBYpQEAaHR0cHM6Ly9...

# Clear metadata (visibility not needed)
ABAAB MD ABAAB avatar
```

#### Processing

**Sender (Nefarious)**:
1. Client sends `METADATA * SET key [visibility] :value`
2. Parse visibility (`*` or `private`) - defaults to public
3. Store in in-memory metadata + LMDB for logged-in users
4. Send `MD target key visibility :value` to servers

**Receiver (X3)**:
1. Parse visibility token (`*` or `P`)
2. Store in Keycloak with visibility prefix for private values
3. Only send back to user's connections on login

---

### METADATAQUERY (MDQ) - Phase 29

**Purpose**: Query metadata for offline users or cached data from X3 services.

**Use Case**: When a client requests metadata for a user not currently online, Nefarious queries X3 (the authoritative source) for persisted metadata.

#### P10 Format

**Query** (Nefarious → X3):
```
[SOURCE] MDQ [TARGET] [KEY|*]
```

**Response** (X3 → Nefarious):
Uses standard MD tokens to return requested metadata.

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| SOURCE | String(2-5) | Server or user numeric |
| TARGET | String | Account name or channel name |
| KEY | String | Specific key to query, or `*` for all keys |

#### Examples

```
# Query all metadata for an account
AB MDQ accountname *

# Query specific key for an account
AB MDQ accountname avatar

# Query channel metadata
AB MDQ #channel *

# Query specific channel key
AB MDQ #channel url
```

#### Multi-Hop Routing

In networks with multiple Nefarious servers between client and X3:

```
Client → ServerA → ServerB → X3
           ↓
    (forward MDQ)
           ↓
         ServerB → X3
           ↓
    (MD response)
           ↓
         ServerB → ServerA → Client
```

Each intermediate server:
1. Checks if X3 is available (via heartbeat detection)
2. If X3 available: forwards MDQ toward X3
3. If X3 unavailable: answers from local LMDB cache (graceful degradation)

#### Processing

**Sender (Nefarious)**:
1. Client sends `METADATA * GET account key`
2. User not online - check local LMDB cache
3. Cache miss - send `MDQ account key` toward X3
4. Track pending request with timeout (30 seconds)

**Intermediate (Nefarious)**:
1. Receive MDQ from another server
2. If from services: process as response, deliver to waiting clients
3. If X3 available: forward toward X3 (services server)
4. If X3 unavailable: answer from local LMDB cache

**Receiver (X3)**:
1. Parse MDQ command
2. Look up metadata in Keycloak/LMDB
3. Respond with MD tokens for each key-value pair
4. MD responses include visibility (`*` public, `P` private)

**Response Handling (Nefarious)**:
1. Receive MD tokens from X3 (IsService check)
2. Cache in local LMDB for future queries
3. Find pending MDQ requests for this target/key
4. Forward METADATA response to waiting clients
5. Clean up request tracking

#### Timeout Handling

- Requests timeout after 30 seconds (`METADATA_REQUEST_TIMEOUT`)
- Maximum 100 pending requests (`METADATA_MAX_PENDING`)
- Expired requests cleaned up in main loop (ping check interval)
- Client notified via `FAIL METADATA TEMPORARILY_UNAVAILABLE`

---

### WEBPUSH (WP) - Phase 30

**Purpose**: Web push notification support via X3 services.

**IRCv3 Spec**: https://github.com/ircv3/ircv3-specifications/pull/471

#### P10 Format

**VAPID Key Broadcast** (X3 → Nefarious):
```
[X3] WP V :[VAPID_PUBKEY_BASE64URL]
```

**Register Subscription** (Nefarious → X3):
```
[SERVER] WP R [USER_NUMERIC] [ENDPOINT] [P256DH] [AUTH]
```

**Unregister Subscription** (Nefarious → X3):
```
[SERVER] WP U [USER_NUMERIC] [ENDPOINT]
```

**Push Request** (Nefarious → X3):
```
[SERVER] WP P [ACCOUNT_NAME] :[MESSAGE]
```

**Error Response** (X3 → Nefarious):
```
[X3] WP E [USER_NUMERIC] [CODE] :[MESSAGE]
```

#### Subcommand Codes

| Code | Direction | Description |
|------|-----------|-------------|
| `V` | X3→Nef | VAPID public key broadcast |
| `R` | Nef→X3 | Register push subscription |
| `U` | Nef→X3 | Unregister push subscription |
| `P` | Nef→X3 | Request push delivery |
| `E` | X3→Nef | Error response to client |

#### Security

- Endpoints must be HTTPS
- Internal/private IPs blocked (localhost, 10.x, 192.168.x, etc.)
- Subscriptions stored in Keycloak as `webpush.*` attributes
- RFC 8291 encryption (ECDH + AES-128-GCM)
- RFC 8292 VAPID signing (ECDSA P-256)

---

### AWAY (A) - Presence Aggregation Extension

**Purpose**: User away status management with multi-connection presence aggregation support.

**IRCv3 Specs**:
- https://ircv3.net/specs/extensions/away-notify
- https://ircv3.net/specs/extensions/pre-away

#### Standard P10 Format

```
[USER_NUMERIC] A :[AWAY_MESSAGE]    # Set away with message
[USER_NUMERIC] A                    # Clear away (back/present)
```

#### Extended Format (Away-Star)

```
[USER_NUMERIC] A *                  # Hidden connection (away-star)
```

**Away-Star** is a special away state indicating a "hidden" connection that should not count toward presence aggregation. Mobile clients use this when backgrounded.

#### Examples

```
# User sets normal away
ABAAB A :Be right back

# User clears away (back to present)
ABAAB A

# User sets away-star (hidden/mobile backgrounded)
ABAAB A *
```

#### Presence States

| State | Away Message | Description |
|-------|--------------|-------------|
| Present | (none) | User is actively present |
| Away | Non-`*` message | User is away with message |
| Away-Star | `*` only | Hidden connection (doesn't count as present) |

#### Presence Aggregation (Multi-Connection)

When `FEAT_PRESENCE_AGGREGATION` is enabled, the IRCd aggregates presence across all connections for the same account:

| Priority | State | Effective Presence |
|----------|-------|-------------------|
| 1 (highest) | Any connection PRESENT | Account is PRESENT |
| 2 | Any connection AWAY (not away-star) | Account is AWAY |
| 3 (lowest) | All connections AWAY-STAR | Account is hidden |

**Broadcast Suppression**: With aggregation enabled, AWAY broadcasts only occur when the *effective* presence changes, not on every individual connection's state change.

#### Feature Flags

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_PRESENCE_AGGREGATION` | OFF | Enable multi-connection aggregation |
| `FEAT_AWAY_STAR_MSG` | "Away" | Fallback message for away-star storage |

#### Processing

**Sender (Nefarious)**:
1. Client sends `AWAY [:message]` or `AWAY *`
2. Update local away state
3. If aggregation enabled for logged-in user:
   - Update connection registry
   - Compute effective presence
   - Only broadcast if effective state changed
4. Send `A [:message]` or `A *` to servers

**Receiver (Nefarious/X3)**:
1. Parse `A` token
2. Check for `*` (away-star) vs normal message
3. Update user's away state
4. If aggregation enabled, update presence registry
5. Propagate to other servers

**Pre-Away (Unregistered Clients)**:
Clients with `draft/pre-away` capability can set away state before registration completes:
- `AWAY *` during registration → connection starts as away-star
- Applied when registration completes (`register_user`)

---

### MULTILINE (ML) - Phase 31

**Purpose**: Propagate multiline message batches between servers (S2S relay).

**IRCv3 Spec**: https://ircv3.net/specs/extensions/multiline

#### P10 Format

**Start Batch + First Line**:
```
[USER_NUMERIC] ML +batchid target :first_line
```

**Normal Continuation**:
```
[USER_NUMERIC] ML batchid target :line
```

**Concat Continuation** (line should be concatenated to previous without newline):
```
[USER_NUMERIC] ML cbatchid target :line
```

**End Batch**:
```
[USER_NUMERIC] ML -batchid target :
```

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| USER_NUMERIC | String(5) | 5-character sender numeric |
| batchid | String | Unique batch identifier |
| target | String | Channel name or user nick |
| :line | String | Message text (may be empty for end) |

#### Batch ID Format

```
[USER_YXXID][TIMESTAMP]
```

Example: `AzAAB1735308000` (user AzAAB, Unix timestamp)

#### Modifier Prefixes

| Prefix | Meaning |
|--------|---------|
| `+` | Start new batch (includes first message) |
| `-` | End batch (text may be empty) |
| `c` | Concat continuation (no newline separator) |
| (none) | Normal continuation (newline separator) |

#### Examples

```
# User ABAAB sends multiline to #channel
ABAAB ML +ABAAB1735308000 #channel :First line of message
ABAAB ML ABAAB1735308000 #channel :Second line
ABAAB ML cABAB1735308000 #channel :continued without newline
ABAAB ML -ABAAB1735308000 #channel :

# User ABAAB sends multiline to user BBAAC
ABAAB ML +ABAAB1735308001 BBAAC :Hello
ABAAB ML ABAAB1735308001 BBAAC :This is a multiline message
ABAAB ML -ABAAB1735308001 BBAAC :
```

#### Processing

**Sender (Nefarious - originating server)**:
1. Client completes multiline BATCH with `-batchid`
2. `process_multiline_batch()` validates target and permissions
3. Delivers to local clients (as BATCH for multiline-capable, individual PRIVMSG otherwise)
4. Sends `ML +batchid target :first_line` to all other servers
5. Sends continuation lines with `ML batchid` or `ML cbatchid`
6. Sends `ML -batchid target :` to end batch

**Receiver (Nefarious - remote server)**:
1. `ms_multiline()` receives ML command
2. Propagates to other servers (except source)
3. On `+`: Creates `S2SMultilineBatch` struct, stores first line
4. On normal/concat: Adds line to batch with concat flag
5. On `-`: Delivers batch to local clients via `deliver_s2s_multiline_batch()`
6. Frees batch structure

**Batch Storage**:
- Pending batches stored in `s2s_ml_batches[]` array
- Maximum `MAXCONNECTIONS` concurrent batches
- Batches include: sender, target, message list, concat flags

#### Related Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_MULTILINE_MAX_BYTES` | 4096 | Maximum total bytes in multiline message |
| `FEAT_MULTILINE_MAX_LINES` | 100 | Maximum lines in multiline message |
| `FEAT_CLIENT_BATCH_TIMEOUT` | 60 | Seconds before client batch times out |

---

## SASL Protocol

### Overview

SASL authentication uses the SA token with subcmd codes to coordinate between IRC server and services.

### P10 Format

```
[ORIGIN] SA [TARGET] [TOKEN] [SUBCMD] :[DATA]
```

### Subcmd Codes

| Code | Direction | Description |
|------|-----------|-------------|
| `S` | Nef→X3 | Start SASL session (mechanism selection) |
| `H` | Nef→X3 | Host information (`user@host:ip`) |
| `C` | Both | Continue (authentication data exchange) |
| `D` | X3→Nef | Done with result code (`S`=success, `F`=fail, `A`=abort) |
| `L` | X3→Nef | Login information (`account timestamp`) |
| `M` | X3→Nef | Mechanism list broadcast |
| `I` | X3→Nef | Impersonation (for special cases) |

### Session Flow

```
Client                Nefarious              X3
   |                      |                   |
   +--CAP REQ :sasl------>|                   |
   |<--CAP ACK :sasl------|                   |
   +--AUTHENTICATE PLAIN->|                   |
   |                      |--SA target S PLAIN|
   |                      |--SA target H info-|
   |                      |<--SA target C +----|
   |<--AUTHENTICATE +-----|                   |
   +--AUTHENTICATE data-->|                   |
   |                      |--SA target C data-|
   |                      |<--SA target L acct|
   |                      |<--SA target D S---|
   |<--903 SASL success---|                   |
```

### Mechanism Broadcast (M Subcmd)

**Purpose**: Dynamically advertise available SASL mechanisms.

**Direction**: X3 → Nefarious (broadcast)

```
[X3_NUMERIC] SA * * M :[MECHANISM_LIST]
```

**Example**:
```
Az SA * * M :PLAIN,EXTERNAL,OAUTHBEARER
```

**When Sent**:
1. After X3 completes burst (EOB acknowledgment)
2. When Keycloak availability changes
3. When any authentication backend status changes

**Nefarious Handling**:
- Stores mechanism list in global `SaslMechanisms[]`
- Used in CAP LS 302 response: `sasl=PLAIN,EXTERNAL,OAUTHBEARER`

### Re-Authentication

Re-authentication (e.g., OAuth token refresh) uses the standard AUTHENTICATE flow:

1. Client sends `AUTHENTICATE OAUTHBEARER`
2. Nefarious clears `SASLComplete` flag
3. SASL session state reset
4. Standard SASL flow proceeds with `S` subcmd
5. On success: account updated, ACCOUNT notification sent

**Note**: A separate REAUTHENTICATE command and `R` subcmd were originally planned but determined unnecessary. The existing flow handles re-authentication correctly.

---

## Message Tags

### Overview

P10 messages can optionally include IRCv3 message tags as a prefix. This enables features like server-time, msgid, and client-only tags.

### Format

```
@tag1=value;tag2;+clienttag=value [REST_OF_P10_MESSAGE]
```

### Tag Syntax

- Tags prefixed with `@` at start of line
- Multiple tags separated by `;`
- Tag values after `=` (optional)
- Client-only tags prefixed with `+`
- Tag section ends at first space

### Examples

```
# Message with time and msgid tags
@time=2024-12-23T12:00:00.000Z;msgid=AB-1703334400-1 ABAAB P #channel :Hello

# TAGMSG with client-only tags
ABAAB TM @+typing=active #channel
```

### Server Tags

| Tag | Description | Propagate S2S? |
|-----|-------------|----------------|
| `time` | ISO 8601 timestamp | Yes |
| `msgid` | Unique message identifier | Yes |
| `batch` | Batch reference ID | Yes |
| `account` | Sender's account name | No (use AC) |
| `label` | Command correlation | No (client-local) |
| `bot` | Bot mode indicator | No (via user modes) |

### Client-Only Tags

| Tag | Description | Propagate S2S? |
|-----|-------------|----------------|
| `+typing` | Typing indicator | Yes (via TAGMSG) |
| `+reply` | Reply reference | Yes (via TAGMSG) |
| `+react` | Reaction | Yes (via TAGMSG) |

### Tag Processing

**Nefarious Parser** (`parse_server()` in parse.c):
```c
/* Skip IRCv3 message tags if present */
if (buffer[0] == '@') {
    char *tag_end = strchr(buffer, ' ');
    if (tag_end)
        buffer = tag_end + 1;
}
```

**X3 Parser** (`parse_line()` in proto-p10.c):
```c
/* Skip IRCv3 message tags if present */
if (line[0] == '@') {
    char *tag_end = strchr(line, ' ');
    if (tag_end)
        line = tag_end + 1;
}
```

### Msgid Generation

Message IDs are generated with the format:
```
[SERVER_NUMERIC]-[STARTUP_TIMESTAMP]-[COUNTER]
```

Example: `AB-1703334400-12345`

This ensures uniqueness across the network while maintaining a consistent format.

---

## Backward Compatibility

### Design Principles

All P10 extensions are designed for backward compatibility:

1. **Unknown tokens ignored**: Old servers skip unrecognized tokens
2. **Tag prefix skipped**: Old parsers ignore `@...` prefix
3. **Optional features**: All IRCv3 features are opt-in via CAP

### Compatibility Matrix

| Message Type | Old Nefarious | New Nefarious | Old X3 | New X3 |
|--------------|---------------|---------------|--------|--------|
| SE (SETNAME) | Ignored | Processed | Ignored | Ignored |
| TM (TAGMSG) | Ignored | Processed | Ignored | Ignored |
| BT (BATCH) | Ignored | Processed | Ignored | Ignored |
| CH (CHATHISTORY) | Ignored | Processed | Ignored | Ignored |
| RD (REDACT) | Ignored | Processed | Ignored | Ignored |
| RN (RENAME) | Ignored | Processed | Ignored | Processed |
| MD (METADATA) | Ignored | Processed | Ignored | Processed |
| MR (MARKREAD) | Ignored | Processed | Ignored | Processed |
| WP (WEBPUSH) | Ignored | Processed | N/A | Processed |
| SA M (mechanisms) | Ignored | Processed | N/A | Sent |
| ML (MULTILINE) | Ignored | Processed | Ignored | Ignored |
| @tags prefix | Possible error | Parsed & skipped | Error | Skipped |

### Mixed Network Behavior

In a network with mixed old/new servers:
- New tokens are silently dropped at old server boundaries
- Tags are stripped when passing through old servers
- Core protocol functionality unaffected

**Note**: Feature flags are documented in [FEATURE_FLAGS_CONFIG.md](FEATURE_FLAGS_CONFIG.md).

---

## Quick Reference

### New Tokens Summary

| Token | Format | Purpose |
|-------|--------|---------|
| `SE` | `[NUMERIC] SE :[realname]` | Change realname |
| `TM` | `[NUMERIC] TM @[tags] [target]` | Tag-only message |
| `BT` | `[NUMERIC] BT +/-[id] [type] [params]` | Batch coordination |
| `CH` | `[SERVER] CH [Q\|R\|E] [params...]` | S2S chathistory federation |
| `RD` | `[NUMERIC] RD [target] [msgid] :[reason]` | Message redaction |
| `RG` | `[SERVER] RG [user] [account] [email] :[pass]` | Account registration |
| `VF` | `[SERVER] VF [user] [account] [code]` | Verification |
| `RR` | `[X3] RR [server] [user] [result] :[msg]` | Registration reply |
| `MR` | `[SOURCE] MR [subcmd] [params...]` | Read marker (S, G, R, broadcast) |
| `RN` | `[NUMERIC] RN [old] [new] :[reason]` | Channel rename |
| `MD` | `[SOURCE] MD [target] [key] [vis] :[value]` | Metadata (vis: `*` or `P`) |
| `MDQ` | `[SOURCE] MDQ [target] [key\|*]` | Metadata query to X3 |
| `WP` | `[SOURCE] WP [subcmd] [params...]` | Web push |
| `ML` | `[NUMERIC] ML [+\|-\|c]batchid target :[text]` | S2S multiline batch |

### New SASL Subcmds

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `M` | `[X3] SA * * M :[mechanisms]` | Mechanism broadcast |

### WEBPUSH Subcmds

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `V` | `[X3] WP V :[vapid_key]` | VAPID broadcast |
| `R` | `[SERVER] WP R [user] [endpoint] [p256dh] [auth]` | Register |
| `U` | `[SERVER] WP U [user] [endpoint]` | Unregister |
| `P` | `[SERVER] WP P [account] :[message]` | Push request |
| `E` | `[X3] WP E [user] [code] :[message]` | Error |

### Tag Propagation

| Tag | Propagate? | Notes |
|-----|------------|-------|
| `@time` | Yes | Preserve original timestamp |
| `@msgid` | Yes | Message deduplication |
| `@batch` | Yes | Coordinated batches |
| `@account` | No | Use AC command |
| `@label` | No | Client-local |
| `+typing` | Yes | Via TAGMSG only |
| `+reply` | Yes | Via TAGMSG only |

---

## Implementation Files Reference

### Nefarious IRCd

| File | Purpose |
|------|---------|
| `ircd/m_setname.c` | SETNAME command handler |
| `ircd/m_tagmsg.c` | TAGMSG command handler |
| `ircd/m_batch.c` | BATCH command handler |
| `ircd/m_sasl.c` | SASL protocol, M subcmd |
| `ircd/m_cap.c` | CAP negotiation, mechanism list |
| `ircd/m_chathistory.c` | CHATHISTORY command handler |
| `ircd/m_redact.c` | REDACT command handler |
| `ircd/m_register.c` | REGISTER/VERIFY command handlers |
| `ircd/m_markread.c` | MARKREAD command handler |
| `ircd/m_rename.c` | Channel RENAME command handler |
| `ircd/m_metadata.c` | METADATA command handler |
| `ircd/m_webpush.c` | WEBPUSH command handler |
| `ircd/parse.c` | Tag parsing, command registration |
| `ircd/send.c` | Tag-aware send functions |
| `include/msg.h` | Token definitions |
| `include/capab.h` | Capability flags |
| `include/client.h` | Client tag storage |
| `include/ircd.h` | VAPID key storage |

### X3 Services

| File | Purpose |
|------|---------|
| `src/proto-p10.c` | P10 parser, all token handlers |
| `src/nickserv.c` | SASL, registration, metadata |
| `src/chanserv.c` | Channel metadata, rename |
| `src/webpush.c` | RFC 8291 encryption, push delivery |
| `src/webpush.h` | Web push API declarations |
| `src/keycloak.c` | Metadata/subscription storage |

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | December 2024 | Initial release with IRCv3.2+ extensions |
| 1.1 | December 2024 | Added chathistory, redact, registration, read-marker, rename, metadata, webpush |
| 1.2 | December 2024 | Added metadata visibility support (P10 `*`/`P` tokens), updated compatibility matrix, removed duplicate feature flags section |
| 1.3 | December 2024 | Added METADATAQUERY (MDQ) token documentation with multi-hop routing |
| 1.4 | December 2024 | Updated MARKREAD (MR) to route through X3 with S/G/R subcommands and broadcast |
| 1.5 | December 2024 | Added compression passthrough Z flag to MD token for zstd-compressed metadata |
| 1.6 | December 2024 | Added MULTILINE (ML) token for S2S multiline batch propagation |
| 1.7 | December 2024 | Corrected CHATHISTORY documentation - local LMDB only, no X3 involvement |
| 1.8 | December 2024 | Added S2S chathistory federation protocol (CH Q/R/E subcommands) for Phase 32 |
| 1.9 | December 2024 | Corrected N (NICK) user introduction format - account is a mode parameter for +r, not a fixed position |
| 1.10 | December 2024 | Added N token nick change format; S2S commands use Unix timestamps (ISO 8601 only in message tags per IRCv3) |
| 1.11 | December 2024 | Optimized CHATHISTORY S2S format: single-char subcmds (L/B/A/R/W/T), compact refs |
| 1.12 | December 2024 | Removed T/M prefixes from CHATHISTORY refs - timestamps start with digit, msgids start with server numeric |

---

*This document is part of the Nefarious IRCd IRCv3.2+ upgrade project.*
