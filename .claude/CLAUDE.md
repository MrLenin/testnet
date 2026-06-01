# CLAUDE.md

Always-loaded guidance for Claude sessions in this repo. Reference material lives in `.claude/skills/` (see inventory below); per-incident project knowledge lives in personal memory; durable plans/areas/resources/archives live in `.claude/para/` (`.claude/plans` is a symlink to `para/projects`).

## Guiding principle

**Simpler isn't always better. Think it through. Aim for correct.**

Don't reach for quick fixes (timeouts, delays, retries) when the real problem is architectural. If a plan exists, finish implementing it properly rather than patching symptoms. Ask clarifying questions instead of making assumptions.

Delegate large/complex/difficult tasks to the right agent (see inventory below). When you learn something durable about the project, add it to the appropriate skill — or create one.

## Project overview

Afternet Testnet — Docker-orchestrated IRC test environment running Nefarious IRCd + X3 services + Keycloak. Supports single-server, 2-server (linked) and 4-server (multi) topologies plus an unmodified-upstream comparison slot. Used for IRCv3.2+ fork development against evilnet/nefarious2 with Keycloak-backed SASL.

## Submodules

| Path | Upstream | Purpose |
|---|---|---|
| `nefarious` | evilnet/nefarious2 (fork on MrLenin/nefarious2) | The IRCd we develop. Ships from MrLenin → upstream |
| `nefarious-upstream` | evilnet/nefarious2 master | Unmodified upstream for legacy-vs-fork comparison testing |
| `x3` | evilnet/x3 | Services (AuthServ / ChanServ / OpServ) with Keycloak/SASL/LDAP additions |
| `libkc` | evilnet/libkc | Hand-rolled Keycloak adapter library (HTTP server + REST client + ops abstraction) |
| `keycloak-webhook-spi` | evilnet/keycloak-webhook-spi | Java SPI bundled into Keycloak for outbound webhook events |
| `linesync-data` | MrLenin/gitsync-test | Test data for the gitsync (libgit2-based config distribution) feature |
| `nefarious-rs` | MrLenin/nefarious-rs | Rust IRCd rewrite (parallel exploration, not part of the production path) |

Submodule basics:

```bash
git submodule update --init --recursive          # initial checkout
git submodule update --remote --merge            # update one or all to latest remote
cd nefarious && git checkout -b feature-branch   # work in a submodule
# commit + push inside the submodule
cd .. && git add nefarious && git commit         # parent records the new submodule pointer
```

## Build & run

```bash
# Basic (nefarious + x3 + keycloak), default profile
scripts/dc.sh up -d

# Linked (adds nefarious2 for 2-server testing)
scripts/dc.sh -l up -d

# Multi (linked + nefarious3 + nefarious4)
scripts/dc.sh -l --profile multi up -d

# View logs
scripts/dc.sh logs -f nefarious
scripts/dc.sh logs x3

# Stop all
scripts/dc.sh -l --profile multi down
```

**Rebuilding IS allowed** — use `scripts/dc.sh` (or your `dc`/`dcl` shell aliases), which sources `.env` and `.env.local`. Batch edits before rebuilding rather than rebuilding per change. **Avoid raw `docker compose build`** — it skips `.env.local` and breaks the libkc overlay. See the `service-debugging` skill for the container topology that the rebuild has to wake up cleanly (esp. `pdns-recursor`, which several services depend on transitively).

## Testing rules

Tests live in `tests/` and run under Vitest.

- **DO NOT run the full test suite** (`npm test` with no filter) — takes 5+ minutes and produces noise that drowns the signal.
- Targeted runs are cheap and free to use: `IRC_HOST=localhost npm test -- src/path/to/test.ts`. Prefer background mode for interactivity.
- For quick command-line IRC pokes that aren't full tests, `scripts/irc-test.sh` is fine.
- Writing tests — see the `test-writing` skill for Vitest patterns, the X3 client helpers (`createOperClient` / `createX3Client`), CMocka conventions, and the divergent-behavior documentation pattern.

## Skills & agents inventory

Always reach for these before re-deriving from scratch:

### Skills (`.claude/skills/`)
- **bouncer-architecture** — session/alias model, hard invariants, burst/convergence, hold/revive paths. Read before any `bounce_*` change.
- **nefarious-codebase** — Client/Connection accessors, `ircd_strncpy` strlcpy semantics + audit rule, libkc/curl_multi event adapter, config block ordering, build/test workflow.
- **p10-protocol** — full P10 token reference (TOK_NICK, TOK_BURST, MD/MDQ, MR, TG, SASL, BS/BX, CI), message format, IP encoding (IPv4 6-char base64 / IPv6 with `_` zero compression), numeric format.
- **sasl-keycloak** — local SASL via Keycloak ROPC through libkc, three-tier AUTHENTICATE dispatch, mechanism support matrix, cross-server cache coherence (CI token), Keycloak REST gotchas.
- **service-debugging** — runtime topology (container IPs/ports, who depends on whom), log correlation across services, common failure modes.
- **test-writing** — Vitest patterns, X3 client helpers, CMocka conventions, retry/timeout norms.
- **x3-services** — service-bot reference (AuthServ/ChanServ/OpServ), olevel + channel-access scales, common commands.

The submodules carry their own per-repo `.claude/`:
- `nefarious/.claude/` — bouncer-architecture, nefarious-codebase, sasl-keycloak, p10-protocol skills + bouncer-analyst, c-auditor, p10-log-tracer agents.
- `x3/.claude/` — p10-protocol skill (only). X3-internal architecture references are sparser; the testnet `x3-services` skill is the practical reference for now.

### Agents (`.claude/agents/`)
- **bouncer-analyst** — read-only bouncer race/invariant analysis. Use for hard bouncer bugs, design questions, or auditing a proposed bouncer change against the invariants.
- **c-auditor** — codebase-wide C pattern sweeps. Use for "find every call site that does X wrong" audits (e.g. the `ircd_strncpy` truncation sweep, accessor-misuse sweep, `hs_client` sweep coverage audit).
- **p10-log-tracer** — parse P10 wire logs and reconstruct command flow across servers/clients.
- **test-triage** — diagnose a failing/flaky test without running the suite; reads test + relevant server code + logs and reports root cause + fix.

## Reference documentation

- `P10_PROTOCOL_REFERENCE.md` — comprehensive P10 S2S protocol reference (longer-form than the skill).
- `FEATURE_FLAGS_CONFIG.md` — all IRCv3 feature flags, capability enums, X3 config options, Keycloak integration, metadata/compression settings.
- `docs/investigations/` — IRCv3 capability investigation results.
- `.claude/para/projects/` — durable per-project plans (`.claude/plans/` is a symlink here).

## Active development context

The fork's `ircv3.2-upgrade` branch is where current IRCv3 work lands. Both submodules track custom forks with enhancements:

- **Nefarious** — full IRCv3.2+ stack (CAP, SASL, chathistory, metadata, multiline, redaction, read-marker, etc.), RocksDB-backed storage (chathistory, metadata, bouncer-session, multiline), libkc/Keycloak SASL.
- **X3** — Keycloak/SASL integration, LDAP federation, saxdb persistence, P10 protocol extensions.

Per-incident project knowledge — the live state of "what bug bit us yesterday, what's deferred, what's an open blocker" — lives in personal memory at `~/.claude/projects/-home-ibutsu-testnet/memory/MEMORY.md`. Cross-reference it when assumptions stale.
