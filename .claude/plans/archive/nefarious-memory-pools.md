# Nefarious Memory Pool Implementation Plan

## Executive Summary

Nefarious IRCd already has sophisticated pooling for core structures (Client, Connection, MsgBuf, Msg, Ban, SLink). This plan adds pooling for two remaining high-frequency structures that currently use direct malloc/free: **Membership** and **DLink**.

**Expected Benefit:** 5-15% reduction in allocation overhead during peak traffic, particularly benefiting servers with 1000+ users and frequent join/part activity.

---

## Implementation Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1 - Membership pooling | ✅ Already Done | Was already implemented in channel.c:70-72 |
| Phase 2 - DLink pooling | ✅ Complete | list.c:68-76, modified add_dlink/remove_dlink |
| Phase 3 - MetadataRequest pooling | ✅ Complete | metadata.c:1683-1717, mdq_alloc/mdq_free |

---

## Current Pooling Architecture

Nefarious uses three pooling patterns:

### Pattern 1: Pre-allocated Pool (Client/Connection)
```c
/* Pre-allocate at startup */
for (i = 0; i < MAXCONNECTIONS; ++i) {
    cptr = MyMalloc(sizeof(struct Client));
    cli_next(cptr) = clientFreeList;
    clientFreeList = cptr;
}

/* Allocate from pool */
static struct Client* alloc_client(void) {
    struct Client* cptr = clientFreeList;
    if (!cptr) {
        cptr = MyMalloc(sizeof(struct Client));  /* Overflow */
    } else {
        clientFreeList = cli_next(cptr);
    }
    return cptr;
}
```

### Pattern 2: Freelist On-Demand (Ban/SLink)
```c
static struct Ban* free_bans = NULL;

struct Ban* make_ban(const char *banstr) {
    struct Ban *ban;
    if (free_bans) {
        ban = free_bans;
        free_bans = free_bans->next;
    } else {
        ban = MyMalloc(sizeof(*ban));
    }
    /* initialize */
    return ban;
}

void free_ban(struct Ban *ban) {
    ban->next = free_bans;
    free_bans = ban;
}
```

### Pattern 3: Size-Class Pooling (MsgBuf)
```c
/* 8 size classes: 2^5 to 2^9 bytes */
struct {
    unsigned int alloc, used;
    struct MsgBuf *free;
} msgBufs[MB_MAX_SHIFT - MB_BASE_SHIFT + 1];
```

---

## Phase 1: Membership Structure Pooling

### Current State

**Location:** `ircd/channel.c:726`
```c
member = (struct Membership*) MyMalloc(sizeof(struct Membership));
```

**Structure:** `include/channel.h`
```c
struct Membership {
    struct Client*    user;         /* User on channel */
    struct Channel*   channel;      /* The channel */
    struct Membership* next_member; /* Next user on channel */
    struct Membership* prev_member; /* Previous user on channel */
    struct Membership* next_channel;/* Next channel for user */
    struct Membership* prev_channel;/* Previous channel for user */
    unsigned int      status;       /* Op/voice flags */
    unsigned int      banflags;     /* Ban cache */
    unsigned short    oplevel;      /* Op level */
};
```

**Size:** ~48 bytes (64-bit) / ~32 bytes (32-bit)

**Frequency:** Allocated on every channel JOIN, freed on every PART/KICK/QUIT

### Implementation

#### Step 1: Add freelist and pool variables (`ircd/channel.c`)

```c
/* Membership pool - freelist for channel memberships */
static struct Membership* membershipFreeList = NULL;
static unsigned int membershipAllocCount = 0;
static unsigned int membershipFreeCount = 0;

#define MEMBERSHIP_PREALLOC 1000  /* Pre-allocate on first use */
```

#### Step 2: Create pool init function (`ircd/channel.c`)

