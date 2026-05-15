/**
 * /CHECK -b output parser
 *
 * Drives `/CHECK <nick> -b` against a connected (oper) client and parses
 * the machine-readable BouncerPrimary / BouncerAlias / BouncerFace lines
 * emitted by m_check.c when the -b flag is present.
 *
 * Each parsed entry is a flat object suitable for direct assertion.
 *
 * Example:
 *   const state = await runCheck(client, 'ibutsu');
 *   expect(state.primary?.numeric).toBe('BjAAA');
 *   expect(state.aliases).toHaveLength(1);
 *   expect(state.aliases[0].nick).toBe('ibutsu_');
 *   expect(state.faces.map(f => f.peer)).toContain('AF');
 */

import type { IRCMessage, RawSocketClient } from './ircv3-client.js';
import { parseIRCMessage } from './ircv3-client.js';

export interface BouncerPrimary {
  numeric: string;     // 5-char YXXXX
  nick: string;
  lastnick: number;    // unix timestamp
  sessid: string;      // hs_sessid, or "-" if empty
  server: string;      // server name
  locality: 'local' | 'remote';
}

export interface BouncerAlias {
  index: number;       // 1-based slot
  numeric: string;
  nick: string;        // alias's cli_name (may be "-" if alias is unresolved)
  lastnick: number;
  sessid: string;
  server: string;      // server name
  locality: 'local' | 'remote';
  primaryNumeric: string;  // cli_alias_primary's numeric, or "-"
}

export interface BouncerFace {
  index: number;
  peer: string;        // legacy peer's YY (2-char server numeric)
  face: string;        // recorded face's full YYXXX
}

export interface CheckBouncerState {
  primary?: BouncerPrimary;
  aliases: BouncerAlias[];
  faces: BouncerFace[];
  rawLines: string[];
}

/**
 * Parse a single /CHECK RPL_DATASTR (290) line content into a typed entry,
 * or null if the line doesn't match any known BouncerXxx prefix.
 */
export function parseCheckBouncerLine(content: string):
  | { kind: 'primary'; value: BouncerPrimary }
  | { kind: 'alias'; value: BouncerAlias }
  | { kind: 'face'; value: BouncerFace }
  | null
{
  // BouncerPrimary:: <numeric> <nick> <lastnick> <sessid> <server> <locality>
  const primMatch = content.match(
    /^BouncerPrimary::\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(local|remote)\s*$/
  );
  if (primMatch) {
    return {
      kind: 'primary',
      value: {
        numeric: primMatch[1],
        nick: primMatch[2],
        lastnick: Number(primMatch[3]),
        sessid: primMatch[4],
        server: primMatch[5],
        locality: primMatch[6] as 'local' | 'remote',
      },
    };
  }

  // BouncerAlias:: <idx> <numeric> <nick> <lastnick> <sessid> <server> <locality> <primary>
  const aliasMatch = content.match(
    /^BouncerAlias::\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(local|remote)\s+(\S+)\s*$/
  );
  if (aliasMatch) {
    return {
      kind: 'alias',
      value: {
        index: Number(aliasMatch[1]),
        numeric: aliasMatch[2],
        nick: aliasMatch[3],
        lastnick: Number(aliasMatch[4]),
        sessid: aliasMatch[5],
        server: aliasMatch[6],
        locality: aliasMatch[7] as 'local' | 'remote',
        primaryNumeric: aliasMatch[8],
      },
    };
  }

  // BouncerFace:: <idx> <peer> <face>
  const faceMatch = content.match(
    /^BouncerFace::\s+(\d+)\s+(\S+)\s+(\S+)\s*$/
  );
  if (faceMatch) {
    return {
      kind: 'face',
      value: {
        index: Number(faceMatch[1]),
        peer: faceMatch[2],
        face: faceMatch[3],
      },
    };
  }

  return null;
}

/**
 * Parse a sequence of /CHECK RPL_DATASTR messages into a structured
 * snapshot.  Only the BouncerPrimary / BouncerAlias / BouncerFace lines
 * are consumed; everything else is preserved in rawLines.
 */
export function parseCheckBouncerOutput(messages: IRCMessage[]): CheckBouncerState {
  const state: CheckBouncerState = {
    aliases: [],
    faces: [],
    rawLines: [],
  };

  for (const msg of messages) {
    // RPL_DATASTR (290) format: <server> 290 <target> :<content>
    if (msg.command !== '290') continue;
    const content = msg.params[msg.params.length - 1] ?? '';
    state.rawLines.push(content);

    const parsed = parseCheckBouncerLine(content);
    if (!parsed) continue;

    switch (parsed.kind) {
      case 'primary':
        state.primary = parsed.value;
        break;
      case 'alias':
        state.aliases.push(parsed.value);
        break;
      case 'face':
        state.faces.push(parsed.value);
        break;
    }
  }

  return state;
}

/**
 * Drive `/CHECK <nick> -b` on a connected oper client and return the
 * parsed bouncer state.  Collects every line from the response until
 * RPL_ENDOFCHECK (291) lands, then parses the 290 RPL_DATASTR entries.
 *
 * Caller must already be opered (PRIV_CHECK).  Times out if no
 * RPL_ENDOFCHECK arrives within `timeoutMs` (default 5s).
 *
 * Example:
 *   const state = await runCheck(operClient, 'ibutsu');
 *   expect(state.primary?.nick).toBe('ibutsu');
 *   expect(state.aliases).toHaveLength(1);
 */
export async function runCheck(
  client: RawSocketClient,
  nick: string,
  timeoutMs = 5000
): Promise<CheckBouncerState> {
  const messages: IRCMessage[] = [];
  const startIdx = (client as unknown as { lines: unknown[] }).lines.length;

  // Subscribe to incoming lines and parse them into IRCMessage form.
  // We tap into the listener list directly so we don't depend on the
  // batch mechanism (RPL_DATASTR isn't batched at this level).
  const listener = (line: string) => {
    if (!line) return;
    try {
      messages.push(parseIRCMessage(line));
    } catch {
      // Ignore malformed lines; /CHECK output is well-formed.
    }
  };
  const listeners = (client as unknown as {
    lineListeners: Array<(l: string, i: number) => void>;
  }).lineListeners;
  listeners.push(listener);

  try {
    // Backfill from any lines already in the buffer (defensive — usually
    // no /CHECK reply pending before we send).
    const buffered = (client as unknown as { lines: { raw: string }[] }).lines;
    for (let i = startIdx; i < buffered.length; i++) {
      listener(buffered[i].raw);
    }

    client.send(`CHECK ${nick} -b`);

    // Wait for RPL_ENDOFCHECK (291) OR ERR_SEARCHNOMATCH (292).
    // The latter means the nick isn't on this server / network — caller
    // gets an explicit error instead of an opaque timeout.
    const terminator = await client.waitForLine(/\s29[12]\s/, timeoutMs);
    if (/\s292\s/.test(terminator)) {
      throw new Error(`runCheck: /CHECK ${nick} returned ERR_SEARCHNOMATCH `
        + `(292 — target not found).  Raw: ${terminator}`);
    }
  } finally {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  }

  return parseCheckBouncerOutput(messages);
}
