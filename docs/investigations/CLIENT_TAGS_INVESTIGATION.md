# IRCv3 Client-Only Tags Investigation

## Status: IMPLEMENTED (via existing message-tags infrastructure)

This document covers the draft client-only message tags:
- `+draft/reply` - Message threading
- `+draft/react` - Message reactions
- `+draft/channel-context` - Private message context

---

## Client-Only Tag Prefix

Client-only tags use the `+` prefix and are forwarded between clients without server processing:

```
@+tagname=value PRIVMSG #channel :Hello
```

Servers MUST forward these tags without modification (if message-tags supported).

---

# +draft/reply (Message Threading)

## Specification

**Spec**: https://ircv3.net/specs/client-tags/reply

**Tag**: `+draft/reply=<msgid>`

---

## Purpose

Enables clients to indicate a message is a reply to a previous message, creating threaded conversations.

---

## Format

```
@+draft/reply=<msgid> PRIVMSG <target> :<message>
```

Where `<msgid>` is the ID of the message being replied to.

**Example**:
```
@+draft/reply=AB-1703334400-12345 PRIVMSG #channel :I agree with you!
```

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `message-tags` | Complete |
| `msgid` | Complete |
| `echo-message` | Complete (recommended) |

---

## Server Requirements

Server only needs to:
1. Forward `+draft/reply` tag with messages
2. No validation of msgid required
3. No storage or processing required

**Already implemented** via existing client-only tag infrastructure.

---

## Client Behavior

**Sending**:
1. Get msgid of message to reply to
2. Include `+draft/reply=<msgid>` on PRIVMSG
3. Optionally quote part of original message in content

**Receiving**:
1. Parse `+draft/reply` tag
2. Display message with visual reply indicator
3. Optionally show link to original message

---

## Implementation Status

**Already implemented** via Phase 13b (TAGMSG with client-only tags).

No additional server changes needed.

---

# +draft/react (Message Reactions)

## Specification

**Spec**: https://ircv3.net/specs/client-tags/react

**Tag**: `+draft/react=<reaction>`

---

## Purpose

Enables lightweight reactions to messages (emoji, text) without full replies.

---

## Format

```
@+draft/reply=<msgid>;+draft/react=<reaction> TAGMSG <target>
```

Note: `+draft/react` MUST be used with `+draft/reply` to indicate which message is being reacted to.

**Example**:
```
@+draft/reply=AB-1703334400-12345;+draft/react=:thumbsup: TAGMSG #channel
```

---

## Reaction Values

The spec does not restrict reaction values:
- Unicode emoji: `+draft/react=👍`
- Emoji codes: `+draft/react=:thumbsup:`
- Text: `+draft/react=+1`
- Custom: `+draft/react=lgtm`

Clients may impose their own restrictions.

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `message-tags` | Complete |
| `+draft/reply` | Complete (via TAGMSG) |
| TAGMSG | Complete |

---

## Server Requirements

Server only needs to:
1. Forward `+draft/react` tag with TAGMSG
2. No validation of reaction content
3. No aggregation or deduplication

**Already implemented** via existing TAGMSG infrastructure.

---

## Client Behavior

**Sending**:
1. Get msgid of message to react to
2. Send TAGMSG with both tags:
   - `+draft/reply=<msgid>`
   - `+draft/react=<reaction>`

**Receiving**:
1. Parse both tags
2. Display reaction attached to original message
3. Aggregate identical reactions from multiple users

---

## Implementation Status

**Already implemented** via Phase 17 (TAGMSG) and Phase 13b (client-only tags).

No additional server changes needed.

---

# +draft/channel-context (Private Message Context)

## Specification

**Spec**: https://ircv3.net/specs/client-tags/channel-context

**Tag**: `+draft/channel-context=<channel>`

---

## Purpose

Allows bots/services to indicate that a private message relates to a specific channel context.

---

## Use Case

Common pattern: User runs command in channel, bot responds in private:

```
[#channel] user: !help
[private] bot: Here is the help for #channel...
```

With channel-context, the private message can be displayed in the channel context:

```
@+draft/channel-context=#channel PRIVMSG user :Here is the help for #channel...
```

---

## Format

```
@+draft/channel-context=<channel> PRIVMSG <nick> :<message>
```

**Note**: Only valid on private messages (PRIVMSG/NOTICE to users), NOT channel messages.

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `message-tags` | Complete |

---

## Server Requirements

Server only needs to:
1. Forward `+draft/channel-context` tag
2. No validation of channel name
3. No verification of sender's channel membership

**Already implemented** via existing client-only tag infrastructure.

---

## Client Behavior

**Sending** (typically bots):
1. When responding to channel-originated request via PM
2. Include `+draft/channel-context=<channel>` on the PRIVMSG

**Receiving**:
1. Parse `+draft/channel-context` tag
2. Option A: Display PM in channel's message buffer
3. Option B: Display PM in private buffer with channel indicator
4. Security: Optionally hide if sender not in specified channel

---

## Implementation Status

**Already implemented** via existing message-tags and client-only tag forwarding.

No additional server changes needed.

---

# Combined Summary

## Implementation Status

All three client-only tags are **already supported** by Nefarious through the existing infrastructure:

| Tag | Mechanism | Status |
|-----|-----------|--------|
| `+draft/reply` | Client-only tag on PRIVMSG | Complete |
| `+draft/react` | Client-only tag on TAGMSG | Complete |
| `+draft/channel-context` | Client-only tag on PRIVMSG | Complete |

---

## No Server Changes Needed

The client-only tag infrastructure from Phase 13b handles all these tags:

1. Parse `+tag=value` from incoming messages
2. Store in client tag buffer
3. Forward to recipients
4. Include in S2S relay (TM token for TAGMSG)

---

## Files Already Implemented

| File | Function |
|------|----------|
| `ircd/parse.c` | `extract_client_tags()` - Parses +tags |
| `ircd/send.c` | `sendcmdto_*_client_tags()` - Forwards +tags |
| `ircd/m_tagmsg.c` | TAGMSG handler with client tags |
| `include/client.h` | `con_client_tags[]` storage |

---

## Testing

### Test +draft/reply

```
C1: @+draft/reply=AB-123-1 PRIVMSG #channel :I agree!
C2: (receives) @+draft/reply=AB-123-1 :nick!u@h PRIVMSG #channel :I agree!
```

### Test +draft/react

```
C1: @+draft/reply=AB-123-1;+draft/react=👍 TAGMSG #channel
C2: (receives) @+draft/reply=AB-123-1;+draft/react=👍 :nick!u@h TAGMSG #channel
```

### Test +draft/channel-context

```
Bot: @+draft/channel-context=#help PRIVMSG user :Here is help
User: (receives) @+draft/channel-context=#help :bot!u@h PRIVMSG user :Here is help
```

---

## Client Support

| Client | +reply | +react | +channel-context |
|--------|--------|--------|------------------|
| IRCCloud | Yes | Yes | Yes |
| gamja | Yes | Yes | - |
| Goguma | Yes | Yes | - |
| Halloy | Yes | Yes | - |
| The Lounge | Yes | - | - |
| Palaver | - | Yes | - |

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| +draft/reply | None (done) | None |
| +draft/react | None (done) | None |
| +draft/channel-context | None (done) | None |

**Total**: Zero additional effort - already implemented.

---

## Recommendation

1. **No action needed**: All tags work via existing infrastructure
2. **Document support**: Add to IRCv3 capability list
3. **Test with clients**: Verify with IRCCloud, gamja

---

## References

- **+reply**: https://ircv3.net/specs/client-tags/reply
- **+react**: https://ircv3.net/specs/client-tags/react
- **+channel-context**: https://ircv3.net/specs/client-tags/channel-context
- **Message Tags**: https://ircv3.net/specs/extensions/message-tags
