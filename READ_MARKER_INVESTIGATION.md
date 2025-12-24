# IRCv3 Read Marker Extension Investigation

## Status: DEFERRED (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/read-marker

**Capability**: `draft/read-marker`

**Decision**: Defer implementation until specification stabilizes

---

## Specification Summary

The read-marker extension enables multiple clients of the same user to synchronize which messages have been read in each buffer (channel or query). This is primarily useful for:
- Bouncers serving multiple clients
- Servers with chathistory support
- Clearing notifications across devices

---

## MARKREAD Command Format

**Client → Server (Set):**
```
MARKREAD <target> timestamp=YYYY-MM-DDThh:mm:ss.sssZ
```
Signals that user has read messages up to the specified timestamp.

**Client → Server (Get):**
```
MARKREAD <target>
```
Requests the server's stored read timestamp for a target.

**Server → Client:**
```
MARKREAD <target> timestamp=YYYY-MM-DDThh:mm:ss.sssZ
```
Notifies client of the last read timestamp. Timestamp can be `*` if unknown.

---

## Server Behavior Requirements

1. **On JOIN**: After sending JOIN to client, MUST send MARKREAD for that channel BEFORE RPL_ENDOFNAMES (366)
2. **On MARKREAD from client**:
   - Validate timestamp format
   - Only accept if timestamp > stored timestamp (timestamps only increase)
   - Broadcast updated timestamp to ALL of user's connected clients
   - If client sends older timestamp, respond with current stored value
3. **Privacy**: MUST NOT disclose read markers to other users without explicit opt-in
4. **Persistence**: Should persist across reconnects (requires storage)

---

## Error Handling (using standard-replies)

| Error Code | Condition | Response |
|------------|-----------|----------|
| `NEED_MORE_PARAMS` | Missing target | `FAIL MARKREAD NEED_MORE_PARAMS :Missing target` |
| `INVALID_PARAMS` | Invalid target | `FAIL MARKREAD INVALID_PARAMS <target> :Invalid target` |
| `INVALID_PARAMS` | Bad timestamp format | `FAIL MARKREAD INVALID_PARAMS <target> :Invalid timestamp` |
| `INTERNAL_ERROR` | Storage failure | `FAIL MARKREAD INTERNAL_ERROR <target> :Could not save` |

---

## Implementation Architecture Options

### Option A: In-Memory Only (Simplest)
- Store read markers in user's Client struct
- Lost on disconnect/restart
- Suitable for single-server, non-bouncer use

### Option B: X3 Services Integration (Recommended)
- Store read markers in X3's database (or linked SQL)
- Persist across reconnects
- Requires new P10 command for sync

### Option C: File-based Persistence
- Write to disk periodically
- Moderate complexity
- No X3 changes needed

---

## Why Defer?

1. **Spec is draft**: May change before ratification
2. **Limited client support**: Only Halloy, gamja, Goguma, soju, Ergo currently support it
3. **Requires chathistory**: Most useful in combination with chathistory
4. **Storage complexity**: Proper implementation needs persistence

---

## Relationship to Chathistory

Read-marker and chathistory are complementary:
- **chathistory**: Retrieve missed messages
- **read-marker**: Track which messages have been seen

Implementing chathistory first makes read-marker more useful.

---

## Files That Would Be Modified

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_READMARKER` |
| `include/ircd_features.h` | Add `FEAT_CAP_read_marker` |
| `ircd/ircd_features.c` | Register feature (default: FALSE) |
| `ircd/m_cap.c` | Add `draft/read-marker` to capability list |
| `include/msg.h` | Add `MSG_MARKREAD`, `TOK_MARKREAD` |
| `include/handlers.h` | Add `m_markread` declaration |
| `ircd/m_markread.c` | New file: MARKREAD command handler |
| `ircd/parse.c` | Register MARKREAD command |
| `ircd/m_join.c` | Send MARKREAD after JOIN, before 366 |

---

## P10 Protocol (If X3 Integration)

**New Token**: `MR` (MARKREAD)

**Format**:
```
[USER_NUMERIC] MR <target> <timestamp>
```

---

## References

- **Spec**: https://ircv3.net/specs/extensions/read-marker
- **Related**: chathistory extension
- **Supporting servers**: Ergo, soju
- **Supporting clients**: Halloy, gamja, Goguma
