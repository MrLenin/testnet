# Metadata System Enhancement Plan

## Overview

This document details the implementation plan for enhancing the metadata system across Nefarious IRCd and X3 Services. The enhancements focus on:

1. **LMDB as X3 Cache/Fallback** - Use Nefarious LMDB as a local cache to reduce X3 queries and provide fallback when X3/Keycloak is unavailable
2. **Channel Metadata Persistence** - Integrate channel metadata with X3 for registered channels
3. **Multi-Server Synchronization** - Ensure metadata consistency across multi-server networks

**Spec Reference**: https://ircv3.net/specs/extensions/metadata

---

## Current Architecture

### What's Implemented

#### Nefarious (IRCd)

| Component | Status | Description |
|-----------|--------|-------------|
| In-memory user metadata | Complete | Stored in `cli_metadata(cptr)` linked list |
| In-memory channel metadata | Complete | Stored in `chptr->metadata` linked list |
| LMDB for account metadata | Complete | `metadata_account_*()` functions in metadata.c |
| LMDB for channel metadata | Partial | Functions exist but not integrated |
| P10 propagation (MD token) | Complete | Propagates with visibility (`*`/`P`) |
| Visibility support | Complete | Public vs private metadata |

#### X3 (Services)

| Component | Status | Description |
|-----------|--------|-------------|
| MD token handler | Complete | `cmd_metadata()` in proto-p10.c |
| Keycloak user storage | Complete | `nickserv_set_user_metadata()` |
| Keycloak user retrieval | Complete | `nickserv_get_user_metadata()` |
| Sync on login | Complete | `nickserv_sync_metadata_to_ircd()` |
| Channel metadata | **Not Implemented** | No ChanServ integration |

### Current Data Flow

```
User sets metadata:
  Client -> Nefarious -> Store in-memory + LMDB (if account)
                      -> P10 MD to servers
                      -> X3 receives -> Store in Keycloak (if account)

User logs in:
  X3 auth success -> Keycloak lookup -> P10 MD to Nefarious
                  -> Nefarious stores in-memory
```

### Gaps Identified

1. **No cache fallback**: Nefarious LMDB is parallel storage, not a cache for X3
2. **No X3 unavailable handling**: If X3/Keycloak is down, metadata operations fail
3. **No channel metadata in X3**: Channel metadata only exists in Nefarious memory/LMDB
4. **Multi-server inconsistency**: Each server has independent LMDB storage
5. **No sync on server connect**: Metadata not exchanged during netburst

---

## Enhancement Goals

### Goal 1: LMDB as Smart Cache for X3

Use Nefarious LMDB as a read-through cache for X3-stored metadata:
- Cache X3 metadata locally after login sync
- Serve reads from cache (fast local access)
- Write-through to X3 on set operations
- Fallback to cache when X3 unavailable

### Goal 2: X3 Fallback Mode

When X3 or Keycloak is unavailable:
- Continue serving metadata from local LMDB cache
- Queue write operations for later sync
- Detect X3 reconnection and replay queued operations

### Goal 3: Channel Metadata Persistence

For registered channels (ChanServ):
- Store channel metadata in X3's SAXDB (or new storage)
- Sync channel metadata during burst
- Preserve metadata across channel destruction/recreation

### Goal 4: Multi-Server Consistency

Ensure metadata is consistent across all servers:
- Propagate all metadata changes via P10
- Include metadata in netburst for users and channels
- Handle split-brain scenarios gracefully

---

## Architecture Design

### Cache Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                      Nefarious IRCd                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │  In-Memory  │◄───│    LMDB     │◄───│   X3/KC     │     │
│  │   (Fast)    │    │   (Cache)   │    │ (Authoritative)   │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│        ▲                  ▲                   ▲             │
│        │                  │                   │             │
│   Client GET         Cache Miss         Write-through       │
│   (immediate)        (rare)             (async okay)        │
└─────────────────────────────────────────────────────────────┘
```

### Cache Operations

| Operation | Flow |
|-----------|------|
| GET | Memory → (miss) → LMDB → (miss) → X3 query |
| SET | Memory → LMDB → P10 to X3 → Keycloak |
| LOGIN | X3 sends all metadata via P10 → Memory + LMDB |
| X3 DOWN | Memory → LMDB (read-only mode for account data) |

### Channel Metadata Flow

```
Registered Channel:
  SET: Client → Nefarious → Memory + LMDB
                         → P10 to X3 → ChanServ stores in SAXDB

  GET: Memory → (miss) → LMDB → (miss) → P10 query to X3

  Burst: X3 sends channel metadata → Nefarious stores in memory + LMDB

Unregistered Channel:
  SET: Client → Nefarious → Memory only
                         → P10 to other servers (memory only)
```

---

## Implementation Phases

### Phase 1: Cache-Aware Metadata Operations

**Goal**: Make LMDB a proper read-through cache for account metadata

**Nefarious Changes** (`metadata.c`):

```c
/* Enhanced get with cache-through */
struct MetadataEntry *metadata_get_client_cached(struct Client *cptr, const char *key)
{
  struct MetadataEntry *entry;
  const char *account;
  char value[METADATA_VALUE_LEN];

  /* Check in-memory first */
  entry = metadata_get_client(cptr, key);
  if (entry)
    return entry;

  /* If logged in, check LMDB cache */
  if (!IsAccount(cptr))
    return NULL;

  account = cli_account(cptr);
  if (metadata_account_get(account, key, value) == 0) {
    /* Found in LMDB - load into memory */
    metadata_set_client(cptr, key, value, METADATA_VIS_PUBLIC);
    return metadata_get_client(cptr, key);
  }

  return NULL;
}
```

**Effort**: 8-12 hours

### Phase 2: X3 Availability Detection

**Goal**: Detect when X3/Keycloak is unavailable and switch to cache mode

**Nefarious Changes**:

```c
/* In metadata.h */
extern int metadata_x3_available;
extern time_t metadata_x3_last_seen;

/* In metadata.c */
int metadata_x3_available = 0;
time_t metadata_x3_last_seen = 0;

/* Called when X3 sends any message */
void metadata_x3_heartbeat(void)
{
  metadata_x3_available = 1;
  metadata_x3_last_seen = CurrentTime;
}

