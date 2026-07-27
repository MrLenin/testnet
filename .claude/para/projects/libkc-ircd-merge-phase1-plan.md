# libkc → Nefarious in-tree merge, Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move libkc's 9 sources and 12 headers into the nefarious tree, delete every trace of the standalone-library build path, and give the vendored code the first unit tests it has ever had.

**Architecture:** Headers land in `nefarious/include/kc/`, sources in `nefarious/ircd/kc/`. Because `ircd/Makefile.in:59` already sets `CPPFLAGS = -I. -I.. -I${top_srcdir}/include`, the existing `#include <kc/kc_event.h>` in the six consumer files resolves unchanged — no consumer edits. The `kc_event_ops` / `kc_log_ops` seam is preserved and enforced mechanically: `ircd/kc/*.c` may never include an ircd header.

**Tech Stack:** C (C99), autoconf 2.x (`configure.in`, not `.ac`), hand-written `Makefile.in` (not automake), cmocka, Docker (debian:13), libcurl, jansson, OpenSSL.

**Spec:** `.claude/para/projects/libkc-ircd-merge.md`. Read it before starting.

## Global Constraints

- **Phase 1 changes no behavior.** Sources move verbatim. The only edits to `kc_*.c` / `kc_*.h` content are `#include` path rewrites. If you find a bug, write it into the spec's Phase 2 section — do not fix it here.
- **Repo:** all source changes are in the `nefarious` submodule (`/home/ibutsu/testnet/nefarious`, branch `ircv3.2-hardening`). Testnet-level changes (submodule removal, compose, `dc.sh`, CLAUDE.md) are in the parent repo `/home/ibutsu/testnet`.
- **`ircd/kc/*.c` MUST NOT include any ircd header.** No `#include "ircd_*.h"`, `<ircd_*.h>`, `"client.h"`, `"s_debug.h"`, etc. Task 4 enforces this.
- **Build command is `scripts/dc.sh`**, never raw `docker compose build` — it sources `.env`/`.env.local`.
- **Do not run the full Vitest suite** (`npm test` with no filter). Targeted runs only.
- **Return codes** (from `include/kc/kc_keycloak.h`): `KC_SUCCESS = 0`, `KC_ERROR = -1`, `KC_FORBIDDEN = -3`.
- **Commit at each task boundary.** Nefarious submodule commit first, then the parent-repo pointer bump when the task touches both.

---

### Task 1: Vendor the sources and switch the build in-tree

This task is atomic and cannot be split: while `configure.in` still passes `-lkc`, compiling the same symbols in-tree produces duplicate-definition link errors. Sources, includes, configure, and Makefile move together.

**Files:**
- Create: `nefarious/include/kc/` (12 headers, copied from `libkc/include/`)
- Create: `nefarious/ircd/kc/` (9 sources, copied from `libkc/src/`)
- Modify: `nefarious/configure.in:1060-1093`
- Modify: `nefarious/ircd/Makefile.in` (`IRCD_SRC` list, `.c.o` rule)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `ircd/kc/*.o` object files that Tasks 5–8 link against, and header paths `<kc/kc_url.h>`, `<kc/kc_base64.h>`, `<kc/kc_cache.h>`, `<kc/kc_jwt.h>`, `<kc/kc_keycloak.h>` resolvable from `ircd/test/` via its own `CPPFLAGS = -I${top_srcdir}/include -I../..`.

- [ ] **Step 1: Copy the files into the tree**

```bash
cd /home/ibutsu/testnet
mkdir -p nefarious/include/kc nefarious/ircd/kc
cp libkc/include/*.h nefarious/include/kc/
cp libkc/src/*.c     nefarious/ircd/kc/
ls nefarious/include/kc | wc -l   # expect 12
ls nefarious/ircd/kc   | wc -l    # expect 9
```

- [ ] **Step 2: Rewrite the intra-libkc includes**

All 31 sibling includes are quoted form (`#include "kc_http.h"`). Quoted includes search the *including file's* directory first — which works for the headers (all siblings in `include/kc/`) but breaks for the sources (now in `ircd/kc/`, headers in `include/kc/`). Rewrite all of them to angle form for uniformity:

```bash
cd /home/ibutsu/testnet/nefarious
sed -i -E 's|#include "(kc[a-z0-9_]*\.h)"|#include <kc/\1>|' ircd/kc/*.c include/kc/*.h
grep -rn '#include "kc' ircd/kc/ include/kc/   # expect: no output
grep -rc '#include <kc/' ircd/kc/*.c | paste -sd' '   # expect 25 across sources
```

Expected per-file source counts: `kc_base64.c` 1, `kc.c` 2, `kc_cache.c` 2, `kc_http.c` 2, `kc_webhook.c` 2, `kc_url.c` 2, `kc_http_sync.c` 3, `kc_keycloak.c` 5, `kc_jwt.c` 6. Headers: `kc.h` 2, `kc_http.h` 2, `kc_jwt.h` 1, `kc_url.h` 1.

- [ ] **Step 3: Rewrite the configure.in Keycloak block**

Replace the body of the `if test x"$unet_cv_enable_keycloak" = xyes; then` block at `configure.in:1060-1093` (everything from `AC_ARG_WITH([keycloak],` through `AC_MSG_NOTICE`) with:

```m4
  AC_CHECK_LIB([curl], [curl_multi_init], [],
    [AC_MSG_ERROR([libcurl is required for --enable-keycloak])])
  AC_CHECK_LIB([jansson], [json_object], [],
    [AC_MSG_ERROR([libjansson is required for --enable-keycloak])])

  AC_DEFINE([USE_LIBKC], , [Define if Keycloak support (in-tree kc/) is built])
  AC_MSG_NOTICE([Keycloak support enabled (in-tree ircd/kc)])
```

`AC_CHECK_LIB` prepends `-lcurl` / `-ljansson` to `LIBS` itself, so no manual `LIBS=` assignment. `-lssl -lcrypto` are already linked for TLS. The `--with-keycloak`, `--with-keycloak-includes` and `--with-keycloak-libs` options and all prefix-hunting are deleted outright.

- [ ] **Step 4: Add the sources to ircd/Makefile.in**

