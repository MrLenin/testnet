---
title: "`draft/persistence` Extension"
layout: spec
work-in-progress: true
copyrights:
  -
    name: "MrLenin"
    period: "2026"
---

## Notes for implementing work-in-progress version

This is a work-in-progress specification.

Software implementing this work-in-progress specification MUST NOT use the unprefixed `persistence` CAP name, command name, or batch type.  Implementations SHOULD use the `draft/persistence` prefix on the CAP and batch type, and the literal `PERSISTENCE` command name, to be interoperable with other software implementing a compatible work-in-progress version.  The final version of the specification will use the unprefixed `persistence` CAP name and batch type.

This specification supersedes the in-house `BOUNCER` command surface previously used by Nefarious for the same purpose.  The `BOUNCER` command is retained for one release cycle for tooling compatibility and is expected to be removed in a future major version.

## Introduction

This specification describes a mechanism for IRC clients and servers to negotiate persistent sessions — connections whose state (nick, channel memberships, away status, preferences, and related metadata) is retained by the server across client disconnections.

When the client reconnects, the server restores that state to the new connection in a way the client can distinguish from live network activity.  When a second client connects to the same account, the server attaches it as an additional view onto the same session.

The specification covers:

  1. Discovery of persistence support via a CAP.
  2. A `PERSISTENCE` command for the client to inspect and adjust its session, organise per-connection configuration as named profiles, attach to a chosen profile at registration time, control auto-replay of missed messages, and detach from persistence entirely.
  3. A `draft/persistence` batch type wrapping the server's channel-state restoration burst.
  4. A `evilnet.github.io/bouncer-replay` batch type wrapping the server's optional missed-message replay.
  5. A reserved metadata key prefix (`draft/persistence/`) for server-managed state related to this specification.
  6. A network-membership reconciliation mechanism for clients that participate in profile-driven divergent channel sets across multiple concurrent connections.

The server as mentioned in this document MAY be an IRC server or an IRC bouncer.

## Motivation

Persistent connections are a longstanding IRC pattern implemented by bouncers (e.g. ZNC, soju) and native server features (e.g. Ergo, Nefarious).  Despite widespread deployment, there is no standard protocol for:

  1. **Discovery** — Clients cannot reliably distinguish a persistent server from a stateless one, leading to harmful client-driven auto-rejoin on reconnect.
  2. **State restoration boundary** — When the server replays channel state, clients cannot distinguish replayed joins from live activity, and lack a signal that the replay is complete.
  3. **Per-connection configuration** — Users with multiple concurrent clients (e.g. mobile, desktop) cannot easily express that different clients should observe different subsets of their session state.
  4. **Lifecycle control** — Clients cannot request or query persistence status, opt out at runtime, or pick among multiple held sessions.

This specification addresses each of these and is structured so that conforming servers may implement progressively richer subsets independently.

## Architecture

### Dependencies

Negotiating the `batch` ([`batch`][batch]) and `message-tags` ([`message-tags`][message-tags]) capabilities is RECOMMENDED for full functionality.  The `draft/persistence` batch types defined below require the `batch` capability; when `batch` is not negotiated the server falls back to sending state restoration messages without the batch wrapper.

Negotiating `draft/metadata-2` ([`draft/metadata-2`][metadata2]) is RECOMMENDED.  This specification reserves a server-managed metadata key prefix; clients may read those keys via `METADATA GET` even when not setting them.

### Capability

This specification adds the `draft/persistence` capability.

