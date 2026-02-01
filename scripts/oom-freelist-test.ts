/**
 * OOM Freelist Leak Reproduction & Memory Monitor
 *
 * Reproduces evilnet/nefarious2#76 by triggering repeated SQUIT/reconnect
 * cycles while active users are connected, monitoring memory growth via
 * IRC STATS z/x and docker stats.
 *
 * Usage:
 *   cd tests && npx tsx ../scripts/oom-freelist-test.ts
 *
 * Environment variables:
 *   OOM_CYCLES              - SQUIT/reconnect cycles (default: 20)
 *   OOM_TARGET              - Server to SQUIT (default: upstream.fractalrealities.net)
 *   OOM_SETTLE_DELAY        - ms after reconnect before measuring (default: 5000)
 *   OOM_SERVICES_CYCLES     - Additional X3 SQUIT cycles (default: 0)
 *   OOM_REGISTER_CHANNELS   - Extra channels to register for ChanServ memberships (default: 0)
 *   IRC_HOST                - Hub server host (default: localhost)
 *   IRC_PORT                - Hub server port (default: 6667)
 *   HUB_CONTAINER           - Hub docker container name (default: nefarious)
 *   UPSTREAM_CONTAINER      - Upstream docker container name (default: nefarious-upstream)
 */

import { createOperClient, X3Client, IRC_OPER } from '../tests/src/helpers/x3-client.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  cycles: parseInt(process.env.OOM_CYCLES || '20'),
  target: process.env.OOM_TARGET || 'upstream.fractalrealities.net',
  settleDelay: parseInt(process.env.OOM_SETTLE_DELAY || '5000'),
  servicesCycles: parseInt(process.env.OOM_SERVICES_CYCLES || '0'),
  registerChannels: parseInt(process.env.OOM_REGISTER_CHANNELS || '0'),
  hubContainer: process.env.HUB_CONTAINER || 'nefarious',
  upstreamContainer: process.env.UPSTREAM_CONTAINER || 'nefarious-upstream',
};

// ── Types ──────────────────────────────────────────────────────────────────

interface MemorySnapshot {
  // STATS z
  clients: number;
  connections: number;
  channels: number;
  channelsMem: number;
  memberships: number;
  membershipsMem: number;
  bans: number;
  bansMem: number;
  glines: number;
  zlines: number;
  shuns: number;
  jupes: number;
  totalCL: number;
  totalCH: number;
  totalDB: number;
  totalMS: number;
  totalMB: number;
  // STATS x
  bansInUse: number;
  bansFree: number;
  bansAlloc: number;
  // Docker
  hubMemMB: number;
  upstreamMemMB: number;
}

interface Measurement {
  cycle: number | 'base';
  timestamp: number;
  snapshot: MemorySnapshot;
}

// ── STATS z Parser ─────────────────────────────────────────────────────────

