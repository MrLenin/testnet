import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDb } from '../src/recdb/parse.js';
import { parseLdif, ldapAccounts } from '../src/ldif.js';
import { classifyHash, activityBucket, classifyAccounts } from '../src/census/classify.js';
import { buildReport, renderReport } from '../src/census/report.js';
import { ogetObj } from '../src/recdb/model.js';

const FIXTURE = readFileSync(new URL('./fixtures/bedlike.x3db', import.meta.url), 'utf8');
const NOW = 1700000000; // matches fixture epochs

describe('classifyHash', () => {
  it('plain lowercase 32-hex', () =>
    expect(classifyHash('0123456789abcdef0123456789abcdef').format).toBe('plain-md5'));
  it('uppercase plain hash is a flagged anomaly', () => {
    const r = classifyHash('0123456789ABCDEF0123456789ABCDEF');
    expect(r.format).toBe('malformed');
    expect(r.anomalies).toContain('plain-hash-uppercase');
  });
  it('seeded $ + 8hex + 32hex', () =>
    expect(classifyHash('$a1b2c3d4FEDCBA9876543210FEDCBA9876543210').format).toBe('seeded'));
  it('seeded with lowercase digest flagged', () => {
    const r = classifyHash('$a1b2c3d4fedcba9876543210fedcba9876543210');
    expect(r.format).toBe('seeded');
    expect(r.anomalies).toContain('seeded-hash-lowercase');
  });
  it('garbage is malformed; absent is absent', () => {
    expect(classifyHash('not-a-hash').format).toBe('malformed');
    expect(classifyHash(undefined).format).toBe('absent');
    expect(classifyHash('').format).toBe('absent');
  });
});

describe('activityBucket', () => {
  it('buckets by age', () => {
    expect(activityBucket(String(NOW - 86400 * 10), NOW)).toBe('<30d');
    expect(activityBucket(String(NOW - 86400 * 100), NOW)).toBe('<180d');
    expect(activityBucket(String(NOW - 86400 * 300), NOW)).toBe('<1y');
    expect(activityBucket(String(NOW - 86400 * 1000), NOW)).toBe('<5y');
    expect(activityBucket(String(NOW - 86400 * 3000), NOW)).toBe('older');
    expect(activityBucket('bogus', NOW)).toBe('unknown');
    expect(activityBucket(undefined, NOW)).toBe('unknown');
  });
});

describe('classifyAccounts (fixture world)', () => {
  const ns = ogetObj(parseDb(FIXTURE).root, 'NickServ')!;
  it('with an LDIF: four-way split', () => {
    const ldap = ldapAccounts(parseLdif(
      'dn: uid=alice,ou=users,dc=x\nuid: alice\nuserPassword: {SSHA}h\n\n' +
      'dn: uid=zoe,ou=users,dc=x\nuid: zoe\nuserPassword: {SSHA}h\n'));
    const { accounts: c } = classifyAccounts(ns, ldap, NOW);
    const by = Object.fromEntries(c.map(a => [a.handle, a]));
    expect(by['alice']!.credState).toBe('both');            // hash + LDAP
    expect(by['bob']!.credState).toBe('local-hash-only');
    expect(by['carol[away]']!.credState).toBe('local-hash-only'); // malformed still counts as local cred material
  });
  it('without an LDIF: two-way split only', () => {
    const { accounts: c } = classifyAccounts(ns, null, NOW);
    expect(new Set(c.map(a => a.credState))).toEqual(new Set(['local-hash-only']));
  });
  it('a non-object NickServ entry is surfaced as an anomaly, not silently skipped, and is not counted', () => {
    const db = parseDb('"NickServ" { "bob" ("list", "not", "object"); "alice" { "passwd" "0123456789abcdef0123456789abcdef"; }; };');
    const world = ogetObj(db.root, 'NickServ')!;
    const { accounts, anomalies } = classifyAccounts(world, null, NOW);
    expect(accounts.map(a => a.handle)).toEqual(['alice']);
    expect(anomalies).toContain('NickServ: record "bob" is a list, not an object — not counted');
  });
});

