# Keycloak Access Sync Rework Plan

## Implementation Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 - Batch processing | ✅ Complete | `chanserv.c` refactored with `kc_sync_state`, `chanserv_sync_keycloak_batch()`, priority queue |
| 6 - Resilient failure handling | ✅ Complete | LMDB per-channel metadata (`lmdb_chansync_meta`), exponential backoff (30s→1h), `x3_lmdb_chansync_*()` functions |
| 3 - Priority queue | ✅ Complete | `kc_channel_priority()`, `kc_sync_priority_cmp()`, configurable |
| 4a - Hash-based incremental | ✅ Complete | FNV-1a hash via `kc_membership_hash_*()`, comparison in attribute mode, `unchanged_syncs` stat |
| 4b - Webhooks (GROUP_MEMBERSHIP) | ✅ Complete | GROUP_MEMBERSHIP + GROUP UPDATE handlers in `keycloak_webhook.c`, `group_syncs` stat |
| OpServ KCSYNC commands | ✅ Complete | `cmd_kcsync()` in opserv.c with STATUS/STATS/CHANNEL/ALL/ABORT/RESET subcommands, accessor funcs in chanserv.c |
| 4c - Expanded webhook coverage | ⚠️ Partial | SCRAM invalidation ✅, fingerprint pre-warm ✅, opserv/metadata detection (tracking only, see TODO) |
| 2 - Async pull sync | ⏳ Pending | |
| 5 - Distributed sync window | ⏳ Pending | Config added (`keycloak_sync_distributed`), logic TBD |

### Phase 4c TODO Items

The following 4c handlers are **tracking/logging only** and need additional work:

1. **OpServ level invalidation** - Currently just increments `stats.opserv_invalidations`. This is acceptable since opserv level is fetched live from Keycloak on each check (no local cache exists). Could add local cache later for performance.

2. **Metadata invalidation** - Currently just increments `stats.metadata_invalidations` and relies on TTL expiration. Needs `x3_lmdb_metadata_delete_by_prefix()` function to immediately purge `meta:<username>.*` keys instead of waiting for TTL.

---

## Implementation Review (vs Plan)

### Divergences from Plan

| Area | Plan | Implemented | Risk |
|------|------|-------------|------|
| **Backoff timing** | 5min→30min→2hr | 30s→60s→2min→4min...→1hr (exponential) | Low - current is more conservative |
| **Priority queue for webhook** | Proper queue with HIGH/IMMEDIATE priorities | ✅ Implemented with pending queue | None - fixed |
| **CHANNEL_IMPORTANT flag** | +200 score in priority | Not implemented | Low - minor feature |
| **`kc_channel_sync_meta` in chanData** | Store in struct chanData | Stored in LMDB via `lmdb_chansync_meta` | None - LMDB approach is better |

### Potential Issues

1. **`chanserv_queue_keycloak_sync()` pending queue** ✅ FIXED
   - Added `struct kc_pending_sync` linked list to track channels queued during batch
   - HIGH+ priority requests during batch are added to pending queue
   - `kc_sync_process_pending()` processes pending queue after batch completes (or aborts)
   - Duplicate detection: if channel already pending, updates priority if higher

2. **Hash-only in attribute mode**
   - Hash-based incremental sync only works in attribute mode (`chanserv_sync_keycloak_group_with_attribute`)
   - Legacy mode (`chanserv_sync_keycloak_group`) stores entry count as "hash" - not true incremental
   - **Impact**: Legacy mode users don't get incremental sync benefits

3. **Phase 4c partial completion**
   - OpServ level: Tracking only (acceptable - fetched live)
   - Metadata: Tracking only (needs prefix-delete for immediate invalidation)

### Working Correctly ✅

- **Batch processing**: `kc_sync_state`, `chanserv_sync_keycloak_batch()`, `timeq` integration
- **Priority queue**: `kc_channel_priority()` scoring, `qsort` ordering
- **Exponential backoff**: LMDB-based `lmdb_chansync_meta` with failure tracking
- **FNV-1a hash**: `kc_membership_hash_init/add()` for incremental sync
- **SCRAM invalidation**: Calls real `x3_lmdb_scram_*` functions
- **Fingerprint pre-warm**: Calls real `x3_lmdb_fingerprint_set()`
- **GROUP_MEMBERSHIP handler**: Queues immediate sync for channel
- **OpServ KCSYNC**: STATUS/STATS/CHANNEL/ALL/ABORT/RESET all implemented

