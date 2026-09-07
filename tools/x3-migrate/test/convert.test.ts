import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDb } from '../src/recdb/parse.js';
import { ogetObj } from '../src/recdb/model.js';
import { accountsWithChannelAccess, convertAccounts, type KeycloakUser } from '../src/convert/accounts.js';

const FIXTURE = readFileSync(new URL('./fixtures/bedlike.x3db', import.meta.url), 'utf8');

function sections() {
  const { root } = parseDb(FIXTURE);
  const ns = ogetObj(root, 'NickServ');
  const cs = ogetObj(root, 'ChanServ');
  if (!ns) throw new Error('fixture has no NickServ section');
  return { nickserv: ns, chanserv: cs ?? null };
}

/** Keycloak enumeration standing in for a post-sync admin-REST listing. */
const kc = (username: string, id: string, extra: Partial<KeycloakUser> = {}): KeycloakUser => ({
  id,
  username,
  ...extra,
});

describe('accountsWithChannelAccess', () => {
  it('folds every account holding a channel user record', () => {
    const { chanserv } = sections();
    const held = accountsWithChannelAccess(chanserv);
    // fixture #test grants alice/BOB/ghost; matching is case-insensitive
    expect(held.has('alice')).toBe(true);
    expect(held.has('bob')).toBe(true);
    expect(held.has('ghost')).toBe(true);
    expect(held.has('nobody')).toBe(false);
  });

  it('returns an empty set when there is no ChanServ section', () => {
    expect(accountsWithChannelAccess(null).size).toBe(0);
  });
});

describe('convertAccounts', () => {
  it('keys the acct row on the Keycloak subject UUID, not the name or entryUUID', () => {
    const { nickserv, chanserv } = sections();
    const r = convertAccounts(nickserv, [kc('alice', 'kc-alice-uuid', { ldapId: 'entry-uuid-alice' })], { chanserv });
    const alice = r.accounts.find(a => a.name === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.uuid).toBe('kc-alice-uuid');
  });

  it('carries registered through byte-identically from saxdb', () => {
    const { nickserv } = sections();
    // whatever the fixture says for alice must survive verbatim
    const r = convertAccounts(nickserv, [kc('alice', 'u1')], {});
    const alice = r.accounts.find(a => a.name === 'alice')!;
    expect(Number.isInteger(alice.registeredTs)).toBe(true);
    expect(String(alice.registeredTs)).toBe(alice.registeredRaw);
  });

  it('matches names case-insensitively via IRC folding', () => {
    const { nickserv } = sections();
    // fixture stores BOB uppercase; Keycloak stores it lowercase
    const r = convertAccounts(nickserv, [kc('bob', 'kc-bob')], {});
    expect(r.accounts.find(a => a.uuid === 'kc-bob')).toBeDefined();
    expect(r.quarantined.find(q => q.handle.toLowerCase() === 'bob')).toBeUndefined();
  });

  it('quarantines an x3 handle with no Keycloak user instead of dropping it', () => {
    const { nickserv, chanserv } = sections();
    const r = convertAccounts(nickserv, [], { chanserv });
    expect(r.accounts).toHaveLength(0);
    expect(r.quarantined.length).toBeGreaterThan(0);
    for (const q of r.quarantined) expect(q.reason).toBe('no-keycloak-user');
  });

  it('reports whether a quarantined account holds channel access', () => {
    const { nickserv, chanserv } = sections();
    const r = convertAccounts(nickserv, [], { chanserv });
    const alice = r.quarantined.find(q => q.handle.toLowerCase() === 'alice');
    expect(alice?.hasChannelAccess).toBe(true);
  });

  it('surfaces Keycloak users with no x3 handle rather than ignoring them', () => {
    const { nickserv } = sections();
    const r = convertAccounts(nickserv, [kc('stranger', 'kc-stranger')], {});
    expect(r.keycloakOnly).toContain('stranger');
  });

  it('quarantines rather than guesses when two Keycloak users fold to one name', () => {
    const { nickserv } = sections();
    const r = convertAccounts(nickserv, [kc('alice', 'kc-1'), kc('ALICE', 'kc-2')], {});
    const q = r.quarantined.find(x => x.handle.toLowerCase() === 'alice');
    expect(q?.reason).toBe('duplicate-keycloak-match');
    expect(r.accounts.find(a => a.name === 'alice')).toBeUndefined();
  });

  it('builds a unique name -> uuid secondary index over converted accounts only', () => {
    const { nickserv } = sections();
    const r = convertAccounts(nickserv, [kc('alice', 'kc-alice')], {});
    expect(r.byName).toEqual([{ name: 'alice', uuid: 'kc-alice' }]);
  });

  it('surfaces a non-object NickServ record as an anomaly and does not convert it', () => {
    const { root } = parseDb('"NickServ" {\n"junk" "notanobject";\n};\n');
    const ns = ogetObj(root, 'NickServ')!;
    const r = convertAccounts(ns, [kc('junk', 'kc-junk')], {});
    expect(r.accounts).toHaveLength(0);
    expect(r.anomalies.join(' ')).toMatch(/junk/);
  });

  it('defaults a missing opserv level to 0 and preserves a present one', () => {
    const { root } = parseDb(
      '"NickServ" {\n' +
        '"noop" { "passwd" "x"; "register" "100"; };\n' +
        '"admin" { "passwd" "x"; "register" "100"; "opserv_level" "1000"; };\n' +
        '};\n',
    );
    const ns = ogetObj(root, 'NickServ')!;
    const r = convertAccounts(ns, [kc('noop', 'u-noop'), kc('admin', 'u-admin')], {});
    expect(r.accounts.find(a => a.name === 'noop')!.opservLevel).toBe(0);
    expect(r.accounts.find(a => a.name === 'admin')!.opservLevel).toBe(1000);
  });

  it('flags an unparsable registered timestamp rather than silently zeroing it', () => {
    const { root } = parseDb('"NickServ" {\n"bad" { "passwd" "x"; "register" "notanumber"; };\n};\n');
    const ns = ogetObj(root, 'NickServ')!;
    const r = convertAccounts(ns, [kc('bad', 'u-bad')], {});
    expect(r.anomalies.join(' ')).toMatch(/bad/);
    expect(r.quarantined.find(q => q.handle === 'bad')?.reason).toBe('malformed-record');
  });
});
