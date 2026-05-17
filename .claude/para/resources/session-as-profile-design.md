# Bouncer "sessions" reframed as configuration profiles

**Status:** Design exploration, 2026-05-17.  Open for decision before locking Phase 4 of [draft-persistence-unification](../projects/draft-persistence-unification.md).

**Origin:** User suggestion — "instead of separate 'bouncer sessions' denoting different session identity, it represented different session settings/metadata (reasonably)."

## The shift

Today:

> A *session* is a persistent identity.  `(account, sessid)` keys a logical bouncer presence — its primary nick, channel memberships, chathistory window, and held state.  Multi-session-per-account is deferred but conceptually means "two simultaneous personas under one account."  ATTACH (Phase 4) was to mean "resume **this particular identity**."

Proposed:

> A *session* is a configuration profile.  `(account, profile_name)` keys a named bundle of preferences (hold, auto-replay, cap defaults, notification scope, …).  There is exactly **one bouncer identity per account**.  ATTACH means "load **this configuration** for the connecting client."

Under the proposed model the "two simultaneous personas" use case goes away.  Most users don't want two personas; they want "same identity, different client behaviour" — and that's exactly what profiles serve.

## Anatomy of a profile

A profile is a named map of preferences scoped to one account.  Every
account has an implicit `default` profile.  Resolution order for any
setting (most-specific first):

1. Active profile's own setting (if explicitly set)
2. Parent profile chain via inheritance (Q4) — walks until a parent
   has the key, or until a profile has no parent
3. `default` profile (the implicit parent of any profile that didn't
   `CREATE … FROM`)
4. Account-global setting — the `PERSISTENCE SET` target, written to
   the top-level `bouncer/<key>` (Q2)
5. Server default (`FEAT_BOUNCER_DEFAULT_HOLD` etc.)

The unsolicited `PERSISTENCE STATUS` at registration is the resolved
value at this chain for the connecting client's active profile.

### What's profilable

| Setting | Storage key | Default | Profile-scoped? |
|---|---|---|---|
| Hold preference | `bouncer/hold` | `FEAT_BOUNCER_DEFAULT_HOLD` | yes |
| Auto-replay on resume | `bouncer/auto-replay` | `FEAT_BOUNCER_AUTO_REPLAY` | yes |
| Auto-replay window/limit | `bouncer/replay-limit` | `FEAT_BOUNCER_AUTO_REPLAY_LIMIT` | yes |
| Auto-rejoin vs explicit-join | `bouncer/auto-rejoin` | on | yes |
| Notification scope | `bouncer/notify` | `all` | yes |
| Default cap set | `bouncer/caps` | — | yes |
| umode defaults | `bouncer/umodes` | — | yes |
| **Channel list (per-profile membership)** | `bouncer/profile/<name>/channels` | (per-profile) | **yes — reconciler model** |
| Nick | (shared identity) | — | **no** (shared) |
| Channel memberships (network-level) | (shared identity) | — | **no** (shared) |
| Account session lifetime | (shared identity) | — | **no** (shared) |
| Chathistory contents | (shared identity) | — | **no** (shared) |

### Channel membership (per-profile reconciler model)

The bouncer already decouples network-level presence from client-level
presence — this is what bouncers have done since ZNC's detached buffers.
Profiles extend that decoupling: **each profile owns its own channel
list**, and the bouncer reconciles network-level membership against the
union of those lists.

The model:

- Each profile has a **channel list** — the channels its attached
  clients want to be in.  Normal `/JOIN` and `/PART` on an attached
  client edit *that client's active profile's* list (not a shared
  account-wide set).
- **Network-level membership** is computed as the **union of channel
  lists across currently-active profiles**, plus a HOLD-driven sticky
  contribution from inactive profiles (see "Empty-attach behaviour"
  below).
- A profile is **active** when at least one alias is attached to it.
  Inactive profiles whose accounts have `bouncer/hold = ON` keep
  contributing to the union (the bouncer is holding the channels for
  their eventual reconnect).  Profiles whose account has
  `bouncer/hold = OFF` drop out when their last alias detaches.
- **Per-client delivery** is filtered on the active profile's channel
  list: a client on profile A only receives traffic for channels in
  A's list, even if the network is in more channels because profile B
  wants them too.

`/JOIN` and `/PART` semantics under the reconciler:

