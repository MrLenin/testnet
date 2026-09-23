# Webhook plan 2: the subject by Keycloak id (P0-1, P0-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Keycloak account delete, disable, or admin password reset reaches the ircd and acts, resolved by the user's Keycloak id rather than a username the events never carry.

**Architecture:** Every real `USER` admin event carries `resourcePath: users/<uuid>` and nothing else that names the subject (delete and reset-password carry no representation; update carries the changed fields, `enabled` among them when it changed). Since step 5 every logged-in client and every positive auth-cache entry carries the compact form of that uuid (`kc_id`), so the ircd resolves the subject itself: a pure decision module turns an event into (kind, compact id, payload-carried name); the handler purges the caches by id here and on every fork server (`CI` gains an id form) and deauths by the account names the id resolves to, matching clients by id where both sides know it. No admin credential, no Keycloak round trip, no SPI behaviour change; the SPI's documented contract is re-anchored to the ircd.

**Tech Stack:** C (nefarious `ircv3.2-hardening` fork, libkc vendored in `ircd/kc/`, jansson), CMocka, Vitest (testnet `tests/`), Keycloak 26.4.7 admin REST API, keycloak-webhook-spi (Java; docs only here).

**Spec:** `.claude/para/projects/keycloak-webhook-audit-2026-09.md`, findings P0-1 and P0-2, plus its "Prod cutover checklist" items 1, 4 and 5 (B-2 is already closed by plan 1, `2026-09-22-bouncer-deauth-correctness.md`).

## What the live store says (2026-09-23, bed realm, 500 USER admin events)

| Event | resourcePath | representation | subject name anywhere? |
|---|---|---|---|
| USER/DELETE (221) | `users/<uuid>` | none | no |
| USER/UPDATE (48) | `users/<uuid>` | the changed fields; `enabled` + `username` present in 29 (console saves), absent in 19 (partial API puts) | only inside a full representation |
| USER/ACTION reset-password (1) | `users/<uuid>/reset-password` | none | no |
| USER/CREATE (230) | `users/<uuid>` | full | yes (irrelevant) |

`authDetails` always names the acting admin (`userId`, `clientId`, `realmId`, `ipAddress`), never the subject. The uuid is the only stable subject handle, and Keycloak's PUT semantics mean an `enabled` absent from the representation was not changed.

## Open decisions (mine to propose, the user's to make)

1. **`CI` id form.** `CI <username|*> [<kc_id>]` extends the fork-only cache-invalidate token so a server that never saw a client for the id still purges its positive cache. Old receivers ignore the second parameter and treat `*` as an unknown name (no-op). Alternative: no wire change, accept a 300 s window on servers that never saw the client. This plan implements the extension.
2. **Bed plumbing edits `.env.local`.** The running Keycloak sends to a phantom `x3:9080` and with a secret the ircd rejects (audit P1-1); `.env.local` overrides the committed `.env`. This plan changes both files to `http://nefarious:9090/keycloak-webhook` and the ircd's `x3-webhook-secret`, and recreates Keycloak. Nothing else in `.env.local` is touched.
3. **SPI: documentation only.** With id resolution the SPI already satisfies the contract; this plan rewrites its README and comments (X3 to ircd) and does not change the payload. Injecting `username` into admin events (audit option 1) stays open and unneeded.
4. **The end-to-end test is ungated.** It drives real Keycloak admin actions and depends on delivery working (decision 2). Gate it behind an env variable if the bed is expected to run without delivery.

## Global Constraints

- `ircd/kc/*.c` may not include ircd headers (`make check-kc-boundary` runs on every make). New ircd-side code lives outside `ircd/kc/`.
- The pure module and its CMocka test link without ircd objects (like `account_id_cmocka`: `../account_id.o ../webpush_keyring.o` only, plus `-ljansson`).
- Deauth under legacy accounts stays refused unless a kill switch is on (plan 1, Task 6); `WEBHOOK_KILL_ON_DELETE` / `_DISABLE` stay default off.
- Sockets are only ever exited locally; accounts are cleared network-wide through AC U (plan 1).
- Never run the full Vitest suite; one vitest process at a time, from `tests/`; `IRC_HOST=localhost`.
- Deploy: merge into `bed-deploy`, `scripts/dc.sh -l build nefarious nefarious2`, `scripts/dc.sh -l up -d nefarious nefarious2`, confirm the `ircd.<stamp>` symlink advanced in both, make sure X3 relinks.
- Commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; nothing is pushed; the SPI change is a branch for the user's PR.
- Plain, defensive language in comments and commit messages.

## Review Focus

1. A DELETE for a user no client carries (logged out minutes ago) must still purge this server's positive cache and every other server's (`CI * <id>`); the test for it is in Task 4's step 1 (cmocka cannot see the cache) and Task 2 case C, which logs out before deleting.
2. An UPDATE whose representation lacks `enabled` (partial API put) must do nothing at all; Task 3 fixture `user-update-partial.json`.
3. A malformed or foreign resourcePath (`users/not-a-uuid`, `groups/<uuid>`) must be ignored, never acted on and never crash; Task 3 fixtures `user-delete-bad-path.json`, and the resource-type gate.
4. `authDetails.username`, if any producer ever sets it, must never become the subject (it is the acting admin); Task 3 fixture `user-delete-actor-named.json` and the parser change in Task 5.
5. A synthetic event carrying only a root-level `username` (what `x3-account-change.test.ts` posts, and what a future SPI enrichment would send) keeps resolving by name; Task 3 fixture `user-delete-root-username.json`, Task 6 re-runs that suite.

## File structure

- Create `include/webhook_subject.h`, `ircd/webhook_subject.c` -- pure decision: event to (kind, compact id, name).
- Create `ircd/test/webhook_subject_cmocka.c`, `ircd/test/fixtures/webhook/*.json` -- CMocka over real payload shapes.
- Modify `ircd/Makefile.in` (source list), `ircd/test/Makefile.in` (test program, fixture path define).
- Modify `ircd/sasl_auth.c`, `include/sasl_auth.h` -- `sasl_cache_invalidate_id()`.
- Modify `ircd/sasl_webhook.c` -- subject-driven user events, `cache_invalidate_subject()`, id-aware walk match, `ms_cacheinval` id form.
- Modify `ircd/kc/kc_webhook.c` -- drop the acting-admin username fallback.
- Modify `.env`, `.env.local` (bed delivery), `tests/src/services/keycloak-webhook-e2e.test.ts` (new).
- Modify `keycloak-webhook-spi/README.md`, `.../WebhookEventListenerProvider.java` (comments only).

---

### Task 1: Bed delivery plumbing (audit P1-1)

**Files:**
- Modify: `.env:81-82`, `.env.local:62-63`

**Interfaces:**
- Produces: real Keycloak admin events arriving at `nefarious:9090` with the ircd's secret. Every later bed task assumes it.

- [ ] **Step 1: Point the SPI at the ircd only, with the ircd's secret, in both env files**

```bash
cd /home/ibutsu/testnet
S=$(grep -o '"WEBHOOK_SECRET" = "[^"]*"' data/ircd.conf | cut -d'"' -f4)
for f in .env .env.local; do
  sed -i "s|^KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL=.*|KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL=http://nefarious:9090/keycloak-webhook|" $f
  sed -i "s|^KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_SECRET=.*|KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_SECRET=$S|" $f
done
grep -n "KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS" .env .env.local | sed -E 's/(SECRET=).*/\1<set>/'
```
Expected: four lines, both URLs `http://nefarious:9090/keycloak-webhook`, both secrets `<set>`.

- [ ] **Step 2: Recreate Keycloak so the SPI reads the new environment**

```bash
scripts/dc.sh up -d --force-recreate --no-deps keycloak
for i in $(seq 1 40); do docker ps --format '{{.Names}} {{.Status}}' | grep -q "^keycloak .*(healthy)" && break; sleep 5; done
docker ps --format '{{.Names}} {{.Status}}' | grep "^keycloak "
docker exec keycloak sh -c 'echo $KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL'
```
Expected: `keycloak Up ... (healthy)`; the URL line names only `nefarious:9090`.

