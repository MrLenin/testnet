# Metadata System Leverage Plan

## Executive Summary

This document provides a comprehensive analysis of the metadata storage systems in X3 and Nefarious, identifies opportunities to reduce technical debt, and proposes a phased approach to better leverage the metadata infrastructure.

**Goal**: Reduce reliance on SAXDB text-based storage, consolidate data flows through LMDB/Keycloak, and maximize the value of the IRCv3 metadata system.

---

## 1. Current State Analysis

### 1.1 Storage Systems Overview

| System | Type | Location | Characteristics |
|--------|------|----------|-----------------|
| **SAXDB** | Text-based hierarchical | `x3data/x3.db` | Human-readable, periodic writes, full state persistence |
| **LMDB** | Memory-mapped key-value | `x3data/lmdb/` | Ultra-fast reads, transactional, compression support |
| **Keycloak** | External identity backend | PostgreSQL/H2 | User attributes, group memberships, OAuth tokens |
| **Nefarious LMDB** | Memory-mapped cache | `metadata/` | Per-account metadata persistence, TTL-based |

### 1.2 Data Distribution (Current)

#### SAXDB Databases

| Database | Module | Data Stored |
|----------|--------|-------------|
| `NickServ` | nickserv.c | Account handles, passwords, nicks, masks, sslfps, flags, opserv_level, email, fakehost |
| `ChanServ` | chanserv.c | Channels, users, bans (lamers), notes, DNR list, suspended channels |
| `OpServ` | opserv.c | Trusted hosts, gags, alerts, routing plans, bad words, exempt channels |
| `MemoServ` | mod-memoserv.c | Memos between users, read/receipt flags |
| `gline` | gline.c | G-lines (network bans) |
| `shun` | shun.c | Shuns |
| `Global` | global.c | Global announcements |
| `modcmd` | modcmd.c | Command bindings, service bot configurations |

#### X3 LMDB Databases

| Database | Prefix | Data Stored |
|----------|--------|-------------|
| `accounts` | composite key | Account custom metadata (theme, website, etc.) |
| `channels` | composite key | Channel custom metadata |
| `metadata` | `chanaccess:` | Keycloak group sync cache |
| `metadata` | `fp:` | Certificate fingerprint → username mapping |
| `metadata` | `authfail:` | Failed authentication attempt cache |
| `metadata` | `fpfail:` | Failed fingerprint lookup cache |

#### Nefarious LMDB

| Database | Key Format | Data Stored |
|----------|------------|-------------|
| `metadata` | `account\0key` | Account metadata with TTL (T:timestamp:value) |
| `metadata` | `#channel\0key` | Channel metadata (when persisted) |

### 1.3 Data Flow Diagram

```
                          ┌─────────────────┐
                          │    Keycloak     │
                          │  (Identity)     │
                          └────────┬────────┘
                                   │ Group sync, user attributes
                                   ▼
                          ┌─────────────────┐       ┌─────────────────┐
                          │       X3        │◀─────▶│    Nefarious    │◀──── IRC Clients
                          │   (Services)    │  P10  │     (IRCd)      │      (connect here)
                          └────────┬────────┘       └────────┬────────┘
                                   │                         │
                    ┌──────────────┼──────────────┐          │
                    ▼              ▼              ▼          ▼
              ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
              │  SAXDB  │   │  LMDB   │   │Keycloak │   │  LMDB   │
              │  (X3)   │   │  (X3)   │   │  Cache  │   │ (Nefar) │
              └─────────┘   └─────────┘   └─────────┘   └─────────┘
```

**Client interaction**: IRC clients connect to Nefarious, which relays service commands (PRIVMSG to AuthServ/ChanServ/O3) to X3 via the P10 server link protocol.

---

## 2. Technical Debt Analysis

### 2.1 SAXDB Limitations

