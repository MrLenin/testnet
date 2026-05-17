# Bouncer held-ghost event replay

**Status:** Planning (not implemented)
**Author:** ibutsu
**Date:** 2026-05-12

## Problem

When a bouncer session is HELD (no live primary, ghost only), channel
events (JOIN/PART/MODE/KICK/TOPIC/NICK) arrive for the ghost's channels.
Channel state is updated correctly — memberships, modes, topic, etc. —
but no notification is queued for the absent client.

On revive, the freshly-attached primary sees the *current* state via the
post-NJOIN replay, but not the *transitions* that occurred while held.
PRIVMSG/NOTICE are covered by chathistory replay; structural events are
not.

User-visible symptom: "I missed Alice joining and Bob taking +o while I
was offline." Particularly painful for ops who want a record of mode
changes.

## Scope

Queue these events per held-ghost:

- JOIN, PART, QUIT (only for ghosts who share a channel with the actor)
- MODE (channel modes)
- KICK
- TOPIC change
- NICK change (only for users sharing a channel with the ghost)

Out of scope:

- PRIVMSG/NOTICE/TAGMSG — covered by chathistory.
- AWAY, SETNAME — covered by metadata sync at revive.
- Server-to-server-only events.

## Storage

**Per-Client byte-bounded ring**, modeled on `chathistory_ephemeral.c`'s
PM ring (already merged this session). New file:
`bouncer_event_replay.c`.

- Default cap: 64 KB per ghost (configurable via new feature
  `FEAT_BOUNCER_EVENT_REPLAY_BYTES`).
- FIFO eviction when full.
- Cleared on revive after drain, or on ghost destruction.

Each entry stores:
- timestamp (HLC if available, wall-clock fallback)
- pre-formatted IRC line as it would have been delivered to a live client,
  with `@time=…;msgid=…` server-time tags already populated

## Hook points

The ghost already receives most of these events implicitly because it's
still in the channel's member list. The dispatch path (`sendcmdto_channel_butone`)
already iterates members; the only change is that when the recipient is
a HELD ghost (`IsBouncerHold(cli)`), instead of dropping the send to the
nonexistent socket, append to the replay ring.

New helper in `send.c`:

```c
static inline int held_ghost_capture(struct Client *cli, const char *line)
{
  if (!IsBouncerHold(cli)) return 0;
  bounce_event_replay_append(cli, line);
  return 1;  /* consumed, do not deliver */
}
```

Call sites (audit needed):
- `vsendto_one_buffer` family in `send.c`
- channel broadcast helpers
- numeric reply helpers (these mostly aren't reaching held ghosts anyway —
  numerics are reply-to-source, ghosts don't send)

## Drain on revive

In `bounce_revive()`, after channel state is in sync and before the
primary is fully attached, walk the event ring and emit each line via
`sendrawto_one()`. Lines are pre-formatted so they slot into the wire
stream verbatim.

Order matters: drain ring BEFORE chathistory replay, so structural
context (Alice joined) precedes content (Alice said hi).

## Multi-session interaction

Per [memory: project_bouncer_multi_session_neutral.md], future is
`(account, sessid)` not `account`. The ring lives on the Client struct,
so it's already session-scoped (each ghost = one session). No special
adaptation needed.

## Open questions

1. **MODE collapse.** If +o then -o then +o happens while held, do we
   replay all three or collapse to net `+o`? Spec says "client
   observability"; replaying all three preserves the timeline. Default:
   no collapse.
2. **TOPIC.** Multiple topic changes while held → replay all, or just
   final? Final is the spec behavior on join; replay loses the audit
   trail. Default: replay all.
3. **Burst window.** Events arriving during local burst-in-progress are
   ghost-state-update only on this side — peer's burst contains the
   final state. Replaying burst-derived events to the client is wrong
   (they'd see "Alice joined" for users already in the channel at last
   disconnect). Solution: gate ring appending on
   `!bounce_burst_in_progress() && !IsBurst(source_server)`.

## Implementation order

1. Add `bounce_event_replay.{c,h}` with append/drain/purge primitives.
2. Add `FEAT_BOUNCER_EVENT_REPLAY_BYTES` feature.
3. Hook `held_ghost_capture` in send.c at the lowest send primitive.
4. Drain in `bounce_revive()`.
5. Tests: bouncer test that disconnects, has peer perform +o/+v/JOIN,
   reconnects, verifies replay.

## Not blocking

This is a UX improvement, not a correctness bug. Channel state
converges correctly without it. Defer until other bouncer work
stabilizes (BX C2/C3 audits, persistence redesign).
