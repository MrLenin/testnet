# Consolidated Unimplemented Items from All Plan/Investigation Files

This document comprehensively compiles ALL unimplemented, deferred, optional, and future work items from every plan and investigation file in the project.

**Last Updated**: 2026-01-05
**Sources Reviewed**:
- `.claude/plans/` (9 files)
- `docs/plans/` (8 files)
- `docs/investigations/` (15 files)
- `IRCV3_PROJECT_STATUS.md`

---

## Summary by Priority

| Priority | Category | Items | Est. Effort |
|----------|----------|-------|-------------|
| **P0** | Critical Path | 1 | 20-30 hrs |
| **P1** | High Value | 5 | 60-90 hrs |
| **P2** | Medium Value | 4 | 20-40 hrs |
| **P3** | Low Priority/Deferred | 7 | 30-50 hrs |
| **Optional** | Future Enhancements | 6 | Variable |

> **Important**: Several items were discovered to be **already implemented** during codebase verification:
> - #1: SASL EXTERNAL with Keycloak ✅
> - #11: X3 Crash Investigation ✅ (completed, optional ASAN remaining)
> - #12: Metadata Write Queue ✅
> - #13: ChanServ/Keycloak Bidirectional Sync ✅
> - #14: TAGMSG History Storage ✅
> - #15: DM History (just disabled by default) ✅
> - #25: Channel History Federation ✅
> - #8-10: Test infrastructure (partially done)
> - #23: Redis/Multi-X3 - **Deferred** (not realistic for current deployment)
>
> The plan files were outdated. Always verify implementation status against actual code.

---

## P0: Critical Path Items

### 1. ~~SASL EXTERNAL with Keycloak~~ - IMPLEMENTED

**Source**: `docs/plans/SASL_EXTERNAL_KEYCLOAK_PLAN.md`
**Status**: ✅ IMPLEMENTED (plan file not updated)

The following are implemented in `x3/src/nickserv.c` and `x3/src/keycloak.c`:
- [x] `loc_auth_external()` - Full fingerprint authentication flow
- [x] `keycloak_find_user_by_fingerprint()` / `keycloak_find_user_by_fingerprint_async()` - Keycloak API lookup
- [x] `kc_sync_fingerprints()` - Syncs to Keycloak `x509_fingerprints` attribute
- [x] NickServ commands: `ADDCERTFP`, `DELCERTFP`, `OADDCERTFP`, `ODELCERTFP`
- [x] LMDB fingerprint caching with TTL and negative cache
- [x] Fingerprint collision detection (`KC_COLLISION`)
- [x] Auto-create accounts from Keycloak (`keycloak_autocreate`)

**Remaining Optional Items** (from original plan):
- [ ] Certificate expiration tracking/warnings
- [x] `CERT LIST` command - IMPLEMENTED as `LISTCERTFP` and `OLISTCERTFP` (nickserv.c)
- [x] `CERT SEARCH` oper command - IMPLEMENTED as `SEARCHCERTFP` (nickserv.c)
- [x] Certificate auto-registration on PLAIN auth - IMPLEMENTED with `cert_autoregister` config option (nickserv.c)

---

### 2. Make SAXDB Optional (Future Work)

**Source**: `metadata-leverage-plan.md` Phase 6.3
**Status**: Deferred (significant undertaking)
**Effort**: 20-30 hours

Currently SAXDB is still required even with LMDB. This would:
- Allow deployments to run purely on LMDB
- Eliminate 30-minute data loss window entirely
- Migrate account/channel core data to LMDB

**Prerequisite**: All current LMDB work must be stable first

**Note (2026-01-05)**: This is a major architectural change requiring migration of:
- Core account identity (handles, nicks, passwords, email)
- Core channel data (registrations, bans/lamers, notes)
- Network security data (glines, shuns, trusted hosts)
- Service configuration (modcmd bindings)

Recommend treating this as a separate project with dedicated planning.

---

## P1: High Value Items

### 3. Keycloak Webhook for Real-time Cache Invalidation

**Source**: `.claude/plans/x3-keycloak-optimization.md`
**Status**: Not implemented
**Effort**: 16-24 hours

