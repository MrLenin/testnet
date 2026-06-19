#!/usr/bin/env npx tsx
/**
 * MsgBuf pool leak soak harness.
 *
 * Purpose: try to reproduce the prod-test "Unable to allocate buffers"
 * panic (see ~/.claude/projects/-home-ibutsu-testnet/memory/
 * project_msgbuf_pool_panic.md) on a locally-controlled testnet by
 * driving sustained traffic and snapshotting /STATS z output.
 *
 * Defaults to LINKED topology (testnet + nefarious2 — bring up with
 * `scripts/dc.sh -l up -d`).  Spawns multiple concurrent "churn"
 * workers each running a connect → JOIN → chat → PART → QUIT loop with
 * brief inter-cycle sleeps, plus a single oper observer that polls
 * /STATS z every N minutes, parses the MsgBuf size-class table, and
 * appends a JSONL snapshot to tests/leak-soak-results/<ts>/stats.jsonl.
 *
 * Runs until SIGINT; on exit, dumps a summary table showing per-class
 * deltas (alloc/used at first vs. last snapshot) and an
 * approximate ratchet rate.  A monotonically climbing `.used` in any
 * class is the repro signal — confirms a leak path is exercised by
 * the harness's traffic shape, and the class identifies the size of
 * the leaked carrier (which narrows the offending wire token).
 *
 * Usage:
 *   npx tsx src/scripts/leak-soak.ts
 *   # With knobs:
 *   WORKERS=20 INTERVAL_MIN=2 npx tsx src/scripts/leak-soak.ts
 *
 * Env vars (all optional):
 *   IRC_HOST         testnet host (default: localhost)
 *   IRC_PORT         testnet port (default: 6667)
 *   IRC_HOST2        leaf host    (default: localhost)
 *   IRC_PORT2        leaf port    (default: 6668)
 *   WORKERS          churn worker count (default: 10)
 *   LEAF_WORKERS     leaf-side worker count (default: 5)
 *   INTERVAL_MIN     /STATS z poll interval in minutes (default: 5)
 *   CHAN             target channel for chat (default: #soak)
 *   OUT_DIR          results dir (default: tests/leak-soak-results)
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IRC_HOST = process.env.IRC_HOST || 'localhost';
const IRC_PORT = parseInt(process.env.IRC_PORT || '6667', 10);
const IRC_HOST2 = process.env.IRC_HOST2 || 'localhost';
const IRC_PORT2 = parseInt(process.env.IRC_PORT2 || '6668', 10);
const WORKERS = parseInt(process.env.WORKERS || '10', 10);
const LEAF_WORKERS = parseInt(process.env.LEAF_WORKERS || '5', 10);
const CHATTY = parseInt(process.env.CHATTY || '6', 10);
const FLAPPERS = parseInt(process.env.FLAPPERS || '4', 10);
const BOUNCERS = parseInt(process.env.BOUNCERS || '6', 10);
const CHATHISTORY = parseInt(process.env.CHATHISTORY || '2', 10);
const REVIVES = parseInt(process.env.REVIVES || '4', 10);
const NICKCHURN = parseInt(process.env.NICKCHURN || '3', 10);
const SASLONLY = parseInt(process.env.SASLONLY || '0', 10);
const BARECONN = parseInt(process.env.BARECONN || '0', 10);
const INTERVAL_MIN = parseFloat(process.env.INTERVAL_MIN || '5');
const CHAN = process.env.CHAN || '#soak';
const OUT_DIR = process.env.OUT_DIR || path.resolve(__dirname, '../../leak-soak-results');

const OPER_NAME = process.env.OPER_NAME || 'oper';
const OPER_PASS = process.env.OPER_PASS || 'shmoo';

/** Minimal raw IRC client — connects, sends, exposes line stream. */
class RawClient {
  socket: net.Socket;
  buffer = '';
  onLine: (line: string) => void = () => {};
  closed = false;

