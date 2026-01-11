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

    const waitForSearchComplete = async (timeout = 30000): Promise<void> => {
      const startMarkers = countSearchMarkers();
      const start = Date.now();
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
    };

    // Search for test accounts using AuthServ
    // AuthServ SEARCH supports: handlemask, accountmask, account (all synonyms)
    // Use limit 500 to get more results (default may be capped)
    // Search for both test* and bisync* patterns (bidirectional sync tests use bisync prefix)
    console.log('\nSearching for test accounts...');
    const accountSearchStart = lines.length; // Track buffer position before search
    send('PRIVMSG AuthServ :SEARCH PRINT handlemask test* limit 500');
    await waitForSearchComplete(30000);
    await new Promise(r => setTimeout(r, 2000)); // Anti-flood delay

    console.log('Searching for bisync accounts...');
    send('PRIVMSG AuthServ :SEARCH PRINT handlemask bisync* limit 500');
    await waitForSearchComplete(30000);
    await new Promise(r => setTimeout(r, 2000)); // Anti-flood delay

    // Accounts to never delete (admin accounts, main test fixtures)
    const PROTECTED_ACCOUNTS = ['testadmin', 'testuser'];

    // Parse search results for accounts (only look at lines since search started)
    const parseAccounts = (startIndex: number = 0) => {
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        // Look for test account names in Match: lines
        // Format is ":AuthServ NOTICE bot :Match: test01f17b"
        // Patterns: test + 6 hex chars, or bisync variants + 4-5 hex chars
        if (line.includes('Match:')) {
          // Match test accounts (test + 6 hex)
          const testMatch = line.match(/(test[0-9a-f]{6})/i);
          if (testMatch &&
              !stats.accountsFound.includes(testMatch[1]) &&
              !PROTECTED_ACCOUNTS.includes(testMatch[1].toLowerCase())) {
            stats.accountsFound.push(testMatch[1]);
            if (DEBUG) console.log(`DEBUG: Found account ${testMatch[1]}`);
          }
          // Match bisync accounts (bisync, bisyncadd, bisyncclvl, bisyncdel + hex chars)
          const bisyncMatch = line.match(/(bisync(?:add|clvl|del)?[0-9a-f]{4,6})/i);
          if (bisyncMatch &&
              !stats.accountsFound.includes(bisyncMatch[1]) &&
              !PROTECTED_ACCOUNTS.includes(bisyncMatch[1].toLowerCase())) {
            stats.accountsFound.push(bisyncMatch[1]);
            if (DEBUG) console.log(`DEBUG: Found account ${bisyncMatch[1]}`);
          }
        }
      }
    };

    parseAccounts(accountSearchStart);
    if (DEBUG) console.log(`DEBUG: lines array has ${lines.length} entries`);

    // Check if more results were truncated and re-search if needed
    const hasMoreAccounts = lines.slice(accountSearchStart).some(l => l.includes('more match') || l.includes('truncated'));
    if (hasMoreAccounts) {
      console.log('Results may be truncated, searching again with higher limit...');
      const retryStart = lines.length;
      send('PRIVMSG AuthServ :SEARCH PRINT handlemask test* limit 1000');
      await waitForSearchComplete(30000);
      parseAccounts(retryStart);
    }

    console.log(`Found ${stats.accountsFound.length} test accounts`);

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
    console.log('\nSearching for orphaned test channels...');
    const channelSearchStart = lines.length; // Track buffer position before search
    send('PRIVMSG O3 :CSEARCH PRINT name #test-* limit 500');
    await waitForSearchComplete(30000);
    await new Promise(r => setTimeout(r, 2000)); // Anti-flood delay

    console.log('Searching for orphaned bisync channels...');
    send('PRIVMSG O3 :CSEARCH PRINT name #bisync* limit 500');
    await waitForSearchComplete(30000);
    await new Promise(r => setTimeout(r, 2000)); // Anti-flood delay

    console.log('Searching for orphaned bidisync channels...');
    send('PRIVMSG O3 :CSEARCH PRINT name #bidisync* limit 500');
    await waitForSearchComplete(30000);
    await new Promise(r => setTimeout(r, 2000)); // Anti-flood delay

    // Parse channel list - look for test, bisync, and bidisync channel patterns
    // Only look at lines since channel search started to avoid picking up
    // channel names from earlier OUNREGISTER responses
    const parseChannels = (startIndex: number = 0) => {
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        // Match channel names like #test-a0da46b0 (8 hex chars)
        const testMatches = line.matchAll(/(#test-[a-f0-9]{6,8})/gi);
        for (const match of testMatches) {
          if (!stats.channelsFound.includes(match[1])) {
            stats.channelsFound.push(match[1]);
          }
        }
        // Match bisync channel names like #bisyncadd-a0da46b0, #bisyncclvl-..., etc.
        const bisyncMatches = line.matchAll(/(#bisync(?:add|clvl|del|unreg)?-[a-f0-9]{6,8})/gi);
        for (const match of bisyncMatches) {
          if (!stats.channelsFound.includes(match[1])) {
            stats.channelsFound.push(match[1]);
          }
        }
        // Match bidisync channel names like #bidisync-a0da46b0
        const bidisyncMatches = line.matchAll(/(#bidisync-[a-f0-9]{6,8})/gi);
        for (const match of bidisyncMatches) {
          if (!stats.channelsFound.includes(match[1])) {
            stats.channelsFound.push(match[1]);
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
