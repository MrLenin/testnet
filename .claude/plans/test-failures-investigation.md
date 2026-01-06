# Test Failures Investigation Plan

## Summary
15 test failures remaining after WebSocket and ML token fixes. Investigation reveals several categories with different root causes.

## Test Failure Categories

### 1. OpServ Oper Level (4 failures) ✅ FIXED
**Tests**: should report higher access, GLINE, UNGLINE, force-join
**Error**: `expected 0 >= 100` or `expected 0 >= 200`

**Root Cause**: testadmin not having olevel 1000 due to:
1. SAXDB doesn't persist immediately - olevel lost on restart
2. testadmin must be registered FIRST to get olevel 1000
3. Keycloak auto-create (via AUTH) creates account with olevel 0

**Fix Applied**:
✅ Complete fix for testadmin olevel 1000:
1. Start with email_enabled=0 in x3.conf (no cookie needed for first account)
2. x3-ensure-admin.sh deletes leftover testadmin from Keycloak first
3. REGISTER testadmin (auto-authenticates, gets olevel 1000 as first registrant)
4. WRITEALL to persist immediately
5. Enable email in x3.conf
6. REHASH to apply email verification for future users
7. cleanup-tests.ts now runs after tests (posttest) to clean up Keycloak test users

**Result**: 11/12 OpServ tests now pass. Verified testadmin has olevel 1000.

**Remaining Issue**: `should respond to HELP command` test fails
- File: `src/services/opserv.test.ts:56-63`
- Error: `expected 0 to be greater than 0` (no lines received)

**Analysis**: The `serviceCmd()` method in x3-client.ts (line 87-117):
1. Clears buffer, sends command, then collects NOTICE responses
2. Filters lines for `x3.services` or service name prefix
3. Has 2-second individual line timeout, 10-second overall timeout

**Possible causes**:
- O3 might not respond to HELP from non-authenticated users
- Response format might not match filter pattern
- Response arrives before collection loop starts (race condition)

**Fix options**:
1. Test if O3 HELP works for anonymous users manually
2. Increase individual line timeout from 2s to 3s
3. Add small delay before sending command to ensure buffer is ready

---

### 2. SASL Failures (4 failures)
**Tests**: 904 invalid credentials (x2), ACCOUNT message after SASL (x2)
**Error**: Timeout waiting for 90x responses

**Possible Causes**:
- SASL handler timing out during Keycloak communication
- Invalid credentials not being rejected promptly
- testuser credentials not set up correctly in Keycloak

**Investigation Needed**:
- [ ] Test SASL PLAIN manually with testuser/testpass
- [ ] Check X3 logs for SASL processing
- [ ] Verify testuser exists in Keycloak with correct password

---

### 3. Chat History (2 failures) ⚠️ INTERMITTENT
**Tests**: NOTICE stored in history, paginate AFTER with msgid
**Error**: Timeout waiting for BATCH response

**Status**: Tests pass in isolation but failures appear intermittently in full suite runs.
**Likely cause**: PM consent mechanics making tests timing-sensitive.

---

### 4. Keycloak Channel Groups (2 failures) ⚠️ INTERMITTENT
**Tests**: create hierarchical groups, add user to group
**Error**: `expected false to be true`, null reference

**Status**: Tests pass in isolation but failures appear intermittently in full suite runs.

---

### 5. ChanServ Registration (1 failure)
**Test**: should register a channel when authenticated and opped
**File**: `src/services/chanserv.test.ts:55-87`
**Error**: `expected false to be true` at `chanResult.success`

**Analysis**: The `registerChannel()` method in x3-client.ts (line 303-358):
1. Sends `PRIVMSG ChanServ :REGISTER #channel`
2. Watches for ChanServ JOIN (success) or NOTICE with error
3. Returns success=false if neither received in 10 seconds

**Possible causes**:
- User doesn't have ops in channel (required for registration)
- First user to join empty channel should get ops automatically
- Timing issue - ops granted after registration attempt

**Fix options**:
1. Verify user has ops before calling registerChannel
2. Wait for MODE message (not just JOIN) before registering
3. Add explicit op check via NAMES before registration

---

### 6. Misc (3 failures)
**Tests**: PART, error format, hostmask

**Investigation Needed**:
- [ ] Check PART echo-message handling
- [ ] Verify service command response parsing
- [ ] Check hostmask registration flow

---

## Priority Order

1. ✅ **OpServ failures** - FIXED (11/12 pass, 1 timing issue in HELP test)
2. **O3 HELP** - Response collection timing issue (serviceCmd)
3. **ChanServ registration** - Ops timing issue (need to wait for MODE)
4. ⚠️ **Chat History** - Intermittent, likely PM consent timing
5. ⚠️ **Keycloak groups** - Intermittent
6. **Misc** - 3 tests, various causes
7. **SASL failures** - 4 tests, save for last (may be complex/annoying)

## 4x Test Run Results

