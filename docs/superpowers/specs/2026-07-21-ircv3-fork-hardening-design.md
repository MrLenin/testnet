# Design: IRCv3 fork + CRDT hardening remediation

**Date:** 2026-07-21
**Status:** approved — ready for implementation planning
**Backlogs:** `.claude/para/projects/fork-ircv3-review-2026-07.md` (fork),
`.claude/para/projects/crdt-mesh-review-2026-07.md` (crdt). Findings are already
verified against source; this doc plans the remediation, it does not re-derive findings.

## Context & goal

Two whole-subsystem reviews produced verified backlogs: the production fork
(`nefarious` @ `ircv3.2-upgrade`, ~40 findings incl. 5 CRITICAL) and the CRDT branch
(`nefarious-crdt` @ `crdt-mesh`, 5 CRITICAL + systemic themes). Goal: resolve them
safely, fork first, then crdt.

**Grounding that shapes the plan:**
- `nefarious` and `nefarious-crdt` are the **same repo** (both clone `MrLenin/nefarious2`).
  `crdt-mesh` is 151 commits off base `da8845c`, which is an ancestor of the ircv3.2
  HEAD — so `crdt-mesh` can be rebased directly onto `ircv3.2-upgrade`.
- The fork's IRCv3 findings are **shared code** — spot-checked F-A1, F-MB1, F-CN1, F-SW1
  all exist in the crdt tree too. Fixing them on `ircv3.2-upgrade` first and then rebasing
  crdt onto the fixed base makes the crdt branch **inherit** the fixes (no double-fixing,
  no divergence). This validates the fork-first ordering.

## Decomposition (three phases)

