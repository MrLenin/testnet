# IRCv3 Metadata Extension Investigation

## Status: IMPLEMENTED (All Phases Complete)

**Specification**: https://ircv3.net/specs/extensions/metadata

**Capability**: `draft/metadata-2`

---

## Implementation Summary

All six phases of the metadata-2 specification have been implemented:

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Basic GET/SET (In-Memory) | ✅ Complete |
| Phase 2 | Subscriptions | ✅ Complete |
| Phase 3 | Channel Metadata | ✅ Complete |
| Phase 4 | Network Propagation | ✅ Complete |
| Phase 5 | X3 Integration | ✅ Complete |
| Phase 6 | Limits, Rate Limiting, Visibility | ✅ Complete |

---

## Specification Summary

The metadata extension provides a key-value store for users and channels. This enables:
- User profile information (avatar URL, timezone, pronouns)
- Channel metadata (description, rules URL)
- Real-time presence data (location, status)
- Bot configuration and state

---

## Capability Value Tokens

| Token | Description |
|-------|-------------|
| `before-connect` | Allow METADATA before registration |
| `max-subs=N` | Maximum subscription count |
| `max-keys=N` | Maximum keys per target |
| `max-value-bytes=N` | Maximum value size in bytes |

**Example**: `CAP LS :draft/metadata-2=max-subs=50,max-keys=20,max-value-bytes=1000`

---

## METADATA Command

### Syntax

```
METADATA <target> <subcommand> [params...]
```

### Subcommands

| Subcommand | Syntax | Description | Status |
|------------|--------|-------------|--------|
| `GET` | `METADATA <target> GET <key> [key...]` | Retrieve specific keys | ✅ |
| `LIST` | `METADATA <target> LIST` | List all metadata for target | ✅ |
| `SET` | `METADATA <target> SET <key> [visibility] [:<value>]` | Set/delete key | ✅ |
| `CLEAR` | `METADATA <target> CLEAR` | Remove all metadata | ✅ |
| `SUB` | `METADATA * SUB <key> [key...]` | Subscribe to key updates | ✅ |
| `UNSUB` | `METADATA * UNSUB <key> [key...]` | Unsubscribe from keys | ✅ |
| `SUBS` | `METADATA * SUBS` | List current subscriptions | ✅ |
| `SYNC` | `METADATA <target> SYNC` | Fetch subscribed keys for target | ✅ |

---

## Message Format

### Server to Client

```
METADATA <target> <key> <visibility> :<value>
```

| Field | Description |
|-------|-------------|
| `<target>` | User nick or channel name |
| `<key>` | Metadata key name |
| `<visibility>` | `*` for public, `private` for private |
| `<value>` | Key value (trailing parameter) |

**Example**:
```
:server METADATA nick avatar * :https://example.com/avatar.png
:server METADATA nick secret private :my-secret-value
:server METADATA #channel description * :Welcome to our channel
```

---

## Visibility Support

Metadata can be marked as public or private:

| Visibility | Token | Who Can See |
|------------|-------|-------------|
| Public | `*` | Everyone |
| Private | `private` | Owner only (and opers) |

### SET with Visibility

```
METADATA SET * mykey * :public value
METADATA SET * mykey private :private value
METADATA SET * mykey :defaults to public
```

### P10 Visibility Propagation

```
# Public metadata
[SOURCE] MD <target> <key> * :<value>

# Private metadata
[SOURCE] MD <target> <key> P :<value>
```

---

## Key Naming

Valid characters: `a-z`, `0-9`, `_`, `.`, `/`, `-`, `:`

**Examples**:
- `avatar` - User avatar URL
- `bot` - Bot indicator
- `location` - User location
- `pronouns` - User pronouns
- `channel/rules` - Channel rules URL

---

## Subscription System

Clients subscribe to specific keys and receive notifications when they change:

```
C: METADATA * SUB avatar pronouns
S: :server 770 nick :avatar pronouns

# When user changes avatar:
S: :server METADATA user avatar * :https://new-avatar.png
```

**Note**: Private metadata changes are NOT sent to subscribers.

---

## SYNC Subcommand

The SYNC command fetches all subscribed metadata for a target using batch:

```
C: METADATA #channel SYNC
S: @batch=abc123 BATCH +abc123 metadata
S: @batch=abc123 :server METADATA #channel description * :Welcome
S: @batch=abc123 :server METADATA nick1 avatar * :https://...
S: @batch=abc123 :server METADATA nick2 avatar * :https://...
S: BATCH -abc123
```

For channel targets, SYNC includes metadata for all channel members.

---

## Rate Limiting

Configurable via `FEAT_METADATA_RATE_LIMIT` (default: 10 commands/second).

- Applied per-client, per-second
- Operators bypass rate limiting
- Returns `RATE_LIMITED` error when exceeded

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `batch` | Complete |
| `standard-replies` | Complete |

---

## Numeric Responses

| Numeric | Name | Description |
|---------|------|-------------|
| 760 | `RPL_METADATAEND` | End of metadata list |
| 761 | `RPL_KEYVALUE` | Key-value pair response |
| 762 | `RPL_KEYSTATUS` | Key status (set confirmation) |
| 763 | `RPL_KEYNOTSET` | Key not set |
| 770 | `RPL_METADATASUBOK` | Subscription confirmed |
| 771 | `RPL_METADATAUNSUBOK` | Unsubscription confirmed |
| 772 | `RPL_METADATASUBS` | Subscription list |
| 773 | `RPL_METADATASYNCLATER` | Sync postponed |

