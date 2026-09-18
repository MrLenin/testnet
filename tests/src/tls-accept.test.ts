import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import * as tls from 'node:tls';

/*
 * The TLS accept path must finish a handshake on its own events.
 *
 * Client listeners hand their accepted sockets a CLIENT_TCP_WINDOW send
 * buffer (2 KB, doubled by the kernel), and a server flight carrying a
 * real certificate chain is larger than that: SSL_accept writes the
 * first 4 KB, gets EAGAIN on the rest and reports SSL_ERROR_WANT_WRITE.
 * For years the rest went out only because the auth notices queued at
 * accept had armed writable interest that nobody dropped (the idle-socket
 * spin).  Once that spin was fixed, a ClientHello processed on a read
 * event whose flight did not fit left the handshake waiting for a write
 * event nobody would arm, until an unrelated event or the connect
 * timeout -- the client saw an EOF mid-handshake (prod, 2026-09-18).
 *
 * The bed's certificate is a three-certificate chain for this reason: the
 * first test asserts the flight is bigger than the buffer, so the others
 * really exercise the write side.  A self-signed leaf alone would make
 * them pass on any build.
 */

const HOST = process.env.IRC_HOST ?? 'localhost';
/* 6697 is TLS with WebSocket autodetect on the bed, like prod's. */
const PORT = parseInt(process.env.IRC_TLS_PORT ?? '6697');
const CLIENT_SEND_BUFFER = 4096;
const HANDSHAKE_LIMIT_MS = 3000;

interface Handshake {
  /** From the ClientHello going out to the handshake completing. */
  ms: number;
  /** Bytes the server sent during the handshake: its whole flight. */
  flightBytes: number;
  /** DER bytes of every certificate the server sent. */
  chainBytes: number;
  chainLength: number;
}

function chainSize(cert: tls.DetailedPeerCertificate | null): { bytes: number; length: number } {
  let bytes = 0;
  let length = 0;
  const seen = new Set<string>();
  for (let c = cert; c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
    seen.add(c.fingerprint256);
    bytes += c.raw.length;
    length++;
  }
  return { bytes, length };
}

/**
 * Open a TCP connection, wait `delayMs`, then start TLS on it.  A delay
 * puts the ClientHello after the server's accept, so it is processed on
 * a read event rather than at accept time.
 */
function handshake(delayMs: number): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const raw = net.connect(PORT, HOST);
    let timer: NodeJS.Timeout | undefined;
    const fail = (err: Error) => {
      if (timer) clearTimeout(timer);
      raw.destroy();
      reject(err);
    };
    raw.once('error', fail);
    raw.once('connect', () => {
      setTimeout(() => {
        const t0 = Date.now();
        timer = setTimeout(
          () => fail(new Error(`no handshake after ${HANDSHAKE_LIMIT_MS} ms (ClientHello ${delayMs} ms after connect)`)),
          HANDSHAKE_LIMIT_MS,
        );
        const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
        secure.once('error', fail);
        secure.once('secureConnect', () => {
          if (timer) clearTimeout(timer);
          const { bytes, length } = chainSize(secure.getPeerCertificate(true));
          const result = {
            ms: Date.now() - t0,
            flightBytes: raw.bytesRead,
            chainBytes: bytes,
            chainLength: length,
          };
          secure.end();
          resolve(result);
        });
      }, delayMs);
    });
  });
}

describe('TLS accept drives its own handshake', () => {
  it('precondition: the server flight is larger than the client socket send buffer', async () => {
    const h = await handshake(0);
    expect(h.chainLength, 'the bed certificate must be a chain (see docker-compose.yml nefarious-init)').toBeGreaterThan(1);
    expect(h.flightBytes, `flight ${h.flightBytes} B, certificates ${h.chainBytes} B`).toBeGreaterThan(CLIENT_SEND_BUFFER);
  });

  it('a ClientHello arriving after accept completes the handshake', async () => {
    for (let i = 0; i < 5; i++) {
      const h = await handshake(300);
      expect(h.ms).toBeLessThan(HANDSHAKE_LIMIT_MS);
    }
  });

  it('a ClientHello arriving with the connection completes the handshake', async () => {
    for (let i = 0; i < 5; i++) {
      const h = await handshake(0);
      expect(h.ms).toBeLessThan(HANDSHAKE_LIMIT_MS);
    }
  });

  it('a socket idle for two seconds before its ClientHello completes the handshake', async () => {
    const h = await handshake(2000);
    expect(h.ms).toBeLessThan(HANDSHAKE_LIMIT_MS);
  });
});
