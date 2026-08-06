# tools/x3-migrate — converter skeleton + census (X3-merge Phase 0) — design

**Date:** 2026-08-06
**Status:** draft (user review pending)
**Scope:** new standalone TypeScript tool in testnet `tools/x3-migrate/` — saxdb/recdb
parser + serializer, LDIF export reader, census/go-no-go report, CLI. This is the
Phase 0 slice of the offline converter defined by
`.claude/para/projects/x3-merge-sequencing.md` §4 and the Phase 0 section; the
part A–D emitters are later phases and get stubs only.
**Decisions already ratified (2026-08-06 unpark):** tool home = testnet
`tools/x3-migrate/`; language = TypeScript; Gate 1 has no production-access path,
so the census must serve BOTH D1 branches (federation and one-time import) —
nothing in it may assume the import branch.

## Ground truth (verified 2026-08-06; file:line in x3/)

Format authority is X3's own reader/writer pair, documented from source:

- **Grammar** (`src/recdb.c:37-45`, reader `parse_record_int` :512-537):
  `database := record*`; `record := qstring ['='] (qstring | object | stringlist) ';'`.
  Objects `{ record* }` (:471-490); string lists `( q, q, ... )`, empty `()` legal,
  trailing comma tolerated by the reader (:500-508 loop-top break — corrected 2026-08-06 during implementation; writer never emits it). Every string is double-quoted — no barewords
  (:378). The `=` is reader-only sugar; the writer never emits it (:523 /
  `saxdb.c:333-340`).
- **Escapes** (reader `parse_qstring` :388-455): `\a \b \t \n \v \f \r \\ \"`;
  octal `\ooo` (1–3 digits, max `\377`); hex `\x` with 0–2 digits (bare `\x`
  survives literally); unrecognized `\X` keeps BOTH chars. Raw newline inside a
  string = UNTERMINATED_STRING error. The **writer** escapes only the fixed set
  `\ BEL BS TAB LF VT FF CR "` (`saxdb.c:249-266`) and never emits octal/hex.
- **Comments** `/* */` and `//`, between tokens only (:337-366). Whitespace
  optional everywhere tokens self-delimit.
- **Writer layout** (`saxdb.c`): `"name" {` + newline+tab-indent when the record
  is "complex", single-line space-separated when not (:273-313); string lists as
  `"name" ("a", "b");` (:315-331); **integers are quoted decimal strings**
  (:342-356) — indistinguishable from strings without schema knowledge; atomic
  write via `<file>.new` + rename (:141-165); mondo mode wraps each module as a
  top-level `"Section" { ... };` with a blank line between sections (:386-405).
- **Key order invariant:** the backing dict is a splay tree with `irccasecmp`
  ordering iterated in order (`dict-splay.c`, `saxdb.c:556-573`) → within any
  object, keys appear in **case-insensitive lexicographic order** on disk.
  Duplicate keys cannot be produced by the writer; the reader last-wins.
- **Quirks that shape the parser contract:** NUL-unsafe (C-string pipeline);
  X3's own loader `_exit(1)`s on any syntax error (`recdb.c:656-661`) — there is
  no partial-parse mode in X3, so OUR parser must never "helpfully" accept what
  X3 would die on (a converter output that X3 can't reload would brick the
  rollback path); `${VAR}` env-interpolation is NOT in recdb.c (approved
  2026-08-04 design, unlanded) — if it lands, this parser follows (feature-freeze
  line item).
- **Top-level sections** (`saxdb_register` sites): NickServ, ChanServ, OpServ,
  Global, SpamServ, MemoServ, HelpServ, python, gline, shun, sendmail, modcmd.
  The **bed runs mondo mode**: single `/x3/data/x3.db` (sampled live; both
  complex and single-line layouts present). Per-module `.db` files are the
  non-mondo default — the tool accepts both shapes.
- **Credential shapes** (`src/md5.c:325-360,633-651`, `nickserv.h:118`):
  NickServ `"passwd"` is either legacy plain `MD5(password)` as 32 **lowercase**
  hex chars, or the custom seeded form `$` + 8 seed hex chars + **uppercase**
  MD5 digest. Discriminator = leading `$` (`md5.c:639`). Field is
  `char[43]` (`MD5_CRYPT_LENGTH`=42).
- **Handle references in ChanServ** (`chanserv.c:10072-10111`; verified against
  `chanserv_write_channel` at final review 2026-08-06): per-channel `"users"`
  object keys ARE the handle names (no separate field); the per-channel handle
  ref is `"registrar"`, not `"owner"` — `chanserv_write_channel` never emits a
  channel-level `"owner"` key. `"owner"` DOES appear, but only inside each
  per-ban record (`KEY_OWNER`, written only in the ban-record writer). These
  are the census's dangling-reference edges: channel `registrar`, per-ban
  `owner`, and `users` keys.
- **LDAP side:** directory entries at `uid=<handle>,ou=users,...` with
  `objectClass: inetOrgAnonAccount`; `userPassword` scheme on the bed is
  whatever Keycloak wrote (`{SSHA}` observed; production hypothesis `{SMD5}`,
  unconfirmed — Gate 1). Export format = LDIF (slapcat or ldapsearch -LLL).