  constructor(host: string, port: number) {
    this.socket = net.createConnection({ host, port });
    this.socket.setNoDelay(true);
    this.socket.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\r\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('PING ')) {
          this.send(`PONG ${line.substring(5)}`);
          continue;
        }
        this.onLine(line);
      }
    });
    this.socket.on('error', () => { this.closed = true; });
    this.socket.on('close', () => { this.closed = true; });
  }

  send(line: string) {
    if (this.closed) return;
    try { this.socket.write(line + '\r\n'); } catch { /* ignore */ }
  }

  waitForLine(pattern: RegExp, timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      const prior = this.onLine;
      const timer = setTimeout(() => {
        this.onLine = prior;
        reject(new Error(`timeout waiting for ${pattern}`));
      }, timeoutMs);
      this.onLine = (line: string) => {
        prior(line);
        if (pattern.test(line)) {
          clearTimeout(timer);
          this.onLine = prior;
          resolve(line);
        }
      };
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('error', reject);
    });
  }

  close() {
    this.closed = true;
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

function uniq(prefix: string): string {
  return `${prefix}${Math.random().toString(36).substring(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** A single churn worker: connect → register → JOIN → chat → PART → QUIT, loop. */
async function churnWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  let cycles = 0;
  while (!stop.value) {
    const nick = uniq(`s${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :soak${id}`);
      await c.waitForLine(/\s001\s/, 15000);
      c.send(`JOIN ${CHAN}`);
      await c.waitForLine(new RegExp(`\\s(JOIN|MODE|332|353|366)\\s`), 8000);
      for (let i = 0; i < 5 && !stop.value; i++) {
        c.send(`PRIVMSG ${CHAN} :soak#${id} cycle=${cycles} msg=${i}`);
        await sleep(50);
      }
      c.send(`PART ${CHAN}`);
      await sleep(100);
      c.send(`QUIT :soak cycle end`);
      await sleep(200);
    } catch (e) {
      // swallow — connection failures mid-cycle just restart the loop
    } finally {
      c.close();
    }
    cycles++;
    if (stop.value) return;
    await sleep(1000 + Math.floor(Math.random() * 3000));
  }
}

/** Chatty worker: connect once, stay in channel, PRIVMSG rapidly forever.
 * Stresses the PRIVMSG fan-out path (every channel member gets a copy →
 * one msgq_make per recipient × N).  Lots of MsgBuf turnover per second. */
async function chattyWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  while (!stop.value) {
    const nick = uniq(`c${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :chatty${id}`);
      await c.waitForLine(/\s001\s/, 15000);
      c.send(`JOIN ${CHAN}`);
      await c.waitForLine(new RegExp(`\\s366\\s`), 8000);
      let i = 0;
      while (!stop.value) {
        c.send(`PRIVMSG ${CHAN} :chatty#${id} i=${i} ${'x'.repeat(40 + (i % 200))}`);
        i++;
        await sleep(200 + Math.floor(Math.random() * 300));
        if (i % 100 === 0 && Math.random() < 0.2) break;  // periodic reconnect
      }
    } catch { /* swallow */ }
    finally { c.close(); }
    if (!stop.value) await sleep(500);
  }
}

/** Bare-connect worker: connect, NICK/USER, 001, immediate QUIT.
 * No SASL, no JOIN, no nothing.  Tests IRC connection lifecycle in
 * isolation. */
async function bareConnectWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  while (!stop.value) {
    const nick = uniq(`bc${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :bc${id}`);
      await c.waitForLine(/\s001\s/, 15000);
      c.send('QUIT :bare-connect cycle');
      await sleep(100);
    } catch { /* swallow */ }
    finally { c.close(); }
    if (!stop.value) await sleep(200);
  }
}

/** SASL-only worker: bare SASL PLAIN, then immediate QUIT.  No JOIN,
 * no BOUNCER HOLD, no channel state.  Isolates the SASL handshake
 * (Keycloak ROPC via libkc) from every other path — if FD growth
 * appears here, the leak is in the SASL path itself. */
