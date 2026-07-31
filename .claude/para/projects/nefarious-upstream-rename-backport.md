# Upstream channel-rename backport (evilnet/nefarious2)

Planned 2026-07-31. Status: **APPROVED — §3 decided 2026-07-31 (user): dedicated `r`
SERVER flag. Implementable; sequence per §4 (r-flag plumbing patch first).**
This is the patch that un-drafts [evilnet/x3 #57](https://github.com/evilnet/x3/pull/57)
and lifts [[x3-channel-rename]]'s dynamic-guard restriction during production's mixed
fork/legacy period. Publish rights on evilnet/nefarious2 exist
(memory `project_upstream_publish_rights`).

## 1. What the backport is

Full RENAME support on upstream master — client command, services arbitration
(AC R query / A-D reply), RN application + relay, PART/JOIN presentation for
non-cap clients — so an upstream server neither diverges on RN nor blocks the
network-wide guard. Port source: fork `feature/channel-rename` @ 6ad0c49
(`m_rename.c` and satellites).

## 2. Port inventory (recon 2026-07-31, verified against nefarious-upstream)

**Verbatim drops (no adaptation):**
- `hChangeChannel` (fork hash.c:217-231 — 15 lines; upstream lacks it, substrate
  identical: `strhash`, `hRemChannel`, `channelTable` all present).
- `rename_channel` (fork channel.c:2042-2127) — upstream `chname[1]` tail-alloc,
  `destruct_event`, membership lists all identical; zero edits.
- msg.h RN token + parse.c msgtab entry (struct Message byte-identical; `RN`/`RG`
  letters free upstream).
- `F_B(RENAME_SERVICES, 0, 0, 0)` + enum (F_B macro shape identical).
- Cap registration `draft/channel-rename` — upstream `_CAP` table takes it as a
  3-line add (**no cap value, no cap-notify upstream** — the fork's
  feature-notify callback must be dropped; plain cap only).
- m_account.c A/D cookie graft (~30 lines at the structurally-identical
  `FindNServer(parv[1])` point; upstream handles the same 8 AC letters as the fork).
- The ZANNELS-off completion re-validation (`sub1_from_channel` is byte-identical
  upstream — the destruct-and-recreate window exists there too; port verbatim).
- ~90% of m_rename.c incl. the whole pending-rename table.

**Small rewrites:**
- `send_fail` → port a tag-free `send_standard_reply` (~30 lines over
  msgq_make/send_buffer). Upstream has NO standard-replies at all; the fork's
  version drags label/server-time deps. 10 call sites in m_rename.c.
- `sendcmdto_serv_butone_v3` → upstream already has the right primitive:
  `sendcmdto_flag_serv_butone(from, cmd, tok, one, require, forbid, ...)`
  (send.h:48). One-line wrapper over a new FLAG once §3 decides the flag.

**Drops (bouncer-only, removing them simplifies):**
- `bouncer_session.h` include, alias→primary rewrites in the AC emit and the
  legacy-services forward (collapses to a bare sendcmdto_one loop),
  `CapOwnHas` → `CapActive`.

## 3. THE design decision: how upstream signals rename-capability

The fork gates everything on the `v` (IRCv3-aware) SERVER flag. Two facts:

- **Upstream re-synthesizes SERVER flags from bitflags at every relay/burst site**
  (`m_server.c:786`, `s_serv.c:191`, `s_serv.c:237` — rebuilt from
  `IsHub/IsService/IsIPv6/IsOpLevels`, parv[7] never echoed; unknown letters
  parsed-and-discarded with no default case). A flag that isn't plumbed into a
  bitflag + all three emit sites **does not survive one upstream hop** — the one
  silent-failure hazard in this whole port. (The fork's own tree carries `v`
  correctly at its equivalents — s_serv.c:203/280 — a recon claim to the contrary
  was checked and is wrong.)
- **Upstream must NOT advertise `v` itself**: `v` means the full v3 S2S dialect
  (metadata burst, ML, TG, BX…); a fork peer would send all of it and upstream
  silently drops (`is_unco`) — silent cross-hop degradation of every fork feature
  on mixed networks. Ruled out.

**Recommended: a dedicated `r` SERVER flag = "applies and relays RN".**
- Upstream: `FLAG_RENAME_CAPABLE` + parse `r` in `set_server_flags` + emit at all
  FOUR sites (own SERVER line ×2, relay, burst ×2) — the emit-site completeness IS
  the patch's hard part; the guard checks `!RenameCapable && !IsService`.
- Fork follow-up (small, separate commit on the fork): parse `r` → set the same
  notion (`SetRenameCapable`; fork servers imply it via `v`); RN emission for the
  rename paths targets `v OR r` peers (only RN — nothing else widens); guard
  updated to accept `r` peers. Until this lands, fork guards treat upstream+patch
  as legacy — correct-but-restrictive, no breakage.
- Convergence bonus: X3 (with #57) can later advertise `r` itself, making the
  targeted legacy-services forward unnecessary — keep the forward for
  compatibility with non-`r` X3 regardless.

Alternative rejected: no flag + fleet-atomic upgrade assumption — silently wrong
on any mixed-version network, which is the exact population a backport serves.

## 4. Sequencing

1. Decide §3 (recommend `r` flag).
2. Branch off evilnet/nefarious2 master; port per §2 inventory; the `r`-flag
   plumbing patch FIRST (it's independently reviewable and the risk concentrate).
3. Bed verification: the nefarious-upstream comparison slot rebuilt with the
   branch; fork+upstream mixed topology on the bed — this finally lets the rename
   gate run on the FULL bed (guard sees `r` on the upstream slot; CRDT anchors
   remain blockers unless the anchor mint learns to carry flags — out of scope,
   noted for [[crdt-mesh-roadmap]]).
4. PR to evilnet/nefarious2. After merge: un-draft #57; then the deferred testnet
   working-tree checkpoint ([[x3-channel-rename]] queue).

## 4a. IMPLEMENTED + REVIEWED 2026-07-31 (branch `feature/channel-rename` on
`nefarious-upstream`, HEAD f308ff0, base master 919e035, NOT pushed)

- **B1 `26b242b`** — `r`-flag plumbing: `FLAG_RENAME_CAPABLE` + macros, parse in
  `set_server_flags`, emit at all 5 SERVER-flag synthesis sites (own line ×2
  unconditional, relay + burst ×2 conditional on `IsRenameCapable`),
  `SetRenameCapable(&me)` in ircd.c. Review confirmed all 5 sites, cross-hop
  survival, no straggler.
- **B2 `78f91db` → f308ff0**` — the port: hChangeChannel + rename_channel verbatim
  (UAF fix present), plain cap, tag-free `send_fail` (now **source-prefixed**
  `:<me> FAIL …` per the fork's matching fix — user decision 2026-07-31), RN token,
  flag-filtered RN broadcast via `sendcmdto_flag_serv_butone(…, FLAG_RENAME_CAPABLE,
  FLAG_LAST_FLAG, …)`, full pending-rename table incl. ZANNELS completion
  re-validation, m_account A/D cookie graft. Enum/cap insertions boot-assert safe.
- **F1 `f308ff0` (also fixed in the FORK `957f493`)** — timeout-path UAF:
  `pending_rename_timeout_cb` freed `pr` (embedded timer) in ET_EXPIRE →
  `timer_run` touched freed memory post-return. Fixed: unlink in ET_EXPIRE,
  `MyFree` only in ET_DESTROY, `timer_active` guard, `next`-cache in client-exit
  loop. Free-once verified across all 5 teardown paths. **Was byte-identical in the
  fork — inherited, not port-introduced; only fires on services-silent 10s timeout,
  which is why every gate missed it.**

Review verdict after F1: the port is clean. Two tracked items below.

### DEPENDENCY (blocks end-to-end, NOT the upstream PR itself): X3 must advertise `r`
On upstream, RN is broadcast only to `FLAG_RENAME_CAPABLE` peers. X3 introduces
`+s6o` — **no `r`** — so it gets the AC query (direct send via
`find_services_server`) and *authorizes* a rename it **never receives the RN to
apply** → X3 diverges. The fork's targeted legacy-services forward covered this;
the upstream port dropped it by design. **Un-drafting [evilnet/x3 #57] therefore
requires an X3 change: advertise `r` in `irc_server()` (proto-p10.c:534/537, add the
letter) — X3 already has the RN handler from #57.** This is the real gate on #57,
independent of the upstream PR landing (which is safe alone: FEAT_RENAME_SERVICES
defaults off). Add to #57's scope before it leaves draft.

### TRACK (inherited, feature-gated): F2 — AC cookie aliases into P10 numeric space
`ms_account` tries `FindNServer(parv[1])` before the cookie path; decimal cookies
are valid P10 base64, so on a net with a colliding server numeric a rename reply is
misrouted as a LOC reply → silent timeout. Byte-identical in the fork, reachable
only with FEAT_RENAME_SERVICES on. Clean fix = a `RENAME` discriminator in the reply
(mirror what #57 did request-side). Low priority; note on #57.

## 5. Explicitly out of scope

- Batch/labeled-response/server-time decoration of the rename (upstream has none
  of the substrate; plain cap + bare RENAME/PART/JOIN presentation).
- cap-notify/302 upstream, bouncer semantics, §6 redirect window / §7 history
  chain (fork-side follow-ons).

## Cross-refs

[[x3-channel-rename]] (design + decisions incl. guard-now-backport-also ruling),
`x3-channel-rename-impl-plan.md` + its SDD ledger (implementation history),
[[crdt-mesh-roadmap]] (anchor flag gap), memory `project_upstream_publish_rights`.