| Action by alias on profile A | Profile A's list | Network membership |
|---|---|---|
| `/JOIN #x` (not previously in A) | gains `#x` | joins `#x` if no other active profile already had it |
| `/JOIN #x` (already in A) | unchanged | unchanged (no-op) |
| `/PART #x` (in A) | loses `#x` | parts `#x` only if no other active profile still has it |
| `/PART #x` (not in A) | unchanged | unchanged (`/PART` returns ERR_NOTONCHANNEL from A's perspective) |

Aliases attached to the **same** profile see each other's `/JOIN` and
`/PART` (they share the profile's list, so a list change is reflected
across all of them).  Aliases on **different** profiles don't observe
each other's channel-list edits — even when the network is in the
channel because another profile wanted it.

Wire shape for editing a profile's channel list explicitly (e.g., from
tooling, or while attached to a different profile):

```
PERSISTENCE PROFILE SET <name> channels +#foo
PERSISTENCE PROFILE SET <name> channels -#bar
PERSISTENCE PROFILE SET <name> channels DEFAULT     # empty list (profile
                                                     # wants no channels;
                                                     # not the same as
                                                     # "delete the profile")
```

For end-users, `/JOIN` and `/PART` from any attached client just do the
right thing — they edit the active profile's list and trigger
reconciliation automatically.

#### Empty-attach behaviour