---

## Problem Statement

The current Keycloak access sync implementation processes all channels synchronously in a single blocking operation. For large deployments (6000+ entries across 50+ channels), this creates:

1. **Log spam** - Single summary dump after processing thousands of entries
2. **Blocking behavior** - Services unresponsive during sync
3. **No rate limiting** - Rapid-fire API calls to Keycloak
4. **No incremental sync** - Full sync every time, even if nothing changed
5. **No prioritization** - Inactive channels synced same as active ones
6. **Poor failure handling** - One failure can affect entire sync

## Current Architecture

```
chanserv_sync_keycloak_access()
├── for each channel in channelList (BLOCKING)
│   └── chanserv_sync_keycloak_channel()
│       └── HTTP GET to Keycloak (SYNCHRONOUS)
│           └── Process all members
│               └── Write to LMDB
└── Log summary
└── Schedule next sync (keycloak_sync_frequency)
```

**Location**: `x3/src/chanserv.c` lines 11065-11105

## Proposed Architecture

### Phase 1: Batch Processing with Progress Logging

**Goal**: Break monolithic sync into digestible chunks with visibility

```
chanserv_sync_keycloak_access()
├── Initialize sync state
├── Schedule first batch
└── return (non-blocking)

chanserv_sync_keycloak_batch() [called via timeq]
├── Process KC_SYNC_BATCH_SIZE channels
├── Log progress: "Sync progress: X/Y channels (Z entries)"
├── if more channels:
│   └── timeq_add(next batch after KC_SYNC_BATCH_DELAY_MS)
└── else:
    └── Log completion, schedule next full sync
```

**New Configuration Options**:
```c
"keycloak_sync_batch_size" "10"       /* Channels per batch (default: 10) */
"keycloak_sync_batch_delay" "100"     /* Ms between batches (default: 100) */
```

**Implementation**:
- New struct `kc_sync_state` to track progress across batches
- Use existing `timeq` infrastructure for scheduling
- Yields control between batches, services remain responsive

---

### Phase 2: Async Pull Sync

**Goal**: Use existing curl_multi infrastructure for non-blocking HTTP

Currently, the push (bidirectional) sync already uses async HTTP via `keycloak_add_user_to_group_async()`. The pull sync should do the same.

```
chanserv_sync_keycloak_channel_async()
├── keycloak_get_group_members_async(callback)
└── return immediately

kc_group_members_callback()
├── Parse response
├── Update LMDB
├── Trigger next channel in batch
└── Update progress
```

**New Async Request Type**:
```c
enum kc_async_type {
    // ... existing types ...
    KC_ASYNC_GROUP_MEMBERS,   /* Get group members for pull sync */
};
```

**Benefits**:
- Leverages existing handle pool (8 concurrent requests)
- Non-blocking throughout entire sync
- Natural rate limiting via pool size

---

### Phase 3: Priority Queue

**Goal**: Sync active/important channels first

```c
struct kc_sync_queue {
    struct chanData **channels;
    int count;
    int current;
};

/* Priority scoring */
int kc_channel_priority(struct chanData *cData) {
    int score = 0;
    if (cData->channel && cData->channel->members.used > 0)
        score += 100;  /* Has active users */
    if (cData->visited > now - 3600)
        score += 50;   /* Recent activity */
    if (cData->flags & CHANNEL_IMPORTANT)
        score += 200;  /* Marked important */
    return score;
}
```

**Sync Order**:
1. Channels with active users (members present)
2. Recently active channels (visited in last hour)
3. All other registered channels

**New Configuration**:
```c
"keycloak_sync_prioritize" "1"        /* Enable priority sorting (default: 1) */
```

---

### Phase 4: Incremental/Delta Sync

**Goal**: Only sync what changed since last sync

#### Option A: Keycloak Webhooks (Preferred) - INTEGRATE WITH EXISTING

X3 already has a complete webhook infrastructure in `keycloak_webhook.c` that handles USER, CREDENTIAL, and SESSION events. We just need to add GROUP_MEMBERSHIP handling.

