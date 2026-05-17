# Redis Integration Investigation Plan

## Executive Summary

This document provides a comprehensive investigation into using Redis as a shared state layer for **multi-X3 environments**. The primary motivation is enabling active/passive (and potentially active/active) X3 deployments for high availability and horizontal scaling.

**Primary Goal**: Enable multiple X3 instances to share state via Redis, allowing:
- **Active/Passive**: Standby X3 can take over if primary fails
- **Active/Active** (stretch goal): Multiple X3 instances handle requests simultaneously

**Secondary Benefits**:
- Native TTL support (cleaner than LMDB TTL management)
- Pub/Sub for real-time cache invalidation
- Better debugging tools (`redis-cli` vs binary LMDB)
- Potential SAXDB elimination (longer term)

**Key Questions to Answer**:
1. What state must be shared for active/passive failover?
2. What additional state sharing is needed for active/active?
3. How do we handle split-brain scenarios?
4. What's the consistency model for shared state?
5. How does Redis unavailability affect X3 operation?

---

## 1. Multi-X3 Architecture Requirements

### 1.1 Active/Passive Requirements

In active/passive, only ONE X3 handles traffic at a time. The passive instance needs:

| Requirement | Purpose |
|-------------|---------|
| **Shared persistent state** | Passive can resume where active left off |
| **Health monitoring** | Detect when active fails |
| **Takeover mechanism** | Passive becomes active |
| **State consistency** | No lost registrations, channel changes, etc. |

**State that MUST be shared for active/passive:**

| State | Why Critical | Current Storage |
|-------|--------------|-----------------|
| Account registrations | Users must exist after failover | SAXDB |
| Channel registrations | Channels must persist | SAXDB |
| Channel access levels | Ops/voices must be preserved | SAXDB + LMDB cache |
| Glines/shuns | Network bans must persist | SAXDB |
| Pending memos | Undelivered memos must survive | SAXDB |
| Keycloak cache | Avoid re-auth storm on failover | LMDB |

**State that does NOT need sharing:**

| State | Why Not Critical |
|-------|------------------|
| Connected users | IRCd tracks this; X3 rebuilds on BURST |
| In-memory nick→account mapping | Rebuilt from BURST |
| Pending auth timeouts | Can restart |

### 1.2 Active/Active Requirements (More Complex)

In active/active, MULTIPLE X3 instances handle traffic simultaneously. Additional needs:

| Requirement | Challenge |
|-------------|-----------|
| **Write coordination** | Two X3s registering same account simultaneously |
| **Cache invalidation** | X3-A modifies channel; X3-B must know |
| **Command routing** | Which X3 handles a given command? |
| **Conflict resolution** | What if both modify same data? |

**Additional state concerns for active/active:**

| Scenario | Problem | Solution Approach |
|----------|---------|-------------------|
| Simultaneous account register | Race condition | Redis SETNX (atomic create) |
| Simultaneous channel register | Race condition | Redis SETNX |
| Access level change while user online | Stale cache on other X3 | Pub/Sub invalidation |
| Memo sent while recipient on other X3 | Delivery routing | Check online status in Redis |
| Gline added | Must propagate immediately | Pub/Sub broadcast |

### 1.3 IRC Network Topology Considerations

```
             ┌───────────────────────────────────────┐
             │           IRC Network                 │
             │  ┌─────────┐         ┌─────────┐     │
             │  │ Hub 1   │◄───────►│ Hub 2   │     │
             │  │(nefar1) │         │(nefar3) │     │
             │  └────┬────┘         └────┬────┘     │
             │       │                   │          │
             │  ┌────┴────┐         ┌────┴────┐     │
             │  │ Leaf 1  │         │ Leaf 2  │     │
             │  │(nefar2) │         │(nefar4) │     │
             │  └─────────┘         └─────────┘     │
             └───────────────────────────────────────┘
                      │                   │
                      ▼                   ▼
               ┌───────────┐       ┌───────────┐
               │   X3-A    │       │   X3-B    │
               │ (Primary) │       │(Secondary)│
               └─────┬─────┘       └─────┬─────┘
                     │                   │
                     └─────────┬─────────┘
                               ▼
                        ┌───────────┐
                        │   Redis   │
                        └───────────┘
```

**P10 Link Considerations**:
- Each X3 links to ONE IRCd (its hub)
- In active/passive: only active X3 is linked
- In active/active: both X3s link to different hubs
- P10 BURST provides full network state on link

### 1.4 Failover Scenarios

#### Active/Passive Failover

```
Time T0: X3-A (active) linked to Hub1
         X3-B (passive) watching, not linked

Time T1: X3-A crashes or loses connection

Time T2: Health check detects X3-A down

Time T3: X3-B links to Hub1 (or Hub2)
         X3-B receives BURST, rebuilds online state
         X3-B reads persistent state from Redis

Time T4: X3-B is now active, serving requests
```

**Critical**: Between T1 and T4, any writes X3-A made must be in Redis.

#### Active/Active Netsplit Recovery

```
Time T0: X3-A and X3-B both active
         Hub1 and Hub2 connected

Time T1: Netsplit - Hub1 and Hub2 disconnect
         X3-A serves Hub1 users
         X3-B serves Hub2 users

Time T2: Both X3s continue writing to Redis
         Potential conflicts if same entity modified

Time T3: Network rejoins
         BURST reconciles user state
         Channel access may have diverged

Time T4: Conflict resolution needed
```

---

## 2. Why Redis for Multi-X3?

### 2.1 Current Pain Points (from metadata-leverage-plan.md)

| Pain Point | Current Solution | Redis Advantage |
|------------|------------------|-----------------|
| SAXDB periodic writes | Dual-write to LMDB | Redis AOF provides immediate durability |
| TTL management | Custom TTL format in LMDB | Native `EXPIRE` command |
| Sync-back to SAXDB | Periodic background job | Not needed - Redis IS durable |
| Multi-X3 state sync | Not supported | Pub/Sub + replication |
| Debugging storage | Binary LMDB files | `redis-cli` introspection |
| Keycloak cache invalidation | TTL-based | Pub/Sub for real-time invalidation |

### 2.2 Redis Feature Alignment

