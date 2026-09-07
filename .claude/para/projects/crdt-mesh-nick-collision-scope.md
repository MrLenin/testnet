# live nick-collision via CRDT (§17.5) — scope + design (2026-06-09)

> **STATUS 2026-06-28:** the resolver IS built and wired — `crdt_resolve_nick_collision` is invoked at
> crdt_shadow.c:3099 (the materialize/update detection hook), and `crdt_nick_force_rename` exists in the
> engine. So this is no longer "scoped, no code." The remaining gap is **live-validation**: exercise a
> real concurrent-same-nick claim across two CRDT leaves under partition+heal and confirm both
> converge to the resolver's single winner with a clean client-visible rename (no ambiguous nick hash,
> no ghost). Treat as a TEST/validation task, not a build task. SMALL.

## The gap
Pre-3l, P10's collision-kill backstop fired when a duplicate-nick N arrived via P10. Since 3l
(introduce) + 3n (nick-change) suppress N to CRDT peers (it rides the doc), two users on DIFFERENT
CRDT leaves can claim the same nick concurrently → both land in the doc `users` map with nick "bob"
→ materialize `hAddClient`s two "bob" → ambiguous nick hash. The convergence window is now ~0.6s
(post eager-relay), so the trigger is narrow but real (two unauthenticated users racing a nick).

## Engine (already present, tested — scenario B): NO engine change
- `crdt_resolve_nick_collision(local, remote, registered_owner)` → winning claim. Rule: account-owner
  wins (if registered) → else different user@host: OLDER `claimed_at` wins → same user@host: NEWER
  wins → tie: lower `node_id`. Deterministic on shared data ⇒ every server picks the SAME winner.
- `crdt_nick_force_rename` exists but writes raw lwwmap (local) — we do NOT use it; we drive the live
  rename through set_nick_name instead (so clients + gateway see a real NICK), and the producer hook
  mirrors the numeric into the doc.

## Design (pure shadow; build claims ad-hoc from user records)
**Detection** at the two nick-setting sites: `crdt_materialize_one_user` (create) and
`crdt_reconcile_user_update` (rename). Before claiming nick N for user U, `FindClient(N)`:
- free → take N.
- held by a different live user V → build `CrdtNickClaim` for U (from its CrdtUserRecord) and V (from
  its live Client): numeric, `claimed_at`=HLC{physical_ms = nick_ts*1000, node_id = owning-server
  numeric}, ident, ip (32-bit fold of ip6), account. registered_owner = NULL (account-aware step
  DEFERRED — needs X3 nick-registration data). Run the resolver → loser L.

**Resolution — home-server-authoritative + non-home-defer (the no-oscillation rule):**
- L == V and V is LOCAL (MyConnect) → force-rename V to its numeric via
  `set_nick_name(V, V, numeric, …, svsnick=1)` (svsnick bypasses NICKDELAY/ban checks; broadcasts the
  NICK — suppressed to CRDT + §17.7-gatewayed per 3n; producer mirrors numeric→doc). Then U takes N.
- L == V and V is REMOTE → do NOT rename V here (not our user). Give U its NUMERIC for now (defer);
  V's home server will force-rename V, the doc converges, and reconcile then aligns U→N. (Avoids
  non-home servers renaming a remote user into a collision → no ping-pong/oscillation.)
- L == U → give U its NUMERIC (U lost; defer if it should later win — same 2-step convergence).

The LOCAL-loser force-rename fires when THIS server materializes/reconciles the WINNING remote user
into a nick its own local user holds — i.e. the loser's home server resolves within ~0.6s (eager
relay). Non-home servers never create a duplicate (loser-candidate → numeric) and converge in ≤2
monotone reconcile steps once the home server's authoritative rename propagates.

**Convergence:** the resolver is deterministic on replicated user-record data, so all servers agree
on the winner; only the loser's HOME server mutates the doc (single-writer) → no multi-writer churn.

## Touch points
- crdt_shadow.c: a helper `crdt_resolve_live_nick(want_nick, in_rec/in_numeric) -> effective_nick`
  (+ force-renames a local holder when the holder loses). Hook in `crdt_materialize_one_user` (before
  cli_name/hAddClient) and `crdt_reconcile_user_update` (before the set_nick_name rename).
- Build-claim helper (CrdtUserRecord/Client → CrdtNickClaim); 32-bit ip fold.
- No producer change, no nicks-map use, no engine change, no wire change. cmocka 32.

## Deferred
- Account-aware resolution (registered_owner) — needs X3 nick-registration lookup; timestamp rule is
  convergent + matches P10 without it.
- Same-numeric reuse races; the nicks LWW map (unused by this design — claims built ad-hoc).

## Verify (nef1—nef3—nef4,nef5)
Two clients claim the SAME nick on nef4 and nef5 within the convergence window → converges to ONE
holder of the nick everywhere; the loser shows its numeric (not killed), keeps its connection +
channels; NO duplicate/ambiguous nick on any server; no oscillation (bounded NICK events); gateway
shows the rename on legacy; 0 crashes. Also: same-user reconnect (same ident/ip) → newer wins.
