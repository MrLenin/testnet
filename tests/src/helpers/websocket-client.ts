/**
 * WebSocket client helper for testing RFC 6455 compliance.
 * Provides low-level frame building and parsing for comprehensive testing.
 */

import * as tls from 'tls';
import * as crypto from 'crypto';

const WS_HOST = process.env.IRC_HOST ?? 'nefarious';
const WS_PORT = parseInt(process.env.WS_PORT ?? '8443');

/** WebSocket opcodes */
export const WS_OPCODE = {
  CONTINUATION: 0x00,
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
} as const;

export interface WebSocketFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/**
 * Generate a random WebSocket key for handshake.
 */
export function generateWebSocketKey(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Compute expected Sec-WebSocket-Accept value.
 */
export function computeAcceptKey(key: string): string {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Build a masked WebSocket frame (client-to-server must be masked).
 */
export function buildFrame(
  data: string | Buffer,
  opcode: number = WS_OPCODE.TEXT,
  fin: boolean = true
): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);

  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  let header: Buffer;
  const firstByte = (fin ? 0x80 : 0x00) | opcode;

  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = firstByte;
    header[1] = 0x80 | payload.length; // MASK + length
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = firstByte;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = firstByte;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }

  return Buffer.concat([header, masked]);
}

/**
 * Build an unmasked WebSocket frame (for testing server rejection).
 */
export function buildUnmaskedFrame(
  data: string | Buffer,
  opcode: number = WS_OPCODE.TEXT,
  fin: boolean = true
): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const firstByte = (fin ? 0x80 : 0x00) | opcode;

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = firstByte;
    header[1] = payload.length; // No MASK bit
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Parse a WebSocket frame from buffer.
 * Returns null if incomplete.
 */
export function parseFrame(buffer: Buffer): WebSocketFrame | null {
  if (buffer.length < 2) return null;

  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let pos = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    pos = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    pos = 10;
  }

  if (masked) {
    pos += 4; // Skip mask bytes
  }

  if (buffer.length < pos + payloadLen) return null;

  let payload = buffer.subarray(pos, pos + payloadLen);
  if (masked) {
    const mask = buffer.subarray(pos - 4, pos);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }

  return { fin, opcode, payload };
}

/**
 * Calculate the total size of a frame in buffer.
 */
export function getFrameSize(buffer: Buffer): number | null {
  if (buffer.length < 2) return null;

  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let headerLen = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    headerLen = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    headerLen = 10;
  }

  if (masked) headerLen += 4;

  const totalSize = headerLen + payloadLen;
  if (buffer.length < totalSize) return null;

  return totalSize;
}

/**
 * WebSocket test client for comprehensive testing.
 */
export class WebSocketTestClient {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private frames: WebSocketFrame[] = [];
  private connected = false;
  private handshakeComplete = false;

  constructor(
    private host = WS_HOST,
    private port = WS_PORT
  ) {}

