# R4a — channel traffic over the CR-M mesh (design + plan)

The headline R4 first slice (per `crdt-mesh-roadmap.md` + the bandwidth spike `crdt-mesh-r4-bandwidth-spike.md`):
route live CHANNEL traffic among CRDT-aware servers over the CR-M gossip flood, so it survives a tree-edge
cut with zero client-visible interruption. Prerequisite R3 (exactly-once across tree↔mesh failover) is
DONE + committed (submodule 9b58fdf). Started 2026-06-11.

## Goal & the prize
A channel PRIVMSG/NOTICE/TAGMSG reaches every member exactly once, AND keeps reaching them when a tree
edge on the delivery path dies (the CR-M flood routes around the cut via overlays). Demo: steady-state
channel chat survives a `nef7↔nef5` (or any single tree edge) cut with **zero** dropped/duplicated lines
to members on other servers.

## Current delivery (the baseline)
- **Local-origin** channel msg: `relay_channel_message` (ircd_relay.c:428) → `sendcmdto_channel_butone`
  (tree: local members + per-server-direction relay) + CR M `crdt_gossip_message` ONLY if a member's
  server `IsMeshStub` (ircd_relay.c:844).
- **Server-relayed** channel msg: `server_relay_channel_message` (ircd_relay.c:819) → same shape
  (sendcmdto_channel_butone @838 + mesh-only CR M @851 with `relay_msgid`).
- **CR M receive**: ms_crdt 'M' (m_crdt.c:382) delivers to all LOCAL members, deduped CR-M-vs-CR-M by
  `crdt_m_seen_check_add(msgid)` (m_crdt.c:377; 8192-slot, 90s window).
- So today there is **no overlap**: a member is tree-reachable (gets the tree copy) XOR mesh-only (gets
  CR M). Each member gets exactly one copy.

## The exactly-once challenge R4a introduces
Widening CR M to fire for **any member on a CRDT peer** (not just mesh-only) makes a remote CRDT member M
on server R receive the msg via BOTH paths: the tree relay (S→…→R→M) AND the CR-M flood (S⇝R→M). R must
deliver to M exactly once. The msgid links the two copies (`relay_msgid` == the CR-M `msgid`), so the
dedup key exists — the problem is WHERE to apply it.

**The wrinkle:** `sendcmdto_channel_butone` (send.c:2642) does local delivery AND per-direction server
relay in ONE call (shared per-cap buffers, S2S-tag buffers, alias-split, `sentalong` per-direction dedup).
So at R we cannot simply "skip the call if CR M already delivered" — that would also skip relaying the
tree copy onward to legacy directions. The dedup has to gate the **local-member** sends specifically.

## Two approaches (decision: B, receiver dedup — matches the roadmap + the prize)

**A. Sender path-split** — S sends CR M to CRDT directions and the tree only to legacy directions (skip
CRDT-aware server-directions in sendcmdto_channel_butone). Exactly-once by construction (no overlap), no
receiver state. *Rejected as the primary:* (1) it's really R6 (tree demoted for CRDT peers), not R4's
"tree as backup"; (2) **legacy-behind-CRDT** breaks — skipping the tree to a CRDT direction also skips a
legacy server reachable only through it; (3) it gives no redundancy, so a CR-M loss isn't backed by the
tree. Keep as a possible R6 optimization once all-CRDT is guaranteed.

**B. Receiver dedup (CHOSEN)** — S sends via BOTH planes (tree unchanged + CR-M flood widened to all
CRDT-peer members); each receiving server delivers to its locals exactly once by msgid, whichever copy
arrives first. This is the roadmap's "R3 msgid dedup gating exactly-once at the client," gives the
zero-interruption prize (a cut drops one plane's copy, the other still arrives), and is legacy-safe (the
tree copy still reaches legacy-behind-CRDT). Cost: redundant send (~2.5× tree for broadcast per the
spike — acceptable) + a per-msgid local-delivery gate.

