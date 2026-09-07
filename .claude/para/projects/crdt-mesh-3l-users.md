# CRDT-Mesh Phase 3 last item — USERS via CRDT (scope/design)

Status: SCOPE (read-only design pass, 2026-06-09). The keystone — the routing substrate every
other class references by numeric. After this, P10 introduce/nick/umode/QUIT are off the wire to
CRDT peers and the §17.7 gateway bridges to legacy, completing Phase 3.

## What already exists (no new work)

**Engine** — op-recording, NB5-clean:
- `crdt_user_set` / `crdt_user_remove` (LWW `users` map, full `CrdtUserRecord` payload: nick, ident,
  host, realname, account+acc_create, umode LETTERS, ip6[16], nick_ts, owning server). Both record ops.
- `crdt_nick_claim` + `crdt_resolve_nick_collision` + `crdt_nick_force_rename` (the §17.5 collision
  resolver) — present but the shadow does **not** call nick_claim yet (collision = deferred).
- `crdt_user_visible` — owning-server-ACTIVE gating (for the §17.3 SQUIT-as-SPLIT design).

**Producer (doc population) — ALREADY FULLY WIRED, behind the 3a single-writer gate:**
- `crdt_shadow_user_add` at register_user [s_user.c:1009], nick-refresh [s_user.c:1348], umode-refresh
  [s_user.c:2571]. So create/nick-change/umode all land in the doc today.
- `crdt_shadow_user_remove` at exit_one_client [s_misc.c:334] — tombstones on quit (LWW delete).
- All gated `from_crdt_peer(cli_from(cptr))` → the local/legacy-inbound server is the single writer.

**Read path (create)** — `mat_create_user_cb` ([crdt_shadow.c:768]) already builds a live remote
Client from a `CrdtUserRecord` (modeled on the set_nick_name IsServer remote-create branch
[s_user.c:1078]): make_client + SetRemoteNumNick(findNUser-guarded) + account/umode/UserStats. Used
by `materialize_live` (the 3c BURST replacement). **It is LOCAL-ONLY — no §17.7 gateway emit.**

## What's missing (the entire delta = suppress + reconcile/gateway)

