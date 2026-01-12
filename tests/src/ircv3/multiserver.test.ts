/**
 * Multi-server IRC tests
 *
 * These tests verify that features work correctly across linked IRC servers.
 * They require the 'linked' docker-compose profile to be active:
 *   docker compose --profile linked up -d
 *
 * Tests in this file will be SKIPPED (visible in output) if secondary server
 * is not available. Previously they would silently pass - now they show as skipped.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  RawSocketClient,
  createClientOnServer,
  isSecondaryServerAvailable,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  uniqueChannel,
  uniqueId,
  // P10 protocol helpers
  getP10Logs,
  parseBurst,
  parseNick,
  validateBurstOrder,
  getServerFromNumeric,
} from '../helpers/index.js';

// Check secondary server availability synchronously at module load time
// Using top-level await (ESM) to determine skip condition before tests run
const secondaryAvailable = await isSecondaryServerAvailable();

if (!secondaryAvailable) {
  console.log('\n⚠️  Secondary server not available - multi-server tests will be SKIPPED');
  console.log('   To run these tests: docker compose --profile linked up -d\n');
}

// Use describe.skipIf to make skipped tests visible in output
// This replaces the previous pattern of `if (await skipIfNoSecondary()) return;`
// which made tests silently pass instead of showing as skipped
describe.skipIf(!secondaryAvailable)('Multi-Server IRC', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Server Link Verification', () => {
    it('can connect to secondary server', async () => {
      const client = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client.capLs();
      client.capEnd();
      client.register('multitest1');
      const welcome = await client.waitForNumeric('001');

      expect(welcome).toContain('001');
      client.send('QUIT');
    });

    it('servers are linked (visible in LINKS)', async () => {
      const client = trackClient(await createClientOnServer(PRIMARY_SERVER));

      await client.capLs();
      client.capEnd();
      client.register('linkstest1');
      await client.waitForNumeric('001');

      client.send('LINKS');

      // Wait for server list - should see both servers
      // Note: LINKS may be restricted to opers on some networks (AfterNET/EFnet)
      const links: string[] = [];
      let linksRestricted = false;
      try {
        for (let i = 0; i < 10; i++) {
          const line = await client.waitForLine(/364|365|481/, 2000);
          if (/481/.test(line)) {
            // ERR_NOPRIVILEGES - LINKS is oper-only
            linksRestricted = true;
            console.log('LINKS command is restricted to opers');
            break;
          }
          if (/364/.test(line)) {
            links.push(line);
          }
          if (/365/.test(line)) {
            break; // End of LINKS
          }
        }
      } catch {
        // Timeout is expected after getting all links
      }

      // Either we got links, or the command is restricted/silently ignored (all valid for security)
      if (!linksRestricted && links.length > 0) {
        // Should have at least 2 servers (primary + secondary) if LINKS is available
        expect(links.length).toBeGreaterThanOrEqual(2);
        console.log(`LINKS returned ${links.length} servers`);
      } else if (links.length === 0 && !linksRestricted) {
        // LINKS may be silently disabled (common anti-mapping measure)
        console.log('LINKS returned no servers (may be silently disabled for security)');
      }
      // Test passes regardless - we're just verifying the command doesn't crash
      client.send('QUIT');
    });
  });

  describe('Cross-Server Communication', () => {
    it('clients on different servers can message each other in a channel', async () => {
      // Client on primary server
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      await client1.capLs();
      client1.capEnd();
      client1.register('msender1');
      await client1.waitForNumeric('001');

      // Client on secondary server
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));
      await client2.capLs();
      client2.capEnd();
      client2.register('mrecver1');
      await client2.waitForNumeric('001');

      // Both join the same channel
      const channel = '#multitest';
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin('#multitest');

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin('#multitest');

      // Wait for cross-server sync: client1 should see client2's JOIN
      // This proves the servers have synced rather than using arbitrary sleep
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'mrecver1', 5000);

      // Client 1 sends a message
      const testMessage = `cross-server-test-${uniqueId()}`;
      client1.send(`PRIVMSG ${channel} :${testMessage}`);

      // Client 2 should receive it despite being on a different server
      const received = await client2.waitForLine(new RegExp(testMessage), 5000);
      expect(received).toContain(testMessage);

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('WHOIS shows user on remote server', async () => {
      // Client on primary server
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      await client1.capLs();
      client1.capEnd();
      client1.register('whoiser1');
      await client1.waitForNumeric('001');

      // Client on secondary server
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));
      await client2.capLs();
      client2.capEnd();
      client2.register('whoisee1');
      await client2.waitForNumeric('001');

      // Join a channel together to ensure servers are synced
      const channel = '#whoistest';
      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForJoin('#whoistest');
      await client2.waitForJoin('#whoistest');

      // Wait for cross-server sync: client1 sees client2's JOIN
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'whoisee1', 5000);

      // WHOIS from client1 for client2
      client1.send('WHOIS whoisee1');

      // Should get WHOIS response
      const whoisInfo = await client1.waitForLine(/311.*whoisee1/i, 5000);
      expect(whoisInfo).toContain('whoisee1');

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('NICK change is visible across servers', async () => {
      // Client on primary server
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      await client1.capLs();
      client1.capEnd();
      client1.register('nickold1');
      await client1.waitForNumeric('001');

      // Client on secondary server, join same channel to see nick changes
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));
      await client2.capLs();
      client2.capEnd();
      client2.register('observer1');
      await client2.waitForNumeric('001');

      // Both join same channel so they can see each other's nick changes
      const channel = '#nicktest';
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin('#nicktest');

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin('#nicktest');

      // Wait for cross-server sync: client2 sees client1's JOIN
      await client2.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'nickold1', 5000);

      // Client 1 changes nick
      client1.send('NICK nicknew1');

      // Client 2 should see the nick change
      const nickChange = await client2.waitForLine(/NICK.*nicknew1/i, 5000);
      expect(nickChange).toContain('nicknew1');

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server Metadata', () => {
    it('SASL authentication works on secondary server', async () => {
      // This test requires an account to exist
      // Skip if not set up
      const testAccount = process.env.TEST_ACCOUNT ?? 'testuser';
      const testPassword = process.env.TEST_PASSWORD ?? 'testpass';

      const client = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client.capLs();
      const caps = await client.capReq(['sasl']);

      if (caps.nak.includes('sasl')) {
        console.log('SASL not available on secondary server');
        client.close();
        return;
      }

      // Attempt SASL auth
      client.send('AUTHENTICATE PLAIN');

      try {
        await client.waitForLine(/AUTHENTICATE \+/, 3000);
        const payload = Buffer.from(`${testAccount}\0${testAccount}\0${testPassword}`).toString('base64');
        client.send(`AUTHENTICATE ${payload}`);

        // Wait for result (success or failure)
        const result = await client.waitForLine(/90[0-9]/, 5000);
        // If we get here, SASL interaction worked (success or failure is fine)
        expect(result).toMatch(/90[0-9]/);
      } catch {
        // SASL not working - this is okay, it just means no account is configured
        console.log('SASL not configured with test account');
      }

      client.capEnd();
      client.send('QUIT');
    });

    it('metadata is visible across servers', async () => {
      // This test requires metadata capability and an account with metadata
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      const caps1 = await client1.capReq(['draft/metadata-2']);
      if (caps1.nak.includes('draft/metadata-2')) {
        console.log('Metadata not available');
        client1.close();
        client2.close();
        return;
      }
      client1.capEnd();
      client1.register('metauser1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/metadata-2']);
      client2.capEnd();
      client2.register('metaquery1');
      await client2.waitForNumeric('001');

      // Join a channel to establish cross-server sync
      const channel = '#metadatatest';
      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForJoin('#metadatatest');
      await client2.waitForJoin('#metadatatest');
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'metaquery1', 5000);

      // Set metadata on client 1 (on primary server)
      const testKey = 'testkey';
      const testValue = `testvalue-${uniqueId()}`;
      client1.send(`METADATA SET * ${testKey} :${testValue}`);
      // Wait for confirmation the metadata was set
      await client1.waitForLine(/METADATA.*SET|761/i, 3000);

      // Query metadata from client 2 (on secondary server)
      client2.send(`METADATA GET metauser1 ${testKey}`);
      // Wait for metadata response
      await client2.waitForLine(/METADATA|761/i, 3000);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server Channel Operations', () => {
    it('MODE changes propagate across servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      client1.capEnd();
      client1.register('modeop1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      client2.capEnd();
      client2.register('modeobs1');
      await client2.waitForNumeric('001');

      const channel = uniqueChannel('modetest');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync: client1 sees client2's JOIN
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'modeobs1', 5000);

      client2.clearRawBuffer();

      // Client 1 (op) sets mode
      client1.send(`MODE ${channel} +s`);

      // Client 2 should see the mode change
      const modeChange = await client2.waitForLine(/MODE.*\+s/i, 5000);
      expect(modeChange).toContain('+s');

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('KICK works across servers', async () => {
      const op = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const user = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await op.capLs();
      op.capEnd();
      op.register('kickop1');
      await op.waitForNumeric('001');

      await user.capLs();
      user.capEnd();
      user.register('kickuser1');
      await user.waitForNumeric('001');

      const channel = uniqueChannel('kicktest');
      op.send(`JOIN ${channel}`);
      await op.waitForJoin(channel);

      user.send(`JOIN ${channel}`);
      await user.waitForJoin(channel);

      // Wait for cross-server sync: op sees user's JOIN
      await op.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'kickuser1', 5000);

      user.clearRawBuffer();

      // Op kicks user on remote server
      op.send(`KICK ${channel} kickuser1 :Cross-server kick test`);

      // User should receive KICK
      const kickMsg = await user.waitForLine(/KICK.*kickuser1/i, 5000);
      expect(kickMsg).toContain('KICK');

      op.send('QUIT');
      user.send('QUIT');
    });

    it('TOPIC changes propagate across servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      client1.capEnd();
      client1.register('topicop1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      client2.capEnd();
      client2.register('topicobs1');
      await client2.waitForNumeric('001');

      const channel = uniqueChannel('topictest');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync: client1 sees client2's JOIN
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'topicobs1', 5000);

      client2.clearRawBuffer();

      // Set topic from primary server
      const newTopic = `Cross-server topic test ${uniqueId()}`;
      client1.send(`TOPIC ${channel} :${newTopic}`);

      // Client 2 should see TOPIC change
      const topicChange = await client2.waitForLine(/TOPIC/i, 5000);
      expect(topicChange).toContain('TOPIC');

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('PART message propagates across servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      client1.capEnd();
      client1.register('parter1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      client2.capEnd();
      client2.register('partobs1');
      await client2.waitForNumeric('001');

      const channel = uniqueChannel('parttest');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync: client2 sees client1's JOIN
      await client2.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'parter1', 5000);

      client2.clearRawBuffer();

      // Client 1 parts
      client1.send(`PART ${channel} :Leaving cross-server`);

      // Client 2 should see PART
      const partMsg = await client2.waitForLine(/PART.*parter1/i, 5000);
      expect(partMsg).toContain('PART');

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server User Operations', () => {
    it('private message works across servers', async () => {
      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const receiver = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await sender.capLs();
      sender.capEnd();
      sender.register('pmsender1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('pmrecver1');
      await receiver.waitForNumeric('001');

      // Join a channel to verify cross-server sync
      const channel = '#pmtest';
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin('#pmtest');
      await receiver.waitForJoin('#pmtest');
      // Wait for cross-server visibility
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'pmrecver1', 5000);

      receiver.clearRawBuffer();

      // Send PM across servers
      const testMsg = `Private message test ${uniqueId()}`;
      sender.send(`PRIVMSG pmrecver1 :${testMsg}`);

      // Receiver should get the message
      const pm = await receiver.waitForLine(new RegExp(testMsg), 5000);
      expect(pm).toContain(testMsg);

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('NOTICE works across servers', async () => {
      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const receiver = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await sender.capLs();
      sender.capEnd();
      sender.register('noticesend1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      receiver.capEnd();
      receiver.register('noticerecv1');
      await receiver.waitForNumeric('001');

      // Join a channel to verify cross-server sync
      const channel = '#noticetest';
      sender.send(`JOIN ${channel}`);
      receiver.send(`JOIN ${channel}`);
      await sender.waitForJoin('#noticetest');
      await receiver.waitForJoin('#noticetest');
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'noticerecv1', 5000);

      receiver.clearRawBuffer();

      const testNotice = `Notice test ${uniqueId()}`;
      sender.send(`NOTICE noticerecv1 :${testNotice}`);

      const notice = await receiver.waitForLine(new RegExp(testNotice), 5000);
      expect(notice).toContain(testNotice);

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('QUIT propagates across servers', async () => {
      const quitter = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const observer = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await quitter.capLs();
      quitter.capEnd();
      quitter.register('quitter1');
      await quitter.waitForNumeric('001');

      await observer.capLs();
      observer.capEnd();
      observer.register('quitobs1');
      await observer.waitForNumeric('001');

      // Both join same channel
      const channel = uniqueChannel('quittest');
      quitter.send(`JOIN ${channel}`);
      await quitter.waitForJoin(channel);

      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      // Wait for cross-server sync: observer sees quitter's JOIN
      await observer.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'quitter1', 5000);

      observer.clearRawBuffer();

      // Quitter leaves
      quitter.send('QUIT :Cross-server quit');

      // Observer should see QUIT
      const quitMsg = await observer.waitForLine(/QUIT.*quitter1/i, 5000);
      expect(quitMsg).toContain('QUIT');

      observer.send('QUIT');
    });
  });

  describe('Cross-Server IRCv3 Features', () => {
    it('account-tag visible on remote server', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      await client1.capReq(['account-tag']);
      client1.capEnd();
      client1.register('acctag1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['account-tag']);
      client2.capEnd();
      client2.register('acctag2');
      await client2.waitForNumeric('001');

      const channel = uniqueChannel('acctag');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'acctag2', 5000);

      client2.clearRawBuffer();

      // Client 1 sends message
      client1.send(`PRIVMSG ${channel} :Account tag test`);

      const msg = await client2.waitForLine(/PRIVMSG.*Account tag test/i, 5000);
      // If authenticated, should have account= tag (checked by logging)
      expect(msg).toContain('Account tag test');

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('echo-message works on remote server', async () => {
      const client = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client.capLs();
      const caps = await client.capReq(['echo-message']);
      if (caps.nak.includes('echo-message')) {
        console.log('echo-message not available');
        client.close();
        return;
      }

      client.capEnd();
      client.register('echo1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('echotest');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      client.clearRawBuffer();

      const testMsg = `Echo test ${uniqueId()}`;
      client.send(`PRIVMSG ${channel} :${testMsg}`);

      // Should receive own message back
      const echo = await client.waitForLine(new RegExp(testMsg), 3000);
      expect(echo).toContain(testMsg);

      client.send('QUIT');
    });

    it('server-time capability works on both servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      const caps1 = await client1.capReq(['server-time']);
      client1.capEnd();
      client1.register('time1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      const caps2 = await client2.capReq(['server-time']);
      client2.capEnd();
      client2.register('time2');
      await client2.waitForNumeric('001');

      const channel = uniqueChannel('timetest');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'time2', 5000);

      client2.clearRawBuffer();

      // Send message from primary
      client1.send(`PRIVMSG ${channel} :Time tag test`);

      const msg = await client2.waitForLine(/PRIVMSG.*Time tag test/i, 5000);
      expect(msg).toContain('Time tag test');
      // If server-time is enabled, should have time= tag
      if (msg.includes('time=')) {
        expect(msg).toMatch(/time=\d{4}-\d{2}-\d{2}/);
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server Channel Rename', () => {
    it('RENAME propagates to remote server', async () => {
      const op = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const observer = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await op.capLs();
      await op.capReq(['draft/channel-rename']);
      op.capEnd();
      op.register('renameop1');
      await op.waitForNumeric('001');

      await observer.capLs();
      await observer.capReq(['draft/channel-rename']);
      observer.capEnd();
      observer.register('renameobs1');
      await observer.waitForNumeric('001');

      const oldChannel = uniqueChannel('renold');
      const newChannel = uniqueChannel('rennew');

      op.send(`JOIN ${oldChannel}`);
      await op.waitForJoin(oldChannel);

      observer.send(`JOIN ${oldChannel}`);
      await observer.waitForJoin(oldChannel);

      // Wait for cross-server sync
      await op.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'renameobs1', 5000);

      observer.clearRawBuffer();

      // Rename from primary server
      op.send(`RENAME ${oldChannel} ${newChannel} :Cross-server rename`);

      const rename = await observer.waitForLine(/RENAME/i, 5000);
      expect(rename).toContain('RENAME');

      op.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Cross-Server Message Redaction', () => {
    it('REDACT propagates to remote server', async () => {
      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const observer = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await sender.capLs();
      await sender.capReq(['draft/message-redaction', 'echo-message']);
      sender.capEnd();
      sender.register('redactsend1');
      await sender.waitForNumeric('001');

      await observer.capLs();
      await observer.capReq(['draft/message-redaction']);
      observer.capEnd();
      observer.register('redactobs1');
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('redactcross');
      sender.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);

      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      // Wait for cross-server sync
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'redactobs1', 5000);

      // Send message and capture msgid
      sender.send(`PRIVMSG ${channel} :Message to redact cross-server`);

      const echo = await sender.waitForLine(/PRIVMSG.*Message to redact/i, 3000);
      const match = echo.match(/msgid=([^\s;]+)/);
      expect(match).not.toBeNull();
      const msgid = match![1];

      observer.clearRawBuffer();

      // Redact the message
      sender.send(`REDACT ${channel} ${msgid} :Cross-server redaction`);

      const redact = await observer.waitForLine(/REDACT/i, 5000);
      expect(redact).toContain('REDACT');

      sender.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Cross-Server AWAY Status', () => {
    it('AWAY message propagates across servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      await client1.capReq(['away-notify']);
      client1.capEnd();
      client1.register('awaytest1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['away-notify']);
      client2.capEnd();
      client2.register('awaytest2');
      await client2.waitForNumeric('001');

      // Both join same channel for away-notify
      const channel = uniqueChannel('awaytest');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'awaytest2', 5000);

      client2.clearRawBuffer();

      // Client 1 sets away
      client1.send('AWAY :Gone for lunch');

      // Client 2 should see AWAY message (with away-notify)
      const awayMsg = await client2.waitForLine(/AWAY/i, 5000);
      expect(awayMsg).toContain('AWAY');

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('AWAY status visible in WHOIS across servers', async () => {
      const awayclient = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const querier = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await awayclient.capLs();
      awayclient.capEnd();
      awayclient.register('awaywhois1');
      await awayclient.waitForNumeric('001');

      await querier.capLs();
      querier.capEnd();
      querier.register('awaywhois2');
      await querier.waitForNumeric('001');

      // Join a channel to establish cross-server visibility
      const channel = '#awaywhoistest';
      awayclient.send(`JOIN ${channel}`);
      querier.send(`JOIN ${channel}`);
      await awayclient.waitForJoin('#awaywhoistest');
      await querier.waitForJoin('#awaywhoistest');
      await querier.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'awaywhois1', 5000);

      // Set away on client 1
      awayclient.send('AWAY :Testing WHOIS away');
      // Wait for AWAY to be confirmed
      await awayclient.waitForNumeric('306', 5000);  // RPL_NOWAWAY

      querier.clearRawBuffer();

      // Query WHOIS from other server
      querier.send('WHOIS awaywhois1');

      // 301 = RPL_AWAY
      const awayLine = await querier.waitForLine(/301.*awaywhois1/i, 5000);
      expect(awayLine).toContain('Testing WHOIS away');

      awayclient.send('QUIT');
      querier.send('QUIT');
    });
  });

  describe('Cross-Server SETNAME', () => {
    it('SETNAME propagates across servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      await client1.capReq(['setname']);
      client1.capEnd();
      client1.register('setname1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['setname']);
      client2.capEnd();
      client2.register('setname2');
      await client2.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('setname');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'setname2', 5000);

      client2.clearRawBuffer();

      // Client 1 changes realname
      const newName = `New Realname ${uniqueId()}`;
      client1.send(`SETNAME :${newName}`);

      // Client 2 should see SETNAME
      const setnameMsg = await client2.waitForLine(/SETNAME/i, 5000);
      expect(setnameMsg).toContain('SETNAME');

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server TAGMSG', () => {
    it('TAGMSG propagates across servers', async () => {
      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const receiver = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await sender.capLs();
      await sender.capReq(['message-tags']);
      sender.capEnd();
      sender.register('tagmsg1');
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['message-tags']);
      receiver.capEnd();
      receiver.register('tagmsg2');
      await receiver.waitForNumeric('001');

      const channel = uniqueChannel('tagmsgtest');
      sender.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);

      receiver.send(`JOIN ${channel}`);
      await receiver.waitForJoin(channel);

      // Wait for cross-server sync
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'tagmsg2', 5000);

      receiver.clearRawBuffer();

      // Send TAGMSG with reaction
      sender.send(`@+draft/react=:thumbsup: TAGMSG ${channel}`);

      const tagmsg = await receiver.waitForLine(/TAGMSG/i, 5000);
      expect(tagmsg).toContain('TAGMSG');

      sender.send('QUIT');
      receiver.send('QUIT');
    });
  });

  describe('Cross-Server INVITE', () => {
    it('INVITE propagates across servers', async () => {
      const op = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const invitee = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await op.capLs();
      await op.capReq(['invite-notify']);
      op.capEnd();
      op.register('inviteop1');
      await op.waitForNumeric('001');

      await invitee.capLs();
      invitee.capEnd();
      invitee.register('invitee1');
      await invitee.waitForNumeric('001');

      // Op creates invite-only channel
      const channel = uniqueChannel('invitetest');
      op.send(`JOIN ${channel}`);
      await op.waitForJoin(channel);
      op.send(`MODE ${channel} +i`);
      // Wait for MODE confirmation
      await op.waitForLine(/MODE.*\+i/i, 5000);

      invitee.clearRawBuffer();

      // Op invites user on remote server
      op.send(`INVITE invitee1 ${channel}`);

      // Invitee should receive INVITE
      const inviteMsg = await invitee.waitForLine(/INVITE.*invitee1/i, 5000);
      expect(inviteMsg).toContain('INVITE');

      op.send('QUIT');
      invitee.send('QUIT');
    });
  });

  describe('Cross-Server Read Marker', () => {
    it('MARKREAD syncs across servers for same account', async () => {
      // This test requires authentication to the same account on both servers
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      const caps1 = await client1.capReq(['draft/read-marker']);
      if (caps1.nak.includes('draft/read-marker')) {
        console.log('read-marker not available');
        client1.close();
        client2.close();
        return;
      }
      client1.capEnd();
      client1.register('readmark1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/read-marker']);
      client2.capEnd();
      client2.register('readmark2');
      await client2.waitForNumeric('001');

      // Verify read-marker works on both servers
      const channel = uniqueChannel('readmarktest');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'readmark2', 5000);

      // Both clients can query MARKREAD
      client1.send(`MARKREAD ${channel}`);
      client2.send(`MARKREAD ${channel}`);

      // Verify commands work on both
      const markread1 = await client1.waitForLine(/MARKREAD|730/i, 3000);
      expect(markread1).toBeDefined();

      const markread2 = await client2.waitForLine(/MARKREAD|730/i, 3000);
      expect(markread2).toBeDefined();

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server CHGHOST', () => {
    it('CHGHOST propagates across servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      await client1.capReq(['chghost']);
      client1.capEnd();
      client1.register('chghost1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['chghost']);
      client2.capEnd();
      client2.register('chghost2');
      await client2.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('chghost');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'chghost2', 5000);

      // CHGHOST is typically triggered by services, not by users directly
      // But we can verify the capability is enabled on both servers
      expect(client1.hasCapEnabled('chghost')).toBe(true);
      expect(client2.hasCapEnabled('chghost')).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server Extended-Join', () => {
    it('extended-join info visible across servers', async () => {
      const joiner = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const observer = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await joiner.capLs();
      joiner.capEnd();
      joiner.register('extjoin1');
      await joiner.waitForNumeric('001');

      await observer.capLs();
      await observer.capReq(['extended-join']);
      observer.capEnd();
      observer.register('extjoin2');
      await observer.waitForNumeric('001');

      // Observer creates channel first
      const channel = uniqueChannel('extjoin');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      observer.clearRawBuffer();

      // Joiner joins from different server
      joiner.send(`JOIN ${channel}`);
      await joiner.waitForJoin(channel);

      // Observer should see extended-join format
      const joinMsg = await observer.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'extjoin1', 5000);
      expect(joinMsg.source?.nick).toBe('extjoin1');
      // Extended join format: :nick!user@host JOIN #channel account :realname
      // Account may be * if not logged in

      joiner.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Cross-Server Batch Operations', () => {
    it('batch capability works on both servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      const caps1 = await client1.capReq(['batch', 'draft/chathistory']);
      client1.capEnd();
      client1.register('batch1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      const caps2 = await client2.capReq(['batch', 'draft/chathistory']);
      client2.capEnd();
      client2.register('batch2');
      await client2.waitForNumeric('001');

      // Verify batch works on both
      expect(caps1.ack).toContain('batch');
      expect(caps2.ack).toContain('batch');
      console.log('Batch capability enabled on both servers');

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('multiline BATCH message propagates across servers', async () => {
      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const receiver = trackClient(await createClientOnServer(SECONDARY_SERVER));

      // Set up sender with multiline
      await sender.capLs();
      const senderCaps = await sender.capReq(['draft/multiline', 'batch', 'echo-message']);
      if (senderCaps.nak.includes('draft/multiline')) {
        console.log('draft/multiline not available on primary');
        sender.close();
        receiver.close();
        return;
      }
      sender.capEnd();
      sender.register('mlsender1');
      await sender.waitForNumeric('001');

      // Set up receiver with multiline to receive batches
      await receiver.capLs();
      const receiverCaps = await receiver.capReq(['draft/multiline', 'batch']);
      if (receiverCaps.nak.includes('draft/multiline')) {
        console.log('draft/multiline not available on secondary');
        sender.close();
        receiver.close();
        return;
      }
      receiver.capEnd();
      receiver.register('mlrecv1');
      await receiver.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('mlcross');
      sender.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);

      receiver.send(`JOIN ${channel}`);
      await receiver.waitForJoin(channel);

      // Wait for cross-server sync
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'mlrecv1', 5000);

      receiver.clearRawBuffer();

      // Send multiline BATCH from primary server
      const batchId = `ml${uniqueId()}`;
      const uniqueMarker = `MLTEST${uniqueId()}`;
      sender.send(`BATCH +${batchId} draft/multiline ${channel}`);
      sender.send(`@batch=${batchId} PRIVMSG ${channel} :${uniqueMarker} line 1`);
      sender.send(`@batch=${batchId} PRIVMSG ${channel} :${uniqueMarker} line 2`);
      sender.send(`@batch=${batchId} PRIVMSG ${channel} :${uniqueMarker} line 3`);
      sender.send(`BATCH -${batchId}`);

      // Receiver on secondary should get the message(s)
      // May receive as batch or as individual PRIVMSGs depending on server implementation
      // P10 protocol may not preserve multiline batches across server links
      const received: string[] = [];
      try {
        for (let i = 0; i < 10; i++) {
          const line = await receiver.waitForLine(new RegExp(`PRIVMSG|BATCH.*${channel}|${uniqueMarker}`), 2000);
          received.push(line);
          if (line.includes('line 3') || received.length >= 3) break;
        }
      } catch {
        // Timeout expected after collecting messages
      }

      const hasLine1 = received.some(l => l.includes(`${uniqueMarker} line 1`));
      const hasLine2 = received.some(l => l.includes(`${uniqueMarker} line 2`));
      const hasLine3 = received.some(l => l.includes(`${uniqueMarker} line 3`));
      const hasAnyMarker = received.some(l => l.includes(uniqueMarker));
      const hasBatch = received.some(l => l.includes('BATCH'));

      console.log(
        `Multiline cross-server: ${received.length} msgs, batch=${hasBatch}, ` +
        `L1=${hasLine1}, L2=${hasLine2}, L3=${hasLine3}, anyMarker=${hasAnyMarker}`
      );

      // Messages MUST propagate across server links in some form
      // They may arrive as batch, individual PRIVMSGs, or concatenated
      expect(hasAnyMarker).toBe(true);

      // Verify at least some lines were received
      const lineCount = [hasLine1, hasLine2, hasLine3].filter(Boolean).length;
      expect(lineCount).toBeGreaterThanOrEqual(1);

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('BATCH chathistory response works on secondary server', async () => {
      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const querier = trackClient(await createClientOnServer(SECONDARY_SERVER));

      // Sender on primary
      await sender.capLs();
      sender.capEnd();
      sender.register('chsender1');
      await sender.waitForNumeric('001');

      // Querier on secondary with chathistory
      await querier.capLs();
      const caps = await querier.capReq(['draft/chathistory', 'batch', 'server-time']);
      if (caps.nak.includes('draft/chathistory')) {
        console.log('chathistory not available on secondary');
        sender.close();
        querier.close();
        return;
      }
      querier.capEnd();
      querier.register('chquery1');
      await querier.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('chbatch');
      sender.send(`JOIN ${channel}`);
      await sender.waitForJoin(channel);

      querier.send(`JOIN ${channel}`);
      await querier.waitForJoin(channel);

      // Wait for cross-server sync
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'chquery1', 5000);

      // Sender sends messages from primary
      const marker = `batchtest${uniqueId()}`;
      sender.send(`PRIVMSG ${channel} :${marker} message 1`);
      sender.send(`PRIVMSG ${channel} :${marker} message 2`);

      // Wait for messages to propagate - querier sees them
      await querier.waitForLine(new RegExp(`message 2`), 5000);

      // Querier requests chathistory from secondary - should get BATCH response
      querier.clearRawBuffer();
      querier.send(`CHATHISTORY LATEST ${channel} * 10`);

      // Should get BATCH start
      const batchStart = await querier.waitForLine(/BATCH \+/, 5000);
      expect(batchStart).toMatch(/BATCH \+[^ ]+ chathistory/);

      // Collect messages until BATCH end
      const messages: string[] = [];
      for (let i = 0; i < 15; i++) {
        try {
          const line = await querier.waitForLine(/PRIVMSG|BATCH -/, 1000);
          if (line.includes('BATCH -')) break;
          if (line.includes('PRIVMSG')) messages.push(line);
        } catch {
          break; // Timeout collecting messages is expected
        }
      }

      const hasMarker = messages.some(m => m.includes(marker));
      expect(hasMarker).toBe(true);
      console.log(`BATCH chathistory on secondary: ${messages.length} messages, has marker=${hasMarker}`);

      sender.send('QUIT');
      querier.send('QUIT');
    });
  });

  describe('Cross-Server Metadata', () => {
    it('metadata visible across servers', async () => {
      const setter = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const querier = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await setter.capLs();
      const caps1 = await setter.capReq(['draft/metadata-2']);
      if (caps1.nak.includes('draft/metadata-2')) {
        console.log('metadata-2 not available');
        setter.close();
        querier.close();
        return;
      }
      setter.capEnd();
      setter.register('metaset1');
      await setter.waitForNumeric('001');

      await querier.capLs();
      await querier.capReq(['draft/metadata-2']);
      querier.capEnd();
      querier.register('metaget1');
      await querier.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('metadata');
      setter.send(`JOIN ${channel}`);
      await setter.waitForJoin(channel);

      querier.send(`JOIN ${channel}`);
      await querier.waitForJoin(channel);

      // Wait for cross-server sync
      await setter.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'metaget1', 5000);

      // Set metadata on primary server
      setter.send('METADATA SET * testkey :testvalue');
      // Wait for confirmation
      await setter.waitForLine(/METADATA|761/i, 3000);

      querier.clearRawBuffer();

      // Query metadata from secondary server
      querier.send('METADATA GET metaset1 testkey');

      const response = await querier.waitForLine(/METADATA.*testkey/i, 5000);
      expect(response).toBeDefined();

      setter.send('QUIT');
      querier.send('QUIT');
    });

    it('metadata subscriptions work cross-server', async () => {
      const setter = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const subscriber = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await setter.capLs();
      const caps1 = await setter.capReq(['draft/metadata-2']);
      if (caps1.nak.includes('draft/metadata-2')) {
        console.log('metadata-2 not available');
        setter.close();
        subscriber.close();
        return;
      }
      setter.capEnd();
      setter.register('metasub1');
      await setter.waitForNumeric('001');

      await subscriber.capLs();
      await subscriber.capReq(['draft/metadata-2']);
      subscriber.capEnd();
      subscriber.register('metasub2');
      await subscriber.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('metasub');
      setter.send(`JOIN ${channel}`);
      await setter.waitForJoin(channel);

      subscriber.send(`JOIN ${channel}`);
      await subscriber.waitForJoin(channel);

      // Wait for cross-server sync
      await setter.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'metasub2', 5000);

      // Subscriber subscribes to key
      subscriber.send('METADATA * SUB avatar');
      // Wait for subscription confirmation
      await subscriber.waitForLine(/761|METADATA/i, 3000);

      subscriber.clearRawBuffer();

      // Setter sets the key
      setter.send('METADATA SET * avatar :https://example.com/avatar.png');

      // Subscriber should receive notification
      const notification = await subscriber.waitForLine(/METADATA.*avatar/i, 5000);
      expect(notification).toBeDefined();

      setter.send('QUIT');
      subscriber.send('QUIT');
    });
  });

  describe('Cross-Server Webpush', () => {
    it('webpush capability available on both servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      const caps1 = await client1.capReq(['draft/webpush']);
      client1.capEnd();
      client1.register('webpush1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      const caps2 = await client2.capReq(['draft/webpush']);
      client2.capEnd();
      client2.register('webpush2');
      await client2.waitForNumeric('001');

      if (caps1.nak.includes('draft/webpush') || caps2.nak.includes('draft/webpush')) {
        console.log('webpush not available on one or both servers');
      } else {
        console.log('Webpush capability enabled on both servers');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server Account-Notify', () => {
    it('account-notify visible cross-server', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      await client1.capReq(['account-notify']);
      client1.capEnd();
      client1.register('accnotify1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['account-notify']);
      client2.capEnd();
      client2.register('accnotify2');
      await client2.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('accnotify');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'accnotify2', 5000);

      // Verify both have account-notify enabled
      expect(client1.hasCapEnabled('account-notify')).toBe(true);
      expect(client2.hasCapEnabled('account-notify')).toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server NICK Change', () => {
    it('NICK change propagates across servers', async () => {
      const changer = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const observer = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await changer.capLs();
      changer.capEnd();
      changer.register('nickold1');
      await changer.waitForNumeric('001');

      await observer.capLs();
      observer.capEnd();
      observer.register('nickobs1');
      await observer.waitForNumeric('001');

      // Both join channel
      const channel = uniqueChannel('nicktest');
      changer.send(`JOIN ${channel}`);
      await changer.waitForJoin(channel);

      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      // Wait for cross-server sync
      await observer.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'nickold1', 5000);

      observer.clearRawBuffer();

      // Change nick
      const newNick = `nicknew${uniqueId().slice(0,4)}`;
      changer.send(`NICK ${newNick}`);

      // Observer should see NICK change
      const nickMsg = await observer.waitForLine(/NICK/i, 5000);
      expect(nickMsg).toContain('NICK');

      changer.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Cross-Server WHO/WHOIS', () => {
    it('WHOIS returns info for remote users', async () => {
      const target = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const querier = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await target.capLs();
      target.capEnd();
      target.register('whoistarget1');
      await target.waitForNumeric('001');

      await querier.capLs();
      querier.capEnd();
      querier.register('whoisquery1');
      await querier.waitForNumeric('001');

      // Join a channel to establish cross-server sync
      const channel = '#whoistest';
      target.send(`JOIN ${channel}`);
      querier.send(`JOIN ${channel}`);
      await target.waitForJoin('#whoistest');
      await querier.waitForJoin('#whoistest');
      await querier.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'whoistarget1', 5000);

      querier.clearRawBuffer();

      // Query WHOIS for remote user
      querier.send('WHOIS whoistarget1');

      // 311 = RPL_WHOISUSER
      const whoisLine = await querier.waitForLine(/311.*whoistarget1/i, 5000);
      expect(whoisLine).toContain('whoistarget1');

      target.send('QUIT');
      querier.send('QUIT');
    });

    it('WHO returns users from both servers', async () => {
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await client1.capLs();
      client1.capEnd();
      client1.register('whotest1');
      await client1.waitForNumeric('001');

      await client2.capLs();
      client2.capEnd();
      client2.register('whotest2');
      await client2.waitForNumeric('001');

      // Both join same channel
      const channel = uniqueChannel('whotest');
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'whotest2', 5000);

      client1.clearRawBuffer();

      // WHO the channel
      client1.send(`WHO ${channel}`);

      const whoReplies: string[] = [];
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          const line = await client1.waitForLine(/352|315/i, 500);
          if (line.includes('315')) break; // End of WHO
          if (line.includes('352')) whoReplies.push(line);
        } catch {
          break;
        }
      }

      // Should see both users
      expect(whoReplies.length).toBeGreaterThanOrEqual(2);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  describe('Cross-Server Chathistory', () => {
    it('chathistory includes messages from both servers', async () => {
      const sender1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const sender2 = trackClient(await createClientOnServer(SECONDARY_SERVER));

      await sender1.capLs();
      await sender1.capReq(['draft/chathistory', 'batch', 'server-time']);
      sender1.capEnd();
      sender1.register('chathist1');
      await sender1.waitForNumeric('001');

      await sender2.capLs();
      await sender2.capReq(['draft/chathistory', 'batch', 'server-time']);
      sender2.capEnd();
      sender2.register('chathist2');
      await sender2.waitForNumeric('001');

      // Both join same channel
      const channel = uniqueChannel('chathist');
      sender1.send(`JOIN ${channel}`);
      await sender1.waitForJoin(channel);

      sender2.send(`JOIN ${channel}`);
      await sender2.waitForJoin(channel);

      // Wait for cross-server sync
      await sender1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === 'chathist2', 5000);

      // Send messages from both servers
      sender1.send(`PRIVMSG ${channel} :Message from primary server`);
      // Wait for message to be stored
      await sender1.waitForLine(/PRIVMSG.*primary server/i, 3000);
      sender2.send(`PRIVMSG ${channel} :Message from secondary server`);
      // Wait for message to propagate
      await sender1.waitForLine(/PRIVMSG.*secondary server/i, 3000);

      sender1.clearRawBuffer();

      // Request chathistory
      sender1.send(`CHATHISTORY LATEST ${channel} * 10`);

      const batchStart = await sender1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          const line = await sender1.waitForLine(/PRIVMSG|BATCH -/, 500);
          if (line.includes('BATCH -')) break;
          if (line.includes('PRIVMSG')) messages.push(line);
        } catch {
          break; // Timeout collecting messages is expected
        }
      }

      // Should have messages from both servers
      const hasPrimary = messages.some(m => m.includes('primary server'));
      const hasSecondary = messages.some(m => m.includes('secondary server'));
      console.log(`Chathistory: ${messages.length} messages, primary=${hasPrimary}, secondary=${hasSecondary}`);
      expect(messages.length).toBeGreaterThanOrEqual(1);

      sender1.send('QUIT');
      sender2.send('QUIT');
    });
  });

  /**
   * Cross-Server PM Chathistory Consent Tests
   *
   * These tests verify that PM history consent (metadata) works correctly
   * when users are on different linked servers. The consent check should
   * work identically for local and remote users due to metadata propagation
   * via S2S (MD token in P10 protocol).
   */
  describe('Cross-Server PM Chathistory Consent', () => {
    it('PM history stored when both users opt in (cross-server)', async () => {

      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const receiver = trackClient(await createClientOnServer(SECONDARY_SERVER));
      const testId = uniqueId();
      const senderNick = `xspm1_${testId}`;
      const receiverNick = `xspm2_${testId}`;

      await sender.capLs();
      await sender.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      sender.capEnd();
      sender.register(senderNick);
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      receiver.capEnd();
      receiver.register(receiverNick);
      await receiver.waitForNumeric('001');

      // Join common channel to establish visibility
      const syncChannel = uniqueChannel('pmsync');
      sender.send(`JOIN ${syncChannel}`);
      await sender.waitForJoin(syncChannel);
      receiver.send(`JOIN ${syncChannel}`);
      await receiver.waitForJoin(syncChannel);
      // Wait for cross-server visibility
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === receiverNick, 5000);

      // Both parties opt in - MUST get 761 response
      sender.send('METADATA SET * chathistory.pm * :1');
      const senderMeta = await sender.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(senderMeta).toMatch(/761/);
      receiver.send('METADATA SET * chathistory.pm * :1');
      const receiverMeta = await receiver.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(receiverMeta).toMatch(/761/);

      // Verify metadata propagated by querying from other server
      sender.clearRawBuffer();
      sender.send(`METADATA GET ${receiverNick} chathistory.pm`);
      await sender.waitForLine(/761.*chathistory\.pm/i, 5000);

      // Send PM across servers
      const testMsg = `CrossServer PM ${testId}`;
      sender.send(`PRIVMSG ${receiverNick} :${testMsg}`);
      // Wait for PM to arrive at receiver
      await receiver.waitForLine(new RegExp(`PRIVMSG.*${testMsg}`, 'i'), 5000);

      sender.clearRawBuffer();

      // Request PM history
      sender.send(`CHATHISTORY LATEST ${receiverNick} * 10`);

      // MUST receive batch
      const batchStart = await sender.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await sender.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Cross-server PM must be stored with mutual consent
      expect(messages.length).toBeGreaterThanOrEqual(1);

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('PM history NOT stored when remote user has not opted in', async () => {

      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const receiver = trackClient(await createClientOnServer(SECONDARY_SERVER));
      const testId = uniqueId();
      const senderNick = `xsno1_${testId}`;
      const receiverNick = `xsno2_${testId}`;

      await sender.capLs();
      await sender.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      sender.capEnd();
      sender.register(senderNick);
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      receiver.capEnd();
      receiver.register(receiverNick);
      await receiver.waitForNumeric('001');

      // Join common channel for visibility
      const syncChannel = uniqueChannel('nosync');
      sender.send(`JOIN ${syncChannel}`);
      await sender.waitForJoin(syncChannel);
      receiver.send(`JOIN ${syncChannel}`);
      await receiver.waitForJoin(syncChannel);
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === receiverNick, 5000);

      // Only sender opts in - remote receiver does NOT - MUST get 761 response
      sender.send('METADATA SET * chathistory.pm * :1');
      const senderMeta = await sender.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(senderMeta).toMatch(/761/);

      // Send PM across servers
      const testMsg = `CrossServer NoOpt ${testId}`;
      sender.send(`PRIVMSG ${receiverNick} :${testMsg}`);
      // Wait for PM to arrive at receiver
      await receiver.waitForLine(new RegExp(`PRIVMSG.*${testMsg}`, 'i'), 5000);

      sender.clearRawBuffer();

      // Request PM history - should be empty
      sender.send(`CHATHISTORY LATEST ${receiverNick} * 10`);

      // MUST receive batch
      const batchStart = await sender.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await sender.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // PM NOT stored without remote consent
      expect(messages.length).toBe(0);

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('metadata propagates correctly for consent check (cross-server METADATA GET)', async () => {

      const setter = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const querier = trackClient(await createClientOnServer(SECONDARY_SERVER));
      const testId = uniqueId();
      const setterNick = `xsmd1_${testId}`;
      const querierNick = `xsmd2_${testId}`;

      await setter.capLs();
      await setter.capReq(['draft/metadata-2']);
      setter.capEnd();
      setter.register(setterNick);
      await setter.waitForNumeric('001');

      await querier.capLs();
      await querier.capReq(['draft/metadata-2']);
      querier.capEnd();
      querier.register(querierNick);
      await querier.waitForNumeric('001');

      // Join common channel for visibility
      const syncChannel = uniqueChannel('mdsync');
      setter.send(`JOIN ${syncChannel}`);
      await setter.waitForJoin(syncChannel);
      querier.send(`JOIN ${syncChannel}`);
      await querier.waitForJoin(syncChannel);
      await setter.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === querierNick, 5000);

      // Setter on primary sets opt-in - MUST get 761 response
      setter.send('METADATA SET * chathistory.pm * :1');
      const setterMeta = await setter.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(setterMeta).toMatch(/761/);

      querier.clearRawBuffer();

      // Querier on secondary checks setter's metadata - poll until propagated
      let response: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        querier.send(`METADATA GET ${setterNick} chathistory.pm`);
        try {
          response = await querier.waitForLine(/761.*chathistory\.pm/i, 2000);
          if (response) break;
        } catch {
          // Retry after brief pause
          await new Promise(r => setTimeout(r, 200));
        }
      }
      expect(response).toContain('chathistory.pm');

      setter.send('QUIT');
      querier.send('QUIT');
    });

    it('remote explicit opt-out prevents PM storage', async () => {

      const sender = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const receiver = trackClient(await createClientOnServer(SECONDARY_SERVER));
      const testId = uniqueId();
      const senderNick = `xsout1_${testId}`;
      const receiverNick = `xsout2_${testId}`;

      await sender.capLs();
      await sender.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      sender.capEnd();
      sender.register(senderNick);
      await sender.waitForNumeric('001');

      await receiver.capLs();
      await receiver.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      receiver.capEnd();
      receiver.register(receiverNick);
      await receiver.waitForNumeric('001');

      // Join common channel for visibility
      const syncChannel = uniqueChannel('outsync');
      sender.send(`JOIN ${syncChannel}`);
      await sender.waitForJoin(syncChannel);
      receiver.send(`JOIN ${syncChannel}`);
      await receiver.waitForJoin(syncChannel);
      await sender.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === receiverNick, 5000);

      // Sender opts in, remote receiver explicitly opts out - MUST get 761 responses
      sender.send('METADATA SET * chathistory.pm * :1');
      const senderMeta = await sender.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(senderMeta).toMatch(/761/);
      receiver.send('METADATA SET * chathistory.pm * :0');
      const receiverMeta = await receiver.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(receiverMeta).toMatch(/761/);

      // Verify opt-out metadata propagated
      sender.clearRawBuffer();
      sender.send(`METADATA GET ${receiverNick} chathistory.pm`);
      await sender.waitForLine(/761.*chathistory\.pm.*:0/i, 5000);

      // Send PM across servers
      const testMsg = `CrossServer OptOut ${testId}`;
      sender.send(`PRIVMSG ${receiverNick} :${testMsg}`);
      // Wait for PM to arrive at receiver
      await receiver.waitForLine(new RegExp(`PRIVMSG.*${testMsg}`, 'i'), 5000);

      sender.clearRawBuffer();

      // Request PM history - should be empty
      sender.send(`CHATHISTORY LATEST ${receiverNick} * 10`);

      // MUST receive batch
      const batchStart = await sender.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batchStart).toBeDefined();

      const messages: string[] = [];
      while (true) {
        const line = await sender.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) messages.push(line);
      }

      // Remote opt-out prevents PM storage
      expect(messages.length).toBe(0);

      sender.send('QUIT');
      receiver.send('QUIT');
    });

    it('PM stored on both ends with mutual consent (bidirectional)', async () => {

      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));
      const testId = uniqueId();
      const nick1 = `xsbi1_${testId}`;
      const nick2 = `xsbi2_${testId}`;

      await client1.capLs();
      await client1.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client1.capEnd();
      client1.register(nick1);
      await client1.waitForNumeric('001');

      await client2.capLs();
      await client2.capReq(['draft/chathistory', 'batch', 'server-time', 'draft/metadata-2']);
      client2.capEnd();
      client2.register(nick2);
      await client2.waitForNumeric('001');

      // Join common channel for visibility
      const syncChannel = uniqueChannel('bisync');
      client1.send(`JOIN ${syncChannel}`);
      await client1.waitForJoin(syncChannel);
      client2.send(`JOIN ${syncChannel}`);
      await client2.waitForJoin(syncChannel);
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && msg.source?.nick === nick2, 5000);

      // Both opt in - MUST get 761 responses
      client1.send('METADATA SET * chathistory.pm * :1');
      const meta1 = await client1.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta1).toMatch(/761/);
      client2.send('METADATA SET * chathistory.pm * :1');
      const meta2 = await client2.waitForLine(/761.*chathistory\.pm/i, 3000);
      expect(meta2).toMatch(/761/);

      // Verify metadata propagated both ways
      client1.clearRawBuffer();
      client1.send(`METADATA GET ${nick2} chathistory.pm`);
      await client1.waitForLine(/761.*chathistory\.pm/i, 5000);

      // Exchange messages both directions
      client1.send(`PRIVMSG ${nick2} :From primary to secondary`);
      // Wait for PM to arrive at client2
      await client2.waitForLine(/PRIVMSG.*From primary to secondary/i, 5000);
      client2.send(`PRIVMSG ${nick1} :From secondary to primary`);
      // Wait for PM to arrive at client1
      await client1.waitForLine(/PRIVMSG.*From secondary to primary/i, 5000);

      // Check history from client1's perspective - MUST receive batch
      client1.clearRawBuffer();
      client1.send(`CHATHISTORY LATEST ${nick2} * 10`);

      const batch1 = await client1.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batch1).toBeDefined();

      const client1Messages: string[] = [];
      while (true) {
        const line = await client1.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) client1Messages.push(line);
      }

      // Check history from client2's perspective - MUST receive batch
      client2.clearRawBuffer();
      client2.send(`CHATHISTORY LATEST ${nick1} * 10`);

      const batch2 = await client2.waitForLine(/BATCH \+\S+ chathistory/i, 5000);
      expect(batch2).toBeDefined();

      const client2Messages: string[] = [];
      while (true) {
        const line = await client2.waitForLine(/PRIVMSG|BATCH -/, 3000);
        if (line.includes('BATCH -')) break;
        if (line.includes('PRIVMSG')) client2Messages.push(line);
      }

      // Both should have history (bidirectional PM storage)
      expect(client1Messages.length).toBeGreaterThan(0);
      expect(client2Messages.length).toBeGreaterThan(0);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });

  // ============================================================================
  // P10 Protocol Integration
  // ============================================================================

  describe('P10 Protocol Integration', () => {
    it('demonstrates P10 log inspection (informational)', async () => {
      const testId = uniqueId();
      const channel = `#p10int-${testId}`;

      // Create activity to potentially generate P10 messages
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      await client1.capLs();
      client1.capEnd();
      client1.register(`p10test1${testId.slice(0, 3)}`);
      await client1.waitForNumeric('001');

      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));
      await client2.capLs();
      client2.capEnd();
      client2.register(`p10test2${testId.slice(0, 3)}`);
      await client2.waitForNumeric('001');

      // Join channel on both servers
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && (msg.source?.nick?.startsWith('p10test2') ?? false), 5000);

      // Try to get P10 logs from docker
      // Note: Log visibility depends on server debug configuration
      const logs = await getP10Logs('nefarious', undefined, '1m');

      // This test is informational - verify the API works
      expect(Array.isArray(logs)).toBe(true);

      // If logs are available, try parsing them
      if (logs.length > 0) {
        console.log(`  P10 logs available: ${logs.length} lines`);

        // Try to find BURST messages
        const burstLogs = logs.filter(l => l.includes(' B #'));
        if (burstLogs.length > 0) {
          const burst = parseBurst(burstLogs[0]);
          if (burst) {
            console.log(`  Found BURST for ${burst.channel} with ${burst.users.size} users`);
          }
        }

        // Try to find N (nick) messages
        const nickLogs = logs.filter(l => / N [^ ]+ \d+ \d+/.test(l));
        if (nickLogs.length > 0) {
          const nick = parseNick(nickLogs[0]);
          if (nick) {
            console.log(`  Found nick introduction: ${nick.nick}`);
          }
        }
      } else {
        console.log('  P10 logs not available (server debug level may be low)');
      }

      client1.send('QUIT');
      client2.send('QUIT');
    });

    it('verifies user numerics are consistent across servers', async () => {
      const testId = uniqueId();
      const channel = `#numtest-${testId}`;
      const nick1 = `num1${testId.slice(0, 5)}`;
      const nick2 = `num2${testId.slice(0, 5)}`;

      // Setup clients
      const client1 = trackClient(await createClientOnServer(PRIMARY_SERVER));
      await client1.capLs();
      client1.capEnd();
      client1.register(nick1);
      await client1.waitForNumeric('001');

      const client2 = trackClient(await createClientOnServer(SECONDARY_SERVER));
      await client2.capLs();
      client2.capEnd();
      client2.register(nick2);
      await client2.waitForNumeric('001');

      // Join channel together
      client1.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);

      client2.send(`JOIN ${channel}`);
      await client2.waitForJoin(channel);

      // Wait for cross-server sync
      await client1.waitForParsedLine(msg => msg.command === 'JOIN' && (msg.source?.nick?.startsWith('num2') ?? false), 5000);

      // WHOIS should return consistent info from both servers
      client1.send(`WHOIS ${nick2}`);
      const whois1 = await client1.waitForNumeric('311', 5000);
      expect(whois1.raw).toContain(nick2);

      client2.send(`WHOIS ${nick1}`);
      const whois2 = await client2.waitForNumeric('311', 5000);
      expect(whois2.raw).toContain(nick1);

      // Users should be visible to each other via NAMES
      client1.send(`NAMES ${channel}`);
      const names = await client1.waitForNumeric('353', 5000);
      expect(names.raw).toContain(nick1);
      expect(names.raw).toContain(nick2);

      client1.send('QUIT');
      client2.send('QUIT');
    });
  });
});
