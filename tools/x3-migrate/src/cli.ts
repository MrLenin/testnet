#!/usr/bin/env -S npx tsx
// x3-migrate CLI. See README.md.
//
// Usage:
//   census (--db <mondo-file> | --section Name=<file> [--section ...]) [--ldif <file>] [--json <out>]
//   convert | residual | bans   (reserved stubs; not implemented)
//
// Exit codes for `census`: 0 clean (GO), 2 anomalies (NO-GO), 1 parse/usage failure.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseDb, RecdbParseError, ParseResult, ParseDiagnostic } from './recdb/parse.js';
import { robj } from './recdb/model.js';
import { parseLdif, ldapAccounts } from './ldif.js';
import { buildReport, renderReport } from './census/report.js';

const USAGE = `Usage:
  census (--db <mondo-file> | --section Name=<file> [--section Name=<file> ...]) [--ldif <file>] [--json <out>]
  convert   (not implemented)
  residual  (not implemented)
  bans      (not implemented)
`;

interface ParsedArgs {
  db?: string;
  sections: { name: string; file: string }[];
  ldif?: string;
  json?: string;
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

function runCensus(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args) {
    console.log(USAGE);
    return 1;
  }
  if ((args.db === undefined) === (args.sections.length === 0)) {
    // Exactly one of --db / --section must be given: both absent, or both present, is a usage error.
    console.log('Exactly one of --db or --section (one or more) is required.\n' + USAGE);
    return 1;
  }

  let parse: ParseResult;
  try {
    if (args.db !== undefined) {
      const text = readFileOrFail(args.db);
      if (text === undefined) return 1;
      parse = parseDb(text);
    } else {
      const mergedDiagnostics: ParseDiagnostic[] = [];
      const pairs: [string, ReturnType<typeof parseDb>['root']][] = [];
      for (const { name, file } of args.sections) {
        const text = readFileOrFail(file);
        if (text === undefined) return 1;
        const sub = parseDb(text);
        mergedDiagnostics.push(...sub.diagnostics);
        pairs.push([name, sub.root]);
      }
      parse = { root: robj(pairs), diagnostics: mergedDiagnostics };
    }
  } catch (e) {
    if (e instanceof RecdbParseError) {
      console.log(`Parse error: ${e.message}`);
      return 1;
    }
    throw e;
  }

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

function main(): number {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'census':
      return runCensus(rest);
    case 'convert':
    case 'residual':
    case 'bans': {
      // Phase mapping per x3-merge-sequencing.md §3: convert = converter part A
      // (Phase 1, account authority); bans = part B's persistent-ban slice
      // (Phase 2, channel authority); residual = converter part C, the trimmed
      // x3.db for the demoted residual X3 (Phase 3).
      const phase = sub === 'convert' ? 1 : sub === 'bans' ? 2 : 3;
      console.log(`${sub}: not implemented (X3-merge phase ${phase} deliverable)`);
      return 1;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

process.exitCode = main();