### Producer suppress points (P10 → CRDT peers), under FEAT_CRDT_PRIMARY
1. **NICK introduce** — the FLAG_IPV6 two-call split [s_user.c:852 / 863]. Call-1 is
   `require=FLAG_IPV6, forbid=FLAG_LAST_FLAG`; **change forbid → FLAG_CRDT_AWARE** so it targets
   IPv6-capable *legacy* peers only. Call-2 (`forbid=FLAG_IPV6`, the non-IPv6 peers) is **vacuous in
   this testnet — every link negotiates FLAG_IPV6** (built with v6 even on Docker's v4 bridge), so
   not forbidding CRDT there is harmless. *VERIFY FLAG_IPV6 on the live links first.* (General-case
   limitation: a non-IPv6 CRDT peer would double — documented, not reachable here. `sendcmdto_flag_
   serv_butone` takes a single require + single forbid, so a non-IPv6 CRDT peer can't be excluded
   without restructuring to an explicit IsCrdtAware check.)
2. **NICK rename** — [s_user.c:1254] `sendcmdto_serv_butone(sptr, CMD_NICK, cptr, "%s %Tu", …)` →
   `sendcmdto_flag_serv_butone(…, FLAG_LAST_FLAG, FLAG_CRDT_AWARE, …)` legacy-only.
3. **umode** — `send_umode_out` [s_user.c:1554-1559] is a manual `LocalClientArray` loop emitting
   `CMD_MODE` per server via `sendcmdto_one`; add `&& !(IsCrdtAware(acptr) && FEAT_CRDT_PRIMARY)` to
   the loop guard (mirror the QUIT loop). Remote-primary umode propagation [s_user.c:1942] likewise.
4. **QUIT** — [s_misc.c:1018], inside the `cli_serv(&me)->down` loop; add the CRDT-peer skip to the
   QUIT branch condition (the loop is a manual `sendcmdto_one`, not `sendcmdto_serv_butone`).
5. **SQUIT** — [s_misc.c:1000], same loop. **Left on P10** (see SQUIT decision below).

### Consumer — a NEW `crdt_shadow_reconcile_users()` (none exists; only the bulk materialize)
Walk the doc `users` LWW map on CR D/U + the verify timer:
- **create**: not-yet-live (findNUser==NULL) + a real record → `mat_create_user_cb` (reuse) **+ a new
  §17.7 gateway NICK emit** to legacy: re-introduce the freshly-materialized Client with the
  register_user FLAG_IPV6 split, sourced from the owning server, `forbid=FLAG_CRDT_AWARE`. (Mirror of
  3f reconcile_members: materialize locally, then gateway the wire token.)
- **rename**: live user whose doc nick ≠ live nick → local rename (hRemClient/hAddClient +
  common-channel NICK notify) + gateway NICK to legacy.
- **umode**: live user whose doc umode LETTERS ≠ live → `user_apply_umode_str` (or a diff'd
  send_umode) + gateway MODE to legacy.
- **delete-on-leave**: doc entry is a tombstone → exit the materialized user + gateway QUIT to legacy.
  **Tombstone-gate** (the 3g lesson, user-level): remove ONLY on an explicit LWW *delete-tombstone*,
  NEVER on mere absence/GC. → **ENGINE CHECK for the remove cut:** does `crdt_lwwmap` retain a
  delete-tombstone (data_len==0, ts set) distinguishable from absent? If not, that's the one engine
  add for the remove sub-phase (a `crdt_user_is_explicitly_removed` analog of
  `crdt_orset_is_explicitly_removed`). Verify in crdt_types.c before building 3m.

Loop/echo safety: reuse the proven `from_crdt_peer` self-gate on the producer hooks — a reconciled
create/rename/umode/remove has `cli_from` = a CRDT peer, so the hook self-skips (no re-mint), exactly
as membership did. No `nomirror` variant needed (the umode case may need care — verify, since 3e
modes needed nomirror because its from was &me, not a peer).

## Hazards specific to USERS (why it's the keystone, not a mop-up)
- **Routing substrate lag.** Users are referenced by numeric everywhere. Eventual-consistency lag
  means a JOIN/PRIVMSG can arrive referencing a not-yet-materialized numeric → the historical
  "Cannot send to channel" class (see the bouncer-defer post-mortem, s_user.c:833-849). Channel
  reconcilers already findNUser-retry, so *membership* self-heals; *messaging* to a lagging user can
  transiently fail. **Accepted for the PoC** (documented in memory).
- **Attendant introduce traffic not in the doc.** register_user also emits BS A (bouncer session,
  [s_user.c:877]), MARK webirc/sslfp/cversion [888-925], AWAY [754] — none captured in
  `CrdtUserRecord`. If NICK is suppressed but these still flow via P10, they reach a CRDT peer that
  has no user yet → findNUser-fail drop (harmless) or ordering races. **Scope decision:** bouncer on a
  CRDT-mesh leaf is its own can of worms → keep bouncer/MARK/AWAY out of the USERS cut; let them ride
  P10 to legacy only; CRDT peers reconstruct just the `CrdtUserRecord` fields. (AWAY could be added to
  the record later; MARK/BS A are deferred.)
- **SQUIT ≠ QUIT (the §17.3 elegance vs PoC pragmatism).** Proposal §17.3: SQUIT is a server-state
  transition (ACTIVE→SPLIT) that *hides* users, zero tombstones, so netsplit account-persistence is
  free; `crdt_user_visible` already gates on it; `crdt_server_squit` exists. But nothing in the shadow
  emits it yet, and full visibility-gating in materialize/reconcile + relink re-materialization is a
  chunk. **PoC decision: keep SQUIT on P10** — the 3c-verified cascade tears down materialized users
  cleanly on uplink loss (no assert). The §17.3 SPLIT design is a later refinement. So the remove cut
  is **clean QUIT only via CRDT**, SQUIT stays P10 (exactly how 3g did PART-via-CRDT / KICK+QUIT-P10).
- **Nick collision.** Two CRDT peers claiming a nick concurrently → two numerics, same nick string in
  the LWW map, no auto-resolution unless `crdt_nick_claim`/resolver is wired. Engine resolver exists;
  P10 is the backstop. **Deferred** (live nick-collision is a known follow-up).
- **The introduce gateway double-emit.** A legacy user (nef1) is mirrored into the doc by the gateway
  (nef3, single-writer since nef1 is non-CRDT) → propagates to leaves who materialize. A CRDT-leaf
  user (nef5) reconcile-creates on nef3 → gateway NICK to nef1. The `from_crdt_peer` gate + the
  findNUser idempotency guard prevent loops (same structure as 3f JOIN-gateway, proven).

## Proposed slicing (recommended: 3 sub-phases, mirrors membership 3f/3g/3h)

Each is independently shippable — earlier cuts keep the not-yet-cut direction on P10, exactly like
3f(JOIN-CRDT)/3g(PART-CRDT) coexisted with P10 removal until 3g.

- **3l — INTRODUCE + steady-state CREATE (the "add" half).** Suppress NICK introduce (call-1 forbid
  CRDT). New `crdt_shadow_reconcile_users()` create-only + §17.7 gateway NICK. Removal still P10
  (so quit users still tear down normally; the producer tombstone already lands in the doc and
  mat_create skips tombstoned entries → no ghost-recreate). **Foundational — everything depends on it.
  Medium risk** (substrate lag; guards already exist). RECOMMENDED FIRST.
- **3n — NICK-change + UMODE (the "update" half, the LWW-value-change analog of 3h/3e).** Suppress
  NICK rename + umode MODE. reconcile gains rename + umode + gateway. **Medium risk** (rename touches
  the nick hash; umode is LWW-clean). Can slot before or after 3m.
- **3m — QUIT / delete-on-leave (the "remove" half, the risky one like 3g).** Suppress S2S QUIT +
  tombstone-gated reconcile-remove + gateway QUIT. SQUIT stays P10. **HIGH risk** (the substrate-
  remove; the 3g resurrection lesson applies; needs the LWW-tombstone-gate engine check). Do LAST,
  on a stable create/update base.

Recommended order: **3l → 3n → 3m** (risky remove last). Alternatives: 2-cut (create+update / remove)
or all-at-once (high blast radius — not recommended for the keystone).

## Verification template (nef1[legacy]—nef3[gateway]—nef4,nef5[CRDT])
Per cut, the established discriminator pattern:
- Build FRESH + confirm (NB6): `docker exec … strings …/bin/ircd | grep -c <new-log-string>` >0 +
  `ircd.YYYYMMDDHHMM` advances; `--no-cache` if stale.
- 3l: new user on nef5 → nef4 via CRDT only (zero P10 `N` token on nef4) + nef1 via gateway NICK
  (sourced from the owning server numeric, the CRDT→P10 discriminator). Legacy user on nef1 → leaves
  via mirror→CR→reconcile, no echo. /WHO + /WHOIS parity (account, umodes). 2-hop anti-entropy lag
  expected (NB8).
- 3n: /nick on nef5 visible everywhere via CRDT+gateway; umode +i/+x converges; no echo to origin.
- 3m: /quit on nef5 → removed everywhere via CRDT (zero P10 `Q` on nef4) + gateway QUIT to nef1;
  SAFETY CANARY: no live user wrongly removed on sync lag (the 3g gate); SQUIT still tears down
  cleanly. Concurrent nick-collision: P10 backstop holds (resolver deferred).
- All cuts: cmocka still green, 0 crashes, valgrind clean, 0 ts=0 anomalies.

## Execution gates (per CRDT phase norm)
Rebuild nef3/4/5 via `scripts/dc.sh -l --profile multi up -d --build nefarious3 nefarious4
nefarious5` (`--no-cache` if stale). Commit at each sub-phase boundary
(`feedback_crdt_commit_each_phase`): submodule push to origin crdt-mesh + testnet pointer staged as
ONLY nefarious-crdt; data/ircd*.conf + nef5/CRDT_PRIMARY config stay UNCOMMITTED. TDD where an engine
change occurs (the 3m LWW-tombstone-gate, if needed).
