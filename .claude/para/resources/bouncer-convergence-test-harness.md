# Bouncer convergence test harness

## Problem

Repro cycles for bouncer collision/convergence bugs take hours of manual
work — restart container, reconnect, manually trigger SQUIT, observe with
HexChat, parse logs.  Many recent bugs were timing-dependent and only
showed under specific burst-order races.  Without a deterministic harness
the same bugs re-appear in different shapes.

## Goals

- Express each known scenario as a self-contained test case
- Re-run any scenario in <60s, no manual steps
- Assertion API matches against bouncer state (primary/alias topology,
  faces, channel state) and against client-observed wire output
- Covers post-crash recovery scenarios (mid-rename SIGKILL → restart)

## Non-goals (this harness)

- Full IRCv3 conformance — that's irctest's job
- Replacing the existing `tests/` Vitest suite — this lives alongside it
- Performance benchmarking — separate concern

## Approach (scope #1 from discussion)

Scenario orchestrator built on top of the existing docker-compose stack
and `tests/` Vitest infrastructure.  Each test:

1. Brings up a known topology (uses existing `default` / `linked` / `multi`
   compose profiles or composes its own)
2. Drives client connections via the existing `tests/src/helpers/`
   IRC client helpers
3. Triggers cross-server events programmatically (SQUIT via oper, KILL,
   container kill+restart for crash recovery, etc.)
4. Asserts state via `/CHECK <nick>` parsing on each relevant server
5. Asserts client-observed wire output (numerics, ERROR messages, NICK
   events) via the IRC client helpers' message capture

## Inspection surface

`/CHECK <nick>` already exposes:
- Bouncer Alias:: line (alias-of, alias numeric)
- Bouncer Session:: block — state, sessid, managing server, connection
  count breakdown, hold override, session timing, resume count

