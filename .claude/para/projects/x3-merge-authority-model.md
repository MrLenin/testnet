# Authority & Data Model for Absorbing Services into the IRCd

Independent design, 2026-07-30. Written from code on `nefarious` @ `ircv3.2-hardening`
and `x3` @ `master`, deliberately without consulting prior planning docs.

> **Read `x3-merge-sequencing.md` first — it is the plan of record.** This document
> predates the big-bang-per-phase deployment constraint, so read its migration and
> replication remarks through that one. The *design* here is unaffected: the entity
> and authority model does not change with deployment style, and a reconciliation
> pass found no dual-writer or live-coexistence assumptions baked into it.
>
> Two points this document makes are corroborated from the operational side in the
> sequencing doc: keying by stable identity rather than name (§2.3 there shows X3's
> name-keyed access rows producing a live privilege-escalation path once the daemon
> can rename accounts), and Keycloak as identity authority (the deployment already
> federates Keycloak from the LDAP directory that X3 writes to and binds against).

Forcing functions: (a) `draft/account-registration` (`ircd/m_register.c`),
(b) `draft/channel-rename` for +R channels (`ircd/m_rename.c`). Both are blocked
not on missing wire handlers but on the absence of a single authority for
account identity and channel privilege. This document proposes that authority
model.

---

## 0. Ground truth (what the code actually does today)

Read this section as the evidence base; every later argument leans on it.

**Registration relay is a dead letter.** `m_register()` validates locally and
relays `RG` / `VF` P10 tokens to any `+s` server
(`nefarious/ircd/m_register.c:114-116, 133-135`), expecting an `RR` (REGREPLY)
back (`ms_regreply`, `m_register.c:368`). X3 has **no** handler for RG, VF, or
REGREPLY — `grep -rni 'regreply|"RG"|"VF"' x3/src/` finds nothing; X3's P10
dispatch table (`x3/src/proto-p10.c:2831-2832` and surrounding
`dict_insert(irc_func_dict, ...)` block) registers no such tokens. The request
vanishes and the client times out.

**Rename authorization is not merely unanswered — it is misparsed.** For a
+R channel, `m_rename()` sends
`AC <usernum> R <cookie> <chan> RENAME <newname>`
(`nefarious/ircd/m_rename.c:435-437`) and parks a `PendingRename` with a 10s
timeout (`m_rename.c:55-75`). But in X3's `cmd_account()`, subcommand `R`
means "account stamp with timestamp" and does
`call_account_func(user, argv[3])` (`x3/src/proto-p10.c:1732-1733`), where the
registered function is nickserv's `handle_account()`
(`x3/src/nickserv.c:5562`, registered at `nickserv.c:6133`). So X3 attempts to
log the *requesting user* in as account "`<cookie>`". Meanwhile Nefarious's own
inbound `AC ... R` means "X3 stamps a user's account + timestamp"
(`nefarious/ircd/m_account.c:250-267`; X3 emits it at
`x3/src/proto-p10.c:653`). One token letter, three meanings, zero working
paths. The reply path Nefarious listens on (`AC <cookie> A/D` →
`pending_rename_find`, `m_account.c:337-357`) is never exercised.

**The privilege data lives only in X3's process memory + saxdb.** Channel
access is `struct userData { struct handle_info *handle; unsigned short
access; time_t expires, accessexpiry; ... }` chained per-channel and
per-account (`x3/src/chanserv.h:137-157`), against the scale
`UL_PEON=1, UL_HALFOP=150, UL_OP=200, UL_MANAGER=300, UL_COOWNER=400,
UL_OWNER=500, UL_HELPER=600` (`x3/src/chanserv.h:26-34`), with per-channel
action thresholds in `chanData.lvlOpts[]` (`chanserv.h:112`). Accounts are
`struct handle_info` with MD5-crypt password, email, opserv_level, owned
nicks, flags (`x3/src/nickserv.h:93-120`). The IRCd sees none of this; it
knows only the account *name* stamped on a user
(`nefarious/include/struct.h:93-94`: `account[ACCOUNTLEN+1]` +
`acc_create`; `ACCOUNTLEN` is 15, `include/ircd_defs.h:71`).

