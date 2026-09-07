# channel-relocate (D) — drop `+F`, follow = client JOIN — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to execute task-by-task. Steps use `- [ ]`.

**Goal:** Replace the umode-`+F` server-side auto-follow with design (D): the server moves only the *issuer*; every other member stays in the tombstone and follows by their own `JOIN`. No per-user server follow-state.

**Architecture:** One-line classifier change per engine (`user == sptr || IsRelocateFollow(user)` → `user == sptr`) plus deletion of the `+F` umode / X3 `FLAGS_FOLLOW`. The member walk, per-member status snapshot, tombstone `+z`/`+L`, grace sweep, `RELOCATE`/`NOTICE`, and the `+L`-redirect follow path all stay untouched — the snapshot is now the *only* way a non-issuer keeps standing, so it must keep running for every member.

**Tech stack:** C (Nefarious ircd + X3 services, P10), Vitest E2E, Docker bed.

Spec: `docs/specs/channel-relocate.md` @ `5247f15` (design D). Vetting verdict: TENABLE, net simplification.

## Global Constraints

- **Rollout gate (hard):** the ircd `+F` umode removal and the X3 `case 'F'` parse removal MUST ship together and be deployed together with every relocation-aware server — a mid-upgrade peer still emitting `+F` at a de-`F`'d server hits the unknown-umode path. This is the *existing* "all servers relocation-aware before `RENAME_CONSENT`" constraint; sequence within it. On the bed: rebuild **all** relocation servers (nefarious, nefarious2, the CRDT leaves that carry relocate, nefarious-upstream #96) **and** X3 before recreating, in one batch.
- Remove `FLAG_RELOCATE_FOLLOW` from the **tail** of the client `enum Flag` (client flags are an in-memory bitset, never wire-encoded by ordinal, but tail-removal avoids reshuffling neighbors).
- Do NOT touch: the member walk, the snapshot capture, tombstone lifecycle, `RELOCATE` verb / cap / `RELOCATE=` ISUPPORT, the `+L` redirect follow path, X3 bot-follow-via-real-JOIN.
- `FEAT_RELOCATE_GRACE` / `RENAME_CONSENT` features and the `X3_RELOCATE_GRACE` config stay.

---

### Task 1: Fork ircd — remove `+F`, issuer-only classifier

**Repo/branch:** `nefarious` @ `feature/channel-relocate`

**Files/sites:**
- `ircd/m_rename.c:1816` — `if (user == sptr || IsRelocateFollow(user)) {` → `if (user == sptr) {`
- `include/client.h:230` — delete `FLAG_RELOCATE_FOLLOW` enum member (move to enum tail first if not already last, or delete in place — it is not wire-ordinal-sensitive)
- `include/client.h:1177/1328/1475` — delete `IsRelocateFollow` / `SetRelocateFollow` / `ClearRelocateFollow` macros
- `ircd/s_user.c:1063` — delete `{ FLAG_RELOCATE_FOLLOW, 'F' }` from `userModeList`
- `ircd/s_user.c:2303-2311` — delete the `case 'F':` block in `set_user_mode`

**Steps:**
- [ ] Grep-confirm no other reference to `FLAG_RELOCATE_FOLLOW`/`IsRelocateFollow`/`SetRelocateFollow`/`ClearRelocateFollow` remains after the edits.
- [ ] Host build (`./configure … && make`) clean; `make` runs the cmocka gate green.
- [ ] Confirm the `RELOCATE` cap, `CMD_RELOCATE`/`RLO`, and `RELOCATE=` ISUPPORT are UNTOUCHED (they are the notify class, unrelated to `+F`).
- [ ] Commit.

**Verify:** issuer-only partition; a former op who was `+F` now behaves as a stayer (snapshot + notify), restored on follow-JOIN.

---

### Task 2: X3 — remove `FLAGS_FOLLOW`