1. **Phase 1 — fix `ircv3.2-upgrade`** (this spec's focus). Scope: **CRITICAL + MAJOR**
   (per decision); the trivial `ircd_strncpy` stragglers folded into one cleanup commit;
   remaining MINOR/NOTE deferred to a follow-up pass.
2. **Phase 2 — rebase `crdt-mesh` onto the fixed base.** Inherits phase-1 fixes; resolve
   conflicts in the ~8 files both branches heavily touch. Sketched here; planned in detail
   when reached.
3. **Phase 3 — fix the crdt-only backlog** (5 CRDT criticals + themes A/B + CRDT MAJORs +
   invariant-2 re-sweep). Planned *after* the rebase, against the actual post-rebase state.

Each phase gets its own spec → plan → implementation cycle. This document specifies Phase 1
and sketches 2–3.

---

## Phase 1 design

### Working branch & commits
- Branch `ircv3.2-hardening` off `ircv3.2-upgrade` in the `nefarious` submodule (libkc
  fixes on a matching branch in the `libkc` submodule). Never commit to the tracked branch;
  nothing pushed until the user approves.
- **One commit per finding or tight cluster**, each independently reviewable, revertable,
  and cherry-pickable — important because these commits must survive the Phase 2 rebase as
  distinct units.

### Ordering: hybrid (client-reachable criticals first, then subsystem-by-subsystem)
Rationale: close the worst *client-reachable* exposure before the long tail, but otherwise
group by subsystem so each file is opened once and each subsystem's findings are fixed and
tested together.

**Batch 0 — client-reachable criticals**
- **F-A1** SASL authzid → allowlist-gated capability (see Design point 1).
- **T1 overflows** (F-MB1 + F-SW1 ×3) → one shared guard-and-clamp helper applied to all
  four `x += ircd_snprintf(…, sizeof(buf)-x, …)` sites, plus a grep for any others (see
  Design point 2).

**Batch 1 — remaining criticals**
- **F-CN1** DNSBL `assert→abort` — **CONFIRMED LIVE** (`FEAT_NATIVE_DNSBL` is enabled, per
  O1): a stalled/unreachable DNSBL lookup crashes the running server at connect-timeout.
  Top-priority critical. Add an `AR_DNSBL_PENDING` branch to `auth_ping_timeout` (cancel
  `dnsbl_request`, clear flag, `check_auth_finished`) and actually enforce `FEAT_DNSBL_TIMEOUT`.
- **F-BC1** bouncer alias-setup teardown: revert the alias transformation before returning
  −1, or attempt `SetLocalNumNick` before the count-mutating point of no return.

**Batch 2 — SASL / libkc auth tier**
- **F-K3** libkc JWT: require+check `iss`/`aud`/`azp`/`nbf`, enforce `exp` (present-required).
- **F-A2** SASL relay `fd`: bound against `HighestFd` before `LocalClientArray[fd]`
  (m_sasl.c and the sibling m_account.c `decode_auth_id`).
- **F-K1/F-K2** webhook: refuse-to-start (or loud-warn + refuse state-changing events) when
  the port is set but the secret is empty; constant-time secret compare.

**Batch 3 — chathistory**
- **F-CH1** DM access → identity-anchored (see Design point 3).
- **F-CH2** channel-name truncation: size the `lookup_target`/`normalized_target` buffers to
  `CHANNELLEN+1` (or reject over-length targets).
- **F-CH3** presence `uint8_t` overflow: clamp `effective_max_intervals` to
  `PRESENCE_MAX_INTERVALS-1` (or widen `count`).

**Batch 4 — metadata**
- **F-M1** persist visibility and honor it in `metadata_account_list` (stop hardcoding PUBLIC).
- **F-M2** decode `T<ts>|`/`P:` framing in `metadata_account_list` (route through the
  decode helper the single-key path uses).
- **F-M3** `ms_markread`: validate/normalize the timestamp and cap length before store +
  rebroadcast.
- **F-M4** `METADATA CLEAR`: skip `metadata_key_is_server_managed` keys (mirror the SET guard).

**Batch 5 — bouncer / delivery**
- **F-BW1/F-BW2** BX handlers: require exactly-5-char wire numerics + an account cross-check
  before mutating (convert-in-place / promote / exit).
- **F-CN2** alias-KILL re-entrancy UAF: untrack the alias before recursing into
  `exit_client(primary)`, or add a top-of-`exit_client` `FLAG_CLOSING` no-op guard.
- **F-MB2** S2S multiline sender UAF: invalidate batches whose `sender == bcptr` on user
  exit (or store+re-resolve the numeric).
- **F-MB3** S2S multiline: add a `start_time` reaper + per-link cap.
- **F-SW2** drain-key truncation: use full `sizeof` for `alias_numeric`.

**Batch 6 — storage + mechanical cleanup**
- **F-S1** disk-full recovery (MAJOR): map ENOSPC/"No space" → `DB_ERR_FULL` in
  `translate_errptr` and route every errptr through it (wire the dead function in).
- **strncpy stragglers** (metadata keys, quota target/account, m_chathistory
  normalized_target, bouncer name/channel): one cleanup commit. In-scope by agreement
  (trivial + mechanical), even though individually MINOR.

**Deferred to a follow-up pass** (MINOR/NOTE, out of Phase-1 scope): F-CN3 (listener
plaintext branch), F-CN4 (`cli_fd=-1` ordering), F-SW3 (SCRAM `DupString` free-first),
F-MB4 (`m_redact` msgid clear), the m12–m19 CRDT-side minors, etc. **Two of these are
memory-safety and are candidates to pull forward** if cheap and co-located: **F-CH4**
(`strchr` OOB read on a non-NUL-terminated DB value → use `memchr`) and **F-CH5**
(unbounded S2S chunk growth). Flagged so the deferral is explicit
(`feedback_no_silent_defer`); the call is the maintainer's at plan time.

### Design point 1 — F-A1 authzid (allowlist-gated capability)
Per the maintainer: authzid impersonation is a deliberately-stubbed capability (historically
a network-run ZNC service account logging in on behalf of users); nothing relies on it now,
but the ability should be preserved for future use — safely. So the fix fills in the `TODO`
at sasl_auth.c:795 rather than removing the branch:
- A non-empty `authzid ≠ authcid` is honored **only** when the KC-authenticated authcid is
  on an operator-configured trusted-service allowlist — a new **`FEAT_` string list** (per
  O3; a conf block is overkill); otherwise it is rejected.
- The allowlist **defaults empty** → out of the box nothing can impersonate (closes the bug),
  and the ZNC-style path is one config line away.
- The same allowlist gate applies to the OAUTHBEARER/SCRAM/ECDSA `login_as = authzid ? …`
  sites, not just PLAIN.
- Independently (a straight bug, policy-agnostic): the positive-auth cache must store the
  KC-verified **authcid**, not `login_as`, so a rejected/absent impersonation cannot poison
  a later legitimate login.

### Design point 2 — T1 shared snprintf-append helper
Introduce a small helper (e.g. `str_appendf(char *buf, size_t buflen, int *pos, fmt, …)`)
that clamps `*pos` to the actual bytes written (never the would-be length) and no-ops once
the buffer is full, then convert all four sites: `format_batch_open_tags` (m_batch.c) and
the three bouncer channel-list builders (bouncer_session.c:3640, 5945, 7309). Grep the tree
for other `x += ircd_snprintf(…, sizeof(buf)-x, …)` accumulators and convert any found. The
correctly-guarded existing patterns (`build_channel_string`, `format_message_tags_with_client`)
are the reference.

### Design point 3 — F-CH1 identity-anchored PM history
The infrastructure already exists asymmetrically: `store_private_history` embeds an ephemeral
party's `session_id` (ircd_relay.c:385-402) and the ephemeral access path gates on
`history_pm_target_has_sessid` matching the requester's `cli_session_id` (m_chathistory.c:1142).
Only the **authed** path is unhardened (current-nick check, no account stamp/match). Fix =
symmetric completion:
- **Store**: stamp each party's identity anchor on the record — `account` when authed,
  `session_id` when not (the "same spot", as intended). The session_id half exists; add the
  account half.
- **Access (authed path)**: gate on the requester's account matching a stored account anchor,
  mirroring `history_pm_target_has_sessid`. Replaces the nick-equality-only check in the
  plain-nick and colon branches (m_chathistory.c:1035, 1051-1073).
- **Semantics**: authed → retrievable across reconnects; unauthed → retrievable until
  disconnect; a freed nick yields a new anchor → no cross-user leak; incidentally fixes
  nick-rename history loss. Pre-existing nick-only records become unreachable — **accepted**
  (testnet; clean cutover, no dual-read shim). Exact key layout (whether the conversation
  pair-key also moves off nicks) is an implementation detail settled against the existing
  `has_sessid`/pair-key code.

### Verification (TDD-where-constructible)
- **cmocka** (runs in the Docker build, gates the image) for pure logic: the `str_appendf`
  bounds (feed an overflowing input, assert no OOB / correct truncation), the `orset`/`fd`
  bound guards, the JWT claim checks, the presence-count clamp.
- **New Vitest integration** (via `createOperClient`/`createX3Client`; never modify existing
  irctest files) for client-reachable behavior: authzid impersonation rejected (+ allowlisted
  path still works), DM/channel history access denied to a non-participant / nick-taker,
  private metadata stays private across a re-login.
- **Build-gate + reasoning** where a behavioral test can't be constructed (hung-DNSBL, the
  numeric-saturation teardown) — noted per `feedback_no_silent_defer`.
