# X3-into-Nefarious — Sequencing Under Big-Bang-Per-Phase Deployment

**PLAN OF RECORD.** Rewritten 2026-07-30, replacing the prior sequencing document
wholesale; corrected in a reconciliation pass the same day (see "Corrections applied"
below). The prior plan assumed live coexistence of both systems (dual writers, orphan
firewall, RELAY/LOCAL runtime toggles, live reconciliation). Those constraints were
wrong and none of that machinery appears here.

## Document set

- **This document** — sequencing, windows, converter, rollback. Read first.
- `x3-merge-authority-model.md` — the target entity/authority model (Keycloak =
  identity authority; daemon `registry` RocksDB env = IRC-domain authority;
  UUID-keyed accounts, stable-id channels, numeric grants behind a `chan_authorize`
  verb chokepoint). Written before the big-bang-per-phase constraint was known, so
  read its migration and replication remarks through this document; its *design* is
  unaffected — the entity model does not change with deployment style.
- `x3-merge-survey-inventory.md` — what X3 does and stores. Pure reference, accurate.

## Corrections applied in the reconciliation pass (2026-07-30)

Each is marked inline where it lands:

1. **The testnet runs LDAP** (§0). `data/x3.conf` is stale; the live config is
   env-substituted with `X3_LDAP_ENABLE=1`. The claimed testnet/production auth
   divergence does not exist — Phase 0's "LDAP-enabled bed variant" work and risk
   §7.2 are struck.
2. **The `nickserv.c:5625` citation was from the no-LDAP branch** (§0, §2). The live
   path is the LDAP reconciliation at `:5579-5601`, which behaves oppositely.
3. **The LDAP `createTimestamp` is authoritative and X3 backfills saxdb onto it**
   deliberately (§0) — so the converter reads the directory and ignores saxdb's
   `registered`, and the dormant-account tail stops mattering for that field.
4. **The rename escalation vector is real, and the LDAP reconciliation enables it**
   (§2.3). A coordinator objection that it was mere denial was wrong; mechanism
   verified end-to-end. The collapse-the-cutovers recommendation stands and is now
   better supported than its original citation.
5. **A registration stopgap may exist outside the merge entirely** (Phase 0,
   Gate 1b): Keycloak's LDAP federation is `editMode: READ_ONLY`, which is the exact
   mechanism behind "X3 can't see Keycloak-only accounts". Test the `WRITABLE` flip
   before scoping Phase 1.

## Deployment model (the corrected constraints, restated as rules)

1. **Big-bang per phase.** Production migrates in maintenance windows: shut down,
   rebuild, migrate data, restart. There is never a period where both systems are live
   and writable. No dual-writer machinery, no mirror-writes, no live reconciliation,
   no runtime authority toggles for production safety.
2. **Incremental development, big-bang deployment.** The testnet proves increments one
   at a time; production takes batches of proven increments at windows. Increments are
   designed to *compose into a single cutover*, not to be independently deployable.
3. **Migration is offline tooling.** All services state is flat-text saxdb in one
   `x3.db` (mondo file; survey §2). The converter runs against a copy, is verified, and
   is re-runnable before any window opens.
4. **Rollback is restore-from-backup**: previous `x3.db` + previous binaries + previous
   config (+ Keycloak realm export, added below). Not flag-based reversibility.

---

## 0. Ground truth (verified this pass; file:line)

Facts from the companion docs are cited there and not repeated. New verifications:

**Two password-hash formats coexist in `x3.db`.** `checkpass()` (`x3/src/md5.c:639`)
dispatches on a leading `$`:
- *Plain*: 32-char **lowercase** hex, literally `MD5(password)` — `cryptpass()`
  (`x3/src/md5.c:633`) → `md5()` with `sprintf("%02x")`. This is what all new writes
  produce ("compatable with php, md5sum etc" per the in-code comment).
- *Legacy salted*: `$` + 8 hex seed chars + 32 **uppercase** hex —
  `cryptpass_real()` (`x3/src/md5.c:325`): write the 8 hex digits of the seed into a
  64-byte buffer, append the password, append one `'1'`, pad with `'0'` to 64 bytes,
  MD5 the whole buffer, emit uppercase. **Custom construction; no stock MD5 mode
  reproduces it.** Nothing rewrites format 2 to format 1 on login (`checkpass` only
  compares), so decades-old accounts retain salted hashes indefinitely. Both formats
  must be assumed present, plus malformed/empty rows in a file this old.

