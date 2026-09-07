# Bouncer rebind refused on burst-time N — sessid tag missing in peer's burst

**Status:** Both Options landed and committed.  B (nefarious 219ab03) as
the receiver-side fallback; A (nefarious 8cf493c) as the principled
sender-side fix.  Receiver-side acc_ts_match stays as defense-in-depth
until production confidence in A; demote/remove as a follow-up.
**Author:** ibutsu
**Date:** 2026-05-19
**Trigger:** observed in X3 logs whenever `leaf` re-links to `nefarious` carrying user `ibutsu` while `nefarious` holds a bouncer ghost for ibutsu (`BjAAD`)

## Symptom

Every time `leaf` re-bursts a user whose account matches a held
bouncer ghost on `nefarious`, X3 (and any other peer running classic
collision detection) emits:

```
W: DH D BjAAD :x3.services (Overruled by older nick)
W: DHAAA P #MrSnoopy :[05:17:04] QUIT ibutsu (… on testnet.…)
                                     (Overruled by older nick)
```

Then nefarious's *post-fall-through* alias attach lands:

```
   Bj BX C ACAAA BjAAD ibutsu …
   BjAAD Q :Promoted to alias of ibutsu
   Bj D BjAAD :x3.services (Ghost 5 Numeric Collided)   ← echoed kill
   Bj BX C ACAAA BjAAE ibutsu …                          ← retry on
                                                          fresh primary
```

User experience: a few seconds of session churn on every link bounce,
visible "QUIT … (Overruled by older nick)" in op channels, X3
auth-stamp warnings, GetUserN-couldn't-find-user noise.  No data
loss — the retry on a fresh primary numeric eventually settles —
but it's protocol-level garbage.

## Why this happens

### The path that's *supposed* to handle this — `bounce_rebind_ghost_to_remote_primary`

