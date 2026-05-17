# Step 4 — Cluster B audit (BX R / BX F / restore_pending / pending_demote_peer)

Read against `bouncer-design-intent.md`, `bouncer-wire-protocol.md`, `bouncer-state-machine.md`. **No fix proposals** — findings only. Specific code references included so step-5 work can verify.

## Surface

**Files / functions involved:**

| location | what it does |
|----------|--------------|
| `bouncer_session.c:6202–6857` | `bounce_session_reconcile` (BX R receiver), `bounce_emit_session_reconcile`, `bounce_emit_burst_reconciles` |
| `bouncer_session.c:6484–6513` | `bounce_reconcile_end` (BX F receiver) |
| `bouncer_session.c:6956–7090` | `bounce_resolve_pending_demotes` (called from `ms_end_of_burst`) |
| `bouncer_session.c:6228–6283` | `bounce_destroy_yielded_ghost` (broadcasts Q) and `bounce_destroy_silent_held_ghost` (suppresses Q via `FLAG_KILLED`) |
| `m_nick.c:520–611` | `bxr_says_we_lose` short-circuit; cross-cutting bouncer logic in m_nick |
| `s_serv.c:308–318` | BX F handshake — emits BX F + `SetBurstGated(cptr)`, defers `server_finish_burst` |
| `bouncer_session.h:222`, `:228` | `hs_pending_demote_peer[6]`, `hs_restore_pending` |
| `client.h` | `FLAG_BXF_AWARE`, `IsBxfAware()`, `SetBxfAware()` |

## What the code actually does

### 1. BX R receiver (`bounce_session_reconcile`) is a four-branch decision tree

After parsing `<ghost_numeric> <sessid> <last_active> <role> [<account>]`:

| branch | when | action |
|--------|------|--------|
| **(a) sessid not found, account not found locally** | unknown session entirely | forward, return |
| **(b) hijack** | `hs_origin != sptr` and session is not local-origin | refuse, forward, return |
| **(c) held-ghost yield** | `hs_origin != sptr` (split-brain), no live local primary, no live local alias | silent-destroy ghost (FLAG_KILLED), broadcast BS X, destroy session, forward |
| **(d) active-vs-active demote** | `hs_origin != sptr`, !restore_pending, live local primary | compute `we_lose` from last_active + lex on origin; if lose → `bounce_demote_live_primary_to_alias` or stash `hs_pending_demote_peer` for EOB retry |
| **(e) restore-pending compare-and-yield** | `restore_pending` true | compute `we_lose` from last_active + lex on ghost numeric; if lose → `bounce_destroy_yielded_ghost` (broadcasts Q), repoint origin, clear restore_pending |
| **(f) firm side, no contest** | !restore_pending, no origin mismatch | emit BX R back ONLY if peer is strictly behind (anti-ping-pong), forward |

**Six paths through one handler.** No path matches the convergence-via-roster-union intent — every path either picks a winner, refuses, or stops the loop.

### 2. `hs_pending_demote_peer` is a deferral mechanism for unresolvable peer references

When BX R says "you lose, demote to alias of peer's primary," the peer's primary numeric isn't necessarily resolvable via `findNUser` yet — burst order is BX R *before* N. The handler stashes the expected numeric in `hs_pending_demote_peer[6]` and returns; `bounce_resolve_pending_demotes` retries at end-of-burst.

**Three retry outcomes** (`bouncer_session.c:6956–7090`):
- Peer's primary now resolvable → demote completes.
- Peer's primary still NOT resolvable + we have a live local primary → clear pending; "peer will retry next BX R round."
- Peer's primary still NOT resolvable + we're a held ghost too → **yield (destroy our session via `bounce_destroy_yielded_ghost`)**.

The third case is documented as the "split-brain that won't heal" deadlock fix: both sides reference each other's held ghosts, neither can demote (no peer primary to attach to). The fix is to break the deadlock by destroying one side. This is patching a deadlock that arose specifically because the resolution primitive is "demote-loser-to-alias" — under deterministic dedup the case wouldn't occur.

### 3. BX F is a synchronous burst gate