Currently cache invalidation relies on TTL (30-second delay). Webhook would provide:
- Immediate fingerprint revocation on password change
- Instant account suspension effect
- Real-time group membership changes

**Implementation Tasks**:
- [ ] Keycloak Admin Event Listener configuration
- [ ] HTTP endpoint in X3 to receive webhooks
- [ ] LMDB cache invalidation logic
- [ ] Security (webhook authentication)

---

### 4. X3-issued Session Tokens for SASL PLAIN Optimization

**Source**: `.claude/plans/x3-keycloak-optimization.md`
**Status**: Not implemented
**Effort**: 16-24 hours

After successful PLAIN auth, issue session token to client:
- Token format: `x3tok:base64_encoded_data`
- X3 validates locally, no Keycloak call needed
- LMDB storage: `session:<token_id>` → `username|expiry`

**Benefits**:
- Reduces Keycloak load significantly for reconnecting clients
- Lower latency for repeat authentications

---

### 5. ~~SCRAM-SHA-256 for Session Tokens~~ - IMPLEMENTED (Extended)

**Source**: `.claude/plans/x3-keycloak-optimization.md`
**Status**: ✅ IMPLEMENTED (with all hash variants + account passwords)
**Effort**: 24-32 hours

Enhanced security over plaintext tokens:
- [x] SCRAM-SHA-1, SCRAM-SHA-256, SCRAM-SHA-512 key derivation using OpenSSL EVP APIs
- [x] Session token storage: `scram:<hash_type>:<token_id>` → `expiry:hashtype:iteration:salt:storedkey:serverkey:username`
- [x] Account password storage: `scram_acct:<hash_type>:<account>` → `0:hashtype:iteration:salt:storedkey:serverkey:account`
- [x] Token never sent in plaintext, replay-resistant via nonces
- [x] SASL SCRAM-SHA-1, SCRAM-SHA-256, SCRAM-SHA-512 mechanisms added to X3
- [x] Session SCRAM credentials auto-created after successful PLAIN auth
- [x] Account SCRAM credentials created on registration/password change
- [x] SCRAM credentials revoked when sessions are revoked

**Implementation Details**:
- `x3_lmdb.h/c`: Generic SCRAM functions via `enum scram_hash_type` (SHA1, SHA256, SHA512)
- `x3_lmdb.h/c`: Session token API: `x3_lmdb_scram_create_ex/get_ex/delete_ex/revoke_all()`
- `x3_lmdb.h/c`: Account password API: `x3_lmdb_scram_acct_create/create_all/get/delete_all()`
- `nickserv.c`: SASL SCRAM state machine supporting all three hash variants
- Session tokens use username `x3scram:tokenid`, account passwords use regular account name
- Works with WeeChat and other clients supporting SCRAM mechanisms

**Known Limitation - Email Verification Flow**:
SCRAM credentials for account passwords are NOT created for accounts requiring email verification (activation cookie). This is because:
1. At registration time, plaintext password is available but account isn't activated yet
2. At activation time (cookie use), only the encrypted password is available - SCRAM requires plaintext
3. Creating SCRAM credentials before activation would bypass email verification

**Workaround**: Users who register with email verification enabled must use the `PASS` command to change their password after activation to get SCRAM credentials.

**Future Solution** (from Jobe):
Change the registration flow to collect password at cookie confirmation time instead of registration time:
1. `REGISTER handle email` - no password provided yet
2. User receives activation cookie via email
3. `COOKIE handle cookie password` - password provided HERE with plaintext available
4. SCRAM credentials created at this point

This matches modern password reset UX (like websites that ask for new password after clicking reset link, not before). Same approach would fix RESETPASS flow. This is a cleaner design that solves the limitation properly rather than working around it.

---

### 6. Session Token Revocation

**Source**: `.claude/plans/x3-keycloak-optimization.md`
**Status**: Not implemented
**Effort**: 8-12 hours

LMDB-backed instant revocation:
- Session versioning: `session_ver:<username>` → version number
- Bump version to invalidate all tokens for a user
- Triggers: password change, LOGOUT ALL, admin suspend, webhook