| IRC Data Pattern | Redis Feature | Fit |
|------------------|---------------|-----|
| Account metadata (key-value) | HSET (hashes) | Excellent |
| Channel access levels | ZADD (sorted sets) | Excellent |
| Fingerprint lookups | HSET with expiry | Excellent |
| Memos (message queue) | XADD (streams) | Excellent |
| Activity tracking | HSET with expiry | Excellent |
| Auth failure counting | INCR with expiry | Excellent |
| Keycloak cache | STRING with expiry | Good |
| Real-time sync | PUBLISH/SUBSCRIBE | Excellent |

---

## 3. Architecture Options

### 3.1 Option A: Active/Passive with Shared Redis

```
┌─────────────────────────────────────────────────────────────┐
│                        IRC Network                          │
│     ┌─────────┐                           ┌─────────┐      │
│     │  Hub 1  │◄─────────────────────────►│  Hub 2  │      │
│     └────┬────┘                           └─────────┘      │
│          │                                                  │
│          │ P10 Link (active only)                          │
└──────────┼──────────────────────────────────────────────────┘
           │
           ▼
    ┌───────────┐         ┌───────────┐
    │   X3-A    │         │   X3-B    │
    │ (Active)  │         │ (Passive) │
    └─────┬─────┘         └─────┬─────┘
          │                     │ (read-only monitoring)
          └──────────┬──────────┘
                     ▼
              ┌───────────┐
              │   Redis   │◄──── Sentinel for Redis HA
              │ (Primary) │
              └─────┬─────┘
                    │
              ┌─────┴─────┐
              │  Replica  │
              └───────────┘
```

**Characteristics**:
- Only X3-A is linked to IRC network
- X3-B monitors Redis + X3-A health
- On X3-A failure, X3-B links to network
- Redis provides shared persistent state

**Failover trigger options**:
1. X3-B detects X3-A not updating Redis heartbeat
2. Redis Sentinel notifies X3-B (via Pub/Sub)
3. External orchestrator (Kubernetes, systemd)

**Pros**: Simpler consistency model (only one writer), proven HA pattern
**Cons**: Failover delay, passive instance idle

### 3.2 Option B: Active/Active with Redis Coordination

```
┌─────────────────────────────────────────────────────────────┐
│                        IRC Network                          │
│     ┌─────────┐                           ┌─────────┐      │
│     │  Hub 1  │◄─────────────────────────►│  Hub 2  │      │
│     └────┬────┘                           └────┬────┘      │
│          │                                     │            │
│          │ P10 Link                            │ P10 Link   │
└──────────┼─────────────────────────────────────┼────────────┘
           │                                     │
           ▼                                     ▼
    ┌───────────┐                         ┌───────────┐
    │   X3-A    │◄───── Pub/Sub ─────────►│   X3-B    │
    │ (Active)  │                         │ (Active)  │
    └─────┬─────┘                         └─────┬─────┘
          │                                     │
          └──────────────┬──────────────────────┘
                         ▼
                  ┌───────────┐
                  │   Redis   │ ◄─── Cluster or Sentinel
                  │  Cluster  │
                  └───────────┘
```

**Characteristics**:
- Both X3 instances handle traffic simultaneously
- Each links to different hub (geographic distribution)
- Redis Pub/Sub for real-time state synchronization
- Atomic operations for conflict prevention

**Write coordination strategies**:

| Operation | Strategy |
|-----------|----------|
| Account register | `SETNX account:{name}` - first wins |
| Channel register | `SETNX channel:{name}` - first wins |
| Access change | Write to Redis, Pub/Sub notifies other X3 |
| Gline/shun | Write to Redis, Pub/Sub immediate broadcast |
| Memo send | `XADD` to stream, recipient's X3 delivers |

**Pros**: Full HA, geographic distribution, load sharing
**Cons**: Consistency complexity, potential conflicts during netsplit

### 3.3 Hybrid: Active/Passive with Quick Promotion

```
Normal operation:
  X3-A: Active, linked, processing commands
  X3-B: Warm standby, subscribed to Redis Pub/Sub, not linked

On X3-A failure:
  X3-B: Receives Pub/Sub notification
  X3-B: Links to network within seconds
  X3-B: Already has current state from Pub/Sub stream
```

**Key insight**: Even in active/passive, X3-B can subscribe to Redis Pub/Sub to maintain a warm cache. This minimizes failover time because X3-B doesn't need to cold-start from Redis.

### 3.4 Confirmed Approach

**✅ Phase 1**: Active/Passive (Option A) - **CONFIRMED**
- Simpler to implement correctly
- Validates Redis integration
- Provides basic HA
- Redis-based leader election (`SETNX x3:leader`)
- Polling + Pub/Sub backup for failover detection

**Phase 2**: Warm Standby (Option A + Pub/Sub)
- Passive subscribes to Pub/Sub
- Faster failover (target: < 10 seconds)
- Tests Pub/Sub infrastructure

**Phase 3**: Active/Active (Option B) - **Stretch Goal**
- Only if Phase 2 proves stable
- Requires careful conflict resolution
- Higher operational complexity

---

## 4. State Synchronization Design

### 4.1 Pub/Sub Channels for Multi-X3

```redis
# State change notifications
x3:state:account:{name}     # Account created, modified, deleted
x3:state:channel:{name}     # Channel registered, dropped, settings changed
x3:state:access:{channel}   # Access list changed
x3:state:gline              # Gline added/removed
x3:state:shun               # Shun added/removed

# Cache invalidation
x3:cache:invalidate:{type}  # Force cache refresh

# Heartbeat/health
x3:heartbeat:{instance_id}  # Instance alive notification

# Leader election (for active/passive)
x3:leader:election          # Leader election events
```

### 4.2 Message Formats

```json
// Account state change
{
  "event": "account_created",
  "account": "newuser",
  "source": "x3-a",
  "timestamp": 1704067200,
  "data": {
    "email": "user@example.com",
    "registered_by": "AuthServ"
  }
}

// Channel access change
{
  "event": "access_changed",
  "channel": "#help",
  "account": "helper",
  "old_level": 100,
  "new_level": 200,
  "source": "x3-a",
  "changed_by": "admin"
}

// Heartbeat
{
  "instance": "x3-a",
  "status": "active",
  "linked_to": "hub1.example.net",
  "timestamp": 1704067200,
  "load": {
    "accounts_cached": 1500,
    "channels_cached": 200,
    "memory_mb": 128
  }
}
```