1. **Text-based format**: Inefficient for large datasets, parsing overhead on startup
2. **Periodic writes**: Risk of data loss between write intervals (default 30min)
3. **No compression**: Large files for networks with many accounts/channels
4. **No indexing**: Full scan required for searches
5. **Monolithic structure**: All data in one file (when mondo mode enabled)
6. **No TTL support**: Expired data must be explicitly cleaned up

### 2.2 Redundant/Overlapping Storage

| Data | SAXDB | LMDB | Keycloak | Notes |
|------|-------|------|----------|-------|
| Account passwords | ✓ | - | ✓ (for OIDC users) | Dual storage, sync issues possible |
| SSL fingerprints | ✓ | ✓ (fp: cache) | - | Cache speeds lookups |
| Channel access | ✓ | ✓ (chanaccess:) | ✓ (groups) | Three-way sync complexity |
| Email addresses | ✓ | - | ✓ | Keycloak authoritative for OIDC |
| Last seen times | ✓ | - | - | Could move to LMDB |
| Custom metadata | - | ✓ | ✓ | Good - already in LMDB |

### 2.3 Code Debt

1. **Password hash migration**: Still supporting legacy MD5 alongside PBKDF2
2. **Dual auth paths**: Local passwords vs Keycloak OIDC
3. **Multiple sync mechanisms**: ChanServ group sync, metadata sync, fingerprint sync
4. **LDAP code**: Marked deprecated but still present

---

## 3. Migration Candidates

### 3.1 High-Value SAXDB → LMDB Migrations

#### Priority 1: Session/Activity Data (Low Risk, High Value)

| Data Field | Current Location | Migration Target | Rationale |
|------------|------------------|------------------|-----------|
| `lastseen` | SAXDB (per account) | LMDB | Frequent updates, benefits from fast writes |
| `last_present` | SAXDB (per account) | LMDB | Already synced to Nefarious via `$last_present` |
| `nick.lastseen` | SAXDB (per nick) | LMDB | Frequent updates |

**Storage format**: `lastseen:{account}` → `{timestamp}`

#### Priority 2: Authentication Caches (Low Risk)

| Data | Current Location | Migration Target | Rationale |
|------|------------------|------------------|-----------|
| SSL fingerprints | SAXDB | LMDB primary | Already cached; make LMDB authoritative |
| Auth failure tracking | LMDB only | Keep LMDB | Good current design |

#### Priority 3: User Preferences (Medium Risk)

| Data Field | Current Location | Migration Target | Rationale |
|------------|------------------|------------------|-----------|
| `screen_width` | SAXDB | LMDB/Metadata | User preference, metadata system natural fit |
| `table_width` | SAXDB | LMDB/Metadata | User preference |
| `userlist_style` | SAXDB | LMDB/Metadata | User preference |
| `announcements` | SAXDB | LMDB/Metadata | User preference |
| `maxlogins` | SAXDB | LMDB/Metadata | User preference |

**Storage**: As IRCv3 metadata keys (`x3.screen_width`, `x3.table_width`, etc.)

### 3.2 Data to Keep in SAXDB (For Now)

| Data | Reason |
|------|--------|
| Account structure (handle, nicks) | Core identity, needs reliable persistence |
| Password hashes | Security-critical, SAXDB + Keycloak backup |
| Channel structure | Core registration data |
| Bans/lamers | Needs reliable persistence |
| Glines/shuns | Network-critical |
| Routing plans | Operational data |

### 3.3 Keycloak Integration Opportunities

| Data | Current State | Opportunity |
|------|---------------|-------------|
| Email addresses | Dual storage | Make Keycloak authoritative |
| User roles/olevels | SAXDB + Keycloak attribute | Sync from Keycloak `x3_opserv_level` |
| Account flags | SAXDB only | Could store as Keycloak attributes |
| Fakehost | SAXDB only | Could sync to Keycloak for SSO display |

---

## 4. Metadata System Enhancement Opportunities

### 4.1 New Metadata Keys to Support

#### Account Metadata (via IRCv3 METADATA)

