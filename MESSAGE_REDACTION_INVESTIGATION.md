# IRCv3 Message Redaction Extension Investigation

## Status: INVESTIGATING (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/message-redaction

**Capability**: `draft/message-redaction`

---

## Specification Summary

The message-redaction extension allows users to delete previously sent messages. This enables:
- Correcting mistakes quickly
- Removing sensitive information accidentally shared
- Moderation of channel content
- Compliance with data protection regulations (GDPR right to erasure)

---

## REDACT Command

**Syntax**: `REDACT <target> <msgid> [:<reason>]`

| Parameter | Description |
|-----------|-------------|
| `<target>` | Channel or nick where message was sent |
| `<msgid>` | Message ID of the message to redact |
| `<reason>` | Optional reason for redaction |

**Example**:
```
REDACT #channel AB-1703334400-12345 :Contained sensitive information
REDACT nickname XY-1703334500-67890
```

---

## Server Behavior

When a client is authorized to redact a message:

1. Forward `REDACT` command to recipients who have the capability
2. Do NOT forward to clients without the capability
3. Optionally store redaction for chathistory

**Format to clients**:
```
:nick!user@host REDACT <target> <msgid> :<reason>
```

---

## Error Responses

| Error Code | Condition |
|------------|-----------|
| `FAIL REDACT INVALID_TARGET <target>` | Cannot redact from this target |
| `FAIL REDACT REDACT_FORBIDDEN <msgid>` | User lacks authorization |
| `FAIL REDACT REDACT_WINDOW_EXPIRED <msgid>` | Deletion window has closed |
| `FAIL REDACT UNKNOWN_MSGID <msgid>` | Message doesn't exist or too old |

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `message-tags` | Complete |
| `msgid` generation | Complete (Phase 16) |
| `echo-message` | Complete (recommended) |
| `standard-replies` | Complete |

---

## Authorization Model

Who can redact what?

| Actor | Own Messages | Others' Messages |
|-------|--------------|------------------|
| Regular user | Yes (time-limited) | No |
| Channel operator | Yes | Yes (in their channel) |
| IRC operator | Yes | Yes (network-wide) |

### Time Window

Servers may impose a time limit on self-redaction:
- Example: Can only redact messages < 5 minutes old
- Operators may have longer/unlimited windows

---

## Implementation Architecture

### Option A: Nefarious-Only (No Persistence)

```
Client -> Nefarious -> Recipients
                   |
            (msgid tracking in memory)
```

**Pros**: Simple, no external dependencies
**Cons**: No chathistory integration, limited msgid validation

### Option B: With Chathistory Integration

```
Client -> Nefarious -> SQLite (chathistory DB)
                   |
               Recipients
```

**Pros**: Full msgid validation, chathistory redaction
**Cons**: Requires chathistory implementation first

---

## P10 Protocol Design

### New Token: `RD` (REDACT)

**Format**:
```
[USER_NUMERIC] RD <target> <msgid> :<reason>
```

**Example**:
```
ABAAB RD #channel AB-1703334400-12345 :Oops
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_REDACT` |
| `include/ircd_features.h` | Add `FEAT_CAP_message_redaction`, `FEAT_REDACT_WINDOW` |
| `ircd/ircd_features.c` | Register features |
| `ircd/m_cap.c` | Add `draft/message-redaction` to capability list |
| `include/msg.h` | Add `MSG_REDACT`, `TOK_REDACT` ("RD") |
| `include/handlers.h` | Add `m_redact`, `ms_redact` declarations |
| `ircd/m_redact.c` | New file: REDACT command handler |
| `ircd/parse.c` | Register REDACT command |
| `ircd/Makefile.in` | Add m_redact.c |

---

## Message ID Validation

To validate a msgid, server needs to:

1. **Parse msgid format**: `<server>-<timestamp>-<counter>`
2. **Verify originating server** (optional)
3. **Check timestamp** within allowed window
4. **Verify sender** (if tracking)

### Without Chathistory

Limited validation:
- Parse timestamp from msgid
- Check if within redaction window
- Trust client's claim of authorship

### With Chathistory

Full validation:
- Query database for msgid
- Verify sender matches
- Check channel/target matches
- Update/delete record

---

## Chathistory Integration

When chathistory is implemented:

```sql
-- Option A: Delete message
DELETE FROM messages WHERE msgid = ?;

-- Option B: Mark as redacted
UPDATE messages
SET redacted = TRUE,
    redacted_by = ?,
    redacted_at = ?,
    content = '[redacted]'
WHERE msgid = ?;
```

### Chathistory Response After Redaction

Option A: Omit message entirely
Option B: Include REDACT message after original:
```
@time=... :nick!u@h PRIVMSG #channel :original message
@time=... :nick!u@h REDACT #channel msgid :reason
```

---

## Implementation Phases

### Phase 1: Basic Redaction (No Validation)

1. Add capability and feature flag
2. Implement REDACT command
3. Forward to recipients with capability
4. No msgid validation (trust client)

**Effort**: Low (8-12 hours)

### Phase 2: Time Window Enforcement

1. Parse timestamp from msgid
2. Check against configurable window
3. Return `REDACT_WINDOW_EXPIRED` if too old

**Effort**: Low (4-8 hours)

### Phase 3: Network Propagation

1. Add P10 RD token
2. Implement `ms_redact()` for S2S
3. Propagate across network

**Effort**: Medium (8-12 hours)

### Phase 4: Chathistory Integration

1. Query database to validate msgid
2. Verify sender authorization
3. Update/delete database record
4. Include in chathistory responses

**Effort**: Medium (12-16 hours, requires chathistory)

---

## Configuration Options

```
features {
    "CAP_message_redaction" = "TRUE";
    "REDACT_WINDOW" = "300";        // seconds (0 = unlimited)
    "REDACT_OPER_WINDOW" = "0";     // seconds for opers (0 = unlimited)
    "REDACT_CHANOP_OTHERS" = "TRUE"; // chanops can redact others
};
```

---

## Security Considerations

1. **No operational security**: Once sent, assume message was seen
2. **Federation concerns**: Other servers may not honor redaction
3. **Client logging**: Clients may have logged the original
4. **Rate limiting**: Prevent redaction spam
5. **Audit logging**: Log all redactions for abuse prevention

---

## Edge Cases

1. **Cross-server redaction**: Message sent on Server A, redacted from Server B
2. **Netsplit**: Redaction during split may not propagate
3. **Services messages**: Can users redact services messages?
4. **DMs**: Redacting private messages

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| Basic REDACT | Low | Low |
| Time window | Low | Low |
| P10 propagation | Medium | Medium |
| Msgid validation | Medium | Medium |
| Chathistory integration | High | High |

**Total**: Medium effort (32-48 hours without chathistory)

---

## Recommendation

1. **Implement Phase 1-3**: Basic redaction with network propagation
2. **Skip chathistory integration initially**: Implement after chathistory
3. **Conservative defaults**: Short redaction window (5 min)
4. **Feature flag disabled by default**: Draft spec may change

---

## Relationship to Chathistory

Message redaction and chathistory are complementary:
- **Without chathistory**: Redaction only affects connected clients
- **With chathistory**: Redaction affects historical queries too

Implementing chathistory first makes redaction more meaningful.

---

## Client Support

| Client | Support |
|--------|---------|
| IRCCloud | Yes |
| gamja | Yes |
| Goguma | Yes |
| Halloy | Yes |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/message-redaction
- **Message IDs**: https://ircv3.net/specs/extensions/message-ids
- **Related**: Chathistory extension
