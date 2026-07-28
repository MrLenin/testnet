# SASL post-auth stall — investigation step

**Status:** OPEN, repro-gated. Committed as a discrete step **between Phase 1
(fork-hardening batches) and Phase 2 (crdt-mesh rebase)** — do not start the crdt
rebase until this is diagnosed or explicitly deferred by the maintainer.

## Symptom (maintainer report, 2026-07-21)

A user connects, **successfully authenticates via SASL**, and then registration
**times out waiting for something** — the client never finishes registering and is
eventually reaped by a timeout. Could **not** be reproduced on demand ("we could not
reproduce the conditions to properly test/diagnose the issue").

## Diagnosis state

- **NOT DNSBL / NOT F-CN1.** F-CN1 (`auth_ping_timeout` missing an `AR_DNSBL_PENDING`
  branch → `assert(0)`/abort) was a *separate crash* on the DNSBL path, now fixed
  (`2a44dae`). Its failure mode is an abort, not a hang-then-timeout. The DNSBL
  both-flags-pending edge resolves on the next `check_pings` cycle (auth_ping_timeout
  is rescheduled, not one-shot) — so it is not a persistent stall either. See
  [[project_native_dnsbl_timeout_gap]] (now partially resolved by F-CN1).
- **Points at iauth.** A stall that *ends in a timeout* matches the
  `IAUTH_REQUIRED` → **"Authorization Timeout"** exit in the auth state machine, i.e.
  an iauth gate (`AR_IAUTH_PENDING`) that never clears after SASL succeeds. This is
  where the maintainer originally had it; the earlier "it's the DNSBL both-pending
  edge" hypothesis was retracted.

## Leads to pull (when the step starts)

1. **iauth config shim** — [[project_iauthd_ts_no_include]]: the iauthd-ts config
   parser ignores `include`, and the testnet `ircd.conf` is a 6-line shim, so iauth
   may not be configured the way the conf implies. If iauth is enabled but effectively
   mis/unconfigured, the `AR_IAUTH_PENDING` gate could stay set after SASL.
2. **WIP diagnostics already in-tree — KEEP THEM.** Instrumentation added during the
   earlier investigation lives at `nefarious/ircd/s_auth.c` ~535-553, ~648-657,
   ~728-737. Do **not** strip or gate these until this step concludes; they are the
   instrumentation for reproducing/diagnosing the stall.
3. **Three-tier AUTHENTICATE dispatch** (sasl-keycloak skill: local Keycloak / IAuth /
   P10 relay). A post-auth stall could be the IAuth tier not sending its ack, or a
   missing `check_auth_finished()` after the SASL exchange completes on one tier.
   Check that every SASL-success path clears its pending flag AND calls
   `check_auth_finished` / `register_user`.
4. **Optional related refactor (maintainer's call):** restructure `auth_ping_timeout`
   to drain *all* pending AR_* flags in one pass rather than one-per-cycle. Downgraded
   from "fixes the stall" to "hardening" after the F-CN1 review — it does not by itself
   explain the stall, but it removes one source of multi-cycle timeout ambiguity.

## Repro strategy (needs building — no reliable repro today)

- The failure is timing/config dependent. First attempt: capture a live stall with the
  in-tree s_auth.c diagnostics at `L_INFO` (note: `LS_SYSTEM L_DEBUG` is filtered — logs
  need ≥ `L_INFO`), driving SASL PLAIN via Keycloak against the testnet and watching
  which `AR_*_PENDING` flag is still set at the `check_auth_finished` that never fires.
- If not reproducible interactively, add a targeted log at every `check_auth_finished`
  early-return that names the still-pending flag, then exercise the SASL path under the
  bed's account pool.
- Per `feedback_no_unbounded_background_runs`: cap any autonomous testnet run ≤ 1h.

## Why it's a step, not a batch item

It has no root cause yet, so it can't be a spec'd fix in the Phase-1 review batches.
It's a systematic-debugging task that gates the crdt transition because shipping the
crdt rebase on top of a known-but-undiagnosed SASL registration stall would compound
the problem across a much larger change.

## DIAGNOSIS COMPLETE (2026-07-22) — root cause = iauthd-ts "Bug B" (Hurry doesn't force-decide with a pending DNSBL lookup)

**Mechanism (two independent gates, both confirmed vs source):**
1. **nefarious side:** local Keycloak SASL (m_authenticate.c Path 1, `sasl_local_available()`) clears AR_SASL_PENDING — SASL itself succeeds. The iauth gate AR_IAUTH_PENDING is SEPARATE and never touched by local SASL. AR_IAUTH_SOFT_DONE is set ONLY by `iauth_cmd_soft_done` (s_auth.c:2749), i.e. only when iauth explicitly responds. iauthd-ts sends policy `RTAWUwFr` (config.ts:13) — `R` = IAUTH_REQUIRED (s_auth.c:2331). So every client MUST get an iauth decision.
2. **auth_ping_timeout (s_auth.c:1204-1235):** AR_IAUTH_PENDING set + IAUTH_REQUIRED + !AR_IAUTH_SOFT_DONE + circuit-not-open → `exit_client_msg(... "Authorization Timeout")` (1228). The circuit breaker only trips on CONSECUTIVE timeouts (systemic), so an INTERMITTENT single-client stall never trips it → that client dies. Exact symptom: "SASL succeeds, then times out."
3. **iauthd-ts side (THE ROOT):** `handleClientUpdate` (iauth.ts:503-536) — when `client.hurry` is set it decides ONLY `if (pending === 0)`; there is NO `else`. On Hurry with a still-pending DNSBL lookup it sends NOTHING and waits. If a lookup never resolves (slow DNS via pdns-recursor, or an unresponsive DNSBL server, past DNSTIMEOUT or past nefarious's reg timeout), no `D` is ever sent. Developer's own annotations flag this as **"Bug B"** (iauth.ts:557) and a related **"Bug C"** (SYNTHETIC 0.0.0.0 client from `A`-without-`C` → D emitted, ircd mismatch-rejects → stall, iauth.ts:559-561).

**Why intermittent / unreproducible:** requires a DNSBL lookup to hang past the reg timeout for a SPECIFIC client — DNS/recursor timing dependent. SASL works for everyone whose lookups resolve in time (all testnet tests pass).

**FIX (two layers, complementary):**
- **ROOT (iauthd-ts, iauth.ts handleClientUpdate):** on Hurry, force a decision REGARDLESS of pending lookups — treat unresolved lookups as misses. Hurry is the IRCd's "decide now" deadline; a hung ADVISORY DNSBL must not hold (let alone kill) the client. Change `if (client.hurry) { if (pending === 0) { <decide> } }` → decide whenever hurry is set (pending treated as non-match). Mirrors nefarious's own DNSBL-timeout behavior (auth_ping_timeout cancels DNSBL and proceeds, s_auth.c:1243). Verifiable via tools/iauthd-ts tests (iauth.test.ts). Also address Bug C (synthetic client D-emit mismatch).
- **DEFENSE-IN-DEPTH (nefarious, policy):** on local Keycloak SASL success, set AR_IAUTH_SOFT_DONE (mirror iauth_cmd_soft_done) so a proven-identity SASL user survives ANY iauth non-response. Security-policy nuance: does successful Keycloak SASL satisfy IAUTH_REQUIRED? (Likely yes — Keycloak SASL is strong identity; iauth's DNSBL/spoof checks are advisory for an authenticated user.) Maintainer sign-off.

**Recommendation:** ship BOTH — the iauthd-ts Hurry fix is the correct root (fixes UNauthenticated clients too), the nefarious SOFT_DONE is cheap insurance for authenticated users. The current WIP s_auth.c diagnostics (544/650/730) can stay until the fix is validated, then be gated/removed.

## REFINEMENT (2026-07-22, during fix impl) — naive Hurry-fix ALSO bypasses block lists; trigger is config-dependent
- **Maintainer directive:** do NOT loosen the nefarious side (AR_IAUTH_SOFT_DONE on local-SASL success) — it lets a SASL-authed user bypass block lists. Discuss with Rubin before any nef-side change. (Chosen: "iauthd-ts root fix only".)
- **CRITICAL:** the naive iauthd-ts "root fix" (decide on Hurry, treat pending lookups as misses) has the SAME block-list-bypass hole — it passes a client whose DNSBL lookup is merely slow. OFF THE TABLE for the same reason. Any iauthd-ts fix must NOT decide-past-a-pending-blocklist-lookup.
- **`lookupDNSBL` already hard-caps at dnsTimeout (5s) via Promise.race (dnsbl.ts).** A lookup can't hang forever → pending reaches 0 within 5s → decision fires. So "Bug B" (waiting on Hurry) self-resolves in ≤5s and is likely NOT the real trigger (unless nefarious's iauth timeout < ~5s, worth checking FEAT_CONNECTTIMEOUT/auth ping schedule).
- **Bug C (synthetic 0.0.0.0 client → `D 0.0.0.0 0` → nefarious mismatch-reject → stall)** only fires when SASL routes THROUGH iauth (Path 2). Testnet uses local Keycloak SASL (Path 1): iauthd-ts gets C→DNSBL→R(auth)→H, never the `A` exchange, so NO synthetic client. Not the testnet trigger.
- **CONCLUSION:** mechanism fully diagnosed; specific trigger is config-dependent and NOT reproducible in the testnet's local-Keycloak path (consistent with maintainer "could not reproduce"). In-tree diagnostics ARMED (s_auth.c 544/650/730 = which flag blocks; iauthd-ts D-out SUSPICIOUS / H-UNKNOWN / `H id= lookups=n/m`). SAFE next step = catch a LIVE occurrence with diagnostics, confirm the exact non-block-list path, then fix THAT. Do NOT ship a guess (block-list-bypass risk). Non-blocking for the crdt rebase (intermittent, diagnosed, armed).

## ESCALATION (2026-07-27, observed during the libkc in-tree merge) — SIGSEGV, not just a stall

A **live SIGSEGV** was caught in `check_auth_finished` (`ircd/s_auth.c:779`), on the IAuth path, while
running `src/keycloak` and `src/ircv3/sasl.test.ts` against the testnet stack. This is a **more severe
manifestation than anything recorded above** — the documented symptom throughout this doc is a hang
("Authorization Timeout" / stall), not a crash.

**Verified NOT caused by the libkc merge** (two independent reviewers, git evidence):
- `git log --oneline 3e00825..9f2d892 -- ircd/s_auth.c` is **empty** — the merge series touched zero
  lines of this file. Same for `ircd/sasl_auth.c`.
- `git blame -L 775,785 ircd/s_auth.c` attributes the crash-adjacent lines to `4345482` (2026-07-21,
  six days before the merge), whose own message reads *"WIP checkpoint: SASL-stall / DNSBL
  auth-timeout diagnostics (pre-existing)"* — i.e. the armed-diagnostics commit this doc describes.
- The crash path is IAuth (`iauth_parse` / `iauth_read` / `iauth_sock_callback`), with no `kc_*`
  involvement and no reachable path from the vendored code.

**Why this matters for the plan above.** The standing recommendation is "catch a LIVE occurrence with
the armed diagnostics, confirm the exact non-block-list path, then fix THAT." This *was* a live
occurrence — but it crashed rather than stalling, which suggests the armed diagnostics at 544/650/730
may themselves be dereferencing something already freed, OR that the underlying defect has a
memory-safety dimension the stall analysis never reached. Either possibility changes the fix calculus:
a segfault in production auth code is not merely a UX stall.

### ROOT CAUSE (2026-07-27, backtraced) — the diagnostics ARE the faulting code

**`s_auth.c:779` is the diag-exit `log_write` itself**, not the code it was added to observe:

```c
778:  res = register_user(auth->client, auth->client);
779:  log_write(LS_USER, L_INFO, 0,
780:            "check_auth_finished: register_user returned %d for %p "
781:            "(fd %d) — SASL-stall diag exit",
782:            res, (void*)auth, cli_fd(cptr));      /* <-- NULL deref */
```

`register_user()` can exit the client. Its teardown runs through `list.c:436-466`, which
**deliberately** sets `cli_connect(cptr) = 0` (three sites: :446 immediate dealloc, :461 deferred
dealloc, :465 remote) so that `MyConnect()` on a freed Client reads false instead of dangling — the
rationale is spelled out in the `s_misc.c:446-455` comment. `cli_fd(cli)` expands to
`s_fd(&cli_connect(cli)->con_socket)`, so once `cli_connect` is NULL this reads at
`0 + offsetof(Connection, con_socket) + offsetof(Socket, s_fd)`.

**Arithmetic proof** (`gdb` on the built binary): `offsetof(struct Connection, con_socket)` = 9128,
`offsetof(struct Socket, s_fd)` = 56. 9128 + 56 = 9184 = **0x23e0** — exactly the address valgrind
reported. This is also why valgrind said "not stack'd, malloc'd or (recently) free'd" rather than
"freed": the base is NULL, not a stale heap pointer.

**Scope of the defect — one site, not five.** The armed diagnostics read `cli_fd(cptr)` at
`s_auth.c:546, 651, 731, 773, 781`. Only **781** sits after a client-destroying call; 651 and 731 are
early-return "still BLOCKED" paths with the client alive, and 773 is the *entry* log immediately
before `register_user`. The bug is confined to the diag-exit line.

**Consequence for this investigation's standing guidance.** The plan above says to leave the
diagnostics armed and wait to catch a live occurrence. That is now known to be unsafe: whenever
`register_user` takes a client-exiting path, the instrumentation converts a routine registration
failure into a **server-wide SIGSEGV**. Every such occurrence since `4345482` (2026-07-21) has been
crashing the ircd rather than producing the stall this doc is trying to observe.

**Fix (minimal, root cause):** capture the fd before the call and never touch `cptr` after a function
that can exit the client —

```c
int diag_fd = cli_fd(cptr);   /* register_user can exit the client; cli_connect goes NULL */
res = register_user(auth->client, auth->client);
log_write(..., res, (void*)auth, diag_fd);
```

`(void*)auth` is only a pointer value, never dereferenced, so it stays safe.

**Trigger — the bouncer REVIVE path, not any `exit_client`.** Two earlier guesses in this note were
wrong and are recorded here so nobody re-treads them: it is **not** the hardcoded `kcauto1` nick (a
plain collision is answered with 433 in `m_nick`; the client survives and never reaches
`register_user`), and it is **not** `BOUNCE_RESUME_REJECT_DUPLICATE` (that needs
`hs_alias_count >= BOUNCER_MAX_ALIASES` = 4, or `FEAT_BOUNCER_REQUIRE_TLS` — and the testnet sets
`BOUNCER_REQUIRE_TLS = FALSE` with `BOUNCER_ALIASES = TRUE`, so neither gate can fire for a
one-connection test).

The actual path is `s_user.c:520-565`: on a successful bouncer revive, `bounce_revive()` transplants
the socket to the held ghost and **frees the temporary client** — its own contract says so
(`bouncer_session.c:5071-5072`: *"The temporary client whose socket will be transplanted. This client
will be freed (locally, no network messages)."*). `register_user` then returns with an explicit
warning at `s_user.c:564-565`:

```c
/* Return special code — caller must not dereference sptr */
return CPTR_KILLED;
```

`check_auth_finished`'s diag-exit line dereferenced `sptr` anyway. That is the whole bug: a documented
"do not touch this pointer" contract, violated by instrumentation added later.

This also explains the intermittency the rest of this doc never accounted for — it needs a held
session to revive, so it fires on reconnect-to-held-session, not on a first connection.

**The fix is sufficient, not merely necessary.** Because the revive path returns `CPTR_KILLED`
(non-zero), `check_auth_finished`'s trailing `if (res == 0) destroy_auth_request(auth);` is correctly
skipped — important, since freeing the client already ran `destroy_auth_request` via
`list.c:336-337`. Had revive returned 0, removing the NULL deref would merely have exposed a
double-free one line later.

For completeness, the six `exit_client` paths in `register_user` — all eliminated as candidates here,
and `:783`/`:806` are in the remote-client `else` branch that `check_auth_finished` never reaches:

| s_user.c | reason |
|---|---|
| :427 | SASL authentication required for this connection class |
| :596 | Could not attach as alias to existing session |
| :609 | **Account already has an active session on this network** |
| :640 | Registration failed: no nickname |
| :783 | NICK server wrong direction |
| :806 | Too many connections from your host — throttled |

The plausible trigger for a Keycloak test that re-authenticates the same account across runs is
**:609 (or :596)** — an account/session collision on the bouncer path, not a nick collision. The
hardcoded nick was a genuine but separate test bug (433 → flaky failure, no crash); it is fixed, and
fixing it does **not** remove the crash trigger.

**Caller audit — the bug class is confined to one site.** `register_user` has three call sites:
`s_auth.c:778` (the crash), `s_user.c:1107` (`return register_user(...)` — tail call, nothing touched
after), and `bouncer_session.c:9214` (followed only by `MyFree(list)`, `cli` never re-read). Only
`s_auth.c` dereferenced the client afterwards.

Evidence: `.superpowers/sdd/libkc-ircd-merge-phase1-plan/task-9-report.md` (fix-round-1 section) and
the ledger `progress.md` in the same directory. Not tracked anywhere else as of 2026-07-27.