| Key | Description | Visibility | Storage |
|-----|-------------|------------|---------|
| `x3.opserv_level` | Operator level (read-only from Keycloak) | Private | Keycloak → LMDB |
| `x3.registered` | Registration timestamp | Public | LMDB |
| `x3.email_verified` | Email verification status | Private | Keycloak |
| `x3.fakehost` | Custom vhost | Public | SAXDB (for now) |
| `x3.screen_width` | Display preference | Private | LMDB |
| `x3.table_width` | Table display preference | Private | LMDB |
| `x3.style` | User list style preference | Private | LMDB |

#### Channel Metadata (via IRCv3 METADATA)

| Key | Description | Visibility | Storage |
|-----|-------------|------------|---------|
| `x3.registered` | Channel registration timestamp | Public | LMDB |
| `x3.founder` | Channel founder account | Public | LMDB |
| `x3.modes` | Enforced channel modes | Public | LMDB |
| `x3.greeting` | Channel greeting message | Public | LMDB |
| `x3.user_greeting` | Per-user greeting setting | Public | LMDB |

### 4.2 Compression Optimization

Current compression settings:
- X3 LMDB: threshold 256 bytes, level 3
- Nefarious: threshold 256 bytes, level 3

**Recommendations**:
1. Lower threshold to 128 bytes for metadata that tends to be smaller
2. Enable compression passthrough (Z flag) for all X3 → Nefarious metadata
3. Monitor compression ratios and adjust

#### Dynamic Compression Strategy

Instead of a fixed threshold, implement adaptive compression:

**A. Content-aware threshold**:
```c
int should_compress(const char *key, const char *value, size_t len) {
    /* Small values never compress well */
    if (len < 64) return 0;

    /* Known high-entropy keys (already compressed/binary) */
    if (strstr(key, "avatar") || strstr(key, "image")) return 0;

    /* Text-heavy keys compress great */
    if (strstr(key, "greeting") || strstr(key, "info")) return len > 100;

    /* Default threshold */
    return len > 256;
}
```

**B. Adaptive based on actual compression ratio**:
```c
/* Try compression, only use if ratio is worthwhile */
size_t compressed_len = zstd_compress(value, len, compressed_buf);
if (compressed_len < len * 0.8) {  /* Only if 20%+ savings */
    store_compressed(key, compressed_buf, compressed_len);
} else {
    store_raw(key, value, len);  /* Not worth the CPU cost */
}
```

**C. Per-key-prefix configuration**:
```conf
"metadata_compression" {
    "default_threshold" "256";
    "greeting" "100";           // text compresses well
    "avatar" "never";           // already compressed
    "x3.info" "50";             // user info strings
    "topic" "100";              // channel topics
};
```

**D. Dynamic level selection based on size**:
```c
int compression_level(size_t len) {
    if (len < 512) return 1;      /* fast for small */
    if (len < 4096) return 3;     /* balanced */
    return 6;                      /* better ratio for large */
}
```

**Implementation priority**: B (adaptive ratio) provides best balance of simplicity and effectiveness. The P10 passthrough (Z flag) already avoids recompression waste between X3 and Nefarious.

### 4.3 TTL Strategy for Migrated Data

**Critical Distinction**: Data migrated from SAXDB is fundamentally different from cache data.

| Data Origin | TTL Behavior | Rationale |
|-------------|--------------|-----------|
| **Cache data** (Keycloak sync, auth failures) | Short TTL (hours) | Can be regenerated from authoritative source |
| **Migrated SAXDB data** | Long TTL + refresh OR no TTL | Cannot be regenerated - original SAXDB may be gone |

#### TTL Categories

