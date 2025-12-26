# Compressed Data Passthrough Optimization

## Status: IMPLEMENTED (Metadata)

**Implementation Date:** December 2024

### Metadata Passthrough - Completed:
- [x] X3: `x3_lmdb_account_get_raw()` - Get data without decompression
- [x] X3: `x3_lmdb_account_set_raw()` - Set data without compression
- [x] X3: `x3_lmdb_account_list_raw()` - List raw entries with compression flag
- [x] X3: `irc_metadata_raw()` - Send compressed metadata with Z flag
- [x] X3: `nickserv_sync_account_metadata_to_ircd()` - Uses raw passthrough for MDQ responses
- [x] Nefarious: `metadata_account_set_raw()` - Store without recompression
- [x] Nefarious: `ms_metadata()` Z flag detection and raw storage

### Chathistory - N/A:
Chathistory compression passthrough is not applicable because:
- History is stored locally per-server in LMDB (not synchronized between servers)
- Clients receive plaintext IRC protocol (PRIVMSG/NOTICE), not raw data
- Decompression is only needed when serving clients (unavoidable)
- Compression still provides storage efficiency benefit

### Optional/Deferred:
- [ ] CAPAB negotiation for server link capability (not critical, Z flag is backward compatible)
- [ ] End-to-end testing with compression metrics
- [ ] Future: If server-to-server history sync is added, implement compressed batch forwarding

---

## Problem Statement

Currently, LMDB-cached data (metadata, chathistory) is:
1. **Decompressed in X3** when read from LMDB
2. **Sent uncompressed over P10**
3. **Recompressed in Nefarious** when stored to LMDB

This creates unnecessary CPU overhead and increased network bandwidth.

---

## Current Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CURRENT (INEFFICIENT)                            │
└─────────────────────────────────────────────────────────────────────┘

X3 LMDB                  P10 Network              Nefarious LMDB
┌──────────┐            ┌──────────┐            ┌──────────┐
│Compressed│            │Decompress│            │Compressed│
│  Data    │──────────▶ │  (CPU)   │──────────▶ │  Data    │
│  (zstd)  │            │Plain Text│            │  (zstd)  │
└──────────┘            └──────────┘            └──────────┘
     ↓                       ↓                       ↓
x3_lmdb_get()           putsock()             compress_data()
(decompress)            (send)                (recompress)
```

---

## Proposed Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PROPOSED (OPTIMIZED)                             │
└─────────────────────────────────────────────────────────────────────┘

X3 LMDB                  P10 Network              Nefarious LMDB
┌──────────┐            ┌──────────┐            ┌──────────┐
│Compressed│            │Base64    │            │Compressed│
│  Data    │──────────▶ │Compressed│──────────▶ │  Data    │
│  (zstd)  │            │  Data    │            │  (zstd)  │
└──────────┘            └──────────┘            └──────────┘
     ↓                       ↓                       ↓
x3_lmdb_get_raw()       putsock()             store_raw()
(no decompress)         (base64)              (no compress)
```

---

## P10 Token Extension

### Current MD Token Format
```
<source> MD <target> <key> <visibility> :<value>
```
Example:
```
AB MD nick avatar * :https://example.com/avatar.jpg
```

### Proposed Extended Format
```
<source> MD <target> <key> <visibility> Z :<base64_compressed_data>
```

The `Z` flag indicates:
- Value is zstd-compressed
- Value is base64-encoded (for safe P10 transmission)
- Receiver should decode + store directly without recompression

Example:
```
AB MD nick avatar * Z :KLUv/QBYpQEAaHR0cHM6Ly9leGFtcGxlLmNvbS9hdmF0YXIuanBn
```

---

## Implementation

### Phase 1: X3 Changes

**File: `src/x3_lmdb.c`**

Add raw getter that returns compressed data:
```c
/**
 * Get account metadata value without decompression
 * @param account Account name
 * @param key Metadata key
 * @param value Buffer for raw (possibly compressed) value
 * @param is_compressed Output flag: 1 if data is compressed
 * @return LMDB_SUCCESS on success, LMDB_NOT_FOUND if not found
 */
int x3_lmdb_account_get_raw(const char *account, const char *key,
                            char *value, size_t *value_len,
                            int *is_compressed);
```

**File: `src/proto-p10.c`**

Modify `irc_metadata()` to send compressed data:
```c
void irc_metadata(const char *target, const char *key,
                  const char *value, int visibility)
{
    char raw_value[4096];
    size_t raw_len;
    int is_compressed;

    /* Try to get raw (possibly compressed) data */
    if (x3_lmdb_account_get_raw(target, key, raw_value,
                                 &raw_len, &is_compressed) == LMDB_SUCCESS) {
        if (is_compressed && feature_enabled(FEAT_COMPRESSED_METADATA)) {
            /* Send compressed with Z flag */
            char *b64 = base64_encode(raw_value, raw_len);
            putsock("%s " P10_METADATA " %s %s %s Z :%s",
                    self->numeric, target, key, vis_token, b64);
            free(b64);
            return;
        }
    }

    /* Fallback: decompress and send plain */
    putsock("%s " P10_METADATA " %s %s %s :%s",
            self->numeric, target, key, vis_token, value);
}
```

