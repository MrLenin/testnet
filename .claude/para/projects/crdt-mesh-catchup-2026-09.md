# crdt-mesh catch-up with ircv3.2-hardening — plan (2026-09-20)

Measured, not guessed: a dry-run `git merge --no-commit origin/ircv3.2-hardening`
into a detached worktree of `crdt-mesh` @ `8956de7` (left in place, conflicted,
at `scratchpad/wt-crdt-dry` for the resolver). Read this before touching either
branch; `crdt-mesh` skill and `crdt-mesh-roadmap.md` ("Where we are") stay the
truth for the CRDT side.

## Size

| | |
|---|---|
| merge base | `5c5b512` (2026-07-27; the last merge of hardening into crdt-mesh was `dbe0a83`) |
| fork commits since | 221 |
| crdt commits since | 266 (crdt-mesh last moved 2026-07-30, `8956de7`) |
| files changed on both sides | 65 |
| **auto-merged cleanly** | **151 files** |
| **conflicted** | **21 files, 66 hunks**, no delete/modify or rename cases |
| commits present on both sides under different hashes (cherry-picks) | 25 subjects |

The 25 cherry-picked pairs matter: their hunks conflict only because the two
copies sit on different bases; the resolution is "the same text once". They
cover most of the metadata era-2 work (P0–P3), the epoll timer clamp, the
metadata env close in `server_die`, the `m_rename` AC-R change, the cap-notify
implication, and the bouncer `hs_client` recovery.

## Conflicts, classified

Hunk counts from the dry run; "fork" = ircv3.2-hardening, "crdt" = crdt-mesh.

### A. Same change on both sides (take the text once) — low risk

| file | hunks | note |
|---|---|---|
| `ircd/engine_epoll.c` | 1 | timer clamp on both; crdt adds the DEBUGMODE clock offset next to it |
| `ircd/m_metadata.c` | 8 | era-2 P0–P3 on both (cherry-picked); the fork adds case-fold keys `4087e9b` and oper `*account` S2S `177caf7` on top |
| `ircd/metadata.c` | 6 | era-2 on both; fork adds folded store keys `80c93e2`/`af31cc3` and the presence-aggregation removal `7b15d40`; crdt adds the dual-plane hold/`b` fix `d499f60` and doc-reconcile materialization |
| `include/metadata.h` | 4 | era-2 on both; crdt has the doc-reconcile declarations |
| `ircd/ircd.c` | 2 | metadata env close on both; fork adds `stop_listeners()` first (`7cae799`), presence boot heartbeat, webpush transport gating; crdt adds overlay liveness + clock offset. Union. |

Method: for each hunk, diff the two sides ignoring whitespace; where identical
keep one; where one side has extra lines, keep both.

### B. Union of additions in tables and enums — low risk, tedious

| file | hunks | note |
|---|---|---|
| `include/msg.h` | 1 | fork: SEARCH (`SH`), TOKEN, PN, RG/VF/RR removal, RLO; crdt: CR, overlay. Token letters must stay unique across both sets. |
| `ircd/parse.c` | 2 | fork: SEARCH, TOKEN, PN, tag namespaces; crdt: CRDT/CRDTMESH, MFLG_NOSHUN on CAP, beyond-horizon sources. Both tables merge additively. |
| `include/ircd_features.h` | 1 | fork: CAP_soju_search, PRESENCE_AGGREGATION removed, authtoken, webpush; crdt: CRDT_OVERLAY_PRIMARY, CRDT_BOUNCER_DOC, METADATA_CACHE removal (also cherry-picked to the fork). Enum order is not on the wire. |
| `ircd/test/Makefile.in` | 3 | both add cmocka suites; union of the lists. |

### C. One side dominant, re-apply the other's small change — low/medium

| file | hunks | dominant | re-apply |
|---|---|---|---|
| `ircd/m_webpush.c` | 2 | fork (+1768: payloads, attention, key ring, control-frame meter) | crdt Tier C F2-c subscription convergence over the mesh (`aaeb657`, 32 lines) |
| `ircd/m_register.c` | 1 | fork (+463: local Keycloak flow, throttle) | crdt eager metadata load at attach (`31a0401`, 6 lines) |
| `ircd/m_rename.c` | 3 | fork (+1887: relocate design D, GLINE_BADCHAN) | crdt `8956de7` is cherry-picked on both already — check the hunk is the pair |
| `ircd/m_server.c` | 2 | crdt (+212: overlay link parity, MR-5 tree retirement) | fork's RN routing by rename-capable flag (`9d9efdb`, 3 lines) |
| `ircd/s_serv.c` | 1 | crdt (+64: beacon burst, stub backfill, tree retirement) | fork's WP burst gate `70b7473`, WEBSOCKET mark `218c2f9`; the netburst-by-nick fix is a pair |

