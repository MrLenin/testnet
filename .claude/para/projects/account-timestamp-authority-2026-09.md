# The account timestamp: a delete detector that was disabled mid-migration

**Status:** design approved 2026-09-22, not yet implemented
**Scope:** x3 (`upstream/master`), nefarious bouncer + webhook consumer, Keycloak SPI.
*Originally also libkc/SASL, the Keycloak realm mapper and a seeding migration — all
withdrawn by design E.*

## Thesis

X3's account timestamp was never a registration date as far as authentication was
concerned. It was a **delete detector**: *wire TS newer than saxdb ⇒ the LDAP account was
destroyed and recreated ⇒ different principal ⇒ do not auth into the saxdb handle.*

That detector is currently disabled, and the code that disabled it silently overwrites the
evidence. Both live symptoms — destroyed registration dates and the name-reuse escalation
— are the same defect seen from two sides.

The fix is not to repair the detector. It is to **finish the migration it was disabled
for**: give X3 a reliable way to learn that an externally-managed account was deleted, and
then retire the timestamp check, which is what the migration always intended.

## Origin — this was deliberate, and the reasoning was sound

Not a blunder. The record should be clear on this, because the design only makes sense
once you know why the interim state exists.

**The original premise: X3 was the only writer that could delete an LDAP entry.** dokuwiki's
`authldap` has `modPass` only — no `createUser`, no `deleteUsers`. So saxdb and the
directory were inherently in step, and the timestamp detector worked because X3 controlled
both sides of the comparison.

**Keycloak's admin REST broke that premise.** It introduced an external delete path, and X3
has no way to observe it. Stranding-by-deletion is a *new* vector, not accumulated debt.

**The ircd then took over SASL, and it cannot see saxdb.** It only knows what Keycloak
exposes. So it could not present X3's `registered`, and the detector began firing on
legitimate logins.

**The bridge, as designed:** move the stamps onto a value Keycloak could also see — the LDAP
`createTimestamp` — so the ircd could present something X3 would accept. Then, once a real
delete-detection mechanism existed, **turn the timestamp check off**.

Landed `a52968b` (2026-03-12), refined `291ec17` (2026-03-15).

**The terminus never arrived.** The Keycloak work moved fast, the transitional state became
permanent, and it now has to be resolved in one pass rather than in the planned stages.

## What the interim state actually does

In the exact case the detector was built to catch — directory entry recreated underneath X3
— the comparison fires correctly, and then the "correcting saxdb" branch **adopts the new
timestamp and binds anyway**:

```c
if (ldap_time == timestamp) {
    /* Wire matches LDAP — correct saxdb from LDAP */
    hi->registered = ldap_time;      /* detector defeated, evidence overwritten */
}
```

This is why §2.3 of `x3-merge-sequencing.md` finds that the LDAP reconciliation *enables*
the name-reuse escalation. The `#else` no-LDAP branch still rejects on mismatch — the
original logic is intact there, untouched.

### It only destroys data where drift exists

Where X3 created the account itself, saxdb and the directory agree and the backfill is a
no-op. `pool00`: saxdb `register` = `1784679309`, LDAP `createTimestamp` =
`20260722001509Z`. Identical, because AuthServ REGISTER wrote both.

Where something external happened, it overwrites. `uid=ibutsu` was restored into live LDAP
on 2026-07-30 from an orphaned March volume; the restore minted a fresh `createTimestamp`
of `20260730042329Z`, and X3 adopted it as the registration date.

**Firing on every auth is the mechanism. Drift is the cause.**

## Root cause

**X3 learns only about account lifecycle events it initiates.** Everything else — deletion,
recreation, restore-from-backup, bulk migration — is drift it cannot see. The timestamp
detector was a proxy for the knowledge it lacked, and the proxy stopped working the moment
a second writer appeared.

## Scheduled failures, independent of the above

- `nefarious/ircd/kc/kc_keycloak.c:276` reads `createTimestamp` **out of the Keycloak
  user-attribute map**, where it exists only because Keycloak's LDAP User Attribute Mapper
  puts it there. That mapper disappears with federation. `user->created_at` then becomes 0
  for everyone and `AC` stops carrying a timestamp (`sasl_auth.c:662` guards on it).
  **Downgraded by design E:** once gate (c) retires, nothing reads the value, so this
  becomes a harmless no-op rather than a scheduled failure.
- `entryUUID` has the same expiry: X3's identity binding (`4d29d8e`) is built on an LDAP
  operational attribute and dies with LDAP.

## What is actually deployed

Production X3 is `upstream/master` = `evilnet/x3` @ `5d7fadb` (**2026-04-23**).

| | `upstream/master` (prod) | `feature/ldap-identity-binding` (bed) |
|---|---|---|
| backfill `a52968b` | **present** | present |
| `ldap_uuid` / entryUUID binding | **absent** | present |
| `X3AccountLevel` schema `d598377` | absent | present |

Prod call sites: `src/nickserv.c:1188` (register), `:5669` (autocreate), and the
reconciliation block **`:5577-5631`** — from `if(hi && timestamp && hi->registered != timestamp)`
to its closing brace, with three `return;` sites (`:5600` LDAP mismatch, `:5617`
out-of-range, `:5629` no-LDAP).

Prod runs a **current ircd** against a **five-month-old X3**. Do not assume anything merged
after 2026-04-23 is present on the services side.

## Evidence (live bed and realm, 2026-09-22)

