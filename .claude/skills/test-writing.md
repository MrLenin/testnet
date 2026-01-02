# Test Writing Skill

Comprehensive guide for writing tests in the Afternet testnet project. Covers TypeScript integration tests (Vitest) and C unit tests (CMocka).

## Test Architecture Overview

```
tests/                              # TypeScript integration tests
├── src/
│   ├── helpers/                    # Test utilities and clients
│   ├── services/                   # X3 service tests
│   ├── ircv3/                      # IRCv3 capability tests
│   ├── core-commands.test.ts       # Basic IRC command tests
│   └── setup/                      # Test setup and global config
└── vitest.config.ts

nefarious/ircd/test/                # C unit tests (CMocka)
├── *_cmocka.c                      # CMocka test files
├── Makefile                        # Build CMocka tests
└── run-tests.sh                    # Run all tests
```

---

## Part 1: TypeScript Integration Tests (Vitest)

### Running Tests

```bash
cd tests

# Run specific test file
IRC_HOST=localhost npm test -- src/services/authserv.test.ts

# Run with verbose output
IRC_HOST=localhost npm test -- --reporter=verbose src/services/

# Run specific test by name
IRC_HOST=localhost npm test -- "should register a channel"

# IMPORTANT: Do NOT run the full test suite - it takes 5+ minutes
```

### Helper Imports

All helpers are exported from `../helpers/index.js`:

```typescript
import {
  // === IRC Clients ===
  TestIRCClient, createTestClient,           // Basic IRC client
  IRCv3TestClient, createIRCv3Client,        // IRCv3 CAP-aware client
  RawSocketClient, createRawSocketClient,    // Low-level socket client

  // === X3 Service Client ===
  X3Client, createX3Client,                  // Regular non-privileged client
  createOperClient,                          // Privileged O3 access (olevel 1000)
  createAuthenticatedX3Client,               // SASL-authenticated client
  createTestAccount,                         // Creates unique account credentials
  ACCESS_LEVELS,                             // OWNER=500, COOWNER=400, etc.
  X3_ADMIN, IRC_OPER,                        // Admin credentials

  // === Unique ID Generation ===
  uniqueId,                                  // Random 8-char hex string
  uniqueChannel,                             // #test-<uniqueId>
  uniqueNick,                                // nick-<uniqueId>

  // === CAP Bundles ===
  CAP_BUNDLES, getCaps, getMergedCaps,       // Capability request helpers

  // === Message Parsing ===
  parseIRCMessage, ParsedMessage,            // Structured message parsing
  assertPrivmsg, assertNumeric,              // Message assertions
  assertJoin, assertMode, assertKick,
  getMessageText, getServerTime, getMsgId,   // Value extractors

  // === P10 Protocol ===
  parseP10Message, parseBurst, parseNick,    // P10 message parsing
  getP10Logs, getBurstLogs,                  // Docker log parsing
  validateBurstOrder, BurstPhase,            // Burst validation
  compareTimestamps, nickCollisionWinner,    // TS rules
  encodeIP, decodeIP,                        // IP encoding

  // === Multi-Server ===
  SERVERS, TOPOLOGY,                         // Server definitions
  createMultiServerClients,                  // Connect to multiple servers
  waitForCrossServerSync,                    // Wait for propagation
  getAvailableServers, isServerAvailable,    // Server availability checks

  // === Keycloak ===
  isKeycloakAvailable, checkKeycloakAvailable,
} from '../helpers/index.js';
```

### Test Patterns

#### Basic Service Test

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { X3Client, createX3Client, createTestAccount, uniqueChannel } from '../helpers/index.js';

describe('MyFeature', () => {
  const clients: X3Client[] = [];

  const trackClient = (client: X3Client): X3Client => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try { client.send('QUIT'); client.close(); } catch {}
    }
    clients.length = 0;
  });

  it('should do something', async () => {
    const client = trackClient(await createX3Client());
    const { account, password, email } = await createTestAccount();

    await client.registerAndActivate(account, password, email);
    await client.auth(account, password);

    const result = await client.serviceCmd('ChanServ', 'HELP');
    expect(result.length).toBeGreaterThan(0);
  });
});
```

#### Privileged Operations Test

```typescript
import { createOperClient } from '../helpers/index.js';

it('should perform oper command', async () => {
  const client = trackClient(await createOperClient());

  // createOperClient() returns a client authenticated as X3_ADMIN (olevel 1000)
  const level = await client.myAccess();
  expect(level).toBe(1000);

  // Now test oper commands (GLINE, KILL, etc.)
  const glineResult = await client.gline('*!*@test.example', '1h', 'Test ban');
  expect(glineResult.success).toBe(true);
});
```

#### IRCv3 CAP Test

```typescript
import { createIRCv3Client, CAP_BUNDLES, getCaps } from '../helpers/index.js';

it('should negotiate capabilities', async () => {
  const client = trackClient(await createIRCv3Client({
    caps: getCaps('messaging'),  // Gets ['message-tags', 'server-time', 'echo-message']
  }));

  expect(client.caps.has('message-tags')).toBe(true);
});
```

#### Multi-Server Test

```typescript
import { createMultiServerClients, waitForCrossServerSync, SERVERS } from '../helpers/index.js';

