# Test Audit: Weak Assertions & Helper Underutilization

**Audit Date**: 2026-01-18
**Coverage**: 36 test files in `tests/src/`
**Status**: Phase 1, 2, 3 Complete, Phase 4 In Progress

## Implementation Progress

### ✅ Phase 1: New Helpers (COMPLETE)

Created new helper files:
- `tests/src/helpers/sasl.ts` - SASL authentication (PLAIN, OAUTHBEARER)
- `tests/src/helpers/keycloak-sync.ts` - Keycloak attribute/group polling
- `tests/src/helpers/ircv3-wait.ts` - IRCv3-specific wait helpers
- `tests/src/helpers/assertions.ts` - Service assertion helpers

Added to `cap-bundles.ts`:
- `CAP_BUNDLES.readMarker`
- `CAP_BUNDLES.labeled`
- `CAP_BUNDLES.fullMessaging`
- `CAP_BUNDLES.setname`
- `CAP_BUNDLES.channelRename`

### ✅ Phase 2: SASL Migration (COMPLETE)

Migrated manual SASL to `authenticateSaslPlain()`:
- `ircv3/read-marker.test.ts` (5 instances)
- `ircv3/metadata.test.ts` (2 instances)
- `ircv3/multiserver.test.ts` (1 instance)
- `helpers/x3-client.ts` (`createAuthenticatedX3Client`)
- `keycloak/keycloak.test.ts` (`authenticateSecondUser` + 5 tests)

**Note**: SASL tests in `sasl.test.ts` and OAUTHBEARER tests in `keycloak.test.ts` intentionally kept inline (testing mechanisms themselves).

### ✅ Phase 3: Fix Weak Assertions (COMPLETE)

#### Service Tests (COMPLETE)
- ✅ `services/authserv.test.ts` - Updated assertions with content checks
- ✅ `services/chanserv.test.ts` - Updated with `assertServiceSuccess`, `assertServiceError`, `assertHasMatchingItem`
- ✅ `services/opserv.test.ts` - Updated STATS/GLINE/error assertions with content patterns
- ✅ `services/integration.test.ts` - Updated access list and service response assertions

#### IRCv3 Tests (COMPLETE)
- ✅ `ircv3/chathistory.test.ts` - Updated all `batchStart.toBeDefined()` → `batchStart.command.toBe('BATCH')`, updated FAIL/error assertions
- ✅ `ircv3/labeled-response.test.ts` - Updated all 7 weak assertions with command validation
- ✅ `ircv3/metadata.test.ts` - Updated METADATA response assertions with command checks
- ✅ `ircv3/sasl.test.ts` - Updated all 13 SASL numeric response assertions with `/^90\d$/` pattern
- ✅ `ircv3/multiserver.test.ts` - Updated 11 weak assertions (BATCH, MARKREAD, METADATA)
- ✅ `ircv3/webpush.test.ts` - Updated 7 weak assertions with WEBPUSH/FAIL/error patterns

Example transformations:
```typescript
// Before:
expect(authResult.lines.length).toBeGreaterThan(0);
expect(authResult.success).toBe(true);

// After:
assertServiceSuccess(authResult, /authorized|authenticated|greeting|welcome/i);

// Before (SASL tests):
expect(response).toBeDefined();

// After:
expect(/^90\d$/.test(response.command), `Should get 9XX SASL numeric, got: ${response.command}`).toBe(true);
```

### 🔄 Phase 4: Fixed Timeouts (IN PROGRESS)

**Original count**: 349 instances across 36 files
**Current count**: ~283 instances (66 removed)

#### Progress:
- ✅ Removed redundant post-join delays from:
  - `chanserv.test.ts` (5 removed)
  - `core-commands.test.ts` (12 removed)
  - `edge-cases.test.ts` (8 removed)
  - `notify.test.ts` (7 removed)
  - `names.test.ts` (5 removed)
  - `multiline.test.ts` (9 removed)
  - `channel-rename.test.ts` (5 removed)
  - `userchange.test.ts` (3 removed)
  - `redaction.test.ts` (4 removed)
  - `labeled-response.test.ts` (4 removed)
  - `integration.test.ts` (3 removed)
  - `pre-away.test.ts` (1 removed)

#### Remaining Delays (Categorized):