### 4.3 Leader Election for Active/Passive

Using Redis for leader election:

```redis
# Attempt to become leader (atomic)
SET x3:leader {instance_id} NX EX 30

# Refresh leadership (must be current leader)
SET x3:leader {instance_id} XX EX 30

# Check who is leader
GET x3:leader
```

**Election algorithm**:
```
1. On startup, try SETNX x3:leader {my_id} EX 30
2. If successful: I am leader, link to IRC network
3. If failed: Another instance is leader, enter passive mode
4. Leader refreshes key every 10 seconds
5. If leader fails to refresh, key expires
6. Passive instances poll key; first to SETNX after expiry wins
7. New leader links to IRC network
```

### 4.4 Consistency During Failover

**Problem**: Active X3-A crashes mid-write. X3-B takes over. Is state consistent?

**Solution**: Write-ahead to Redis

```c
/* Before modifying in-memory state, write to Redis */
int register_channel(const char *name, const char *founder) {
    /* 1. Write to Redis first (durable) */
    if (redis_setnx("channel:%s", name, channel_data) != REDIS_OK) {
        return CHANNEL_ALREADY_EXISTS;
    }

    /* 2. Only then update in-memory state */
    add_channel_to_memory(name, founder);

    /* 3. Publish notification */
    redis_publish("x3:state:channel:%s", name, "created");

    return CHANNEL_REGISTERED;
}
```

If X3-A crashes between steps 1 and 2, X3-B will:
- Read channel from Redis (it exists)
- Rebuild in-memory state from Redis
- No data loss

---

## 5. Data Model Design

### 5.1 Account Data

```redis
# Core account (if not in Keycloak)
HSET account:{name} handle {name}
HSET account:{name} email {email}
HSET account:{name} password {hash}          # Only for local-auth accounts
HSET account:{name} registered {timestamp}
HSET account:{name} flags {bitmask}
HSET account:{name} opserv_level {level}

# Account activity (with TTL)
HSET activity:{name} lastseen {timestamp}
HSET activity:{name} last_present {timestamp}
EXPIRE activity:{name} 2592000               # 30 days

# Account preferences (with TTL)
HSET prefs:{name} screen_width {value}
HSET prefs:{name} table_width {value}
HSET prefs:{name} style {value}
EXPIRE prefs:{name} 7776000                  # 90 days

# Account nicks
SADD nicks:{account} nick1 nick2 nick3
# Nick to account reverse lookup
SET nick:{nickname} {account}

# Account fingerprints (with TTL)
HSET fp:{fingerprint} account {name}
HSET fp:{fingerprint} registered {timestamp}
HSET fp:{fingerprint} last_used {timestamp}
EXPIRE fp:{fingerprint} 7776000              # 90 days

# Fingerprints per account (for listing)
SADD account_fps:{account} fp1 fp2 fp3
```

### 5.2 Channel Data

```redis
# Channel core
HSET channel:{name} founder {account}
HSET channel:{name} registered {timestamp}
HSET channel:{name} flags {bitmask}
HSET channel:{name} modes {enforced_modes}
HSET channel:{name} topic {topic}
HSET channel:{name} greeting {greeting}
HSET channel:{name} user_greeting {user_greeting}

# Channel access (sorted set - score is access level)
ZADD chanaccess:{channel} 500 founder_account
ZADD chanaccess:{channel} 400 coowner_account
ZADD chanaccess:{channel} 200 op_account
ZADD chanaccess:{channel} 100 voice_account

# Query access by level
ZRANGEBYSCORE chanaccess:{channel} 200 +inf    # All ops and above
ZSCORE chanaccess:{channel} {account}          # Get specific level

# Channel bans (lamers) - sorted by timestamp
ZADD bans:{channel} {timestamp} {mask}
HSET ban:{channel}:{mask} set_by {account}
HSET ban:{channel}:{mask} reason {reason}
HSET ban:{channel}:{mask} expires {timestamp}

# DNR (Do Not Register) list
SADD dnr_channels {pattern}
HSET dnr:{pattern} set_by {account}
HSET dnr:{pattern} reason {reason}
```

### 5.3 Memos (Using Streams)

```redis
# Add memo
XADD memos:{recipient} * from {sender} message {text} sent {timestamp}

# Read unread memos (returns entries after last read)
XREAD STREAMS memos:{account} {last_read_id}

# Read all memos for account
XRANGE memos:{account} - +

# Mark memo as read (store last read ID)
SET memo_read:{account} {last_read_stream_id}

# Delete memo
XDEL memos:{account} {stream_id}

# Memo count
XLEN memos:{account}
```

### 5.4 OpServ Data

```redis
# Glines (network bans)
HSET gline:{mask} set_by {account}
HSET gline:{mask} reason {reason}
HSET gline:{mask} expires {timestamp}
HSET gline:{mask} issued {timestamp}
EXPIRE gline:{mask} {remaining_seconds}

# Index for gline lookup
ZADD glines_by_expiry {expiry_timestamp} {mask}

# Shuns
HSET shun:{mask} set_by {account}
HSET shun:{mask} reason {reason}
HSET shun:{mask} expires {timestamp}
EXPIRE shun:{mask} {remaining_seconds}

# Trusted hosts
SADD trusted_hosts {ip_pattern}
HSET trusted:{ip_pattern} issuer {account}
HSET trusted:{ip_pattern} reason {reason}
```

### 5.5 Caches (with TTL)

```redis
# Keycloak token cache
SET kc_token:{username}:{token_hash} {token_data}
EXPIRE kc_token:{username}:{token_hash} 14400    # 4 hours

# Keycloak group membership cache
HSET kc_groups:{username} {group} {role}
EXPIRE kc_groups:{username} 14400                 # 4 hours

# Auth failure tracking
INCR authfail:{ip}
EXPIRE authfail:{ip} 3600                         # 1 hour

# Fingerprint failure cache
SET fpfail:{fingerprint} 1
EXPIRE fpfail:{fingerprint} 3600                  # 1 hour
```

