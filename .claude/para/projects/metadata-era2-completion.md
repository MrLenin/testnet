# Metadata subsystem — era-2 completion + mesh convergence (design spec)

> Approved 2026-07-24 (fresh-eyes audit → two-tier model, "approach 1"). Branch: `crdt-mesh`
> (nefarious-crdt), with the era-2 correctness subset kept cherry-pickable for the prod fork.
> Grounding: full-subsystem audits at `.claude/para/resources/metadata-audit-storage-2026-07-24.md`
> and `metadata-audit-wire-2026-07-24.md` (every claim file:line). Related findings:
> `crdt-mesh-clocktest-findings.md` (F1-F5), F2-b spec `crdt-mesh-tier-c-f2.md`.

## Background (why)

draft/metadata-2 is a half-finished migration across three eras: ERA1 (Keycloak/X3-authoritative,
per-node MDQ pull-cache — abandoned), ERA2 (ircd-authoritative RocksDB `metadata_cf` — cutover
e16c222 2026-01-26, incomplete), F2B (CRDT-doc convergence of permanent account metadata —
81f70b4). Audit-confirmed state:

- **User netburst broken since birth** (ca033ea): `s_serv.c:548` targets by numnick, `ms_metadata`
  resolves by nick (`m_metadata.c:1529`) → every bursted user row silently dropped. The F2-b doc is
  therefore the ONLY working late-link backfill for user metadata today.
- **Channel metadata has no coherent persistence**: origin never writes the store
  (`metadata_channel_persist` dead), remotes cache TTL-stamped rows (4h) nobody reloads
  (`metadata_channel_load` dead), a GET can resurrect a stale remote cache row. Channel burst
  (inline `channel.c:1643`) is the only thing that works.
- **Visibility is not persisted for users** and the three restore paths disagree (list→PUBLIC
  `metadata.c:759`, get-promotion→PRIVATE `:1245`, cmd-fallback→PUBLIC-and-serves) → "private"
  leaks public after restart (clocktest F3).
- **GET is a hidden write path**: `m_metadata.c:503` promotion re-persists whatever it reads as
  permanent AND doc-mirrors it (can upgrade a 4h TTL row into permanent mesh state).
- **Doc reconcile is store-only** (`crdt_shadow.c:2311-2410`): never touches live `cli_metadata`,
  never notifies subscribers. Masked by the redundant P10 MD broadcast; becomes the M8-staleness
  class for values AND deletes once MR-5 retires the tree. **This spec's §A1 gates MR-6.**
- **Oper `SET *account` (offline)** writes a local TTL row, no S2S, no doc → silently decays in 4h.
- **ERA1 husks**: MDQ responder (dead protocol — X3 has NO MD/MDQ code at all; zero senders
  ecosystem-wide), Z compressed passthrough (originator-less; its private variant stores
  unreadable `P:`+zstd blobs), ~9 dead functions, `FEAT_METADATA_CACHE_SLOTS` (0 reads),
  `FEAT_METADATA_CACHE_ENABLED` (only gates the purge timer), stale FEATURE_FLAGS_CONFIG.md
  sections describing deleted X3 machinery.
- `AC U` metadata wipe verified correct: X3 emits it ONLY from `nickserv_unregister_handle`
  (account deletion; X3 has no LOGOUT). Keep.

## Target model (the design)

Rule: **the doc is the authority for shared persistent state; the store is each node's
materialization of the doc; memory is a session cache kept coherent by reconcile.** Everything
else is ephemeral: memory-only + live S2S, no store, no doc.

| Tier | What | Store | Doc | Memory |
|---|---|---|---|---|
| Persistent | account (permanent) metadata | per-node materialization | authoritative (F2B, completed by §A) | cache, reconciled + notified |
| Persistent | **+R channel** metadata | per-node materialization (NEW) | authoritative (NEW, §B) | cache, reconciled + notified |
| Ephemeral | unauthed-user metadata | never | never | only copy; S2S MD + fixed burst |
| Ephemeral | unregistered-channel metadata | **never** (remote TTL cache DELETED) | never | only copy; S2S MD + burst |
| Out of tier | TTL rows (`last_present`, legacy rows) | TTL-stamped, purge-swept | never | virtual keys |

