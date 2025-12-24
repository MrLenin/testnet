# IRCv3 Read Marker Extension Investigation

## Status: IMPLEMENTED (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/read-marker

**Capability**: `draft/read-marker`

**Feature Flag**: `FEAT_CAP_draft_read_marker` (disabled by default - draft spec)

---

## Implementation Status

Full implementation in Nefarious using the existing LMDB infrastructure from chathistory:

### Files Modified

| File | Changes |
|------|---------|
| `include/capab.h` | Added `CAP_DRAFT_READMARKER` capability |
| `include/ircd_features.h` | Added `FEAT_CAP_draft_read_marker` |
| `ircd/ircd_features.c` | Feature registration (default: FALSE) |
| `ircd/m_cap.c` | `draft/read-marker` capability |
| `include/msg.h` | `MSG_MARKREAD`, `TOK_MARKREAD` ("MR") |
| `include/handlers.h` | `m_markread`, `send_markread_on_join` declarations |
| `ircd/m_markread.c` | New file: MARKREAD command handler |
| `ircd/parse.c` | Command registration |
| `ircd/Makefile.in` | Added m_markread.c |
| `ircd/m_join.c` | Calls `send_markread_on_join()` before NAMES |
| `include/history.h` | Added `readmarker_get()`, `readmarker_set()` API |
| `ircd/history.c` | LMDB readmarkers database, get/set implementations |

### Features Implemented

- MARKREAD command for get/set operations
- Persistence via LMDB (same database as chathistory)
- Per-account + per-target storage
- Automatic MARKREAD on JOIN (before RPL_ENDOFNAMES)
- Multi-client broadcast (updates all connections with same account)
- Timestamps only increase (older timestamps rejected)
- standard-replies error handling

### Configuration

To enable read-marker (disabled by default):
```
features {
    "CAP_draft_read_marker" = "TRUE";  /* Enable capability */
};
```

Note: Requires LMDB/chathistory to be enabled for persistence.

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

1. **On JOIN**: After sending JOIN to client, MUST send MARKREAD for that channel BEFORE RPL_ENDOFNAMES (366) ✅
2. **On MARKREAD from client**:
   - Validate timestamp format ✅
   - Only accept if timestamp > stored timestamp (timestamps only increase) ✅
   - Broadcast updated timestamp to ALL of user's connected clients ✅
   - If client sends older timestamp, respond with current stored value ✅
3. **Privacy**: MUST NOT disclose read markers to other users without explicit opt-in ✅
4. **Persistence**: Should persist across reconnects (requires storage) ✅

---

## Storage Architecture

Read markers are stored in the existing LMDB environment alongside chathistory:

**Database**: `readmarkers` (5th database in LMDB env)

**Key**: `account\0target` (e.g., `myaccount\0#channel`)

**Value**: ISO 8601 timestamp (e.g., `2025-01-01T00:00:00.000Z`)

This reuses the chathistory infrastructure with minimal additional code.

---

## Error Handling (using standard-replies)

| Error Code | Condition | Response |
|------------|-----------|----------|
| `ACCOUNT_REQUIRED` | Not logged in | `FAIL MARKREAD ACCOUNT_REQUIRED :You must be logged in` |
| `NEED_MORE_PARAMS` | Missing target | `FAIL MARKREAD NEED_MORE_PARAMS :Missing target` |
| `TEMPORARILY_UNAVAILABLE` | Storage unavailable | `FAIL MARKREAD TEMPORARILY_UNAVAILABLE <target> :Storage not available` |
| `INTERNAL_ERROR` | Storage failure | `FAIL MARKREAD INTERNAL_ERROR <target> :Could not save` |

---

## Example Flow

```
C: CAP LS 302
S: CAP * LS :... draft/read-marker ...
C: CAP REQ :draft/read-marker
S: CAP * ACK :draft/read-marker
C: AUTHENTICATE PLAIN
S: 900 ... (authenticated as myaccount)
C: JOIN #channel
S: :nick!user@host JOIN #channel
S: MARKREAD #channel timestamp=2025-01-01T12:00:00.000Z
S: 353 nick = #channel :@nick
S: 366 nick #channel :End of /NAMES list.

C: MARKREAD #channel timestamp=2025-01-01T15:00:00.000Z
S: MARKREAD #channel timestamp=2025-01-01T15:00:00.000Z  (broadcast to all user's clients)

C: MARKREAD #channel
S: MARKREAD #channel timestamp=2025-01-01T15:00:00.000Z
```

---

## Dependencies

| Dependency | Status |
|------------|--------|
| `standard-replies` | Complete |
| SASL/account system | Complete |
| LMDB (history.c) | Complete |
| chathistory | Complete |

---

## Client Support

| Software | Type | Support |
|----------|------|---------|
| Ergo | Server | Yes |
| soju | Bouncer | Yes |
| Halloy | Client | Yes |
| gamja | Client | Yes |
| Goguma | Client | Yes |
| **Nefarious** | **Server** | **Yes (NEW)** |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/read-marker
- **Related**: chathistory extension
- **Supporting servers**: Ergo, soju, Nefarious
- **Supporting clients**: Halloy, gamja, Goguma
