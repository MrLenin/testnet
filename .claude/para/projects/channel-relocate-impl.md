# evilnet/channel-relocate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `evilnet/channel-relocate` spec (docs/specs/channel-relocate.md): consent-based channel rename ("relocation mode") where only the issuer and umode-`+F` users are moved; everyone else gets an actionable prompt (`RELOCATE` verb for cap holders, NOTICE otherwise) and the old channel becomes a redirecting tombstone for a grace period.

**Architecture:** Relocation layers a member-partition policy over the shipped `feature/channel-rename` machinery (m_rename.c validation, X3 AC R arbitration, DNR, registration transfer). The partition (movers = issuer + umode `+F` holders) is computed from GLOBAL state, so every server applies it identically when the RN token arrives; per-client presentation (RELOCATE vs NOTICE) is decided by each client's local server. Whether a rename is a relocation travels ON THE WIRE (a `C` marker parameter in RN), so mixed-FEAT fleets stay coherent — the origin server's `FEAT_RENAME_CONSENT` decides, propagation obeys the marker. The tombstone is the old channel kept alive via the persist exmode bit with a server-set `+L` redirect and an embedded-Timer grace sweep (same lifecycle discipline as the pending-rename table).

**Tech Stack:** C (nefarious fork, `feature/channel-relocate` branch off `feature/channel-rename` @ 9b4a56b), C (X3, `feature/channel-relocate` branch off `feature/channel-rename` @ 1d80d7d), Vitest integration tests in testnet `tests/`.

## Global Constraints