**The IRCd already authenticates against Keycloak, in-process.** SASL PLAIN
verifies via `kc_user_verify_password()` (`nefarious/ircd/sasl_auth.c:876`),
SCRAM and ECDSA fetch credentials via `kc_user_get()`
(`sasl_auth.c:1509, 1758`). The libkc client offers lookup, search, create,
delete, update, password set, group ops
(`nefarious/include/kc/kc_keycloak.h:147-191`), fully async over the ircd
event loop (`nefarious/ircd/ircd_kc_adapter.c:1-23`). Notably, `struct
kc_user` already models X3-derived attributes: `opserv_level` from
`x3_opserv_level`, SCRAM credentials from `x3_scram_*` attributes, and a
Keycloak `id` (UUID) (`kc_keycloak.h:58-78`) — evidence that this deployment
already pushes X3 account material *into* Keycloak, one way.

**X3's only external identity hook is LDAP, not Keycloak.** `x3/src/x3ldap.h:25-37`
(`ldap_check_auth`, `ldap_do_add`, `ldap_rename_account`, ...), used from
nickserv with optional writeback (`x3/src/nickserv.c:1167-1169, 2146-2147`).
This is deployment glue (Keycloak can federate an LDAP), not a sync protocol:
it covers credentials/existence at best, and nothing about channel state.
Per the corrected brief, treat the two account stores as **unable to sync**;
the LDAP path does not change that conclusion, it only softens one migration
edge.

**Everything the IRCd persists today is keyed by mutable *name*.**
- chathistory: key `target\0timestamp\0msgid` (`nefarious/ircd/history.c:26,
  101-135`), target = channel name or nick pair.
- metadata: key `account\0key` / `#channel\0key`
  (`nefarious/ircd/metadata.c:30-31, 3222`).
- bouncer sessions: keyed by `bsr_account` name with a version byte
  (`nefarious/ircd/bouncer_session.c:3229`).
- `rename_channel()` updates only the in-memory hash table and struct
  (`nefarious/ircd/channel.c:2050-2130`); **no persisted store is migrated on
  rename** — a renamed channel silently orphans its history and metadata
  today. This is the single strongest piece of evidence for the keying
  decision in §1.

**Mode +R is already services-gated.** `MODE_REGISTERED` (`0x2000`,
`nefarious/include/channel.h:125`) can only be set with `MODE_PARSE_FORCE`
(`nefarious/ircd/channel.c:4710`), i.e. by services or oper force. The daemon
becoming the registrar means the daemon becomes the legitimate setter.

**The storage layer is a clean KV abstraction over RocksDB.**
`db_env_open`/`db_cf_open` (`nefarious/include/db_env.h:61-82`), owned-value
gets and result codes (`include/db_types.h`), atomic multi-CF write batches
and snapshots — explicitly designed for the single-threaded event loop, no
MVCC needed (`nefarious/include/db_txn.h:1-25`). Three envs exist today:
history (`history.c:724`), metadata (`metadata.c:254`), webpush
(`webpush_store.c:141`).

---

## 1. Entity model

Four persistent entities, one ephemeral. **None of this exists yet** — the
daemon currently persists no account or channel-registration state at all.

### 1.1 Account (directory record)

The daemon-local anchor for an identity that Keycloak authenticates.

- **Primary key: Keycloak subject UUID** (`kc_user.id`,
  `kc_keycloak.h:59-60`). Immutable, globally unique, minted by the identity
  authority.
- Attributes: canonical account name (≤ `ACCOUNTLEN`=15, normalized
  case-fold), `registered_ts` (unified from X3 `handle_info.registered` /
  KC `created_at`), cached email, cached `opserv_level`, flags
  (suspended, no-expire...), `last_seen`, schema version byte.