```c
/** Initialize the membership pool.
 * Pre-allocates MEMBERSHIP_PREALLOC structures on first call.
 */
static void membership_pool_init(void)
{
    int i;
    struct Membership* member;

    if (membershipFreeList)
        return;  /* Already initialized */

    for (i = 0; i < MEMBERSHIP_PREALLOC; i++) {
        member = (struct Membership*) MyMalloc(sizeof(struct Membership));
        if (!member)
            break;
        member->next_member = membershipFreeList;
        membershipFreeList = member;
        membershipAllocCount++;
        membershipFreeCount++;
    }

    Debug((DEBUG_LIST, "Membership pool: pre-allocated %d structures", i));
}
```

#### Step 3: Modify `add_user_to_channel()` (`ircd/channel.c:726`)

**Before:**
```c
member = (struct Membership*) MyMalloc(sizeof(struct Membership));
```

**After:**
```c
/* Allocate from pool */
if (membershipFreeList) {
    member = membershipFreeList;
    membershipFreeList = member->next_member;
    membershipFreeCount--;
} else {
    member = (struct Membership*) MyMalloc(sizeof(struct Membership));
    if (!member)
        return NULL;
    membershipAllocCount++;
}
```

#### Step 4: Modify `remove_user_from_channel()` to return to pool

Find the existing `MyFree(member)` call and replace:

**Before:**
```c
MyFree(member);
```

**After:**
```c
/* Return to pool instead of freeing */
member->next_member = membershipFreeList;
membershipFreeList = member;
membershipFreeCount++;
```

#### Step 5: Add pool statistics function (`ircd/channel.c`)

```c
/** Report membership pool statistics.
 * @param[in] sptr Client requesting stats.
 */
void membership_pool_stats(struct Client *sptr)
{
    send_reply(sptr, SND_EXPLICIT | RPL_STATSDEBUG,
               ":Membership pool: %u allocated, %u free, %u in use",
               membershipAllocCount, membershipFreeCount,
               membershipAllocCount - membershipFreeCount);
}
```

#### Step 6: Call pool init at startup

In `init_channel()` or appropriate init function:
```c
membership_pool_init();
```

### Testing

1. Start server, verify pool pre-allocation in debug output
2. Join/part channels, verify no memory leaks
3. `/STATS d` should show pool statistics
4. Stress test with many rapid joins/parts
5. Memory profiler: verify reduced malloc calls

---

## Phase 2: DLink Structure Pooling

### Current State

**Location:** `ircd/list.c:512`
```c
static struct DLink* add_dlink(struct DLink **lpp, void *value) {
    struct DLink *lp = (struct DLink*) MyMalloc(sizeof(struct DLink));
    ...
}

static void remove_dlink(struct DLink **lpp, struct DLink *lp) {
    ...
    MyFree(lp);
}
```

**Structure:** `include/list.h`
```c
struct DLink {
    struct DLink*  next;
    struct DLink*  prev;
    union {
        struct Client* cptr;
        struct Channel* chptr;
        struct ConfItem* aconf;
        char* cp;
    } value;
};
```

**Size:** ~32 bytes (64-bit)

**Frequency:** Used for server downlinks, channel members (via `add_dlink`), invite lists

### Implementation

#### Step 1: Add freelist variables (`ircd/list.c`)

```c
/* DLink pool */
static struct DLink* dlinkFreeList = NULL;
static unsigned int dlinkAllocCount = 0;
static unsigned int dlinkFreeCount = 0;

#define DLINK_PREALLOC 500  /* Pre-allocate batch size */
```

#### Step 2: Create allocation helpers

```c
/** Allocate a DLink from the pool.
 * @return Pointer to DLink or NULL on failure.
 */
static struct DLink* alloc_dlink(void)
{
    struct DLink* lp;

    if (dlinkFreeList) {
        lp = dlinkFreeList;
        dlinkFreeList = lp->next;
        dlinkFreeCount--;
    } else {
        lp = (struct DLink*) MyMalloc(sizeof(struct DLink));
        if (lp)
            dlinkAllocCount++;
    }
    return lp;
}

/** Return a DLink to the pool.
 * @param[in] lp DLink to free.
 */
static void free_dlink(struct DLink* lp)
{
    lp->next = dlinkFreeList;
    dlinkFreeList = lp;
    dlinkFreeCount++;
}
```

