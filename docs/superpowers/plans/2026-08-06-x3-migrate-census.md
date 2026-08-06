# tools/x3-migrate — Converter Skeleton + Census Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone TypeScript tool in `tools/x3-migrate/` that parses X3's saxdb/recdb databases and LDIF directory exports and produces the Phase 0 census/go-no-go report (X3-merge program, Phase 0 slice).

**Spec:** `docs/superpowers/specs/2026-08-06-x3-migrate-census-design.md` (approved 2026-08-06). The spec's "Ground truth" section IS the format authority — its grammar/escape/writer facts were audited from `x3/src/recdb.c` + `saxdb.c` and are restated in the tasks below where needed.

**Architecture:** Pure text-in/text-out pipeline: `recdb/parse.ts` → model (`recdb/model.ts`) → `recdb/serialize.ts`; `ldif.ts` beside it; `census/` consumes both; `cli.ts` fronts it. Zero runtime dependencies (Node core only), zero bed dependency in the test suite.

**Tech Stack:** Node ≥20, ESM, strict TypeScript, vitest + tsx (dev-only deps).

## Global Constraints

- Package is self-contained at `tools/x3-migrate/` with its OWN `package.json`; it is NOT wired into `tests/`'s vitest config. Its suite runs via `cd tools/x3-migrate && npm test`.
- **Strict parser**: any input X3's `parse_database()` would `_exit(1)` on must throw `RecdbParseError` (with line/column). Anything X3's reader accepts must parse with X3's exact semantics. No recovery mode.
- Integers stay strings in the model (the format cannot distinguish them). Duplicate keys: last-wins for the value, plus a diagnostic. Key lookups are case-insensitive with RFC1459 casemapping (`irccasecmp`: `[`≡`{`, `]`≡`}`, `\`≡`|`, `~`≡`^`, plus ASCII A-Z≡a-z).
- Round-trip gate is semantic (`parse(serialize(parse(x)))` deep-equals `parse(x)`); byte-identity with X3 output is a NON-goal.
- Census must run without an LDIF (Gate 1 blocked; both D1 branches served). Read-only over copies — the tool never writes any db.
- CLI exit codes: 0 = census clean, 2 = anomalies present, 1 = parse/usage failure.
- No real user data in the repo — fixtures are synthetic (bed-SHAPED, invented values).
- TDD: every task writes its failing tests first. Tests define behavior; implementation makes them pass.
- Commits go to testnet `main`. The working tree carries the user's pre-existing unstaged files (`data/*.conf`, `scripts/setup-keycloak.sh`, `.claude/para/*`, submodule pointers) — stage ONLY files under `tools/x3-migrate/`; never `git add -A`.
- Live-bed access is used ONLY in Task 6's manual smoke step, via `scripts/dc.sh exec x3` (never raw docker compose), read-only (`cat` a copy out).

---

### Task 1: Package scaffold + recdb value model

**Files:**
- Create: `tools/x3-migrate/package.json`, `tools/x3-migrate/tsconfig.json`
- Create: `tools/x3-migrate/src/recdb/model.ts`
- Test: `tools/x3-migrate/test/model.test.ts`

**Interfaces (later tasks consume verbatim):**
```ts
export type RValue = RString | RList | RObject;
export interface RString { kind: 'string'; value: string }
export interface RList   { kind: 'list';   items: string[] }
export interface RObject { kind: 'object'; entries: Map<string, RValue> }

export function rstr(value: string): RString;
export function rlist(items: string[]): RList;
export function robj(pairs?: Iterable<[string, RValue]>): RObject;

/** RFC1459 casemapping lower-case fold (a-z + []\~ forms). */
export function ircFold(s: string): string;
/** Case-insensitive (irccasecmp) lookup into an RObject. */
export function oget(obj: RObject, key: string): RValue | undefined;
export function ogetStr(obj: RObject, key: string): string | undefined;
export function ogetObj(obj: RObject, key: string): RObject | undefined;
export function ogetList(obj: RObject, key: string): string[] | undefined;
```

- [ ] **Step 1: Scaffold the package**

`tools/x3-migrate/package.json`:
```json
{
  "name": "x3-migrate",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "census": "tsx src/cli.ts census"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tools/x3-migrate/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

Run: `cd tools/x3-migrate && npm install`
Expected: lockfile created, deps installed. (Commit the lockfile — reproducible tool builds.)

- [ ] **Step 2: Write the failing model tests**

`test/model.test.ts`:
```ts
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
```

Run: `npm test` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/recdb/model.ts`**

```ts
export type RValue = RString | RList | RObject;
export interface RString { kind: 'string'; value: string }
export interface RList   { kind: 'list';   items: string[] }
export interface RObject { kind: 'object'; entries: Map<string, RValue> }

export const rstr = (value: string): RString => ({ kind: 'string', value });
export const rlist = (items: string[]): RList => ({ kind: 'list', items });
export const robj = (pairs?: Iterable<[string, RValue]>): RObject =>
  ({ kind: 'object', entries: new Map(pairs ?? []) });

/** RFC1459 casemapping fold: A-Z -> a-z, [ -> {, ] -> }, \ -> |, ~ -> ^.
 * Matches X3's irccasecmp key semantics (dict-splay.c). */
export function ircFold(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0x41 && c <= 0x5a) out += String.fromCharCode(c + 32);
    else if (ch === '[') out += '{';
    else if (ch === ']') out += '}';
    else if (ch === '\\') out += '|';
    else if (ch === '~') out += '^';
    else out += ch;
  }
  return out;
}

