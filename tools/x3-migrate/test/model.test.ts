import { describe, it, expect } from 'vitest';
import { rstr, rlist, robj, ircFold, oget, ogetStr, ogetObj, ogetList } from '../src/recdb/model.js';

describe('ircFold (RFC1459 casemapping)', () => {
  it('folds ASCII letters', () => expect(ircFold('AbC')).toBe('abc'));
  it('folds the RFC1459 bracket forms', () => {
    expect(ircFold('[]\\~')).toBe('{}|^');
    expect(ircFold('NICK[away]~')).toBe('nick{away}^');
  });
  it('leaves other characters alone', () => expect(ircFold('a0-_$')).toBe('a0-_$'));
});

describe('oget family', () => {
  const o = robj([
    ['Owner', rstr('IbUtSu')],
    ['users', robj([['helper[1]', rstr('200')]])],
    ['tags', rlist(['a', 'b'])],
  ]);
  it('finds keys case-insensitively', () => {
    expect(ogetStr(o, 'owner')).toBe('IbUtSu');
    expect(ogetStr(o, 'OWNER')).toBe('IbUtSu');
  });
  it('finds RFC1459-equivalent keys', () => {
    const u = ogetObj(o, 'USERS')!;
    expect(ogetStr(u, 'HELPER{1}')).toBe('200');
  });
  it('returns undefined on absent keys and kind mismatches', () => {
    expect(oget(o, 'nope')).toBeUndefined();
    expect(ogetStr(o, 'users')).toBeUndefined();   // it's an object, not a string
    expect(ogetObj(o, 'owner')).toBeUndefined();
    expect(ogetList(o, 'tags')).toEqual(['a', 'b']);
    expect(ogetList(o, 'owner')).toBeUndefined();
  });
  it('preserves insertion order in entries', () => {
    expect([...o.entries.keys()]).toEqual(['Owner', 'users', 'tags']);
  });
});