/* Called periodically to check X3 health */
void metadata_x3_check(void)
{
  if (CurrentTime - metadata_x3_last_seen > 60) {
    if (metadata_x3_available) {
      metadata_x3_available = 0;
      log_write(LS_SYSTEM, L_WARNING, 0,
                "metadata: X3 unavailable, switching to cache mode");
    }
  }
}

/* Check before write operations */
int metadata_can_write_x3(void)
{
  return metadata_x3_available && metadata_lmdb_is_available();
}
```

**Effort**: 4-8 hours

### Phase 3: Write Queue for X3 Unavailability

**Goal**: Queue metadata writes when X3 is unavailable

**Data Structures**:

```c
struct MetadataWriteQueue {
  char account[ACCOUNTLEN + 1];
  char key[METADATA_KEY_LEN];
  char *value;
  int visibility;
  time_t timestamp;
  struct MetadataWriteQueue *next;
};

static struct MetadataWriteQueue *write_queue_head = NULL;
static struct MetadataWriteQueue *write_queue_tail = NULL;
static int write_queue_count = 0;
#define WRITE_QUEUE_MAX 1000
```

**Operations**:

```c
/* Queue a write when X3 unavailable */
int metadata_queue_write(const char *account, const char *key,
                         const char *value, int visibility)
{
  if (write_queue_count >= WRITE_QUEUE_MAX)
    return -1;  /* Queue full */

  /* Add to queue... */
}

/* Replay queue when X3 comes back */
void metadata_replay_queue(void)
{
  struct MetadataWriteQueue *item, *next;

  for (item = write_queue_head; item; item = next) {
    next = item->next;
    /* Send P10 MD to X3 */
    sendcmdto_one(&me, CMD_METADATA, cli_x3(), "%s %s %s :%s",
                  item->account, item->key,
                  item->visibility == METADATA_VIS_PRIVATE ? "P" : "*",
                  item->value);
    /* Free item */
  }
  write_queue_head = write_queue_tail = NULL;
  write_queue_count = 0;
}
```

**Effort**: 12-16 hours

### Phase 4: Channel Metadata in X3/ChanServ

**Goal**: Persist registered channel metadata in X3

**X3 Changes** (`chanserv.c`):

```c
/* Channel metadata storage in chanData */
struct chanData {
  /* ... existing fields ... */
  dict_t metadata;  /* Key-value dict for channel metadata */
};

/* SAXDB persistence */
static void chanserv_write_metadata(struct saxdb_context *ctx,
                                     struct chanData *channel)
{
  dict_iterator_t it;

  if (!channel->metadata || !dict_size(channel->metadata))
    return;

  saxdb_start_record(ctx, "metadata", 0);
  for (it = dict_first(channel->metadata); it; it = iter_next(it)) {
    saxdb_write_string(ctx, iter_key(it), iter_data(it));
  }
  saxdb_end_record(ctx);
}

/* Read from SAXDB */
static void chanserv_read_metadata(struct saxdb_context *ctx,
                                    struct chanData *channel)
{
  /* Parse metadata section... */
}
```

**P10 Handler** (`proto-p10.c`):

```c
/* Handle MD for channels */
static CMD_FUNC(cmd_metadata)
{
  const char *target = argv[1];

  if (target[0] == '#') {
    /* Channel metadata */
    struct chanNode *channel = GetChannel(target);
    if (!channel || !channel->channel_info)
      return 1;  /* Only for registered channels */

    /* Store in chanData->metadata dict */
    chanserv_set_metadata(channel->channel_info, key, value, visibility);
    return 1;
  }

  /* ... existing user handling ... */
}
```

**Effort**: 16-24 hours

### Phase 5: Netburst Metadata Exchange

**Goal**: Include metadata in server burst for consistency

**Nefarious Changes** (`s_user.c`, `channel.c`):

During user burst:
```c
/* After sending N (NICK) command, send metadata */
static void burst_user_metadata(struct Client *sptr, struct Client *cptr)
{
  struct MetadataEntry *entry;

  for (entry = cli_metadata(sptr); entry; entry = entry->next) {
    sendcmdto_one(&me, CMD_METADATA, cptr, "%C %s %s :%s",
                  sptr, entry->key,
                  entry->visibility == METADATA_VIS_PRIVATE ? "P" : "*",
                  entry->value);
  }
}
```

During channel burst:
```c
/* After sending B (BURST) command, send channel metadata */
static void burst_channel_metadata(struct Channel *chptr, struct Client *cptr)
{
  struct MetadataEntry *entry;

  for (entry = chptr->metadata; entry; entry = entry->next) {
    sendcmdto_one(&me, CMD_METADATA, cptr, "%s %s %s :%s",
                  chptr->chname, entry->key,
                  entry->visibility == METADATA_VIS_PRIVATE ? "P" : "*",
                  entry->value);
  }
}
```

**Effort**: 12-16 hours

### Phase 6: Multi-Server LMDB Sync Strategy

**Goal**: Handle LMDB consistency across servers

**Options Analysis**:

| Strategy | Pros | Cons |
|----------|------|------|
| A: X3 as authoritative | Simple, single source of truth | Depends on X3 availability |
| B: Leader election | Consistent writes | Complex, needs coordination |
| C: Eventual consistency | Simple, resilient | Temporary inconsistencies |
| D: No local LMDB sync | Simplest | Each server caches independently |

**Recommended**: Option D with X3 authoritative

- Each Nefarious server maintains independent LMDB cache
- X3/Keycloak is authoritative for account metadata
- Channel metadata propagated via P10
- On login, X3 sends fresh data (refreshes cache)
- LMDB is cache only, not source of truth

**Effort**: 4-8 hours (documentation and validation)

---

## Configuration Options

### New Feature Flags

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_METADATA_CACHE_ENABLED` | TRUE | Use LMDB as cache for X3 metadata |
| `FEAT_METADATA_X3_TIMEOUT` | 60 | Seconds before declaring X3 unavailable |
| `FEAT_METADATA_QUEUE_SIZE` | 1000 | Max queued writes during X3 outage |
| `FEAT_METADATA_BURST` | TRUE | Include metadata in netburst |

### X3 Configuration

