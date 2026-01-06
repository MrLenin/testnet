# SAXDB Optional - Full LMDB Migration Plan

**Date**: 2026-01-05
**Status**: Active Implementation
**Branch**: `x3/saxdb-optional`
**Effort Estimate**: 20-30 hours

---

## Overview

This plan migrates all core X3 data from SAXDB to LMDB, making SAXDB truly optional. After completion, X3 can run purely on LMDB with periodic snapshots for durability.

---

## Current State Analysis

### Data Currently in SAXDB Only

| Module | Data Type | Complexity | Priority |
|--------|-----------|------------|----------|
| NickServ | Account handles | High | P1 |
| NickServ | Account nicks | Medium | P1 |
| NickServ | Account masks | Low | P2 |
| NickServ | Account ignores | Low | P3 |
| NickServ | Cookies | Medium | P2 |
| ChanServ | Channel registrations | High | P1 |
| ChanServ | Channel users | High | P1 |
| ChanServ | Channel bans | Medium | P2 |
| ChanServ | Channel notes | Low | P3 |
| OpServ | Glines | Medium | P2 |
| OpServ | Shuns | Medium | P2 |
| OpServ | Trusted hosts | Low | P2 |
| OpServ | Alerts | Low | P3 |
| Global | Messages | Low | P3 |
| ModCmd | Bindings | Medium | P2 |
| MemoServ | Memos | Medium | P3 |

### Data Already in LMDB

- Activity timestamps
- User preferences (metadata)
- SSL fingerprints
- Channel metadata
- Session tokens
- SCRAM credentials
- Keycloak cache
- Read markers

---

## LMDB Key Schema Design

### Account Data (NickServ)

```
# Core account record
acct:<handle>                   -> JSON {passwd, email, registered, lastseen, flags, ...}

# Account nicks (already partial)
nick:<nick>                     -> <handle>

# Account masks
mask:<handle>:<index>           -> <mask_string>
mask_count:<handle>             -> <count>

# Account ignores
ignore:<handle>:<index>         -> <ignore_mask>
ignore_count:<handle>           -> <count>

# Cookies (temporary auth tokens)
cookie:<handle>                 -> JSON {type, data, expires}
```

### Channel Data (ChanServ)

```
# Core channel record
chan:<#channel>                 -> JSON {registrar, registered, visited, flags, modes, ...}

# Channel users (access list)
chanuser:<#channel>:<handle>    -> JSON {access, flags, seen, info}

# Channel bans/lamers
chanban:<#channel>:<index>      -> JSON {mask, owner, reason, set_time, expires}
chanban_count:<#channel>        -> <count>

# Channel notes
channote:<#channel>:<id>        -> JSON {setter, text, set_time}
channote_next_id:<#channel>     -> <next_id>
```

### Network Security (OpServ)

```
# Glines
gline:<mask>                    -> JSON {issuer, reason, issued, expires, lastmod}

# Shuns
shun:<mask>                     -> JSON {issuer, reason, issued, expires}

# Trusted hosts
trusted:<mask>                  -> JSON {issuer, reason, issued, limit}

# Alerts
alert:<id>                      -> JSON {owner, text_discrim, action, ...}
alert_next_id                   -> <next_id>
```

### Global/ModCmd

```
# Global messages
global_msg:<id>                 -> JSON {flags, text}
global_next_id                  -> <next_id>

# ModCmd bindings (complex - may need special handling)
modcmd:<service>:<command>      -> JSON {module, flags, min_level, ...}
```

---

## Implementation Phases

### Phase 1: Infrastructure (2-3 hours) ✅ COMPLETE

- [x] 1.1 Add JSON serialization helpers to x3_lmdb.c
  - Using existing `x3_lmdb_set/get()` to store JSON as strings
  - Serialization done in callers (nickserv.c, chanserv.c) which have struct access
  - Added `x3_lmdb_handle_set/get/delete/exists()` for account JSON
  - Added `x3_lmdb_nick_register/get_handle/unregister()` for nick mapping

- [x] 1.2 Add index iteration helpers
  - `x3_lmdb_prefix_iterate(db, prefix, callback, ctx)`
  - `x3_lmdb_prefix_delete_all(db, prefix)`
  - `x3_lmdb_prefix_count(db, prefix)`

- [x] 1.3 Add `saxdb_enabled` config option
  - `x3_lmdb_saxdb_enabled()` - returns flag (default 1)
  - `x3_lmdb_set_saxdb_enabled()` - set from config
  - Default: enabled (backward compatible)

### Phase 2: NickServ Migration (6-8 hours) ✅ COMPLETE

- [x] 2.1 Account core data
  - Added `x3_lmdb_handle_set/get/delete/exists()` for JSON account data
  - Storage at `handle:<handle_name>` key
  - JSON serialization done by callers (nickserv.c)

- [x] 2.2 Account nicks
  - Added `x3_lmdb_nick_register/get_handle/unregister()`
  - Storage at `nick:<nick_name>` → `<handle>` mapping

