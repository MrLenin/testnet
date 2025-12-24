# IRCv3 Event Playback Extension Investigation

## Status: IMPLEMENTED (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/event-playback

**Capability**: `draft/event-playback`

**Feature Flag**: `FEAT_CAP_draft_event_playback` (already exists, enabled by default)

---

## Implementation Summary

Event-playback extends the `draft/chathistory` capability to include non-message events in history playback. When a client has `draft/event-playback` capability enabled, they receive JOIN, PART, QUIT, KICK, MODE, and TOPIC events in addition to PRIVMSG/NOTICE.

### How It Works

1. **Capability Check**: When sending history, `m_chathistory.c` checks if the client has `CAP_DRAFT_EVENTPLAYBACK`
2. **Event Filtering**: `should_send_message_type()` filters events - without event-playback, only PRIVMSG/NOTICE are sent
3. **Event Storage**: Events are stored in LMDB with their type (HISTORY_JOIN, HISTORY_PART, etc.)
4. **Playback**: During CHATHISTORY commands, events are formatted according to their type

---

## Files Modified

| File | Changes |
|------|---------|
| `ircd/m_chathistory.c` | Added `should_send_message_type()` filtering function |
| `ircd/channel.c` | Added `store_channel_event()`, store JOIN/PART/MODE events |
| `ircd/s_misc.c` | Added `store_quit_events()` for QUIT event storage |
| `ircd/m_topic.c` | Added `store_topic_event()` for TOPIC event storage |
| `ircd/m_kick.c` | Added `store_kick_event()` for KICK event storage |

---

## Event Types Stored

| Event | Type Constant | Storage Location | Content |
|-------|---------------|------------------|---------|
| JOIN | `HISTORY_JOIN` | `channel.c:joinbuf_join()` | Empty string |
| PART | `HISTORY_PART` | `channel.c:joinbuf_join()` | Part reason |
| QUIT | `HISTORY_QUIT` | `s_misc.c:exit_one_client()` | Quit message |
| TOPIC | `HISTORY_TOPIC` | `m_topic.c:do_settopic()` | Topic text |
| KICK | `HISTORY_KICK` | `m_kick.c:m_kick()` | "nick :reason" |
| MODE | `HISTORY_MODE` | `channel.c:modebuf_flush_int()` | Mode string |

---

## Implementation Details

### Event Filtering (m_chathistory.c)

```c
/** Check if message type should be sent to client.
 * Without draft/event-playback, only PRIVMSG and NOTICE are sent.
 */
static int should_send_message_type(struct Client *sptr, enum HistoryMessageType type)
{
  if (type == HISTORY_PRIVMSG || type == HISTORY_NOTICE)
    return 1;
  return CapActive(sptr, CAP_DRAFT_EVENTPLAYBACK);
}
```

This function is called in `send_history_batch()` before sending each message.

### Event Storage Pattern

Each file uses a similar pattern for storing events:

```c
#ifdef USE_LMDB
static unsigned long xxx_history_msgid_counter = 0;

static void store_xxx_event(struct Client *sptr, struct Channel *chptr, ...)
{
  /* 1. Check history availability and chathistory feature */
  if (!history_is_available()) return;
  if (!feature_bool(FEAT_CAP_draft_chathistory)) return;

  /* 2. Only store from local users to avoid duplicates */
  if (!MyUser(sptr)) return;

  /* 3. Generate timestamp and msgid */
  /* 4. Build sender string nick!user@host */
  /* 5. Get account if logged in */
  /* 6. Store in database */
  history_store_message(msgid, timestamp, channel, sender, account, type, text);
}
#endif
```

### QUIT Special Case

QUIT events are stored for each channel the user is on, before `remove_user_from_all_channels()` is called. This requires iterating through `cli_user(sptr)->channel` membership list.

### KICK Event Format

Per the event-playback spec, KICK events store the kicked user's nick and reason:
```
<kicked_nick> :<reason>
```

---

## Message Formatting (m_chathistory.c)

The existing `msg_type_cmd[]` array maps event types to IRC commands for playback:

```c
static const char *msg_type_cmd[] = {
  [HISTORY_PRIVMSG] = "PRIVMSG",
  [HISTORY_NOTICE]  = "NOTICE",
  [HISTORY_JOIN]    = "JOIN",
  [HISTORY_PART]    = "PART",
  [HISTORY_QUIT]    = "QUIT",
  [HISTORY_KICK]    = "KICK",
  [HISTORY_MODE]    = "MODE",
  [HISTORY_TOPIC]   = "TOPIC",
  [HISTORY_TAGMSG]  = "TAGMSG"
};
```

---

## Configuration

Event-playback is enabled when chathistory is enabled:
```
features {
    "CAP_draft_chathistory" = "TRUE";    /* Enable chathistory */
    "CAP_draft_event_playback" = "TRUE"; /* Enable event-playback (default) */
};
```

---

## Testing

1. Connect with a client that supports `draft/event-playback`
2. Join a channel and perform various actions (join, part, topic changes, mode changes)
3. Reconnect and request history with `CHATHISTORY LATEST #channel * 50`
4. Verify all event types are included in the response

Without `draft/event-playback`:
- Only PRIVMSG and NOTICE events are returned

With `draft/event-playback`:
- All event types (JOIN, PART, QUIT, KICK, MODE, TOPIC, PRIVMSG, NOTICE) are returned

---

## Dependencies

| Dependency | Status |
|------------|--------|
| `draft/chathistory` | Complete |
| `draft/event-playback` capability | Already defined |
| LMDB history storage | Complete |
| `standard-replies` | Complete |

---

## Notes

1. **Local Users Only**: Events are only stored when originated by local users to prevent duplicate storage in a multi-server network.

2. **TAGMSG**: While the storage infrastructure supports TAGMSG (HISTORY_TAGMSG), it is not currently being stored. This can be added to m_tagmsg.c if needed.

3. **Message IDs**: Each event gets a unique msgid in the format `serverid-starttime-counter`, ensuring uniqueness across server restarts.

4. **Timestamps**: All events use ISO 8601 format with millisecond precision: `2024-01-15T10:30:45.123Z`

---

## References

- **Spec**: https://ircv3.net/specs/extensions/event-playback
- **Chathistory**: https://ircv3.net/specs/extensions/chathistory
- **Related**: draft/chathistory, message-tags, msgid
