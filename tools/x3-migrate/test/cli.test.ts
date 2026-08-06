import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const run = (args: string[]) => {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: e.status as number, stdout: String(e.stdout ?? '') };
  }
};

const dir = mkdtempSync(join(tmpdir(), 'x3migrate-'));
const CLEAN_DB = join(dir, 'clean.db');
const DIRTY_DB = join(dir, 'dirty.db');
const BAD_DB = join(dir, 'bad.db');
const LDIF = join(dir, 'x.ldif');
const SECTION_GOOD = join(dir, 'section-good.db');
const SECTION_BAD = join(dir, 'section-bad.db');
const SECTION_DUP = join(dir, 'section-dup.db');
writeFileSync(CLEAN_DB, '"NickServ" { "u1" { "passwd" "0123456789abcdef0123456789abcdef"; }; };\n');
writeFileSync(DIRTY_DB, '"NickServ" { "u1" { "passwd" "junk"; }; };\n');
writeFileSync(BAD_DB, '"NickServ" { broken\n');
writeFileSync(LDIF, 'dn: uid=u1,ou=u,dc=x\nuid: u1\nuserPassword: {SSHA}h\n');
writeFileSync(SECTION_GOOD, '"u1" { "passwd" "0123456789abcdef0123456789abcdef"; };\n');
writeFileSync(SECTION_BAD, '"u2" { broken\n');
writeFileSync(SECTION_DUP, '"u1" { "passwd" "0123456789abcdef0123456789abcdef"; }; "u1" { "passwd" "0123456789abcdef0123456789abcdef"; };\n');

describe('census subcommand', () => {
  it('exit 0 and GO on a clean db+ldif', () => {
    const r = run(['census', '--db', CLEAN_DB, '--ldif', LDIF]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('GO');
  });
  it('exit 2 on anomalies', () => {
    const r = run(['census', '--db', DIRTY_DB]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('NO-GO');
  });
  it('exit 1 with location on a parse failure', () => {
    const r = run(['census', '--db', BAD_DB]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/line|:\d+/i);
  });
  it('writes the JSON report when asked', () => {
    const out = join(dir, 'r.json');
    run(['census', '--db', CLEAN_DB, '--ldif', LDIF, '--json', out]);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    expect(j.accounts.total).toBe(1);
    expect(j.clean).toBe(true);
  });
  it('exit 1 on usage errors', () => {
    expect(run(['census']).code).toBe(1);
    expect(run(['frobnicate']).code).toBe(1);
    expect(run(['census', '--db', CLEAN_DB, '--section', 'X=' + CLEAN_DB]).code).toBe(1); // mutually exclusive
  });
  it('accepts per-module files via --section', () => {
    const NS = join(dir, 'nickserv.db');
    writeFileSync(NS, '"u1" { "passwd" "0123456789abcdef0123456789abcdef"; };\n');
    const r = run(['census', '--section', 'NickServ=' + NS, '--ldif', LDIF]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('GO');
  });
  it('a parse failure in the SECOND --section file exits 1 with location', () => {
    const r = run(['census', '--section', 'NickServ=' + SECTION_GOOD, '--section', 'ChanServ=' + SECTION_BAD]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/line|:\d+/i);
  });
  it('a per-file parser diagnostic survives the --section merge into anomalies', () => {
    const out = join(dir, 'dup.json');
    const r = run(['census', '--section', 'NickServ=' + SECTION_DUP, '--json', out]);
    expect(r.code).toBe(2);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    expect(j.anomalies.some((a: string) => a.includes('duplicate-key'))).toBe(true);
  });
});

describe('reserved subcommands', () => {
  for (const sub of ['convert', 'residual', 'bans']) {
    it(`${sub} states it is not implemented`, () => {
      const r = run([sub]);
      expect(r.code).toBe(1);
      expect(r.stdout.toLowerCase()).toContain('not implemented');
    });
  }
});
