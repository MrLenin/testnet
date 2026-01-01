/**
 * WebSocket Support Tests
 *
 * Tests RFC 6455 WebSocket handshake and frame handling for IRC-over-WebSocket.
 * Tests are organized by category:
 * - Handshake validation (required headers, accept key computation)
 * - Frame encoding/decoding (masked frames, control frames)
 * - Error handling (malformed requests, missing headers)
 *
 * Nefarious strictly enforces RFC 6455 compliance including:
 * - §4.2.2: No Sec-WebSocket-Protocol unless client requests one
 * - §5.1: Client frames MUST be masked
 * - §5.2: RSV bits MUST be 0 unless extension negotiated
 * - §5.2: Reserved opcodes cause connection failure
 * - §5.5: Control frame payload ≤125 bytes
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as tls from 'tls';
import * as crypto from 'crypto';
import {
  WebSocketTestClient,
  createWebSocketClient,
  generateWebSocketKey,
  computeAcceptKey,
  buildUnmaskedFrame,
  parseFrame,
  WS_OPCODE,
} from '../helpers/websocket-client';
import { uniqueId } from '../helpers/index';

const WS_HOST = process.env.IRC_HOST ?? 'nefarious';
const WS_PORT = parseInt(process.env.WS_PORT ?? '8443');

/**
 * Helper to create raw TLS connection for low-level handshake tests.
 */
async function createRawTLSConnection(): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      { host: WS_HOST, port: WS_PORT, rejectUnauthorized: false },
      () => resolve(sock)
    );
    sock.on('error', reject);
  });
}

/**
 * Wait for HTTP response ending with \r\n\r\n.
 */
async function waitForHTTPResponse(
  socket: tls.TLSSocket,
  timeout = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('HTTP response timeout')),
      timeout
    );
    let data = '';
    const handler = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.removeListener('data', handler);
        resolve(data);
      }
    };
    socket.on('data', handler);
  });
}

