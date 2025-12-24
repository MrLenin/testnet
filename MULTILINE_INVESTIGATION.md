# IRCv3 Multiline Messages Extension Investigation

## Status: IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/multiline

**Capability**: `draft/multiline`

**Priority**: HIGH - User retention issue; users expect this from modern chat platforms

---

## Why High Priority?

The lack of multiline support is frequently cited as a reason users leave IRC for Discord/Slack/Matrix:

- **Code pasting**: Developers can't paste code snippets without flood protection kicking in
- **User expectations**: Modern chat platforms all support multi-line messages
- **Workflow disruption**: Having to use pastebins for simple multi-line content is friction

This is a key UX gap between IRC and modern chat platforms.

---

## Specification Summary

The multiline extension allows clients to send messages that span multiple lines without splitting them into separate PRIVMSG commands. This enables:
- Pasting code blocks without flood triggers
- Multi-paragraph messages as single units
- Preserving formatting from other applications
- Better chat experience matching Discord/Slack/Matrix

---

## Implementation Summary

### Files Modified

| File | Changes |
|------|---------|
| `include/capab.h` | Added `CAP_DRAFT_MULTILINE` enum value |
| `include/ircd_features.h` | Added `FEAT_CAP_draft_multiline`, `FEAT_MULTILINE_MAX_BYTES`, `FEAT_MULTILINE_MAX_LINES` |
| `ircd/ircd_features.c` | Registered features with defaults (TRUE, 4096, 24) |
| `ircd/m_cap.c` | Added `draft/multiline` capability with dynamic value generation |
| `include/client.h` | Added multiline batch state fields to Connection struct |
| `include/handlers.h` | Added `m_batch` declaration |
| `ircd/parse.c` | Added parsing for `@batch=` and `draft/multiline-concat` tags |
| `ircd/m_batch.c` | Added client BATCH handler with multiline batch processing |
| `ircd/m_privmsg.c` | Added batch interception for multiline messages |

### Capability Advertisement

```
CAP LS :draft/multiline=max-bytes=4096,max-lines=24
```

### Connection State

New fields in `struct Connection`:
- `con_ml_batch_id[16]` - Active multiline batch ID
- `con_ml_target[256]` - Batch target (channel or nick)
- `con_ml_messages` - Linked list of batched messages
- `con_ml_msg_count` - Number of messages collected
- `con_ml_total_bytes` - Total bytes in batch
- `con_msg_batch_tag[16]` - Current message's @batch tag
- `con_msg_concat` - Current message's concat flag

### Message Flow

```
1. Client sends BATCH +id draft/multiline #channel
2. Server stores batch ID and target in connection state
3. Client sends @batch=id PRIVMSG #channel :message
4. parse.c extracts @batch tag and concat flag
5. m_privmsg.c intercepts if batch ID matches, calls multiline_add_message()
6. Client sends BATCH -id
7. m_batch.c calls process_multiline_batch() to deliver
```

### Delivery Logic

- **Supporting clients**: Receive message wrapped in batch
- **Non-supporting clients**: Receive individual PRIVMSG commands
- **Echo-message**: Sender receives echo if echo-message enabled

---

## Configuration

```
features {
    "CAP_draft_multiline" = "TRUE";  /* enabled by default */
    "MULTILINE_MAX_BYTES" = "4096";  /* max total bytes */
    "MULTILINE_MAX_LINES" = "24";    /* max lines per batch */
};
```

---

## Example Flow

```
C: CAP LS 302
S: CAP * LS :... draft/multiline=max-bytes=4096,max-lines=24 ...
C: CAP REQ :draft/multiline batch
S: CAP * ACK :draft/multiline batch
C: NICK user
C: USER user 0 * :User Name
S: 001 ...

C: BATCH +abc123 draft/multiline #channel
C: @batch=abc123 PRIVMSG #channel :Line 1
C: @batch=abc123 PRIVMSG #channel :Line 2
C: @batch=abc123;draft/multiline-concat PRIVMSG #channel : continued
C: BATCH -abc123
```

Output for supporting clients:
```
S: BATCH +serverid draft/multiline #channel
S: @batch=serverid :user!ident@host PRIVMSG #channel :Line 1
S: @batch=serverid :user!ident@host PRIVMSG #channel :Line 2
S: @batch=serverid;draft/multiline-concat :user!ident@host PRIVMSG #channel : continued
S: BATCH -serverid
```

Output for non-supporting clients:
```
S: :user!ident@host PRIVMSG #channel :Line 1
S: :user!ident@host PRIVMSG #channel :Line 2
S: :user!ident@host PRIVMSG #channel : continued
```

---

## Error Handling

Uses IRCv3 standard-replies (FAIL):

| Error Code | Condition |
|------------|-----------|
| `MULTILINE_MAX_BYTES` | Total bytes exceeded limit |
| `MULTILINE_MAX_LINES` | Line count exceeded limit |
| `INVALID_FORMAT` | Invalid batch format |
| `UNSUPPORTED_TYPE` | Unknown batch type |
| `NO_ACTIVE_BATCH` | Tried to end non-existent batch |
| `BATCH_ID_MISMATCH` | Batch ID doesn't match active batch |

---

## Dependencies

| Dependency | Status |
|------------|--------|
| `batch` | Complete |
| `message-tags` | Complete |
| `standard-replies` | Complete |
| `echo-message` | Complete |
| `labeled-response` | Complete |

All dependencies were already implemented.

---

## Limitations

- Max 24 lines and 4096 bytes by default

Note: Batch timeout is now implemented via `CLIENT_BATCH_TIMEOUT` (default 30 seconds).
S2S propagation is implemented - multiline batches are relayed between servers.

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| soju | Bouncer |
| Goguma | Client |
| gamja | Client |
| **Nefarious** | **Server (NEW)** |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/multiline
- **Batch**: https://ircv3.net/specs/extensions/batch
- **Message Tags**: https://ircv3.net/specs/extensions/message-tags