**Existing Infrastructure** (`x3/src/keycloak_webhook.c`):
- HTTP listener on configurable port
- JSON parsing with jansson
- Secret validation
- Statistics tracking
- Already integrated with ioset event loop

**Add to `handle_keycloak_event()`**:
```c
/* Add to existing event type handling in keycloak_webhook.c */
} else if (strcmp(resource_type, "GROUP_MEMBERSHIP") == 0) {
    /* Group membership change - sync affected channel */
    const char *group_path = NULL;
    const char *user_id = NULL;

    /* resourcePath format: groups/<group-id>/members/<user-id> */
    if (resource_path) {
        group_path = resource_path;
    }

    /* Extract group name from representation */
    if (representation) {
        json_t *rep_json = json_loads(representation, 0, NULL);
        if (rep_json) {
            json_t *gname = json_object_get(rep_json, "name");
            json_t *gpath = json_object_get(rep_json, "path");
            if (gpath && json_is_string(gpath))
                group_path = json_string_value(gpath);
            json_decref(rep_json);
        }
    }

    if (group_path) {
        /* Convert group path to channel name */
        char *channel = kc_group_path_to_channel(group_path);
        if (channel) {
            log_module(webhook_log, LOG_INFO,
                       "Group membership %s for channel %s",
                       operation_type, channel);

            /* Queue immediate sync for this channel */
            chanserv_queue_keycloak_sync(channel, KC_SYNC_PRIORITY_IMMEDIATE);
            stats.cache_invalidations++;
            free(channel);
        }
    }
}
```

**New Event Type** (add to `keycloak_webhook.h`):
```c
typedef enum {
    // ... existing types ...
    KC_EVENT_GROUP_MEMBERSHIP,     /* User added/removed from group */
} kc_webhook_event_type;
```

**New Stats Field**:
```c
struct kc_webhook_stats {
    // ... existing fields ...
    unsigned long group_syncs;     /* Group membership sync triggers */
};
```

**Benefits**:
- Zero new infrastructure - leverages existing webhook listener
- Real-time sync (seconds vs minutes/hours)
- Only processes actual changes
- Consistent with existing cache invalidation patterns

**Keycloak Configuration**: Add GROUP_MEMBERSHIP to existing webhook event types

---

#### Additional Webhook Handlers (Expand Existing Coverage)

While adding GROUP_MEMBERSHIP, we should also expand webhook coverage for other Keycloak events that affect X3 caches.

##### 1. User Attribute Changes (x3_opserv_level, metadata)

When user attributes change in Keycloak admin panel, invalidate relevant caches:

```c
/* Enhance existing USER UPDATE handling in keycloak_webhook.c */
} else if (strcmp(resource_type, "USER") == 0 &&
           strcmp(operation_type, "UPDATE") == 0) {
    const char *username = extract_username(root, representation);

    if (username && representation) {
        json_t *rep = json_loads(representation, 0, NULL);
        if (rep) {
            json_t *attrs = json_object_get(rep, "attributes");
            if (attrs) {
                /* Check for x3_opserv_level change */
                if (json_object_get(attrs, "x3_opserv_level")) {
                    log_module(webhook_log, LOG_INFO,
                               "OpServ level changed for %s via Keycloak", username);
                    nickserv_invalidate_opserv_cache(username);
                    stats.cache_invalidations++;
                }
                /* Check for metadata attribute changes */
                if (json_object_get(attrs, "x3_metadata")) {
                    log_module(webhook_log, LOG_INFO,
                               "Metadata changed for %s via Keycloak", username);
                    x3_lmdb_metadata_invalidate_user(username);
                    stats.cache_invalidations++;
                }
            }
            json_decref(rep);
        }
    }
}
```

##### 2. Password/SCRAM Credential Changes

When password changes, SCRAM verifier caches become stale:

```c
/* Enhance CREDENTIAL handling for password changes */
} else if (strcmp(resource_type, "CREDENTIAL") == 0) {
    const char *cred_type = extract_credential_type(representation);
    const char *username = extract_user_from_resource_path(resource_path);

    if (strcmp(operation_type, "UPDATE") == 0 ||
        strcmp(operation_type, "CREATE") == 0) {

        if (cred_type && strcmp(cred_type, "password") == 0 && username) {
            /* Password changed - invalidate SCRAM caches */
            log_module(webhook_log, LOG_INFO,
                       "Password changed for %s - invalidating SCRAM cache", username);
            x3_lmdb_scram_delete_all_for_account(username);
            stats.cache_invalidations++;
        }
    }
}
```