| Data Type | TTL | Refresh Mechanism | Backup Strategy |
|-----------|-----|-------------------|-----------------|
| **Cache: Keycloak entries** | 4 hours | Re-sync from Keycloak | None needed (source is Keycloak) |
| **Cache: Auth failures** | 1 hour | None (ephemeral) | None needed |
| **Cache: Channel access** | `sync_frequency * 2` | Keycloak sync job | None needed |
| **Migrated: lastseen** | 30 days | Refresh on any account activity | Periodic SAXDB sync-back |
| **Migrated: last_present** | 30 days | Refresh on presence change | Periodic SAXDB sync-back |
| **Migrated: user preferences** | 90 days | Refresh on any SET command | Periodic SAXDB sync-back |
| **Migrated: fingerprints** | 90 days | Refresh on SASL EXTERNAL auth | Periodic SAXDB sync-back |
| **Migrated: channel settings** | 90 days | Refresh on any ChanServ command | Periodic SAXDB sync-back |

#### TTL Refresh Implementation

For migrated data, implement automatic TTL refresh ("touch") on access:

```c
/* When reading migrated data, refresh TTL if accessed */
int x3_lmdb_get_with_refresh(const char *key, char *value, time_t ttl_days) {
    int rc = x3_lmdb_get(key, value);
    if (rc == LMDB_SUCCESS) {
        /* Refresh TTL on successful read */
        time_t new_expiry = now + (ttl_days * 86400);
        x3_lmdb_set_ttl(key, new_expiry);
    }
    return rc;
}
```

#### SAXDB Sync-Back for Durability

Migrated data should periodically sync back to SAXDB as a durability layer:

```
┌──────────┐     migrate     ┌──────────┐
│  SAXDB   │ ───────────────▶│   LMDB   │  (primary for reads)
│(backup)  │◀─────────────── │(primary) │
└──────────┘   sync-back     └──────────┘
              (periodic)
```

**Sync-back frequency**:
- Activity data (lastseen): Daily
- Preferences: On change + daily
- Fingerprints: On change + daily

**Sync-back trigger**: Also sync on graceful shutdown to ensure no data loss.

#### Immutable Keys (No TTL)

Some data should never expire and never need TTL:

| Key Pattern | Reason |
|-------------|--------|
| `x3.registered` | Historical timestamp, never changes |
| `x3.founder` | Historical record |
| Core account identity | Must persist |

Configure immutable keys in X3:
```conf
"nickserv" {
    "metadata_immutable_keys" ("x3.registered", "x3.founder", "x3.created_by");
};
```

---

## 5. Implementation Phases

### Phase 1: Activity Data Migration (Low Risk) ✅ COMPLETE

**Goal**: Move frequently-updated activity fields to LMDB

**Implementation Date**: 2026-01-05

#### Tasks

- [x] 1.1 Add LMDB functions for activity data
  - `x3_lmdb_activity_set(account, lastseen, last_present)` - in x3_lmdb.c:1798
  - `x3_lmdb_activity_get(account, lastseen_out, last_present_out)` - in x3_lmdb.c:1730
  - `x3_lmdb_activity_touch(account)` - in x3_lmdb.c:1860
  - `x3_lmdb_activity_delete(account)` - in x3_lmdb.c:1879

- [x] 1.2 Modify nickserv to use LMDB for activity
  - Added `nickserv_update_activity_lmdb()` helper function - nickserv.c:6840
  - Dual-write on de-auth (quit) - nickserv.c:1218
  - Dual-write on auth - nickserv.c:1248
  - Dual-write in `handle_update_last_present()` - nickserv.c:7215

- [x] 1.3 Implement TTL management for activity data
  - 30-day TTL with refresh on any account activity (LMDB_ACTIVITY_TTL_DAYS = 30)
  - TTL auto-refresh when `x3_lmdb_activity_set()` is called
  - `x3_lmdb_activity_touch(account)` refreshes TTL without changing values

- [x] 1.4 Add SAXDB sync-back mechanism
  - Dual-write during migration period (writes to both struct/SAXDB and LMDB)
  - LMDB shutdown handler ensures clean database close
  - SAXDB continues to be written from the struct on normal schedule

- [x] 1.5 Add startup migration
  - On SAXDB load, checks LMDB for fresher data - nickserv.c:5533-5560
  - If LMDB has fresher timestamps, uses those
  - If LMDB doesn't have data, migrates from SAXDB