#### Step 3: Modify `add_dlink()` and `remove_dlink()`

**add_dlink - Before:**
```c
struct DLink *lp = (struct DLink*) MyMalloc(sizeof(struct DLink));
```

**add_dlink - After:**
```c
struct DLink *lp = alloc_dlink();
```

**remove_dlink - Before:**
```c
MyFree(lp);
```

**remove_dlink - After:**
```c
free_dlink(lp);
```

#### Step 4: Pre-allocation at startup

In `init_list()`:
```c
/* Pre-allocate DLink pool */
for (i = 0; i < DLINK_PREALLOC; i++) {
    struct DLink* lp = (struct DLink*) MyMalloc(sizeof(struct DLink));
    if (!lp) break;
    lp->next = dlinkFreeList;
    dlinkFreeList = lp;
    dlinkAllocCount++;
    dlinkFreeCount++;
}
```

### Testing

1. Verify pool pre-allocation at startup
2. Test server linking (heavy DLink usage)
3. Test netsplit/rejoin scenarios
4. Memory profiler: verify reduced malloc calls

---

## Phase 3: MetadataRequest Pooling (Recommended)

### Investigation Summary

After deep analysis of all metadata structures:

| Structure | Size | Lifecycle | Verdict |
|-----------|------|-----------|---------|
| **MetadataRequest** | 289B | Short (30s) | ✅ Good candidate |
| MetadataSub | 72B | Medium | ⚠️ Not worth it |
| MetadataEntry | 84B + value | Medium | ❌ Values are the cost |
| MetadataWriteQueue | 128B + value | Rare | ❌ Only during X3 outage |

**Key insight:** MetadataEntry pooling alone won't help because variable-size value allocations dominate memory cost. Multi-size value pools would add complexity for marginal gain.

### MetadataRequest - Best Candidate

**Location:** `ircd/metadata.c:1747-1769`

```c
struct MetadataRequest {
  struct Client *client;              // 8 bytes
  char target[CHANNELLEN + 1];        // 201 bytes
  char key[METADATA_KEY_LEN];         // 64 bytes
  time_t timestamp;                   // 8 bytes
  struct MetadataRequest *next;       // 8 bytes
};  // Total: 289 bytes
```

**Why it's a good candidate:**
- Fixed size (289 bytes)
- Short-lived (30-second timeout)
- Predictable max count (100 global)
- High allocation/deallocation frequency during metadata queries
- Simple free-list implementation

### Implementation

#### Step 1: Add pool variables (`ircd/metadata.c`)

```c
/* MetadataRequest pool */
static struct MetadataRequest *mdqFreeList = NULL;
static unsigned int mdqAllocCount = 0;
static unsigned int mdqFreeCount = 0;
```

#### Step 2: Create allocation helpers

```c
/** Allocate a MetadataRequest from the pool.
 * @return Pointer to MetadataRequest or NULL on failure.
 */
static struct MetadataRequest *mdq_alloc(void)
{
    struct MetadataRequest *req;

    if (mdqFreeList) {
        req = mdqFreeList;
        mdqFreeList = req->next;
        mdqFreeCount--;
    } else {
        req = (struct MetadataRequest *)MyMalloc(sizeof(struct MetadataRequest));
        if (req)
            mdqAllocCount++;
    }
    if (req)
        memset(req, 0, sizeof(struct MetadataRequest));
    return req;
}

/** Return a MetadataRequest to the pool.
 * @param[in] req MetadataRequest to free.
 */
static void mdq_free(struct MetadataRequest *req)
{
    req->next = mdqFreeList;
    mdqFreeList = req;
    mdqFreeCount++;
}
```

#### Step 3: Modify allocation sites

**In `metadata_send_query()` line 1748:**

