# IRCv3 Multiline Messages Extension Investigation

## Status: HIGH PRIORITY (Draft Specification)

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

## Capability Value

Required parameters:
- `max-bytes=N` - Maximum total byte length of combined message
- `max-lines=N` - Maximum number of lines (recommended)

**Example**: `CAP LS :draft/multiline=max-bytes=4096,max-lines=24`

---

## Batch Format

Multiline messages use the batch mechanism:

```
C: BATCH +abc draft/multiline #channel
C: @batch=abc PRIVMSG #channel :First line
C: @batch=abc PRIVMSG #channel :Second line
C: @batch=abc PRIVMSG #channel :Third line
C: BATCH -abc
```

### Batch Type

**Type**: `draft/multiline`

**Parameter**: Target recipient (channel or nick)

---

## Message Concatenation

### Default Behavior

Lines are joined with `\n` (newline):

```
First line
Second line
Third line
```

### Concat Tag

Using `draft/multiline-concat` tag joins lines directly (no newline):

```
C: @batch=abc PRIVMSG #channel :Hello
C: @batch=abc;draft/multiline-concat PRIVMSG #channel :World
```

Result: `Hello World` (single line)

---

## Server Behavior

### For Supporting Clients

Forward batch as-is with appropriate tags.

### For Non-Supporting Clients

Deliver individual PRIVMSG/NOTICE messages:
- Remove batch tags
- Add `@msgid` and `@label` to first message
- Send messages in order

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `batch` | Complete |
| `message-tags` | Complete |
| `standard-replies` | Complete |
| `echo-message` | Complete |
| `labeled-response` | Complete |

All dependencies are already implemented.

---

## Error Responses

| Error Code | Condition |
|------------|-----------|
| `MULTILINE_MAX_BYTES <limit>` | Total bytes exceeded |
| `MULTILINE_MAX_LINES <limit>` | Line count exceeded |
| `MULTILINE_INVALID_TARGET <batch> <msg>` | Mismatched targets |
| `MULTILINE_INVALID` | Malformed batch |

---

## Implementation Architecture

### Batch Collection

Server must collect all messages in a batch before processing:

```c
struct MultilineBatch {
    char batchid[16];
    char target[CHANNELLEN + 1];
    struct Client *sender;
    struct MultilineMessage *messages;
    int message_count;
    int total_bytes;
    time_t started;
};

struct MultilineMessage {
    char *content;
    int concat;  /* Has draft/multiline-concat tag */
    struct MultilineMessage *next;
};
```

### Processing Flow

```
1. Client sends BATCH +id draft/multiline #channel
2. Server creates MultilineBatch struct
3. Client sends PRIVMSG messages with @batch=id
4. Server collects messages, validates limits
5. Client sends BATCH -id
6. Server processes batch:
   a. For supporting recipients: send as batch
   b. For non-supporting: send individual PRIVMSGs
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_MULTILINE` |
| `include/ircd_features.h` | Add multiline features |
| `ircd/ircd_features.c` | Register features |
| `ircd/m_cap.c` | Add `draft/multiline` with values |
| `ircd/m_batch.c` | Handle multiline batch type |
| `include/client.h` | Add multiline batch storage |
| `ircd/m_privmsg.c` | Handle batched messages |

---

## Batch Handler Changes

In `m_batch.c`:

```c
int handle_batch_start(struct Client *sptr, const char *batchid,
                       const char *type, const char *params)
{
    if (strcmp(type, "draft/multiline") == 0) {
        return start_multiline_batch(sptr, batchid, params);
    }
    /* ... other batch types ... */
}

int handle_batch_end(struct Client *sptr, const char *batchid)
{
    struct MultilineBatch *batch = find_batch(sptr, batchid);
    if (batch && batch->type == BATCH_MULTILINE) {
        return process_multiline_batch(sptr, batch);
    }
    /* ... */
}
```

---

## Processing Multiline Batch