**`handle_account` never adopts a UUID.** `nickserv_verify_ldap_identity()` is wired into
`cmd_auth` and `loc_auth` only. Real users authenticate by local Keycloak SASL, which lands
in `handle_account`. On the bed 19/26 handles carry `ldap_uuid` — all test accounts using
the X3-mediated paths. `ibutsu` does not. Coverage is inversely correlated with how much an
account matters, and in prod it is zero.

**Keycloak's native `createdTimestamp` cannot carry the value.** For the federated cohort it
is the *sync import* time, quantised to the batch:

```
username    kc.createdTimestamp   attr createTimestamp
pool00      2026-07-22 00:15:42   20260722001509Z
pool01      2026-07-22 00:15:42   20260722001541Z   <- collides with pool00
pool03      2026-07-22 00:17:42   20260722001643Z
pool04      2026-07-22 00:17:42   20260722001715Z   <- collides with pool03
```

Every KC value lands on a `:42` boundary; the LDAP column has genuine ~31s per-account
spread. Two collisions in a 14-row sample.

**And it is read-only, in the worst way.** Probed on a throwaway user: a PUT backdating it
returned **`204 Success`** and the value was silently discarded. A migration that trusts
response codes would report a clean run over an empty write.

**Federation is `WRITABLE`** — a user created directly in KC came back with `federationLink`
set. **KC stores the entryUUID as `LDAP_ID`** on federated users.

## Rulings

### Freeze = declaring the migration complete

**User decision, 2026-09-22.** Whatever `hi->registered` holds today is canonical; no
restoration pass.

Framed correctly this is not "accept the damage." The migration's purpose was to move the
stamps onto a value Keycloak could see. It succeeded. The lost account ages were the price
of keeping auth working during the interim — already paid, not refundable. Freezing
declares the interim over and stops the charge.

Recorded so nobody "repairs" the discrepancy later: **this is intended.**

### Freezing still rescues the dormant tail

The backfill is lazy — it fires on auth. Accounts that have not authenticated since
2026-03-12 **still hold their original `registered`**, and are damaged the moment their
owner next logs in. Seeding now locks in the correct value for them permanently. The
dry-run census measures this cohort.

## Design

### A. Root fix — reliable delete detection

> **Partly superseded by F (2026-09-22).** A's *identity* assumption — that X3 can resolve
> a principal through the directory — does not hold, because X3 outlives LDAP. Identity
> moves onto the wire (design F). What remains valid here is delete detection as
> **convergence hygiene**: it is what makes a deletion propagate rather than merely fail
> closed at the next auth. The transport findings, durability layering and disposal ruling
> all still stand.

Replace the proxy with the knowledge. A working Keycloak lifecycle feed lets X3 dispose of
a handle when its backing account is deleted, which is what the timestamp check was
approximating.

**Prior art is substantial and already libkc-shaped.** X3's `keycloak-integration` branch
(HEAD `37a8d01`, 2026-03-07) carries `keycloak_webhook.c` (549 lines) written against
libkc's own types — `struct kc_webhook_event`, `KC_WH_RESOURCE_USER`, `KC_WH_OP_DELETE`,
`kc_webhook_set_secret()` — handling USER, CREDENTIAL, USER_SESSION, ADMIN_EVENT,
GROUP_MEMBERSHIP and GROUP. Alongside it: `keycloak.c`, `kc_async.c`, `kc_sync.c`,
`kc_token.c`, `x3_kc_adapter.c`, `x3_kc_bridge.c`, and `LIBKC_MIGRATION.md` documenting the
move onto libkc's HTTP transport.

**But it does not work as written, for two independent reasons:**

1. **Same dead path as the ircd.** `keycloak_webhook.c:172` opens `if (event->username)`.
   Keycloak's `USER/DELETE` admin event carries no username and no representation — 128/128
   live samples. The branch never executes. The SPI was written to satisfy *this file* and
   never injected a username into admin events either; the contract was broken on both ends
   from the start.
2. **It does not dispose of the handle.** `keycloak_invalidate_user_caches()` (`:508`) clears
   LMDB fingerprint entries and revokes session tokens. No unregister, no suspend, no mark.
   The handle survives with its ChanServ rows and oper level intact — **so the escalation
   remains open even when the event fires.**

Plus: the file is `x3_lmdb_*`-coupled throughout and LMDB is being retired; and
`keycloak-integration` predates prod's base.

**So the work is a contract fix, not a port:**
- Resolve the subject by `user_id`, which *is* present on every one of these events
  (`kc_webhook_extract_user_id` already parses it from `resourcePath`). Prefer having the
  SPI inject `username`/`realmName` into admin events too — it holds the `KeycloakSession`
  and already does this for user events — but the ircd/X3 side must not depend on it.
- Add real handle disposition on delete. What disposition is an open question (below).
- Never resolve the subject from `authDetails` — that is the *acting admin*. A delete
  performed by admin `ibutsu` would act on `ibutsu`'s own account.
- De-LMDB it.

The P0 security findings on the transport (`kc_webhook`/`sasl_webhook`) are in
`keycloak-webhook-audit-2026-09.md` and are prerequisites for pointing a prod Keycloak at
this. They are not restated here.

#### Delivery must be durable — and Keycloak already holds the queue

**Requirement (user, 2026-09-22):** a delete must not be lost because the consumer was
down. Bounded retries make delivery best-effort, and a lost delete is a permanently
stranded handle — the exact failure this whole design exists to prevent.

The answer is not an indefinitely-retrying SPI with its own durable queue. Keycloak's
**admin event store already is that queue**, it is already enabled on the realm, and it is
already populated. Verified on the bed 2026-09-22:

```
GET /admin/realms/testnet/admin-events?resourceTypes=USER&operationTypes=DELETE
  2026-09-22 05:21:08 DELETE USER  users/358987a0-24ca-46de-97c4-50fb8a854353
  2026-08-30 04:26:58 DELETE USER  users/c2ca00a7-cb2a-4935-a849-e8e7cdc37cf6
  ...
  + &dateFrom=2026-09-01  ->  narrowed 6 -> 1      (watermark filtering works)

Keycloak 26.4.7; realm events config contains adminEventsEnabled: true,
adminEventsDetailsEnabled: true, and NEITHER eventsExpiration NOR
adminEventsExpiration (both absent = unset = retained indefinitely).
Confirmed empirically: USER/DELETE events from 2026-08-07 are still queryable,
seven weeks on. Nothing is pruning the store.
```

Filtering by resource and operation works, `dateFrom` provides the watermark, and **every
`resourcePath` carries the subject UUID** — so catch-up resolves subjects exactly as the
live path does.

**Three layers:**

| Layer | Role | Latency | Survives |
|---|---|---|---|
| Push (webhook) | fast path | seconds | nothing — best-effort, bounded retries |
| Pull catch-up at startup | durability | restart | arbitrary downtime |
| Periodic reconciliation sweep | backstop | hours/days | lost watermark, pruned store, expiry |

Catch-up: persist a watermark, query `admin-events` filtered to the lifecycle operations,
process in ascending time order, advance the watermark only after successful disposition.
No SPI change required for this layer.

**Why layered beats indefinite SPI retry:** no durable queue to build or own; survives
outages longer than any retry window; self-heals a consumer that never received the event
at all; and no head-of-line blocking, where one undeliverable event stalls the rest.

**Cold start must not replay history.** With no stored watermark, record *now* and let the
reconciliation sweep handle everything prior. Blindly replaying the full store would
dispose of a handle for every account ever deleted, including names long since legitimately
re-registered.

**Config dependency, and why the sweep is mandatory.** Catch-up relies on
`adminEventsEnabled` plus the absence of `adminEventsExpiration`. Both hold today (bed
verified; prod believed untouched — user, 2026-09-22).

But unset expiration means the admin event store **grows without bound**, which gives a
prod operator a legitimate reason to set one later. The moment they do, catch-up silently
loses events older than the window — with no error, and no reason for anyone to connect the
change to account handling.

**So the reconciliation sweep is not optional.** It is what makes the design survive a
config change nobody thinks to mention. If an expiration is ever set, the sweep interval
must be shorter than it.

#### UUID-keyed disposition is mandatory, not preferable

Durability forces it. Consider delete-then-recreate during an outage: consumer down, `foo`
deleted (UUID `U1`), `foo` recreated (`U2`), consumer restarts and catch-up sees the DELETE.

- Keyed on **username** → disposes of the new, legitimate `foo`. Data destroyed by the
  recovery mechanism.
- Keyed on **UUID** → disposes of "the handle bound to `U1`", which is not the handle bound
  to `U2`. Correct, and idempotent on replay.

This requires handles to carry a stored **Keycloak** `user_id`, populated at auth success.
That binding then serves four roles at once: live disposition, catch-up disposition, the
name-reuse identity check, and — unlike `entryUUID` — it **survives LDAP retirement**. It is
the successor to `4d29d8e` in every one of that commit's jobs, which sharpens the open
question of whether shipping the entryUUID version upstream is still worth it.

#### Disposition: unregister

**Ruling (user, 2026-09-22):** unregister. *"You delete your account, you shouldn't be
surprised it's gone."*

**Do not call `nickserv_unregister_handle()` as-is.** It opens by deleting the directory
entry:

```c
if(nickserv_conf.ldap_enable && nickserv_conf.ldap_admin_dn) {
    if( (rc = ldap_delete_account(hi->handle)) != LDAP_SUCCESS) {
```

The directory is the *source* of this event, not a target. Writing back into it means X3
acts on the directory that just reported the deletion — and under `WRITABLE` federation an
LDAP delete leads Keycloak's sync sweep (`removeInvalidUsersEnabled`) to remove the user,
which can emit a further admin event. The loop is bounded (UUID-keyed disposition is
idempotent, `LDAP_NO_SUCH_OBJECT` already tolerated) but the rule is simple:
**never write back to the directory in response to a directory event.**

Needed: a local-only unregister that skips `ldap_delete_account()` and keeps everything
else — the `unreg_func_list` hooks (which tear down ChanServ access), `irc_delete()` on
logged-in users, and handle teardown.

**Consequence for the transport — this ruling raises the blast radius.** Per
`keycloak-webhook-audit-2026-09.md` P0-3, the webhook endpoint uses a static shared secret
in a plaintext header over HTTP, with no body HMAC, no timestamp, no nonce, and no
`realmId` check. The audit rated a forged or replayed delete a *mass-deauth* primitive.
With unregister as disposition it becomes **mass irreversible account destruction**.

**Therefore the P0-3 fixes (body HMAC, replay protection, realm check, `vhost` honoured)
are hard prerequisites for sequencing step 3, not hygiene.** UUID keying mitigates *replay* — a repeat
DELETE for `U1` is idempotent — but not *forgery*, since an attacker who can mint requests
can name any UUID they can learn.

**Guards — RULED IN (user, 2026-09-22):**
- *Journal before unregister* — persist the handle record before teardown so admin error, a
  forged event, or a bug is reversible for N days. Users still see the account gone, so the
  ruling's semantics are untouched; operators get a rollback path. Retention period needs a
  value; it should outlast a weekend.
