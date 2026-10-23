/**
 * A TLS client whose socket has blocked must not be killed with
 * "Write error: Internal OpenSSL error or protocol error" when a priority
 * line is queued for it.
 *
 * When SSL_write returns want-write, OpenSSL keeps that record pending and
 * the next SSL_write on the connection must present the same record (a
 * different one is SSL_ERROR_SSL "bad write retry").  The retry from the
 * normal queue is correct, but msgq_mapiov maps the PRIORITY queue ahead
 * of it, and the ping check sends its PING to clients with priority
 * (ircd.c, sendcmdto_prio_one), as do WALLOPS and, under
 * FLUSH_ULINE_IMMEDIATE, every services line.  So any TLS client whose
 * socket blocked once -- a phone that stopped acknowledging while an alias
 * attach flooded it with channel state -- died at the next ping check with
 * that reason.  rdrake's aliases did, about twenty-five times on
 * 2026-10-01/02.  The WebSocket deliver path maps the same queue and fails
 * the same way (with an errno text instead).
 *
 * The test drives it with a Python client whose TCP receive buffer is 4 KB
 * (node cannot set SO_RCVBUF on a TCP socket): the client is an oper with
 * +w, pauses reading, is fed until its window closes and the server's send
 * buffer is full (the server's queue is now blocked with a pending record),
 * then receives a WALLOPS (priority).  On the old build the retry on
 * resume presents the WALLOPS first and the client is killed; on the fixed
 * build the WALLOPS waits its turn and everything arrives.
 *
 * Two flavours: plain TLS (IRC_TLS_PORT, 6697) and WebSocket over TLS
 * (WS_PORT, 9998 on the bed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { createRawSocketClient, RawSocketClient, uniqueNick, uniqueId } from '../helpers/index.js';
import { createOperClient } from '../helpers/x3-client';

const HOST = process.env.IRC_HOST ?? 'nefarious';
const TLS_PORT = parseInt(process.env.IRC_TLS_PORT ?? '6697');
const WS_PORT = parseInt(process.env.WS_PORT ?? '9998');
const OPER_NAME = process.env.OPER_NAME || 'oper';
const OPER_PASS = process.env.OPER_PASS || 'shmoo';
const HELPER = path.resolve(__dirname, '../helpers/ws_paused_reader.py');
const SSL_KILL = /Internal OpenSSL error/;

/** The Python client, driven over its stdin/stdout. */
class PausedReader {
  private proc: ChildProcessWithoutNullStreams;
  private events: string[] = [];
  private waiters: Array<{ re: RegExp; resolve: (s: string) => void }> = [];
  closed: string | null = null;