P10 MD keeps its current roles (steady-state broadcast, burst, legacy/§17.7 gateway reach); the
doc adds overlay reach + restart durability + late-link backfill. Dual delivery stays idempotent
(existing suspend + echo guards).

---

## §A — Account tier completion

**A1. Reconcile materializes live memory + notifies (the MR-6 gate).**
New `metadata_apply_converged(const char *account, const char *key, const char *value, int visibility)`
in metadata.c: for every LOCAL online client whose `cli_account` matches, update the in-memory
`cli_metadata` entry DIRECTLY (create_entry/update/remove — **MUST NOT call `metadata_set_client`**,
which would re-write the store and re-enter the doc chokepoint), then fire subscriber notifies
(value or value-less). Expose `notify_subscribers` machinery via metadata.h as needed (it currently
lives static-ish in m_metadata.c:214). Callers: `reconcile_metadata_set_cb` (after the store heal,
when the store value actually changed) and the delete store-walk apply loop (value=NULL).
Also: add `crdt_shadow_reconcile_metadata()` to `crdt_shadow_materialize_live()` (closes the
up-to-30s post-CR-F latency; audit wire §4). Optional rider: add the markers reconcile there too
(same latency class, F2-a).

**A2. Visibility persistence — canonical row encoding.**
*(Refined 2026-07-24 from the P1 discovery pass — `metadata-p1-discovery-2026-07-24.md` in
para/resources; refinements are within the "pick at plan time" delegation.)*
Store row value encoding (innermost→outermost): `[vis prefix][raw value]` → `[TTL wrapper]` →
`[zstd]`. **ALWAYS-prefix for user-settable permanent rows**: `P:` private, `*:` public — never
bare — so every value round-trips byte-exact (a public value literally starting "P:" encodes as
`*:P:...`; the collision ambiguity exists only for legacy bare rows, where it already existed).
**Exempt classes stay BARE with rule-determined visibility**: server-managed keys
(`draft/persistence/*` per the `server_managed_prefixes` table) read as PRIVATE by rule, and
TTL rows (`last_present`, legacy caches) read as PUBLIC — this keeps old-peer INTERNAL
`metadata_account_get` consumers (bouncer hold gating, profiles) reading bare `1`/`0` values
unchanged, which is exactly the class a prefixed doc value would otherwise break on a
mixed-version mesh. Write side: `metadata_account_set/set_permanent` gain a visibility
parameter; static `set_ts` is the single encoder (parameter, NOT caller pre-prefixing — the
discovery's caller census shows 3/6 writers hold explicit vis, 2 fixed, 1 needs a split;
pre-prefixing would re-open the chokepoint-bypass fuse P0 closed). Read side:
`metadata_account_get`/`metadata_account_list` decode and RETURN visibility (out-param /
entry->visibility) and always return the STRIPPED value — internal consumers unchanged; all
three memory-restore paths use the decoded value, no more hardcoded PUBLIC/PRIVATE guesses.
Doc value = the same vis-prefixed buffer captured pre-TTL (so visibility round-trips the mesh);
the reconcile echo-guard must compare vis-aware (split docval vs get+vis), else every private
row re-writes each tick. Mixed-version compat: old bare doc/store values decode as public;
old peers' GET fallback parses `P:` but shows `*:`-prefixed public values verbatim, and stale
peers reconciling prefixed user rows serve them prefixed — transient during lockstep bed
upgrades, absent on the doc-less prod cherry-pick; the server-managed exemption removes the
one behavioral class (bouncer hold). Legacy bare rows are NOT migrated — they read as public
(documented; anyone who cared already leaked).
This closes clocktest F3 (the offline-GET path already honors `P:` with owner/oper gating — it
just never had prefixed rows to find).

**A3. Promotion hygiene — reads stop writing.**
The `m_metadata.c:503-506` and `:549-553` GET-fallback promotions become memory-only inserts
(same direct-entry mechanism as A1) with visibility from the decoded row. The `metadata.c:1239`
promotion stays as-is minus the hardcoded PRIVATE (uses decoded vis). Result: no read path ever
writes the store or mints doc ops; the TTL→permanent upgrade hole is closed.
**Eager load extends to all attach paths**: call `metadata_load_account` at every point an
account is attached to a client, not just the current 4 (m_account.c:254/395/459,
sasl_auth.c:622). Plan-time task: enumerate the account-stamp sites (pre-reg SASL success, IAuth
account assignment, WEBIRC, bouncer-ghost/mesh materialization, MODE +r if applicable) and hook
the common chokepoint if one exists. LIST/WHOIS/self-burst then work post-restart without
per-key GETs; the lazy promotions become pure backstops.