- [ ] **Step 3: Delivery oracle -- create and delete a throwaway user and watch both logs**

```bash
KC=http://localhost:8080
TOK=$(curl -s -d username=admin -d password=admin -d grant_type=password -d client_id=admin-cli $KC/realms/master/protocol/openid-connect/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
T0=$(date -u +%Y-%m-%dT%H:%M:%S)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"username":"testwhprobe","enabled":true}' $KC/admin/realms/testnet/users
ID=$(curl -s -H "Authorization: Bearer $TOK" "$KC/admin/realms/testnet/users?username=testwhprobe&exact=true" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $TOK" $KC/admin/realms/testnet/users/$ID
sleep 3
docker logs keycloak --since $T0 2>&1 | grep -c "Sending admin event webhook"
docker logs nefarious --since $T0 2>&1 | grep "WEBHOOK: Event USER/" | cut -c1-160
```
Expected: `201`, `204`, a Keycloak count of at least 2, and two ircd lines `WEBHOOK: Event USER/CREATE ...` and `WEBHOOK: Event USER/DELETE user=(null) path=users/<uuid>`. (The DELETE reaches the handler and is still ignored today -- that is P0-1.)

- [ ] **Step 4: Commit the committed half**

```bash
git add .env
git commit -m "bed: the Keycloak webhook SPI delivers to the ircd with the ircd's secret

The committed URL named x3:9080, where nothing has listened since X3
stopped being a webhook consumer, and the secret was not the one the
ircd's conf expects, so every delivery was rejected (audit P1-1).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(`.env.local` is untracked by design; say in the report that it was edited.)

---

### Task 2: The end-to-end test, red

**Files:**
- Create: `tests/src/services/keycloak-webhook-e2e.test.ts`

**Interfaces:**
- Consumes: `getKeycloakAdminToken` (`../helpers/keycloak-sync`), `authenticateSaslPlain` (`../helpers/sasl`), `createRawSocketClient`, `RawSocketClient` (`../helpers/index.js`), `whoisAccount` (`../helpers/webhook-post`).
- Produces: the three bed observables every later task is judged by.

- [ ] **Step 1: Write the test**

```ts
/**
 * Real Keycloak admin actions reach the ircd and act (audit P0-1, P0-2).
 *
 * Keycloak's USER admin events name the subject only by uuid in
 * resourcePath: DELETE and reset-password carry nothing else, UPDATE carries
 * the changed fields.  The ircd resolves the subject by the Keycloak id it
 * has carried on every logged-in client and every positive-cache entry since
 * step 5, so no username is needed.  Before the fix handle_user_event
 * returned on the missing username and nothing happened: the session stayed
 * authenticated and the positive cache kept answering the old password for
 * SASL_POSCACHE_TTL.
 *
 * Every case primes the positive cache with a second login (a cache hit
 * never asks Keycloak), so "login fails afterwards" is the cache purge, not
 * Keycloak's own refusal.  Needs real delivery: the SPI must send to the
 * ircd with its secret (plan task 1).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { RawSocketClient, createRawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';
import { whoisAccount } from '../helpers/webhook-post';

const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';
const tag = Math.random().toString(36).slice(2, 7);
const USER = `testwh${tag}`;                    // 'test*' is swept by cleanup-tests.ts
const PASSWORD = 'Webhook!2026';
const NEW_PASSWORD = 'Webhook!2026b';
let token = '';
let userId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreateUser(username: string, password: string): Promise<string> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username, enabled: true, emailVerified: true, email: `${username}@example.com`,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create ${username}: ${res.status} ${await res.text()}`);
  const q = await kc(`/users?username=${encodeURIComponent(username)}&exact=true`);
  return (await q.json())[0].id;
}

/** SASL PLAIN as the user; resolves to the registered client, or null when the login was refused. */
async function tryLogin(password: string, nick: string): Promise<RawSocketClient | null> {
  const c = await createRawSocketClient();
  await c.capLs();
  await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, USER, password);
  if (!r.success) { c.close(); return null; }
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001', 15000);
  return c;
}

/** Poll WHOIS until the nick shows no account, or give up. */
async function loggedOutWithin(c: RawSocketClient, nick: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await whoisAccount(c, nick)) === '') return true;
    await sleep(500);
  }
  return false;
}