  /**
   * Connect and complete WebSocket handshake.
   */
  async connect(subprotocol?: string): Promise<string> {
    const key = generateWebSocketKey();

    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const sock = tls.connect(
        { host: this.host, port: this.port, rejectUnauthorized: false },
        () => resolve(sock)
      );
      sock.on('error', reject);
    });

    this.connected = true;

    // Set up data handler
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });

    // Send handshake
    const headers = [
      'GET / HTTP/1.1',
      `Host: ${this.host}:${this.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ];
    if (subprotocol) {
      headers.push(`Sec-WebSocket-Protocol: ${subprotocol}`);
    }
    headers.push('', '');

    this.socket.write(headers.join('\r\n'));

    // Wait for handshake response
    const response = await this.waitForHandshake();
    this.handshakeComplete = true;

    return response;
  }

  private async waitForHandshake(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);

      const checkBuffer = () => {
        const str = this.buffer.toString();
        const endIndex = str.indexOf('\r\n\r\n');
        if (endIndex !== -1) {
          clearTimeout(timeout);
          const response = str.substring(0, endIndex + 4);
          this.buffer = this.buffer.subarray(endIndex + 4);
          resolve(response);
        } else {
          setTimeout(checkBuffer, 10);
        }
      };
      checkBuffer();
    });
  }

  private processBuffer(): void {
    if (!this.handshakeComplete) return;

    while (true) {
      const frame = parseFrame(this.buffer);
      if (!frame) break;

      const size = getFrameSize(this.buffer);
      if (size === null) break;

      this.buffer = this.buffer.subarray(size);
      this.frames.push(frame);
    }
  }

  /**
   * Send a text frame.
   */
  send(data: string): void {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected');
    }
    this.socket.write(buildFrame(data + '\r\n'));
  }

  /**
   * Send a raw frame with specific opcode and FIN bit.
   */
  sendFrame(data: string | Buffer, opcode: number, fin = true): void {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected');
    }
    this.socket.write(buildFrame(data, opcode, fin));
  }

  /**
   * Send raw bytes directly (for malformed frame testing).
   */
  sendRaw(data: Buffer): void {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected');
    }
    this.socket.write(data);
  }

  /**
   * Send a PING control frame.
   */
  ping(payload = ''): void {
    this.sendFrame(payload, WS_OPCODE.PING);
  }

  /**
   * Send a CLOSE control frame.
   */
  close(code?: number, reason?: string): void {
    let payload = Buffer.alloc(0);
    if (code !== undefined) {
      const reasonBuf = reason ? Buffer.from(reason, 'utf8') : Buffer.alloc(0);
      payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
    }
    this.sendFrame(payload, WS_OPCODE.CLOSE);
  }

  /**
   * Wait for a frame matching the predicate.
   */
  async waitForFrame(
    predicate: (frame: WebSocketFrame) => boolean,
    timeout = 5000
  ): Promise<WebSocketFrame> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const idx = this.frames.findIndex(predicate);
      if (idx !== -1) {
        return this.frames.splice(idx, 1)[0];
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timeout waiting for frame');
  }

  /**
   * Wait for a text frame containing the pattern.
   */
  async waitForText(pattern: RegExp | string, timeout = 5000): Promise<string> {
    const frame = await this.waitForFrame((f) => {
      if (f.opcode !== WS_OPCODE.TEXT && f.opcode !== WS_OPCODE.BINARY) return false;
      const text = f.payload.toString('utf8');
      return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
    }, timeout);
    return frame.payload.toString('utf8');
  }

  /**
   * Wait for a PONG response.
   */
  async waitForPong(timeout = 5000): Promise<WebSocketFrame> {
    return this.waitForFrame((f) => f.opcode === WS_OPCODE.PONG, timeout);
  }

  /**
   * Wait for a CLOSE frame.
   */
  async waitForClose(timeout = 5000): Promise<{ code?: number; reason?: string }> {
    const frame = await this.waitForFrame((f) => f.opcode === WS_OPCODE.CLOSE, timeout);
    if (frame.payload.length >= 2) {
      return {
        code: frame.payload.readUInt16BE(0),
        reason: frame.payload.subarray(2).toString('utf8'),
      };
    }
    return {};
  }

  /**
   * Get all received frames.
   */
  getFrames(): WebSocketFrame[] {
    return [...this.frames];
  }

  /**
   * Clear received frames.
   */
  clearFrames(): void {
    this.frames = [];
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected && this.socket !== null;
  }

  /**
   * Disconnect.
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.handshakeComplete = false;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
  }

  /**
   * Perform IRC registration over WebSocket.
   * Returns true if 001 welcome received.
   */
  async register(nick: string, user?: string): Promise<boolean> {
    const username = user ?? nick;
    this.send(`NICK ${nick}`);
    this.send(`USER ${username} 0 * :WebSocket Test`);

    const start = Date.now();
    while (Date.now() - start < 10000) {
      // Process received frames
      for (const frame of this.getFrames()) {
        if (frame.opcode === WS_OPCODE.TEXT || frame.opcode === WS_OPCODE.BINARY) {
          const text = frame.payload.toString('utf8');
          // Respond to PING
          for (const line of text.split(/[\r\n]+/)) {
            const pingMatch = line.match(/^PING :?(.+)/);
            if (pingMatch) {
              this.send(`PONG :${pingMatch[1]}`);
            }
          }
          // Check for welcome
          if (text.includes(' 001 ')) {
            return true;
          }
        }
      }
      this.clearFrames();
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }
}

/**
 * Create a connected WebSocket test client.
 */
export async function createWebSocketClient(
  subprotocol?: string
): Promise<WebSocketTestClient> {
  const client = new WebSocketTestClient();
  await client.connect(subprotocol);
  return client;
}