async function saslOnlyWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  const account = `pool${String(id).padStart(2, '0')}`;
  const password = `poolpass${String(id).padStart(2, '0')}`;
  const saslPayload = Buffer.from(`\0${account}\0${password}`).toString('base64');
  while (!stop.value) {
    const nick = uniq(`s${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send('CAP LS 302');
      await c.waitForLine(/CAP \S+ LS/, 5000).catch(() => {});
      c.send('CAP REQ :sasl');
      await c.waitForLine(/CAP \S+ ACK :sasl/, 5000).catch(() => {});
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :sasl${id}`);
      c.send('AUTHENTICATE PLAIN');
      await c.waitForLine(/AUTHENTICATE \+/, 5000);
      c.send(`AUTHENTICATE ${saslPayload}`);
      await c.waitForLine(/\s903\s|\s904\s|\s905\s/, 8000);
      c.send('CAP END');
      await c.waitForLine(/\s001\s/, 15000);
      // Immediate clean QUIT — no JOIN, no HOLD, no channel state
      c.send('QUIT :sasl-only cycle');
      await sleep(200);
    } catch { /* swallow */ }
    finally { c.close(); }
    if (!stop.value) await sleep(300);
  }
}

/** SASL PLAIN bouncer worker: SASL with pool account, JOIN, brief chat,
 * QUIT to leave a held session, then reconnect+SASL to trigger revive.
 * Exercises bounce_setup_local_alias / bounce_revive / hold transitions —
 * the most-touched bouncer paths.  Each worker holds one pool account
 * exclusively for the soak duration. */
async function bouncerWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  const account = `pool${String(id).padStart(2, '0')}`;
  const password = `poolpass${String(id).padStart(2, '0')}`;
  // SASL PLAIN payload: base64(authzid\0authcid\0password) — empty authzid
  const saslPayload = Buffer.from(`\0${account}\0${password}`).toString('base64');
  let cycles = 0;
  while (!stop.value) {
    const nick = uniq(`b${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send('CAP LS 302');
      await c.waitForLine(/CAP \S+ LS/, 5000).catch(() => {});
      c.send('CAP REQ :sasl');
      await c.waitForLine(/CAP \S+ ACK :sasl/, 5000).catch(() => {});
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :bouncer${id}`);
      c.send('AUTHENTICATE PLAIN');
      await c.waitForLine(/AUTHENTICATE \+/, 5000);
      c.send(`AUTHENTICATE ${saslPayload}`);
      await c.waitForLine(/\s903\s|\s904\s|\s905\s/, 8000);
      c.send('CAP END');
      await c.waitForLine(/\s001\s/, 15000);
      c.send(`JOIN ${CHAN}`);
      await c.waitForLine(/\s366\s/, 8000);
      // Enable bouncer hold so the next disconnect leaves a session
      c.send(`BOUNCER HOLD ON`);
      await sleep(500);
      for (let i = 0; i < 3 && !stop.value; i++) {
        c.send(`PRIVMSG ${CHAN} :b#${id} cycle=${cycles} i=${i}`);
        await sleep(200);
      }
      // Hard-disconnect (not QUIT) so the bouncer holds the session
      c.close();
      if (stop.value) return;
      await sleep(1500 + Math.floor(Math.random() * 1500));
      // Reconnect with same SASL → triggers bounce_revive
    } catch (e) {
      // SASL failure or timeout — skip this cycle
    } finally {
      c.close();
    }
    cycles++;
    await sleep(500);
  }
}

/** Chathistory-pull worker: SASL with a pool account, join a busy
 * channel, then loop CHATHISTORY LATEST / BEFORE / AROUND commands.
 * Exercises history.c replay paths. */