### 5.6 Metadata (IRCv3)

```redis
# Account metadata (IRCv3 METADATA keys)
HSET meta:account:{name} {key} {value}
# Example: HSET meta:account:testuser x3.theme dark-mode

# Channel metadata (IRCv3 METADATA keys)
HSET meta:channel:{name} {key} {value}
# Example: HSET meta:channel:#test x3.registered 1704067200

# Visibility tracking (optional separate hash)
HSET meta_vis:account:{name} {key} {visibility}
# visibility: "public", "private", "restricted"
```

---

## 6. TTL Strategy

**✅ Confirmed: Field-level TTL with Redis 7.4+ (HEXPIRE)**

### 6.1 Native TTL vs Application TTL

Redis provides native key expiration. Two approaches:

**Approach A: Key-Level Expiry**
```redis
HSET activity:{account} lastseen {ts} last_present {ts}
EXPIRE activity:{account} 2592000  # 30 days

# Problem: Entire hash expires, not individual fields
```

**Approach B: Field-Level Expiry (Redis 7.4+)**
```redis
HSET activity:{account} lastseen {ts}
HEXPIRE activity:{account} 2592000 FIELDS 1 lastseen
# Note: Requires Redis 7.4+ for HEXPIRE
```

**Approach C: Separate Keys per Field**
```redis
SET activity:{account}:lastseen {ts}
EXPIRE activity:{account}:lastseen 2592000

SET activity:{account}:last_present {ts}
EXPIRE activity:{account}:last_present 2592000

# Pro: Works with any Redis version
# Con: More keys, more lookups
```

**✅ Decision**: Using Approach B (field-level expiry) with Redis 7.4+. This provides the cleanest TTL semantics and matches the behavior designed in metadata-leverage-plan.md.

### 6.2 TTL Refresh on Access

```c
/* After successful read, refresh TTL */
void redis_refresh_ttl(redisContext *c, const char *key, int ttl_days) {
    redisCommand(c, "EXPIRE %s %d", key, ttl_days * 86400);
}

/* Combine read + refresh in single round-trip (Lua script) */
const char *lua_get_and_refresh =
    "local val = redis.call('HGETALL', KEYS[1])\n"
    "if next(val) then\n"
    "  redis.call('EXPIRE', KEYS[1], ARGV[1])\n"
    "end\n"
    "return val";
```

### 6.3 TTL Categories (from metadata-leverage-plan.md)

| Data Category | TTL | Redis Pattern |
|---------------|-----|---------------|
| Cache (Keycloak) | 4 hours | `EXPIRE key 14400` |
| Cache (auth fail) | 1 hour | `EXPIRE key 3600` |
| Migrated (activity) | 30 days | `EXPIRE key 2592000` + refresh |
| Migrated (prefs) | 90 days | `EXPIRE key 7776000` + refresh |
| Migrated (fingerprints) | 90 days | `EXPIRE key 7776000` + refresh |
| Migrated (channel) | 90 days | `EXPIRE key 7776000` + refresh |
| Immutable | Never | No `EXPIRE` call |

---

## 7. Persistence Configuration

**✅ Confirmed: Hybrid persistence (RDB + AOF with `everysec`)**

### 7.1 RDB (Point-in-Time Snapshots)

```conf
# redis.conf
save 900 1      # Save if at least 1 key changed in 900 seconds
save 300 10     # Save if at least 10 keys changed in 300 seconds
save 60 10000   # Save if at least 10000 keys changed in 60 seconds

dbfilename x3-dump.rdb
dir /var/lib/redis/x3/
```

**Pros**:
- Compact single-file backup
- Fast restart (load entire dataset)
- Good for disaster recovery

**Cons**:
- Can lose data since last snapshot
- Fork can cause latency spike

### 7.2 AOF (Append-Only File)

```conf
# redis.conf
appendonly yes
appendfilename "x3-appendonly.aof"
appenddirname "appendonlydir"

# fsync policy options:
# appendfsync always    # Safest, slowest (fsync every write)
# appendfsync everysec  # Good balance (fsync every second)
# appendfsync no        # Fastest, OS handles fsync

appendfsync everysec    # Recommended

# AOF rewrite settings
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

**Pros**:
- At most 1 second of data loss (with `everysec`)
- Human-readable (can be edited)
- Automatic rewrite keeps file size manageable

**Cons**:
- Larger than RDB
- Slower restart (replay all commands)

### 7.3 Hybrid Persistence (Confirmed)

```conf
# redis.conf - Enable both
save 900 1
save 300 10
save 60 10000

appendonly yes
appendfsync everysec

# Use RDB for fast restarts, AOF for durability
aof-use-rdb-preamble yes  # Redis 4.0+: AOF file starts with RDB snapshot
```

**✅ Decision for X3**:
- Production: Hybrid (RDB + AOF with `everysec`) - **CONFIRMED**
- Development: RDB only for simplicity (optional)

---

## 8. High Availability & Replication

**✅ Confirmed: Redis Sentinel (not Cluster) for automatic failover**

### 8.1 Master-Replica Setup

```
┌─────────────────┐
│  Redis Primary  │
│   (172.29.0.20) │
└────────┬────────┘
         │ Replication
    ┌────┴────┐
    ▼         ▼
┌───────┐  ┌───────┐
│Replica│  │Replica│
│  #1   │  │  #2   │
└───────┘  └───────┘
```

```conf
# replica.conf
replicaof 172.29.0.20 6379
replica-read-only yes
```

**Use Case**: Read scaling, warm standby for failover

### 8.2 Redis Sentinel (Confirmed)

```
┌─────────────────┐
│  Redis Primary  │◀─── Sentinels monitor
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐  ┌───────┐
│Replica│  │Replica│
└───────┘  └───────┘
    ▲         ▲
    └────┬────┘
         │