`server_estab` in `s_serv.c:308–318`:
1. Emit BX R for all local sessions (`bounce_emit_burst_reconciles`).
2. If peer `IsBxfAware`, emit `BX F`, `SetBurstGated(cptr)`, return early (defer the rest of the burst — N tokens, channel BURST, EB).
3. Wait for peer's `BX F` (handler at `bouncer_session.c:6484`).
4. On peer's BX F, `ClearBurstGated`, call `server_finish_burst`.

**This is two-phase commit layered on top of P10's burst.** It exists because the active-vs-active demote path needs verdicts settled *before* the N burst goes on the wire, otherwise losers' Ns ship and trigger collision rules.

`FLAG_BXF_AWARE` is a separate capability flag from `FLAG_IRCV3AWARE` — meaning some IRCv3-aware peers don't speak BX F. Comment at s_serv.c:297 says: *"Peers that don't speak BX F (older IRCv3-aware builds, or fully legacy non-IRCv3 builds) MUST NOT be gated — they will never send BX F back, so the gate would hang the burst forever."*

**Note (user 2026-05-04):** the separate flag is defensive backwards-compatibility, which is the right pattern in principle. In our actual deployment, however, the population of IRCv3-aware-but-not-BX-F-aware servers is effectively nil — so the distinction isn't currently buying anything operationally. Doesn't change the findings about BX F itself (the two-phase-commit-on-burst layering is still the issue); just means the flag separation is an artifact of doing the compatible thing, not a design weakness.

### 4. m_nick has accreted bouncer-state cross-cutting