## Design

### Package layout

```
tools/x3-migrate/
  package.json          # private; deps: typescript, tsx, vitest (dev) — runtime deps: none (node core only)
  tsconfig.json
  src/
    recdb/parse.ts      # text -> Db model
    recdb/serialize.ts  # Db model -> text (X3 writer conventions)
    recdb/model.ts      # value model + helpers
    ldif.ts             # LDIF export reader
    census/classify.ts  # credential-state + format classification (pure)
    census/report.ts    # counts, distributions, dangling refs, rendering
    cli.ts              # `census` subcommand (parts A-D reserved)
  test/                 # vitest; fixtures/ with synthetic dbs + LDIF
```

Self-contained package (own `package.json`), NOT wired into `tests/`'s vitest
config — its suite runs with `cd tools/x3-migrate && npm test` and has zero bed
dependency (pure text in/out). Node ≥20, ESM, strict TS.

### recdb model

```ts
type RValue = RString | RObject | RList;
interface RString { kind: 'string'; value: string }
interface RList   { kind: 'list';   items: string[] }
interface RObject { kind: 'object'; entries: Map<string, RValue> }  // insertion order preserved
```

- Keys keep their on-disk case; lookups go through a helper implementing
  `irccasecmp` semantics (RFC1459 casemapping: `[]\~` ≡ `{}|^`), because X3's
  dict is case-insensitive — two source keys differing only by case are a
  **census anomaly**, not silently merged (the parser records a diagnostic;
  last-wins like X3's reader for the value itself).
- Integers stay strings in the model (the format cannot distinguish them); no
  schema-aware `asInt`/`asTime` accessor layer shipped — the one place that
  needed epoch-string parsing (`activityBucket`, in `census/classify.ts`)
  inlines its own decimal-string parse rather than growing a general accessor
  API. Revisit only if a second schema-aware caller appears.

### Parser contract (`parse.ts`)

- Implements the reader grammar EXACTLY, including: optional `=`, both comment
  styles, empty lists, all escape forms (octal/hex/unknown-kept), EOF rules
  (clean between records; empty-name-at-EOF tolerated; name-without-value =
  error), raw-newline-in-string = error.
- **Strict by default** — any input X3's `parse_database()` would die on is a
  thrown `RecdbParseError` with line/column and context. No recovery mode in v0:
  the census's job is to refuse to open the window on bad data, not to paper
  over it. (X3-tolerated oddities — optional `=`, weird escapes — are NOT
  errors; they parse as X3 parses them, and each occurrence is counted in a
  `diagnostics` side-channel so the census can report "this file uses
  reader-only forms".)
- Accepts a whole-file string; ~tens of MB at saxdb scale is fine in memory
  (plan §4: converter runtime is minutes; the bed file is 22 KB).
- Mondo and per-module inputs both land in the same shape:
  `parseDb(text)` returns the top-level `RObject`; a mondo file's sections are
  its entries; a per-module file IS one section's body (caller says which via
  CLI flags — `--db x3.db` for mondo vs `--section NickServ=nickserv.db ...`).

### Serializer contract (`serialize.ts`)

Emits X3-writer conventions: always-quoted, writer escape set only, no `=`,
`;` terminators, complex records indented with tabs / non-complex single-line,
lists `("a", "b")`, blank line between mondo sections. Key-order policy:
`asWritten` (model order — for fidelity tests) or `x3` (irccasecmp sort —
matching what X3 itself would next write). The **round-trip gate** (see
Testing) is semantic: `parse(serialize(parse(f)))` deep-equals `parse(f)`;
byte-identity with X3 output is NOT a goal (the complex/non-complex flag is
per-call-site schema knowledge we don't reproduce), but serializing the live
bed db and re-parsing it must be lossless.

### LDIF reader (`ldif.ts`)

Minimal, spec-correct subset for slapcat/ldapsearch exports: `dn:`/attr lines,
`::` base64 values, line folding (leading space), comment `#`, entry separation
by blank line, multi-valued attrs. Extracts per entry: `dn`, `uid`,
`objectClass[]`, `userPassword[]` (raw bytes + parsed `{SCHEME}` prefix),
`createTimestamp`/`modifyTimestamp` when present. Unknown attributes are kept
in a generic bag (census reports attribute inventory). No LDAP wire protocol,
no binds — file in, records out.

### Census (`census/`)

Input: parsed NickServ/ChanServ/OpServ/... sections + optional LDIF export.
Output: one JSON report + a human-readable rendering. Contents, per the plan's
go/no-go definition (sequencing §4 item 1 + Phase 0):

1. **Credential-state classification** — every NickServ handle into exactly one
   of: `ldap-backed` (uid present in LDIF), `local-hash-only` (parsable
   `passwd`, no LDIF entry), `both`, `neither`. With per-state counts and
   lastseen-activity distribution (buckets: <30d, <180d, <1y, <5y, older,
   never/unparsable) — the "is the dual-format provider needed at all" input.
   Runs without an LDIF too (bed quick-mode): then only `local-hash` vs
   `no-credential` with a clear "no directory export supplied" banner.
2. **Local-hash format split** — `plain-md5` (32 lowercase hex),
   `seeded` (`$`+8hex+32 uppercase hex), `malformed` (anything else, each
   listed). Case-sensitivity discriminators recorded (a lowercase seeded digest
   or uppercase plain digest = anomaly, per the masked-misdetection warning).
3. **Entity counts** — what ships: NickServ handle count (`accounts.total`),
   ChanServ channel/user-record/ban-record totals (`chanserv.{channels,
   userRecords, banRecords}`), and a top-level entry count per section
   (`sections`, "unmodeled sections included" — presence + count only, e.g.
   modcmd/glines/shuns/memos are counted at the top level but not descended
   into). Per-channel notes/lamers and memo-level counts are NOT surfaced —
   they are not broken out anywhere in the report; a later phase would need
   to extend the ChanServ/MemoServ sweep to add them.
4. **Dangling references** — channel `registrar`s and `users`-object keys and
   ban `owner`s that name no NickServ handle (irccasecmp matching); LDIF uids
   with no handle; handles with no LDIF entry (feeds 1).
5. **Anomalies** — duplicate-case keys, reader-only syntax forms used,
   unparsable timestamps, empty sections, sections present that the tool
   doesn't model (named, counted, passed through).

**Go/no-go rule rendered at the top of the report:** zero unexplained records —
every row is classified, quarantine-listed, or on an explicit drop list. The
census itself never modifies anything; it is read-only over copies.

### CLI (`cli.ts`)

```
npx tsx src/cli.ts census --db <x3.db> [--ldif <export.ldif>] [--json out.json]
```

Reserved (stubs that print "phase N — not implemented"): `convert` (parts A–C),
`residual`, `bans` (part D). Exit code 0 = census clean, 2 = anomalies present
(scriptable go/no-go), 1 = parse failure.

## Testing (TDD — suite gates the package)

Vitest, red-first per subsystem:

- **Parser vectors** straight from the grammar report: every escape form (incl.
  `\377`, `\x` bare, unknown-escape-kept), optional `=`, both comment styles,
  empty list/object, single-line and indented layouts, mondo blank-line
  separation, error cases (raw newline in string, missing `;`, name at EOF,
  unterminated comment→EOF tolerance), duplicate-key last-wins + diagnostic,
  case-insensitive lookup (`FOO` vs `foo`, and RFC1459 `[]` ≡ `{}`).
- **Round-trip property**: for every fixture AND a checked-in copy of a
  bed-shaped sample db (synthetic data, real shapes — no real user data in the
  repo), `parse(serialize(parse(x)))` deep-equals `parse(x)`.
- **LDIF vectors**: folding, base64, multi-value, `{SSHA}`/`{SMD5}`/`{CRYPT}`
  prefix parsing, missing userPassword.
- **Census vectors**: tiny synthetic worlds asserting each classification bucket,
  each dangling-ref direction, each hash-format split incl. malformed and the
  case discriminators, and the exit-code contract.
- **Live smoke (manual, not CI-gated):** `census --db` against a fresh copy of
  the bed's `/x3/data/x3.db` must run clean; recorded in the implementation
  report with its numbers (baseline census of the bed).

## Accepted limitations / non-goals (v0)

1. Parts A–D emitters, Keycloak import payloads, hash providers, rehearsal
   tooling: later phases (stubs only). The census is deliberately useful to
   BOTH D1 branches; nothing here commits to import vs federation.
2. No byte-identical re-serialization of X3 output (schema-free tool can't know
   complex flags); lossless semantic round-trip is the gate. Part C (trimmed
   residual db X3 must reload) will need the strict serializer + a reload test
   on the bed — that test belongs to the phase that builds part C.
3. NUL/binary values: unsupported, matching X3 itself; occurrences (via octal
   escapes decoding to control bytes) are census anomalies. Extension found at
   final review 2026-08-06: the CLI reads db/LDIF files as UTF-8
   (`readFileSync(..., 'utf8')`), while X3's own pipeline is byte-agnostic
   (C strings, no encoding). Non-UTF-8 raw bytes — legal input to X3's
   reader/writer — silently decode to U+FFFD (the replacement character)
   under Node's UTF-8 decoder, with no diagnostic. Accepted for the census as
   shipped because the fields it inspects (`passwd` hashes, handles, LDAP
   `uid`s) are ASCII in practice on this bed; but this MUST be revisited
   before part C's residual-db work (candidates: read as latin1/binary and
   re-decode field-by-field, or detect and flag U+FFFD occurrences as an
   anomaly) since a lossy read there could silently corrupt data the
   converter is supposed to preserve byte-for-byte.
4. `${VAR}` interpolation: not parsed (not in X3's recdb.c yet); revisit if the
   env-interp redesign lands (freeze-line item).
5. HelpServ/python/SpamServ section internals are counted, not modeled.

## Scope boundaries

Not this spec: any X3 or nefarious code change; Gate 1 confirmation and D1
ratification (blocked on production facts); the WRITABLE rename/deletion-at-scale
probe (sequencing doc schedules it separately); Keycloak REST of any kind.
