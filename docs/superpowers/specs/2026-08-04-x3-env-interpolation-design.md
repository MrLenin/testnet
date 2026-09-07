# X3 config env-interpolation — design

**Date:** 2026-08-04
**Status:** approved (design); implementation plan pending
**Scope:** X3 services (`evilnet/x3`), docker config path + recdb parser
**Origin:** Rubin's suggestion to make `.env` the canonical X3 config surface and
retire the `x3.conf-dist` + `dockerentrypoint.sh` sed-substitution layer.

## Goal

Delete the template + `sed` indirection between `.env` and X3's running config.
X3's own config reader expands `${VAR}` / `${VAR:-default}` references from the
process environment at parse time, so:

- `.env` (documented by `.env.example`) is the source of **values**;
- `x3.conf` stays the source of **structure** (its recdb tree, inline docs, and
  arbitrary-cardinality sections);
- bare-metal deployments that never set these env vars are unaffected;
- the config-generation step — and the whole class of "frozen config" bugs it
  created — disappears.

## Background: the current flow

1. `.env` / `.env.local` → `docker compose` injects env vars into the x3
   container.
2. `docker/dockerentrypoint.sh` reads `docker/x3.conf-dist` (a template with
   `%VARIABLE%` placeholders), applies bash defaults (`: "${VAR:=default}"`),
   `sed`-substitutes every placeholder, stamps a generation marker, and writes
   `/x3/data/x3.conf`.
3. X3's `conf_read()` (`src/conf.c`) → the recdb parser (`src/recdb.c`) reads
   `x3.conf`. No `getenv` exists anywhere in the config path today.

The wart Rubin objects to is step 2: a `sed` layer that can silently drop a
variable or mis-escape a value, plus a marker-based regeneration policy that
exists only to stop the generated file from freezing.

## Approach: parse-time `${VAR}` interpolation

X3's recdb parser gains environment interpolation on **quoted string values**.
The `x3.conf-dist` template is retired; the file X3 reads ships with `${VAR}`
references directly and needs no pre-processing.

### Interpolation grammar

A single pure function — `env_interpolate(const char *raw) -> char *` — runs as
a post-dequote pass over each QSTRING value assembled in `parse_qstring()`
(`src/recdb.c`, the quoted-string reader at ~line 370). It applies to **values
only**, never keys or record paths (least astonishment; interpolating structural
keys would be surprising and is unnecessary).

| Syntax | Expansion |
|---|---|
| `${VAR}` | `getenv("VAR")`. **Unset ⇒ fatal** conf-load abort naming the variable, file, and line. |
| `${VAR:-default}` | env value if set and non-empty; otherwise the literal `default` text. |
| `$$` | a literal `$` (so a real `${` in a value is written `$${`). |

Rules:

- References are recognized anywhere in a value, multiple per value, adjacent.
- `$` is special **only** in `$$` and `${`. A lone `$` not followed by `{` or
  `$` is a literal `$` (no error), so existing values containing `$` are safe.
- **Non-recursive:** an expanded value that itself contains `${…}` is left
  literal — the expansion output is not re-scanned. This is an env-injection
  guard (an operator-set value cannot smuggle in a second variable reference).
- Interpolation is independent of recdb's backslash-escape machinery, which has
  already run to produce the dequoted buffer; `$$` is the only escape this layer
  defines, keeping the two layers from interfering.

### Missing-variable behavior (fail loud, fail early)

`${VAR}` with `VAR` unset and no `:-default` aborts config load with a message
of the form:

```
x3.conf:<line>: ${X3_UPLINK_PASSWORD} is unset and has no default
```

X3 never boots a half-configured services daemon. The shipped `x3.conf` uses
`:-default` for every key that has a sane default, and a bare `${VAR}` **only**
for genuinely-required secrets (uplink password, LDAP bind password). A
bare-metal admin with no env set therefore boots on the defaults for the
optional keys and must supply the few required secrets in env or edit them to
literals — the same obligation they already have today.

## File changes

- **`docker/x3.conf-dist` → `docker/x3.conf`.** It stops being a "-dist"
  template (the name currently signals "needs processing," which ceases to be
  true) and becomes the real config X3 reads, with `%VAR%` placeholders
  rewritten as `${VAR:-default}` / `${VAR}` references. While rewriting, flatten
  it as far as it honestly goes: single uplink, no dead branches — the operator
  should see a simple file (see the concession in *Considered and rejected*).
- **`docker/dockerentrypoint.sh`.** The entire `%VAR%` substitution loop and the
  generation-marker policy are deleted. Its only remaining responsibility is
  selecting which config X3 reads:
  - a user-supplied `/x3/data/x3.conf` (volume-mounted) wins and is used as-is;
  - otherwise X3 reads the image-shipped `docker/x3.conf` directly.
  Because interpolation happens at read time on the static shipped file, there
  is nothing to generate, nothing to stamp, and nothing to keep in sync.
- **`.env.example`.** Purpose unchanged — it documents every variable — but it is
  now genuinely canonical: the variables it lists are exactly the ones the
  shipped `x3.conf`'s `${…}` references consume, and it is the surface an
  operator edits. The `:-default`s in `x3.conf` mean `.env.example` can show
  recommended production values while the file itself carries the fallbacks.