- Spec is `docs/specs/channel-relocate.md` — normative for all wire formats and behavior. Key verbatim values: cap name `evilnet/channel-relocate`; verb `RELOCATE <old-channel> <new-channel> [:<reason>]` sourced from the renamer; umode letter `F`; ISUPPORT token `RELOCATE=<grace-seconds>`; grace default 900s.
- A member who is NOT moved MUST NOT receive a `RENAME` message (spec: "Relationship to draft/channel-rename").
- A member holding both caps gets `RELOCATE` and is not moved (relocate wins).
- The issuer is ALWAYS moved. Umode `+F` members are always moved, notified per their rename caps (RENAME msg vs PART+JOIN pair).
- Tombstone: server-set `+L <new>` redirect honoring umode `+L` (NOLINK) opt-out; members may stay/talk; at grace expiry server-generated `PART :Channel has moved to <new>`; tombstone cannot itself be renamed; a rename of the tombstone's TARGET re-points the tombstone's redirect (no multi-hop chains).
- Status preservation: former members joining `<new>` within grace get their old status (op/halfop/voice + oplevel) from a snapshot taken at rename time.
- `FEAT_RENAME_CONSENT` default OFF (bool). `FEAT_RELOCATE_GRACE` default 900 (int, seconds). Bed conf will set 45 for testability.
- FLEET-CRASH TRAP (memory): `F_B`/`F_I` registration order in ircd_features.c MUST match the enum order in ircd_features.h — boot assert.
- Commit style: imperative subject, body explains why, each commit ends `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Build gate: `make -C ircd -s -j8` (fork), `make -s -j8` (x3) must pass before every commit.
- DO NOT run the full vitest suite; targeted files only (`IRC_HOST=localhost npm test -- src/ircv3/<file>`).

## File Structure

- `nefarious/include/ircd_features.h` + `ircd/ircd_features.c` — FEAT_RENAME_CONSENT, FEAT_RELOCATE_GRACE.
- `nefarious/include/capab.h` + `ircd/m_cap.c` — CAP_EVILNET_RELOCATE (+ per-cap feature FEAT_CAP_evilnet_channel_relocate, notify func like its neighbors).
- `nefarious/include/client.h` + `ircd/s_user.c` — FLAG_RELOCATE_FOLLOW / umode `F` (global umode).
- `nefarious/include/msg.h` + `ircd/parse.c` — MSG_RELOCATE/CMD_RELOCATE token (server→client only; parse entry mapped to m_ignore for clients, m_ignore for servers).
- `nefarious/ircd/m_rename.c` — partition engine, tombstone table + lifecycle, RN `C` marker emit/parse, status snapshot/restore hook export.
- `nefarious/ircd/m_join.c` — status-restore call on join of a relocation target within grace.
- `nefarious/ircd/s_user.c` or `ircd/ircd.c` (whichever carries the 005 builder — locate `RPL_ISUPPORT`/`supported.h` usage) — RELOCATE= token when FEAT_RENAME_CONSENT.
- `x3/src/proto-p10.c` — RN `C` marker parse; consent split path. `x3/src/hash.h`/`hash.c` — FLAGS_FOLLOW ('F' umode parse in mod_usermode).
- `testnet/tests/src/ircv3/channel-relocate.test.ts` — integration suite.
- `testnet/data/ircd.conf` (+ any per-server confs that carry Features for the prod pair) — `"RENAME_CONSENT" = "TRUE"`, `"RELOCATE_GRACE" = "45"` for the bed.

---

### Task 1: Fork plumbing — features, cap, umode, ISUPPORT, RELOCATE token

**Files:**
- Modify: `nefarious/include/ircd_features.h` (enum, after FEAT_RENAME_SERVICES), `nefarious/ircd/ircd_features.c` (same relative position)
- Modify: `nefarious/include/capab.h:102` area, `nefarious/ircd/m_cap.c:366` area
- Modify: `nefarious/include/client.h` (FLAG_RELOCATE_FOLLOW in the GLOBAL umode region, i.e. after FLAG_OPER; add `IsRelocateFollow(x)`/`SetRelocateFollow`/`ClearRelocateFollow` accessor macros beside their neighbors), `nefarious/ircd/s_user.c` userModeList (letter `'F'` — verified free)
- Modify: `nefarious/include/msg.h` + `nefarious/ircd/parse.c` (MSG_RELOCATE "RELOCATE", TOK_RELOCATE "RLO"; handlers: m_ignore/m_ignore — the verb is server→client output only)
- Modify: the fork's 005/ISUPPORT builder (grep `RPL_ISUPPORT`/`ircd_snprintf.*CHANMODES` to locate; it is feature-driven) — emit `RELOCATE=<FEAT_RELOCATE_GRACE>` only when `feature_bool(FEAT_RENAME_CONSENT)`.

**Interfaces (produces):**
- `FEAT_RENAME_CONSENT` (bool, default 0), `FEAT_RELOCATE_GRACE` (int, default 900)
- `CAP_EVILNET_RELOCATE` usable as `CapActive(sptr, CAP_EVILNET_RELOCATE)`
- `FLAG_RELOCATE_FOLLOW`, `IsRelocateFollow(cptr)` — global umode, propagates in N-intro umode string and MODE
- `CMD_RELOCATE` usable with `sendcmdto_one(from, CMD_RELOCATE, to, "%s %s :%s", old, new, reason)`

- [ ] **Step 1:** Add both FEATs. `F_B(RENAME_CONSENT, 0, 0, 0)` and `F_I(RELOCATE_GRACE, 0, 900, 0)` immediately after `F_B(RENAME_SERVICES, 0, 0, 0)` (ircd_features.c:1215 area), enum entries at the matching position in ircd_features.h (after FEAT_RENAME_SERVICES, before FEAT_CAP_draft_read_marker). Comment on RENAME_CONSENT: "relocation mode — renames move only the issuer and +F users; see docs/specs/channel-relocate.md in the testnet repo".
- [ ] **Step 2:** Add the cap, copying the DRAFT_CHANRENAME pattern exactly: `_CAP(EVILNET_RELOCATE, 0, "evilnet/channel-relocate", 0)` in capab.h beside line 102, and in m_cap.c beside line 366 with a per-cap feature `FEAT_CAP_evilnet_channel_relocate` (add that FEAT + notify func by copying `feature_notify_cap_draft_channel_rename`'s declaration/definition/registration trio verbatim with the new name; default the cap feature to 1 so the cap is advertised wherever the build runs — gating of the BEHAVIOR is FEAT_RENAME_CONSENT, and the cap alone is harmless).
- [ ] **Step 3:** Add umode F: `FLAG_RELOCATE_FOLLOW` in client.h's global-umode region (after FLAG_WALLOP is fine; anywhere ≥ FLAG_GLOBAL_UMODES) + accessor macros; `{ FLAG_RELOCATE_FOLLOW, 'F' }` in s_user.c userModeList (s_user.c:1033-1062 table). User-settable by anyone (no oper gate — spec: "user-settable").
- [ ] **Step 4:** Add MSG_RELOCATE/TOK_RELOCATE ("RLO") to msg.h + parse.c msgtab following the MSG_RENAME entry's shape, with mp handlers `{ m_ignore, m_ignore, m_ignore, m_ignore, m_ignore }`-equivalent per that table's arity (client/server/oper entries all m_ignore).
- [ ] **Step 5:** ISUPPORT: in the located 005 builder add, guarded on `feature_bool(FEAT_RENAME_CONSENT)`, the token `RELOCATE=%d` with `feature_int(FEAT_RELOCATE_GRACE)`.
- [ ] **Step 6:** Build: `make -C ircd -s -j8` → exit 0.
- [ ] **Step 7:** Probe test (scratchpad python, no bed rebuild yet — defer live checks to Task 6; this step is compile-level only): grep the binary/symbols sanity is unnecessary — instead verify via `ircd -x 2` config parse? Skip: build success + code review suffice at this task boundary.
- [ ] **Step 8:** Commit: `relocate: plumbing — FEAT_RENAME_CONSENT/RELOCATE_GRACE, evilnet/channel-relocate cap, umode +F, RLO token, ISUPPORT`.

### Task 2: Fork partition engine + RN consent marker

**Files:**
- Modify: `nefarious/ircd/m_rename.c` (all sites below), `nefarious/include/channel.h` (if a helper needs exporting — prefer keeping everything static in m_rename.c)

**Interfaces:**
- Consumes: Task 1's FEATs/cap/umode/CMD_RELOCATE.
- Produces: `static void relocate_execute(struct Client *sptr, struct Channel *chptr, const char *oldname, const char *newname, const char *reason)` — performs a relocation-mode rename locally (partition + tombstone creation), used by both execution paths and by ms_rename when the marker is present. Also `static int rename_is_consent(void)` = `feature_bool(FEAT_RENAME_CONSENT)`. Tombstone struct (Task 3 fleshes lifecycle; Task 2 introduces it minimally):

```c
struct RelocateTombstone {
  struct RelocateTombstone *next;
  struct Channel *oldchan;          /* the tombstone channel (name-stable while alive) */
  char newname[CHANNELLEN + 1];     /* current redirect target (chain-flattened) */
  time_t expires;
  struct Timer timer;               /* embedded — free only on ET_DESTROY (mirror PendingRename discipline, m_rename.c:311-333) */
  int timer_active;
  struct RelocateSnap *snaps;       /* Task 4: member status snapshot list */
};
```

**Wire format decision (normative for X3 Task 5):** a relocation-mode rename propagates as `RN <old> <new> C :<reason>` (marker `C` as parc-position 3, reason moves to 4); a classic rename stays `RN <old> <new> :<reason>`. `ms_rename` distinguishes by parc/argv: if the parameter before the reason is exactly `"C"`, relocation semantics apply on THIS server regardless of local FEAT_RENAME_CONSENT.

- [ ] **Step 1:** In the two origin execution sites — the direct path in `m_rename` (the non-registered branch that calls `rename_channel()` + `send_rename_to_members()`) and `pending_rename_complete()` (m_rename.c:334ff) — branch on `rename_is_consent()`: classic path unchanged; consent path calls `relocate_execute(...)` instead of `rename_channel()`+`send_rename_to_members()`, then propagates with the `C` marker:

```c
  sendcmdto_serv_butone_v3(pr->client, CMD_RENAME, cli_from(pr->client),
                        "%s %s C :%s", pr->oldname, newname, pr->reason);