function parseStatsZLines(lines: string[]): Partial<MemorySnapshot> {
  const result: Partial<MemorySnapshot> = {};

  for (const line of lines) {
    let m: RegExpMatchArray | null;

    // :Clients N(bytes) Connections N(bytes)
    m = line.match(/Clients\s+(\d+)\((\d+)\)\s+Connections\s+(\d+)\((\d+)\)/);
    if (m) {
      result.clients = parseInt(m[1]);
      result.connections = parseInt(m[3]);
      continue;
    }

    // :Channels N(bytes) Bans N(bytes)
    m = line.match(/Channels\s+(\d+)\((\d+)\)\s+Bans\s+(\d+)\((\d+)\)/);
    if (m) {
      result.channels = parseInt(m[1]);
      result.channelsMem = parseInt(m[2]);
      result.bans = parseInt(m[3]);
      result.bansMem = parseInt(m[4]);
      continue;
    }

    // :Channel Members N(bytes) Invites N(bytes)
    m = line.match(/Channel Members\s+(\d+)\((\d+)\)\s+Invites/);
    if (m) {
      result.memberships = parseInt(m[1]);
      result.membershipsMem = parseInt(m[2]);
      continue;
    }

    // :Glines N(bytes) Zlines N(bytes) Shuns N(bytes) Jupes N(bytes)
    m = line.match(/Glines\s+(\d+)\((\d+)\)\s+Zlines\s+(\d+)\((\d+)\)\s+Shuns\s+(\d+)\((\d+)\)\s+Jupes\s+(\d+)\((\d+)\)/);
    if (m) {
      result.glines = parseInt(m[1]);
      result.zlines = parseInt(m[3]);
      result.shuns = parseInt(m[5]);
      result.jupes = parseInt(m[7]);
      continue;
    }

    // :Total: ww N ch N cl N co N db N ms N mb N
    m = line.match(/Total:\s+ww\s+(\d+)\s+ch\s+(\d+)\s+cl\s+(\d+)\s+co\s+(\d+)\s+db\s+(\d+)\s+ms\s+(\d+)\s+mb\s+(\d+)/);
    if (m) {
      result.totalCH = parseInt(m[2]);
      result.totalCL = parseInt(m[3]);
      result.totalDB = parseInt(m[5]);
      result.totalMS = parseInt(m[6]);
      result.totalMB = parseInt(m[7]);
      continue;
    }
  }

  return result;
}

// ── STATS x Parser (ban freelist) ──────────────────────────────────────────

function parseBanStats(lines: string[]): { inuse: number; free: number; alloc: number } {
  for (const line of lines) {
    // :Bans: inuse N(bytes) free N alloc N
    const m = line.match(/Bans:\s+inuse\s+(\d+)\((\d+)\)\s+free\s+(\d+)\s+alloc\s+(\d+)/);
    if (m) {
      return { inuse: parseInt(m[1]), free: parseInt(m[3]), alloc: parseInt(m[4]) };
    }
  }
  return { inuse: 0, free: 0, alloc: 0 };
}

// ── Docker Stats ───────────────────────────────────────────────────────────

function parseMemString(memStr: string): number {
  const m = memStr.match(/([\d.]+)(\w+)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'gib') return val * 1024;
  if (unit === 'mib') return val;
  if (unit === 'kib') return val / 1024;
  if (unit === 'gb') return val * 1000;
  if (unit === 'mb') return val;
  if (unit === 'kb') return val / 1000;
  return val;
}

async function getContainerMem(container: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `docker stats ${container} --no-stream --format '{{.MemUsage}}'`
    );
    // Format: "45.2MiB / 2GiB"
    return parseMemString(stdout.trim().split('/')[0].trim());
  } catch {
    return 0;
  }
}

// ── IRC Stats Collection ───────────────────────────────────────────────────

async function collectStatsZ(client: X3Client): Promise<string[]> {
  client.clearRawBuffer();
  client.send('STATS z');

  const lines: string[] = [];
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const msg = await client.waitForParsedLine(
        m => m.command === '249' || m.command === '219',
        5000
      );
      if (msg.command === '219') break;
      lines.push(msg.trailing || msg.params[msg.params.length - 1] || '');
    } catch {
      break;
    }
  }
  return lines;
}

async function collectStatsX(client: X3Client): Promise<string[]> {
  client.clearRawBuffer();
  client.send('STATS x');

  const lines: string[] = [];
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const msg = await client.waitForParsedLine(
        m => m.command === '249' || m.command === '219',
        5000
      );
      if (msg.command === '219') break;
      lines.push(msg.trailing || msg.params[msg.params.length - 1] || '');
    } catch {
      break;
    }
  }
  return lines;
}