### D. Semantic, both sides changed the same logic — medium

| file | hunks | what collides |
|---|---|---|
| `ircd/bouncer_session.c` | 4 | fork: BX U `aw=`/`la=` replication, session-record lifetime `841f3ce`, echo-message gating, convergence chooser; crdt: doc mirror eager-mint, `bounce_destroy_owned`, CR-X alias echo, hs_client recovery (pair). Sites mostly differ; the 4 hunks are where both touched the same helpers. Resolve with the bouncer invariants list open (skill). |
| `ircd/channel.c` | 6 | fork: one-time-per-event stamps, presence hooks on add/remove, join_msgid zeroing, +L/+l; crdt: mesh anchor never `exit_client`ed, stub-source tolerance, ±R metadata hooks (pair). Keep fork's event/presence stamping *and* crdt's anchor guards. |
| `ircd/m_kick.c`, `ircd/m_tagmsg.c`, `ircd/m_account.c` | 3+2+1 | fork: HLC-stamped events, unconditional storage, one time per event, s2s tag override lifetime; crdt: KICK via CRDT (`a8e065f`), TAGMSG over CR-M/mesh unicast, ACCOUNT via CR-X tunnel. In each, the fork changed *how a row is stamped/stored*, crdt changed *how the command is routed*; both belong. |
| `ircd/s_user.c` | 3 | fork: retention ISUPPORT (`chathistory_update_retention_isupport`), away star per viewer, authtoken; crdt: mesh WHOIS, cloak gateway synth, user-mirror reconcile. Different functions mostly; the hunks are in `register_user` / 005 build. |

### E. The one to design before resolving — high risk

| file | hunks | what collides |
|---|---|---|
| `ircd/m_chathistory.c` | 10 | fork +2287/-437: presence-aware paging (row hook, boundary seeks), requester token on CH Q, partial/absence table, federation merge fixes, incarnation, SEARCH, retention widest-over-stores. crdt +487/-166: 5-5f B2 doc-aware federation dispatch + CR-X tunnel for mesh-only stores, B4 legacy-ward capability synth. **Both rewrote how a query fans out.** |

Do not resolve E hunk by hunk. Read `crdt-mesh-5-5f-chathistory-scope.md` and the
fork's `chathistory-presence-paging.md` / `chathistory-partial` notes first, then
decide the shape: the fork's `start_fed_query` (requester token, absence-driven
fan-out, `FedRequest` partial/cut flags) is the newer and tested one; crdt's B2
adds *where a responder is found* (doc collection + CR-X tunnel when the store is
mesh-only). The likely resolution is fork's request/merge logic with crdt's
responder discovery and transport substituted at the fan-out and reply-routing
points. Budget this as its own session with the bed's 5-node topology up.

## Order of work

1. **Prepare**: rebuild the CRDT 5-node bed images last known good (`crdt-mesh`
   @ `8956de7`, nefarious3–7) and run the crdt live gates (p2_chreg, p2_restart,
   leafauth, `/CRDT status` stub count) so the baseline is green before the merge.
   Note the cmocka gate: 368 tests, Docker-gated, must stay green.
2. **Merge in the dry-run worktree**, classes A → B → C → D, committing nothing
   until E is done; keep a running list of every hunk where a fork behaviour was
   re-applied by hand (those are the ones to re-test).
3. **Class E** as its own session (see above).
4. **Build + cmocka** in Docker; then the fork's testnet suites that touch merged
   files, on the CRDT bed: chathistory (presence paging, strict presence, partial,
   between-bounds, retention, search), bouncer (stale-replica, activity,
   away-persistence), webpush attention, tls-accept, preauth. Then the crdt live
   gates again, then a soak.
5. **Merge commit** on `crdt-mesh` (a merge, not a rebase: 266 commits of history
   with live-validated milestones behind them), pushed to `MrLenin/nefarious-crdt`
   only; the CRDT branch has no evilnet mirror.

## After the merge: what the fork added that the mesh must learn