- **Secondary index: `name → uuid`**, unique. The wire (P10 `AC`,
  `cli_user()->account`) speaks names; every authz evaluation does one hash
  lookup through this index.

Why UUID-primary rather than name-primary: account rename exists in the
current world (`x3/src/x3ldap.h:29 ldap_rename_account`; X3's
`cmd_account` `M` subcommand, `x3/src/proto-p10.c:639`) and Keycloak
usernames are mutable. If grants (§1.3) referenced names, an account rename
would require rewriting every grant row or would silently orphan privileges —
exactly the failure mode the name-keyed history/metadata stores already
exhibit for channels. Cost: one extra lookup per evaluation (in-memory cached,
see §4), and a hard rule that **no grant can exist before Keycloak has issued
the UUID** — acceptable, since account creation goes through Keycloak anyway
(§3).

### 1.2 RegisteredChannel

- **Primary key: stable channel id** — a 64-bit random id minted at
  registration (not the name).
- Attributes: current name, `founder_uuid` (Account FK), `registered_ts`,
  flags (suspended...), mode-lock (the subset of `chanData.modes`,
  `x3/src/chanserv.h:90`, worth keeping), optional description/registrar.
- **Secondary index: `name → channel_id`**, unique among registered channels.

**Name vs stable identity — argued explicitly.** Keying by name is what X3
does (`chanData` is reached from the `chanNode` by name) and is simpler: no
index, the wire key *is* the storage key. But this design's own forcing
function (b) is channel **rename**, and the codebase already demonstrates the
cost of name-keying under rename: `rename_channel()`
(`channel.c:2050`) migrates nothing persistent, so history
(`history.c:26`) and metadata (`metadata.c:30`) are orphaned. If registration
state were name-keyed, RENAME on a registered channel would have to
delete-and-recreate the registration plus every grant row atomically — a
multi-row identity change that is also the worst possible shape for
replication (§6): remote servers cannot distinguish "renamed" from
"dropped and re-registered by someone else."

With a stable id, rename is a two-write attribute update (row update + index
swap) inside one `db_writebatch` (`db_txn.h:10-16`), grants never move, and
the operation replicates as an LWW attribute change. What it costs: every
name lookup goes through the index; the in-memory `struct Channel` needs a
cached `reg_id` field (new) so hot paths don't hit the index at all; and the
existing name-keyed stores (history, metadata, bouncer) remain broken across
renames until they, too, migrate to the id — that migration is **out of scope
here but is now possible**, which name-keying would foreclose. I choose the
stable id.

### 1.3 AccessGrant

- **Primary key: composite `(channel_id, account_uuid)`.**
- Attributes: `level` (uint16, X3 scale), `granted_by` (uuid), `granted_ts`,
  `expires` / `accessexpiry` (both exist in X3, `chanserv.h:144-146`), flag
  bits (auto-op / auto-invite / auto-join, `chanserv.h:124-135`).
- **Secondary index: `account_uuid → (channel_id)`** — X3 maintains exactly
  this dual chaining in memory (`userData.prev/next` per channel,
  `u_prev/u_next` per handle, `chanserv.h:152-157`); we need it for "list my
  channels," account deletion, and expiry sweeps.

The founder is *also* representable as a level-500 grant; I keep
`founder_uuid` denormalized on the channel row because ownership transfer is
an audited, singular event in X3 (`chanData.giveownership`,
`chanserv.h:119`) and "who is the owner" must be answerable without a scan.
Invariant: the founder row and the level-500 grant are updated in the same
write batch.

### 1.4 ChannelSuspension / note records — deferred

X3 carries suspensions, bans ("lamers"), notes per channel
(`chanserv.h:116-118`). Model them later as child records keyed
`(channel_id, ...)`; nothing in the forcing functions needs them. Written
down here per no-silent-defer.

### 1.5 VerificationCookie (ephemeral, local-only)

