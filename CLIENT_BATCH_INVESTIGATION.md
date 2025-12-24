# IRCv3 Client-Initiated Batch Extension Investigation

## Status: INVESTIGATING (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/client-batch

**Capability**: None (framework for other specifications)

---

## Specification Summary

The client-initiated batch extension defines how clients can send batched commands to servers. This is a framework specification that:
- Defines client batch syntax
- Establishes error handling patterns
- Enables future batch-based features (multiline, etc.)

---

## Key Difference from Server Batch

| Aspect | Server-Initiated | Client-Initiated |
|--------|------------------|------------------|
| Direction | Server → Client | Client → Server |
| Current Use | Netjoin, netsplit, history | Future features |
| Nesting | Allowed | NOT allowed |
| CAP | `batch` | Defined by specific features |

---

## BATCH Command Syntax

Same as server-initiated batches:

```
C: BATCH +reference-tag type [params...]
C: @batch=reference-tag COMMAND params...
C: @batch=reference-tag COMMAND params...
C: BATCH -reference-tag
```

---

## Restrictions

1. **No interleaving**: Once batch opened, client MUST NOT send non-batched messages
2. **No nesting**: Client batches cannot be nested
3. **Must close**: Batch must be closed before starting another

---

## Error Handling

Uses standard-replies framework:

### TIMEOUT Error

```
FAIL BATCH TIMEOUT <reference-tag> :Batch timed out
```

Sent when:
- Batch left open too long
- Server discards past and future messages in that batch

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `batch` | Complete |
| `standard-replies` | Complete |

---

## Current Use Cases

This is a framework spec. Actual batch types are defined elsewhere:

| Batch Type | Specification | Status |
|------------|---------------|--------|
| `draft/multiline` | multiline extension | Draft |
| Future types | TBD | - |

---

## Server Responsibilities

### Batch Tracking

```c
struct ClientBatch {
    char reference_tag[64];
    char type[32];
    char params[256];
    time_t started;
    struct Message *messages;
    int message_count;
    int total_bytes;
};
```

### Timeout Handling

```c
void check_client_batch_timeout(struct Client *cptr)
{
    struct ClientBatch *batch = cli_batch(cptr);
    if (batch && (CurrentTime - batch->started > BATCH_TIMEOUT)) {
        send_fail(cptr, "BATCH", "TIMEOUT", batch->reference_tag,
                  "Batch timed out");
        free_client_batch(batch);
    }
}
```

---

## Implementation Architecture

### State Machine

```
IDLE -> BATCH_STARTED -> RECEIVING_MESSAGES -> BATCH_ENDED
                    \                     /
                     \-- TIMEOUT/ERROR --/
```

### Message Handling

```c
int parse_client_message(struct Client *cptr, char *buffer)
{
    struct ClientBatch *batch = cli_batch(cptr);

    /* Check for BATCH command */
    if (is_batch_command(buffer)) {
        return handle_batch_command(cptr, buffer);
    }

    /* If in batch, verify @batch tag */
    if (batch) {
        if (!has_matching_batch_tag(buffer, batch->reference_tag)) {
            /* Non-batched message during batch = error */
            send_fail(cptr, "BATCH", "INVALID", batch->reference_tag,
                      "Expected batched message");
            return -1;
        }
        return collect_batch_message(cptr, buffer);
    }

    /* Normal message processing */
    return parse_message(cptr, buffer);
}
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/client.h` | Add client batch state |
| `ircd/m_batch.c` | Handle client-initiated batches |
| `ircd/parse.c` | Integrate batch message collection |
| `ircd/s_bsd.c` | Add batch timeout checks |

---

## Configuration Options

```
features {
    "CLIENT_BATCH_TIMEOUT" = "30";  /* seconds */
};
```

---

## Implementation Phases

### Phase 1: Batch Framework

1. Add client batch state to client structure
2. Handle BATCH +/- commands from clients
3. Track batch state per connection
4. Implement timeout handling

**Effort**: Medium (12-16 hours)

### Phase 2: Message Collection

1. Collect batched messages
2. Verify @batch tags
3. Reject non-batched during batch

**Effort**: Low (8-12 hours)

### Phase 3: Type Dispatch

1. Dispatch to type handlers (multiline, etc.)
2. Type-specific validation
3. Type-specific processing

**Effort**: Low (4-8 hours)

---

## Error Scenarios

### Missing @batch Tag

```
C: BATCH +abc draft/multiline #channel
C: PRIVMSG #channel :Hello        <- Missing @batch=abc

S: FAIL BATCH INVALID abc :Expected batched message
```

### Interleaved Messages

```
C: BATCH +abc draft/multiline #channel
C: @batch=abc PRIVMSG #channel :Line 1
C: PING :test                     <- Non-batched during batch

S: FAIL BATCH INVALID abc :Cannot send non-batched during batch
```

### Timeout

```
C: BATCH +abc draft/multiline #channel
C: @batch=abc PRIVMSG #channel :Line 1
... 30 seconds pass ...

S: FAIL BATCH TIMEOUT abc :Batch timed out
```

---

## Security Considerations

1. **Resource limits**: Maximum messages per batch
2. **Timeout enforcement**: Prevent resource exhaustion
3. **Type validation**: Only allow known batch types
4. **Size limits**: Maximum bytes per batch

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Batch state tracking | Medium | Low |
| Message collection | Low | Low |
| Timeout handling | Low | Low |
| Type dispatch | Low | Low |
| Error handling | Low | Low |

**Total**: Medium effort (24-36 hours)

---

## Recommendation

1. **Implement with multiline**: This is a framework, needs use case
2. **Share infrastructure**: Build for extensibility
3. **Conservative timeouts**: Prevent resource exhaustion

---

## Future Batch Types

The spec anticipates:
- Additional batch types beyond multiline
- Possible nested batches in future revisions
- Client-to-server coordination batches

Design APIs with future expansion in mind.

---

## Relationship to Server Batches

| Feature | Server Batch | Client Batch |
|---------|--------------|--------------|
| Token | `BT` | N/A (client sends) |
| Types | netjoin, netsplit, chathistory | multiline, future |
| Direction | S→C (and S→S) | C→S |
| Implementation | Phase 11, 13d | New |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/client-batch
- **Batch**: https://ircv3.net/specs/extensions/batch
- **Multiline**: https://ircv3.net/specs/extensions/multiline
- **Standard Replies**: https://ircv3.net/specs/extensions/standard-replies
