# X3 Metadata Compression

Zstandard (zstd) compression for X3 Services metadata storage.

## Overview

X3 supports optional zstd compression for metadata values stored in LMDB. This reduces storage requirements for large metadata values and network bandwidth when transferring metadata to Nefarious.

## Why zstd?

- 10-20% better compression ratio than zlib
- 3-5x faster decompression than zlib
- Adjustable compression levels (1-22)
- Battle-tested (Linux kernel, PostgreSQL, MySQL)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `metadata_compress_threshold` | 256 | Min bytes to trigger compression |
| `metadata_compress_level` | 3 | Compression level (1-22) |

**x3.conf example**:
```
"nickserv" {
    "metadata_compress_threshold" "256";
    "metadata_compress_level" "3";
};
```

## Compression Levels

| Level | Speed | Ratio | Use Case |
|-------|-------|-------|----------|
| 1 | Fastest | ~60% | High-volume, low CPU |
| 3 | Fast | ~75% | Recommended default |
| 9 | Medium | ~85% | Similar to zlib -9 |
| 19-22 | Slow | ~95% | Archival, max ratio |

## Storage Format

Compressed values are prefixed with magic byte `0x1F`:

```
Uncompressed: avatar=https://example.com/photo.jpg
Compressed:   0x1F + zstd_frame
```

Detection is automatic on read - no separate flag needed.

## Compression Passthrough

When X3 responds to MDQ queries from Nefarious, pre-compressed data is sent with the P10 `Z` flag:

```
Az MD ABAAB avatar * Z :KLUv/QBYpQEAaHR0cHM6Ly9...
```

**Benefits**:
- Nefarious stores compressed data directly in its LMDB cache
- No decompress/recompress cycle
- CPU savings on both X3 and Nefarious

**Flow**:
```
X3 LMDB (compressed)
       │
       ▼ MD ... Z :base64(compressed)
Nefarious LMDB (compressed, unchanged)
       │
       ▼ decompress on client request
Client (plaintext)
```

## Build Requirements

```bash
./configure --with-zstd
```

Package: `libzstd-dev` (Debian/Ubuntu) or `libzstd-devel` (RHEL/Fedora)

## Backward Compatibility

- Old uncompressed data is read correctly (no magic byte)
- New compressed data works with updated X3 only
- If compression doesn't save space, value stored uncompressed

## Typical Compression Ratios

| Content Type | Typical Ratio |
|--------------|---------------|
| Avatar URLs | 70-80% |
| JSON blobs | 50-60% |
| Base64 data | 80-90% |
| Short strings | No compression (below threshold) |

---

*Part of the X3 Services IRCv3.2+ upgrade project.*
