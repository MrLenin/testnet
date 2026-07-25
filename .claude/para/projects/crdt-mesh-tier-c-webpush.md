# Tier C F2-c — WEBPUSH subscription convergence over the mesh

Scoped + designed 2026-07-25 (recon on crdt-mesh @ 773857d). Executed directly (TDD + opus
review), F2-b-sized. **Reclassifies WEBPUSH out of F5**: the scope doc filed WEBPUSH under F5
"ephemeral notices / accept-degrade," conflating the push MESSAGE (genuinely ephemeral, local,
accept-degrade) with the push SUBSCRIPTION (persistent, account-anchored state). The subscription
is F2-class — it belongs in the doc, exactly like read-markers (F2-a) and account metadata (F2-b).

## Recon facts (ground truth)

- **Subscription state** = per-account set of `{endpoint, p256dh, auth}`, stored in LMDB via
  `webpush_store_add/remove/foreach/foreach_all` (webpush_store.c), stored-blob form
  `"endpoint|p256dh|auth"` (m_webpush.c:227). Account-anchored, persistent, low-frequency.
- **Sync today** = P10 `WP R/U/B` tree broadcast + link burst ONLY (m_webpush.c:237/284/510;
  ms_webpush :709/730/746). No doc mirror (zero hits in crdt_shadow/crdt_state). → a subscription
  registered on the hub NEVER reaches an overlay-only leaf, and does NOT survive a tree-cut
  partition. A mobile push for a user whose bouncer session / missed message lands on such a node
  silently never fires. This is the F2 beyond-horizon gap, for the fork's headline mobile feature.
- **Removal paths**: explicit `WP U` (unregister); expiry-driven `webpush_store_remove` when a
  push attempt gets HTTP 410/404 (m_webpush.c:363). NO user-quit reap — subscriptions are
  ACCOUNT-keyed and persist across sessions/quits (unlike TEMPSHUN's user-keyed register). The
  only deletes are explicit unregister + expiry.
- **VAPID key** (`WP V`) is a per-server key, not per-subscription — OUT of scope, untouched.

## Design (F2-b metadata analog, verbatim where possible)

- **Collection** `CRDT_COLL_WEBPUSH`: key = `account\0endpoint` (opaque, mirrors metadata's
  `account\0key`), value = the full `"endpoint|p256dh|auth"` stored blob (endpoint redundant with
  the key but makes reconcile a trivial `webpush_store_add(account, value)` — no reconstruction).
  LWW (a re-register of the same endpoint rotates keys → newest wins). Endpoints are long URLs
  (≤ WEBPUSH_MAX_ENDPOINT_LEN) → size doc-key buffers for `ACCOUNTLEN + WEBPUSH_MAX_ENDPOINT_LEN`
  (the P2 CHANNELLEN-widening lesson: don't inherit a too-small key buffer).
- **Mirror (live→doc)** — the F3/§17.7 entry-node pattern:
  - `webpush_cmd_register`/`_unregister` (LOCAL origin, m_webpush.c:180/258): ALWAYS mirror —
    `crdt_shadow_webpush_set(account, endpoint, blob)` / `_remove(account, endpoint)` after the
    existing store write + tree broadcast.
  - `ms_webpush` WP R/U/B (RELAYED): mirror only when `!IsCrdtAware(cptr)` (a legacy/gateway-edge
    arrival — inject legacy-originated subs into the mesh; §17.7 gateway). A CRDT-relayed arrival
    is already in the doc via the flood → no re-mint. (Exact F3 ms_tempshun predicate.)
  - Expiry removal (m_webpush.c:363): mirror `_remove` (the expired sub is gone network-wide;
    LWW-correct wherever the push attempt happened).
- **Reconcile (doc→store)** `crdt_shadow_reconcile_webpush`: SET-heal walk (foreach doc-live
  entries → `webpush_store_add` if not already identical — echo-guard via a store presence/blob
  compare so unchanged rows aren't re-written every tick, the metadata quality bar) + a delete
  store-walk (invariant 11: live-walk `webpush_store_foreach_all`, `webpush_store_remove` any
  row whose `account\0endpoint` doc key is absent/tombstoned — collect-then-act). Logs
  applied/removed counts at L_INFO (the live-gate observability).
- **EAGER-suite wiring (the F3 lesson, load-bearing):** add `crdt_shadow_reconcile_webpush()` to
  ALL THREE reconcile sites — the m_crdt.c eager-delta suite (else it converges only on the 30s
  tick and the live gate races it), the verify_cb suite, and materialize_live.
- **Wire/digest/snapshot:** enum appended at tail; `snap_put_lww` line; digest salt 23 in both
  digest functions; generic LWW op-apply + snapshot reader already NULL-guard unknown colls
  (forward-compat: old peers read-and-discard). Mirror the F2-b metadata sites 1:1.
- **Single-writer:** the doc op is minted once at the origin (local cmd) or the gateway edge
  (`!IsCrdtAware`); relayed CRDT applies do their own `webpush_store_add` (store materialization)
  but DON'T re-mint. No suspend bracket needed (unlike metadata) because ms_webpush's store
  writes are DIRECT (webpush_store_add), not through a doc-mirroring chokepoint — so simply
  not-mirroring on the CRDT-relay path is sufficient.
- **Legacy P10 unchanged:** WP R/U/B tree broadcast + burst stay, serving legacy/tree peers.

## Tests

- **cmocka (engine gate):** `test_webpush_op_replicates` — `account\0endpoint` SET / LWW
  key-rotate / DELETE / snapshot roundtrip + convergence (the metadata-op test shape with the
  webpush key form). Engine is key-agnostic → a regression lock.
- **Live gate** `tests/clocktest/f2c_webpush.py` (the p1_doconly tree-cut recipe): client A
  auths on hub nef3, `WEBPUSH REGISTER <endpoint> <keys>`. Cut the nef3↔nef4 tree link (netshoot
  sidecar). Register a SECOND endpoint on nef3 → doc-only path to the cut leaf (nef4 reaches it
  via the nef5 overlay). Assert nef4's reconcile log shows the subscription materialized into its
  store (both endpoints), and mdigest converges. Then unregister → assert the delete converges
  (reconcile-remove log + mdigest). Restore link. (No real push delivery needed — the gate is
  subscription-state convergence, observable via the reconcile log + digest.)

## Invariants checked

- Inv 3 (op-recording setters), 4 (blob value: char string, memset the record), 8 (full-walk
  reconcile), 11 (live-walk for removes) — all mirror the F2-b metadata implementation.
- Account-anchored → depends on account-prop (FIXED this session, [[project_crdt_account_prop_leaf_defect]]);
  a leaf now knows client accounts, so `IsAccount(sptr)` + `cli_account` resolve for the mirror.
- No user-quit reap (account-keyed, persists across quits) — deletes are explicit-unregister +
  expiry only. Differs from TEMPSHUN; do NOT add a user_remove reap.

## Cross-refs
F2-a read-markers / F2-b metadata (`crdt-mesh-tier-c-f2.md`) — the template. Sibling F3 TEMPSHUN
(`crdt-mesh-tier-c-f3.md`) — the entry-node mirror-gate pattern + the eager-suite lesson.
