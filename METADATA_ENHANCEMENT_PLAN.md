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

### X3 Phases (Updated with LMDB)

| Phase | Description | Effort |
|-------|-------------|--------|
| A | Add LMDB to X3 Build System | 4-8 hours |
| B | Create X3 LMDB Wrapper Module | 16-24 hours |
| C | ChanServ LMDB Integration | 8-12 hours |
| 4 | Channel Metadata P10 Handler | 16-24 hours |

### Testing

| Area | Effort |
|------|--------|
| Nefarious phases testing | 8-12 hours |
| X3 LMDB integration testing | 6-10 hours |
| End-to-end metadata flow | 4-6 hours |

**Total Estimate**: 96-148 hours (increased due to LMDB integration)

---

## Implementation Priority

### Must Have (Core Functionality)
- **X3 Phase A-C**: LMDB integration (prerequisite for everything else)
- Phase 1: Cache-aware operations
- Phase 4: Channel metadata in X3

### Should Have (Reliability)
- Phase 2: X3 availability detection
- Phase 5: Netburst metadata

### Nice to Have (Resilience)
- Phase 3: Write queue
- Phase 6: Multi-server strategy

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

### Dual-Storage Strategy

For reliability during transition:

```
             ┌─────────────────┐
             │  ChanServ MD    │
             │    Request      │
             └────────┬────────┘
                      │
              ┌───────▼───────┐
              │  Write Both   │
              │  LMDB + SAXDB │
              └───────┬───────┘
         ┌────────────┴────────────┐
         ▼                         ▼
   ┌─────────────┐          ┌─────────────┐
   │    LMDB     │          │   SAXDB     │
   │  (Primary)  │          │  (Backup)   │
   └─────────────┘          └─────────────┘
         │                         │
         │    On read:             │
         └────────┬────────────────┘
                  │
          ┌───────▼───────┐
          │  Read from    │
          │  LMDB first,  │
          │  fallback to  │
          │  SAXDB if     │
          │  not found    │
          └───────────────┘
```

This allows:
- Gradual migration without data loss
- SAXDB still provides human-readable backup
- Can disable SAXDB writes once LMDB is proven stable

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

1. **Shared LMDB**: Could Nefarious and X3 share LMDB file? (Probably not - different processes)
2. **Metadata expiry**: TTL for cached metadata entries
3. **Sync on demand**: Request metadata from X3 for specific users/channels
4. **Compression**: Compress large metadata values in LMDB
5. **Keycloak for channels**: If Keycloak adds group support, use for channels

---

## Decision Points

Before implementing:

1. **LMDB vs SQLite for X3?** - Recommended: LMDB for consistency with Nefarious
2. **Write queue persistence?** - Queue in memory or persist to LMDB?
3. **Burst optimization?** - Batch metadata in single P10 message?
4. **Cache TTL?** - Should cached entries expire?
5. **Dual-storage duration?** - How long to maintain SAXDB backup?

---

## References

- [IRCv3 metadata specification](https://ircv3.net/specs/extensions/metadata)
- [METADATA_INVESTIGATION.md](METADATA_INVESTIGATION.md) - Current implementation status
- [P10_PROTOCOL_REFERENCE.md](P10_PROTOCOL_REFERENCE.md) - MD token documentation
- Nefarious `ircd/metadata.c` - Core implementation
- X3 `src/nickserv.c` - Keycloak integration