- **Maintainer does the final live rebuild-and-reconnect validation** (standing habit).

---

## Phase 2 sketch — rebase `crdt-mesh`

- Rebase `crdt-mesh` onto the fixed `ircv3.2-hardening` (or `ircv3.2-upgrade` after Phase 1
  merges). Recommended over merge for a clean linear history since crdt-mesh is a private
  experimental branch — **confirm rebase-vs-merge when we get here.**
- Expect conflicts in the files both branches heavily modify: `bouncer_session.c`,
  `m_batch.c`, `s_misc.c`, `metadata.c`, `channel.c`, `s_user.c`, `ircd_relay.c`, `send.c`.
  Because phase-1 commits are per-finding, conflicts resolve finding-by-finding.
- Rewrites the 151 crdt commits → force-push `origin/crdt-mesh` + bump the testnet
  superproject submodule pointer.
- Verify post-rebase: crdt cmocka suite green, phase-1 fixes present (grep the fixed sites),
  build clean.

## Phase 3 sketch — crdt-only backlog
Planned after the rebase against the real post-rebase state. Covers the 5 CRDT criticals
(origin-OOB, coll-NULL, chunk-cleanup, unbounded-realloc, KILL-NumNick), Theme A (one shared
reclaim-sweep helper), Theme B (monotonic-clock liveness + legacy-TS-in-merge-order), the
CRDT MAJORs, and the invariant-2 `NumNick(from)` re-sweep. Note: F-MB1/T1 and several fork
findings will already be fixed via inheritance — Phase 3 re-verifies rather than re-fixes.

---

## Open items
- **O1 — RESOLVED:** `FEAT_NATIVE_DNSBL` **is enabled** → F-CN1 is a live remote-crash;
  treated as a top-priority critical.
- **O2:** Phase 2 rebase-vs-merge — deferred to Phase 2 (recommendation: rebase).
- **O3 — RESOLVED:** F-A1 allowlist is a **`FEAT_` string list** (a conf block is overkill).

## Success criteria (Phase 1)
- All 5 CRITICALs + all MAJORs fixed on `ircv3.2-hardening`, one reviewable commit each.
- New regression tests green in the Docker/cmocka gate; new Vitest integration tests pass
  for the client-reachable auth/access/visibility fixes.
- Clean build; maintainer live-validates; nothing pushed without approval.
