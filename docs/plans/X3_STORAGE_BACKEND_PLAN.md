# X3 Services - Storage Backend Alternatives

## Overview

Evaluate and select a replacement/supplement for SAXDB to achieve:
- **Performance**: Fast reads/writes for real-time operations
- **Durability**: ACID guarantees, crash recovery, minimal data loss
- **Import compatibility**: Read existing saxdb files on migration

---

## Storage Backend Comparison

| Backend | Type | Performance | Durability | Complexity | Best For |
|---------|------|-------------|------------|------------|----------|
| **LMDB** | Embedded KV | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Low | High-freq KV ops |
| **SQLite** | Embedded SQL | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Medium | Structured queries |
| **Redis** | External KV | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Medium | Caching, pub/sub |
| **PostgreSQL** | External SQL | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | High | Full RDBMS features |
| **RocksDB** | Embedded KV | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Medium | Write-heavy workloads |

---

## Option 1: LMDB (Recommended for Hybrid)

**Pros:**
- Already proven in Nefarious (chathistory, metadata)
- Zero-copy reads, memory-mapped
- ACID transactions
- No external server needed
- Single-file database
- Excellent for key-value patterns

**Cons:**
- No SQL queries
- Fixed map size (must pre-allocate)
- Single writer at a time

**Use Case:** Hybrid approach - SAXDB for bulk, LMDB for high-frequency

---

## Option 2: SQLite (Full Replacement)

**Pros:**
- Full SQL query capability
- Excellent durability (WAL mode)
- Single-file database
- Widely understood, excellent tooling
- Can replace SAXDB entirely
- Supports complex queries (joins, indexes)

**Cons:**
- Slightly slower than LMDB for simple KV
- More complex integration
- Larger binary size

**Use Case:** Full SAXDB replacement with query capabilities

---

## Option 3: Redis (External + Caching)

**Pros:**
- Extremely fast (in-memory)
- Pub/sub for real-time sync
- Rich data structures (sets, sorted sets, hashes)
- Clustering support
- Persistence options (RDB, AOF)

**Cons:**
- External server dependency
- Memory-bound (expensive for large datasets)
- Less durable than disk-first DBs
- Operational complexity

**Use Case:** Caching layer + real-time sync, with disk backend

---

## Option 4: PostgreSQL (Enterprise)

**Pros:**
- Full RDBMS capabilities
- Excellent durability and ACID
- Advanced features (JSONB, full-text search)
- Replication, high availability
- Industry standard

**Cons:**
- External server required
- Highest operational complexity
- Overkill for small networks
- Latency for simple operations

**Use Case:** Large networks needing enterprise features

---

## Detailed Option Analysis

### Option A: Hybrid LMDB (Lowest Risk)

```
SAXDB (accounts, channels) + LMDB (metadata, markers, presence)
```

| Aspect | Details |
|--------|---------|
| **Effort** | 23-34 hours |
| **Risk** | Low - SAXDB untouched for core data |
| **Performance** | Excellent for metadata (LMDB), unchanged for bulk |
| **Durability** | Immediate for LMDB data, 30-min for SAXDB |
| **Migration** | Import metadata from SAXDB once, then skip |
| **Multi-server** | Would need separate sync mechanism |
| **Dependencies** | liblmdb (already have for Nefarious) |

**When to choose:** Want immediate metadata durability with minimal code changes.

---

### Option B: SQLite Full Replacement (Cleanest Long-term)

```
Replace all SAXDB with SQLite database
```

| Aspect | Details |
|--------|---------|
| **Effort** | 40-60 hours |
| **Risk** | Medium - touching all serialization code |
| **Performance** | Good (WAL mode), slightly slower than LMDB for pure KV |
| **Durability** | Excellent - all data immediately durable |
| **Migration** | One-time import, then pure SQLite |
| **Multi-server** | Native replication possible |
| **Dependencies** | libsqlite3 |

**Schema example:**
```sql
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    handle TEXT UNIQUE NOT NULL,
    password TEXT,
    email TEXT,
    flags INTEGER,
    registered INTEGER,
    last_seen INTEGER
);

CREATE TABLE account_metadata (
    account_id INTEGER REFERENCES accounts(id),
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (account_id, key)
);

CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    registered INTEGER,
    flags INTEGER
);
```