```
"chanserv" {
    "metadata_enabled" = "1";       /* Enable channel metadata storage */
    "metadata_max_keys" = "20";     /* Max keys per channel */
    "metadata_max_value" = "1000";  /* Max value length */
};
```

---

## P10 Protocol Changes

### MD Token Enhancement

Current format works for all cases:
```
[SOURCE] MD [TARGET] [KEY] [VISIBILITY] :[VALUE]
```

### New Burst Behavior

After `N` (NICK) introduction:
```
AB N user 1 timestamp ident host +modes account B64IP :realname
AB MD ABAAB avatar * :https://example.com/avatar.png
AB MD ABAAB timezone * :America/New_York
```

After `B` (BURST) channel:
```
AB B #channel timestamp +nt ABAAB:o
AB MD #channel description * :Welcome to our channel
AB MD #channel rules * :Be nice
```

---

## Testing Strategy

### Unit Tests

1. **Cache operations**: Get/set with cache miss, hit
2. **X3 detection**: Timeout handling, recovery detection
3. **Write queue**: Queue, replay, overflow handling
4. **Channel metadata**: SAXDB read/write

### Integration Tests

1. **Login sync**: User logs in, metadata appears on all servers
2. **Channel metadata**: Set on one server, visible on others
3. **X3 outage**: Continue operation, queue writes, replay on recovery
4. **Netburst**: Server joins, receives all metadata

### Performance Tests

1. **Cache hit rate**: Measure LMDB cache effectiveness
2. **Burst size**: Metadata impact on burst traffic
3. **Write queue**: Handle 1000 queued operations

---

## Security Considerations

1. **Cache poisoning**: Validate metadata from P10 before caching
2. **Queue overflow**: Limit queue size, oldest-first eviction
3. **Visibility enforcement**: Never expose private metadata in cache
4. **X3 spoofing**: Validate X3 source for metadata updates

---

## Effort Summary

### Nefarious Phases

| Phase | Description | Effort |
|-------|-------------|--------|
| 1 | Cache-Aware Metadata Operations | 8-12 hours |
| 2 | X3 Availability Detection | 4-8 hours |
| 3 | Write Queue for X3 Unavailability | 12-16 hours |
| 5 | Netburst Metadata Exchange | 12-16 hours |
| 6 | Multi-Server Strategy | 4-8 hours |

### X3 Phases (SAXDB Replacement)

| Phase | Description | Effort |
|-------|-------------|--------|
| A | Add LMDB to X3 Build System | 4-8 hours |
| B | Create X3 LMDB Wrapper Module | 16-24 hours |
| C | ChanServ/NickServ LMDB Integration | 12-16 hours |
| D | SAXDB Import Layer (migration) | 12-16 hours |
| E | Remove SAXDB Write Path | 8-12 hours |
| 4 | Channel Metadata P10 Handler | 16-24 hours |
| - | Human-readable export tool | 4-6 hours |

### Testing

| Area | Effort |
|------|--------|
| Nefarious phases testing | 8-12 hours |
| X3 LMDB + migration testing | 10-14 hours |
| End-to-end metadata flow | 4-6 hours |

**Total Estimate**: 134-194 hours

Note: While this is higher than the original estimate, the full SAXDB replacement provides long-term benefits:
- Eliminates dual-maintenance burden
- Improves performance for ALL X3 operations
- Cleaner, more maintainable codebase

---

## Implementation Priority

### Must Have (Core Functionality)
- **X3 Phase A-D**: LMDB integration + SAXDB migration (prerequisite for everything else)
- Phase 1: Cache-aware operations (Nefarious)
- Phase 4: Channel metadata in X3

### Should Have (Reliability)
- **X3 Phase E**: Remove SAXDB write path (after A-D proven stable)
- Phase 2: X3 availability detection
- Phase 5: Netburst metadata

### Nice to Have (Resilience/Polish)
- Phase 3: Write queue
- Phase 6: Multi-server strategy
- Human-readable export tool

---

## X3 Database Backend Analysis

### Current State: SAXDB Limitations

SAXDB (Simple And eXtensible DataBase) is X3's current storage mechanism:

```
Write mechanism:
1. Open temp file (e.g., chanserv.db.new)
2. Serialize entire database to text format
3. Flush and close file
4. Rename temp to final (atomic replace)
5. Default write interval: 30 minutes
```

**Problems for metadata operations**:

| Issue | Impact |
|-------|--------|
| Full rewrite on save | O(n) write for any change - doesn't scale |
| Text format | Larger on disk, slower to parse |
| No random access | Must read entire file to find one key |
| No transactions | Crash during write = potential data loss |
| Delayed persistence | 30-minute window of potential data loss |
| Single-threaded writes | Blocks X3 during large database writes |

**SAXDB is fine for**: Channel registrations, user accounts (infrequent changes).
**SAXDB is problematic for**: High-frequency metadata updates, real-time sync.

### Backend Options Analysis

#### Option A: LMDB (Lightning Memory-Mapped Database)

**Already used in Nefarious** for account/channel metadata storage.

| Aspect | Details |
|--------|---------|
| Type | Embedded key-value store |
| License | OpenLDAP (permissive) |
| Transactions | Full ACID, crash-safe |
| Performance | ~10M ops/sec, memory-mapped |
| Footprint | ~32KB library, single file DB |
| Dependencies | None (self-contained) |

**Pros**:
- Already integrated in Nefarious codebase
- Zero configuration needed
- Memory-mapped = fast reads without syscalls
- B+tree = efficient range queries (list all keys for channel)
- Single-writer, multiple-reader (safe for concurrent access)
- Copy-on-write = never corrupts existing data

**Cons**:
- Max database size must be set at open time
- Memory-mapped can be problematic on 32-bit systems
- Single writer means writes must be serialized

**Integration effort**: ~16-24 hours (already have patterns from Nefarious)

#### Option B: SQLite

| Aspect | Details |
|--------|---------|
| Type | Embedded relational database |
| License | Public domain |
| Transactions | Full ACID |
| Performance | Good for reads, decent for writes |
| Footprint | ~600KB library |
| Dependencies | None |

**Pros**:
- Familiar SQL interface
- Built-in indexing, queries
- Excellent documentation
- Can query across tables (user ↔ channel relationships)

