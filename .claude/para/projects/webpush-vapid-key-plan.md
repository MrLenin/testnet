# Web push VAPID key plan (recovered 2026-09-03)

## Status 2026-09-03: IMPLEMENTED (fork `be89a65`, branch ircv3.2-hardening)

Items 2–4 of the order of work shipped in one commit: import-failure fallback + quarantine
+ snomask notice, the key ring (`webpush_keyring.c`, pure, 8 cmocka cases), subscription
key id (5th record field; `WP R`/`WP B` 7th param; pre-ring records stamped at first boot),
per-connection binding (`con_vapid_seen`, recorded by every 005 emitter), `WP K` private-key
transport (burst first, then on mint; only new keys propagate), scheduled rotation
(`WEBPUSH_KEY_ROTATE`, 90 d default), manual key via `WEBPUSH_VAPID_PRIVKEY` (gen max+1,
`RESET` demotes), 403 reaping after three in a row, `STATS webpush`.  Bed test:
`tests/src/ircv3/webpush-keyring.test.ts` (convergence, SET-driven rotation reaching the
secondary, old-key binding + retention).  Docs: `P10_PROTOCOL_REFERENCE.md` WEBPUSH,
`FEATURE_FLAGS_CONFIG.md`.

Decisions taken while implementing (deviations from the text below):
- **Prune grace.** "Pruned at once when unreferenced" was unsafe: a peer prunes a key it
  holds no reference to, then a `WP R` bound to that key arrives (a client that saw it in
  ISUPPORT on another server).  Rule now: not current AND (unreferenced AND ≥ 1 day old, OR
  older than `WEBPUSH_EXPIRE`).  A newcomer's throw-away key lingers a day, unadvertised.
  A first-time registration from a connection older than a day that saw a since-pruned key
  degrades gracefully: delivery falls back to the current key → 403 ×3 → reaped → the
  client re-registers at its next login.
