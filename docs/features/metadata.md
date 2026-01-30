# IRCv3 Metadata

Implementation of `draft/metadata-2` IRCv3 extension in Nefarious IRCd with X3 Services integration.

## Overview

Metadata provides key-value storage for users and channels, enabling features like avatars, pronouns, status messages, and custom client data. Nefarious maintains an LMDB cache with X3 as the authoritative store.

## Architecture

```
┌─────────┐                    ┌──────────┐                    ┌────┐
│ Client  │─METADATA SET──────►│ Nefarious│─MD──────────────►│ X3 │
│         │                    │  (cache) │                    │    │
│         │◄─METADATA VALUE────│          │◄─MD──────────────│    │
└─────────┘                    └──────────┘                    └────┘
                                    │
                               ┌────▼────┐
                               │  LMDB   │
                               │ (cache) │
                               └─────────┘
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_metadata` | TRUE | Enable `draft/metadata-2` capability |
| `FEAT_METADATA_CACHE_ENABLED` | TRUE | Enable LMDB caching |
| `FEAT_METADATA_X3_TIMEOUT` | 60 | Seconds before cache-only mode |
| `FEAT_METADATA_QUEUE_SIZE` | 1000 | Max pending writes |
| `FEAT_METADATA_BURST` | TRUE | Send metadata during netburst |
| `FEAT_METADATA_DB` | "metadata" | LMDB database path |
| `FEAT_METADATA_CACHE_TTL` | 14400 | Cache expiry (seconds) |
| `FEAT_METADATA_PURGE_FREQUENCY` | 3600 | Purge interval (seconds) |

## Client Commands

### METADATA Subcommands

```
METADATA <target> GET <key>
METADATA <target> LIST
METADATA <target> SET <key> <visibility> :<value>
METADATA <target> CLEAR <key>
METADATA <target> SUB <key> [key...]
METADATA <target> UNSUB <key> [key...]
```

### Visibility

- `*` - Public (visible to everyone)
- `P` - Private (visible only to owner and opers)

### Examples

```
METADATA * SET avatar * :https://example.com/photo.jpg
METADATA * SET email P :user@example.com
METADATA #channel SET url * :https://example.com
METADATA * GET avatar
METADATA johndoe LIST
```

## P10 Protocol

### MD Token (Metadata)

**Format**:
```
[SOURCE] MD <target> <key> <visibility> :<value>
[SOURCE] MD <target> <key> <visibility> Z :<compressed_base64>
```

**Visibility flags**:
- `*` - Public
- `P` - Private
- `Z` - Compressed (zstd, passthrough from X3)

**Examples**:
```
AB MD ABAAB avatar * :https://example.com/photo.jpg
Az MD ABAAB avatar * Z :KLUv/QBYpQEAaHR0cHM6Ly9...
AB MD #channel url * :https://channel.example.com
```

### MDQ Token (Metadata Query)

**Format**:
```
[SOURCE] MDQ <target> <key|*>
```

**Purpose**: Request metadata from X3 when not in local cache.

**Examples**:
```
AB MDQ johndoe *        # All metadata for account
AB MDQ johndoe avatar   # Specific key
AB MDQ #channel *       # All channel metadata
```

**Response**: X3 sends MD tokens with requested data.

## Cache Architecture

### Write-Through

1. Client sets metadata
2. Nefarious writes to local LMDB
3. Nefarious forwards MD to X3
4. X3 stores in LMDB + Keycloak

### Read-Through

1. Client requests metadata
2. Nefarious checks local LMDB
3. Cache hit: return immediately
4. Cache miss: send MDQ to X3
5. X3 responds with MD
6. Nefarious caches and returns to client

### Offline Queue

When X3 is unavailable:
1. Writes queued in memory (up to QUEUE_SIZE)
2. X3 unavailability detected via heartbeat timeout
3. Queue replayed when X3 reconnects
4. Reads served from LMDB cache

## TTL and Expiry

### Nefarious Cache TTL

Cached entries expire after `METADATA_CACHE_TTL` seconds. Periodic purge removes expired entries.

### X3 Metadata TTL

X3 has its own TTL system (see x3-lmdb.md):
- `metadata_ttl_enabled`
- `metadata_default_ttl`
- `metadata_immutable_keys`

## Compression

When X3 has compressed metadata (zstd), it's passed through unchanged:

```
X3 LMDB (compressed) ──MD...Z──► Nefarious LMDB (compressed) ──decompress──► Client
```

Benefits:
- No recompression overhead
- Reduced network bandwidth
- Efficient storage

## Netburst

When `METADATA_BURST=TRUE`, metadata is sent during server linking:

1. Server A links to Server B
2. Server A sends all cached user/channel metadata
3. Server B populates its local cache
4. Clients on Server B have immediate access

## Virtual Keys

Special keys computed dynamically:

| Key | Description |
|-----|-------------|
| `presence` | Effective presence (present/away/away-star) |
| `last_present` | Unix timestamp of last presence |

## Standard Keys

Common metadata keys (by convention):

| Key | Description |
|-----|-------------|
| `avatar` | User avatar URL |
| `pronouns` | User pronouns |
| `bot` | Bot indicator ("true") |
| `homepage` | User website |
| `url` | Channel website |
| `rules` | Channel rules |
| `description` | Channel description |

## X3 Storage

X3 stores metadata in:

1. **LMDB**: Primary fast storage
2. **Keycloak** (optional): Attribute backup
   - `metadata.<key>` user attributes

## Example Configuration

```
features {
    "CAP_metadata" = "TRUE";
    "METADATA_CACHE_ENABLED" = "TRUE";
    "METADATA_DB" = "metadata";
    "METADATA_BURST" = "TRUE";
    "METADATA_CACHE_TTL" = "14400";
    "METADATA_PURGE_FREQUENCY" = "3600";
};
```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*