┌────────┴────────┐
│    Sentinels    │
│ (3+ for quorum) │
└─────────────────┘
```

```conf
# sentinel.conf
sentinel monitor x3master 172.29.0.20 6379 2
sentinel down-after-milliseconds x3master 5000
sentinel failover-timeout x3master 60000
sentinel parallel-syncs x3master 1
```

**X3 Connection via Sentinel**:
```c
/* Use hiredis sentinel support */
redisContext *c = redisConnectWithSentinel(
    "x3master",           /* sentinel master name */
    sentinel_hosts,       /* array of sentinel addresses */
    num_sentinels
);
```

### 8.3 Redis Cluster (Not Selected)

```
┌─────────────────────────────────────────────────┐
│                  Redis Cluster                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │ Shard 1 │  │ Shard 2 │  │ Shard 3 │         │
│  │ 0-5460  │  │5461-10922│ │10923-16383│        │
│  └─────────┘  └─────────┘  └─────────┘         │
│       │            │            │              │
│       ▼            ▼            ▼              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │Replica 1│  │Replica 2│  │Replica 3│         │
│  └─────────┘  └─────────┘  └─────────┘         │
└─────────────────────────────────────────────────┘
```

**When to Use Cluster**:
- Dataset exceeds single-node memory
- Need horizontal write scaling
- Very large networks (100k+ accounts)

**Limitation**: Multi-key operations must use same hash slot
```redis
# Force same slot with hash tags
HSET {user:alice}:prefs screen_width 80
HSET {user:alice}:activity lastseen 1704067200
# Both keys hash to same slot due to {user:alice}
```

**✅ Decision for X3**:
- Start with single node + Sentinel - **CONFIRMED**
- Cluster only if memory/throughput requires it (unlikely for typical IRC network)

---

## 9. Pub/Sub Implementation Details

### 9.1 Event Channels (Extended)

```redis
# Channel events
PUBLISH x3:channel:registered "#newchannel"
PUBLISH x3:channel:dropped "#oldchannel"
PUBLISH x3:channel:access_changed "#channel:account:newlevel"

# Account events
PUBLISH x3:account:registered "newaccount"
PUBLISH x3:account:authed "account:nick:ip"
PUBLISH x3:account:metadata_changed "account:key"

# OpServ events
PUBLISH x3:opserv:gline_added "mask:duration:reason"
PUBLISH x3:opserv:gline_removed "mask"

# Keycloak cache invalidation
PUBLISH x3:keycloak:invalidate "username"
PUBLISH x3:keycloak:group_changed "username:group"
```

### 9.2 X3 Subscriber Implementation

```c
/* Subscribe to all X3 events */
void *x3_redis_subscriber(void *arg) {
    redisContext *c = redisConnect(redis_host, redis_port);
    redisReply *reply;

    /* Subscribe to all X3 channels */
    reply = redisCommand(c, "PSUBSCRIBE x3:*");
    freeReplyObject(reply);

    while (1) {
        if (redisGetReply(c, (void **)&reply) == REDIS_OK) {
            if (reply->type == REDIS_REPLY_ARRAY && reply->elements >= 4) {
                const char *channel = reply->element[2]->str;
                const char *message = reply->element[3]->str;
                x3_handle_redis_event(channel, message);
            }
            freeReplyObject(reply);
        }
    }
}
```

### 9.3 Consistency Model

With multiple X3 instances, need to decide on consistency:

**Option A: Eventual Consistency (Simpler)**
- Each X3 reads/writes Redis directly
- Pub/Sub for cache invalidation
- Potential for race conditions on simultaneous updates

**Option B: Leader-based (Stronger)**
- One X3 is "leader" for writes
- Other instances are read-only
- Leader election via Redis locks

**Option C: Optimistic Locking**
```redis
WATCH account:{name}
# read current value
MULTI
HSET account:{name} field newvalue
EXEC
# EXEC returns nil if account:{name} changed since WATCH
```

**Recommendation**: Option A (Eventual) for most IRC use cases. IRC services are inherently eventually consistent (network splits, etc.).

---

## 10. Fallback Strategy

### 10.1 Redis Unavailability Handling

```c
typedef enum {
    X3_REDIS_HEALTHY,
    X3_REDIS_DEGRADED,      /* Some operations failing */
    X3_REDIS_UNAVAILABLE    /* All Redis operations failing */
} redis_state_t;

redis_state_t g_redis_state = X3_REDIS_HEALTHY;
```

### 10.2 Degradation Modes

| Redis State | Behavior |
|-------------|----------|
| **Healthy** | Normal operation, all features |
| **Degraded** | Queue writes, serve from local cache |
| **Unavailable** | Fallback to SAXDB/LMDB (if available) |

### 10.3 Write Queue for Degraded Mode

```c
/* Queue writes when Redis is degraded */
struct redis_write_queue {
    char *command;
    time_t queued_at;
    int retries;
    struct redis_write_queue *next;
};

void x3_queue_redis_write(const char *fmt, ...) {
    if (g_redis_state != X3_REDIS_HEALTHY) {
        /* Add to queue */
        queue_add(fmt, ...);
    } else {
        /* Execute directly */
        redis_execute(fmt, ...);
    }
}

/* Background thread replays queue when Redis recovers */
void x3_redis_queue_replay(void) {
    while (queue_head && g_redis_state == X3_REDIS_HEALTHY) {
        redis_execute(queue_head->command);
        queue_pop();
    }
}
```

### 10.4 Circuit Breaker Pattern

```c
#define REDIS_FAILURE_THRESHOLD 5
#define REDIS_RECOVERY_TIMEOUT 30  /* seconds */

static int redis_failure_count = 0;
static time_t redis_circuit_opened = 0;