When all aliases for a profile detach, that profile's contribution to
the network-membership union depends on the account's HOLD state
(parallel to today's bouncer-session HOLD semantic):

| Profile state | `bouncer/hold` | Contributes to union? |
|---|---|---|
| Active (≥ 1 alias attached) | n/a | **yes** |
| Inactive (no aliases attached) | ON | **yes — sticky** |
| Inactive (no aliases attached) | OFF | **no — drops out** |

The reconciler runs whenever (a) a client attaches/detaches, (b) `/JOIN`
or `/PART` is issued, (c) a profile's channel list is edited via the
`PERSISTENCE PROFILE SET` long form, or (d) `bouncer/hold` is toggled.
On each run it computes the new union and issues whatever network
JOINs/PARTs close the delta — no JOIN/PART churn at the network level
unless a channel newly enters or newly leaves the union.

#### Why reconciler over view-only-filter

The earlier draft of this proposal picked a view-only filter (network
membership stays shared, profile filters delivery).  The reconciler is
strictly more powerful for the same wire surface — it gives users true
per-profile presence (different channels actually joined for different
profiles) rather than just per-profile views over a shared set.  The
cost is the reconciler bookkeeping, which is bounded: O(profiles × avg
channels per profile) work on each attach/detach/edit, all in memory.

The trigger-driven alternative (ATTACH directly emits JOIN/PART) is
still rejected — it churns the network presence on every profile
switch and has no good answer for the empty-attach case.

### What's NOT profilable (intentionally)

These are *identity* concerns, not *behaviour* concerns:

- **Nick.**  One identity = one canonical nick at a time.  Aliases under the session share the nick.
- **Chathistory.**  History is keyed by identity — `account` and channel — not by profile.  A client attached to a profile whose channel list doesn't include `#foo` can still query `CHATHISTORY #foo` and receive history (assuming the account had presence in `#foo` when the messages were stored).  Profiles drive what's joined at the network level and what's delivered live; they don't gate historical access.

## Wire surface (Phase 4 reshape)

Replaces the gist's `PERSISTENCE LIST` / `ATTACH` session-identity semantics:

```
PERSISTENCE PROFILE LIST
:srv PERSISTENCE PROFILE <name> [<key>=<value> ...]
:srv PERSISTENCE PROFILE ENDOFLIST

PERSISTENCE PROFILE CREATE <name> [FROM <source>]
PERSISTENCE PROFILE DELETE <name>
PERSISTENCE PROFILE RENAME <old> <new>

PERSISTENCE PROFILE GET <name> <key>
PERSISTENCE PROFILE SET <name> <key> <value>
PERSISTENCE PROFILE SET <name> <key> DEFAULT     # delete the override
                                                  # (falls back to default profile)

# Pre-CAP-END (during registration):
PERSISTENCE ATTACH <profile>
# Post-registration: no-op or error?  See open question #4.
```

Channel-list editing of *other* profiles uses the long form
`PERSISTENCE PROFILE SET <name> channels +#x` / `-#x`.  The active
profile's list is edited implicitly via the user's normal `/JOIN` and
`/PART` — no separate `HIDE`/`UNHIDE` command is needed under the
reconciler model.

The `default` profile is implicit, always present, cannot be deleted, and is the
target whenever `ATTACH` is omitted.

## Storage layout

Under the existing server-managed `bouncer/` prefix:

```
bouncer/profile/<name>/<key>     # one entry per (profile, key)
bouncer/profile/<name>/channels  # comma-separated visibility set
                                  # (empty / missing = "all channels")
bouncer/profile-default          # the user's preferred default profile name
bouncer/profile-list             # cached list of profile names (for LIST)
```

All under METADATA_VIS_PRIVATE, all S2S-broadcast via the existing
`abac5f4` path, all exempt from the per-target key-count budget thanks to the
Phase 1 carve-out.

The current `bouncer/hold` becomes either:

- **(A)** an alias for `bouncer/profile/default/hold` (back-compat), or
- **(B)** removed in favour of explicit profile addressing.

Option (A) is non-disruptive — legacy clients keep using `bouncer/hold` and it
implicitly addresses the default profile.

## Wire-level relationship to aliases

Aliases (under the existing single-session machinery) already have:

- Own Client struct, own P10 numeric
- Own CAP state
- Own labels and read-marker view

Adding "own active profile" is a natural extension.  `(account, alias)` already
exists as a routing dimension; `(account, alias, profile)` is just a refinement.

Aliases under one bouncer identity can each ATTACH to different profiles —
e.g., a mobile client and a desktop client connect simultaneously, both
aliased to the same identity, each with its own profile-driven behaviour
(mobile suppresses the channel-state burst, desktop wants the full replay).

## Comparison to the deferred multi-session model

| Concern | Multi-session (deferred) | Profiles (this proposal) |
|---|---|---|
| Identity invariant | Two identities per account | One identity per account |
| Race surface | concurrent-identity collisions, BX/BS reconcile | reconciler edits to network membership; bounded and in-memory |
| Nick management | each session has its own nick | shared nick |
| Channel membership | per-session, full identity duplication | per-profile, reconciled to a union for the shared network presence |
| Storage scaling | per `(account, sessid)` | per `(account, profile_name)` |
| Aliases | each session can have N aliases | one session, N aliases, each may have its own active profile |
| User-visible benefit | "work nick" + "personal nick" under same creds | "mobile profile joins 3 channels + desktop joins 50" under same identity |
| Wire complexity | BS A/D/X/T per session, post-burst reconciles | flat metadata reads at attach + a network-membership reconciler on attach/detach/edit |

Profiles deliver most of what users actually want from multi-session
while leaving the heavy parts of the identity layer alone.  nick
management, BURST, BS/BX sync, KILL semantics, and chathistory keys all
stay account-scoped — none of them learn about profiles.  The new
machinery is concentrated in two places: per-connection profile state
(an attribute on Client), and the network-membership reconciler that
maintains the union of active profile channel lists.  That second piece
is real work — it's not free the way the view-only filter would have
been — but it's localised to one subsystem instead of threading
identity dimensions through every send site.

## Migration from current code

- `(account, sessid)` → `(account)` for identity.  Drop the sessid-in-key
  plumbing (or keep it as `(account, "default")` for compat).
- Memory `[project_bouncer_multi_session_neutral](../../memory/project_bouncer_multi_session_neutral.md)` is **superseded** by this proposal.  Code written
  with multi-session keying becomes profile-keying instead.  The careful
  `(account, sessid)` neutrality we've maintained over the past month
  translates *directly* to `(account, profile)` — same shape, different
  meaning.
- Drop the "Phase 4: LIST sessions + ATTACH session" wire surface;
  replace with the profile surface above.
- `hs_enforced` (Phase 3) becomes a per-profile flag.

## Open questions

1. **Can a connection switch profiles mid-session?**
   *Resolved 2026-05-17:* **no for v1**.  `ATTACH` is registration-only.
   Mid-session preference changes go through `PERSISTENCE SET` (global)
   or `PERSISTENCE PROFILE SET <name> ...` (per-profile).  Revisit if
   real-world clients ask for in-flight profile swapping.

2. **Scope of plain `PERSISTENCE SET ON|OFF|DEFAULT`.**
   *Resolved 2026-05-17:* **global**.  The bare command writes to the
   account-level `bouncer/hold` key (same key as today — no schema
   change) and applies regardless of which profile is active.  Per-profile
   overrides go through the explicit long form
   `PERSISTENCE PROFILE SET <name> hold ON|OFF|DEFAULT`.

   This keeps the v1 user-facing command identical to what Phase 1
   already ships, and avoids the "did this write hit the global or
   the active profile?" question on every keystroke.  The effective
   value at a connection resolves via the chain in "Anatomy of a
   profile" above — account-global sits *below* the profile chain so
   per-profile settings can override the global default, not the other
   way around.

3. **Cap-value advertisement.**  *Resolved 2026-05-17:* keep `list` and
   let it mean "I support `LIST`, whether of profiles or sessions."  The
   value token stays `draft/persistence=replay-control,list,attach`
   regardless of which model wins — clients keying off the token don't
   care about the underlying semantics, just that LIST is supported.

4. **Profile inheritance.**  *Resolved 2026-05-17:* **inheritance, not
   deep-copy**.  `CREATE foo FROM bar` links foo to inherit from bar;
   subsequent changes to bar propagate to foo unless foo has overridden
   the specific key.  The full effective-value resolution chain is in
   "Anatomy of a profile" above.

   Cycles are refused at CREATE/SET time.  Inheritance applies to all
   profile keys (hold, auto-replay, channels, …) uniformly — no
   special-case carve-out for any key.  For the channel list
   specifically, inheriting means "the parent's channels are part of
   my list too unless I explicitly remove them" — which composes
   naturally with the reconciler: inheritance resolves to a flat list
   at union-computation time, so the reconciler sees one effective
   channel set per active profile, not a tree.

5. **Server-default profile.**  *Resolved 2026-05-17:* **implicit
   FEAT_* fallthrough**.  No magic server-default profile name on the
   wire; the resolution chain just walks past the user's profiles into
   the existing feature defaults.  Revisit if an operator use case
   appears (e.g. network-wide "lurker profile" presets).

6. **Per-delivery filter site.**  *Resolved 2026-05-17:* every
   channel-routed delivery (PRIVMSG, NOTICE, TAGMSG, MODE, TOPIC, JOIN,
   PART, …) checks the recipient connection's active-profile channel
   list before sending.  Half-filtering (resume burst only) leaks live
   messages from channels the profile doesn't want.  The lookup is
   cheap (small per-connection set) but every send site has to honour
   it.

7. **`/JOIN` and `/PART` under the reconciler.**  *Resolved 2026-05-17:*
   `/JOIN #x` from a client on profile A adds `#x` to A's channel list
   (and joins `#x` at the network level only if no other active
   profile already had it).  `/PART #x` removes `#x` from A's list
   (and parts at the network level only if no other active profile
   still has it).  Aliases on the same profile see each other's
   JOIN/PART; aliases on different profiles do not.  See "Channel
   membership" above for the full table.

8. **`PRIVMSG #x` to a channel not in the active profile's list.**
   *Resolved 2026-05-17:* per the reconciler, if `#x` isn't in your
   active profile's list, you aren't in it at the network level
   *unless* another active profile is in it.  Either way, the bouncer
   refuses outbound to a channel your active profile doesn't claim
   (returns `ERR_NOTONCHANNEL`).  If you want to talk in `#x`, `/JOIN
   #x` first — that grows your profile's list and joins network-side
   if needed.

   This is a clean break from the view-only-filter draft, where
   off-view sends would have been allowed-but-invisible.  Under the
   reconciler, "your active profile is your IRC reality" — the
   bouncer doesn't pretend you have presence somewhere your profile
   says you don't.

## What to do next

All nine open questions are resolved (2026-05-17).  Next steps:

1. Rewrite the unification plan's Phase 4 in profile terms (the
   reconciler model with per-profile channel lists, inheritance,
   account-global `PERSISTENCE SET` semantics, and FEAT_* fallthrough).
2. Update the `(account, sessid)`-neutrality memory to reflect the
   new direction — the keying shape is preserved, the *meaning*
   flips from identity to profile.
3. Phases 1-3 from the existing unification plan land unchanged.
   STATUS/GET/SET ON/OFF/DEFAULT, batch wrapping, REPLAY trio, and
   DETACH all still apply — they're about the *current profile* in
   the new model.
4. Scope an implementation plan for the network-membership reconciler.
   It needs: per-profile channel-list storage, inheritance resolution
   that flattens at union-computation time, an attach/detach hook that
   re-runs the union, a JOIN/PART delta emitter, and per-delivery
   profile-list checks at every channel send site.  HOLD-driven
   stickiness composes with the existing `bounce_session` HOLD
   machinery.

## Related

- [draft-persistence-unification](../projects/draft-persistence-unification.md) — the active plan; Phase 4 is the section this proposal reshapes.
- [[bouncer-multi-session-neutral]] — memory note this would supersede.
- [[project_oper_session_state]] — IsOper-as-session-attribute also reshapes under profiles (oper-as-profile-attribute instead).