**Cons**:
- More complex API than key-value stores
- WAL mode needed for concurrent readers during write
- Slightly more overhead than LMDB

**Integration effort**: ~24-32 hours

#### Option C: PostgreSQL (via libpq)

X3 already has PostgreSQL patches in `/x3/patches/` for logging and HelpServ.

| Aspect | Details |
|--------|---------|
| Type | External relational database |
| License | PostgreSQL License (permissive) |
| Transactions | Full ACID |
| Performance | Excellent with proper indexing |
| Footprint | Requires external server |
| Dependencies | libpq, running PostgreSQL server |

**Pros**:
- Existing X3 integration patterns in patches
- Full SQL, complex queries
- Concurrent access handled by server
- Network accessible (multi-server aware)

**Cons**:
- External dependency (PostgreSQL server)
- Network latency for every operation
- Deployment complexity increased significantly
- Overkill for key-value metadata

**Integration effort**: ~32-40 hours

#### Option D: In-Memory + SAXDB Hybrid

Keep existing SAXDB but optimize for metadata:

1. Store metadata in memory hash tables
2. Write to SAXDB only on shutdown or periodic flush
3. Use write-ahead log for crash recovery

**Pros**:
- No new dependencies
- Simple implementation
- Compatible with existing infrastructure

**Cons**:
- Still has SAXDB limitations for large metadata volumes
- Requires implementing WAL manually
- Doesn't solve multi-server sync

**Integration effort**: ~12-20 hours

### Recommendation: LMDB

**Primary recommendation**: LMDB for X3 channel metadata storage

**Rationale**:
1. **Consistency with Nefarious**: Same backend reduces cognitive load, allows code sharing
2. **Proven in codebase**: Already working in Nefarious for identical use case
3. **Zero external deps**: No PostgreSQL server to manage
4. **Performance**: More than adequate for metadata operations
5. **Crash safety**: Never corrupts existing data

### LMDB Integration Plan for X3

#### Phase A: Add LMDB to X3 Build System

```bash
# configure.in additions
AC_ARG_WITH([lmdb],
  [AS_HELP_STRING([--with-lmdb=PATH],
    [Path to LMDB installation])],
  [with_lmdb=$withval],
  [with_lmdb=check])

# Check for liblmdb
AC_CHECK_LIB([lmdb], [mdb_env_create], [have_lmdb=yes], [have_lmdb=no])
AC_CHECK_HEADERS([lmdb.h], [], [have_lmdb=no])
```

**Effort**: 4-8 hours

#### Phase B: Create X3 LMDB Wrapper Module

New files: `src/lmdb_store.c`, `src/lmdb_store.h`

```c
/* Initialize LMDB environment for X3 */
int x3_lmdb_init(const char *path);
void x3_lmdb_shutdown(void);

/* Channel metadata operations */
int x3_lmdb_channel_set(const char *channel, const char *key,
                        const char *value, int visibility);
int x3_lmdb_channel_get(const char *channel, const char *key,
                        char *value, size_t value_len);
int x3_lmdb_channel_del(const char *channel, const char *key);
struct dict *x3_lmdb_channel_list(const char *channel);

/* Account metadata (future - currently uses Keycloak) */
int x3_lmdb_account_set(const char *account, const char *key,
                        const char *value, int visibility);
```

**Effort**: 16-24 hours

#### Phase C: ChanServ LMDB Integration

Modify `chanserv.c` to use LMDB for channel metadata:

```c
/* In chanserv_read_metadata() */
if (x3_lmdb_available()) {
  channel->metadata = x3_lmdb_channel_list(channel->channel->name);
} else {
  /* Fall back to SAXDB parsing */
}

/* In chanserv_write_metadata() */
/* LMDB writes are immediate, no need to batch */
```

**Effort**: 8-12 hours

### SAXDB Replacement Strategy

Rather than maintaining dual storage indefinitely, replace SAXDB with LMDB as the primary storage backend for all X3 data, keeping SAXDB only for backwards-compatible import.

#### Why Full Replacement Makes Sense

| Aspect | Dual-Storage | Full Replacement |
|--------|--------------|------------------|
| Complexity | High - two code paths | Low - single backend |
| Maintenance | Double the bugs | Single codebase |
| Performance | SAXDB still runs | Pure LMDB speed |
| Migration | Indefinite transition | Clean cutover |
| Code size | Larger | Smaller after migration |

#### Migration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    First Run (Migration)                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│   │  SAXDB      │────▶│  Migrator   │────▶│    LMDB     │   │
│   │  (*.db)     │     │  (one-time) │     │  (x3.lmdb)  │   │
│   └─────────────┘     └─────────────┘     └─────────────┘   │
│         │                                        │          │
│         ▼                                        ▼          │
│   ┌─────────────┐                         ┌─────────────┐   │
│   │  Rename to  │                         │  All future │   │
│   │  *.db.bak   │                         │  operations │   │
│   └─────────────┘                         └─────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Normal Operation                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────┐                                           │
│   │   X3 Core   │                                           │
│   └──────┬──────┘                                           │
│          │                                                   │
│          ▼                                                   │
│   ┌─────────────┐     No more SAXDB writes                  │
│   │    LMDB     │     No more periodic flush                │
│   │   Backend   │     Instant persistence                   │
│   └─────────────┘     ACID transactions                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

#### Phase D: SAXDB Import Layer (New)

Keep SAXDB **read-only** for importing existing databases:

```c
/* saxdb_import.c - One-time migration from SAXDB to LMDB */

int saxdb_import_to_lmdb(const char *saxdb_path, const char *lmdb_path);

/* Called once at startup if LMDB is empty but SAXDB exists */
void x3_migrate_databases(void) {
  if (!x3_lmdb_has_data() && saxdb_file_exists("chanserv.db")) {
    log_module(MAIN_LOG, LOG_INFO, "Migrating SAXDB to LMDB...");
    saxdb_import_to_lmdb("chanserv.db", "x3.lmdb");
    saxdb_import_to_lmdb("nickserv.db", "x3.lmdb");
    /* ... other databases ... */
    rename("chanserv.db", "chanserv.db.bak");
    log_module(MAIN_LOG, LOG_INFO, "Migration complete. Old files renamed to *.bak");
  }
}
```

