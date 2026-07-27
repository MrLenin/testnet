# libkc → Nefarious in-tree merge

Scoped 2026-07-27. Decision: **fold `libkc` into the nefarious tree and archive `evilnet/libkc`**
(approach A of A/B/C). Approved by user 2026-07-27 after evidence review.

Cross-ref: [[project_x3_branch_strategy]], [[project_x3_nefarious_merge]],
[[project_sasl_config_secrets_blocker]], [[project_ircd_string_dependency_light]],
`.claude/para/projects/sasl-post-auth-stall.md`.

## Why — all three original justifications are dead or complete

libkc existed for exactly three reasons. Each was checked against the trees, not assumed:

1. **Bootstrap ircd-side Keycloak auth from X3's implementation — COMPLETE.** Six ircd files
   consume `<kc/…>`: `sasl_auth.c`, `sasl_conf.c`, `sasl_webhook.c`, `webpush.c`, `ircd.c`,
   `ircd_kc_adapter.c`. That is the entire intended payload and it shipped.
2. **Testbed for the X3↔ircd transition — COMPLETE AND ABANDONED.** The X3 side was really built:
   `x3_kc_adapter.c`, `x3_kc_bridge.c`, `LIBKC_MIGRATION.md` on branch `keycloak-integration`,
   last commit 2026-03-07, never merged to `master` or `upstream/bouncer-transfer`. Recorded in
   memory as "dead branch, reference design only."
3. **Legacy X3 might gain Keycloak — NOT HAPPENING.** `upstream/bouncer-transfer` ships; it is
   LDAP-backed with zero Keycloak code. Standing direction (Rubin) is to fold services *into* the
   IRCd, so X3 will never acquire this dependency.

A fourth possible reason — external consumers via the GHCR publish workflow and the documented
`--build-arg LIBKC_IMAGE=ghcr.io/<your-org>/libkc:<tag>` fork override — was raised and explicitly
declined by the user. No external consumer is intended.

**Net: one consumer, no prospect of a second.** libkc's own README still claims it is "used by both
X3 Services and Nefarious IRCd" — false as of the `keycloak-integration` branch going dead.

## Why now — the split is actively costing correctness

The dependency ships as an OCI image and has drifted into a three-level staleness chain:

| Layer | Commit | Contains |
|---|---|---|
| local `libkc` HEAD | `d236906` | F-K3 (JWT `exp` required, `nbf` checked) |
| `origin/main` | `96a36b6` | FD-cache fix; **F-K1/F-K2 unpushed** |
| `LIBKC_IMAGE` pin, `nefarious/Dockerfile:6` | `sha-10aa335` | none of the above |

The committed default build of the ircd therefore links a libkc predating the FD-exhaustion fix and
**both** security fixes (webhook fail-closed + constant-time compare; JWT expiry validation). Only
the `docker-compose.libkc-dev.yml` overlay hides this locally. That overlay — 13 services of
`build-context` override, the `scripts/dc.sh` branch, and the CLAUDE.md prohibition on raw
`docker compose build` — exists solely to defeat the repo split.

In-tree, this drift class is structurally impossible: one commit, one build.

Licensing is a non-issue: libkc is GPL-2.0-or-later, "matching X3 and Nefarious."

## Phase 1 — the move (verbatim, reviewable as a move)

**STATUS: COMPLETE 2026-07-27 (nefarious 9f2d892).**
Gate evidence: 17/17 cmocka suites in-image (13 pre-existing + kc_url/kc_base64/kc_cache/kc_jwt); `src/sasl` 2/2 (live PLAIN/ROPC through kc_http/kc_url/kc_base64/kc_cache); `src/keycloak` OAUTHBEARER 2/4 passed, 2 pre-existing failures unrelated to vendoring — RFC 7628 abort-handshake timing gap in `sasl_auth.c` (untouched by this merge, blamed to 2026-03-17) and nick-collision test-pool residue; `kc_jwt_validate_local`'s runtime path (JWKS fetch, signature verify, claim extraction) directly confirmed working via server logs across 3 independent runs; `src/ircv3/sasl.test.ts` 20/20 passed (EXTERNAL, AUTHENTICATE chunking, malformed-payload handling).

### 1.1 Layout