- *Batch sanity limit* — if one catch-up run would unregister more than N handles, halt and
  alert rather than proceed. Catches a corrupted watermark, a wrong-realm feed, or a forged
  burst mid-flight. N needs a value; it should be generous enough that a genuine cleanup
  does not trip it, low enough that a runaway stops early.

### B. Retire the detector in X3

Once delete detection is real, the timestamp check has no job.

- **(a)** Delete the backfill. `hi->registered` becomes a date: displayed, never compared,
  never overwritten.
- **(b)** Remove all three `return;` sites. They leave the user `+r` on the ircd but unbound
  in X3 — authenticated, yet silently stripped of all ChanServ access.
- **(c)** Replace the reconciliation with **detect-and-log**. Drift will still occur —
  webhook delivery fails, backups get restored, migrations run — and the correct response
  to it is a loud log line, never a silent overwrite. That was the original sin of the
  interim.

**(a) and (b) are inseparable.** For a dormant account, saxdb holds the true old date and
LDAP the migration date:

| Change | Result |
|---|---|
| today (backfill live) | reconcile → **saxdb overwritten**. Silent data loss. |
| delete backfill, keep rejects | **reject → user unbound**. Lockout. |
| delete both | binds; saxdb keeps its value. Correct. |

Removing the overwrite without removing the rejects converts silent data loss into a hard
lockout for exactly the cohort whose data is still intact.

**These changes are escalation-neutral and need no prerequisite.** Trace the reuse case both
ways — today the reconciliation adopts the new timestamp and binds; afterwards it binds
directly. Same outcome. The detector is already defeated, so removing it opens nothing that
is not already open. (An earlier draft of this spec claimed the `entryUUID` gate was a
prerequisite. It is not.)

### C. The wire timestamp outlives X3 — **SUPERSEDED by E**