int x3_redis_execute(redisContext *c, const char *cmd) {
    /* Circuit is open - don't even try */
    if (redis_failure_count >= REDIS_FAILURE_THRESHOLD) {
        if (time(NULL) - redis_circuit_opened < REDIS_RECOVERY_TIMEOUT) {
            return REDIS_CIRCUIT_OPEN;
        }
        /* Try to recover */
        redis_failure_count = REDIS_FAILURE_THRESHOLD - 1;
    }

    redisReply *reply = redisCommand(c, cmd);
    if (!reply || reply->type == REDIS_REPLY_ERROR) {
        redis_failure_count++;
        if (redis_failure_count >= REDIS_FAILURE_THRESHOLD) {
            redis_circuit_opened = time(NULL);
            log_error("Redis circuit breaker opened");
        }
        return REDIS_ERROR;
    }

    redis_failure_count = 0;  /* Reset on success */
    return REDIS_OK;
}
```

### 10.5 SAXDB Fallback (During Migration)

```c
/* Hybrid read: try Redis first, fallback to SAXDB */
int x3_read_account_field(const char *account, const char *field, char *value) {
    int rc = x3_redis_hget(account, field, value);
    if (rc == REDIS_OK) {
        return X3_OK;
    }

    /* Redis failed - try SAXDB */
    if (g_saxdb_enabled) {
        return saxdb_read_account_field(account, field, value);
    }

    return X3_NOT_FOUND;
}
```

---

## 11. Performance Benchmarking Plan

### 11.1 Benchmark Scenarios

| Scenario | Description | Target |
|----------|-------------|--------|
| **Auth lookup** | HGETALL account:{name} | < 1ms |
| **Fingerprint lookup** | HGET fp:{fingerprint} account | < 1ms |
| **Channel access check** | ZSCORE chanaccess:{channel} {account} | < 1ms |
| **Activity update** | HSET + EXPIRE | < 2ms |
| **Memo delivery** | XADD | < 2ms |
| **Bulk account load** | SCAN + HGETALL (1000 accounts) | < 100ms |
| **Channel list** | SCAN channel:* | < 50ms |

### 11.2 Comparison vs LMDB

```bash
# Create benchmark tool
# tests/benchmark/redis-vs-lmdb.c

# Test scenarios:
# 1. Single key read latency
# 2. Single key write latency
# 3. Bulk read (1000 keys)
# 4. Bulk write (1000 keys)
# 5. Range query (sorted set vs manual scan)
# 6. Memory usage for N accounts
```

### 11.3 Load Testing

```bash
# Use redis-benchmark
redis-benchmark -h localhost -p 6379 \
    -n 100000 \
    -c 50 \
    -t hset,hget,zadd,zscore,expire

# Custom X3-specific benchmark
./x3-redis-benchmark \
    --accounts 10000 \
    --channels 1000 \
    --auth-rate 100/s \
    --metadata-rate 50/s
```

### 11.4 Memory Profiling

```bash
# Monitor memory usage
redis-cli INFO memory

# Analyze key distribution
redis-cli --bigkeys

# Memory usage for specific patterns
redis-cli MEMORY USAGE account:testuser
redis-cli DEBUG OBJECT account:testuser
```

---

## 12. Operational Requirements

### 12.1 Docker Compose Addition

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7.4-alpine
    container_name: x3-redis
    restart: unless-stopped
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - redis_data:/data
      - ./data/redis.conf:/usr/local/etc/redis/redis.conf:ro
    command: redis-server /usr/local/etc/redis/redis.conf
    networks:
      irc_net:
        ipv4_address: 172.29.0.20
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  redis_data:
```

### 12.2 Configuration File

```conf
# data/redis.conf
bind 0.0.0.0
port 6379
protected-mode no  # Within Docker network

# Memory
maxmemory 256mb
maxmemory-policy volatile-lru

# Persistence
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfsync everysec
aof-use-rdb-preamble yes

# Logging
loglevel notice
logfile ""

# Slow log
slowlog-log-slower-than 10000
slowlog-max-len 128
```

### 12.3 Monitoring

```bash
# Add to docker-compose for monitoring (optional)
services:
  redis-exporter:
    image: oliver006/redis_exporter:latest
    ports:
      - "127.0.0.1:9121:9121"
    environment:
      REDIS_ADDR: redis:6379
    networks:
      - irc_net
```

**Key Metrics to Monitor**:
- `redis_connected_clients`
- `redis_memory_used_bytes`
- `redis_commands_processed_total`
- `redis_keyspace_hits_total` / `redis_keyspace_misses_total`
- `redis_latest_fork_usec`
- `redis_aof_last_bgrewrite_status`

### 12.4 Backup Strategy

```bash
# Script: scripts/redis-backup.sh
#!/bin/bash
BACKUP_DIR=/backups/redis
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Trigger RDB save and copy
redis-cli BGSAVE
sleep 5  # Wait for save
cp /data/x3-dump.rdb $BACKUP_DIR/x3-dump-$TIMESTAMP.rdb

# Retention: keep 7 days
find $BACKUP_DIR -name "x3-dump-*.rdb" -mtime +7 -delete
```

---

## 13. X3 Integration Approach

### 13.1 Library Selection

**Option A: hiredis (Recommended)**
```c
#include <hiredis/hiredis.h>

redisContext *c = redisConnect("127.0.0.1", 6379);
redisReply *reply = redisCommand(c, "HSET account:%s email %s",
                                 account, email);
```
- Official C client
- Simple API
- Async support via `hiredis-async`
- Already packaged in Debian

**Option B: redis-plus-plus (C++ wrapper)**
- Higher-level API
- Connection pooling built-in
- Requires C++17

**Recommendation**: hiredis for direct C integration

### 13.2 Connection Management

```c
/* x3_redis.h */
typedef struct {
    redisContext *ctx;
    redisContext *sub_ctx;  /* For Pub/Sub (separate connection) */
    const char *host;
    int port;
    int db;
    time_t last_connect_attempt;
    int connected;
} x3_redis_t;

/* Connection pool for multi-threaded access */
typedef struct {
    x3_redis_t **connections;
    int pool_size;
    pthread_mutex_t lock;
} x3_redis_pool_t;
```

### 13.3 Configuration

```conf
# x3.conf additions
"redis" {
    "enable" "1";
    "host" "172.29.0.20";
    "port" "6379";
    "db" "0";
    "password" "";                  # Empty if no auth
    "connection_pool_size" "5";
    "connect_timeout" "5000";       # ms
    "command_timeout" "1000";       # ms
    "retry_interval" "5";           # seconds
    "fallback_to_saxdb" "1";        # Enable SAXDB fallback
};
```

### 13.4 Migration Strategy

**Phase 1: Dual-Write (Week 1-2)**
```c
/* Write to both Redis and SAXDB */
void nickserv_set_lastseen(handle_info *hi, time_t when) {
    /* Existing SAXDB write */
    hi->lastseen = when;

    /* New Redis write */
    x3_redis_hset("activity:%s", hi->handle, "lastseen", "%lu", when);
}
```