[m_nick.c:587–611](nefarious/ircd/m_nick.c#L587-L611): `bxr_says_we_lose` short-circuit. Reads `bsess->hs_pending_demote_peer` to decide whether to demote local primary instead of falling through to standard collision rules.

The block exists because of a specific failure mode (comment lines 568–586): *"both sides claim local origin in the post-counter-reset / post-data-wipe scenario … the original 'refuse if local origin' path then made BOTH servers refuse each other's introductions → mutual stalemate → permanent split-brain."*

Translation: `is_local_session` is too coarse a discriminator under the contest model — both sides legitimately claim local origin in split-brain, and "refuse if local origin" deadlocks. The fix is to consult BX R verdict via `hs_pending_demote_peer`. **m_nick now reaches into bouncer session state to decide nick collision behavior.**

### 5. Cross-sessid fallback (`bouncer_session.c:6573–6594`)

When sessid lookup misses, the handler falls back to account-based session lookup (`bounce_find_local_session_by_account`). Comment says: *"each side may have independently created a session with its own sessid prefix during the partition (e.g., AC-8 here vs Bj-2 there for the same account)."*

This explicitly admits that `(account, sessid)` is *not* a stable global identity — two servers can independently mint sessions for the same account during a partition, each with its own sessid prefix. The reconcile primitive then has to bridge across sessid identity. Under the convergence intent, this is "two distinct sessions" (different sessids → coexist), but the code treats them as same-session-to-be-merged.

This is a structural disagreement with design intent: either sessid is the stable identity unit (then independently-minted sessions during partition must somehow agree on a shared sessid) or it isn't (then cross-sessid fallback is reasonable but the `(account, sessid)` framing in design intent needs revision).

## Findings classified

### Design-intent mismatches

**M1 — winner-picking instead of convergence.** The active-vs-active demote path (branch (d)) and the restore-pending compare-and-yield path (branch (e)) both compute a winner via last-active timestamp + lex tiebreaker. Per design intent, same-session convergence should be **deterministic dedup as roster union**, not winner-picking with demote-loser semantics. The very *existence* of `bounce_demote_live_primary_to_alias` as the primary resolution operation is the mismatch.

**M2 — coordination subcommand for a problem the design says is local-deterministic.** Mar 2 said netsplit-promotion-equivalent operations are deterministic per server with no coordination. BX R + BX F constitute coordination: each side announces state, each side computes a verdict, BX F gates burst progress until both sides finish. If persistence carries enough context for both sides to compute the same answer independently, none of this coordination is needed.

**M3 — `is_local_session` is a discriminator the design doesn't recognize.** Per design intent, "local origin" vs "remote replica" is implementation detail; what matters is whether two servers refer to the same logical session. The receiver's branching on `hs_origin == sptr` and authorizing-vs-refusing accordingly is contest semantics, not convergence.

**M4 — m_nick reaches into bouncer state.** The `bxr_says_we_lose` short-circuit makes nick collision behavior dependent on BX R verdict state. Under the design intent, nick collision for accounts-bearing primaries should be irrelevant for same-session ghosts (they should converge before the question arises) and decided by standard rules for genuinely different sessions. Cross-cutting between m_nick and bouncer state is symptomatic of the layering of contest semantics on top of P10.

### Real-gap-driven accretions (responding to actual problems)

**G1 — equal-TS persisted ghosts.** Branch (e) explicitly handles "both restore_pending, equal last_active" via lex tiebreaker on ghost numeric. This is closing the persistence gap (Mar 2's "natural nick collision kills the older" doesn't fire). **The gap is real; the response is contest-shaped.** Under deterministic dedup the same lex rule would apply, but as a *survivor selection* not a *winner declaration*.

**G2 — split-brain held ghosts deadlock.** `bounce_resolve_pending_demotes` lines 6986–7018 break a deadlock where both sides reference held ghosts. This deadlock only exists because the resolution primitive is demote-to-alias. Under deterministic dedup this case is "two replicas of the same logical session, neither has live presence → pick survivor lex, silently destroy the other" — no deadlock to break.

**G3 — burst race between BX R and N.** `hs_pending_demote_peer` deferral exists because peer-primary numerics named in BX R are not yet resolvable when BX R is processed (N comes later in the burst). BX F was added to gate the N tail until BX R resolution completes. Both are layered fixes for the same structural issue: the active-vs-active demote path needs cross-server state references that aren't yet in place during burst. Under deterministic dedup the cross-references aren't needed (each side computes locally).

### Reactive defense

**R1 — anti-ping-pong gate.** `bouncer_session.c:6760–6776`: BX R reply is gated on `their_last_active < ours` to prevent unbounded BX R loops between two firm sides with matching last_active. The comment explicitly identifies the failure mode (*"unbounded BX R ping-pong that saturates the S2S link"*). This is reactive defense added because the original BX R design didn't think through reply-vs-ack semantics.

**R2 — wandering-thought comment.** Lines 6749–6753 contain: *"Wait, no — if their_last_active < ours, we_lose=0 and we'll emit normally. If equal AND we win lex, we_lose=0 but their_last_active == ours, so the emit gate skips. That's fine — peer will run this same code, see they lose, and demote. No emit needed from our side to drive that."* — Code comment in stream-of-consciousness form. Hallmark of reactive thinking; no design referent backs the reasoning.

### Silent defers

**D1 — `their_role` parsed but unused.** `bouncer_session.c:6569`: *"role currently advisory only"*. The wire format includes `<role>` ("P" or "A"), the receiver parses it, then `(void)their_role`. **A wire field exists with no consumer.** Either the field is dead weight or there's a deferred design that hasn't landed. Worth flagging.

**D2 — "separate fix" comment.** Lines 6766–6772: *"When equal AND both sides are firm we have an active-vs-active split-brain that needs demotion handling (loser flips primary→alias), but that's a separate fix; here we just stop the flood."* — Explicit acknowledgment that the case isn't handled here, deferred to "separate fix" with no plan-file link. Active-vs-active demote *was* added later (the (d) branch), so this comment is now outdated; but the silent-defer pattern is worth noting.

**D3 — destroy-array bound.** `bounce_resolve_pending_demotes` line 6970: `MAX_PHANTOM_DESTROY = 256`. Hardcoded ceiling on phantoms-destroyed-per-EOB with no overflow handling visible in this read. If >256 sessions need yielding in one EOB, the surplus are silently skipped. Probably fine in practice; flagged for completeness.

### What context the persistence redesign would need

From this read, the BX R / pending_demote / m_nick machinery is passing around the following data to make decisions. **All of these would need to be persisted** for a deterministic local-only convergence to work:

1. `hs_last_active` per session — already persisted (`bsr_last_active`).
2. `hs_origin` — already persisted (`bsr_origin`).
3. **Per-connection activity** for tiebreaking when multiple connections share a session — *not currently persisted*. Currently we collapse to session-level `last_active`.
4. **Alias roster as of last shutdown** with per-alias-server identity — *not persisted* (`hs_aliases[]` is runtime-only).
5. **Live-presence state** ("is there a live primary, live alias?") — only meaningful at runtime, but the *fact that the session was active vs holding at shutdown* could be persisted.
6. **Session sessid stability across restarts** — currently persisted (`bsr_sessid`), but the cross-sessid fallback path (G3) suggests sessid uniqueness across partitions isn't guaranteed. Either tighten sessid generation to be globally stable, or accept (account-only) as the convergence discriminator.
7. **Last known peer state** if any — *not persisted*. Servers could remember "as of last shutdown, server X claimed primary for this session" — useful for post-restart deterministic ordering.

## Summary assessment

Cluster B is a coordination-protocol fix layered onto a problem the design said is local-deterministic. Most of its surface — BX R verdicts, BX F handshakes, hs_pending_demote_peer, demote-loser-to-alias, anti-ping-pong gates, m_nick cross-cutting — exists because of one structural choice: **using session-vs-session contest semantics for what should be roster-union convergence semantics**.

The real gap (equal-TS persisted ghosts) is genuine but small; closing it within convergence semantics is far smaller than the current cluster-B surface. The persistence redesign work that came up earlier (richer persisted record so reconciliation is locally deterministic) is the natural way through.

**For step 5:** the recommendation here is structural, not a list of patches. *"Replace cluster B's contest-shaped resolution with deterministic dedup driven by enriched persistence context."* Specific code paths to remove or reshape become clear once the persistence design is settled.

## Update: "servers hold sessions, they don't own them" cascades through the findings

User principle, recorded in `bouncer-design-intent.md` §"Servers hold sessions; they don't own them" — sessions are network-wide constructs, servers don't own them, session IDs must not encode server identity.

This principle resolves several findings above more sharply:

- **M3 — `is_local_session` is meaningless.** The discriminator `hs_origin == cli_yxx(&me)` presupposes ownership. Under the principle, `hs_origin` itself is a conceptual error — there is no origin server. The "split-brain vs hijack" gate (lines 6611–6618) collapses: there's no such thing as a hijack, only different views of the same network-wide session.
- **M1 — winner-picking dissolves.** "Demote-loser-to-alias" presupposes a loser, which presupposes a contest, which presupposes ownership. With holding semantics, there's no contest; both holders just merge their rosters.
- **G3 (cross-sessid fallback) is a direct consequence of server-prefixed sessids.** Two servers minting sessids during a partition produce different sessids only because the scheme bakes server identity into the ID. Move to globally-unique session IDs and the case can't arise.
- **D1 — `their_role` "currently advisory only."** Roles like `P` (primary holder) vs `A` (alias holder) make sense in a roster-merge model; they're descriptors of what each holder has, not arbitration weights. A future design might make these load-bearing for the merge logic — but only if framed as "describing the holder's roster contribution," not as "claiming ownership."
- **G2 — "split-brain that won't heal" deadlock vanishes.** The deadlock arose because two ownership claims couldn't both be honored. Under holding semantics, both holders silently retain their state; if both are HELD with no connections, hold-expiry handles cleanup deterministically per-server.

**Findings that survive even under the holding principle:**

- **G1 — equal-TS persisted ghosts** is still a real persistence-state gap that needs *some* deterministic dedup rule (lex on session ID, lex on holder identity, or similar). The principle reframes it from "who wins" to "which physical record survives," but doesn't eliminate it.
- **R1 — anti-ping-pong** isn't needed if there's no BX R reply traffic. Under the principle, BX R becomes (at most) "I hold this session, here's my roster contribution" — emit-once on link, no reply-loops possible.
- **D3 — `MAX_PHANTOM_DESTROY = 256`** is implementation hygiene that survives any redesign.

The reframing also implies a concrete persistence-redesign data point that wasn't on the earlier list:

8. **Globally stable session IDs.** The persisted record's `bsr_sessid` should be a global identifier (UUID, content hash, or other server-independent scheme), not a server-prefixed counter. This eliminates the cross-sessid split-brain case at its source.

## Update: KILL semantics (user invariant #12, 2026-05-04)

Per design intent invariant #12: network KILL of any session connection ends the entire session — aliases don't survive. Cluster B's code paths use `FLAG_KILLED` extensively, but as a *silent-destroy marker* (suppress Q to legacy peers, suppress channel-quit notifications), not as a network-KILL semantic. Two distinct concepts:

- **Network KILL** (the IRC `KILL` token from oper or peer server): an oper assertion of "this user is off the network." Per invariant #12, must terminate the entire session including all aliases.
- **`FLAG_KILLED` as internal marker**: used by `bounce_destroy_silent_held_ghost` and similar to mean "destroy this Client struct without the usual Q broadcast, because Q would generate spurious user-visible scrollback for an event that's purely internal session-state cleanup."

Cluster B's use of `FLAG_KILLED` is the second kind and is fine *for cluster B*. The risk surface is elsewhere: when a network KILL arrives for a primary, does the current code (a) end the whole session, or (b) treat it like a clean disconnect and let aliases survive via `bounce_promote_alias`? The latter would violate invariant #12. **This needs to be checked against the `bounce_promote_alias` / exit_client paths** (a step-4 entry point not in cluster B).

Cluster B's findings don't change under invariant #12, but step 4 reading of the promote/exit paths should specifically validate KILL is handled as session-ending, not connection-ending.

## Update: BX E and BX K reclassification (user 2026-05-04)

BX E (echo-message analog for aliases) and BX K (snomask sync across alias-holding servers) were classified as **post-design feature / IRCv3 cap parity gap fill** — legitimate additions, not scope creep. Cluster B doesn't touch BX E or BX K, so no findings change. Mentioned here only for cross-reference completeness; full classification in `bouncer-wire-protocol.md`.

## Comparison to original plans (added 2026-05-04)

User pointed at two pre-flailing plan files:
- [`.claude/plans/bouncer-burst-reconcile.md`](bouncer-burst-reconcile.md) — original BX R reconcile design.
- [`.claude/plans/bouncer-burst-revive.md`](bouncer-burst-revive.md) — `bounce_rebind_ghost_to_remote_primary` design.

Reading current code against these reveals **the cluster B mess is more specifically located than the audit had it**.

### The original BX R plan (bouncer-burst-reconcile.md)

The plan was contest-shaped at the framing level (*"Loser destroys its ghost silently"*) **but bounded to the two-held-ghost case**: both sides have a restored ghost (HOLDING), neither has live presence, pick a survivor. The plan's three branches:

1. Their session not found → just track announcement.
2. Both `restore_pending` → compare last_active, lex tiebreaker if tied. Loser destroys ghost silently.
3. Their session firm (active client attached or already reconciled) → they win unconditionally. Destroy our ghost.

**The plan's mechanism for case (2) is mechanically equivalent to deterministic dedup.** The framing is "winner/loser" but the operation is "of the two `Client*` representing the same logical session, exactly one survives, deterministic by (last_active, lex)." That's compatible with convergence semantics.

What the plan **did not specify**: active-vs-active split-brain (both sides have a *live primary*, not just held ghosts). The plan's branch (3) — "Their session is firm, they win" — covers "we're held, they're active" but not "both active." Under the plan, two-live-primaries was an unaddressed case.

### What the code grew beyond the plan

The current code (cluster B) extended the plan to handle active-vs-active by adding:
- Branch (d) in `bounce_session_reconcile`: active-vs-active demote-loser-to-alias.
- `hs_pending_demote_peer` deferral for unresolvable peer-primary references during burst.
- `bounce_resolve_pending_demotes` EOB retry.
- BX F handshake to gate the N-burst tail until verdicts settle (so losers' Ns don't ship and trigger collision).
- `bxr_says_we_lose` short-circuit in m_nick.

**This extension is where the contest semantics break the design intent.** The plan's original case (held-vs-held dedup) is fine. The extension to active-vs-active is what's wrong: under invariant #11 (servers hold, don't own) and convergence-via-roster-union, two live primaries for the same session aren't a contest — they're two holders whose connection rosters union into one session.

### The revive plan (bouncer-burst-revive.md) — clean designed primitive

`bounce_rebind_ghost_to_remote_primary` is a **wire-level invisible** local-state mutation: when leaf has a held ghost and hub introduces the live primary via N, leaf rebinds the ghost's `Client*` to the new numeric, drops it from local nick hash, re-attaches to the server's link, channel memberships preserved. No QUIT, no JOIN, no S2S messages.

The plan and code are sound. The revive primitive is a positive existence proof: **for at least one bouncer scenario (held-ghost-meets-its-own-primary's-introduction), the right primitive is a clean local-state mutation, not coordination protocol.**

**Accretion finding on the revive code:** the implementation added an authorization gate (lines 3493–3527) that wasn't in the original plan: refuses rebind if `session->hs_origin != server`, with a special `-3` return for the BX-R-winner case (consumed by m_nick.c:522 to silent-drop the incoming N). The gate exists to prevent *hijack* — a peer (legacy or otherwise) reintroducing a user with matching account name shouldn't be able to commandeer a ghost it doesn't own. **This gate leans on the ownership concept (`hs_origin`).** Under invariant #11 (servers hold, don't own), the gate's shape needs revisiting — the protection is real, but the discriminator should be "does the peer's BS C correspond to the same session ID we hold?" rather than "does the peer match the recorded origin?" Since N doesn't carry sessid (it arrives via BS C later), the gating timing has to shift: either the rebind is deferred until BS C lands, or N carries a session-identity hint, or the gate uses a different protection (e.g., trust-but-verify with later rollback if BS C contradicts).

This is a real design question for the persistence redesign. **Adding to the persistence-redesign data-point list:**

11. **Either `N` carries a session-identity field, OR rebind is gated on BS C arrival (not on N).** The current authorization gate via `hs_origin` is incompatible with the holding-not-owning principle and needs replacement.

### Net assessment after plan comparison

Cluster B's surface splits more cleanly than the original audit framed it:

- **In-plan, sound:** held-vs-held BX R dedup (the original plan's case 2-3); the revive primitive (mostly).
- **Plan-extension that broke the model:** active-vs-active demote, BX F handshake, `hs_pending_demote_peer`, m_nick `bxr_says_we_lose`. This is what should be reshaped in step 5 — the plan didn't sanction it, and the design intent doesn't either.
- **Authorization-gate accretion on the revive path:** lines 3493–3527 of `bounce_rebind_ghost_to_remote_primary`. Lean on ownership, need reshaping under invariant #11.

The original plans were OK for what they covered. The mess is specifically the **extension of contest semantics to active-vs-active** plus the **ownership-based authorization gates that crept into otherwise-clean primitives**.

## Once-over conclusion

The cluster B audit's findings stand under all the design-intent updates accumulated through 2026-05-04 dialog:
- "Servers hold sessions, they don't own them" (invariant #11) → dissolves M3, M1, G2, G3 in cluster B; sharpens findings, doesn't invalidate them.
- KILL semantics (invariant #12) → no change to cluster B findings; flags a specific check for `bounce_promote_alias` paths in the next step-4 entry point.
- BX E/K reclassification → orthogonal to cluster B, no change.

Step 5's gap-report material from this audit:
- **Structural recommendation:** replace contest-shaped reconciliation with deterministic dedup / roster-merge driven by enriched persistence (eight data points listed in §"What context the persistence redesign would need" + globally-stable session IDs).
- **Specific code paths** that the structural change would simplify or remove: `bounce_session_reconcile` decision tree (collapse to dedup), `bounce_resolve_pending_demotes` (eliminate), `hs_pending_demote_peer` field (eliminate), `bounce_demote_live_primary_to_alias` (eliminate as primary resolution operation), BX F handshake (eliminate), m_nick `bxr_says_we_lose` short-circuit (eliminate), anti-ping-pong gate (eliminate — no replies in roster-merge model).
- **Specific code paths** that survive in some form: BX R as "I hold this session, here's my roster contribution" (emit-once on link, no replies), `bounce_destroy_silent_held_ghost` and similar Q-suppressing exit paths (still needed for internal cleanup events), persistence restoration logic (with enriched data).