- [x] 1.6 Sync `$last_present` to Nefarious metadata
  - Synced via irc_metadata() in `handle_update_last_present()` - nickserv.c:7217-7220
  - Also synced during auth - nickserv.c:1283-1288

### Phase 2: User Preferences as Metadata (Medium Risk) ✅ COMPLETE

**Goal**: Expose user preferences as IRCv3 metadata keys

**Implementation Date**: 2026-01-05

#### Tasks

- [x] 2.1 Define metadata key namespace
  - Added `X3_METADATA_PREFIX "x3."` and individual key defines - nickserv.c:142-148
  - Keys: `x3.screen_width`, `x3.table_width`, `x3.style`, `x3.announcements`, `x3.maxlogins`
  - TTL constant: `X3_PREF_TTL_DAYS 90` (90 days) - nickserv.c:150-152

- [x] 2.2 Implement preference metadata handlers in X3
  - Added `nickserv_sync_preference_metadata()` helper - nickserv.c:6884-6930
  - Stores with P: visibility prefix (private) and 90-day TTL
  - Pushes to Nefarious via `irc_metadata()` for online users

- [x] 2.3 Implement TTL management for preferences
  - 90-day TTL in `nickserv_sync_preference_metadata()` - nickserv.c:6910
  - TTL refresh on any SET command (TTL refreshed when value written)
  - x3.* keys use `X3_PREF_TTL_SECS` in `nickserv_set_user_metadata()` - nickserv.c:6806-6808
  - Dual-write to SAXDB via struct updates (existing SAXDB writer handles this)

- [x] 2.4 Migrate preference commands to use metadata
  - `opt_width()` → syncs `x3.screen_width` - nickserv.c:3783-3786
  - `opt_tablewidth()` → syncs `x3.table_width` - nickserv.c:3804-3807
  - `opt_style()` → syncs `x3.style` - nickserv.c:3908-3910
  - `opt_announcements()` → syncs `x3.announcements` - nickserv.c:3948-3950
  - `opt_maxlogins()` → syncs `x3.maxlogins` - nickserv.c:4085-4090

- [x] 2.5 Add IRCv3 METADATA client support
  - Added `handle_x3_preference_metadata()` - nickserv.c:6661-6753
  - Validates values and updates handle_info struct when clients SET x3.* keys
  - Called from `nickserv_set_user_metadata()` - nickserv.c:6765-6776
  - Supports: screen_width, table_width, style, announcements, maxlogins

### Phase 3: Fingerprint Consolidation (Low Risk)

**Goal**: Make LMDB authoritative for fingerprint lookups

#### Tasks

- [ ] 3.1 Enhance LMDB fingerprint storage
  - Store registration timestamp
  - Store last-used timestamp
  - Store associated account name

- [ ] 3.2 Implement TTL management for fingerprints
  - 90-day TTL with refresh on SASL EXTERNAL auth
  - TTL refresh when fingerprint successfully used for auth
  - Store format: `fp:{fingerprint}` → `{account}:{registered}:{last_used}:{expiry}`

- [ ] 3.3 Add fingerprint metadata sync
  - Sync fingerprints to Keycloak as user attribute (`x3_sslfps`)
  - Enable certificate-based login via Keycloak
  - Sync-back to SAXDB on change and daily

- [ ] 3.4 Deprecate SAXDB fingerprint storage
  - Read from LMDB first
  - Fallback to SAXDB during migration
  - Dual-write during migration period
  - Eventually remove SAXDB fingerprint writes

### Phase 4: Channel Metadata Enhancement (Medium Risk)

**Goal**: Expose channel settings as IRCv3 metadata

#### Tasks

- [ ] 4.1 Define channel metadata keys
  - `x3.greeting`, `x3.user_greeting`, `x3.topic_mask`
  - `x3.modes` for enforced modes
  - `x3.registered`, `x3.founder` (immutable, no TTL)