**But when LDAP is enabled, X3 never reads those hashes at all.** The local path is
explicitly guarded: `if (password && *password && !nickserv_conf.ldap_enable)`
before `checkpass()` (`x3/src/nickserv.c:2198`). With `ldap_enable` set,
authentication is a **plain LDAP bind** — `ldap_check_auth()` (`x3/src/x3ldap.c:125`)
→ `ldap_do_bind(dn, pass)`; the directory performs verification and X3 never sees a
hash. Deployment status — one fact observed, one assumed, one structural:
- **CORRECTED 2026-07-30 — the testnet DOES run LDAP.** `data/x3.conf` is a stale
  artifact and is not what the container uses. The live config is generated from
  `x3/docker/x3.conf-dist` (`"ldap_enable" "%X3_LDAP_ENABLE%"`, line 252) with
  `.env.local:38` setting `X3_LDAP_ENABLE=1`. The compose file states the intent
  outright — *"X3 (LDAP-authoritative) writes account credentials to LDAP on
  registration"* (`docker-compose.yml:678`) — and notes the env move was made
  because *"it's how LDAP kept reverting to disabled"* (`:691`). **The bed exercises
  production's authentication path.** An earlier draft of this plan claimed
  otherwise and scoped remedial work on that basis; that work is struck.
- **The whole deployment already shares one substrate.** OpenLDAP is the
  authoritative directory; X3 writes accounts into it (`ldap_do_add`,
  `x3/src/x3ldap.c:367`) and authenticates by bind against it; Keycloak federates
  **READ_ONLY** from the same subtree (`scripts/setup-keycloak.sh:741`,
  `usersDn=ou=users,dc=fractalrealities,dc=net`, matching X3's
  `X3_LDAP_DN_FMT`); the daemon authenticates via Keycloak. Production is reported
  to store RFC 2307 `{SMD5}` in the directory — **still an assumption**, and
  production's `ldap_enable` value remains unconfirmed, but the testnet topology is
  now observed, not assumed.
- Mixed populations are possible either way: `ldap_autocreate`
  (`x3/src/nickserv.c:2461`) creates X3 handles for LDAP-authenticated users, but
  accounts predating LDAP may hold local hashes with no directory entry.

**X3's AC-stamp handling is exactly the seam that bites in any split cutover.**
`handle_account()` (`x3/src/nickserv.c:5562`):
- Unknown handle → `"had unknown account stamp"` warning, user is simply **not bound**
  to any handle (`nickserv.c:5683`); every authed services command then fails for them.
- Known handle but wire timestamp ≠ stored `registered` → behaviour **depends on the
  branch, and the earlier citation of `nickserv.c:5625` was from the wrong one**.
  `:5625` is the `#else` path, explicitly commented *"No LDAP — original behavior:
  reject on mismatch"*. This deployment runs LDAP, so the live path is
  `nickserv.c:5579-5601`: X3 calls `ldap_get_user_create_time(stamp)` and treats the
  **directory's `createTimestamp` as authoritative** — matching the wire means X3
  logs *"correcting saxdb from %lu"* and writes `hi->registered = ldap_time`
  (`:5583-5591`), which then persists (`saxdb_write_int(ctx, KEY_REGISTER_ON, ...)`,
  `:4237`). Only a wire/LDAP *disagreement* rejects.
  **This is a deliberate lazy backfill, not drift**: the AC timestamp exists to
  distinguish a re-registered name from its predecessor, and once Keycloak SASL made
  the LDAP `createTimestamp` the only value the daemon can know, saxdb's original
  `registered` had to converge onto it. Consequence for the converter: **read
  `createTimestamp` from the directory and ignore saxdb's `registered` entirely** —
  no per-row heuristics, and the dormant-account tail (accounts that have not logged
  in since the change, so never backfilled) stops mattering for this field.
- The only auto-create path is LDAP-gated (`nickserv.c:5641+`, requires `ldap_enable`
  + `ldap_autocreate`); disabled in deployment.

**ChanServ is config-gated as a unit.** `init_chanserv(nick)` registers all passive
hooks — join/automode, mode enforcement, topic, auth — only `if (nick)`
(`x3/src/chanserv.c:10035-10044`), and the bot itself only under the same test
(`chanserv.c:10225-10226`). Omitting the nick in x3.conf disables ChanServ wholesale,
same mechanism the testnet already uses for SpamServ (survey §1). No X3 code change
needed to turn ChanServ off.

**The daemon does not persist G-lines.** No save/restore path in
`nefarious/ircd/gline.c` (memory-only, mirrors ircu); X3's saxdb gline/shun sections
(`gline.c:312`, `shun.c:313`) plus REFRESHG/REFRESHS are what survive a whole-network
restart today. Retiring OpServ therefore requires daemon-side net-ban persistence
(Phase 4). *(Confidence: high that no persistence exists; grepped, not exhaustively
traced.)*

**Burst automode suppression exists in ChanServ** (join-flood/burst gates around
`chanserv.c:8540`, survey §3) — parity matters because every window ends in a
whole-network cold start, i.e. the worst-case burst.

Carried from the companion docs (load-bearing here): the RG/VF/RR and rename relay
contracts are daemon-complete but X3-absent (survey §4); the daemon's kc client covers
the full account lifecycle (`nefarious/include/kc/kc_keycloak.h:147-191`); registered
channels have no founder field — founder = the access-500 row (survey §3); the modcmd
permission wiring is saxdb data, not code (survey §2); `kc_user` already models
`x3_opserv_level` and `x3_scram_*` attributes (authority model §0).

---

## 1. v1 topology decision: services live in the hub daemon

