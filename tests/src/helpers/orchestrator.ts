/**
 * Multi-server scenario orchestrator (Phase B starter).
 *
 * Drives state observation on a multi-server testnet via existing IRC
 * commands.  Designed to be expanded as scenarios in tests/src/bouncer/
 * grow; today provides:
 *
 *   - linkComplete(client, expectedPeers): poll /STATS l + /MAP until
 *     all expected peers are linked AND past their burst (no `!` in
 *     /MAP, indicating burst-ack steady state).
 *
 * Docker orchestration primitives (bringUp, kill, restart, forceSquit)
 * will land here when the first scenario needs them; for now scenarios
 * run against an already-up compose stack and drive events via /SQUIT
 * etc. directly through an oper client.
 */

import type { RawSocketClient, IRCMessage } from './ircv3-client.js';
import { parseIRCMessage } from './ircv3-client.js';

export interface LinkState {
  /** Peer server names visible in /STATS l */
  connectedPeers: string[];
  /** Per-peer flags from /MAP: `!` means still mid-burst (BURST_ACK not cleared) */
  burstingPeers: string[];
  /** Raw output for debugging */
  raw: string[];
}

/**
 * Snapshot the link state via /STATS l + /MAP, parsed into a flat shape.
 *
 * /STATS l rows: `<peer_name> <SendQ> <SendM> <SendKB> <RcvM> <RcvKB> :<openSince>`
 * /MAP rows: `<prefix><server>[!] [<users>]`  — `!` indicates still bursting
 *
 * Caller must already be opered (PRIV_STATS_l / PRIV_MAP).
 */
export async function snapshotLinks(
  client: RawSocketClient,
  timeoutMs = 3000
): Promise<LinkState> {
  const state: LinkState = {
    connectedPeers: [],
    burstingPeers: [],
    raw: [],
  };

  // Tap into the line listener list to collect responses to both
  // commands.  We dispatch both commands in sequence and wait for the
  // END-OF-STATS (219) for /STATS l, then the end of /MAP (017).
  const listeners = (client as unknown as {
    lineListeners: Array<(l: string, i: number) => void>;
  }).lineListeners;

  const captured: IRCMessage[] = [];
  const listener = (line: string) => {
    if (!line) return;
    try {
      captured.push(parseIRCMessage(line));
      state.raw.push(line);
    } catch {
      // Ignore malformed.
    }
  };
  listeners.push(listener);

  try {
    client.send('STATS l');
    await client.waitForLine(/\s219\s/, timeoutMs);

    client.send('MAP');
    // /MAP terminator: RPL_MAPEND 017 in nefarious.
    await client.waitForLine(/\s017\s/, timeoutMs);
  } finally {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  }

  // Parse /STATS l rows: numeric 211 (RPL_STATSLINKINFO).
  for (const msg of captured) {
    if (msg.command !== '211') continue;
    const trailingParam = msg.params[msg.params.length - 1] ?? '';
    // params[0] is the client's nick; we don't need it.  The peer name
    // is the first significant field after the nick.  Format example:
    //   <nick> <peer> 0 55 4 31 1 :616
    // Different builds shift the columns; the peer name is the first
    // alphabetic non-numeric column after the nick.
    const fields = msg.params.slice(1);
    if (fields.length === 0) continue;
    const peerName = fields[0];
    if (peerName && /[a-zA-Z]/.test(peerName) && !state.connectedPeers.includes(peerName)) {
      state.connectedPeers.push(peerName);
    }
    // Suppress unused warning for trailingParam (kept for future use).
    void trailingParam;
  }

  // Parse /MAP rows: numeric 015 (RPL_MAP).  The `!` marker appears
  // immediately after the server name when the peer is still bursting.
  for (const msg of captured) {
    if (msg.command !== '015') continue;
    const trailing = msg.params[msg.params.length - 1] ?? '';
    // Strip tree-drawing prefix (whitespace, |, `-, etc.) and grab the
    // first token; `!` may be appended.
    const trimmed = trailing.replace(/^[\s|`\-]+/, '');
    const m = trimmed.match(/^(\S+?)(!)?(\s|$)/);
    if (m && m[2] === '!') {
      state.burstingPeers.push(m[1]);
    }
  }

  return state;
}

/**
 * Wait for all expected peers to be both (a) present in /STATS l and
 * (b) absent from /MAP's bursting set (no `!` marker).  Polls every
 * 250ms up to `timeoutMs`.
 *
 * Returns the final LinkState on success; throws on timeout with
 * diagnostic context.
 */
export async function linkComplete(
  client: RawSocketClient,
  expectedPeers: string[],
  timeoutMs = 60_000
): Promise<LinkState> {
  const deadline = Date.now() + timeoutMs;
  let last: LinkState | null = null;

  while (Date.now() < deadline) {
    last = await snapshotLinks(client);

    const missing = expectedPeers.filter(p => !last!.connectedPeers.includes(p));
    const stillBursting = expectedPeers.filter(p => last!.burstingPeers.includes(p));

    if (missing.length === 0 && stillBursting.length === 0) {
      return last;
    }

    await new Promise(r => setTimeout(r, 250));
  }

  const ctx = last
    ? `connected=${last.connectedPeers.join(',')} bursting=${last.burstingPeers.join(',')}`
    : '(no snapshot)';
  throw new Error(`linkComplete timeout after ${timeoutMs}ms; expected=${expectedPeers.join(',')} ${ctx}`);
}