export function oget(obj: RObject, key: string): RValue | undefined {
  const want = ircFold(key);
  let found: RValue | undefined;
  for (const [k, v] of obj.entries) if (ircFold(k) === want) found = v; // last wins, like X3
  return found;
}
export const ogetStr = (o: RObject, k: string): string | undefined => {
  const v = oget(o, k); return v?.kind === 'string' ? v.value : undefined;
};
export const ogetObj = (o: RObject, k: string): RObject | undefined => {
  const v = oget(o, k); return v?.kind === 'object' ? v : undefined;
};
export const ogetList = (o: RObject, k: string): string[] | undefined => {
  const v = oget(o, k); return v?.kind === 'list' ? v.items : undefined;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all model tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/x3-migrate/package.json tools/x3-migrate/package-lock.json tools/x3-migrate/tsconfig.json tools/x3-migrate/src/recdb/model.ts tools/x3-migrate/test/model.test.ts
git commit -m "x3-migrate: package scaffold + recdb value model (census tool, merge Phase 0)"
```

---

### Task 2: recdb parser

**Files:**
- Create: `tools/x3-migrate/src/recdb/parse.ts`
- Test: `tools/x3-migrate/test/parse.test.ts`

**Interfaces:**
- Consumes: the model types from Task 1.
- Produces (Tasks 3/5/6 consume verbatim):
```ts
export class RecdbParseError extends Error {
  constructor(message: string, public line: number, public col: number);
}
export interface ParseDiagnostic { line: number; col: number; kind:
  'duplicate-key' | 'reader-only-equals' | 'reader-only-escape'
  | 'reader-only-trailing-comma'; detail: string }
export interface ParseResult { root: RObject; diagnostics: ParseDiagnostic[] }
export function parseDb(text: string): ParseResult;
```

The grammar being implemented (audited from `x3/src/recdb.c` — normative):
`database := record*`; `record := qstring ['='] (qstring | object | stringlist) ';'`; `object := '{' record* '}'`; `stringlist := '(' [qstring (',' qstring)*] ')'`. Every string is double-quoted (no barewords). Comments `/* ... */` (unterminated runs to EOF without error) and `// ...` between tokens only. Whitespace optional wherever tokens self-delimit. Escapes inside strings: `\a`(0x07) `\b`(0x08) `\t` `\n` `\v`(0x0B) `\f`(0x0C) `\r` `\\` `\"`; octal `\o`, `\oo`, `\ooo` (digits 0-7, value ≤ 0o377, stop at first non-octal digit or 3 digits); hex `\x` + 0-2 hex digits (bare `\x` with no hex digit ⇒ the two literal chars `\x`); any OTHER `\X` ⇒ BOTH literal chars kept. A raw (unescaped) newline inside a string is an error. EOF: clean between records OK; a parsed name followed by EOF (no value) is an error; whitespace/comments then EOF is OK. Duplicate keys within one object (irccasecmp-equal): value last-wins + `duplicate-key` diagnostic. The optional `=` and any octal/hex/unknown escape occurrences produce `reader-only-*` diagnostics (X3's writer never emits them — their presence means a hand-edited or foreign file).

- [ ] **Step 1: Write the failing parser tests**

`test/parse.test.ts`:
```ts
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
  it('tolerates a trailing comma (reader does; writer never emits) with a diagnostic', () => {
    // CORRECTED 2026-08-06 against recdb.c:500-508: after a consumed comma the
    // loop top breaks on ')' — the C reader accepts ("x",).
    const r = parseDb('"l" ("x",);');
    expect(ogetList(r.root, 'l')).toEqual(['x']);
    expect(r.diagnostics.some(d => d.kind === 'reader-only-trailing-comma')).toBe(true);
    expect(() => root('"l" (,);')).toThrow(RecdbParseError);    // qstring expected
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
    expect(ogetStr(root('"k" "\\377";'), 'k')).toBe('\u00ff');
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
```

Run: `npm test` — Expected: parse tests FAIL (module not found).

- [ ] **Step 2: Implement `src/recdb/parse.ts`**

Single-pass recursive-descent over the string with an index cursor and line/col tracking. Structure:

```ts
import { RObject, RValue, robj, rstr, rlist, ircFold } from './model.js';

export class RecdbParseError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(`${message} at ${line}:${col}`);
  }
}
export interface ParseDiagnostic { line: number; col: number;
  kind: 'duplicate-key' | 'reader-only-equals' | 'reader-only-escape'; detail: string }
export interface ParseResult { root: RObject; diagnostics: ParseDiagnostic[] }

export function parseDb(text: string): ParseResult { /* cursor state + helpers below */ }
```

Implementation notes binding the details (mirror `recdb.c` behavior exactly):
- `skipWs()`: consume `isspace` + both comment forms; `/*` without `*/` consumes to EOF silently; returns the next significant char or EOF sentinel.
- `parseQstring()`: expect `"` else error `expected open quote`; loop chars; raw `\n` ⇒ error `unterminated string`; on `\` dispatch: named set; octal (peek 1-3 digits 0-7, first digit already seen); `x` + up to 2 hex digits (zero digits ⇒ append literal `\x`); default ⇒ append `\` + char. Emit one `reader-only-escape` diagnostic per octal/hex/unknown occurrence. EOF before closing quote ⇒ error.
- `parseRecord(into)`: `skipWs`; EOF ⇒ done-flag. Parse name qstring; `skipWs`; EOF here ⇒ error `expected record data`; optional `=` (diagnostic) then `skipWs`; dispatch on `"`/`{`/`(` else error `expected record data`; `skipWs`; expect `;` else error `expected semicolon`. Insert into `into.entries` by the RAW key (preserve spelling/order); if an existing entry is irccasecmp-equal to the new key (compare via `ircFold`), record `duplicate-key` — the NEW entry is appended and `oget`'s last-wins picks it up (matches the reader's dict last-wins).
- `parseObject()` / `parseStringList()` per grammar; list requires `,` between elements, `)` ends; `EXPECTED_COMMA` otherwise; a trailing comma before `)` is accepted (loop-top break) with a `reader-only-trailing-comma` diagnostic.
- Line/col: track on every consumed char (`\n` increments line, resets col).

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test` — Expected: all parse + model tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/x3-migrate/src/recdb/parse.ts tools/x3-migrate/test/parse.test.ts
git commit -m "x3-migrate: strict recdb parser (grammar-faithful to x3 recdb.c)"
```

---

### Task 3: Serializer + round-trip gate + bed-shaped fixture

**Files:**
- Create: `tools/x3-migrate/src/recdb/serialize.ts`
- Create: `tools/x3-migrate/test/fixtures/bedlike.x3db` (synthetic mondo db)
- Test: `tools/x3-migrate/test/serialize.test.ts`

**Interfaces:**
- Consumes: Task 1 model, Task 2 `parseDb`.
- Produces:
```ts
export interface SerializeOptions { keyOrder?: 'asWritten' | 'x3' }  // default 'asWritten'
export function serializeDb(root: RObject, opts?: SerializeOptions): string;
```

Writer conventions being implemented (audited from `x3/src/saxdb.c` — normative): every name/value quoted; escape ONLY the set `\` BEL BS TAB LF VT FF CR `"` (as `\\ \a \b \t \n \v \f \r \"`), never octal/hex; no `=`; records end `;`; objects `"name" {` … `};` — indent nested records with one TAB per depth and newline separators; lists `"name" ("a", "b");` (comma+space); empty list `"name" ();`; top-level sections separated by a blank line (mondo shape); `keyOrder:'x3'` sorts each object's entries by `ircFold(key)` lexicographic (the splay-iteration invariant), `'asWritten'` keeps model order. (Simplification vs X3, accepted by the spec: X3 writes some leaf records single-line via a per-call-site "complex" flag we cannot know schema-free; we always write the indented form. The round-trip gate is semantic, so this is safe; byte-identity is a spec non-goal.)

- [ ] **Step 1: Create the synthetic bed-shaped fixture**

`test/fixtures/bedlike.x3db` — shapes copied from the live bed's mondo layout, ALL VALUES INVENTED:
```
"gline" {
};

"shun" {
};

"sendmail" {
"prohibited" { };
};

"OpServ" {
"routingplan_options" {
"KARMA_TIMER" "1700000000";
};
"max_clients" { "max" "26"; "time" "1700000001"; };
};

"NickServ" {
"alice" {
"passwd" "0123456789abcdef0123456789abcdef";
"registered" "1600000000";
"lastseen" "1700000000";
"flags" "";
};
"bob" {
"passwd" "$a1b2c3d4FEDCBA9876543210FEDCBA9876543210";
"registered" "1500000000";
"lastseen" "1500000100";
};
"carol[away]" {
"passwd" "not-a-hash";
"registered" "1400000000";
};
};

"ChanServ" {
"#test" {
"registered" "1600000500";
"owner" "alice";
"users" {
"alice" { "level" "500"; "seen" "1700000000"; };
"BOB" { "level" "200"; "seen" "1650000000"; };
"ghost" { "level" "100"; "seen" "1400000000"; };
};
"bans" {
"*!*@spam.example" { "owner" "alice"; "reason" "spam"; "expires" "0"; };
};
};
};

"modcmd" {
"bots" {
"OpServ" { "aliases" ("op", "deop"); };
};
};
```

(Deliberate contents: legacy plain hash (alice), `$`-seeded hash (bob), malformed hash (carol), RFC1459 chars in a handle, a case-variant users key (`BOB`), a dangling users ref (`ghost` has no NickServ handle), an empty-string value, empty objects, single-line leaf records, a string list.)

**Corrected at final review 2026-08-06:** the `#test` block's channel-level
key above is written as `"owner" "alice";` — verified against
`chanserv_write_channel` in x3/src/chanserv.c, that key is wrong:
`chanserv.c` never emits a channel-level `"owner"`; the real per-channel
handle field is `"registrar"`. The per-ban `"owner"` on the line below
(`*!*@spam.example`) is correct as written — ban records DO carry `"owner"`.
The checked-in fixture (`test/fixtures/bedlike.x3db`) was fixed to
`"registrar" "alice";` at that channel level; this plan's code block is left
as originally authored, per the historical-record convention.

- [ ] **Step 2: Write the failing serializer tests**

`test/serialize.test.ts`:
```ts
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
    expect(parseDb(serializeDb(once, { keyOrder: 'x3' })).root).toEqual(once);
  });
});
```

Note on `toEqual`: `RObject.entries` is a `Map` — vitest's deep equality compares Maps including ORDER of entries. For the `x3`-order round-trip test that would fail spuriously; therefore implement the comparison so order doesn't matter — add a tiny local helper in the test file instead of raw `toEqual` for that one case if it proves order-sensitive: canonicalize both roots by sorting entries with `ircFold` before comparing. Keep the first two round-trip tests on plain `toEqual` (asWritten preserves order).

Run: `npm test` — Expected: serializer tests FAIL.

- [ ] **Step 3: Implement `src/recdb/serialize.ts`**

```ts
import { RObject, RValue, ircFold } from './model.js';

export interface SerializeOptions { keyOrder?: 'asWritten' | 'x3' }

const ESCAPES: Record<string, string> = {
  '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n',
  '\x0b': '\\v', '\f': '\\f', '\r': '\\r', '"': '\\"',
};
const quote = (s: string) => '"' + s.replace(/[\\\x07\b\t\n\x0b\f\r"]/g, c => ESCAPES[c]!) + '"';

export function serializeDb(root: RObject, opts: SerializeOptions = {}): string {
  const order = (o: RObject): [string, RValue][] => {
    const e = [...o.entries];
    return opts.keyOrder === 'x3' ? e.sort((a, b) => ircFold(a[0]) < ircFold(b[0]) ? -1 : ircFold(a[0]) > ircFold(b[0]) ? 1 : 0) : e;
  };
  const emit = (o: RObject, depth: number): string => {
    let out = '';
    for (const [k, v] of order(o)) {
      const ind = '\t'.repeat(depth);
      if (v.kind === 'string') out += `${ind}${quote(k)} ${quote(v.value)};\n`;
      else if (v.kind === 'list') out += `${ind}${quote(k)} (${v.items.map(quote).join(', ')});\n`;
      else out += `${ind}${quote(k)} {\n${emit(v, depth + 1)}${ind}};\n`;
    }
    return out;
  };
  // top level: sections separated by a blank line (mondo shape)
  return order(root)
    .map(([k, v]) => v.kind === 'object'
      ? `${quote(k)} {\n${emit(v, 1)}};\n`
      : emit({ kind: 'object', entries: new Map([[k, v]]) } as RObject, 0))
    .join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all PASS (adjust only test-side canonicalization if the x3-order round-trip trips on Map order, per the note above — never weaken the asWritten round-trip).

- [ ] **Step 5: Commit**

```bash
git add tools/x3-migrate/src/recdb/serialize.ts tools/x3-migrate/test/serialize.test.ts tools/x3-migrate/test/fixtures/bedlike.x3db
git commit -m "x3-migrate: recdb serializer + semantic round-trip gate + bed-shaped fixture"
```

---

### Task 4: LDIF reader

**Files:**
- Create: `tools/x3-migrate/src/ldif.ts`
- Test: `tools/x3-migrate/test/ldif.test.ts`

**Interfaces:**
- Produces (Task 5 consumes verbatim):
```ts
export interface LdifEntry {
  dn: string;
  /** every attribute, lowercased name -> raw values (utf8-decoded; base64 already decoded) */
  attrs: Map<string, string[]>;
}
export interface LdapAccount {
  uid: string;
  dn: string;
  objectClasses: string[];
  /** parsed from userPassword values: e.g. { scheme: 'SSHA', raw: '{SSHA}...' }; scheme '' = plaintext/unprefixed */
  passwords: { scheme: string; raw: string }[];
  createTimestamp?: string;
  modifyTimestamp?: string;
}
export function parseLdif(text: string): LdifEntry[];
/** entries with a uid attribute, mapped to accounts */
export function ldapAccounts(entries: LdifEntry[]): LdapAccount[];
```

- [ ] **Step 1: Write the failing LDIF tests**

`test/ldif.test.ts`:
```ts
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
```

Run: `npm test` — Expected: FAIL.

- [ ] **Step 2: Implement `src/ldif.ts`**

Line-based: unfold first (a line starting with a single space continues the previous line, minus that space); drop `#` comment lines (before unfolding per RFC 2849 — a continuation of a comment is also dropped); split entries on blank lines; parse `name:: b64` vs `name: value` vs `name:< url` (treat `:<` as unsupported ⇒ keep raw with a `url:` prefix marker in the value); attribute names lowercased into the Map, values appended in order. `ldapAccounts`: filter entries with `uid`; `passwords` from each `userpassword` value via `/^\{([^}]+)\}/` (scheme uppercased; no match ⇒ scheme `''`); `objectClasses` from `objectclass`; timestamps from `createtimestamp`/`modifytimestamp` (first value).

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/x3-migrate/src/ldif.ts tools/x3-migrate/test/ldif.test.ts
git commit -m "x3-migrate: LDIF export reader (slapcat/ldapsearch subset)"
```

---

### Task 5: Census — classification + report

**Files:**
- Create: `tools/x3-migrate/src/census/classify.ts`
- Create: `tools/x3-migrate/src/census/report.ts`
- Test: `tools/x3-migrate/test/census.test.ts`

**Interfaces:**
- Consumes: Task 1 model + oget helpers, Task 2 `ParseResult`, Task 4 `LdapAccount`.
- Produces (Task 6 consumes verbatim):
```ts
// classify.ts
export type CredState = 'ldap-backed' | 'local-hash-only' | 'both' | 'neither';
export type HashFormat = 'plain-md5' | 'seeded' | 'malformed' | 'absent';
export type ActivityBucket = '<30d' | '<180d' | '<1y' | '<5y' | 'older' | 'unknown';
export interface AccountCensus {
  handle: string; credState: CredState; hashFormat: HashFormat;
  activity: ActivityBucket; anomalies: string[];
}
export function classifyHash(passwd: string | undefined): { format: HashFormat; anomalies: string[] };
export function activityBucket(lastseenEpochStr: string | undefined, now: number): ActivityBucket;
export function classifyAccounts(nickserv: RObject, ldap: LdapAccount[] | null, now: number): AccountCensus[];

// report.ts
export interface CensusReport {
  generatedAt: string;                       // ISO, caller-supplied clock
  ldifSupplied: boolean;
  sections: Record<string, number>;          // top-level section name -> record count (1 level down)
  accounts: {
    total: number;
    byCredState: Record<CredState, number>;
    byHashFormat: Record<HashFormat, number>;
    activityByCredState: Record<CredState, Record<ActivityBucket, number>>;
  };
  chanserv: { channels: number; userRecords: number; banRecords: number };
  danglingRefs: { kind: 'owner' | 'users-key' | 'ban-owner' | 'ldap-only-uid'; channel?: string; name: string }[];
  // (corrected at final review 2026-08-06: the channel-level kind ships as
  // 'registrar', not 'owner' — chanserv.c never writes a channel-level
  // "owner"; only ban records do. 'ban-owner' is unaffected.)
  anomalies: string[];                       // flat, human-readable, includes parser diagnostics
  clean: boolean;                            // danglingRefs empty AND anomalies empty
}
export function buildReport(parse: ParseResult, ldap: LdapAccount[] | null, now: number): CensusReport;
export function renderReport(r: CensusReport): string;   // human-readable text
```

Classification rules (from the spec — normative):
- `classifyHash`: `undefined`/empty ⇒ `absent`. 32 chars all `[0-9a-f]` ⇒ `plain-md5`; if it is 32 hex but contains ANY uppercase ⇒ `malformed` + anomaly `plain-hash-uppercase` (case discriminator). Leading `$`: `$` + exactly 8 hex + 32 hex ⇒ `seeded`; seeded digest containing any lowercase ⇒ anomaly `seeded-hash-lowercase` but still `seeded` if shape matches ONLY when the digest is all-hex — otherwise `malformed`. Everything else ⇒ `malformed`.
  (X3 writes seeded digests uppercase and plain digests lowercase — `md5.c` — so case deviation signals format misdetection; the report surfaces it rather than guessing.)
- `activityBucket`: parse decimal epoch; `now - t` into the buckets; unparsable/absent ⇒ `unknown`.
- `classifyAccounts`: NickServ section entries = handles (each an object). LDAP match by `ircFold(handle) === ircFold(uid)`. **CredState keys on credential-material PRESENCE, not parsability** (this refines the spec's "parsable passwd" parenthetical): a non-empty `passwd` counts as local material even when `classifyHash` says `malformed` — the malformation surfaces via `hashFormat` + anomalies, never by silently reclassifying the account as `neither` (which would hide it from the credential-migration planning the census exists for). Empty/absent `passwd` = no local material. `ldap===null` ⇒ every account gets `local-hash-only` (material present) or `neither` (absent), and the report notes no-LDIF mode. LDAP uids matching no handle become `ldap-only-uid` dangling refs (reported by buildReport).
- `buildReport` also: ChanServ sweep — per channel: `owner` string, `users` object keys, `bans` object `owner` fields, each checked against handle set (irccasecmp) → dangling refs with `channel` filled; counts. Sections map = every top-level section name → its entry count (sections the tool doesn't model are counted, not interpreted). Parser diagnostics fold into `anomalies` as strings. `clean` per the interface comment.
  (corrected at final review 2026-08-06: the per-channel field checked is `registrar`, not `owner` — the latter never appears at channel level in `chanserv.c`'s writer, only inside per-ban records. The shipped kind is `'registrar'`.)

- [ ] **Step 1: Write the failing census tests**

`test/census.test.ts`:
```ts
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
    const c = classifyAccounts(ns, ldap, NOW);
    const by = Object.fromEntries(c.map(a => [a.handle, a]));
    expect(by['alice']!.credState).toBe('both');            // hash + LDAP
    expect(by['bob']!.credState).toBe('local-hash-only');
    expect(by['carol[away]']!.credState).toBe('local-hash-only'); // malformed still counts as local cred material
  });
  it('without an LDIF: two-way split only', () => {
    const c = classifyAccounts(ns, null, NOW);
    expect(new Set(c.map(a => a.credState))).toEqual(new Set(['local-hash-only']));
  });
});

