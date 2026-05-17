# Step 4 — BX M, BX E, BX K audit

Read against design intent + wire protocol. Combined audit because all three are classified as **post-design feature / IRCv3 cap parity gap fill** and share the burst-race deferral machinery.

## BX E — alias echo (PM forwarding to alias-holding servers)

**Location:** `bouncer_session.c:5447–5499`. ~50 lines.

### What it does

Wire format: `BX E <alias_numeric> <from_numeric> <tok> <target_nick> <msgid> :<text>`.

When a PM is delivered to the primary's local server, but the user's session has aliases on other servers, those alias-holding servers don't see the PM via channel routing (it's a direct message). BX E carries the message to those servers so the alias's connection sees it.

Handler flow:
1. `findNUser(parv[2])` → if alias unknown, `defer_bx_for_alias` for replay-after-BX-C.
2. If alias is on another server, forward via `sendcmdto_one`.
3. If local, deliver via `sendcmdto_one_tags_ext` with msgid preserved.

### Findings

**E1 — Small, focused, scoped.** Single delivery path. Msgid passed through unmodified. Implementation matches stated purpose. No findings of concern.

**E2 — Single-msgid invariant preserved.** The msgid arrives in the wire and is delivered to the local client unchanged. Same event, same msgid across primary's delivery and alias's BX E delivery.

## BX M — multiline batch echo

**Location:** `bouncer_session.c:6097–6200` (handler), `5749–5917` (batch struct + helpers + cleanup), `5919–6093` (delivery).

### What it does

Wire format (3 frame types):
- `BX M +<batch_id> <alias_numeric> <from_numeric> <tok> <target_nick> <msgid> [<@ctags>] :<first_line>` — start
- `BX M c<batch_id> <alias_numeric> :<line>` — concat-marker continuation
- `BX M <batch_id> <alias_numeric> :<line>` — plain continuation
- `BX M -<batch_id> <alias_numeric> [<paste_url>]` — end (deliver + free batch)

The `S2SBxmBatch` struct holds accumulating frames; on `-` end, deliver the assembled batch as a single multiline-aware delivery to the local alias.

### Findings

**M1 — Lifecycle is competent but heavy.** Cleanup hooks for: link drop (`s2s_bxm_cleanup_link`), alias destroy mid-batch (`s2s_bxm_cleanup_alias`), batch-id collision (drop pre-existing on M+), TTL via the pending-BX defer machinery, drain replay (`bx_drain_in_progress` skips re-forward). Each individually justified; cumulatively a significant surface. **Reasonable engineering hygiene** for an inherently stateful S2S batch protocol.

**M2 — Single-msgid invariant preserved.** Msgid captured in M+ frame, held in batch struct, applied at delivery. Compatible with invariant.

**M3 — Burst-race deferral applies to all BX M frames.** Each frame that targets an unknown alias is deferred. Drain replay order is insertion-order (per cluster C3 finding), so M+ replays before its continuations. Correct.

**M4 — Bounded by MAXCONNECTIONS slots.** Hardcoded ceiling (`s2s_bxm_batches[MAXCONNECTIONS]`). On overflow, M+ silently fails (returns 0 without creating). This is one of the "silent return without notification" patterns — combined with the pending-BX TTL expiry, the failure surface for a flood attacker is bounded but observable only via debug logs.

**M5 — Heavily decoupled from session reconciliation.** Unlike cluster B/C3, BX M is purely about per-message multiline correctness. The lifecycle complexity stems from S2S batch correctness, not from bouncer state. Step 5: under the persistence redesign, BX M would still exist in roughly its current form because multiline batch state is per-message, not per-session. Independent of the bigger cleanup.

**M6 — Forward-to-remote path exists** (`forward_bxm_line` for non-local alias). Routing follows alias's server. Standard.

## BX K — snomask sync

**Location:** `bouncer_session.c:7099–7139`.

### What it does

Wire format: `BX K <alias_numeric> <snomask>`.

When OPER status changes for a session connection (e.g., user opers via primary), the snomask should propagate to alias connections on other servers so they see the same snotices. BX K carries the snomask value.

Handler flow:
1. If alias unknown locally: defer for replay AND forward to network immediately (other servers may have it).
2. If alias known and local: `set_snomask(alias, snomask, SNO_SET)`.
3. Forward to network unless we're inside a drain replay (avoid duplicate forwards).

### Findings

**K1 — Asymmetric handling: forward immediately, defer local apply.** Unusual pattern. Most other deferred handlers fully defer (no immediate side-effects on the network). BX K splits: forward proceeds immediately so remote servers can apply, but local apply is deferred until BX C arrives. Consequence: other servers may apply the snomask before we do — eventually-consistent state.

Probably the right tradeoff given the asymmetry of who-knows-what (other servers might have the alias known, we might not), but the asymmetry is fragile and worth noting. Under enriched persistence with alias roster known at restore time (per cluster B's structural recommendation), this asymmetry would vanish — both sides would know each other's aliases at link establishment, no defer needed.

**K2 — `is_replay` flag prevents duplicate forwards during drain.** On drain replay, we already forwarded on first arrival; replay skips the forward. Correct, prevents duplicate broadcast.

**K3 — Snomask is a `set`, not a delta.** `set_snomask(alias, snomask, SNO_SET)` overwrites the entire snomask value rather than diff-applying. So out-of-order BX K arrivals last-write-wins. Probably fine for snomask (it's a state, not a stream of changes), but worth noting if event ordering ever matters for a future mode-like field.

## Cross-cutting observations

All three handlers lean on `defer_bx_for_alias` (the pending-BX machinery from cluster C3) for burst-race protection. **Eliminating the pending-BX machinery — per cluster C3's structural recommendation — requires these handlers to compute alias presence from persisted state instead.** That's a coherent path: at link establishment, both peers know each other's alias rosters from persisted state, so `findNUser(alias)` succeeds at any time and the deferral path becomes unreachable.

The single-msgid invariant is preserved correctly across all three:
- BX E: msgid passed through unchanged.
- BX M: msgid captured at start frame, held in batch, applied at end.
- BX K: not msgid-bearing (snomask is state, not event).

## Net assessment

**BX E, BX M, BX K are clean implementations of post-Mar-2 features.** Engineering quality is good (defensive cleanup, bounded buffers, msgid preservation). Their existence is justified by real IRCv3 cap parity gaps that Mar 2 didn't cover. None of them have the contest semantics or layer-confusion issues from clusters B and C3.

**Step 5 status:** these three need no major reshaping. The pending-BX dependency is shared with cluster C3; if cluster C3's structural recommendation lands (persistence-driven local computation), the burst-race deferral path here becomes unreachable but the rest of the implementations stand. Otherwise no change needed.

The only thing to flag for the bigger redesign: under "servers hold sessions, they don't own them," **BX K's asymmetric forwarding model would simplify** (no need to forward immediately because all peers know the roster from persistence; can fully defer if needed), but doesn't change the basic shape.

## Status

- BX E — no findings of concern.
- BX M — engineering review only (M1–M6 are observations, not bugs).
- BX K — K1 (asymmetric forward) is intentional but worth flagging for the persistence redesign.
- All three remain valid post-design features. No scope-creep or contest-semantics concerns.