In `IRCD_SRC`, immediately after the `jupe.c \` line, insert:

```make
	kc/kc.c \
	kc/kc_base64.c \
	kc/kc_cache.c \
	kc/kc_http.c \
	kc/kc_http_sync.c \
	kc/kc_jwt.c \
	kc/kc_keycloak.c \
	kc/kc_url.c \
	kc/kc_webhook.c \
```

**Corrected in the Phase 1 final review (2026-07-27):** adding these nine lines *literally* — i.e. unconditionally — broke the default `--disable-keycloak` build, which then compiled `kc_webhook.c` with no `-ljansson` in `LIBS`. The shipped form is `@KC_SRC@ \`, `AC_SUBST`ed from `configure.in` (nine sources when Keycloak is enabled, empty otherwise); `ircd/test/Makefile.in`'s `CMOCKA_TESTPROGS` gets `@KC_CMOCKA_TESTPROGS@` the same way. See spec §1.3.

`OBJS = ${SRC:%.c=%.o}` yields `kc/kc_http.o` etc., and the suffix rule `.c.o:` writes the object next to the source — so the `kc/` directory must exist at build time. It does, since it holds the sources. No rule change needed. Verify after building that `ircd/kc/*.o` exist.

- [ ] **Step 5: Regenerate configure and build**

```bash
cd /home/ibutsu/testnet/nefarious
autoconf
./configure --enable-keycloak
make -C ircd 2>&1 | tail -30
```

Expected: clean build. If you get `undefined reference to curl_easy_escape` or similar, the `AC_CHECK_LIB` ordering is wrong — check that `LIBS` contains `-lcurl -ljansson` in `ircd/Makefile`.

- [ ] **Step 6: Verify the library is gone and the symbols are in-tree**

```bash
cd /home/ibutsu/testnet/nefarious
grep -c 'lkc' ircd/Makefile          # expect 0
ls ircd/kc/*.o | wc -l               # expect 9
nm ircd/ircd | grep -c ' T kc_http_request'   # expect 1 (defined in the binary, not imported)
ldd ircd/ircd | grep -c libkc        # expect 0
```

- [ ] **Step 7: Run the existing test suites to confirm no regression**

```bash
cd /home/ibutsu/testnet/nefarious
make -C ircd/test test
(cd ircd/test && make cmocka && make test-cmocka)
```

Expected: all legacy tests PASSED, all cmocka suites pass. These do not exercise kc code — they are the "did the build change break anything else" gate.

- [ ] **Step 8: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add include/kc ircd/kc configure.in ircd/Makefile.in
git commit -m "kc: vendor libkc in-tree (include/kc, ircd/kc)

Sources move verbatim from evilnet/libkc; the only content edit is
rewriting 31 sibling includes from quoted to <kc/...> form. The existing
-I\${top_srcdir}/include already resolves the six consumers' <kc/...>
includes, so no consumer file changes.

configure.in drops --with-keycloak* prefix-hunting and -lkc, and gains
real AC_CHECK_LIB probes for curl and jansson (previously asserted,
never checked).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Drop libkc from the Docker image

**Files:**
- Modify: `nefarious/Dockerfile:1-36`

**Interfaces:**
- Consumes: the in-tree build from Task 1.
- Produces: an image that builds the ircd with no libkc artifact present — the real proof Task 1 is self-sufficient.

- [ ] **Step 1: Delete the libkc plumbing**

Remove from `nefarious/Dockerfile`:
- lines 1–6: the `# --- libkc: pulled from GHCR ---` comment block and `ARG LIBKC_IMAGE=ghcr.io/evilnet/libkc:sha-10aa335`
- line 26: `FROM ${LIBKC_IMAGE} AS libkc`
- lines 31–35: the `COPY --from=libkc /usr/lib/.` and `COPY --from=libkc /usr/include/.` lines and their explanatory comment

Keep `RUN ldconfig` and the `FROM base AS libs` stage — other libraries flow through it. Do **not** touch line 19: `libcurl4-openssl-dev`, `libjansson-dev` and `libcmocka-dev` are already installed and are now the only source of those deps.

- [ ] **Step 2: Verify no libkc references remain**

```bash
grep -in libkc /home/ibutsu/testnet/nefarious/Dockerfile   # expect: no output
```

- [ ] **Step 3: Build the image**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build nefarious 2>&1 | tail -40
```

Expected: build succeeds through the in-image `make test && (cd ircd/test && make cmocka && make test-cmocka)` gate at `Dockerfile:88`. A failure here with `kc/kc_*.h: No such file or directory` means the include rewrite in Task 1 Step 2 missed a file.

- [ ] **Step 4: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add Dockerfile
git commit -m "docker: drop the libkc image stage; kc builds in-tree

The build image already installs libcurl4-openssl-dev and libjansson-dev,
which are now the only source of those deps. Removes the three-level pin
drift (Dockerfile pin -> origin/main -> local HEAD) described in the
merge spec.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Remove the submodule and the overlay machinery

**Files:**
- Delete: `libkc/` (submodule), `docker-compose.libkc-dev.yml`
- Modify: `.gitmodules:12-14`, `scripts/dc.sh:17,52`, `.claude/CLAUDE.md`

**Interfaces:**
- Consumes: Task 2's image, which no longer needs the submodule present.
- Produces: a testnet checkout with no libkc.

- [ ] **Step 1: Read what dc.sh does with the overlay before changing it**

```bash
sed -n '10,60p' /home/ibutsu/testnet/scripts/dc.sh
```

~~`-l` currently does two things — the linked-server profile and the libkc-dev `COMPOSE_FILE` overlay. Only the overlay half is removed; `-l` must keep its linked-server behavior. Do not collapse the flag.~~

**Corrected during execution (Task 3 review; see also Task 9 Step 1):** the premise above is **wrong**. `-l` only ever did *one* thing — the libkc-dev `COMPOSE_FILE` overlay. `scripts/dc.sh:22-33` assigns `LINKED=1` and never reads it, before or after this task; `nefarious2`..`nefarious7` are profile-gated in `docker-compose.yml` and need an explicit `--profile linked`. Removing the overlay branch therefore leaves `LINKED` a dead variable. Deleting the whole `if [[ $LINKED -eq 1 ]] … fi` block (rather than just the `export COMPOSE_FILE=` line, which would leave an empty then-body and a bash syntax error) was the correct edit and is what shipped.

- [ ] **Step 2: Remove the submodule**

```bash
cd /home/ibutsu/testnet
git submodule deinit -f libkc
git rm -f libkc
rm -rf .git/modules/libkc
grep -c libkc .gitmodules    # expect 0
```

`git rm` removes the `.gitmodules` stanza at lines 12–14 automatically. Verify the `nefarious-upstream` stanza that followed it is intact.

- [ ] **Step 3: Delete the compose overlay and the dc.sh branch**

```bash
cd /home/ibutsu/testnet
git rm -f docker-compose.libkc-dev.yml
```

In `scripts/dc.sh`, delete the `export COMPOSE_FILE="docker-compose.yml:docker-compose.libkc-dev.yml"` line (line 52) and the `-l adds the libkc-dev overlay` half of the comment at line 17. Leave the linked-profile logic alone.

- [ ] **Step 4: Update CLAUDE.md**

In `/home/ibutsu/testnet/.claude/CLAUDE.md`:
- Delete the `libkc` row from the Submodules table.
- In the "Build & run" section, change the warning from "**Avoid raw `docker compose build`** — it skips `.env.local` and breaks the libkc overlay" to "**Avoid raw `docker compose build`** — it skips `.env.local`." The overlay no longer exists.

- [ ] **Step 5: Verify a clean stack comes up**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh -l up -d
scripts/dc.sh logs nefarious 2>&1 | tail -20
```

Expected: nefarious starts and links. Per the `service-debugging` skill, confirm `pdns-recursor` is healthy first — several services depend on it transitively and a failure there masquerades as a build problem.

- [ ] **Step 6: Commit**

```bash
cd /home/ibutsu/testnet
git add -A .gitmodules libkc docker-compose.libkc-dev.yml scripts/dc.sh .claude/CLAUDE.md
git commit -m "testnet: retire the libkc submodule and its compose overlay

libkc is now vendored in nefarious/ircd/kc. Removes the submodule, the
13-service docker-compose.libkc-dev.yml build-context override, and the
dc.sh COMPOSE_FILE branch that existed solely to defeat the repo split.
-l keeps its linked-server meaning.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Enforce the kc/ boundary rule mechanically

The `kc_event_ops` seam is what keeps `ircd/kc/` independently reasonable. Documentation alone decays; this makes a violation fail the build.

**Files:**
- Modify: `nefarious/ircd/Makefile.in`
- Modify: `nefarious/.claude/skills/nefarious-codebase.md`

**Interfaces:**
- Consumes: `ircd/kc/*.c` from Task 1.
- Produces: a `check-kc-boundary` make target run as a prerequisite of the ircd build.

- [ ] **Step 1: Add the check target to ircd/Makefile.in**

Insert before the `build:` target:

```make
# The kc/ subtree is the vendored libkc.  It talks to the ircd only through
# the kc_event_ops / kc_log_ops adapters (ircd_kc_adapter.c) — exactly as it
# did when it was a separate .so.  Including an ircd header here collapses
# that seam, so it is a build error.  See
# .claude/para/projects/libkc-ircd-merge.md.
check-kc-boundary:
	@bad=`grep -l -E '^[[:space:]]*#[[:space:]]*include[[:space:]]*("|<ircd)' ${srcdir}/kc/*.c ${srcdir}/kc/*.h 2>/dev/null`; \
	if [ -n "$$bad" ]; then \
		echo "ERROR: ircd/kc must not include ircd headers:"; \
		for f in $$bad; do echo "  $$f"; done; \
		echo "kc/ talks to the ircd only via kc_event_ops/kc_log_ops."; \
		exit 1; \
	fi
```

Add `check-kc-boundary` as the first prerequisite of the `build:` target, and add it to `.PHONY` if a `.PHONY` line exists in this file (if not, no change needed — the target name collides with no file).

**Widened during execution (Task 4 review, user ruling):** the original expression matched only `(ircd|client|s_debug|struct|msgq|dbuf)` prefixes and missed 22 core ircd headers (`channel.h`, `s_conf.h`, `numnicks.h`, `send.h`, `hash.h`, `list.h`, …). After Task 1 every legitimate include under `ircd/kc/` is angle-form — `<kc/…>`, `<stdlib.h>`, `<curl/curl.h>`, `<jansson.h>`, `<openssl/…>` — so **any quoted include is by definition a reach into the ircd tree**. The rule above flags quoted includes plus angle-form `<ircd…>`, needs no maintenance as `include/` grows, and the red test must plant a header the old expression missed (e.g. `#include "s_conf.h"`) to prove the widening.

- [ ] **Step 2: Verify the check fails on a real violation (red)**

```bash
cd /home/ibutsu/testnet/nefarious
sed -i '1i #include "s_conf.h"' ircd/kc/kc_url.c
make -C ircd check-kc-boundary; echo "exit=$?"
```

Expected: prints `ERROR: ircd/kc must not include ircd headers:` followed by `.../kc/kc_url.c`, and `exit=1`.

- [ ] **Step 3: Remove the violation and verify it passes (green)**

```bash
cd /home/ibutsu/testnet/nefarious
sed -i '1d' ircd/kc/kc_url.c
head -3 ircd/kc/kc_url.c        # confirm the file's original first lines are back
make -C ircd check-kc-boundary; echo "exit=$?"
```

Expected: no output, `exit=0`.

- [ ] **Step 4: Document the rule in the skill**

In `nefarious/.claude/skills/nefarious-codebase.md`, add a section next to the existing dependency-light guidance:

```markdown
## The ircd/kc boundary

`ircd/kc/*.c` is vendored libkc (formerly `evilnet/libkc`, merged 2026-07).
It reaches the ircd **only** through `kc_event_ops` / `kc_log_ops`;
`ircd_kc_adapter.c` is the sole translation layer. Including an ircd header
from `kc/` is a build error, enforced by `make check-kc-boundary`.

If kc code needs something from the ircd, add it to the adapter interface in
`include/kc/kc_event.h` — do not reach across.
```

- [ ] **Step 5: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/Makefile.in .claude/skills/nefarious-codebase.md
git commit -m "kc: fail the build if ircd/kc includes an ircd header

Preserves the kc_event_ops seam that survived the vendoring. Verified
red (planted include -> exit 1) and green (removed -> exit 0).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: cmocka suite for kc_url

These are characterization tests: the code already exists and is expected to pass on first run. Their value is regression protection for Phase 2, when this code gets edited. Do not expect a red phase — expect the suite to pass immediately, and treat a failure as a real bug found (record it in the spec's Phase 2 section rather than "fixing the test").

**Files:**
- Create: `nefarious/ircd/test/kc_url_cmocka.c`
- Modify: `nefarious/ircd/test/Makefile.in`

**Interfaces:**
- Consumes: `ircd/kc/kc_url.o` from Task 1; `struct kc_realm { const char *base_url; const char *realm; }` from `<kc/kc_realm.h>`.
- Produces: the `KC_*_CMOCKA_OBJS` / target pattern that Tasks 6–8 copy.

- [ ] **Step 1: Write the test**

Create `nefarious/ircd/test/kc_url_cmocka.c`:

```c
/*
 * kc_url_cmocka.c - unit tests for the vendored libkc URL builders.
 *
 * kc_url.c uses the kc_log_* macros, which call kc_get_log_ops() from
 * kc.c.  We stub it here rather than link kc.o, which would drag in the
 * whole HTTP stack for a set of string-building tests.
 */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <stdlib.h>
