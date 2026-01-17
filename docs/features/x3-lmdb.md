# X3 LMDB Storage

LMDB-based persistent storage for X3 Services with optional SAXDB dual-write mode.

**Branch**: `saxdb-optional` extends LMDB to full standalone storage mode.

## Overview

X3 uses LMDB (Lightning Memory-Mapped Database) as its primary fast storage backend. LMDB provides:

- Memory-mapped storage for zero-copy reads
- ACID transactions with crash recovery
- Single-writer, multiple-reader concurrency
- No external dependencies (embedded database)

## Architecture

### Default Mode (LMDB + SAXDB)

```
┌───────────────┐
│   X3 Core     │
└──────┬────────┘
       │
   ┌───┴───┐
   ▼       ▼
┌─────┐ ┌──────┐
│LMDB │ │SAXDB │
│Cache│ │Persist│
└─────┘ └──────┘
```

### LMDB-Only Mode (saxdb-optional branch)

```
┌───────────────┐
│   X3 Core     │
└──────┬────────┘
       │
       ▼
    ┌─────┐
    │LMDB │
    │ Only│
    └─────┘
```

## Configuration

### Basic Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `services/x3/lmdb_path` | "x3data/lmdb" | Database directory |
| `services/x3/lmdb_nosync` | 0 | Enable nosync mode |
| `services/x3/lmdb_sync_interval` | 10 | Sync interval when nosync enabled |

### TTL and Purge

| Setting | Default | Description |
|---------|---------|-------------|
| `services/x3/lmdb_purge_interval` | 3600 | Purge expired entries (seconds) |
| `nickserv/metadata_ttl_enabled` | 1 | Enable metadata TTL |
| `nickserv/metadata_default_ttl` | 2592000 | Default TTL (30 days) |
| `nickserv/metadata_immutable_keys` | "avatar..." | Keys that never expire |

### Snapshots

| Setting | Default | Description |
|---------|---------|-------------|
| `services/x3/lmdb_snapshot_path` | "x3data/backups" | Snapshot directory |
| `services/x3/lmdb_snapshot_interval` | 0 | Auto-snapshot interval (0=off) |
| `services/x3/lmdb_snapshot_retention` | 7 | Snapshots to retain |

### SAXDB-Optional Mode

| Setting | Default | Description |
|---------|---------|-------------|
| `services/x3/saxdb_enabled` | 1 | Enable SAXDB reads/writes |

## Databases

X3 uses multiple named databases within a single LMDB environment:

| Database | Purpose | Key Format |
|----------|---------|------------|
| `accounts` | User accounts | `account:<name>` |
| `channels` | Registered channels | `channel:<name>` |
| `metadata` | User/channel metadata | `meta:<target>:<key>` |
| `sessions` | Session tokens | `session:<account>` |
| `scram` | SCRAM credentials | `scram:<type>:<account>` |
| `webpush` | Push subscriptions | `webpush:<account>:<hash>` |
| `readmarker` | Read markers | `rm:<account>:<target>` |
| `chanaccess` | Channel access (Keycloak) | `access:<channel>:<account>` |
| `certexp` | Cert expiry | `certexp:<fingerprint>` |

## Key Prefixes

### Account Database

```
account:<name>         → Account record
passwd:<name>          → Password hash
email:<name>           → Email address
cookie:<name>          → Pending verification
```

### Session Database

```
session:<account>      → Session token hash:created:lastused
scram:sha1:<account>   → SCRAM-SHA-1 credentials
scram:sha256:<account> → SCRAM-SHA-256 credentials
scram:sha512:<account> → SCRAM-SHA-512 credentials
scram_acct:*:<account> → Account password SCRAM
```

### Metadata Database

```
meta:<target>:<key>    → Metadata value
  Target formats:
    *                  → Current user
    accountname        → Specific account
    #channel           → Channel metadata
```

## NoSync Mode

When `lmdb_nosync=1`:

1. LMDB skips fsync on every transaction
2. Writes are batched in memory
3. Periodic timer calls `mdb_env_sync()`
4. **Risk**: Data loss on crash

**Use cases**:
- High write volume systems
- Non-critical data
- Systems with battery backup

## TTL System

Metadata entries can have expiration times:

### Value Format

```
[T:timestamp:][P:]value

Examples:
  T:1735689600:myvalue        → Expires 2025-01-01, public
  T:1735689600:P:myvalue      → Expires 2025-01-01, private
  myvalue                     → Never expires, public
  P:myvalue                   → Never expires, private
```

### Expiry Behavior

1. **Lazy expiry**: Check TTL on read, delete if expired
2. **Periodic purge**: Background timer sweeps all expired entries
3. **Immutable keys**: Keys in `metadata_immutable_keys` never expire

## Snapshots

### Manual Snapshot

```
/msg O3 LMDB SNAPSHOT
```

Creates a point-in-time copy of the database.

### Automatic Snapshots

When `lmdb_snapshot_interval > 0`:

1. Timer fires every interval
2. Snapshot created with timestamp filename
3. Old snapshots rotated (keep `retention` newest)

### Snapshot Format

```
x3data/backups/
  lmdb-20250117-093000/
    data.mdb
    lock.mdb
```

## SAXDB-Optional Mode

The `saxdb-optional` branch adds full standalone LMDB operation:

### When `saxdb_enabled=0`:

- SAXDB files not read on startup
- SAXDB files not written on shutdown
- All data lives exclusively in LMDB
- Faster startup/shutdown
- No XML overhead

### Migration

```
1. Start with saxdb_enabled=1 (data in SAXDB)
2. X3 loads SAXDB, populates LMDB
3. Set saxdb_enabled=0
4. Restart X3 (LMDB-only mode)
5. Delete old SAXDB files (optional)
```

## OpServ Commands

```
LMDB STATUS    - Show database statistics
LMDB SNAPSHOT  - Create manual snapshot
LMDB STATS     - Detailed performance metrics
```

## Build Requirements

```bash
./configure --with-lmdb
```

Package: `liblmdb-dev` (Debian/Ubuntu) or `lmdb-devel` (RHEL/Fedora)

## Performance Tuning

### Map Size

LMDB pre-allocates virtual address space:

```c
mdb_env_set_mapsize(env, 1073741824);  // 1GB
```

### Read-Only Transactions

For read-heavy workloads:
- Readers don't block writers
- Use short-lived read transactions
- Don't hold cursors across events

---

*Part of the X3 Services IRCv3.2+ upgrade project.*
