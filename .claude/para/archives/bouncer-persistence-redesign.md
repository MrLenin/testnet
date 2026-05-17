# Bouncer Persistence + Reconciliation Redesign

**Status:** Design dialog in progress, started 2026-05-05. Reads against [bouncer-design-intent.md](bouncer-design-intent.md), [bouncer-gap-report.md](bouncer-gap-report.md).

**Goal:** Replace contest-shaped reconciliation with deterministic dedup + roster union, driven by enriched persistence. Eliminates cluster B's coordination protocol surface (BX R/F machinery, hs_pending_demote_peer, active-vs-active demote, m_nick BX-R verdict cross-cut, BX C in-place conversion, pending-BX deferral) while preserving the in-design wire protocol surface and the post-design IRCv3-cap-parity additions.

**Method:** structured design dialog. Each section below holds a foundational decision. Decisions are captured as the user makes them; implementation follows the schema, not the dialog.

**Out of scope of this redesign:** anything in the gap report's "Things explicitly NOT in scope" section (architectural inversion, C2S multi-session surface, etc.).

## Design surface

Seven areas need decisions, roughly dependency-ordered:

### A — Identity scheme
- Sessid format (current: `<server-prefix>-<seq>`; target: globally unique)
- Identity stability across restarts, relinks, and partitions
- Whether identity is carried on the wire (N, BS, BX subcommands) and where

### B — Persistence content
- Per-session fields (what survives shutdown)
- Per-connection fields (per primary, per alias)
- Per-channel-membership fields
- Versioning / migration from current `BOUNCER_DB_VERSION = 7`