For REGISTER email verification: key `name`, value `(code, uuid-pending,
expiry)` — the analogue of X3's `handle_cookie` (`x3/src/nickserv.h:79-85`).
Short-TTL, never replicated, lives in the daemon's registry env or purely in
memory. Alternative: delegate entirely to Keycloak's built-in email
verification (`kc_user.email_verified` exists, `kc_keycloak.h:65`) — see
open questions (§7).

### 1.6 What is deliberately *not* an entity

- **Nick ownership** (`x3/src/nickserv.h:122-128`). Accounts, not nicks, are
  the identity primitive in the ircu/P10 world the daemon already lives in.
  Dropping nick registration is a real feature regression versus X3 and needs
  a product decision; the model does not require it either way, since a
  NickRecord would just be another `name → account_uuid` table.
- **X3's cosmetic/behavioral account baggage** (epithet, infoline, fakehost,
  table_width..., `nickserv.h:104-115`): becomes account *metadata* in the
  existing metadata store (`account\0key`, `metadata.c:30`), not schema.

---

## 2. Authority model

### 2.1 The question

"May user U perform action A on channel C / account T?" must be answerable
**locally, synchronously, from daemon-owned state** — the entire pathology of
today's design is that this question crosses a P10 boundary and dies there
(§0). The kc client is async by construction (`ircd_kc_adapter.c`), which is
fine for authentication (SASL already parks the client) but disqualifies
Keycloak from the per-command authorization path.

### 2.2 Faithful numeric port vs alternatives

*Option 1 — verbatim numeric scale.* Store `access` 1..500, compare against
per-action thresholds, port `lvlOpts[]`. Pro: lossless migration of every
existing access list; the scale is the network's operating culture; total
ordering gives "may act on lower-level users" for free. Con: magic numbers in
authorization code; thresholds scattered per call site (X3's actual bug
surface); >500 staff levels conflate channel authority with network staff.

*Option 2 — fixed named roles* (owner/coowner/manager/op/halfop/peon). Pro:
legible. Con: it is exactly the numeric scale with the numbers hidden —
X3's `UL_` enum *is* the role list — and it destroys X3's between-level
grants (access 250 exists in the wild) so migration becomes lossy.

*Option 3 — capability sets per grant.* Maximally expressive, maximally
incompatible: no ordering (so no "act on lower" rule), unmappable from
existing data without inventing policy, and a UX cliff.

**Choice: numeric storage, verb-mediated evaluation.** Grants store the raw
X3 number (lossless migration). No caller ever compares numbers; all
authorization flows through one chokepoint:

```c
/* proposed; does not exist */
enum chan_verb { CV_RENAME, CV_SET_MODELOCK, CV_EDIT_ACCESS,
                 CV_TRANSFER, CV_UNREGISTER, CV_SET_TOPIC_LOCKED, ... };
int chan_authorize(const struct Client *u, const struct Channel *c,
                   enum chan_verb v);
```

with a default verb→threshold table seeded from X3's defaults, later
per-channel overridable (the `lvlOpts` mechanism, `chanserv.h:112`, ports
into a small map on the channel row). This keeps the migration faithful,
gives the codebase one auditable authorization function, and leaves room to
evolve past the scale without a flag day.

Evaluation order inside `chan_authorize`:
1. resolve requester identity: `cli_user(u)->account` → uuid (directory
   index; in-memory cache);
2. oper override check (§2.4);
3. grant lookup `(c->reg_id, uuid)`, expiry-checked;
4. `level >= threshold[verb]` (channel override, else default);
5. founder always passes.

### 2.3 Interaction with IsChanOp (+o prefix status)

Two authority planes, deliberately kept distinct:

- **Ephemeral plane** — prefix status (+o/+h/+v) on a live membership. It
  continues to govern classic channel operations (KICK, MODE, TOPIC, INVITE)
  exactly as today, and remains the *only* authority on unregistered
  channels — `m_rename.c:395` (`IsChanOp` gate) stays as-is for the -R case.