#include <string.h>

#include <kc/kc_log.h>
#include <kc/kc_realm.h>
#include <kc/kc_url.h>

const struct kc_log_ops *kc_get_log_ops(void);
const struct kc_log_ops *kc_get_log_ops(void) { return NULL; }

static const struct kc_realm R = { "http://keycloak:8080", "afternet" };

static void test_token_endpoint(void **state) {
    (void)state;
    char *u = kc_url_token(R);
    assert_non_null(u);
    assert_string_equal(u,
        "http://keycloak:8080/realms/afternet/protocol/openid-connect/token");
    free(u);
}

static void test_jwks_endpoint(void **state) {
    (void)state;
    char *u = kc_url_jwks(R);
    assert_non_null(u);
    assert_string_equal(u,
        "http://keycloak:8080/realms/afternet/protocol/openid-connect/certs");
    free(u);
}

static void test_user_by_id(void **state) {
    (void)state;
    char *u = kc_url_user(R, "abc-123");
    assert_non_null(u);
    assert_string_equal(u,
        "http://keycloak:8080/admin/realms/afternet/users/abc-123");
    free(u);
}

static void test_user_by_username_exact(void **state) {
    (void)state;
    char *u = kc_url_user_by_username(R, "alice", 1);
    assert_non_null(u);
    assert_non_null(strstr(u, "username=alice"));
    assert_non_null(strstr(u, "exact=true"));
    free(u);
}