##### 3. New Fingerprint Registration (Pre-warm Cache)

When a new certificate is registered, pre-warm the fingerprint cache:

```c
/* Add to CREDENTIAL CREATE handling */
if (strcmp(operation_type, "CREATE") == 0 && representation) {
    json_t *rep = json_loads(representation, 0, NULL);
    if (rep) {
        json_t *type = json_object_get(rep, "type");
        if (type && json_is_string(type) &&
            strcmp(json_string_value(type), "x509") == 0) {

            /* Extract fingerprint and username */
            const char *fingerprint = extract_x509_fingerprint(rep);
            const char *username = extract_user_from_resource_path(resource_path);
            time_t expiry = extract_cert_expiry(rep);

            if (fingerprint && username) {
                log_module(webhook_log, LOG_INFO,
                           "Pre-caching new fingerprint for %s", username);
                x3_lmdb_fingerprint_set(fingerprint, username, expiry);
                stats.fingerprint_additions++;
            }
        }
        json_decref(rep);
    }
}
```

##### 4. Group Attribute Changes (Access Level Config)

When group settings change (not just membership), re-sync the channel:

```c
} else if (strcmp(resource_type, "GROUP") == 0 &&
           strcmp(operation_type, "UPDATE") == 0) {
    /* Group settings changed - might affect access level configuration */
    const char *group_path = NULL;

    if (representation) {
        json_t *rep = json_loads(representation, 0, NULL);
        if (rep) {
            json_t *path = json_object_get(rep, "path");
            if (path && json_is_string(path))
                group_path = json_string_value(path);

            /* Check if x3-relevant attributes changed */
            json_t *attrs = json_object_get(rep, "attributes");
            if (attrs && group_path) {
                char *channel = kc_group_path_to_channel(group_path);
                if (channel) {
                    log_module(webhook_log, LOG_INFO,
                               "Group attributes changed for %s - re-syncing", channel);
                    chanserv_queue_keycloak_sync(channel, KC_SYNC_PRIORITY_HIGH);
                    stats.group_syncs++;
                    free(channel);
                }
            }
            json_decref(rep);
        }
    }
}
```

##### Webhook Event Coverage Summary

| Keycloak Event | X3 Action | Cache Affected |
|----------------|-----------|----------------|
| GROUP_MEMBERSHIP CREATE/DELETE | Queue channel sync | `chanaccess:` |
| GROUP UPDATE | Re-sync if attrs changed | `chanaccess:` |
| USER DELETE | Clear all user caches | all user caches |
| USER UPDATE (with x3 attrs) | Invalidate opserv/metadata | opserv cache, `meta:` |
| CREDENTIAL DELETE (x509) | Delete fingerprint | `fp:` |
| CREDENTIAL CREATE (x509) | Pre-warm fingerprint | `fp:` |
| CREDENTIAL UPDATE/CREATE (password) | Invalidate SCRAM | `scram:`, `scram_acct:` |
| USER_SESSION DELETE | Revoke sessions | `session:`, `sessver:` |

##### New Stats Fields

```c
struct kc_webhook_stats {
    /* ... existing fields ... */
    unsigned long group_syncs;           /* Group membership/attribute sync triggers */
    unsigned long fingerprint_additions; /* Fingerprints pre-cached */
    unsigned long scram_invalidations;   /* SCRAM caches invalidated */
    unsigned long opserv_invalidations;  /* OpServ level cache invalidations */
    unsigned long metadata_invalidations;/* Metadata cache invalidations */
};
```

---

#### Option B: Keycloak Admin Events API (Polling Fallback)

```
GET /admin/realms/{realm}/admin-events?type=GROUP_MEMBERSHIP
    &dateFrom={last_sync_timestamp}
```

**Implementation**:
```c
/* Track last sync time globally */
static time_t kc_last_sync_time = 0;

chanserv_sync_keycloak_incremental()
├── GET admin-events since kc_last_sync_time
├── For each GROUP_MEMBERSHIP event:
│   ├── Parse affected channel from group path
│   └── Queue channel for targeted sync
├── Process only affected channels
└── Update kc_last_sync_time
```