async function chathistoryWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  // Use pool accounts above the bouncer range to avoid contention
  const accountIdx = id + 8;  // pool08, pool09 (max 2)
  const account = `pool${String(accountIdx).padStart(2, '0')}`;
  const password = `poolpass${String(accountIdx).padStart(2, '0')}`;
  const saslPayload = Buffer.from(`\0${account}\0${password}`).toString('base64');
  while (!stop.value) {
    const nick = uniq(`h${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send('CAP LS 302');
      await c.waitForLine(/CAP \S+ LS/, 5000).catch(() => {});
      c.send('CAP REQ :sasl draft/chathistory message-tags server-time batch');
      await c.waitForLine(/CAP \S+ ACK/, 5000).catch(() => {});
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :history${id}`);
      c.send('AUTHENTICATE PLAIN');
      await c.waitForLine(/AUTHENTICATE \+/, 5000);
      c.send(`AUTHENTICATE ${saslPayload}`);
      await c.waitForLine(/\s903\s|\s904\s/, 8000);
      c.send('CAP END');
      await c.waitForLine(/\s001\s/, 15000);
      c.send(`JOIN ${CHAN}`);
      await c.waitForLine(/\s366\s/, 8000);
      let i = 0;
      while (!stop.value) {
        c.send(`CHATHISTORY LATEST ${CHAN} * 50`);
        await sleep(500);
        c.send(`CHATHISTORY BEFORE ${CHAN} timestamp=2026-06-16T00:00:00.000Z 50`);
        await sleep(500);
        i++;
        if (i % 30 === 0) break;  // periodic reconnect
      }
    } catch { /* swallow */ }
    finally { c.close(); }
    if (!stop.value) await sleep(1000);
  }
}

/** Revive+chathistory storm worker: mimics the prod-test "rdrake"
 * pattern that immediately precedes the panic in the leak audit notes
 * — SASL → JOIN multiple busy channels → enable hold → abrupt TCP
 * close (no QUIT, so bounce_hold fires) → reconnect+SASL quickly →
 * bounce_revive runs.  If the revive path triggers chathistory
 * auto-replay, the SendQ floods fast.  Exercises:
 *   - bounce_hold / bounce_revive socket transplant
 *   - chathistory replay buffer accumulation
 *   - per-recipient tag-buffer cache (the just-fixed leak class)
 * Each worker holds one pool account exclusively. */
async function reviveStormWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  // Use pool accounts above the bouncer + chathistory ranges
  const accountIdx = id + 4;  // pool04, pool05, pool06, pool07
  const account = `pool${String(accountIdx).padStart(2, '0')}`;
  const password = `poolpass${String(accountIdx).padStart(2, '0')}`;
  const saslPayload = Buffer.from(`\0${account}\0${password}`).toString('base64');
  const channels = [CHAN, `${CHAN}-2`, `${CHAN}-3`];
  let cycles = 0;
  while (!stop.value) {
    const nick = uniq(`r${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send('CAP LS 302');
      await c.waitForLine(/CAP \S+ LS/, 5000).catch(() => {});
      c.send('CAP REQ :sasl draft/chathistory message-tags server-time batch echo-message');
      await c.waitForLine(/CAP \S+ ACK/, 5000).catch(() => {});
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :rev${id}`);
      c.send('AUTHENTICATE PLAIN');
      await c.waitForLine(/AUTHENTICATE \+/, 5000);
      c.send(`AUTHENTICATE ${saslPayload}`);
      await c.waitForLine(/\s903\s|\s904\s|\s905\s/, 8000);
      c.send('CAP END');
      await c.waitForLine(/\s001\s/, 15000);
      for (const ch of channels)
        c.send(`JOIN ${ch}`);
      await sleep(800);
      c.send('BOUNCER HOLD ON');
      await sleep(500);
      // Abrupt close (no QUIT) → server ping-timeouts the connection
      // and bounce_hold fires.  Mirrors rdrake's "Ping timeout" line.
      c.socket.destroy();
      if (stop.value) return;
      // Quick reconnect → bounce_revive should trigger
      await sleep(800 + Math.floor(Math.random() * 1500));
    } catch { /* swallow */ }
    finally { c.close(); }
    cycles++;
    if (!stop.value) await sleep(300);
  }
}

/** Nick-churn worker: rapid NICK changes; each one fan-outs to every
 * common-channel member.  Same dispatch helpers as PRIVMSG, but a
 * different wire shape (NICK token) — useful to surface any cache-
 * array bug that's specific to NICK fan-out. */