The fork's new S2S surfaces ride P10 tokens; among CRDT peers the P10 tree is
retired (MR-5), so each needs a mesh path or an explicit "tunnel via gateway"
decision:

- `PN` — strict-presence intervals replicated network-wide (`603d161`). Presence
  is per (account, channel) and account-anchored: a natural doc collection, or
  CR-X tunnel first.
- `CH A S/R` store advertisements + the new widest-retention ISUPPORT
  (`7ce0cfe`): crdt 5-5f B2 already keeps storage capability as a doc
  collection; the retention value should come from that collection on CRDT
  peers, and `chathistory_retention_advertised()` must read both sources.
- `BX U aw= / la=` (per-connection away and activity, `571caac`/`346a1c0`): the
  bouncer-over-mesh work (5-5e) mirrors bconns in the doc; the two fields belong
  on the bconn record.
- `TOKEN`/authtoken S2S (`7fd9ef8`) and `RLO`/relocate (`fe0a842`): gateway-only
  until designed.
- SEARCH federation: scoped, not scheduled
  (`chathistory-federated-search.md`); on the mesh it rides the same 5-5f
  responder discovery once E is resolved.

## What was already missing on crdt-mesh (from the roadmap and memory)

- Tier C partial: F3/F4 not done; F2-c webpush convergence exists but predates
  the fork's key ring and attention model (will need re-alignment after C).
- Deferred: M6-trim, m15-incarnation-anchor (`project_crdt_review_2026_07`).
- Services bridge B3 REGISTER/VERIFY blocked on X3; B4/B6/B7 optional.
- "Not-yet-on-CRDT transport gaps" section of the roadmap (next expansion class).
- Metadata era-2 "prod-fork cherry-pick subset": largely done (the 25 pairs);
  verify nothing of P1/P2 is fork-only after the merge.
- Soak since the 2026-07-30 deploy was interrupted by the fork work; a fresh soak
  follows the merge.

## Risks and rules

- One-commit-per-PR and "never stack" apply to evilnet; `crdt-mesh` is a fork
  branch with a merge history, so a merge commit is right here.
- `bouncer-architecture` invariants and the `crdt-mesh` hard invariants are the
  checklist for classes D and E; run the c-auditor on any stub-as-source path
  the merge touches.
- Freshness trap (NB6): verify the `ircd.YYYYMMDDHHMM` symlink advances on every
  slot after a rebuild; build all five CRDT images before recreating the fleet.
- Bed disk: check `df` first; the docker log cap in compose (`64bd535`) applies
  only to recreated containers.

## Execution log

### 2026-09-20 — merge done, host gates green, bed gates pending

- Baseline `/CRDT status` on the 2026-07-30 fleet (nefarious6/7 restarted
  ~20 min earlier; overlays not yet re-autoconnected): every node `0
  mismatch(es)`, `mesh reachable=5`, `partitioned=YES` (tree split, mesh
  whole — the routine bed state); hub2 `2 crdt, 4 legacy, 2 stub (2
  presented)`, nef7 `OVERLAY-PRIMARY … 3 live overlay edge(s)`.
- Merge commit `d5220b9` on `crdt-mesh` (local; parents `8956de7` +
  `7ce0cfe`), built in `scratchpad/wt-crdt-dry` then fast-forwarded into
  `nefarious-crdt`.  Not pushed yet.
- Class E resolved as the plan predicted: the fork's request/merge/responder
  logic on crdt's `collect_storage_targets` + CR-X tunnel + `ch_reply_out`.
  Extra work the merge exposed, all in the merge commit: the trailing query
  params (ref2, requester token, type mask) now ride every forward path
  including the two tunnel re-wraps; the reply chunker subtracts a
  `CH_TUNNEL_WRAP` (64 B) allowance from the fork's measured per-row budget
  while a tunneled query is being answered; the CR-M witness store stamps
  rows with `msgid_decode_time_ms` (fork rule: never the wall clock);
  REGISTER/VERIFY/REGREPLY bridge cases retired; webpush peer-receive
  returns the record for the doc mirror and the doc reconcile invalidates
  the subs-count cache; `chathistory_retention_advertised()` walks the doc
  collection (same reachability gate as the collector) and the verify tick
  re-derives the ISUPPORT token.
- Host build with the image's configure flags: clean; `make test` green;
  cmocka 33 suites / 551 tests, 0 failed.