## Bug class eliminated

Today the marker-based regeneration exists solely to defeat config freezing: a
volume-persisted generated `x3.conf` would otherwise be produced once at first
container start and never reflect later env changes (the documented stale-conf
trap). With interpolation there is **no generation step**: the static
`x3.conf` re-expands from the *current* environment on every boot, so env
changes always take effect on restart and the frozen-config failure mode is
gone. No marker, no regeneration policy, no user-managed-vs-generated
detection.

## Error handling

- Unset-and-no-default ⇒ fatal abort at conf load, message names the variable +
  source location (above).
- Unterminated `${` (no closing `}`) ⇒ fatal parse error, message names the file
  + line.
- All other values (including those with literal `$`) parse unchanged from
  today.

## Testing

- **Unit (cmocka).** `env_interpolate` is pure and self-contained, so it gates in
  the build:
  - plain `${VAR}` set and unset;
  - `${VAR:-default}` with the variable set, unset, and set-but-empty;
  - `$$` → literal `$`; `$${VAR}` → literal `${VAR}`;
  - multiple and adjacent references in one value;
  - lone `$` left literal;
  - unterminated `${` → error;
  - unset-with-no-default → the fatal path (exercised via a return-code variant
    so the test can assert the error rather than exit the process).
- **Integration.** A docker boot smoke test: X3 comes up and links to the ircd
  driven only by `.env` (no hand-written `x3.conf`). The testnet's existing X3
  E2E suite then exercises the booted configuration end to end.

## Scope boundaries

- **X3 only.** The Nefarious IRCd uses the identical
  `base.conf-dist` + `%VAR%` sed pattern in its own docker entrypoint and is the
  obvious next candidate for the same treatment, but that is a **separate**
  spec and PR — deliberately not bundled here, to keep this change reviewable
  for upstream and to avoid coupling two submodules' release cadences.
- **Not touched:** X3's config *semantics*, the recdb format, the meaning of any
  existing key, and the non-docker (bare-metal, hand-written `x3.conf`) path
  beyond the fact that `${…}` now expands in quoted values there too (a no-op
  for any value that contains none).

## Considered and rejected: env-only, no `x3.conf`

Rubin's stronger form — run the whole config off env vars and stop reading
`x3.conf` entirely — was weighed and rejected. Two measured facts about the X3
tree drive the call, and one point of Rubin's is conceded up front.

**Conceded: the config's external flexibility is mostly unused ballast.** Nobody
runs more than one uplink; much of the recdb tree's cardinality exists because
its designers didn't cut complexity. The shipped `x3.conf` should therefore be
as flat as it honestly can be — a single uplink, no dead branches — so the file
an operator actually sees is simple. The rejection below is about cost, not
about defending the tree's design.

1. **recdb is not just the config format — it is X3's database format.**
   `database_get` has ~491 call sites; recdb serializes `x3.db` and every saxdb
   write. The parser is load-bearing for persistence regardless of what config
   does, so keeping config in recdb costs zero extra — it reuses a parser X3
   cannot remove short of rewriting its entire on-disk layer (a separate
   project; the fork's LMDB-based saxdb replacement proves the seam exists but
   was a convenience pick, not a destination).

2. **The config tree is internal API with ~145 consumers.**
   `conf_get_data("services/chanserv/…")`-style path lookups appear ~145 times
   across 27 files, plus ~24 `conf_register` reload callbacks. That internal
   tree stays no matter where values come from. Env-only does not remove it —
   it would rebuild the same tree in C from env, which means baking the
   structure into the binary (recompile to add a log target or second uplink)
   or inventing an index-encoding convention (`X3_UPLINK_0_ADDRESS`, …) for the
   residual list-shaped keys (`uplinks`, `logs`, `dbs`, the `valid_*_regex`
   family). Both are worse operability than a file, and a docker-only env path
   forks two config systems that drift while breaking no less than the
   bare-metal networks that run off hand-written, commented `x3.conf` files.

3. **Interpolation captures the actual goal at a fraction of the cost.** What
   Rubin wants gone is the `sed`/template middle layer and the friction of
   `.env` not being canonical. Parse-time `${VAR}` interpolation deletes both —
   `.env` becomes the value surface, `.env.example` "the thing" — via a ~50-line
   pure function on a parser that is staying anyway, keeping the file's inline
   docs, the escape hatch for the genuinely list-shaped keys, and bare-metal
   compatibility. If specific hot keys later warrant being env-native with no
   file entry at all, a per-setting env fallback in `conf_get_data` can layer
   on top incrementally; it is not needed now (YAGNI).

**Relationship to the services-integration direction.** The long-term direction
(fold services into the ircd — `project_x3_nefarious_merge`; Rubin has endorsed
the same instinct, X3 being a link SPOF) would eventually moot X3's config
loading entirely. This refactor is deliberately low-regret against that future:
one day of work, no new entrenchment of recdb (which persistence keeps alive
regardless), and X3-as-is must keep running for the entire duration of any
integration effort.

## Open follow-ups (out of scope here)

- The identical refactor for the Nefarious IRCd docker config
  (`base.conf-dist` + entrypoint sed) — separate spec/PR.
- Optional per-setting env fallback in `conf_get_data` for a small set of hot
  keys — only if a concrete need appears.