**When to choose:** Want to eliminate SAXDB entirely, need query capabilities (e.g., "find all accounts registered this week").

---

### Option C: LMDB + Redis (Multi-server Ready)

```
LMDB (durable storage) + Redis (pub/sub, caching)
```

| Aspect | Details |
|--------|---------|
| **Effort** | 35-45 hours |
| **Risk** | Medium - external dependency |
| **Performance** | Excellent - Redis for hot data, LMDB for cold |
| **Durability** | LMDB is durable, Redis is cache |
| **Migration** | Same as Option A |
| **Multi-server** | Native pub/sub for real-time sync |
| **Dependencies** | liblmdb + hiredis + Redis server |

**Architecture:**
```
┌─────────────┐     ┌─────────────┐
│ X3 Server 1 │────▶│   Redis     │◀────│ X3 Server 2 │
└──────┬──────┘     │  (pub/sub)  │     └──────┬──────┘
       │            └─────────────┘            │
       ▼                                       ▼
┌─────────────┐                        ┌─────────────┐
│  LMDB       │                        │  LMDB       │
│  (local)    │                        │  (local)    │
└─────────────┘                        └─────────────┘
```

**When to choose:** Running multiple X3 instances that need real-time sync.

---

### Option D: PostgreSQL (Enterprise Scale)

```
External PostgreSQL database for everything
```

| Aspect | Details |
|--------|---------|
| **Effort** | 60-80 hours |
| **Risk** | High - complete architecture change |
| **Performance** | Good, but network latency for each op |
| **Durability** | Excellent - full ACID, replication |
| **Migration** | One-time import |
| **Multi-server** | Native - all X3 instances share one DB |
| **Dependencies** | libpq + PostgreSQL server |

**When to choose:** Large network (1000+ users), need enterprise features (HA, backup, monitoring).

---

## Decision Matrix

| Factor | Hybrid LMDB | SQLite | LMDB+Redis | PostgreSQL |
|--------|-------------|--------|------------|------------|
| Implementation time | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| Code change risk | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| Durability | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Query capability | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| Multi-server sync | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Operational cost | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |

---

## Selected Approach: Hybrid LMDB + Optional Redis

**Phase 1:** ✅ **COMPLETE** - LMDB for high-frequency data (metadata, markers, channel access)
**Phase 2 (Optional):** Add Redis pub/sub layer for multi-server sync

> **Implementation Status:** The LMDB storage layer is fully implemented in `x3/src/x3_lmdb.c` and `x3/src/x3_lmdb.h`. See the actual implementation for the complete API including TTL support, zstd compression, and Keycloak group sync.

---

## Current SAXDB Architecture

```
┌─────────────────────────────────────────┐
│         X3 Services (Memory)            │
│  NickServ | ChanServ | Global | OpServ  │
└────────────────┬────────────────────────┘
                 │ SAXDB_WRITER callbacks
                 ▼
        ┌────────────────────┐
        │   Text Files       │
        │  nickserv.db       │
        │  chanserv.db       │
        │  (full rewrite)    │
        └────────────────────┘
```

**Problems:**
- Full database rewrite for ANY change (O(n) writes)
- 30-minute data loss window on crash
- Blocks X3 during flush
- Cannot support real-time metadata sync

---

## Proposed Hybrid Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  X3 Services (Memory)                   │
└───────────┬─────────────────────────────┬───────────────┘
            │                             │
    Bulk Data (30-min)           High-Frequency (immediate)
            │                             │
            ▼                             ▼
    ┌───────────────┐            ┌─────────────────┐
    │    SAXDB      │            │      LMDB       │
    │  nickserv.db  │            │   x3data.lmdb   │
    │  chanserv.db  │            │                 │
    │  (accounts,   │            │  - metadata     │
    │   channels)   │            │  - presence     │
    └───────────────┘            │  - read markers │
                                 │  - session data │
                                 └─────────────────┘
```

---

## Phase 1: LMDB Storage Module

### New Files

**`src/x3_lmdb.h`** - LMDB wrapper API
```c
#ifndef X3_LMDB_H
#define X3_LMDB_H