- **Prune clock = retirement, not creation (`d04312f`, 2026-09-05).** Both prune windows
  (grace for unreferenced keys, WEBPUSH_EXPIRE for referenced ones) used to run from the key's
  creation, so a key rotated out after WEBPUSH_KEY_ROTATE was prunable the same tick once
  WEBPUSH_EXPIRE ≤ ROTATE (PR #107 sets both to 90 d) — with live subscriptions still bound to it.
  Retirement = creation of the oldest key that outranks it (the current key's when none does);
  the ring keeps no retired-at field, so nothing on the wire or on disk changes.
- **Who rotates.** Only the current key's origin server runs the scheduled rotation (any
  server once the origin is gone), so a linked network rotates once per period, not once
  per server.  Two servers that both consider the origin gone can still mint two keys of the
  same generation; the older wins, the other retires and prunes.
- **Manual flag is local bookkeeping**, replicated at mint and mutable only by `RESET` on the
  origin; the current-key rule never reads it — it only stops auto-rotation from displacing
  an operator's key.  Clearing does not remove or demote the key elsewhere; the origin's
  scheduled rotation displaces it when due.
- **No oper `WEBPUSH ROTATE` subcommand** (that would extend the spec's verb; see
  `feedback_no_invented_extensions`).  On-demand rotation = `SET WEBPUSH_VAPID_PRIVKEY` with a
  fresh scalar (`openssl ecparam -genkey -name prime256v1 | openssl ec -outform DER | tail -c
  32`, or the test helper) — or wait for the schedule.  Status = `STATS webpush`.
- **`WP B` is now relayed onward** (was: single hop).  Servers behind the peer never saw a
  split-off leaf's registrations otherwise.  Idempotent per hop (newer `armed` wins).
- **`WP V` never adopted** (was: filled an empty slot with a key the server could not sign
  with).  Still emitted on change for pre-ring peers.
- **Migrated single key** gets `created = first boot of the ring code` (its mint time is
  unknown), generation 0, origin = this server.  On a linked network the first server to
  boot the ring code wins the legacy-key tie; both keys stay while referenced.
- **Cap value** `draft/webpush=vapid=` left as is (decision still pending with Sean); the
  binding reads only the ISUPPORT emissions.

Residue (not verifiable on the bed, no capture endpoint): delivery actually signing with a
retired key for its subscriptions; the 403 reap path; migration of a real pre-ring store
(bed stores were fresh).  Prod rescue (order-of-work item 1) still stands: on the first boot
of this build prod's bad persisted blob is quarantined and a key generated — the config
override is no longer needed for the rescue, only if a specific key is wanted.

The plan for VAPID key handling was agreed before the webpush foundation shipped (F2-c, week of
2026-07-21) and was never written down beyond bullets; the user restated its gist on 2026-09-03
while chasing why prod advertises `draft/webpush` without a key. Written traces:
`docs/investigations/WEBPUSH_INVESTIGATION.md` Phase 4 item 4 ("VAPID key rotation"),
`docs/features/webpush.md` (an X3-generates-the-key design that never shipped),
`.claude/para/projects/crdt-mesh-tier-c-webpush.md` ("VAPID key (WP V) is a per-server key, not
per-subscription — OUT of scope"). Spec: ircv3/ircv3-specifications#471, "IRC servers SHOULD
occasionally rotate their VAPID keys, by generating new keys for future IRC connections (old keys
must be kept at hand for existing subscriptions)."

## The plan (user's words, 2026-09-03)

> Auto-gen key, send it S2S, rotate periodically updating the other servers.
> Config overrides for manual key management.

Auto-generation "was the foundation on which the rest was to build on."

## What the fork has (the foundation)

- `webpush_setup()` (m_webpush.c): priority 1 config key `WEBPUSH_VAPID_PRIVKEY` (imported and
  persisted), priority 2 the key persisted in the webpush store (`vapid_privkey` in the config
  CF), priority 3 generate + persist. Runs at boot inside the libkc block (build must be
  `--enable-keycloak`, `kc_init` must succeed) and again on any change of the config feature.
- `WP V :<pubkey>` broadcast on change; peers `set_vapid_pubkey()` from it, so the advertised
  public key converges network-wide. **Only the public key crosses the wire.**
- Cap value `draft/webpush=vapid=<pub>` and ISUPPORT `VAPID=`, both from the one advertised key.
- One key slot; no rotation; subscriptions record no key.

## What is missing

1. **Private key sharing.** The server that holds a session pushes for it and must sign with the
   key the subscription was created under. With only the public key shared, a subscription
   registered on server A and pushed by server B fails (403) unless every server was provisioned
   with the same `WEBPUSH_VAPID_PRIVKEY`. The plan's "send it S2S" must carry the private half.
   Options: (a) a `WP K <keyid> <privkey_b64> <created>` token between servers — P10 links carry
   account passwords and SASL material already, and fork links are TLS where configured; (b) keep
   per-server keys and pin each subscription to its registering server (pushes routed there) —
   breaks the "any server pushes for held sessions" model; (c) derive from a shared config secret.
   (a) matches the plan; note the hub-fanout trust implication in the doc when implemented.
2. **Key ring.** The store's config CF holds N keys (id = public key, plus created time and a
   `current` marker). `webpush_setup()` loads the ring; generation appends a new current key.
3. **Subscription ↔ key binding.** The stored record gains a key id (6th field after `armed`);
   `WP R`/`WP B` carry it; delivery (`notify_iter_cb` → `webpush_notify`) signs with that key.
   Records without a key id (pre-ring) bind to the key that was current when the ring was
   introduced (migration at first boot: stamp them with the sole existing key).
4. **Rotation.** `WEBPUSH_KEY_ROTATE` seconds (0 = never; spec says "occasionally"; a default of
   90–180 days is reasonable): a timer mints a key at generation `max + 1`, persists it, broadcasts
   `WP K` + `WP V`, re-announces the cap value (cap-notify) and ISUPPORT. Old keys stay until no
   subscription references them, then are pruned (the sweep can do it).
5. **Manual management (config override).** `WEBPUSH_VAPID_PRIVKEY` set → that key becomes the
   current key on every server that has it (imported into the ring, not replacing it); clearing
   it returns to auto-generation. An oper `SET` of the feature rotates on demand.
6. **Clients.** A client that registered under an old key keeps working (server signs with it);
   on next login it sees the new `vapid=` and, per spec, re-registers when the key it holds
   differs — the spec expects clients to compare the advertised key with the one they subscribed
   under. The expiry sweep ages out subscriptions of devices that never come back.

## Prod state 2026-09-03 — RESOLVED (root cause found 13:00 EDT)

`STATS webpush` on the ring build: "Store: available, ring not loaded", no error → setup never
ran.  `webpush_setup()` was called only inside `#ifdef USE_LIBKC` after `kc_init()`, and
configure's `--enable-keycloak` **defaults to OFF** — a hand-built prod without the flag has
the whole block compiled out: nothing fails, nothing logs, the cap stays on, no key ever.
(The "bad persisted blob" theory below was wrong; wiping the store proved it.)  Fixes:
`31bfe3f` key setup runs regardless of the transport + `STATS webpush` Delivery line +
`kc_transport_ready`; `<next>` the cap is turned OFF with a CONFIG-level error naming the
fix when no transport exists (a cap that cannot deliver is a lie to clients).  Prod needs a
rebuild with `./configure --enable-keycloak` (libcurl + libjansson dev packages); no
Keycloak{} block is required for webpush alone.

### (superseded) original suspicion

Prod advertises `draft/webpush` bare: feature on, store open, code compiled in (both setup
strings present in the binary), no webpush line in the log (LS_SYSTEM not logged there). Setup
is failing at runtime before a key exists. Suspect: a persisted key blob from an earlier build
that `webpush_import_vapid_key` rejects — that path returns without falling back to generation.
Rescue that fits the plan: set `WEBPUSH_VAPID_PRIVKEY` (config override), rehash; it is imported
and persisted, and becomes the ring's first key later. Also worth fixing in code: on a persisted
key that fails to import, log and fall through to generation instead of returning.

## Order of work

1. Rescue prod (config key), confirm `vapid=` and the 005 token.
2. Import-failure fallback + a `SET`-driven regenerate.
3. Key ring + subscription key id + migration (single-server complete, spec-compliant rotation).
4. `WP K` private-key transport + rotation broadcast (multi-server).
Estimate: 2–3 days for 2–4, cmocka on the ring/record parsing, bed test with a rotation forced
by `SET` and a subscription registered before it still delivering (needs a capture endpoint —
Sean's round-trip harness shape).

## Scenario: the key fails to load (prod, 2026-09-03)

Today `webpush_setup()` has three outcomes when the store holds a key blob that will not import:
log at L_ERROR, return -1, advertise nothing — and, on a linked network, adopt the first peer's
public key via `WP V` (the `V` handler fills an empty slot) while holding no private key at all,
so the server advertises a key it cannot sign with. Neither is acceptable. Rules:

1. **Distinguish transient from permanent.** Store not open → transient: keep the slot empty,
   advertise no `vapid=` (clients must not register), retry setup on the next maintenance tick.
   Import failure of a present blob (wrong length, bad scalar, provider refuses it) → permanent
   for that blob.
2. **Permanent failure never leaves the server keyless.** Fall through to the next source: config
   key, then a peer's ring (see convergence; with `WP K` the private half comes from peers and the
   lost key is recovered outright), then generation. Log at L_ERROR *and* send an oper notice
   (snomask) — prod drops LS_SYSTEM, which is how this went unnoticed since May.
3. **Never overwrite the bad blob silently.** Move it aside under a `vapid_privkey.bad.<time>`
   config-CF key for post-mortem, then persist the recovered or new key in its place.
4. **Subscriptions bound to a lost key** (no peer had it): keep them; delivery gets a 403 from
   the push service, which today is not handled (only 410 reaps). Treat 403 with a VAPID error
   body as "key mismatch": do not reap on the first one (transient service issues look the
   same), but count per subscription and reap after N; the expiry sweep is the backstop. The
   client re-registers on its next login because the advertised `vapid=` changed — the spec's
   own recovery path.
5. **Operator visibility.** `STATS`-style or `WEBPUSH STATUS` oper output: current key id,
   ring size, per-key subscription counts, last setup error. Cheap, and it would have answered
   tonight's question in one command.

## Convergence: initial link, relink, netsplit

Model: the ring is a **set of immutable key objects** `(id = public key, private key, created,
origin, manual flag)`. Sets merge by union, so every exchange is idempotent and order-free.
`current` is not replicated; every server computes it from the ring with one rule, and the rule
must make rotation **deliberate**: a newcomer's boot key must never displace the network's key
(user, 2026-09-03: "so the vapid key will change every time a new server is linked" — it must
not). Each key carries an integer **generation**, assigned when it is minted: a boot-time key is
generation 0; a deliberate rotation mints `max(generation in ring) + 1`; a manual config key is
imported as `max + 1` too. Rule: highest generation wins; among equals the **oldest** `created`
wins; ties by id bytes. So an established network key beats every fresh server's generation-0
key, two sides of a split that both rotated tie on generation and the older one wins, and a
rotation or a config import wins everywhere the moment it replicates. Subscriptions reference keys by id (record field; `WP R`/
`WP B` carry it).

- **Initial link.** The burst sends the whole ring first (`WP K` per key, private half included:
  P10 links already carry credentials and are TLS where configured; a hub fans it out like any
  burst), then the subscriptions (`WP B`). Both sides union; both compute the same current; the
  cap value and ISUPPORT are re-announced only if current changed (cap-notify to clients).
  A fresh server with no key of its own therefore comes up with the network's key and never
  generates one. Today's behaviour (each server its own key, `V` only fills an empty slot, no `V`
  in the burst) is replaced entirely.