async function collectSnapshot(client: X3Client): Promise<MemorySnapshot> {
  const statsZLines = await collectStatsZ(client);
  const statsXLines = await collectStatsX(client);

  const [hubMem, upstreamMem] = await Promise.all([
    getContainerMem(CONFIG.hubContainer),
    getContainerMem(CONFIG.upstreamContainer),
  ]);

  const statsZ = parseStatsZLines(statsZLines);
  const banStats = parseBanStats(statsXLines);

  return {
    clients: statsZ.clients ?? 0,
    connections: statsZ.connections ?? 0,
    channels: statsZ.channels ?? 0,
    channelsMem: statsZ.channelsMem ?? 0,
    memberships: statsZ.memberships ?? 0,
    membershipsMem: statsZ.membershipsMem ?? 0,
    bans: statsZ.bans ?? 0,
    bansMem: statsZ.bansMem ?? 0,
    glines: statsZ.glines ?? 0,
    zlines: statsZ.zlines ?? 0,
    shuns: statsZ.shuns ?? 0,
    jupes: statsZ.jupes ?? 0,
    totalCL: statsZ.totalCL ?? 0,
    totalCH: statsZ.totalCH ?? 0,
    totalDB: statsZ.totalDB ?? 0,
    totalMS: statsZ.totalMS ?? 0,
    totalMB: statsZ.totalMB ?? 0,
    bansInUse: banStats.inuse,
    bansFree: banStats.free,
    bansAlloc: banStats.alloc,
    hubMemMB: hubMem,
    upstreamMemMB: upstreamMem,
  };
}

// ── Upstream Oper Client ───────────────────────────────────────────────────

const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '6671');

async function createUpstreamOperClient(): Promise<X3Client> {
  const upClient = new X3Client();
  const host = process.env.IRC_HOST ?? 'localhost';
  await upClient.connect(host, UPSTREAM_PORT);

  await upClient.capLs();
  upClient.capEnd();
  upClient.register('oom-upstream');
  await upClient.waitForLine(/001/);

  await new Promise(r => setTimeout(r, 1000));

  // Oper up on upstream (same credentials as hub)
  upClient.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  try {
    await upClient.waitForLine(/381/, 5000);
  } catch {
    console.warn('  WARNING: Failed to oper up on upstream');
  }

  upClient.clearRawBuffer();
  return upClient;
}

// ── SQUIT / CONNECT Cycle ──────────────────────────────────────────────────