**A4. Oper `METADATA SET *account` becomes a real write.**
Offline branch (`m_metadata.c:783`): write PERMANENT (with vis per A2) instead of TTL → the doc
chokepoint converges it mesh-wide; other nodes materialize via §A1. No S2S MD emission for the
offline case even after this change (an offline account has no `FindUser`-resolvable target;
ms_metadata would drop it — audit wire §2). On legacy-only topologies (prod cherry-pick, no doc)
the write is therefore node-local: documented limitation, unchanged from today except it no
longer evaporates in 4h. Online branch unchanged (already permanent + broadcast).

**A5. `AC U` wipe: unchanged** (unregister-only, verified). The prefix-wide clear taking
`draft/persistence/*` with it is correct — the account no longer exists.

**A6. Private-change notifies (spec alignment, rider on A1's notify work).**
draft/metadata-2 notifies the target's own sessions for private changes; today private changes
notify nobody (`m_metadata.c:866-868`, `:1640-1643`). Make notify vis-aware: public → current
behavior; private → deliver only to subscribed sessions of the target account/user itself.

## §B — Channel tier (+R = persistent)

**B1. Persistence at the set-chokepoint.** `metadata_set_channel` gains a store write IFF the
channel has `MODE_REGISTERED` (+R, services/server-set only): `metadata_account_set_permanent`
with vis prefix per A2 (store key `#chan\0key`, exactly the existing remote-cache key shape).
Not +R → memory only (unchanged). Deletes likewise (NULL → store delete when +R). Note this
runs on RELAYED applies too (`ms_metadata` → `metadata_set_channel` under suspend): every node
persists +R rows into its OWN store (its materialization) while only the origin mints doc ops —
the suspend guard already provides exactly this split.

**B2. Doc convergence.** `metadata_doc_key` (`crdt_shadow.c:2233`) drops the `IsChannelName`
exclusion — channel keys enter the SAME `CRDT_COLL_METADATA` collection as opaque
`#chan\0key` storage keys (the F2-a/F2-b opaque-key rule; zero engine work, generic LWW path,
version-tolerant: an old peer's reconcile just writes the store row and never materializes
memory — harmless). Single-writer discipline: B1's write happens on the server where the SET
command runs (the origin); `ms_metadata`'s existing suspend covers relayed applies. The
`metadata_account_set_ts` chokepoint mints the ops — no new mirror site.

**B3. ±R transition hooks** (in the mode-apply path where `MODE_REGISTERED` lands, server/services
origin only). **Single-writer trap**: mode_parse applies ±R on EVERY node, so the hook fires
everywhere — without a gate, N nodes would mint N identical doc-op sets (benign under LWW per
invariant 5, but churn + discipline violation). Rule: the hook's LOCAL store work runs on every
node (each node materializes its own store); the DOC mint runs only where the mode change entered
the network (`MyConnect(sptr)` services link or local OPMODE) — elsewhere the hook wraps its
store writes in `crdt_shadow_metadata_suspend`, same split as B1.
- **+R set**: persist-memory-first — walk `chptr->metadata`, `metadata_account_set_permanent`
  each (→ doc only at the entry node, per the rule above); then load store keys NOT in memory
  into memory (covers a restart where +R arrives in burst after the doc/store already has rows;
  at burst time memory is empty so only the load half does work). This wires
  `metadata_channel_load`'s job; adapt or replace that dead function (its sibling
  `metadata_channel_persist` is superseded by B1 — delete it).