The authority model's registry env is per-server-local and replication is explicitly
unsolved (authority model §6). Production is multi-server. Rather than solve
replication now (that is the CRDT-mesh branch's job, §8), **v1 keeps the
services-shaped topology: one designated registrar daemon (the hub) owns the registry
env and answers all authority questions.** Leaves behave exactly as today:

- REGISTER/VERIFY relay to the `+s`-flagged server already exists client-side
  (`m_register.c:114-137`); the hub daemon becomes the responder instead of X3.
- Rename authorization relays likewise, but the misparsed `AC ... R` query
  (authority model §0) is **replaced with a clean dedicated token**, since we now
  control both ends. The 10s `PendingRename` timeout machinery stays for leaves; on
  the hub the decision is local and synchronous.
- Automode/enforcement: the hub daemon observes joins/modes via normal P10 and emits
  modes network-wide — wire-identical behavior to ChanServ today, same availability
  profile, but in-process, Keycloak-anchored, RocksDB-persisted.
- SASL stays genuinely distributed: every daemon already authenticates locally against
  Keycloak (shared external store); only IRC-domain authority is hub-anchored.

This bounds scope hard: v1 is "absorb services into the hub daemon," not "distribute
services into every daemon." Distribution is deferred to the mesh. *(Confidence:
high that this is the right v1 scope; the single-registrar choice itself is a
topology/ops decision the network should ratify — marked as such.)*

---

## 2. The inter-phase seam — analysis and recommendation

**The question:** if accounts cut over first (Window A) and channels later (Window B),
X3 still enforces ChanServ access during the gap, with access lists keyed by handle
*name*, while the daemon owns account creation and rename.

### What services would need during the gap, and how it could learn it

1. **Handle existence for every account it must bind.** Without a `handle_info`, an AC
   stamp logs `"unknown account stamp"` and the user is not logged in to services at
   all (`nickserv.c:5683`) — no ChanServ commands, no access, cannot even be ADDUSER'd
   (target-handle lookup fails). Learning paths: (a) frozen snapshot of the nickserv
   db at Window A (covers pre-existing accounts), (b) an AC-triggered autocreate stub
   patterned on the LDAP autocreate branch (`nickserv.c:5641+`) for accounts created
   after Window A — covers them only from their first connect, (c) a live sync feed —
   which is exactly the prohibited class of machinery.
2. **Registered-timestamp agreement.** The daemon's AC carries `acc_create`
   (`m_account.c:477-479`); X3 silently rejects on mismatch (`nickserv.c:5625`). The
   snapshot and the daemon directory must agree to the second.
3. **Handle continuity under rename — the escalation vector, mechanism corrected.**
   X3 access rows are keyed by handle name (survey §2). A daemon-side rename during
   the gap (i) strands the user's access under the old name, and (ii) frees the old
   name for re-registration.

   The AC timestamp is what normally prevents a new holder of a reused name from
   being mistaken for the old one — and under LDAP it **fails to, in exactly this
   case**. Chain, verified: daemon renames `foo`→`bar` (writing through to the
   directory) → X3's saxdb keeps handle `foo` with its access rows → a new account
   registers `foo`, getting a fresh directory entry and `createTimestamp` → the new
   user authenticates and the daemon stamps `foo:<new ts>`
   (`nefarious/ircd/m_account.c:477-479`) → X3 finds the **old** handle by name
   (`nickserv.c:5575`) → `ldap_get_user_create_time("foo")` returns the **new**
   user's timestamp, because the directory's `foo` is now the new account →
   wire == LDAP, so X3 takes the *"correcting saxdb"* branch (`:5583-5591`) and
   falls through to `set_user_handle_info(user, hi, 0)` (`:5681`) — **binding the
   new user to the old handle, inheriting every access row keyed to that name.**

   Note the direction: the LDAP reconciliation *enables* this. The no-LDAP branch
   (`:5625`) would have rejected on mismatch and produced mere denial. The
   timestamp disambiguates only while the name→timestamp binding is stable; once the
   daemon can rename and re-register names in the directory, the timestamp follows
   the *name* rather than the principal and stops being an identity check at all.
   This is the authority model's "name is not identity" thesis, arrived at from the
   operational side.

   Only mitigations in a split: freeze account rename for the whole gap, or sync
   renames live (prohibited).
4. **`opserv_level` for staff commands** (dual gate, survey §3) — frozen at snapshot;
   staff changes during the gap require hand-editing.

### What breaks, concretely, in the gap

- Every account registered after Window A is second-class in ChanServ until Window B:
  grantable only after first connect (stub), invisible before.
- Account rename must be frozen network-wide (else escalation via name reuse).
- The gap lasts as long as channel-absorption development — the dominant effort item
  (§6), i.e. **months of degraded steady-state on a live network**, visible on every
  new registration.

### Recommendation: collapse the two cutovers into one window

**Accounts and channels cut over together in a single production window (Window 1).**
Reasoning:

- The gap's costs are recurring and user-visible for months; the collapse's cost is a
  somewhat larger single window. But the window's long pole is verification, which is
  shared — the converter runs both halves in one pass either way, and the channel data
  is small next to the account data.