### C — Holding semantics implementation
- What replaces `hs_origin` (or whether it's retained as historical metadata only)
- What replaces `is_local_session`
- How "this server holds this session" is determined locally vs. inferred from peer state

### D — Convergence operation
- Inputs: both sides' views (persisted + live)
- Output: a single converged view
- When it runs: link establishment, on demand, periodic
- Behavior for equal-state vs. divergent state vs. one-side-newer

### E — Specific reconciliation cases
- Two held ghosts (same session, both servers restored from persistence)
- One held ghost + one active (active wins per design intent)
- Two active (roster union; both contribute connections)
- Restoration after a single restart (no peer state to compare against)

### F — Wire protocol changes
- What survives unchanged (BS C/A/D/X/U/T, BX C/X/P/N/U, BX M/E/K)
- What gets removed (BX R, BX F machinery)
- What changes form (any modifications to surviving subcommands; e.g., does N carry a session-identity hint?)

### G — Migration path from current code
- How to ship the enriched schema with backward compat for existing on-disk records
- How to retire old machinery without breaking running deployments
- Verification strategy (test cases, especially for the failure modes that motivated cluster B)

---

## A — Identity scheme

(Decisions captured here as dialog proceeds.)

### A.1 — Sessid format

**Current:** `<2-char-server-prefix>-<seq>`, e.g., `Bj-2`, `AC-3`. Bakes server identity into the ID. Two servers minting sessions for the same account during a partition produce different sessids by construction — directly causing the cross-sessid split-brain case.

**Target (per design intent invariant #11):** server-independent global identifier.

**Options:**

1. **UUID v4 (random).** Simple, no coordination needed, collision probability negligible. Requires the persisted record to carry the full UUID; might be longer on the wire than current sessids. Easy to audit (any non-UUID sessid is legacy).
2. **UUID v7 (timestamp-prefixed).** Sortable, carries embedded creation time. Slightly more useful for ordering / debugging than v4. Same wire-format cost.
3. **Content hash** (e.g., HMAC over `account || creation_time_us || some_fixed_secret`). Deterministic given same inputs, but if two servers independently mint a session for the same account at different times, they get different sessids — which is correct per design intent (different sessids ARE different sessions when the user reconnects to two servers without coordination).
4. **Content hash with truncation** for shorter wire encoding. Adds collision risk; probably not worth the wire savings.
5. **Random string of N base64 chars.** Like a token. Less universally recognizable than UUID but cheaper.

**Open decisions:**
- Which scheme?
- If UUID, v4 or v7?
- Is wire-encoding length a concern?

**DECIDED 2026-05-05:** UUID v7. Sortable, embedded creation time (useful for debugging and tiebreakers), no coordination needed. Wire-encoding length not a concern at network scale; ~36 chars hex with dashes (or ~22 chars base64) is manageable.

Implementation note: collision probability for UUID v7 is dominated by the random component (74 bits of entropy after the timestamp). Negligible at any realistic network scale. The timestamp prefix doubles as a useful "session age" signal for debugging without needing to inspect the persisted record.

### A.2 — Identity on the wire

**Question:** does `N` (NICK) carry a session-identity hint, or is session-identity carried only via `BS C / BS A`?

Bears on the rebind authorization gate (cluster B audit's revive-primitive finding). If N carries sessid, gating is simple: rebind only if local ghost's sessid matches incoming N's sessid. If N doesn't carry sessid, rebind has to either (a) trust account-match and let later BS C disambiguate, or (b) defer rebind decision until BS C arrives.

**Tradeoffs:**

- **N carries sessid hint:** wire-format change to N, slight bytes-on-wire cost, but simpler logic. Compatible with legacy: trailing optional field.
- **N doesn't carry sessid; rebind defers to BS C:** no N format change. Rebind window opens on N (mark "this client might be a rebind candidate"), closes on BS C arrival (confirm match or reject). Means rebind isn't strictly atomic at N-time.

**DECIDED 2026-05-05:** Yes, N carries sessid — **but only when emitted to bouncer-aware peers**, stripped for legacy. Same split-delivery pattern as the existing IPv6/non-IPv6 split in `sendcmdto_flag_serv_butone`: emit two buffer variants per peer class.

Rationale: rebind authorization becomes simple atomic at N-time (no deferral logic, no "rebind candidate window"); legacy peers don't pay the bytes-on-wire cost or see bouncer-internal information. Reinforces the "BX P only on legacy" contract — sessid is bouncer-aware information by construction.

Implementation note: when this lands, the rebind primitive's authorization gate (currently leans on `hs_origin`) becomes "rebind only if local ghost's persisted sessid matches the incoming N's sessid hint." Drops the cluster-B-flavored split-brain consultation entirely.

### A.3 — Multi-session future support

**Per design intent:** architecture must allow multiple sessions per account, even if not exposed today.

**Question:** does this redesign actively build out the multi-session-per-account framework (so when C2S surface lands later, the wire/persistence already supports it), or just stay neutral (don't preclude, but don't actively support either)?

The decision shapes how prominently `(account, sessid)` is treated as the identity tuple vs. how often code falls back to "one session per account" lookups. Currently a lot of code does `bounce_get_session(client)` which returns the first session for the account — implicit single-session assumption.

**Open decision** (lean toward "stay neutral, just don't preclude" unless there's appetite for the bigger framework lift).

**DECIDED 2026-05-05:** Stay neutral. Don't actively build out the multi-session framework, don't refactor existing single-session lookups as drive-by cleanup. But don't preclude multi-session either.

Captured as a prominent project memory: [`project_bouncer_multi_session_neutral.md`](../../.claude/projects/-home-ibutsu-testnet/memory/project_bouncer_multi_session_neutral.md). Hard rule for new code: key bouncer-session lookups on `(account, sessid)`, not `account` alone. Sessids are now globally unique (UUID v7 per A.1), so the discriminator is meaningful and stable.

Existing call sites of `bounce_get_session(client)` etc. are accepted as-is — refactoring them is separate work for when C2S multi-session surface lands.

---

## B — Persistence content

Decided 2026-05-05. Six sub-decisions; "yes" on B.1, B.2, B.6 (the coupled set covering activity granularity, alias-roster persistence, per-alias caps); "skip" on B.3, B.4, B.5, B.7.

### B.1 — Per-connection `last_active`

**DECIDED: yes, split.** Session-level `hs_last_active` becomes per-primary `last_active` plus per-alias `last_active`. Tiebreaking under deterministic dedup uses per-connection granularity ("most-active connection" not "most-active session"). Cost negligible; alignment with design intent's "oldest and most-active connection" preference for primary identity post-convergence.

### B.2 — Persist alias roster

**DECIDED: yes.** `hs_aliases[]` becomes part of the persisted record. Eliminates BX C in-place conversion path (the C3 cluster's main accretion) — at restore, server knows "this session expects aliases on these servers with these caps," so burst BX C arrives matching expectations rather than triggering convert-in-place.

Each persisted alias entry: `numeric` (5 chars), `server_yxx` (2 chars), `last_active` (per B.1), `caps` (per B.6).

Important nuance: persisted aliases are *stale at restore* (each alias's TCP socket died with the process if local; remote-server aliases may or may not be alive). The persisted record is **expectations to be confirmed via peer burst**, not authoritative live state. Restoration logic must distinguish "ours, dead with us" from "remote, possibly still alive — confirm via burst."

### B.3 — Live-presence state at shutdown (ACTIVE vs HELD)

**DECIDED: skip.** Derivable from `hs_disconnect_time` (0 = ACTIVE) plus alias-roster presence (B.2). No separate field. Make it explicit later if a derivation case turns out awkward.

### B.4 — Per-channel last-action context

**DECIDED: skip for now.** Aspirational feature ("respect user-initiated parts during netsplit"). Not load-bearing. Add fields in v9 if/when the feature becomes a priority. `BOUNCER_DB_VERSION` versioning supports this.

### B.5 — Last known peer state list

**DECIDED: skip.** Redundant with B.2 — the alias roster already names the servers that hold this session. Timestamp aspect is debug-only and reconstructable from logs.

### B.6 — Persist per-alias caps

**DECIDED: yes.** Per-alias `caps` field stored alongside alias roster entry (B.2). Allows post-restart reconciliation to know each alias's caps without waiting for BX U from peer; eliminates one source of pending-BX deferral. Stale-cap risk bounded — peers re-emit BX U on link establishment anyway, persisted value is a starting point.

### B.7 — Origin metadata per state piece

**DECIDED: skip.** Over-engineering. Per-connection `last_active` + per-alias `last_active` + per-alias `caps` cover the practical tiebreaks. Per-field provenance adds complexity without clear benefit at our scale.

### Schema delta summary

Changes from current `BounceSessionRecord` (v7) to v8:

- New per-primary field: `bsr_primary_last_active`. (Currently `bsr_last_active` is session-level — repurpose it for "session as a whole" or rename and split.)
- Replace runtime-only `hs_aliases[]` with persisted `bsr_aliases[]`, each entry: `{ numeric[5], server_yxx[2], last_active, caps }`. Bounded by `BOUNCER_MAX_ALIASES`.
- New: `bsr_sessid` becomes UUID v7 format (per A.1) — schema migration concern (G).

Other v7 fields (timestamps, identity, channel memberships, history) carry forward unchanged.

## C — Holding semantics implementation

Decided 2026-05-05.

### C.1 — Fate of `hs_origin`

**DECIDED: keep as historical metadata only.** Field stays in the persisted record (`bsr_origin`) and runtime struct (`hs_origin`) for debugging and audit, but **no code path uses it for authorization or behavior**. Comment in the struct definition makes this explicit ("historical only — do not gate behavior on this"). Existing persisted records keep their `bsr_origin` value forward-compat through the schema migration; new records record the creating server's numeric for audit value.

### C.2 — Replace `is_local_session`

**DECIDED: replace with new function `session_has_local_holder()`.** Answers a runtime-state question — "does this server currently have a Client* (primary, held ghost, or alias) for this session?" — based on actual local state, not persisted attribute. Old `is_local_session` removed. Each call site has to update to the new name, which forces a small audit at each site to confirm what it's actually asking.

### C.3 — Communicate holding to peers

**DECIDED: extend BS A to carry per-alias `last_active` + `caps`.** Reuses existing burst flow (BS C for session-level info, BS A for per-alias info). Each side bursts its sessions normally; the receiving side has the full picture by EOB. No new subcommand needed. BX U (caps update) continues to handle runtime cap changes after burst.

## D — Convergence operation

Decided 2026-05-05.

### D.1 — When does convergence run?

**DECIDED: at-N-time per session, in m_nick.** Original framing of "EOB convergence" was wrong — P10's standard collision logic fires at-N-time (when an incoming N for an existing nick arrives), not at EOB. Waiting until EOB means P10 has already killed one or both colliding clients before convergence has a chance to fire.

The resolution mechanism: m_nick recognizes "incoming N has bouncer-relevant context" via the sessid hint on N (per A.2, present on bouncer-aware paths) or account-match fallback (when sessid was stripped by an intervening legacy peer). When recognized, m_nick applies the convergence rule for the local state vs. incoming, **before** standard P10 collision fires:
- Local has held ghost + incoming is for same session → silently destroy ghost via bouncer-internal flag, accept incoming as fresh client (E.2 case).
- Local has live primary + incoming is for same session → run D.2 election; loser side demotes its primary to alias, winner side accepts the new alias (E.3 case). At-N-time, not EOB.
- Local has held ghost + incoming is also a held ghost (same session) → run held-ghost dedup; loser silently destroys local ghost, accepts incoming (E.1 case).

EOB itself isn't a special trigger; it's just the point at which all session-related burst activity has settled. There's no separate EOB pass.

This is roughly what the existing code does in m_nick (rebind primitive, the various split-merge branches), just with cleaner inputs (sessid hint as the discriminator instead of the BX R verdict cross-cut). The cross-cutting between m_nick and bouncer state remains — but it's a clean, bounded interface rather than the cluster-B verdict-consultation tangle.

### D.2 — Tiebreaker rules

**DECIDED.**

For **primary identity post-convergence** (among the **live** connections in the converged roster — held ghosts do not compete; they're placeholders, not connections):

1. **Oldest** `cli_firsttime` wins. Stability over churn — established connection stays primary.
2. Tiebreaker: highest `last_active` (most recent engagement).
3. Tiebreaker on tiebreaker: lex on numeric (deterministic — both sides compute the same answer).

Rationale for oldest-first lead: stability, consistency with existing `bounce_promote_alias` logic, and design intent's "oldest and most-active" reads as a conjunction valued together — oldest-first honors the established connection while most-active disambiguates ties.

For **which held-ghost record survives** (when both sides have held ghosts and no live connection elsewhere):

1. Highest `last_active` wins (the ghost with most-recent-prior-activity is closest to the user's last-known-state).
2. Tiebreaker: lex on numeric.

Note: `cli_firsttime` for a ghost is "boot time" on restoration — not meaningful — so ghost-dedup uses different tiebreakers than live-connection promotion.

For **channel mode bits** on overlapping memberships: surviving primary's view wins (the primary is authoritative for the session's network presence).

For **hold-expiry clock**: max of accumulated time. Older session "wins" — accumulated hold time is something the user has earned by use; convergence shouldn't reset that (per design intent §"Convergence semantics — hold-expiry clock").

### D.3 — Wire signal during convergence

**DECIDED: no coordination protocol.** Each side computes convergence locally from data it already has (its own state + peer's bursted state). If the result requires action — primary swap, ghost destroy, alias-roster update — the side taking action emits the action's normal wire signal (BX P for primary swap, BS X for session destroy, etc.). **No BX R, no BX F, no equivalent reconcile-handshake.**

This eliminates cluster B's coordination protocol surface entirely. Determinism is the contract: same inputs + same algorithm → same answer on both sides. If determinism is wrong, the system breaks subtly — that's a strong incentive for both sides to be careful, and a clean failure mode (verifiable by log analysis if needed).

Optional debug-build addition: emit a "convergence verdict for session X = primary Y, aliases Z" log line at INFO level; log analysis on disagreements catches determinism bugs. Pure logging, not protocol — separate decision from D.3 itself.

## E — Specific reconciliation cases

Walkthroughs applying the D rules to canonical scenarios. Each trace confirms the rules produce a coherent outcome.

**Action-emission convention:** convergence is computed identically on both sides (determinism). Each side independently determines "did I win or lose" for any given decision, and the **loser side** takes the action and emits the wire signal (BX P, BS X, BX C, etc.). The winner side does nothing — its local state is already correct.

**Resolution timing:** at-N-time per case (per D.1). Each case below describes resolution as it happens when the relevant N arrives, not at EOB.

### E.1 — Two held ghosts (same `(account, sessid)`, both restored, no live connections anywhere)

**Setup:**
- Server A: held ghost `AAxxx`, persisted `last_active = T_A`, hold accumulator `H_A`, persisted channels `C_A`
- Server B: held ghost `BBxxx`, persisted `last_active = T_B`, hold accumulator `H_B`, persisted channels `C_B`
- Same `(account, sessid)` (per A.1 — globally unique sessid means same identity)

**At EOB, both sides compute:**
- Live connections in roster: none → this is the "held-ghost dedup" case (D.2 second tiebreaker rule).
- Survivor: highest `last_active`. Suppose `T_A > T_B` → **A's ghost survives**.
- Lex tiebreaker on equal `T`: lex on numeric.

**Outcome:**
- **Server A:** keeps its ghost `AAxxx` as the network-facing representation; keeps session record; no action emitted.
- **Server B:** silently destroys its ghost `BBxxx` locally (no Q broadcast — it's purely internal cleanup, use the dedicated bouncer-internal silent-destroy flag from gap report A1); updates its session record to reflect "ghost is on A" (essentially becomes a remote-replica record).
- **Network:** single `ibutsu` nick-holder, on A. No visible event.

**Hold-clock reconciliation:** both records were persisted with their accumulators `H_A` and `H_B`. After convergence, **both A and B keep their hold timers running** with the reconciled accumulator `max(H_A, H_B)`. Whichever timer fires first triggers `BS X` network-wide cleanup. (Cancelling the loser's timer would create a time bomb: if A SQUITs before its timer fires, B's record sits forever.)

**Discipline that prevents zombie-ghost time bombs:**

> **Ghosts may be (re-)created at boot-time restoration, user reconnect, OR runtime via deterministic election in response to ghost-holder SQUIT. No other runtime auto-creation paths are permitted.**

Without this discipline, any holder could spontaneously create a new local ghost in response to peer-state changes, causing reappearing-ghost surprises and multi-ghost collisions. With it, the legitimate creation paths are bounded and each one is wire-consistent.

**The SQUIT-election path** addresses chathistory presence continuity. When the ghost-holder (A) SQUITs, the network would otherwise lose the nick-claim entirely — and "held = nick is claimed" is a design-intent invariant. The election picks the next-in-line holder to take over the ghost role, and uses **BX P** as the wire signal — a pure in-place numeric swap, wire-invisible to channel members.

**Mechanism (BX P-on-SQUIT):**

P10 networks are trees. SQUIT of a non-leaf partitions the tree; within each post-SQUIT partition, the propagation is deterministic. The elected successor (in each partition) emits BX P **before** the SQUIT-induced exit cleanup propagates, so peers process the renumber before they would have processed Q for the ghost.

Stock legacy BX P updates `cli_user(client)->server` ([nefarious-upstream/ircd/m_bouncer_transfer.c:132](../../nefarious-upstream/ircd/m_bouncer_transfer.c#L132)), so after the renumber the ghost's home-server pointer correctly points at the successor. SQUIT cleanup walks A's clients (those with `cli_user(...)->server == A`); the renumbered ghost no longer matches that filter and is left intact.

**Election rule:** lowest YY among the remaining holders wins. To keep the BX P-before-SQUIT ordering deterministic, the BX P emission is performed by **the server that detected A's link drop** (S_A — the server adjacent to A that originated the SQUIT for its partition). S_A computes the same election result that every peer computes independently (lowest YY among holders), constructs the new ghost numeric in the elected successor's namespace, and emits BX P to its downlinks BEFORE forwarding/broadcasting the SQUIT. If S_A itself is the elected successor, no special-casing — same emission order applies.

This places the BX P emission at the natural origin point of the partition's SQUIT propagation, guaranteeing BX P arrives at every peer in the partition before SQUIT does.

**Cross-partition behavior:** P10 SQUIT of a non-leaf partitions the tree. Each partition runs this election independently and reaches its own (deterministic) result. If the originally-elected successor is in a different partition than some peer X, X's partition runs its own election among holders in X's partition. When the partitions later heal (some new link forms), convergence (D.1) handles the merge — both partitions had ghosts; one wins per E.1 rules.

**Deterministic by construction within each partition** — no coordination message needed. Both sides of any link in the partition agree on the election result; S_A is the natural emission point.

**Wire-invisible to channel members within the partition.** BX P is an in-place numeric swap — channels see no JOIN, no QUIT, just the user's numeric quietly updating in their NAMES list. Chathistory presence continues uninterrupted via the renumbered ghost on the successor.

**Edge case:** if the lowest-YY holder also SQUITs (cascading server failures), each fresh SQUIT runs a new election with the updated holder set. Same mechanism, same deterministic answer.

**Edge case:** the successor server (whichever partition it lives in) creates a fresh local Client struct for its new ghost as part of processing its own SQUIT-handling path — independent of the BX P broadcast that goes to other peers. (BX P renumbers an existing struct on remote peers; on the successor itself, the struct is freshly created locally.)

**Edge case:** the successor assumes ownership of the hold timer for the session. The non-elected holders' timers continue to run as a backstop — if the elected successor itself SQUITs before its timer fires, the next election produces a new successor.

With this discipline:
- A SQUITs at runtime → B (elected) creates ghost. Network sees consistent Q + N. Chathistory presence continues via the new ghost on B.
- A reboots later and rejoins → A's boot-time restoration legitimately creates a ghost. Convergence at EOB resolves any conflict with B's state.
- B does **not** spontaneously create a ghost outside the SQUIT-election path or the boot/reconnect paths.

This is the answer to "but what about chathistory presence when the ghost-holder SQUITs?" — the elected successor preserves presence; the no-zombie discipline is preserved for all other paths.

**Channel state:** A's persisted channels `C_A` win (surviving primary's view). B drops its persisted channel state for this session.

### E.2 — One held ghost + one active primary

**Setup:**
- Server A: held ghost `AAxxx`, persisted record
- Server B: live primary `BBxxx` (user reconnected to B; possibly a fresh registration that resumed this session via SASL + sessid)
- Same `(account, sessid)`

**At EOB, both sides compute:**
- Live connections in roster: `BBxxx` only (A's ghost is not live).
- Primary identity (live-only candidates): `BBxxx` wins by default (only candidate).

**Outcome:**
- **Server A:** silently destroys ghost `AAxxx` (held ghost was just a placeholder; live primary supersedes); updates session record to reflect "primary on B"; cancels hold timer (session is no longer held — it's active on B).
- **Server B:** no action — already has the live primary; session record is already correct.
- **Network:** single `ibutsu` nick-holder, on B. No visible "primary moved" event because there was no other live primary to displace.

**Channel state:** A's persisted channels merge with B's live channels (union). For overlapping channels, B's primary view wins (mode bits etc.). A's contributions add channels that B didn't yet know about (e.g., persisted channels the user was in pre-disconnect that B's fresh session didn't auto-rejoin — these get re-added to maintain continuity).

### E.3 — Two active primaries (split-brain after relink)

**Setup:**
- Server A: live primary `AAxxx`, `cli_firsttime = T_A_first`, recently active
- Server B: live primary `BBxxx`, `cli_firsttime = T_B_first`, also recently active
- Same `(account, sessid)`
- Both came up during a partition; user happened to be connected to both during the split

**At EOB, both sides compute:**
- Live connections in roster: `AAxxx` + `BBxxx` (and any aliases).
- Primary identity: oldest `cli_firsttime` wins. Suppose `T_A_first < T_B_first` → **AAxxx is primary**, `BBxxx` becomes alias.
- Lex tiebreaker on equal `cli_firsttime`: most recent `last_active`; further tiebreaker: lex on numeric.

**Outcome:**
- **Server A:** no action (already primary, deterministic agreement). Updates its alias roster to add `BBxxx` (server B).
- **Server B:** loser side — converts `BBxxx` from primary to alias locally (set `IsBouncerAlias`, clear `IsBouncerHold` if set, add `CHFL_ALIAS` on memberships, etc.). Emits `BX C AAxxx BBxxx <sessid> ibutsu …` to the network. Emits `BX P BBxxx AAxxx <sessid> ibutsu` to **legacy peers only** (renumber on legacy view) per gap report B1. Suppresses the relay of A's primary's N to legacy peers (BX P substitutes for it).
- **Network IRCv3-aware:** sees `BX C` and the existing N for `AAxxx`; alias relationship established.
- **Network legacy:** sees `BX P` doing in-place numeric swap; their view of `BBxxx` becomes `AAxxx`.

**Channel state:** combined memberships. For overlapping channels with different mode states, A's primary view wins.

**Hold-clock:** preserved (sessions are active, hold-clock isn't running).

### E.4 — Single restart, no peer state for this session

**Setup:**
- Server A reboots
- Restores sessions from persistence on boot, creating held ghosts for each
- Either no peer link yet, OR peer link exists but peer doesn't have a session for this `(account, sessid)`

**Convergence behavior:**
- If no peer link yet: no convergence runs for this session (no peer state to compare against). The ghost waits in HOLDING; hold timer counts down per A's persisted accumulator.
- If peer link exists but peer has no record for this `(account, sessid)`: at EOB, convergence sees A's ghost + nothing on peer side. No conflict; ghost stays as A's local network-facing representation. Peer learns about the ghost via standard N burst (with sessid hint per A.2 going only to bouncer-aware peers).

**Outcome:**
- **Server A:** ghost remains in HOLDING; hold timer running; persisted record intact.
- **Other servers:** add the ghost to their global client view via standard N processing; they don't have a session record for it locally (they're not holders) — when they learn about aliases via subsequent BX C for this session, they install alias replicas referencing the ghost.

This is the "no contest, just hold" case. No reconciliation primitive runs because there's nothing to reconcile.

### Why these four cases cover the surface

E.1 + E.2 + E.3 are the only multi-server-state combinations:
- E.1: both held (no live connection anywhere)
- E.2: asymmetric (one held, one active)
- E.3: both active

E.4 is the no-multi-state case (single side only). Restoration into E.4 either stays E.4 (no peer ever links with a competing record) or transitions into E.1/E.2/E.3 once a peer with state shows up.

Aliases are inherently part of a session's roster, not a separate case — they're handled within the session's convergence (D.2's "live connections in the roster" includes aliases).

---

**Net of E:** the D rules produce coherent, deterministic outcomes for all four canonical cases. No new wire protocol surface introduced beyond the existing BX P / BX C / BS X. The bouncer-internal silent-destroy flag (gap report A1) is required for E.1's "loser destroys silently" path to avoid spurious legacy QUIT scrollback.

## F — Wire protocol changes

Net effect on the bouncer wire surface from the redesign decisions in A–E.

### F.1 — Removed entirely

| subcommand | reason |
|------------|--------|
| **BX R** | Reconcile machinery is replaced by at-N-time recognition in m_nick (D.1). Sessid hint on N (A.2) provides the discriminator. No reply traffic, no anti-ping-pong gate. |
| **BX F** | Burst-tail handshake gating is no longer needed. Convergence is at-N-time per session, not a single EOB pass that needs gating. |
| **FLAG_BXF_AWARE** | Goes away with BX F. |

### F.2 — Modified format

| subcommand | change | rationale |
|------------|--------|-----------|
| **N** (NICK introduction) | Add optional trailing sessid field for bouncer-aware peers; stripped on emission to legacy peers via FLAG_IRCV3AWARE-keyed split delivery (same shape as the existing FLAG_IPV6 split). | A.2 — m_nick uses the sessid hint to recognize bouncer-relevant N's and apply convergence rules at-N-time. |
| **BS A** (Attach) | Carry per-alias `last_active` + `caps` fields. | B.1 + B.6 — peers receive enough context to compute convergence locally without needing BX R. |
| **BS C** (Create) | sessid value format changes from `<server-prefix>-<seq>` to UUID v7. | A.1 — globally unique session identity. |
| **BX C** (Alias create) | sessid value format changes (same as BS C). Per-channel JOIN msgids ride along in the chanlist payload (e.g., `:#chan1@msgid1 #chan2@msgid2`); receivers parse trailing `@msgid` per channel and use it for the alias's auto-attach JOIN msgid. | A.1 (sessid) + B2 ride-along subsumes BX J. Single-msgid invariant preserved without a separate broadcast. |

### F.3 — Removed via ride-along

| subcommand | reason |
|------------|--------|
| **BX J** | Subsumed by BX C carrying per-channel JOIN msgids (per F.2 BX C entry). Receivers get msgid parity at alias-create time. Migration: keep BX J handler as a no-op for backwards-compat with peers still emitting during rollout window, retire emit immediately, retire handler later. |

### F.4 — Unchanged

| subcommand | role |
|------------|------|
| BS C, BS A (otherwise), BS D, BS X, BS U, BS T | Session-state replication. Already in-design; format changes are additive (per F.2). |
| BX C, BX X, BX P, BX N, BX U | Active-state changes. Already in-design; sessid format change is value-only (BX C also gains the JOIN-msgid ride-along per F.2). |
| BX M, BX E, BX K | Post-design IRCv3 cap parity additions. No changes. |

### F.5 — Behavior changes (not subcommand changes)

These are protocol-adjacent changes that don't add/remove wire subcommands but change how existing ones are used:

- **m_nick recognition path:** at-N-time, gate on sessid hint or account-match fallback to dispatch to convergence rules instead of standard P10 collision (D.1).
- **BX P used as the SQUIT-recovery signal for held ghosts:** when ghost-holder SQUITs, the SQUIT-originating server (S_A) computes the elected successor and emits BX P with the new ghost numeric in the successor's namespace BEFORE forwarding/broadcasting the SQUIT. Stock legacy BX P updates `cli_user(client)->server`, so the renumbered ghost is no longer in A's namespace by the time SQUIT cleanup walks A's clients. Wire-invisible to channel members within the partition. (E.1 SQUIT-election path.)
- **N relay suppression to legacy on E.3 demote:** when a server's primary loses E.3 convergence and emits BX P to legacy peers, the corresponding N relay for the winning side's primary to those legacy peers must be suppressed (gap report B1, generalized to apply to E.3 demote paths).
- **`FLAG_KILLED` semantic split:** introduce dedicated bouncer-internal silent-destroy flag; `FLAG_KILLED` reserved for actual network KILL (gap report A1, prerequisite for the silent-destroy paths in convergence).

### F.6 — Net protocol surface change

- **Subcommands removed:** BX R, BX F, BX J — three.
- **Subcommands added:** none.
- **Subcommands modified:** N (added optional sessid trailing field), BS A (added per-alias activity + caps), BS C (sessid format), BX C (sessid format + per-channel JOIN msgid ride-along, subsuming BX J).
- **Behavior changes in surviving subcommands:** several, listed in F.5 — most notably BX P gains a new use case (SQUIT-recovery renumber).

The redesign is **net wire-surface reduction** (three subcommands removed, none added) plus **field additions** to existing subcommands. The protocol gets smaller, not larger.

## G — Migration path

Decided 2026-05-05.

### G.1 — Schema migration (v7 → v8)

**Sessid format (G.1.a):** mint new UUID v7 for every v7 record on first load. Old `<server-prefix>-<seq>` values replaced everywhere. Active-session disruption is bounded — single-server testnet, low active-session count, restart-on-deploy is the natural transition point. Sessids are largely server-internal; clients use bouncer-token resume, not the sessid directly.

**Default values for new persisted fields (G.1.b):**
- Per-connection `last_active`: primary's value = existing `bsr_last_active` (carries forward); aliases empty (v7 didn't persist aliases anyway).
- Persisted alias roster (B.2): empty on migration. Repopulated by peers' BS A bursts on next link establishment.
- Per-alias caps (B.6): empty on migration. Repopulated via BX U on link.

**Mechanism (G.1.c):** standard version bump. `BOUNCER_DB_VERSION` 7 → 8. On open, detect v7 records and migrate in place — same pattern as the Phase 7 storage migration. Single-pass migration on first start with new code; v7 records rewritten as v8 with UUIDs minted.

### G.2 — Wire-protocol coexistence during rollout

**N/A.** Single-server production testnet. If a second server is added later, both run the new code from the start. No multi-version-in-flight scenario to handle.

### G.3 — Verification strategy

**Reproduction harness for failure modes (G.3.a):** five scripted scenarios derived from cluster B's commit history, covering the failure modes that motivated each accretion the redesign retires:

1. **Equal-TS persisted ghosts** (the 2026-05-04 reproduction). Hub holds ghost, leaf reconnects with new primary; verify no collision, no ghost-zombies. Tests at-N-time recognition + held-vs-active resolution (E.2).
2. **Two-active split-brain after partition heal.** Each side gets a primary during partition; link re-establishes; verify deterministic demote-loser-to-alias via at-N-time recognition (E.3).
3. **Held-ghost on SQUIT (BX P-on-SQUIT path).** Two-server topology, ghost on hub, hub SQUITs; verify wire-invisible renumber on the partition's surviving leaf.
4. **Persistence through restart.** Kill server, restart, verify ghost restoration, then reconnect; verify revive primitive works against the new sessid + at-N-time recognition.
5. **Account+sessid identity on N.** Verify sessid hint correctly carried on bouncer-aware paths, stripped on legacy paths.

Run all five before retiring old machinery (BX R, BX F handlers).

**Parallel verification (G.3.b):** N/A for single-server.

**Rollback path (G.3.c):** keep v7 backup of persisted records on first migration. Cheap insurance, tiny additional disk usage, trivial rollback (drop back to old binary, restore v7 records from backup). Drop the backup after a confidence window — a week of stable operation under the new code.

---

## Status

All seven design sections (A–G) decided as of 2026-05-05.

The redesign is **net wire-surface reduction** (three subcommands removed: BX R, BX F, BX J) plus **field additions** to existing subcommands (sessid hint on N, per-alias activity + caps on BS A, sessid format on BS C / BX C, per-channel JOIN msgid ride-along on BX C). Plus several behavior changes in surviving subcommands (at-N-time m_nick recognition, BX P-on-SQUIT renumber, FLAG_KILLED semantic split).

Eliminates cluster B's coordination protocol surface (BX R / BX F / hs_pending_demote_peer / active-vs-active demote / m_nick BX-R verdict cross-cut) and cluster C3's BX C in-place conversion accretion (held ghosts recognized at restore via persisted alias roster, no in-place conversion needed).

**Next phase:** implementation. Specifying ready-for-implementation detail (function signatures, exact wire-format strings, schema-migration code path) is its own task — separate from this design dialog. The audit + redesign is the architecture; implementation follows from it.

## Where to start

Three foundational decisions feed everything else:

- **A.1 (sessid scheme)** — which option?
- **A.2 (sessid on the wire)** — yes (N carries hint) or no (rebind defers to BS C)?
- **A.3 (multi-session future support)** — actively build out, or stay neutral?

Once these settle, B (persistence content) is mostly a list of specific fields, and C–F follow from A and B.

Suggest taking them in order. A.1 first.