**Phase 2: Redis Primary, SAXDB Backup (Week 3-4)**
```c
/* Read from Redis, fallback to SAXDB */
time_t nickserv_get_lastseen(handle_info *hi) {
    char buf[32];
    if (x3_redis_hget("activity:%s", hi->handle, "lastseen", buf)) {
        return strtoul(buf, NULL, 10);
    }
    return hi->lastseen;  /* SAXDB fallback */
}
```

**Phase 3: Redis Only (Week 5+)**
```c
/* Redis only, remove SAXDB code */
time_t nickserv_get_lastseen(const char *handle) {
    return x3_redis_hget_ulong("activity:%s", handle, "lastseen");
}
```

---

## 14. Risk Assessment

### 14.1 Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Redis unavailable | Medium | High | Circuit breaker, SAXDB fallback, write queue |
| Data loss | Low | High | AOF + RDB persistence, backup strategy |
| Memory exhaustion | Medium | Medium | maxmemory policy, monitoring alerts |
| Network latency | Low | Medium | Local Redis instance, connection pooling |
| Migration bugs | Medium | Medium | Dual-write period, comprehensive testing |
| Operational complexity | Medium | Low | Docker compose, monitoring, documentation |

### 14.2 Rollback Plan

1. Keep SAXDB writes during entire migration period
2. Configuration flag to disable Redis: `redis.enable = 0`
3. On rollback, SAXDB has all data (may be slightly stale for activity)
4. Document rollback procedure

---

## 15. Implementation Phases (Multi-X3 Focus)

The phases are ordered to enable active/passive failover as early as possible, with active/active as a later enhancement.

### Phase M1: Redis Infrastructure (1-2 days)

- [ ] M1.1 Add Redis to docker-compose.yml with Sentinel
- [ ] M1.2 Create redis.conf with HA-appropriate settings
- [ ] M1.3 Add replica container for testing failover
- [ ] M1.4 Verify Redis Sentinel failover works
- [ ] M1.5 Document Redis operational procedures

### Phase M2: X3 Redis Integration (3-5 days)

- [ ] M2.1 Add hiredis dependency to X3 build
- [ ] M2.2 Implement x3_redis.c connection management
- [ ] M2.3 Add Sentinel support for automatic Redis failover
- [ ] M2.4 Add configuration parsing for redis block
- [ ] M2.5 Implement circuit breaker pattern
- [ ] M2.6 Add Redis health check to O3 STATS

### Phase M3: Core State Migration (1 week)

Migrate the essential state needed for active/passive failover:

- [ ] M3.1 **Accounts**: Migrate account registration to Redis
  - `HSET account:{name}` for core account data
  - Dual-write to SAXDB during migration

- [ ] M3.2 **Channels**: Migrate channel registration to Redis
  - `HSET channel:{name}` for channel data
  - `ZADD chanaccess:{channel}` for access lists
  - Dual-write to SAXDB during migration

- [ ] M3.3 **Network bans**: Migrate glines/shuns to Redis
  - `HSET gline:{mask}` with Redis TTL for expiry
  - Dual-write to SAXDB during migration

- [ ] M3.4 **Fingerprints**: Migrate `fp:*` to Redis
  - Already in LMDB; move to Redis for sharing

- [ ] M3.5 **Keycloak cache**: Move from LMDB to Redis
  - Shared cache benefits both X3 instances

### Phase M4: Leader Election & Health (3-4 days)

- [ ] M4.1 Implement leader election via Redis
  - `SETNX x3:leader {instance_id} EX 30`
  - Refresh loop every 10 seconds

- [ ] M4.2 Implement heartbeat publishing
  - `SET x3:heartbeat:{id}` with status/timestamp

- [ ] M4.3 Implement passive mode for non-leader
  - Don't link to IRC network
  - Monitor leader heartbeat
  - Attempt takeover if leader expires

- [ ] M4.4 Test manual failover
  - Kill leader X3, verify passive takes over

- [ ] M4.5 Test Redis failover during X3 operation
  - Kill Redis primary, verify Sentinel promotes replica

### Phase M5: Active/Passive Validation (1 week)

- [ ] M5.1 Deploy two X3 instances in docker-compose
  - `x3` (default) and `x3-standby` (profile: ha)

- [ ] M5.2 Test registration during failover
  - Register account on X3-A
  - Kill X3-A
  - Verify account exists on X3-B

- [ ] M5.3 Test channel state during failover
  - Modify channel access on X3-A
  - Kill X3-A
  - Verify access preserved on X3-B

- [ ] M5.4 Test glines during failover
  - Add gline on X3-A
  - Kill X3-A
  - Verify gline active on X3-B

- [ ] M5.5 Measure failover time
  - Target: < 30 seconds to full service restoration

### Phase M6: Pub/Sub for Warm Standby (3-4 days)

Enable passive X3 to maintain warm cache via Pub/Sub:

- [ ] M6.1 Implement Pub/Sub publisher in active X3
  - Publish on account/channel/access changes
  - Publish on gline/shun changes

- [ ] M6.2 Implement Pub/Sub subscriber in passive X3
  - Subscribe to `x3:state:*` channels
  - Update local cache on events

- [ ] M6.3 Test cache consistency
  - Make change on X3-A
  - Verify X3-B cache updated within 1 second

- [ ] M6.4 Measure improved failover time
  - Target: < 10 seconds (no cold cache rebuild)

### Phase M7: Active/Active Foundation (Future, 1-2 weeks)

Only proceed if Phase M6 is stable:

- [ ] M7.1 Implement atomic write operations
  - `SETNX` for account/channel registration
  - `WATCH/MULTI/EXEC` for modifications

- [ ] M7.2 Implement conflict detection
  - Log conflicting writes
  - Use last-writer-wins or reject second write

- [ ] M7.3 Test dual-link configuration
  - X3-A links to Hub1
  - X3-B links to Hub2
  - Both process commands

- [ ] M7.4 Test netsplit behavior
  - Split network, make changes on both sides
  - Rejoin, verify state consistency

- [ ] M7.5 Document active/active limitations
  - Known edge cases
  - Operational guidance