**Effort**: 12-16 hours

#### Phase E: Remove SAXDB Write Path (New)

Once LMDB is stable, remove SAXDB writer code entirely:

1. Remove `saxdb_write_*()` functions from service modules
2. Remove periodic write timers
3. Keep `saxdb_read_*()` for import compatibility
4. Simplify build (optional SAXDB for legacy import only)

**Effort**: 8-12 hours

#### Human-Readable Export

For debugging/backup, add LMDB export to text format:

```c
/* Export LMDB to human-readable format (like old SAXDB) */
int x3_lmdb_export_text(const char *lmdb_path, const char *output_path);

/* CLI command: /msg OpServ EXPORTDB */
```

This provides the benefits of SAXDB's readability without the runtime cost.

**Effort**: 4-6 hours

### Updated X3 Phase Summary

| Phase | Description | Effort |
|-------|-------------|--------|
| A | Add LMDB to X3 Build System | 4-8 hours |
| B | Create X3 LMDB Wrapper Module | 16-24 hours |
| C | ChanServ/NickServ LMDB Integration | 12-16 hours |
| D | SAXDB Import Layer (migration) | 12-16 hours |
| E | Remove SAXDB Write Path | 8-12 hours |
| - | Human-readable export tool | 4-6 hours |

**X3 Subtotal**: 56-82 hours

This is more work upfront but results in:
- Cleaner codebase long-term
- No dual-maintenance burden
- Better performance for all X3 operations (not just metadata)
- Simpler deployment (no periodic DB writes blocking)

---

## Dependencies

| Dependency | Status |
|------------|--------|
| LMDB support in Nefarious | Complete |
| Keycloak integration in X3 | Complete |
| MD P10 token | Complete |
| Visibility support | Complete |
| SAXDB in X3 | Complete |
| **LMDB in X3** | **New - Required for Phase 4** |

---

## Future Considerations

### 1. Shared LMDB Between Nefarious and X3

**Question**: Could Nefarious and X3 share a single LMDB database file?

**Analysis**:

```
Current Architecture:
┌─────────────┐    ┌─────────────┐
│  Nefarious  │    │     X3      │
│  (Process A)│    │  (Process B)│
└──────┬──────┘    └──────┬──────┘
       │                   │
       ▼                   ▼
┌─────────────┐    ┌─────────────┐
│ nef.lmdb    │    │  x3.lmdb    │
│ (metadata)  │    │ (channels,  │
└─────────────┘    │  accounts)  │
                   └─────────────┘

Proposed Shared Architecture:
┌─────────────┐    ┌─────────────┐
│  Nefarious  │    │     X3      │
│  (Process A)│    │  (Process B)│
└──────┬──────┘    └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 ▼
         ┌─────────────┐
         │ shared.lmdb │
         │ (all data)  │
         └─────────────┘
```

**LMDB Multi-Process Semantics**:

| Aspect | LMDB Behavior |
|--------|---------------|
| Multiple readers | Fully supported, concurrent access |
| Single writer | Only one process can write at a time |
| Write lock | Global lock across all processes |
| Readers during write | Readers see consistent snapshot |

**Challenges**:

1. **Write contention**: Both Nefarious and X3 want to write frequently
   - Nefarious: Metadata updates, cache writes
   - X3: Channel/account changes, service operations
   - Would need to serialize all writes through lock

2. **Different data models**:
   - Nefarious stores per-client metadata, P10 state
   - X3 stores service-level data (registrations, access lists)
   - Mixing these in one DB makes schema complex

3. **Failure isolation**: If one process corrupts the DB, both fail
   - Separate DBs = one can recover independently

4. **Upgrade complexity**:
   - Can't upgrade X3 independently of Nefarious
   - Schema changes affect both

**Alternative: Shared via P10**:

Current P10 protocol already provides real-time sync:
```
Nefarious sets metadata → MD token → X3 receives → stores in x3.lmdb
X3 sets metadata → MD token → Nefarious receives → stores in nef.lmdb
```

This is effectively a distributed database with eventual consistency.

**Recommendation**: Keep separate LMDB files.

**Rationale**:
- P10 provides real-time sync without shared storage complexity
- Write contention would hurt performance
- Failure isolation is important for production
- Separate files = independent upgrades

**Effort to implement if pursued**: 24-32 hours (not recommended)

---

### 2. Metadata Expiry (TTL)

**Question**: Should metadata entries expire automatically after a certain time?

**Use Cases for TTL**:

| Scenario | TTL Benefit |
|----------|-------------|
| User hasn't logged in for months | Free cache memory |
| Stale channel metadata | Ensure freshness |
| Orphaned metadata (deleted account/channel) | Cleanup |
| Temporary metadata (e.g., typing indicator) | Auto-cleanup |

**Implementation Approaches**:

#### Approach A: Per-Entry TTL

```c
struct MetadataEntry {
  char *key;
  char *value;
  int visibility;
  time_t created;
  time_t expires;        /* 0 = never expires */
  struct MetadataEntry *next;
};

/* In LMDB, store as: */
struct LMDBMetadata {
  uint32_t visibility;
  uint32_t created;
  uint32_t expires;      /* Seconds since epoch, or 0 */
  uint16_t value_len;
  char value[];
};
```

**Pros**:
- Granular control per key
- Some metadata can be permanent, others temporary
- Supports future "ephemeral metadata" use cases

**Cons**:
- Extra 4-8 bytes per entry
- Requires periodic sweep to clean expired entries
- Complexity in LMDB storage format

#### Approach B: Global Sweep with Last-Access Time

```c
/* Track last access time, sweep entries not accessed in N days */
void metadata_sweep_stale(int max_age_seconds) {
  time_t cutoff = CurrentTime - max_age_seconds;
  /* Iterate LMDB, delete entries with last_access < cutoff */
}
```

**Pros**:
- Simple implementation
- Cleans up genuinely unused data
- No per-entry overhead

**Cons**:
- All-or-nothing - can't keep some permanent
- Requires tracking last access (write on every read)

#### Approach C: Event-Based Cleanup Only

Current approach - clean up when:
- User disconnects (clear in-memory)
- Account deleted (X3 notifies, clear LMDB)
- Channel destroyed (clear channel metadata)