Before:
```c
req = (struct MetadataRequest *)MyMalloc(sizeof(struct MetadataRequest));
```

After:
```c
req = mdq_alloc();
```

**In `metadata_handle_response()` line 1865 and `metadata_expire_requests()` line 1909:**

Before:
```c
MyFree(req);
```

After:
```c
mdq_free(req);
```

### Why NOT MetadataEntry (and a Protocol Insight)

**Protocol Reality:** The IRC message limit (512 bytes) combined with the lack of chunking in the metadata spec means values are effectively limited to ~300 bytes:

```c
// Feature-controlled client limit (advertised in CAP)
F_I(METADATA_MAX_VALUE_BYTES, 0, 300, 0),  /* Limited by 512-byte IRC message size */

// But internal buffers are oversized:
#define METADATA_VALUE_LEN 1024  // Wasteful!
```

The 1024-byte `METADATA_VALUE_LEN` is used for stack buffers throughout `metadata.c` and `m_metadata.c`, wasting stack space. The actual limit is ~300 bytes due to protocol constraints.

**If we wanted to optimize MetadataEntry:**
1. Reduce `METADATA_VALUE_LEN` to 384 (300 + safety margin)
2. Use just two size-class pools: 128B and 384B
3. This would cover 99%+ of real-world values

**Current Recommendation:** Skip MetadataEntry pooling unless profiling shows it's a bottleneck. The protocol limit makes the "variable size" problem much smaller than it first appears.

**Future Consideration:** Reduce `METADATA_VALUE_LEN` from 1024 to 384 to save stack space across dozens of allocation sites.

---

## Pool Configuration Features

### Add Feature Flags (`ircd_features.def`)

```c
F_I(MEMBERSHIP_POOL_SIZE, 0, 1000)  /* Initial membership pool size */
F_I(DLINK_POOL_SIZE, 0, 500)        /* Initial DLink pool size */
```

### Runtime Statistics

Add to `/STATS d` output:
```
:Membership pool: 1000 allocated, 750 free, 250 in use
:DLink pool: 500 allocated, 400 free, 100 in use
:Client pool: 4096 allocated, 3996 free, 100 in use
:MsgBuf pool: 256 allocated (class 5), 128 allocated (class 6), ...
```

---

## Files to Modify

### Phase 1 (Membership)
- `ircd/channel.c` - Pool implementation
- `include/channel.h` - Function declaration (if exposing stats)

### Phase 2 (DLink)
- `ircd/list.c` - Pool implementation

### Phase 3 (MetadataRequest)
- `ircd/metadata.c` - Pool implementation (lines 1747-1769, 1859-1866, 1909)

### Optional
- `ircd/ircd_features.c` - Pool size features
- `ircd/s_stats.c` - Pool statistics in /STATS

---

## Memory Impact

| Structure | Pool Size | Per-Item | Total Memory |
|-----------|-----------|----------|--------------|
| Membership | 1000 | 48 bytes | 48 KB |
| DLink | 500 | 32 bytes | 16 KB |
| MetadataRequest | 100 (max) | 289 bytes | 29 KB |
| **Total** | | | **93 KB** |

Minimal memory overhead for significant allocation performance gain.

---

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| malloc() calls per JOIN | 1 | 0 (from pool) |
| malloc() calls per server link | ~N (downlinks) | 0 (from pool) |
| Memory fragmentation | Higher | Lower (fixed-size pools) |
| JOIN/PART latency variance | Variable | More consistent |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Pool exhaustion | Low | Fall back to MyMalloc |
| Memory leak in pool | Medium | Add pool drain on shutdown |
| Pool corruption | Low | Debug assertions, valgrind |
| Oversized pool | Low | Configurable pool sizes |

---

## Implementation Order

1. **Membership pooling** (highest impact, most joins/parts)
2. **DLink pooling** (server operations benefit)
3. **Metrics/stats** (observability)
4. **Feature flags** (configurability)
5. **MetadataEntry** (only if profiling shows need)
