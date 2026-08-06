import { describe, it, expect } from 'vitest';
import { parseDb, RecdbParseError } from '../src/recdb/parse.js';
import { ogetStr, ogetObj, ogetList } from '../src/recdb/model.js';

const root = (t: string) => parseDb(t).root;

describe('records and values', () => {
  it('parses a string record', () => {
    expect(ogetStr(root('"k" "v";'), 'k')).toBe('v');
  });
  it('accepts the reader-only = form and flags it', () => {
    const r = parseDb('"k" = "v";');
    expect(ogetStr(r.root, 'k')).toBe('v');
    expect(r.diagnostics.some(d => d.kind === 'reader-only-equals')).toBe(true);
  });
  it('parses nested objects and empty objects', () => {
    const o = root('"a" { "b" { }; "c" "1"; };');
    const a = ogetObj(o, 'a')!;
    expect(ogetObj(a, 'b')!.entries.size).toBe(0);
    expect(ogetStr(a, 'c')).toBe('1');
  });
  it('parses string lists, including empty', () => {
    const o = root('"l" ("x", "y"); "e" ();');
    expect(ogetList(o, 'l')).toEqual(['x', 'y']);
    expect(ogetList(o, 'e')).toEqual([]);
  });
  it('accepts a lone trailing comma in a list (matches the C reader), flagged as a diagnostic', () => {
    const r = parseDb('"l" ("x",);');
    expect(ogetList(r.root, 'l')).toEqual(['x']);
    expect(r.diagnostics.some(d => d.kind === 'reader-only-trailing-comma')).toBe(true);
  });
  it('still rejects a leading comma in a list', () => {
    expect(() => root('"l" (,);')).toThrow(RecdbParseError);
  });
  it('still rejects a double comma in a list', () => {
    expect(() => root('"l" ("x",,);')).toThrow(RecdbParseError);
  });
  it('parses with no whitespace at all (self-delimiting tokens)', () => {
    const o = root('"a"{"b""1";};');
    expect(ogetStr(ogetObj(o, 'a')!, 'b')).toBe('1');
  });
  it('requires the semicolon terminator', () => {
    expect(() => root('"k" "v"')).toThrow(RecdbParseError);
  });
});

describe('escapes', () => {
  it('decodes the named escapes', () => {
    expect(ogetStr(root('"k" "a\\tb\\nc\\"d\\\\e";'), 'k')).toBe('a\tb\nc"d\\e');
    expect(ogetStr(root('"k" "\\a\\b\\v\\f\\r";'), 'k')).toBe('\x07\x08\x0b\x0c\x0d');
  });
  it('decodes octal escapes (1-3 digits, stop at non-octal)', () => {
    expect(ogetStr(root('"k" "\\101";'), 'k')).toBe('A');
    expect(ogetStr(root('"k" "\\1018";'), 'k')).toBe('A8');   // 3 digits max
    expect(ogetStr(root('"k" "\\778";'), 'k')).toBe('?8');    // \77 = 0o77 = 63 = '?'
    expect(ogetStr(root('"k" "\\377";'), 'k')).toBe('ÿ');
  });
  it('decodes hex escapes (0-2 digits; bare \\x stays literal)', () => {
    expect(ogetStr(root('"k" "\\x41";'), 'k')).toBe('A');
    expect(ogetStr(root('"k" "\\x4";'), 'k')).toBe('\x04');
    expect(ogetStr(root('"k" "\\xg";'), 'k')).toBe('\\xg');   // no hex digit: literal \x kept
  });
  it('keeps unknown escapes as both characters', () => {
    expect(ogetStr(root('"k" "\\q";'), 'k')).toBe('\\q');
  });
  it('flags reader-only escapes as diagnostics', () => {
    expect(parseDb('"k" "\\101";').diagnostics.some(d => d.kind === 'reader-only-escape')).toBe(true);
    expect(parseDb('"k" "a\\tb";').diagnostics.some(d => d.kind === 'reader-only-escape')).toBe(false);
  });
  it('rejects a raw newline inside a string', () => {
    expect(() => root('"k" "a\nb";')).toThrow(RecdbParseError);
  });
});

describe('comments and whitespace', () => {
  it('skips both comment styles between tokens', () => {
    const o = root('/* x */ "k" // eol\n "v" /* y */ ;');
    expect(ogetStr(o, 'k')).toBe('v');
  });
  it('tolerates an unterminated block comment at EOF', () => {
    expect(ogetStr(root('"k" "v"; /* dangling'), 'k')).toBe('v');
  });
});

describe('EOF and errors', () => {
  it('accepts clean EOF between records (and empty input)', () => {
    expect(root('').entries.size).toBe(0);
    expect(root('  \n// c\n').entries.size).toBe(0);
  });
  it('rejects a name with no value at EOF', () => {
    expect(() => root('"k"')).toThrow(RecdbParseError);
  });
  it('reports line and column', () => {
    try { root('"k" "v";\n"bad" ?;'); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(RecdbParseError); expect((e as RecdbParseError).line).toBe(2); }
  });
});

describe('duplicate keys', () => {
  it('last-wins across case-equivalent keys, with a diagnostic', () => {
    const r = parseDb('"o" { "Key" "1"; "KEY" "2"; };');
    expect(ogetStr(ogetObj(r.root, 'o')!, 'key')).toBe('2');
    expect(r.diagnostics.some(d => d.kind === 'duplicate-key')).toBe(true);
    // both spellings remain in entries (model preserves what was written)
    expect(ogetObj(r.root, 'o')!.entries.size).toBe(2);
  });
});

describe('mondo shape', () => {
  it('parses multiple top-level sections separated by blank lines', () => {
    const o = root('"gline" {\n};\n\n"NickServ" {\n"acct" { "passwd" "x"; };\n};\n');
    expect(ogetObj(o, 'gline')).toBeDefined();
    expect(ogetStr(ogetObj(ogetObj(o, 'nickserv')!, 'acct')!, 'passwd')).toBe('x');
  });
});