  constructor(host: string, port: number, rcvbuf: number, plain: boolean) {
    const args = [HELPER, host, String(port), String(rcvbuf)];
    if (plain) args.push('plain');
    this.proc = spawn('python3', args);
    let buf = '';
    this.proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const ev of parts) {
        if (ev.startsWith('closed ')) this.closed = ev.slice(7);
        this.events.push(ev);
        for (const w of [...this.waiters]) {
          if (w.re.test(ev)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(ev); }
        }
      }
    });
    this.proc.stderr.on('data', (d: Buffer) => { process.stderr.write(`[ws_paused_reader] ${d}`); });
    this.proc.on('exit', () => { if (this.closed === null) this.closed = 'process exit'; });
  }

  cmd(line: string): void { try { this.proc.stdin.write(line + '\n'); } catch { /* gone */ } }

  /** Wait for an event matching re (already-seen events count). */
  wait(re: RegExp, ms: number): Promise<string> {
    const seen = this.events.find((e) => re.test(e));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { re, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`timeout waiting for ${re}`)); }
      }, ms);
    });
  }

  count(re: RegExp): number { return this.events.filter((e) => re.test(e)).length; }
  clear(): void { this.events = []; }
  kill(): void { this.cmd('quit'); setTimeout(() => this.proc.kill(), 500); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let client: PausedReader | null = null;
let watcher: RawSocketClient | null = null;
let feeder: RawSocketClient | null = null;

afterEach(() => {
  client?.kill(); client = null;
  try { watcher?.close(); } catch { /* */ } watcher = null;
  try { feeder?.close(); } catch { /* */ } feeder = null;
});

for (const mode of [
  { name: 'plain TLS', port: TLS_PORT, plain: true },
  { name: 'WebSocket over TLS', port: WS_PORT, plain: false },
]) {
  describe(`a blocked ${mode.name} client that is sent a priority line`, () => {
    it('is not killed, and receives it in order', async () => {
      const chan = `#tlsprio${Math.random().toString(36).slice(2, 6)}`;
      const nick = uniqueNick('tlsp');
      client = new PausedReader(HOST, mode.port, 4096, mode.plain);
      await client.wait(/^ready$/, 15000);
      client.cmd(`send NICK ${nick}`);
      client.cmd(`send USER ${nick} 0 * :paused reader`);
      await client.wait(/ 001 /, 20000);
      client.cmd(`send OPER ${OPER_NAME} ${OPER_PASS}`);
      await client.wait(/ 381 /, 10000);
      client.cmd(`send MODE ${nick} +w`);
      client.cmd(`send JOIN ${chan}`);
      await client.wait(new RegExp(`JOIN :?${chan}`), 10000);

      // Watches the channel for the client's QUIT and its reason.
      watcher = await createRawSocketClient();
      await watcher.capLs(); watcher.capEnd();
      watcher.register(uniqueNick('tlsw'));
      await watcher.waitForNumeric('001', 15000);
      watcher.send(`JOIN ${chan}`);
      await watcher.waitForLine(new RegExp(`JOIN :?${chan}`), 10000);

      // An oper feeds the channel and sends the WALLOPS.
      const op = await createOperClient();
      feeder = op;
      op.send(`JOIN ${chan}`);
      await op.waitForLine(new RegExp(`JOIN :?${chan}`), 10000);

      let killReason: string | null = null;
      watcher.clearRawBuffer();
      const quitWatch = watcher.waitForLine(new RegExp(`^:${nick}!.* QUIT :(.*)`), 300_000)
        .then((l) => { killReason = /QUIT :(.*)$/.exec(l)?.[1] ?? 'quit'; })
        .catch(() => { /* no quit: good */ });
      const dead = () => killReason !== null || client!.closed !== null;
      const inq = async (): Promise<number> => {
        client!.clear();
        client!.cmd('inq');
        return parseInt((await client!.wait(/^inq /, 5000)).slice(4));
      };

      const fill = 'x'.repeat(380);
      client.cmd('pause');

      // Phase A: lines until the client's receive queue stops growing
      // (its window is closed).
      let last = -1, flat = 0, lines = 0;
      while (flat < 2 && lines < 120 && !dead()) {
        op.send(`PRIVMSG ${chan} :${lines++} ${fill}`);
        await sleep(120);
        const n = await inq();
        flat = n === last ? flat + 1 : 0;
        last = n;
      }
      expect(flat, `the client's window closed after ${lines} lines (${last} bytes queued)`).toBe(2);

      // Phase B: enough more to fill the server's 2 KB (doubled) send
      // buffer, so its queue blocks with a record pending in OpenSSL.
      for (let i = 0; i < 16 && !dead(); i++) {
        op.send(`PRIVMSG ${chan} :park ${i} ${fill}`);
        await sleep(100);
      }

      // The priority line.
      const id = uniqueId();
      op.send(`WALLOPS :prio ${id}`);
      await sleep(1000);

      // Resume: the retry must present the pending record, not the WALLOPS.
      client.clear();
      client.cmd('resume');
      await sleep(4000);
      await Promise.race([quitWatch, sleep(3000)]);

      expect(killReason ?? '', `the client was killed: ${killReason}`).not.toMatch(SSL_KILL);
      expect(killReason, 'the client was not killed at all').toBeNull();
      expect(client.closed, 'the client is still connected').toBeNull();
      expect(client.count(new RegExp(`WALLOPS :prio ${id}`)), 'the WALLOPS arrived').toBe(1);
      expect(client.count(/park 15 /), 'the last parked line arrived').toBe(1);
    }, 240_000);
  });
}
