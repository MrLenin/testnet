# IRCv3 Channel-Context Client Tag Investigation

## Status: PARTIAL - TAGMSG only

**Specification**: https://ircv3.net/specs/client-tags/channel-context

**Tag**: `+channel-context` (client-only tag)

**Effort**: Low (4-8 hours)

**Priority**: Low - Nice-to-have for client UX

---

## Why This Matters

Channel-context allows clients to indicate which channel a private message relates to:
- Users can right-click a nick in a channel and "message about this channel"
- Receiving client can display the context or group messages
- Useful for moderation discussions, support queries
- Better UX for multi-channel users

---

## Specification Summary

### Tag Format

```
+channel-context=<channel>
```

Client-only tags (prefixed with `+`) are sent by clients and relayed by servers to recipients that support `message-tags`.

### Use Cases

1. **Private message about a channel**:
   ```
   @+channel-context=#help PRIVMSG Support :Can you help with the spam in #help?
   ```

2. **TAGMSG with channel context**:
   ```
   @+typing;+channel-context=#help TAGMSG Support
   ```

### Requirements

1. Server MUST relay client-only tags on PRIVMSG, NOTICE, TAGMSG
2. Recipients MUST have `message-tags` capability
3. Tag value MUST be a valid channel name

---

## Current Implementation

### What Works

| Message Type | Client Tags Relayed |
|--------------|---------------------|
| TAGMSG | ✅ Yes - `cli_client_tags()` passed to recipients |
| PRIVMSG | ❌ No - client tags not relayed |
| NOTICE | ❌ No - client tags not relayed |

### Code Analysis

**parse.c** - Correctly extracts client-only tags:
```c
/* Check for client-only tags (prefixed with +) */
else if (*tag_name == '+') {
  /* Copy client-only tag to buffer for TAGMSG relay */
  if (client_tags_pos + tag_len + 2 < sizeof(cli_client_tags(cptr))) {
    ...
    memcpy(cli_client_tags(cptr) + client_tags_pos, tag_name, tag_len);
    ...
  }
}
```

**m_tagmsg.c** - Uses client tags:
```c
client_tags = cli_client_tags(sptr);
sendcmdto_channel_client_tags(sptr, MSG_TAGMSG, chptr, sptr,
                              SKIP_DEAF | SKIP_BURST, client_tags, "%H", chptr);
```

**ircd_relay.c** - Does NOT use client tags for PRIVMSG/NOTICE.

---

## Implementation Requirements

### Changes Needed

| File | Change |
|------|--------|
| `ircd/ircd_relay.c` | Add `cli_client_tags()` to relay functions |
| `ircd/send.c` | Already has `sendcmdto_one_client_tags()` |

### Modified Functions

1. `relay_channel_message()` - Add client tags parameter
2. `relay_channel_notice()` - Add client tags parameter
3. `relay_directed_message()` - Add client tags parameter
4. `relay_directed_notice()` - Add client tags parameter

### Example Change

```c
void relay_channel_message(struct Client* sptr, const char* name,
                           const char* text, int count)
{
  const char *client_tags = cli_client_tags(sptr);

  // ... existing code ...

  /* Use sendcmdto_channel_client_tags instead of sendcmdto_channel_butone */
  if (client_tags && *client_tags) {
    sendcmdto_channel_client_tags(sptr, CMD_PRIVMSG, chptr, sptr,
                                  SKIP_DEAF | SKIP_BURST, client_tags,
                                  "%H :%s", chptr, text);
  } else {
    sendcmdto_channel_butone(sptr, CMD_PRIVMSG, chptr, sptr,
                             SKIP_DEAF | SKIP_BURST,
                             "%H :%s", chptr, text);
  }
}
```

---

## Effort Breakdown

| Component | Effort |
|-----------|--------|
| Modify relay functions | 2-3 hours |
| Add PM relay support | 1-2 hours |
| Testing | 1-2 hours |
| **Total** | **4-8 hours** |

---

## Priority Assessment

**Low Priority**:

1. **Limited client support**: Few clients use channel-context
2. **TAGMSG works**: Primary use case (typing indicators) already works
3. **Nice-to-have**: Improves UX but not critical functionality

Consider implementing when doing other PRIVMSG/NOTICE work.

---

## Testing

1. Send PRIVMSG with `+channel-context`:
   ```
   @+channel-context=#test PRIVMSG user :Message about #test
   ```

2. Verify recipient with `message-tags` capability receives tag

3. Verify recipient without capability doesn't see raw tag

---

## Client Support

| Software | Support |
|----------|---------|
| The Lounge | Client |
| Gamja | Client |
| Kiwi IRC | Client |
| **Nefarious** | **PARTIAL** (TAGMSG only) |

---

## Related Specs

- **message-tags**: Required for client-only tag relay
- **typing**: Uses `+typing` client tag (same mechanism)
- **reply**: Uses `+reply` client tag (same mechanism)

---

## References

- **Spec**: https://ircv3.net/specs/client-tags/channel-context
- **Message Tags**: https://ircv3.net/specs/extensions/message-tags