describe('buildReport (fixture world)', () => {
  const parse = parseDb(FIXTURE);
  const r = buildReport(parse, null, NOW);
  it('counts sections including unmodeled ones', () => {
    expect(r.sections['NickServ']).toBe(3);
    expect(r.sections['gline']).toBe(0);
    expect(r.sections['modcmd']).toBe(1);
    expect(r.sections['ChanServ']).toBe(2); // top-level: version_control + channels
  });
  it('counts chanserv entities (descending through the real "channels" key)', () => {
    expect(r.chanserv).toEqual({ channels: 1, userRecords: 3, banRecords: 1 });
  });
  it('does not fall back to a flat scan when "channels" is absent', () => {
    const noChannelsKey = parseDb('"ChanServ" { "version_control" { "version_number" "2"; }; "note_types" { }; };');
    const r3 = buildReport(noChannelsKey, null, NOW);
    expect(r3.chanserv).toEqual({ channels: 0, userRecords: 0, banRecords: 0 });
  });
  it('finds the dangling users-key ref', () => {
    expect(r.danglingRefs).toContainEqual({ kind: 'users-key', channel: '#test', name: 'ghost' });
  });
  it('matches registrar refs case-insensitively (no false dangling)', () => {
    // fixture's #test carries "registrar" "alice", which resolves against the
    // "alice" handle — chanserv.c never writes a channel-level "owner".
    expect(r.danglingRefs.filter(d => d.kind === 'registrar')).toHaveLength(0);
  });
  it('finds a dangling registrar ref', () => {
    const db = parseDb(
      '"NickServ" { "alice" { "passwd" "0123456789abcdef0123456789abcdef"; }; };' +
      '"ChanServ" { "channels" { "#orphan" { "registrar" "nosuchhandle"; }; }; };',
    );
    const r2 = buildReport(db, null, NOW);
    expect(r2.danglingRefs).toContainEqual({ kind: 'registrar', channel: '#orphan', name: 'nosuchhandle' });
    expect(r2.clean).toBe(false);
  });
  it('is not clean (dangling ref + malformed hash present)', () => {
    expect(r.clean).toBe(false);
    expect(r.anomalies.some(a => a.includes('carol[away]'))).toBe(true);
  });
  it('reports ldap-only uids when an LDIF is supplied', () => {
    const ldap = ldapAccounts(parseLdif('dn: uid=zoe,ou=u,dc=x\nuid: zoe\n'));
    const r2 = buildReport(parse, ldap, NOW);
    expect(r2.danglingRefs).toContainEqual({ kind: 'ldap-only-uid', name: 'zoe' });
  });
  it('renders a readable report with the go/no-go headline', () => {
    const text = renderReport(r);
    expect(text).toMatch(/NO-GO|GO/);
    expect(text).toContain('local-hash-only');
  });
});

describe('non-object records are surfaced, never silently dropped (zero-unexplained-records rule)', () => {
  it('a non-object NickServ record is an anomaly and is not counted as an account', () => {
    const db = parseDb('"NickServ" { "bob" ("a", "list"); "alice" { "passwd" "0123456789abcdef0123456789abcdef"; }; };');
    const r = buildReport(db, null, NOW);
    expect(r.anomalies).toContain('NickServ: record "bob" is a list, not an object — not counted');
    expect(r.accounts.total).toBe(1);
    expect(r.clean).toBe(false);
  });
  it('a non-object ChanServ.channels record is an anomaly and is not counted as a channel', () => {
    const db = parseDb('"ChanServ" { "channels" { "#ghost" "a string, not an object"; }; };');
    const r = buildReport(db, null, NOW);
    expect(r.anomalies).toContain('ChanServ.channels: record "#ghost" is a string, not an object — not counted');
    expect(r.chanserv.channels).toBe(0);
    expect(r.clean).toBe(false);
  });
  it('a non-object ban record is an anomaly and is not counted as a ban', () => {
    const db = parseDb('"ChanServ" { "channels" { "#test" { "bans" { "*!*@x" ("not", "an", "object"); }; }; }; };');
    const r = buildReport(db, null, NOW);
    expect(r.anomalies).toContain('ChanServ.channels.#test.bans: record "*!*@x" is a list, not an object — not counted');
    expect(r.chanserv.banRecords).toBe(0);
    expect(r.clean).toBe(false);
  });
  it('a non-object users VALUE is still counted as a user record but flagged as an anomaly', () => {
    const db = parseDb('"ChanServ" { "channels" { "#test" { "users" { "someone" "not-an-object"; }; }; }; };');
    const r = buildReport(db, null, NOW);
    expect(r.anomalies).toContain('ChanServ.channels.#test.users: record "someone" is a string, not an object — counted as a user record');
    expect(r.chanserv.userRecords).toBe(1); // keys still count regardless of value kind
    expect(r.clean).toBe(false);
  });
});

describe('a clean world is clean', () => {
  it('clean db + matching ldif => clean report, GO headline', () => {
    const db = parseDb('"NickServ" { "u1" { "passwd" "0123456789abcdef0123456789abcdef"; "lastseen" "' + String(NOW - 1000) + '"; }; };');
    const ldap = ldapAccounts(parseLdif('dn: uid=u1,ou=u,dc=x\nuid: u1\nuserPassword: {SSHA}h\n'));
    const r = buildReport(db, ldap, NOW);
    expect(r.clean).toBe(true);
    expect(renderReport(r)).toContain('GO');
  });
});
