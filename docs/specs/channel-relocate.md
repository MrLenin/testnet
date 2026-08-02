# `evilnet/channel-relocate` — consent-based channel renaming

Status: **draft** (vendored extension, `evilnet/` namespace)

Authors: AfterNET development (MrLenin / ibutsu)

## Notes

This is a vendored specification. It is not an IRCv3 working group document,
and it deliberately diverges from [`draft/channel-rename`][dcr] in one core
semantic: **no client is ever moved between channels without consent.**

[dcr]: https://ircv3.net/specs/extensions/channel-rename

## Motivation

`draft/channel-rename` lets an operator rename a channel in place. All members
are force-moved to the new name server-side; the capability only controls how
the move is *presented* (a tidy `RENAME` message vs. a legacy `PART`/`JOIN`
pair). The permission to relabel every member's presence rests entirely with
the channel operator.

This creates an abuse class: an operator can accumulate a community under an
innocuous name and then rename the channel to something defamatory or
incriminating, making every member instantly and involuntarily "present" in
the new channel — visibly, in WHOIS, channel lists, and logging bots. Members
with the capability are moved *silently*; the capability makes the abuse
tidier, not consensual.

The alternative operators use today — set a topic/notice, lock the old
channel, `+L`-forward it, invite people over — is consensual but loses
everything that makes a rename a *rename*: registration, access lists,
message history, and protection of the old name all stay behind, and no
client renders any of it coherently.

This extension keeps the rename machinery (state transfer, history
continuity, old-name protection, a first-class client experience) and
replaces only the member move with consent. The model follows Matrix room
upgrades: the old room is tombstoned with a pointer to its replacement,
clients render a "this room has moved" affordance, and nobody is auto-joined.

Design goal: **fully usable at zero client adoption.** Clients without the
capability get a legible experience through existing primitives (NOTICE,
`+L` redirect and its numerics). The capability is additive polish, not a
dependency.

## Relationship to `draft/channel-rename`

A server implementing this extension operates in *relocation mode*: the
rename command exists and behaves as specified in `draft/channel-rename`
**except** that members are not moved by default.

`draft/channel-rename` notification semantics still apply — but only to
members who actually move (see *Member handling*). A member who is not moved
MUST NOT receive a `RENAME` message for the channel, since `RENAME` asserts
"your membership now points at the new name" and would desynchronize any
client that honors it.

Whether a network runs force-move semantics (plain `draft/channel-rename`)
or relocation mode is network policy; the two modes MUST NOT be mixed on one
network.

## Architecture

### Dependencies

None. This extension does not require `draft/channel-rename` to be
negotiated by the client, though servers implementing it will generally
implement both capabilities. [`message-tags`][mt] is recommended.

[mt]: https://ircv3.net/specs/extensions/message-tags

### Capability

    evilnet/channel-relocate

No value. Advertised and negotiated per [`capability-negotiation`][cap].
Negotiating it means: *"my client will present relocation notices to the
user as an actionable prompt, and will not assume it has been moved."*

[cap]: https://ircv3.net/specs/extensions/capability-negotiation

### `RELOCATE` message

Sent by the server to a channel member who is **not** being moved and who has
negotiated `evilnet/channel-relocate`:

    :<source> RELOCATE <old-channel> <new-channel> [:<reason>]

* `<source>` is the entity that performed the rename (the issuing user's
  full mask where known, otherwise a server or services name), so clients
  can attribute the action in the prompt.
* The message MAY carry `msgid`, `time`, and `account` tags.
* The message is informational plus actionable: the recipient remains a
  member of `<old-channel>`. The client SHOULD present a prompt of the form
  *"<old-channel> has moved to <new-channel> (reason) — follow?"*.
* **Accepting** is simply sending `JOIN <new-channel>`. There is no new
  client-to-server command.
* **Declining** is doing nothing (or parting the old channel). No reply is
  expected or defined.

`RELOCATE` is sent once, at rename time. A client that was offline for the
rename discovers the move through the tombstone (below) when it rejoins.

### `RPL_ISUPPORT` token

    RELOCATE=<grace-seconds>

Advertises relocation mode and the tombstone grace period, e.g.
`RELOCATE=900`. Clients MAY use this to time out their own prompt UI.

### User mode `+F` (auto-follow)

A user-settable mode meaning *"I consent in advance to all channel
relocations."* A `+F` member is moved immediately at rename time, exactly as
under `draft/channel-rename`, and is notified per their negotiated
capabilities (`RENAME` message if they have `draft/channel-rename`, legacy
`PART`+`JOIN` otherwise).

This is the explicit-opt-in inverse of the draft spec's default. Services
MAY persist the preference and restore it on login.

## Behavior

### Performing a rename

Command syntax, validation, and error handling are as in
`draft/channel-rename` (`RENAME <old> <new> [:<reason>]`, `FAIL RENAME
CHANNEL_NAME_IN_USE`/`CANNOT_RENAME`, etc.). Who may rename is network
policy; on networks with services arbitration the same authorization flow
applies unchanged. This spec changes only what happens to members after the
rename is authorized.

