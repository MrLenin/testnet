# History Gap Markers for +Y and +y

**Goal:** When a message is skipped due to +Y (no-storage) or +y (PM opt-out), store a lightweight gap marker in LMDB so chathistory replay shows the gap instead of silently omitting it.

## Design

### What Gets Stored

When `store_channel_history()` or `store_private_history()` would skip a message due to +Y or +y, store a **gap marker** instead:

```
type=HISTORY_GAP | sender=nick!user@host | account=acct | content=""
```

- Same LMDB key format: `target\0timestamp\0msgid`
- Serialized value: `"9|nick!user@host|account|"` (~30-40 bytes vs ~300+ for a real message)
- No content stored — the privacy protection is about content, not sender identity
- Sender info always stored in LMDB (needed for collapsing consecutive gaps by sender)

### Query-Time Collapsing

In `send_history_batch()`, consecutive gap markers from the same sender are collapsed into one placeholder. This prevents a chatty +Y user from flooding the replay with individual gap lines.

### Wire Format

Gap markers are rendered as regular messages inside the chathistory BATCH, using `PRIVMSG` with a `+draft/chathistory-gap` tag. Clients that understand the tag can render them specially; others see them as normal messages.

**Channel gaps** — from the server (sender identity stored but hidden in display):
```
@batch=hist42ABA;time=2024-01-15T10:30:45.123Z;msgid=gap-123;+draft/chathistory-gap :server.name PRIVMSG #channel :[3 messages not stored]
```
Sender nick is stored in LMDB for collapsing but not exposed in channel display. Reply context often makes the identity guessable anyway, but we don't actively reveal it.