One consumer survives: the ircd's bouncer rebind gate (c) uses `acc_create` as a stable
per-principal discriminator (`bouncer_session.c:5979`, documented at `:5953` as *"set by
services on account REGISTER and never changes for a live account"*), persisted as
`bsr_acc_create`.

The directory's `createTimestamp` serves this well — "TS changed" ≡ "entry recreated" ≡
"different principal" is exactly what gate (c) should treat as a non-match. The problem is
only that it disappears at LDAP retirement, and KC's native `createdTimestamp` cannot
replace it because it collides.

**Carrier:** a Keycloak user attribute `account_created_at`, epoch seconds, seeded once from
the frozen saxdb values. Precedent exists — `x3_opserv_level`, `x3_scram_*`, `ecdsa_pubkey`
are already read from the KC user-attribute map at `kc_keycloak.c:230-278`. Not named `x3_*`:
this outlives X3.

**This attribute exists for the bouncer, not for X3.** That is the whole of its remaining
justification.

**libkc fallback ladder:**

| Rung | Source | Format | Log | Lifetime |
|---|---|---|---|---|
| 1 | `account_created_at` | epoch seconds | — | permanent |
| 2 | `createTimestamp` (LDAP mapper) | generalized time | DEBUG | until federation retires |
| 3 | KC native `createdTimestamp` | millis → seconds | INFO | KC-native accounts only |
| 4 | exhausted | → `0` | WARNING, rate-limited per account | — |

**Rung 4 fails open.** `sasl_auth.c:662` already guards on `acc_create` and emits `AC`
without a TS. This matches the ratified house rule — *absent → fail open loudly, mismatch →
fail closed* — and the lesson of `d598377`, where gating in-memory state on a directory
write failed closed and took every OpServ grant to 0.

Epoch seconds rather than generalized time: the value's semantic is `time_t`, which is what
`acc_create` is and what `AC` carries as `%Tu`. `parse_ldap_time()` stays for rung 2.

### D. The wire timestamp is inconsistent across auth paths — **SUPERSEDED by E**

X3 still stamps on its own auth paths: `cmd_auth` (`:2445`) and `loc_auth` (`:2656`) both
call `set_user_handle_info(..., 1)`, and `StampUser()` (`hash.c:394`, via `nickserv.c:1116`)
sends `hi->registered`. The ircd's local SASL path sends `createTimestamp`.

**Where those differ, the same account gets a different wire TS depending on how the user
logged in** — which breaks bouncer gate (c) across auth methods. Live today, independent of
everything else here, and as far as I can tell previously unnoticed.

Resolution: one owner for the wire TS. Either X3 stamps the directory-derived value, or it
stops stamping and the ircd owns it outright. The second is the direction of travel.

### E. Supersession — the timestamp has no consumer

*Added 2026-09-22, prompted by the question "upstream nef doesn't do anything with the
timestamp, how can it?" Sections C and D are retained above for their reasoning but no
longer describe work to be done.*

**Upstream nefarious never consumes the value.** It has `acc_create`, and every use is
parse, store, or propagate:

```
m_account.c:199,296,347   parse from AC
m_account.c:364           ? "%C %s %Tu" : "%C %s"   <- presence check, formatting only
s_auth.c:435,2337         set from SASL / iauth
s_user.c:1762             parse from NICK burst
s_user.c:1920-1926        if (acc_create) ... emit in burst
```

The only conditionals ask *is it set*, never *what is it*. That is correct by design: the
timestamp's meaning was always X3's, and the ircd is a courier carrying services' value
between services and other servers.

**The fork has exactly one comparison, network-wide.** Full enumeration:

| Category | Sites |
|---|---|
| Parse from wire | `m_account.c` x3, `s_user.c`, `s_auth.c` x2, `sasl_auth.c` |
| Store / propagate | `m_account.c:512`, `s_user.c:1920-1926` |
| Copy primary -> alias | `bouncer_session.c:7559, 8055, 8113` |
| Persist / restore | `bsr_acc_create` x5, incl. record-version migration |
| **Compare** | **`bouncer_session.c:5979-5980` — bouncer rebind gate (c). That is all.** |

**And that consumer was already scheduled for deletion.**
`bouncer-burst-rebind-sessid-gap.md` (2026-05-19) status line:

> Both Options landed and committed. B (`219ab03`) as the receiver-side fallback; A
> (`8cf493c`) as the principled sender-side fix. **Receiver-side `acc_ts_match` stays as
> defense-in-depth until production confidence in A; demote/remove as a follow-up.**

Gate (c) was always temporary, pending confidence in the sender-side sessid fix that
shipped four months ago. `bounce_set_n_sessid_hint()` carries the same judgement in code:
without it the gate *"fell back to acc_create_match — too coarse, can rebind unrelated
non-bouncer connections that happen to share an account."*

**So this is the same failure mode as the backfill itself: a deliberate interim measure
whose planned terminus never arrived.** Two of them, stacked on the same value.

#### Consequence

Retire gate (c), and nothing anywhere reads the account timestamp. The ircd becomes what
upstream already is — a pure courier. The following all become unnecessary:

| Superseded | Why |
|---|---|
| Design C — `account_created_at` carrier attribute | no consumer to feed |
| libkc fallback ladder (rungs 1-4) | nothing to supply |
| Seeding migration | nothing to seed for |
| Attribute written at account creation; realm protocol mapper | same |
| Federation-retirement rung drop | moot |
| `kc_keycloak.c:276` scheduled failure | harmless — `acc_create` becomes 0 and nobody reads it |
| Design D — cross-path stamping inconsistency | moot — nothing compares the two values |

The entire Keycloak-attribute workstream disappears. What remains is three pieces: retire
the X3 detector, retire gate (c), build delete detection.

#### Caveats

- **Gate (c) is a security gate.** Retiring it needs its own verification that option A
  covers the legacy-peer case where origin *also* mismatches — a legacy peer reintroducing
  a user whose ghost was created on a different server carries neither `,S` nor a matching
  origin. Whether four months of production constitutes the "confidence in A" the doc asked
  for is an operator judgement, not something to assume.
- **No wire change.** The ircd still parses and propagates the timestamp, as upstream does.
  X3 keeps stamping whatever it holds. Nothing becomes incompatible.
- **The census tool keeps its value.** Its seeding purpose evaporates, but its
  stranded-handle enumeration feeds delete detection (A) and is worth running regardless.
- **`bsr_acc_create` becomes vestigial** but should stay in the record format — removing a
  field means another version migration for no benefit.

### F. The identity must ride the wire — supersedes A's entryUUID assumption

*Added 2026-09-22. Design A assumed X3 could learn identity from the directory. It cannot,
for the whole window that matters.*

#### Why entryUUID is not the answer

**X3 will outlive LDAP** (user, 2026-09-22). That single fact invalidates the sequencing
constraint recorded earlier in this document — "X3 must stop being an account authority at
or before LDAP retirement" — and with it every directory-based control.

After LDAP retirement X3 has **no identity source whatsoever**:

| Source | After LDAP retirement |
|---|---|
| `entryUUID` (`4d29d8e`) | gone — an LDAP operational attribute |
| X3's own LDAP auth path | gone |
| Keycloak REST | never existed — X3 has no HTTP client on any shipping branch |
| **The P10 wire** | **the only channel left** |

So carrying identity on the wire is not one option among several. It is the only mechanism
that spans the window, and everything else is scaffolding with a hard expiry.

#### The design

**The ircd carries the Keycloak user id alongside the account; X3 binds the handle to it
and refuses on mismatch.**

The ircd is the right source: it performs SASL, so it already holds the identity.
`kc_user.id` is parsed at `kc_keycloak.c:187` and is in hand on every SASL callback path
(`sasl_plain_cb`, `sasl_scram_creds_cb`, `sasl_ecdsa_key_cb`, `sasl_external_cb`).

Two wire positions, because X3 reads the account from both:

| Position | Site | Today | Proposed |
|---|---|---|---|
| `AC` | `m_account.c:512`, `sasl_auth.c:662-679` | `%C %s %Tu` | trailing id parameter |
| `+r` in burst | `s_user.c:2771-2779` (`umode_str`) | `account:timestamp` | `account:timestamp:id` |

#### It is backward compatible, by luck of the existing parsers

This is the part that makes it cheap rather than a protocol break.

- **`AC`**: the handler gates on `parc > 4` with no strict arity rejection, so an unmodified
  server ignores a trailing parameter.
- **`+r`**: `s_user.c:2596-2599` parses with `strchr(account, ':')` then `atoi(ts)`, and
  `atoi` stops at the next non-digit. So `account:timestamp:id` parses **correctly on
  unmodified servers** — account up to the first colon, timestamp terminated by the second.
  X3's `handle_account` does the same thing with `strtol`, and is equally tolerant.

No protocol version gate, no capability negotiation, no flag day.

#### Encode it like a sessid, not as a raw UUID

A burst NICK line is capped at 512 bytes (see `project_s2s_512_compression_rationale`), and
a hyphenated UUID adds 37 characters per user — enough to push long nick/host/realname
combinations over on a large burst.

The fork already has the answer: `hs_sessid` carries a UUIDv7 as 22-char base64
(`AZ7RzhRLcaSl5PLPNJ9eMw`). Encode the Keycloak user id the same way — 16 raw bytes,
base64url, no padding. 22 characters instead of 37, and consistent with an encoding the
codebase already reads.

#### Why this survives what the alternatives do not

| | Wire-carried KC id | entryUUID (`4d29d8e`) | P10 relay | Webhook |
|---|---|---|---|---|
| Works today | yes | yes | yes | not yet |
| Survives LDAP retirement | **yes** | no | yes | yes |
| Nothing lost if X3 is down | **yes** — re-sent on every burst | yes | **no** — one-shot, gone | no — needs catch-up |
| Needs HTTP in X3 | no | no | no | yes |
| Backward compatible | yes | n/a | n/a | n/a |

The "nothing lost if X3 is down" property comes free: `cmd_nick` -> `AddUser()` ->
`mod_usermode()` -> `call_account_func()` -> `handle_account()` runs for **every** user on
**every** burst. The check is idempotent and re-applies on relink, so an outage delays it
rather than skipping it.

#### What it replaces

This retires the timestamp's identity role by **replacing it properly**, which is the
structural gap this whole document opened with: `AC` had no account-id field, so the
timestamp was drafted as one. Give the wire a real identity field and the timestamp goes
back to being a date — permanently, not as an interim.

It also means **`4d29d8e` is not the thing to ship.** Going straight to the wire-carried id
is one mechanism instead of two, with no expiry date. The seeding problem simplifies to
"store the Keycloak user id", which the census tool already retrieves from its user
lookups (`u["id"]`), rather than the `LDAP_ID` attribute.

#### Residue

- **Legacy handles remain trust-on-first-use** until seeded, exactly as with entryUUID.
  Prod has no stored identity of any kind, so the backlog needs the seed before the control
  covers it.
- **Stranded handles** (no Keycloak user at all) cannot be seeded and stay claimable. The
  census enumerates them; disposal is a one-time operator decision.
- **Fail-open on absent identity** stays the rule, per the ratified ruling and the
  `ldap_field_oslevel` precedent. Mismatch fails closed.

### G. X3 cannot be told; it must ask — pull, not push

*Added 2026-09-22. Resolves the question design F leaves open: identity binding stops the
wrong person binding, but the stranded handle persists forever, still holding the name and
its access. Deletion has to propagate.*

#### Why every push design leaked

Each attempt failed the same way, and it is structural rather than a detail of any one
mechanism: **X3 is the party that can be absent, and it has no durable inbox.** A webhook,
a P10 relay, a CACHEINVAL-style broadcast — all are one-shot. If X3 is down or delinked
when the event fires, the event is gone, with nothing to reconcile against afterwards.

Inverting the direction fixes it, because the party that can be absent becomes the party
that drives:

| | Push | Pull |
|---|---|---|
| X3 down at event time | **lost**, permanently | irrelevant — nothing was sent |
| X3 returns | gap never closes | asks, converges |
| Retry / batching | producer's problem, and it holds no state about X3 | X3's own schedule |
| Needs HTTP in X3 | webhook yes, relay no | **no** |
| Survives LDAP retirement | yes | yes |

#### The channel already exists

`XQUERY`/`XREPLY` — `XQ`/`XR`, `include/msg.h:375-381` — is a generic extension-query
channel built for services asking a server something. The ircd side exists; **X3
implements it on no branch**, so that is the work. The ircd is the natural Keycloak proxy:
it already holds libkc and talks to Keycloak for SASL, so X3 never needs an HTTP client.

#### Three layers, none of which has to be complete alone

**Ruling (user, 2026-09-22): get them live, poll on link, sweep as a safety net.**

| Layer | Trigger | Scope | Role |
|---|---|---|---|
| 1 — live | deletion arrives at the ircd | one account | latency: converge in seconds |
| 2 — on link | X3 links or relinks | deletions since X3's watermark | **durability** |
| 3 — sweep | slow interval | full reconcile | safety net |

Layer 2 is what makes the design correct, and it is bounded by the number of *deletions*,
not the number of handles. Keycloak answers deltas directly — verified on the bed
2026-09-22:

```
GET /admin/realms/<realm>/admin-events
      ?resourceTypes=USER&operationTypes=DELETE&dateFrom=<watermark>
  -> narrowed 6 results to 1; every resourcePath carries the subject UUID
  -> adminEventsEnabled true, no adminEventsExpiration set (retained)
```

So on link X3 sends its watermark, the ircd asks Keycloak for deletions since then, and
returns the list. X3 disposes by **identity**, not by name — the UUID is in every
`resourcePath`, which is also what makes replay and delete-then-recreate safe (see A).

Layer 3 exists because layer 2's correctness depends on a realm setting nobody will think
to tell us about: the admin-event store grows unbounded today, so an operator will
eventually set `adminEventsExpiration`, and any outage longer than that window silently
loses events. The sweep survives that. It can be slow precisely because it is a net, not
the mechanism.

#### Consequences

- **The webhook is demoted to a latency optimisation.** It becomes layer 1 and nothing
  more. The P0-3 transport fixes stop being a correctness prerequisite and become a
  prerequisite for *enabling* layer 1 — which matters, because with `unregister` as
  disposition a forged event is still mass destruction.
- **Watermark lives in saxdb**, alongside the handle data it protects.
- **Cold start must not replay history.** With no stored watermark, record *now* and let
  the sweep handle the backlog. Replaying the full store would dispose a handle for every
  account ever deleted, including names long since legitimately re-registered.
- **Mismatch fails closed, with no exception** (user, 2026-09-22). A bad seed locking out a
  legitimate owner is indistinguishable at auth time from a hijack in progress, so it must
  refuse; the remedy is operator correction, not a permissive gate. Absent identity still
  fails open, per the ratified rule.

## Sequencing

*Revised 2026-09-22 per designs F and G.*

| # | Step | Where | Status |
|---|---|---|---|
| 1 | Retire the LDAP backfill (design B) | x3 `upstream/master` | **done** — `cfe7d8a`, unpushed |
| 2 | Retire bouncer rebind gate (c) (design E) | nefarious | **done** — `396c423` + `95e61e3`, unpushed |
| 3 | Wire-carried Keycloak identity (design F) | nefarious + x3 | next — no prerequisite |
| 4 | Seed stored identity; stranded-handle report | tooling, no deploy | needs 3 |
| 5 | `XQUERY` deletion poll on link + sweep (design G, layers 2-3) | nefarious + x3 | needs 3 |
| 6 | Live delivery (design G layer 1) | SPI + consumer | **transport P0-3 (hard)** |

Steps 1 and 2 are complete, independent, and remove no working control (see B and E).

Step 3 is the control: it replaces the retired timestamp's identity role and spans the
whole window — works today, survives LDAP retirement, moot only when X3 retires.

Step 4 makes step 3 cover the existing population. Without it every handle is
trust-on-first-use and the backlog stays claimable.

Step 5 is what actually converges a deletion, and it is the durable half. Step 6 only makes
convergence faster.

**Withdrawn** (see E): seeding `account_created_at`, the libkc ladder, the realm mapper,
the federation-retirement rung drop. **Not adopted** (see F): shipping `4d29d8e`, and any
directory-based identity binding. **Demoted** (see G): the webhook, from mechanism to
latency optimisation.

## Census tool — built, and outliving its original purpose

*Seeding is withdrawn (design E). The tool was built before that was known, and its
enumeration half remains useful: it is how stranded handles get counted ahead of delete
detection. `x3/tools/x3-census/`, read-only. What follows documents both halves; the
write path was never built and now should not be.*

Input is a copy of prod `x3.db` (recdb text; in-container `/x3/data/x3.db`). `"register"` is
`KEY_REGISTER_ON` (`nickserv.c:99`), epoch seconds — the value to seed.

**Two parts.** Do not hand-roll a recdb parser; quoting, nested blocks and list values
(`"masks" ("*@*")`) are edge cases a regex gets wrong quietly. X3 ships `src/recdb.c`.

1. **C dumper** linked against `recdb.c` → JSON `{handle, register, ldap_uuid?, opserv_level?}`.
2. **Python driver** for the Keycloak side.

**TRAP — the dumper must call `tools_init()` first.** `irccasecmp()` folds through a
`static char irc_tolower[256]` (`tools.c:356`) that `tools_init()` populates. Uninitialised
it maps every byte to `'\0'`, so every dict key compares equal and **the parsed database
silently collapses to a single entry**. No error, no warning — just a confident, wrong
answer. Verified the hard way 2026-09-22: 25 handles came back as 1. Link
`recdb.c dict-splay.c tools.c`, stub `MAIN_LOG`, `log_module`, `lang_C`,
`hidden_host_suffix`, `GetChannel`, `language_find_message`, and call `tools_init()` before
`parse_database()`.

**Seeding must refuse on UUID mismatch.** Where X3 has a stored `ldap_uuid` that disagrees
with the KC user's `LDAP_ID`, the name was taken by a different principal. Seeding would
stamp the *old* principal's registration date onto the *new* principal's account. Such rows
are reported and skipped, never written — they are disposal candidates, not seed candidates.

**The ambiguity prod cannot resolve.** Two cases present identically as "saxdb differs from
the directory":

| Case | Truth | Correct action |
|---|---|---|
| (a) | same principal, directory entry recreated (restore, migration) | seed — preserves the original date |
| (b) | a different principal took the name | do not seed — dispose |

Only the stored `ldap_uuid` separates them, and **prod has none**. Observed live on the bed
2026-09-22, where both appeared in one run: `idbibyxyq` (saxdb 02:33:32 vs directory
02:33:34, UUIDs differ — case b) alongside `testuser` (saxdb 08-06 vs directory 08-30, no
conflict — case a).

So the tool **must not auto-resolve the differing set**. Seed the unambiguous rows — where
saxdb already agrees with the directory — and emit every differing row as an explicit
review list. Run the census on prod before deciding a policy for it: if the set is small,
review by hand; if large, it needs a ruling. Note that case (b) handles are already
compromised, so a wrong timestamp on one is marginal next to the harm already done —
this is a question of not compounding it silently.

**Join on username only** — prod has no `ldap_uuid` values at all. Where one *is* present
(bed), assert it against the KC user's `LDAP_ID` and hard-fail that row on mismatch.

**Merge, never blind PUT.** Keycloak's user update replaces the whole `attributes` map; a
naive write destroys `x3_opserv_level`, `x3_scram_*`, `ecdsa_pubkey`, `LDAP_ID`,
`LDAP_ENTRY_DN`.

**Read back and compare every row.** Non-negotiable, per the 204-silent-discard finding.

Idempotent, resumable, rate-limited. `--dry-run` is the default and reports: total handles;
resolved; unresolvable; UUID mismatches; already-seeded vs would-change; **the census** of
handles still holding a pre-2026-03-12 `register`; and **stranded handles** (no KC user) —
the latent-takeover class, enumerated as a side effect.

## Testing

**Step 1 — retire the X3 detector** (Vitest E2E; X3 has no CMocka, only legacy
`test-driver.pl`):
- dormant-account path: saxdb value differs from the directory -> binds successfully **and
  keeps its value**. Covers both failure modes at once — the silent overwrite and the bind
  refusal. Create the divergence by backdating saxdb, not by recreating the directory
  entry, so the test exercises the dormant case rather than name reuse.
- a freshly registered account, whose saxdb agrees with the directory, logs nothing.

**Step 2 — retire gate (c)**:
- a leaf re-linking during burst, carrying a user whose account matches a held ghost,
  rebinds via `,S` sessid match with no kill and no broadcast — the case `8cf493c` was
  written for, now load-bearing rather than belt-and-braces.
- the negative that gate (c) used to permit: two unrelated non-bouncer connections sharing
  an account must **not** rebind onto each other's ghost. This is the coarseness the sessid
  hint comment warns about, and removing (c) should make it impossible rather than merely
  unlikely.
- a legacy peer (no `,S`) reintroducing a user whose ghost was created on **another**
  server: document what happens. This is the case with neither (a) nor (b), and retiring
  (c) changes its outcome. If the refusal is unacceptable, (c) cannot retire yet.

**Step 3 — delete detection**:
- KC-side delete -> handle disposed; a subsequent registration of the same name does **not**
  inherit access
- **durability**: stop the consumer, delete an account, restart -> catch-up disposes it
- **delete-then-recreate during downtime**: consumer down, account deleted and re-created,
  restart -> the NEW account survives untouched and only the old binding is disposed
- cold start with no watermark does not replay history
- journal: a disposed handle is recoverable within the retention window
- batch limit: a run exceeding N halts and alerts instead of proceeding

*Withdrawn with design C: the CMocka ladder suite, the seeded-value assertions, and the
cross-path wire-TS equality test (design D).*

## Residue and open questions

**Open:**
- **Does gate (c) retire?** Its own doc asked for "production confidence in A" (`8cf493c`,
  2026-05-19). Design E's simplification depends on it.

  **Frequency measured 2026-09-22** from five months of production `ircd-user.log`
  (2026-04-25 → 2026-09-22): the rebind path fired **four times total**.

  ```
  2026-6-4   ghost fc42     -> AbDMT on Aurora.AfterNET.Org
  2026-7-1   ghost ibutsu   -> BFCrG on luna.AfterNET.Org
  2026-9-2   ghost ibutsu   -> AbJ4k on Aurora.AfterNET.Org
  2026-9-2   ghost princess -> AbJ69 on Aurora.AfterNET.Org
  ```

  So gate (c) fires *at most* four times per five months. Two consequences:

  1. **Waiting for proof is impractical.** The gate-discriminating output is
     `Debug((DEBUG_INFO, "...authorizing via account-TS match...")`, which lives only in
     the ephemeral debug stream — `docker logs` covers only since container start. At this
     event rate, proving "never fires" would take a year.
  2. **The risk of retiring is rare and loud, not silent.** The failure mode is a refused
     rebind, which produces the "Overruled by older nick" churn the 2026-05-19 doc was
     filed about — already documented, with a known diagnosis. That is a defensible
     deliberate risk.

  **Recommended:** retire it without waiting, and separately make each rebind self-report
  its gate. `log_write(LS_USER, L_TRACE, "Bouncer rebind: ghost %s rebound to remote
  primary %s...")` at `bouncer_session.c:6098` already persists for months; the gate
  variables (`origin_match` / `sessid_match` / `acc_ts_match`) are in a scoped block ~100
  lines earlier and do not reach it. Hoist an `auth_via` string, set it in the three
  branches, append it to that line. Five lines, no behaviour change — and it answers the
  question for every rebind from then on, including any that follow the retirement.
- **Two constants need values:** the journal retention period and the batch sanity limit N.
- **Admin event retention is unset today and that is load-bearing.** Bed verified (KC
  26.4.7, no `adminEventsExpiration`, 7-week-old DELETEs still present); prod believed the
  same. The store grows unbounded, so someone will eventually set an expiration — the sweep
  exists to survive that.
- **Is shipping `4d29d8e` upstream still worth it?** Clean cherry-pick, closes a live prod
  hole now — but it is built on `entryUUID` (dies with LDAP) inside X3 (being retired), and
  delete detection supersedes it. Interim value against short half-life.
- **`d598377` (`X3AccountLevel` schema) is also absent from prod** — separate subject, same
  five-month gap.

**Ruled:**
- **Disposition: unregister** (user, 2026-09-22), with journal-before-unregister and a batch
  sanity limit both ruled in. Requires a local-only variant that skips
  `ldap_delete_account()`, and promotes the P0-3 transport fixes to hard prerequisites.
- **Freeze, do not restore.** Pre-03-12 dates are unrecoverable for the cohort that
  authenticated since. Intended, not an oversight.

**Closed by design E** (kept so the reasoning is not rediscovered):
- ~~Policy for the ambiguous seeding set~~ — seeding withdrawn; nothing to seed.
- ~~Rung 3 is wrong for the federated cohort~~ — no ladder.
- ~~Which value X3 stamps, given it cannot stop stamping~~ (design D) — nothing compares
  the values, so inconsistency is harmless.

## Related

`keycloak-webhook-audit-2026-09.md` (transport P0s, SPI contract),
`x3-merge-sequencing.md` §0 and §2.3, `project_x3_name_reuse_escalation`,
`project_x3_ldap_identity_binding`, `project_ibutsu_account_lost_x3db_wipe`,
`project_x3_branch_strategy`, `project_x3_ldap_oslevel_schema`.