it('should sync across servers', async () => {
  const { primary, secondary } = await createMultiServerClients('user1', 'user2');
  trackClient(primary);
  trackClient(secondary);

  primary.send('JOIN #test');

  // Wait for join to propagate to secondary
  const syncResult = await waitForCrossServerSync(secondary, /JOIN.*#test/, 5000);
  expect(syncResult).toBeTruthy();
});
```

### X3Client Methods Reference

```typescript
// === Service Communication ===
await client.serviceCmd('AuthServ', 'HELP');              // Send command, get response lines
await client.waitForServiceNotice('ChanServ', /pattern/); // Wait for specific notice

// === AuthServ ===
await client.registerAccount(account, password, email);   // Register (needs activation)
await client.registerAndActivate(account, pass, email);   // Register + auto-activate
await client.auth(account, password);                     // Authenticate
await client.activateAccount(account, cookie);            // Activate with cookie
await client.uset(option, value);                         // Set user option
await client.addMask(hostmask);                           // Add auth hostmask
await client.checkAuth();                                 // Returns { authenticated, account }

// === ChanServ ===
await client.registerChannel('#channel');                 // Register channel (must be opped)
await client.addUser('#channel', account, level);         // Add user to access list
await client.clvl('#channel', account, newLevel);         // Change user level
await client.delUser('#channel', account);                // Remove user access
await client.getAccess('#channel');                       // Returns [{account, level}, ...]
await client.set('#channel', option, value);              // Set channel option
await client.ban('#channel', mask, reason);               // Add LAMER (persistent ban)
await client.unban('#channel', mask);                     // Remove ban/LAMER

// === OpServ (O3) - requires createOperClient() ===
await client.myAccess();                                  // Get oper level (0-1000)
await client.gline(mask, duration, reason);               // Add network ban
await client.ungline(mask);                               // Remove network ban
await client.forceJoin(nick, channel);                    // Force user to join
```

### Message Parser Usage

```typescript
import { parseIRCMessage, assertPrivmsg, assertNumeric } from '../helpers/index.js';

it('should parse messages correctly', async () => {
  const line = ':nick!user@host PRIVMSG #channel :hello world';
  const msg = parseIRCMessage(line);

  // Check command
  expect(msg.command).toBe('PRIVMSG');
  expect(msg.params[0]).toBe('#channel');
  expect(msg.params[1]).toBe('hello world');

  // Or use assertion helpers
  assertPrivmsg(line, '#channel', 'hello world');
});

it('should check numeric responses', async () => {
  const response = await client.waitForLine(/353|366/, 5000);
  assertNumeric(response, 353);  // RPL_NAMREPLY
});
```

### CAP Bundles

```typescript
const CAP_BUNDLES = {
  messaging: ['message-tags', 'server-time', 'echo-message'],
  batching: ['batch', 'labeled-response', 'message-tags'],
  chathistory: ['draft/chathistory', 'batch', 'server-time', 'message-tags'],
  sasl: ['sasl'],
  metadata: ['draft/metadata', 'message-tags'],
};

// Usage
import { getCaps, getMergedCaps } from '../helpers/index.js';

getCaps('messaging');                        // ['message-tags', 'server-time', 'echo-message']
getMergedCaps('messaging', 'sasl');          // [...messaging, 'sasl']
getMergedCaps('chathistory', ['custom-cap']); // [...chathistory, 'custom-cap']
```

### X3 Command Gotchas

**1. Name Resolution**: X3 interprets names as nicks by default. Use `*` prefix for account names:
```typescript
await client.addUser('#chan', 'username', 200);      // Targets NICK
await client.addUser('#chan', '*accountname', 200);  // Targets ACCOUNT
```
The X3Client methods handle this automatically.

**2. BAN vs ADDLAMER**:
- `BAN`: Temporary channel ban (ephemeral)
- `ADDLAMER`: Persistent ban that re-bans returning users

**3. SET Options**: Not all options exist. Check X3 docs or use `SET #chan` to list.

**4. Timing**: Add delays after JOIN before channel operations:
```typescript
client.send(`JOIN ${channel}`);
await client.waitForLine(/JOIN/i, 5000);
await new Promise(r => setTimeout(r, 500));  // Let modes settle
await client.registerChannel(channel);
```

### Access Levels

```typescript
const ACCESS_LEVELS = {
  OWNER: 500,
  COOWNER: 400,
  MANAGER: 300,
  OP: 200,
  HALFOP: 100,
  VOICE: 50,
  PEON: 1,
};
```

---

## Part 2: C Unit Tests (CMocka)

### Location and Structure

CMocka tests are in `nefarious/ircd/test/`:

```
nefarious/ircd/test/
├── ircd_string_cmocka.c      # String utility tests
├── ircd_in_addr_cmocka.c     # IP address tests
├── ircd_crypt_cmocka.c       # Encryption tests
├── numnicks_cmocka.c         # Numeric handling tests
├── history_cmocka.c          # Chat history tests
├── crule_cmocka.c            # Connection rule tests
├── dbuf_cmocka.c             # Data buffer tests
├── ircd_compress_cmocka.c    # Compression tests
├── ircd_cloaking_cmocka.c    # Host cloaking tests
├── ircd_chattr_cmocka.c      # Character attribute tests
├── ircd_match_cmocka.c       # Pattern matching tests
├── test_stub.c               # Stub functions for linking
└── Makefile
```

### Building CMocka Tests

```bash
# Build all CMocka tests (requires libcmocka-dev)
cd nefarious/ircd/test
make cmocka

# Build specific test
make ircd_string_cmocka
```

### Running CMocka Tests

```bash
# Run specific test
./ircd_string_cmocka

# Run inside Docker container
docker exec nefarious /ircd/ircd/test/ircd_string_cmocka
```

### CMocka Test Pattern

```c
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include "ircd_string.h"  // Header for functions being tested

/* ========== Test Group: ircd_strncpy ========== */

static void test_ircd_strncpy_normal(void **state)
{
    (void)state;  // Unused parameter
    char dest[32];

    ircd_strncpy(dest, "hello", sizeof(dest));
    assert_string_equal(dest, "hello");
}

static void test_ircd_strncpy_truncation(void **state)
{
    (void)state;
    char dest[8];

    ircd_strncpy(dest, "hello world", sizeof(dest) - 1);
    assert_int_equal(strlen(dest), 7);
}

/* ========== Test Group: ircd_strcmp ========== */

static void test_ircd_strcmp_equal(void **state)
{
    (void)state;

    assert_int_equal(0, ircd_strcmp("hello", "hello"));
    assert_int_equal(0, ircd_strcmp("hello", "HELLO"));  // IRC is case-insensitive
}

static void test_ircd_strcmp_not_equal(void **state)
{
    (void)state;

    assert_int_not_equal(0, ircd_strcmp("hello", "world"));
}

/* ========== Main ========== */

int main(void)
{
    const struct CMUnitTest tests[] = {
        /* ircd_strncpy tests */
        cmocka_unit_test(test_ircd_strncpy_normal),
        cmocka_unit_test(test_ircd_strncpy_truncation),

        /* ircd_strcmp tests */
        cmocka_unit_test(test_ircd_strcmp_equal),
        cmocka_unit_test(test_ircd_strcmp_not_equal),
    };

    return cmocka_run_group_tests(tests, NULL, NULL);
}
```

### CMocka Assertions

```c
// Basic assertions
assert_true(condition);
assert_false(condition);
assert_null(ptr);
assert_non_null(ptr);

// Numeric comparisons
assert_int_equal(expected, actual);
assert_int_not_equal(a, b);

// String comparisons
assert_string_equal(expected, actual);
assert_string_not_equal(a, b);

// Memory comparisons
assert_memory_equal(expected, actual, size);
assert_memory_not_equal(a, b, size);

// Pointer equality
assert_ptr_equal(expected, actual);
assert_ptr_not_equal(a, b);

// Range checks
assert_in_range(value, min, max);
assert_not_in_range(value, min, max);
```

### CMocka Setup/Teardown

```c
static int group_setup(void **state)
{
    /* Called once before all tests in the group */
    struct test_data *data = malloc(sizeof(struct test_data));
    *state = data;
    return 0;  // Return 0 for success
}

static int group_teardown(void **state)
{
    /* Called once after all tests in the group */
    free(*state);
    return 0;
}

static int test_setup(void **state)
{
    /* Called before each test */
    struct test_data *data = *state;
    data->counter = 0;
    return 0;
}

static int test_teardown(void **state)
{
    /* Called after each test */
    return 0;
}

int main(void)
{
    const struct CMUnitTest tests[] = {
        cmocka_unit_test_setup_teardown(test_something, test_setup, test_teardown),
    };

    return cmocka_run_group_tests_name("my_tests", tests, group_setup, group_teardown);
}
```

### Makefile Target for New CMocka Test

Add to `nefarious/ircd/test/Makefile`:

```makefile
# Add to CMOCKA_TESTPROGS
CMOCKA_TESTPROGS = \
    ... \
    my_new_cmocka

# Add build rule
my_new_cmocka: my_new_cmocka.c test_stub.o
    $(CC) $(CFLAGS) $(CPPFLAGS) -o $@ $< test_stub.o ../libinput.a $(CMOCKA_LIBS) $(LDFLAGS)
```

---

## Debugging Tips

### TypeScript Tests
1. Use `console.log('Response:', result.lines)` to see X3 responses
2. Check X3 logs: `docker logs x3 2>&1 | tail -50`
3. Use `scripts/irc-test.sh` for quick manual testing
4. If flaky, add delays or increase timeouts

### CMocka Tests
1. Run with `--verbose` or check test output
2. Use `print_message()` for debug output (CMocka macro)
3. Check that test_stub.c has required stub functions
4. Verify linking includes required `.a` libraries

### Common Issues
- **Empty serviceCmd response**: Check `serviceCmd()` filtering - only x3.services responses are captured
- **Account activation fails**: Email verification enabled - use `registerAndActivate()`
- **CMocka build fails**: Install `libcmocka-dev` and ensure headers are in path