async function nickChurnWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  while (!stop.value) {
    const baseNick = uniq(`n${id}_`).substring(0, 7);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send(`NICK ${baseNick}0`);
      c.send(`USER ${baseNick} 0 * :nickch${id}`);
      await c.waitForLine(/\s001\s/, 15000);
      c.send(`JOIN ${CHAN}`);
      await c.waitForLine(/\s366\s/, 8000);
      for (let i = 0; i < 50 && !stop.value; i++) {
        c.send(`NICK ${baseNick}${i + 1}`);
        await sleep(300 + Math.floor(Math.random() * 400));
      }
    } catch { /* swallow */ }
    finally { c.close(); }
    if (!stop.value) await sleep(500);
  }
}

/** Channel-flap worker: rapid JOIN/PART on a fixed connection.
 * Stresses the JOIN/PART announce fan-out paths.  Both JOIN and PART
 * trigger a fan-out PRIVMSG-like broadcast to channel members.  */
async function flapWorker(id: number, host: string, port: number, stop: { value: boolean }) {
  while (!stop.value) {
    const nick = uniq(`f${id}_`).substring(0, 9);
    const c = new RawClient(host, port);
    try {
      await c.ready();
      c.send(`NICK ${nick}`);
      c.send(`USER ${nick} 0 * :flap${id}`);
      await c.waitForLine(/\s001\s/, 15000);
      let i = 0;
      while (!stop.value) {
        c.send(`JOIN ${CHAN}`);
        await sleep(150);
        c.send(`PART ${CHAN}`);
        await sleep(150);
        i++;
        if (i % 50 === 0) break;
      }
    } catch { /* swallow */ }
    finally { c.close(); }
    if (!stop.value) await sleep(500);
  }
}

/** Observer: /STATS z poller + JSONL writer. */
interface SizeClass {
  size: number;
  alloc: number;
  used: number;
}
interface Snapshot {
  ts: string;
  t_seconds: number;
  msgs_alloc: number;
  msgs_used: number;
  tot_bufsize: number;
  classes: SizeClass[];
  totals?: Record<string, number>;
}

async function statsObserver(outFile: string, runStartMs: number, stop: { value: boolean }) {
  const opNick = uniq('soakob_').substring(0, 9);
  const c = new RawClient(IRC_HOST, IRC_PORT);
  await c.ready();
  c.send(`NICK ${opNick}`);
  c.send(`USER ${opNick} 0 * :soak-observer`);
  await c.waitForLine(/\s001\s/, 60000);
  c.send(`OPER ${OPER_NAME} ${OPER_PASS}`);
  try { await c.waitForLine(/\s381\s/, 15000); }
  catch { console.warn('observer: OPER did not return 381 — STATS may be HIS-shielded'); }
  // Tell server we want SNO_NETWORK (so a panic snotice would land here too, just in case)
  c.send(`MODE ${opNick} +s 1024`);
  await sleep(500);

  const intervalMs = INTERVAL_MIN * 60 * 1000;
  fs.writeFileSync(outFile, '');

  const snapshot = (): Promise<Snapshot> => {
    return new Promise((resolve, reject) => {
      const collected: string[] = [];
      const prior = c.onLine;
      const timer = setTimeout(() => {
        c.onLine = prior;
        reject(new Error('STATS z timeout'));
      }, 15000);
      c.onLine = (line: string) => {
        prior(line);
        collected.push(line);
        if (/:End of \/STATS report/i.test(line) && / z\b/i.test(line)) {
          clearTimeout(timer);
          c.onLine = prior;
          const parsed = parseStatsZ(collected);
          parsed.t_seconds = Math.round((Date.now() - runStartMs) / 1000);
          resolve(parsed);
        }
      };
      c.send(`STATS z`);
    });
  };

  let firstSnap: Snapshot | undefined;
  let lastSnap: Snapshot | undefined;
  // Initial snapshot
  try {
    const s = await snapshot();
    firstSnap = s; lastSnap = s;
    fs.appendFileSync(outFile, JSON.stringify(s) + '\n');
    console.log(`[observer] t=${s.t_seconds}s tot_bufsize=${s.tot_bufsize} msgs_used=${s.msgs_used} classes=${s.classes.map(c=>`${c.size}:${c.used}/${c.alloc}`).join(' ')}`);
  } catch (e) {
    console.error('[observer] initial STATS z failed:', e);
  }

  while (!stop.value) {
    await sleep(Math.min(intervalMs, 5000));
    if (stop.value) break;
    if (Date.now() - (lastSnap ? new Date(lastSnap.ts).getTime() : 0) < intervalMs) continue;
    try {
      const s = await snapshot();
      lastSnap = s;
      fs.appendFileSync(outFile, JSON.stringify(s) + '\n');
      console.log(`[observer] t=${s.t_seconds}s tot_bufsize=${s.tot_bufsize} msgs_used=${s.msgs_used} classes=${s.classes.map(c=>`${c.size}:${c.used}/${c.alloc}`).join(' ')}`);
    } catch (e) {
      console.error('[observer] STATS z snapshot failed:', e);
    }
  }
  c.close();
  return { firstSnap, lastSnap };
}

