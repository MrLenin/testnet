# Bouncer System Gap Report — Step 5

Synthesis of the design audit. Pulls findings from the step-4 audit docs and reframes them against the design intent into actionable decision material.

**Reads against:**
- [bouncer-design-intent.md](bouncer-design-intent.md) — design intent + 12 invariants
- [bouncer-wire-protocol.md](bouncer-wire-protocol.md) — wire protocol classification
- [bouncer-state-machine.md](bouncer-state-machine.md) — state machine

**Step-4 source docs:**
- [bouncer-audit-cluster-b.md](bouncer-audit-cluster-b.md)
- [bouncer-audit-cluster-c3.md](bouncer-audit-cluster-c3.md)
- [bouncer-audit-kill-semantics.md](bouncer-audit-kill-semantics.md)
- [bouncer-audit-bxm-bxe-bxk.md](bouncer-audit-bxm-bxe-bxk.md)
- [bouncer-audit-flags.md](bouncer-audit-flags.md)

**Not in this report:** code patches. The recommendations are decisions for you to make; implementation follows whichever path you choose.

---

> ## Status note (added 2026-05-05)
>
> A focused **persistence + reconciliation redesign** has been worked through: [bouncer-persistence-redesign.md](bouncer-persistence-redesign.md). It supersedes or absorbs much of this gap report.
>
> **Item disposition under the redesign:**
> - **Tier C:** fully superseded by the redesign (the redesign IS Tier C, with full design detail).
> - **B1** (BX P + N-relay suppression on in-place conversion): **moot** — the in-place conversion path itself goes away under the redesign (held ghosts recognized at restore via persisted alias roster).
> - **B2** (BX J → ride-along on BX C): **folded into** the redesign (F.2 BX C entry, F.3 removal).
> - **A1** (FLAG_KILLED semantic split): **folded into** the redesign (F.5 behavior change; prerequisite for several silent-destroy paths in convergence).
> - **A4, A5, A6** (in-place conversion fixes — ClearBouncerHold, persistence cleanup, umode double-application): **moot** under the redesign for the same reason as B1.
> - **A2, A3, A7**: **still independent**, still actionable. KILL-of-held-ghost-with-aliases (A2), KILL-of-alias-ends-session (A3), revert of f3fb834 (A7) are unrelated to the redesign and can land at any time.
>
> Items below carry these status markers inline.

---

## Headline

The bouncer system has three distinct quality strata:

1. **Sound:** the wire-protocol surface designed in Mar 2 (BX C/X/P/N/U + BS C/A/D/X/U/T), the post-Mar-2 IRCv3 cap-parity additions (BX M/E/K), the revive primitive (`bounce_rebind_ghost_to_remote_primary`), the channel/membership flag machinery (CHFL_ALIAS, CHFL_HOLDING). These need no major reshaping.

2. **Workarounds for under-designed persistence:** cluster B's BX R / BX F / `hs_pending_demote_peer` / active-vs-active demote, plus m_nick's `bxr_says_we_lose` cross-cut, plus the BX C in-place conversion path. **All of these layer coordination protocol onto a problem that wants enriched persistence and deterministic local computation.** Per user 2026-05-04: persistence was rushed in, the multi-server era surfaced reconciliation gotchas, the answer is to "persist smarter, provide more context to properly decide a reconciliatory path."

3. **Small, isolated bugs:** flag mutual-exclusion not enforced on conversion (F1/C2), persistence record orphaned on conversion (C3), KILL semantics partially honored (K1, K2), `FLAG_KILLED` overloaded (K4). These are bounded fixes that don't depend on the persistence redesign.

Two cross-cutting principles surfaced in design dialog clarify the redesign target:

- **Servers hold sessions; they don't own them** (invariant #11). Sessions are network-wide constructs; `hs_origin` and `is_local_session` are conceptual errors that need replacement.
- **Network KILL of any session connection ends the entire session** (invariant #12). Aliases don't survive a KILL of the primary, and a KILL of an alias ends the session too.

## Findings organized by decision shape

### Tier A — Small bounded fixes (no design dependency, can land independently)

These are concrete bugs in localized code paths. Each is small, scoped, and orthogonal to the larger redesign. Suggested order respects dependency:

| # | finding | location | dependency | size | redesign disposition |
|---|---------|----------|------------|------|----------------------|
| **A1** | `FLAG_KILLED` overloading: introduce dedicated flag for bouncer-internal silent-destroy, leave `FLAG_KILLED` strict-network-KILL | `bouncer_session.c:6281`, `:5134`, plus `s_misc.c` exit handlers | none | new flag + replace ~3 SetFlag(FLAG_KILLED) call sites with the new flag + update s_misc.c to gate session-destroy on FLAG_KILLED only | **folded into redesign** (F.5) |
| **A2** | KILL of held ghost while aliases exist: add FLAG_KILLED check in HOLDING branch parallel to ACTIVE branch's check; if set, don't promote — exit aliases, broadcast BS X, destroy session | `s_misc.c:504-513` | A1 must land first | small, parallel to existing ACTIVE-killed branch | **independent** — still actionable |
| **A3** | KILL of an alias ends the session: add FLAG_KILLED check in alias early-return branch; if set, locate session and tear down everything | `s_misc.c:339-352` | A1 must land first | small | **independent** — still actionable |
| **A4** | Mutual-exclusion: `ClearBouncerHold(alias)` at SetBouncerAlias on in-place conversion | `bouncer_session.c:4976` | none | one line | **moot under redesign** (in-place conversion path eliminated) |
| **A5** | Persistence record cleanup on in-place conversion: when converting a held ghost to alias, delete the persisted bsr_* record | `bouncer_session.c:4949-4982` | none | small | **moot under redesign** (in-place conversion path eliminated) |
| **A6** | Verify umode double-application on in-place conversion (`bounce_copy_umodes` followed by `user_apply_umode_str` via shared `track_alias` label) | `bouncer_session.c:4981` | none | code-read + verify-or-fix | **moot under redesign** (in-place conversion path eliminated) |
| **A7** | Revert `f3fb834` (m_join skip-duplicate-JOIN) — user has patched HexChat fork to handle the auto-rejoin race client-side | `m_join.c:354-364` | none | revert one commit | **independent** — still actionable |

These can land any time, in any order respecting A1-before-A2/A3.

**Suggested grouping if doing them together:** A1 → A2 → A3 as a "KILL semantics correctness" series; A4 + A5 + A6 as a "BX C in-place conversion cleanup" series; A7 standalone.

### Tier B — Scoped reshapes (medium surface, deferrable to persistence redesign)

These are larger but still bounded. They could land independently, OR they could be deferred and folded into the bigger redesign.

| # | finding | what it does | dependency | redesign disposition |
|---|---------|--------------|------------|----------------------|
| **B1** | BX C in-place conversion emits **BX P** to legacy peers (not Q) and suppresses the N relay to those peers | Closes the bug from 2026-05-04 reproduction by **renumbering** the held ghost's identity in upstream's view to the new primary's numeric. BX P is the semantically correct signal: the user is the same logical client, only the network-facing numeric changed. Q would generate visible "QUIT" scrollback for an internal renumber event. Caveat: BX P doesn't carry user/host/IP, so if those diverged from the held ghost (user reconnected from different IP), legacy upstream retains stale metadata. Accepted as cosmetic cost — a stable session that doesn't get killed matters more than freshness of host metadata on legacy peers. | none; orthogonal to persistence redesign | **moot under redesign** — in-place conversion path eliminated entirely |
| **B2** | BX J → ride-along on BX C (preserve single-msgid invariant, eliminate separate subcommand) | Moves alias-channel-attach JOIN msgids into BX C's payload (which already carries chanlist), removing the BX J broadcast and eliminating one wire subcommand | none; smaller than persistence redesign | **folded into redesign** (F.2 BX C, F.3) |

**B1** is the targeted fix for the specific collision; consider it the "bandaid" alternative to letting persistence redesign eliminate the in-place conversion path entirely. Implementation: at the BX C in-place conversion site (`bouncer_session.c:4949–4982`), before the relay loop runs, emit `BX P BjAAA ACAAA <sessid> ibutsu` toward legacy (non-IRCv3-aware) peers and suppress relay of the matching `N` to those same peers. IRCv3-aware peers continue to receive both the N (for the new primary's Client struct) and the BX C (for the alias relationship).

**B2** is a clean simplification with a clear migration path (deprecate BX J, add per-channel-msgid carriage to BX C's chanlist param).

### Tier C — Architectural redesign (the big rework)

> **Superseded by [bouncer-persistence-redesign.md](bouncer-persistence-redesign.md)** (decided 2026-05-05). The content below was the audit's "what we should do" pointer; the redesign doc is the "here's how, decided." Treat the redesign doc as the active reference; Tier C below is historical.

This is the cluster B + persistence answer. Step 1's design intent and the audit findings converge on a single recommendation:

**Replace contest-shaped reconciliation with deterministic dedup + roster union, driven by enriched persistence.**

#### What gets eliminated

- BX R reconcile machinery (sender + receiver), or reduced to "I hold this session, here's my roster contribution" emit-once at link
- BX F handshake (synchronous burst gate)
- `hs_pending_demote_peer` field and `bounce_resolve_pending_demotes`
- `bounce_demote_live_primary_to_alias` as a primary-resolution operation
- Anti-ping-pong gate in BX R (no replies in roster-merge model)
- m_nick `bxr_says_we_lose` short-circuit (no contest verdicts to consult)
- BX C in-place conversion path (held ghost recognized at restore as a session-identity slot, not an independent client)
- Pending-BX deferral machinery (alias presence computed from persisted state, not from burst order)

#### What gets reshaped

- `hs_origin` and `is_local_session`: replaced with holding semantics (no ownership concept)
- Session ID: globally unique (UUID / content-hash / server-independent), not server-prefixed counter
- Persisted record (`BounceSessionRecord`): enriched with the data points below
- `bounce_rebind_ghost_to_remote_primary` authorization gate: shifts from `hs_origin` to either session-identity-on-N or BS-C-arrival timing

#### What survives

- BS C/A/D/X/U/T (all six in-design)
- BX C/X/P/N/U (all five in-design)
- BX M/E/K (post-design feature, IRCv3 cap parity)
- The revive primitive (with its authorization gate reshaped)
- Held-ghost dedup as deterministic survivor selection (mechanism similar to BX R's restore-pending branch, framed as dedup not contest)

#### Persistence-record enrichment data points

Aggregating from cluster B + cluster C3 + revive audits:

1. **Per-connection activity** (last_active per primary + per alias, not just session-level)
2. **Alias roster at shutdown** (which servers held which alias numerics) — currently runtime-only
3. **Live-presence state at shutdown** (was the session ACTIVE or HELD at shutdown?)
4. **Globally stable session IDs** (UUID / content-hash, replacing `<server-prefix>-<seq>`)
5. **Last known peer state** (which servers held this session as of last sync)
6. **Per-channel last-action context** (when each membership changed, user-initiated vs. auto)
7. **Origin metadata per state piece** (which server last touched each piece, for tiebreaking)
8. **Per-alias caps stored alongside roster** (currently streamed via BX U)
9. **At-restoration knowledge of alias roster** so server pre-creates placeholders or expects them in burst (eliminates in-place conversion)
10. **Either N carries a session-identity hint OR rebind gating shifts to BS C arrival** (replaces hs_origin-based authorization)

#### Rough sequence for the redesign

1. Specify the enriched record schema (decide each of the 10 data points above).
2. Decide the sessid scheme (UUID? hash? content-derived?).
3. Specify the deterministic-dedup primitive: input = both sides' persisted records + live state, output = converged session.
4. Specify the rebind authorization mechanism (in light of #2 — if sessid is on N, gating becomes simple; if not, deferral is needed).
5. Implement record schema + migration from current schema (data point: BOUNCER_DB_VERSION = 7, so versioning is already in place).
6. Implement deterministic-dedup primitive replacing BX R's contest logic.
7. Remove the now-unused machinery: BX F, hs_pending_demote_peer, active-vs-active demote, m_nick verdict consultation, anti-ping-pong gate, pending-BX deferral, in-place conversion.

Each step is a coherent piece of work. The schema decision (1–4) is the prerequisite; once specified, implementation can follow incrementally.

## Cross-cutting decisions you'll want to make

These shape the redesign but aren't strict prerequisites:

1. **How much to invest in the redesign vs. tier A/B fixes alone.** Tier A + B addresses concrete bugs and one collision-class. Tier C is the architectural cleanup. They're not exclusive — A/B can land while C is being designed.

2. **Whether to keep `hs_origin` as historical metadata** (last-known-managing-server) even after the holding-not-owning principle takes effect. Useful for debugging; not load-bearing for behavior.

3. **Multi-session-per-account future support.** Currently architectural-allowed but not exercised. The redesign should not preclude it; specifically, sessid generation needs to be sequence-friendly enough that one account can hold multiple distinct sessions.

4. **Hold-expiry clock semantics under convergence.** Per design intent: follow the older session. The persisted record should carry the cumulative hold-time accumulator; convergence picks the higher value (older session).

5. **User-initiated channel parts during a netsplit.** Per design intent: respect them if feasible, aspirational. Implementation cost: per-channel last-action metadata tied to (event-was-user-initiated). Worth doing? Best-effort fallback (user re-PARTs after relink) is fine if cost is high.

## Possible future revisit (not in scope now)

**BX P optional trailing metadata fields.** The current BX P wire format is `<old_numeric> <new_numeric> <sessid> <nick>`. Legacy peers' stock BX handler does an in-place numeric swap from `<old>` to `<new>` but doesn't update user/host/IP — meaning legacy peers retain whatever metadata they had for `<old>`. If user/host/IP have changed across the renumber (e.g., user reconnected from a different IP), legacy retains stale metadata.

A backwards-compatible extension would be to permit optional trailing fields: `BX P <old> <new> <sessid> <nick> [<user> <host> <ip>]`. Legacy peers parse only the four required fields and ignore unknown trailing args (standard P10 behavior). Bouncer-aware peers consume the metadata and refresh.

Recorded here as an option, not a recommendation. The metadata staleness is cosmetic; once reconciliation is deterministic and stable (tier C), the user value of fresh metadata on legacy is small. Worth revisiting only if/when stability is solid and there's appetite for further wire-protocol polish.

## Things explicitly NOT in scope of this audit

- **The architectural inversion (sessions-first not connections-first foundation).** Documented in design intent §"Architectural inversion." Fixing it would require a much larger rewrite than the persistence redesign; the convention-enforcement (one-session-per-account guards) currently masks it. Out of scope; tier-C redesign works with the inverted foundation, not against it.

- **Client-facing C2S surface for multi-session selection.** User noted this is out of scope for now; architecture must allow it. Tier C honors that constraint (globally unique session IDs make it possible to expose).

- **Persistence got rushed in.** Not a fixable item. Tier C is the architectural response.

- **Wire-protocol-level shadow remnants.** Shadows were removed 2026-03-07; no remaining surface relevant to this audit.

## Risk assessment

**Tier A (small fixes):** low risk individually. A1 → A2/A3 sequence has the only ordering constraint. Each fix touches a single function or a small number of call sites. Standard verification: build + targeted irctest if applicable.

**Tier B (scoped reshapes):**
- B1 (Q on in-place conversion) is small but interacts with the legacy-peer view of held ghosts. Verification needs a 2-server test with a held ghost and a re-linking flow that triggers the conversion. Same scenario as 2026-05-04 reproduction.
- B2 (BX J → ride-along) is a wire-protocol change. Migration path: emit ride-along msgids on BX C from now on, keep BX J handler as a no-op for backwards compat with peers that still emit it, retire BX J emit. Multi-version deployment story is straightforward.

**Tier C (architectural redesign):** medium-to-high risk because it touches the persistence record format and the BX R / m_nick cross-cut. Mitigations:
- Versioned record (BOUNCER_DB_VERSION) supports migration.
- Deterministic-dedup primitive can be implemented alongside BX R initially (parallel paths during migration), then BX R retired once deterministic dedup is shown correct.
- "Servers hold, don't own" implementation can be incremental: start by treating `hs_origin` as historical metadata only, remove it from authorization paths one by one.

## Where this report stops

This report is decision material, not implementation. Each tier C bullet is a coherent piece of work but specifying the enriched record schema and the deterministic-dedup primitive in implementation-ready detail is its own design task — separate from the audit, requiring its own design dialog.

The audit's job is done at the point of saying *"here is the gap, here is the shape of the fix, here are the choices you have to make."* From here, tier A/B work can proceed if you want concrete fixes now, and tier C design work can proceed in parallel or in sequence as you decide.

If you want to push tier C forward, the natural next step is a focused dialog on **the enriched persistence record schema** (specifying each of the 10 data points). That sets the foundation; everything else in tier C follows from it.