- [x] 2.3 Account masks and ignores
  - Added `x3_lmdb_mask_add/clear/list()` with indexed keys
  - Added `x3_lmdb_ignore_add/clear/list()` with indexed keys
  - Storage at `mask:<handle>:<index>` and `ignore:<handle>:<index>`

- [x] 2.4 Cookies
  - Added `x3_lmdb_cookie_set/get/delete()` with JSON storage
  - Storage at `cookie:<handle>` with type, value, data, expires

- [x] 2.5 Modify nickserv_saxdb_read/write ✅
  - Added `nickserv_lmdb_write_handle()` for dual-write to LMDB
  - Added `nickserv_lmdb_read_handle()` and `nickserv_lmdb_read_all()` for LMDB fallback
  - `nickserv_saxdb_read()` checks `x3_lmdb_saxdb_enabled()` flag
  - All code guarded by `#ifdef WITH_LMDB`

### Phase 3: ChanServ Migration (6-8 hours) ✅ COMPLETE

- [x] 3.1 Channel core data ✅
  - Added `x3_lmdb_chanreg_set/get/delete/exists()` for JSON channel data
  - Storage at `chanreg:#channel` key

- [x] 3.2 Channel users (access lists) ✅
  - Added `x3_lmdb_chanuser_reg_set/get/delete/clear()`
  - Storage at `chanuser:#channel:handle` key

- [x] 3.3 Channel bans ✅
  - Added `x3_lmdb_chanban_add/clear/list()`
  - Indexed storage at `chanban:#channel:N`

- [x] 3.4 Channel notes
  - Stored as part of channel metadata (existing system)

- [x] 3.5 Modify chanserv_saxdb_write ✅
  - Added `chanserv_lmdb_write_channel()` and `chanserv_lmdb_write_all()`
  - Dual-write from `chanserv_saxdb_write()`

- [x] 3.6 Modify chanserv_saxdb_read ✅
  - Added `chanserv_lmdb_read_channel()` to deserialize JSON to chanData
  - Added `lmdb_channel_read_callback()` for prefix iteration
  - Added `chanserv_lmdb_read_all()` to load all channels from LMDB
  - Added fallback in `chanserv_saxdb_read()` when SAXDB disabled
  - Added `chanserv_lmdb_read_users()` and `chanserv_lmdb_read_bans()` helpers

### Phase 4: OpServ Migration (3-4 hours) - INFRASTRUCTURE ONLY

- [x] 4.1 Glines
  - Existing LMDB support in gline.c
  - Key prefix: gline:<mask>

- [x] 4.2 Shuns
  - Existing LMDB support in shun.c
  - Key prefix: shun:<mask>

- [x] 4.3 Trusted hosts ✅
  - Added x3_lmdb_trusted_set/get/delete()
  - Key prefix: trusted:<ipaddr>

- [x] 4.4 Gags ✅
  - Added x3_lmdb_gag_set/get/delete()
  - Key prefix: gag:<mask>

- [x] 4.5 Alerts ✅
  - Added x3_lmdb_alert_set/get/delete()
  - Key prefix: alert:<name>

- [x] 4.6 OpServ dual-write integration ✅
  - Added inline LMDB writes in opserv_saxdb_write() for trusted hosts, gags, alerts
  - JSON format: limit/expires/issued/issuer/reason for trusted, owner/reason/expires for gags
  - JSON format: discrim/owner/last/expire/reaction for alerts

- [x] 4.7 OpServ LMDB read integration ✅
  - Added `lmdb_trusted_read_callback()`, `lmdb_gag_read_callback()`, `lmdb_alert_read_callback()`
  - Added `opserv_lmdb_read_all()` to load all OpServ data from LMDB
  - Added fallback in `opserv_saxdb_read()` when SAXDB disabled
  - Added JSON helper functions `os_json_extract_string/int()`

### Phase 5: Supporting Modules (2-3 hours) - PARTIAL

- [x] 5.1 Global messages ✅
  - Added `x3_lmdb_global_set/get/delete/clear()` to x3_lmdb.c
  - Added `LMDB_PREFIX_GLOBAL` prefix
  - Added dual-write in `global_saxdb_write()`
  - Added `gl_json_extract_string/int()` helpers
  - Added `lmdb_global_read_callback()` and `global_lmdb_read_all()`
  - Added LMDB fallback in `global_saxdb_read()`

- [~] 5.2 ModCmd bindings - DEFERRED
  - Complex nested structure (bots, services, commands, helpfiles)
  - Mostly static configuration that rarely changes
  - Lower priority - can be added later if needed

- [~] 5.3 MemoServ - DEFERRED
  - Optional module, may not be enabled on all networks
  - Complex structure (accounts, memos, history)
  - Lower priority - can be added later if needed

### Phase 6: Testing and Finalization (3-4 hours)

- [ ] 6.1 Migration tool: SAXDB -> LMDB import
- [ ] 6.2 Verification: compare SAXDB and LMDB data
- [ ] 6.3 Performance testing
- [ ] 6.4 Documentation update