- **Fresh network, two independently generated keys.** Server one boots and generates A; server
  two boots and generates B; they link. Both are generation 0, so the **older** one is current
  and the other is **retired**: still in the ring, still signs every subscription registered
  under it, never advertised again, never used for a new registration. "Retired" is not a third
  state, it is simply "in the ring and not current"; nothing is demoted by hand.
- **A new server joins an established network** (the common case: a reinstall, a new leaf).
  Its boot key is generation 0 and younger than the network's key, so it loses on arrival and
  the network's advertised key does not move. A retired key with **no local subscription
  referencing it** is pruned at once, not by the age rule, so a newcomer's throw-away key is
  gone within the first burst. Deliberately no "generate lazily to avoid this" trick: a server
  must be able to advertise a key to its first client before any link exists.
- **Binding a registration to the key the client actually used.** REGISTER carries no key, and
  a client registers with whatever `vapid=` it saw at CAP LS / 005 — which on a server whose
  current key changed since then is the *old* one. Binding to "current at REGISTER time" would
  silently mis-sign those. The spec carries the key in exactly one place, the `VAPID` ISUPPORT
  token (`draft/webpush` has **no** cap value in the spec; the fork's `=vapid=` cap value is a
  local extension — decision pending: drop it for fidelity once Sean confirms his client reads
  ISUPPORT). A client can therefore learn the key at these moments only: the `ISUPPORT` reply
  during CAP negotiation for clients that negotiated `draft/extended-isupport` (the fork
  implements it, `m_isupport.c`), the 005 burst right after registration, and a later 005
  re-send (`send_isupport_update()`, which the fork already does on key change). The server
  records, per connection, the key id in each of those emissions as it makes them, and
  REGISTER binds the subscription to the last one recorded. A long-lived connection that registers after a rotation therefore
  binds to whatever it was last told, which is the only key it can have used. Cheap, exact,
  and it closes the race around every key change, including the newcomer case above.
