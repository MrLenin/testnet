# Web push: trigger on an unattended account, not only on HOLDING (scoped 2026-09-03)

## Status 2026-09-03: SHIPPED (`8df21bc` + `daa371c`, branch ircv3.2-hardening, pushed both remotes)

Implemented as scoped, with one change: the "remote alias counts as attending" gap was closed
first by replicating per-connection activity live (`8df21bc`: `BX U <numeric> la=<ts>` on a
connection's first message after 5 min quiet, aliases AND primaries; promotion now picks the
most recently active alias; WHOIS idle is session-wide; oper CHECK lists every connection with
its idle).  So remote aliases use the same idle rule as local ones.
Then `daa371c`: `webpush_attention.c` (pure, 5 cmocka cases), `WEBPUSH_IDLE` (900 s default,
`draft/webpush/idle` per-account override, 0 = held/away only), both triggers evaluate once per
session at its primary, `STATS webpush` suppression counters + last reason.
Bed: `bouncer-activity.test.ts` (2: remote-alias activity visible in CHECK + WHOIS idle;
promotion picks the active alias over the older idle one) and `webpush-attention.test.ts`
(no push while a connection attends, push once all idle, push when the remaining connection is
away) green with the webpush/keyring/limits suites (17/17).
Lessons: CHECK numerics are 290/291 (not 27x); an abrupt socket drop HOLDS the session and
promotes only at hold expiry — a clean QUIT promotes immediately; a test subscriber key must be
a real P-256 point or encryption fails before submission ("not submitted", not "sent").
Residue: no per-device targeting (every subscription is pushed; the read relay closes the
others); `docs/features/webpush.md` in the testnet repo is still the never-shipped X3 design.

## Problem

`webpush_notify_pm` / `webpush_notify_channel` push only when the recipient is a held bouncer
ghost (`IsBouncerHold(acptr)` and `hs_state == BOUNCE_HOLDING`).  That was right when the ghost
was the only recipient.  A power user keeps permanent connections (home, work), plus phone,
tablet, ad-hoc dev clients; the session is never held, so they never get a push — including
at lunch or after leaving the desk, which is exactly when they expect one.

The draft (ircv3 PR 471) leaves the "when" to the server: "the server will send push
notifications for a server-defined subset of IRC messages".  So this is ours to define.

## Rule

Push when the account is **unattended**: no connection of its session is *attending*.

A connection is attending when it is connected, not away, and has sent a message within the
idle window.  So the account is unattended when every connection is one of:

| state | source |
|---|---|
| held (no socket) | `hs_state == BOUNCE_HOLDING` — today's rule |
| away | the connection's own `con_pre_away != 0`; session-level `hs_effective_away` already aggregates this (present iff any connection is not away) |
| idle ≥ `WEBPUSH_IDLE` | `cli_user(c)->last` — the WHOIS idle clock; with `IDLE_FROM_MSG` (default on) it advances on PRIVMSG/NOTICE only, never on pings, MARKREAD, WHO, etc. |

Any attending connection → no push.  A desktop idle for hours and a phone app in the background
both count as unattended; the client the user is typing on does not.

Accounts without a bouncer session (single plain connection) get the same rule: away or idle
→ push.  Today they never push at all.

Everything else is unchanged: per-(account, origin) cooldown (`WEBPUSH_COOLDOWN`), mutes,
highlight rules, read-marker relay (stays ungated: it is how devices close notifications),
payload tiers, delivery and key binding.

### Cross-server connections

Away replicates network-wide (AWAY on the wire; the aggregation already sees remote aliases
via `findNUser`), idle does not: `ba_last_active` for a remote alias is refreshed only in the
link burst (`bounce_burst` → BS with `last_active`), never live.  Rule for v1: a remote alias
that is not away counts as **attending** (no push).  Conservative — a missed push, never a
spurious one — and prod's non-fork peers carry no aliases, so it does not bite there.  Follow-up
if it does: a coarse activity hint on BX U (e.g. on the first message after ≥5 min quiet), then
idle applies to remote aliases too.

### Configuration

- `FEAT_WEBPUSH_IDLE` (int, seconds, default 900): idle window; 0 disables the idle rule
  (held or away only).
- Per-account override `draft/webpush/idle` metadata (seconds; same namespace as the existing
  `payload` and `mute` keys, the fork's own).  Empty/absent = feature default.  Power users
  differ (10 vs 30 min); everything else stays server policy.

## Design

New pure module `webpush_attention.c/.h` (no ircd deps, cmocka-gated like `webpush_expiry`):

```c
struct webpush_conn_state { int held; int away; long long last_msg; int remote; };
/* 1 when no connection attends: every entry is held, away, or (local and last_msg + idle <= now);
 * remote && !away && !held => attending.  n == 0 => unattended. idle <= 0 => idle rule off. */
int webpush_unattended(const struct webpush_conn_state *c, int n, long long now, long long idle);
```

Integration in `m_webpush.c`:

- `webpush_account_unattended(struct Client *acptr)` builds the array from the session:
  primary `hs_client` (held if `hs_state == BOUNCE_HOLDING`, away from `con_pre_away`, idle
  from `cli_user->last`), each `hs_aliases[i]` resolved via `findNUser` (local → same fields;
  remote → `remote = 1`, away from `cli_user->away`).  No session → the single client.
- `webpush_notify_pm`: replace the `IsBouncerHold`/`HOLDING` gate with
  `webpush_account_unattended(acptr)`; `acptr` must be the session primary (`!IsBouncerAlias`,
  `MyConnect`) so the decision runs once per message, not once per alias delivery.
- `webpush_notify_channel`: same predicate per member; skip aliases (`IsBouncerAlias(u)`) so a
  session is evaluated once.
- Suppression accounting for `STATS webpush`: counts of pushes suppressed as attended /
  cooldown / muted, and the last suppression reason.

## Tests

- cmocka `webpush_attention_cmocka.c`: empty set; all held; one attending among held; away
  everywhere; idle boundary (`last + idle == now` unattended, `+1` attending); idle rule off;
  remote non-away attends; remote away does not; mixed.
- Bed `tests/src/ircv3/webpush-attention.test.ts` (capture endpoint via webhook.site, as the
  prod probe): account with two live connections registered for push; oper `SET WEBPUSH_IDLE 5`
  and `SET WEBPUSH_COOLDOWN 0` for the run (restored after); PM from a third client while one
  connection is active → **no** request within 8 s; both connections quiet > 5 s → PM → request
  arrives; one connection sets AWAY, the other stays idle → PM → request; cleanup UNREGISTER.
  Needs outbound HTTPS from the bed's nefarious container (prod had it; verify first, else the
  test asserts on `STATS webpush` push counters instead).

## Order of work

1. Pure module + cmocka (red → green).
2. Integration + STATS counters.
3. Feature + metadata override, docs (`FEATURE_FLAGS_CONFIG.md`, `docs/features/webpush.md`).
4. Bed test; deploy; push.

Estimate: half a day.  Residue to record on completion: remote-alias idle (above); no
per-device targeting (every subscription of the account is pushed — the read relay closes the
others, as today).