On success, the server:

1. Creates `<new-channel>` and transfers channel state to it: modes, ban
   lists, keys/limits, registration status, and — where the server supports
   it — message-history association, so history follows the community rather
   than the name.
2. Converts `<old-channel>` into a **tombstone** (below).
3. Partitions the membership and notifies each member per *Member handling*.

### Member handling

At rename time each member of the old channel falls into exactly one class:

| Class | Moved? | Notification |
|---|---|---|
| The issuer of the rename | yes | per rename caps (`RENAME` or `PART`+`JOIN`) |
| Members with umode `+F` | yes | per rename caps (`RENAME` or `PART`+`JOIN`) |
| Members with `evilnet/channel-relocate` | no | `RELOCATE` |
| All other members | no | server `NOTICE` to the old channel |

The issuer is always moved: issuing the rename is consent. A member holding
both `evilnet/channel-relocate` and `draft/channel-rename` is in the
`RELOCATE` class — this capability takes precedence, and they are not moved.

The fallback `NOTICE` SHOULD name both channels and the reason, e.g.:

    :services.example.net NOTICE #old :#old has moved to #new (spring cleaning). Join #new to follow; this channel closes in 15 minutes.

### The tombstone

For the grace period (network-configured, advertised via `RELOCATE=`), the
old channel persists as a tombstone:

* The server sets channel mode `+L <new-channel>` (redirect) on it. A user
  attempting to `JOIN <old-channel>` is forwarded to the new channel with
  the server's existing `+L` redirect numeric (Nefarious: `ERR_LINKSET`
  490; other lineages use 470). Users with the NOLINK user mode, `+L`,
  opt out of redirects as today and receive the corresponding error
  (Nefarious: `ERR_LINKCHAN` 551) instead — an existing, respected
  consent mechanism. The tombstone's `+l` limit, if any, is stripped so
  the redirect fires unconditionally.
* The persist marker keeping the empty tombstone alive is visible as `+z`
  in MODE queries even though only the `+L` change is announced.
* Remaining members see each mover leave via an ordinary `PART <old>`
  (reason names the new channel), except movers whose join was still
  delayed (`+D`), whose presence is never revealed.
* Remaining members keep their membership and may talk, part, or follow at
  any time. Servers MAY additionally set `+m` on the tombstone; this spec
  does not require it.
* The old name cannot be re-registered during the grace period (and for any
  additional do-not-register window the network configures beyond it).

At grace expiry, the server removes each remaining member with a
server-generated `PART`:

    :dan!d@host PART #old :Channel has moved to #new

and the tombstone dissolves. The do-not-register window on the old name MAY
outlive the tombstone.

### Status preservation

Members do not lose standing by declining to be force-moved. A former member
of the old channel who joins the new channel **within the grace period**
SHOULD be granted the membership status (op/halfop/voice, and oplevel where
applicable) they held in the old channel at rename time, from a snapshot
taken when the rename executed. On registered channels, services access
lists transfer with the registration and apply as usual regardless of the
grace period.

### Multiple renames

A rename of a channel that is itself the target of a live tombstone updates
the earlier tombstone's redirect to point at the newest name (redirect
chains MUST NOT require multi-hop resolution at join time). A tombstone
channel itself cannot be renamed.

## Examples

Channel `#oldname` is renamed to `#newname` by `alice` (reason
`moving!`). Members: `alice` (issuer, has `draft/channel-rename`), `bob`
(umode `+F`, has `draft/channel-rename`), `carol` (has
`evilnet/channel-relocate`), `dan` (no relevant caps).

Alice and bob (moved, have the rename cap):

    :alice!a@example RENAME #oldname #newname :moving!

If bob lacked `draft/channel-rename` he would instead see the legacy pair:

    :bob!b@example PART #oldname :Channel renamed to #newname
    :bob!b@example JOIN #newname

Carol (not moved, prompted):

    :alice!a@example RELOCATE #oldname #newname :moving!

Carol's client prompts; she accepts, her client sends:

    JOIN #newname

and she receives a normal join burst for `#newname` (with her old-channel
status restored per *Status preservation*).

Dan (not moved, no caps):

    :services.example.net NOTICE #oldname :#oldname has moved to #newname (moving!). Join #newname to follow; this channel closes in 15 minutes.

Eve, not previously a member, tries to join the old name during the grace
period:

    JOIN #oldname
    :irc.example.net 490 eve #oldname :[Link] #oldname has become full, so you are automatically being transferred to the linked channel #newname
    :eve!e@example JOIN #newname

(The numeric and text are the server's existing `+L` forward notification;
490 shown here per Nefarious.)

At grace expiry, dan is still sitting in the tombstone:

    :dan!d@example PART #oldname :Channel has moved to #newname

## Security considerations

* The abuse class this extension exists to close: no member's presence can
  be relabeled without their consent. Consent is expressed per-event (the
  `JOIN` after a `RELOCATE` prompt), in advance (umode `+F`), or by taking
  the action oneself (the issuer).