**Pros**:
- No timer overhead
- Simple, predictable behavior
- Already partially implemented

**Cons**:
- Orphaned data possible if cleanup missed
- Long-unused data stays in cache

**Recommendation**: Approach C (Event-Based) with Approach A for future ephemeral metadata

**Implementation Plan**:

| Phase | Scope | When |
|-------|-------|------|
| Current | Event-based cleanup only | Now |
| Future | Add optional TTL field to LMDB format | When ephemeral metadata needed |
| Future | Periodic sweep for expired entries | When ephemeral metadata needed |

**Effort**: 4-6 hours for current approach, 12-16 hours for full TTL support

---

### 3. Sync On Demand

**Question**: Should Nefarious be able to request metadata from X3 for specific users/channels?

**Current Flow**:
```
User logs in → X3 sends ALL metadata via P10 → Nefarious caches
```

**On-Demand Flow**:
```
Client requests metadata for user not in cache
  → Nefarious checks: is it in cache? No
  → Nefarious queries X3: "send metadata for account X"
  → X3 looks up Keycloak/LMDB
  → X3 sends MD tokens
  → Nefarious caches and returns to client
```

**Use Cases**:

| Scenario | Benefit |
|----------|---------|
| WHOIS on offline user | Show metadata without pre-loading |
| Channel ACCESS listing | Get metadata for all users with access |
| Bot integration | Look up user metadata without login |
| Search functionality | Find users by metadata value |

**P10 Protocol Extension**:

```
New token: MDQ (Metadata Query)

Format: [SOURCE] MDQ [TARGET] [KEY|*]

Examples:
AB MDQ NickServ *         → "Send all metadata for account NickServ"
AB MDQ #channel url       → "Send 'url' metadata for #channel"
AB MDQ Rubin timezone     → "Send 'timezone' for account Rubin"

Response: Standard MD tokens
AB MD Rubin timezone * :America/New_York

Error response (if not found):
AB MDQ Rubin unknown      → No response (or empty MD)
```

**Implementation Requirements**:

1. **Nefarious changes**:
   - New `m_metadata_query.c` handler for MDQ token
   - Track pending queries (avoid duplicate queries)
   - Timeout for unanswered queries
   - Cache results when received

2. **X3 changes**:
   - Handle MDQ token in `proto-p10.c`
   - Look up metadata from Keycloak/LMDB
   - Send MD tokens in response

3. **Rate limiting**:
   - Limit queries per source to prevent abuse
   - Cache negative results ("no metadata") briefly

**Security Considerations**:

- Only return public (`*`) metadata for arbitrary queries
- Private (`P`) metadata only to authenticated requestor
- Rate limit to prevent enumeration attacks

**Effort**: 16-24 hours

---

### 4. Compression for Large Metadata Values

**Question**: Should large metadata values be compressed in LMDB?

**Current Limits**:

```c
#define METADATA_VALUE_LEN 1000  /* Max value length */
```

**Compressible Metadata Types**:

| Type | Example | Typical Size | Compressible? |
|------|---------|--------------|---------------|
| Avatar URL | https://cdn.example.com/avatar.png | 50-100 bytes | No (short) |
| Bio/Description | User-written text | 100-500 bytes | Maybe |
| JSON blob | Structured settings | 200-1000 bytes | Yes |
| Base64 data | Small images | 500-10000 bytes | Yes |

**Compression Options**:

#### Option A: LZ4 (Fast)

```c
#include <lz4.h>

int metadata_compress(const char *in, size_t in_len,
                      char *out, size_t *out_len) {
  int compressed = LZ4_compress_default(in, out, in_len, *out_len);
  if (compressed > 0) {
    *out_len = compressed;
    return 0;
  }
  return -1;  /* Compression failed or didn't help */
}
```

**Pros**:
- Extremely fast (500 MB/s compression, 2 GB/s decompression)
- Low CPU overhead
- Good for real-time systems

**Cons**:
- Lower compression ratio (~2:1)
- Adds LZ4 dependency

#### Option B: Zstd (Balanced)

```c
#include <zstd.h>

int metadata_compress(const char *in, size_t in_len,
                      char *out, size_t *out_len) {
  size_t compressed = ZSTD_compress(out, *out_len, in, in_len, 1);
  if (!ZSTD_isError(compressed)) {
    *out_len = compressed;
    return 0;
  }
  return -1;
}
```

**Pros**:
- Better ratio (~3:1 to 5:1)
- Still fast (300 MB/s)
- Modern, well-maintained

**Cons**:
- Larger library (~1MB)
- Adds dependency

#### Option C: No Compression (Current)

**Pros**:
- Simple
- No dependencies
- Predictable performance

**Cons**:
- Larger LMDB database
- More I/O for large values

**Storage Format with Compression**:

```c
/* LMDB value format */
struct LMDBMetadataValue {
  uint8_t  flags;         /* Bit 0: compressed */
  uint8_t  compression;   /* 0=none, 1=lz4, 2=zstd */
  uint16_t original_len;  /* Uncompressed length */
  uint16_t stored_len;    /* Actual stored length */
  char     data[];        /* Compressed or raw data */
};
```

**When to Compress**:

```c
#define METADATA_COMPRESS_THRESHOLD 256  /* Only compress if > 256 bytes */

if (value_len > METADATA_COMPRESS_THRESHOLD) {
  /* Attempt compression */
  if (compressed_len < value_len * 0.9) {
    /* Only use if 10%+ smaller */
    store_compressed();
  } else {
    store_raw();
  }
}
```

**Recommendation**: No compression initially, add LZ4 if LMDB grows large

**Rationale**:
- Current max value is 1000 bytes - small
- Compression overhead may exceed savings
- Add later if database size becomes concern

**Effort**: 8-12 hours (if implemented)

---

### 5. Keycloak Groups for Channel Access

See detailed analysis below

### Keycloak Group Integration for Channels

#### Currently Implemented in X3 (`keycloak.c`)