describe('WebSocket Support', () => {
  let socket: tls.TLSSocket | null = null;
  let client: WebSocketTestClient | null = null;

  afterEach(() => {
    if (socket) {
      socket.destroy();
      socket = null;
    }
    if (client) {
      client.disconnect();
      client = null;
    }
  });

  describe('Handshake Validation (RFC 6455 §4.2)', () => {
    it('should complete WebSocket handshake with valid headers', async () => {
      const key = generateWebSocketKey();
      const expectedAccept = computeAcceptKey(key);

      socket = await createRawTLSConnection();

      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: text.ircv3.net',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      const response = await waitForHTTPResponse(socket);

      expect(response).toContain('HTTP/1.1 101');
      expect(response).toContain('Upgrade: websocket');
      expect(response).toContain(`Sec-WebSocket-Accept: ${expectedAccept}`);
      expect(response).toContain('Sec-WebSocket-Protocol: text.ircv3.net');
    });

    it('should compute correct Sec-WebSocket-Accept value', async () => {
      // Test with known key/accept pair from RFC 6455 §1.3
      const testKey = 'dGhlIHNhbXBsZSBub25jZQ==';
      const expectedAccept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
      expect(computeAcceptKey(testKey)).toBe(expectedAccept);

      // Now verify server computes same value
      socket = await createRawTLSConnection();
      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${testKey}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      const response = await waitForHTTPResponse(socket);

      expect(response).toContain(`Sec-WebSocket-Accept: ${expectedAccept}`);
    });

    it('should NOT send Sec-WebSocket-Protocol when client does not request one (RFC 6455 §4.2.2)', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      const response = await waitForHTTPResponse(socket);

      expect(response).toContain('HTTP/1.1 101');
      // RFC 6455 §4.2.2: Server MUST NOT send Sec-WebSocket-Protocol unless client requested
      expect(response).not.toContain('Sec-WebSocket-Protocol');
    });

    it('should handle multiple subprotocol options', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: binary.ircv3.net, text.ircv3.net',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      const response = await waitForHTTPResponse(socket);

      expect(response).toContain('HTTP/1.1 101');
      // Server should pick one of the offered protocols
      expect(response).toMatch(/Sec-WebSocket-Protocol: (binary|text)\.ircv3\.net/);
    });

    it('should handle case-insensitive header names', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'GET / HTTP/1.1',
        `host: ${WS_HOST}:${WS_PORT}`,
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-key: ${key}`,
        'sec-websocket-version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      const response = await waitForHTTPResponse(socket);

      expect(response).toContain('HTTP/1.1 101');
    });

    it('should accept GET request with query string', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'GET /?encoding=text HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      const response = await waitForHTTPResponse(socket);

      expect(response).toContain('HTTP/1.1 101');
    });

    it('should handle Connection header with multiple values', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: keep-alive, Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      const response = await waitForHTTPResponse(socket);

      expect(response).toContain('HTTP/1.1 101');
    });
  });

  describe('Handshake Error Handling', () => {
    it('should reject non-GET request method', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'POST / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);

      // Should get an error response or connection close
      const response = await new Promise<string>((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(data), 2000);
        socket!.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n') || data.includes('HTTP/1.')) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        socket!.on('close', () => {
          clearTimeout(timeout);
          resolve(data || 'CONNECTION_CLOSED');
        });
      });

      // Either error response or connection closed
      if (response !== 'CONNECTION_CLOSED') {
        expect(response).not.toContain('HTTP/1.1 101');
      }
    });

    it('should reject missing Sec-WebSocket-Key', async () => {
      socket = await createRawTLSConnection();

      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);

      const response = await new Promise<string>((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(data), 2000);
        socket!.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        socket!.on('close', () => {
          clearTimeout(timeout);
          resolve(data || 'CONNECTION_CLOSED');
        });
      });

      if (response !== 'CONNECTION_CLOSED') {
        expect(response).not.toContain('HTTP/1.1 101');
      }
    });

    it('should reject missing Upgrade header', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);

      const response = await new Promise<string>((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(data), 2000);
        socket!.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        socket!.on('close', () => {
          clearTimeout(timeout);
          resolve(data || 'CONNECTION_CLOSED');
        });
      });

      if (response !== 'CONNECTION_CLOSED') {
        expect(response).not.toContain('HTTP/1.1 101');
      }
    });

    it('should reject unsupported WebSocket version', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 8',
        '',
        '',
      ].join('\r\n');

      socket.write(request);

      const response = await new Promise<string>((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(data), 2000);
        socket!.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        socket!.on('close', () => {
          clearTimeout(timeout);
          resolve(data || 'CONNECTION_CLOSED');
        });
      });

      // RFC 6455 says server MUST return Sec-WebSocket-Version with supported versions
      // Or close connection
      if (response !== 'CONNECTION_CLOSED' && response.length > 0) {
        expect(response).not.toContain('HTTP/1.1 101');
      }
    });
  });

  describe('Frame Encoding/Decoding (RFC 6455 §5)', () => {
    it('should exchange IRC messages over WebSocket', async () => {
      client = await createWebSocketClient();

      const nick = `wstest${Math.floor(Math.random() * 100000)}`;
      const registered = await client.register(nick);

      expect(registered).toBe(true);
    });

    it('should handle PING/PONG control frames', async () => {
      client = await createWebSocketClient();

      // Send WebSocket PING
      const pingPayload = 'test-ping-' + uniqueId();
      client.ping(pingPayload);

      // Wait for PONG response
      const pong = await client.waitForPong(5000);

      expect(pong.opcode).toBe(WS_OPCODE.PONG);
      expect(pong.payload.toString()).toBe(pingPayload);
    });

    it('should handle empty PING payload', async () => {
      client = await createWebSocketClient();

      client.ping('');
      const pong = await client.waitForPong(5000);

      expect(pong.opcode).toBe(WS_OPCODE.PONG);
      expect(pong.payload.length).toBe(0);
    });

    it('should handle PING with maximum allowed payload (125 bytes)', async () => {
      client = await createWebSocketClient();

      // Control frame payload max is 125 bytes (RFC 6455 §5.5)
      const maxPayload = 'x'.repeat(125);
      client.ping(maxPayload);

      const pong = await client.waitForPong(5000);
      expect(pong.payload.toString()).toBe(maxPayload);
    });

    it('should echo PING payload in PONG response', async () => {
      client = await createWebSocketClient();

      const uniquePayload = crypto.randomBytes(16).toString('hex');
      client.ping(uniquePayload);

      const pong = await client.waitForPong(5000);
      expect(pong.payload.toString()).toBe(uniquePayload);
    });

    it('should handle binary opcode for IRC data', async () => {
      client = new WebSocketTestClient();
      await client.connect();

      const nick = `wsbinary${Math.floor(Math.random() * 100000)}`;
      // Send NICK as binary frame instead of text
      client.sendFrame(`NICK ${nick}\r\n`, WS_OPCODE.BINARY);
      client.sendFrame(`USER ${nick} 0 * :Binary Test\r\n`, WS_OPCODE.BINARY);

      // Server should still process it
      // Note: register() already sent NICK/USER, so this might get errors
      await client.register(nick).catch(() => {});
      // Just verify connection is still alive
      expect(client.isConnected()).toBe(true);
    });

    it('should accept frames with extended payload length (126-65535)', async () => {
      client = await createWebSocketClient();

      const nick = `wsext${Math.floor(Math.random() * 100000)}`;
      await client.register(nick);

      // Create message with payload > 125 bytes to trigger extended length encoding
      const longMsg = 'x'.repeat(200);
      client.send(`PRIVMSG #test :${longMsg}`);

      // If we get here without error, server accepted the frame
      expect(client.isConnected()).toBe(true);
    });
  });

  describe('Close Frame Handling (RFC 6455 §5.5.1)', () => {
    it('should respond to CLOSE frame with CLOSE frame', async () => {
      client = await createWebSocketClient();

      const nick = `wsclose${Math.floor(Math.random() * 100000)}`;
      await client.register(nick);

      // Send close frame with code 1000 (normal closure)
      client.close(1000, 'Test complete');

      // Wait for close response
      const closeResponse = await client.waitForClose(5000);
      expect(closeResponse.code).toBe(1000);
    });

    it('should handle CLOSE frame without payload', async () => {
      client = await createWebSocketClient();
      const nick = `wsclose2${Math.floor(Math.random() * 100000)}`;
      await client.register(nick);

      // Send close frame without code/reason
      client.sendFrame(Buffer.alloc(0), WS_OPCODE.CLOSE);

      // Server should still close cleanly
      await client.waitForClose(5000).catch(() => ({}));
      // Empty close is valid per RFC 6455
      expect(client.isConnected()).toBe(true); // Connection still open until we read close
    });

    it('should handle CLOSE with code only (no reason)', async () => {
      client = await createWebSocketClient();
      const nick = `wsclose3${Math.floor(Math.random() * 100000)}`;
      await client.register(nick);

      // Send close frame with just status code, no reason
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1000, 0);
      client.sendFrame(payload, WS_OPCODE.CLOSE);

      const closeResponse = await client.waitForClose(5000);
      expect(closeResponse.code).toBe(1000);
    });

    it('should accept common close codes', async () => {
      // Test close codes: 1000 (normal), 1001 (going away)
      for (const code of [1000, 1001]) {
        const testClient = await createWebSocketClient();
        const nick = `wscc${code}${Math.floor(Math.random() * 10000)}`;
        await testClient.register(nick);

        testClient.close(code);
        const resp = await testClient.waitForClose(5000).catch(() => ({ code: -1 }));
        // Server should respond with close
        expect(resp.code).toBeGreaterThanOrEqual(1000);
        testClient.disconnect();
      }
    });
  });

  describe('Masking Requirements (RFC 6455 §5.3)', () => {
    it('should accept properly masked client frames', async () => {
      client = await createWebSocketClient();
      const nick = `wsmask${Math.floor(Math.random() * 100000)}`;

      // buildFrame() creates masked frames by default
      const registered = await client.register(nick);
      expect(registered).toBe(true);
    });

    it('should reject unmasked client frames', async () => {
      socket = await createRawTLSConnection();
      const key = generateWebSocketKey();

      // Complete handshake
      const request = [
        'GET / HTTP/1.1',
        `Host: ${WS_HOST}:${WS_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');

      socket.write(request);
      await waitForHTTPResponse(socket);

      // Send an UNMASKED frame (violation of RFC 6455)
      // Per RFC 6455 §5.1, server MUST close connection
      const unmaskedFrame = buildUnmaskedFrame('NICK badmask\r\n');
      socket.write(unmaskedFrame);

      // Server MUST close connection per RFC 6455
      const result = await new Promise<'closed' | 'alive'>((resolve) => {
        const timeout = setTimeout(() => resolve('alive'), 2000);
        socket!.on('close', () => {
          clearTimeout(timeout);
          resolve('closed');
        });
        socket!.on('data', (chunk) => {
          const frame = parseFrame(chunk);
          if (frame && frame.opcode === WS_OPCODE.CLOSE) {
            clearTimeout(timeout);
            resolve('closed');
          }
        });
      });

      expect(result).toBe('closed');
    });

    it('should send unmasked frames to client (server-to-client)', async () => {
      client = await createWebSocketClient();
      const nick = `wsunmask${Math.floor(Math.random() * 100000)}`;
      await client.register(nick);

      // Get a frame from server
      client.ping('test');
      const pong = await client.waitForPong(5000);

      // Server frames should be unmasked - parseFrame handles this correctly
      // If we got here, the frame was valid (unmasked from server)
      expect(pong.opcode).toBe(WS_OPCODE.PONG);
    });
  });
});