- [ ] 4.2 Implement TTL management for channel metadata
  - 90-day TTL for mutable settings (greeting, topic_mask)
  - No TTL for immutable keys (registered, founder)
  - TTL refresh on any ChanServ command for the channel
  - Sync-back to SAXDB on change and daily

- [ ] 4.3 Implement channel metadata sync
  - On channel registration, set metadata (no TTL for registered/founder)
  - On setting changes, update metadata with TTL refresh
  - Dual-write to SAXDB during migration period

- [ ] 4.4 Enable channel metadata queries
  - MDQ for channel metadata
  - METADATA LIST for channels

### Phase 5: SAXDB Reduction (Higher Risk)

**Goal**: Reduce SAXDB to essential-only data

#### Tasks

- [ ] 5.1 Audit remaining SAXDB data
  - Identify what cannot be migrated
  - Document dependencies

- [ ] 5.2 Implement LMDB-first for remaining candidates
  - Memos (could move to LMDB with TTL - 30 days, refresh on read)
  - Per-nick data (could consolidate)

- [ ] 5.3 Add SAXDB → LMDB migration tool
  - One-time bulk migration
  - Validation and rollback capability
  - Preserve original timestamps for TTL calculation

- [ ] 5.4 Implement TTL purge job
  - Periodic background job to clean expired entries
  - Configurable purge frequency (default: 1 hour)
  - Log purge statistics for monitoring

- [ ] 5.5 Implement TTL recovery mechanism
  - If entry expired but SAXDB backup exists, restore from SAXDB
  - Log recovery events for debugging
  - Consider this a safety net, not normal operation

- [ ] 5.6 Reduce SAXDB write frequency
  - Increase interval for non-critical data
  - Keep frequent writes for core registration data
  - SAXDB becomes backup layer, not primary

- [ ] 5.7 End-state validation
  - Verify all migrated data has proper TTL or is immutable
  - Verify sync-back mechanisms are working
  - Verify TTL refresh is happening on access

### Phase 6: SAXDB Elimination (Future/Optional)

**Goal**: Fully eliminate SAXDB dependency with alternative durable storage

#### The Problem

SAXDB currently serves as a durability safety net. Without it, we need:
- Reliable persistence for LMDB data
- Backup/snapshot mechanism
- Recovery path if LMDB corrupts

#### Storage Backend Options

| Option | Pros | Cons |
|--------|------|------|
| **LMDB snapshots** | Already have LMDB, just add periodic `mdb_env_copy` | Binary format, lock during copy |
| **Keycloak-only** | Already integrated, proper database | Can't store channel data, IRC-specific fields |
| **SQLite** | Battle-tested, single file, SQL queries | New dependency, migration work |
| **JSON/YAML export** | Human-readable, easy debugging | Need to write serializer, slower |
| **Redis + persistence** | Fast, replication built-in, pub/sub | New dependency, but powerful *(see Phase 6.1)* |

#### Phase 6.1: Redis Integration (Requires Investigation)

Redis is particularly interesting because it offers:

1. **Built-in persistence**: RDB snapshots + AOF logging
2. **Replication**: Master-replica for HA
3. **Pub/Sub**: Could enable real-time sync between X3 instances
4. **Data structures**: Hashes, sorted sets, streams - natural fit for IRC data
5. **Clustering**: Horizontal scaling if needed
6. **TTL native**: Built-in key expiration

**Potential architecture**:
```
┌─────────────────┐       ┌─────────────────┐
│       X3        │◀─────▶│      Redis      │◀───── Replication
│   (Services)    │       │   (Primary)     │
└─────────────────┘       └────────┬────────┘
                                   │
                          ┌────────┴────────┐
                          │  Persistence    │
                          │  (RDB + AOF)    │
                          └─────────────────┘
```

