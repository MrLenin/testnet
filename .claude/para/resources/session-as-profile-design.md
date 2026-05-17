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

A profile is a named map of preferences scoped to one account.  Every account has an implicit `default` profile.  Resolution order for any setting is:

1. Per-connection override (set on this connection only — e.g. `PERSISTENCE SET ON` for this socket)
2. Active profile (set via `PERSISTENCE ATTACH <profile>` at registration)
3. `default` profile
4. Server default (`FEAT_BOUNCER_DEFAULT_HOLD` etc.)

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
| Channel auto-join | (shared identity) | — | **no** (shared) |
| Nick | (shared identity) | — | **no** (shared) |
| Channel memberships | (shared identity) | — | **no** (shared) |
| Account session lifetime | (shared identity) | — | **no** (shared) |
| Chathistory contents | (shared identity) | — | **no** (shared) |

### What's NOT profilable (intentionally)

These are *identity* concerns, not *behaviour* concerns:

- **Nick.**  One identity = one canonical nick at a time.  Aliases under the session share the nick.
- **Channel memberships.**  The bouncer's view of "which channels does this user occupy" is a property of the user, not the profile.  A profile may choose to suppress the JOIN burst on resume (auto-rejoin = off → explicit JOIN command required), but it does not change *which* channels are occupied at the network level.
- **Chathistory.**  History is keyed by identity — `account` and channel — not by profile.

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

The `default` profile is implicit, always present, cannot be deleted, and is the
target whenever `ATTACH` is omitted.

## Storage layout

Under the existing server-managed `bouncer/` prefix:

```
bouncer/profile/<name>/<key>     # one entry per (profile, key)
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
| Race surface | concurrent-identity collisions, BX/BS reconcile | none beyond current single-session |
| Nick management | each session has its own nick | shared nick |
| Storage scaling | per `(account, sessid)` | per `(account, profile_name)` |
| Aliases | each session can have N aliases | one session, N aliases, each may have its own active profile |
| User-visible benefit | "work nick" + "personal nick" under same creds | "mobile profile" + "desktop profile" under same identity |
| Wire complexity | BS A/D/X/T per session, post-burst reconciles | flat metadata reads at attach |

Profiles deliver ~80% of what users actually want from multi-session, at ~10%
of the implementation complexity — because they sit *above* the bouncer
identity layer rather than threading new identity dimensions through every
sub-system (m_nick, BURST, BS sync, KILL semantics, chathistory keys, …).

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
   - Pro: useful for "I'm switching modes" use cases.
   - Con: harder to reason about (caps/umode changes require re-emission).
   - Recommendation: **no for v1**.  ATTACH is registration-only; mid-session
     changes go through individual `PERSISTENCE SET` commands.

2. **What about per-connection ad-hoc settings that don't belong to any profile?**
   - Today's `PERSISTENCE SET ON` writes to `bouncer/hold` — does it write
     to the active profile's hold setting, or to a connection-only override?
   - Recommendation: writes go to the active profile (resolution layer 2),
     not connection-only.  Connection-only overrides would need a new
     `PERSISTENCE SET TEMP ON` or `PERSISTENCE OVERRIDE` form.

3. **Cap-value advertisement.**
   - CAP value token currently planned: `draft/persistence=replay-control,list,attach`.
   - With profiles: `draft/persistence=profile,attach,replay-control`?  Or
     keep `list` and let it mean "I support LIST whether of profiles or
     sessions"?

4. **Profile inheritance.**
   - Should `CREATE foo FROM bar` deep-copy bar's settings into foo, or
     link foo to inherit-from bar?  Inheritance is more flexible but adds
     resolution complexity.
   - Recommendation: deep-copy on create (simpler).  Re-link via
     explicit SET if user wants live propagation.

5. **Server-default profile.**
   - The server has its own defaults via FEAT_*; should it also expose a
     "server-default profile" that users can ATTACH for "fresh slate"
     behaviour?  Or is the implicit fallthrough to FEAT_* sufficient?
   - Recommendation: implicit FEAT_* fallthrough.  Don't expose a magic
     server-default profile name.

## What to do next

1. **Decide:** profiles or sessions?  (User decision.)
2. If profiles: rewrite the unification plan's Phase 4 in profile terms.
3. If profiles: update the `(account, sessid)`-neutrality memory to reflect the new direction.
4. Either way: phases 1-3 from the existing unification plan are unchanged.
   STATUS/GET/SET ON/OFF/DEFAULT, batch wrapping, REPLAY trio, DETACH all
   still apply — they're about the *current profile* in the new model.

## Related

- [draft-persistence-unification](../projects/draft-persistence-unification.md) — the active plan; Phase 4 is the section this proposal reshapes.
- [[bouncer-multi-session-neutral]] — memory note this would supersede.
- [[project_oper_session_state]] — IsOper-as-session-attribute also reshapes under profiles (oper-as-profile-attribute instead).