---

## Error Responses

| Error Code | Condition |
|------------|-----------|
| `KEY_INVALID` | Key name contains invalid characters |
| `KEY_NO_PERMISSION` | Cannot access/modify this key |
| `KEY_NOT_SET` | Key doesn't exist |
| `LIMIT_REACHED` | Maximum keys/subs reached |
| `RATE_LIMITED` | Too many requests |
| `TOO_MANY_SUBS` | Maximum subscriptions exceeded |
| `VALUE_INVALID` | Value doesn't meet requirements |
| `INVALID_TARGET` | Target doesn't exist |
| `INTERNAL_ERROR` | Server error |

---

## Implementation Architecture

### Storage

- **In-memory**: Client and channel metadata linked lists
- **LMDB**: Persistent storage for account-linked metadata
- **Keycloak**: X3 stores metadata as user attributes with `metadata.` prefix

### Visibility Storage

Visibility is stored as a prefix in Keycloak attribute values:
- Public: stored as-is (`value`)
- Private: stored with prefix (`P:value`)

---

## P10 Protocol

### Token: `MD` (METADATA)

**Set with visibility**:
```
[SOURCE] MD <target> <key> <visibility> :<value>
```

**Clear**:
```
[SOURCE] MD <target> <key>
```

**Visibility tokens**:
- `*` = public
- `P` = private

**Examples**:
```
ABAAB MD ABAAB avatar * :https://example.com/avatar.png
ABAAB MD ABAAB secret P :private-data
ABAAB MD #channel description * :Welcome
```

### Sync on Connect

When user authenticates, X3 sends stored metadata to IRCd:
```
AZ MD ABAAB avatar * :https://...
AZ MD ABAAB pronouns * :they/them
AZ MD ABAAB secret P :private-value
```

---

## Files Modified

### Nefarious

| File | Changes |
|------|---------|
| `include/capab.h` | Added `CAP_DRAFT_METADATA2` |
| `include/ircd_features.h` | Added metadata feature flags |
| `ircd/ircd_features.c` | Registered `FEAT_METADATA_*` features |
| `ircd/m_cap.c` | Added `draft/metadata-2` capability, subscription cleanup |
| `include/msg.h` | Added `MSG_METADATA`, `TOK_METADATA` ("MD") |
| `include/handlers.h` | Added `m_metadata`, `ms_metadata` declarations |
| `ircd/m_metadata.c` | **New file**: METADATA command handler |
| `ircd/metadata.c` | **New file**: Metadata storage implementation |
| `include/metadata.h` | **New file**: Metadata API declarations |
| `ircd/parse.c` | Registered METADATA command |
| `ircd/Makefile.in` | Added m_metadata.c, metadata.c |
| `include/client.h` | Added metadata/subscription pointers, rate limit fields |
| `include/channel.h` | Added channel metadata pointer |
| `ircd/s_err.c` | Added RPL_KEYVALUE with visibility parameter |

### X3

| File | Changes |
|------|---------|
| `src/nickserv.h` | Added metadata API, visibility constants |
| `src/nickserv.c` | Metadata get/set with visibility, Keycloak storage |
| `src/proto.h` | Added `irc_metadata()` with visibility |
| `src/proto-p10.c` | Added MD token handler with visibility parsing |

---

## Feature Flags

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_CAP_metadata` | TRUE | Enable draft/metadata-2 capability |
| `FEAT_METADATA_MAX_KEYS` | 20 | Maximum keys per target |
| `FEAT_METADATA_MAX_VALUE_BYTES` | 1000 | Maximum value size |
| `FEAT_METADATA_MAX_SUBS` | 50 | Maximum subscriptions per client |
| `FEAT_METADATA_RATE_LIMIT` | 10 | Commands per second (0 = disabled) |

---

## Common Metadata Keys

### User Keys

| Key | Description | Example |
|-----|-------------|---------|
| `avatar` | Profile picture URL | `https://...` |
| `bot` | Bot indicator | (empty or any value) |
| `pronouns` | User pronouns | `they/them` |
| `location` | Location | `New York, USA` |
| `timezone` | Timezone | `America/New_York` |
| `url` | Personal website | `https://...` |

### Channel Keys

| Key | Description | Example |
|-----|-------------|---------|
| `description` | Channel description | `A friendly chat` |
| `rules` | Rules URL | `https://...` |
| `icon` | Channel icon URL | `https://...` |

---

## Security Considerations

1. **Visibility**: Private metadata hidden from other users
2. **Rate limiting**: Prevents spam/abuse (configurable)
3. **Size limits**: Enforced max-keys and max-value-bytes
4. **Key restrictions**: Validated key names
5. **Privacy**: Private metadata not propagated to subscribers
6. **Oper access**: Operators can see all metadata

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| ObsidianIRC | Server |
| soju | Bouncer |
| Nefarious | **Complete** |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/metadata
- **Related**: account-tag, bot-mode
- **Deprecated**: metadata-notify (incompatible)