- **Persistent plane** — grants, governing *administrative* verbs on
  registered channels (§2.2 verb list). Holding +o does **not** grant these:
  this matches the existing intent, since `m_rename.c:414` already refuses to
  let a mere chanop rename a +R channel without services' blessing. And a
  grant does not confer live +o by itself.

Bridge between the planes: the auto-op projection. X3's `USER_AUTO_OP`
(`chanserv.h:127,130`) becomes daemon-native: on JOIN to a registered
channel, an unexpired grant ≥ `UL_OP` (auto-op flag set) yields +o, ≥
`UL_HALFOP` yields +h. This is where users *experience* their access; it also
means a netsplit-rejoined owner re-ops without services being alive — an
availability improvement over X3.

### 2.4 Interaction with oper privileges

The daemon has a real per-oper privilege system (`PRIV_*`,
`nefarious/include/client.h:121-160`) with an existing precedent for
override-services powers (`PRIV_FORCE_OPMODE`, `client.h:150`). Extend it —
do not build a second staff scale:

- new `PRIV_CHANREG_ADMIN`: bypasses `chan_authorize` (logged), can
  unregister/transfer any channel;
- new `PRIV_ACCOUNT_ADMIN`: account suspend/rename/delete surface.

X3's staff tiers above `UL_OWNER` (`UL_HELPER=600` etc., `chanserv.h:34`) and
per-account `opserv_level` (`nickserv.h:112`) **map into PRIVs at oper-up**,
not into channel grants. The plumbing half-exists: `kc_user.opserv_level`
already arrives from Keycloak (`kc_keycloak.h:66`); a small
`opserv_level → priv-set` table in ircd.conf closes it. Channel grants are
capped at 500; numbers above 500 are migrated as flags on the *account*, not
grants.

---

## 3. Where identity comes from

### 3.1 The single-authority requirement

Today there are two account stores that cannot sync: X3's saxdb
(`handle_info`, MD5-crypt passwords, `nickserv.h:118`) and Keycloak (reached
only by the daemon, `sasl_auth.c:876`). An account created in either alone is
an orphan in the other — Keycloak-only accounts authenticate but own nothing;
saxdb-only accounts own things but (in the daemon-mediated flows) can't be
verified. **This is the actual blocker for REGISTER**, not the missing RG
responder: implementing the responder would just mint more split-brain
accounts.

**Decision — split the word "authority" along the domain boundary:**

- **Keycloak is the sole authority for account identity**: existence,
  canonical name, credentials, email + verification state, group membership.
  All authentication already terminates there; account *creation* will too
  (`kc_user_create`, `kc_keycloak.h:156`).
- **The daemon is the sole authority for the IRC domain**: channel
  registrations, access grants, founder-ship, channel policy, and the
  account *directory* row that anchors them (§1.1).
- **X3's saxdb becomes a migration source, then is retired.** It is never a
  peer authority again. During any transition window where X3 still runs, it
  must be demoted to a consumer (trust `AC` stamps it did not issue) or fed
  through the existing LDAP federation (`x3ldap.c`) as a read-mostly mirror —
  but no new writes originate there.

So: **channel ownership hangs off daemon-local state keyed by the Keycloak
identity** (grants reference the KC UUID). Neither store alone holds the
whole truth, and that is by design: Keycloak cannot express channel access
(groups/attributes are the wrong shape and the wrong latency), and the daemon
should not hold credentials.

### 3.2 Keycloak unavailable

The seam is authentication vs authorization:

- **Authentication degrades** — new SASL sessions fail. This is already true
  today (`sasl_auth.c:876` has no fallback verifier), so no regression.
- **Authorization survives** — `chan_authorize` (§2.2) reads only the
  RocksDB directory + grants. A user already authenticated (or riding a
  bouncer session, which persists account anchoring across the outage,
  `bouncer_session.c`) keeps full control of channels they own. Channel
  access does *not* die with the identity store.