describe('Keycloak admin actions reach the ircd', () => {
  const clients: RawSocketClient[] = [];

  beforeAll(async () => {
    token = await getKeycloakAdminToken();
    userId = await kcCreateUser(USER, PASSWORD);
  }, 60_000);

  afterEach(() => {
    for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
    clients.length = 0;
  });

  afterAll(async () => {
    token = await getKeycloakAdminToken();
    await kc(`/users/${userId}`, { method: 'DELETE' });   // 404 after case C is fine
  });

  it('disable deauths the session and stops the cached password', async () => {
    const primary = await tryLogin(PASSWORD, `wh${tag}a`);
    expect(primary, 'first login').not.toBeNull();
    clients.push(primary!);
    const cached = await tryLogin(PASSWORD, `wh${tag}b`);          // primes the positive cache
    expect(cached, 'second login (cache hit)').not.toBeNull();
    clients.push(cached!);

    expect((await kc(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) })).status).toBe(204);

    expect(await loggedOutWithin(primary!, `wh${tag}a`, 8000), 'the session lost its account').toBe(true);
    const again = await tryLogin(PASSWORD, `wh${tag}c`);
    if (again) clients.push(again);
    expect(again, 'the cached password no longer logs in').toBeNull();

    expect((await kc(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status).toBe(204);
  }, 90_000);

  it('an admin password reset stops the old password at once', async () => {
    const c1 = await tryLogin(PASSWORD, `wh${tag}d`);
    expect(c1, 'login after re-enable').not.toBeNull();
    clients.push(c1!);
    const c2 = await tryLogin(PASSWORD, `wh${tag}e`);               // primes the positive cache
    expect(c2).not.toBeNull();
    clients.push(c2!);

    expect((await kc(`/users/${userId}/reset-password`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'password', value: NEW_PASSWORD, temporary: false }),
    })).status).toBe(204);
    await sleep(2000);

    const old = await tryLogin(PASSWORD, `wh${tag}f`);
    if (old) clients.push(old);
    expect(old, 'the old password is refused (cache purged)').toBeNull();
    const fresh = await tryLogin(NEW_PASSWORD, `wh${tag}g`);
    expect(fresh, 'the new password works').not.toBeNull();
    clients.push(fresh!);
  }, 90_000);

  it('delete deauths the session and stops the cached password, even for a user who logged out', async () => {
    const stay = await tryLogin(NEW_PASSWORD, `wh${tag}h`);
    expect(stay).not.toBeNull();
    clients.push(stay!);
    const gone = await tryLogin(NEW_PASSWORD, `wh${tag}i`);          // primes the cache, then leaves
    expect(gone).not.toBeNull();
    gone!.close();
    await sleep(1000);

    expect((await kc(`/users/${userId}`, { method: 'DELETE' })).status).toBe(204);

    expect(await loggedOutWithin(stay!, `wh${tag}h`, 8000), 'the live session lost its account').toBe(true);
    const again = await tryLogin(NEW_PASSWORD, `wh${tag}j`);
    if (again) clients.push(again);
    expect(again, 'the cached password of the deleted user no longer logs in').toBeNull();
  }, 90_000);
});
```

- [ ] **Step 2: Run it against the deployed build and read why each case fails**

Run: `cd tests && IRC_HOST=localhost npm test -- src/services/keycloak-webhook-e2e.test.ts`
Expected: 3 failed. Case A on "the session lost its account" (expected true, got false); case B on "the old password is refused" (a client came back); case C on "the live session lost its account". If a case fails on `first login` or on a Keycloak status code, Task 1 or the bed is broken -- fix that first, this is not the red we want.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/src/services/keycloak-webhook-e2e.test.ts
git commit -m "tests: real Keycloak disable, reset-password and delete must reach the ircd

Red on purpose: the ircd ignores USER admin events without a username,
which is all of them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The pure subject module, with real payloads

**Files:**
- Create: `include/webhook_subject.h`, `ircd/webhook_subject.c`, `ircd/test/webhook_subject_cmocka.c`, `ircd/test/fixtures/webhook/*.json`
- Modify: `ircd/Makefile.in:219` (next to `account_id.c`), `ircd/test/Makefile.in:55,99,279-281` (mirror `account_id_cmocka`)

**Interfaces:**
- Consumes: `account_id_from_uuid()` (`include/account_id.h`), `struct kc_webhook_event` (`include/kc/kc_webhook.h`).
- Produces: `enum WebhookSubjectKind { WH_SUBJECT_NONE, WH_SUBJECT_DELETE, WH_SUBJECT_DISABLE, WH_SUBJECT_ENABLE, WH_SUBJECT_PASSWORD_RESET, WH_SUBJECT_LOGOUT }`, `struct WebhookSubject { kind; char kc_id[ACCOUNT_ID_LEN + 1]; const char *username; }`, `int webhook_subject_resolve(const struct kc_webhook_event *, struct WebhookSubject *)` (1 when kind != NONE), `const char *webhook_subject_kind_name(enum WebhookSubjectKind)`.

- [ ] **Step 1: Fixtures from the live store (real shapes), plus four labelled synthetic ones**

```bash
cd /home/ibutsu/testnet/nefarious && mkdir -p ircd/test/fixtures/webhook
KC=http://localhost:8080
TOK=$(curl -s -d username=admin -d password=admin -d grant_type=password -d client_id=admin-cli $KC/realms/master/protocol/openid-connect/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOK" "$KC/admin/realms/testnet/admin-events?resourceTypes=USER&max=500" | python3 - <<'EOF'
import sys, json
evs = json.load(sys.stdin); out = 'ircd/test/fixtures/webhook/'
def pick(pred):
    for e in evs:
        if pred(e): return e
    raise SystemExit('no live sample for a fixture; capture one by hand')
rep = lambda e: json.loads(e['representation']) if e.get('representation') else None
delete = pick(lambda e: e['operationType'] == 'DELETE')
reset  = pick(lambda e: e['operationType'] == 'ACTION' and e['resourcePath'].endswith('/reset-password'))
full   = pick(lambda e: e['operationType'] == 'UPDATE' and rep(e) and 'enabled' in rep(e))
part   = pick(lambda e: e['operationType'] == 'UPDATE' and rep(e) and 'enabled' not in rep(e))
create = pick(lambda e: e['operationType'] == 'CREATE')
json.dump(delete, open(out + 'user-delete.json', 'w'), indent=1)
json.dump(reset,  open(out + 'user-action-reset-password.json', 'w'), indent=1)
json.dump(part,   open(out + 'user-update-partial.json', 'w'), indent=1)
json.dump(create, open(out + 'user-create.json', 'w'), indent=1)
# a disable is a full-representation save with enabled flipped: the live store has none (nobody disabled a bed user from the console)
d = dict(full); r = rep(full); r['enabled'] = False; d['representation'] = json.dumps(r)
json.dump(d, open(out + 'user-update-disable.json', 'w'), indent=1)
# the acting admin must never become the subject: no uuid, a named actor
a = dict(delete); a['resourcePath'] = 'users/not-a-uuid'; a['authDetails'] = dict(delete['authDetails'], username='ibutsu')
json.dump(a, open(out + 'user-delete-actor-named.json', 'w'), indent=1)
b = dict(delete); b['resourcePath'] = 'users/not-a-uuid'
json.dump(b, open(out + 'user-delete-bad-path.json', 'w'), indent=1)
# what the x3-account-change suite posts: a root-level username and no path
json.dump({'id': 'synthetic', 'time': 0, 'realmId': 'testnet', 'resourceType': 'USER', 'operationType': 'DELETE', 'username': 'testaccXu'},
          open(out + 'user-delete-root-username.json', 'w'), indent=1)
print('fixtures written')
EOF
ls ircd/test/fixtures/webhook/
```
Expected: eight files. `user-update-disable.json`, `user-delete-actor-named.json`, `user-delete-bad-path.json` and `user-delete-root-username.json` are synthetic; the test's comments say which.

- [ ] **Step 2: Write the failing test**

`ircd/test/webhook_subject_cmocka.c`:

```c
/* cmocka suite for the pure webhook subject decision
 * (include/webhook_subject.h), over the real USER admin-event shapes the
 * bed realm produced (fixtures/webhook/*.json; four are synthetic and say
 * so in their names: -disable, -actor-named, -bad-path, -root-username). */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <string.h>
#include <stdio.h>
#include <cmocka.h>
#include <jansson.h>

#include "../../include/webhook_subject.h"

#ifndef WEBHOOK_FIXTURE_DIR
#define WEBHOOK_FIXTURE_DIR "fixtures/webhook"
#endif

/* The parts of the payload the decision reads, filled the way the libkc
 * parser fills them after Task 5 (root username, then the representation's
 * own username; the acting admin's authDetails never). */
struct fixture {
  json_t *root;
  json_t *rep;
  char user_id[40];
  struct kc_webhook_event ev;
};

static const char *str(json_t *o, const char *k)
{
  json_t *v = o ? json_object_get(o, k) : NULL;
  return (v && json_is_string(v)) ? json_string_value(v) : NULL;
}

static void load(struct fixture *f, const char *name)
{
  char path[512];
  const char *s;
  memset(f, 0, sizeof(*f));
  snprintf(path, sizeof(path), "%s/%s", WEBHOOK_FIXTURE_DIR, name);
  f->root = json_load_file(path, 0, NULL);
  assert_non_null(f->root);
  s = str(f->root, "resourceType");
  f->ev.resource_type = (s && 0 == strcmp(s, "USER")) ? KC_WH_RESOURCE_USER : KC_WH_RESOURCE_UNKNOWN;
  s = str(f->root, "operationType");
  f->ev.operation_type = !s ? KC_WH_OP_UNKNOWN
                       : 0 == strcmp(s, "CREATE") ? KC_WH_OP_CREATE
                       : 0 == strcmp(s, "UPDATE") ? KC_WH_OP_UPDATE
                       : 0 == strcmp(s, "DELETE") ? KC_WH_OP_DELETE
                       : 0 == strcmp(s, "ACTION") ? KC_WH_OP_ACTION : KC_WH_OP_UNKNOWN;
  f->ev.resource_path = str(f->root, "resourcePath");
  if (f->ev.resource_path && 0 == strncmp(f->ev.resource_path, "users/", 6)
      && strlen(f->ev.resource_path + 6) >= 36) {
    memcpy(f->user_id, f->ev.resource_path + 6, 36);
    f->user_id[36] = '\0';
    f->ev.user_id = f->user_id;
  }
  s = str(f->root, "representation");
  if (s) {
    f->rep = json_loads(s, 0, NULL);
    f->ev.representation = f->rep;
  }
  f->ev.username = str(f->root, "username");
  if (!f->ev.username && f->rep)
    f->ev.username = str(f->rep, "username");
}

static void unload(struct fixture *f)
{
  if (f->rep) json_decref(f->rep);
  if (f->root) json_decref(f->root);
}