```
nefarious/include/kc/*.h     ← 12 headers, verbatim from libkc/include/
nefarious/ircd/kc/*.c        ←  9 sources, verbatim from libkc/src/
```

`ircd/Makefile.in:59` is `CPPFLAGS = -I. -I.. -I${top_srcdir}/include`, so headers at
`include/kc/` resolve the existing `#include <kc/kc_event.h>` **unchanged**. Zero edits to any of
the six consumer files. The only source edits are intra-libkc includes:
`#include "kc_http.h"` → `#include <kc/kc_http.h>`.

6,178 lines in; ~0 lines of consumer churn.

### 1.2 Boundary rule (non-negotiable)

`ircd/kc/*.c` MUST NOT include ircd headers. It talks to the ircd only through `kc_event_ops` /
`kc_log_ops`, exactly as it does today across the `.so` boundary. `ircd_kc_adapter.c` remains the
sole translation layer.

This is the same shape as the `ircd_string.c must stay dependency-light` rule. Enforced
mechanically: a build-time grep for `#include "ircd` / `#include <ircd` under `ircd/kc/`, failing
the build. Documented in `nefarious/.claude/skills/nefarious-codebase.md` and CLAUDE.md.

Rationale: the `kc_event_ops` seam is *why* the ircd adapter is clean. Vendoring tempts future
contributors to reach straight into ircd internals and collapse it. The rule keeps the merge a
merge rather than a dissolution.

### 1.3 Build system

- `configure.in:1060-1093` — keep `--enable-keycloak` and the `USE_LIBKC` define (decided: it stays
  a configure option rather than becoming always-on, so a no-Keycloak build stays possible and the
  curl/jansson deps stay optional). Delete `--with-keycloak`, `--with-keycloak-includes`,
  `--with-keycloak-libs` and all prefix-hunting. `LIBS` drops `-L$prefix -lkc`, keeps
  `-lcurl -ljansson`; `-lssl -lcrypto` are already linked for TLS.
- Migrate libkc's real dependency probes in: `AC_CHECK_LIB([curl],[curl_multi_init])` and
  `AC_CHECK_LIB([jansson],[json_object])`. Today the ircd asserts these libs without checking.
- `ircd/Makefile.in` — add the nine `kc/*.c` to `IRCD_SRC`. `OBJS = ${SRC:%.c=%.o}` handles the
  subdirectory, so the build rule needs the `kc/` object dir to exist.
- Sources compile only under `--enable-keycloak`, matching current conditional behavior.
- No new Docker build deps: `nefarious/Dockerfile:19` already installs `libcurl4-openssl-dev`,
  `libjansson-dev` and `libcmocka-dev`. Only the libkc `.so`/header COPY goes away.

### 1.4 Testnet / Docker deletions

- `nefarious/Dockerfile`: the `LIBKC_IMAGE` arg, the `FROM ${LIBKC_IMAGE} AS libkc` stage, both
  `COPY --from=libkc` lines.
- `docker-compose.libkc-dev.yml`: deleted in full.
- `scripts/dc.sh:52`: the libkc-overlay `COMPOSE_FILE` branch.
- `.gitmodules` + the `libkc` submodule directory.
- CLAUDE.md: the "breaks the libkc overlay" warning, and the libkc row in the submodule table.

### 1.5 Repo disposition

**Before archiving:** push `fbb13dd` (F-K1/F-K2) and `d236906` (F-K3) to `evilnet/libkc` so the
archived history is not missing its own security fixes. Then archive the repo with a README
pointing at the ircd tree. `git subtree split` remains the extraction path if an external consumer
ever materializes — the escape hatch costs nothing to leave open.

### 1.6 Testing

libkc has **no `tests/` directory at all** today. The ircd already has an `ircd/test/*_cmocka.c`
suite with its own `ircd/test/Makefile.in`, gated in the Docker build via
`cd ircd/test && make cmocka && make test-cmocka` (`nefarious/Dockerfile:88`). New suites register
there and link the `kc/*.o` they need. The merge is what makes these testable:

- `kc_url_cmocka.c` — URL building and escaping
- `kc_base64_cmocka.c` — decode, padding, URL-safe alphabet
- `kc_cache_cmocka.c` — TTL and eviction
- `kc_jwt_cmocka.c` — claim validation against fixed tokens (`exp`/`nbf` — the F-K3 work, currently
  untested)

