# Chat History

Implementation of `draft/chathistory` IRCv3 extension in Nefarious IRCd with federation support.

## Overview

Chathistory provides message replay functionality, allowing clients to retrieve messages sent while they were offline or before they joined a channel. Nefarious implements both local LMDB storage and cross-server federation.

## Architecture

### Local Storage

```
Client Request
      │
      ▼
┌──────────────────┐
│ CHATHISTORY cmd  │
│ (m_chathistory.c)│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   LMDB Storage   │
│ (history/*.mdb)  │
└──────────────────┘
```

### Federation (Multi-Server)

```
Client ─► Server A ─┬─► Local LMDB
                    │
                    └─► CH Q ─► Server B ─► CH R ─► Merge ─► Client
                              ├─► Server C ─► CH R ─┘
                              └─► Server D ─► CH R ─┘
```

## Feature Flags

### Storage Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_chathistory` | TRUE | Enable capability advertisement |
| `FEAT_CHATHISTORY_STORE` | TRUE | Store messages locally |
| `FEAT_CHATHISTORY_MAX` | 100 | Max messages per request |
| `FEAT_CHATHISTORY_DB` | "history" | LMDB database path |
| `FEAT_CHATHISTORY_RETENTION` | 7 | Days to keep messages |

### Federation Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CHATHISTORY_FEDERATION` | TRUE | Enable S2S queries |
| `FEAT_CHATHISTORY_TIMEOUT` | 5 | S2S response timeout (sec) |
| `FEAT_CHATHISTORY_WRITE_FORWARD` | TRUE | Forward writes to storage servers |
| `FEAT_CHATHISTORY_STORE_REGISTERED` | TRUE | Store registered channels on non-storage servers |

### Storage Management

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CHATHISTORY_HIGH_WATERMARK` | 85 | % usage to trigger eviction |
| `FEAT_CHATHISTORY_LOW_WATERMARK` | 75 | % usage target after eviction |
| `FEAT_CHATHISTORY_MAINTENANCE_INTERVAL` | 300 | Seconds between maintenance |
| `FEAT_CHATHISTORY_EVICT_BATCH_SIZE` | 1000 | Max entries per eviction cycle |
| `FEAT_CHATHISTORY_STRICT_TIMESTAMPS` | FALSE | Reject old timestamps |

### PM History Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CHATHISTORY_PRIVATE` | FALSE | Enable PM history |
| `FEAT_CHATHISTORY_PRIVATE_CONSENT` | 2 | PM consent mode |
| `FEAT_CHATHISTORY_ADVERTISE_PM` | FALSE | Advertise PM policy in CAP |
| `FEAT_CHATHISTORY_PM_NOTICE` | FALSE | Send policy notice on connect |

## Client Commands

### CHATHISTORY Subcommands

```
CHATHISTORY LATEST <target> * <limit>
CHATHISTORY BEFORE <target> <msgid|timestamp> <limit>
CHATHISTORY AFTER <target> <msgid|timestamp> <limit>
CHATHISTORY AROUND <target> <msgid|timestamp> <limit>
CHATHISTORY BETWEEN <target> <start> <end> <limit>
CHATHISTORY TARGETS <timestamp> <timestamp> <limit>
```

### Reference Formats

- **Timestamp**: `timestamp=2024-01-15T10:30:00.000Z`
- **Message ID**: `msgid=ABC123-DEF456`

### Example

```
CHATHISTORY LATEST #channel * 50
:server BATCH +abc chathistory #channel
@batch=abc;time=... :nick!user@host PRIVMSG #channel :Hello
@batch=abc;time=... :nick!user@host PRIVMSG #channel :World
:server BATCH -abc
```

## P10 Federation Protocol

### Token: `CH` (CHATHISTORY)

### Advertisement Subcommands (Phase 3)

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `A S` | `CH A S <retention>` | Storage capability |
| `A R` | `CH A R <retention>` | Retention update |
| `A F` | `CH A F :<channels>` | Full channel list |
| `A +` | `CH A + :<channel>` | Add channel |
| `A -` | `CH A - :<channel>` | Remove channel |

### Query Subcommands

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `Q` | `CH Q <target> <subcmd> <ref> <limit> <reqid>` | Query request |
| `R` | `CH R <reqid> <msgid> <ts> <type> <sender> <acct> :<text>` | Response (plain text) |
| `Z` | `CH Z <reqid> <msgid> <ts> <type> <sender> <acct> :<b64_zstd>` | Response (compressed) |
| `B` | `CH B <reqid> <msgid> <ts> <type> <sender> <acct> [+] :<b64>` | Response (chunked) |
| `E` | `CH E <reqid> <count>` | End of response |

**Response Types**:
- `CH R`: Plain text content, used when message fits in single P10 line
- `CH Z`: Zstd-compressed content (base64 encoded) for bandwidth savings
- `CH B`: Base64-encoded content with chunking for large/multiline messages

### Write Forward Subcommands (Phase 4)

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `W` | `CH W <target> <msgid> <ts> <sender> <acct> <type> :<text>` | Single message |
| `WB` | `CH WB <target> <msgid> <ts> <sender> <acct> <type> [+] :<b64>` | Batch chunk |

## PM Consent Modes

Users control PM history storage via metadata:

```
METADATA * SET chathistory.pm * :1    # Opt in
METADATA * SET chathistory.pm * :0    # Opt out
METADATA * CLEAR chathistory.pm       # Use server default
```

### Mode 0: Global (Least Private)

All PMs stored unless either party explicitly opts out.

### Mode 1: Single-Party

Store if sender OR recipient has opted in. Opt-out overrides.

### Mode 2: Multi-Party (Default, Most Private)

Store only if BOTH sender AND recipient have opted in.

## Storage Decoupling

The `STORE` flag decouples storage from capability:

| STORE | CAP | Behavior |
|-------|-----|----------|
| TRUE | TRUE | Full storage server |
| FALSE | TRUE | Relay server (queries only) |
| TRUE | FALSE | Silent storage |
| FALSE | FALSE | No chathistory |

**Relay servers** forward queries via federation without local storage overhead.

## Write Forwarding

When `STORE=FALSE` and `WRITE_FORWARD=TRUE`:

1. Message arrives at relay server
2. Relay forwards via `CH W` to storage servers
3. Storage servers store and ACK
4. Client queries hit storage servers via federation

## Watermark Eviction

Prevents unbounded storage growth:

1. Maintenance timer checks usage every `MAINTENANCE_INTERVAL`
2. If usage > `HIGH_WATERMARK` (85%), eviction starts
3. Oldest entries evicted in batches of `EVICT_BATCH_SIZE`
4. Continues until usage <= `LOW_WATERMARK` (75%)

## LMDB Storage Format

### Key Structure

```
Channel: c:<channel>:<msgid>
PM:      p:<account1>:<account2>:<msgid>
```

### Value Structure

```
<timestamp>|<sender>|<account>|<type>|<text>
```

## Example Configuration

```
features {
    "CAP_chathistory" = "TRUE";
    "CHATHISTORY_STORE" = "TRUE";
    "CHATHISTORY_MAX" = "100";
    "CHATHISTORY_DB" = "history";
    "CHATHISTORY_RETENTION" = "7";
    "CHATHISTORY_FEDERATION" = "TRUE";
    "CHATHISTORY_WRITE_FORWARD" = "TRUE";
    "CHATHISTORY_PRIVATE" = "TRUE";
    "CHATHISTORY_PRIVATE_CONSENT" = "2";
};
```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*