static void test_delete_resolves_by_id(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  load(&f, "user-delete.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 1);
  assert_int_equal(s.kind, WH_SUBJECT_DELETE);
  assert_int_equal((int)strlen(s.kc_id), ACCOUNT_ID_LEN);
  assert_null(s.username);                         /* nothing in the payload names the subject */
  unload(&f);
}

static void test_reset_password_is_a_cache_purge(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  load(&f, "user-action-reset-password.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 1);
  assert_int_equal(s.kind, WH_SUBJECT_PASSWORD_RESET);
  assert_int_equal((int)strlen(s.kc_id), ACCOUNT_ID_LEN);
  unload(&f);
}

static void test_disable_needs_enabled_false(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  load(&f, "user-update-disable.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 1);
  assert_int_equal(s.kind, WH_SUBJECT_DISABLE);
  assert_non_null(s.username);                     /* a full representation names the subject */
  unload(&f);

  /* Review focus 2: a partial put that did not touch enabled is nothing. */
  load(&f, "user-update-partial.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  assert_int_equal(s.kind, WH_SUBJECT_NONE);
  unload(&f);
}

static void test_create_is_nothing(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  load(&f, "user-create.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  unload(&f);
}

static void test_actor_and_bad_path_are_nothing(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  /* Review focus 3 and 4: no uuid, and the named admin is not the subject. */
  load(&f, "user-delete-actor-named.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  assert_string_equal(s.kc_id, "");
  assert_null(s.username);
  unload(&f);
  load(&f, "user-delete-bad-path.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  unload(&f);
}

static void test_root_username_still_resolves(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  /* Review focus 5: a synthetic event names the subject at the root and
   * carries no path -- resolved by name, no id. */
  load(&f, "user-delete-root-username.json");
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 1);
  assert_int_equal(s.kind, WH_SUBJECT_DELETE);
  assert_string_equal(s.kc_id, "");
  assert_string_equal(s.username, "testaccXu");
  unload(&f);
}

static void test_non_user_resources_and_null(void **state)
{
  struct fixture f; struct WebhookSubject s;
  (void)state;
  load(&f, "user-delete.json");
  f.ev.resource_type = KC_WH_RESOURCE_GROUP;
  assert_int_equal(webhook_subject_resolve(&f.ev, &s), 0);
  unload(&f);
  assert_int_equal(webhook_subject_resolve(NULL, &s), 0);
  assert_int_equal(s.kind, WH_SUBJECT_NONE);
  assert_string_equal(webhook_subject_kind_name(WH_SUBJECT_DISABLE), "disable");
}

int main(void)
{
  const struct CMUnitTest tests[] = {
    cmocka_unit_test(test_delete_resolves_by_id),
    cmocka_unit_test(test_reset_password_is_a_cache_purge),
    cmocka_unit_test(test_disable_needs_enabled_false),
    cmocka_unit_test(test_create_is_nothing),
    cmocka_unit_test(test_actor_and_bad_path_are_nothing),
    cmocka_unit_test(test_root_username_still_resolves),
    cmocka_unit_test(test_non_user_resources_and_null),
  };
  return cmocka_run_group_tests(tests, NULL, NULL);
}
```

- [ ] **Step 3: Wire the build (both Makefiles) and run the test to watch it fail on the missing header**

`ircd/Makefile.in`: add `webhook_subject.c \` on the line after `account_id.c \` (line 219).

`ircd/test/Makefile.in`: add `webhook_subject_cmocka` to the `CMOCKA_TESTPROGS` list after `account_id_cmocka` (line 55, keep the backslashes), add `webhook_subject_cmocka.c \` to the source list after `account_id_cmocka.c \` (line 99), and after the `account_id_cmocka` rule (line 281) add:

```make
# webhook_subject tests - the pure webhook subject decision over real
# Keycloak admin-event shapes (fixtures/webhook); links no ircd objects
WEBHOOK_SUBJECT_CMOCKA_OBJS = webhook_subject_cmocka.o ../webhook_subject.o ../account_id.o ../webpush_keyring.o
webhook_subject_cmocka.o: ${srcdir}/webhook_subject_cmocka.c
	${CC} ${CFLAGS} ${CPPFLAGS} -DWEBHOOK_FIXTURE_DIR='"${srcdir}/fixtures/webhook"' -c -o $@ ${srcdir}/webhook_subject_cmocka.c
webhook_subject_cmocka: $(WEBHOOK_SUBJECT_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(WEBHOOK_SUBJECT_CMOCKA_OBJS) $(CMOCKA_LIBS) $(JANSSON_LIBS)
```

Run: `cd /home/ibutsu/testnet/nefarious && ./config.status >/dev/null && make -C ircd/test webhook_subject_cmocka 2>&1 | grep -m1 error`
Expected: `fatal error: ../../include/webhook_subject.h: No such file or directory`.

- [ ] **Step 4: Write the module**

`include/webhook_subject.h`:

```c
/*
 * IRC - Internet Relay Chat, include/webhook_subject.h
 *
 * What a Keycloak USER admin event asks of the ircd, decided from the
 * event alone.  Keycloak names the subject of delete, disable and
 * password-reset events only by uuid (resourcePath "users/<uuid>"); the
 * compact form of that uuid is the Keycloak id every logged-in client and
 * positive-cache entry carries (step 5), so the ircd resolves the subject
 * itself.  Pure: no ircd headers, unit tested against real payloads.
 */
#ifndef INCLUDED_webhook_subject_h
#define INCLUDED_webhook_subject_h

#include "account_id.h"
#include "kc/kc_webhook.h"

enum WebhookSubjectKind {
  WH_SUBJECT_NONE = 0,        /**< nothing for the ircd to do */
  WH_SUBJECT_DELETE,          /**< USER/DELETE */
  WH_SUBJECT_DISABLE,         /**< USER/UPDATE whose representation carries enabled:false */
  WH_SUBJECT_ENABLE,          /**< USER/UPDATE carrying enabled:true (log only) */
  WH_SUBJECT_PASSWORD_RESET,  /**< USER/ACTION users/<uuid>/reset-password */
  WH_SUBJECT_LOGOUT           /**< USER/ACTION users/<uuid>/logout (log only) */
};

struct WebhookSubject {
  enum WebhookSubjectKind kind;
  /** Compact Keycloak id of resourcePath's uuid; "" when the event has none or it is malformed. */
  char kc_id[ACCOUNT_ID_LEN + 1];
  /** The subject's own name when the payload carries one (root-level, or a
   * full representation); NULL otherwise.  Never the acting admin. */
  const char *username;
};

/** Decide what ev asks for.  out is always filled (kind NONE when there is
 * nothing to do, including a subject nobody can name).
 * @return 1 when out->kind != WH_SUBJECT_NONE. */
extern int webhook_subject_resolve(const struct kc_webhook_event *ev,
                                   struct WebhookSubject *out);

/** A short lower-case name for logs ("delete", "disable", ...). */
extern const char *webhook_subject_kind_name(enum WebhookSubjectKind kind);

#endif /* INCLUDED_webhook_subject_h */
```

`ircd/webhook_subject.c`:

```c
/*
 * IRC - Internet Relay Chat, ircd/webhook_subject.c
 *
 * See include/webhook_subject.h.  Keep this file free of ircd headers: it
 * is compiled standalone for the cmocka suite.
 */
#include "webhook_subject.h"

#include <jansson.h>
#include <string.h>

static int path_ends_with(const char *path, const char *suffix)
{
  size_t lp, ls;
  if (!path || !suffix)
    return 0;
  lp = strlen(path);
  ls = strlen(suffix);
  return lp >= ls && 0 == strcmp(path + lp - ls, suffix);
}

int webhook_subject_resolve(const struct kc_webhook_event *ev,
                            struct WebhookSubject *out)
{
  if (!out)
    return 0;
  memset(out, 0, sizeof(*out));
  if (!ev || ev->resource_type != KC_WH_RESOURCE_USER)
    return 0;

  /* The uuid in resourcePath is the one handle Keycloak always gives; a
   * malformed one leaves kc_id empty (account_id_from_uuid writes nothing). */
  if (ev->user_id)
    (void)account_id_from_uuid(ev->user_id, out->kc_id);
  out->username = ev->username;

  switch (ev->operation_type) {
  case KC_WH_OP_DELETE:
    out->kind = WH_SUBJECT_DELETE;
    break;
  case KC_WH_OP_UPDATE:
    /* Keycloak's update carries the fields it changed: an absent
     * "enabled" was not touched (PUT semantics), so only an explicit
     * false is a disable. */
    if (ev->representation) {
      json_t *en = json_object_get(ev->representation, "enabled");
      if (en && json_is_false(en))
        out->kind = WH_SUBJECT_DISABLE;
      else if (en && json_is_true(en))
        out->kind = WH_SUBJECT_ENABLE;
    }
    break;
  case KC_WH_OP_ACTION:
    if (path_ends_with(ev->resource_path, "/reset-password"))
      out->kind = WH_SUBJECT_PASSWORD_RESET;
    else if (path_ends_with(ev->resource_path, "/logout"))
      out->kind = WH_SUBJECT_LOGOUT;
    break;
  default:
    break;
  }

  /* A subject nobody can name is nothing to act on. */
  if (out->kind != WH_SUBJECT_NONE && !out->kc_id[0] && !out->username)
    out->kind = WH_SUBJECT_NONE;

  return out->kind != WH_SUBJECT_NONE;
}

const char *webhook_subject_kind_name(enum WebhookSubjectKind kind)
{
  switch (kind) {
  case WH_SUBJECT_DELETE:         return "delete";
  case WH_SUBJECT_DISABLE:        return "disable";
  case WH_SUBJECT_ENABLE:         return "enable";
  case WH_SUBJECT_PASSWORD_RESET: return "reset-password";
  case WH_SUBJECT_LOGOUT:         return "logout";
  case WH_SUBJECT_NONE:
  default:                        return "none";
  }
}
```

- [ ] **Step 5: Run the suite green, and the whole tree**

Run: `cd /home/ibutsu/testnet/nefarious && make -j8 >/dev/null 2>&1; echo build=$?; make -C ircd/test webhook_subject_cmocka >/dev/null 2>&1; ./ircd/test/webhook_subject_cmocka; echo rc=$?`
Expected: `build=0`, 7 tests PASSED, `rc=0`. Check the binary's own exit code, never a pipe's.

- [ ] **Step 6: Commit**

```bash
git add include/webhook_subject.h ircd/webhook_subject.c ircd/test/webhook_subject_cmocka.c ircd/test/fixtures/webhook ircd/Makefile.in ircd/test/Makefile.in
git commit -m "webhook: a pure decision names the subject of a USER admin event by its Keycloak id

Keycloak's delete and reset-password events carry nothing but the
user's uuid; an update carries the fields it changed.  Resolve delete,
disable (enabled:false), reset-password and logout from the event
alone, with the compact id every logged-in client and cache entry has
carried since step 5.  Tested over the realm's real event shapes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Cache purge by id, here and on every server

**Files:**
- Modify: `ircd/sasl_auth.c:382-400` (next to `poscache_invalidate_user`), `include/sasl_auth.h:163`, `ircd/sasl_webhook.c` (`ms_cacheinval`)

**Interfaces:**
- Consumes: `struct poscache_entry.kc_id` (`sasl_auth.c:294`), `account_id_valid()`.
- Produces: `void sasl_cache_invalidate_id(const char *kc_id)`; wire `CI <username|*> [<kc_id>]` accepted by `ms_cacheinval` and relayed as received.

- [ ] **Step 1: The observable is Task 2's case C** (a user who logged out, then is deleted: only an id can find the cache entry). Re-read that case; no new test here.

- [ ] **Step 2: Add the id purge to the positive cache**

After `poscache_invalidate_user` in `ircd/sasl_auth.c`:

```c
/** Drop every positive entry carrying this Keycloak id (compact form).
 * The entry for a user who logged out minutes ago still answers their
 * password; a delete or reset names that user only by id. */
static void poscache_invalidate_id(const char *kc_id)
{
  unsigned int i;

  for (i = 0; i < AUTHCACHE_BUCKETS; i++) {
    struct poscache_entry **pp = &poscache_table[i];
    struct poscache_entry *e;

    while ((e = *pp) != NULL) {
      if (e->kc_id[0] && 0 == strcmp(e->kc_id, kc_id)) {
        *pp = e->next;
        MyFree(e);
        cache_stats.pos_invalidations++;
      } else {
        pp = &e->next;
      }
    }
  }
}
```

After `sasl_cache_invalidate_user`:

```c
/** Invalidate the positive cache by Keycloak id.  The negative cache is
 * keyed by name only (a failed login has no id) and is left alone. */
void sasl_cache_invalidate_id(const char *kc_id)
{
  if (!authcache_initialized || !kc_id || !kc_id[0])
    return;
  poscache_invalidate_id(kc_id);
  log_write(LS_SYSTEM, L_DEBUG, 0,
            "SASL AUTH CACHE: Invalidated positive entries for id %s", kc_id);
}
```

`include/sasl_auth.h` after line 163: `extern void sasl_cache_invalidate_id(const char *kc_id);`

- [ ] **Step 3: Teach `ms_cacheinval` the id form**

Replace the body of `ms_cacheinval` in `ircd/sasl_webhook.c`:

```c
/* CI <username|*> [<kc_id>]: purge the auth caches for a user.  The name
 * form is the original; the id form (step 5's compact Keycloak id) reaches
 * a server that never saw a client for the user, whose positive cache may
 * still hold their password.  "*" stands for "no name".  A receiver
 * without the id form ignores the second parameter and finds nothing under
 * "*"; the message is relayed as received. */
int ms_cacheinval(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
  const char *username, *kc_id;

  if (parc < 2)
    return 0;

  username = parv[1];
  kc_id = (parc > 2 && account_id_valid(parv[2])) ? parv[2] : NULL;

  log_write(LS_SYSTEM, L_DEBUG, 0,
            "CI: Cache invalidation for %s id %s from %C",
            username, kc_id ? kc_id : "-", sptr);

  if (0 != strcmp(username, "*"))
    sasl_cache_invalidate_user(username);
  if (kc_id)
    sasl_cache_invalidate_id(kc_id);

  if (kc_id)
    sendcmdto_serv_butone_v3(sptr, CMD_CACHEINVAL, cptr, "%s %s", username, kc_id);
  else
    sendcmdto_serv_butone_v3(sptr, CMD_CACHEINVAL, cptr, "%s", username);

  return 0;
}
```
Add `#include "account_id.h"` to `ircd/sasl_webhook.c`'s common includes (it is outside the `USE_LIBKC` block; `ms_cacheinval` is too).

- [ ] **Step 4: Build**

Run: `cd /home/ibutsu/testnet/nefarious && make -j8 2>&1 | grep -E "error|warning: .*sasl_(auth|webhook)" ; echo build=${PIPESTATUS[0]}`
Expected: no lines, `build=0`.

- [ ] **Step 5: Commit**

```bash
git add ircd/sasl_auth.c include/sasl_auth.h ircd/sasl_webhook.c
git commit -m "sasl: purge the positive cache by Keycloak id, and carry the id on CI

A delete or reset names its user only by uuid, and the user may have
logged out: the cache entry still answers their password for
SASL_POSCACHE_TTL.  Entries carry the compact id since step 5, so purge
by it, and let CI carry it (\"CI * <id>\") for servers that never saw a
client for the user.  Older receivers ignore the second parameter.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The handler acts on the subject

**Files:**
- Modify: `ircd/sasl_webhook.c` (`handle_user_event`, `handle_credential_event`, `deauth_action_for`, `handle_sessions_for_account`), `ircd/kc/kc_webhook.c:856-875`

**Interfaces:**
- Consumes: Task 3's `webhook_subject_resolve`, Task 4's `sasl_cache_invalidate_id`, plan 1's `handle_sessions_for_account` / `deauth_action_for` / `bounce_deauth_classify`.
- Produces: `handle_sessions_for_account(const char *account, const char *reason, int do_kill, const char *kc_id)` -- a client matches by name, and by id when both it and the event carry one.

- [ ] **Step 1: Red is Task 2** (all three cases). Re-run it only after Task 6's deploy.

- [ ] **Step 2: One cache-purge helper for every path**

Add below `deauth_client` in `ircd/sasl_webhook.c` (inside `USE_LIBKC`), and make `handle_credential_event` call `cache_invalidate_subject(event->username, NULL)` at its two invalidation sites in place of the paired `sasl_cache_invalidate_user` + `sendcmdto_serv_butone_v3` lines (keep its `wh_stats.cache_invalidations++` out: the helper counts):

```c
/** Purge the auth caches for a subject here and on every fork server: by
 * name when the payload names it, by Keycloak id when it carries one.  The
 * id reaches servers that never saw a client for the user. */
static void cache_invalidate_subject(const char *username, const char *kc_id)
{
  int has_id = (kc_id && kc_id[0]) ? 1 : 0;

  if (username)
    sasl_cache_invalidate_user(username);
  if (has_id)
    sasl_cache_invalidate_id(kc_id);

  if (has_id)
    sendcmdto_serv_butone_v3(&me, CMD_CACHEINVAL, NULL, "%s %s",
                             username ? username : "*", kc_id);
  else if (username)
    sendcmdto_serv_butone_v3(&me, CMD_CACHEINVAL, NULL, "%s", username);

  wh_stats.cache_invalidations++;
}
```

- [ ] **Step 3: Match clients by id when both sides know it**

Change `deauth_action_for`'s signature to `(struct Client *cptr, const char *account, const char *kc_id, int do_kill)` and its match:

```c
  subj.account_matches = (cli_user(cptr)
                          && 0 == ircd_strcmp(cli_user(cptr)->account, account)
                          /* A name can be reused; an id cannot.  When the
                           * event and the client both carry one they must
                           * agree.  A client without one (legacy hop,
                           * restored ghost) still matches by name: for a
                           * deauth the safe error is to include it. */
                          && (!kc_id || !kc_id[0] || !cli_user(cptr)->kc_id[0]
                              || 0 == strcmp(cli_user(cptr)->kc_id, kc_id))) ? 1 : 0;
```

Change `handle_sessions_for_account` to take `const char *kc_id` as its last parameter, pass it to both `deauth_action_for` calls, and update the doc comment's first line: "Apply an account deauth or kill to every session of an account (matched by id too when known)."

- [ ] **Step 4: Resolve names from the id, and drive the user events by the subject**

Replace `handle_user_event` entirely:

```c
/* ---- User events (delete, disable, admin password reset) ---- */

#define WH_SUBJECT_MAX_NAMES 4

/** The account names a subject resolves to: the payload's own name when it
 * carries one, and the account of every client (local or replica) carrying
 * the subject's Keycloak id.  Distinct; the cap covers a rename race. */
static int subject_account_names(const struct WebhookSubject *s,
                                 char names[][ACCOUNTLEN + 1], int max)
{
  struct Client *cptr;
  int n = 0, i;

  if (s->username && n < max)
    ircd_strncpy(names[n++], s->username, ACCOUNTLEN + 1);
  if (!s->kc_id[0])
    return n;

  for (cptr = GlobalClientList; cptr && n < max; cptr = cli_next(cptr)) {
    if (!IsUser(cptr) || !IsAccount(cptr) || !cli_user(cptr))
      continue;
    if (0 != strcmp(cli_user(cptr)->kc_id, s->kc_id))
      continue;
    for (i = 0; i < n; i++)
      if (0 == ircd_strcmp(names[i], cli_user(cptr)->account))
        break;
    if (i == n)
      ircd_strncpy(names[n++], cli_user(cptr)->account, ACCOUNTLEN + 1);
  }
  return n;
}

/** Deauth (or kill, when the switch is on) every session the subject
 * resolves to, after purging its caches everywhere. */
static void deauth_subject(const struct WebhookSubject *s, const char *reason,
                           enum Feature kill_feature, const char *kill_name)
{
  char names[WH_SUBJECT_MAX_NAMES][ACCOUNTLEN + 1];
  int do_kill = feature_bool(kill_feature);
  int n, i;

  log_write(LS_SYSTEM, L_INFO, 0,
            "WEBHOOK: %s: id %s name %s -- invalidating caches",
            reason, s->kc_id[0] ? s->kc_id : "-", s->username ? s->username : "-");
  cache_invalidate_subject(s->username, s->kc_id);

  /* Deauth is not implementable under legacy accounts: the legacy AC
   * grammar has no unregister form, so peers cannot be told, while the
   * BX U alias propagation would still fire -- leaving one session whose
   * connections disagree about their own account and a network that
   * disagrees with us.  A relink then re-teaches the account from the
   * peer's N token, undoing the local clear.  Refuse loudly instead. */
  if (!feature_bool(FEAT_EXTENDED_ACCOUNTS) && !do_kill) {
    log_write(LS_SYSTEM, L_WARNING, 0,
              "WEBHOOK: %s deauth REFUSED -- EXTENDED_ACCOUNTS is off and %s "
              "is off; no coherent deauth exists.  Enable one of them.",
              reason, kill_name);
    return;
  }

  n = subject_account_names(s, names, WH_SUBJECT_MAX_NAMES);
  if (!n) {
    log_write(LS_SYSTEM, L_INFO, 0,
              "WEBHOOK: %s: no session carries id %s", reason, s->kc_id);
    return;
  }
  /* Default: deauth (AC U), which propagates network-wide.  The kill
   * switch escalates to disconnecting LOCAL sockets only. */
  for (i = 0; i < n; i++)
    handle_sessions_for_account(names[i], reason, do_kill, s->kc_id);
}

static void handle_user_event(const struct kc_webhook_event *event)
{
  struct WebhookSubject s;

  wh_stats.user_events++;

  if (!webhook_subject_resolve(event, &s)) {
    log_write(LS_SYSTEM, L_DEBUG, 0,
              "WEBHOOK: USER/%s for %s: nothing to do",
              event->operation_type_str ? event->operation_type_str : "?",
              event->resource_path ? event->resource_path : "(no path)");
    return;
  }

  switch (s.kind) {
  case WH_SUBJECT_DELETE:
    deauth_subject(&s, "Account deleted", FEAT_WEBHOOK_KILL_ON_DELETE, "KILL_ON_DELETE");
    break;
  case WH_SUBJECT_DISABLE:
    deauth_subject(&s, "Account disabled", FEAT_WEBHOOK_KILL_ON_DISABLE, "KILL_ON_DISABLE");
    break;
  case WH_SUBJECT_PASSWORD_RESET:
    /* Keycloak emits no user-level event for an admin reset; this is the
     * only chance to stop the old password answering from the cache. */
    log_write(LS_SYSTEM, L_INFO, 0,
              "WEBHOOK: Admin password reset: id %s name %s -- invalidating caches",
              s.kc_id[0] ? s.kc_id : "-", s.username ? s.username : "-");
    cache_invalidate_subject(s.username, s.kc_id);
    break;
  case WH_SUBJECT_ENABLE:
  case WH_SUBJECT_LOGOUT:
    log_write(LS_SYSTEM, L_DEBUG, 0, "WEBHOOK: USER %s for id %s: noted",
              webhook_subject_kind_name(s.kind), s.kc_id[0] ? s.kc_id : "-");
    break;
  case WH_SUBJECT_NONE:
    break;
  }
}
```
Add `#include "webhook_subject.h"` and `#include "ircd_features.h"` (if not already present) to the `USE_LIBKC` includes. Remove the old `handle_user_event` and its `sasl_cache_invalidate_user` / `CMD_CACHEINVAL` lines with it. Update the file header's event list: "Account delete / disable / admin password reset -> by Keycloak id (resourcePath uuid); see include/webhook_subject.h".

- [ ] **Step 5: The acting admin is never the subject (parser)**

In `ircd/kc/kc_webhook.c` lines 856-875, delete the `authDetails.username` fallback block and change the comment to:

```c
    /* Resolve the subject's username from the payload:
     * 1. Root-level "username" (injected by the webhook SPI on user events)
     * 2. representation.username (a full user representation)
     * authDetails names the acting admin, never the subject, and is not a
     * source. */
```
(The `auth_details.username` field parse further down stays; it is audit data.)

- [ ] **Step 6: Build, boundary, and the two cmocka suites**

Run: `cd /home/ibutsu/testnet/nefarious && make -j8 2>&1 | grep -E "error|warning: .*(sasl_webhook|kc_webhook)"; echo build=${PIPESTATUS[0]}; make check-kc-boundary; ./ircd/test/webhook_subject_cmocka >/dev/null; echo subject=$?; ./ircd/test/bouncer_deauth_cmocka >/dev/null; echo deauth=$?`
Expected: no error lines, `build=0`, boundary silent, `subject=0`, `deauth=0`.

- [ ] **Step 7: Commit**

```bash
git add ircd/sasl_webhook.c ircd/kc/kc_webhook.c
git commit -m "webhook: delete, disable and admin reset act on the subject's Keycloak id

handle_user_event returned on a missing username, which every real
USER admin event lacks (audit P0-1): a deleted or disabled account kept
its sessions and its cached password, and an admin reset changed nothing
(P0-2).  The handler now takes the pure subject decision: caches purged
by name and id here and on every server, sessions deauthed under every
account name the id resolves to, clients matched by id when both sides
carry one (a name can be reused, an id cannot).  The parser no longer
takes authDetails.username, which names the acting admin, as a subject.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Deploy and turn the bed green

**Files:** none (bed operations)

- [ ] **Step 1: Merge into bed-deploy, rebuild both images, recreate both ircds, confirm the binaries, make sure X3 relinks**

```bash
cd /home/ibutsu/testnet/nefarious && git merge --no-edit <this branch>
cd /home/ibutsu/testnet && scripts/dc.sh -l build nefarious nefarious2 > /tmp/build-wh.log 2>&1; echo build=$?
scripts/dc.sh -l up -d nefarious nefarious2
sleep 10; for c in nefarious nefarious2; do echo "$c $(docker exec $c readlink /home/nefarious/bin/ircd)"; done
sleep 60; docker logs x3 --since 2m 2>&1 | grep -c "Connection to server established"; docker ps --format '{{.Names}} {{.Status}}' | grep "^x3 "
```
Expected: `build=0`, both symlinks newer than the previous stamp, X3 `Up` and relinked (start it with `scripts/dc.sh up -d --no-deps x3` if it exited).

- [ ] **Step 2: Task 2 green**

Run: `cd tests && IRC_HOST=localhost npm test -- src/services/keycloak-webhook-e2e.test.ts`
Expected: 3 passed.

- [ ] **Step 3: Neighbours, one process at a time**

Run, each on its own: `src/ircv3/bouncer-deauth-local-alias.test.ts` (2), `src/ircv3/bouncer-deauth-cross-server.test.ts` (3), `X3_AC_CHANGE=1 ... src/services/x3-account-change.test.ts` (2; its AC U case posts a root-username DELETE and must still work), `src/ircv3/sasl-reauth.test.ts`.
Expected: all green.

---

### Task 7: The SPI's contract is the ircd's

**Files:**
- Modify: `keycloak-webhook-spi/README.md:69-130`, `.../WebhookEventListenerProvider.java` (javadoc and comments at 121-362; no code change)

- [ ] **Step 1: Replace the README's "Event Formats" and "X3 IRC Services Integration" sections**

````markdown
## Event Formats

### Admin Events

Keycloak admin events are forwarded as they are, plus nothing: the subject of a
`USER` event is named only by the uuid in `resourcePath`.

```json
{
  "id": "event-uuid",
  "time": 1234567890000,
  "realmId": "realm-uuid",
  "resourceType": "USER",
  "operationType": "DELETE",
  "resourcePath": "users/<user-uuid>",
  "representation": "{...}",
  "authDetails": { "userId": "<acting admin uuid>", "clientId": "...", "realmId": "...", "ipAddress": "..." }
}
```

`representation` is present when Keycloak recorded one (create: the full user;
update: the fields that changed, so `enabled` appears only when it changed;
delete and actions: absent).  `authDetails` names the acting admin, never the
subject; consumers must not read it as the subject.

### User Events

User events (login, logout, credential changes) are forwarded with the event's
own fields; credential-change events additionally carry the user's `username`
at the root and, when the realm's password policy stores them, the SCRAM-SHA-256
verifier attributes.

## Consumer contract: the Nefarious ircd

The only consumer is the Nefarious ircd (`ircd/sasl_webhook.c`, via the vendored
`kc_webhook` parser).  What it needs per event:

| Event | Subject | What the ircd does |
|---|---|---|
| `USER` / `DELETE` | `resourcePath` uuid | purges its auth caches by id, deauths every session of the account (or disconnects local sockets when `WEBHOOK_KILL_ON_DELETE` is on) |
| `USER` / `UPDATE` with `enabled:false` | uuid (and `representation.username` when full) | same, as a disable (`WEBHOOK_KILL_ON_DISABLE`) |
| `USER` / `ACTION` `users/<uuid>/reset-password` | uuid | purges its auth caches by id |
| credential change user events | root `username` | purges its auth caches by name |
| everything else | -- | logged, ignored |

The ircd resolves the uuid against the Keycloak id it stores for every logged-in
client and every positive-cache entry (the ID token's `sub`, compact form), so
no username is needed on admin events.  A root-level `username` is honoured when
present (synthetic events, tests).
````

- [ ] **Step 2: Re-anchor the Java comments**

In `WebhookEventListenerProvider.java`: the `formatUserEvent` javadoc ("matching X3's expected format", "This allows X3 to pre-populate...") becomes "in the shape the Nefarious ircd's kc_webhook parser reads; credential events carry the username the ircd purges its caches by, and the SCRAM verifier attributes when the policy stores them"; `// Add username for X3 lookup` becomes `// The ircd purges its auth caches by this name`; the `formatAdminEvent` javadoc's "X3's keycloak_webhook.c expects" block becomes the README's admin-event shape with the note that `authDetails` is the acting admin and that the ircd resolves the subject by the resourcePath uuid; every remaining "for X3 compatibility" / "X3" comment says "for the ircd". `grep -n "X3" src/main/java` must then list nothing.

- [ ] **Step 3: Commit on a branch in the SPI submodule (the PR is the user's)**

```bash
cd /home/ibutsu/testnet/keycloak-webhook-spi && git checkout -b docs/ircd-contract
git add README.md src/main/java/net/afternet/keycloak/webhook/WebhookEventListenerProvider.java
git commit -m "docs: the payload contract is the Nefarious ircd's, not X3's

X3 stopped consuming these events; the README and the code comments
still described what X3's resolver expected.  Document what the ircd
reads: the subject of a USER admin event is the resourcePath uuid,
authDetails is the acting admin, and only credential user events
carry a username.  No payload change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**1. Spec coverage.** P0-1 (delete and disable dead) -> Tasks 3, 5, proven by Task 2 cases A and C. P0-2 (admin reset) -> Tasks 4, 5, case B. Audit "fix direction" option 2 (uuid map) -> the id every client and cache entry already carries; option 3 (reorder for `enabled`) -> Task 3's decision. `authDetails.username` hazard -> Task 5 step 5 and fixture. Cutover 4 (coverage against real payloads) -> Task 3 fixtures from the live store; cutover 5 (secret reconciliation, one green run) -> Tasks 1 and 6; cutover 6's SPI re-anchoring -> Task 7. Out of scope, by design: P0-3 (transport, replay), P0-4 (STATS surface), P1-3..P1-5 (SCRAM material), the `.env.local` phantom cleanup beyond the two lines.

**2. Placeholder scan.** Every code step carries its code; the fixture step pulls from the realm and writes the synthetic ones inline; Task 6's `<this branch>` is the branch name the executor chose at setup.

**3. Type consistency.** `webhook_subject_resolve(const struct kc_webhook_event *, struct WebhookSubject *)` in Tasks 3 and 5; `sasl_cache_invalidate_id(const char *)` in Tasks 4 and 5; `handle_sessions_for_account(account, reason, do_kill, kc_id)` and `deauth_action_for(cptr, account, kc_id, do_kill)` in Task 5 only; `WH_SUBJECT_*` names identical in the header, the test and the handler.

**4. Review focus.** Each of the five lines names its test: 1 -> Task 2 case C; 2 -> `user-update-partial.json`; 3 -> `user-delete-bad-path.json` and the resource-type test; 4 -> `user-delete-actor-named.json` + Task 5 step 5; 5 -> `user-delete-root-username.json` + Task 6 step 3.

**Things to verify at execution time, not assumed here:** whether `ircd/test/Makefile.in` needs the explicit `.o` rule or the generic one already takes `CPPFLAGS` (the fixture path define must reach the compile either way); whether `enum Feature` is the type name `feature_bool` takes (`include/ircd_features.h`); and whether Keycloak needs a full recreate or a restart to re-read the SPI environment (Task 1 step 2 checks inside the container).

## Execution record (2026-09-23)

Executed inline (superpowers:executing-plans) on nefarious `fix/webhook-subject-by-id`, cut
from `75d8101` (the pushed tip of both fork branches), 9 commits `70f1a09..7b65b7a`,
unpushed. Tests on testnet `main`; SPI docs on `docs/ircd-contract` (2 commits off main).
Bed: `bed-deploy` merge `d3b0e8d`, both ircds on `ircd.202609232212`. Push commands and PR
text: `step5-pr-drafts-2026-09-23.md`. The user approved the plan and its four proposals as
written ("looks good").

### Commits

| Task | Where | Commit | What |
|---|---|---|---|
| 1 | testnet | 68e4f691 | `.env` (and `.env.local`) point the SPI at `nefarious:9090` with the ircd's secret |
| 2 | testnet | fe40cd41 | `keycloak-webhook-e2e.test.ts`, red on the old build |
| 3 | nefarious | 70f1a09 | pure `webhook_subject` decision, fixtures from the realm, cmocka |
| 4 | nefarious | f22b28d | positive-cache purge by id; `CI <name|*> [<id>]` |
| 5 | nefarious | ec30e19 | handler on the subject; id-aware walk match; parser drops the actor-name fallback |
| 6 | nefarious | 9d3d4b9 | a named re-enable purges the caches (negative cache after a refused attempt) |
| 7 | spi | c195c7a, f8a6e1c | README event formats + consumer contract; Java comments re-anchored |
| fix | nefarious | 8e7a3df | only `users/<uuid>` is the user; `users/<uuid>/credentials/<id>` purges |
| fix | nefarious | 137d50d | module and cmocka program gated on the Keycloak build; `configure` regenerated |
| fix | nefarious | 9f08338 | names from the purged cache reach id-less sessions; warnings |
| fix | nefarious | 7b65b7a | fixtures carry synthetic identifiers |
| fix | testnet | d66616c4, 48656404 | WHOIS helper reads its own whole reply; e2e pre-state assertions; hold off for the test user; skill notes |

### Fresh review (Fable) and fix pass

Verdict "Yes with fixes". Fixed, each with a test that failed first where one could exist:

1. Critical: a `USER`/`DELETE` or `UPDATE` on a sub-resource of the user (unlinking a
   federated identity is `DELETE users/<uuid>/federated-identity/<p>`) was read as the
   user's own deletion or disable. Only the bare path (or a synthetic path-less event) is
   the user. cmocka `test_subresource_delete_or_update_is_not_the_user`.
2. Important: sessions carrying no Keycloak id (authenticated through X3, relayed `AC R`
   without the id as prod X3 sends it, legacy hops, DB-restored ghosts) are unreachable by
   a nameless event. Partial cover: the id purge hands back the account names of the
   positive-cache entries it drops and those are walked too; "nothing names the subject"
   is a warning naming the id; README and this record say which classes are reached.
3. Important: `webhook_subject.c` and its cmocka program were unconditional and pull in
   jansson through `kc/kc_webhook.h`; both now ride configure's `KC_SRC` /
   `KC_CMOCKA_TESTPROGS`; `./configure --disable-keycloak && make` verified on a detached
   worktree of `7b65b7a` (module absent, tree and cmocka gate build).
4. Minor, fixed: `whoisAccount` marks earlier lines consumed before it asks; each e2e case
   asserts the account is visible before the admin action.
5. Minor, fixed: `users/<uuid>/credentials/<id>` under `DELETE` or `ACTION` purges the
   caches (`test_credential_removal_purges`).
6. Minor, fixed: the four-name cap warns; `.env` comment; fixtures scrubbed.

### Rulings (cost if wrong in the ledger)

- The user's "looks good" on the plan doc took the four proposals as decided (CI id form,
  `.env.local` edit, SPI docs only, ungated e2e).
- Task 1's gate is the Keycloak side (sends logged, no delivery failure) plus the
  functional proof; the ircd's L_INFO webhook lines turned out to reach `docker logs`,
  its L_DEBUG ones do not.
- Task 2: a failed case re-enables the user in a `finally`, so cases cannot cascade.
- Task 3: the first "disable" fixture was a bare console toggle; a full-representation
  one was added beside it, and the Task 3 commit was amended (it had landed red).
- Task 6: case B retries its first login for up to 75 s (a refused attempt on a disabled
  account sits in the negative cache for `SASL_NEGCACHE_TTL`; a bare `{enabled:true}`
  toggle names the user only by id); a re-enable that names the user purges by name.
- Fix pass: the durable cover for id-less sessions (persist id to account at every
  id-carrying login; `kc_id` in the bounce-DB session record) is deferred to step 5c,
  where the restored-ghost id is already owed.
- Fix pass: hold is on by default (`BOUNCER_DEFAULT_HOLD`); the e2e test turns it off for
  its user, since a closed client's ghost is revived by the next login under the ghost's
  nick.

### Deferred (not fixed here)

- A bare API re-enable leaves a refused password in the negative cache for up to 60 s.
- Under `WEBHOOK_KILL_ON_*` a name-only match can disconnect an id-less client of a
  reused name (rename + id-less login + the switch on); no feature doc file carries it.
- The cross-server id purge has no bed observer; a pre-branch v3 peer relays `CI *`
  without the id (rollout window).
- The cmocka suite mirrors the parser's field mapping instead of driving `dispatch_event`.
- Bouncer observation for a bouncer-analyst pass: a client revived from a held ghost was
  classified as held (`IsBouncerHold`) two seconds later and its session destroyed on a
  delete; if a live client can carry that flag, a plain deauth exits it (ledger, green3
  investigation, `docker logs nefarious` 22:16:12-16Z).

### Operator notes

- A Keycloak delete, disable (`enabled:false` in the update), admin password reset or
  credential removal reaches the ircd by the user's Keycloak id; nothing in the event
  names the user and nothing needs to. `CI <name|*> [<id>]` carries the id to every fork
  server; old receivers ignore it.
- Sessions authenticated through X3, a legacy hop, or restored from the bouncer DB carry
  no id and are reached only through a name (the event's, or one the purged cache knew);
  the log warns with the id when nothing names the subject.
- `WEBHOOK_KILL_ON_DELETE` / `_DISABLE` stay off; a re-enable purges by name only when
  the event names the user (console save), not for a bare API toggle.
- Bed: `.env` and `.env.local` must agree on the SPI URL and secret; Keycloak reads them
  at start (recreate after a change); `docker logs keycloak | grep "Sending admin event"`
  and `docker logs nefarious | grep WEBHOOK` are the delivery oracles.

### Final bed run

See the ledger's last lines (this record was written while the last end-to-end run was in
progress; the result line follows below when it lands).
