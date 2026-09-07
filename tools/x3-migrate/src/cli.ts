#!/usr/bin/env -S npx tsx
// x3-migrate CLI. See README.md.
//
// Usage:
//   census  (--db <mondo-file> | --section Name=<file> [--section ...]) [--ldif <file>] [--json <out>]
//   convert (--db ... | --section ...) --kc-users <file.json> [--json <out>]
//   residual | bans   (reserved stubs; not implemented)
//
// Exit codes for `census`: 0 clean (GO), 2 anomalies (NO-GO), 1 parse/usage failure.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseDb, RecdbParseError, ParseResult, ParseDiagnostic } from './recdb/parse.js';
import { robj, ogetObj } from './recdb/model.js';
import { parseLdif, ldapAccounts } from './ldif.js';
import { buildReport, renderReport } from './census/report.js';
import { convertAccounts, type KeycloakUser } from './convert/accounts.js';

const USAGE = `Usage:
  census (--db <mondo-file> | --section Name=<file> [--section Name=<file> ...]) [--ldif <file>] [--json <out>]
  convert (--db <mondo-file> | --section Name=<file> ...) --kc-users <file.json> [--json <out>]
          <file.json> is a Keycloak admin-REST user enumeration (array of
          {id, username, email?, attributes?}), taken AFTER a full federation
          sync so every directory user is present. Consuming a dump rather than
          querying live keeps the conversion deterministic and re-runnable,
          which the idempotence requirement (§4.5) depends on.
  residual  (not implemented)
  bans      (not implemented)
`;

interface ParsedArgs {
  db?: string;
  sections: { name: string; file: string }[];
  ldif?: string;
  json?: string;
  kcUsers?: string;
}

function parseArgs(argv: string[]): ParsedArgs | undefined {
  const out: ParsedArgs = { sections: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') {
      const v = argv[++i];
      if (v === undefined) return undefined;
      out.db = v;
    } else if (arg === '--section') {
      const v = argv[++i];
      if (v === undefined) return undefined;
      const eq = v.indexOf('=');
      if (eq <= 0) return undefined;
      out.sections.push({ name: v.slice(0, eq), file: v.slice(eq + 1) });
    } else if (arg === '--ldif') {
      const v = argv[++i];
      if (v === undefined) return undefined;
      out.ldif = v;
    } else if (arg === '--kc-users') {
      const v = argv[++i];
      if (v === undefined) return undefined;
      out.kcUsers = v;
    } else if (arg === '--json') {
      const v = argv[++i];
      if (v === undefined) return undefined;
      out.json = v;
    } else {
      return undefined;
    }
  }
  return out;
}

function readFileOrFail(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e: any) {
    console.log(`Cannot read file "${path}": ${e.message ?? e}`);
    return undefined;
  }
}

/** Load the db per --db / --section. Returns undefined after printing the reason. */
function loadDb(args: ParsedArgs): ParseResult | undefined {
  let parse: ParseResult;
  try {
    if (args.db !== undefined) {
      const text = readFileOrFail(args.db);
      if (text === undefined) return undefined;
      parse = parseDb(text);
    } else {
      const mergedDiagnostics: ParseDiagnostic[] = [];
      const pairs: [string, ReturnType<typeof parseDb>['root']][] = [];
      for (const { name, file } of args.sections) {
        const text = readFileOrFail(file);
        if (text === undefined) return undefined;
        const sub = parseDb(text);
        mergedDiagnostics.push(...sub.diagnostics);
        pairs.push([name, sub.root]);
      }
      parse = { root: robj(pairs), diagnostics: mergedDiagnostics };
    }
  } catch (e) {
    if (e instanceof RecdbParseError) {
      console.log(`Parse error: ${e.message}`);
      return undefined;
    }
    throw e;
  }
  return parse;
}

function checkDbArgs(args: ParsedArgs): boolean {
  if ((args.db === undefined) === (args.sections.length === 0)) {
    // Exactly one of --db / --section must be given: both absent, or both present, is a usage error.
    console.log('Exactly one of --db or --section (one or more) is required.\n' + USAGE);
    return false;
  }
  return true;
}

function runCensus(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args) {
    console.log(USAGE);
    return 1;
  }
  if (!checkDbArgs(args)) return 1;
  const parse = loadDb(args);
  if (parse === undefined) return 1;

  let ldap = null;
  if (args.ldif !== undefined) {
    const text = readFileOrFail(args.ldif);
    if (text === undefined) return 1;
    ldap = ldapAccounts(parseLdif(text));
  }

  const report = buildReport(parse, ldap, Math.floor(Date.now() / 1000));
  console.log(renderReport(report));

  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify(report, null, 2));
  }

  return report.clean ? 0 : 2;
}

