# Metadata Value Chunking Extension

## Status: PLANNED

## Problem Statement

The IRCv3 `draft/metadata-2` specification has a fundamental design flaw:
- It allows servers to advertise `max-value-bytes` up to 1024+ bytes
- IRC protocol limits messages to 512 bytes (body, excluding tags)
- After command overhead (`METADATA SET target key :`), only ~300-400 bytes remain for values
- Values exceeding this limit get **silently truncated** by the IRC parser
- The spec has no chunking/continuation mechanism

This was identified when the [message length increase PR](https://github.com/ircv3/ircv3-specifications/pull/281) was closed without merge in 2017, with the author suggesting "some sort of continuation cap that works with labels" instead.

## Current State (After Immediate Fix)

- `max-value-bytes` lowered to 300 (realistic limit)
- Error code changed to `VALUE_INVALID` per spec
- CAP LS advertises the correct limit

## Proposed Solution: Chunked Metadata Values

Implement a continuation mechanism similar to SASL's 400-byte chunking, allowing metadata values up to the full 1024 bytes (or more) to be transmitted across multiple messages.

### Design Goals

1. **Backward compatible** - Servers/clients without chunking support work with 300-byte limit
2. **Labeled-response friendly** - Works with IRCv3 labeled-response for correlation
3. **Atomic** - Partial uploads don't corrupt existing values
4. **Simple** - Minimal protocol complexity

### Proposed Protocol Extension

#### Capability Advertisement

```
CAP LS 302
:server CAP * LS :draft/metadata-2=max-subs=50,max-keys=20,max-value-bytes=1024,chunked
```

The `chunked` token indicates server supports chunked value transmission.

#### Chunked SET Command

**Format:**
```
METADATA SET <target> <key> [<visibility>] + :<chunk1>
METADATA SET <target> <key> [<visibility>] + :<chunk2>
METADATA SET <target> <key> [<visibility>] :<final_chunk>
```

- `+` after visibility indicates "more data follows"
- Final chunk has no `+`, signaling completion
- Server assembles chunks and stores atomically
- If final chunk never arrives within timeout, discard partial

**Example - Setting a 600-byte value:**
```
@label=abc123 METADATA SET * avatar + :data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfF
METADATA SET * avatar + :cXdZSk8j3mYP9AH/wDAnQPb+QAAAABJRU5ErkJggg==MoreDataMoreDataMoreDataMore
METADATA SET * avatar :DataFinalPortion
```

Server response (on final chunk):
```
@label=abc123 :server 761 nick * avatar * :data:image/png;base64,iVBORw0KGgo...
```

#### Chunked GET Response (Server to Client)

For values exceeding single-message size, server uses batching:

```
@label=xyz BATCH +md1 draft/metadata-value nick avatar
@batch=md1 :server METADATA nick avatar * + :data:image/png;base64,iVBORw0K...
@batch=md1 :server METADATA nick avatar * + :GgoAAAANSUhEUgAAAAEAAAABC...
@batch=md1 :server METADATA nick avatar * :AYAAAAfFcXdZSk8j3mYP9AH
BATCH -md1
```

This uses the existing BATCH mechanism with a new batch type `draft/metadata-value`.

### Implementation Plan

#### Phase 1: Server-Side Chunk Assembly (Nefarious)

**Files to modify:**
- `ircd/m_metadata.c` - Add chunk assembly logic to SET handler
- `include/metadata.h` - Add chunk buffer structure per client
- `ircd/metadata.c` - Add chunk buffer management functions

**New structures:**
```c
#define METADATA_CHUNK_TIMEOUT 30  /* seconds */
#define METADATA_MAX_ASSEMBLED 4096  /* max assembled value size */

struct MetadataChunkBuffer {
  char target[NICKLEN + 1];
  char key[METADATA_KEY_LEN];
  char *data;           /* assembled data so far */
  size_t len;           /* current length */
  size_t allocated;     /* allocated size */
  time_t started;       /* when first chunk received */
  int visibility;       /* METADATA_VIS_* */
};
```

**SET handler changes:**
```c
static int metadata_cmd_set(struct Client *sptr, int parc, char *parv[])
{
  /* ... existing validation ... */

  /* Check for continuation marker */
  int is_continuation = 0;
  if (parc >= 5 && parv[4][0] == '+' && parv[4][1] == '\0') {
    is_continuation = 1;
    /* Shift params: visibility is parv[5], value is parv[6] */
  } else if (parc >= 6 && parv[5][0] == '+' && parv[5][1] == '\0') {
    is_continuation = 1;
    /* value is parv[6] */
  }

  if (is_continuation) {
    /* Append to chunk buffer */
    return metadata_chunk_append(sptr, target, key, value, visibility);
  }

  /* Check if this completes a chunked upload */
  struct MetadataChunkBuffer *buf = metadata_chunk_get(sptr, target, key);
  if (buf) {
    /* Append final chunk and finalize */
    return metadata_chunk_finalize(sptr, buf, value);
  }

  /* Regular non-chunked SET */
  /* ... existing code ... */
}
```

#### Phase 2: Server-Side Chunked Response (Nefarious)

**Files to modify:**
- `ircd/m_metadata.c` - Add chunked response logic to GET handler

**GET handler changes for large values:**
```c
static void send_keyvalue_chunked(struct Client *to, const char *target,
                                  const char *key, const char *value,
                                  const char *visibility)
{
  size_t len = strlen(value);
  size_t chunk_size = 350;  /* Safe chunk size */

  if (len <= chunk_size || !CapActive(to, CAP_BATCH)) {
    /* Single message or client doesn't support batch */
    send_keyvalue(to, target, key, value, visibility);
    return;
  }

  /* Send as batch */
  char batch_id[16];
  snprintf(batch_id, sizeof(batch_id), "md%lu", (unsigned long)CurrentTime);

  sendrawto_one(to, "BATCH +%s draft/metadata-value %s %s",
                batch_id, target, key);

  const char *p = value;
  while (len > 0) {
    size_t this_chunk = (len > chunk_size) ? chunk_size : len;
    int more = (len > this_chunk);

    sendrawto_one(to, "@batch=%s :%s METADATA %s %s %s %s:%.*s",
                  batch_id, cli_name(&me), target, key, visibility,
                  more ? "+ " : "", (int)this_chunk, p);

    p += this_chunk;
    len -= this_chunk;
  }

  sendrawto_one(to, "BATCH -%s", batch_id);
}
```

#### Phase 3: Client Support (Test Framework)

**Files to modify:**
- `tests/src/helpers/ircv3-client.ts` - Add chunked SET helper
- `tests/src/ircv3/metadata.test.ts` - Add chunking tests

**Helper function:**
```typescript
async setMetadataChunked(target: string, key: string, value: string,
                         visibility?: 'private' | '*'): Promise<void> {
  const chunkSize = 300;
  const vis = visibility || '*';

  if (value.length <= chunkSize) {
    this.send(`METADATA SET ${target} ${key} ${vis} :${value}`);
    return;
  }

  let offset = 0;
  while (offset < value.length) {
    const remaining = value.length - offset;
    const isLast = remaining <= chunkSize;
    const chunk = value.slice(offset, offset + chunkSize);

    if (isLast) {
      this.send(`METADATA SET ${target} ${key} ${vis} :${chunk}`);
    } else {
      this.send(`METADATA SET ${target} ${key} ${vis} + :${chunk}`);
    }

    offset += chunkSize;
  }
}
```

#### Phase 4: X3 Integration

**Files to modify:**
- `x3/src/nickserv.c` - Handle chunked MD responses from IRCd
- `x3/src/mod-keycloak.c` - Store/retrieve large attribute values

### Protocol Edge Cases

| Scenario | Behavior |
|----------|----------|
| Timeout during chunked upload | Discard partial, no error to client |
| New SET for same key during chunk | Discard old partial, start fresh |
| Client disconnect during chunk | Cleanup chunk buffer |
| Different target in continuation | Error: FAIL METADATA INVALID_PARAMS |
| Different key in continuation | Error: FAIL METADATA INVALID_PARAMS |
| Visibility change mid-chunk | Use visibility from final chunk |
| Chunk exceeds max-value-bytes total | Error: FAIL METADATA VALUE_INVALID |

### CAP LS Update

When chunking is implemented, advertise:
```
draft/metadata-2=max-subs=50,max-keys=20,max-value-bytes=4096,chunked
```

The `max-value-bytes` can be increased since chunking removes the 512-byte message constraint.

### Testing Plan

1. **Basic chunked SET** - Value split across 2-3 chunks
2. **Large value SET** - Value split across 10+ chunks
3. **Timeout test** - Start chunk upload, don't finish, verify cleanup
4. **Interleaved test** - Two clients chunking to same key simultaneously
5. **Chunked GET response** - Verify batch-wrapped response for large values
6. **Non-chunked fallback** - Client without batch cap gets truncated value

### Future Considerations

- **Compression** - Could combine with zstd compression for even larger values
- **Streaming** - For very large values, could implement streaming API
- **Binary data** - Current impl assumes UTF-8; might need base64 for binary

### References

- [IRCv3 Metadata Spec](https://ircv3.net/specs/extensions/metadata.html)
- [Message Length PR #281](https://github.com/ircv3/ircv3-specifications/pull/281) (closed)
- [SASL Authentication](https://ircv3.net/specs/extensions/sasl-3.1) - chunking precedent
- [IRCv3 Batch](https://ircv3.net/specs/extensions/batch) - for chunked responses