**Fallback**: If no events or too many events, fall back to full sync.

#### Option C: ETag/Conditional Requests

Store ETags per channel, use conditional GET:

```c
struct chanData {
    // ... existing fields ...
    char kc_group_etag[64];  /* ETag from last sync */
};

/* Conditional request */
curl_easy_setopt(curl, CURLOPT_HTTPHEADER, "If-None-Match: {etag}");
/* 304 Not Modified = skip this channel */
```

#### Option D: Hash-Based Change Detection

Hash group membership, only process if hash changed:

```c
/* Store hash of last known membership */
uint64_t kc_membership_hash(const char *channel);

/* On sync, compare hashes before processing */
if (new_hash == stored_hash)
    return 0;  /* No changes */
```

**Recommendation**:
- If webhooks can be configured: Option A (webhooks) + Option D (hash) as fallback
- Otherwise: Option D (hash-based) with Option B (polling) for environments with admin events enabled

---

### Phase 5: Distributed Sync Window

**Goal**: Spread sync across time to avoid thundering herd

Instead of syncing all channels at once every hour, distribute across the sync window:

```c
"keycloak_sync_frequency" "3600"      /* Total window (1 hour) */
"keycloak_sync_distributed" "1"       /* Enable distributed sync */

/* Calculate per-channel interval */
int interval = keycloak_sync_frequency / registered_channel_count;
/* e.g., 3600s / 60 channels = 60s per channel */

/* Stagger initial sync times */
for (i = 0; i < channel_count; i++) {
    timeq_add(now + (i * interval), sync_single_channel, channel[i]);
}
```

**Benefits**:
- Constant low-level sync activity vs periodic spikes
- Keycloak load spread evenly
- Issues detected faster (not waiting for next full sync)

---

### Phase 6: Resilient Failure Handling

**Goal**: Partial failures don't break entire sync

```c
struct kc_sync_result {
    int succeeded;
    int failed;
    int skipped;
    struct {
        char channel[CHANNELLEN];
        int error_code;
        char error_msg[256];
    } failures[KC_MAX_FAILURES_TRACKED];
};

/* Per-channel error tracking */
if (sync_failed) {
    result->failed++;
    if (result->failed <= KC_MAX_FAILURES_TRACKED) {
        /* Record failure for later reporting */
    }
    /* Continue to next channel, don't abort */
}

/* Exponential backoff for failing channels */
struct chanData {
    // ...
    int kc_sync_failures;      /* Consecutive failure count */
    time_t kc_next_sync;       /* Backoff: don't retry before this time */
};
```

**Backoff Strategy**:
- 1st failure: retry next batch
- 2nd failure: wait 5 minutes
- 3rd failure: wait 30 minutes
- 4th+ failure: wait 2 hours, log warning

---

## Implementation Order

| Phase | Description | Effort | Dependencies |
|-------|-------------|--------|--------------|
| 1 | Batch processing + progress logging | 2-3 hours | None |
| 2 | Async pull sync | 4-6 hours | Phase 1 |
| 3 | Priority queue | 2-3 hours | Phase 1 |
| 4a | Incremental sync (hash-based) | 3-4 hours | Phase 1 |
| 4b | Keycloak webhooks (GROUP_MEMBERSHIP) | 2-3 hours | Phase 1, existing webhook infra |
| 4c | Expanded webhook coverage | 3-4 hours | Phase 4b |
| 5 | Distributed sync window | 2-3 hours | Phase 1 |
| 6 | Resilient failure handling | 3-4 hours | Phase 1 |

**Recommended Order**: 1 → 6 → 3 → 4a → 4b → 4c → 2 → 5

- **Phase 1** is foundational - must come first
- **Phase 6** adds resilience early - critical for production stability
- **Phase 3** is high value/low effort - active channels get synced first
- **Phase 4a** (hash-based) is simpler incremental sync - immediate wins
- **Phase 4b** (webhooks - groups) adds real-time channel access sync
- **Phase 4c** (webhooks - expanded) adds SCRAM, fingerprint, opserv cache invalidation
- **Phase 2** (async pull) is optimization - adds complexity but removes blocking
- **Phase 5** (distributed) is polish - smooths out load patterns

---

## New Configuration Summary