| Function | Keycloak API | Purpose |
|----------|--------------|---------|
| `keycloak_get_group_by_name()` | `GET /groups?search=` | Look up group by name, returns UUID |
| `keycloak_add_user_to_group()` | `PUT /users/{id}/groups/{groupId}` | Add user to group |
| `keycloak_remove_user_from_group()` | `DELETE /users/{id}/groups/{groupId}` | Remove user from group |
| `keycloak_get_user_attribute()` | `GET /users/{id}` | Get single user attribute |
| `keycloak_set_user_attribute()` | `PUT /users/{id}` | Set user attribute |
| `keycloak_list_user_attributes()` | `GET /users/{id}` | List attributes with prefix |

**Current usage**: Oper group membership - when a user's opserv level exceeds `keycloak_oper_group_level`, they're added to the configured `keycloak_oper_group`.

#### Available but NOT Implemented

These Keycloak REST API endpoints could be useful for channel integration:

| Endpoint | Method | Purpose | Use Case |
|----------|--------|---------|----------|
| `/groups` | POST | Create group | Auto-create group when channel registered |
| `/groups/{id}` | PUT | Update group (including attributes) | Store channel metadata in group attrs |
| `/groups/{id}` | DELETE | Delete group | Clean up when channel dropped |
| `/groups/{id}` | GET | Get group with attributes | Retrieve channel config from KC |
| `/groups/{id}/members` | GET | List group members | Get channel access list |
| `/users/{id}/groups` | GET | List user's groups | Get all channels user has access to |
| `/users/{id}/groups/count` | GET | Count user's groups | Quick check for access |

#### Group Attributes for Channel Metadata

Keycloak groups support custom attributes (`Map<String, List<String>>`). This could store:

```json
{
  "name": "irc-channel-#afternet",
  "attributes": {
    "irc_channel": ["#afternet"],
    "irc_default_modes": ["+nt"],
    "irc_entrymsg": ["Welcome to AfterNET!"],
    "irc_max_users": ["500"],
    "metadata.url": ["https://afternet.org"],
    "metadata.description": ["The main AfterNET channel"]
  }
}
```

**Pros of group attributes**:
- Single source of truth in Keycloak
- Accessible via Keycloak Admin UI
- Survives X3 restarts without local storage
- Could sync across multiple X3 instances

**Cons**:
- Requires admin API for every metadata change (network latency)
- Not designed for high-frequency updates
- No P10-style real-time sync to IRCd

#### Potential Channel Integration

Keycloak groups could map to IRC channels:

```
Keycloak Group          IRC Channel
─────────────────────────────────────
irc-channel-#afternet   #afternet (access level from group attrs)
irc-channel-#help       #help
irc-opers               Auto-oper on connect
```

**Benefits**:
- Centralized access control (single source of truth)
- SSO integration (corporate/org identity → IRC access)
- Group attributes could store access levels
- Works with existing Keycloak admin UI

**Challenges**:
- Keycloak groups are flat or hierarchical, not key-value
- Would need convention for mapping group → channel + access level
- Network latency for group membership checks
- Channel metadata (topic, modes) doesn't fit group model well

**Possible approaches**:

1. **Groups as access lists only**: Use Keycloak groups for "who can access channel" but keep channel metadata in LMDB
   ```
   Group: irc-channel-#secret
   Members: user1, user2, user3
   Attributes: {"irc_access_level": "300", "irc_autoop": "true"}
   ```

2. **Hybrid model**: Keycloak for authentication/authorization, LMDB for channel state
   ```
   Keycloak: Who is allowed in #channel, at what level
   LMDB: Channel topic, modes, metadata, bans
   ```

3. **Group attributes as metadata**: Store channel metadata in group custom attributes
   ```
   Group: irc-channel-#mychannel
   Attributes: {
     "irc_topic": "Welcome to the channel",
     "irc_modes": "+nt",
     "metadata.description": "Our main hangout"
   }
   ```
   Con: Requires admin API calls for every metadata change

**Recommendation**: Option 2 (Hybrid) - Use Keycloak groups for channel access control only, keep channel metadata in LMDB. This leverages Keycloak's strengths (identity, authorization) without trying to make it do things it wasn't designed for.

#### New Keycloak Functions Needed for Full Integration

If pursuing Option 1 or 3 (deeper KC integration), these functions would need to be added to `keycloak.c`:

```c
/* Group CRUD operations */
int keycloak_create_group(realm, client, group_name, attributes, group_id_out);
int keycloak_update_group(realm, client, group_id, attributes);
int keycloak_delete_group(realm, client, group_id);
int keycloak_get_group(realm, client, group_id, group_out);  /* Full group with attrs */

/* Group membership queries */
int keycloak_get_group_members(realm, client, group_id, members_out, count_out);
int keycloak_get_user_groups(realm, client, user_id, groups_out, count_out);

/* Group attribute operations (if storing metadata in KC) */
int keycloak_set_group_attribute(realm, client, group_id, attr_name, attr_value);
int keycloak_get_group_attribute(realm, client, group_id, attr_name, value_out);
int keycloak_list_group_attributes(realm, client, group_id, prefix, entries_out);
```

**Effort for full KC group integration**: 24-32 hours

#### Recommended Phased Approach

| Phase | Scope | Effort |
|-------|-------|--------|
| 1 | Use existing group functions for channel access control | 8-12 hours |
| 2 | Add `keycloak_get_group_members()` for listing channel access | 4-6 hours |
| 3 | Add `keycloak_get_user_groups()` for "what channels can I access" | 4-6 hours |
| 4 | (Optional) Add group CRUD for auto-creating channel groups | 8-12 hours |
| 5 | (Optional) Add group attributes for KC-stored metadata | 8-12 hours |

**Total for hybrid model (Phases 1-3)**: 16-24 hours
**Total for full KC integration (Phases 1-5)**: 32-48 hours

---

## Decision Points

### Resolved Decisions

1. **LMDB vs SQLite for X3?** - Decided: LMDB for consistency with Nefarious
2. **SAXDB replacement vs dual-storage?** - Decided: Full replacement with import layer

### Decision 3: Write Queue Persistence

**Question**: When X3/Keycloak is unavailable and Nefarious queues metadata writes, should the queue be in memory or persisted to LMDB?

| Option | Pros | Cons |
|--------|------|------|
| **Memory only** | Simple, fast, no I/O | Lost on crash/restart |
| **LMDB persisted** | Survives restarts, durable | More complex, I/O overhead |