No network in any of them. Integration coverage stays where it is: the testnet SASL/Keycloak tests
are the real gate and must pass unchanged before and after the move.

### 1.7 Explicitly NOT in Phase 1

No behavior changes. A verbatim move must diff as a verbatim move or it is un-reviewable. Every
defect below lands in Phase 2.

## Phase 2 — immediately after the move

User direction 2026-07-27: these are sequenced work, not deferrals. Both tracks start as soon as
Phase 1 is green.

### 2.1 Blocking HTTPS on the SASL path (HIGH — correctness/latency)

`kc_jwt.c:568` — `kc_jwt_validate_local` calls `jwks_refresh`, which on JWKS TTL expiry performs a
**synchronous** `kc_http_sync_perform` (`kc_jwt.c:281`) inside the ircd's single-threaded event
loop. The entire server stalls on a Keycloak round-trip. The TTL short-circuit
(`kc_jwt.c:259-267`) hides it most of the time, which is what makes it nasty — it fires only on
cache expiry, i.e. rarely and unpredictably, under whatever SASL load happens to be live.

Likely relevant to `.claude/para/projects/sasl-post-auth-stall.md` — check before designing the fix.

Fix direction (to be designed, not assumed): make JWKS refresh async via `kc_http_request`, with
validation deferred or failed-soft during an in-flight refresh; or refresh proactively on a timer
well before TTL so the validate path never fetches.

### 2.2 `kc_http.c` defect inventory (MED — hardening)

Found while rebutting an external review of the file. The review itself was mostly wrong (it
invented an easy-handle leak that does not exist, claimed there are no timeouts when
`CURLOPT_TIMEOUT_MS` is set at `kc_http.c:219` and all five callers pass 10000, and flagged the
evidence-backed `MAXCONNECTS` fix as a red flag). These are the real defects it missed:

1. **Recursion into `curl_multi_socket_action` from the timer callback** — `kc_http.c:346-350`. On
   `timeout_ms == 0`, `curl_timer_cb` synchronously calls `timer_fired_cb`, re-entering
   `curl_multi_socket_action` from inside `CURLMOPT_TIMERFUNCTION`. curl's own `hiperfifo.c` clamps
   `0 → 1ms` with a comment specifically to avoid this.
2. **`kc_http_shutdown` violates its contract** — `kc_http.c:113-134` frees socket infos then calls
   `curl_multi_cleanup` with easy handles still added. In-flight contexts, response buffers and
   slists leak and no callback fires, despite `kc_http.h:53` promising "Cancels any pending
   requests." Low blast radius (shutdown ≈ exit) but the header lies.
3. **No response-size cap** — `kc_http.c:503-525` doubles forever. A misbehaving or hostile endpoint
   walks the daemon out of memory.
4. **Latency stats are quantized garbage** — `kc_http.c:464-472`. `now()` is seconds
   (`kc_event.h:53`), so every latency is a multiple of 1000ms and `max_latency_ms` is unusable.
5. **slist OOM leak** — `kc_http.c:193-202`. `owned = curl_slist_append(owned, …)` returning NULL
   loses the head of the list already built.
6. **Undetected bearer truncation** — `kc_http.c:198-201`. `snprintf` cannot overflow, but a
   Keycloak access token with fat role/group claims past ~2013 bytes yields a silently truncated
   `Authorization` header and an unexplained 401. Needs a return-value check.
7. **Callback re-entrancy** — `kc_http.c:249-250` can fire the user callback before
   `kc_http_request` returns. Callers happen to be safe today; it is an unstated contract.

Item 3 and item 6 are the two with production consequence; 1 is the one most likely to bite under
load. Item 2 is contract hygiene. 4, 5, 7 are cheap once the file is open.

## Decisions taken (do not relitigate)

- Approach A (vendor + archive), not B (fix split ergonomics) or C (merge, keep publishing).
  C is operationally identical to A given `git subtree split`; B buys nothing once the second
  consumer is confirmed dead.
- No external-consumer ambition. GHCR publish workflow goes away with the repo.
- `--enable-keycloak` stays a configure option.
- Boundary rule enforced mechanically, not merely documented.
- Phase 1 is a verbatim move. Zero behavior changes.