```c
/* chanserv.conf additions */
"keycloak_sync_batch_size" "15"       /* Channels per batch (default: 15) */
"keycloak_sync_batch_delay" "100"     /* Ms between batches (default: 100) */
"keycloak_sync_prioritize" "1"        /* Enable priority sorting (default: ON) */
"keycloak_sync_distributed" "1"       /* Enable distributed sync (default: ON) */
"keycloak_sync_incremental" "1"       /* Enable hash-based delta sync (default: ON) */
```

---

## Data Structures

```c
/* Sync state (persists across batches) */
struct kc_sync_state {
    struct chanData **queue;      /* Sorted channel queue */
    int queue_size;               /* Total channels to sync */
    int current_index;            /* Current position in queue */
    int total_entries;            /* Running total of entries synced */
    int channels_done;            /* Channels completed */
    int channels_failed;          /* Channels that failed */
    time_t start_time;            /* When sync started */
    struct kc_sync_result result; /* Detailed results */
};

/* Per-channel sync metadata (in chanData) */
struct kc_channel_sync_meta {
    uint64_t membership_hash;     /* Hash of last known membership */
    time_t last_sync;             /* When last synced */
    int consecutive_failures;     /* For backoff calculation */
    time_t next_allowed_sync;     /* Backoff: earliest next sync */
    char etag[64];                /* ETag for conditional requests */
};
```

---

## Testing Strategy

1. **Unit tests**: Hash calculation, priority scoring, backoff calculation
2. **Integration tests**:
   - Batch processing yields control (mock timeq)
   - Async requests complete correctly
   - Incremental sync detects changes
3. **Load tests**:
   - 100+ channels, 10k+ entries
   - Measure memory, CPU, sync duration
4. **Failure tests**:
   - Keycloak unavailable mid-sync
   - Individual channel failures
   - Network timeouts

---

## Rollout Plan

1. **Feature flags**: All new behavior behind config flags, default OFF
2. **Gradual enablement**:
   - Enable batch processing first (low risk)
   - Enable priority queue (low risk)
   - Enable incremental sync (medium risk)
   - Enable async pull (higher risk, more testing)
3. **Monitoring**: Add metrics for sync duration, failure rate, entries/second
4. **Rollback**: Each phase independently disableable

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Log entries during sync | 2 (start + end) | Progress every 10 channels |
| Services blocked during sync | Yes | No (async/batched) |
| Full sync on unchanged data | Yes | No (incremental) |
| Keycloak API calls/second | Unlimited | Rate limited |
| Recovery from partial failure | Manual | Automatic with backoff |

---

## Design Decisions

1. **Distributed sync (Phase 5)**: Default ON - most robust approach, spreads load evenly
2. **Batch size**: Configurable via `keycloak_sync_batch_size`, default 15 (middle ground)
3. **OpServ commands**: Yes - add manual sync control (see below)
4. **Keycloak admin events API**: This is a new feature with no existing deployments yet - webhooks as primary, polling as fallback for environments that can't configure webhooks

---

## OpServ Commands

Add manual sync control commands to OpServ (O3):

### KCSYNC

```
KCSYNC <subcommand> [args]
```

| Subcommand | Args | Description | Access |
|------------|------|-------------|--------|
| `STATUS` | - | Show current sync state, queue depth, last sync times | 400+ |
| `CHANNEL` | `#channel` | Queue immediate sync for specific channel | 400+ |
| `ALL` | - | Queue full sync of all channels (respects batching) | 600+ |
| `ABORT` | - | Abort current sync operation | 600+ |
| `STATS` | - | Show sync statistics (success/fail counts, durations) | 400+ |
| `RESET` | `#channel` | Clear failure counters and cached hashes for channel | 600+ |

### Example Output

```
/msg O3 KCSYNC STATUS
-O3- Keycloak Sync Status:
-O3-   State: RUNNING (batch 3/6)
-O3-   Progress: 28/57 channels (2847 entries)
-O3-   Queue: 29 pending, 2 failed, 0 priority
-O3-   Started: 45 seconds ago
-O3-   Last full sync: 2025-01-07 14:32:00 (completed)

/msg O3 KCSYNC CHANNEL #help
-O3- Queued #help for immediate Keycloak sync (priority: IMMEDIATE)

/msg O3 KCSYNC STATS
-O3- Keycloak Sync Statistics:
-O3-   Total syncs: 1,247
-O3-   Successful: 1,241 (99.5%)
-O3-   Failed: 6 (0.5%)
-O3-   Avg duration: 2.3s per channel
-O3-   Avg entries: 108 per channel
-O3-   Last 24h: 24 full syncs, 47 webhook-triggered
```