- **-R set (unregister)**: channel analog of AC U — every node wipes its own `#chan\0*` store
  rows; per-key doc tombstones minted only at the entry node (reuse the `metadata_account_clear`
  + `crdt_shadow_metadata_remove_key` pattern with the channel name in the account slot; suspend
  elsewhere). Memory is cleared too, locally on every node, with unset notifies — completing the
  AC U analogy (AC U clears live client memory). **AMENDED 2026-07-25 (P2/T4 review):** the
  original "memory stays" wording was wrong twice over: the delete-reconcile keys off store-row
  presence, and the -R hook has already wiped each node's own rows, so retained memory was never
  reaped (node-divergent LIST) and a later +R on the same node would re-persist the retained
  entries over the tombstones (resurrection). Doc tombstones from the entry node remain the mesh
  backstop for nodes that missed the mode.

**B4. Materialization.** `metadata_apply_converged` (A1) grows a channel branch: if
`FindChannel(#chan)` → update `chptr->metadata` directly + notify subscribers; channel absent →
store-only (memory materializes on +R per B3, or lazily via the read-only GET fallback). The
delete store-walk reaps channel rows identically (opaque keys — it already would once B2 lands;
the channel branch of apply_converged handles the memory half).

**B5. Delete the remote TTL channel cache + resurrection path.** `ms_metadata`'s separate channel
store-cache block (`m_metadata.c:1602-1636`) is REMOVED — the store write for +R channels now
happens inside `metadata_set_channel` itself (B1, permanent, correct visibility), and
unregistered channels get no store row at all. With the cache block go the Z-path store writes
and `metadata_account_set_raw` (§D). The GET channel store-fallback (`:515-556`) remains
(post-B1 it finds only legit +R rows) but becomes read-only per A3. Pre-existing TTL cache rows
age out via the purge sweep (they're TTL-stamped; no migration needed). CLEAR's known
channel-store-row residue (fdf93a5 block comment) is resolved for +R channels because the S2S
per-key unset now reaches the store through `metadata_set_channel`'s delete branch (B1), with
the doc tombstone reap (B4) as the backstop for nodes the unset missed; for unregistered
channels there are no store rows left to leak.

**B6. Burst unchanged.** Channel MD burst (`channel.c:1643-1653`) keeps serving tree/legacy
peers; CR F carries the doc (now including channels) for CRDT peers.

## §C — Ephemeral tier

**C1. Fix the user burst target**: `s_serv.c:548` `%C` (numnick) → `%s` + `cli_name(acptr)` —
one-token fix, matches every other bursted per-user extension (e.g. CMD_MARK `s_serv.c:505`).
Serves legacy IRCv3-aware peers and cold-boot links; between doc-ready CRDT peers the CR F
cutover (`s_serv.c:367-381`) bypasses the P10 N-burst loop entirely, so there the doc remains
the backfill and this fix is inert.
**C2.** Unauthed-user metadata otherwise unchanged (memory-only, dies at disconnect).
**C3.** Unregistered-channel metadata: memory + S2S + burst only (B5 removed the store leak).

## §D — Retirements & repairs (era-1/2 debris)

Delete (with parse.c/msg.h/header/decl cleanup where applicable):
- MDQ: `ms_metadataquery` + msgtab entry + `MSG/TOK/CMD_METADATAQUERY` (zero senders in
  nefarious-crdt, prod fork, and X3; its answers are unparseable by its own sibling anyway).
- Z compressed passthrough: parse/decode/store/relay branches in `ms_metadata`
  (`m_metadata.c:1496-1499, 1513-1520, 1538-1558, 1608-1622, 1649-1652`), `base64_decode`
  (`:79-102`), `metadata_account_set_raw` (`metadata.c:511-538`) — no originator exists;
  removing it also closes the chokepoint-bypass fuse (audit wire surprise 7).
- Dead functions: `metadata_get_client_cached`, `metadata_channel_persist`, burst stubs
  `metadata_burst_client/channel`, `metadata_defrag`, `metadata_valid_key`, `parse_visibility`,
  `METADATA_MAX_KEYS`/`METADATA_MAX_SUBS` macros (`metadata.h:40,43`). (`metadata_channel_load`
  is revived-or-replaced by B3, not deleted blindly.)
- Flags: remove `FEAT_METADATA_CACHE_SLOTS` (0 reads). Remove `FEAT_METADATA_CACHE_ENABLED` and
  run the purge timer unconditionally (TTL rows still exist: `last_present`, aging legacy rows) —
  its name has lied since e16c222. Keep `CACHE_TTL` + `PURGE_FREQUENCY` (they govern the real TTL
  tier). Keep `METADATA_BURST`.
- Wire `metadata_lmdb_shutdown` into the server exit path (env currently never closed; today via
  the dead `metadata_init/shutdown` pair — either revive `metadata_shutdown` with a real caller
  or call the lmdb shutdown directly; delete whichever husk remains).
- Comment/doc truth: fix stale ERA1 comments (`m_metadata.c:368-374` MDQ flow, `metadata.h:364/380`,
  `server_managed_prefixes` comment drift `metadata.h:269-276` vs table `metadata.c:1446`),
  rewrite FEATURE_FLAGS_CONFIG.md metadata + MDQ sections to this spec's model. Optional cosmetic
  (`metadata_lmdb_*` → `metadata_db_*` rename) is NOT in scope.

## Known deferrals discovered in flight

- **`+ir account:ts` umode-mirror gap (found P1/T3, 2026-07-24):** in `set_user_mode` the
  umode→metadata mirror (`metadata_set_client("umode.*",…)`) fires inside the mode-char loop,
  but the `+r` account-field stamp happens in a post-loop block — so on any combined
  `+r`+mirrored-flag event (the normal burst shape) the mirror write sees an empty account:
  memory-only, never persisted, never doc-mirrored; the A3 eager load then replaces it with
  the (possibly stale) store copy in the same event. The umode FLAGS themselves are unaffected
  (set unconditionally); blast radius = the `umode.*` metadata VIEW for remote burst intros,
  self-healing on the next flag toggle. Root cause is the loop/post-loop split — fix is a
  set_user_mode reorder, deliberately NOT done inside P1. **Binding consequence for A1/§A
  reconcile (encoded in P1/T4): the doc can lag true flag state for `umode.*` right after
  burst, so `metadata_apply_converged` must NOT drive umode flag-sync from doc values —
  memory + notify only.**
- **`account_conn.c` is dead code** (not in IRCD_SRC; found P1/T1): the audits' "last_present
  TTL store write" path is inert — last_present is served virtually from bouncer state. With
  the ms_metadata channel cache dying in P2/B5 and oper offline SET now permanent (A4), the
  TTL row machinery (`CACHE_TTL`, purge sweep) may have zero live writers left → candidate
  for retirement in P2/P3, and `account_conn.c` itself for removal.
  **RESOLVED BY P3 SURVEY (2026-07-25, exhaustive c-auditor sweep of all 14 real call sites):
  ZERO live TTL writers** — every reachable non-NULL write is `metadata_account_set_permanent`
  (ts=0); the sole true TTL writer (`account_conn.c:465`) is dead code; all `metadata_account_set`
  survivors are NULL-value deletes (TTL bypassed). The doc-mirror's `!permanent` gate
  independently guarantees no TTL row can ever converge. DECISION: **keep `CACHE_TTL` + the purge
  sweep as a LEGACY-AGER** (the only path that physically reclaims pre-era-2 rows; read-time
  expiry just masks them) — re-commented in code (`metadata_account_purge_expired` header +
  ircd.c callback) so nobody reintroduces a TTL writer thinking it's load-bearing. Full
  retirement = a one-time on-disk migration pass, separate follow-on if ever wanted;
  `account_conn.c` file removal folds into the prod cherry-pick housekeeping.
- **GET existence-leak on denied private keys (found P1/T7 live + final review):** in
  `metadata_cmd_get` a private key the viewer can't see does `continue` (no reply), while a
  truly-absent key returns 766 RPL_KEYNOTSET — so a non-owner can distinguish "exists-but-
  private" (silence) from "absent" (766). VALUE never leaks (that's the A2 guarantee, tested);
  only key EXISTENCE leaks. Pre-existing control flow, now reachable because P1 made private
  rows persist. One-line fix (emit 766 on the denied path so denied == absent) — a GET-reply
  hardening fast-follow, not a P1 regression.
- **Private-notify wire token (found P1 final review):** `metadata_notify_subscribers`
  hardcodes the `*` visibility field even for a PRIVATE change. Delivery scoping is correct
  (owner-only — no leak), but the token is inconsistent with GET's `private` rendering. Cosmetic;
  align or document `*` as the intentional placeholder.
- **CLEAR per-key S2S unset carries no vis token (pre-existing):** the legacy P10 MD unset
  broadcast from CLEAR defaults remote nodes to PUBLIC-shaped notify. Value-less (no leak); the
  DOC tombstone-reap path already scopes correctly (reads oldvis before reaping), so post-MR-5
  the doc path is fine — only the legacy broadcast lacks the token.

## Non-goals (documented deferrals)

- `last_present` / network-wide presence: separate MAX-register track (user decision, F2-b spec).
- `SYNC` "later" semantics (774 then nothing) — unchanged.
- `ms_metadata` unknown-target relay-drop on legacy chains — superseded by the doc on mesh;
  legacy topologies keep today's behavior.
- Multi-identity/profile-keyed metadata — off roadmap (`project_bouncer_profile_model`).
- No doc convergence for TTL rows or unauthed users (by definition of the tiers).

## Testing

- **cmocka (TDD, gates the image)**: extend `test_metadata_op_replicates` with channel-shaped
  opaque keys (`#chan\0key` SET/LWW/DELETE/snapshot roundtrip). Engine surface is otherwise
  unchanged (same collection, generic LWW).
- **Live 5-node bed** (the F2-a/F2-b recipe): (1) +R channel SET on hub → overlay-only leaf
  materializes store+memory, GET/LIST correct; (2) full-bed restart → +R channel metadata
  survives (doc→store→+R-load→memory), unregistered channel metadata gone; (3) -R → rows +
  doc entries reaped mesh-wide AND live memory cleared with unset notifies on every node (LIST
  empty everywhere; re-+R must NOT resurrect the cleared keys); (4) visibility: private user key survives restart private, LIST
  shows it only to owner (F3 regression test — extend `tests/clocktest/s5c_restore.py`);
  (5) user-burst fix (C1): NOT live-observable between doc-ready CRDT peers (CR F cutover skips
  the N-burst loop) — P0 validates by inspection + build/cmocka; e2e proof lands with the
  prod-fork cherry-pick on the 2-server legacy-burst bed (documented deferral);
  (6) doc-only staleness: tree-cut leaf receives SET + CLEAR via doc, online
  client's GET reflects both WITHOUT reattach (A1 regression — the M8-doc-edition guard);
  (7) oper offline `SET *account` survives >TTL and appears on another node.
- Vitest: visibility-restart + LIST-after-reconnect client-visible checks where the harness
  reaches them (`tests/src/ircv3/`).

## Phasing (implementation order)

- **P0 — shrink the surface**: §D retirements + §C1 burst token fix. No behavior redesign;
  every deletion is auditable dead code. Docker + cmocka gate. **DONE 2026-07-24 (`236e1ff`).**
- **P1 — account tier**: A2 (encoding first — everything reads through it), A3, A1, A6, A4.
  Live-validate scenarios 4/6/7. **DONE 2026-07-24 (`f98b04d`).**
- **P2 — channel tier**: B1→B6. Live-validate scenarios 1/2/3. **DONE 2026-07-25 (`207a083`;
  + final-review CLEAR-on-+R fix; §B3 -R memory semantics amended above; GET existence-leak
  closed in-phase).**
- **P3 — docs**: FEATURE_FLAGS_CONFIG.md rewrite + skill/memory updates (this file tracks state).
  **DONE 2026-07-25** (FEATURE_FLAGS metadata/Z/last_present sections rewritten to this model;
  p10-protocol skill both copies + submodule CLAUDE.md MDQ-retirement annotations; roadmap
  addendum; TTL-writer retirement survey recorded below).
- Commit per phase (standing crdt-mesh OK); submodule push + testnet pointer per constraints in
  `crdt-mesh-tier-c-f2.md` §Constraints.

## Prod-fork cherry-pick subset (no doc dependencies)

C1 (burst fix), A2 (visibility encoding + unified restore), A3 (read-only promotions + eager
load), A4-local (permanent not TTL; still node-local), A6 (private notifies), all of §D except
doc-adjacent comments. §B channel persistence WITHOUT B2/B4-doc parts is possible (store+load on
+R) but weaker (no cross-node backfill) — decide at cherry-pick time, not now.
