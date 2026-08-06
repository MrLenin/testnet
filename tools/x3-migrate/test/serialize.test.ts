import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDb } from '../src/recdb/parse.js';
import { serializeDb } from '../src/recdb/serialize.js';
import { robj, rstr, rlist } from '../src/recdb/model.js';

const FIXTURE = readFileSync(new URL('./fixtures/bedlike.x3db', import.meta.url), 'utf8');

describe('serializer conventions', () => {
  it('writes strings quoted, records semicolon-terminated, no equals', () => {
    const out = serializeDb(robj([['k', rstr('v')]]));
    expect(out).toContain('"k" "v";');
    expect(out).not.toContain('=');
  });
  it('escapes exactly the writer set', () => {
    const out = serializeDb(robj([['k', rstr('a\tb\n"c"\\d\x07')]]));
    expect(out).toContain('"a\\tb\\n\\"c\\"\\\\d\\a"');
  });
  it('does not escape high bytes or other controls', () => {
    const out = serializeDb(robj([['k', rstr('\u00ff\x1b')]]));
    expect(out).toContain('"\u00ff\x1b"');
  });
  it('writes lists with comma-space and empty lists bare', () => {
    const out = serializeDb(robj([['l', rlist(['a', 'b'])], ['e', rlist([])]]));
    expect(out).toContain('"l" ("a", "b");');
    expect(out).toContain('"e" ();');
  });
  it('separates top-level sections with a blank line', () => {
    const out = serializeDb(robj([['A', robj()], ['B', robj()]]));
    expect(out).toMatch(/};\n\n"B"/);
  });
  it('x3 key order sorts by ircFold', () => {
    const out = serializeDb(robj([['b', rstr('1')], ['A', rstr('2')], ['[x', rstr('3')]]), { keyOrder: 'x3' });
    const ia = out.indexOf('"A"'), ib = out.indexOf('"b"'), ix = out.indexOf('"[x"');
    expect(ia).toBeLessThan(ib);
    expect(ib).toBeLessThan(ix);   // '[' folds to '{' (0x7b) > 'b'
  });
});

describe('round-trip gate', () => {
  const deepEq = (t: string) => {
    const once = parseDb(t).root;
    const twice = parseDb(serializeDb(once)).root;
    expect(twice).toEqual(once);
  };
  it('round-trips the bed-shaped fixture semantically', () => deepEq(FIXTURE));
  it('round-trips escape-heavy content', () =>
    deepEq('"k" "a\\tb\\377\\x41\\q"; "o" { "l" ("x\\"y", ""); };'));
  it('round-trips in x3 key order too', () => {
    const once = parseDb(FIXTURE).root;
    const serialized = serializeDb(once, { keyOrder: 'x3' });
    const twice = parseDb(serialized).root;
    // Canonicalize both by sorting entries with ircFold before comparing
    const canonicalizeMap = (m: Map<string, any>): Map<string, any> => {
      return new Map([...m.entries()].sort((a, b) => {
        const fa = a[0].toLowerCase().replace(/[\[\]\\~]/g, c => ({ '[': '{', ']': '}', '\\': '|', '~': '^' }[c]!));
        const fb = b[0].toLowerCase().replace(/[\[\]\\~]/g, c => ({ '[': '{', ']': '}', '\\': '|', '~': '^' }[c]!));
        return fa < fb ? -1 : fa > fb ? 1 : 0;
      }));
    };
    const canonicalize = (v: any): any => {
      if (v.kind === 'object') {
        return { kind: 'object', entries: canonicalizeMap(new Map([...v.entries].map(([k, val]: any) => [k, canonicalize(val)]))) };
      }
      return v;
    };
    expect(canonicalize(twice)).toEqual(canonicalize(once));
  });
});