| Run | Failures | Pattern |
|-----|----------|---------|
| 1 | ~3 | Cleanest - PART, ChanServ reg, Keycloak auth |
| 2 | ~15 | Cascading failures |
| 3 | ~15 | Same as Run 2 |
| 4 | ~15 | Same as Runs 2-3 |

**Key finding:** Run 1 starts clean, subsequent runs accumulate failures.

**Root cause:** Cleanup between runs not fully resetting state:
- Leftover X3 accounts from Run 1 cause `expected false to be true` in registration tests
- Leftover channels cause ChanServ tests to fail
- O3 HELP timing issue consistent (`expected 0 to be greater than 0`)

**Consistent failures across all runs:**
1. O3 HELP test - timing/response collection
2. PART test - response format issue
3. Keycloak auth - may need testuser setup

**Fix priority:**
1. ✅ Fix cleanup script to properly remove test data between runs
   - Updated cleanup-tests.ts to default to testadmin/testadmin123 credentials
   - Now O3 commands work without explicit env vars
2. ✅ Fix O3 HELP timing in serviceCmd()
   - Added 100ms delay after sending command before collecting responses
   - Increased individual line timeout from 2s to 3s
3. Fix ChanServ registration (wait for MODE before register)

## Test Flakiness Commands

Run tests 4 times to capture intermittent failures:
```bash
cd /home/ibutsu/testnet/tests
for i in 1 2 3 4; do
  echo "=== Run $i ===" | tee -a /tmp/test-summary.log
  IRC_HOST=localhost npm test -- --reporter=verbose 2>&1 | tee /tmp/test-run$i.log
  grep -E "FAIL|expected|AssertionError" /tmp/test-run$i.log | head -20 >> /tmp/test-summary.log
  echo "---" >> /tmp/test-summary.log
done
cat /tmp/test-summary.log
```

## Key Questions to Answer

1. ✅ Does testadmin have opserv_level=1000 in X3 memory/SAXDB? **YES - verified with O3 ACCESS**
2. ✅ Does O3 ACCESS require IRC oper (+o) mode, X3 opserv_level, or both? **BOTH required**
3. Is SASL PLAIN working at all with valid credentials?
4. Are these test infrastructure issues or actual server bugs?

---

## X3 Crash Investigation

**Kernel logs show multiple segfaults:**
```
x3: segfault at 92 ip ...d3d40 in x3[...+e2000]  -> sar_fd_readable (sar.c)
x3: segfault at 0 ip ...51d3 in x3[...+e2000]   -> modcmd_register
x3: segfault at 0 ip ...8d5 in x3[...+e6000]    -> modcmd_register (multiple)
x3: segfault at 0 ip ...664 in x3[...+e6000]    -> modcmd_register
```

**Two crash locations identified:**
1. `modcmd_register` (modcmd.c) - NULL pointer dereferences (address 0)
2. `sar_fd_readable` (sar.c) - accessing address 0x92 (146 bytes from NULL)

**Root cause hypotheses:**
- modcmd_register: NULL `module` or `module->commands` passed to function
- sar_fd_readable: NULL struct pointer with member at offset 146

**Core dump collection enabled:**
- docker-compose.yml: ulimits.core set to unlimited
- x3 entrypoint: runs from /x3/cores directory (but X3 does chdir(PREFIX) overriding this)
- Host directory: ./x3cores mounted to /x3/cores
- **Kernel core_pattern set:** `/home/ibutsu/testnet/x3cores/core.%e.%p.%t`

**Key findings:**
- X3 does `chdir(PREFIX)` in main.c:124, overriding entrypoint's cd to /x3/cores
- Crashes correlate with "debug: Checking for expired bans" log (may be coincidence)
- modcmd_register crashes suggest NULL module pointer (could be Python extension issue)
- sar_fd_readable crash at offset 146 bytes doesn't match known struct sizes

**Next steps:**
1. ✅ Set kernel core_pattern to absolute path
2. ✅ Ran tests - crash occurred but no core dump (Docker/WSL path issues)
3. **Pending**: Build X3 with ASAN or use Valgrind

**Observations from crash:**
- Memory corruption suspected - random crash locations, corrupted data structures
- Prior memory corruption bugs were fixed (caefbc6) suggesting pattern of issues

**Note**: The "COOKIE is an unknown command" error observed during testing was a **separate issue**
from the crashes - these two problems happened to be investigated simultaneously but are unrelated.
Afternet has used cookie auth for years without issues, so command table corruption was not the cause.

**Recent suspicious commits:**
- `d8d6596` SASL async hardening - 674 lines changed in session management
- `e2b2f41` account_func callback list - changed single callback to list pattern
- `20c9bc0` Keycloak async HTTP - async operation changes

**Recommended debugging approaches:**
1. **ASAN build** (preferred): Add `-fsanitize=address -fno-omit-frame-pointer` to CFLAGS
2. **Valgrind**: Run X3 under Valgrind to detect memory errors
3. **Git bisect**: Find when crashes started by testing older commits
4. **Add defensive NULL checks**: To modcmd_register and sar_fd_readable