Clients requesting this capability indicate that they:

  - understand the `PERSISTENCE` command and its replies as defined below, and
  - will refrain from sending JOIN commands for channels they intend to be restored from a persistent session (auto-rejoin suppression — see [Client behaviour](#client-behaviour)).

The capability MAY carry a comma-separated value indicating the OPTIONAL subcommands the server supports beyond the base `STATUS`/`GET`/`SET` triad:

```
CAP * LS :draft/persistence=replay-control,profile,list,attach
```

Defined optional tokens:

| Token            | Meaning                                                       |
|------------------|---------------------------------------------------------------|
| `replay-control` | Server supports `PERSISTENCE REPLAY` subcommands              |
| `profile`        | Server supports `PERSISTENCE PROFILE` subcommands             |
| `attach`         | Server supports `PERSISTENCE ATTACH` (and the `PROFILE` model)|
| `detach`         | Server supports `PERSISTENCE DETACH`                          |
| `list`           | Server supports `PERSISTENCE LIST` or `PERSISTENCE PROFILE LIST` |

Clients MUST tolerate unknown tokens in the value and MUST NOT assume the absence of a token implies the absence of a feature; the value is a hint, not an authoritative inventory.

### Server-managed metadata keys

This specification stores per-account configuration as metadata keys under the prefix:

  - `draft/persistence/` while this document remains a work-in-progress draft.
  - `persistence/` once this document is ratified.

These keys are *server-managed*: their values are maintained by the server in response to the `PERSISTENCE` command defined below, and direct `METADATA SET` from a client is refused.

When the `draft/metadata-2` capability is in use, servers MUST refuse client-initiated `METADATA SET` against any key that begins with this specification's prefix, replying with:

```
FAIL METADATA KEY_NO_PERMISSION <target> <key> :Key is server-managed and cannot be set directly
```

Server-managed keys MUST NOT count against the per-target `MAX_KEYS` budget advertised by the `draft/metadata-2` capability.  Servers MAY allow privileged out-of-band paths (e.g. an oper-only administrative interface keyed on `*<account>`) to write to these keys; this is implementation-defined and not part of the wire protocol.

Server-managed keys remain readable via `METADATA GET`, so clients MAY inspect them.

Specifications and vendor extensions that introduce additional server-managed keys SHOULD use their own draft-namespaced or vendor-scoped prefix (e.g. `draft/my-extension/...` or `vendor.example/...`) rather than claiming generic unprefixed prefixes.  This avoids namespace conflicts and keeps the carve-out auditable per-specification.

## Commands

The `PERSISTENCE` command introduced by this specification has the syntax:

```
PERSISTENCE <subcommand> [<argument> ...]
```

Subcommand names defined here are case-insensitive; clients SHOULD send them in upper case.  Servers MUST accept any case.

The `draft/persistence` capability is a client opt-in signal: it advertises to the server that the client understands the unsolicited `PERSISTENCE STATUS` line at registration and the *semantics* of the `draft/persistence`-typed batch (channel-state restoration vs. live activity).

Servers MUST NOT refuse `PERSISTENCE` commands from clients that have not negotiated the capability — the command surface remains available to any authenticated client.  Auto-replay and other server-side effects defined by this specification likewise apply regardless of capability negotiation.

Capability gating in this specification scopes:

  - The registration-time unsolicited `PERSISTENCE STATUS` — gated on `draft/persistence`.
  - The `draft/persistence` and `evilnet.github.io/bouncer-replay` batch *envelopes* — gated on `batch` only.  Per the `batch` extension, unknown batch types are tolerated, so a client that has `batch` without `draft/persistence` still receives the envelope and benefits from the grouping signal.  The `draft/persistence` capability adds *interpretation* (treat the batch contents as restoration, suppress join notifications, etc.); it is not a precondition for emitting the envelope.

Authentication is required for every subcommand defined in this specification.  When the calling connection has not authenticated, the server MUST reply:

```
FAIL PERSISTENCE ACCOUNT_REQUIRED <subcommand> :You must be authenticated
```

Unknown subcommands and ill-formed arguments produce:

```
FAIL PERSISTENCE INVALID_PARAMETERS <context> :<description>
```

where `<context>` identifies the offending subcommand or argument and `<description>` is human-readable.

### STATUS (base, REQUIRED)

```
PERSISTENCE STATUS                             ; client to server
:server PERSISTENCE STATUS <state>             ; server to client
```

`<state>` is one of `ON` or `OFF` and reflects the effective persistence state for the calling connection.

The server MUST send an unsolicited `PERSISTENCE STATUS` to a connection that has negotiated `draft/persistence` and is authenticated.  This unsolicited message MUST be sent after the final `005` (`RPL_ISUPPORT`) and before `376` (`RPL_ENDOFMOTD`) or `422` (`ERR_NOMOTD`).

Servers MUST also send `PERSISTENCE STATUS` as the reply to `PERSISTENCE GET` and after every successful `PERSISTENCE SET` and `PERSISTENCE ATTACH`.

### GET (base, REQUIRED)

```
PERSISTENCE GET                                ; client to server
```

The server replies with `PERSISTENCE STATUS` reflecting the current effective state.

### SET (base, REQUIRED)

```
PERSISTENCE SET <argument>                     ; client to server
```

`<argument>` is one of `ON`, `OFF`, or `DEFAULT`.

  - `ON` — Request that persistence be enabled for the account.  The server MUST record this preference at account scope; if no session exists, the server SHOULD create one.
  - `OFF` — Request that persistence be disabled for the account.  The server MUST record this preference at account scope; if a session exists, the server SHOULD destroy it (see [DETACH](#detach-optional) for the multi-connection case).
  - `DEFAULT` — Clear any account-scope preference; the effective state then falls back to the server's default policy.

The server MUST reply with both:

```
:server PERSISTENCE SET <argument>
:server PERSISTENCE STATUS <effective>
```

The reply MAY appear in either order; the `STATUS` line reflects the new effective state, which need not match `<argument>` (e.g. when server policy enforces `ON`).

### REPLAY (REQUIRED if `replay-control` advertised)

This subcommand controls the optional missed-message replay (see [`evilnet.github.io/bouncer-replay` batch](#evilnetgithubiobouncer-replay-batch)).  It does not affect the channel-state restoration burst (see [`draft/persistence` batch](#draftpersistence-batch)) — joining, topic, and member-list restoration are part of the session's current state, not historical activity.

```
PERSISTENCE REPLAY GET                         ; client to server
PERSISTENCE REPLAY SET <argument>              ; client to server
:server PERSISTENCE REPLAY STATUS <client-setting> <effective>
```

`<argument>` is one of `ON`, `OFF`, or `DEFAULT`.  `<client-setting>` is `ON`, `OFF`, or `DEFAULT` and reports the user's explicit preference.  `<effective>` is `ON` or `OFF` and reports what the server actually does for this connection.

`GET` returns the current `REPLAY STATUS`.  `SET <argument>` updates the preference, replies with an acknowledgement followed by `REPLAY STATUS`:

```
:server PERSISTENCE REPLAY SET <argument>
:server PERSISTENCE REPLAY STATUS <client-setting> <effective>
```

### PROFILE (REQUIRED if `profile` advertised)

A *profile* is a named bundle of per-connection configuration for the calling account.  Every account has an implicit `default` profile that is always present and cannot be removed.

```
PERSISTENCE PROFILE LIST
PERSISTENCE PROFILE CREATE <name> [FROM <parent>]
PERSISTENCE PROFILE DELETE <name>
PERSISTENCE PROFILE RENAME <old-name> <new-name>
PERSISTENCE PROFILE GET <name> <key>
PERSISTENCE PROFILE SET <name> <key> <value>
PERSISTENCE PROFILE SET <name> <key> DEFAULT
```

#### Profile names

A profile name MUST consist of one to 32 ASCII characters drawn from `A-Z`, `a-z`, `0-9`, `_`, and `-`.  Profile names are case-insensitive for matching.  The literal name `default` is reserved for the implicit default profile and MUST NOT be the target of `CREATE`, `DELETE`, or `RENAME`.

#### Profile inheritance

`CREATE <name> FROM <parent>` makes `<name>` inherit from `<parent>`.  `CREATE <name>` without a `FROM` clause is equivalent to `CREATE <name> FROM default`.  Cycles MUST be refused at `CREATE` and `SET` time.

A profile's *effective* value for a given key is resolved by walking from the profile root-ward through parents and applying overrides leaf-ward.  For scalar keys, the first explicit setting closest to the leaf wins.  For the channel-list key (defined below), the resolution composes adds and subtracts (see [Channel lists](#channel-lists)).

The server MUST refuse `DELETE` of a profile that is an ancestor of any other existing profile, replying with `FAIL PERSISTENCE INVALID_PARAMETERS`.

#### Profile keys

The following keys are defined by this specification for use under `PERSISTENCE PROFILE SET <name> <key> <value>`.

| Key            | Type       | Meaning                                                  |
|----------------|------------|----------------------------------------------------------|
| `parent`       | name       | Parent profile in the inheritance chain                  |
| `hold`         | `0`/`1`    | Per-profile persistence preference                       |
| `auto-replay`  | `0`/`1`    | Per-profile missed-message replay preference             |
| `channels`     | set ops    | Channel-list edits (see below)                           |

The `channels` key uses set operations:

```
PERSISTENCE PROFILE SET <name> channels +#x   ; add #x
PERSISTENCE PROFILE SET <name> channels -#x   ; remove #x (or mark inherited #x as subtracted)
PERSISTENCE PROFILE SET <name> channels DEFAULT
```

`DEFAULT` clears the profile's own contribution to its channel list (the effective list then equals the parent's effective list).

Future revisions or vendor extensions MAY define additional keys.  Servers MUST reject `SET` on keys they do not recognise with `FAIL PERSISTENCE INVALID_PARAMETERS`.

#### LIST output

```
:server PERSISTENCE PROFILE <name> [<key>=<value> ...]
:server PERSISTENCE PROFILE ENDOFLIST
```

The server MUST emit one `PROFILE` line per profile defined for the account, in arbitrary order, terminated by `ENDOFLIST`.  Lines MAY include trailing `<key>=<value>` pairs reporting profile attributes (notably `parent=<name>`); clients MUST tolerate unknown attributes.

The implicit `default` profile is always reported, even if no keys are set on it.

#### GET reply

```
:server PERSISTENCE PROFILE <name> <key> :<value>
:server PERSISTENCE PROFILE <name> <key>
```

The first form indicates the key has an effective value; the second indicates the key is unset.  For the `channels` key, the value is the effective channel list as a comma-separated string with inheritance applied.

#### SET acknowledgement

```
:server PERSISTENCE PROFILE <name> <key> :<value>
:server PERSISTENCE PROFILE <name> <key>          ; key cleared
```

#### CREATE / DELETE / RENAME acknowledgement

```
:server PERSISTENCE PROFILE CREATED <name> parent=<parent>
:server PERSISTENCE PROFILE DELETED <name>
:server PERSISTENCE PROFILE RENAMED <old-name> <new-name>
```

### ATTACH (REQUIRED if `attach` advertised)

```
PERSISTENCE ATTACH <profile>                   ; client to server
:server PERSISTENCE ATTACH <profile>
```

`ATTACH` selects the active profile for the calling connection.  The server MUST accept `ATTACH` only between SASL completion and the end of capability negotiation (i.e. before `CAP END`).  After registration, the server MUST refuse with `FAIL PERSISTENCE INVALID_PARAMETERS`.

The active profile drives:

  - delivery filtering against the profile's effective `channels` list,
  - the resolution chain for `STATUS`, `REPLAY STATUS`, and other per-connection settings,
  - the contents of the channel-state restoration burst.

If the client does not send `ATTACH` before registration completes, the active profile is `default`.

### DETACH (REQUIRED if `detach` advertised)

```
PERSISTENCE DETACH [<session-id>]              ; client to server
:server PERSISTENCE DETACH OK | NOSESSION
```

`DETACH` without a `<session-id>` argument requests that the caller's current session be released.  Released means: any other connections attached to the session are disconnected, the held/ghost state is cleared, account-scope `hold` is set to `OFF`, and the caller continues as a normal non-persistent client.

If the caller has no active session, the server replies `:server PERSISTENCE DETACH NOSESSION`; this is informational, not an error.

If the calling session is marked as enforced by server policy (e.g. a connection class with an enforced-persistence flag is currently attached), the server MUST refuse:

```
FAIL PERSISTENCE CANNOT_DETACH :Connection class enforces persistence; cannot detach
```

The session-enforced flag MUST be cleared when the session transitions to fully-held (no live connections); a subsequent non-enforced reattach may then `DETACH` normally.

If `<session-id>` refers to a different session owned by the same account, the server MUST destroy that session without affecting the caller.

## Batch types

### `draft/persistence` batch

When a client with the `batch` capability resumes a session — whether by reconnecting to a held session or by attaching as an additional view onto an active session — the server MUST wrap the resulting channel-state restoration in a batch of type `draft/persistence`:

```
:server BATCH +<ref> draft/persistence
:nick!user@host JOIN #channel
:server 332 nick #channel :Topic text
:server 333 nick #channel setter 1713234120
:server 353 nick = #channel :@op +voice nick
:server 366 nick #channel :End of /NAMES list.
:nick!user@host JOIN #another
...
:server BATCH -<ref>
```

The batch's contents represent the *current* state of the connection's view, not historical activity.  Clients that have negotiated `draft/persistence` MUST NOT treat these joins, mode messages, or topic messages as new events for the purpose of notifications, auto-join scripts, or analogous side effects.  Clients that have `batch` but not `draft/persistence` MAY treat the batch contents as live activity (the spec extends them no semantic obligation beyond standard `batch` behaviour), but SHOULD use the grouping signal where useful.

The batch boundary MUST encompass all channel-state restoration triggered by the resume.  After `BATCH -<ref>`, any subsequent JOINs, modes, or topics are live activity.

When the client has not negotiated `batch`, the server MUST still send the restoration burst but does so without the wrapping `BATCH` lines.  Clients SHOULD treat all JOINs received between the welcome (`001`) and the MOTD-end (`376`/`422`) as restoration; subsequent JOINs are live activity.

#### Empty restoration

If the resuming connection has no channels in its effective view, the server MAY omit the `draft/persistence` batch entirely.  The client MUST tolerate either behaviour.

### `evilnet.github.io/bouncer-replay` batch

When the server replays missed messages on resume (subject to the resolved `auto-replay` preference and the absence of `draft/chathistory` on the client), the replay MUST be wrapped in a vendor-scoped batch of type `evilnet.github.io/bouncer-replay`:

```
:server BATCH +<outer> evilnet.github.io/bouncer-replay
@batch=<outer> :server BATCH +<inner> chathistory #channel
@batch=<inner> :nick!user@host PRIVMSG #channel :live message before the gap
@batch=<inner> :nick!user@host PRIVMSG #channel :and another
@batch=<outer> :server BATCH -<inner>
:server BATCH -<outer>
```

The outer batch boundary signals the entire missed-message replay block, useful for unread-marker rollup, do-not-disturb suppression, and notification batching.

Servers MUST emit the outer batch lazily — on the first inner `chathistory` batch — so that empty replays do not ship an empty wrapper.

Servers MUST NOT emit this batch when the client has negotiated `draft/chathistory`; such clients fetch history themselves.

This batch type is vendor-scoped on `evilnet.github.io` because the host is DNS-resolvable and demonstrably controlled by the originating organisation; the namespace MAY be promoted to a non-vendor draft in a future revision.

## Channel lists

Each profile has an *effective channel list*, computed by walking the inheritance chain root-to-leaf and applying each profile's own contribution:

  - A `<channel>` entry adds the channel to the running set.
  - A `-<channel>` entry removes the channel from the running set, regardless of whether it was inherited.

`PERSISTENCE PROFILE SET <name> channels +<channel>` ensures the channel is present in the effective list at `<name>`:

  - If the inheritance chain already contains `<channel>` above `<name>`, the server MUST remove any local `-<channel>` subtract entry and otherwise leave the profile's own list untouched.
  - Otherwise the server MUST add `<channel>` to the profile's own list.

`PERSISTENCE PROFILE SET <name> channels -<channel>` ensures the channel is absent from the effective list at `<name>`:

  - If the inheritance chain contains `<channel>` above `<name>`, the server MUST add `-<channel>` to the profile's own list.
  - Otherwise the server MUST remove any local `<channel>` entry.

An *empty effective channel list* is the permissive default and means "no filter": the connection observes traffic for all channels the account is currently in.  A non-empty effective channel list means "filter to these channels": the connection observes traffic only for channels in the effective list.

When a connection's active profile has a non-empty effective channel list, the server MUST filter every channel-routed delivery to that connection (PRIVMSG, NOTICE, TAGMSG, JOIN, PART, MODE, TOPIC, …) by membership in the effective list.

When the connection issues `/JOIN <channel>` while filtering is active (effective list non-empty), the server MUST update the active profile's channel list as if `PROFILE SET <profile> channels +<channel>` had been issued, before performing the network join.

When the connection issues `/PART <channel>` while filtering is active, the server MUST update the active profile's channel list as if `PROFILE SET <profile> channels -<channel>` had been issued, after performing the network part.

The default profile's initial channel list is empty, preserving the "no filter, mirror primary" behaviour for legacy clients.

## Network-membership reconciliation

This section is OPTIONAL.  Servers MAY implement it when the account-scope `hold` setting resolves to `ON` and the user has multiple concurrent connections with divergent profile channel lists.

For accounts whose effective `hold` is `OFF`, the server SHOULD treat profiles as advisory and apply only the per-delivery filter described in [Channel lists](#channel-lists).  Profile-driven divergent network presence is undefined for non-persistent accounts.

For accounts whose effective `hold` is `ON`, the server MAY model concurrent connections as separate channel members with mirror memberships under the account's network identity.  In this model:

  - The account has a single primary network presence (the connection currently selected as the session's primary).
  - Each additional concurrent connection is an *alias* with its own per-channel mirror memberships.
  - When a connection issues `/PART <channel>`, the server consults the union over all profiles' effective channel lists for the account.  If any other profile still wants the channel, the server MUST suppress the network-level part for the calling connection and emit a synthetic PART to the connection's own view only.  If no other profile wants the channel, the server proceeds with a normal network part, which removes mirror memberships across all connections of the account.
  - When a connection issues `/JOIN <channel>` for a channel that is already a network member of the account (via another connection's profile), the server MUST emit a synthetic JOIN echo to the joining connection along with a single-channel state burst (`TOPIC`, `RPL_TOPICWHOTIME`, `NAMES`) reflecting the channel's current state.

The propagation mechanism for cross-server mirror memberships is implementation-defined and outside the scope of this specification.

## Client behaviour

### Auto-rejoin suppression

A client that has negotiated `draft/persistence` MUST NOT send JOIN commands for channels it remembers from a previous connection.  The client SHOULD instead wait for the channel-state restoration burst.  The client MAY send JOIN for channels not received from the server after the restoration boundary.

This rule applies regardless of the effective `STATUS` value: even when `STATUS` reports `OFF`, the presence of the `draft/persistence` capability is sufficient grounds to suppress client-driven auto-rejoin and to instead respect whatever the server delivers.

### Reading STATUS

A client SHOULD NOT alter its UI based solely on the `<state>` value of `PERSISTENCE STATUS`.  The status is informational; clients that want to expose persistence state to users SHOULD use a wording that reflects "the server is holding my session" rather than "I am persistent".

### Profile selection at registration

A client that wants to attach to a specific profile MUST do so between SASL completion and `CAP END`:

```
C: CAP LS 302
S: CAP * LS :draft/persistence=profile,attach sasl batch
C: CAP REQ :draft/persistence batch sasl
S: CAP * ACK :draft/persistence batch sasl
C: AUTHENTICATE PLAIN
... SASL exchange ...
S: 900 * account :You are now logged in
C: PERSISTENCE PROFILE LIST
S: :server PERSISTENCE PROFILE default
S: :server PERSISTENCE PROFILE mobile parent=default
S: :server PERSISTENCE PROFILE ENDOFLIST
C: PERSISTENCE ATTACH mobile
S: :server PERSISTENCE ATTACH mobile
C: CAP END
```

If the client does not send `ATTACH`, the server's auto-selection logic applies (the active profile defaults to `default`).

## Errors

The following error code values are defined for `FAIL PERSISTENCE`:

| Code                  | Meaning                                                        |
|-----------------------|----------------------------------------------------------------|
| `ACCOUNT_REQUIRED`    | Authentication is required to use this subcommand              |
| `INVALID_PARAMETERS`  | Subcommand arguments were malformed or referred to non-existent names |
| `INTERNAL_ERROR`      | Server failed to process the request                           |
| `CANNOT_DETACH`       | The session is class-enforced and cannot be detached           |
| `NO_SUCH_SESSION`     | The session id does not exist or is not owned by the account   |

Servers SHOULD use the `<context>` field of `FAIL` to indicate the offending subcommand and any relevant argument.

## Security considerations

  - Persistence carries elevated risk of resource exhaustion.  Servers SHOULD limit the number of concurrent held sessions per account, enforce inactivity timeouts for held sessions, and require SASL authentication before creating a session.
  - The per-account profile space (`draft/persistence/profile/...`) is metadata: it is replicated by the metadata distribution mechanism to peers that share the account.  Implementations MUST treat these keys as PRIVATE (visible only to the owning account) for purposes of `draft/metadata-2`'s visibility model.
  - The optional network-membership reconciliation creates a divergence between an account's per-channel network presence and the per-connection view of that presence.  Operators SHOULD audit channel-routed administrative tooling (KICK, BAN, MODE delivery) to confirm it behaves predictably under this divergence.
  - `PERSISTENCE LIST` and the listing of profile names can reveal that an account has multiple held sessions or multiple configured profiles.  Servers MUST only return data owned by the authenticated account.

## Examples

### Minimal flow

```
C: CAP LS 302
S: CAP * LS :draft/persistence batch sasl
C: CAP REQ :draft/persistence batch sasl
S: CAP * ACK :draft/persistence batch sasl
C: AUTHENTICATE PLAIN
... SASL exchange ...
C: CAP END
S: ... registration burst ...
S: 005 nick ... :are supported by this server
S: :server PERSISTENCE STATUS ON
S: :server BATCH +1 draft/persistence
S: :nick!user@host JOIN #chan
S: :server 332 nick #chan :Topic
S: :server 366 nick #chan :End of /NAMES
S: :server BATCH -1
S: 376 nick :End of /MOTD
```

### Profile + ATTACH

```
C: PERSISTENCE PROFILE LIST
S: :server PERSISTENCE PROFILE default
S: :server PERSISTENCE PROFILE mobile parent=default
S: :server PERSISTENCE PROFILE ENDOFLIST
C: PERSISTENCE ATTACH mobile
S: :server PERSISTENCE ATTACH mobile
C: CAP END
S: ... registration burst ...
S: :server PERSISTENCE STATUS ON
```

### Editing a profile's channels

```
C: PERSISTENCE PROFILE CREATE mobile FROM default
S: :server PERSISTENCE PROFILE CREATED mobile parent=default
C: PERSISTENCE PROFILE SET mobile channels +#urgent
S: :server PERSISTENCE PROFILE mobile channels :#urgent
C: PERSISTENCE PROFILE SET mobile channels +#priority
S: :server PERSISTENCE PROFILE mobile channels :#urgent,#priority
C: PERSISTENCE PROFILE GET mobile channels
S: :server PERSISTENCE PROFILE mobile channels :#urgent,#priority
```

### REPLAY control

```
C: PERSISTENCE REPLAY GET
S: :server PERSISTENCE REPLAY STATUS DEFAULT ON
C: PERSISTENCE REPLAY SET OFF
S: :server PERSISTENCE REPLAY SET OFF
S: :server PERSISTENCE REPLAY STATUS OFF OFF
```

### DETACH

```
C: PERSISTENCE DETACH
S: :server PERSISTENCE DETACH OK
S: :server PERSISTENCE STATUS OFF
```

If class-enforced:

```
C: PERSISTENCE DETACH
S: FAIL PERSISTENCE CANNOT_DETACH DETACH :Connection class enforces persistence; cannot detach
```

### Reading server-managed metadata

```
C: METADATA * GET draft/persistence/hold
S: :server 761 nick * draft/persistence/hold private :1
C: METADATA * SET draft/persistence/hold :0
S: FAIL METADATA KEY_NO_PERMISSION * draft/persistence/hold :Key is server-managed and cannot be set directly
C: PERSISTENCE SET OFF
S: :server PERSISTENCE SET OFF
S: :server PERSISTENCE STATUS OFF
```

## Errata

None at time of publication.

[batch]: ../extensions/batch.html
[message-tags]: ../extensions/message-tags.html
[metadata2]: ../extensions/metadata-2.html