/**
 * Read a Keycloak admin-REST user listing. Accepts the endpoint's own shape:
 * an array of user representations, LDAP_ID lifted out of `attributes`.
 */
function readKcUsers(path: string): KeycloakUser[] | undefined {
  const text = readFileOrFail(path);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.log(`${path}: not valid JSON (${(e as Error).message})`);
    return undefined;
  }
  if (!Array.isArray(raw)) {
    console.log(`${path}: expected a JSON array of Keycloak user representations`);
    return undefined;
  }
  const out: KeycloakUser[] = [];
  for (const [i, u] of raw.entries()) {
    const o = u as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : undefined;
    const username = typeof o.username === 'string' ? o.username : undefined;
    if (!id || !username) {
      console.log(`${path}: entry ${i} is missing id or username`);
      return undefined;
    }
    const attrs = (o.attributes ?? {}) as Record<string, unknown>;
    const ldapIdVal = attrs.LDAP_ID;
    out.push({
      id,
      username,
      email: typeof o.email === 'string' ? o.email : undefined,
      ldapId: Array.isArray(ldapIdVal) ? String(ldapIdVal[0]) : undefined,
    });
  }
  return out;
}

function runConvert(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args) {
    console.log(USAGE);
    return 1;
  }
  if (!checkDbArgs(args)) return 1;
  if (args.kcUsers === undefined) {
    console.log('convert requires --kc-users <file.json>.\n' + USAGE);
    return 1;
  }

  const parse = loadDb(args);
  if (parse === undefined) return 1;
  const kcUsers = readKcUsers(args.kcUsers);
  if (kcUsers === undefined) return 1;

  const nickserv = ogetObj(parse.root, 'NickServ');
  if (!nickserv) {
    console.log('No NickServ section found — nothing to convert.');
    return 1;
  }
  const chanserv = ogetObj(parse.root, 'ChanServ') ?? null;

  const result = convertAccounts(nickserv, kcUsers, { chanserv });

  const lines: string[] = [];
  lines.push('=== Converter part A — account authority ===');
  lines.push(`  accounts converted : ${result.accounts.length}`);
  lines.push(`  quarantined        : ${result.quarantined.length}`);
  lines.push(`  keycloak-only      : ${result.keycloakOnly.length}`);
  lines.push(`  anomalies          : ${result.anomalies.length}`);

  if (result.quarantined.length > 0) {
    lines.push('');
    lines.push('  Quarantined (NOT converted — each needs a decision before the window opens):');
    for (const q of result.quarantined) {
      const marks = [
        q.hasChannelAccess ? 'HOLDS CHANNEL ACCESS' : undefined,
        q.opservLevel > 0 ? `opserv_level=${q.opservLevel}` : undefined,
      ].filter(Boolean);
      lines.push(
        `    ${q.handle} [${q.reason}]` +
          (marks.length ? ` — ${marks.join(', ')}` : '') +
          (q.detail ? ` (${q.detail})` : ''),
      );
    }
  }
  if (result.keycloakOnly.length > 0) {
    lines.push('');
    lines.push('  Keycloak users with no X3 handle:');
    for (const n of result.keycloakOnly) lines.push(`    ${n}`);
  }
  if (result.anomalies.length > 0) {
    lines.push('');
    lines.push('  Anomalies:');
    for (const a of result.anomalies) lines.push(`    ${a}`);
  }

  const clean = result.quarantined.length === 0 && result.anomalies.length === 0;
  lines.push('');
  lines.push(
    clean
      ? '  GO — every account mapped to a Keycloak identity.'
      : '  NO-GO — resolve every entry above, or record it on the written drop list.',
  );
  console.log(lines.join('\n'));

  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify(result, null, 2));
  }
  return clean ? 0 : 2;
}

function main(): number {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'census':
      return runCensus(rest);
    case 'convert':
      return runConvert(rest);
    case 'residual':
    case 'bans': {
      // Phase mapping per x3-merge-sequencing.md §3: convert = converter part A
      // (Phase 1, account authority); bans = part B's persistent-ban slice
      // (Phase 2, channel authority); residual = converter part C, the trimmed
      // x3.db for the demoted residual X3 (Phase 3).
      const phase = sub === 'bans' ? 2 : 3;
      console.log(`${sub}: not implemented (X3-merge phase ${phase} deliverable)`);
      return 1;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

process.exitCode = main();