[m_nick.c:500-524](nefarious/ircd/m_nick.c#L500-L524) has a dedicated
ghost-rebind branch.  When peer introduces a primary whose account
matches our held ghost's account, it calls
`bounce_rebind_ghost_to_remote_primary` — a wire-invisible local
rebind, no kill, no broadcast.  This is exactly the right shape for
the leaf-relinks-with-ibutsu case.

### Why it refuses in practice

The rebind has an authorization gate at
[bouncer_session.c:5369-5394](nefarious/ircd/bouncer_session.c#L5369-L5394):

```c
int origin_match = (0 == strcmp(session->hs_origin, cli_yxx(server)));
int sessid_match = (wire_sessid && wire_sessid[0]
                    && 0 == strcmp(wire_sessid, session->hs_sessid));

if (!origin_match && !sessid_match) {
    return -1;     /* falls through to standard collision logic */
}
```

For the observed scenario:
- `session->hs_origin = "Bj"` (the ghost was created on testnet).
- `cli_yxx(server) = "AC"` (leaf is introducing the new N).
- → **origin_match fails.**
- `cli_s2s_sessid(link)` = `""` — leaf's burst-time N for ACAAA
  doesn't carry a `,S<sessid>` compact tag.
- → **sessid_match fails.**

Both fail → rebind refused → fall through to standard nick collision.
nefarious emits + forwards the N normally; X3 and other peers run
classic newer-vs-older TS resolution; KILL is emitted; ghost dies.

### Why leaf doesn't carry `,S` in the burst N

[send.c:486-496](nefarious/ircd/send.c#L486-L496) — sessid emission
in `format_s2s_tags_with_client` looks at:

```c
if (cptr && cli_s2s_sessid(cptr)[0]) {
    sessid_tag = cli_s2s_sessid(cptr);
} else if (s2s_sessid_override[0]) {
    sessid_tag = ...;
}
```

For a *relayed* message, `cli_s2s_sessid` was populated by parse-side
preservation of the incoming `,S` tag.  But for an *originating*
emission — leaf bursting its own local user `ACAAA` — there's no
incoming `,S` to preserve, and nothing sets `s2s_sessid_override`
before the burst N.  Result: no `,S` segment.

This is the gap.  Leaf knows ACAAA is part of a bouncer session
(it received the BS C broadcast when the session was created on
nefarious).  But the burst N emission doesn't consult that session
record.

## Fix options

### Option A — emit `,S` during burst-time N for users with a known bouncer session

Server-side fix on the *emitting* side (leaf).  At the point where
leaf emits N for its local user during burst, look up the session
record by account, and if found, prepend `,S=<hs_sessid>` to the
S2S tag prefix via `s2s_sessid_override`.

**Pros**
- Fixes the root data-flow gap, not just the symptom.
- All BX-aware peers benefit automatically.
- No protocol change; uses an already-defined compact tag.

**Cons**
- Touches the burst emission path, which is high-traffic and has
  invariants around ordering ([[project_bx_r_yield_burst_order]],
  [[project_bouncer_bxf_handshake]]).  Risk of accidental side
  effects.
- Requires audit of which other N-emission sites also need this
  treatment (register_user, set_nick_name, …).

### Option B — add `acc_create_match` to the rebind auth gate

In `bounce_rebind_ghost_to_remote_primary`, add a third valid-match
condition:

```c
int acc_create_match = (incoming_acc_ts != 0
                        && incoming_acc_ts == cli_user(ghost)->acc_create);

if (!origin_match && !sessid_match && !acc_create_match) {
    return -1;
}
```

The +r flag in the N introduction carries `account:ts` syntax;
parsing the TS gives `incoming_acc_ts`.  `cli_user(ghost)->acc_create`
is populated at session restore from `bsr_acc_create`.  For
legitimate same-account identity, both equal.

**Pros**
- Receiver-side fix; doesn't touch the emission path.
- Tighter than removing the gate — still requires a per-account
  identity signal.
- Account TS is set by services on REGISTER and never changes for
  a live account → effectively a stable session-identity hash.

**Cons (architectural — see "Same-account ≠ same session" below)**
- Cannot distinguish "bouncer-intentional reconnect" from "plain
  authed connection that happens to share an account."  Account TS
  is the same in both cases.
- Doesn't fix the root data-flow gap — burst N still lacks `,S`,
  just the receiver accepts an additional fallback signal that's
  too coarse to be architecturally correct.
- Account TS is observable by any peer that has ever seen the user.
  A byzantine peer could forge it.  Less of a concern on an
  operator-controlled bus, but still a weakness vs sessid which is
  a UUIDv7 known only to servers genuinely holding the session.

### Option C — both A and B

A as the principled steady-state fix.  B as defense-in-depth for
edge cases where A doesn't fire (peer hasn't yet seen the BS C, or
session was restored from MDBX on both sides without a fresh BS C).

## Same-account ≠ same session (2026-05-19, important constraint)

A user with PERSISTENCE / hold-ON does *not* necessarily want every
connection authed to that account to claim the bouncer session.
Examples of legitimate "non-bouncer connection, same account":

- User has bouncer hold ON, gets held as `BjAAD` on hub.  User then
  opens a non-CAP legacy client (irssi without `draft/persistence`
  ACK) from a different machine, authed to the same account, with
  a *different* nick.  This is a separate presence — not a
  continuation of the bouncer session.
- A monitoring or probe client logs in with `+r` for account access
  to channel-list state, but doesn't want to claim the bouncer
  identity.

For these cases the held ghost must remain held; the new connection
must register as an independent +r'd user.

**Distinguishing the two cases requires a per-connection signal of
bouncer intent.**  The leaf knows it (it has the BS replica and
negotiated CAPs with the local user); the receiver doesn't get told
unless leaf emits something.  That signal is exactly `,S<sessid>`.

**Why Option B alone is insufficient:**

- `acc_create_match` fires on *any* +r'd same-account user.  A
  non-bouncer client picks any nick and connects — if their nick
  happens to match the held ghost (e.g., during a link-bounce window
  where leaf hasn't yet seen the ghost's burst), `acc_create_match`
  would rebind them silently into the session they didn't ask for.
- Normal operation hides this via leaf's local `NICKNAMEINUSE`
  check at registration time — once leaf knows about the ghost, a
  new local user can't pick that nick.  But the window before that
  burst lands is exactly when the rebind path runs.

**Why Option A is the architecturally correct answer:**

- Leaf emits `,S=<hs_sessid>` only for connections it knows are
  bouncer-eligible (account has hold ON *and* this specific
  connection is the locally-claimed continuation of the session).
- Receiver uses `,S` as the load-bearing authorization signal.
- Non-bouncer-same-account user → no `,S` → no rebind → both
  presences coexist correctly.
- Bouncer reconnect → `,S` carries the sessid → rebind succeeds.

**Single-session direction (profiles supersede multi-session)** does
*not* eliminate this distinction.  Profiles handle per-context
separation *within* a bouncer session.  They don't change the fact
that a non-CAP authed connection is a separate presence outside the
bouncer session entirely.  See [[project_bouncer_profile_model]].

## Recommendation

**B as the immediate symptom fix (landed 2026-05-19).**  Stops the
observed X3 noise / KILL churn during link bounces in the common
case where a CAP-aware bouncer client reconnects via leaf.  Coarse
enough to rebind the wrong client in edge cases, but those edges
are hidden by `NICKNAMEINUSE` enforcement in practice.

**A as the architectural fix — re-elevated to active follow-up.**
B alone leaves the non-bouncer-same-account hazard in the rebind
path.  Once A lands:
- Tighten the gate back: `origin_match || sessid_match` as the
  primary authorization, with `acc_create_match` demoted to a
  debug-only hint ("matched, but no sessid — probably a non-bouncer
  client; falling through to standard collision").
- The leaf-side `,S` emission becomes the single source of truth
  for "this N introduces a bouncer-session continuation."

**Audit checklist for Option A (when ready):**
- `register_user` (s_user.c) — emit `,S` if the user has an active
  session record.  Burst-time codepath via server_estab.
- `set_nick_name` (s_user.c) — same.
- Burst loop in m_burst.c / s_serv.c — same.
- `bounce_alias_create` / BX C path — already emits sessid context;
  verify ,S is set on the per-emission scratch.
- Verify `s2s_sessid_override` is cleared after the burst N, not
  carried into the next emission (existing auto-clear at
  format_s2s_tags_with_client:494 covers this).

## Implementation status (2026-05-19)

**Option B landed and committed** (nefarious 219ab03 — "bouncer/rebind:
accept acc_create_match as a third auth signal").  Symptomatic fix;
stops the observed X3 noise but has the architectural gap noted in
"Same-account ≠ same session" above.

**Option A landed and committed** (nefarious 8cf493c — "bouncer/sessid-
hint: prefer session.hs_sessid over cli_session_id").  Principled
sender-side fix; emits `,S=hs_sessid` for any user whose account has a
known session record, restoring sessid_match as the load-bearing
auth signal.

With both in place, the layering is:

  - **Steady state (Option A):** sender's `bounce_set_n_sessid_hint`
    looks up the session by `cptr's session` or `cli_account(cptr)`
    and emits `hs_sessid` as the `,S` compact tag.  Receiver's rebind
    succeeds via `sessid_match`.
  - **Defense-in-depth (Option B):** if Option A misses
    (unaudited N-emission site, MDBX-restore edge case where both
    sides restored independently with self-referential hs_origin,
    transient split-brain during convergence), the receiver's
    `acc_create_match` fallback still catches it.  Architecturally
    coarser but produces correct behavior in nefarious's
    bouncer model where hold-ON is account-level.

**Follow-up: tighten the gate.**  Once we have production confidence
that Option A covers all legitimate paths, the receiver's
`acc_create_match` signal can be demoted from "valid auth" to
"debug-only hint" (or removed entirely).  Gate becomes
`origin_match || sessid_match`, which is the strict design intent
from when the rebind path was first written.  Don't do this until
we've observed no production drift between the two signals.

Changes:

- [bouncer_session.h:1016-1024](nefarious/include/bouncer_session.h#L1016-L1024) —
  added `time_t incoming_acc_ts` to
  `bounce_rebind_ghost_to_remote_primary` signature.
- [bouncer_session.c:5369-5418](nefarious/ircd/bouncer_session.c#L5369-L5418) —
  auth gate now accepts a third valid signal: `acc_ts_match`
  (incoming TS == `cli_user(ghost)->acc_create`, both non-zero).
  Refuses only when all three (origin / sessid / acc_ts) fail.
  Updated debug log lists which signal authorized the rebind.
- [m_nick.c:472-498, 516](nefarious/ircd/m_nick.c#L472) — parse the
  `:ts` suffix from `+r account[:ts]` via `strtoll`; pass the result
  as the new arg.

**Test added** at [tests/src/ircv3/bouncer-cross-server-rebind.test.ts](tests/src/ircv3/bouncer-cross-server-rebind.test.ts):

- Connect Client A on PRIMARY, enable hold, record sessid.
- Abrupt disconnect → held ghost on PRIMARY.
- Reconnect Client B on SECONDARY same account.
- Query BOUNCER INFO from Client B → assert same sessid.
- Skipped when SECONDARY unavailable (single-server profile).
- **Passes 1/1 in 28s.**  Pre-fix would have failed because the held
  ghost gets killed and a fresh session is created on SECONDARY with
  a different sessid.

No regression observed in adjacent suites (testnet running healthy
under valgrind).

## Tests

This race is reliably observable on every link bounce of `leaf` (or
any IRCv3-aware peer that has a long-lived user matching a held
session on nefarious).  We can pin it with an integration test:

1. Connect a bouncer-enabled SASL'd client to nefarious (`ibutsu`).
2. PERSISTENCE SET ON, disconnect → leaves held ghost.
3. Connect a *second* IRCv3-aware client for the same account via
   `nefarious2` (leaf).
4. Drop nefarious2's link to nefarious (SQUIT) and re-link.
5. Watch X3's output (or nefarious's snomask) for the
   `Overruled by older nick` KILL.
   - Pre-fix: KILL fires.
   - Post-fix: rebind succeeds, no KILL.

Could land in `tests/src/ircv3/bouncer-cross-server-rebind.test.ts` or
similar.  Re-link via SQUIT is testable via X3 oper command.

## Out of scope (deferred)

- **Audit other N-emission sites for `,S` propagation.**  Beyond
  burst, look at the relay paths, the `BX P` (alias promote) wire
  emission, and `bounce_setup_local_alias`.  Option A territory.
- **Pre-burst session-state exchange.**  Bigger protocol change —
  exchange session records BEFORE the N burst so receivers know
  about all bouncer relationships up-front.  Out of scope.
- **Legacy peer support.**  This fix targets BX-aware peers only.
  For genuinely legacy peers (no BX support at all), the
  `project_legacy_peer_bouncer_collision.md` discussion of
  Reject/Allow-renamed/Legacy-as-alias is the relevant frame.
  Different problem; not addressed here.

## Related memory

- [[project_legacy_peer_bouncer_collision]] — three policy options for
  legacy peers; this fix is for BX-aware peers.
- [[project_bouncer_race_scenarios_survey]] — class 2 (BX C vs N)
  notes that this case "is OK by design."  This plan shows it's
  *not* OK when the held session originated on a different server
  than the peer reintroducing the user.  Worth updating the survey
  once the fix lands.
- [[project_bouncer_legacy_collision_cascade]] — "fix collision
  outcomes, not consequences" — the rebind path IS an outcome fix
  (suppress the collision before it fires).  Aligned with that
  guidance.