**Depends On**: Session tokens implementation (#4)

---

### 7. Password Hash Migration Analysis Tool

**Source**: `.claude/plans/password-hashing-upgrade.md` Phase 7
**Status**: Not implemented
**Effort**: 4-8 hours

Python script to analyze password hash distribution:
- Report accounts using each algorithm (MD5, PBKDF2, bcrypt)
- Optionally force migration for dormant accounts
- Generate migration progress reports

---

## P2: Medium Value Items

### 8. Test Infrastructure Improvements

**Source**: `.claude/plans/test-stability-investigation.md` Phase 4
**Status**: Partially done (see test-failures-investigation.md)
**Effort**: 8-12 hours remaining

**Completed**:
- [x] O3 HELP timing fix (100ms delay, increased timeout 2s→3s)
- [x] cleanup-tests.ts updated with default credentials
- [x] 4x test run analysis documented

**Remaining**:
- [ ] Create timeout constants: `SERVICE_RESPONSE_TIMEOUT`, etc.
- [ ] Environment-based timeout multiplier for CI
- [ ] Unique prefixes per test file
- [ ] Retry logic for flaky operations

---

### 9. Test Documentation

**Source**: `.claude/plans/test-stability-investigation.md` Phase 5
**Status**: Partially done
**Effort**: 2-4 hours remaining

**Completed**:
- [x] test-failures-investigation.md documents known issues
- [x] Root causes documented for OpServ, ChanServ, timing issues

**Remaining**:
- [ ] Inline comments in flaky tests
- [ ] Troubleshooting guide for CI failures

---

### 10. Pending SASL/Test Investigations

**Source**: `.claude/plans/test-failures-investigation.md`
**Status**: Partially investigated
**Effort**: 4-8 hours remaining

**Completed**:
- [x] OpServ failures fixed (11/12 pass)
- [x] testadmin olevel 1000 issue resolved
- [x] Cleanup between test runs improved

**Remaining**:
- [ ] SASL PLAIN test with testuser/testpass
- [ ] ChanServ registration ops timing
- [ ] Intermittent Keycloak group test failures

---

### 11. ~~X3 Crash Investigation~~ - INVESTIGATED

**Source**: `.claude/plans/test-failures-investigation.md`
**Status**: ✅ Investigation completed (see test-failures-investigation.md)

Work completed:
- [x] Kernel logs analyzed - identified `modcmd_register` and `sar_fd_readable` crash sites
- [x] Core dump collection configured (docker-compose.yml, kernel core_pattern)
- [x] Root cause hypotheses documented (NULL module pointer, memory corruption)
- [x] Suspicious commits identified (d8d6596, e2b2f41, 20c9bc0)
- [x] Prior memory corruption bugs fixed (caefbc6)

**Remaining optional** (if crashes persist):
- [ ] ASAN build for deeper analysis
- [ ] Git bisect to find regression

---

### 12. ~~Metadata Write Queue for X3 Unavailability~~ - IMPLEMENTED

**Source**: `docs/plans/METADATA_ENHANCEMENT_PLAN.md` Phase 3
**Status**: ✅ IMPLEMENTED in `nefarious/ircd/metadata.c`

Full implementation exists:
- [x] `struct MetadataWriteQueue` - queue entry
- [x] `metadata_queue_write()` - queue writes when X3 unavailable
- [x] `metadata_replay_queue()` - replay on X3 reconnect
- [x] `metadata_clear_queue()` - clear without replaying
- [x] `FEAT_METADATA_QUEUE_SIZE` - configurable queue size
- [x] X3 heartbeat detection (`metadata_x3_heartbeat()`)

---

### 13. ~~ChanServ Access Level Sync from Keycloak Groups~~ - IMPLEMENTED

**Source**: `docs/plans/METADATA_ENHANCEMENT_PLAN.md`
**Status**: ✅ IMPLEMENTED - Bidirectional sync exists in `x3/src/chanserv.c`

Full implementation:
- [x] `keycloak_access_sync` - enables sync
- [x] `keycloak_bidirectional_sync` - enables X3 → Keycloak push
- [x] `chanserv_push_keycloak_access()` - pushes access changes
- [x] `chanserv_delete_keycloak_channel()` - deletes channel groups
- [x] Integration with ADDUSER, CLVL, DELUSER commands

---

### 14. ~~TAGMSG History Storage~~ - IMPLEMENTED

**Source**: `docs/investigations/EVENT_PLAYBACK_INVESTIGATION.md`
**Status**: ✅ IMPLEMENTED in `nefarious/ircd/m_tagmsg.c`

- [x] `store_tagmsg_history()` function stores TAGMSG with `HISTORY_TAGMSG` type
- [x] Called at line 222: `store_tagmsg_history(sptr, chptr, client_tags);`
- [x] Stores client-only tags as content for event-playback

---

### 15. ~~DM (Private Message) History~~ - IMPLEMENTED

**Source**: `docs/investigations/CHATHISTORY_INVESTIGATION.md`
**Status**: ✅ IMPLEMENTED (disabled by default for privacy)

Full implementation in Nefarious:
- [x] `FEAT_CHATHISTORY_PRIVATE` - enables DM history (default: FALSE)
- [x] `FEAT_CHATHISTORY_PRIVATE_CONSENT` - consent mode (0=global, 1=single, 2=multi)
- [x] `FEAT_CHATHISTORY_ADVERTISE_PM` - advertises PM policy in CAP
- [x] `FEAT_CHATHISTORY_PM_NOTICE` - sends notice about PM policy
- [x] `pm_history_consent()` - checks consent based on user preferences

**Not a code issue** - just a policy decision to enable/configure

---

## P3: Low Priority / Deferred Items

### 16. Argon2 Password Hashing Support

**Source**: `.claude/plans/password-hashing-upgrade.md`
**Status**: Partially implemented (detection only)
**Effort**: 8-12 hours

Detection is implemented in `x3/src/password.c`:
- [x] `PW_ALG_ARGON2ID` enum value
- [x] Detection: `if (strncmp(hash, "$argon2id$", 10) == 0)`
- [ ] Actual hashing function (needs `libargon2` or OpenSSL 3.2+)

Lower priority since PBKDF2/bcrypt already cover needs.

---

### 17. MD5 Legacy Password Deprecation Timeline

**Source**: `.claude/plans/password-hashing-upgrade.md`
**Status**: No decision made

Open questions:
- [ ] What deprecation timeline for legacy MD5 support?
- [ ] Should bcrypt be optional or mandatory dependency?
- [ ] Force migration for dormant accounts?

---

### 18. LDAP Code Cleanup

**Source**: `.claude/plans/x3-code-quality-audit.md`
**Status**: Marked DEPRIORITIZED
**Effort**: 8-12 hours

LDAP code marked for removal when LDAP is phased out. Currently low priority.

---

### 19. ~~Static Analysis Integration~~ - IMPLEMENTED

**Source**: `.claude/plans/x3-code-quality-audit.md`
**Status**: ✅ IMPLEMENTED
**Effort**: 4-8 hours

- [x] Add `-Wall -Wextra -Werror` to catch future issues
  - Updated `configure.in` with modern warning flags
  - Added: `-Wall -Wextra -Wformat=2 -Wstrict-prototypes -Wmissing-prototypes -Wold-style-definition -Wuninitialized -Wpointer-arith -Wno-unused-parameter`
  - `-Werror` enabled in maintainer mode
- [x] Integrate cppcheck or scan-build
  - Created `.cppcheck` configuration file
  - Created `tools/static-analysis.sh` script
  - Supports both cppcheck and scan-build

---

### 20. WebSocket Origin Validation

**Source**: `docs/investigations/WEBSOCKET_INVESTIGATION.md`
**Status**: Basic implementation complete, security hardening optional
**Effort**: 4-8 hours

- [ ] Restrict WebSocket connections to trusted web origins
- [ ] Configurable allowed origins list

---

### 21. Multi-Factor Authentication for SASL EXTERNAL

**Source**: `docs/plans/SASL_EXTERNAL_KEYCLOAK_PLAN.md`
**Status**: Design documented, not implemented
**Effort**: 16-24 hours

Require additional authentication after EXTERNAL for sensitive accounts (operators):
- Secondary SASL PLAIN step for high-privilege accounts
- Or custom EXTERNAL-MFA mechanism

**Depends On**: ~~SASL EXTERNAL implementation (#1)~~ - Base implemented, MFA extension not done

---

### 22. ~~Certificate Auto-Registration on PLAIN Auth~~ - IMPLEMENTED

**Source**: `docs/plans/SASL_EXTERNAL_KEYCLOAK_PLAN.md`
**Status**: ✅ IMPLEMENTED
**Effort**: 4-6 hours

When user authenticates via SASL PLAIN while connected with a certificate:
- [x] Auto-add the fingerprint to their account
- [x] Configurable: `cert_autoregister` option (default: disabled)
- [x] Silent registration via `nickserv_addsslfp_silent()` function
- [x] Works for both async and sync SASL PLAIN success paths

**Implementation**: `nickserv.c` - Added `cert_autoregister` config option and `nickserv_addsslfp_silent()` helper function

---

## Optional / Future Enhancements

### 23. Redis Pub/Sub for Multi-X3 Instances - DEFERRED

**Sources**:
- `.claude/plans/redis-investigation.md` (comprehensive)
- `docs/plans/X3_STORAGE_BACKEND_PLAN.md` Phase 7

**Status**: Deferred - not a realistic goal for current deployment
**Effort**: 30-45 hours

For networks running multiple X3 instances that need real-time sync. Requires `hiredis` library and Redis server infrastructure.

**Decision**: Single-X3 deployment is sufficient for current needs. Channel history federation via P10 covers cross-server history without Redis.

---

### 24. Enterprise PostgreSQL Backend

**Source**: `docs/plans/X3_STORAGE_BACKEND_PLAN.md` Option D
**Status**: Documented alternative, not planned
**Effort**: 60-80 hours

For very large networks (1000+ users) needing:
- Full RDBMS capabilities
- Replication and high availability
- Advanced query capabilities

**Not recommended** for current network size.

---

### 25. ~~Channel History Federation~~ - IMPLEMENTED

**Source**: `IRCV3_PROJECT_STATUS.md`
**Status**: ✅ IMPLEMENTED in `nefarious/ircd/m_chathistory.c`

Full S2S federation protocol exists:
- [x] `FEAT_CHATHISTORY_FEDERATION` feature flag (default: TRUE)
- [x] `should_federate()` - decides when to query other servers
- [x] `struct FedRequest` - tracks pending federation requests
- [x] `start_fed_query()` - sends CH Q to all linked servers
- [x] `ms_chathistory()` - handles S2S federation (CH Q/R/E)
- [x] Message merging from local + federated results
- [x] Timeout handling for unresponsive servers

**Does NOT depend on Redis** - uses P10 S2S protocol

---

### 26. Full SQLite SAXDB Replacement

**Source**: `docs/plans/X3_STORAGE_BACKEND_PLAN.md` Option B
**Status**: Documented alternative, not planned
**Effort**: 40-60 hours

Replace all SAXDB with SQLite database:
- Full SQL query capability
- Better for complex queries (e.g., "find all accounts registered this week")
- Higher implementation effort than hybrid LMDB approach

**Decision**: Hybrid LMDB was chosen instead.

---

### 27. SASL EXTERNAL Certificate Expiration Warnings

**Source**: `docs/plans/SASL_EXTERNAL_KEYCLOAK_PLAN.md`
**Status**: Designed, not implemented
**Effort**: 4-6 hours

- Store certificate expiration dates
- Warn users before expiry (30 days)
- Optionally block auth with expired certs

**Depends On**: ~~SASL EXTERNAL implementation (#1)~~ - Base implemented

---

### 28. Fingerprint Migration Script

**Source**: `docs/plans/SASL_EXTERNAL_KEYCLOAK_PLAN.md`
**Status**: Script documented, not created
**Effort**: 2-4 hours

`scripts/migrate-certfp-to-keycloak.sh`:
- Read existing fingerprints from X3 DB
- Create Keycloak user attributes

**Depends On**: ~~SASL EXTERNAL implementation (#1)~~ - Base implemented, `kc_sync_fingerprints()` exists

---

## Implementation Roadmap Recommendation

### Phase A: Stability & Quality (1-2 weeks remaining)
1. ~~Test Infrastructure~~ - Partially done, finish timeout constants (#8)
2. ~~Test Documentation~~ - Partially done, add inline comments (#9)
3. ~~X3 Crash Investigation~~ - **Completed!** (optional ASAN if crashes persist)
4. Password Hash Migration Tool (#7)

### Phase B: Authentication Enhancements (2-3 weeks effort)
1. ~~SASL EXTERNAL with Keycloak~~ - **Already implemented!**
2. Session Tokens (#4, #5, #6) - Would reduce Keycloak load
3. Keycloak Webhook (#3)
4. Certificate auto-registration (#22) - Easy add-on to existing ADDCERTFP

### Phase C: Storage Enhancements (As needed)
1. ~~Channel History Federation~~ - **Already implemented!**
2. Make SAXDB Optional (#2) - When LMDB proves stable
3. ~~Redis Pub/Sub~~ - **Deferred** (single X3 sufficient)

### Phase D: Polish & Deferred (As needed)
- Argon2 Support (#16)
- Static Analysis (#19)
- MD5 Deprecation (#17)
- CERT LIST/SEARCH commands (minor additions to existing cert infrastructure)

---

## Files Cross-Reference

| File | Items |
|------|-------|
| `.claude/plans/password-hashing-upgrade.md` | #7, #16, #17 |
| `.claude/plans/x3-keycloak-optimization.md` | #3, #4, #5, #6 |
| `.claude/plans/test-stability-investigation.md` | #8, #9 |
| `.claude/plans/test-failures-investigation.md` | #10, #11 |
| `.claude/plans/x3-code-quality-audit.md` | #18, #19 |
| `.claude/plans/metadata-leverage-plan.md` | #2 |
| `.claude/plans/redis-investigation.md` | #23 (deferred) |
| `docs/plans/X3_STORAGE_BACKEND_PLAN.md` | #23, #24, #26 |
| `docs/plans/SASL_EXTERNAL_KEYCLOAK_PLAN.md` | #1, #21, #22, #27, #28 |
| `docs/plans/METADATA_ENHANCEMENT_PLAN.md` | #12, #13 |
| `docs/investigations/EVENT_PLAYBACK_INVESTIGATION.md` | #14 |
| `docs/investigations/CHATHISTORY_INVESTIGATION.md` | #15 |
| `docs/investigations/WEBSOCKET_INVESTIGATION.md` | #20 |
| `IRCV3_PROJECT_STATUS.md` | #23, #25 |

---

## What's COMPLETE (Not Listed Above)

The following major features are fully implemented:
- IRCv3.2+ capabilities in Nefarious (all 22+ phases)
- LMDB storage backend (Phases 1-6 of metadata-leverage-plan)
- Chathistory with LMDB
- Event Playback
- Metadata extension (all 6 phases)
- WebSocket native support
- Web Push (via X3)
- Pre-Away extension
- Multiline messages
- Message redaction
- Channel rename
- Extended ISUPPORT
- Read markers
- Account registration
- All client-only tags (+reply, +react, +channel-context)
- Password hashing upgrade (PBKDF2, bcrypt) - Phases 1-6
- LMDB Snapshots, JSON Export, TTL Purge (Phase 6.2)
- **SASL EXTERNAL with Keycloak** - Full implementation including:
  - `loc_auth_external()` fingerprint authentication
  - Async Keycloak fingerprint lookup (`keycloak_find_user_by_fingerprint_async`)
  - `kc_sync_fingerprints()` for Keycloak attribute sync
  - NickServ `ADDCERTFP`/`DELCERTFP` commands
  - LMDB fingerprint caching with TTL
  - Fingerprint collision detection
- **Metadata Write Queue** - Queues writes when X3 unavailable, replays on reconnect
- **ChanServ/Keycloak Bidirectional Sync** - Full two-way sync of access levels to groups
- **TAGMSG History Storage** - `store_tagmsg_history()` stores client-only tags for event-playback
- **DM/Private Message History** - Full implementation with consent modes (disabled by default)
- **Argon2id Detection** - Can detect Argon2id hashes (actual hashing may need library)
- **Channel History Federation** - Full S2S federation via P10 CH Q/R/E protocol