### Phase 2: Nefarious Changes

**File: `ircd/m_metadata.c`**

Modify `ms_metadata()` to detect and handle compressed data:
```c
int ms_metadata(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
    /* ... existing parsing ... */

    /* Check for Z (compressed) flag */
    if (parc >= 5 && parv[4][0] == 'Z') {
        /* Value is base64-encoded compressed data */
        size_t raw_len;
        unsigned char *raw = base64_decode(parv[5], &raw_len);

        /* Store directly without recompression */
        metadata_account_set_raw(target, key, raw, raw_len, visibility);
        free(raw);
    } else {
        /* Standard: compress on store */
        metadata_account_set(target, key, parv[4], visibility);
    }
}
```

**File: `ircd/metadata.c`**

Add raw setter that stores without compression:
```c
int metadata_account_set_raw(const char *account, const char *key,
                             const unsigned char *data, size_t len,
                             int visibility)
{
    /* Store directly - data already compressed */
    MDB_val mkey, mdata;
    /* ... LMDB transaction ... */
    mdata.mv_data = (void *)data;
    mdata.mv_size = len;
    mdb_put(txn, dbi, &mkey, &mdata, 0);
}
```

### Phase 3: Feature Negotiation

**Server Link Capability**

Add to server link handshake:
```
PASS :password TS
CAPAB :... METADATA_ZSTD ...
```

Check during metadata send:
```c
if (cli_capab(cptr) & CAPAB_METADATA_ZSTD) {
    /* Can send compressed */
} else {
    /* Must decompress for this server */
}
```

---

## Compatibility

### Backward Compatible

| Sender | Receiver | Result |
|--------|----------|--------|
| Old X3 | Old Nefarious | Works (current behavior) |
| New X3 | Old Nefarious | Works (fallback to uncompressed) |
| Old X3 | New Nefarious | Works (no Z flag, normal processing) |
| New X3 | New Nefarious | Optimized (compressed passthrough) |

### Feature Detection

X3 checks server capabilities before sending compressed:
```c
if (uplink_supports(CAPAB_METADATA_ZSTD)) {
    send_compressed();
} else {
    decompress_and_send();
}
```

---

## Chathistory Optimization

The same pattern applies to chathistory (CH token):

### Current
```
AB CH #channel BEFORE msgid 50
<responses are decompressed from LMDB, sent plain, recompressed on store>
```

### Proposed
```
AB CH #channel BEFORE msgid 50 Z
<responses sent as compressed batches>
```

---

## Benefits

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| CPU (decompress) | Yes | No | ~50% reduction |
| CPU (recompress) | Yes | No | ~50% reduction |
| Network bytes | 100% | ~40% | ~60% reduction |
| Latency | Higher | Lower | Reduced processing |

---

## Testing Checklist

- [ ] X3 sends compressed MD when server supports it
- [ ] X3 falls back to plain when server doesn't support it
- [ ] Nefarious stores compressed data without recompression
- [ ] Nefarious handles plain MD from old X3 correctly
- [ ] Mixed network (old/new servers) works correctly
- [ ] Base64 encoding/decoding is correct
- [ ] Magic byte preserved through transit
- [ ] Compression stats show reduced CPU usage

---

## Implementation Order

| Phase | Task | Files | Effort |
|-------|------|-------|--------|
| 1 | Add raw getters to X3 LMDB | x3_lmdb.c/h | 2-3 hrs |
| 2 | Add Z flag support to X3 proto-p10 | proto-p10.c | 3-4 hrs |
| 3 | Add raw setters to Nefarious | metadata.c | 2-3 hrs |
| 4 | Add Z flag parsing to Nefarious | m_metadata.c | 3-4 hrs |
| 5 | Add CAPAB negotiation | both sides | 2-3 hrs |
| 6 | Extend to chathistory | m_chathistory.c | 3-4 hrs |
| 7 | Testing & validation | - | 4-6 hrs |

**Total Estimated Effort: 19-27 hours**

---

## References

- [LMDB Compression Implementation](../investigations/METADATA_INVESTIGATION.md)
- [P10 Protocol Reference](../../P10_PROTOCOL_REFERENCE.md)
- [X3 LMDB Module](../../x3/src/x3_lmdb.c)
- [Nefarious Metadata](../../nefarious/ircd/metadata.c)