---

## Configuration

```
"saxdb" {
    "enabled" "0";              // 0 = LMDB-only, 1 = use SAXDB (default)
    "write_frequency" "3600";   // Only relevant if enabled
};

"lmdb" {
    "core_data_enabled" "1";    // Store accounts/channels in LMDB
    "snapshot_interval" "3600"; // Hourly snapshots for durability
    "snapshot_retention" "24";  // Keep 24 snapshots
};
```

---

## Migration Strategy

### New Deployments
1. Start with `saxdb_enabled = 0`
2. All data stored in LMDB from the start
3. Periodic LMDB snapshots for backup

### Existing Deployments
1. Keep `saxdb_enabled = 1` initially
2. Run migration tool to import SAXDB -> LMDB
3. Verify data integrity
4. Set `saxdb_enabled = 0`
5. Optionally keep SAXDB files as backup

---

## Risk Mitigation

1. **Data Loss**: LMDB snapshots every hour, keep SAXDB as fallback initially
2. **Performance**: LMDB is faster than SAXDB file parsing
3. **Corruption**: LMDB has built-in integrity (MVCC, checksums)
4. **Rollback**: Can re-enable SAXDB if issues discovered

---

## Progress Tracking

- [x] Phase 1: Infrastructure ✅
- [x] Phase 2: NickServ ✅ (write + read complete)
- [x] Phase 3: ChanServ ✅ (write + read complete)
- [x] Phase 4: OpServ ✅ (infrastructure + write + read complete)
- [x] Phase 5: Supporting Modules ✅ (Global complete, ModCmd/MemoServ deferred)
- [ ] Phase 6: Testing

## Jansson Integration Notes (2026-01-05)

Jansson is now mandatory when LMDB is enabled (via --with-keycloak).
JSON handling has been refactored to use jansson for proper encoding/escaping.

### Refactored Modules
- **global.c** ✅ - Full jansson integration for read/write
- **opserv.c** ✅ - Full jansson integration for read/write

### Modules Using Legacy JSON Extractors
- **chanserv.c** - Still uses manual JSON extractors (cs_json_extract_*)
  - Has jansson.h include available
  - Refactoring deferred due to complexity (12+ LMDB sections)
  - Current code works correctly, just not using jansson API

### Build Configuration
```bash
./configure --with-lmdb --with-keycloak --with-ssl
# This enables both LMDB and jansson support
```

## Audit Notes (2026-01-05)

### Context Window Gaps - RESOLVED

Previous sessions marked phases as complete when only partial work was done.
These gaps have now been fixed:

1. **Phase 3 ChanServ**: ✅ FIXED
   - `chanserv_lmdb_write_channel()` ✅
   - `chanserv_lmdb_read_channel()` ✅ ADDED
   - SAXDB-optional fallback ✅ ADDED

2. **Phase 4 OpServ**: ✅ FIXED
   - `x3_lmdb_trusted/gag/alert_set/get/delete()` ✅
   - opserv.c dual-write integration ✅ ADDED
   - LMDB read callbacks ✅ ADDED
   - SAXDB-optional fallback ✅ ADDED

---

## Notes

- JSON chosen for complex records to maintain human-readability in exports
- Simple values (counts, timestamps) stored as raw strings for efficiency
- All LMDB writes are transactional for consistency
- TTL/expiration reuses existing infrastructure from metadata TTL

## Phase 2.5 Implementation Notes

Phase 2.5 requires careful integration with nickserv.c:

### Write Path (nickserv_saxdb_write)
1. After writing each handle to SAXDB, also serialize to LMDB
2. JSON format for handle_info should include: passwd, email, flags, opserv_level, karma, timestamps, etc.
3. Masks, ignores, and nicks stored separately using the indexed key functions
4. This "dual-write" approach ensures data is captured in both stores during transition

### Read Path (nickserv_saxdb_read)
1. When `x3_lmdb_saxdb_enabled()` returns false, skip SAXDB file reading
2. Instead, iterate over all `handle:*` keys in LMDB
3. Deserialize JSON back to handle_info struct
4. Reconstruct masks, ignores, nicks from their indexed keys

### JSON Format for handle_info
```json
{
  "passwd": "...",
  "email": "...",
  "flags": 5,
  "opserv_level": 1000,
  "karma": 0,
  "registered": 1234567890,
  "lastseen": 1234567890,
  "last_present": 1234567890,
  "maxlogins": 0,
  "language": "en_US",
  "infoline": "...",
  "fakehost": "...",
  "epithet": "...",
  "last_quit_host": "...",
  "screen_width": 80,
  "table_width": 50,
  "userlist_style": "n",
  "announcements": "?"
}
```

### Migration Strategy
1. Enable dual-write mode (SAXDB + LMDB)
2. Wait for complete cycle of all accounts to be written
3. Verify data consistency between SAXDB and LMDB
4. Disable SAXDB with `saxdb_enabled = 0`
5. Keep SAXDB files as backup