**Data model mapping**:
| X3 Data | Redis Structure |
|---------|-----------------|
| Account metadata | `HSET account:{name} {key} {value}` |
| Channel metadata | `HSET channel:{name} {key} {value}` |
| Channel access | `ZADD chanaccess:{channel} {level} {account}` |
| Fingerprints | `HSET fp:{fingerprint} account {name} last_used {ts}` |
| Activity | `HSET activity:{account} lastseen {ts} last_present {ts}` |
| Memos | `XADD memos:{recipient} * from {sender} message {text}` |

**Benefits over LMDB**:
- No need for sync-back to SAXDB (Redis IS the durable store)
- TTL handled natively by Redis
- Easier debugging (`redis-cli` vs binary LMDB)
- Potential for multi-X3 setups sharing state

**Concerns to investigate**:
- Memory usage vs LMDB
- Network latency (if Redis is remote)
- Operational complexity
- Fallback if Redis is unavailable

**Status**: Requires dedicated investigation - this is a significant architectural change.

#### Tasks (Phase 6)

- [ ] 6.1 Investigate Redis integration feasibility
  - Prototype basic account/channel storage
  - Benchmark vs LMDB performance
  - Document operational requirements

- [ ] 6.2 Implement LMDB snapshot mechanism (interim)
  - Periodic `mdb_env_copy` to backup location
  - Configurable snapshot frequency
  - Retention policy for snapshots

- [ ] 6.3 Make SAXDB optional
  - Configuration flag to disable SAXDB entirely
  - Startup check for required data sources
  - Clear error messages if misconfigured

---

## 6. External Dependency Reduction

### 6.1 Keycloak Dependency Management

| Scenario | Current Behavior | Target Behavior |
|----------|------------------|-----------------|
| Keycloak unavailable | LMDB cache fallback | Same + queue writes for replay |
| New user registration | Requires Keycloak | Fallback to local-only with warning |
| Password change | Keycloak + SAXDB | Keycloak primary, LMDB backup |
| Group sync failure | Log warning | Queue and retry with exponential backoff |

### 6.2 LDAP Removal

The LDAP module is marked deprecated. Removal steps:

- [ ] 6.2.1 Verify no active LDAP usage in configuration
- [ ] 6.2.2 Remove LDAP compilation flags
- [ ] 6.2.3 Remove LDAP source files
- [ ] 6.2.4 Update documentation

### 6.3 Reducing PostgreSQL/External DB Dependency

Keycloak currently uses PostgreSQL. For simpler deployments:

- [ ] Consider embedded H2 mode for development/small networks
- [ ] Document minimal Keycloak configuration

---

## 7. Metrics & Monitoring

### 7.1 Key Metrics to Track

| Metric | Purpose | Target |
|--------|---------|--------|
| SAXDB write frequency | Disk I/O | < 1/30min for stable data |
| LMDB operations/sec | Performance | > 10,000 reads/sec |
| Keycloak request latency | External dependency | < 100ms p99 |
| Compression ratio | Storage efficiency | > 40% reduction |
| Cache hit rate | Effectiveness | > 90% for metadata |
| TTL expiration rate | Data freshness | < 5% stale reads |

### 7.2 Monitoring Commands

```
/msg O3 STATS metadata    - LMDB statistics
/msg O3 STATS keycloak    - Keycloak health/latency
/msg O3 STATS cache       - Cache hit rates
```

---

## 8. Risk Assessment

### 8.1 Migration Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Data loss during migration | Low | High | Backup before migration, validation steps |
| Performance regression | Medium | Medium | Benchmark before/after, rollback plan |
| Keycloak sync conflicts | Medium | Low | X3 authoritative, conflict logging |
| LMDB corruption | Low | High | Regular backups, health checks |

### 8.2 Rollback Strategy

1. Keep SAXDB writes during migration period (dual-write)
2. Maintain SAXDB read fallback for 2 major releases
3. Document rollback procedure for each phase
4. Test rollback procedure before production deployment

---

## 9. Success Criteria

### Phase 1 Success
- [ ] Activity data stored in LMDB with 30-day TTL
- [ ] TTL refreshes on account activity
- [ ] Daily sync-back to SAXDB working
- [ ] `$last_present` synced to Nefarious