#ifdef WITH_LMDB

#include <lmdb.h>

/* Database handles for different data types */
#define X3_DBI_METADATA   0   /* account metadata */
#define X3_DBI_CHANMETA   1   /* channel metadata */
#define X3_DBI_READMARK   2   /* read markers */
#define X3_DBI_PRESENCE   3   /* presence state */
#define X3_DBI_COUNT      4

/* Initialize LMDB environment */
int x3_lmdb_init(const char *dbpath, size_t map_size_mb);

/* Shutdown and cleanup */
void x3_lmdb_shutdown(void);

/* Key-value operations */
int x3_lmdb_get(int dbi, const char *key, char *value, size_t value_size);
int x3_lmdb_put(int dbi, const char *key, const char *value);
int x3_lmdb_del(int dbi, const char *key);

/* Iteration */
typedef int (*x3_lmdb_iter_cb)(const char *key, const char *value, void *extra);
int x3_lmdb_iterate(int dbi, const char *prefix, x3_lmdb_iter_cb cb, void *extra);

/* Transaction support */
int x3_lmdb_begin(void);
int x3_lmdb_commit(void);
void x3_lmdb_abort(void);

#else /* !WITH_LMDB */

/* Stub macros for graceful degradation */
#define x3_lmdb_init(p, s)           (-1)
#define x3_lmdb_shutdown()           do {} while(0)
#define x3_lmdb_get(d, k, v, s)      (-1)
#define x3_lmdb_put(d, k, v)         (-1)
#define x3_lmdb_del(d, k)            (-1)

#endif /* WITH_LMDB */
#endif /* X3_LMDB_H */
```

**`src/x3_lmdb.c`** - Implementation
- LMDB environment management
- Named database (DBI) handling
- Compression integration (reuse x3_compress)
- Error logging

---

## Phase 2: Migrate Metadata to LMDB

### Current Metadata Storage (in SAXDB)

**NickServ** stores metadata inline with account data:
```
"accountname" {
    "metadata" {
        "key1" "value1";
        "key2" "value2";
    };
};
```

### New Metadata Storage (LMDB)

**Key format**: `account\0key` or `#channel\0key`
**Value format**: Compressed string (with zstd)

### Migration Points

**File: `src/nickserv.c`**

