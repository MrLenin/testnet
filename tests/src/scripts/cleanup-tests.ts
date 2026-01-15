#!/usr/bin/env npx tsx
/**
 * Cleanup script for test data
 *
 * Removes test accounts (test*) and test channels (#test-*) from X3 and Keycloak.
 * Requires IRC oper AND X3 AuthServ admin account (olevel 1000).
 *
 * Setup (first time after fresh x3.db):
 *   1. Connect as IRC oper
 *   2. /msg AuthServ REGISTER <account> <password> <email>
 *   3. First oper to register gets olevel 1000 automatically
 *
 * Usage:
 *   npm run cleanup
 *   # Or with custom credentials:
 *   X3_ACCOUNT=admin X3_PASSWORD=secret npm run cleanup
 *   # To also delete pool accounts (pool00-pool29):
 *   npm run cleanup -- --include-pool
 *
 * Environment variables:
 *   IRC_HOST       - IRC server host (default: localhost)
 *   IRC_PORT       - IRC server port (default: 6667)
 *   OPER_NAME      - IRC oper name (default: oper)
 *   OPER_PASS      - IRC oper password (default: shmoo)
 *   X3_ACCOUNT     - X3 AuthServ account with olevel 1000
 *   X3_PASSWORD    - X3 AuthServ password
 *   KEYCLOAK_URL   - Keycloak URL (default: http://localhost:8080)
 *   KEYCLOAK_REALM - Keycloak realm (default: testnet)
 *   DEBUG=1        - Enable verbose output
 */

import * as net from 'net';
import * as readline from 'readline';

const IRC_HOST = process.env.IRC_HOST || 'localhost';
const IRC_PORT = parseInt(process.env.IRC_PORT || '6667', 10);
const OPER_NAME = process.env.OPER_NAME || 'oper';
const OPER_PASS = process.env.OPER_PASS || 'shmoo';
// X3 AuthServ credentials (first oper to register gets olevel 1000)
// Default to testadmin which is created by x3-ensure-admin.sh
const X3_ACCOUNT = process.env.X3_ACCOUNT || 'testadmin';
const X3_PASSWORD = process.env.X3_PASSWORD || 'testadmin123';
// Keycloak settings
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'testnet';
const DEBUG = process.env.DEBUG === '1';
// Command line flags
const INCLUDE_POOL = process.argv.includes('--include-pool');
// Pool account pattern (pool00-pool99)
const POOL_PATTERN = /^pool\d{2}$/;

interface CleanupStats {
  accountsFound: string[];
  channelsFound: string[];
  keycloakUsersFound: string[];
  accountsDeleted: number;
  channelsDeleted: number;
  keycloakUsersDeleted: number;
  errors: string[];
}

/**
 * Clean up test users from Keycloak directly (DEPRECATED)
 *
 * NOTE: This function is no longer called automatically. X3's OUNREGISTER command
 * now handles Keycloak user deletion via kc_delete_account(). Keeping this function
 * available for manual cleanup if needed (e.g., if X3 is down but Keycloak isn't).
 *
 * Removes users matching test* pattern (but not testuser which is the main test account)
 */