```

  and the same marker in `rename_forward_rcapable()`'s emission (add a `const char *marker` argument, `""` or `"C "`; X3 needs the marker too).
- [ ] **Step 2:** Implement `relocate_execute()`. Semantics, in order:
  1. Create the new channel and transfer channel STATE using the existing rename machinery's state-copy behavior but WITHOUT the member move. Implementation: call `get_channel(sptr, newname, CGT_CREATE)` then copy `mode` (incl. exmode, bans via the same loop `rename_channel()` uses — read `rename_channel()` at channel.c:2050ff and replicate its state-transfer portion verbatim, EXCLUDING the membership `memcpy`/relink portion), set `creationtime` from the old channel, and mark registration: the `MODE_REGISTERED` bit copies with mode.mode. Do NOT free the old channel.
  2. Partition members of `chptr` (old): for each `struct Membership *m` — mover iff `m->user == sptr (issuer)` or `IsRelocateFollow(m->user)`. Movers: `remove_user_from_channel`-equivalent move — use `add_user_to_channel(newchan, m->user, m->status & (CHFL_CHANOP|CHFL_HALFOP|CHFL_VOICE), OpLevel(m))` then `remove_user_from_channel(m->user, chptr)`; iterate safely (capture `next_member` first). Notify each LOCAL mover per rename caps exactly as `send_rename_to_members()` does (reuse it by extracting its per-member emission into a helper `send_rename_notice_to(member, oldname, chptr, reason)` operating on one member, or restructure minimally; movers on OTHER servers are notified by their own server via the RN marker — emit NOTHING network-wide per member).
  3. Non-movers stay in `chptr`. For each LOCAL non-mover: if `CapActive(user, CAP_EVILNET_RELOCATE)` → `sendcmdto_one(sptr, CMD_RELOCATE, user, "%s %s :%s", oldname, newname, reason)`. Else → `sendcmdto_one(&his, CMD_NOTICE, user, "%C :%s has moved to %s (%s). Join %s to follow; this channel closes in %d minutes.", chptr, oldname, newname, reason, newname, feature_int(FEAT_RELOCATE_GRACE)/60)` — match the spec's NOTICE example shape; `&his` per HIS conventions for server-sourced notices (check how the fork sources channel NOTICEs elsewhere, e.g. m_clearmode or bounce notices, and copy that source choice).
  4. Tombstone the old channel: set `EXMODE_PERSIST` bit directly (`chptr->mode.exmode |= EXMODE_PERSIST` — internal, no wire, mirroring how relocation must not depend on services), set redirect `ircd_strncpy(chptr->mode.redir, newname, CHANNELLEN)` + `chptr->mode.mode |= MODE_REDIRECT`, emit the visible mode change to channel members and servers via a modebuf (`modebuf_init` + `modebuf_mode_string(MODE_ADD|MODE_REDIRECT, newname)` + flush — copy the modebuf usage pattern from an existing server-set mode site, e.g. the oplevel or +R handling in m_burst/channel.c), register the tombstone in the table with `expires = CurrentTime + feature_int(FEAT_RELOCATE_GRACE)` and arm the timer (Task 3 supplies the sweep; in this task arm it with the callback stub that only logs).
  5. `ms_rename` (m_rename.c:784): parse the optional `C` marker; when present run `relocate_execute()` for local application (each server applies the identical global partition; issuer = `sptr`), and RE-propagate with the marker preserved (both `sendcmdto_serv_butone_v3` relay and `rename_forward_rcapable`). When absent, existing classic behavior untouched.
- [ ] **Step 3:** Guard rails in `m_rename`/`pending_rename_complete` (consent mode only): renaming a channel that IS a live tombstone → `send_fail(sptr, "RENAME", "CANNOT_RENAME", oldname, "Channel is a relocation tombstone")`. Renaming a channel whose NAME is some tombstone's `newname` → allowed, but after success update that tombstone's `newname` + `mode.redir` to the newest name (chain flattening; emit the redirect mode change again).
- [ ] **Step 4:** Build. Commit: `relocate: partition engine + RN C marker (consent-mode rename moves issuer + +F only)`.

### Task 3: Fork tombstone lifecycle — grace sweep, expiry, destruct

**Files:**
- Modify: `nefarious/ircd/m_rename.c` (tombstone table lifecycle), `nefarious/ircd/channel.c` only if `sub1_from_channel` needs no change (it does not: EXMODE_PERSIST already keeps the empty tombstone alive — channel.c:370).

**Interfaces:** Consumes Task 2's `struct RelocateTombstone` + table. Produces `struct RelocateTombstone *relocate_tombstone_find(const char *name)` and `relocate_tombstone_find_by_target(const char *newname)` (statics), and exported `void relocate_tombstone_channel_gone(struct Channel *chptr)` called from channel destruction if the tombstone channel dies early (defensive unlink; call site in `destruct_channel`/`sub1_from_channel`'s actual free path — locate where `struct Channel` is freed and add the hook).

- [ ] **Step 1:** Implement the timer callback with the PendingRename discipline verbatim (m_rename.c:311-333 comment): ET_EXPIRE runs the sweep but does NOT free; free on ET_DESTROY; `timer_active` guard.
- [ ] **Step 2:** Expiry sweep: for each remaining member of `oldchan` (capture next first): emit to local members and all servers a server-generated PART — use the same emission shape as an ordinary PART from the user (`sendcmdto_channel_butserv_butone(member->user, CMD_PART, chptr, NULL, 0, "%H :Channel has moved to %s", chptr, ts->newname)` + `sendcmdto_serv_butone(...)` — copy the exact pair from m_join.c's JOINBUF_TYPE_PARTALL handling or m_part.c) then `remove_user_from_channel()`. After the loop: clear `EXMODE_PERSIST` and `MODE_REDIRECT`/`mode.redir` (silent bit clears), unlink the tombstone; if the channel is now empty it destructs through the normal path (`sub1_from_channel` already ran per removal; ZANNELS/destruct-event machinery takes it — verify by reading remove_user_from_channel's tail and note in the report which path collects it).
- [ ] **Step 3:** Early-death hook: `relocate_tombstone_channel_gone()` unlinks + timer_del (respecting timer_active discipline) — wire the call into the channel free site.
- [ ] **Step 4:** JOIN redirect on the tombstone needs NO new code (existing `+L`/`mode.redir` machinery in m_join.c handles forwarding incl. umode +L NOLINK opt-out) — VERIFY by reading m_join.c's redirect branch and record file:line in the commit message. What DOES need code: joining the tombstone directly should still be possible for former members? Spec says redirect applies to JOIN attempts; members "may talk, part, or follow" — those already inside are unaffected. No exemption implemented; the redirect governs new joins. Confirm the redirect branch fires before the zombie/create branch for an existing channel (it does — redirect is a join-time check on an existing channel).
- [ ] **Step 5:** Build. Commit: `relocate: tombstone lifecycle — grace sweep PARTs stragglers, persist/redirect cleared, early-death unlink`.

### Task 4: Fork status snapshot + restore-on-follow

**Files:**
- Modify: `nefarious/ircd/m_rename.c` (snapshot capture in relocate_execute; export lookup), `nefarious/ircd/m_join.c` (restore hook after a successful join)

**Interfaces:** Produces exported `int relocate_snap_lookup(const char *newname, struct Client *who, unsigned int *flags, int *oplevel)` (declare in `include/channel.h` beside the other m_rename exports — grep `pending_rename` externs for where those live) returning 1 + outputs when `who` (matched by numeric/pointer identity? use `struct Client *` captured at snapshot time BUT clients can disconnect — match by account when set, else by nick+user@host snapshot strings) has a snapshot in `newname`'s live tombstone.

```c
struct RelocateSnap {
  struct RelocateSnap *next;
  char account[ACCOUNTLEN + 1];   /* primary key when non-empty */
  char nick[NICKLEN + 1];         /* fallback key (nick match) */
  unsigned int flags;             /* CHFL_CHANOP|CHFL_HALFOP|CHFL_VOICE subset */
  int oplevel;
};
```

- [ ] **Step 1:** In `relocate_execute()` (Task 2 site), before partitioning, snapshot EVERY member (movers keep status through the move anyway; snapshotting all is simpler and covers a mover who parts and re-follows within grace): account (from `cli_user(user)->account` when `IsAccount`), nick, `m->status & (CHFL_CHANOP|CHFL_HALFOP|CHFL_VOICE)`, `OpLevel(m)`.
- [ ] **Step 2:** Restore: in m_join.c where a join to an EXISTING channel completes (after `joinbuf` add / the point where the new Membership exists — locate the tail of the per-channel join loop), call `relocate_snap_lookup(chptr->chname, sptr, &flags, &oplevel)`; on hit and when the member currently has no status, apply: set membership status + oplevel and BROADCAST the mode grant as a server-set MODE (modebuf with `&his`/server source granting +o/+h/+v — copy the modebuf-grant pattern from m_svsjoin.c or the burst op-application). Consume (unlink+free) the snap on use.
- [ ] **Step 3:** Build. Commit: `relocate: member status snapshot at rename, restored on follow-join within grace`.

### Task 5: X3 — RN C marker + consent split + FLAGS_FOLLOW

**Files:**
- Modify: `x3/src/proto-p10.c` (cmd_rename; mod_usermode 'F'), `x3/src/hash.h` (FLAGS_FOLLOW bit — next free user FLAGS bit, currently 0x40000000 free per the FLAGS list ending at 0x20000000 COMMONCHANSONLY)

**Interfaces:** Consumes the RN wire decision from Task 2 (`RN <old> <new> C :<reason>`). X3's existing `cmd_rename` + `RenameChannel()` handle the classic shape.

- [ ] **Step 1:** hash.h: `#define FLAGS_FOLLOW 0x40000000 /* +F auto-follow channel relocations (evilnet/channel-relocate) */` + `IsFollow(x)` macro; parse `'F'` in the user-mode parser (find the umode switch in proto-p10.c `mod_usermode` handling 'x','B','z' etc. and add `case 'F': do_user_mode(FLAGS_FOLLOW); break;` in the same style).
- [ ] **Step 2:** `cmd_rename`: detect the marker (argc one higher, the pre-reason arg == "C"). Classic path unchanged. Consent path:
  1. Do NOT `RenameChannel()` (which re-keys the node). Instead: create/get the new chanNode (`AddChannel(newname, now, NULL, NULL, NULL)` shape — copy the call used elsewhere in proto-p10 for on-the-fly creation), move the REGISTRATION: re-point `channel_info` from old node to new (mirror what `cmd_move`/`chanserv_rename` does with channel_info ownership — reuse the existing rename hook array by calling the hooks with (old, new) as the rename hooks expect chanNode transitions; read `hash.c RenameChannel()` and extract/replicate its channel_info + hook logic WITHOUT the dict re-key/name swap).
  2. Move member records for movers only: issuer (RN source user) + every member with `IsFollow(member->user)` — `AddChannelUser(user, newchan)` preserving modes/oplevel then `DelChannelUser(user, oldchan, NULL, 0)` (same ordering discipline as the BX P merge: transfer before any deletion; walk popping the last element).
  3. Old node stays (unregistered husk mirroring the ircd tombstone); the existing timed DNR on the old name stays exactly as the classic path sets it.