```c
int process_multiline_batch(struct Client *sptr, struct MultilineBatch *batch)
{
    struct Channel *chptr = NULL;
    struct Client *target = NULL;

    /* Find target */
    if (IsChannelName(batch->target)) {
        chptr = FindChannel(batch->target);
        if (!chptr)
            return send_fail(sptr, "BATCH", "INVALID_TARGET", ...);
    } else {
        target = FindUser(batch->target);
        if (!target)
            return send_fail(sptr, "BATCH", "INVALID_TARGET", ...);
    }

    /* Send to supporting recipients as batch */
    /* Send to non-supporting as individual messages */

    return 0;
}
```

---

## Fallback Delivery

For clients without `draft/multiline`:

```c
void deliver_multiline_fallback(struct Client *to, struct MultilineBatch *batch)
{
    struct MultilineMessage *msg;
    int first = 1;

    for (msg = batch->messages; msg; msg = msg->next) {
        if (first) {
            /* Include @msgid and @label on first message */
            sendcmdto_one_tags(batch->sender, CMD_PRIVMSG, to,
                               "@msgid=...;@label=...",
                               "%s :%s", batch->target, msg->content);
            first = 0;
        } else {
            sendcmdto_one(batch->sender, CMD_PRIVMSG, to,
                          "%s :%s", batch->target, msg->content);
        }
    }
}
```

---

## Implementation Phases

### Phase 1: Batch Collection

1. Add capability with values
2. Implement multiline batch storage
3. Collect messages until batch end

**Effort**: Medium (12-16 hours)

### Phase 2: Batch Delivery

1. Forward batch to supporting clients
2. Fallback delivery to non-supporting clients
3. Handle echo-message

**Effort**: Medium (12-16 hours)

### Phase 3: Validation and Limits

1. Enforce max-bytes, max-lines
2. Target validation
3. Timeout handling for incomplete batches

**Effort**: Low (8-12 hours)

### Phase 4: Concat Tag Support

1. Parse `draft/multiline-concat` tag
2. Apply concatenation when joining

**Effort**: Low (4-8 hours)

---

## Configuration Options

```
features {
    "CAP_multiline" = "TRUE";
    "MULTILINE_MAX_BYTES" = "4096";
    "MULTILINE_MAX_LINES" = "24";
    "MULTILINE_TIMEOUT" = "30";  /* seconds */
};
```

---

## P10 Considerations

### Option A: Forward as Batch

Propagate multiline batch between servers:

```
ABAAB BT +abc draft/multiline #channel
@batch=abc ABAAB P #channel :Line 1
@batch=abc ABAAB P #channel :Line 2
ABAAB BT -abc
```

### Option B: Expand Before Relay

Convert to individual messages for S2S:
- Simpler implementation
- Loses multiline semantics cross-server

---

## Security Considerations

1. **DoS prevention**: Timeout incomplete batches
2. **Size limits**: Prevent memory exhaustion
3. **Rate limiting**: Limit multiline batch frequency
4. **Target validation**: Ensure target matches throughout

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| Batch collection | Medium | Medium |
| Batch delivery | Medium | Medium |
| Fallback delivery | Medium | Low |
| Limits and timeout | Low | Low |
| Concat tag | Low | Low |

**Total**: Medium effort (36-52 hours)

---

## Recommendation

1. **HIGH PRIORITY**: Key feature for user retention from Discord/Slack/Matrix
2. **Implement after client-batch**: Shared infrastructure
3. **Start with Phase 1-2**: Core functionality first
4. **Conservative limits initially**: Small max-lines, can increase later
5. **Focus on code pasting use case**: Primary pain point for developer users

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| soju | Bouncer |
| Goguma | Client |
| gamja | Client |

Moderate adoption.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/multiline
- **Batch**: https://ircv3.net/specs/extensions/batch
- **Message Tags**: https://ircv3.net/specs/extensions/message-tags