1. **Read migration** - `nickserv_saxdb_read()`:
   - If "metadata" section exists in saxdb, import to LMDB
   - Mark as migrated (don't re-import on next read)

2. **Write bypass** - `nickserv_saxdb_write()`:
   - Skip "metadata" section entirely (now in LMDB)
   - Reduces saxdb file size and write time

3. **Runtime operations**:
   - `SET_METADATA` → `x3_lmdb_put(X3_DBI_METADATA, ...)`
   - `GET_METADATA` → `x3_lmdb_get(X3_DBI_METADATA, ...)`
   - Immediate persistence, no 30-min delay

**File: `src/chanserv.c`**

Same pattern for channel metadata.

---

## Phase 3: Migrate Read Markers to LMDB

### Current State

Read markers stored in NickServ account data (saxdb).

### New Storage

**Key format**: `account\0#channel`
**Value format**: ISO 8601 timestamp

### Benefits

- Immediate persistence when user reads messages
- No full database rewrite for each MARKREAD
- Efficient sync with Nefarious IRCd

---

## Phase 4: Add Presence State to LMDB

### Current State

Presence ephemeral (lost on restart).

### New Storage

**Key format**: `account`
**Value format**: JSON `{"status":"away","message":"brb"}`

### Benefits

- Presence survives X3 restart
- Can sync presence to reconnecting clients
- Foundation for RESUME capability

---

## Phase 5: SAXDB Import Layer

### Import Detection

On startup, check for existing saxdb files:
```c
void x3_storage_init(void) {
    if (file_exists("nickserv.db") && !lmdb_has_accounts()) {
        log_module(MAIN_LOG, LOG_INFO, "Importing from saxdb...");
        import_nickserv_metadata();
        import_chanserv_metadata();
        import_read_markers();
    }
}
```

### Import Process

1. Parse saxdb file using existing `parse_database()`
2. Extract metadata sections
3. Write to LMDB
4. Log progress

---

## Phase 6: Build System

### File: `configure.ac`

Add LMDB detection (similar to existing zstd):
```autoconf
AC_ARG_WITH([lmdb],
    [AS_HELP_STRING([--with-lmdb], [Enable LMDB storage backend])],
    [with_lmdb=$withval], [with_lmdb=check])

if test "x$with_lmdb" != "xno"; then
    AC_CHECK_LIB([lmdb], [mdb_env_create],
        [LIBS="$LIBS -llmdb"
         AC_DEFINE([WITH_LMDB], [1], [LMDB storage enabled])],
        [if test "x$with_lmdb" = "xyes"; then
            AC_MSG_ERROR([LMDB requested but not found])
         fi])
fi
```

### File: `src/Makefile.in`

Add to x3_OBJECTS:
```makefile
x3_lmdb.$(OBJEXT)
```

---

## Configuration

### x3.conf Options

```
"nickserv" {
    /* LMDB storage settings */
    "lmdb_path" "/data/x3data";        /* Database directory */
    "lmdb_map_size" "256";             /* Map size in MB */

    /* Migration */
    "import_saxdb_metadata" "1";       /* Import on first run */
};
```

---

## Implementation Order

| Phase | Task | Files | Status |
|-------|------|-------|--------|
| 1 | Create x3_lmdb module | x3_lmdb.c/h | ✅ Complete |
| 2 | Migrate account metadata | nickserv.c | ✅ Complete |
| 3 | Migrate channel metadata | chanserv.c | ✅ Complete |
| 4 | Migrate read markers | nickserv.c | ✅ Complete (via metadata API) |
| 5 | Add presence storage | nickserv.c | N/A (computed from connections) |
| 6 | SAXDB import layer | x3_lmdb.c | ✅ Complete |
| 7 | Build system updates | configure.ac, Makefile.in | ✅ Complete |
| 8 | Testing & documentation | - | ✅ Complete |

**LMDB Phase: COMPLETE**

---

## Critical Files

| File | Changes |
|------|---------|
| `src/x3_lmdb.h` | New - LMDB wrapper API |
| `src/x3_lmdb.c` | New - LMDB implementation |
| `src/nickserv.c` | Metadata/readmarkers → LMDB |
| `src/chanserv.c` | Channel metadata → LMDB |
| `configure.ac` | LMDB detection |
| `src/Makefile.in` | Add x3_lmdb.o |

---

## What Stays in SAXDB

| Data | Reason |
|------|--------|
| Account registrations | Bulk data, infrequent changes |
| Channel registrations | Bulk data, infrequent changes |
| Access lists | Changes with channel ops, not real-time |
| Bans | Moderate frequency, acceptable delay |
| G-lines/Shuns | OpServ managed, infrequent |
| Global messages | Infrequent changes |

---

## What Moves to LMDB

| Data | Reason |
|------|--------|
| Account metadata | High-frequency sync with IRCd |
| Channel metadata | High-frequency sync with IRCd |
| Read markers | Every MARKREAD command |
| Presence state | Real-time status changes |

---

## Benefits Summary

| Metric | SAXDB Only | Hybrid LMDB |
|--------|------------|-------------|
| Metadata write latency | 30 min | Immediate |
| Data loss window | 30 min | ~0 (LMDB sync) |
| Per-operation overhead | O(n) full rewrite | O(1) key-value |
| Real-time sync | Not possible | Supported |
| Migration effort | N/A | 23-34 hours |

---

## Testing Checklist

- [x] Build with `--with-lmdb` compiles successfully
- [x] Build without LMDB uses stub macros
- [x] Fresh install creates LMDB databases
- [x] Existing saxdb metadata is imported
- [x] Metadata operations use LMDB
- [x] SAXDB no longer writes metadata section
- [x] Read markers persist immediately
- [x] X3 restart preserves LMDB data
- [x] Compression works for large values (zstd integration)

---

## Optional Phase 7: Redis Pub/Sub Layer

**When to add:** If running multiple X3 instances that need real-time metadata sync.

### New Files

**`src/x3_redis.h`** - Redis wrapper API
```c
#ifndef X3_REDIS_H
#define X3_REDIS_H

#ifdef WITH_REDIS

/* Initialize Redis connection */
int x3_redis_init(const char *host, int port, const char *password);

/* Shutdown */
void x3_redis_shutdown(void);

/* Pub/Sub */
int x3_redis_publish(const char *channel, const char *message);
typedef void (*x3_redis_sub_cb)(const char *channel, const char *message, void *data);
int x3_redis_subscribe(const char *channel, x3_redis_sub_cb callback, void *data);

/* Optional caching */
int x3_redis_set(const char *key, const char *value, int ttl_seconds);
int x3_redis_get(const char *key, char *value, size_t value_size);

#else /* !WITH_REDIS */

#define x3_redis_init(h, p, pw)      (-1)
#define x3_redis_shutdown()          do {} while(0)
#define x3_redis_publish(c, m)       (-1)
#define x3_redis_subscribe(c, cb, d) (-1)

#endif /* WITH_REDIS */
#endif /* X3_REDIS_H */
```

### Sync Protocol

When metadata changes locally:
```c
void on_metadata_change(const char *target, const char *key, const char *value) {
    /* Write to local LMDB */
    x3_lmdb_put(X3_DBI_METADATA, build_key(target, key), value);

    /* Publish to Redis for other X3 instances */
    char msg[1024];
    snprintf(msg, sizeof(msg), "SET %s %s %s", target, key, value);
    x3_redis_publish("x3:metadata", msg);
}
```

When receiving sync from Redis:
```c
void on_redis_metadata(const char *channel, const char *message, void *data) {
    char cmd[16], target[128], key[64], value[512];
    if (sscanf(message, "%15s %127s %63s %511s", cmd, target, key, value) >= 3) {
        if (strcmp(cmd, "SET") == 0) {
            /* Update local LMDB */
            x3_lmdb_put(X3_DBI_METADATA, build_key(target, key), value);
            /* Update in-memory cache */
            update_memory_cache(target, key, value);
        }
    }
}
```

### x3.conf Redis Options

```
"nickserv" {
    /* Redis sync (optional) */
    "redis_host" "localhost";
    "redis_port" "6379";
    "redis_password" "";           /* empty = no auth */
    "redis_channel" "x3:metadata"; /* pub/sub channel */
};
```

### Build System

Add to `configure.ac`:
```autoconf
AC_ARG_WITH([redis],
    [AS_HELP_STRING([--with-redis], [Enable Redis pub/sub sync])],
    [with_redis=$withval], [with_redis=no])

if test "x$with_redis" = "xyes"; then
    AC_CHECK_LIB([hiredis], [redisConnect],
        [LIBS="$LIBS -lhiredis"
         AC_DEFINE([WITH_REDIS], [1], [Redis sync enabled])],
        [AC_MSG_ERROR([Redis requested but hiredis not found])])
fi
```

### Redis Phase Effort

| Task | Effort |
|------|--------|
| x3_redis module | 4-6 hrs |
| Pub/sub integration | 4-6 hrs |
| Testing | 2-3 hrs |
| **Total** | **10-15 hrs** |

---

## Complete Implementation Order

| Phase | Task | Effort | Dependency |
|-------|------|--------|------------|
| 1 | Create x3_lmdb module | 4-6 hrs | None |
| 2 | Migrate account metadata | 4-6 hrs | Phase 1 |
| 3 | Migrate channel metadata | 3-4 hrs | Phase 1 |
| 4 | Migrate read markers | 2-3 hrs | Phase 1 |
| 5 | Add presence storage | 2-3 hrs | Phase 1 |
| 6 | SAXDB import layer | 3-4 hrs | Phase 2-5 |
| 7 | Build system (LMDB) | 1-2 hrs | Phase 1 |
| **LMDB Total** | | **19-28 hrs** | |
| 8 | Redis module (optional) | 4-6 hrs | Phase 7 |
| 9 | Pub/sub sync | 4-6 hrs | Phase 8 |
| 10 | Testing Redis | 2-3 hrs | Phase 9 |
| **Redis Total** | | **10-15 hrs** | |
| **Grand Total** | | **29-43 hrs** | |
