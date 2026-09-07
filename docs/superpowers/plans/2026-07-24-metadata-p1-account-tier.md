# Metadata P1 — Account Tier Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P1 of `.claude/para/projects/metadata-era2-completion.md` §A — visibility persistence (A2), read-only promotions + eager load everywhere (A3), doc-reconcile materialization into live memory with subscriber notifies (A1, the MR-6 gate), vis-aware private notifies (A6), and oper offline `SET *account` made permanent (A4).

**Architecture:** All grounding is in two documents implementers' briefs cite: the spec §A (path above, incl. the 2026-07-24 A2 refinement) and the discovery report `.claude/para/resources/metadata-p1-discovery-2026-07-24.md` (every file:line below was verified there at `236e1ff`). Order is A2-write+read core → GET-path unification → eager load → reconcile materialization → notifies → oper SET, because everything downstream reads through the A2 encoding.

**Tech Stack:** C (ircu/Nefarious), RocksDB store layer, CRDT shadow (crdt_shadow.c), cmocka in-build gate, 5-node Docker CRDT bed + tests/clocktest python drivers.

## Global Constraints

- Tree: `/home/ibutsu/testnet/nefarious-crdt`, branch `crdt-mesh`, base `236e1ff`. Do NOT touch `/home/ibutsu/testnet/nefarious`.
- **Canonical row encoding (spec A2, refined):** innermost→outermost `[vis prefix][raw value]` → TTL wrapper → store zstd. ALWAYS-prefix user-settable permanent rows: `P:` private, `*:` public, never bare. EXEMPT (stay bare): server-managed keys (`metadata_key_is_server_managed`, table = `draft/persistence/`) → read as PRIVATE by rule; TTL-stamped rows (`last_present`, ms_metadata channel cache) → read as PUBLIC by rule. Legacy bare non-exempt rows decode as PUBLIC. Exactly ONE encoder (static `metadata_account_set_ts`) and the decoders in `metadata_account_get`/`_list` — no caller ever pre-prefixes or self-parses.
- **Signature contract (Task 1 produces, later tasks consume):**
  - `int metadata_account_set(const char *account, const char *key, const char *value, int visibility)` and `int metadata_account_set_permanent(const char *account, const char *key, const char *value, int visibility)` — visibility is `METADATA_VIS_PUBLIC`/`METADATA_VIS_PRIVATE` (existing enums); ignored when `value == NULL` (delete) and for exempt-class writes.
  - `metadata_account_get` KEEPS its current signature (returns stripped value); NEW `int metadata_account_get_vis(const char *account, const char *key, char *value, size_t value_len, int *visibility)` — `metadata_account_get` becomes a wrapper passing NULL. Internal consumers (bouncer/profile/account_conn) stay untouched by construction.
  - `metadata_account_list` keeps its signature; each returned `MetadataEntry->visibility` now carries the DECODED (or rule-determined) visibility instead of hardcoded PUBLIC.
  - Task 4 produces `void metadata_apply_converged(const char *account, const char *key, const char *value, int visibility)` (value NULL = delete) in metadata.c — P2 later extends it with a channel branch; keep the user branch cleanly separable.
- **Doc value = the vis-prefixed buffer** captured pre-TTL: build `[vis]value` once in `set_ts` before `encode_ttl_value` (metadata.c:447) and pass that same buffer to `crdt_shadow_metadata_set` (metadata.c:482). Exempt-class writes mirror bare (server-managed rows are doc-converged BARE — old-peer bouncer readers depend on it).
- **The reconcile echo-guard must become vis-aware** (crdt_shadow.c:2331-2334): compare split-docval (prefix→vis+raw) against `metadata_account_get_vis` output. Unfixed, every private row re-writes each 30s tick.
- The F2-b single-writer gates (`g_metadata_reconciling`, `g_metadata_remote_applying`, suspend bracketing in ms_metadata) must remain airtight — no new store write may re-enter the doc mirror during reconcile/remote-apply.
- `metadata_load_account` REPLACES `cli_metadata` wholesale (idempotent; doubles are wasted iteration only). Extending it to new attach flows extends "login replaces pre-login memory-only metadata" to those flows — spec-consistent; say it in the Task 3 commit body.
- Host build: `LIBRARY_PATH=$HOME/.local/lib make -C ircd ircd CPPFLAGS="-I. -I.. -I../include -I$HOME/.local/include"` → fresh `ircd/ircd`, zero new warnings. cmocka: `make -C ircd/test crdt_cmocka && ./ircd/test/crdt_cmocka` → all PASSED. Docker (`scripts/dc.sh`) is the canonical gate; freshness = the `ircd.YYYYMMDDHHMM` symlink advances.
- No cmocka suite links metadata.o/m_metadata.o (pre-existing); behavior gates are the Task 7 live scenarios (per `feedback_no_silent_defer`, this is the documented test strategy).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. One commit per task, subjects prefixed `P1:`.