**Repo/branch:** `x3` @ `feature/channel-relocate` (PR #59)

**Files/sites:**
- `src/hash.h:95` — delete `#define FLAGS_FOLLOW 0x40000000` (frees the bit)
- `src/hash.h:126` — delete `#define IsFollow(x) …`
- `src/proto-p10.c:2666` — `if(IsLocal(user) || user == issuer || IsFollow(user))` → `if(IsLocal(user) || user == issuer)` (X3 still moves its own local bots + the issuer; bots follow the community via real JOINs as today)
- `src/proto-p10.c:3964-3966` — delete `case 'F': do_user_mode(FLAGS_FOLLOW); break;` (and update the comment noting it mirrored the ircd `userModeList 'F'`)

**Steps:**
- [ ] Grep-confirm no remaining `FLAGS_FOLLOW`/`IsFollow(` usage.
- [ ] Host build clean.
- [ ] Confirm bot-follow (real JOIN + status re-assert), husk sweep, `-R`/`-z` cmd_burst correction are untouched.
- [ ] Commit.

---

### Task 3: Upstream backport #96 — remove `+F`, issuer-only (mirror of Task 1)

**Repo/branch:** `nefarious-upstream` @ `backport/channel-relocate` (PR #96)

Same edits as Task 1, at the ported sites (the `+F` plumbing added in commit `1682fd6`): `m_rename.c` classifier, `include/client.h` flag+macros, `ircd/s_user.c` userModeList + `set_user_mode` case.

**Steps:**
- [ ] Apply the identical strip; grep-confirm clean.
- [ ] Host build + `make` cmocka gate green.
- [ ] Docker build the `nefarious-upstream` image.
- [ ] Commit (amend or stack on `1682fd6`); update PR #96 body note that the umode is dropped per spec (D).

---

### Task 4: E2E tests — `bob`-moves → `bob`-stays

**Repo:** `tests/src/ircv3/channel-relocate.test.ts` (the 8-case suite)

**Steps:**
- [ ] Read the suite; identify every case asserting a `+F` user is auto-moved (`bob`-style) — these must become "stayer, then follows by JOIN, status restored".
- [ ] Delete/rewrite any `MODE +F` setup and its move assertion; assert instead: non-issuer stays in the tombstone, gets `RELOCATE` (if cap) or `NOTICE`, and on `JOIN #new` (or `JOIN #old` via `+L` redirect) is placed in #new with status restored.
- [ ] Keep issuer-moves, tombstone, grace-sweep, and status-preservation cases.
- [ ] Per `feedback_no_test_changes`/`feedback_tests_may_be_wrong`: this is a fork-owned E2E suite (not irctest), and the spec changed, so updating assertions to (D) is correct — audit that each renamed case tests what its name claims.

---

### Task 5: Coordinated bed rebuild + live-gate

**Steps:**
- [ ] Rebuild ALL relocation images in one batch (nefarious, nefarious2, any CRDT leaves carrying relocate, nefarious-upstream) + X3 — per the rollout-gate constraint. `scripts/dc.sh build …` each, then a scoped recreate.
- [ ] Live-gate on the bed:
  - issuer relocation → only the issuer moves; a second member (no cap) stays in the tombstone with a NOTICE.
  - the stayer `JOIN #new` → placed in #new, prior op/voice restored from snapshot.
  - `JOIN #old` during grace → `+L`-forwarded to #new (490), status restored.
  - a member with `evilnet/channel-relocate` cap → gets `RELOCATE`, follows by JOIN.
  - no server auto-moves a non-issuer anywhere; upstream (#96) stays in sync (issuer move + tombstone + applied JOINs), no crash.
- [ ] Run the updated E2E suite green ×3.
- [ ] Restore bed to full LINKS after gating.

---

## Sequencing / commit boundaries

Tasks 1–4 are independent code changes; **Task 5 requires all of 1–3 built together** (rollout gate). Land commits per task; do the bed recreate only once all engines are rebuilt. Submodule gitlink bumps + testnet checkpoint after live-gate is green (ask before the checkpoint commit per `feedback_no_overzealous_commits`).

## Out of scope (separate threads)
- Phase-2 deployment-gated server-side auto-follow-via-metadata (documented future in the spec).
- Mode-budget audit (bouncer umode → metadata; backport chathistory umode + history chanmodes) — see `project_fork_mode_budget_audit` memory.
