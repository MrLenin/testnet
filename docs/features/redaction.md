# Message Redaction

Implementation of `draft/message-redaction` IRCv3 extension in Nefarious IRCd.

## Overview

Message redaction allows users to delete their own messages or channel operators to delete messages in channels they moderate. Redacted messages are removed from chathistory and marked as redacted for clients that have already received them.

## Client Commands

```
REDACT <target> <msgid> [:<reason>]
```

- `target`: Channel or nick the original message was sent to
- `msgid`: The `msgid` tag from the original message
- `reason`: Optional reason for redaction (displayed to users)

## P10 Protocol

**Token**: `RD` (REDACT)

**Format**:
```
[NUMERIC] RD <target> <msgid> :<reason>
```

**Example**:
```
ABAAB RD #channel AB123-456 :Removing spam
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_message_redaction` | TRUE | Enable `draft/message-redaction` capability |

## Redaction Rules

1. **Own messages**: Users can always redact their own messages
2. **Channel messages**: Channel operators (+o or higher) can redact any message in their channel
3. **Oper override**: IRC operators with sufficient privileges can redact any message
4. **Time window**: Redaction may be limited to recent messages (implementation-dependent)

## Chathistory Interaction

- Redacted messages are removed from LMDB chathistory storage
- Clients receive `REDACT` notification for messages already delivered
- History queries after redaction won't include the removed message

## Client Capability

Clients must negotiate `draft/message-redaction` to receive redaction notifications:

```
CAP REQ :draft/message-redaction
```

Clients without this capability won't see redaction events.

## Example Flow

1. User sends message:
   ```
   :nick!user@host PRIVMSG #channel :Hello @msgid=AB123-456
   ```

2. User redacts:
   ```
   REDACT #channel AB123-456 :Typo
   ```

3. Server broadcasts:
   ```
   :nick!user@host REDACT #channel AB123-456 :Typo
   ```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*
