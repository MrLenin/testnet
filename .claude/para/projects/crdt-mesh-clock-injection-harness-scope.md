# CRDT-mesh timing-race live-validation harness — SCOPE (2026-07-23)

**Purpose.** Convert the Phase-3 timing-race fixes from "reasoned + unit-tested" to "live-proven." A set of
crdt-mesh behaviors depend on real clock skew / clock steps / same-second collisions / reconcile-window
timing across a live multi-node mesh — conditions ad-hoc IRC pokes on a synced-clock shared bed cannot
reproduce deterministically (see the P3-4 live-validation notes: on synced clocks, fixed-vs-unfixed is
indistinguishable). This harness injects those conditions deterministically and asserts the outcomes.

## ⚠️ faketime is a DEAD END here (learned 2026-07-23) — do NOT rebuild on it
`faketime` is NOT in the crdt-mesh Dockerfile → it is absent from the runtime containers. The
`tools/irctest/nefarious.py:210` plumbing that references it runs the ircd as a **host binary on the CI
runner** (where CI installs faketime) — a completely different execution context from the Docker mesh.
(History corrected per user 2026-07-23: the past "never got faketime working" attempts were about running
irctest **locally outside CI** — a host-binary context — NOT about the CRDT mesh; it was never tried against
the mesh containers.) For the mesh it would mean adding the tool to the image and fighting LD_PRELOAD
propagation through the entrypoint `exec` + the optional valgrind wrapper — avoidable risk. **Also OUT: Linux time namespaces** — they virtualize
CLOCK_MONOTONIC/BOOTTIME only, NOT CLOCK_REALTIME, and this ircd reads wall-clock via `time()`/
`gettimeofday()` (CLOCK_REALTIME), so a time-ns offset is invisible to it. And a per-container `date -s`
changes the HOST clock (no realtime isolation without a time-ns, which doesn't help anyway).

## Injection design — an in-ircd debug clock-offset hook (PRIMARY; reliable, self-contained)
The clock-read surface is TINY — **two chokepoints**, both already located:
- **`hlc_wall_clock_ms()`** (crdt_hlc.c:22-25) — the SINGLE function all HLC time flows through
  (:31/:53/:111 + MsgIdCounter ircd.c:1265). One edit covers all HLC/LWW/topic_time/marker ordering.
- **`CurrentTime`** — set from `time()` at exactly THREE sites (engine_epoll.c:291, ircd.c:1082, ircd.c:1239);
  everything else READS the `CurrentTime` global. Adding the offset at those 3 SET sites skews every
  CurrentTime consumer (verify timer, beacon recv_ts, ban expiry, lastmod).

**Design:** a global `time_t ircd_fake_clock_offset` (seconds), **hard-gated `#if defined(DEBUGMODE)`** (the
testbed already builds `--enable-debug`; prod/release builds compile the hook OUT entirely → zero prod
risk), read once at startup from env `IRCD_FAKE_CLOCK_OFFSET`. Apply `+ ircd_fake_clock_offset` in
`hlc_wall_clock_ms` (×1000 for ms) and at the 3 `CurrentTime = time()` sites (a tiny `ircd_now()` helper
keeps it DRY). Emit a LOUD startup `L_WARNING` when non-zero ("FAKE CLOCK OFFSET +Ns ACTIVE — debug only")
so it can never be silently on. ~15 lines, one debug-only path, works IDENTICALLY under valgrind or not,
no container tooling, no LD_PRELOAD.
- **Static per-node skew** (m15, M12, M11): set `IRCD_FAKE_CLOCK_OFFSET` per service in
  `docker-compose.clocktest.yml` (nef4 `+30`, nef5 `0`). For **same-second** (M12), give BOTH colliding
  nodes the SAME offset → identical `TStime()` seconds → guaranteed same-second lastmod.
- **Runtime clock step** (U6, M2, M13-expiry, M8-window): make the offset live-settable — a debug oper
  command (extend the existing `/CRDT` oper command with a `clockstep <±secs>` subcommand → sets
  `ircd_fake_clock_offset`), OR re-read the env/a file at the top of the 30s verify-cb. The oper-command
  path is cleanest (instant, driver-controllable, no polling). **Elegant payoff:** M13 ban-expiry no longer
  needs to WAIT real time — step the offset past `gl_lifetime` and expiry fires in seconds (solves the
  "lifetimes too long to wait for" blocker from the P3-3 live cycle).

**faketime remains an OPTIONAL fallback** only if a zero-production-code-change path is ever required (add
`faketime` to the Dockerfile + a `NEFARIOUS_FAKETIME`→`faketime -f` entrypoint wrap, valgrind off) — but
given the history, the in-ircd hook is the recommended primary.

## Partition / mesh-only leaf (unchanged — proven recipe)
netns sidecar `docker run --net=container:nefariousN --cap-add NET_ADMIN nicolaka/netshoot` + `ss -K dst
<peerIP>` (drop the established P10/overlay socket immediately) + `iptables-nft -A ... -j DROP` (hold —
**host is nftables, MUST use `iptables-nft`**, roadmap:287). Reverse to heal.

**Valgrind:** opt-in via `NEFARIOUS_VALGRIND=1` (dockerentrypoint.sh:57-61). Run the clock-test profile with
it OFF (memory already validated; the in-ircd hook is valgrind-agnostic anyway).

## Harness architecture
Standalone driver (Python, the `/tmp/crdt4c/` throwaway pattern — OR committed under `tests/clocktest/` if we
want it repeatable/CI-able; recommend committed, it's high-value regression infra). Responsibilities:
1. **Bring-up:** start the 5-node CRDT subnet in the clock-test profile (per-node `NEFARIOUS_FAKETIME`,
   valgrind off). Honor the bring-up gotchas (SKILL): sequence targets-before-initiators, don't restart 3+
   at once, force stuck P10 uplinks with oper CONNECT, wait for the 4496 listener not just the pgrep healthcheck.
2. **Per-scenario:** set/step clocks, apply/heal partitions, drive IRC actions via a client helper (oper is
   async via Keycloak — wait for the 381 numeric; then gline / join / part / metadata set-clear), wait the
   relevant window (verify cycle = 30s; reconcile; stepped-expiry), then ASSERT.
3. **Observability** (all already emitted): the verify NOTICE (`digest=`/`mdigest=`/`N mismatch`/`oplog=` —
   convergence + GC); `docker inspect RestartCount` (no crash); targeted log-greps for the scenario signal
   (stub retired? a stale `+o` reappeared? reconcile churn "drove N gline(s)" repeating? a jupe `-server`
   ping-pong? a metadata SET-heal after CLEAR?). Note the `LS_SYSTEM L_DEBUG` filter — need ≥L_INFO logs.

## The scenarios (8) — clock/partition setup → action → assertion
| # | Fix | Injection | Action | PASS assertion |
|---|-----|-----------|--------|----------------|
| 1 | **M12** same-second ban lastmod | both nodes SAME absolute faketime | gline same mask, different reason, one per node, same second | doc converges to one reason; reconcile does NOT churn ("drove N gline(s)" not repeating every cycle); no split |
| 2 | **m15** skew delete-on-leave | nef4 `+30s` ahead of nef5 | on a persisted channel: user +o on nef4, PART, reconnect+rejoin on nef5 | stale `+o` does NOT reappear on the rejoiner (delete-on-leave HLC beats the stale +o); a legit re-op on the clock-behind node still lands |
| 3 | **U6** forward step mass-reap | dynamic file: step a node `+120s` | observe stubs/overlays after the step | NOT all stubs+overlays retired at once (miss_ticks +1, ≤ one retired per genuine 3-tick staleness); mesh self-heals |
| 4 | **M2** beacon poisoning | skew node A `+300s` (future beacons) OR backward-step | A beacons to peers; then observe a live peer B | B does NOT retire a LIVE server on the future/backward beacon; recv_ts still refreshes (Part-A) |
| 5 | **M8** metadata CLEAR resurrect | none (timing-window) | authed account: set metadata key, CLEAR it, wait ~2 verify cycles | the key does NOT resurrect (no SET-heal); peers converge on the tombstone |
| 6 | **M13** ban expiry tombstone+GC | dynamic file: step past `gl_lifetime` | set a gline (short lifetime), step the fake clock past its lifetime | the doc entry is TOMBSTONED then GC'd (oplog/digest reflect a DELETE, not unbounded growth); jupe variant: 3-site expiry all tombstone |
| 7 | **M11** topic split | a legacy island (cutover-off node) + a skewed mesh node | set topic on legacy; then a causally-later topic with a LOWER topic_time on the skewed mesh node | the higher-`topic_time` topic wins EVERYWHERE including the legacy island (no permanent split) |
| 8 | **jupe** config-resurrection | mixed legacy+mesh; a jupe in a legacy node's config | expire the mesh jupe (step clock); rehash the legacy node (re-asserts its config jupe) | the doc settles (no `-server`/`+server` ping-pong loop); `jupe_deactivate` early-return terminates repeated deactivates |

## Build/run integration
- **`docker-compose.clocktest.yml`** override: per-node `NEFARIOUS_FAKETIME`, `NEFARIOUS_VALGRIND=0`, plus the
  netshoot sidecar service(s). Layer via `COMPOSE_FILE` like the libkc-dev overlay.
- **The DEBUGMODE clock-offset hook** (crdt_hlc.c `hlc_wall_clock_ms` + the 3 `CurrentTime = time()` sites +
  a `/CRDT clockstep <±secs>` oper subcommand): the ONLY production-tree change, ~15 lines, compiled out of
  release builds. Everything else is test harness.
- **Driver** under `tests/clocktest/` (committed) or `/tmp/crdt4c/` (throwaway). Recommend committed + a
  `scripts/clocktest.sh` entry; NOT per-commit CI (multi-node mesh + partitions is heavy) — a manual/nightly
  target. The irctest CI already proves faketime works per-commit at the single-node level.

## MVP + sequencing (de-risk the harness before the elaborate scenarios)
- **MVP (proves the harness, no partition):** #1 (M12, static same-faketime), #2 (m15, static skew +
  part/rejoin), #5 (M8, pure timing-window), #6 (M13, dynamic-step-expiry). These need only the faketime
  entrypoint patch + the driver — no netns. #6 also validates the dynamic-file step mechanism.
- **Then (adds partition / legacy island):** #3 (U6 step + a stub via partition), #4 (M2 beacon), #7 (M11
  legacy+mesh split), #8 (jupe mixed). These need the netshoot sidecar + a cutover-off legacy node.