Therefore the daemon's account directory is **a durable cache of identity
attributes but the system of record for the IRC domain**. One consequence to
accept openly: with Keycloak down, REGISTER (account) and first-time
name→uuid resolution fail closed. Writes to identity require the identity
authority; that is the correct failure.

### 3.3 The existing split population

Migration states and their disposition (one-shot importer reading saxdb dumps
+ `kc_user_search`, `kc_keycloak.h:153`):

| State | Disposition |
|---|---|
| **saxdb-only** | Create in Keycloak (`kc_user_create`) carrying legacy credentials as attributes — the deployment already does exactly this shape for SCRAM (`x3_scram_*` attributes read back in `kc_keycloak.h:69-73`); MD5-crypt hashes (`nickserv.h:118`) go in as a legacy-hash attribute, verified-then-upgraded on first login, or force password-reset by policy. Then create directory row with the new UUID; import grants. |
| **Keycloak-only** | Already canonical. Directory row is created lazily on first successful auth (uuid, name, `created_at`). They stop being second-class the moment the daemon, not X3, answers channel authority — they simply have no grants yet. |
| **Both, diverged** | Join on normalized name. Keycloak wins every identity field (credentials, email, verification). saxdb wins every IRC-domain field (channel access → grants, opserv_level → PRIV mapping, registered-ts = min of the two, cf. `handle_info.registered` `nickserv.h:108` vs `kc_user.created_at` `kc_keycloak.h:77`). Conflicts (different emails, name-case fights) are logged to an operator review file, never auto-deleted. |

Grants import: for each X3 `userData`, resolve handle → UUID via the
directory; unresolvable handles (dangling saxdb refs) import into a quarantine
CF, not the live grants CF.

---

## 4. Storage

**Verdict: the existing RocksDB abstraction is a suitable home, with one new
env and modest conventions — no new capabilities required.**

What it already provides that this model needs:
- named column families in an isolated env (`db_env.h:61-82`) — precedent:
  three independent envs with their own tuning (`history.c:724`,
  `metadata.c:254`, `webpush_store.c:141`);
- **atomic multi-CF write batches** (`db_txn.h:10-16, 38+`) — required for
  every operation here that touches a row and its secondary index (channel
  rename, account rename, grant + founder update), and explicitly designed
  for the single-threaded event loop, so no locking questions;