- [ ] **Step 3:** Build x3 (`make -s -j8`). Commit: `relocate: RN C marker — consent split keeps tombstone node, moves issuer + +F members, registration re-pointed`.

### Task 6: Bed enablement + integration tests

**Files:**
- Modify: `testnet/data/ircd.conf` + `testnet/data/ircd2.conf` (Features block of the prod pair — locate the existing `Features {` block shape): add `"RENAME_CONSENT" = "TRUE"; "RELOCATE_GRACE" = "45";`
- Create: `testnet/tests/src/ircv3/channel-relocate.test.ts`

**Test cases (Vitest, model on channel-rename-services.test.ts's helpers/retries; SQUIT window NOT needed if tests run on the isolated pair — but the bed is mixed, so tests must SQUIT like the rename gates OR use unregistered channels where the direct path applies; use unregistered channels for all except one registered case, and accept that the legacy-blocker guard applies to consent renames identically — the suite must oper+SQUIT upstream/leaf4/leaf5 in beforeAll and the bed restored in afterAll via `docker restart nefarious3` equivalent is NOT available from vitest: instead mark the registered-channel case skipped-by-default with a comment pointing at the manual probe gate):**
1. consent rename of unregistered channel: issuer moved (gets RENAME msg with cap), `+F` second client moved (PART+JOIN fallback without rename cap), relocate-cap third client NOT moved + receives `RELOCATE #old #new`, no-cap fourth client NOT moved + receives the NOTICE, and MUST NOT receive RENAME.
2. old channel shows `+L #new` redirect + persist behavior: fifth client JOINs #old → lands in #new via 470.
3. follow: the relocate-cap client JOINs #new within grace → regains its old +o (snapshot restore).
4. grace expiry (RELOCATE_GRACE=45 on bed): after ~50s the no-cap client receives a PART for #old with "moved to" reason; #old is gone (403) after.
5. umode: `MODE nick +F` settable/queryable; ISUPPORT contains `RELOCATE=45`.
6. tombstone not renameable: RENAME #old → FAIL while grace lives.

- [ ] **Step 1:** Write the suite; each case as an independent test with fresh channels (`#rl<rand>`); reuse the existing raw-socket/ircv3 client helper used by channel-rename-services.test.ts (read its imports and copy the connection/cap-negotiation pattern; `+F` set via `MODE <nick> +F`).
- [ ] **Step 2:** Rebuild bed: `scripts/dc.sh -l build nefarious nefarious2 x3 && scripts/dc.sh -l up -d nefarious nefarious2 x3` (batch after all code tasks are merged).
- [ ] **Step 3:** Oper-SQUIT the legacy blockers for the run (probe helper or beforeAll), run: `IRC_HOST=localhost npm test -- src/ircv3/channel-relocate.test.ts` → all green (expiry case allowed ~60s).
- [ ] **Step 4:** Restore bed (`docker restart nefarious3`, verify LINKS ×9).
- [ ] **Step 5:** Commit (testnet repo): conf + tests. Commit (submodule bumps deferred to the user's checkpoint discipline — do NOT commit submodule pointers).

### Task 7: Final review + push

- [ ] **Step 1:** Whole-branch review (SDD final review) across both repos' `feature/channel-relocate` diffs vs their parents.
- [ ] **Step 2:** Push `feature/channel-relocate` to origin in both nefarious (MrLenin) and x3 (MrLenin). NO PRs yet — Rubin's spec comments may land Monday; PRs wait for the user's call.
- [ ] **Step 3:** Update `docs/specs/channel-relocate.md` if implementation forced any spec deviation (record each in a "Deviations" section — spec is normative, deviations need the user's sign-off, so list them in the final report too).

## Self-Review notes

- Spec coverage: cap (T1), RELOCATE verb (T1/T2), ISUPPORT (T1), umode F (T1/T5), partition + issuer-always-moves + both-caps-rule (T2), NOTICE fallback (T2), tombstone +L/redirect/470/NOLINK (T2/T3), grace expiry PART (T3), status preservation (T4), chain flattening (T2 step 3), tombstone-not-renameable (T2 step 3), X3 registration/DNR (T5), offline-members limitation (spec: no code — documented limitation), multi-session bouncer coherence (spec: implementation-defined — NOT implemented; note as deviation-by-omission in T7 report).
- RELOCATE replay-on-rejoin (spec MAY): not implemented — record in T7.
- Type consistency: `relocate_execute`, `RelocateTombstone`, `RelocateSnap`, `relocate_snap_lookup` names used consistently across T2–T4.

---

## POST-SHIP FOLLOW-UPS (final review triage, 2026-08-02 — none block the branch)

1. **persist_was_ours overwrite on diverged-link re-tombstone** (Medium): relocate_tombstone_add's repoint path recomputes provenance as 0 (bit already set by our own earlier relocation) and overwrites the record's 1 → sweep never reclaims persist. One-line fix (`||`). Reachable only on already-diverged links.
2. **ircd→services tombstone-dissolve wire signal** — the clean fix retiring both the D2 saxdb-window hole and the burst re-arm heuristic.
3. off_channel(+z-services) networks: tombstone carries untracked services +z post-relocation (~1 day linger). Bounded.
4. Not-done cleanup batch (believed done, verified not): N2 tripwire widen; snapshot userhost → realhost (fail-safe today); T5-N1 "+k service"→U-line comment correction.
5. T3-M2 sweep self-echo tags; T3-M3 sweep PART history storage (respect single-msgid); T3-M7 persistence_channel_visible vs sweep PART (bouncer-analyst pass); T5-M1 services-side loud abort on #new-preexists; T6-M2 X3 husk timestamp 0; T2-M8 relay drop when #old unknown (fix with classic); T2-M9 cmocka fixtures for partition classifier; BX-P direct modeNode deref (pre-existing).
6. Verification bundle (harness gaps, not known code gaps): one-server MODE -L sweep divergence; HelpServ-bot unregistered relocation; X3-side bouncer-alias mover fidelity.
7. Operational rule: `O3 WRITEALL` before restarting X3 mid-grace (DNR fingerprint durability).
8. DEPLOYMENT: bed conf knowingly enables RENAME_CONSENT with CRDT doc-driven peers linked (spec item 9 violation — bed-only, documented D3). Prod must not copy until relocation is ported to the mesh branch. Also: every v3 server must run relocation-aware builds BEFORE any server enables RENAME_CONSENT (marker misread = classic force-move).