function parseStatsZ(lines: string[]): Snapshot {
  const s: Snapshot = {
    ts: new Date().toISOString(),
    t_seconds: 0,
    msgs_alloc: 0,
    msgs_used: 0,
    tot_bufsize: 0,
    classes: [],
  };
  for (const line of lines) {
    // ":Msgs allocated %d(%zu) used %d(%zu) text %zu"
    let m = line.match(/:Msgs allocated (\d+)\(\d+\) used (\d+)\(\d+\) text (\d+)/);
    if (m) {
      s.msgs_alloc = parseInt(m[1], 10);
      s.msgs_used = parseInt(m[2], 10);
      s.tot_bufsize = parseInt(m[3], 10);
      continue;
    }
    // ":MsgBufs of size %zu allocated %d(%zu) used %d(%zu)"
    m = line.match(/:MsgBufs of size (\d+) allocated (\d+)\(\d+\) used (\d+)\(\d+\)/);
    if (m) {
      s.classes.push({
        size: parseInt(m[1], 10),
        alloc: parseInt(m[2], 10),
        used: parseInt(m[3], 10),
      });
    }
  }
  return s;
}

function summarize(first: Snapshot, last: Snapshot, runtimeSec: number): string {
  const lines: string[] = [];
  const dt = (new Date(last.ts).getTime() - new Date(first.ts).getTime()) / 1000;
  lines.push('== leak-soak summary ==');
  lines.push(`runtime:       ${runtimeSec.toFixed(0)}s`);
  lines.push(`first → last:  ${dt.toFixed(0)}s between snapshots`);
  lines.push(`tot_bufsize:   ${first.tot_bufsize} → ${last.tot_bufsize}  (Δ=${last.tot_bufsize - first.tot_bufsize}, ${dt > 0 ? ((last.tot_bufsize - first.tot_bufsize) / (dt / 3600)).toFixed(0) : '?'} bytes/h)`);
  lines.push(`msgs_used:     ${first.msgs_used} → ${last.msgs_used}`);
  lines.push(``);
  lines.push(`class    alloc Δ    used Δ    used end   ratchet/h`);
  for (const lc of last.classes) {
    const fc = first.classes.find(c => c.size === lc.size);
    if (!fc) continue;
    const usedDelta = lc.used - fc.used;
    const allocDelta = lc.alloc - fc.alloc;
    const ratchet = dt > 0 ? (usedDelta / (dt / 3600)) : 0;
    lines.push(`${String(lc.size).padStart(5)}    ${String(allocDelta).padStart(7)}   ${String(usedDelta).padStart(7)}   ${String(lc.used).padStart(8)}   ${ratchet.toFixed(0).padStart(6)}/h`);
  }
  lines.push(``);
  const climbing = last.classes.filter(lc => {
    const fc = first.classes.find(c => c.size === lc.size);
    return fc && lc.used > fc.used + 50;
  });
  if (climbing.length > 0) {
    lines.push(`LEAK SIGNAL: classes monotonically climbed: ${climbing.map(c => c.size).join(', ')}`);
    lines.push(`            → the leaked carrier is at one of these sizes`);
    lines.push(`            → narrow the audit to subsystems emitting wire tokens of that body length`);
  } else {
    lines.push(`No clear leak signal in this run (used counts stayed flat or oscillated).`);
    lines.push(`Either:`);
    lines.push(`  - the leaky path isn't exercised by this traffic shape — try heavier mix`);
    lines.push(`  - the leak rate is below ${(50 / (dt / 3600)).toFixed(0)}/h and needs a longer run`);
    lines.push(`  - the leak shape on prod is traffic-specific (real users doing X)`);
  }
  return lines.join('\n');
}