- snapshots + iterators for consistent scans (expiry sweeps, "list my
  channels") (`db_txn.h:18-24`, `db_cursor.h`);
- durable-sync control (`db_env_sync`, `db_env.h:89`) for
  registration-grade writes (unlike history, this data is precious — sync
  batches on registration/transfer, not on every last-seen touch).

Proposed layout — new env `registry` (fourth env), CFs:
```
acct          : uuid(16)                  → account record (versioned)
acct_by_name  : casefold(name)            → uuid
chan          : chan_id(8)                → channel record (versioned)
chan_by_name  : casefold(name)            → chan_id
grant         : chan_id(8) . uuid(16)     → level, flags, ts, expiry
grant_by_acct : uuid(16) . chan_id(8)     → (empty; key-only index)
cookie        : casefold(name)            → code, expiry   [optional, §1.5]
meta          : "schema"                  → version
```

Conventions it needs (all precedented in-tree):
- **versioned record encoding** — the abstraction is schemaless; bouncer
  already prefixes a `BOUNCER_DB_VERSION` (`bouncer_session.c:3229`). Do the
  same, fixed-width packed structs with a leading version byte.
- **manual secondary-index maintenance** — RocksDB CFs don't self-index; the
  dupsort flag is explicitly advisory-only on RocksDB (`db_env.h:38-41`).
  Every index write rides the same write batch as its primary row; a startup
  scan can verify index ↔ row agreement cheaply at this data size.
- **in-memory cache as the hot path**: at this volume (thousands of channels,
  not millions), load `acct_by_name`, `chan_by_name`, and per-channel grant
  lists into hash tables at boot (like X3 does from saxdb), treat RocksDB as
  the durable log. `chan_authorize` then never touches disk. A new
  `reg_id` field cached on `struct Channel` avoids even the name lookup.

Not suitable / out of scope for this layer: multi-server visibility. The env
is strictly per-server-local; see §6.

---

## 5. The forcing functions, re-derived under this model

### 5.1 Account registration (a)

New flow (replaces the RG/VF relay wholesale):

1. `m_register` keeps its local validation (`m_register.c:171-221`) and adds
   a directory check: `acct_by_name` hit → immediate `FAIL REGISTER
   ACCOUNT_EXISTS` with zero network traffic.
2. Instead of `send_register_rg`, call `kc_user_create(name, email, password,
   cb, ctx)` (`kc_keycloak.h:156`) — async over the existing adapter; the
   pre-registration client is parked exactly as SASL parks it. The
   `server!fd.cookie` self-reference machinery (`m_register.c:110-116,
   297-352`) becomes unnecessary for local completion (keep
   `find_prereg_client` only if a relay mode is retained for
   non-Keycloak-built leafs).
3. If verification policy demands email confirmation: create a
   VerificationCookie (§1.5), reply `VERIFICATION_REQUIRED`; `m_verify`
   checks the cookie locally and flips `email_verified` via `kc_user_update`
   (`kc_keycloak.h:164`).
4. On Keycloak success: write the directory row `(uuid, name, now)` in a
   sync'd batch, then complete login through the **already-working local
   tail**: `ms_regreply`'s success arm does exactly this today —
   `cli_saslaccount` + `SetSASLComplete` for pre-reg clients, direct
   `SetAccount` + `metadata_load_account` + ACCOUNT-notify for post-reg
   (`m_register.c:415-445`). That code is reused as-is; only the trigger
   changes from "P10 reply that never comes" to "kc callback."
5. Network propagation is the normal timestamped `AC` the daemon already
   emits/forwards (`m_account.c:477-479`).

Unblocked? Yes, and specifically the *orphan* problem is gone: the account is
born in the single identity authority (Keycloak) and its IRC-domain anchor
(directory row) in the single IRC authority (the daemon) in one flow. No
services-side database exists to disagree. Transition caveat: a still-running
legacy X3 will not know the account until it consumes the LDAP federation or
trusts foreign `AC` — that is a property of the transition window, not of the
end-state model.

### 5.2 Registered-channel rename (b)

New flow in `m_rename` for the `MODE_REGISTERED` branch (`m_rename.c:414`):

1. `chan_by_name[oldname]` → `chan_id` (or the cached `chptr->reg_id`).
2. `chan_authorize(sptr, chptr, CV_RENAME)` — synchronous, local (§2.2).
   Proposed default threshold: `UL_COOWNER` (400); X3 has no rename
   precedent, so this is policy, flagged in §7.
3. On pass: one write batch — update `chan.name`, delete
   `chan_by_name[oldname]`, put `chan_by_name[newname]` (refuse if the new
   name is already a *registered* channel, distinct from the live-channel
   check at `m_rename.c:407`); then the existing in-memory + wire tail
   unchanged: `rename_channel` (`channel.c:2050`), `send_rename_to_members`,
   `sendcmdto_serv_butone_v3` (`m_rename.c:449-469`).
4. The entire `PendingRename` cookie/timeout apparatus
   (`m_rename.c:52-303`) and the colliding `AC ... R` query
   (`m_rename.c:435-437`) are **deleted** — the decision no longer crosses a
   process boundary, so there is nothing to await, time out, or misparse
   (§0's `call_account_func(user, "<cookie>")` hazard dies with it).
5. `ms_rename` (remote-origin renames) additionally updates the local
   registry copy by `reg_id` — trivially safe *because* the registration is
   not keyed by name (§1.2); under name-keying this step would be a
   delete/recreate race against the propagation order.

Unblocked? Yes: the daemon can answer "is this user privileged enough on this
registered channel" from its own grants table, which is precisely the
knowledge whose absence forced the dead P10 round-trip.

### 5.3 Explicitly not solved by this document

Registration/unregistration of *channels* (`CV_UNREGISTER`, setting
`MODE_REGISTERED` via the daemon as the now-legitimate `MODE_PARSE_FORCE`
setter, `channel.c:4710`), ownership transfer UX, and the migration of the
name-keyed history/metadata stores onto `chan_id` (§1.2) are consequences of
the model, listed as follow-on work.

## 6. Replication (flagged, not solved)

The registry env is per-server. On a multi-server network the model needs:

- **Burst + steady-state sync** of directory rows, channels, and grants —
  either a services-style single-writer (one daemon is the registrar, others
  hold read replicas and forward writes; simplest, but reintroduces a
  services-shaped availability choke) or true multi-writer replication with
  convergence rules.
- **Friendly to replication in this model:** stable ids everywhere — a
  channel rename or account rename is an LWW attribute update on an immutable
  key, and grants are naturally last-writer-wins registers keyed
  `(chan_id, uuid)`. Keycloak being a single shared external store means
  account *identity* needs no IRC-side replication at all — only the
  directory cache rows, which any server can (re)derive from Keycloak.
- **Hostile to replication, called out plainly:**
  1. **The unique name indexes.** `acct_by_name` and `chan_by_name` are
     first-claimant-wins registers; two servers accepting REGISTER for the
     same name during a netsplit produce a merge conflict with no good
     automatic answer (for accounts, Keycloak's own uniqueness arbitrates *if
     both sides could reach it* — under a split from Keycloak, registration
     fails closed anyway (§3.2), which conveniently narrows the account race;
     **channel registration has no such external arbiter** and needs either a
     single-registrar rule or a deterministic tiebreak + notify-loser
     protocol).
  2. **VerificationCookies** are server-sticky; a client that REGISTERs on
     one server and VERIFYs on another fails unless cookies replicate or the
     flow is pinned (or delegated to Keycloak's email flow, sidestepping it).
  3. **`expires`/`last_seen` touches** are high-frequency low-value writes;
     replicating them naively is chatty — they should be batched/period-
     synced, unlike registration-grade writes.

## 7. Least-sure list (own doubts, plainly)

1. **UUID-keyed grants vs name-keyed everything else.** The wire, `struct
   User`, bouncer sessions (`bouncer_session.c:3229`), and metadata
   (`metadata.c:30`) all speak account *names*; this design introduces a
   second account key and a permanent name↔uuid seam. I believe the rename
   robustness and Keycloak anchoring justify it, but the mixed-keying period
   (grants by uuid, sessions/metadata by name) is a standing source of
   drift bugs until the older stores migrate.
2. **Email verification ownership.** Daemon-local cookies (§1.5) vs
   Keycloak's native email-verification flow. Keycloak-native removes the
   server-sticky replication wart (§6.2) but couples VERIFY UX to Keycloak's
   mailer and makes the IRC `VERIFY <code>` command awkward
   (Keycloak verifies via emailed link, not a short code the daemon can
   check). I lean daemon-cookie + `kc_user_update(email_verified)` but have
   not validated Keycloak-side constraints on setting that flag via the
   admin API.
3. **The transition window with a live X3.** Demoting X3 to a consumer of
   foreign `AC` stamps and LDAP-federated identity is asserted, not designed;
   X3's `cmd_account` trusts only its own database today
   (`proto-p10.c:1672-1737`), and the `AC` subcommand-letter collisions (§0)
   show how fragile that channel is. If the cutover cannot be a hard flag
   day, this needs its own protocol design.
4. **CV_RENAME threshold (400) and the verb→threshold defaults generally**
   are invented policy — X3 has no rename to copy from; network operators
   should ratify the table before it hardens.
5. **In-memory-cache-at-boot** (§4) assumes registry volume stays
   X3-saxdb-sized. If a network's registered-channel count breaks that
   assumption, the cache becomes partial and `chan_authorize` grows a
   (fast) RocksDB fallback path — the API shape survives, the latency claim
   weakens.