- Next: five-image rebuild (+ init twins), fleet recreate, symlink freshness
  check, then the fork suites on the CRDT bed and the crdt live gates.
- First fleet boot on `d5220b9` died on every slot at the first feature
  lookup (`ircd_features.c: features[feat].feat == feat`): the enum union
  put `FEAT_BOUNCER_MAX_ALIASES` after the CRDT block while the auto-merged
  `features[]` row sat before `CRDT_ENABLED`.  Fixed in `d2730e0` (enum
  moved to table order + a `_Static_assert` on the row count).  LESSON: an
  enum/table pair that must agree in order is a class-B "union" that the
  build cannot check; after any such union, diff the two orders before
  building images (the check is a 15-line python, see the session).
- Bed gates, first pass (2026-09-20 03:00-03:44): the run was MIS-TARGETED —
  `PRIMARY_SERVER.port` was hard-coded 6667, so every "primary" client sat on
  the legacy fork primary and only `IRC_PORT2=6670` (leaf2) touched the merged
  binary.  Fixed in the testnet helpers (PRIMARY_SERVER and the client
  defaults now honour `IRC_PORT`).  What that pass still established: the
  five slots boot clean on `d2730e0` (0 valgrind errors, 0 CONFIG errors,
  storage capability published on each), `/CRDT status` = 0 mismatches,
  mesh reachable=5 on every node; a hand probe (seed on hub2, read from
  leaf2 after a late join) returns all rows in 0.2 s via CH Q to hub2 +
  leaf4 and a CR-X tunnel to leaf5; tls-accept handshakes pass on hub2:6699
  (its precondition fails only because the CRDT init containers make a
  single self-signed cert, not the fork's chain).
- Legacy-primary + CRDT-leaf federation (what the mis-targeted federation
  suite measured): leaf2 never queries the legacy primary's store — it holds
  no ad for it (legacy `CH A S` does not cross the gateway into the mesh;
  only the mesh-ward B4 synth exists).  A real gap, the mirror of B4: the
  gateway should publish legacy-known stores into the doc (or synth their
  ads mesh-ward).  Added to the post-merge list.
- Suites that SQUIT `leaf.fractalrealities.net` by name (partial,
  retention-isupport, stale-replica, federation's first/last cases) are
  tree-bed specific: from a CRDT node the CONNECT cannot heal that link.
  Need CRDT-bed variants (SQUIT leaf2 from hub2), not fixes.
- Eager retention publish + delta re-derive: `6204d08` (images rebuilt,
  fleet recreate after the second test pass).
- Second pass, retargeted (IRC_PORT=6669): every pool-backed suite stalled
  ~8 min in beforeAll — AuthServ answered nothing from hub2/leaf2 (`401 No
  such nick`).  Root cause was a class-C hand-merge slip, not the mesh: the
  burst-time SERVER line in `s_serv.c` (the one that introduces already-
  linked servers to a new peer) had seven flag `%s` slots for eight flag
  arguments, so the `C` flag string became the server info and the real
  info was dropped.  When the upstream slot linked to hub2 at 07:01:59 the
  relayed introduction reached the legacy primary with an EMPTY info and
  the primary answered `SQ … :No server info specified` — hub2 lost its
  primary link (and with it X3, the leaf and the paste host) for the rest
  of the session.  Fixed in `efda7f0`; an argument-count audit of all four
  SERVER emitters is now clean.  LESSON: any hand-widened format string
  gets an arg-count audit (a 10-line python) before the images build.

### 2026-09-20 05:00 — DONE: merge on the fleet, gates green, pushed

`crdt-mesh` = `100de7f` on MrLenin/nefarious2 (merge `d5220b9` + four
follow-ups: `d2730e0` enum order, `6204d08` eager retention publish,
`efda7f0` SERVER format, `100de7f` PN gate).  Fleet nefarious3–7 on it
(binaries `ircd.202609200859`), 0 valgrind errors, 0 asserts, `/CRDT
status` 0 mismatches + mesh reachable=5 on every node, services reachable
from every CRDT node.

Bed gates with BOTH ends on the mesh (`IRC_PORT=6669 IRC_PORT2=6670`,
slot opers granted `set = yes`):

| suite | result |
|---|---|
| chathistory-presence-paging | 5/5 |
| chathistory-strict-presence | 3/3 |
| chathistory-presence-transition | 1/1 |
| chathistory-targets-presence | 1/1 |
| chathistory-between-bounds | 1/1 |
| chathistory-federation | 7/7 (incl. SQUIT/CONNECT of the legacy leaf from hub2) |
| search | 7/7 |
| bouncer-away-persistence | 1/1 |
| bouncer-activity | 2/2 |
| webpush-attention | 3/3 (cross-server AWAY * over the hub2↔leaf2 tree link) |
| preauth-resource-limits | 5/5 |
| tls-accept | 3/3 handshakes (precondition needs a chain cert on the slot) |

Not run on the mesh (tree-bed specific, SQUIT `leaf.fractalrealities.net`
by name and expect the tree-side semantics): chathistory-partial,
chathistory-retention-isupport, bouncer-stale-replica.  They need CRDT-bed
variants where the split is hub2↔leaf2 and "absent" means beacon-stale,
not tree-split.

Bed lessons (also in the crdt-mesh skill): PRIMARY_SERVER honours
`IRC_PORT` now; slot confs are bind-mounted per file, so edit them IN
PLACE or restart the container (an atomic rename leaves the container on
the old inode and REHASH reloads nothing); slot opers need `set = yes` for
the suites that SET features.

Still open after the merge (the mesh must learn these; ordered by value):
1. Absence table on the mesh: `absence_open` fires on SQUIT even when the
   store stays beacon-reachable, and nothing closes it for a CRDT peer
   (CH A S never re-arrives).  Absence should key on beacon staleness;
   close on doc/beacon recovery.
2. Legacy stores into the mesh: the gateway learns legacy `CH A S` but
   never publishes them into the doc, so an inner node never queries the
   legacy primary's store (the mirror of B4).
3. PN presence intervals: now accepted from anchors, but they still ride
   the P10 tree only; a doc collection (or CR-X tunnel) is needed for
   overlay-only nodes.
4. `BX U aw=/la=` and alias records on the bconn doc record (5-5e).
5. `TOKEN`/authtoken and `RLO`/relocate: gateway-only until designed.
6. SEARCH federation rides 5-5f once (1) is settled.
7. Pre-existing: `ACCOUNT for already registered user` re-emits from the
   gateway (memory: bouncer-stale-held-convergence side note).
8. The CRDT init containers make a single self-signed cert; give them the
   fork's chain so tls-accept's precondition holds there too.

### 2026-09-20 12:00-12:40 — post-merge items 1 and 2 SHIPPED

1. **Absence table on the mesh** (`862788c`): a doc-known store is absent
   while its CR H beacon is stale (or it is not a live P10 server here) and
   back on a fresh beacon; `crdt_shadow` sweeps the storage collection every
   verify tick and hooks the beacon receive path; `m_chathistory` keeps a
   per-server reach state (0 unknown / 1 reachable / 2 absent) so only
   transitions act, the absence is backdated to the last beacon seen, a store
   never seen reachable cannot go absent (boot), and the retention token is
   re-derived on both transitions.  Live gate (`scratchpad/absence_gate.py`):
   `docker stop nefarious6` → hub2 pages carry the partial tag and no end tag
   after 20 s; `docker start` → complete again after 56 s.  PASS.
2. **Legacy stores into the doc** (`9da78dd`): the gateway publishes a legacy
   server's storage capability on its behalf — eagerly on CH A S/R from a
   non-CRDT-aware server, re-minted each verify tick from the legacy ads it
   still holds, withdrawn when the server leaves the gateway's legacy link.
   Two bugs surfaced on the way and are fixed: the CH E once-per-responder
   guard keyed on `server_ad_index(sptr)`, which is -1 for anchored sources
   and tunneled re-injects, so replies through the mesh were never guarded
   (`d823d08`, tunnel dispatch now carries the CR-X source); and a reply the
   gateway relays for a legacy responder toward a CRDT next hop went out as a
   P10 line the peer had no Client for and silently dropped, so the origin
   waited to the fed timeout and stamped the page partial (`4f38981`: relayed
   replies toward a CRDT next hop ride the tunnel sourced by the responder).
   Live gate: rows seeded on the legacy primary, read from leaf2 — before:
   0 rows; after: 3 rows in 0.2–0.8 s, six responders credited, no partial.
   DEBUG lines `CH fed dispatch` / `CH E: reqid` / `CH fed timeout` now name
   the responders a request waits on.

Remaining from the list: PN over the doc (3), BX U aw=/la= on the bconn
record (4), TOKEN/RLO (5), SEARCH federation (6), AC re-emit (7), slot cert
chain (8), and CRDT-bed variants of the three tree-specific suites.

Later the same afternoon (`f434264`): hub2 itself never dispatched to the
legacy primary — the bed's CRDT slot confs U-line `testnet` (data/ircd3–7
`UWorld`; prod uses no UWorld block, so prod never saw this) and the store
collector skipped U-lined servers.  An entry in that table exists only
because the server sent CH A S, which services never do, so the U-line
skip is gone from the ad-gated walks (kept on the write-forward and
direct-link propagation paths, where it is about services).  Gate: rows
seeded on the primary now read from hub2 (6 responders incl. Bj) and from
leaf2 in 0.2–0.8 s.

Regression on the mesh after items 1–2: federation 7/7, search 7/7,
strict-presence 3/3, presence-paging 5/5 (when run right after the
federation suite it fails 2/5 by design: that suite SQUITs the legacy leaf
from hub2, which has no C-line for it, so the leaf stays split ~5 min and
every page is honestly partial — order the suites accordingly).  Fleet on
`f434264`: 0 valgrind errors, 0 asserts, 0 CRDT mismatches, mesh
reachable=5.  crdt-mesh pushed to MrLenin/nefarious2.

### 2026-09-20 13:00-13:50 — items 3 and 4 SHIPPED (crdt-mesh `b16cb09`, pushed, fleet on it)

3. **PN over the mesh** (`75f1ff9`): `presence_broadcast_close` also floods
   the PN body over CR M (letter `S`, target `*`, the CI precedent);
   receivers apply locally only (the origin's tree copy serves legacy; a P10
   re-emit would echo across planes).  Gate (`scratchpad/pn_gate.py`): an
   account's PART on hub2 → before: leaf2/leaf3 got the tree PN, leaf5
   (overlay-only) nothing; after: all three apply the mesh copy, leaf5
   included.  Presence cmocka harness stubs `generate_msgid` +
   `crdt_gossip_message`.
4. **Away + activity on the bconn record** (`b16cb09`): `CrdtBouncerConn`
   gains `away`/`away_known` (sizeof 16→24, explicit zeroed padding); the
   host fills the record from the connection, re-mints on an away change
   and on the la= interval; the bconn reconcile now APPLIES last_active /
   caps / away into the primary's and aliases' roster fields on every delta
   (before this the record's fields were never consumed at all).  Gate
   (`scratchpad/bconn_gate.py`): primary on hub2 with a bouncer session,
   alias on leaf5 (overlay-only) sends `AWAY *` then `AWAY` → hub2 logs
   `CRDT bconn: … alias AIAAB … away=2` then `away=0`.  Regression on the
   mesh: presence-paging 5/5, strict 3/3, webpush-attention 3/3;
   presence-replication 1/2 (the failing case SQUITs the legacy leaf by name).

Remaining: TOKEN/RLO (5), SEARCH federation (6), AC re-emit (7), slot cert
chain (8), CRDT-bed variants of the tree-specific suites.

### 2026-09-20 14:00 — item 5 SHIPPED (crdt-mesh `7f25581`, pushed, fleet on it)

5. **TOKEN over the mesh** (`7f25581`): TK G/U (token issued / revoked)
   also flood over CR M (letter `A`, target `*`, CI precedent) from every
   origin emit and from the gateway edge when a TK arrives over a legacy
   link; a mesh receiver learns/forgets locally (idempotent) and re-emits
   real P10 to its legacy links only when the origin server has no tree
   presence there (an overlay-only node's tokens reach legacy without a
   dual-plane echo).  The CRDT slot confs now carry the primary's four
   Authtoken services (bind-mounted; appended in place).  Gates: authtoken
   suite 7/7 with both ends on the mesh; an opaque token generated on hub2
   validates on leaf5 (overlay-only, no tree link) and on leaf2; the legacy
   primary learned it via the tree copy and forgot it on the single-use
   `TK U` that followed — correct.  **RLO stays gateway-only**: the relocate
   cap is off by default and design D's follow-join is still pending across
   fork/#96/X3; a unicast `RLO` toward a mesh-only user would ride the CR-X
   unicast path like SVSJOIN when that design lands.

Remaining: SEARCH federation (6), AC re-emit (7), slot cert chain (8),
CRDT-bed variants of the tree-specific suites.