- The rename-inheritance hazard disappears rather than being frozen around.
- Constraint 2 already says increments must compose into one cutover. Account
  authority remains **first in development order** — that intent is right, because
  grants foreign-key on account UUIDs, and converter part B consumes part A's
  name→UUID map. It is just not a separate *production* cutover.
- A residual, much weaker seam persists regardless (residual X3 — OpServ, MemoServ,
  HelpServ, Global — still resolves accounts), and it is cheap to serve: nothing the
  residual bots enforce is ownership-bearing. See Phase 3.

**Contingency (if channel absorption slips indefinitely):** the split is survivable
with exactly three mitigations, priced now so the fallback is real: (i) frozen
snapshot nickserv db at Window A, (ii) the AC-autocreate stub patch, (iii) account
rename disabled until Window B. Accept "new accounts are grantable only after first
connect" as the documented degradation. Do not build anything beyond those three.

---

## 3. Phase breakdown

Development phases (testnet-staged, no production exposure) feed two production
windows. Each phase lists what it develops, what proves it, and confidence.

### Phase 0 — Groundwork: auth-topology confirmation, credential decision, converter skeleton, census (dev)

- **Gate 1 — confirm production's authentication topology.** Two user-reported,
  unverified facts decide the entire credential track: (a) production runs
  `ldap_enable 1`, (b) the directory stores RFC 2307 `{SMD5}`. Confirm both from
  production config / a directory read **before any credential work is scoped**.
  Everything below branches on the answer.
