/**
 * IRC-over-WebSocket Protocol Tests
 *
 * Tests IRC protocol operations over WebSocket connections:
 * - Client registration (NICK/USER/PING-PONG)
 * - Channel operations (JOIN/PART/PRIVMSG)
 * - Multiple concurrent clients
 * - Message routing between WebSocket and raw socket clients
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  WebSocketTestClient,
  createWebSocketClient,
  WS_OPCODE,
} from '../helpers/websocket-client';
import { createRawSocketClient, RawSocketClient } from '../helpers/ircv3-client';

// Generate unique identifiers for test isolation
function uniqueNick(prefix = 'ws'): string {
  return `${prefix}${randomUUID().slice(0, 8)}`;
}

function uniqueChannel(): string {
  return `#ws${randomUUID().slice(0, 8)}`;
}

describe('IRC-over-WebSocket Protocol', () => {
  const clients: (WebSocketTestClient | RawSocketClient)[] = [];

  // Track clients for cleanup
  function trackClient<T extends WebSocketTestClient | RawSocketClient>(client: T): T {
    clients.push(client);
    return client;
  }

  afterEach(() => {
    for (const client of clients) {
      try {
        if (client instanceof WebSocketTestClient) {
          client.disconnect();
        } else {
          client.close();
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    clients.length = 0;
  });

  describe('Client Registration', () => {
    it('should complete IRC registration over WebSocket', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wsreg');

      const registered = await client.register(nick);
      expect(registered).toBe(true);
    });

    it('should receive RPL_WELCOME (001) after registration', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wswelcome');

      // Use register() which handles PING/PONG automatically
      const registered = await client.register(nick);
      expect(registered).toBe(true);

      // Also verify we got 001 in the frames
      const frames = client.getFrames();
      const hasWelcome = frames.some(
        (f) => f.payload.toString('utf8').includes(' 001 ')
      );
      expect(hasWelcome).toBe(true);
    });

    it('should receive PING and respond with PONG during registration', async () => {
      const client = trackClient(new WebSocketTestClient());
      await client.connect();

      const nick = uniqueNick('wsping');
      client.send(`NICK ${nick}`);
      client.send(`USER ${nick} 0 * :WebSocket Test`);

      // The register() method handles PING internally, so this should work
      // We're testing that the server sends PING during registration
      const start = Date.now();
      let gotPing = false;

      while (Date.now() - start < 10000) {
        for (const frame of client.getFrames()) {
          if (frame.opcode === WS_OPCODE.TEXT || frame.opcode === WS_OPCODE.BINARY) {
            const text = frame.payload.toString('utf8');
            if (text.includes('PING')) {
              gotPing = true;
              // Respond to PING
              const pingMatch = text.match(/PING :?(.+)/);
              if (pingMatch) {
                client.send(`PONG :${pingMatch[1].trim()}`);
              }
            }
            if (text.includes(' 001 ')) {
              // Got welcome, test passed
              expect(gotPing).toBe(true);
              return;
            }
          }
        }
        client.clearFrames();
        await new Promise((r) => setTimeout(r, 100));
      }

      throw new Error('Registration timeout');
    });

    it('should handle ERR_NICKNAMEINUSE (433)', async () => {
      const nick = uniqueNick('wsdupe');

      // First client takes the nick
      const client1 = trackClient(await createWebSocketClient());
      await client1.register(nick);

      // Second client tries same nick
      const client2 = trackClient(await createWebSocketClient());
      client2.send(`NICK ${nick}`);
      client2.send(`USER ${nick} 0 * :Test`);

      // Should get 433 error
      const error = await client2.waitForText('433', 5000);
      expect(error).toContain('433');
    });

    it('should handle nick change during registration', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wsmulti');

      // Register first, then change nick
      const registered = await client.register(nick);
      expect(registered).toBe(true);

      // Change nick after registration
      const newNick = uniqueNick('wsnew');
      client.send(`NICK ${newNick}`);

      // Wait for NICK confirmation
      const nickConfirm = await client.waitForText('NICK', 5000);
      expect(nickConfirm).toContain(newNick);
    });
  });

  describe('Channel Operations', () => {
    it('should JOIN and receive JOIN confirmation', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wsjoin');
      const channel = uniqueChannel();

      await client.register(nick);
      client.send(`JOIN ${channel}`);

      // Should receive JOIN echo
      const join = await client.waitForText(`JOIN`, 5000);
      expect(join).toContain(channel);
    });

    it('should receive topic after JOIN', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wstopic');
      const channel = uniqueChannel();

      await client.register(nick);
      client.send(`JOIN ${channel}`);

      // Wait for RPL_ENDOFNAMES (366) which follows topic info
      const endOfNames = await client.waitForText('366', 5000);
      expect(endOfNames).toContain(channel);
    });

    it('should receive NAMES list after JOIN', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wsnames');
      const channel = uniqueChannel();

      await client.register(nick);
      client.send(`JOIN ${channel}`);

      // Should see ourselves in names list (353 = RPL_NAMREPLY)
      const names = await client.waitForText('353', 5000);
      expect(names).toContain(nick);
    });

    it('should PART channel and receive PART confirmation', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wspart');
      const channel = uniqueChannel();

      await client.register(nick);
      client.send(`JOIN ${channel}`);
      await client.waitForText('366', 5000); // Wait for join complete

      client.send(`PART ${channel} :Goodbye`);

      // Should receive PART echo
      const part = await client.waitForText('PART', 5000);
      expect(part).toContain(channel);
    });

    it('should send and receive PRIVMSG in channel', async () => {
      const channel = uniqueChannel();
      const message = `Hello from WebSocket ${randomUUID().slice(0, 8)}`;

      // Two clients in same channel
      const client1 = trackClient(await createWebSocketClient());
      const client2 = trackClient(await createWebSocketClient());
      const nick1 = uniqueNick('wsmsg1');
      const nick2 = uniqueNick('wsmsg2');

      await client1.register(nick1);
      await client2.register(nick2);

      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForText('366', 5000);
      await client2.waitForText('366', 5000);

      // Clear buffers and settle delay to avoid consuming stale frames
      client1.clearFrames();
      client2.clearFrames();
      await new Promise(r => setTimeout(r, 200));

      // Client1 sends message
      client1.send(`PRIVMSG ${channel} :${message}`);

      // Client2 should receive it
      const received = await client2.waitForText(message, 5000);
      expect(received).toContain(message);
      expect(received).toContain(nick1); // From sender
    });

    it('should query channel MODE', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wsmode');
      const channel = uniqueChannel();

      await client.register(nick);
      client.send(`JOIN ${channel}`);
      await client.waitForText('366', 5000);

      // Clear frames and settle delay to avoid consuming stale frames
      client.clearFrames();
      await new Promise(r => setTimeout(r, 200));

      // Query channel modes (returns 324 RPL_CHANNELMODEIS)
      client.send(`MODE ${channel}`);

      // Should get 324 (RPL_CHANNELMODEIS) with channel modes
      const modeReply = await client.waitForText('324', 5000);
      expect(modeReply).toContain(channel);
    });
  });

  describe('Cross-Protocol Messaging', () => {
    it('should exchange messages between WebSocket and raw socket clients', async () => {
      const channel = uniqueChannel();
      const wsMessage = 'From WebSocket';
      const rawMessage = 'From Raw Socket';

      const wsClient = trackClient(await createWebSocketClient());
      const rawClient = trackClient(await createRawSocketClient());
      const wsNick = uniqueNick('wscross');
      const rawNick = uniqueNick('rawcross');

      await wsClient.register(wsNick);
      rawClient.register(rawNick);
      await rawClient.waitForNumeric('001', 10000);

      wsClient.send(`JOIN ${channel}`);
      rawClient.send(`JOIN ${channel}`);
      await wsClient.waitForText('366', 5000);
      await rawClient.waitForNumeric('366', 5000);

      // Clear buffers and settle delay to avoid consuming stale frames
      wsClient.clearFrames();
      rawClient.clearRawBuffer();
      await new Promise(r => setTimeout(r, 200));

      // WebSocket → Raw Socket
      wsClient.send(`PRIVMSG ${channel} :${wsMessage}`);
      const rawReceived = await rawClient.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.raw.includes(wsMessage),
        5000
      );
      expect(rawReceived.raw).toContain(wsMessage);

      // Raw Socket → WebSocket
      rawClient.send(`PRIVMSG ${channel} :${rawMessage}`);
      const wsReceived = await wsClient.waitForText(rawMessage, 5000);
      expect(wsReceived).toContain(rawMessage);
    });

    it('should handle JOIN/PART visibility across protocols', async () => {
      const channel = uniqueChannel();

      const wsClient = trackClient(await createWebSocketClient());
      const rawClient = trackClient(await createRawSocketClient());
      const wsNick = uniqueNick('wsjp');
      const rawNick = uniqueNick('rawjp');

      await wsClient.register(wsNick);
      rawClient.register(rawNick);
      await rawClient.waitForNumeric('001', 10000);

      // Raw client joins first
      rawClient.send(`JOIN ${channel}`);
      await rawClient.waitForNumeric('366', 5000);

      // WebSocket client joins - raw should see JOIN
      rawClient.clearRawBuffer();
      wsClient.send(`JOIN ${channel}`);

      const rawSeesJoin = await rawClient.waitForParsedLine(
        msg => msg.command === 'JOIN' && msg.raw.includes(channel),
        5000
      );
      expect(rawSeesJoin.raw).toContain(wsNick);

      // Wait for ws to be fully joined
      await wsClient.waitForText('366', 5000);
      wsClient.clearFrames();
      await new Promise(r => setTimeout(r, 200));

      // WebSocket client parts - raw should see PART
      wsClient.send(`PART ${channel}`);
      const rawSeesPart = await rawClient.waitForPart(channel, wsNick, 5000);
      expect(rawSeesPart.raw).toContain(wsNick);
    });
  });

  describe('Direct Messages', () => {
    it('should send private message between WebSocket clients', async () => {
      const client1 = trackClient(await createWebSocketClient());
      const client2 = trackClient(await createWebSocketClient());
      const nick1 = uniqueNick('wsdm1');
      const nick2 = uniqueNick('wsdm2');
      const message = `Private message ${randomUUID().slice(0, 8)}`;

      await client1.register(nick1);
      await client2.register(nick2);

      // Clear frames and settle delay to avoid consuming stale frames
      client1.clearFrames();
      client2.clearFrames();
      await new Promise(r => setTimeout(r, 200));

      // Send DM from client1 to client2
      client1.send(`PRIVMSG ${nick2} :${message}`);

      // Client2 should receive it
      const received = await client2.waitForText(message, 5000);
      expect(received).toContain(message);
      expect(received).toContain(nick1);
    });

    it('should receive NOTICE messages', async () => {
      const client1 = trackClient(await createWebSocketClient());
      const client2 = trackClient(await createWebSocketClient());
      const nick1 = uniqueNick('wsnot1');
      const nick2 = uniqueNick('wsnot2');
      const notice = `Notice ${randomUUID().slice(0, 8)}`;

      await client1.register(nick1);
      await client2.register(nick2);

      // Clear frames and settle delay to avoid consuming stale frames
      client2.clearFrames();
      await new Promise(r => setTimeout(r, 200));

      // Send NOTICE from client1 to client2
      client1.send(`NOTICE ${nick2} :${notice}`);

      // Client2 should receive it
      const received = await client2.waitForText(notice, 5000);
      expect(received).toContain('NOTICE');
      expect(received).toContain(notice);
    });
  });

  describe('Connection Management', () => {
    it('should handle graceful QUIT', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wsquit');

      await client.register(nick);

      // Send QUIT
      client.send('QUIT :Goodbye');

      // Should receive close frame or ERROR message
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Connection should be closed or closing
      // The server may send a close frame or just disconnect
    });

    it('should handle WebSocket CLOSE followed by reconnect', async () => {
      const nick = uniqueNick('wsrecon');

      // First connection
      let client = await createWebSocketClient();
      await client.register(nick);
      client.close(1000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      client.disconnect();

      // Wait for server to clean up nick
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Reconnect with same nick
      client = trackClient(await createWebSocketClient());
      const registered = await client.register(nick);
      expect(registered).toBe(true);
    });

    it('should handle concurrent WebSocket connections', async () => {
      const numClients = 5;
      const channel = uniqueChannel();
      const testClients: WebSocketTestClient[] = [];

      // Create and register multiple clients concurrently
      const createPromises = Array.from({ length: numClients }, async (_, i) => {
        const client = trackClient(await createWebSocketClient());
        const nick = uniqueNick(`wsc${i}`);
        await client.register(nick);
        testClients.push(client);
        return { client, nick };
      });

      const results = await Promise.all(createPromises);

      // All should join same channel
      for (const { client } of results) {
        client.send(`JOIN ${channel}`);
      }

      // All should receive join confirmations in parallel
      // Use longer timeout to account for concurrent connection overhead
      const joinPromises = results.map(async ({ client }) => {
        const join = await client.waitForText('366', 10000);
        expect(join).toContain(channel);
        return join;
      });
      await Promise.all(joinPromises);
    });
  });

  describe('Error Handling', () => {
    it('should receive ERR_NOSUCHCHANNEL for invalid channel', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wserr');

      await client.register(nick);

      // Try to message a channel we're not in
      client.send('PRIVMSG #nonexistent :hello');

      // Should get 404 or similar error
      const error = await client.waitForText(/4\d\d/, 5000);
      expect(error).toBeDefined();
    });

    it('should receive ERR_NOSUCHNICK for non-existent user', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wserr2');

      await client.register(nick);

      // Try to message a user that doesn't exist
      client.send('PRIVMSG nonexistent_user_xyz :hello');

      // Should get 401 (ERR_NOSUCHNICK)
      const error = await client.waitForText('401', 5000);
      expect(error).toContain('401');
    });

    it('should receive ERR_NEEDMOREPARAMS for incomplete commands', async () => {
      const client = trackClient(await createWebSocketClient());
      const nick = uniqueNick('wserr3');

      await client.register(nick);

      // JOIN without channel should trigger 461
      client.send('JOIN');

      // Should get 461 (ERR_NEEDMOREPARAMS)
      const error = await client.waitForText('461', 5000);
      expect(error).toContain('461');
    });
  });

  describe('Unicode and Special Characters', () => {
    it('should handle UTF-8 messages', async () => {
      const client1 = trackClient(await createWebSocketClient());
      const client2 = trackClient(await createWebSocketClient());
      const channel = uniqueChannel();
      const nick1 = uniqueNick('wsutf1');
      const nick2 = uniqueNick('wsutf2');

      await client1.register(nick1);
      await client2.register(nick2);

      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForText('366', 5000);
      await client2.waitForText('366', 5000);

      // Clear frames and settle delay to avoid consuming stale frames
      client2.clearFrames();
      await new Promise(r => setTimeout(r, 200));

      // Send UTF-8 message
      const utf8Message = 'Hello 世界 🌍 émoji';
      client1.send(`PRIVMSG ${channel} :${utf8Message}`);

      // Should receive intact
      const received = await client2.waitForText('世界', 5000);
      expect(received).toContain('世界');
    });

    it('should handle message with IRC formatting codes', async () => {
      const client1 = trackClient(await createWebSocketClient());
      const client2 = trackClient(await createWebSocketClient());
      const channel = uniqueChannel();
      const nick1 = uniqueNick('wsfmt1');
      const nick2 = uniqueNick('wsfmt2');

      await client1.register(nick1);
      await client2.register(nick2);

      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForText('366', 5000);
      await client2.waitForText('366', 5000);

      // Clear frames and settle delay to avoid consuming stale frames
      client2.clearFrames();
      await new Promise(r => setTimeout(r, 200));

      // Send message with IRC color/bold codes
      // \x02 = bold, \x03 = color
      const formattedMessage = '\x02Bold\x02 and \x0304Red\x03';
      client1.send(`PRIVMSG ${channel} :${formattedMessage}`);

      // Should receive with formatting intact
      const received = await client2.waitForText('Bold', 5000);
      expect(received).toContain('Bold');
    });
  });
});