static void test_user_by_username_inexact(void **state) {
    (void)state;
    char *u = kc_url_user_by_username(R, "alice", 0);
    assert_non_null(u);
    assert_null(strstr(u, "exact=true"));
    free(u);
}

/* Every builder must reject a NULL realm rather than format "(null)". */
static void test_null_realm_rejected(void **state) {
    (void)state;
    struct kc_realm bad = { NULL, NULL };
    assert_null(kc_url_token(bad));
    assert_null(kc_url_jwks(bad));
    assert_null(kc_url_users(bad));
}

/* group_by_path percent-encodes via curl but must keep literal slashes. */
static void test_group_by_path_keeps_slashes(void **state) {
    (void)state;
    char *u = kc_url_group_by_path(R, "/staff/opers");
    assert_non_null(u);
    assert_non_null(strstr(u, "/staff/opers"));
    assert_null(strstr(u, "%2F"));
    free(u);
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(test_token_endpoint),
        cmocka_unit_test(test_jwks_endpoint),
        cmocka_unit_test(test_user_by_id),
        cmocka_unit_test(test_user_by_username_exact),
        cmocka_unit_test(test_user_by_username_inexact),
        cmocka_unit_test(test_null_realm_rejected),
        cmocka_unit_test(test_group_by_path_keeps_slashes),
    };
    return cmocka_run_group_tests(tests, NULL, NULL);
}
```

These assertions were verified against `kc_url.c`'s templates: `"%s/realms/%s/protocol/openid-connect/token"`, `"…/certs"`, `"%s/admin/realms/%s/users/%s"`, and `"%s/admin/realms/%s/users/?username=%s%s"` with `exact_suffix = "&exact=true"`. All builders open with `if (!r.base_url || !r.realm || …) return NULL;`, so `test_null_realm_rejected` passes as written.

- [ ] **Step 2: Wire it into the test Makefile**

In `nefarious/ircd/test/Makefile.in`:
- add `kc_url_cmocka` to `CMOCKA_TESTPROGS`
- add `kc_url_cmocka.c \` to `DEP_SRC`
- add a `CURL_LIBS = -lcurl` variable next to the existing `ZSTD_LIBS = -lzstd`
- add the target after the `recv_classify_cmocka` block:

```make
# kc_url tests - vendored libkc URL builders.  kc_url.c calls
# curl_easy_escape in kc_url_group_by_path, hence -lcurl.  The test
# stubs kc_get_log_ops itself so kc.o (and the whole HTTP stack) stays
# out of the link.
KC_URL_CMOCKA_OBJS = kc_url_cmocka.o ../kc/kc_url.o
kc_url_cmocka: $(KC_URL_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(KC_URL_CMOCKA_OBJS) $(CMOCKA_LIBS) $(CURL_LIBS)
```

- [ ] **Step 3: Build and run**

```bash
cd /home/ibutsu/testnet/nefarious
make -C ircd            # ensure ../kc/kc_url.o is current
(cd ircd/test && make kc_url_cmocka && ./kc_url_cmocka)
```

Expected: 7 tests, all PASSED. A failure in `test_null_realm_rejected` means the builders don't NULL-guard — real finding, record it under Phase 2 in the spec and mark the test `cmocka_unit_test` → skip with a comment referencing the spec, rather than deleting it.

- [ ] **Step 4: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/test/kc_url_cmocka.c ircd/test/Makefile.in
git commit -m "test: cmocka coverage for kc_url endpoint builders

First unit tests the vendored libkc code has ever had.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: cmocka suite for kc_base64

**Files:**
- Create: `nefarious/ircd/test/kc_base64_cmocka.c`
- Modify: `nefarious/ircd/test/Makefile.in`

**Interfaces:**
- Consumes: `ircd/kc/kc_base64.o`. API from `<kc/kc_base64.h>`: `bool kc_isbase64(char)`, `void kc_base64_encode(const char *in, size_t inlen, char *out, size_t outlen)`, `size_t kc_base64_encode_alloc(const char *in, size_t inlen, char **out)`, `bool kc_base64_decode(const char *in, size_t inlen, char *out, size_t *outlen)`, `bool kc_base64_decode_alloc(const char *in, size_t inlen, char **out, size_t *outlen)`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the test**

Create `nefarious/ircd/test/kc_base64_cmocka.c`:

```c
/*
 * kc_base64_cmocka.c - unit tests for the vendored libkc base64 codec.
 * kc_base64.c has no libkc dependencies at all — no log stub needed.
 */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <stdlib.h>
#include <string.h>

#include <kc/kc_base64.h>

static void test_encode_alloc_roundtrip(void **state) {
    (void)state;
    const char *in = "nefarious";
    char *enc = NULL;
    size_t enc_len = kc_base64_encode_alloc(in, strlen(in), &enc);
    assert_non_null(enc);
    assert_int_equal(enc_len, KC_BASE64_LENGTH(strlen(in)));
    assert_string_equal(enc, "bmVmYXJpb3Vz");

    char *dec = NULL;
    size_t dec_len = 0;
    assert_true(kc_base64_decode_alloc(enc, enc_len, &dec, &dec_len));
    assert_int_equal(dec_len, strlen(in));
    assert_memory_equal(dec, in, dec_len);

    free(enc);
    free(dec);
}

/* One and two padding characters — the two off-by-one-prone cases. */
static void test_padding_one(void **state) {
    (void)state;
    char *enc = NULL;
    kc_base64_encode_alloc("ab", 2, &enc);
    assert_string_equal(enc, "YWI=");
    free(enc);
}

static void test_padding_two(void **state) {
    (void)state;
    char *enc = NULL;
    kc_base64_encode_alloc("a", 1, &enc);
    assert_string_equal(enc, "YQ==");
    free(enc);
}

static void test_empty_input(void **state) {
    (void)state;
    char *enc = NULL;
    size_t n = kc_base64_encode_alloc("", 0, &enc);
    assert_int_equal(n, 0);
    assert_non_null(enc);
    assert_string_equal(enc, "");
    free(enc);
}

/* Binary payloads must survive — JWKS moduli are not text. */
static void test_binary_roundtrip(void **state) {
    (void)state;
    const char raw[] = { 0x00, (char)0xff, 0x10, (char)0x80, 0x7f };
    char *enc = NULL;
    size_t enc_len = kc_base64_encode_alloc(raw, sizeof raw, &enc);
    assert_non_null(enc);

    char *dec = NULL;
    size_t dec_len = 0;
    assert_true(kc_base64_decode_alloc(enc, enc_len, &dec, &dec_len));
    assert_int_equal(dec_len, sizeof raw);
    assert_memory_equal(dec, raw, sizeof raw);

    free(enc);
    free(dec);
}

static void test_reject_invalid(void **state) {
    (void)state;
    char *dec = NULL;
    size_t dec_len = 0;
    /* '!' is not in the base64 alphabet. */
    assert_false(kc_base64_decode_alloc("YWJ!", 4, &dec, &dec_len));
    free(dec);
}

static void test_isbase64(void **state) {
    (void)state;
    assert_true(kc_isbase64('A'));
    assert_true(kc_isbase64('z'));
    assert_true(kc_isbase64('0'));
    assert_true(kc_isbase64('+'));
    assert_true(kc_isbase64('/'));
    assert_false(kc_isbase64('!'));
    assert_false(kc_isbase64('-'));   /* url-safe alphabet is NOT accepted here */
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(test_encode_alloc_roundtrip),
        cmocka_unit_test(test_padding_one),
        cmocka_unit_test(test_padding_two),
        cmocka_unit_test(test_empty_input),
        cmocka_unit_test(test_binary_roundtrip),
        cmocka_unit_test(test_reject_invalid),
        cmocka_unit_test(test_isbase64),
    };
    return cmocka_run_group_tests(tests, NULL, NULL);
}
```

- [ ] **Step 2: Wire it into the test Makefile**

Add `kc_base64_cmocka` to `CMOCKA_TESTPROGS`, `kc_base64_cmocka.c \` to `DEP_SRC`, and:

```make
# kc_base64 tests - vendored libkc base64 codec (no libkc deps)
KC_BASE64_CMOCKA_OBJS = kc_base64_cmocka.o ../kc/kc_base64.o
kc_base64_cmocka: $(KC_BASE64_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(KC_BASE64_CMOCKA_OBJS) $(CMOCKA_LIBS)
```

- [ ] **Step 3: Build and run**

```bash
cd /home/ibutsu/testnet/nefarious
(cd ircd/test && make kc_base64_cmocka && ./kc_base64_cmocka)
```

Expected: 7 tests, all PASSED. The length assertions were verified against `kc_base64.c:112-141`: `kc_base64_encode_alloc` computes `outlen = 1 + KC_BASE64_LENGTH(inlen)` but returns `outlen - 1`, i.e. the encoded length excluding the NUL — so passing that value straight back into `kc_base64_decode_alloc` is correct, and the empty-input case returns 0 with a 1-byte `""` buffer.

- [ ] **Step 4: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/test/kc_base64_cmocka.c ircd/test/Makefile.in
git commit -m "test: cmocka coverage for kc_base64 codec

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: cmocka suite for kc_cache

**Files:**
- Create: `nefarious/ircd/test/kc_cache_cmocka.c`
- Modify: `nefarious/ircd/test/Makefile.in`

**Interfaces:**
- Consumes: `ircd/kc/kc_cache.o`. API from `<kc/kc_cache.h>`: `void kc_cache_init(void)`, `void kc_cache_cleanup(void)`, `void kc_cache_stats_get(struct kc_cache_stats *)`, `void kc_userid_cache_put(const char *username, const char *user_id)`, `const char *kc_userid_cache_get(const char *username)`, `void kc_userid_cache_remove(const char *username)`, `void kc_user_repr_cache_put(const char *user_id, json_t *repr)`, `json_t *kc_user_repr_cache_get(const char *user_id)`, `void kc_user_repr_cache_remove(const char *user_id)`. `struct kc_cache_stats { unsigned long user_cache_hits; unsigned long user_cache_misses; }`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the test**

Create `nefarious/ircd/test/kc_cache_cmocka.c`:

```c
/*
 * kc_cache_cmocka.c - unit tests for the vendored libkc caches.
 * kc_cache.c uses the kc_log_* macros; stub kc_get_log_ops as in
 * kc_url_cmocka.c.  jansson is required for the representation cache.
 */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <string.h>
#include <jansson.h>

#include <kc/kc_log.h>
#include <kc/kc_cache.h>

const struct kc_log_ops *kc_get_log_ops(void);
const struct kc_log_ops *kc_get_log_ops(void) { return NULL; }

static int setup(void **state) { (void)state; kc_cache_init(); return 0; }
static int teardown(void **state) { (void)state; kc_cache_cleanup(); return 0; }

static void test_userid_put_get(void **state) {
    (void)state;
    kc_userid_cache_put("alice", "uuid-alice");
    const char *got = kc_userid_cache_get("alice");
    assert_non_null(got);
    assert_string_equal(got, "uuid-alice");
}

static void test_userid_miss_returns_null(void **state) {
    (void)state;
    assert_null(kc_userid_cache_get("nobody"));
}

/* Nick comparison in IRC is case-insensitive; kc_cache.c includes
 * <strings.h> for strcasecmp, so a case-varied lookup must hit. */
static void test_userid_lookup_is_case_insensitive(void **state) {
    (void)state;
    kc_userid_cache_put("Alice", "uuid-alice");
    const char *got = kc_userid_cache_get("alice");
    assert_non_null(got);
    assert_string_equal(got, "uuid-alice");
}

static void test_userid_put_overwrites(void **state) {
    (void)state;
    kc_userid_cache_put("bob", "uuid-old");
    kc_userid_cache_put("bob", "uuid-new");
    assert_string_equal(kc_userid_cache_get("bob"), "uuid-new");
}

static void test_userid_remove(void **state) {
    (void)state;
    kc_userid_cache_put("carol", "uuid-carol");
    kc_userid_cache_remove("carol");
    assert_null(kc_userid_cache_get("carol"));
}

static void test_stats_count_hits_and_misses(void **state) {
    (void)state;
    struct kc_cache_stats before, after;
    kc_cache_stats_get(&before);

    kc_userid_cache_put("dave", "uuid-dave");
    (void)kc_userid_cache_get("dave");      /* hit */
    (void)kc_userid_cache_get("nobody2");   /* miss */

    kc_cache_stats_get(&after);
    assert_int_equal(after.user_cache_hits,   before.user_cache_hits + 1);
    assert_int_equal(after.user_cache_misses, before.user_cache_misses + 1);
}

/* The repr cache must deep-copy: mutating the caller's object afterwards
 * must not change what the cache holds. */
static void test_repr_cache_deep_copies(void **state) {
    (void)state;
    json_t *repr = json_pack("{s:s}", "username", "erin");
    kc_user_repr_cache_put("uuid-erin", repr);
    json_object_set_new(repr, "username", json_string("mallory"));

    json_t *cached = kc_user_repr_cache_get("uuid-erin");
    assert_non_null(cached);
    assert_string_equal(json_string_value(json_object_get(cached, "username")),
                        "erin");
    json_decref(repr);
}

/* Credentials must never be retained in the cache. */
static void test_repr_cache_strips_credentials(void **state) {
    (void)state;
    json_t *repr = json_pack("{s:s, s:[{s:s}]}",
                             "username", "frank",
                             "credentials", "value", "hunter2");
    kc_user_repr_cache_put("uuid-frank", repr);
    json_decref(repr);

    json_t *cached = kc_user_repr_cache_get("uuid-frank");
    assert_non_null(cached);
    assert_null(json_object_get(cached, "credentials"));
}

static void test_repr_cache_remove(void **state) {
    (void)state;
    json_t *repr = json_pack("{s:s}", "username", "grace");
    kc_user_repr_cache_put("uuid-grace", repr);
    json_decref(repr);
    kc_user_repr_cache_remove("uuid-grace");
    assert_null(kc_user_repr_cache_get("uuid-grace"));
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test_setup_teardown(test_userid_put_get, setup, teardown),
        cmocka_unit_test_setup_teardown(test_userid_miss_returns_null, setup, teardown),
        cmocka_unit_test_setup_teardown(test_userid_lookup_is_case_insensitive, setup, teardown),
        cmocka_unit_test_setup_teardown(test_userid_put_overwrites, setup, teardown),
        cmocka_unit_test_setup_teardown(test_userid_remove, setup, teardown),
        cmocka_unit_test_setup_teardown(test_stats_count_hits_and_misses, setup, teardown),
        cmocka_unit_test_setup_teardown(test_repr_cache_deep_copies, setup, teardown),
        cmocka_unit_test_setup_teardown(test_repr_cache_strips_credentials, setup, teardown),
        cmocka_unit_test_setup_teardown(test_repr_cache_remove, setup, teardown),
    };
    return cmocka_run_group_tests(tests, NULL, NULL);
}
```

Verified against `kc_cache.c`: the user-id cache compares with `strcasecmp` (lines 128, 191, 214) so the case-insensitive assertion holds; the representation cache compares UUIDs with `strcmp` (lines 249, 307, 323), which is correct for opaque IDs.

- [ ] **Step 2: Wire it into the test Makefile**

Add `kc_cache_cmocka` to `CMOCKA_TESTPROGS`, `kc_cache_cmocka.c \` to `DEP_SRC`, add `JANSSON_LIBS = -ljansson` next to `ZSTD_LIBS`, and:

```make
# kc_cache tests - vendored libkc user-id and user-representation caches
KC_CACHE_CMOCKA_OBJS = kc_cache_cmocka.o ../kc/kc_cache.o
kc_cache_cmocka: $(KC_CACHE_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(KC_CACHE_CMOCKA_OBJS) $(CMOCKA_LIBS) $(JANSSON_LIBS)
```

- [ ] **Step 3: Build and run**

```bash
cd /home/ibutsu/testnet/nefarious
(cd ircd/test && make kc_cache_cmocka && ./kc_cache_cmocka)
```

Expected: 9 tests, all PASSED.

- [ ] **Step 4: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/test/kc_cache_cmocka.c ircd/test/Makefile.in
git commit -m "test: cmocka coverage for kc_cache (user-id + repr caches)

Includes a regression test that the representation cache deep-copies and
strips credentials.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: cmocka suite for kc_jwt claim validation (F-K3)

The `exp`/`nbf` enforcement added by F-K3 lives in `jwt_parse_claims()`, which is `static` and sits behind the JWKS fetch in `kc_jwt_validate_local()`. The tree already has a pattern for this: `ircd_cloaking_cmocka` and `crule_cmocka` `#include` the `.c` under test to reach its statics. Do the same — this reaches the claim logic with no network and no JWKS.

**Files:**
- Create: `nefarious/ircd/test/kc_jwt_cmocka.c`
- Modify: `nefarious/ircd/test/Makefile.in`

**Interfaces:**
- Consumes: `ircd/kc/kc_jwt.c` (included, not linked), `ircd/kc/kc_base64.o`, `ircd/kc/kc_http_sync.o`. `struct kc_token_info` from `<kc/kc_keycloak.h>`; relevant fields `long exp`, `long nbf`, `long iat`, `char *sub`, `char *username`, `char *iss`, `char *azp`, `bool active`. Internal signature: `static int jwt_parse_claims(const char *payload_b64, struct kc_token_info *info)` returning `KC_SUCCESS` / `KC_FORBIDDEN` / `KC_ERROR`. `KC_JWT_CLOCK_SKEW` is 60.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the test**

Create `nefarious/ircd/test/kc_jwt_cmocka.c`:

```c
/*
 * kc_jwt_cmocka.c - unit tests for JWT claim validation (F-K3).
 *
 * jwt_parse_claims() is static and sits behind the JWKS fetch in
 * kc_jwt_validate_local(), so we #include the .c to reach it — the same
 * approach ircd_cloaking_cmocka.c and crule_cmocka.c use.  No network,
 * no JWKS, no signature verification is exercised here: this covers the
 * claim policy only.
 *
 * Payloads are base64url of:
 *   VALID       {"exp":4102444800,"sub":"u1","preferred_username":"alice"}
 *   NOEXP       {"sub":"u1","preferred_username":"alice"}
 *   EXPIRED     {"exp":1000000000,"sub":"u1"}
 *   FUTURE_NBF  {"exp":4102444800,"nbf":4102444800,"sub":"u1"}
 * exp 4102444800 = 2100-01-01; exp 1000000000 = 2001-09-09.
 */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <stdlib.h>
#include <string.h>

#include <kc/kc_log.h>

const struct kc_log_ops *kc_get_log_ops(void);
const struct kc_log_ops *kc_get_log_ops(void) { return NULL; }

#include "../kc/kc_jwt.c"

#define P_VALID      "eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIiwicHJlZmVycmVkX3VzZXJuYW1lIjoiYWxpY2UifQ"
#define P_NOEXP      "eyJzdWIiOiJ1MSIsInByZWZlcnJlZF91c2VybmFtZSI6ImFsaWNlIn0"
#define P_EXPIRED    "eyJleHAiOjEwMDAwMDAwMDAsInN1YiI6InUxIn0"
#define P_FUTURE_NBF "eyJleHAiOjQxMDI0NDQ4MDAsIm5iZiI6NDEwMjQ0NDgwMCwic3ViIjoidTEifQ"

static void free_info_fields(struct kc_token_info *i) {
    free(i->username); free(i->email); free(i->sub);
    free(i->iss); free(i->azp);
}

static void test_valid_claims_accepted(void **state) {
    (void)state;
    struct kc_token_info info;
    memset(&info, 0, sizeof info);
    assert_int_equal(jwt_parse_claims(P_VALID, &info), KC_SUCCESS);
    assert_true(info.active);
    assert_int_equal(info.exp, 4102444800L);
    assert_string_equal(info.sub, "u1");
    assert_string_equal(info.username, "alice");
    free_info_fields(&info);
}

/* F-K3: a token with no exp would otherwise be valid forever. */
static void test_missing_exp_rejected(void **state) {
    (void)state;
    struct kc_token_info info;
    memset(&info, 0, sizeof info);
    assert_int_equal(jwt_parse_claims(P_NOEXP, &info), KC_FORBIDDEN);
    free_info_fields(&info);
}

static void test_expired_rejected(void **state) {
    (void)state;
    struct kc_token_info info;
    memset(&info, 0, sizeof info);
    assert_int_equal(jwt_parse_claims(P_EXPIRED, &info), KC_FORBIDDEN);
    free_info_fields(&info);
}

/* F-K3: nbf enforced when present, beyond the 60s skew tolerance. */
static void test_future_nbf_rejected(void **state) {
    (void)state;
    struct kc_token_info info;
    memset(&info, 0, sizeof info);
    assert_int_equal(jwt_parse_claims(P_FUTURE_NBF, &info), KC_FORBIDDEN);
    free_info_fields(&info);
}

/* An absent nbf is not an error — Keycloak does not always emit it. */
static void test_absent_nbf_is_not_an_error(void **state) {
    (void)state;
    struct kc_token_info info;
    memset(&info, 0, sizeof info);
    assert_int_equal(jwt_parse_claims(P_VALID, &info), KC_SUCCESS);
    assert_int_equal(info.nbf, 0);
    free_info_fields(&info);
}

static void test_garbage_payload_rejected(void **state) {
    (void)state;
    struct kc_token_info info;
    memset(&info, 0, sizeof info);
    int rc = jwt_parse_claims("!!!not-base64!!!", &info);
    assert_int_not_equal(rc, KC_SUCCESS);
    free_info_fields(&info);
}

static void test_extract_created_at_handles_malformed(void **state) {
    (void)state;
    assert_int_equal(kc_jwt_extract_created_at(NULL), 0);
    assert_int_equal(kc_jwt_extract_created_at("no-dots-here"), 0);
    assert_int_equal(kc_jwt_extract_created_at("only.one-dot"), 0);
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(test_valid_claims_accepted),
        cmocka_unit_test(test_missing_exp_rejected),
        cmocka_unit_test(test_expired_rejected),
        cmocka_unit_test(test_future_nbf_rejected),
        cmocka_unit_test(test_absent_nbf_is_not_an_error),
        cmocka_unit_test(test_garbage_payload_rejected),
        cmocka_unit_test(test_extract_created_at_handles_malformed),
    };
    return cmocka_run_group_tests(tests, NULL, NULL);
}
```

- [ ] **Step 2: Wire it into the test Makefile**

Add `kc_jwt_cmocka` to `CMOCKA_TESTPROGS`, `kc_jwt_cmocka.c \` to `DEP_SRC`, add `SSL_LIBS = -lssl -lcrypto` next to `ZSTD_LIBS`, and:

```make
# kc_jwt tests - claim policy (F-K3 exp/nbf).  Uses the #include .c
# approach to reach static jwt_parse_claims, so ../kc/kc_jwt.o must NOT
# be linked (duplicate symbols).  kc_http_sync.o satisfies the JWKS
# fetch reference, which no test actually calls.
KC_JWT_CMOCKA_OBJS = kc_jwt_cmocka.o ../kc/kc_base64.o ../kc/kc_http_sync.o
kc_jwt_cmocka: $(KC_JWT_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(KC_JWT_CMOCKA_OBJS) $(CMOCKA_LIBS) $(JANSSON_LIBS) $(CURL_LIBS) $(SSL_LIBS)
```

- [ ] **Step 3: Build and run**

```bash
cd /home/ibutsu/testnet/nefarious
(cd ircd/test && make kc_jwt_cmocka && ./kc_jwt_cmocka)
```

Expected: 7 tests, all PASSED. If the link fails with duplicate `kc_jwt_*` symbols, `../kc/kc_jwt.o` crept into `KC_JWT_CMOCKA_OBJS` — remove it.

- [ ] **Step 4: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/test/kc_jwt_cmocka.c ircd/test/Makefile.in
git commit -m "test: cmocka coverage for JWT claim policy (F-K3 exp/nbf)

The exp-required and nbf-enforced logic shipped in d236906 with no test.
Reaches static jwt_parse_claims via the #include .c pattern already used
by ircd_cloaking_cmocka and crule_cmocka — no network, no JWKS.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full-stack gate and parent-repo pointer bump

**Files:**
- Modify: `/home/ibutsu/testnet` (submodule pointer for `nefarious`)

**Interfaces:**
- Consumes: everything above.
- Produces: the merged state, verified end-to-end.

- [ ] **Step 1: Rebuild both ircd images**

`build nefarious` does not rebuild `nefarious2`; cross-server tests need both.

```bash
cd /home/ibutsu/testnet
scripts/dc.sh --profile linked build nefarious nefarious2 2>&1 | tail -20
scripts/dc.sh --profile linked up -d
```

**Corrected during execution (Task 3 review):** `-l` does *not* activate the `linked` compose profile — `dc.sh` sets `LINKED=1` and never reads it, before or after Task 3. `nefarious2`..`nefarious7` are profile-gated in `docker-compose.yml`, so `--profile linked` must be passed explicitly. CLAUDE.md's "Linked (adds nefarious2): `scripts/dc.sh -l up -d`" is inaccurate for the same reason; fixing `dc.sh` or the doc is a behavior change and stays out of Phase 1.

- [ ] **Step 2: Confirm the in-image cmocka gate ran all four new suites**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh --profile linked build nefarious 2>&1 | grep -E 'kc_(url|base64|cache|jwt)_cmocka'
```

Expected: each of the four appears with passing output. If they are absent, they were not added to `CMOCKA_TESTPROGS` and the Docker gate silently skipped them.

- [ ] **Step 3: Run the SASL/Keycloak integration tests**

These are the real gate — the unit tests do not touch the HTTP path.

```bash
cd /home/ibutsu/testnet
IRC_HOST=localhost npm test -- src/sasl 2>&1 | tail -30
```

Expected: same pass/fail set as before the merge. Compare against a pre-merge run if you have one; if any SASL test newly fails, the vendoring changed behavior and Task 1's "verbatim" claim is violated — bisect the include rewrite before anything else.

- [ ] **Step 4: Commit the parent-repo pointer**

```bash
cd /home/ibutsu/testnet
git add nefarious
git commit -m "nefarious: bump to vendored-libkc build (Phase 1 of the merge)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Mark Phase 1 done in the spec**

In `.claude/para/projects/libkc-ircd-merge.md`, add under the Phase 1 heading: `**STATUS: COMPLETE <date> (<nefarious sha>).**` Leave Phase 2 untouched — it starts next.

---

## Deferred to Phase 2 (do not do here)

Both tracks are specified in `.claude/para/projects/libkc-ircd-merge.md` §Phase 2 and start immediately after Task 9:

- **2.1** — the synchronous JWKS fetch in `kc_jwt_validate_local` that stalls the event loop on the SASL path.
- **2.2** — the seven `kc_http.c` defects.

Two Phase-1 items also depend on Phase 2 landing first, and must not be attempted here:

- `kc_jwt_validate_local` has no unit coverage; it cannot get any until 2.1 introduces a seam between claim validation and the JWKS fetch. Task 8 covers `jwt_parse_claims` only.
- `kc_http.c` has no unit coverage; the singleton `g_multi`/`g_ops` state makes it untestable without a context handle. Out of scope — the spec explicitly declined a context-handle refactor.

## Remaining repo action

**DONE (verified in the Phase 1 final review, 2026-07-27):** `evilnet/libkc` `main` is now `d236906`, so `fbb13dd` (F-K1/F-K2) and `d236906` (F-K3) are both in the archived history. Original note: ~~Before `evilnet/libkc` is archived, `fbb13dd` (F-K1/F-K2) and `d236906` (F-K3) must be pushed so the archived history is not missing its own security fixes.~~ `git push origin fork-hardening:main` from the libkc checkout is a clean fast-forward (origin/main is 0 behind). Archiving the repo remains a GitHub-side action for the user.