- **Decision D1 — Keycloak↔LDAP federation vs one-time import** (must be surfaced
  and ratified; the window's credential step depends on it):
  - *Federation*: Keycloak's native LDAP user federation verifies credentials by
    bind against the same directory X3 uses today. Zero hash work, lowest-risk
    window step — but the directory stays in the architecture permanently as the
    credential authority. That contradicts the stated end-state goal of a mostly
    self-contained deployment; and Keycloak does not capture passwords into its own
    store on federated logins, so "federate now, retire LDAP later" still ends in a
    hash migration or a forced-reset campaign — it defers the problem, it does not
    shrink it.
  - *One-time import* (**recommended for the self-contained end-state**): export
    directory entries with their `userPassword` hashes, import into Keycloak behind
    a custom `PasswordHashProvider`, which rehashes to a modern algorithm on each
    user's first successful login; the directory retires at Window 1. The SPI
    deployment path is proven (`keycloak-webhook-spi`).
- **Hash providers — conditional scope, per D1 and the census:**
  - *`{SMD5}` provider* (import branch only): standard RFC 2307 salted-MD5, small
    and testable against stock vectors — needed if the directory-hash assumption
    confirms.
  - *X3 dual-format provider* (only if the census finds an **active local-hash-only
    cohort**): both X3 formats with dispatch on the leading `$` (`md5.c:639`
    semantics) — plain **lowercase**-hex `MD5(password)` (`md5.c:633`), and the
    custom salted form (`md5.c:325`: 8 seed hex chars + password + `'1'` +
    `'0'`-pad to 64 bytes, MD5, **uppercase** + `$`-seed prefix; no stock MD5 mode
    reproduces it). Mandatory tests if built: vectors extracted from a real
    `x3.db`/directory copy verified end-to-end through Keycloak login, plus an
    explicit case-sensitivity discriminator (a case-insensitive compare appears to
    work while masking format misdetection). If production is LDAP-backed and the
    local-hash cohort is dormant-only, this provider is **not built** and that
    cohort gets an announced reset path instead.
  - No password resets are required for any imported format in the import branch;
    Keycloak rehashes on first login.
- **Converter skeleton**: saxdb (recdb) parser + LDAP export reader + census mode.
  The census classifies **every account into one of four credential states —
  LDAP-backed / local-hash-only / both / neither** — and reports: account counts
  per state; local-hash format split (plain / `$`-salted / malformed); per-state
  activity (lastseen) distribution, which decides whether the X3 dual-format
  provider is needed at all; channel/grant/lamer/note counts; dangling references;
  modcmd overrides present. The census is a **go/no-go input**: zero unexplained
  records, or each explained and dispositioned.
- **STRUCK (correction, §0): the "LDAP-enabled bed variant" work.** An earlier draft
  claimed the bed ran `ldap_enable "0"` and scoped building an LDAP-backed variant
  before credentials could be called proven. The bed already runs LDAP
  (`.env.local:38`), with OpenLDAP authoritative and Keycloak federating from it, so
  that work does not exist. Residual check only: confirm the bed's directory hash
  scheme matches production's, since the rehearsal's value depends on it.
- **Gate 1b — the registration stopgap, test before scoping Phase 1.** Keycloak's
  LDAP federation is configured `editMode: READ_ONLY` with `syncRegistrations: false`
  (`scripts/setup-keycloak.sh:741`). That is the exact mechanism behind
  "X3 doesn't recognise Keycloak-only accounts": X3→LDAP→Keycloak works (Keycloak
  imports, `changedSyncPeriod: 60`), but daemon→Keycloak stops dead in Keycloak's
  local store and never reaches the directory. Flipping to `WRITABLE` +
  `syncRegistrations: true` should push daemon-created users into LDAP, after which
  `ldap_autocreate` (`x3/src/nickserv.c:2461`) creates the X3 handle on first bind —
  closing the loop with **no merge work at all**.
  If it holds, account registration stops being merge-blocked and the whole programme
  proceeds on its own merits (self-contained deployment, channel authority) instead
  of under pressure from a broken feature. Note it does **not** shrink Phase 1 —
  Phase 1 is about the daemon *owning* accounts, not about registration working —
  it removes the urgency, which is a different and more valuable thing.
  Ways it can fail, all cheap to test: Keycloak must create entries matching
  `userObjectClasses: inetOrgAnonAccount` and X3's search filter; the password must
  land in a form the directory accepts on bind (bind is scheme-agnostic, so likely,
  but "likely" is load-bearing); and DN case (`ou=users` vs older `ou=Users`) wants
  confirming. **An afternoon's experiment; run it before Phase 1 is scoped.**
- **Cheap verify items** (hour-scale, do first): the `+z` vs `+R` registered-mode
  wire-letter question (X3 emits `+z`, `proto-p10.c:3911`; nefarious binds
  `MODE_REGISTERED` to `'R'`, `channel.c:2402` — confirm what actually flows);
  whether any prod tooling still consumes `sync.log` (survey §6); production's
  current Keycloak status (**guess: not deployed in production yet** — if so,
  standing up Keycloak infra happens ahead of Window 1, inert, with rehearsal
  realms).

*Proof:* Gate-1 facts confirmed and D1 ratified; census run on testnet `x3.db` and
on a production copy (+ directory export) if obtainable; whichever hash providers
D1/census require are green against real-data vectors on the LDAP-enabled bed.
**Effort: 1-2 weeks tooling + the D1 decision's calendar** (the ~1 week formerly
added for an LDAP-enabled bed is struck — the bed already runs LDAP; add instead the
afternoon for Gate 1b's `WRITABLE` experiment). **Confidence: high on mechanics,
medium until Gate 1 confirms production's `ldap_enable` and hash scheme.**

### Phase 1 — Account authority in the daemon (dev)

- `registry` env, account CFs (`acct`, `acct_by_name`) per authority model §4.
- Native REGISTER/VERIFY on the registrar: `m_register` keeps local validation, calls
  `kc_user_create` instead of relaying into the void; the already-written local
  completion tail (`m_register.c:415-445`) fires from the kc callback. Leaf relay
  (RG/VF → hub, RR back) now answered by the hub daemon. Directory row written on
  success; AC propagation unchanged.
- Converter **part A**: saxdb accounts joined with the LDAP directory export →
  Keycloak import payload (handle, email, registered-ts, flags, `opserv_level` as
  attributes — the `x3_*`-attribute shape already exists, `kc_keycloak.h:66-73`;
  credentials per **D1**: `{SMD5}` hashes from the directory on the import branch,
  X3-format hashes only for a live local-hash-only cohort, federation config
  instead if D1 chose federation) + daemon directory rows keyed by the Keycloak
  UUIDs the import returns. **`registered` must survive byte-identical into
  `acc_create`** (§2 seam fact — needed for residual X3).
- opserv_level → PRIV mapping at oper-up (authority model §2.4) — small conf table.

*Proof on testnet:* register/verify/SASL Vitest suites against the hub; on the bed
(which already runs LDAP — §0), import a copy of `x3.db` + seeded directory,
then authenticate one account from **each credential class the census found**
through the D1-chosen path; confirm rehash-on-login in the realm (import branch);
AC stamps carry the imported timestamps. **Effort: 3-5 weeks. Confidence: high** —
most parts (kc client, m_register tail, SASL) already exist; credential-path
confidence inherits Phase 0's Gate-1 status.

### Phase 2 — Channel authority in the daemon (dev; the dominant item)

- Channel CFs (`chan`, `chan_by_name`, `grant`, `grant_by_acct`), stable channel ids,
  `chan_authorize` verb chokepoint with the verb→threshold table seeded from X3
  defaults (authority model §2.2).
- **Command surface, scoped** (not the 95-command matrix). Must-have for Window 1 to
  not regress a live network: registration lifecycle (register/unregister/move-as-
  rename under stable id), access management (adduser/deluser/clvl/access lists/
  giveownership with cooldown + audit), enforcement parity (`validate_op`-class
  checks, per-channel `lvlOpts` overrides), join automode **including burst/join-flood
  suppression parity** (`chanserv.c:8540`), persistent bans ("lamers") with join-time
  enforcement, channel + user suspensions, the core `set` options (defaulttopic,
  topicmask, modes/mode-lock, enf*, automode, pubcmd, dynlimit), `uset`
  autoop/autoinvite, info/access queries. **Converted but command-deferred:** notes
  (data carried, read-only surface later). **Dropped consciously:** toys, karma,
  seen/events (decide at converter time; per no-silent-defer, the drop list is written
  into the converter report).
- Registered-channel RENAME: local `chan_authorize(CV_RENAME)` on the hub; clean new
  S2S token replacing the colliding `AC ... R` query; `PendingRename` retained for
  leaf-origin requests.
- Converter **part B**: chanserv db → channel rows + grants (handle→UUID via part A's
  map; unresolvable handles → quarantine CF, never live), lvlOpts → per-channel verb
  overrides, lamers, suspensions, giveownership history; **modcmd db** per-command
  access overrides → verb-table overrides, with an explicit report of overrides that
  have no daemon analogue.

*Proof on testnet:* the authority-matrix sweep (scripted access ladder 1..500,
allow/deny boundary per verb, cross-server via leaf relay); rename allow/deny incl.
denial latency; automode under a full-topology cold restart with populated channels
(the burst case); **parity harness** — run one scripted command corpus against real X3
and against the daemon, diff outcomes; converter round-trip diff (convert → dump →
compare against source semantics). **Effort: 3-5 months. Confidence: medium** — the
scope cut is the lever; if parity chasing sets in, this is where the schedule dies.

### Phase 3 — Residual-X3 demotion package (dev)

What still runs after Window 1: OpServ (net-bans/trusts/alerts/routing), Global,
MemoServ, HelpServ, Snoop. All resolve accounts, so:

- **Config strip**: ChanServ nick omitted (hooks and bot vanish,
  `chanserv.c:10035-10044, 10225`); NickServ demoted — AUTH/REGISTER/PASS/SET/RENAME
  and friends **unbound via modcmd data** (the permission wiring is saxdb state;
  unbinding is data, not code), leaving it a passive AC consumer.
- **One small X3 patch**: AC-autocreate stub — on an AC stamp for an unknown handle,
  create a minimal `handle_info` (no password, registered-ts from the wire), modeled
  on the LDAP autocreate branch (`nickserv.c:5641+`) minus LDAP. This is the entire
  residual seam service: post-window accounts become memo-able/HelpServ-visible from
  first connect. Accepted limitations, documented: accounts never yet connected are
  invisible to residual bots; account rename stays disabled until Window 2 (staff-
  rare; avoids stranding memos/olevel); `opserv_level` changes during the residual
  period are hand-edits.
- Converter **part C**: the **trimmed `x3.db`** for residual X3 — nickserv section
  retained minus passwords (olevel, flags, registered-ts preserved so AC binding and
  the dual staff gate keep working), chanserv section dropped, opserv/global/memo/
  helpserv/gline/shun/modcmd sections carried through (modcmd with the demotion
  unbinds applied).

*Proof on testnet:* mixed bed — new daemons + demoted X3; pre-window account connects
and binds with **zero** timestamp warnings; post-window account gets stub-created on
first AC; memo send/read across both populations; OpServ command works for an
olevel'd oper; grep X3 logs for `"unknown account stamp"` = only never-connected
accounts. **Effort: 2-3 weeks. Confidence: high.**

### Window 1 — The authority cutover (production; accounts + channels + demotion)

See §5 for the runbook. Moves: account identity → Keycloak; account directory,
channel registrations, grants, enforcement, REGISTER/VERIFY, channel RENAME → hub
daemon; X3 → demoted residual (Phase 3 package).

### Phase 4 — Residue absorption (dev; scope decisions live here)

- **Net-ban persistence in the daemon** (glines/shuns/jupes survive whole-network
  restart without X3's saxdb copy) — required before OpServ dies (§0).
- Trusted-hosts (clone allowances) → daemon conf/store; alerts/discrim engine →
  **product decision**: port a subset, or accept loss (much of TRACE's action set
  exists as oper tooling already).
- Global messages → trivial daemon store + on-connect replay.
- MemoServ/HelpServ → product decision: port minimal memos into the daemon
  (account-to-account, they key cleanly on UUIDs), retire HelpServ or leave it as the
  single surviving X3 module until nobody notices it is gone.

*Effort: 2-3 months.* **Confidence: low-medium — scope is a set of product decisions
not yet made; the only hard technical item is net-ban persistence.**

### Window 2 — X3 retirement (production)

Small window: stop X3 permanently, daemons restart with net-ban persistence primary,
Global/memo data converted (converter part D, same harness). Rollback: restore the
trimmed `x3.db` + re-enable the residual container.

---

## 4. The offline converter

One tool, four output parts, all produced from a single read of a copied `x3.db`
plus (on the D1 import branch) an LDAP directory export, plus Keycloak import
responses for part A's UUIDs:

| Part | Input sections | Output | Consumed at |
|---|---|---|---|
| A | nickserv + LDAP export | Keycloak import payload (users, `x3_*` attributes, credentials per D1) + `acct`/`acct_by_name` rows | Window 1 |
| B | chanserv, modcmd | `chan`/`chan_by_name`/`grant`/`grant_by_acct` rows, verb-table overrides, quarantine CF | Window 1 |
| C | all | trimmed residual `x3.db` (passwords stripped, chanserv dropped, modcmd unbinds applied) | Window 1 |
| D | opserv, global, memoserv, gline/shun | daemon net-ban/global/memo stores | Window 2 |

**Correctness verification, all before any window (this is the heart of the
big-bang-safe strategy):**

1. **Census & go/no-go report** (Phase 0): counts per entity; **credential-state
   split** (LDAP-backed / local-hash-only / both / **neither** — a decades-old flat
   file will have rows matching nothing) with per-state activity distribution;
   local-hash format split (plain / `$`-salted / malformed); dangling references;
   every anomaly explained or the window does not open.
2. **Credential vectors from real data** (D1 import branch): extract live rows of
   every credential class from the copies, verify each authenticates through the
   deployed provider(s) in a rehearsal realm **on the LDAP-enabled bed**; include
   the case-sensitivity discriminator test if the X3 dual-format provider is built.
   (Federation branch: replace with a bind-path rehearsal against a directory copy.)
3. **Round-trip diff**: convert, dump the outputs, semantically compare against the
   source (every account, every grant, every lamer accounted for: migrated,
   quarantined, or on the written drop list — no fourth category).
4. **Parity harness** (Phase 2): identical command corpus against X3-with-source-db
   and daemon-with-converted-db; diff the outcomes.
5. **Idempotence/re-run**: the converter is re-run against a *fresh* copy taken at
   shutdown in the window itself; rehearsals prove that a re-run on newer data needs
   no human decisions (anomalies auto-quarantine and report).
6. **Full dress rehearsal** on the testnet with a production-shaped (ideally
   production-copy) `x3.db`: the entire §5 runbook end-to-end, twice, including the
   rollback rehearsal. **The window is not scheduled until a rehearsal has passed
   clean.**

Converter runtime is minutes at saxdb scale; Keycloak bulk import is the slow step
(**guess:** admin/partialImport throughput puts tens of thousands of users in the
10-30 min range — measure in rehearsal, it is on the window's critical path).

---

## 5. Window 1 runbook

Pre-window (days before): Keycloak infra live in production with an empty target
realm (if not already present — §Phase 0 guess); rehearsal passed clean on a recent
data copy; census go/no-go green; announcement out; image tags for old and new stacks
both pullable; rollback artifacts checklist printed.

1. **Close the network** (announce, stop client listeners or full stop). — T+0
2. **Stop X3 cleanly** (write-on-exit flushes saxdb), stop daemons. — T+5m
3. **Back up everything**: `x3.db`, **an LDAP directory export** (LDIF incl.
   `userPassword`), all configs, old image tags recorded, **Keycloak realm export**
   (the realm is about to be bulk-populated; realm restore is the rollback for it).
   — T+15m
4. **Run the converter** on the just-flushed `x3.db` + fresh directory export;
   census diff vs rehearsal copy — anomalies must be of already-explained classes or
   **abort here** (nothing has changed yet; abort cost is ~zero). — T+25m
5. **Credential step, per D1**: *import branch* — Keycloak import (part A), then
   spot-verify counts + a sampled login of each credential class via the
   provider(s); *federation branch* — enable/verify the LDAP federation config and
   sampled bind logins (directory stays up permanently). — T+25m..T+55m *(the
   measured-in-rehearsal step)*
6. **Install**: new daemon images + config (registrar flag on hub), registry env
   files (parts A/B) onto the hub, trimmed `x3.db` (part C) + demoted config for X3.
   — T+60m
7. **Start** Keycloak-dependent order per the deployment's topology; hub first, then
   leaves, then residual X3. — T+70m
8. **Smoke matrix** (scripted, from rehearsal): SASL login of a salted-hash account
   and a plain-hash account; REGISTER a new account end-to-end; join a registered
   channel as its owner → automode +o; access query; a denied and an allowed rename;
   an OpServ command as an olevel'd oper; memo between an old and a new account; X3
   log grep for `unknown account stamp` / timestamp warnings = zero for connected
   pre-window accounts. — T+70m..T+100m
9. **Reopen.** Watch the cold-start burst (automode storm risk, §7) with eyes on
   server logs and mode-change rates. — T+100m

**Window length: ~2 hours nominal, book 4.** Aborting at any step ≤5 is free; the
restore path (§6) is the exit from any later step.

---

## 6. Rollback

**Window 1, during the window:** stop everything; restore `x3.db` (step-3 backup),
old images, old configs; **restore the Keycloak realm export** (removes imported
users; if Keycloak was newly stood up, simply point nothing at it). The LDAP
directory is untouched by the cutover — on the import branch it was merely no
longer consulted — so rollback re-points nothing there; the step-3 LDIF export is
belt-and-braces. Restart old stack. Rehearsed in Phase 3/dress-rehearsal. Time:
~30 minutes.

**Window 1, after reopen:** same procedure, but every post-reopen write is lost —
registrations and password changes (now only in Keycloak/registry), grant changes,
memos to stub accounts. Declare the horizon explicitly in the announcement: e.g.
rollback remains on the table for 24-48h as a known-tradeoff decision, after which
forward-fix only. Note: rehash-on-login mutations inside Keycloak are *not* a
rollback problem — the realm restore reverts to the legacy-hash attribute and the SPI
still validates it.

**Window 2:** restore trimmed `x3.db` + residual X3 container + prior daemon config.
Cheap and low-drama; the daemons' net-ban store simply goes back to being secondary.

**Development phases:** git revert / testnet rebuild; nothing reaches production
between windows by construction.

---

## 7. What is most likely to go wrong (ranked)

1. **The post-cutover cold-start burst.** The window *ends* with a whole-network
   restart: every user and channel bursts at once into the brand-new in-daemon
   ChanServ — automode, enforcement, lamer checks — in its first minute of life,
   exercising exactly the suppression logic (`chanserv.c:8540` parity) that normal
   testing exercises least. Failure mode: mode storm / enforcement fight / hub CPU
   spike at the worst possible moment, in front of the whole network. Mitigation:
   Phase 2's populated-bed cold-restart test is mandatory, and the dress rehearsal
   must include a full-topology restart with realistic channel population.
2. **~~The testnet/production auth divergence~~ — STRUCK.** The bed does run LDAP
   (`.env.local:38`, §0); this risk was based on a stale `data/x3.conf` and does not
   exist. What remains is far smaller: confirm the bed's directory hash scheme
   matches production's, or the credential rehearsal proves the wrong scheme.
3. **Data variance in a decades-old flat file / directory** — accounts in the
   "neither" credential state, rows matching no hash format, dangling grant
   references, encoding oddities — surfacing in the window instead of before it.
   Mitigation: the census go/no-go + step-4 abort (which is free).
4. **Hash-provider dispatch subtleties** (if the import branch builds providers:
   case-insensitive compare masking X3-format misdetection; SMD5 salt-extraction
   edge cases). Mitigation: the explicit discriminator tests + real-vector logins in
   rehearsal.
5. **Keycloak import running long** and eating the window (import branch).
   Mitigation: measured in rehearsal; the runbook books 2x.

---

## 8. CRDT-mesh timing constraint (noted, not solved)

The parallel branch at `/home/ibutsu/testnet/nefarious-crdt` merges periodically from
this daemon's line. Constraints it imposes on *when and how* this program lands:

- Keep absorption code in **new files behind narrow seams** (registry, chan_authorize,
  the responder module); smearing authority logic through `channel.c`/`s_user.c`
  bleeds into every mesh sync.
- Land in **few, coarse, self-consistent commits** at phase boundaries; long-lived
  half-states on the prod branch are carried by every mesh merge in between.
- **Do not invent a rival replication protocol** for the registry. The single-
  registrar topology (§1) is deliberate: registry entities are stable-id/LWW-shaped
  (authority model §6) precisely so mesh replication can subsume them later; any
  interim homegrown sync would be thrown away and would collide with mesh semantics.
- Coordinate merge points: a large absorption merge landing mid-mesh-milestone is the
  expensive case; phase boundaries are the cheap ones.

---

## 9. Effort and confidence summary

| Phase | Effort (engineering) | Confidence |
|---|---|---|
| 0 — SPI + converter skeleton + census | 1-2 weeks | High |
| 1 — Account authority | 3-5 weeks | High (most parts exist) |
| 2 — Channel authority | **3-5 months** | Medium (scope discipline is the risk) |
| 3 — Demotion package | 2-3 weeks | High |
| Dress rehearsals | 1-2 weeks calendar | High |
| **Window 1** | 2h nominal / 4h booked | Medium-high after clean rehearsal |
| 4 — Residue absorption | 2-3 months | Low-medium (product decisions pending) |
| **Window 2** | ~1h | High |

Calendar to Window 1: **~6-9 months** from start, dominated by Phase 2. Window 2:
roughly +3 months after.

**Before committing to any of that, run Gate 1b** (Phase 0): if the Keycloak
`editMode: WRITABLE` flip makes account registration work today, the presenting
pain that motivated this programme is gone, and the whole thing proceeds on its
own merits — self-contained deployment and channel authority — rather than under
schedule pressure from a broken feature. It does not shrink the estimates below;
it changes whether they need to be spent now. An afternoon.

Marked guesses/assumptions: **production runs `ldap_enable 1`** and **the directory
stores `{SMD5}`** — both user-reported, not observed (the *testnet's* LDAP topology
is now observed, §0); confirming them is Phase 0 Gate 1 and the credential track
branches on the answer. Also: production Keycloak status (§Phase 0); the D1
federation-vs-import decision (recommended: import, pending ratification);
Keycloak import throughput (§4); `x3.db`/directory scale in production; whether
prod's modcmd db carries extensive per-command overrides (affects converter part
B's report size); network ratification of the single-registrar topology (§1); MOVE
semantics under stable channel ids (should collapse into rename — verify against
real MOVE usage).

## 10. X3's disposition at each stage (summary)

| Stage | X3 state |
|---|---|
| Phases 0-3 (dev) | Untouched in production; testnet runs both stock and demoted variants |
| Window 1 | Restarted demoted: ChanServ off (config), NickServ = passive AC consumer + autocreate stub, passwords stripped from its db; OpServ/Global/MemoServ/HelpServ/Snoop live |
| Between windows | Demoted residual, account rename frozen, olevel changes by hand-edit |
| Window 2 | Gone |
