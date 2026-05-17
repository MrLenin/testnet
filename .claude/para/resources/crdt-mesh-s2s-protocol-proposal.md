# Proposal: CRDT-Based Mesh Protocol for IRC Server-to-Server Communication

**Status**: Research / RFC
**Author**: Claude (with Rubin's initial concept)
**Date**: 2026-03-06

## Executive Summary

Replace P10's tree-topology, timestamp-based server-to-server protocol with a CRDT (Conflict-free Replicated Data Type) mesh architecture. This eliminates entire classes of IRC bugs (netsplit desyncs, nick collision kills, BURST storms, message ID fragmentation) by leveraging mathematically-guaranteed eventual consistency.

The core insight: IRC network state (users, channels, modes, bans, memberships) maps cleanly onto well-understood CRDT types. A Rust CRDT library (Y-CRDT/yrs) provides production-quality implementations with a C FFI, compatible with Nefarious's architecture.

---

## Table of Contents

1. [Motivation: What's Wrong with P10](#1-motivation-whats-wrong-with-p10)
2. [CRDT Fundamentals](#2-crdt-fundamentals)
3. [IRC State → CRDT Mapping](#3-irc-state--crdt-mapping)
4. [Sync Protocol](#4-sync-protocol)
5. [Conflict Resolution Policies](#5-conflict-resolution-policies)
6. [Wire Protocol Design](#6-wire-protocol-design)
7. [Integration with Nefarious](#7-integration-with-nefarious)
8. [Library Choice: Y-CRDT (yrs)](#8-library-choice-y-crdt-yrs)
9. [Performance Analysis](#9-performance-analysis)
10. [Tombstone Management](#10-tombstone-management)
11. [Migration Path](#11-migration-path)
12. [Impact on Existing Subsystems](#12-impact-on-existing-subsystems)
13. [Open Questions](#13-open-questions)
14. [Prior Art](#14-prior-art)
15. [Appendices](#15-appendices)
16. [Audit Report](#16-audit-report-2026-03-07)
17. [Custom C CRDT — Concrete Designs](#17-custom-c-crdt--concrete-designs)

---

## 1. Motivation: What's Wrong with P10

### 1.1 Timestamp Brittleness

P10 resolves all conflicts via Unix timestamps:
- Nick collisions: lower TS wins
- Channel authority: oldest channel TS has mode priority
- BURST: remote TS vs local TS determines whose state survives

This breaks with clock skew. NTP drift of even a few seconds can cause newer state to overwrite older state, or vice versa. There is no way to detect or correct this after the fact.

### 1.2 No Semantic Merge on Netsplit Recovery

When two sides of a netsplit rejoin via BURST, it's all-or-nothing per channel:
- If `remote_burst_ts < local_ts`: remote state is discarded entirely
- If `remote_burst_ts > local_ts`: local state is overwritten entirely

Non-conflicting changes made on different sides of the split (e.g., Server A set +s while Server B added bans) cannot be merged. One side's changes are always lost.

### 1.3 BURST Storms

Every server rejoin requires transmitting the ENTIRE network state:
- All servers (S tokens)
- All users (N tokens with full metadata)
- All channels (B tokens with member lists, modes, bans)
- All topics, account associations, metadata

For a 10,000-user network with 5,000 channels, a BURST is ~2.5 MB. After a 5-minute netsplit where maybe 200 things changed, we still send 2.5 MB. CRDT delta sync would send ~20 KB.

### 1.4 Nick Collision Kills

When two users claim the same nick on different sides of a split:
- Different user@host: older nick wins, younger is KILL'd
- Same user@host: BOTH are KILL'd

This is aggressive and destructive. Users lose their connection because of a naming conflict that could be resolved more gracefully.

### 1.5 Message ID Fragmentation

Each server generates its own msgid for relayed messages (`A-<startup>-<counter>` vs `B-<startup>-<counter>`). The same message has different IDs on different servers, requiring expensive semantic dedup for chathistory federation queries. The existing federation dedup plan documents this pain in detail.

### 1.6 Tree Topology Rigidity

P10 enforces a spanning tree. Messages flow along a single path. If A needs to reach D, it traverses A→B→C→D. No redundant paths, no automatic failover, single point of failure at every hub.

```
P10 (tree):          CRDT (mesh):
    A                    A---B
    |                    |\ /|
    B                    | X |
   / \                   |/ \|
  C   D                  C---D
```

---

## 2. CRDT Fundamentals

### 2.1 What is a CRDT?

A Conflict-free Replicated Data Type is a data structure where:
- Every replica can be modified independently (no coordination needed)
- Replicas can sync in any order, at any time
- All replicas that have received the same set of updates converge to identical state
- This convergence is **mathematically guaranteed**, not "best effort"

### 2.2 Key Properties

| Property | What it means | Why IRC needs it |
|----------|--------------|-----------------|
| **Commutativity** | Order of applying updates doesn't matter | Messages between servers can arrive in any order |
| **Idempotency** | Applying the same update twice is harmless | Mesh routing may deliver duplicates |
| **Associativity** | Grouping of updates doesn't matter | Partial syncs + full syncs produce same result |
| **Convergence** | Same updates → same state, always | No more desyncs after netsplits |

### 2.3 State Vector

Each server maintains a **state vector** — a map of `{server_id: highest_sequence_seen}`:

```
Server A's state vector: {A: 1547, B: 892, C: 2301}
  "I've seen ops 0-1547 from A, 0-892 from B, 0-2301 from C"
```

This is the CRDT equivalent of "what do I know?" and enables precise delta computation. Size is O(number of servers) — for IRC networks typically under 1 KB.

### 2.4 Relevant CRDT Types

**OR-Set (Observed-Remove Set)**: A set supporting add and remove. Concurrent add + remove → add wins (the add created a new tag the remove didn't know about). Used for: channel membership, ban lists, server lists.

**LWW-Register (Last-Writer-Wins Register)**: A single value where concurrent writes are resolved by timestamp. Used for: topic, individual mode flags, nick ownership.

**LWW-Map**: A key-value store where each key is an independent LWW-Register. Used for: channel state, user metadata, IRCv3 metadata keys.

**G-Counter (Grow-only Counter)**: A counter that only increments. Each replica maintains its own count; total is sum of all. Used for: message sequence numbers, connection counts.

**RGA (Replicated Growable Array)**: An ordered sequence supporting insert/delete at any position. *Not used in our design* — chat history stays in MDBX, not the CRDT (see §13.6). Mentioned for completeness; could theoretically be used for ordered lists like MOTD lines if needed.

---

## 3. IRC State → CRDT Mapping

### 3.1 Complete State Table

| IRC State | Current P10 | CRDT Type | Resolution Policy |
|-----------|-------------|-----------|-------------------|
| Server list | S token, tree topology | OR-Set<ServerRecord> | Add-wins |
| User registry | N token intro | Map<numeric, UserState> | LWW per field |
| Nick→numeric | N token, collision by TS | Map<nick, NickClaim> | Custom: oldest TS wins |
| Channel registry | B token (BURST) | Map<name, ChannelState> | LWW per field |
| Channel members | B token member list | OR-Set<numeric> per channel | Add-wins (see §5.2) |
| Channel modes | M token | Map<mode_char, ModeValue> per channel | LWW per mode |
| Channel topic | T token | LWW-Register<TopicRecord> | Latest timestamp wins |
| Ban/except lists | B token ban params | OR-Set<BanMask> per channel | Add-wins |
| Chat history | P/O tokens (PRIVMSG/NOTICE) | **NOT in CRDT** (MDBX) | HLC msgids only (see §13.6) |
| Read markers | MR token | LWW-Register per user×channel | Latest wins |
| User modes | M token | Map<mode_char, bool> per user | LWW per mode |
| Account association | AC token | LWW-Register<account_name> | Latest wins |
| IRCv3 metadata | MD/MDQ tokens | Map<key, value> per target | LWW per key |
| SASL state | SASL subtokens | Ephemeral (awareness protocol) | Per-session, not replicated |
| Bouncer sessions | BX/BS tokens | Map<session_id, SessionState> | LWW per field |

### 3.2 Document Structure

The network state is modeled as a single CRDT document with named root-level shared types:

```
NetworkDoc {
  "servers": Map<server_numeric, {
    "name": string,
    "description": string,
    "flags": u64,
    "uplink": server_numeric,
    "capabilities": u64
  }>,

  "users": Map<user_numeric, {
    "nick": string,
    "nick_ts": timestamp,
    "ident": string,
    "host": string,
    "realname": string,
    "modes": u64,
    "ip": string,
    "account": string | null,
    "away": string | null,
    "server": server_numeric
  }>,

  "nicks": Map<nick_lowercase, {
    "numeric": user_numeric,
    "claimed_at": timestamp,
    "claimed_by_account": string | null
  }>,

  "channels": Map<channel_name, {
    "created_at": timestamp,
    "modes": Map<mode_char, mode_value>,
    "topic": { text, setter, set_at },
    "members": Map<user_numeric, membership_flags>,
    "bans": Map<ban_mask, { setter, set_at }>,
    "excepts": Map<except_mask, { setter, set_at }>,
    "invites": Map<invite_mask, { setter, set_at }>
  }>,

  /* Chat history is NOT in the CRDT document — stored in MDBX.
   * Only msgid assignment (HLC-based) and read markers are CRDT state.
   * See §13.6 for rationale (Matrix's event DAG bloat lesson). */

  "read_markers": Map<user_numeric, Map<channel_name, {
    "msgid": hlc_id,
    "updated_at": timestamp
  }>>,

  "metadata": Map<target, Map<key, {
    "value": string,
    "visibility": "*" | "+" | ...,
    "set_at": timestamp
  }>>,

  "sessions": Map<session_id, {
    "account": string,
    "primary_numeric": user_numeric,
    "state": "active" | "holding" | ...,
    "connections": Map<conn_id, {
      "server": server_numeric,
      "ip": string,
      "tls": bool,
      "listener_port": u16
    }>
  }>
}
```

### 3.3 Why One Document?

A single document means a single state vector covers everything. Delta sync for server rejoin captures ALL state changes in one exchange. The alternative (per-channel documents) would require O(channels) state vector exchanges on rejoin.

Y-CRDT's Map type provides namespace isolation within one document — channels don't interfere with users, etc.

---

## 4. Sync Protocol

### 4.1 Server Link (Replaces BURST)

```
Phase 1 — State Vector Exchange:
  A → B: CRDT_SYNC_1 <state_vector_A_binary>
  B → A: CRDT_SYNC_2 <delta(B, sv_A)>     // B sends what A needs
  B → A: CRDT_SYNC_1 <state_vector_B>      // B also asks for A's state
  A → B: CRDT_SYNC_2 <delta(A, sv_B)>      // A sends what B needs

Phase 2 — Incremental:
  (on any state change at A):
  A → B: CRDT_UPDATE <delta_binary>
  (on any state change at B):
  B → A: CRDT_UPDATE <delta_binary>
```

**Comparison to P10 BURST**:

| Scenario | P10 | CRDT |
|----------|-----|------|
| Fresh link (empty server) | ~2.5 MB BURST | ~200 KB full delta |
| Netsplit recovery (5 min) | ~2.5 MB BURST | ~20 KB delta |
| Netsplit recovery (1 hour) | ~2.5 MB BURST | ~500 KB delta |
| Incremental change | ~100 bytes per token | ~40 bytes per update |

### 4.2 Mesh Routing

With CRDTs, servers can maintain multiple links without the tree constraint:

```
Topology:
  Hub1 --- Hub2
  |  \   / |
  |   \ /  |
  Leaf1  Leaf2

Sync paths (all valid simultaneously):
  Hub1 ↔ Hub2 (direct)
  Hub1 ↔ Leaf1 (direct)
  Hub1 → Hub2 → Leaf2 (indirect, but update is idempotent)
  Leaf1 → Hub1 → Hub2 → Leaf2 (multi-hop)
```

If Hub1↔Hub2 link fails:
- Hub1 still reaches Leaf2 through Hub1→Leaf1→Leaf2 (if connected)
- Or any other available path
- Updates are idempotent, so receiving the same update via multiple paths is harmless

### 4.3 Partition Handling (Netsplit)

During a netsplit:
1. Each partition continues operating independently
2. CRDT updates are generated normally on each side
3. Updates destined for unreachable servers are simply not sent (no buffering needed)
4. Each side's state vector reflects only what it has seen

On rejoin:
1. State vectors exchanged — each side identifies exactly what the other missed
2. Only the missed updates are sent (not the entire state)
3. CRDT merge guarantees convergence
4. No mode hacking, no nick kills, no desyncs

---

## 5. Conflict Resolution Policies

### 5.1 Nick Collisions

**Current P10**: Timestamp comparison → KILL the loser (or both).

**CRDT approach**: The `nicks` Map uses a custom LWW-Register where **oldest timestamp wins** (inverted from standard LWW):

```
Scenario: Netsplit. User A claims "alice" at T=100 on Server 1.
          User B claims "alice" at T=200 on Server 2.

Merge: T=100 < T=200, so User A keeps "alice".
       User B's nick claim is rejected. User B gets a forced nick change
       (not a KILL — just a rename to their UID or a generated nick).
```

**Key improvement**: No kills. The losing side gets a forced rename, preserving their connection and channel memberships. The nick resolution is deterministic and automatic.

**Account-aware resolution** (enhancement): If both users are authenticated, the one whose account matches the registered nick owner wins regardless of timestamp. This integrates naturally with the SASL/account system.

### 5.2 Channel Membership: ADD-WINS Semantics

OR-Set's default behavior: concurrent JOIN + KICK → user remains (add wins).

**Is this correct for IRC?** Consider:
- Server A: User joins #channel (JOIN)
- Server B: Oper kicks user from #channel (KICK)
- Netsplit means these happened concurrently

With add-wins: user remains after merge. The oper must kick again.
With remove-wins: user is gone. But they legitimately joined on Server A.

**Recommendation**: Add-wins is actually more correct. The user had a valid JOIN. If the oper wants them gone, they can kick again after the merge. This is less disruptive than silently removing someone who thinks they're in the channel.

For **bans**, add-wins also works: if one side adds a ban while another removes it, the ban persists. Safer default.

### 5.3 Channel Modes

Each mode flag is an independent LWW-Register:

```
Scenario: Netsplit.
  Server A: MODE #channel +s  (at HLC time T1)
  Server B: MODE #channel +i  (at HLC time T2)

Merge: These are INDEPENDENT mode flags, not conflicting.
  Result: #channel is +si (both modes set)
```

Actual conflict (same mode flag):
```
  Server A: MODE #channel +s  (at HLC T1)
  Server B: MODE #channel -s  (at HLC T2, T2 > T1)

Merge: T2 > T1, so -s wins. Channel is -s.
```

**This is dramatically better than P10**, where BURST timestamp comparison can overwrite ALL modes from one side, losing non-conflicting changes.

### 5.4 Hybrid Logical Clocks (HLC)

To avoid pure wall-clock dependency, use HLCs for all timestamp-based resolution:

```c
struct HLC {
    uint64_t physical_ms;   /* Wall clock milliseconds */
    uint16_t logical;       /* Counter for same-ms events */
    uint16_t node_id;       /* Server numeric (tiebreaker) */
};
```

HLCs provide:
- Timestamps that roughly correspond to wall clock (for display/logging)
- Causal ordering guarantees even with clock skew
- Deterministic tiebreaking via node_id
- Tolerance for bounded NTP drift

### 5.5 Topic Resolution

Topics use standard LWW (newest wins):

```
Server A: TOPIC #channel :"Old topic" at T=100
Server B: TOPIC #channel :"New topic" at T=200

Merge: T=200 > T=100, "New topic" wins.
```

This matches current IRC behavior and user expectations.

---

## 6. Wire Protocol Design

### 6.1 Recommended Approach: Hybrid P10 + CRDT

Keep P10 framing for backward compatibility and debuggability. Embed CRDT payloads as binary within P10-style messages:

```
# New P10 tokens for CRDT sync:
AB CR S :<base64(state_vector)>        # CRDT Sync Step 1
AB CR D :<base64(delta)>               # CRDT Sync Step 2 / Delta
AB CR U :<base64(incremental_update)>  # CRDT Incremental Update
AB CR A :<json(awareness_state)>       # Awareness (presence)
```

**CR** = new token for "CRDT". Subtokens: S (state vector), D (delta), U (update), A (awareness).

### 6.2 Compression

Nefarious already has zstd integration. CRDT payloads compress well:

```
Raw CRDT delta (5 min split): ~20 KB
After zstd compression:        ~5 KB
Base64 encoding overhead:      +33%
Final wire size:               ~6.7 KB
```

For comparison, P10 BURST for the same scenario: ~2.5 MB.

### 6.3 Batching

Accumulate updates over a short window (10-50ms) before sending:

```c
/* In the event loop */
if (crdt_pending_updates() && time_since_last_flush() > 10ms) {
    uint8_t *batch;
    uint32_t batch_len;
    crdt_flush_updates(&batch, &batch_len);
    /* Compress and send to all linked servers */
    broadcast_crdt_update(batch, batch_len);
    free(batch);
}
```

This amortizes per-message overhead for busy channels.

### 6.4 Message Format Details

```
CRDT Sync Step 1:
  <server_numeric> CR S :<base64(zstd(state_vector_v2))>

CRDT Delta Response:
  <server_numeric> CR D :<base64(zstd(update_v2))>

CRDT Incremental Update:
  <server_numeric> CR U :<base64(zstd(update_v2))>

CRDT Awareness:
  <server_numeric> CR A <target_numeric> :<json_state>
```

The `update_v2` payloads are Y-CRDT's native lib0 binary encoding — the most compact format available.

---

## 7. Integration with Nefarious

### 7.1 Architecture

```
nefarious/
  include/
    crdt_state.h        # CRDT state management API
    crdt_sync.h         # Sync protocol for S2S
    crdt_hlc.h          # Hybrid Logical Clock
  ircd/
    crdt_state.c        # CRDT document management (wraps yffi)
    crdt_sync.c         # Sync protocol (CR token handler)
    crdt_hlc.c          # HLC implementation
    m_crdt.c            # CR token message handlers
  lib/
    libyrs.a            # Static-linked Y-CRDT library
    libyrs.h            # C FFI header
```

### 7.2 Core API

```c
/* crdt_state.h — CRDT State Management */

/* Initialize the CRDT document for this server */
int crdt_init(uint64_t server_numeric);
void crdt_shutdown(void);

/* State mutations (called from existing IRC handlers) */
int crdt_user_add(const char *numeric, const char *nick,
                  const char *ident, const char *host,
                  uint64_t modes, struct HLC timestamp);
int crdt_user_remove(const char *numeric);
int crdt_user_nick_change(const char *numeric, const char *new_nick,
                          struct HLC timestamp);

int crdt_channel_create(const char *name, struct HLC timestamp);
int crdt_channel_join(const char *chan, const char *user_numeric,
                      uint32_t flags);
int crdt_channel_part(const char *chan, const char *user_numeric);
int crdt_channel_set_mode(const char *chan, char mode_char,
                          int set, const char *param,
                          struct HLC timestamp);
int crdt_channel_set_topic(const char *chan, const char *topic,
                           const char *setter, struct HLC timestamp);
int crdt_channel_add_ban(const char *chan, const char *mask,
                         const char *setter, struct HLC timestamp);
int crdt_channel_remove_ban(const char *chan, const char *mask);

/* Sync operations */
int crdt_get_state_vector(uint8_t **out, uint32_t *out_len);
int crdt_compute_delta(const uint8_t *remote_sv, uint32_t sv_len,
                       uint8_t **out, uint32_t *out_len);
int crdt_apply_delta(const uint8_t *delta, uint32_t delta_len);
int crdt_get_pending_updates(uint8_t **out, uint32_t *out_len);

/* Observation (CRDT changes → generate IRC events) */
typedef void (*crdt_observer_fn)(int type, const char *key,
                                  const void *old_val,
                                  const void *new_val,
                                  void *ctx);
int crdt_observe_changes(crdt_observer_fn callback, void *ctx);
```

### 7.3 Bridge Pattern: Incremental Adoption

The bridge translates between existing P10 handlers and CRDT state. This allows **incremental adoption** — P10 continues to work, CRDT runs alongside:

```c
/* In ms_nick() — when receiving N token from remote server */
int ms_nick(struct Client *cptr, struct Client *sptr,
            int parc, char *parv[]) {
    /* ... existing P10 nick handling ... */

    /* Mirror into CRDT state */
    if (feature_bool(FEAT_CRDT_ENABLED)) {
        struct HLC ts = hlc_from_unix(atoi(parv[3]));
        crdt_user_add(parv[parc-2], parv[1], parv[4], parv[5],
                      mode_flags, ts);
    }

    /* ... rest of existing handler ... */
}

/* In ms_burst() — when receiving B token */
int ms_burst(struct Client *cptr, struct Client *sptr,
             int parc, char *parv[]) {
    /* ... existing P10 BURST handling ... */

    /* Mirror into CRDT state */
    if (feature_bool(FEAT_CRDT_ENABLED)) {
        crdt_channel_create(parv[1], hlc_from_unix(atoi(parv[2])));
        /* ... mirror members, modes, bans ... */
    }

    /* ... rest of existing handler ... */
}
```

### 7.4 Thread Safety

Y-CRDT's Doc requires serialized access. Nefarious is single-threaded (event loop), so this is naturally satisfied. All CRDT operations happen synchronously in the event loop — no mutexes needed.

### 7.5 Feature Flags

```
FEAT_CRDT_ENABLED        = 0/1   # Master switch
FEAT_CRDT_SYNC           = 0/1   # Use CRDT delta sync on link (vs P10 BURST)
FEAT_CRDT_MESH           = 0/1   # Allow mesh topology (vs tree)
FEAT_CRDT_PRIMARY         = 0/1   # CRDT is authoritative (vs P10 shadow)
FEAT_CRDT_GC_INTERVAL    = 300   # Tombstone GC interval (seconds)
FEAT_CRDT_BATCH_MS       = 10    # Update batching window (milliseconds)
FEAT_CRDT_COMPRESS       = 1     # Compress CRDT payloads with zstd
```

---

## 8. Library Choice: Y-CRDT (yrs)

### 8.1 Why Y-CRDT Over Alternatives

| Criteria | Y-CRDT (yrs) | Automerge | Custom |
|----------|-------------|-----------|--------|
| C FFI | Yes (yffi, maintained) | Yes (automerge-c) | N/A |
| GC support | Yes (tombstone compaction) | No (full history) | Manual |
| Memory efficiency | Good (with GC) | Higher (retains all history) | Optimal |
| Encoding size | lib0 binary (compact) | Columnar (comparable) | Custom |
| Sync protocol | Built-in 2-phase | Built-in | Manual |
| Maturity | Very mature (Yjs lineage, AppFlowy, BlockSuite) | Mature (Ink & Switch) | Unproven |
| Community | Large | Medium | None |
| Build complexity | Rust + cargo | Rust + cargo | C only |

**Y-CRDT wins** because:
1. GC support is critical — IRC state is highly transient (nicks, joins, parts)
2. Lower memory overhead for our use case
3. Named shared types map naturally to IRC's state categories
4. The yffi C header is comprehensive and well-maintained

### 8.2 C FFI Details

The `yffi` crate produces `libyrs.so`/`libyrs.a` with a complete C header. Key patterns:

```c
#include "libyrs.h"

/* Document lifecycle */
YDoc *doc = ydoc_new_with_id(server_numeric);

/* Transactions (all mutations require a transaction) */
YTransaction *txn = ydoc_write_transaction(doc);
YMap *users = ymap(txn, "users");
ymap_insert(txn, users, numeric, &user_value);
ytransaction_commit(txn);

/* Sync */
YTransaction *rtxn = ydoc_read_transaction(doc);
uint8_t *sv;
uint32_t sv_len = ytransaction_state_vector_v2(rtxn, &sv);
/* send sv to remote... */
ybinary_destroy(sv, sv_len);
ytransaction_commit(rtxn);

/* Apply remote delta */
YTransaction *wtxn = ydoc_write_transaction(doc);
ytransaction_apply_update(wtxn, delta_bytes, delta_len);
ytransaction_commit(wtxn);

/* Observe changes */
YSubscription *sub = ymap_observe(users, my_context, on_user_change);

/* Cleanup */
yunobserve(sub);
ydoc_destroy(doc);
```

**Memory model**: All objects are opaque pointers. Strings from yrs must be freed with `ystring_destroy()`, binaries with `ybinary_destroy()`.

### 8.3 Build Integration

```dockerfile
# In Dockerfile
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Build yrs as static library
COPY y-crdt /build/y-crdt
RUN cd /build/y-crdt/yffi && cargo build --release

# Link into nefarious
RUN cd /build/nefarious && ./configure \
    --with-yrs=/build/y-crdt/yffi/target/release \
    ...
```

Static linking (`libyrs.a`) produces a single binary with no runtime Rust dependency.

---

## 9. Performance Analysis

### 9.1 Memory Usage

| IRC Entity | CRDT Representation | Memory per Instance |
|------------|--------------------|--------------------|
| User (nick, modes, etc.) | Map with ~10 keys | ~500 bytes |
| Channel membership entry | Map entry (numeric → flags) | ~50 bytes |
| Channel state (modes, topic) | Map with ~15 keys | ~800 bytes |
| Ban list entry | Map entry | ~100 bytes |
| Message (chathistory) | Array element | ~200 bytes + text |

**For a 10,000 user / 5,000 channel network**:
- Users: 10,000 × 500 = ~5 MB
- Channel memberships (avg 20/channel): 100,000 × 50 = ~5 MB
- Channel state: 5,000 × 800 = ~4 MB
- **Total: ~14 MB** (comparable to current P10 in-memory state)

### 9.2 Sync Bandwidth

| Scenario | P10 BURST | CRDT Delta | Savings |
|----------|-----------|------------|---------|
| Fresh link (empty server) | ~2.5 MB | ~200 KB | 12x |
| Netsplit recovery (5 min) | ~2.5 MB | ~20 KB | 125x |
| Netsplit recovery (1 hour) | ~2.5 MB | ~500 KB | 5x |
| Incremental change | ~100 bytes | ~40 bytes | 2.5x |

### 9.3 Latency

- State vector exchange: 1 RTT
- Delta computation: O(n) where n = missing operations, ~1ms per 10,000 ops
- Single update encode: < 1 μs
- Single update apply: < 1 μs
- Total netsplit recovery (5 min split): ~10ms compute + network transfer

### 9.4 CPU Overhead

Y-CRDT operations are lightweight:
- Map insert/lookup: O(1) amortized
- Array append: O(1) amortized
- Delta computation: O(missing ops)
- State vector: O(number of servers)

The main CPU cost is encoding/decoding binary payloads for wire transfer, which is dominated by zstd compression (already used by Nefarious).

---

## 10. Tombstone Management

### 10.1 The Problem

CRDTs that support deletion accumulate tombstones — metadata for deleted elements that must be retained for correct merge behavior. Without garbage collection:
- 1 million nick changes → ~50 MB tombstones
- 10 million channel join/parts → ~500 MB tombstones

### 10.2 Y-CRDT's Built-in GC

Y-CRDT supports automatic GC that compacts tombstones:
```rust
let doc = Doc::with_options(Options {
    gc: true,  // Merge consecutive deleted items from same client
    ..Default::default()
});
```

This dramatically reduces tombstone memory by merging consecutive deletions into single GC blocks.

### 10.3 Causal Stability GC

An operation is **causally stable** when all servers have seen it. At that point, tombstones for it can be safely collected:

```
For tombstone T from server S at clock C:
  Can GC if: for all connected servers X, state_vector_X[S] >= C
```

Implementation: periodically broadcast minimum state vectors and compute the global minimum. All operations below the global minimum are stable and their tombstones can be collected.

### 10.4 Epoch-Based Compaction

For long-running networks, periodic full compaction:
1. Network agrees on a compaction epoch (via leader election or configured interval)
2. Each server snapshots its CRDT state at the epoch
3. All tombstones before the epoch are removed
4. New servers joining after compaction receive the snapshot + post-epoch operations

### 10.5 IRC-Specific Optimization

Most IRC state is inherently transient:
- **Nicks**: Old nicks need no tombstone once all servers know the nick changed
- **Channel parts**: Membership tombstone can be collected once all servers have the PART
- **Quit**: User removal tombstone collected once all servers processed the QUIT

The state vector tells us exactly when each server has seen each operation, making GC straightforward and safe.

---

## 11. Migration Path

### Phase 0: Proof of Concept

**Goal**: Validate that IRC state maps correctly onto Y-CRDT types.

- Create a standalone test program (not integrated into Nefarious yet)
- Model a mini IRC network as a CRDT document
- Simulate netsplits and verify convergence
- Measure memory usage and sync bandwidth
- **No wire protocol changes, no Nefarious code changes**

### Phase 1: Shadow CRDT State

**Goal**: Run CRDT alongside P10, validate correctness.

- Add `libyrs.a` to Nefarious build
- Mirror all P10 state mutations into CRDT document (bridge pattern)
- Periodically compare CRDT state vs P10 state for consistency
- Log any divergences for debugging
- Feature flag: `FEAT_CRDT_ENABLED` (shadow mode only)

### Phase 2: CRDT Delta Sync for Netsplit Recovery

**Goal**: Use CRDT sync instead of P10 BURST on reconnect.

- Exchange state vectors during server link
- Use CRDT delta instead of full BURST
- Fall back to P10 BURST if CRDT sync fails
- Keep P10 for incremental updates (not ready for full replacement yet)
- Feature flag: `FEAT_CRDT_SYNC`

### Phase 3: CRDT as Primary S2S Protocol

**Goal**: CRDT handles all S2S state synchronization.

- New CR token for CRDT messages
- CRDT updates replace P10 tokens for state propagation
- P10 bridge available for legacy servers
- CRDT observer generates IRC events for local clients
- Feature flag: `FEAT_CRDT_PRIMARY`

### Phase 4: Mesh Topology

**Goal**: Enable redundant server links and automatic failover.

- Remove tree topology constraint
- Multiple links per server with CRDT dedup handling duplicates
- Automatic partition recovery via any available path
- Feature flag: `FEAT_CRDT_MESH`

### Phase 5: X3 Integration / Services as CRDT Peer

**Goal**: Services participate as a CRDT node, not a privileged P10 entity.

- X3 maintains its own CRDT replica
- Account registrations, channel registrations are CRDT operations
- No special "services link" — just another peer
- This is the "X3 into Nefarious" endgame: services state IS network state

---

## 12. Impact on Existing Subsystems

### 12.1 Bouncer Session System

**Current**: Complex ghost/shadow/alias system with explicit state management per connection, per server. Session records persisted in MDBX.

**With CRDT**: Sessions are CRDT Map entries. All servers see the same session state. Ghost persistence is just another CRDT replica. Shadow syncing is eliminated — the CRDT handles it.

**Migration**: The `sessions` Map in the CRDT document replaces `BouncerSession` struct state. MDBX continues as the local persistent store (backing the CRDT replica). Cross-server relay (BS protocol) is replaced by CRDT sync.

**Tree-topology workarounds that disappear under CRDT mesh**:

The current P10-era bouncer code has several mechanisms that exist *only* because P10 enforces a single path between any two servers — the IRCv3-aware peer at the boundary can short-circuit invalid state before it reaches legacy peers downstream. These become unnecessary under CRDT mesh, where state convergence is mathematical rather than topology-dependent:

- **BX R session reconcile**: Pre-burst exchange that detects same-sessid split-brain on link, picks a winner via `last_active` + lex tiebreaker, and signals the loser to destroy its ghost (`bounce_destroy_yielded_ghost`). Under CRDT, sessions merge automatically; whichever side has the newer HLC wins per-field, no explicit reconcile message needed.

- **Active-vs-active demote with EOB retry**: When both sides have firm local primaries (each thinks it's origin, both `restore_pending=0`), the loser side demotes its primary to alias of the winner's primary via `bounce_demote_live_primary_to_alias`. Deferred to EOB if peer's primary numeric isn't yet locally resolvable (BX R precedes N in burst). CRDT replaces this with HLC-based primary-election; the "primary" attribute is just a field on the session CRDT entry that converges deterministically.

- **Held-ghost-on-link silent drop**: When BX R declares us winner, m_nick's rebind path silently drops the incoming N for the loser's ghost rather than broadcasting KILL — the loser's ghost-destroy Q broadcast is the only network-visible cleanup event. Relies on tree topology: the silent-drop at the IRCv3-aware hop means downstream legacy peers never see the duplicate N. **Under mesh this assumption breaks**: a legacy peer reachable via multiple paths could see both N's via independent forwarding before either side's reconcile completes. The mesh equivalent is to gate the burst-time forwarding of session-bearing N tokens on CRDT convergence having seen the session state, OR (preferable) eliminate the entire mechanism by making session ownership a CRDT field with HLC ordering rather than a per-server flag.

- **Account-asymmetry collision protection**: m_nick refuses to KILL an account-bearing local user for an unauthenticated incoming N from a legacy peer, regardless of standard same-user@host timestamp rules. In CRDT mesh with account-nick binding (§12.4), this becomes a clean CRDT invariant: account-bound nick claims always win over unauthenticated claims, no special m_nick logic needed.

- **JOIN/QUIT msgid parity**: `bounce_sync_alias_join` inherits the primary's `join_msgid` for the alias's auto-attach JOIN echo, so chathistory dedup treats them as one logical event. Under CRDT, channel membership is a single CRDT entry with one HLC-stamped insertion event for the logical user; alias auto-attach is just a presentation-layer choice on the receiving server, not a protocol concern.

These workarounds are documented here so that future mesh-migration work knows what's in scope to remove (vs. preserve). The `feedback_no_reset_hard_without_stash` and burst-order invariants (`project_bx_r_yield_burst_order`) can both be retired once CRDT lands.

### 12.2 Chathistory & Federation

**Existing work**: [`.claude/plans/federation-dedup-s2s-msgid.md`](.claude/plans/federation-dedup-s2s-msgid.md) covers chathistory federation fixes under P10. This work is **already implemented** (except bloom filters, deferred) and is **complementary, not replaced** by the CRDT proposal — the CRDT builds on it.

**What the federation plan solved (implemented, P10-era)**:
1. **S2S msgid preservation** ✅: Relay functions in `ircd_relay.c` use the originating server's msgid from P10 message tags instead of generating new ones. All servers store the same msgid for the same message. Semantic dedup eliminated.
2. **Federation merge sort** ✅: Fixed ascending/descending bug in `merge_messages()`.
3. **TARGETS federation** ✅: New `CH T` S2S response type, `TargetsFedContext` accumulator, `send_targets_batch()` with post-filter sorting.
4. **Multi-hop dest-addressed queries** ✅: `dest_numeric` field in `CH Q` for 3+ hop topologies, fixing the response-drop bug where intermediate servers discard responses for unknown reqids.
5. **Bloom filter advertisements** (deferred): Replace `CH A F` channel lists with compact bloom filters.

**Related plan**: [`.claude/plans/wild-frolicking-mango.md`](.claude/plans/wild-frolicking-mango.md) — Compact S2S message tags. Changes the msgid format from `AA-1772784000-42` (variable-length decimal) to `AABJrQAAAAAk` (fixed 14-char base64: `YY` server numeric + `EEEEEE` creation epoch + `QQQQQQ` counter). Also extends S2S tags to channel events (JOIN/PART/KICK/TOPIC/QUIT) with derived per-channel msgids for QUIT. This plan is a **natural stepping stone** toward HLC msgids.

**What the CRDT proposal adds on top**:
- **HLC-based msgids (evolution of compact format)**: The compact tag plan's msgid structure (`server_numeric + epoch + counter`) is structurally very similar to an HLC (`physical_ms + logical + node_id`). The key difference: HLCs guarantee causal ordering even with clock skew, while epoch+counter doesn't. Migration path: replace the compact format's `creation_epoch`(server boot time, static) + `counter` with HLC's `physical_ms`(wall clock per-event) + `logical`(counter for same-ms). The server numeric (`YY`) maps directly to the HLC `node_id`. The compact wire encoding (7 base64 chars for time) already accommodates this — just change what the 7 chars encode.
- **Read markers in CRDT**: Currently synced via MR P10 token. Becomes a natural LWW-Register per user×channel in the CRDT document.
- **Mesh routing eliminates multi-hop workaround**: The implemented `dest_numeric` fix exists because P10's tree topology requires intermediate forwarding. CRDT mesh topology means any server can query any other directly — no forwarding needed. The `dest_numeric` machinery becomes dead code.
- **Bloom filter → unnecessary**: Channel advertisement filtering (deferred in the federation plan) exists to avoid sending `CH Q` to servers that won't have the data. With CRDT state sync, every server knows what every other server has (state vectors). Bloom filters become redundant — no need to implement the deferred bloom work if CRDT is the target architecture.
- **CH Q/R protocol continues**: Message *content* stays in MDBX, not the CRDT (see §13.6). Federation queries for on-demand history fetching still use CH Q/R/T/E, but with trivial exact-msgid dedup instead of semantic dedup.
- **Derived msgids (QUIT) carry forward**: The compact tag plan's `derive_channel_msgid()` (FNV-1a hash of channel name appended to base msgid) works identically with HLC base msgids — the derivation is msgid-format-agnostic.

**Migration sequence**:
1. ~~Implement federation plan (S2S msgid preservation, TARGETS, dest-addressed queries)~~ ✅ Done
2. Implement compact S2S tags (`.claude/plans/wild-frolicking-mango.md`) — compact wire encoding, event tags, QUIT derived msgids
3. Evolve compact msgid → HLC msgid: change `creation_epoch+counter` to `physical_ms+logical`, keep `YY` server numeric. Compact wire format version byte increments (`A` → `B`). Auto-detection handles mixed versions.
4. Migrate read markers into CRDT document
5. When CRDT mesh is active: `dest_numeric` forwarding becomes dead code (mesh = direct queries). Bloom filter (deferred) never needs implementation — CRDT state vectors supersede it.

### 12.3 Metadata

**Current**: MD/MDQ P10 tokens, X3 timeout-based sync, compression.

**With CRDT**: IRCv3 metadata is a natural CRDT Map. Each key is an independent LWW-Register. Sync is automatic via CRDT protocol.

### 12.4 Nick Registration / Account System

**Current**: X3 AuthServ handles registration. Account association via AC token.

**With CRDT**: Account data is part of the CRDT document. Registration becomes a CRDT operation. Account-nick binding enables smarter nick collision resolution (account owner always wins).

### 12.5 SASL Authentication

**Current**: P10 SASL subtokens route auth flow between client's server and X3.

**With CRDT**: SASL is a transient flow, not replicated state. Continue using direct server-to-services communication for auth flows. Only the *result* (account association) becomes a CRDT operation.

---

## 13. Open Questions

### 13.1 Document Granularity

Should we have:
- **One global document** (simplest, single state vector covers everything)
- **Per-channel documents** (finer-grained sync, but O(channels) state vectors)
- **Hybrid** (global for users/servers, per-channel for channel state)

**Leaning**: One global document. The state vector overhead is trivial (< 1KB for the entire IRC network), and a single document simplifies the sync protocol.

### 13.2 Oldest-TS-Wins for Nicks

Standard CRDTs use "newest wins" (LWW). IRC's nick collision uses "oldest wins." Options:
- Invert the comparison in a custom LWW-Register
- Use a wrapper that negates timestamps before storing
- Implement nick resolution at the application layer above the CRDT

**Leaning**: Application-layer resolution. The CRDT stores all nick claims; the application logic picks the winner based on IRC-specific rules.

### 13.3 OR-Set Add-Wins for KICK

Concurrent JOIN + KICK → user remains (add-wins). Is this acceptable?
- **Argument for**: User legitimately joined on their side. Safer than silently removing.
- **Argument against**: Oper issued a kick for a reason. Having to re-kick is annoying.
- **Possible compromise**: Custom OR-Set variant where removals carry a priority (e.g., oper removals beat user adds)

### 13.4 X3 Transition

During migration, X3 still speaks P10. Options:
- X3 continues on P10 with a bridge to CRDT (pragmatic)
- X3 becomes a CRDT peer (long-term, aligns with X3-into-Nefarious goal)
- Hybrid: X3 uses P10 for commands, CRDT for state sync

### 13.5 Backward Compatibility Period

How long to support both P10 and CRDT simultaneously? Need to define:
- Minimum server version for CRDT support
- Fallback behavior when linking to P10-only servers
- Feature negotiation during server handshake

### 13.6 Chat History: Explicitly NOT in the CRDT

**Decision**: Chat history stays in MDBX. The CRDT handles only **live network state** (users, channels, modes, memberships, metadata, sessions). Message content is never replicated through the CRDT document.

**Why**: Matrix made this mistake. Their event DAG replicates the full history of every room to every participating server. The result:
- Synapse databases routinely hit 100+ GB for moderately active homeservers
- State resolution over long event chains becomes a performance nightmare
- Room "state" includes every historical event, not just current state
- Database migrations and compaction are painful multi-hour operations
- The Dendrite/Conduit rewrites exist largely because of this architectural debt

Chat history is fundamentally different from network state:
- **State** (nicks, channels, modes) is small, frequently mutated, and needs consistency → CRDT
- **History** (messages) is large, append-only, and needs efficient range queries → MDBX/database

The CRDT's role for messages is limited to:
1. **Canonical msgid assignment**: HLC-based IDs generated at origin, never rewritten by relays (solves the msgid fragmentation problem — see [federation-dedup-s2s-msgid.md](.claude/plans/federation-dedup-s2s-msgid.md) §1-2 for the P10-era fix that precedes this)
2. **Read markers**: Per-user last-read position per channel — small LWW-Registers, natural CRDT fit

Note: federation dedup metadata (bloom filters for channel advertisements) becomes unnecessary once CRDT state vectors tell each server exactly what every other server knows. The bloom filter optimization in the federation plan is a good interim solution under P10 but is superseded by CRDT state awareness.

Message relay continues via direct S2S delivery (or mesh multicast). Each server stores messages locally in MDBX. Chathistory queries hit local storage. Federation queries for remote history use the existing CH Q/R/T/E protocol (see federation plan for TARGETS federation and multi-hop dest-addressed queries — both continue to work under CRDT, though mesh topology simplifies the routing).

---

## 14. Prior Art

### 14.1 Matrix Protocol

Matrix uses a DAG-based event system with CRDT-like properties:
- Events form a directed acyclic graph
- Each event references parent events (causal dependencies)
- State resolution algorithm v2 resolves conflicts deterministically
- Every server has a full copy of room state

**The cautionary tale — event history bloat**:

Matrix's biggest architectural mistake was making the event DAG the source of truth for everything — state AND history in one replicated structure. Every message, every state change, every reaction is an event in the DAG, replicated to every participating server.

Consequences:
- Synapse (reference homeserver) databases routinely exceed 100-200 GB for active deployments
- State resolution over rooms with long histories becomes O(events) — rooms active for years need minutes to resolve
- The `state_groups` and `state_groups_state` tables dominate storage, growing without bound
- Database compaction/cleanup (`synapse_auto_compressor`, `rust-synapse-compress-state`) became critical external tools just to keep servers running
- The Dendrite and Conduit rewrites were motivated in large part by this architectural debt
- Federation backfill (fetching history from remote servers) creates cascading load — one slow server degrades the whole room

**Key lessons for our design**:
- **Separate state from history**: The CRDT should track live network state only. Messages go in a purpose-built store (MDBX).
- State resolution is the hardest part to get right
- The "ban vs power level" problem required careful policy design (IRC has the equivalent: concurrent oper MODE vs KICK)
- CRDTs are excellent for state; append-only databases are better for history

### 14.2 Figma

Built a custom CRDT for collaborative design:
- Found standard CRDTs had too much memory overhead for their domain
- Built domain-specific optimizations
- Lesson: don't blindly adopt a general CRDT — tailor to your domain

### 14.3 AppFlowy

Uses Y-CRDT (yrs) in production for collaborative editing:
- Validates that yffi (C FFI) works in production
- Full sync protocol battle-tested at scale
- Confirms Y-CRDT's GC keeps memory manageable

### 14.4 CockroachDB / TigerBeetle

Use Hybrid Logical Clocks (HLCs) for distributed ordering:
- Validates HLC approach for bounded clock skew tolerance
- Demonstrates HLCs working at scale in distributed systems

---

## 15. Appendices

### A. Hybrid Logical Clock Implementation

```c
/* crdt_hlc.h */
#include <stdint.h>
#include <time.h>

struct HLC {
    uint64_t physical_ms;   /* Wall clock (milliseconds since epoch) */
    uint16_t logical;       /* Logical counter for same-ms events */
    uint16_t node_id;       /* Server numeric (deterministic tiebreaker) */
};

/* Packed into a single 96-bit value for wire encoding:
 * [64 bits: physical_ms][16 bits: logical][16 bits: node_id]
 *
 * Comparison: lexicographic on (physical_ms, logical, node_id)
 *
 * Mapping to compact S2S tag format (wild-frolicking-mango.md):
 *   Compact v0 (version 'A'): @A<time:7><msgid:14>
 *     time:  7 base64 chars = 42 bits epoch_ms (physical_ms)
 *     msgid: YY(server numeric=node_id) + EEEEEE(creation epoch) + QQQQQQ(counter)
 *
 *   Compact v1 (version 'B'): @B<time:7><msgid:14>  [proposed HLC evolution]
 *     time:  7 base64 chars = 42 bits epoch_ms (physical_ms, same as v0)
 *     msgid: YY(node_id) + LLLL(logical, 4 b64 = 24 bits) + QQQQQQQQ(counter, 8 b64 = 48 bits)
 *
 *   The version byte auto-detection handles both formats on the wire.
 *   The `time` field is already HLC-compatible (epoch_ms).
 *   The msgid changes from static-epoch+counter to logical+counter.
 */

static inline uint64_t wall_clock_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static inline struct HLC hlc_local_event(struct HLC local) {
    uint64_t now = wall_clock_ms();
    if (now > local.physical_ms) {
        return (struct HLC){ now, 0, local.node_id };
    } else {
        return (struct HLC){ local.physical_ms, local.logical + 1,
                             local.node_id };
    }
}

static inline struct HLC hlc_receive(struct HLC local,
                                      struct HLC remote) {
    uint64_t now = wall_clock_ms();
    uint64_t max_pt = now;
    uint16_t logical;

    if (local.physical_ms > max_pt) max_pt = local.physical_ms;
    if (remote.physical_ms > max_pt) max_pt = remote.physical_ms;

    if (max_pt == local.physical_ms &&
        max_pt == remote.physical_ms) {
        logical = (local.logical > remote.logical ?
                   local.logical : remote.logical) + 1;
    } else if (max_pt == local.physical_ms) {
        logical = local.logical + 1;
    } else if (max_pt == remote.physical_ms) {
        logical = remote.logical + 1;
    } else {
        logical = 0;
    }

    return (struct HLC){ max_pt, logical, local.node_id };
}

static inline int hlc_compare(struct HLC a, struct HLC b) {
    if (a.physical_ms != b.physical_ms)
        return a.physical_ms < b.physical_ms ? -1 : 1;
    if (a.logical != b.logical)
        return a.logical < b.logical ? -1 : 1;
    if (a.node_id != b.node_id)
        return a.node_id < b.node_id ? -1 : 1;
    return 0;
}
```

### B. CRDT Type Summary for IRC

```
NetworkDoc (Y-CRDT Doc)
├── "servers"   : Map<numeric, Map<field, LWW-Register>>
├── "users"     : Map<numeric, Map<field, LWW-Register>>
├── "nicks"     : Map<lowercase_nick, Map<claim_fields>>
├── "channels"  : Map<name, {
│   ├── "modes"   : Map<mode_char, LWW-Register>
│   ├── "topic"   : LWW-Register<{text, setter, time}>
│   ├── "members" : Map<numeric, LWW-Register<flags>>
│   ├── "bans"    : Map<mask, LWW-Register<{setter, time}>>
│   ├── "excepts" : Map<mask, LWW-Register<{setter, time}>>
│   └── "invites" : Map<mask, LWW-Register<{setter, time}>>
│   }>
├── "metadata"  : Map<target, Map<key, LWW-Register<value>>>
└── "sessions"  : Map<session_id, Map<field, LWW-Register>>
```

### C. Bandwidth Comparison Table

| Operation | P10 Wire Size | CRDT Wire Size | Ratio |
|-----------|--------------|----------------|-------|
| Nick introduction | ~120 bytes | ~80 bytes | 1.5x |
| Channel join | ~50 bytes | ~40 bytes | 1.25x |
| Mode change | ~60 bytes | ~45 bytes | 1.3x |
| Topic change | ~100 bytes + topic | ~60 bytes + topic | 1.3x |
| Ban add | ~80 bytes | ~50 bytes | 1.6x |
| Full BURST (10k users) | ~2.5 MB | ~200 KB | 12.5x |
| Netsplit recovery (5 min) | ~2.5 MB | ~20 KB | 125x |
| State vector exchange | N/A | ~400 bytes | N/A |

### D. References

- **Y-CRDT (yrs)**: https://github.com/y-crdt/y-crdt — Rust CRDT library with C FFI
- **Yjs**: https://github.com/yjs/yjs — Original JS implementation, extensive docs
- **CRDTs: The Hard Parts** (Martin Kleppmann, 2020): https://www.youtube.com/watch?v=x7drE24geUw
- **Hybrid Logical Clocks** (Kulkarni et al., 2014): formal HLC specification
- **Matrix State Resolution v2**: https://spec.matrix.org/latest/rooms/v2/ — Prior art for chat state resolution
- **P10 Protocol Reference**: `P10_PROTOCOL_REFERENCE.md` in this repository
- **Federation Dedup Plan**: `.claude/plans/federation-dedup-s2s-msgid.md` — documents current msgid fragmentation

---

## 16. Audit Report (2026-03-07)

**Auditor**: Claude (Opus 4.6)
**Scope**: Feasibility audit, gap analysis, accuracy verification, and expansion toward actionable plan.

### 16.1 Executive Assessment

The proposal is **architecturally sound in its vision** — CRDT-based mesh sync genuinely solves the right problems (netsplit desyncs, BURST storms, msgid fragmentation, tree rigidity). The IRC state → CRDT mapping is well-chosen, and the decision to keep chat history out of the CRDT (learning from Matrix) is excellent.

However, the proposal has **several critical gaps** that must be resolved before it becomes actionable:

1. **Y-CRDT tombstone management is overstated** — the library doesn't solve unbounded tombstone growth for IRC's churn patterns
2. **The C FFI has no known production users** and introduces a Rust build dependency
3. **Key conflict resolution semantics are unresolved** (nick collisions, KICK vs JOIN)
4. **The migration bridge between CRDT and P10 is underspecified**
5. **Server delink/SQUIT handling is entirely missing**

### 16.2 Accuracy Verification

#### What's Correct

| Claim | Verdict | Notes |
|-------|---------|-------|
| P10 problems (§1) | ✅ Accurate | All five problems are real and well-documented |
| CRDT fundamentals (§2) | ✅ Accurate | Commutativity/idempotency/convergence correctly described |
| IRC state maps to CRDTs (§3) | ✅ Correct | OR-Set for memberships, LWW-Map for modes, etc. |
| Chat history NOT in CRDT (§13.6) | ✅ Excellent | Matrix's event DAG lesson correctly applied |
| HLC implementation (Appendix A) | ✅ Correct | Standard HLC algorithm per Kulkarni et al. |
| Y-CRDT has C FFI (§8) | ✅ Exists | `yffi` crate produces C header via cbindgen |
| Sync protocol (§4) | ✅ Correct | State vector exchange + delta is how Y-CRDT sync works |
| Build integration pattern (§8.3) | ✅ Viable | Follows same pattern as libmdbx/zstd in existing Dockerfile |

#### What's Inaccurate or Misleading

| Claim | Issue | Correction |
|-------|-------|------------|
| §10.2 "Y-CRDT has built-in GC that compacts tombstones" | **Misleading** | Y-CRDT's GC only strips deleted *content*, not tombstone *metadata*. Tombstone IDs (the 8-byte item identifiers) grow unboundedly. For IRC with millions of join/parts, this is a real memory concern over months. |
| §10.3 "Causal Stability GC" | **Hypothetical** | This is a theoretical CS concept, not a Y-CRDT feature. You'd have to implement this yourself on top of Y-CRDT. The proposal presents it as part of the solution without noting it's custom work. |
| §10.4 "Epoch-Based Compaction" | **Custom work** | Not a Y-CRDT feature. Would require snapshot + document recreation — essentially throwing away the old YDoc and starting fresh. This is viable but disruptive. |
| §9.1 "Message (chathistory): ~200 bytes" row | **Contradictory** | §13.6 explicitly says chat history is NOT in the CRDT. This row shouldn't be in the memory table. |
| §8.1 "GC support: Yes (tombstone compaction)" vs Automerge "No (full history)" | **Misleading comparison** | Both retain tombstone metadata. Y-CRDT strips content; Automerge retains content. Neither truly compacts tombstones. |
| §9.2 bandwidth claims (200 KB full delta, 20 KB netsplit) | **Unverified** | No benchmark exists. These are estimates based on assumed encoding sizes. Need Phase 0 validation. |

#### Compact Tag HLC Evolution (Appendix A, v1 format) — Bit Allocation Issue

The selected section proposes:
```
Compact v1 (version 'B'): @B<time:7><msgid:14>
  msgid: YY(node_id) + LLLL(logical, 4 b64 = 24 bits) + QQQQQQQQ(counter, 8 b64 = 48 bits)
```

Issues:
- **HLC struct uses `uint16_t logical` = 16 bits**, but the wire format allocates 24 bits (4 base64 chars). 8 bits wasted.
- **48 bits for counter is excessive**: at 1M msgs/sec, 48 bits lasts 8.9 years per server restart. 36 bits (6 base64 chars) would last 19.4 hours at that rate — still generous for an IRC server, and would free up 2 chars.
- **Alternatively**: Use the full 24 wire bits for logical (upgrade `uint16_t` → `uint32_t` in the HLC struct, using only lower 24 bits). This handles extreme clock skew scenarios where the logical counter needs more headroom.

**Recommended fix**: Either shrink LLLL to LLL (3 chars = 18 bits, still > 16-bit logical) and add a char to counter, or expand HLC.logical to uint32_t to match the 24-bit allocation. The current mismatch should be resolved explicitly.

### 16.3 Critical Gaps

#### Gap 1: Tombstone Growth is Unsolved

**Severity**: 🔴 Architectural risk

IRC has fundamentally different churn characteristics than collaborative document editing (Y-CRDT's design target):

| Operation | Frequency (busy network) | Tombstone Impact |
|-----------|-------------------------|------------------|
| JOIN/PART | ~100/sec peak | Each generates a tombstone in the channel members Map |
| NICK change | ~10/sec | Tombstone in nicks Map + update in users Map |
| MODE change | ~5/sec | LWW overwrites don't create tombstones (✅ safe) |
| QUIT | ~50/sec | Tombstone in users Map + members Maps for every channel |

**Projection**: A busy network generates ~150 tombstone-creating operations/sec. Over 30 days: ~389M tombstones. Even at 8 bytes/tombstone metadata, that's ~3.1 GB of tombstone overhead that Y-CRDT cannot reclaim.

**Solutions to evaluate in Phase 0**:
1. **Document rotation**: Periodically create a fresh YDoc, snapshot current state into it, swap. Requires quiescing sync briefly. Custom implementation.
2. **Per-domain documents**: Separate YDocs for users, channels, metadata. Rotate high-churn docs (users/channels) more frequently. More complex sync (multiple state vectors).
3. **Custom CRDT**: Skip Y-CRDT entirely. Implement purpose-built OR-Set and LWW-Map in C with true tombstone reclamation. More work, but exactly fits IRC semantics.
4. **Hybrid**: Use Y-CRDT for low-churn state (metadata, sessions, read markers). Use a custom simpler CRDT or state-based sync for high-churn state (users, channel members).

#### Gap 2: No Known C FFI Production Users

**Severity**: 🟡 Risk factor

Y-CRDT's C FFI (`yffi`) exists and the API surface is comprehensive, but:
- **Pre-1.0 library** (v0.18.x) — API may change
- **No known C production users** — all known deployments use Rust, JS, Python, or WASM bindings
- **Error handling is almost nonexistent** — most functions return NULL/0 on failure with no error code
- **Memory management is manual and error-prone** — every returned pointer needs a specific `*_destroy()` call
- **Introduces Rust toolchain as build dependency** — ~1 GB added to build image, first Rust dep in the project

The existing build system handles this well (parallel Docker build stages, same pattern as libmdbx/libkc), but it's a permanent maintenance burden.

#### Gap 3: Nick Collision Resolution is Not CRDT-Native

**Severity**: 🟡 Semantic mismatch

§5.1 and §13.2 acknowledge that CRDTs use newest-wins (LWW) but IRC needs oldest-wins for nicks. The proposal leans toward "application-layer resolution" — meaning the CRDT stores all claims, and IRC code picks the winner.

This means:
- The CRDT doesn't actually resolve nick conflicts — you still need custom conflict resolution code
- During a merge, you must scan the nicks Map, detect conflicts, and emit forced nick changes
- This is the observer pattern (§7.2 `crdt_observe_changes`) but the details are unspecified
- **Account-aware resolution** (§5.1 enhancement) adds another layer: account owner beats timestamp. This requires cross-referencing account data during nick resolution — more application logic that the CRDT can't express.

**Recommendation**: Design the nick resolution as a deterministic state machine that runs in the CRDT observer. Specify the exact priority order: (1) account owner match, (2) oldest timestamp, (3) node_id tiebreaker. Document the forced-rename protocol (what nick do losers get?).

#### Gap 4: OR-Set ADD-WINS for KICK is Wrong for IRC

**Severity**: 🟡 Semantic mismatch

§5.2 recommends add-wins for channel membership: concurrent JOIN + KICK → user remains. The argument is "user legitimately joined on their side."

**Counter-argument**: An oper kicked someone for a reason (spam, abuse, ban evasion). If the kick is ineffective across a split, the oper must:
1. Notice the user is back (may not be obvious)
2. Re-kick manually
3. During the window between merge and re-kick, the user is active in the channel

This is a **safety-critical semantic choice** for IRC. Options:

| Policy | Concurrent JOIN+KICK Result | Trade-off |
|--------|---------------------------|-----------|
| Add-wins (§5.2 recommendation) | User stays | Kicks are "advisory" across splits |
| Remove-wins | User gone | Legitimate joins are lost |
| Priority-based | Oper kick > user join | Requires priority metadata in the CRDT |
| Last-writer-wins | Most recent action wins | Depends on HLC accuracy |

**Recommendation**: **Priority-based remove-wins for KICK specifically.** Use an OR-Set variant where remove operations carry an oper flag. `KICK` (oper-initiated remove) beats concurrent `JOIN`. Regular `PART` uses standard OR-Set semantics. This requires a custom OR-Set implementation — Y-CRDT's Map type doesn't natively support prioritized removes.

#### Gap 5: SQUIT / Server Delink is Unaddressed

**Severity**: 🔴 Missing entirely

When a server delinks (SQUIT), all users on that server must be removed from the network. In P10, this is handled by propagating the SQUIT and each server removing the affected users. The proposal doesn't discuss:

- How does a SQUIT map to CRDT operations? Is it N individual `crdt_user_remove()` calls (one per user on the departing server)?
- **Atomicity**: Should a SQUIT be atomic (all users removed in one transaction) or can it be a series of individual removes?
- **Reconvergence**: If the server reconnects quickly, its users rejoin via delta sync. But the SQUIT-triggered removes and the rejoin adds may create a storm of tombstones.
- **Phantom users**: If SQUIT removes are applied on some servers but the departing server reconnects before all servers process the removes, CRDT add-wins semantics would mean the users never actually left. Is this correct behavior? (Arguably yes — the users were connected the whole time on their server.)

**Recommendation**: Define SQUIT as a **server state transition** in the CRDT (server record marked as `split`), not as individual user removes. Users belonging to a split server are rendered invisible locally but not tombstoned. On reconnect, the server record transitions back to `linked` and users reappear. This avoids the tombstone storm and matches the actual semantics (users didn't quit — their server split).

#### Gap 6: CRDT Document Persistence Across Restarts

**Severity**: 🟡 Missing

The proposal doesn't discuss what happens when a Nefarious server restarts:
- Does the CRDT document need to be persisted to disk?
- If so, how? Y-CRDT's `ydoc_encode_state_as_update_v2()` produces a full snapshot, but when do you write it?
- If not persisted, the restarting server must do a full sync (equivalent to fresh link). This is fine but should be explicit.
- If persisted, interaction with MDBX needs design: separate MDBX database for CRDT state? Single blob? Incremental updates?

**Recommendation**: Don't persist the CRDT document initially. A restarting server does a full sync (receives the complete delta from its peer). This is simpler and the bandwidth cost is acceptable (~200 KB per the proposal's own estimates). Persistence can be added later as an optimization.

#### Gap 7: Hybrid Phase Bridge (P10 ↔ CRDT) is Underspecified

**Severity**: 🟡 Needs design

§7.3 shows the bridge pattern for mirroring P10 mutations into CRDT, but the reverse is missing:

- When a CRDT update arrives from a CRDT-aware peer, how does the receiving server generate P10 tokens to forward to P10-only peers?
- The CRDT observer (§7.2) fires callbacks like `on_user_change(type, key, old_val, new_val)`. These must be translated back into N, B, M, T, etc. tokens. This is the entire P10 protocol in reverse — significant engineering.
- **Consistency during hybrid**: If server A speaks CRDT to server B but P10 to server C, and a netsplit partitions B from {A,C}: A must handle CRDT merge with B (add-wins, HLC timestamps) AND P10 BURST with C (TS comparison, all-or-nothing) simultaneously. The merge results may be incompatible.

**Recommendation**: Define a clear topology constraint for the hybrid phase: CRDT-aware servers form a CRDT mesh among themselves, and designate ONE gateway server that bridges to the P10 tree. The gateway speaks both protocols. This avoids the dual-merge problem.

### 16.4 Prerequisite Dependency Chain

The proposal correctly identifies the migration sequence but the dependency chain should be made explicit:

```
✅ DONE: S2S msgid preservation (federation-dedup-s2s-msgid.md)
    ↓
✅ DONE: Compact S2S tags (wild-frolicking-mango.md) — needs build verification
    ↓
NEXT: HLC msgid evolution (compact v0→v1, version 'A'→'B')
    ↓ (can run in parallel with:)
NEXT: Phase 0 PoC — validate Y-CRDT vs custom CRDT for IRC state
    ↓
Phase 1: Shadow CRDT state (dual-write P10 + CRDT)
    ↓
Phase 2: CRDT delta sync for netsplit recovery
    ↓
Phase 3: CRDT as primary S2S
    ↓
Phase 4: Mesh topology
    ↓
Phase 5: X3 as CRDT peer (services merge endgame)
```

The **HLC evolution** and **Phase 0 PoC** are the two immediate next steps and can proceed in parallel.

### 16.5 Alternative: Custom CRDT vs Y-CRDT

The proposal exclusively evaluates Y-CRDT. A custom C implementation deserves serious consideration:

| Factor | Y-CRDT (yffi) | Custom C CRDT |
|--------|--------------|---------------|
| Development time | ~2 weeks integration | ~6-8 weeks implementation |
| Tombstone control | Limited (Y-CRDT's opaque GC) | Full control (true reclamation) |
| IRC semantics | Adapted (document editing primitives) | Native (purpose-built for IRC state) |
| Build complexity | Rust toolchain required | Pure C, no new dependencies |
| Maintenance burden | Upstream dependency, FFI fragility | Self-maintained, but simpler |
| Sync protocol | Built-in, battle-tested (Yjs lineage) | Must implement (but spec is simple) |
| Memory overhead | Higher (document editing metadata) | Lower (IRC-specific structures) |
| Debugging | Opaque binary blobs | Inspectable native structures |
| Risk profile | Upstream API changes, no C prod users | Implementation bugs, but fully controlled |

**IRC's CRDT needs are actually quite simple compared to collaborative editing:**
- **OR-Set** (channel members, ban lists) — well-understood, ~200 lines of C
- **LWW-Map** (user state, channel modes, metadata) — ~150 lines of C
- **State vector** (sync protocol) — ~100 lines of C
- **HLC** — already designed in the proposal, ~50 lines of C
- **Delta encoding** — serialization of operations since a given state vector, ~300 lines of C

Total: ~800 lines of purpose-built C vs a 50,000+ line Rust dependency. The custom approach also gives full control over tombstone lifecycle, which is the critical unsolved problem.

**Recommendation**: Phase 0 should prototype BOTH approaches — a Y-CRDT integration AND a minimal custom CRDT — and compare on: memory growth over 24 hours of simulated churn, sync correctness under partition, and code complexity.

### 16.6 Phase 0 PoC Specification (Proposed)

The current Phase 0 description (§11) is vague: "Create a standalone test program." Here's a concrete spec:

#### Objectives
1. Validate that IRC state converges correctly after simulated netsplits
2. Measure tombstone/memory growth under sustained churn
3. Compare Y-CRDT vs custom implementation
4. Validate HLC ordering under simulated clock skew

#### Test Scenarios

**Scenario A — Basic convergence:**
- 3 simulated servers, fully meshed
- 100 users, 50 channels, normal operations for 5 minutes
- Partition server C from {A, B} for 2 minutes
- Independent operations on both sides during partition
- Rejoin and verify convergence

**Scenario B — Nick collision:**
- 2 servers, partitioned
- Same nick claimed on both sides
- Rejoin, verify deterministic resolution (oldest wins, no kill)

**Scenario C — Concurrent KICK+JOIN:**
- Channel with user X on server A
- Partition: A kicks X, B gets X to join
- Rejoin, verify policy (add-wins vs priority-remove-wins)

**Scenario D — Tombstone growth (24-hour stress test):**
- 2 servers, continuous sync
- 100 users cycling JOIN/PART every 10 seconds across 50 channels
- Measure memory at T=0, T=1h, T=6h, T=24h
- For Y-CRDT: measure with GC enabled vs disabled
- For custom: measure with tombstone reclamation vs without

**Scenario E — SQUIT storm:**
- 4 servers, server D hosts 2,500 users
- Server D delinks (SQUIT)
- Measure: tombstone creation count, sync payload size, reconvergence time when D relinks

#### Success Criteria
- 100% state convergence in all scenarios
- Memory growth < 2x baseline after 24 hours of churn (Scenario D)
- Netsplit recovery delta < 100 KB for 5-minute split with 200 changes (Scenario A)
- Nick collision resolved without kills (Scenario B)
- HLC ordering correct with up to 500ms simulated clock skew

#### Deliverables
- Standalone C test program (not integrated into Nefarious)
- Benchmark results table
- Y-CRDT vs custom comparison
- Go/no-go recommendation for Phase 1

### 16.7 Remaining Open Questions (Expanded)

In addition to the open questions in §13, the audit identifies:

1. **CRDT document size limits**: Is there a practical upper bound on YDoc size? What happens at 100 MB? 1 GB?
2. **Partial sync failure recovery**: If a delta application fails mid-stream (network error), does the document remain consistent? Can sync resume?
3. **Observer ordering**: When multiple fields change in one transaction, what order do observers fire? Does this matter for IRC semantics (e.g., nick change + mode change in same operation)?
4. **SASL interaction**: During SASL auth, the account association changes. If this happens during a CRDT sync, does the merge handle it correctly? (Probably yes — AC is a simple LWW-Register — but needs verification.)
5. **Oper overrides**: Some IRC operations are privileged (OPMODE, CLEARMODE). Should these have higher priority in LWW resolution? Or is timestamp sufficient?
6. **Clock skew tolerance**: The HLC tolerates bounded skew, but what's the bound? If a server's clock is 1 hour off, HLC still produces monotonic timestamps, but the `physical_ms` component is wrong. Does this cause user-visible issues (e.g., topic set "in the future")?
7. **Multi-document vs single-document**: If going custom CRDT, per-channel documents avoid the tombstone scaling issue entirely (GC a channel doc when the channel is empty). Worth prototyping.

### 16.8 Recommendation

**Proceed to Phase 0 PoC** with the following adjustments:

1. **Prototype both Y-CRDT and custom CRDT** — the tombstone question must be answered empirically
2. **Resolve the KICK semantics** before implementation — this is a policy decision that affects CRDT type choice
3. **Design SQUIT as a server-state transition**, not user-level removes
4. **Fix the compact tag v1 bit allocation** (logical counter size mismatch)
5. **Define the hybrid bridge topology constraint** (single CRDT↔P10 gateway)
6. **Don't block on Y-CRDT** — if Phase 0 shows the custom approach is viable and solves tombstones, prefer it

The vision is right. The details need Phase 0 to shake out.

---

## 17. Custom C CRDT — Concrete Designs

**Date**: 2026-03-07
**Status**: Detailed design addressing all §16 audit gaps
**Approach**: Purpose-built C CRDT primitives for IRC state, replacing Y-CRDT dependency

The audit (§16) identified that Y-CRDT's document-editing abstractions are a poor fit for IRC's high-churn state patterns, particularly around tombstone management. This section designs IRC-specific CRDT data structures in pure C — ~1,900 lines of purpose-built code vs a 50,000+ line Rust dependency.

### 17.1 Custom C CRDT Data Structures

Four CRDT primitives, each designed for IRC's specific patterns:

#### 17.1.1 CrdtTag — Unique Operation Identifier

Every add operation in an OR-Set gets a globally unique tag. Tags are the foundation of CRDT correctness — they let us distinguish "the same element added by different operations" from "the same add seen twice."

```c
/* crdt_types.h */

/** Globally unique tag for OR-Set operations.
 *  Generated by the originating server; never reused.
 *  Comparison: lexicographic on (origin, seq).
 */
struct CrdtTag {
    uint16_t origin;    /* Server numeric (P10 base64 decoded) */
    uint64_t seq;       /* Per-server monotonic sequence number */
};

/** Compare two tags. Returns -1, 0, or 1. */
static inline int crdt_tag_cmp(struct CrdtTag a, struct CrdtTag b) {
    if (a.origin != b.origin) return a.origin < b.origin ? -1 : 1;
    if (a.seq != b.seq) return a.seq < b.seq ? -1 : 1;
    return 0;
}

/** Global per-server sequence counter. Monotonically increasing.
 *  Each server allocates tags from its own sequence space.
 *  Reset on server restart (state vector exchange handles this).
 */
static uint64_t crdt_local_seq = 0;

static inline struct CrdtTag crdt_new_tag(uint16_t my_numeric) {
    return (struct CrdtTag){ my_numeric, ++crdt_local_seq };
}
```

Tags are 10 bytes on the wire. A busy server generating 100 ops/sec exhausts `uint64_t` seq space in ~5.8 billion years.

#### 17.1.2 CrdtORSet — Observed-Remove Set with Priority Extensions

The OR-Set is the workhorse for channel membership, ban lists, and server lists. Our variant adds **priority removes** for KICK semantics (see §17.4).

```c
/** An element in the OR-Set.
 *  Each element can have multiple concurrent add-tags
 *  (from different servers during a partition).
 */
struct CrdtORSetEntry {
    char               *key;          /* Element value (nick, ban mask, etc.) */
    uint32_t            key_len;
    struct CrdtTag     *add_tags;     /* Dynamic array of add tags */
    uint16_t            add_count;
    uint16_t            add_capacity;
    struct CrdtORSetEntry *ht_next;   /* Hash table chain */
};

/** A remove record (tombstone).
 *  Tombstones are reclaimed via causal stability GC (§17.2).
 */
struct CrdtTombstone {
    struct CrdtTag      tag;          /* The add-tag being removed */
    uint8_t             priority;     /* 0=PART, 2=KICK, 3=SERVICES, 4=IRCD */
    struct CrdtTombstone *next;       /* Hash chain */
};

/** OR-Set with priority-aware removes.
 *  Elements: hash table of CrdtORSetEntry.
 *  Tombstones: hash table of CrdtTombstone (keyed by tag).
 */
struct CrdtORSet {
    struct CrdtORSetEntry **entries;    /* Hash table buckets */
    uint32_t                entry_count;
    uint32_t                bucket_count;
    struct CrdtTombstone  **tombstones; /* Hash table of removed tags */
    uint32_t                tomb_count;
    uint32_t                tomb_buckets;
};

/** Check if an element is present (considering priority removes).
 *
 *  An element is present if:
 *    - It has at least one add-tag NOT covered by a tombstone, AND
 *    - No priority>0 tombstone covers ANY of its add-tags
 *      (priority removes beat all concurrent adds)
 *
 *  Returns: 1 if present, 0 if absent.
 */
int crdt_orset_contains(const struct CrdtORSet *set, const char *key,
                        uint32_t key_len);

/** Add an element. Creates a new unique tag for this add.
 *  Returns the tag assigned (for inclusion in the oplog).
 */
struct CrdtTag crdt_orset_add(struct CrdtORSet *set, const char *key,
                              uint32_t key_len, uint16_t my_numeric);

/** Remove an element. Tombstones all current add-tags.
 *  priority: 0=user-initiated, 2=chanop KICK, 3=services, 4=ircd
 *  Returns number of tags tombstoned.
 */
int crdt_orset_remove(struct CrdtORSet *set, const char *key,
                      uint32_t key_len, uint8_t priority);

/** Merge a remote add operation (idempotent).
 *  If the tag is already present or tombstoned, this is a no-op.
 */
void crdt_orset_merge_add(struct CrdtORSet *set, const char *key,
                          uint32_t key_len, struct CrdtTag tag);

/** Merge a remote remove operation (idempotent).
 *  Adds a tombstone for the given tag with the given priority.
 */
void crdt_orset_merge_remove(struct CrdtORSet *set, struct CrdtTag tag,
                             uint8_t priority);

/** Garbage collect tombstones that are causally stable.
 *  Removes tombstones with tag.seq <= stable_sv[tag.origin].
 *  Also removes orphaned add-tags covered by stable tombstones.
 *  Returns number of tombstones freed.
 */
int crdt_orset_gc(struct CrdtORSet *set, const uint64_t *stable_sv);
```

**Memory per entry**: ~40 bytes (key pointer + 1 tag + hash chain). Tombstone: ~16 bytes (tag + priority + chain pointer).

#### 17.1.3 CrdtLWWMap — Last-Writer-Wins Map

Each key is an independent LWW-Register. Concurrent writes to different keys don't conflict. Concurrent writes to the same key are resolved by HLC timestamp.

```c
/** A single LWW value with timestamp. */
struct CrdtLWWValue {
    void           *data;       /* Value payload (type-specific) */
    uint32_t        data_len;
    struct HLC      timestamp;  /* HLC of the write */
    uint16_t        writer;     /* Server numeric that wrote this */
};

/** Entry in an LWW-Map. */
struct CrdtLWWEntry {
    char               *key;
    uint32_t            key_len;
    struct CrdtLWWValue value;
    struct CrdtLWWEntry *ht_next;  /* Hash chain */
};

/** LWW-Map: each key is independently versioned. */
struct CrdtLWWMap {
    struct CrdtLWWEntry **entries;
    uint32_t              entry_count;
    uint32_t              bucket_count;
};

/** Set a key. If the new HLC > existing HLC, the value is updated.
 *  If the new HLC <= existing HLC, this is a no-op (stale write).
 *  Returns 1 if value was updated, 0 if stale.
 */
int crdt_lwwmap_set(struct CrdtLWWMap *map, const char *key,
                    uint32_t key_len, const void *data,
                    uint32_t data_len, struct HLC timestamp);

/** Get a key's current value. Returns NULL if not set. */
const struct CrdtLWWValue *crdt_lwwmap_get(const struct CrdtLWWMap *map,
                                           const char *key, uint32_t key_len);

/** Merge a remote write (same semantics as set — higher HLC wins). */
int crdt_lwwmap_merge(struct CrdtLWWMap *map, const char *key,
                      uint32_t key_len, const void *data,
                      uint32_t data_len, struct HLC timestamp);

/** Delete a key (sets value to NULL with current HLC).
 *  No tombstone needed — deletion is just an LWW write of NULL.
 *  Future writes with higher HLC can resurrect the key.
 */
int crdt_lwwmap_delete(struct CrdtLWWMap *map, const char *key,
                       uint32_t key_len, struct HLC timestamp);
```

**Key property**: LWW-Map has **no tombstone problem**. Deletes are just writes of NULL. The entry can be fully reclaimed when no server could possibly send a concurrent write with a lower HLC — which is guaranteed once the delete's HLC is causally stable.

#### 17.1.4 CrdtStateVector — Version Tracking

```c
/** State vector: tracks the highest sequence number seen from each server.
 *  Fixed-size array indexed by server numeric (P10 allows up to 4096 servers).
 *  Size: 4096 × 8 = 32 KB.
 */
#define CRDT_MAX_SERVERS  4096  /* NN_MAX_SERVER from numnicks.h */

struct CrdtStateVector {
    uint64_t seq[CRDT_MAX_SERVERS];  /* sv[numeric] = highest seq seen */
};

/** Update state vector when receiving an operation. */
static inline void crdt_sv_update(struct CrdtStateVector *sv,
                                  uint16_t origin, uint64_t seq) {
    if (seq > sv->seq[origin])
        sv->seq[origin] = seq;
}

/** Check if we've already seen this operation. */
static inline int crdt_sv_has_seen(const struct CrdtStateVector *sv,
                                   uint16_t origin, uint64_t seq) {
    return seq <= sv->seq[origin];
}

/** Compute the component-wise minimum of multiple state vectors.
 *  Used for causal stability GC (§17.2).
 */
void crdt_sv_global_min(struct CrdtStateVector *out,
                        const struct CrdtStateVector *vectors,
                        int num_vectors);

/** Sparse wire encoding: only non-zero entries.
 *  Format: <count:2> [<numeric:2><seq:8>] × count
 *  A 5-server network encodes as 2 + 5×10 = 52 bytes.
 */
int crdt_sv_encode(const struct CrdtStateVector *sv,
                   uint8_t *buf, uint32_t buf_len, uint32_t *out_len);

int crdt_sv_decode(struct CrdtStateVector *sv,
                   const uint8_t *buf, uint32_t buf_len);
```

#### 17.1.5 CrdtOpLog — Operation Log for Delta Computation

```c
/** Operation types for the oplog. */
enum CrdtOpType {
    CRDT_OP_ORSET_ADD,      /* OR-Set add: {set_id, key, tag} */
    CRDT_OP_ORSET_REMOVE,   /* OR-Set remove: {set_id, tag, priority} */
    CRDT_OP_LWW_SET,        /* LWW-Map set: {map_id, key, value, hlc} */
    CRDT_OP_LWW_DELETE,     /* LWW-Map delete: {map_id, key, hlc} */
    CRDT_OP_SERVER_STATE,   /* Server state transition: {numeric, state} */
};

/** A single operation in the log.
 *  Operations are the unit of replication — they're sent to peers
 *  and applied to produce convergent state.
 */
struct CrdtOp {
    uint16_t        origin;     /* Server that created this op */
    uint64_t        seq;        /* Sequence number (from CrdtTag) */
    enum CrdtOpType type;
    uint32_t        payload_len;
    uint8_t        *payload;    /* Serialized op-specific data */
    struct CrdtOp  *next;       /* Linked list chain */
};

/** Operation log.
 *  Stores recent operations for delta computation.
 *  Oldest entries pruned by causal stability GC.
 */
struct CrdtOpLog {
    struct CrdtOp  *head;       /* Newest operation */
    struct CrdtOp  *tail;       /* Oldest operation */
    uint32_t        count;
    uint32_t        max_count;  /* Hard limit (configurable) */
    uint64_t        total_bytes; /* Memory tracking */
};

/** Append a local operation to the log. */
void crdt_oplog_append(struct CrdtOpLog *log, struct CrdtOp *op);

/** Compute delta: all ops with seq > remote_sv[origin].
 *  Returns serialized ops as a binary blob.
 */
int crdt_oplog_delta(const struct CrdtOpLog *log,
                     const struct CrdtStateVector *remote_sv,
                     uint8_t **out, uint32_t *out_len);

/** Apply a remote operation (idempotent).
 *  Checks state vector to skip already-seen ops.
 *  Dispatches to appropriate CRDT type (OR-Set or LWW-Map).
 */
int crdt_oplog_apply(struct CrdtOpLog *log, struct CrdtStateVector *sv,
                     const struct CrdtOp *op);

/** Garbage collect: remove ops with seq <= stable_sv[origin].
 *  Returns number of ops freed.
 */
int crdt_oplog_gc(struct CrdtOpLog *log, const struct CrdtStateVector *stable_sv);
```

#### 17.1.6 IRC State Composition

The IRC network state composes these primitives:

```c
/** Top-level CRDT state for the IRC network.
 *  Maps directly to the NetworkDoc structure from §3.2,
 *  but using custom CRDT types instead of Y-CRDT.
 */
struct CrdtNetworkState {
    /* Identity */
    uint16_t             my_numeric;    /* This server's P10 numeric */

    /* Version tracking */
    struct CrdtStateVector  local_sv;   /* What we've seen */
    struct CrdtOpLog        oplog;      /* Recent operations for delta */

    /* Peer state vectors (for causal stability GC) */
    struct CrdtStateVector  peer_sv[CRDT_MAX_SERVERS];
    time_t                  peer_sv_time[CRDT_MAX_SERVERS]; /* Last SV update */

    /* IRC state CRDTs */
    struct CrdtLWWMap    servers;    /* server_numeric → ServerRecord */
    struct CrdtLWWMap    users;      /* user_numeric → UserRecord */
    struct CrdtLWWMap    nicks;      /* nick_lowercase → NickClaim */
    struct CrdtLWWMap    channels;   /* channel_name → ChannelRecord */

    /* Per-channel OR-Sets (indexed by channel name hash) */
    struct CrdtORSet    *members;    /* channel → set of user_numerics */
    struct CrdtORSet    *bans;       /* channel → set of ban_masks */
    struct CrdtORSet    *excepts;    /* channel → set of except_masks */

    /* Per-channel LWW-Maps */
    struct CrdtLWWMap   *chan_modes;  /* channel → mode_char → value */
    struct CrdtLWWMap   *chan_topics; /* channel → {text, setter, time} */

    /* Metadata and sessions */
    struct CrdtLWWMap    metadata;   /* target → key → value */
    struct CrdtLWWMap    sessions;   /* session_id → SessionRecord */
    struct CrdtLWWMap    read_markers; /* user×channel → msgid */
};
```

**Memory estimate** (10,000 users, 5,000 channels):
- State vector: 32 KB (fixed)
- Users LWW-Map: 10,000 × ~200 bytes = ~2 MB
- Channels LWW-Map: 5,000 × ~300 bytes = ~1.5 MB
- Membership OR-Sets: 100,000 entries × ~40 bytes = ~4 MB
- Ban OR-Sets: 50,000 entries × ~60 bytes = ~3 MB
- OpLog (60s window): ~9,000 ops × ~80 bytes = ~720 KB
- Tombstones (60s window): ~9,000 × ~16 bytes = ~144 KB
- **Total: ~11.4 MB** (comparable to current P10 in-memory state, but bounded)

### 17.2 Tombstone Reclamation via Causal Stability

**Resolves**: Audit Gap 1 (🔴 Tombstone growth unsolved)

This is the **key advantage** of the custom CRDT over Y-CRDT. Y-CRDT retains tombstone metadata forever (8-byte item identifiers accumulate unboundedly). Our custom OR-Set can truly free tombstones once they are **causally stable** — meaning all servers have seen both the add and the remove.

#### 17.2.1 The Algorithm

```
CAUSAL STABILITY GARBAGE COLLECTION
====================================

Precondition: Each server periodically broadcasts its state vector
              to all peers via CR V token.

Every FEAT_CRDT_GC_INTERVAL seconds (default: 60):

1. COLLECT peer state vectors
   For each connected server P:
     peer_sv[P] = last received state vector from P
     If time_since_last_sv(P) > FEAT_CRDT_STALE_TIMEOUT:
       Exclude P from computation (prevents offline server
       from blocking GC network-wide)

2. COMPUTE global minimum state vector
   For each server S in the network:
     global_min[S] = min(local_sv[S], peer_sv[1][S], ..., peer_sv[N][S])

   This tells us: "every server in the network has seen at least
   up to sequence global_min[S] from server S."

3. GC tombstones
   For each OR-Set in the network state:
     crdt_orset_gc(set, global_min)
       → Removes all tombstones where tag.seq <= global_min[tag.origin]
       → Also removes add-tags that are covered by stable tombstones
         (the add is stable too, so the element is definitively removed)
       → Returns freed count for monitoring

4. GC oplog
   crdt_oplog_gc(oplog, global_min)
     → Removes all ops where seq <= global_min[origin]
     → These ops can never be needed for delta computation
       (all peers are past this point)

5. LOG metrics
   Report: tombstones_freed, oplog_freed, memory_reclaimed
```

#### 17.2.2 Correctness Argument

An OR-Set tombstone for tag T = `{origin: S, seq: N}` can be safely freed when `global_min[S] >= N` because:

1. **All servers have seen the original add** (since `global_min[S] >= N` means every server has processed at least up to sequence N from server S, and the add has seq ≤ N).
2. **All servers have seen the remove** (the remove was generated after the add, so it has a sequence number from some server — and by the time global_min covers the add, the remove has also been propagated, since operations are delivered in causal order within each server's sequence).
3. **No future merge can resurrect the element** (a merge only resurrects if a server sends an add-tag that the remover didn't know about — but since all servers are past sequence N, no server can produce a "new" add for this element that references the old tag).

Therefore the tombstone can be freed — it will never be needed again.

#### 17.2.3 Stale Server Exclusion

If server X goes offline (netsplit) and stops sending SV updates:

- Without exclusion: `global_min[X]` stays frozen at X's last-known seq, blocking GC for all operations from X. Over hours/days, tombstones accumulate.
- With exclusion: after `FEAT_CRDT_STALE_TIMEOUT` (default: 300 seconds), X is excluded from the global min computation. GC proceeds for all other servers' operations.
- When X reconnects: it receives a delta of everything it missed (delta sync handles this). The delta includes ops that were GC'd from the oplog — but since X's state vector is behind, the linking server must reconstruct the delta from current state (full snapshot fallback via `CR F`).

**Trade-off**: Excluding stale servers means they lose the ability to do incremental delta sync and must do a full snapshot sync on reconnect. This is the same cost as a fresh server link (~200 KB), which is acceptable.

#### 17.2.4 Steady-State Memory Projection

| Metric | Y-CRDT (§16.3 Gap 1) | Custom CRDT |
|--------|---------------------|-------------|
| Tombstone accumulation rate | ~150/sec (unbounded) | ~150/sec (GC'd every 60s) |
| After 1 hour | ~540K tombstones (~4.3 MB) | ~9K tombstones (~144 KB) |
| After 24 hours | ~13M tombstones (~104 MB) | ~9K tombstones (~144 KB) |
| After 30 days | ~389M tombstones (~3.1 GB) | ~9K tombstones (~144 KB) |
| Steady state | **Unbounded growth** | **~144 KB (bounded)** |

The custom CRDT's memory usage is **bounded by GC interval × operation rate**, not by total lifetime operations. This is the fundamental architectural advantage.

#### 17.2.5 Feature Flags

```
FEAT_CRDT_GC_INTERVAL    = 60    # Seconds between GC runs
FEAT_CRDT_STALE_TIMEOUT  = 300   # Seconds before excluding a server from GC
FEAT_CRDT_OPLOG_MAX      = 100000 # Hard cap on oplog entries (safety limit)
```

### 17.3 SQUIT as Server-State Transition

**Resolves**: Audit Gap 5 (🔴 SQUIT handling missing)

#### 17.3.1 The Problem

In P10, when a server delinks (SQUIT), the cascade removes all its users:

```
exit_downlinks() [s_misc.c:485]:
  For each downlink server (deepest first):
    For each user on that server:
      remove_user_from_all_channels(user)
      exit_one_client(user)
```

If we model this as CRDT operations, a server with 2,500 users across an average of 5 channels each generates:
- 2,500 `crdt_user_remove()` operations
- 12,500 `crdt_orset_remove()` operations (membership tombstones)
- **15,000 tombstones** created in one burst

If the server reconnects 30 seconds later, we add 15,000 more operations to restore everything. The tombstones from the first batch are now useless overhead waiting for GC.

#### 17.3.2 The Solution: Server State Transitions

Instead of modeling SQUIT as individual user removals, model it as a **single server-level state change**:

```c
/** Server state in the CRDT. */
enum CrdtServerState {
    CRDT_SRV_ACTIVE = 0,   /* Server is linked, users visible */
    CRDT_SRV_SPLIT  = 1,   /* Server has delinked, users hidden */
};

/** SQUIT handler — CRDT layer. */
void crdt_server_squit(struct CrdtNetworkState *state,
                       uint16_t server_numeric, struct HLC timestamp) {
    /* Single LWW-Map write: server → SPLIT */
    uint8_t split_state = CRDT_SRV_SPLIT;
    crdt_lwwmap_set(&state->servers,
                    numeric_key, numeric_key_len,
                    &split_state, 1, timestamp);
    /* That's it. One operation. Zero tombstones. */
}

/** Server relink — CRDT layer. */
void crdt_server_relink(struct CrdtNetworkState *state,
                        uint16_t server_numeric, struct HLC timestamp) {
    /* Single LWW-Map write: server → ACTIVE */
    uint8_t active_state = CRDT_SRV_ACTIVE;
    crdt_lwwmap_set(&state->servers,
                    numeric_key, numeric_key_len,
                    &active_state, 1, timestamp);
    /* Users reappear instantly — no re-BURST needed. */
}
```

#### 17.3.3 Query-Time Filtering

Users belonging to a `SPLIT` server are hidden at query time, not removed from the CRDT:

```c
/** Check if a user is visible (not on a split server). */
static inline int crdt_user_visible(const struct CrdtNetworkState *state,
                                    const char *user_numeric) {
    /* Look up user's server */
    const struct CrdtLWWValue *user = crdt_lwwmap_get(&state->users,
                                                       user_numeric, ...);
    if (!user) return 0;

    /* Look up server state */
    uint16_t srv = extract_server_numeric(user->data);
    const struct CrdtLWWValue *srv_state = crdt_lwwmap_get(&state->servers,
                                                            srv_key, ...);
    if (!srv_state) return 0;

    return (*(uint8_t*)srv_state->data) == CRDT_SRV_ACTIVE;
}

/** Iterate visible members of a channel. */
void crdt_channel_foreach_member(const struct CrdtNetworkState *state,
                                 const char *channel,
                                 void (*callback)(const char *numeric, void *ctx),
                                 void *ctx) {
    struct CrdtORSet *members = get_channel_members(state, channel);
    /* ... iterate, skipping entries where crdt_user_visible() == 0 ... */
}
```

#### 17.3.4 Client-Facing Behavior

The CRDT state change is invisible to clients. The local server still:
1. Sends `QUIT :*.server.net *.other.net` messages to local clients for each user on the split server
2. Removes Client/Membership structs from local memory (the P10 exit_downlinks cascade)
3. Sends SQUIT to other P10 peers as normal

The CRDT tracks the split state for cross-server consistency. When the server relinks:
- **P10 path**: Full BURST is exchanged (current behavior)
- **CRDT path**: Server state transitions to ACTIVE, delta sync brings the relinking server up to date. No BURST needed — the CRDT already has the user/channel/membership state from before the split.

#### 17.3.5 Edge Cases

**Recursive SQUIT** (hub delinks, taking leaves with it):
- Each server in the subtree gets its own `CRDT_SRV_SPLIT` transition
- When the hub relinks, all servers in the subtree transition back to `ACTIVE`

**User QUIT during split**: If a user on the split side actually quits (not just hidden by the split), the split server records a `crdt_user_remove()` in its oplog. When it relinks and syncs, that remove propagates. The SQUIT state transition doesn't prevent real quits from being tracked.

**Quick reconnect**: If a server splits and relinks within seconds, the CRDT never even needed to process the split on some servers. The LWW timestamp ensures the `ACTIVE` write (with higher HLC) wins over any in-flight `SPLIT` write.

### 17.4 Priority OR-Set for KICK

**Resolves**: Audit Gap 4 (🟡 ADD-WINS for KICK is wrong)

#### 17.4.1 The Semantic Problem

Standard OR-Set: concurrent `JOIN` + `KICK` → user stays (add-wins).

This is wrong for IRC. When an oper kicks someone, it should be authoritative:
- The user was kicked for a reason (spam, abuse, ban evasion)
- If the kick is ineffective across a split, the oper must notice and re-kick
- During the window between merge and re-kick, the kicked user is active in the channel

#### 17.4.2 Priority-Based Merge Rule

The Priority OR-Set extends the standard OR-Set with a priority level on remove operations:

```
PRIORITY OR-SET MERGE RULE
===========================

An element E is considered PRESENT in the set if:
  1. E has at least one add-tag T such that:
     a. T is NOT covered by any tombstone (standard OR-Set rule), AND
     b. No tombstone with priority > 0 exists for ANY of E's add-tags
        (priority removes beat ALL concurrent adds for this element)

The key insight: a priority-0 remove only beats the specific add-tag
it targets (standard OR-Set). A priority>0 remove beats ALL concurrent
adds for that element, even ones from different servers that the
remover didn't know about.
```

#### 17.4.3 Priority Levels

```c
#define CRDT_PRIORITY_USER      0   /* PART — user-initiated leave */
#define CRDT_PRIORITY_CHANOP    2   /* KICK by channel operator */
#define CRDT_PRIORITY_SERVICES  3   /* KICK by ChanServ/X3 */
#define CRDT_PRIORITY_IRCD      4   /* Server-level forced removal */
```

**Scenarios**:

| Side A | Side B | Standard OR-Set | Priority OR-Set |
|--------|--------|----------------|-----------------|
| JOIN | PART (p=0) | User stays | User stays (add-wins for user PART) |
| JOIN | KICK (p=2) | User stays | **User gone** (KICK beats JOIN) |
| JOIN | ChanServ KICK (p=3) | User stays | **User gone** (services override) |
| KICK (p=2) | KICK (p=2) | N/A | User gone (both sides agree) |
| PART (p=0) | PART (p=0) | N/A | User gone (both sides agree) |

This preserves the safety property that oper actions are authoritative across netsplits, while keeping the less disruptive add-wins behavior for voluntary parts.

#### 17.4.4 Interaction with Bans

Ban list adds use the same Priority OR-Set:
- `+b` by chanop (p=2): concurrent `+b` and `-b` → ban stays
- `-b` by chanop (p=2): concurrent `+b` and `-b` → depends on who was later (both p=2, so standard OR-Set add-wins applies within same priority)

For bans, standard add-wins is actually correct — when in doubt, keep the ban (safer default). No priority override needed.

#### 17.4.5 Interaction with make_zombie()

The current `make_zombie()` intermediate state (channel.c:2219) is a P10-specific mechanism for handling remote KICKs where the user's home server hasn't confirmed yet. In the CRDT model:

- `make_zombie()` is **not needed in the CRDT layer** — the Priority OR-Set handles the semantics
- The local server still uses zombie state for its own Client/Membership structs (P10 compatibility)
- The CRDT remove with p=2 (KICK) is definitive — no intermediate state needed

### 17.5 Nick Collision State Machine

**Resolves**: Audit Gap 3 (🟡 Nick collision not CRDT-native)

#### 17.5.1 CRDT Representation

Nick claims are stored in the `nicks` LWW-Map:

```c
/** A nick claim in the CRDT. */
struct CrdtNickClaim {
    char        numeric[6];     /* P10 numeric of claiming user (5 chars + null) */
    struct HLC  claimed_at;     /* When the nick was claimed */
    char        ident[USERLEN+1]; /* Username/ident of claimer */
    uint32_t    ip;             /* IP address of claimer (for collision logic) */
    char        account[ACCOUNTLEN+1]; /* Account name (for account-aware resolution) */
};
```

When a nick change occurs, the server writes a `CrdtNickClaim` to the `nicks` LWW-Map keyed by the lowercased nick.

Under normal operation (no partition), there's only one claim per nick — the LWW-Map simply tracks the current owner. **Conflicts only arise during merge after a netsplit**, when two servers independently wrote different claims for the same nick.

#### 17.5.2 Conflict Detection

The CRDT observer fires when merging state from a reconnecting server. For the `nicks` LWW-Map, a conflict is detected when:

1. A remote merge writes a different `numeric` for a nick key, **AND**
2. The HLC comparison doesn't clearly resolve it (or we want to apply IRC-specific logic rather than pure LWW)

Since we use LWW-Map (not OR-Set) for nicks, the HLC comparison already picks a winner. But IRC's collision logic is more nuanced than pure "latest wins." We handle this at the **application layer**, running the state machine below when the observer detects a nick key merge.

#### 17.5.3 The State Machine

Faithfully reproduces `ms_nick()` logic from [m_nick.c:469-521](nefarious/ircd/m_nick.c#L469-L521):

```c
/** Resolve a nick collision after CRDT merge.
 *
 *  Called by the CRDT observer when a nick key has been merged
 *  with a different numeric than the local state.
 *
 *  @param nick       The contested nick (lowercased)
 *  @param local      Local claim (our side of the split)
 *  @param remote     Remote claim (merged from peer)
 *  @return           Pointer to the WINNING claim
 */
const struct CrdtNickClaim *
crdt_resolve_nick_collision(const char *nick,
                            const struct CrdtNickClaim *local,
                            const struct CrdtNickClaim *remote)
{
    int differ;

    /* Step 1: Are these different users or the same user reconnecting? */
    differ = (local->ip != remote->ip) ||
             (strcmp(local->ident, remote->ident) != 0);

    /* Step 2: Account-aware override (enhancement over P10).
     * If one claimer's account matches the nick's registered owner,
     * they win regardless of timestamp.
     * Note: requires checking X3/AuthServ nick registration data.
     */
    if (nick_is_registered(nick)) {
        const char *owner = nick_get_owner_account(nick);
        if (owner) {
            if (strcmp(local->account, owner) == 0 &&
                strcmp(remote->account, owner) != 0)
                return local;
            if (strcmp(remote->account, owner) == 0 &&
                strcmp(local->account, owner) != 0)
                return remote;
        }
    }

    /* Step 3: Timestamp-based resolution (matching P10's ms_nick logic). */
    if (differ) {
        /* Different user@host: OLDER timestamp wins.
         * Keep the established user; force-rename the newcomer. */
        if (hlc_compare(local->claimed_at, remote->claimed_at) < 0)
            return local;   /* Local is older → local wins */
        if (hlc_compare(local->claimed_at, remote->claimed_at) > 0)
            return remote;  /* Remote is older → remote wins */
    } else {
        /* Same user@host: NEWER timestamp wins.
         * This is a reconnecting user; keep the fresh connection. */
        if (hlc_compare(local->claimed_at, remote->claimed_at) > 0)
            return local;   /* Local is newer → local wins */
        if (hlc_compare(local->claimed_at, remote->claimed_at) < 0)
            return remote;  /* Remote is newer → remote wins */
    }

    /* Step 4: Equal timestamps — tiebreak by server numeric. */
    return (local->claimed_at.node_id < remote->claimed_at.node_id)
           ? local : remote;
}
```

#### 17.5.4 Force-Rename Protocol

When the state machine picks a winner, the **loser** gets a forced rename:

```c
/** Handle the losing side of a nick collision.
 *  Instead of KILL (P10 behavior), force-rename to the user's UID.
 */
void crdt_nick_collision_loser(struct CrdtNetworkState *state,
                               const struct CrdtNickClaim *loser,
                               struct HLC now) {
    /* Generate a UID-based nick: numeric as display nick.
     * e.g., user with numeric "ABAAB" gets nick "ABAAB".
     * This is guaranteed unique (numerics are unique). */
    char uid_nick[6];
    memcpy(uid_nick, loser->numeric, 5);
    uid_nick[5] = '\0';

    /* Update the nicks map: release the contested nick */
    /* The winner's claim is already in the LWW-Map from the merge */

    /* Update the users map: change the loser's nick field */
    crdt_lwwmap_set(&state->users, loser->numeric, 5,
                    uid_nick, strlen(uid_nick), now);

    /* Write the new nick claim for the UID nick */
    struct CrdtNickClaim uid_claim = *loser;
    uid_claim.claimed_at = now;
    crdt_lwwmap_set(&state->nicks, uid_nick, strlen(uid_nick),
                    &uid_claim, sizeof(uid_claim), now);

    /* Emit IRC event: NICK change for the loser.
     * Local clients see: :oldnick NICK ABAAB
     * Connection and channel memberships preserved. */
}
```

**Key improvement over P10**: The loser keeps their connection and all channel memberships. They just get a temporary ugly nick (their numeric). They can `/NICK` to something else immediately.

### 17.6 Custom Sync Protocol

#### 17.6.1 Wire Format — CR Token

New P10 token `CR` with subtokens for CRDT synchronization:

```
TOKEN: CR (CRDT)
SOURCE: Server numeric
FORMAT: <server_numeric> CR <subtoken> [params] :<payload>

Subtokens:
  S — State Vector (request delta)
  D — Delta (oplog entries)
  F — Full snapshot (fallback for fresh/stale link)
  U — Update batch (incremental, 10-50ms window)
  V — Version broadcast (for causal stability GC)
```

#### 17.6.2 Server Link Protocol (Replaces BURST)

```
SERVER LINK — CRDT Sync
========================

Phase 1: Capability negotiation (during PASS/SERVER handshake)
  A → B: SERVER ... <flags including CRDT>
  B → A: SERVER ... <flags including CRDT>
  If both have CRDT flag: use CRDT sync
  If either lacks CRDT: fall back to P10 BURST

Phase 2: State vector exchange
  A → B: AB CR S :<sparse_encoded_sv_A>
  B → A: BC CR S :<sparse_encoded_sv_B>

Phase 3: Delta exchange
  B computes: delta_for_A = oplog.delta(sv_A)
  A computes: delta_for_B = oplog.delta(sv_B)

  If delta available (ops still in oplog):
    B → A: BC CR D :<zstd(serialized_delta)>
    A → B: AB CR D :<zstd(serialized_delta)>
  If delta unavailable (oplog truncated, need full state):
    B → A: BC CR F :<zstd(full_snapshot)>
    A → B: AB CR F :<zstd(full_snapshot)>

Phase 4: Incremental sync (ongoing)
  On state change at A:
    (buffer for FEAT_CRDT_BATCH_MS, default 10ms)
    A → B: AB CR U :<zstd(batched_ops)>
  On state change at B:
    B → A: BC CR U :<zstd(batched_ops)>

Periodic: GC state vector broadcast
  Every FEAT_CRDT_GC_INTERVAL seconds:
    A → B: AB CR V :<sparse_encoded_sv_A>
    B → A: BC CR V :<sparse_encoded_sv_B>
```

#### 17.6.3 Operation Serialization

Each operation is serialized as a compact binary record:

```
OPERATION WIRE FORMAT
=====================

Header (fixed 12 bytes):
  [origin:2][seq:8][type:1][payload_len:2]

OR-Set Add payload:
  [set_id:2][key_len:2][key:var]

OR-Set Remove payload:
  [set_id:2][tag_origin:2][tag_seq:8][priority:1]

LWW-Map Set payload:
  [map_id:2][key_len:2][key:var][value_len:2][value:var]
  [hlc_physical:8][hlc_logical:2][hlc_node:2]

Server State payload:
  [server_numeric:2][state:1]
```

**Batch encoding**: Multiple operations concatenated with length prefixes. Compressed with zstd before base64 encoding for P10 wire.

#### 17.6.4 Full Snapshot Format

For fresh server links or when the oplog has been truncated:

```
FULL SNAPSHOT
=============

Encodes the complete CrdtNetworkState as:
1. State vector (sparse encoded)
2. All servers LWW-Map entries
3. All users LWW-Map entries
4. All nicks LWW-Map entries
5. All channels (LWW-Map + OR-Set members + OR-Set bans)
6. Metadata, sessions, read markers

Format: same as operation serialization, but with
CRDT_OP_SNAPSHOT_* types that represent current state
rather than incremental changes.
```

This is conceptually similar to P10 BURST but more compact due to:
- Binary encoding (not text P10 tokens)
- zstd compression
- No redundant information (P10 sends server name strings, user hosts, etc. per-token; snapshot shares string tables)

#### 17.6.5 Bandwidth Comparison (Updated)

| Scenario | P10 BURST | CRDT Delta | CRDT Full Snapshot |
|----------|-----------|------------|-------------------|
| Fresh link (empty server) | ~2.5 MB | N/A | ~150 KB (compressed) |
| Netsplit recovery (5 min, 200 changes) | ~2.5 MB | ~15 KB | ~150 KB |
| Netsplit recovery (1 hour, 5000 changes) | ~2.5 MB | ~300 KB | ~150 KB |
| Incremental (single op) | ~100 bytes | ~40 bytes | N/A |
| GC state vector broadcast | N/A | ~52 bytes | N/A |

### 17.7 Hybrid Bridge Design

**Resolves**: Audit Gap 7 (🟡 P10 ↔ CRDT bridge underspecified)

#### 17.7.1 Topology Constraint

During the migration period when both CRDT-aware and P10-only servers coexist:

```
HYBRID TOPOLOGY
================

CRDT mesh:              P10 tree:
  A ─── B                  E
  │╲   ╱│                  │
  │  ╲╱  │    gateway       F
  │  ╱╲  │   G ◄──► C      │
  │╱   ╲│                  H
  C ─── D

Rules:
  1. CRDT-aware servers {A, B, C, D} form a mesh (any topology)
  2. P10-only servers {E, F, H} remain in their tree
  3. ONE gateway server (G) bridges the two worlds
  4. G speaks CRDT to C (or any CRDT server) and P10 to E
  5. G is the ONLY server that translates between protocols
```

**Why single gateway?** The dual-merge problem (§16.3 Gap 7): if server A speaks CRDT to B and P10 to C, a netsplit can produce incompatible merge results (CRDT uses HLC/add-wins, P10 uses TS/all-or-nothing). A single gateway serializes the translation, preventing conflicts.

#### 17.7.2 CRDT → P10 Translation

The gateway's CRDT observer generates P10 tokens for P10-only peers:

```c
/** CRDT observer callback on the gateway server.
 *  Translates CRDT state changes into P10 tokens.
 */
void gateway_crdt_observer(int type, const char *key,
                           const void *old_val, const void *new_val,
                           void *ctx) {
    struct Client *p10_peer = (struct Client *)ctx;

    switch (type) {
    case CRDT_OP_USER_ADD:
        /* Generate P10 N (NICK) token */
        sendcmdto_one(&me, CMD_NICK, p10_peer,
                      "%s %d %Tu %s %s ... :%s",
                      nick, hopcount, timestamp, ident, host, info);
        break;

    case CRDT_OP_USER_REMOVE:
        /* Generate P10 Q (QUIT) token */
        sendcmdto_one(user_client, CMD_QUIT, p10_peer,
                      ":%s", quit_message);
        break;

    case CRDT_OP_CHANNEL_JOIN:
        /* If channel is new: generate B (BURST) token
         * If channel exists: generate J (JOIN) token */
        break;

    case CRDT_OP_CHANNEL_PART:
        sendcmdto_one(user_client, CMD_PART, p10_peer,
                      "%H :%s", channel, part_message);
        break;

    case CRDT_OP_MODE_CHANGE:
        /* Generate M (MODE) token */
        break;

    case CRDT_OP_TOPIC_CHANGE:
        /* Generate T (TOPIC) token */
        break;

    case CRDT_OP_SERVER_SPLIT:
        /* Generate SQ (SQUIT) token for the departing server,
         * followed by Q (QUIT) for each user on that server */
        break;

    case CRDT_OP_SERVER_RELINK:
        /* Generate S (SERVER) + full BURST for the relinking server */
        break;
    }
}
```

#### 17.7.3 P10 → CRDT Translation

This direction is the bridge pattern already designed in §7.3. The gateway's existing P10 handlers (ms_nick, ms_burst, ms_kick, etc.) mirror mutations into the CRDT:

```c
/* Already specified in §7.3 — included here for completeness */
if (feature_bool(FEAT_CRDT_ENABLED)) {
    struct HLC ts = hlc_from_unix(timestamp);
    crdt_user_add(numeric, nick, ts);
}
```

#### 17.7.4 Capability Negotiation

During server link handshake, servers advertise CRDT support:

```
CAPABILITY NEGOTIATION
======================

In the SERVER token flags field, a new flag bit:
  SFLAG_CRDT = 0x80000  /* Server supports CRDT sync */

Server link handshake:
  A → B: PASS :<password>
  A → B: SERVER <name> 1 <boot> <link_ts> J10 <numeric> <flags|SFLAG_CRDT> :<info>
  B → A: SERVER <name> 1 <boot> <link_ts> J10 <numeric> <flags|SFLAG_CRDT> :<info>

If both have SFLAG_CRDT:
  → Use CR tokens for sync (§17.6.2)
  → Skip P10 BURST entirely
  → Incremental updates via CR U

If only one has SFLAG_CRDT:
  → Fall back to P10 BURST (standard behavior)
  → If gateway: mirror BURST into CRDT state

If neither has SFLAG_CRDT:
  → Pure P10 (no CRDT involvement)
```

#### 17.7.5 Authoritative Mode

When `FEAT_CRDT_PRIMARY` is enabled on the gateway:

- CRDT state is the source of truth
- P10 BURST from legacy servers is compared against CRDT state
- Conflicts are resolved by CRDT rules (HLC, priority OR-Set), not P10 TS rules
- The gateway re-emits corrected P10 tokens if the CRDT merge produces a different result than P10 would

When `FEAT_CRDT_PRIMARY` is disabled (shadow mode):

- P10 is the source of truth
- CRDT runs alongside, mirroring P10 state
- Divergences are logged but not acted upon
- Used for validation during Phase 1

### 17.8 Implementation Sequence

#### 17.8.1 Source Files

| File | Contents | Est. Lines |
|------|----------|-----------|
| `include/crdt_hlc.h` | HLC struct, compare, local_event, receive, encode/decode | ~80 |
| `include/crdt_types.h` | CrdtTag, CrdtORSet, CrdtLWWMap, CrdtStateVector, CrdtOpLog structs | ~200 |
| `include/crdt_state.h` | CrdtNetworkState, high-level IRC state API | ~120 |
| `include/crdt_sync.h` | Sync protocol API (delta, SV exchange, CR handlers) | ~60 |
| `ircd/crdt_hlc.c` | HLC implementation (already 90% designed in Appendix A) | ~60 |
| `ircd/crdt_types.c` | CRDT primitive implementations (OR-Set, LWW-Map, SV, OpLog, GC) | ~650 |
| `ircd/crdt_state.c` | IRC state management, nick collision state machine, SQUIT transitions | ~450 |
| `ircd/crdt_sync.c` | Sync protocol, serialization, compression, CR token handling | ~350 |
| `ircd/m_crdt.c` | P10 message handlers for CR S/D/F/U/V subtokens | ~200 |
| **Total** | | **~2,170** |

Pure C, no external dependencies beyond what Nefarious already uses (zstd for compression).

#### 17.8.2 Phase 0 PoC — Standalone Test Program

**Deliverable**: A standalone C program (not linked into Nefarious) that:

1. Simulates 3-4 "servers" as in-process `CrdtNetworkState` instances
2. Runs the five test scenarios from §16.6:
   - **A**: Basic convergence after partition
   - **B**: Nick collision resolution
   - **C**: Concurrent KICK+JOIN with priority OR-Set
   - **D**: 24-hour tombstone growth stress test
   - **E**: SQUIT storm (2,500 users, measure tombstone count)
3. Reports: convergence correctness, memory usage over time, delta sizes

**Files needed for PoC**: `crdt_hlc.h/c`, `crdt_types.h/c`, `crdt_state.h/c` + a test harness (~200 lines).

**What's NOT in Phase 0**: Wire protocol (CR tokens), P10 bridge, Nefarious integration, Docker build changes.

#### 17.8.3 Build Integration (Phase 1+)

When moving from PoC to Nefarious integration:

```makefile
# In ircd/Makefile.in — add to IRCD_SRC:
IRCD_SRC = ... crdt_hlc.c crdt_types.c crdt_state.c crdt_sync.c m_crdt.c

# No new libraries. No Rust. No cargo.
# Just more .c files in the existing build.
```

```m4
# In configure.in — new feature flags:
AC_DEFINE([FEAT_CRDT_ENABLED], [0], [Enable CRDT state tracking])
AC_DEFINE([FEAT_CRDT_SYNC], [0], [Use CRDT delta sync on link])
AC_DEFINE([FEAT_CRDT_MESH], [0], [Allow mesh topology])
AC_DEFINE([FEAT_CRDT_PRIMARY], [0], [CRDT is authoritative])
AC_DEFINE([FEAT_CRDT_GC_INTERVAL], [60], [Tombstone GC interval seconds])
AC_DEFINE([FEAT_CRDT_BATCH_MS], [10], [Update batching window ms])
AC_DEFINE([FEAT_CRDT_STALE_TIMEOUT], [300], [Stale server exclusion seconds])
```

No Docker build changes needed. No new dependencies. The CRDT code compiles as part of the existing `make` target, gated behind `#ifdef USE_CRDT` / feature flags.

#### 17.8.4 Revised Migration Path

```
✅ DONE: S2S msgid preservation (federation-dedup-s2s-msgid.md)
✅ DONE: Compact S2S tags (wild-frolicking-mango.md) — needs build verification
    ↓
NEXT (parallel):
  ├─ HLC msgid evolution (compact v0→v1)
  └─ Phase 0 PoC — custom C CRDT standalone test program
    ↓
Phase 1: Shadow CRDT state (dual-write P10 + CRDT, compare for divergence)
    ↓
Phase 2: CRDT delta sync for netsplit recovery (CR S/D/F tokens)
    ↓
Phase 3: CRDT as primary S2S (CR U incremental, CR V GC broadcasts)
    ↓
Phase 4: Mesh topology (multiple links, idempotent delivery)
    ↓
Phase 5: X3 as CRDT peer (services merge endgame)
```

Y-CRDT (yffi) is no longer on the critical path. If the custom CRDT PoC validates successfully, the Rust dependency is eliminated entirely. Y-CRDT remains available as a reference implementation for comparing correctness.
