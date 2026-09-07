# Message Redaction

Implementation of `draft/message-redaction` IRCv3 extension in Nefarious IRCd.

## Overview

Message redaction allows users to delete their own messages or channel operators to delete messages in channels they moderate. Clients that already received the message get a `REDACT` notification. In chathistory the redacted message is kept as a placeholder followed by a `REDACT` context row (the spec's second option for history; since `d04840b`, 2026-04-12), so replays show that a message existed and was redacted without showing its content.

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

- The redacted message stays in the store as a placeholder; a `REDACT` context row referencing
  its msgid is stored next to it (reply index parent → child), and replays splice that row in
  after the message. Context rows do not count towards the requested limit.
- Clients receive a `REDACT` notification for messages already delivered.
- A repeat `REDACT` of an already-redacted msgid is an idempotent success: the requester gets
  the `REDACT` echo (with `echo-message`), nothing is stored again, and nothing is repeated to
  the channel or the network. The spec defines `UNKNOWN_MSGID` as "does not exist or is too
  old" and is silent on repeats; the placeholder still exists, so a FAIL would be wrong.
- A repeat arriving over the network (two servers or two users redacting the same message) is
  shown to local members and relayed, but stores no second context row.

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