describe('buildReport (fixture world)', () => {
  const parse = parseDb(FIXTURE);
  const r = buildReport(parse, null, NOW);
  it('counts sections including unmodeled ones', () => {
    expect(r.sections['NickServ']).toBe(3);
    expect(r.sections['gline']).toBe(0);
    expect(r.sections['modcmd']).toBe(1);
  });
  it('counts chanserv entities', () => {
    expect(r.chanserv).toEqual({ channels: 1, userRecords: 3, banRecords: 1 });
  });
  it('finds the dangling users-key ref', () => {
    expect(r.danglingRefs).toContainEqual({ kind: 'users-key', channel: '#test', name: 'ghost' });
  });
  it('matches owner refs case-insensitively (no false dangling)', () => {
    expect(r.danglingRefs.filter(d => d.kind === 'owner')).toHaveLength(0);
  });
  // (corrected at final review 2026-08-06: this assertion's kind ships as
  // 'registrar' — chanserv.c has no channel-level "owner" key. Shipped test
  // file: test/census.test.ts, "matches registrar refs case-insensitively".)
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

describe('a clean world is clean', () => {
  it('clean db + matching ldif => clean report, GO headline', () => {
    const db = parseDb('"NickServ" { "u1" { "passwd" "0123456789abcdef0123456789abcdef"; "lastseen" "' + String(NOW - 1000) + '"; }; };');
    const ldap = ldapAccounts(parseLdif('dn: uid=u1,ou=u,dc=x\nuid: u1\nuserPassword: {SSHA}h\n'));
    const r = buildReport(db, ldap, NOW);
    expect(r.clean).toBe(true);
    expect(renderReport(r)).toContain('GO');
  });
});
```

Run: `npm test` — Expected: census tests FAIL.

- [ ] **Step 2: Implement `classify.ts` and `report.ts`**

Implement exactly the interfaces and rules in this task's header. Notes:
- `classifyHash` shape checks: plain = `/^[0-9a-f]{32}$/` (case-sensitive); the uppercase-discriminator check = `/^[0-9a-fA-F]{32}$/` matching but not the lowercase form; seeded = `/^\$[0-9a-fA-F]{8}[0-9a-fA-F]{32}$/` with the lowercase-digest anomaly when `/[a-f]/` matches the last 32 chars (X3 writes them uppercase); seed case is not constrained (X3 writes lowercase seed hex, but the discriminator that matters is the digest).
- `classifyAccounts` handles = entries of the NickServ object whose value is an object; per handle read `passwd`/`lastseen` via `ogetStr`. Account anomalies: `malformed` hash ⇒ `"<handle>: malformed passwd"`, hash-case discriminators ⇒ `"<handle>: <anomaly>"`.
- `buildReport` composes: run `classifyAccounts`; aggregate the four `byCredState` / `byHashFormat` / nested activity tallies (initialize every bucket key to 0 so the JSON shape is stable); ChanServ sweep per the interface; sections map over top-level entries (objects ⇒ `entries.size`, non-objects ⇒ 0 with an anomaly `"top-level non-object section <name>"`); parser diagnostics ⇒ `anomalies` strings (`"parse: <kind> at <line>:<col> <detail>"`); `clean = danglingRefs.length === 0 && anomalies.length === 0`.
- `renderReport`: headline `=== CENSUS: GO ===` / `=== CENSUS: NO-GO (<n> anomalies, <m> dangling refs) ===`, then sections table, account tallies (state × activity matrix), chanserv counts, dangling-ref list, anomaly list. Plain text, no color.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/x3-migrate/src/census tools/x3-migrate/test/census.test.ts
git commit -m "x3-migrate: census classification + go/no-go report"
```

---

### Task 6: CLI + live-bed smoke (baseline census)

**Files:**
- Create: `tools/x3-migrate/src/cli.ts`
- Create: `tools/x3-migrate/README.md`
- Test: `tools/x3-migrate/test/cli.test.ts`

**Interfaces:**
- Consumes: `parseDb`, `parseLdif`/`ldapAccounts`, `buildReport`/`renderReport`.
- Produces: `npx tsx src/cli.ts census (--db <mondo-file> | --section Name=<file> [--section ...]) [--ldif <file>] [--json <out>]`; exit 0 clean / 2 anomalies / 1 parse-or-usage failure. `--db` reads a mondo file (sections at top level); each `--section Name=file` parses a per-module db file (whose records ARE that section's entries — same `parseDb`, result wrapped as `robj([[Name, root]])` and merged) — the two forms are mutually exclusive. Stub subcommands `convert`, `residual`, `bans` print `"<name>: not implemented (X3-merge phase N deliverable)"` and exit 1.

- [ ] **Step 1: Write the failing CLI tests**

`test/cli.test.ts` (drive the CLI in-process via `execFileSync` on `tsx`):
```ts
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
writeFileSync(CLEAN_DB, '"NickServ" { "u1" { "passwd" "0123456789abcdef0123456789abcdef"; }; };\n');
writeFileSync(DIRTY_DB, '"NickServ" { "u1" { "passwd" "junk"; }; };\n');
writeFileSync(BAD_DB, '"NickServ" { broken\n');
writeFileSync(LDIF, 'dn: uid=u1,ou=u,dc=x\nuid: u1\nuserPassword: {SSHA}h\n');

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
```

Run: `npm test` — Expected: CLI tests FAIL.

- [ ] **Step 2: Implement `src/cli.ts`**

Minimal argv walk (no dependency): first arg = subcommand; flags `--db`, `--ldif`, `--json` each take a value. `census`: read db file → `parseDb` (catch `RecdbParseError` → print message → exit 1); optional ldif file → `ldapAccounts(parseLdif(...))`; `buildReport(parse, ldap ?? null, Math.floor(Date.now()/1000))`; print `renderReport`; `--json` writes `JSON.stringify(report, null, 2)`; exit `report.clean ? 0 : 2`. Missing `--db`, unreadable files, unknown subcommand: print usage to stdout, exit 1. Stubs per the interface. Keep it under ~120 lines.

- [ ] **Step 3: Run the full package suite**

Run: `npm test` — Expected: ALL suites PASS (model, parse, serialize, ldif, census, cli).

- [ ] **Step 4: Write `README.md`**

Content (verbatim skeleton, adjust paths only if reality differs):
```markdown
# x3-migrate

Offline converter + census for the X3-into-Nefarious merge (Phase 0 slice).
Plan of record: `.claude/para/projects/x3-merge-sequencing.md` §4; design spec:
`docs/superpowers/specs/2026-08-06-x3-migrate-census-design.md`.

Read-only over COPIES of `x3.db` / LDIF exports — never point it at live files.

## Census

    cd tools/x3-migrate
    npm install
    npm test                                  # full gate, no bed needed
    # bed baseline (copy first):
    ../../scripts/dc.sh exec x3 cat /x3/data/x3.db > /tmp/x3db.copy
    npx tsx src/cli.ts census --db /tmp/x3db.copy [--ldif export.ldif] [--json report.json]

Exit codes: 0 = clean (GO), 2 = anomalies (NO-GO), 1 = parse/usage failure.
Without `--ldif` the credential split is local-hash-only vs absent (both-D1-branch
mode); the four-way split needs a directory export (`slapcat` from the openldap
container).

`convert` / `residual` / `bans` are reserved for later merge phases.
```

- [ ] **Step 5: Live-bed smoke — the bed's baseline census (manual, recorded, not CI)**

```bash
scripts/dc.sh exec -T x3 cat /x3/data/x3.db > /tmp/x3db.copy
cd tools/x3-migrate && npx tsx src/cli.ts census --db /tmp/x3db.copy --json /tmp/bed-census.json
```

Expected: exit 0 or 2 (either is fine — this is a measurement), NEVER 1: a parse failure on the real bed db means the parser deviates from X3's grammar and is a BLOCKING finding for this task. Record in the task report: the full rendered report, the JSON's `accounts` block, and every anomaly with a one-line explanation or an "unexplained — carried forward" marker. This is the bed's baseline census, referenced by later phases.

- [ ] **Step 6: Commit**

```bash
git add tools/x3-migrate/src/cli.ts tools/x3-migrate/test/cli.test.ts tools/x3-migrate/README.md
git commit -m "x3-migrate: census CLI + README; bed baseline census recorded"
```

---

## Task ordering

Strictly sequential 1 → 6 (each consumes the previous task's interfaces). No bed access before Task 6 Step 5.

## Not in this plan (spec's scope boundaries)

Parts A–D emitters, Keycloak import payloads, hash providers, rehearsal tooling; any X3/nefarious code change; Gate 1 / D1; `${VAR}` interpolation (not in X3's recdb.c); byte-identical re-serialization of X3 output.