### Phase M8: Data Migration Completion (Optional)

Additional migrations for full SAXDB elimination:

- [ ] M8.1 Migrate memos to Redis streams
- [ ] M8.2 Migrate user preferences to Redis
- [ ] M8.3 Migrate activity data (lastseen, last_present)
- [ ] M8.4 Migrate remaining OpServ data (alerts, routing)
- [ ] M8.5 Make SAXDB optional (config flag)

---

## 16. Decision Points

### 16.1 Key Decisions (Confirmed 2026-01-05)

| Decision | Options | **Decision** | Notes |
|----------|---------|--------------|-------|
| **Multi-X3 mode** | Active/Passive, Active/Active | ✅ Active/Passive first | Active/Active as stretch goal |
| **Leader election** | Redis-based, External (K8s, systemd) | ✅ Redis-based | Self-contained, simpler |
| **Failover trigger** | Polling, Pub/Sub notification | ✅ Polling + Pub/Sub backup | Belt and suspenders |
| Redis version | 6.x, 7.x, 7.4+ | ✅ 7.4+ | HEXPIRE for field-level TTL |
| Redis HA | None, Sentinel, Cluster | ✅ Sentinel | Cluster only if needed later |
| Persistence mode | RDB, AOF, Both | ✅ Both (hybrid) | AOF everysec + RDB snapshots |
| TTL strategy | Key-level, Field-level | ✅ Field-level | Requires Redis 7.4+ |
| LMDB fate | Eliminate, Local cache, Fallback | ⚪ Evaluate during impl | Nice-to-have if beneficial |
| SAXDB fate | Keep as backup, Eliminate | ✅ Keep as backup | During migration period |

### 16.2 Open Questions for Multi-X3

1. ~~**Failover trigger**: Who detects X3-A failure and triggers failover?~~
   - ✅ **ANSWERED**: Polling + Pub/Sub backup ("belt and suspenders")
   - X3-B polls Redis for leader heartbeat + subscribes to Pub/Sub notifications

2. **Network link handoff**: How does X3-B connect to network after X3-A fails?
   - Same hub as X3-A?
   - Different hub (for geographic distribution)?
   - Does IRCd need to be notified of X3 change?
   - *Remains open - depends on network topology*

3. **Split-brain prevention**: What if both X3s think they're leader?
   - Redis atomic leader lock is the safeguard
   - But what if Redis is also partitioned?
   - *Remains open - edge case for future consideration*

4. **Active/active command routing**: In active/active, how are commands routed?
   - Random (both can handle any command)?
   - Affinity (user's X3 handles their commands)?
   - Geographic (X3-A for Hub1 users, X3-B for Hub2)?
   - *Deferred - active/active is stretch goal*

5. ~~**Keycloak interaction**: Should Redis cache all Keycloak data?~~
   - ✅ **ANSWERED**: Yes, shared cache benefits both X3 instances
   - Keycloak cache migration to Redis is part of Phase M3.5

6. ~~**LMDB fate**: What happens to LMDB when Redis is primary?~~
   - ⚪ **DEFERRED**: Evaluate during implementation
   - "Nice-to-have if it makes sense and isn't too silly"
   - Will decide based on performance data from Phase M3

---

## 17. Success Criteria

### Phase M1-M2 Success (Infrastructure)
- [ ] Redis + Sentinel running in docker-compose
- [ ] X3 connects to Redis on startup
- [ ] X3 reconnects after Redis failover (via Sentinel)
- [ ] O3 STATS shows Redis health
- [ ] Circuit breaker handles Redis unavailability

### Phase M3-M4 Success (Core State + Leader Election)
- [ ] Accounts, channels, access lists in Redis
- [ ] Network bans in Redis with TTL expiry
- [ ] Leader election works correctly
- [ ] Non-leader X3 stays passive (doesn't link to network)
- [ ] Leader X3 refreshes leadership reliably

### Phase M5 Success (Active/Passive Failover)
- [ ] **Primary goal**: Failover works reliably
- [ ] Account registered on X3-A survives X3-A crash
- [ ] Channel access modified on X3-A survives X3-A crash
- [ ] Gline added on X3-A survives X3-A crash
- [ ] Failover time < 30 seconds
- [ ] No data loss during failover

### Phase M6 Success (Warm Standby)
- [ ] Passive X3 receives Pub/Sub updates
- [ ] Passive X3 maintains warm cache
- [ ] Failover time improved to < 10 seconds

### Phase M7 Success (Active/Active)
- [ ] Both X3 instances can process commands
- [ ] Account registration is atomic (no duplicates)
- [ ] Channel registration is atomic (no duplicates)
- [ ] Access changes propagate between instances
- [ ] Netsplit doesn't cause data corruption

### Overall Success
- [ ] **HA achieved**: Network survives X3 instance failure
- [ ] Operational complexity is manageable
- [ ] Performance acceptable for production workload
- [ ] Clear upgrade path from active/passive to active/active

---

## 18. Related Documentation

- [metadata-leverage-plan.md](metadata-leverage-plan.md) - Parent plan with SAXDB/LMDB analysis
- [x3-keycloak-optimization.md](x3-keycloak-optimization.md) - Keycloak integration (caching)
- [FEATURE_FLAGS_CONFIG.md](../../FEATURE_FLAGS_CONFIG.md) - Feature flag reference
- [Redis Documentation](https://redis.io/docs/) - Official Redis docs
- [hiredis](https://github.com/redis/hiredis) - C client library

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-05 | Claude | Initial comprehensive Redis investigation plan |
| 2026-01-05 | Claude | Refocused plan on multi-X3 (active/passive, active/active) as primary driver; added state synchronization design, leader election, failover scenarios; reorganized phases to prioritize HA |
| 2026-01-05 | Claude | Key decisions confirmed: Active/Passive first, Redis-based leader election, Sentinel HA, Redis 7.4+, hybrid persistence, field-level TTL. LMDB fate to be evaluated during implementation. |
| 2026-01-05 | Claude | Updated plan to reflect confirmed decisions throughout: added ✅ markers to relevant sections (TTL, Persistence, HA), updated Open Questions with answered/deferred status, fixed section numbering inconsistencies. |
