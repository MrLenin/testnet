# Channel Mode: Require Storage Participation

## Status: Proposal (pending letter assignment)

## Origin

Discussion between Rubin and ibutsu (2026-02-01) about channel owners wanting to prevent `+Y` (no-storage) users from sending messages to their channel, keeping history clean and complete without gap markers.

## Concept

A new channel extended mode that rejects PRIVMSG/NOTICE from users who have user mode `+Y` (no-storage) set. Messages are blocked at the IRCd relay level — they are never sent to the channel and never stored, so no gap markers are created.

## Rationale

- Channel owners who value complete, readable history don't want it littered with "[message not stored]" gap markers
- Current options (`+H`, `+P`) control access and storage policy but not participation requirements
- "If you don't want to participate in history, you don't participate in the channel" is a reasonable policy for channel owners to enforce

## Implementation

### Core behavior

1. Add new `EXMODE_REQUIRESTORAGE` flag in `include/channel.h`
2. In the relay path (`ircd/ircd_relay.c`), before message delivery and storage:
   ```c
   if ((chptr->mode.exmode & EXMODE_REQUIRESTORAGE) && IsNoStorage(sptr)) {
       send_reply(sptr, ERR_CANNOTSENDTOCHAN, chptr->chname);
       return;
   }
   ```
3. Register the mode letter in all `chan_exflags[]` tables in `ircd/channel.c`
4. Add to P10 BURST mode parsing

### Files to modify

- `nefarious/include/channel.h` — new EXMODE define
- `nefarious/ircd/channel.c` — mode tables (4 locations: `SetAutoChanModes`, `modebuf_flush_int`, `modebuf_extract`, `mode_parse`)
- `nefarious/ircd/ircd_relay.c` — send check in channel relay functions
- `nefarious/ircd/m_batch.c` — send check for multiline batch relay (if applicable)
- `nefarious/ircd/m_tagmsg.c` — send check for TAGMSG relay (if applicable)

### Numeric

Use `ERR_CANNOTSENDTOCHAN` (404) with a message like "Cannot send to channel (+y: storage participation required)"

## Open Questions

### Mode letter
- `+y` proposed (symmetry: channel `+y` blocks user `+Y`), but `+y` is already used as a user mode (PM opt-out)
- IRC has precedent for same letter meaning different things on users vs channels
- Other candidates: `+G`, `+W`, `+F`, or any free extended letter
- **Decision deferred** — Rubin wants to think on it

### +v override
- Should `+v` (voice) allow `+Y` users to bypass the restriction, similar to how `+v` overrides `+m`?
- Pro: gives channel ops granular control, familiar pattern
- Con: adds complexity, and the user's messages still won't be stored (gap markers return)
- If `+v` overrides, the channel gets gap markers for that user — which is the thing the mode was trying to prevent
- **Suggestion**: no `+v` override. If the channel requires storage, it means it.

### Interaction with other modes
- `+P` (no storage) + require-storage: contradictory, but harmless (no messages stored regardless, require-storage just blocks +Y users for no practical reason). Could warn or disallow the combination.
- `+H` (public history) + require-storage: complementary. "History is public AND complete."

## Chathistory Mode Summary (for reference)

| Mode | Type | Letter | Purpose |
|------|------|--------|---------|
| Public History | Channel | `+H` | Anyone can query history (no auth/membership needed) |
| No Storage | Channel | `+P` | Nothing stored for this channel |
| Require Storage | Channel | `TBD` | Block `+Y` users from sending |
| No Storage | User | `+Y` | User's channel messages not stored (gap markers instead) |
| PM Opt-out | User | `+y` | User's PMs not stored (gap markers instead) |