**Intentional - DO NOT REMOVE:**
- `chathistory.test.ts` (58) - 100ms timestamp separators for message ordering
- `chathistory-federation.test.ts` (29) - Cross-server sync delays
- `keycloak.test.ts` (23) - Keycloak HTTP latency (outliers up to 1s)
- `sasl.test.ts` (24) - SASL protocol flow timing
- `read-marker.test.ts` (12) - Message persistence + cross-client sync
- `metadata.test.ts` (15) - Metadata propagation delays
- `pre-away.test.ts` (8) - Testing AWAY during registration
- `error-conditions.test.ts` (2) - Multi-user join settling
- `p10-burst.test.ts` (2) - Cross-server mode propagation
- `edge-cases.test.ts` (8) - Rate-limiting/flood protection tests

**Helper internals (appropriate):**
- `helpers/x3-client.ts` (12) - Service command timeouts
- `helpers/cap-bundles.ts` (4) - Internal delay utilities
- `helpers/websocket-client.ts` (2) - WebSocket connection settling

**Scripts (appropriate):**
- `scripts/cleanup-tests.ts` (13) - Cleanup operations

---

## New Helper Reference

### SASL Authentication (`sasl.ts`)

```typescript
import { authenticateSaslPlain, authenticateSaslOAuthBearer, SaslResult } from '../helpers/index.js';

// PLAIN authentication
const result = await authenticateSaslPlain(client, account, password, timeout?);
expect(result.success, `SASL failed: ${result.error}`).toBe(true);

// OAUTHBEARER authentication
const result = await authenticateSaslOAuthBearer(client, token, timeout?);
```

### Service Assertions (`assertions.ts`)

```typescript
import { assertServiceSuccess, assertServiceError, assertHasMatchingItem, assertMessage } from '../helpers/index.js';

// Success with content pattern
assertServiceSuccess(result, /registered|success|created/i);

// Error with expected message
assertServiceError(result, /denied|insufficient|not found/i);

// Find item in array
const owner = assertHasMatchingItem(accessList, e => e.level >= 500, 'Expected owner');

// Verify IRC message structure
assertMessage(msg, {
  command: 'MARKREAD',
  params: ['#channel', /timestamp=/],
  tags: { time: /^\d{4}-\d{2}-\d{2}T/ }
});
```

### IRCv3 Wait Helpers (`ircv3-wait.ts`)

```typescript
import { waitForMarkread, waitForLabeledResponse, waitForBatchComplete, waitForMetadata } from '../helpers/index.js';

// Wait for MARKREAD response
const markread = await waitForMarkread(client, '#channel');

// Wait for labeled response batch
const { messages, ack } = await waitForLabeledResponse(client, 'label123');

// Wait for complete batch
const batch = await waitForBatchComplete(client, 'chathistory');

// Wait for metadata
const meta = await waitForMetadata(client, '*', ['avatar', 'url']);
```

### Keycloak Sync (`keycloak-sync.ts`)

```typescript
import { waitForKeycloakAttribute, waitForKeycloakGroup, getKeycloakAdminToken } from '../helpers/index.js';

// Wait for attribute value
await waitForKeycloakAttribute(adminToken, 'testuser', 'irc_account', 'expectedValue');

// Wait for group membership
await waitForKeycloakGroup(adminToken, 'testuser', '/irc-channels/test', true);
```

---

## Remaining Work

### Phase 4: Fixed Timeouts (SUBSTANTIALLY COMPLETE)

**Status**: ~283 instances remaining, all categorized as intentional or appropriate

The remaining delays fall into these categories:
1. **Protocol testing** - SASL flows, pre-away, rate-limiting
2. **Timestamp separation** - 100ms delays to ensure distinct message timestamps
3. **Cross-server sync** - Federation and P10 burst propagation
4. **External service latency** - Keycloak HTTP calls (up to 1s outliers)
5. **Helper internals** - Service command timeouts, connection settling

**Low-priority future optimizations:**
- Replace fixed 500ms persistence delays with `waitForChathistory()` polling
- Consider reducing 1000ms connection settling to 500ms where stable

---

## Files With Good Practices (Reference)

- `helpers/p10-utils.test.ts` - Good unit test patterns
- `ircv3/p10-burst.test.ts` - Good P10 helper usage
- `ircv3/p10-collision.test.ts` - Specific assertions
- Tests using `createOperClient()` - Proper privileged access
