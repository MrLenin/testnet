# CRDT-mesh Phase 2 — CRDT on the wire (scoping)

**Status:** SCOPING ONLY — not started (awaiting go-ahead).
**Branch:** `crdt-mesh` (nefarious-crdt submodule). Builds on Phase 0 (engine) + Phase 1
(shadow mode, complete at `7478f7f`).

## Goal

Take the CRDT off the passive shadow and put it **on the wire** between CRDT-aware peers
(nef3 ↔ nef4): exchange state vectors + deltas, and prove the two CRDT replicas **converge
to byte-identical documents** — something shadow-mirroring alone cannot do (each server
mirrors its own view with its own-origin tags; only delta exchange unions those tags).

## Guiding principle: additive & non-authoritative

P10 BURST stays the source of truth this entire phase. CRDT sync runs **alongside**, only
between peers that negotiate CRDT support. Nothing the CRDT does can change client-visible
behavior or P10 state yet. This:
- contains risk (a CRDT bug can't corrupt the network),
- avoids the §16.3 Gap-7 dual-merge problem (CRDT isn't authoritative, so nef3 being both a
  P10 gateway to nefarious *and* a CRDT peer of nef4 is fine),
- gives a clean success metric: **nef3.crdt digest == nef4.crdt digest** after sync.

Making CRDT authoritative / replacing BURST / mesh / the hybrid gateway is **Phase 3+**, explicitly out of scope here.

## What already exists (Phase 0/1)

- Engine: `CrdtOpLog`, `CrdtStateVector` (update/has_seen/global_min), `crdt_state_apply_op`
  (idempotent), `crdt_state_sync(dst,src)` — but all **in-process, pointer-based**. No bytes.
- Shadow already appends every local mutation to the oplog (tagged with this server's origin).
- zstd (`ircd_compress.h`), base64-64 codec (`numnicks.h`), `sendcmdto_serv_butone`.
- Free server flag char `'C'`; `FLAG_*_AWARE` + `Set*/Is*` macro pattern (client.h).
- P10 line cap = `BUFSIZE` 512 → deltas must be chunked across multiple CR lines.

## Increments

### Progress
- ✅ 2.1 wire serialization (crdt-mesh `80baa46`)
- ✅ 2.0a `'C'` capability flag + 2.2a `s2s_chunk` shared helper (crdt-mesh `edca46a`); 14/14 cmocka
- ⏳ NEXT: 2.0b nef4 rebuild+enable · 2.2b CR token + m_crdt.c · 2.3 link sync · 2.4 incremental · 2.5 convergence

### 2.0 — Prereqs (small)
- **Rebuild nef4** on latest `crdt-mesh` (it's on an old image) + enable `FEAT_CRDT_ENABLED`
  in `data/ircd4.conf` (like nef3). Now nef3↔nef4 is a CRDT-aware pair, nef4↔nef3 link.
- **Capability negotiation:** `FLAG_CRDT_AWARE` + `'C'` in `set_server_flags` (m_server.c) and
  the SERVER token flags we emit (s_serv.c). Two peers both advertising `'C'` ⇒ CR sync enabled
  on that link. nefarious/nef1/nef2 don't advertise it ⇒ never receive CR traffic.

### 2.1 — Wire serialization (engine, pure, TDD) — the core ✅ DONE (crdt-mesh 80baa46)
- `crdt_op_encode/decode` (CrdtOp ↔ bytes), per proposal §17.6.3 record layout.
- `crdt_sv_encode/decode` (sparse state vector ↔ bytes, §17.1.4).
- `crdt_delta_encode(oplog, remote_sv)` → bytes of all ops with seq > remote_sv (the wire form
  of `crdt_state_sync`'s logic); `crdt_delta_apply(state, bytes)`.
- CMocka round-trip tests (encode∘decode = id; delta(sv) = exactly the unseen ops; apply is
  idempotent) — same TDD discipline as Phase 0. Biggest pure-engine piece.

### 2.2 — CR P10 token + m_crdt.c (medium)
- Register `CR` token (`msg.h` + `parse.c` msgtab), subtokens **S** (state vector), **D**
  (delta), **U** (incremental update), **V** (version/GC), **F** (full snapshot) — §17.6.1.
- Framing: binary payload → optional zstd → base64 → **chunk via the existing 400-char b64
  pattern** (do NOT invent one — see "Chunking: reuse, don't reinvent" below).
- `ms_crdt` handlers: CR S → compute+send CR D for peer's SV; CR D → decode+apply; CR U →
  apply incremental; CR V → record peer SV (for cross-peer causal-stability GC).

### Chunking: reuse, don't reinvent (resolves the top risk)
The codebase already chunks >512-byte S2S payloads three ways; CR should reuse, and there's a
unification opportunity the user flagged:
- **SASL** (`sasl_auth.c`/`m_sasl.c`) and **chathistory federation** (`m_chathistory.c`
  `send_ch_response` / `ChunkEntry`/`pending_chunks[64]`) are **nearly identical**: 400-char
  base64 chunks, `"+"` "more-follows" marker (or `<400`/absent = end), realloc'd accumulator.
  Each rolls its own.
- **Multiline** (`m_batch.c` `s2s_ml_batches[]`) uses batch framing (BT ±id), not chunking —
  but it's the ONLY one with **per-link cleanup** (`s2s_multiline_cleanup_link`, from
  `exit_one_client`). **Finding: chathistory federation is MISSING per-link cleanup** — its
  reqid:msgid-keyed `pending_chunks[]` leak if a peer dies mid-stream (latent bug to log).
- **DECISION (user): Option C.** Extract a small shared helper `s2s_chunk.{c,h}` —
  `{ char *buf; size_t len, alloc; struct Client *link; }` keyed by a stream id, with
  `s2s_chunk_append()` / `_complete()` / `_cleanup_link()`. **CR uses it now**; migrate SASL +
  chathistory onto it **incrementally/later**. This helper is **crdt-mesh-only** (lives next to
  the CRDT work) and is NOT expected to merge back to ircv3.2-upgrade.

### Chathistory cleanup-gap fix — STANDALONE & cherry-pickable (user requirement)
The chathistory federation per-link cleanup bug exists on **ircv3.2-upgrade and upstream**, not
just crdt-mesh. It MUST be fixed as a **self-contained commit that cherry-picks cleanly back to
ircv3.2-upgrade** — so it CANNOT depend on the CRDT shared helper (which is crdt-mesh-only).
- Fix in `m_chathistory.c` using the EXISTING `pending_chunks[]`/`ChunkEntry` structures:
  add a `struct Client *link` field to `ChunkEntry`, set it from `cptr` in `create_chunk()`,
  and add `chathistory_fed_cleanup_link(struct Client *link)` that frees entries for a dead link.
- Wire the call into `exit_one_client()`'s **IsServer cleanup block** (next to
  `s2s_multiline_cleanup_link` / `s2s_bxm_cleanup_link` / `pending_bx_cleanup_link`). That block
  is identical on crdt-mesh and ircv3.2-upgrade (the CRDT user-remove hook is in the *IsUser*
  block, a different location) → the commit cherry-picks clean with no CRDT context.
- **No CRDT deps** (no crdt_* includes/symbols). Touches only `m_chathistory.c` + the existing
  server-cleanup block in `s_misc.c`.
- Sequence: do this fix FIRST as its own commit (cherry-pickable). The later crdt-mesh migration
  of chathistory onto the shared helper supersedes it ONLY on crdt-mesh; ircv3.2-upgrade keeps
  the standalone fix. Slight redundancy, correct outcome (bug fixed on the shipping branch now).

### 2.3 — Link-time sync (medium)
- On `server_estab` between two `'C'` peers: exchange CR S (state vectors) → each sends CR D
  (what the other lacks). Hook near `server_estab` (s_serv.c) / EOB (m_endburst.c), additive to
  the existing P10 BURST.

### 2.4 — Incremental CR U (small-medium)
- Batch oplog tail over `FEAT_CRDT_BATCH_MS` and send CR U to CRDT peers; receiver applies.
  Ongoing convergence as activity happens.

### 2.5 — Convergence proof (small) — the payoff
- Each server computes a **digest** of its CRDT document (e.g., FNV over a canonical
  serialization); exchange via CR (or log it). After sync, **nef3 digest == nef4 digest**.
- Contrast: before CR sync the digests differ (different origin tags for the same logical
  state) — proving the delta exchange, not the shadow mirroring, produced convergence.

### Deferred to later (2.6+/Phase 3)
- CR V cross-peer GC; CR F full-snapshot fallback for stale/fresh peers.
- The shadow→primary transition (each mutation originates **once** from one server instead of
  every server mirroring everything it sees) — required before CRDT can be authoritative.
- Authoritative mode, BURST replacement, mesh topology, hybrid P10↔CRDT gateway.

## Key risks / open questions
- **512-byte chunking**: RESOLVED via reuse — adopt the existing 400-char b64 chunk pattern
  (see "Chunking: reuse, don't reinvent"). No longer a from-scratch design.
- **Pre-existing bug found**: chathistory federation `pending_chunks[]` has no per-link
  cleanup → orphaned chunks leak on mid-stream peer death. Fix = STANDALONE cherry-pickable
  commit (see "Chathistory cleanup-gap fix" above), NOT folded into the CRDT helper, because it
  must merge back to ircv3.2-upgrade / upstream.
- **Redundant per-origin ops**: in additive shadow mode each server tags the same logical
  state with its own origin; OR-Set union still converges (multiple add-tags are fine), so the
  digest match holds — but it's not the minimal op set. The minimal model is the Phase-3
  shadow→primary transition. Flagged, not solved here.
- **nef4 must be rebuilt + enabled** before any of this is testable.
- Verify the engine's op set is sufficient to round-trip every mutation we emit (servers LWW
  SET/DELETE, members ADD/REMOVE, topic/modes LWW, ban/except ADD/REMOVE).

## Test plan
- 2.1: CMocka round-trip + delta-correctness + idempotency (in the existing crdt_cmocka suite
  / a new crdt_wire_cmocka), run in the build like Phase 0.
- End-to-end: nef3↔nef4 both CRDT-enabled; generate activity; confirm CR S/D/U flow (logs) and
  the digest match; confirm P10 + clients unaffected (additive).