* The `+L` redirect during the grace period moves a user only in response
  to that user's own `JOIN` of the old name, which is longstanding `+L`
  behavior with an existing opt-out (NOLINK).
* The rename itself remains a privileged, network-policy-gated action; this
  extension does not widen who may perform it.
* A malicious operator can still rename a channel to an offensive name, but
  gains no hostages: members appear in the new channel only if they
  individually choose to.

## Limitations and open questions

1. **Unregistered channels** lose services-backed access transfer; only the
   grace-period status snapshot preserves standing. A former op who follows
   after the grace period joins as a regular user.
2. **Prompt fatigue / client UX** is delegated to clients; this spec
   deliberately defines no decline signal, so servers cannot distinguish
   "declined" from "hasn't decided," and the tombstone lifetime is the only
   timeout.
3. **Multi-session users** (bouncers): whether `+F` and per-session
   capability sets can disagree across attached sessions of one identity is
   implementation-defined; implementations SHOULD move a user only if the
   move is coherent for all of their sessions.
4. **Offline members** of registered channels (services-recognized regulars
   not present at rename time) get no `RELOCATE`; they encounter the
   tombstone redirect on their next join. Servers MAY replay a `RELOCATE`
   on rejoin of the tombstone within the grace period.

## Implementation status (v1, 2026-08-02 — deviations & clarifications)

The reference implementation (nefarious + X3 `feature/channel-relocate`)
conforms with these recorded choices and gaps:

1. **Wire propagation**: relocation rides the existing rename token as
   `RN <old> <new> C :<reason>` — the marker is honored only in the
   5-parameter shape and the trailing reason is always emitted (possibly
   empty). The origin server's `RENAME_CONSENT` feature decides; relays
   obey the marker regardless of local policy.
2. **Deployment ordering constraint**: every IRCv3-aware server must run a
   relocation-aware build BEFORE any server enables `RENAME_CONSENT` — a
   pre-relocation peer parses the marker as a reason and force-moves
   (classic rename), diverging membership.
3. **Status preservation keys**: snapshots match by account when the
   member had one; account-less members match by nick **and** user@host.
   A member who authenticates between the relocation and their follow
   join forfeits the snapshot (deliberate: prevents nick-reuse theft).
4. **NOTICE rendering**: with an empty reason the parenthetical is
   omitted; the closing time renders in minutes (sub-minute graces read
   "0 minutes" — cosmetic, test beds only).
5. **Post-grace window**: after dissolution the old name is an ordinary
   dead channel; on ZANNELS builds a brief zombie-channel window exists
   where a joiner is opped on the husk before it collects. Registration
   of the name remains DNR-blocked far longer than the grace.
6. **`RELOCATE` replay on rejoin** (spec MAY): not implemented.
7. **Bouncer multi-session**: a mover's local alias connections receive
   the legacy PART+JOIN presentation (never a stale view); an alias whose
   primary lives on another server does not receive the automatic status
   restore (join path never runs on the primary's server).
8. **Services continuity**: X3 re-points the registration, follows its
   bots with real JOINs (re-asserting their status modes), keeps the
   husk's member view honest via a grace-aligned sweep, and re-arms that
   sweep after restarts from burst state (`+z` + unregistered + rename
   DNR fingerprint). The fingerprint is saxdb-persisted; a services crash
   inside the save window lets the next burst strip the persist bit —
   dissolving the network-wide tombstone early (redirect and status
   snapshots lost for the rest of the grace). An explicit
   ircd→services tombstone-dissolve signal is recorded as future work.
9. **Document-driven peers** (CRDT mesh coexistence): the engine clears
   registration/persist bits silently (no wire emission); peers that
   materialize channel state from a replicated document re-assert those
   bits. Relocation is not yet ported to the mesh branch — networks
   running doc-driven peers must not enable `RENAME_CONSENT` until it is.

## Implementation notes (non-normative, Nefarious/X3)

Relocation mode layers onto the existing `feature/channel-rename` work with
the core untouched:

* Reused as-is: `m_rename.c` validation and pending-rename table, X3
  owner-only arbitration (`AC R … RENAME` round-trip), `+R`/registration
  transfer, timed do-not-register on the old name, rename-chain history
  fence ("history follows the community"), `RENAME`/`PART`+`JOIN` per-member
  notification machinery, P10 `RN` propagation and the `r` server-flag
  routing.
* New: the member-partition policy in the post-authorization path (replacing
  the unconditional `rename_channel()` member move), the `RELOCATE` verb and
  its capability, umode `+F` (`FLAG_RELOCATE_FOLLOW`; letter `F` is free in
  `userModeList`), tombstone lifecycle (server-set `+L`, grace timer,
  expiry sweep with server-generated `PART`s), the status snapshot for
  grace-period rejoins, and the `RELOCATE=` ISUPPORT token.
* Mode selection (force-move vs. relocation) would be a feature flag
  (e.g. `FEAT_RENAME_CONSENT`) consulted at the single point where the
  authorized rename executes; both modes ship, networks pick one.
