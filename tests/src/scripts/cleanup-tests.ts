#!/usr/bin/env npx tsx
/**
 * Cleanup script for test data
 *
 * Removes test accounts (test*) and test channels (#test-*) from X3.
 * Requires IRC oper AND X3 AuthServ admin account (olevel 1000).
 *
 * Setup (first time after fresh x3.db):
 *   1. Connect as IRC oper
 *   2. /msg AuthServ REGISTER <account> <password> <email>
 *   3. First oper to register gets olevel 1000 automatically
 *
 * Usage:
 *   X3_ACCOUNT=admin X3_PASSWORD=secret npm run cleanup
 *
 * Environment variables:
 *   IRC_HOST     - IRC server host (default: localhost)
 *   IRC_PORT     - IRC server port (default: 6667)
 *   OPER_NAME    - IRC oper name (default: oper)
 *   OPER_PASS    - IRC oper password (default: shmoo)
 *   X3_ACCOUNT   - X3 AuthServ account with olevel 1000
 *   X3_PASSWORD  - X3 AuthServ password
 *   DEBUG=1      - Enable verbose output
 */

import * as net from 'net';
import * as readline from 'readline';

const IRC_HOST = process.env.IRC_HOST || 'localhost';
const IRC_PORT = parseInt(process.env.IRC_PORT || '6667', 10);
const OPER_NAME = process.env.OPER_NAME || 'oper';
const OPER_PASS = process.env.OPER_PASS || 'shmoo';
// X3 AuthServ credentials (first oper to register gets olevel 1000)
const X3_ACCOUNT = process.env.X3_ACCOUNT || '';
const X3_PASSWORD = process.env.X3_PASSWORD || '';

interface CleanupStats {
  accountsFound: string[];
  channelsFound: string[];
  accountsDeleted: number;
  channelsDeleted: number;
  errors: string[];
}

async function cleanup(): Promise<void> {
  const stats: CleanupStats = {
    accountsFound: [],
    channelsFound: [],
    accountsDeleted: 0,
    channelsDeleted: 0,
    errors: [],
  };

  console.log(`Connecting to ${IRC_HOST}:${IRC_PORT}...`);

  const socket = net.createConnection({ host: IRC_HOST, port: IRC_PORT });
  const rl = readline.createInterface({ input: socket });

  const lines: string[] = [];
  const DEBUG = process.env.DEBUG === '1';
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

  const collectLines = async (endPattern: RegExp, timeout = 10000): Promise<string[]> => {
    const collected: string[] = [];
    const start = Date.now();
    const startIdx = lines.length;

    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 200));
      for (let i = startIdx; i < lines.length; i++) {
        if (!collected.includes(lines[i])) {
          collected.push(lines[i]);
          if (endPattern.test(lines[i])) {
            return collected;
          }
        }
      }
    }
    return collected;
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
    let authenticated = false;
    if (X3_ACCOUNT && X3_PASSWORD) {
      console.log(`Authenticating with AuthServ as ${X3_ACCOUNT}...`);
      send(`PRIVMSG AuthServ :AUTH ${X3_ACCOUNT} ${X3_PASSWORD}`);
      await new Promise(r => setTimeout(r, 1000));

      // Check for successful auth (look for "I recognize you" or similar)
      const authSuccess = lines.some(l =>
        l.includes('AuthServ') && (l.includes('recognize') || l.includes('authenticated'))
      );
      if (authSuccess) {
        console.log('AuthServ authentication successful.');
        authenticated = true;
      } else {
        console.log('AuthServ authentication may have failed - check credentials.');
      }
    } else {
      console.log('No X3_ACCOUNT/X3_PASSWORD set - O3 commands will fail.');
      console.log('Set these env vars or wipe x3.db and register first oper.');
    }

    // Search for test accounts using O3
    console.log('\nSearching for test accounts...');
    send('PRIVMSG O3 :SEARCH PRINT account test*');
    await new Promise(r => setTimeout(r, 2000));

    // Parse search results for accounts
    for (const line of lines) {
      // Look for account names in O3 responses
      const match = line.match(/NOTICE.*:(test[a-f0-9]{5,6})\b/i);
      if (match && !stats.accountsFound.includes(match[1])) {
        stats.accountsFound.push(match[1]);
      }
    }

    console.log(`Found ${stats.accountsFound.length} test accounts`);

    // Search for test channels using ChanServ CLIST command
    console.log('\nSearching for test channels...');
    send('PRIVMSG ChanServ :CLIST #test-*');
    await new Promise(r => setTimeout(r, 3000));

    // Parse channel list - look for #test- patterns in any response
    for (const line of lines) {
      // Match channel names like #test-a0da46b0 (8 hex chars)
      const matches = line.matchAll(/(#test-[a-f0-9]{6,8})/gi);
      for (const match of matches) {
        if (!stats.channelsFound.includes(match[1])) {
          stats.channelsFound.push(match[1]);
        }
      }
    }

    console.log(`Found ${stats.channelsFound.length} test channels`);

    // Delete accounts
    if (stats.accountsFound.length > 0) {
      console.log('\nDeleting test accounts...');
      for (const account of stats.accountsFound) {
        send(`PRIVMSG O3 :OUNREGISTER *${account} FORCE`);
        await new Promise(r => setTimeout(r, 300));
        stats.accountsDeleted++;
        process.stdout.write('.');
      }
      console.log(` Done (${stats.accountsDeleted})`);
    }

    // Unregister channels using ChanServ
    if (stats.channelsFound.length > 0) {
      console.log('\nUnregistering test channels...');
      for (const channel of stats.channelsFound) {
        send(`PRIVMSG ChanServ :UNREGISTER ${channel} CONFIRM`);
        await new Promise(r => setTimeout(r, 300));
        stats.channelsDeleted++;
        process.stdout.write('.');
      }
      console.log(` Done (${stats.channelsDeleted})`);
    }

    // Summary
    console.log('\n=== Cleanup Summary ===');
    console.log(`Accounts deleted: ${stats.accountsDeleted}`);
    console.log(`Channels unregistered: ${stats.channelsDeleted}`);

    send('QUIT :Cleanup complete');
    await new Promise(r => setTimeout(r, 500));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    socket.end();
  }
}

cleanup().catch(console.error);