**PM gaps** — from the original sender (both parties already know who they're talking to):
```
@batch=hist42ABA;time=2024-01-15T10:30:45.123Z;msgid=gap-123;+draft/chathistory-gap :nick!user@host PRIVMSG othernick :[message not stored]
```

Common format:
- Uses `PRIVMSG` inside the chathistory batch (same as regular history messages)
- Adds `+draft/chathistory-gap` message tag for programmatic detection
- Content: `[message not stored]` (single) or `[N messages not stored]` (collapsed)
- Clients unaware of the tag see readable placeholder text naturally

## Changes by File

### 1. `nefarious/include/history.h` — Add HISTORY_GAP enum

```c
enum HistoryMessageType {
  HISTORY_PRIVMSG = 0,
  HISTORY_NOTICE  = 1,
  HISTORY_JOIN    = 2,
  HISTORY_PART    = 3,
  HISTORY_QUIT    = 4,
  HISTORY_KICK    = 5,
  HISTORY_MODE    = 6,
  HISTORY_TOPIC   = 7,
  HISTORY_TAGMSG  = 8,
  HISTORY_GAP     = 9    /* Message not stored (sender opted out) */
};
```

### 2. `nefarious/ircd/ircd_relay.c` — Store gap markers at skip points

**Channel history** (`store_channel_history()`): Replace the early return at `IsNoStorage(sptr)` with a gap marker store:

```c
/* Check if sender has +Y (no storage) user mode */
if (IsNoStorage(sptr)) {
    /* Store gap marker instead of silently skipping */
    history_store_message(msgid, timestamp, chptr->chname, sender,
                          account, HISTORY_GAP, "");
    return;
}
```

**PM history** (`store_private_history()`): Two skip points need gap markers:

1. `should_store_pm()` returns 0 due to opt-out (+y) — store gap marker with the target pair
2. `IsNoStorage(sptr)` — store gap marker

For the PM opt-out case, the sender/target info must be built before the consent check. Restructure `store_private_history()` to:
1. Check feature flags (early return, no gap marker — these are policy, not opt-out)
2. Build sender string and target pair
3. Check `should_store_pm()` — if fails due to opt-out, store gap marker
4. Check `IsNoStorage(sptr)` — if set, store gap marker
5. Otherwise store normal message

**Distinguishing opt-out from policy:** `should_store_pm()` returns 0 for both unauthenticated users (policy) and opted-out users (+y). Gap markers should only be stored for opt-out, not for policy failures. Split the check:

```c
/* Both must have accounts (policy — no gap marker) */
if (!IsAccount(sptr) || !IsAccount(acptr))
    return;

/* Build sender + target here (needed for gap markers below) */
...

/* Check opt-out (gap marker if opted out) */
if (has_pm_optout(sptr) || has_pm_optout(acptr)) {
    history_store_message(msgid, timestamp, target, sender,
                          account, HISTORY_GAP, "");
    return;
}

/* Check +Y no-storage (gap marker) */
if (IsNoStorage(sptr)) {
    history_store_message(msgid, timestamp, target, sender,
                          account, HISTORY_GAP, "");
    return;
}
```

### 3. `nefarious/ircd/m_chathistory.c` — Render gap markers in replay

**Update `msg_type_cmd[]`** to add entry for HISTORY_GAP:
```c
static const char *msg_type_cmd[] = {
  "PRIVMSG", "NOTICE", "JOIN", "PART", "QUIT",
  "KICK", "MODE", "TOPIC", "TAGMSG", "PRIVMSG"  /* GAP rendered as PRIVMSG */
};
```

**Update `should_send_message_type()`** — gap markers are always sent (like PRIVMSG/NOTICE):
```c
if (type == HISTORY_PRIVMSG || type == HISTORY_NOTICE || type == HISTORY_GAP)
    return 1;
```

**Update `send_history_batch()`** — collapse consecutive gaps and render:

Add a `send_gap_marker()` helper and collapsing logic in the message loop:

```c
static void send_gap_marker(struct Client *sptr, const char *target,
                             const char *outer_batchid, const char *time_str,
                             const char *sender, int count)
{
    char content[128];
    int is_channel = (*target == '#' || *target == '&' || *target == '+');

    if (count > 1)
        ircd_snprintf(0, content, sizeof(content), "[%d messages not stored]", count);
    else
        ircd_strncpy(content, "[message not stored]", sizeof(content) - 1);

    if (is_channel) {
        /* Channel: send from server, hide sender identity */
        /* ... sendcmdto_one with server as source, PRIVMSG, +draft/chathistory-gap tag */
    } else {
        /* PM: send from original sender */
        /* ... sendcmdto_one with sender hostmask, PRIVMSG, +draft/chathistory-gap tag */
    }
}
```

In the `send_history_batch()` loop, when encountering a HISTORY_GAP:
- Count consecutive GAPs from the same sender
- Call `send_gap_marker()` with the count
- Skip past the collapsed records

### 4. No changes needed to `history.c`

The existing `history_store_message()` and `serialize_message()` already handle any `HistoryMessageType` value and empty content strings. The gap marker `"9|nick!user@host|account|"` serializes and deserializes correctly through the existing pipe-delimited format.

## Files Summary

| File | Change |
|------|--------|
| `nefarious/include/history.h` | Add `HISTORY_GAP = 9` to enum |
| `nefarious/ircd/ircd_relay.c` | Store gap markers instead of early-returning at +Y/+y skip points |
| `nefarious/ircd/m_chathistory.c` | Render gaps as PRIVMSGs in batch (server for channels, sender for PMs), collapse consecutive, add gap tag |

## Edge Cases

- **Channel +P (no-storage mode)**: No gap markers — the entire channel opts out, no individual message tracking needed
- **`FEAT_CHATHISTORY_STORE` disabled**: No gap markers — storage is globally off
- **`FEAT_CHATHISTORY_PRIVATE` disabled**: No PM gap markers — PM history is globally off
- **Unauthenticated PM senders**: `should_store_pm()` returns 0, but this is a policy requirement, not opt-out. No gap marker — the check is split so only explicit +y opt-out produces markers.
- **Mixed gaps**: If user A (+Y) and user B (+Y) both send messages, their gap markers collapse independently (same-sender collapsing, not all-gaps collapsing)

## Verification

1. Build Nefarious with changes
2. User with +Y sends messages to #channel — gap markers appear in CHATHISTORY LATEST as PRIVMSGs from server
3. User with +y sends PMs — gap markers appear in PM CHATHISTORY with sender nick
4. Consecutive gaps from same sender collapse into single placeholder with count
5. Gap markers include `+draft/chathistory-gap` tag
6. Channel +P does NOT produce gap markers
7. Unauthenticated PM attempts do NOT produce gap markers
8. Gap markers respect retention policy (cleaned up like normal messages)