async function cleanupKeycloak(stats: CleanupStats): Promise<void> {
  console.log('\n=== Keycloak Cleanup ===');

  try {
    // Get admin token
    const tokenRes = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=admin&password=admin&grant_type=password&client_id=admin-cli',
    });

    if (!tokenRes.ok) {
      console.log('Could not get Keycloak token (may not be running)');
      return;
    }

    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    // Get all users
    const usersRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?max=1000`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!usersRes.ok) {
      console.log('Could not list Keycloak users');
      return;
    }

    const users = await usersRes.json() as Array<{ id: string; username: string }>;

    // Filter to test users (test* but not testuser or testadmin)
    const testUsers = users.filter((u: { username: string }) =>
      u.username.startsWith('test') &&
      u.username !== 'testuser' &&
      u.username !== 'testadmin'
    );

    console.log(`Found ${testUsers.length} test users in Keycloak`);
    stats.keycloakUsersFound = testUsers.map((u: { username: string }) => u.username);

    if (testUsers.length === 0) {
      return;
    }

    console.log('Deleting Keycloak test users...');
    for (const user of testUsers) {
      const delRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${user.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (delRes.ok) {
        stats.keycloakUsersDeleted++;
        if (DEBUG) console.log(`  Deleted ${user.username}`);
        else process.stdout.write('.');
      } else {
        stats.errors.push(`Failed to delete Keycloak user ${user.username}`);
      }
    }
    if (!DEBUG) console.log(` Done (${stats.keycloakUsersDeleted})`);

  } catch (error) {
    console.log(`Keycloak cleanup error: ${error}`);
  }
}

async function cleanup(): Promise<void> {
  const stats: CleanupStats = {
    accountsFound: [],
    channelsFound: [],
    keycloakUsersFound: [],
    accountsDeleted: 0,
    channelsDeleted: 0,
    keycloakUsersDeleted: 0,
    errors: [],
  };

  // Note: Keycloak cleanup is now handled by X3's OUNREGISTER command
  // (via kc_delete_account), so we don't need to do it separately here.
  // Doing both would cause double-delete issues.

  console.log(`Connecting to ${IRC_HOST}:${IRC_PORT}...`);

  const socket = net.createConnection({ host: IRC_HOST, port: IRC_PORT });
  const rl = readline.createInterface({ input: socket });

  const lines: string[] = [];
  rl.on('line', (line) => {
    lines.push(line);
    if (DEBUG) console.log('<<', line);
    // Handle PING
    if (line.startsWith('PING')) {
      const token = line.split(' ')[1];
      socket.write(`PONG ${token}\r\n`);
    }
  });

  const send = (cmd: string) => {
    if (DEBUG) console.log('>>', cmd);
    socket.write(`${cmd}\r\n`);
  };

  const waitForLine = (pattern: RegExp, timeout = 5000): Promise<string> => {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (pattern.test(lines[i])) {
            resolve(lines[i]);
            return;
          }
        }
        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for ${pattern}`));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  };

  try {
    // Register
    send(`NICK cleanup_bot`);
    send(`USER cleanup cleanup localhost :Cleanup Bot`);

    await waitForLine(/001/, 10000);
    console.log('Connected.');

    // Oper up
    send(`OPER ${OPER_NAME} ${OPER_PASS}`);
    try {
      await waitForLine(/381|464/, 5000); // 381 = success, 464 = bad password
      const operLine = lines.find(l => /381|464/.test(l));
      if (operLine?.includes('464')) {
        console.error('Failed to oper up - bad credentials');
        console.error(`Set OPER_NAME and OPER_PASS environment variables`);
        send('QUIT');
        socket.end();
        return;
      }
      console.log('Opered up successfully.');
    } catch {
      console.error('Failed to oper up');
      send('QUIT');
      socket.end();
      return;
    }

    // Authenticate with AuthServ if credentials provided
    // MUST wait for auth to complete before searching (Keycloak can take 5-10s)
    if (X3_ACCOUNT && X3_PASSWORD) {
      console.log(`Authenticating with AuthServ as ${X3_ACCOUNT}...`);
      send(`PRIVMSG AuthServ :AUTH ${X3_ACCOUNT} ${X3_PASSWORD}`);
      try {
        await waitForLine(/I recognize you|authenticated/i, 15000);
        console.log('AuthServ authentication successful.');
      } catch {
        console.log('AuthServ authentication may have failed - continuing anyway.');
      }
    } else {
      console.log('No X3_ACCOUNT/X3_PASSWORD set - O3 commands will fail.');
      console.log('Set these env vars or wipe x3.db and register first oper.');
    }

    // Helper to wait for search completion (looks for "Found X Matches" line)
    // Tracks marker count to detect NEW completion markers
    const countSearchMarkers = () => lines.filter(l =>
      (l.includes('Found') && l.includes('Match')) ||
      l.includes('No matching') ||
      l.includes('Nothing matched') ||
      l.includes('0 matches')
    ).length;

    const waitForSearchComplete = async (timeout = 60000, minWait = 2000): Promise<void> => {
      const startMarkers = countSearchMarkers();
      const start = Date.now();

      // Minimum wait before checking - gives X3/Keycloak time to process
      // This prevents premature timeout when Keycloak auth delays are involved
      await new Promise(r => setTimeout(r, minWait));

      while (Date.now() - start < timeout) {
        const currentMarkers = countSearchMarkers();
        if (currentMarkers > startMarkers) {
          // New completion marker found - give time for any trailing messages
          await new Promise(r => setTimeout(r, 500));
          return;
        }
        await new Promise(r => setTimeout(r, 200));
      }
      // Timeout - continue anyway
      if (DEBUG) console.log('DEBUG: Search timeout - continuing');
      if (DEBUG) console.log(`DEBUG: lines array has ${lines.length} entries`);
    };

    // Search for test accounts using AuthServ
    // AuthServ SEARCH supports: handlemask, accountmask, account (all synonyms)
    // Use limit 500 to get more results (default may be capped)
    // Search patterns cover all test account prefixes used in the test suite
    const ACCOUNT_SEARCH_PATTERNS = [
      'test*',       // test[hex] from createTestAccount
      'bisync*',     // bisync, bisyncadd, bisyncclvl, bisyncdel
      'bisown*',     // keycloak owner accounts
      'kcauto*',     // keycloak autocreate tests
      'sl*',         // SASL tests
      'regtest*',    // account-registration tests (handles regtest_*)
      'emailtest*',  // account-registration tests
      'noemail*',    // account-registration tests
      'afterauth*',  // account-registration tests
      'duptest*',    // account-registration tests
      'unreg*',      // keycloak tests
      'synerr*',     // keycloak tests
      'clvl*',       // keycloak tests
      'delown*',     // keycloak tests
      'pool*',       // pool accounts (filtered by POOL_PATTERN unless --include-pool)
    ];

    console.log('\nSearching for test accounts...');
    const accountSearchStart = lines.length; // Track buffer position before search

    for (const pattern of ACCOUNT_SEARCH_PATTERNS) {
      if (DEBUG) console.log(`DEBUG: Searching for ${pattern}`);
      send(`PRIVMSG AuthServ :SEARCH PRINT handlemask ${pattern} limit 500`);
      await waitForSearchComplete();
      await new Promise(r => setTimeout(r, 1000)); // Anti-flood delay
    }

    // Accounts to never delete (admin accounts, main test fixtures)
    const PROTECTED_ACCOUNTS = ['testadmin', 'testuser'];

    // Parse search results for accounts (only look at lines since search started)
    // Format is ":AuthServ NOTICE bot :Match: accountname"
    const parseAccounts = (startIndex: number = 0) => {
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('Match:')) {
          // Extract account name from Match: line
          const match = line.match(/Match:\s*(\S+)/i);
          if (match) {
            const account = match[1].toLowerCase();

            // Skip if already found
            if (stats.accountsFound.includes(account)) continue;

            // Skip protected accounts
            if (PROTECTED_ACCOUNTS.includes(account)) continue;

            // Skip pool accounts unless --include-pool flag
            if (POOL_PATTERN.test(account) && !INCLUDE_POOL) {
              if (DEBUG) console.log(`DEBUG: Skipping pool account ${account} (use --include-pool to delete)`);
              continue;
            }

            stats.accountsFound.push(account);
            if (DEBUG) console.log(`DEBUG: Found account ${account}`);
          }
        }
      }
    };

    parseAccounts(accountSearchStart);
    if (DEBUG) console.log(`DEBUG: lines array has ${lines.length} entries`);

    // Log pool account notice
    if (!INCLUDE_POOL) {
      console.log('(Pool accounts preserved - use --include-pool to delete them)');
    }

    console.log(`Found ${stats.accountsFound.length} test accounts to delete`);

    // Enable GOD mode for cleanup operations (required for OUNREGISTER and UNREGISTER)
    // GOD mode grants UL_HELPER (600) access which allows deleting other users' accounts/channels
    if (stats.accountsFound.length > 0) {
      console.log('\nEnabling GOD mode for cleanup...');
      send('PRIVMSG O3 :GOD ON');
      await new Promise(r => setTimeout(r, 500));
    }

    // Delete accounts using AuthServ OUNREGISTER
    // OUNREGISTER is on AuthServ (not O3), use *account for account name
    // Note: This also cascades to unregister channels owned by the account
    if (stats.accountsFound.length > 0) {
      console.log('Deleting test accounts (channels owned by accounts auto-unregistered)...');
      for (const account of stats.accountsFound) {
        const beforeCount = lines.length;
        send(`PRIVMSG AuthServ :OUNREGISTER *${account} FORCE`);
        // Wait 2 seconds for response and anti-flood
        await new Promise(r => setTimeout(r, 2000));
        // Check if we got a response
        const gotResponse = lines.length > beforeCount;
        if (gotResponse) {
          stats.accountsDeleted++;
          process.stdout.write('.');
        } else {
          stats.errors.push(`No response for OUNREGISTER ${account}`);
          process.stdout.write('x');
        }
      }
      console.log(` Done (${stats.accountsDeleted})`);
    }

    // Search for orphaned test channels (not deleted with their owner accounts)
    // This catches channels registered by non-test accounts, or edge cases
    // Search patterns cover all test channel prefixes used in the test suite
    const CHANNEL_SEARCH_PATTERNS = [
      '#test-*',     // main test channels
      '#bisync*',    // bisync channels
      '#bidisync*',  // bidisync channels
      '#optest*',    // opserv tests
      '#multi-*',    // edge-cases tests
      '#testchan*',  // keycloak tests (no dash after prefix)
      '#accesstest*', // keycloak access tests
      '#ws*',        // websocket tests
    ];

    console.log('\nSearching for orphaned test channels...');
    const channelSearchStart = lines.length; // Track buffer position before search

    for (const pattern of CHANNEL_SEARCH_PATTERNS) {
      if (DEBUG) console.log(`DEBUG: Searching for channels ${pattern}`);
      send(`PRIVMSG O3 :CSEARCH PRINT name ${pattern} limit 500`);
      await waitForSearchComplete();
      await new Promise(r => setTimeout(r, 1000)); // Anti-flood delay
    }

    // Also search for channels owned by pool accounts (if not --include-pool)
    // Pool accounts accumulate channel ownership from test runs - clean those up
    // even when keeping the accounts for reuse
    if (!INCLUDE_POOL) {
      console.log('Searching for channels owned by pool accounts...');
      for (let i = 0; i < 10; i++) {
        const poolAccount = `pool${i.toString().padStart(2, '0')}`;
        if (DEBUG) console.log(`DEBUG: Searching for channels owned by ${poolAccount}`);
        send(`PRIVMSG O3 :CSEARCH PRINT owner *${poolAccount} limit 500`);
        await waitForSearchComplete();
        await new Promise(r => setTimeout(r, 500)); // Anti-flood delay
      }
    }

    // Parse channel list - extract channel names from search results
    // Only look at lines since channel search started to avoid picking up
    // channel names from earlier OUNREGISTER responses
    const parseChannels = (startIndex: number = 0) => {
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        // From CSEARCH results, match channel names in various formats:
        // - "Match: #channel" format
        // - Or any #channel in the line from test patterns

        // First try Match: format (from CSEARCH PRINT)
        const matchFormat = line.match(/Match:\s*(#[^\s,]+)/i);
        if (matchFormat) {
          const channel = matchFormat[1].toLowerCase();
          if (!stats.channelsFound.includes(channel)) {
            stats.channelsFound.push(channel);
            if (DEBUG) console.log(`DEBUG: Found channel (Match:) ${channel}`);
          }
          continue;
        }

        // Also match test patterns directly (for any other output format)
        // Patterns: #test-*, #bisync*, #bidisync*, #optest*, #multi-*, #testchan*, #accesstest*, #ws*
        const channelMatches = line.matchAll(/(#(?:test-|bisync|bidisync|optest|multi-|testchan|accesstest|ws)[^\s,]+)/gi);
        for (const match of channelMatches) {
          const channel = match[1].toLowerCase();
          if (!stats.channelsFound.includes(channel)) {
            stats.channelsFound.push(channel);
            if (DEBUG) console.log(`DEBUG: Found channel (pattern) ${channel}`);
          }
        }
      }
    };

    parseChannels(channelSearchStart);

    console.log(`Found ${stats.channelsFound.length} orphaned test channels`);

    // Unregister orphaned channels using ChanServ
    if (stats.channelsFound.length > 0) {
      // Enable GOD mode if not already (in case no accounts were found earlier)
      if (stats.accountsFound.length === 0) {
        console.log('\nEnabling GOD mode for channel cleanup...');
        send('PRIVMSG O3 :GOD ON');
        await new Promise(r => setTimeout(r, 500));
      }

      console.log('Unregistering orphaned test channels...');
      for (const channel of stats.channelsFound) {
        const beforeCount = lines.length;
        // With GOD mode, no confirmation string needed - IsHelping bypasses that check
        send(`PRIVMSG ChanServ :UNREGISTER ${channel}`);
        // Wait 2 seconds for response and anti-flood
        await new Promise(r => setTimeout(r, 2000));
        const gotResponse = lines.length > beforeCount;
        if (gotResponse) {
          stats.channelsDeleted++;
          process.stdout.write('.');
        } else {
          stats.errors.push(`No response for UNREGISTER ${channel}`);
          process.stdout.write('x');
        }
      }
      console.log(` Done (${stats.channelsDeleted})`);
    }

    // Write databases to disk so deletions persist across X3 restart
    if (stats.accountsDeleted > 0 || stats.channelsDeleted > 0) {
      console.log('\nPersisting changes to disk...');
      send('PRIVMSG O3 :WRITEALL');
      await new Promise(r => setTimeout(r, 2000)); // Give time for disk write
    }

    // Disable GOD mode when done
    if (stats.accountsFound.length > 0 || stats.channelsFound.length > 0) {
      send('PRIVMSG O3 :GOD OFF');
      await new Promise(r => setTimeout(r, 300));
    }

    // Summary
    console.log('\n=== Cleanup Summary ===');
    console.log(`X3 Accounts deleted: ${stats.accountsDeleted} (Keycloak users deleted via OUNREGISTER)`);
    console.log(`X3 Channels unregistered: ${stats.channelsDeleted}`);

    send('QUIT :Cleanup complete');
    await new Promise(r => setTimeout(r, 500));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    socket.end();
  }
}

cleanup().catch(console.error);
