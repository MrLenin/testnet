# Read Markers

Implementation of `draft/read-marker` IRCv3 extension in Nefarious IRCd with X3 as authoritative storage.

## Overview

Read markers track the last-read position in channels and private conversations, enabling multi-device synchronization and unread message counts.

## Architecture

```
Client A ─────────────────────────────────────┐
                                              ▼
            ┌──────┐      MR S      ┌────┐
            │Server│ ─────────────► │ X3 │ (Authoritative)
            │  1   │ ◄───────────── │    │
            └──────┘    Broadcast   └────┘
                                       │
            ┌──────┐                   │
            │Server│ ◄─────────────────┘
            │  2   │   Broadcast
            └──────┘
                ▲
                │
Client B ───────┘
```

X3 is the authoritative store. All servers maintain local LMDB caches.

## Client Commands

**Set marker**:
```
MARKREAD <target> timestamp=<ts>
```

**Get marker**:
```
MARKREAD <target>
```

**Response**:
```
:server MARKREAD <target> timestamp=<ts>
```

## P10 Protocol

**Token**: `MR` (MARKREAD)

**Subcommands**:

| Subcmd | Format | Direction | Purpose |
|--------|--------|-----------|---------|
| `S` | `MR S <user> <target> <ts>` | Server → X3 | Set marker |
| `G` | `MR G <user> <target>` | Server → X3 | Get marker |
| `R` | `MR R <server> <user> <target> <ts>` | X3 → Server | Reply to get |
| (none) | `MR <account> <target> <ts>` | X3 → All | Broadcast update |

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_read_marker` | TRUE | Enable `draft/read-marker` capability |

## Storage

**X3 (Authoritative)**:
- LMDB with Keycloak backup
- Key format: `readmarker.<account>.<target>`
- Value: Unix timestamp with microseconds

**Nefarious (Cache)**:
- Local LMDB cache per server
- Populated on broadcast, queried for fast lookups

## Multi-Device Sync

1. Device A marks #channel read at timestamp T
2. Server forwards `MR S` to X3
3. X3 validates T > existing timestamp
4. X3 broadcasts `MR account #channel T` to all servers
5. Server 2 (with Device B) notifies Device B
6. Device B updates its unread count

## Example Flow

```
Client: MARKREAD #channel timestamp=1705500000.123456

Server → X3: MR S ABAAB #channel 1705500000.123456

X3 → All: MR johndoe #channel 1705500000.123456

Server → Client: :server MARKREAD #channel timestamp=1705500000.123456
```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*
