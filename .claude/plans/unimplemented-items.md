# Unimplemented/Deferred Items from Plan Files

This document compiles all mentioned but not implemented features, optional phases, and future work items from the various plan files.

---

## From: password-hashing-upgrade.md

### Phase 7: Migration Tools (Optional)
**Status**: Not implemented
**Description**: Python script to analyze password hash distribution in x3.db
- Report how many accounts use each algorithm (MD5 legacy, PBKDF2, bcrypt)
- Optionally force migration for dormant accounts that haven't logged in

### Argon2 Support
**Status**: Deferred to future
**Description**: Add Argon2id algorithm support
- OpenSSL 3.2+ has native support
- Would require `libargon2-dev` on older systems
- Lower priority than PBKDF2/bcrypt which cover all current needs

### Open Questions (Unresolved)
1. Should Argon2id be supported immediately or deferred?
2. What deprecation timeline for legacy MD5 support?
3. Should bcrypt be optional or mandatory dependency?

---

## From: x3-keycloak-optimization.md

### Keycloak Webhook for Real-time Cache Invalidation
**Status**: Not implemented
**Description**:
- Fingerprint revocation, password changes, account suspension should invalidate cache immediately
- Would eliminate TTL delay for revoked credentials
- Requires Keycloak admin event listener configuration

### X3-issued Session Tokens for SASL PLAIN Optimization
**Status**: Not implemented
**Description**:
- After successful PLAIN auth, issue session token to client
- Token can be used as password in subsequent PLAIN auths
- X3 detects token format (e.g., `x3tok:...`) and validates locally
- LMDB storage: `session:<token_id>` → `username|expiry`
- No Keycloak call needed for reconnects

### SCRAM-SHA-256 for Session Tokens
**Status**: Not implemented
**Description**:
- Enhanced security over token-as-plaintext
- Use SCRAM exchange instead of direct token
- LMDB storage: `scram:<token_id>` → `salt|storedkey|serverkey|username|expiry`
- Token never sent in plaintext, replay-resistant

### Session Token Revocation
**Status**: Not implemented
**Description**:
- LMDB-backed instant revocation
- Session versioning: `session_ver:<username>` → version number
- Bump version to invalidate all tokens for a user
- Triggers: password change, LOGOUT ALL, admin suspend, webhook

---

## From: test-stability-investigation.md

### Phase 4: Test Infrastructure Improvements
**Status**: Not implemented (marked as optional)

#### Timeout Standardization
- Audit all timeout values across test files
- Create constants for common timeout scenarios:
  - `SERVICE_RESPONSE_TIMEOUT` (for X3 commands)
  - `CHATHISTORY_TIMEOUT` (for batch responses)
  - `SASL_TIMEOUT` (for authentication)
- Consider environment-based timeout multiplier for CI

#### Test Isolation
- Ensure tests clean up channels/accounts they create
- Consider unique prefixes per test file to avoid collisions
- Add retry logic for flaky service operations

#### Helper Function Improvements
- Add `waitForServiceResponse()` with configurable patterns
- Add `waitForChannelJoin()` that waits for JOIN echo
- Add `waitForBatchComplete()` for chathistory

### Phase 5: Documentation
**Status**: Not implemented
- Document known timing requirements
- Add comments to flaky tests explaining the sensitivity
- Create troubleshooting guide for test failures

---

## From: test-failures-investigation.md

### Pending Investigation Items
- [ ] Test SASL PLAIN manually with testuser/testpass
- [ ] Check X3 logs for SASL processing
- [ ] Verify testuser exists in Keycloak with correct password
- [ ] Check PART echo-message handling
- [ ] Verify service command response parsing
- [ ] Check hostmask registration flow

### X3 Crash Investigation
**Status**: Partially investigated, not resolved
- Kernel logs show segfaults in `modcmd_register` and `sar_fd_readable`
- Core dump collection configured but no dumps obtained (Docker/WSL path issues)

#### Recommended Debugging (Not Done)
1. **ASAN build**: Add `-fsanitize=address -fno-omit-frame-pointer` to CFLAGS
2. **Valgrind**: Run X3 under Valgrind to detect memory errors
3. **Git bisect**: Find when crashes started by testing older commits
4. **Add defensive NULL checks**: To modcmd_register and sar_fd_readable

---

## From: x3-code-quality-audit.md

### Future Considerations
- Add `-Wall -Wextra -Werror` to catch future issues
- Static analysis (cppcheck, scan-build) would catch many issues automatically
- LDAP code marked as "DEPRIORITIZED" - to be removed when LDAP phased out

---

## Priority Ranking

### High Value, Low Effort
1. **Phase 7: Migration Tools** - Simple Python script, provides visibility into hash migration progress
2. **Test timeout standardization** - Reduces flakiness with minimal code changes

### High Value, Medium Effort
3. **X3 Session Tokens** - Would significantly reduce Keycloak load for reconnecting clients
4. **Keycloak Webhook** - Real-time cache invalidation improves security

### Medium Value, Higher Effort
5. **Argon2 Support** - Nice to have but PBKDF2/bcrypt already cover needs
6. **SCRAM-SHA-256** - Security improvement but complex implementation

### Deferred/Low Priority
7. **LDAP cleanup** - Wait until LDAP is fully phased out
8. **X3 crash debugging** - Needs dedicated investigation session with ASAN/Valgrind