async function squitAndReconnect(
  hubClient: X3Client,
  upstreamClient: X3Client | null,
  serverName: string,
  cycle: number,
  timeout = 60000
): Promise<{ reconnected: boolean; upstreamClient: X3Client | null }> {
  hubClient.clearRawBuffer();
  hubClient.send(`SQUIT ${serverName} :oom-test cycle ${cycle}`);

  // Let SQUIT fully process
  await new Promise(r => setTimeout(r, 3000));

  let newUpstreamClient: X3Client | null = null;

  if (serverName !== 'x3.services') {
    // The upstream oper client gets disconnected by the SQUIT, so reconnect it
    // and issue CONNECT from the upstream side (where the Connect block has SSL)
    console.log(`  Cycle ${cycle}: SQUIT sent, reconnecting upstream oper...`);

    // Retry connecting to upstream — it may briefly refuse connections after SQUIT
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        newUpstreamClient = await createUpstreamOperClient();
        newUpstreamClient.clearRawBuffer();
        // Issue CONNECT from upstream side — its Connect block has ssl=yes for the hub
        newUpstreamClient.send(`CONNECT testnet.fractalrealities.net 4496`);
        console.log(`  Cycle ${cycle}: CONNECT issued from upstream (attempt ${attempt}), waiting for link...`);
        break;
      } catch (err) {
        if (attempt < 5) {
          console.log(`  Cycle ${cycle}: Upstream not ready (attempt ${attempt}/5), retrying in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.log(`  Cycle ${cycle}: Could not connect to upstream after 5 attempts, waiting for autoconnect...`);
        }
      }
    }
  } else {
    // X3 services — just wait for autoconnect (x3 reconnects on its own)
    console.log(`  Cycle ${cycle}: SQUIT sent, waiting for services autoconnect...`);
  }

  // Poll LINKS on hub until upstream server reappears
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 3000));
    hubClient.clearRawBuffer();
    hubClient.send('LINKS');

    const links: string[] = [];
    try {
      while (true) {
        const msg = await hubClient.waitForParsedLine(
          m => m.command === '364' || m.command === '365',
          5000
        );
        if (msg.command === '365') break;
        links.push(msg.params.join(' '));
      }
    } catch { /* timeout on individual line */ }

    if (links.some(l => l.includes(serverName))) {
      return { reconnected: true, upstreamClient: newUpstreamClient };
    }
  }
  return { reconnected: false, upstreamClient: newUpstreamClient };
}

// ── Output Formatting ──────────────────────────────────────────────────────

function pad(val: string | number, width: number, align: 'left' | 'right' = 'right'): string {
  const s = String(val);
  if (align === 'left') return s.padEnd(width);
  return s.padStart(width);
}

function fmtMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${mb.toFixed(1)}MB`;
}

function fmtDelta(current: number, baseline: number): string {
  const d = current - baseline;
  if (d === 0) return '0';
  return d > 0 ? `+${d}` : `${d}`;
}

function fmtMemDelta(current: number, baseline: number): string {
  const d = current - baseline;
  if (Math.abs(d) < 0.1) return '0';
  return d > 0 ? `+${fmtMem(d)}` : `-${fmtMem(Math.abs(d))}`;
}

function printHeader(): void {
  console.log('');
  console.log('        |         Hub (nefarious)                                      | Upstream');
  console.log(' Cycle  | Clients | Chans | Members | Bans(use) | Bans(free) | Glines | Hub RSS  | Up RSS');
  console.log('--------+---------+-------+---------+-----------+------------+--------+----------+---------');
}

function printRow(m: Measurement): void {
  const s = m.snapshot;
  const label = m.cycle === 'base' ? '  base' : pad(m.cycle, 6);
  console.log(
    `${label} |` +
    ` ${pad(s.clients, 7)} |` +
    ` ${pad(s.channels, 5)} |` +
    ` ${pad(s.memberships, 7)} |` +
    ` ${pad(s.bansInUse, 9)} |` +
    ` ${pad(s.bansFree, 10)} |` +
    ` ${pad(s.glines, 6)} |` +
    ` ${pad(fmtMem(s.hubMemMB), 8)} |` +
    ` ${pad(fmtMem(s.upstreamMemMB), 7)}`
  );
}

function printDelta(baseline: MemorySnapshot, final: MemorySnapshot): void {
  console.log('--------+---------+-------+---------+-----------+------------+--------+----------+---------');
  console.log(
    ` Delta |` +
    ` ${pad(fmtDelta(final.clients, baseline.clients), 7)} |` +
    ` ${pad(fmtDelta(final.channels, baseline.channels), 5)} |` +
    ` ${pad(fmtDelta(final.memberships, baseline.memberships), 7)} |` +
    ` ${pad(fmtDelta(final.bansInUse, baseline.bansInUse), 9)} |` +
    ` ${pad(fmtDelta(final.bansFree, baseline.bansFree), 10)} |` +
    ` ${pad(fmtDelta(final.glines, baseline.glines), 6)} |` +
    ` ${pad(fmtMemDelta(final.hubMemMB, baseline.hubMemMB), 8)} |` +
    ` ${pad(fmtMemDelta(final.upstreamMemMB, baseline.upstreamMemMB), 7)}`
  );
}

function printAnalysis(baseline: MemorySnapshot, final: MemorySnapshot, cycles: number): void {
  console.log('');
  console.log('Analysis:');

  const bansFreeGrowth = final.bansFree - baseline.bansFree;
  const bansAllocGrowth = final.bansAlloc - baseline.bansAlloc;
  const hubRSSGrowth = final.hubMemMB - baseline.hubMemMB;
  const upRSSGrowth = final.upstreamMemMB - baseline.upstreamMemMB;
  const membDelta = final.memberships - baseline.memberships;
  const glineDelta = final.glines - baseline.glines;

  if (bansFreeGrowth > 0) {
    console.log(`  Ban freelist grew by ${bansFreeGrowth} (${bansAllocGrowth} new allocs) across ${cycles} cycles`);
    console.log(`    -> freelist never returns memory to OS`);
  } else {
    console.log(`  Ban freelist: no growth detected (free: ${baseline.bansFree} -> ${final.bansFree})`);
  }

  if (hubRSSGrowth > 1) {
    console.log(`  Hub RSS grew ${fmtMemDelta(final.hubMemMB, baseline.hubMemMB)} — consistent with freelist retention`);
  } else {
    console.log(`  Hub RSS stable (${fmtMem(baseline.hubMemMB)} -> ${fmtMem(final.hubMemMB)})`);
  }

  if (upRSSGrowth > 1) {
    console.log(`  Upstream RSS grew ${fmtMemDelta(final.upstreamMemMB, baseline.upstreamMemMB)} — same freelist issue in stock nefarious`);
  } else {
    console.log(`  Upstream RSS stable (${fmtMem(baseline.upstreamMemMB)} -> ${fmtMem(final.upstreamMemMB)})`);
  }

  if (membDelta === 0) {
    console.log(`  Memberships stable at ${final.memberships} — freelist growth invisible to STATS z`);
  } else {
    console.log(`  Memberships changed: ${fmtDelta(final.memberships, baseline.memberships)} (expected ~0 if no new channels)`);
  }

  if (glineDelta > 0) {
    console.log(`  Glines grew by ${glineDelta} — duplication on re-burst confirmed`);
  } else {
    console.log(`  Glines stable — no duplication observed`);
  }
}

// ── Channel Pre-Registration ───────────────────────────────────────────────

async function registerExtraChannels(client: X3Client, count: number): Promise<string[]> {
  const channels: string[] = [];
  console.log(`Registering ${count} extra channels for ChanServ membership amplification...`);

  for (let i = 0; i < count; i++) {
    const chan = `#oom-reg-${String(i).padStart(3, '0')}`;
    client.clearRawBuffer();
    client.send(`JOIN ${chan}`);
    await new Promise(r => setTimeout(r, 200));
    const result = await client.registerChannel(chan);
    if (result.success) {
      channels.push(chan);
      if ((i + 1) % 25 === 0) {
        console.log(`  Registered ${i + 1}/${count}...`);
      }
    } else {
      console.log(`  Failed to register ${chan}: ${result.error}`);
    }
  }

  console.log(`  Done: ${channels.length}/${count} channels registered`);
  return channels;
}

async function unregisterChannels(client: X3Client, channels: string[]): Promise<void> {
  if (channels.length === 0) return;
  console.log(`Cleaning up ${channels.length} registered channels...`);

  for (const chan of channels) {
    client.clearRawBuffer();
    // First attempt may require confirmation
    const result = await client.unregisterChannel(chan);
    if (result.error === 'confirmation_needed') {
      await client.unregisterChannel(chan, 'CONFIRM');
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

let client: X3Client | null = null;
let registeredChannels: string[] = [];
let measurements: Measurement[] = [];
let interrupted = false;

function printPartialResults(): void {
  if (measurements.length < 2) return;
  const baseline = measurements[0].snapshot;
  const last = measurements[measurements.length - 1].snapshot;
  console.log('\n--- Partial Results (interrupted) ---');
  printDelta(baseline, last);
  printAnalysis(baseline, last, measurements.length - 1);
}

process.on('SIGINT', async () => {
  if (interrupted) process.exit(1);
  interrupted = true;
  console.log('\nInterrupted — printing partial results...');
  printPartialResults();

  if (registeredChannels.length > 0 && client) {
    try { await unregisterChannels(client, registeredChannels); } catch {}
  }
  if (client) {
    try { client.send('QUIT :oom-test done'); } catch {}
  }
  process.exit(0);
});

async function main(): Promise<void> {
  console.log('OOM Freelist Leak Test');
  console.log(`Target: ${CONFIG.target}`);
  console.log(`Cycles: ${CONFIG.cycles} (settle delay: ${CONFIG.settleDelay}ms)`);
  if (CONFIG.servicesCycles > 0) {
    console.log(`Services cycles: ${CONFIG.servicesCycles} (x3.services)`);
  }
  if (CONFIG.registerChannels > 0) {
    console.log(`Extra registered channels: ${CONFIG.registerChannels}`);
  }
  console.log('');

  // Phase 1: Setup
  console.log('Connecting as oper...');
  client = await createOperClient('oom-monitor');
  client.send('JOIN #room');
  await new Promise(r => setTimeout(r, 1000));

  if (CONFIG.registerChannels > 0) {
    registeredChannels = await registerExtraChannels(client, CONFIG.registerChannels);
  }

  // Phase 2: Baseline
  console.log('Collecting baseline...');
  const baselineSnapshot = await collectSnapshot(client);
  const baseline: Measurement = { cycle: 'base', timestamp: Date.now(), snapshot: baselineSnapshot };
  measurements.push(baseline);

  printHeader();
  printRow(baseline);

  // Phase 3: SQUIT/Reconnect Loop
  let upstreamClient: X3Client | null = null;

  for (let cycle = 1; cycle <= CONFIG.cycles && !interrupted; cycle++) {
    const result = await squitAndReconnect(client, upstreamClient, CONFIG.target, cycle);
    upstreamClient = result.upstreamClient;
    if (!result.reconnected) {
      console.log(`  WARNING: ${CONFIG.target} did not reconnect within timeout at cycle ${cycle}`);
      console.log('  Continuing with measurements anyway...');
    }

    // Settle
    await new Promise(r => setTimeout(r, CONFIG.settleDelay));

    const snapshot = await collectSnapshot(client);
    const m: Measurement = { cycle, timestamp: Date.now(), snapshot };
    measurements.push(m);
    printRow(m);
  }

  // Clean up upstream oper client
  if (upstreamClient) {
    try { upstreamClient.send('QUIT'); } catch {}
  }

  // Phase 3b: Optional services cycles
  if (CONFIG.servicesCycles > 0 && !interrupted) {
    console.log('');
    console.log(`--- Services SQUIT cycles (x3.services x ${CONFIG.servicesCycles}) ---`);

    for (let cycle = 1; cycle <= CONFIG.servicesCycles && !interrupted; cycle++) {
      // For services, CONNECT from hub side works (x3 accepts inbound)
      const result = await squitAndReconnect(client, null, 'x3.services', cycle);
      if (!result.reconnected) {
        console.log(`  WARNING: x3.services did not reconnect within timeout at cycle ${cycle}`);
      }

      await new Promise(r => setTimeout(r, CONFIG.settleDelay));

      const snapshot = await collectSnapshot(client);
      const m: Measurement = {
        cycle: `svc-${cycle}` as any,
        timestamp: Date.now(),
        snapshot,
      };
      measurements.push(m);
      printRow(m);
    }
  }

  // Summary
  const finalSnapshot = measurements[measurements.length - 1].snapshot;
  printDelta(baselineSnapshot, finalSnapshot);
  printAnalysis(baselineSnapshot, finalSnapshot, measurements.length - 1);

  // Cleanup
  if (registeredChannels.length > 0) {
    await unregisterChannels(client, registeredChannels);
  }

  client.send('QUIT :oom-test complete');
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  printPartialResults();
  process.exit(1);
});