---

### Task 1: A2 core — visibility parameter, always-prefix encode, decode with out-param

**Files:**
- Modify: `ircd/metadata.c` (set_ts :419-486, set :490, set_permanent :498, get :339-408, list :637-731), `include/metadata.h` (decls)
- Modify (call-site threading): `ircd/metadata.c:1239,:1253` (metadata_set_client persist/delete — passes its existing `visibility` param through), `ircd/m_metadata.c:738` (oper `*account` — passes the parsed vis; still TTL `metadata_account_set` until Task 6), `ircd/m_metadata.c:1371-1376` (ms_metadata channel cache — DROP its hand-rolled `"P:%s"` pre-prefixing :1371-1372, pass the wire vis as the param; the write stays TTL/exempt-class so `set_ts` stores it bare — channel-row vis is rule-PUBLIC… EXCEPT this cache historically encoded private; since the whole block dies in P2/B5 and its GET fallback consumer is rewritten in Task 2 to rule-decode, store it bare and have the channel GET fallback treat TTL channel rows as PUBLIC unless the wire vis was P — simplest: pass the vis param, and in set_ts let TTL-class rows with explicit PRIVATE vis keep the `P:` prefix (TTL rows: prefix only when PRIVATE, bare = public — preserves today's channel-cache read behavior exactly)), `ircd/account_conn.c:465` (last_present → `METADATA_VIS_PUBLIC`), `ircd/persistence_profile.c:234,:383,:405` (values → `METADATA_VIS_PRIVATE`; server-managed keys are exempt anyway so the param is documentary), delete-only sites `:235,:322,:414` + `ircd/crdt_shadow.c:2395` (pass `METADATA_VIS_PUBLIC`, ignored), `ircd/crdt_shadow.c:2335` (reconcile — TEMPORARY shim this task: pass the docval through with `METADATA_VIS_PUBLIC` and a `/* Task 4 splits the prefixed docval */` note; Task 4 finishes it)

**Interfaces:** produces the signature contract in Global Constraints. Encoding rules land wholly inside `set_ts`; decode wholly inside `get_vis`(+wrapper)/`list`.

- [ ] **Step 1:** In `set_ts`: after the existing validity checks and before `encode_ttl_value` (:447), build the stored form per the constraint block: non-exempt permanent (`timestamp==0` && !server-managed) → always `P:`/`*:` prefix; TTL-class (`timestamp!=0`) → prefix ONLY when `visibility==METADATA_VIS_PRIVATE`; server-managed keys → always bare. Pass the SAME buffer to `encode_ttl_value` and to the `crdt_shadow_metadata_set` mirror (:482). Thread `int visibility` through `metadata_account_set`/`_permanent` into `set_ts`.
- [ ] **Step 2:** Add `metadata_account_get_vis` (decode order: decompress → TTL-decode/expiry → vis-prefix strip per class rules: server-managed → PRIVATE + bare; `P:`→PRIVATE, `*:`→PUBLIC, bare→PUBLIC); make `metadata_account_get` = `get_vis(..., NULL)`. In `list` (:637-731): apply the same class rules per row into `entry->visibility` (replacing the hardcoded PUBLIC at :724) and store the STRIPPED value in the entry.
- [ ] **Step 3:** Update every call site listed in Files. Verify sweep: `grep -rn "metadata_account_set\b\|metadata_account_set_permanent\b" ircd/ include/` — every hit is 4-arg; `grep -n "\"P:\"\|P:%s" ircd/m_metadata.c ircd/metadata.c` — zero hand-rolled encode sites remain outside `set_ts`.
- [ ] **Step 4:** Host build + cmocka green; zero new warnings.
- [ ] **Step 5:** Commit: `P1: metadata store rows carry visibility (always-prefix P:/*:; server-managed+TTL classes bare-by-rule); single encoder in set_ts` (+ trailer).

### Task 2: Read-side unification + promotion hygiene (reads stop writing)

**Files:**
- Modify: `ircd/m_metadata.c` GET user store-fallback (:447-471) and channel store-fallback (:491-518); `ircd/metadata.c` lazy fill in `metadata_get_client` (:1147-1160)
- Modify (comment riders): `ircd/persistence_profile.c:261-262,:365-366,:461-462` (stale "list returns raw TTL-encoded values" claims — list has decoded since fdf93a5; simplify or fix the re-get dance comments), `ircd/metadata.c:1400-1404` (`metadata_load_account` doc comment — Task 3 rewrites caller list; here just drop falsehoods you touch)

**Interfaces:** consumes `metadata_account_get_vis`. Promotions become MEMORY-ONLY inserts (create_entry-style, correct vis) — they MUST NOT call `metadata_set_client` (which re-persists + doc-mirrors; that is the exact hole being closed).

- [ ] **Step 1:** User GET fallback: replace the local `P:` parsing (:447-450) with `get_vis`; keep the owner/oper gating exactly (now driven by the returned vis); replace the `metadata_set_client` promotion (:470-471) with a direct in-memory entry insert carrying the decoded vis. Channel fallback likewise (:491-518; promotion :517-518 already memory-only via `metadata_set_channel` — but route its vis from `get_vis` instead of the local parse).
- [ ] **Step 2:** Lazy fill in `metadata_get_client`: use the decoded vis (drop hardcoded `METADATA_VIS_PRIVATE` at :1156) via `get_vis`.
- [ ] **Step 3:** Verify: `grep -n "metadata_set_client" ircd/m_metadata.c` → only the SET command path and ms_metadata apply remain (no GET-path callers). Host build + cmocka green.
- [ ] **Step 4:** Commit: `P1: GET paths stop writing (memory-only promotions, decoded visibility everywhere; TTL->permanent upgrade hole closed)` (+ trailer).

### Task 3: A3 — eager load at every account attach

**Files:**
- Modify: `ircd/s_user.c` (`register_user` :391 — the chokepoint hook; and the umode `+r` stamp block :2528-2541), `ircd/m_register.c` (:416-419 post-reg branch), `ircd/crdt_shadow.c` (:3751-3757 `crdt_materialize_one_user`), `ircd/bouncer_session.c` (:3288-3338 `bounce_create_ghost`), `ircd/metadata.c` (:1143-1149 the load-bearing NOTE)

**Interfaces:** consumes `metadata_load_account(client)` (existing; replace-semantics per Global Constraints).

- [ ] **Step 1:** `register_user`: early in the function (after the require-sasl gate ~:426-430, before Count_ bookkeeping), add: if the client has a non-empty account, `metadata_load_account(sptr)`. This covers pre-reg SASL (s_auth.c:465), IAuth D-with-account (s_auth.c:2879), WEBIRC account (m_webirc.c:212), pre-reg REGISTER (funneled through auth_complete_sasl), and remote N-burst intros (set_nick_name stamps via set_user_mode s_user.c:1119 then register_user :1122). The account string is complete and ts-trimmed on every inbound path by that point (discovery Item 1B).
- [ ] **Step 2:** Per-site residues: (a) `m_register.c:417` post-reg REGISTER; (b) `s_user.c:2541` after the +r stamp, guarded `IsRegistered(acptr)` so remote intros don't double-load (they hit the register_user hook at :1122) — MUST sit AFTER the stamp (the local `account` var still carries `account:ts` before it, discovery flow 9); (c) `crdt_shadow.c:3755` mesh materialization (after the account copy, before/near SetUser :3757); (d) `bouncer_session.c` ghost restore — after SetAccount :3338 (init-order contract: metadata_lmdb_init at ircd.c:1343 precedes bounce_db_restore at ircd.c:1391; note the ghost-REVIVE trap in the commit: revive's temp client load does not transfer to the ghost, which is why the restore-time load is required).
- [ ] **Step 3:** Rewrite the NOTE at metadata.c:1143-1149: the lazy fill is now a BACKSTOP, not the primary path (list the chokepoint + residues). Bouncer aliases need no load (out of nick hash; resolution lands on the primary — discovery Item 1C).
- [ ] **Step 4:** Host build + cmocka green. Verify: `grep -rn "metadata_load_account" ircd/ | wc -l` → 4 (old) + 5 (new: register_user, m_register, s_user +r, crdt_shadow, bouncer_session) + definition/decl.
- [ ] **Step 5:** Commit: `P1: eager metadata load at every account attach (register_user chokepoint + 4 residues); lazy GET fill demoted to backstop` — body notes the replace-semantics extension (+ trailer).

### Task 4: A1 — reconcile materializes live memory + notifies (the MR-6 gate)

**Files:**
- Modify: `ircd/metadata.c` (new `metadata_apply_converged`), `include/metadata.h` (decl + extern for the notify hook), `ircd/m_metadata.c` (un-static/extern `notify_subscribers` under a metadata.h-declared name), `ircd/crdt_shadow.c` (`reconcile_metadata_set_cb` :2311-2337 incl. echo-guard :2331-2334 + the Task-1 shim; delete-walk apply loop :2382-2397; `crdt_shadow_materialize_live` — add `crdt_shadow_reconcile_metadata()` and, rider, the markers reconcile)

**Interfaces:** produces `metadata_apply_converged` (contract in Global Constraints). It updates in-memory entries DIRECTLY for every LOCAL client whose `cli_account` matches (walk LocalClientArray; multiple clients per account is normal — bouncer) and fires the subscriber notify — it must NOT call `metadata_set_client` (store re-write + doc re-entry) and must NOT run store writes at all (the store is already healed by the reconcile caller).

- [ ] **Step 1:** Implement `metadata_apply_converged` (user branch only; leave an explicit seam comment for P2's channel branch). Value: create/update the `cli_metadata` entry with the given vis; NULL: remove the entry. Then notify via the exposed notify hook (public values per current semantics; Task 5 refines private).
- [ ] **Step 2:** `reconcile_metadata_set_cb`: split docval prefix→(vis,raw) per the A2 class rules (server-managed → bare/PRIVATE), replace the Task-1 shim with `metadata_account_set_permanent(acct, key, raw, vis)`, fix the echo-guard to compare `get_vis` output (value AND vis) against the split docval. After a real store change, call `metadata_apply_converged(acct, key, raw, vis)`. Delete-walk apply loop: after `metadata_account_set(...,NULL,...)` reap, call `metadata_apply_converged(acct, key, NULL, 0)`.
- [ ] **Step 3:** Add `crdt_shadow_reconcile_metadata()` to `crdt_shadow_materialize_live()` (closes the up-to-30s post-CR-F latency); rider: add the markers reconcile there too if absent (same latency class, F2-a).
- [ ] **Step 4:** Re-entrancy audit (write it in the report): apply_converged touches memory+notify only → cannot re-enter set_ts/doc; the whole reconcile pass stays under `g_metadata_reconciling`. Host build + cmocka green.
- [ ] **Step 5:** Commit: `P1: doc reconcile materializes live cli_metadata + fires subscriber notifies; vis-aware echo guard; reconcile in materialize_live (MR-6 gate)` (+ trailer).

### Task 5: A6 — vis-aware notifies (private → owner sessions only)

**Files:**
- Modify: `ircd/m_metadata.c` (`notify_subscribers` ~:214-260 + its call sites: local SET :866-868-era site, ms_metadata apply :1640-1643-era site, and the Task-4 converged path)

**Interfaces:** consumes the exposed notify hook; changes its semantics: PUBLIC → current behavior (subscribed local clients passing the share-a-channel/self scoping); PRIVATE → deliver ONLY to subscribed sessions of the target user/account itself (today private changes notify nobody — spec divergence).

- [ ] **Step 1:** Thread visibility into the notify (parameter or entry lookup — match the existing call shape) and implement the private branch. Value-less unsets notify with no value param (existing form).
- [ ] **Step 2:** Host build + cmocka green. Commit: `P1: private metadata changes notify the owner's subscribed sessions (draft/metadata-2 alignment)` (+ trailer).

### Task 6: A4 — oper `SET *account` (offline) becomes a real permanent write

**Files:**
- Modify: `ircd/m_metadata.c` (the oper `*account` offline branch, `metadata_account_set` call at :738-era)

**Interfaces:** consumes Task 1's 4-arg `metadata_account_set_permanent`.

- [ ] **Step 1:** Offline branch: `metadata_account_set(...)` (TTL) → `metadata_account_set_permanent(account, key, value, parsed_vis)`; deletes likewise permanent-path. The doc chokepoint now converges it mesh-wide; other nodes materialize via Task 4. No S2S MD emission (offline target unresolvable by receivers — unchanged); on doc-less topologies the write is node-local (documented limitation, spec A4).
- [ ] **Step 2:** Update the branch's comment (it currently implies a temporary cache write). Host build + cmocka green. Commit: `P1: oper SET *account (offline) writes permanent + doc-converged (was 4h TTL, node-local, silently decaying)` (+ trailer).

### Task 7: Phase gate — Docker, live scenarios, publish

- [ ] **Step 1:** `scripts/dc.sh -l --profile multi build nefarious3 nefarious4 nefarious5 nefarious6 nefarious7` (in-build cmocka gates); `up -d` the five; freshness: all five `readlink /home/nefarious/bin/ircd` advance to one new stamp.
- [ ] **Step 2 (scenario 4 — F3 regression):** new driver `tests/clocktest/p1_vis.py`: authed client on nef3 SETs a PRIVATE key and a PUBLIC key → third-party GET sees only the public one → disconnect/reconnect/reauth → LIST shows both with correct vis (private restored PRIVATE — the F3 leak is dead) → third-party GET still denied the private one. PASS/FAIL verdict printed.
- [ ] **Step 3 (scenario 6 — doc-only staleness, the M8-doc-edition guard):** driver `tests/clocktest/p1_doconly.py` + netns sidecar (crdt-mesh skill recipe: `docker run --rm -d --net=container:nefarious4 --cap-add NET_ADMIN nicolaka/netshoot sleep 600`, then `iptables -I INPUT -s <nef3-ip> -p tcp --sport <tree-port> -j DROP` + `ss -K` the established tree connection — cut ONLY the nef3↔nef4 P10 tree link; the nef4↔nef5 overlay keeps the doc flowing): with an authed client online on nef4 and its key already GETted (memory-hydrated), SET a new value from nef3 → within ~35s the nef4 client's GET returns the NEW value and its subscribed session got a notify, WITHOUT reattach; then CLEAR from nef3 → nef4 GET → not-set. Restore the link (remove the DROP; kill sidecar) and confirm mesh reconverges (mdigest equality via oper probes).
- [ ] **Step 4 (scenario 7):** driver or inline probe: oper on nef3 `METADATA *<offline-account> SET key :val` → row propagates: GET on nef5 (offline-account store probe path) returns it; restart nef5 → still returns it (permanent, store-materialized). 
- [ ] **Step 5:** `s5c_restore.py` still PASS (no regression). Commit the two new drivers in the TESTNET repo (tests/clocktest, same family as the committed harness).
- [ ] **Step 6:** Publish: push `crdt-mesh`; testnet pointer commit staging ONLY `nefarious-crdt` (`nefarious-crdt: bump to <sha7> (metadata P1 — account-tier: visibility persistence, eager load, doc→memory+notify MR-6 gate)`); ledger `Metadata P1 PHASE COMPLETE (...)` in `.superpowers/sdd/progress.md`.

## Self-review notes (write time)

- Spec §A coverage: A1→T4, A2→T1+T2, A3→T3, A4→T6, A5 no-op (unchanged by design), A6→T5. Scenario 4/6/7 → T7 (scenario 5 was P0's C1, deferred to prod bed per spec).
- The T1 ms_metadata channel-cache decision (TTL rows: prefix only when PRIVATE) preserves today's channel GET-fallback behavior byte-for-byte while the block awaits P2/B5 deletion — no channel behavior change in P1.
- Type consistency: 4-arg set/set_permanent, get unchanged + get_vis, apply_converged(account,key,value,vis) — used identically in T1/T2/T4/T6.
- Placeholders: none; every step names exact functions and the discovery report carries the verified lines.
