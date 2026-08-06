import { describe, it, expect } from 'vitest';
import { parseLdif, ldapAccounts } from '../src/ldif.js';

const SAMPLE = [
  'dn: uid=alice,ou=users,dc=example,dc=net',
  'objectClass: inetOrgAnonAccount',
  'uid: alice',
  'userPassword:: e1NTSEF9c2VjcmV0aGFzaA==',        // base64 of {SSHA}secrethash
  'createTimestamp: 20260101000000Z',
  '',
  '# a comment line',
  'dn: uid=bob,ou=users,dc=example,dc=net',
  'objectClass: inetOrgAnonAccount',
  'uid: bob',
  'userPassword: {SMD5}abcdef',
  'description: folded va',
  ' lue continues',
  '',
  'dn: cn=notauser,dc=example,dc=net',
  'cn: notauser',
  '',
].join('\n');

describe('parseLdif', () => {
  it('splits entries on blank lines and skips comments', () => {
    expect(parseLdif(SAMPLE)).toHaveLength(3);
  });
  it('decodes base64 (::) values', () => {
    const alice = parseLdif(SAMPLE)[0]!;
    expect(alice.attrs.get('userpassword')).toEqual(['{SSHA}secrethash']);
  });
  it('unfolds continuation lines', () => {
    const bob = parseLdif(SAMPLE)[1]!;
    expect(bob.attrs.get('description')).toEqual(['folded value continues']);
  });
  it('collects multi-valued attributes', () => {
    const e = parseLdif('dn: x\na: 1\na: 2\n')[0]!;
    expect(e.attrs.get('a')).toEqual(['1', '2']);
  });
  it('preserves dn-only entries with empty attrs', () => {
    const entries = parseLdif([
      'dn: uid=first,dc=example,dc=net',
      'uid: first',
      '',
      'dn: cn=onlydn,dc=example,dc=net',
      '',
      'dn: uid=third,dc=example,dc=net',
      'uid: third',
      '',
    ].join('\n'));
    expect(entries).toHaveLength(3);
    expect(entries[1]!.dn).toBe('cn=onlydn,dc=example,dc=net');
    expect(entries[1]!.attrs.size).toBe(0);
  });
  it('unfolds folded base64 values by concatenating continuation lines', () => {
    const entries = parseLdif([
      'dn: x',
      'data:: Zm9v',
      ' YmFy',
      '',
    ].join('\n'));
    // "Zm9v" + "YmFy" = "Zm9vYmFy" which decodes to "foobar"
    expect(entries[0]!.attrs.get('data')).toEqual(['foobar']);
  });
  it('decodes base64 DN (dn::)', () => {
    // "uid=alice,dc=example" in base64
    const b64Dn = Buffer.from('uid=alice,dc=example').toString('base64');
    const entries = parseLdif(`dn:: ${b64Dn}\nuid: alice\n`);
    expect(entries[0]!.dn).toBe('uid=alice,dc=example');
  });
});

describe('ldapAccounts', () => {
  const accts = ldapAccounts(parseLdif(SAMPLE));
  it('keeps only uid-bearing entries', () => {
    expect(accts.map(a => a.uid)).toEqual(['alice', 'bob']);
  });
  it('parses password schemes', () => {
    expect(accts[0]!.passwords).toEqual([{ scheme: 'SSHA', raw: '{SSHA}secrethash' }]);
    expect(accts[1]!.passwords[0]!.scheme).toBe('SMD5');
  });
  it('handles unprefixed passwords as scheme ""', () => {
    const a = ldapAccounts(parseLdif('dn: x\nuid: y\nuserPassword: plainhash\n'))[0]!;
    expect(a.passwords).toEqual([{ scheme: '', raw: 'plainhash' }]);
  });
  it('carries timestamps when present', () => {
    expect(accts[0]!.createTimestamp).toBe('20260101000000Z');
  });
});