### Implementation

Add to `x3/src/opserv.c`:

```c
static MODCMD_FUNC(cmd_kcsync) {
    const char *subcmd = argc > 1 ? argv[1] : "STATUS";

    if (!strcasecmp(subcmd, "STATUS")) {
        return cmd_kcsync_status(user, channel, argc, argv, cmd);
    } else if (!strcasecmp(subcmd, "CHANNEL")) {
        if (argc < 3) {
            reply("OSMSG_SYNTAX_ERROR", "KCSYNC CHANNEL #channel");
            return 0;
        }
        return cmd_kcsync_channel(user, argv[2]);
    } else if (!strcasecmp(subcmd, "ALL")) {
        return cmd_kcsync_all(user);
    } else if (!strcasecmp(subcmd, "ABORT")) {
        return cmd_kcsync_abort(user);
    } else if (!strcasecmp(subcmd, "STATS")) {
        return cmd_kcsync_stats(user);
    } else if (!strcasecmp(subcmd, "RESET")) {
        if (argc < 3) {
            reply("OSMSG_SYNTAX_ERROR", "KCSYNC RESET #channel");
            return 0;
        }
        return cmd_kcsync_reset(user, argv[2]);
    }
    reply("OSMSG_BAD_SUBCOMMAND", subcmd, "KCSYNC");
    return 0;
}

/* Register in opserv_init() */
modcmd_register(opserv_module, "KCSYNC", cmd_kcsync, 1, MODCMD_REQUIRE_AUTHED,
                "level", "400", NULL);
modcmd_register(opserv_module, "KCSYNC ALL", cmd_kcsync, 2, MODCMD_REQUIRE_AUTHED,
                "level", "600", NULL);
modcmd_register(opserv_module, "KCSYNC ABORT", cmd_kcsync, 2, MODCMD_REQUIRE_AUTHED,
                "level", "600", NULL);
modcmd_register(opserv_module, "KCSYNC RESET", cmd_kcsync, 3, MODCMD_REQUIRE_AUTHED,
                "level", "600", NULL);
```

---

## Files to Modify

### Core Sync Logic
- `x3/src/chanserv.c` - Refactor `chanserv_sync_keycloak_access()` to batched approach, add priority queue, add `chanserv_queue_keycloak_sync()` for webhook-triggered syncs
- `x3/src/chanserv.h` - New structs (`kc_sync_state`, `kc_channel_sync_meta`), function declarations

### Webhook Integration (Existing Infrastructure)
- `x3/src/keycloak_webhook.c` - Expand `handle_keycloak_event()` with:
  - GROUP_MEMBERSHIP handling → queue channel sync
  - GROUP UPDATE handling → re-sync on attribute changes
  - Enhanced USER UPDATE → opserv level & metadata invalidation
  - Enhanced CREDENTIAL handling → SCRAM invalidation on password change, fingerprint pre-warming
  - Helper functions: `kc_group_path_to_channel()`, `extract_x509_fingerprint()`, etc.
- `x3/src/keycloak_webhook.h` - New event types, expanded stats struct
- `x3/src/nickserv.c` - Add `nickserv_invalidate_opserv_cache()` function

### OpServ Commands
- `x3/src/opserv.c` - Add KCSYNC command with subcommands (STATUS, CHANNEL, ALL, ABORT, STATS, RESET)
- `x3/src/modcmd.help` - Help text for KCSYNC commands

### Async Infrastructure
- `x3/src/keycloak.c` - Add `KC_ASYNC_GROUP_MEMBERS` type for async pull sync
- `x3/src/keycloak.h` - New async callback type for group members

### Storage
- `x3/src/x3_lmdb.c` - ✅ Added `x3_lmdb_chansync_*()` functions for per-channel sync metadata (backoff, hash storage)
- `x3/src/x3_lmdb.h` - ✅ Added `struct lmdb_chansync_meta` with membership_hash, last_sync, consecutive_failures, next_allowed_sync, last_entry_count

### Configuration
- `data/x3.conf` - New sync configuration options