- **Relink.** Same exchange; unions are no-ops when nothing changed. Subscriptions converge as
  now: newer `armed` wins, `U` for reaped/cleared endpoints.
- **Netsplit with rotation on both sides.** Each side rotated independently → two new keys of
  the same generation.  After rejoin the union holds both; the rule picks the older one current;
  the other stays in the ring and keeps signing for the subscriptions registered under it until
  they age out. Nothing is lost, nobody re-registers unless their client sees a new `vapid=`.
- **Split-born registrations** bind to whichever key was current on their side; the ring
  union makes them signable everywhere after rejoin.
- **A server that lost its key** (scenario above) gets it back from the first peer's ring: the
  loss is local and self-healing on a linked network. On a single server it is permanent, and
  generation + client re-registration is the recovery.
- **Manual key (config override) semantics under convergence.** Importing `WEBPUSH_VAPID_PRIVKEY`
  adds a key minted at `max generation + 1`, so it wins everywhere once replicated: one server's
  config change rotates the network. Two servers configured with different manual keys: same
  generation, the older import wins deterministically, both remain usable. Clearing the config does not remove
  the key from the ring (subscriptions may reference it); it just stops winning the manual rule
  once… (decision needed: clearing = key demoted to auto-flag, or left manual until rotated by
  a newer manual key? Proposal: demote to auto on clear, replicated as a flag update — the one
  mutable field, LWW by clear-time).
- **Pruning.** A key is dropped when it is not current and no local subscription references it
  — immediately if it was never referenced here, else once it is older than `WEBPUSH_EXPIRE`
  (after that no live subscription anywhere can reference it, since subscriptions age out on
  the same clock). Pruning is local; a peer that still has
  it re-sends it in the next burst and it is re-adopted — harmless, bounded by the same rule.
- **Ordering hazard to avoid:** never apply a `current` from the wire; never let a `WP V`
  overwrite a key we can sign with (the old handler's rule was right for the wrong reason). `WP
  V` becomes advisory/legacy: peers on the ring protocol ignore it; a legacy peer still gets one.

Tests for this section: cmocka on the ring (union idempotence, current rule incl. manual/tie,
prune rule); bed: two servers, register on A, push for a session held on B (needs the capture
endpoint), rotate on A via SET, confirm B signs old subscriptions with the old key and new ones
with the new; netsplit both-rotate then rejoin → one current, both keys present.