What's missing for test assertions:
- Per-alias detail: each alias's full numeric + server + nick + lastnick
  (so we can assert "ACAAA on leaf is an alias, BjAAA on testnet is the
  primary")
- Legacy face records: which peers have a recorded face for this session
  and what numeric the face points to
- Cli_session_id (already emitted at "Session ID:: " line)

Extend `/CHECK` additively — add a new flag `-b` for verbose bouncer
detail that dumps alias list and legacy faces.  No subcommand.  Default
output stays human-readable; `-b` is for harness use.

## Crash injection

Bugs like the recent set_nick_name SIGSEGV trigger only under specific
mid-flow crashes (rename → broadcast → persist).  Need gated debug
feature flags that abort() at known points:

- `FEAT_CRASH_DEBUG_NICK_RENAME_PRE_PERSIST` — abort() after the local
  rename but before MDBX update + broadcast
- `FEAT_CRASH_DEBUG_BURST_MID_N` — abort() N tokens into server_finish_burst
- `FEAT_CRASH_DEBUG_BS_C_PRE_CONVERGE` — abort() before cross-sessid
  rename in BS C handler

These are opt-in features set via /SET (or env var at startup) and only
fire when the value is non-zero.  Default 0 = no crashes.  Test harness
sets one before triggering the scenario.

## Scenarios to cover (initial set)

| # | Scenario | Asserts |
|---|----------|---------|
| 1 | Single user on testnet (bouncer session, no peers) | Primary on testnet, no aliases, session ACTIVE |
| 2 | + Connect alias on leaf | Primary on testnet, alias on leaf, BX C delivered, channel state mirrored |
| 3 | + /nick on alias | Both sides rename, session sessid stable |
| 4 | + SQUIT leaf | Alias goes away cleanly, session stays as primary-only |
| 5 | + Relink leaf | Alias reconstructs OR session converges per design |
| 6 | Same-account collision on link (different nicks, two primaries) | Older lastnick stays primary, newer demotes; one face on legacy peer |
| 7 | Mid-rename crash on testnet → restart → relink | Post-burst reconcile merges; client sees consistent nick |
| 8 | Non-bouncer + bouncer same-account on legacy peer | Both N's reach legacy; both visible as separate users |
| 9 | SQUIT + reconnect → kill via override | Client sees KILL with reason, ERROR :Closing Link |
| 10 | Burst-gate-release while client connects mid-burst | Connection completes, no silent drop |

Start with 1, 2, 3, 6, 7, 8 — they cover the recent regressions.

## Implementation outline

### Phase A: inspection support
- Add `-b` flag handling to m_check.c (a few lines added to the flag
  loop + a new section in the bouncer detail block)
- Emit per-alias detail and legacy_face entries as parseable lines
  (e.g., `Bouncer Alias Detail:: <numeric> on <server> nick <nick> lastnick <ts>`)
- Add parser in `tests/src/helpers/check-parser.ts` that consumes
  `RPL_DATASTR` lines and produces a structured object

### Phase B: orchestrator helpers
- `tests/src/helpers/orchestrator.ts`:
  - `bringUp(profile: 'default' | 'linked' | 'multi')` — async start, wait for healthcheck
  - `connect(server: 'testnet'|'leaf'|'upstream', account?: string)` — IRC client connection helper
  - `forceSquit(server: string)` — exec oper + SQUIT
  - `kill(container: string)` — docker kill, returns when stopped
  - `restart(container: string)` — restart and wait for healthcheck + relink
  - `getState(server: string, nick: string)` — runs /CHECK on the given server, returns parsed object
  - `linkComplete(expectedPeers: string[])` — polls existing commands to detect link + burst state:
  - `/STATS l` — connection roster + "Open since" timer.  Shape:
    ```
    Connection                       SendQ SendM SendKBytes RcveM RcveKBytes :Open since
    leaf.fractalrealities.net        0     55    4          31    1          :616
    upstream.fractalrealities.net    0     26    2          6     0          :35
    ```
    Use to confirm "the connection exists and has been up for at least N seconds".
  - `/MAP` and `/STATS u` — carry the `!` marker on still-bursting peers.
    Per s_serv.c burst-ack flow notes: trailing EA clears the `!` when
    burst-ack lands on both sides.  Use to confirm "past burst, in
    steady state".
  - Poll both at ~250ms intervals; return when all expected peers are
    listed in /STATS l AND no `!` markers in /MAP.

### Phase C: scenario tests
- `tests/src/bouncer/convergence-merge.test.ts` — scenarios 6, 8
- `tests/src/bouncer/crash-recovery.test.ts` — scenario 7
- `tests/src/bouncer/basic-bouncer-lifecycle.test.ts` — scenarios 1-5
- Each scenario: setup → trigger → wait for stability → assert

### Phase D: crash-injection features (only for scenario 7+)
- Add feature flags + abort points in narrow code paths
- Gate at compile time on `--enable-debug-crash-points` (off by default
  in production builds, so production binaries never abort())
- Test sets the feature via `/SET <FLAG> 1` before triggering

## Open questions

1. Should crash-injection require a separate build (--enable-debug-crash-points),
   or runtime feature flag with a `#ifndef NDEBUG` guard?
   - Runtime flag is more convenient for testing; compile gate avoids
     any chance of production crashes.  Prefer runtime + LOG_FATAL
     warning if enabled in production.

2. ~~How does the orchestrator know link is complete?~~  Resolved:
   poll `/STATS l` for connection presence + `/MAP` for absence of `!`
   marker (per nefarious burst-ack flow, `!` clears once both sides
   reach burst-ack steady state).  Both are existing commands, no
   protocol additions or synthetic sync nicks needed.

3. Vitest timeout interaction with docker container startup: containers
   take ~5s to come healthy.  Test suite default timeout is 5s.  Either
   bump timeout per scenario or have a global setUp/tearDown that
   shares one stack across tests in a file.

## Status

- 2026-05-14: plan written