### The dedup mechanism (the implementation crux)
A per-server "channel msgid already delivered to my locals" gate that BOTH the tree local-delivery and
the CR-M local-delivery consult+set. Reuse `crdt_m_seen` (it already is exactly this set, keyed by msgid).
- **CR-M path** (m_crdt.c:377): already `check_add`s — keep.
- **Tree path**: the local-member sends inside `sendcmdto_channel_butone` must be **suppressed** when the
  msgid was already CR-M-delivered, while still relaying to server-directions. Candidate hooks (pick during
  impl, lowest-risk first):
  1. **Gate at the per-local-member send** inside the member loop (send.c, after the relay/local split):
     thread the channel msgid in (already available via `sendcmdto_set_client_msgid`) and skip the user
     send if `crdt_m_seen`-seen. Most surgical re: relay, but touches the hot loop.
  2. **Split local vs relay** in `server_relay_channel_message`/`relay_channel_message`: do the
     server-direction relay via the existing call (suppressing local) + a separate local-only delivery
     that checks the gate. More code, keeps send.c untouched.
  3. **Order guarantee + entry gate**: if we can guarantee the tree copy is processed before the CR-M
     copy at R (NOT guaranteable — independent paths), an entry gate would suffice. Rejected (racy).
  → Lean toward (1): add an optional "dedup-by-client-msgid for local members" flag to
  sendcmdto_channel_butone, set by the channel relays when CRDT-primary, checked at the local-member send.
  Set the msgid in `crdt_m_seen` on first local delivery (either plane).
- **Self/echo**: the sender's own locals are delivered by S directly and S doesn't CR-M to itself — no
  dupe there. Watch `bump_sentalong`/SKIP_BURST interplay.

### Trigger widening
In `relay_channel_message` (ircd_relay.c:844) + `server_relay_channel_message` (:851) + the m_tagmsg.c
equivalents, change the member scan from `IsMeshStub(server)` to **`server is a CRDT peer`** (IsMeshStub
OR (IsServer && IsCrdtAware) — i.e. crdt-reachable + not local), gated on `FEAT_CRDT_PRIMARY`. One
gossip call still covers all mesh members (the flood fans out).

## Incremental slices
1. **R4a-0 (harness):** channel exactly-once test — receivers JOIN #chan on nef5+nef7, sender on nef3
   PRIVMSGs #chan N times; assert each receiver gets N (no dup, no drop). Steady-state first (currently
   green via tree), then across a `nef7↔nef5` cut (the prize). `/tmp/crdt4c/r4achan.sh` (throwaway).
2. **R4a-1:** implement the local-delivery dedup gate (hook 1) — no behavior change yet (CR M still
   mesh-only), just the gate + crdt_m_seen wiring; confirm steady-state still 1×.
3. **R4a-2:** widen the CR-M trigger to all-CRDT-peer members; confirm steady-state still exactly-once
   (dedup works) + bandwidth sane.
4. **R4a-3:** the prize — cut a tree edge mid-stream; confirm zero drop/dup (tree copy lost on the dying
   edge, CR-M copy arrives via overlay, deduped).
5. Commit (submodule + pointer) once green; re-measure bytes (spike follow-up).

## Risks
- **Hot-path send.c change** — sendcmdto_channel_butone is core; a wrong gate drops legitimate delivery or
  double-delivers. Gate strictly on FEAT_CRDT_PRIMARY + CRDT-aware; cmocka can't cover this (integration),
  so the r4achan harness is the gate. Test legacy (non-CRDT) channels unaffected.
- **msgid availability on every channel path** — the tree path must have the SAME msgid the CR M uses
  (`relay_msgid`/`cli_s2s_msgid`); a missing/"*" msgid disables dedup → dupes. Audit all channel relays.
- **NOTICE/TAGMSG** parity — apply the same widening+dedup to 'N' and 'T' (m_tagmsg.c).
- **crdt_m_seen capacity** — 8192 slots / 90s window; at high channel rates this could wrap. Size check
  under load (spike follow-up); the window only needs > worst-case tree-vs-mesh arrival skew (sub-second),
  so 90s is very safe, but slot COUNT vs message rate matters — measure.
- **Bouncer alias / echo-message** interplay on the dedup gate — verify alias forwarding + echo still fire
  once (they're separate from the channel fan-out but share msgids).

## Constraints (standing)
Submodule push to `origin crdt-mesh`; testnet pointer staged ONLY as `nefarious-crdt`; `Co-Authored-By`
trailer; configs uncommitted; cmocka gates the image; verify the `ircd.YYYYMMDDHHMM` symlink advances per
build (+ recreate via StartedAt, NOT a listener poll; never per-command-redirect the `up`).