## Open questions / spikes (resolve during build, ~½ day total)
1. **The DEBUGMODE hook covers both clock domains consistently** — verify a live `/CRDT clockstep` moves
   BOTH `CurrentTime` (next event-loop pass) AND `hlc_wall_clock_ms` together, so a stepped node's beacon/
   expiry logic AND its HLC advance in lockstep (they must, since one global offset feeds both). Quick unit
   check. **Do this first — it gates #3/#4/#6/#8.**
2. Forward step vs the `TT_PERIODIC` verify timer: P3-4b already proved (from `ircd_events.c` timer_run +
   engine_epoll CurrentTime-cached-once-per-pass) a forward jump fires it ONCE, not a catch-up burst — and
   the in-ircd hook changes only what `time()`+offset returns, so that reasoning carries directly. Confirm.
3. A cutover-OFF "legacy island" node for #7/#8 (a nefarious node with `FEAT_CRDT_*` off, linked but not
   mesh-aware) — confirm the compose topology supports one, or reuse the primary `.2`.
4. Oper-in-a-driver: reuse the plaintext `oper`/`shmoo` block (faster than async Keycloak; the P3 live cycles
   used it) + wait for the 381 numeric.

## Effort estimate
- DEBUGMODE clock-offset hook (~15 lines, 2 chokepoints + `/CRDT clockstep`) + `docker-compose.clocktest.yml`:
  **~½ day.** (More reliable than the faketime path AND removes the LD_PRELOAD/Dockerfile/valgrind unknowns.)
- Driver + observability + the 4 MVP scenarios: **~1-1.5 days.**
- The 4 partition/legacy scenarios: **~1-1.5 days.**
- Total **~3-3.5 days**, MVP-first so value lands early. The injection is now a known-reliable in-tree hook,
  not a bet on container LD_PRELOAD tooling; the bulk of the work is scenario orchestration.

## Payoff
Closes the single largest validation debt from Phase 3 (every Theme-B fix + M8/M13 + M11 has a timing-race
proof it currently lacks), and — via the dynamic-clock-step — gives a reusable way to test ANY expiry /
NTP-correction / skew behavior deterministically, not just these 8 (regression value beyond the immediate list).