### Phase 2 Success
- [ ] User preferences accessible via IRCv3 METADATA
- [ ] Preferences have 90-day TTL with refresh on access
- [ ] Clients can read/write preferences via METADATA command
- [ ] Preferences persist across restarts (TTL + sync-back)

### Phase 3 Success
- [ ] Fingerprint lookups use LMDB only
- [ ] Fingerprints have 90-day TTL with refresh on auth
- [ ] Fingerprints synced to Keycloak attributes
- [ ] Certificate auth via Keycloak works

### Phase 4 Success
- [ ] Channel metadata accessible via IRCv3 METADATA
- [ ] Mutable settings have 90-day TTL, immutable have no TTL
- [ ] Channel settings sync to Nefarious
- [ ] MDQ queries work for channels

### Phase 5 Success
- [ ] SAXDB reduced to essential data only
- [ ] All migrated data has proper TTL management
- [ ] TTL purge job running and logging
- [ ] LMDB is primary storage for all cacheable data
- [ ] Startup time reduced by 30%+

---

## 10. Appendix

### A. LMDB Key Format Reference

```
# X3 LMDB
accounts database:
  {account}\0{key}                    → [T{expiry}:]{visibility}:{value}

channels database:
  {channel}\0{key}                    → [T{expiry}:]{visibility}:{value}

metadata database:
  chanaccess:{channel}\0{account}     → {level}:{timestamp}
  fp:{fingerprint}                    → {account}:{registered}:{last_used}:{expiry}
  authfail:{hash}                     → {timestamp}:{expiry}
  fpfail:{fingerprint}                → {timestamp}:{expiry}
  activity:{account}                  → {lastseen}:{last_present}:{expiry}  [NEW]

# TTL Storage Format (for migrated data)
# Format: T{unix_expiry_timestamp}:{actual_value}
# Example: T1709251200:dark-theme (expires March 1, 2024)
# No TTL: value stored without T prefix (immutable keys)

# Nefarious LMDB
metadata database:
  {account}\0{key}                    → T{timestamp}|{value}
  #{channel}\0{key}                   → T{timestamp}|{value}
```

### A.1 TTL Management Summary

| Data Category | TTL | Refresh Trigger | Backup |
|---------------|-----|-----------------|--------|
| Cache (Keycloak) | 4h | Sync job | None |
| Cache (auth fail) | 1h | None | None |
| Migrated (activity) | 30d | Any account action | SAXDB daily |
| Migrated (prefs) | 90d | Any SET command | SAXDB daily |
| Migrated (fingerprints) | 90d | SASL EXTERNAL | SAXDB daily |
| Migrated (channel) | 90d | Any ChanServ cmd | SAXDB daily |
| Immutable | None | N/A | SAXDB |

### B. P10 Metadata Commands

```
# MD - Set metadata
[source] MD [target] [key] [visibility] :[value]
[source] MD [target] [key] [visibility] Z :[base64_compressed]
[source] MD [target] [key]                              # Clear

# MDQ - Query metadata
[source] MDQ [target] [key|*]
```

### C. Related Documentation

- [x3-keycloak-optimization.md](x3-keycloak-optimization.md) - Keycloak integration details
- [password-hashing-upgrade.md](password-hashing-upgrade.md) - Password migration
- [FEATURE_FLAGS_CONFIG.md](../../FEATURE_FLAGS_CONFIG.md) - Feature flag reference
- [P10_PROTOCOL_REFERENCE.md](../../P10_PROTOCOL_REFERENCE.md) - P10 protocol details

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-05 | Claude | Initial comprehensive analysis and plan |
| 2026-01-05 | Claude | Enhanced TTL strategy for migrated SAXDB data: added refresh mechanisms, SAXDB sync-back, TTL categories, immutable key handling |
| 2026-01-05 | Claude | Added Phase 6: SAXDB Elimination with Redis investigation; Added dynamic compression strategy section |