async function main() {
  const startTs = Date.now();
  const tag = new Date(startTs).toISOString().replace(/[:.]/g, '-');
  const dir = path.join(OUT_DIR, tag);
  fs.mkdirSync(dir, { recursive: true });
  const statsFile = path.join(dir, 'stats.jsonl');
  const summaryFile = path.join(dir, 'summary.txt');
  console.log(`leak-soak: results → ${dir}`);
  console.log(`leak-soak: ${WORKERS} churn(testnet) + ${LEAF_WORKERS} churn(leaf) + ${CHATTY} chatty + ${FLAPPERS} flap + ${BOUNCERS} bouncer + ${CHATHISTORY} chathistory + ${REVIVES} revive-storm + ${NICKCHURN} nick-churn; /STATS z every ${INTERVAL_MIN}min`);

  const stop = { value: false };
  process.on('SIGINT', () => { console.log('\n[main] SIGINT — winding down'); stop.value = true; });
  process.on('SIGTERM', () => { console.log('\n[main] SIGTERM — winding down'); stop.value = true; });
  // Workers may throw timeouts mid-cycle; their try/catch handles loop
  // recovery, but the rejection itself can fire before the catch runs
  // its microtask if the timeout was racing close(), so swallow at the
  // process level rather than letting Node terminate.
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/timeout waiting/.test(msg)) return;  // benign — worker recycles
    console.error('[unhandledRejection]', reason);
  });

  // Start observer FIRST (so it gets 001 before the worker storm hits)
  const observerPromise = statsObserver(statsFile, startTs, stop);
  await sleep(2000);

  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < WORKERS; i++) {
    workerPromises.push(churnWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(250);
  }
  for (let i = 0; i < LEAF_WORKERS; i++) {
    workerPromises.push(churnWorker(WORKERS + i, IRC_HOST2, IRC_PORT2, stop));
    await sleep(250);
  }
  for (let i = 0; i < CHATTY; i++) {
    workerPromises.push(chattyWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(250);
  }
  for (let i = 0; i < FLAPPERS; i++) {
    workerPromises.push(flapWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(250);
  }
  for (let i = 0; i < BOUNCERS; i++) {
    const host = (i % 2 === 0) ? IRC_HOST : IRC_HOST2;
    const port = (i % 2 === 0) ? IRC_PORT : IRC_PORT2;
    workerPromises.push(bouncerWorker(i, host, port, stop));
    await sleep(500);
  }
  for (let i = 0; i < CHATHISTORY; i++) {
    workerPromises.push(chathistoryWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(500);
  }
  for (let i = 0; i < REVIVES; i++) {
    workerPromises.push(reviveStormWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(500);
  }
  for (let i = 0; i < NICKCHURN; i++) {
    workerPromises.push(nickChurnWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(300);
  }
  for (let i = 0; i < SASLONLY; i++) {
    workerPromises.push(saslOnlyWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(500);
  }
  for (let i = 0; i < BARECONN; i++) {
    workerPromises.push(bareConnectWorker(i, IRC_HOST, IRC_PORT, stop));
    await sleep(200);
  }

  const { firstSnap, lastSnap } = await observerPromise;
  await Promise.all(workerPromises);

  if (firstSnap && lastSnap) {
    const summary = summarize(firstSnap, lastSnap, (Date.now() - startTs) / 1000);
    fs.writeFileSync(summaryFile, summary + '\n');
    console.log('\n' + summary);
    console.log(`\nfull snapshots: ${statsFile}`);
    console.log(`summary:        ${summaryFile}`);
  } else {
    console.log('\n[main] No snapshots captured — observer failed early.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
