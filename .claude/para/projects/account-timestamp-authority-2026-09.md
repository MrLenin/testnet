# The account timestamp: a delete detector that was disabled mid-migration

**Status:** design approved 2026-09-22, not yet implemented
**Scope:** x3, nefarious libkc + SASL + webhook consumer, Keycloak realm + SPI, one-shot seeding tool

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
are hard prerequisites for step 5, not hygiene.** UUID keying mitigates *replay* — a repeat
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

### C. The wire timestamp outlives X3

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

### D. New finding — the wire timestamp is inconsistent across auth paths

X3 still stamps on its own auth paths: `cmd_auth` (`:2445`) and `loc_auth` (`:2656`) both
call `set_user_handle_info(..., 1)`, and `StampUser()` (`hash.c:394`, via `nickserv.c:1116`)
sends `hi->registered`. The ircd's local SASL path sends `createTimestamp`.

**Where those differ, the same account gets a different wire TS depending on how the user
logged in** — which breaks bouncer gate (c) across auth methods. Live today, independent of
everything else here, and as far as I can tell previously unnoticed.

Resolution: one owner for the wire TS. Either X3 stamps the directory-derived value, or it
stops stamping and the ircd owns it outright. The second is the direction of travel.

## Sequencing

| # | Step | Where | Blocking |
|---|---|---|---|
| 1 | Retire the detector (design B): backfill, three rejects, detect-and-log | x3 `upstream/master` | none — ships now |
| 2 | Seed `account_created_at` from prod `x3.db` (dry-run census first) | tooling, no deploy | none — inert |
| 3 | libkc ladder (design C); `kc_user_create_full()` writes the attribute; realm mapper | nefarious + realm | none |
| 4 | Resolve the stamping inconsistency (design D) | x3 + nefarious | none |
| 5 | Delete detection (design A): KC `user_id` binding, SPI contract, local-only unregister, catch-up + sweep | SPI + consumer | **transport P0-3 (hard)** |
| 6 | Federation retirement: rung 2 drops out | — | 2, 3 |

Design sections are lettered A-D; sequencing steps are numbered. They deliberately do not
correspond — the root fix (A) is the largest piece and lands last.

Step 1 first because it stops permanent data loss and needs nothing. Step 5 is the root fix
and the largest piece; steps 1-4 do not wait on it.

## Seeding tool (step 2)

Input is a copy of prod `x3.db` (recdb text; in-container `/x3/data/x3.db`). `"register"` is
`KEY_REGISTER_ON` (`nickserv.c:99`), epoch seconds — the value to seed.

**Two parts.** Do not hand-roll a recdb parser; quoting, nested blocks and list values
(`"masks" ("*@*")`) are edge cases a regex gets wrong quietly. X3 ships `src/recdb.c`.

1. **C dumper** linked against `recdb.c` → JSON `{handle, register, ldap_uuid?, opserv_level?}`.
2. **Python driver** for the Keycloak side.

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

**CMocka first for the ladder** — self-contained C in libkc: a test per rung, exhaustion,
both format parsers. Gates the image.

**Vitest E2E:**
- wire `acc_create` matches the seeded value; stable across re-auth **and across a
  deliberate `createTimestamp` change on the LDAP entry** — the regression that started this
- dormant-account path: saxdb value differs from LDAP → binds successfully, keeps its value
- same account via `cmd_auth` and via SASL → identical wire TS (design D)
- held-session reconnect: bouncer gate (c) still authorises
- delete detection: KC-side delete → handle disposed; a subsequent registration of the same
  name does **not** inherit access
- **durability**: stop the consumer, delete an account, restart → catch-up disposes it
- **delete-then-recreate during downtime**: consumer down, account deleted and re-created,
  restart → the NEW account survives untouched and only the old binding is disposed
- cold start with no watermark does not replay history

X3 has no CMocka (only legacy `test-driver.pl`), so the X3 half is gated by Vitest E2E.

## Residue and open questions

- **Admin event retention is unset today and that is load-bearing.** Bed verified (KC
  26.4.7, no `adminEventsExpiration`, 7-week-old DELETEs still present); prod believed the
  same. The store therefore grows unbounded, so someone will eventually set an expiration —
  the sweep exists to survive that.
- **Two constants need values:** the journal retention period and the batch sanity limit N.
- **Disposition RULED: unregister** (user, 2026-09-22), with journal-before-unregister and
  a batch sanity limit both ruled in. Requires a local-only variant that skips
  `ldap_delete_account()`, and promotes the P0-3 transport fixes to hard prerequisites.
- **Is shipping `4d29d8e` upstream still worth it?** Clean cherry-pick, closes a live prod
  hole now — but it is built on `entryUUID` (dies with LDAP) inside X3 (being retired), and
  step 5 supersedes it. Interim value against short half-life.
- **Pre-03-12 dates are unrecoverable** for the cohort that authenticated since. Intended.
- **`d598377` (`X3AccountLevel` schema) is also absent from prod** — separate subject, same
  five-month gap.
- Rung 3 is wrong for the federated cohort and right for KC-native accounts. Accepted: it is
  a last-resort rung behind two better ones.

## Related

`keycloak-webhook-audit-2026-09.md` (transport P0s, SPI contract),
`x3-merge-sequencing.md` §0 and §2.3, `project_x3_name_reuse_escalation`,
`project_x3_ldap_identity_binding`, `project_ibutsu_account_lost_x3db_wipe`,
`project_x3_branch_strategy`, `project_x3_ldap_oslevel_schema`.