**Recommendation: Memory only with size limit**

Rationale:
- X3 outages should be brief (minutes, not hours)
- If Nefarious restarts during X3 outage, metadata is already in LMDB cache
- Persisting queue adds complexity for rare edge case
- Queue size limit (1000 entries) prevents memory exhaustion
- On Nefarious restart, X3 will re-sync on reconnect anyway

```c
#define METADATA_WRITE_QUEUE_MAX 1000

/* Queue structure - memory only */
struct MetadataWriteQueue {
  char account[ACCOUNTLEN + 1];
  char key[METADATA_KEY_LEN];
  char *value;
  int visibility;
  time_t timestamp;
  struct MetadataWriteQueue *next;
};

/* On X3 reconnect, replay queue then clear */
void metadata_x3_reconnected(void) {
  metadata_replay_queue();  /* Send all queued writes to X3 */
  metadata_clear_queue();   /* Free memory */
}
```

**Decision: Memory-only queue with 1000 entry limit. Oldest entries evicted if full.**

---

### Decision 4: Burst Optimization

**Question**: Should metadata be batched into single P10 messages during netburst?

| Option | Pros | Cons |
|--------|------|------|
| **One MD per key** | Simple, existing format works | More messages, more overhead |
| **Batched MD** | Fewer messages, faster burst | New P10 format needed |

**Analysis of current burst traffic**:

```
Current (one per key):
AB N user 1 timestamp ident host +modes account B64IP :realname
AB MD ABAAB avatar * :https://example.com/avatar.png
AB MD ABAAB timezone * :America/New_York
AB MD ABAAB url * :https://mysite.com

Batched (hypothetical):
AB N user 1 timestamp ident host +modes account B64IP :realname
AB MDB ABAAB avatar=https://example.com/avatar.png,timezone=America/New_York,url=https://mysite.com
```

**Recommendation: Keep one MD per key (no batching)**

Rationale:
- Average user has 2-5 metadata keys - batching saves minimal overhead
- Existing MD format is well-tested and understood
- Batching requires escaping values (commas, equals signs) - complexity
- P10 line length limit (512 bytes) constrains batch size anyway
- Channels have even fewer metadata keys typically
- Optimization is premature - measure first, optimize if needed

**Decision: No batching. Use existing one-MD-per-key format.**

---

### Decision 5: Cache TTL

**Question**: Should cached metadata entries in LMDB expire automatically?

| Option | Pros | Cons |
|--------|------|------|
| **No TTL** | Simple, no timer overhead | Stale data possible if X3 changes |
| **TTL with refresh** | Fresh data guaranteed | Timer complexity, more X3 queries |
| **TTL with lazy refresh** | Balance of freshness/performance | Still need staleness handling |

**Analysis of data flow**:

```
User metadata lifecycle:
1. User logs in → X3 sends all metadata via P10 → Nefarious caches
2. User sets metadata → Nefarious updates cache + sends to X3
3. User logs out → Cache entry remains (for next login optimization)
4. User logs in again → X3 sends fresh data → Cache refreshed

Channel metadata lifecycle:
1. Channel burst → X3 sends metadata → Nefarious caches
2. Metadata set → Immediate update to both
3. Channel empty/destroyed → Cache cleared
4. Channel recreated → Fresh data from X3
```

**Recommendation: No automatic TTL expiry**

Rationale:
- X3 is authoritative - it sends fresh data on login/burst
- TTL would cause unnecessary X3 queries
- Stale data only possible if X3 changes data without P10 notification (shouldn't happen)
- Memory cleanup happens naturally (user disconnect, channel destroy)
- Could add optional `FEAT_METADATA_CACHE_TTL` later if needed

**Exception**: If implementing "sync on demand" (Future Consideration #3), could add per-entry timestamps for staleness detection without automatic expiry.

**Decision: No TTL. Cache refreshed on login/burst. Optional staleness tracking for future sync-on-demand.**

---

### Decision 6: Migration Rollback

**Question**: How long to keep *.db.bak files after SAXDB → LMDB migration?

| Option | Timeframe | Pros | Cons |
|--------|-----------|------|------|
| **Delete immediately** | 0 | Clean, saves space | No rollback possible |
| **Keep 7 days** | 1 week | Quick rollback window | Manual cleanup needed |
| **Keep 30 days** | 1 month | Extended safety net | Uses disk space |
| **Keep indefinitely** | Forever | Maximum safety | Clutter, forgotten files |
| **Keep until explicit delete** | User decides | Full control | Manual action required |

**Recommendation: Keep until explicit OpServ command**

Rationale:
- Migration is one-time, not repeated
- Disk space for *.db.bak is minimal (text files)
- Admin should verify LMDB is working before deleting backups
- Automatic deletion could delete files before admin notices issues
- OpServ command provides audit trail

```c
/* OpServ command to clean up migration backups */
static MODCMD_FUNC(cmd_clearmigration) {
  /* Delete *.db.bak files */
  unlink("chanserv.db.bak");
  unlink("nickserv.db.bak");
  /* ... */
  reply("OSMSG_MIGRATION_CLEANED");
  return 1;
}
```

**Decision: Keep *.db.bak indefinitely. Add OpServ CLEARMIGRATION command for explicit cleanup.**

---

### Decision Summary

| # | Decision | Resolution |
|---|----------|------------|
| 1 | LMDB vs SQLite | LMDB |
| 2 | SAXDB replacement | Full replacement with import layer |
| 3 | Write queue persistence | Memory-only, 1000 entry limit |
| 4 | Burst optimization | No batching, one MD per key |
| 5 | Cache TTL | No automatic expiry |
| 6 | Migration rollback | Keep *.db.bak until OpServ CLEARMIGRATION |

---

## References

- [IRCv3 metadata specification](https://ircv3.net/specs/extensions/metadata)
- [METADATA_INVESTIGATION.md](../investigations/METADATA_INVESTIGATION.md) - Current implementation status
- [P10_PROTOCOL_REFERENCE.md](../../P10_PROTOCOL_REFERENCE.md) - MD token documentation
- Nefarious `ircd/metadata.c` - Core implementation
- X3 `src/nickserv.c` - Keycloak integration
