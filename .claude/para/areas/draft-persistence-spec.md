# draft/persistence - Session Persistence and Restoration

**Status:** Draft Proposal (fluid — evolving with implementation)
**Author:** Afternet Development Team
**Created:** April 2026
**Upstream context:** [ircv3/ircv3-specifications#503](https://github.com/ircv3/ircv3-specifications/pull/503), [ircv3/ircv3-ideas#91](https://github.com/ircv3/ircv3-ideas/issues/91)

## Abstract

This document specifies a mechanism for IRC clients and servers to negotiate persistent sessions — connections where the client's presence (nick, channels, metadata) is maintained by the server across disconnections. It extends the `draft/persistence` capability from PR #503 with session enumeration, session selection, and batched channel restoration, addressing concerns raised by both bouncer implementors (soju, ZNC) and multi-session advocates.

## Motivation

Persistent connections are a longstanding IRC pattern implemented by bouncers (ZNC, soju) and native server features (Ergo, Nefarious). Despite widespread deployment, there is no standard protocol for:

1. **Discovery** — Clients cannot distinguish a persistent server from a stateless one, leading to harmful auto-rejoin on reconnect (the core problem from ircv3-ideas#91).
2. **State restoration boundary** — When the server replays channel state on reconnect, clients cannot distinguish replayed JOINs from live activity, and don't know when the replay is complete.
3. **Session selection** — Accounts with multiple held sessions have no standard way to enumerate and select which to resume (spb's concern on PR #503).
4. **Lifecycle control** — Clients cannot request or query persistence status (slingamn's PR #503 contribution).

### Design goals

- **Compatible with PR #503** — The `PERSISTENCE STATUS/GET/SET` subcommands use identical syntax and semantics. A client implementing PR #503 works unchanged against this spec.
- **Layered complexity** — The CAP alone is useful (emersion's minimal ask). STATUS adds lifecycle info. LIST/ATTACH add session selection. Each layer is independently valuable.
- **Implementation-driven** — Every feature described here maps to existing Nefarious bouncer infrastructure. Nothing is theoretical.

## Capability

### Name

```
draft/persistence
```

### CAP value

The capability MAY include a comma-separated list of supported optional subcommands as its value:

```
CAP * LS :draft/persistence=list,attach
```

If no value is provided, the server supports only the base protocol (STATUS, GET, SET). Defined optional tokens:

| Token | Meaning |
|-------|---------|
| `list` | Server supports `PERSISTENCE LIST` |
| `attach` | Server supports `PERSISTENCE ATTACH` |

Clients MUST tolerate unknown tokens in the value.

## Base Protocol (PR #503 compatible)

Implementation of the `PERSISTENCE` command is OPTIONAL but RECOMMENDED. Servers that advertise `draft/persistence` without implementing the command still provide value: clients can use the CAP as a discovery signal to suppress auto-rejoin, and the persistence batch (if `batch` is also negotiated) provides the restoration boundary. The command adds lifecycle control — servers that support it SHOULD implement at least STATUS and GET.

### PERSISTENCE STATUS (server to client)

```
PERSISTENCE STATUS <client-setting> <effective-setting>
```

- `<client-setting>`: `ON`, `OFF`, or `DEFAULT` — what the client has requested
- `<effective-setting>`: `ON` or `OFF` — what is actually in effect

Servers that implement the `PERSISTENCE` command MUST send an unsolicited `PERSISTENCE STATUS` during registration if:
- The client has negotiated `draft/persistence`, AND
- The client is authenticated

This unsolicited STATUS MUST be sent no later than before `376`/`422` (end of MOTD). Servers SHOULD send it as early as feasible — immediately after authentication completes if possible, or after the last `005` at latest. Earlier delivery allows clients to act on persistence state sooner (e.g., in response to ATTACH before `CAP END`).

Clients that only use the CAP for discovery (auto-rejoin suppression) or the batch (restoration boundary) without implementing the command protocol MUST ignore unrecognized messages, including unsolicited STATUS. This is standard IRC behavior — the server sends STATUS unconditionally when it supports the command; the client decides whether to act on it.

Servers that advertise `draft/persistence` without implementing the command do not send STATUS; the CAP alone is the persistence signal.

Note: STATUS is also sent as a reply to GET, SET, ATTACH, and DETACH commands, which may occur at any point including pre-registration.

The server SHOULD send `PERSISTENCE STATUS` asynchronously when the effective setting changes. Clients should be aware that a transition from effective `ON` to `OFF` may indicate imminent disconnection (e.g., session expiry, operator intervention, or policy change).

### PERSISTENCE GET (client to server)

```
PERSISTENCE GET
```

Server replies with `PERSISTENCE STATUS`. Requires authentication.

### PERSISTENCE SET (client to server)

```
PERSISTENCE SET <setting>
```

- `<setting>`: `ON`, `OFF`, or `DEFAULT`

Server replies with `PERSISTENCE STATUS`. The server MAY accept the client setting without changing the effective setting (e.g., persistence is mandatory per connection class). In this case:
- MUST NOT send `FAIL`
- MUST send `STATUS` reflecting the actual state
- MAY send `WARN` or `NOTE` to explain the override

### Error responses

```
FAIL PERSISTENCE ACCOUNT_REQUIRED :An account is required
FAIL PERSISTENCE INVALID_PARAMETERS :Invalid parameters
FAIL PERSISTENCE INTERNAL_ERROR :An error occurred
```

## Session Enumeration (LIST extension)

When the server advertises `list` in the CAP value, clients may enumerate held sessions before completing registration.

### PERSISTENCE LIST (client to server)

```
PERSISTENCE LIST
```

Requires authentication. The server replies with zero or more `PERSISTENCE SESSION` lines followed by `PERSISTENCE ENDOFLIST`:

```
PERSISTENCE SESSION <session-id> <state> <nick> <channels> :<info>
PERSISTENCE ENDOFLIST
```

Fields:
- `<session-id>` — Opaque server-assigned identifier (e.g., `s3kF9a`). Stable across reconnects.
- `<state>` — `HELD` (disconnected, ghost maintained) or `ACTIVE` (another connection is live)
- `<nick>` — The nick the session is holding
- `<channels>` — Comma-separated list of channels, or `*` if none
- `<info>` — Human-readable status (e.g., `held since 2026-04-16T03:22:00Z`, `active on leaf.example.net`)

If the account has no sessions, the server sends only `PERSISTENCE ENDOFLIST`.

### Timing

`PERSISTENCE LIST` is valid after SASL authentication completes but before `CAP END`. This allows the client to authenticate, enumerate sessions, select one, and then complete registration — all within the existing CAP negotiation window.

Servers MUST also accept `LIST` after registration for informational use.

## Session Selection (ATTACH extension)

When the server advertises `attach` in the CAP value, clients may select which session to resume.

### PERSISTENCE ATTACH (client to server)

```
PERSISTENCE ATTACH <session-id>
```

Sent after `PERSISTENCE LIST`, before `CAP END`. Instructs the server to resume the specified session instead of auto-selecting.

The server replies with one of:
- `PERSISTENCE STATUS <client-setting> <effective-setting>` — success, session will be resumed on `CAP END`
- `FAIL PERSISTENCE NO_SUCH_SESSION <session-id> :No such session`
- `FAIL PERSISTENCE ACCOUNT_REQUIRED :An account is required`

Attaching to an ACTIVE session (another connection is live) is not an error — it creates an alias connection to that session. The client receives the persistence batch with channel state, same as resuming a HELD session.

If the client does not send `PERSISTENCE ATTACH` before `CAP END`, the server uses its default session selection logic (e.g., most recently disconnected local session).

### PERSISTENCE DETACH (client to server)

```
PERSISTENCE DETACH [<session-id>]
```

Requests that the server disable persistence for the session. The calling connection remains alive as a normal non-persistent client; all other connections to the session (aliases) are disconnected, and the session's held/ghost state is released.

This is the only clean way to leave persistence — it avoids the bookkeeping complications of removing a single connection from a multi-connection session (promotion, nick sync, channel membership reshuffling). The caller becomes the sole owner of the nick and channel memberships, operating as a plain IRC connection.

- **No enforced connections in session**: Session persistence is disabled. Other connections are disconnected. Server replies with `PERSISTENCE STATUS OFF OFF`. On subsequent disconnect, the client will not be held.
- **Session is marked enforced**: The server MUST NOT detach. The session is marked as enforced when any connection on a persistence-enforced class attaches to it. This flag is cleared when the session transitions to HELD (all connections disconnected) — if the enforced-class client doesn't come back, a future non-enforced connection can DETACH the stale session. While any enforced-class connection is active, DETACH would just destroy state that the auto-reconnecting client would immediately recreate empty. Server replies with `FAIL PERSISTENCE CANNOT_DETACH :Persistence is required by server policy`. No connections are affected.

If `<session-id>` is specified and refers to a different session than the client's current one, the server destroys that held session (if owned by the same account). This allows cleanup of stale sessions without attaching to them first.

Error responses:
- `FAIL PERSISTENCE NO_SUCH_SESSION <session-id> :No such session`
- `FAIL PERSISTENCE CANNOT_DETACH :Persistence is required by server policy`

## Channel Restoration Batch

When a persistent session is resumed and the server replays channel state, the replay MUST be wrapped in a `draft/persistence` batch if the client has negotiated both `draft/persistence` and `batch`:

```
:server BATCH +ref draft/persistence
:nick!user@host JOIN #channel
:server 332 nick #channel :Topic text
:server 333 nick #channel setter 1713234120
:server 353 nick = #channel :@op +voice nick
:server 366 nick #channel :End of /NAMES list.
:nick!user@host JOIN #another
...
:server BATCH -ref
```

### Semantics

- The batch type is `draft/persistence` (same name as the CAP).
- All JOINs within the batch are **state restoration**, not live channel activity. Clients SHOULD NOT trigger join notifications, auto-greet scripts, or channel-open actions for these.
- Clients MUST NOT send auto-rejoin JOINs for channels received in this batch.
- The closing `BATCH -ref` signals that channel restoration is complete. Any JOINs received after this point are live activity.
- If chathistory replay follows (for clients with `draft/chathistory`), it occurs after the persistence batch closes.

### Interaction with noimplicitnames

If the client has negotiated `draft/noimplicitnames`, the server SHOULD omit `353`/`366` (NAMES) responses from the persistence batch, as the client will request them explicitly.

### Without batch capability

If the client has `draft/persistence` but not `batch`, the server sends JOINs individually (current behavior). The client infers restoration is complete when it receives `376` (MOTD end) or `422` (no MOTD).

## Client Behavior

### Auto-rejoin suppression

A client that has negotiated `draft/persistence` and received `PERSISTENCE STATUS * ON` (effective=ON):

- MUST NOT send JOIN commands for channels it remembers from a previous connection
- SHOULD wait for the server to deliver channel state via the persistence batch (or individual JOINs)
- MAY send JOIN for channels not received from the server after the batch completes

### Session selection flow

```
C: CAP LS 302
S: CAP * LS :draft/persistence=list,attach sasl batch ...
C: CAP REQ :draft/persistence batch sasl
S: CAP * ACK :draft/persistence batch sasl
C: AUTHENTICATE PLAIN
S: ... (SASL exchange) ...
S: 900 * account :You are now logged in
C: PERSISTENCE LIST
S: PERSISTENCE SESSION s3kF9a HELD myoldnick #chat,#dev :held since 2026-04-16T03:22:00Z
S: PERSISTENCE SESSION x7bQ2m HELD phonenick #mobile :held since 2026-04-15T18:00:00Z
S: PERSISTENCE ENDOFLIST
C: PERSISTENCE ATTACH s3kF9a
S: PERSISTENCE STATUS DEFAULT ON
C: CAP END
S: 001 myoldnick :Welcome ...
S: ... (registration burst) ...
S: 005 myoldnick ... :are supported
S: BATCH +abc draft/persistence
S: :myoldnick!user@host JOIN #chat
S: :server 332 myoldnick #chat :Welcome to chat
S: :server 366 myoldnick #chat :End of /NAMES
S: :myoldnick!user@host JOIN #dev
S: :server 332 myoldnick #dev :Development channel
S: :server 366 myoldnick #dev :End of /NAMES
S: BATCH -abc
S: 376 myoldnick :End of /MOTD
```

### Minimal flow (no LIST/ATTACH)

```
C: CAP REQ :draft/persistence batch
S: CAP * ACK :draft/persistence batch
C: ... (SASL auth) ...
C: CAP END
S: ... (registration) ...
S: 005 nick ... :are supported
S: PERSISTENCE STATUS DEFAULT ON
S: BATCH +xyz draft/persistence
S: :nick!user@host JOIN #channel
S: :server 332 nick #channel :Topic text
S: :server 366 nick #channel :End of /NAMES
S: BATCH -xyz
S: 376 nick :End of /MOTD
```

Even without LIST/ATTACH, the persistence batch signals the boundary between state restoration and live activity — the core problem from ircv3-ideas#91. A client implementing only PR #503's base protocol works without modification; the batch is additive.

### Opt-in persistence

A client enables persistence on a server where it is not on by default:

```
C: PERSISTENCE GET
S: PERSISTENCE STATUS DEFAULT OFF
C: PERSISTENCE SET ON
S: PERSISTENCE STATUS ON ON
```

### Policy-denied persistence

A client attempts to enable persistence, but server policy does not allow it:

```
C: PERSISTENCE SET ON
S: PERSISTENCE STATUS ON OFF
```

### Policy-enforced persistence

A client attempts to disable persistence, but the server requires it (e.g., bouncer-enforced connection class):

```
C: PERSISTENCE GET
S: PERSISTENCE STATUS DEFAULT ON
C: PERSISTENCE SET OFF
S: PERSISTENCE STATUS OFF ON
```

The client's preference is recorded (`OFF`) but the effective setting remains `ON`. The server MAY send a `NOTE` explaining the override.

### DETACH from session

```
C: PERSISTENCE DETACH
S: ... (server disconnects other session connections, releases ghost state)
S: PERSISTENCE STATUS OFF OFF
```

The caller remains connected as a normal non-persistent client. All aliases are disconnected, the session's hold state is cleared, and on next disconnect the client will quit normally instead of being held.

## Server Implementation Notes

### Mapping to Nefarious internals

| Spec concept | Nefarious implementation |
|---|---|
| Session persistence | `BouncerSession` with MDBX backing |
| Session enumeration | `AccountSessions.as_sessions` linked list |
| Session selection | `bounce_find_best_held()` → `PERSISTENCE ATTACH` |
| Auto-select fallback | Existing `bounce_find_best_held()` heuristic |
| Channel restoration | `bounce_send_channel_state()` |
| Session ID | `hs_sessid` |
| HELD state | `hs_state == BOUNCE_HOLDING` |
| ACTIVE state | `hs_state == BOUNCE_ACTIVE` |
| Effective setting | Always ON for `CRFLAG_BOUNCER` connection classes |
| Session enforced flag | New: `hs_enforced` — set on enforced-class attach, cleared on transition to HELD |
| DETACH | `bounce_destroy_session()` (refused if `hs_enforced`) |

### Connection class policy

Nefarious uses connection classes with `CRFLAG_BOUNCER` to determine automatic persistence — clients on these classes have persistence enabled by default. Clients on other classes may opt in via `PERSISTENCE SET ON`.

Currently, the `bouncer/hold` metadata key acts as a user-facing override (setting it to `0` disables persistence even on bouncer-enforced classes). This is confusing and poorly discoverable. `PERSISTENCE SET/GET/STATUS` replaces this mechanism with a proper protocol — the metadata key can be retained internally as the storage backing for the client setting, but clients interact via `PERSISTENCE` commands instead of raw metadata writes.

### Interaction with aliases

Alias connections (multiple simultaneous connections to the same session) receive the persistence batch on attach, just like a primary resuming from HELD state. Both paths call `bounce_send_channel_state()` — the alias needs to know what channels it's in and receive TOPIC/NAMES for each.

If a client sends `PERSISTENCE LIST` and a session is ACTIVE (another connection is live), the session appears with state `ACTIVE`. `PERSISTENCE ATTACH` to an ACTIVE session creates an alias connection to that session. The alias receives the persistence batch containing JOINs for all channels the session is currently in.

## Recommendations

This section is non-normative.

### Abuse prevention

Persistence carries a high risk of abuse, including denial-of-service attacks against servers. Server implementations and server operators should institute safeguards against this (for example, requiring verification during account registration, limiting the number of sessions per account, or restricting persistence to specific connection classes).

### Session expiry

Servers may implement configurable conditions for removing persistent clients from the server (for example, an inactivity timeout on the order of days or months). When a held session expires, the server removes the client from the network as if it had quit.

### Bouncer implementations

Conventional IRC bouncers can implement this specification by adding support for the `PERSISTENCE` command and support for storing the user's preferred setting, then communicating that regardless of the user's setting, persistence is still enabled (e.g., `PERSISTENCE STATUS OFF ON`). This communicates to the client that any preference to become non-persistent has been received but will not be honored.

### Client UI recommendations

There are multiple possibilities for client UIs. Some clients may wish to enable persistence by default (allowing the user to disable this either globally or per-network). They can request `draft/persistence`, then follow this algorithm:

- On observing `PERSISTENCE STATUS DEFAULT OFF`, send `PERSISTENCE SET ON`
- On observing `PERSISTENCE STATUS ON ON`, persistence has been enabled successfully; display this to the end user
- On observing `PERSISTENCE STATUS ON OFF`, report to the end user that it is not possible to enable persistence
- On observing `PERSISTENCE STATUS OFF OFF`, report to the end user that persistence has been disabled by another client

Alternately, clients may wish to report the persistence status to the user, then provide a setting to change it.

Clients that support the `list` and `attach` extensions should present a session picker when multiple sessions are available, showing the nick and channel list for each. If only one session exists, clients should attach to it automatically without prompting.

Clients should select a session promptly after receiving `PERSISTENCE ENDOFLIST`. If the user does not make a selection within a reasonable timeout (e.g., 30 seconds), the client should either fall through to `CAP END` without an `ATTACH` (letting the server auto-select) or attach to the most recently active session. Leaving registration open indefinitely waiting for user input risks hitting server registration timeouts.

Clients may cache the user's last session selection per server/account and reuse it on subsequent reconnects, bypassing the picker entirely when the same session ID is still available. This avoids prompting the user on every reconnect while still allowing session switching when needed.

## Security Considerations

- Persistence carries a high risk of resource exhaustion and denial-of-service. Servers SHOULD require account authentication before creating persistent sessions, SHOULD limit the number of concurrent sessions per account, and SHOULD enforce inactivity timeouts to reclaim held sessions.
- `PERSISTENCE LIST` exposes nick and channel information for held sessions. Servers MUST only return sessions belonging to the authenticated account.
- Session IDs SHOULD be opaque and unguessable to prevent session hijacking, though authentication is the primary security boundary.
- Servers SHOULD enforce rate limits on `PERSISTENCE LIST` to prevent enumeration abuse.

## Compatibility

### With PR #503

This spec is a strict superset of PR #503. The base protocol (STATUS/GET/SET) uses identical syntax, semantics, and error codes. The extensions (LIST/ATTACH/DETACH, persistence batch) are additive and gated behind CAP value tokens.

### With ircv3-ideas#91

The CAP alone (without any PERSISTENCE commands) satisfies the minimal "don't auto-rejoin" signal that emersion requested. The persistence batch addresses the "how does the client know when the join burst is done" follow-up.

### With existing drafts

- `draft/chathistory` — Independent. Chathistory replay occurs after the persistence batch. Clients with chathistory do their own replay; clients without get auto-replay from the bouncer.
- `batch` — The persistence batch uses standard batch infrastructure. No new batch semantics are introduced.

## Open Questions

1. **Batch type name** — Should it be `draft/persistence` (matching the CAP) or something more specific like `draft/channel-restore`? Using the CAP name is simpler; a distinct name allows the batch type to be used independently.

2. **Pre-registration LIST** — Allowing LIST before CAP END is powerful but unusual. Should it require a specific capability token (e.g., `pre-reg-list`) or is gating on `list` sufficient?

3. **Interaction with MONITOR/WATCH** — MONITOR visibility is governed by the session's effective away state, not raw connection events. A connection that negotiates `draft/pre-away` and sets `AWAY *` "does not exist" for presence purposes per the pre-away spec — attaching such a connection MUST NOT trigger a MONITOR online/away transition. Only connections that change the effective away state (i.e., a connection that is present, or sets a human-readable away message) should produce MONITOR notifications.
