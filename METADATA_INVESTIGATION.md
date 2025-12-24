# IRCv3 Metadata Extension Investigation

## Status: IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/metadata

**Capability**: `draft/metadata-2`

---

## Specification Summary

The metadata extension provides a key-value store for users and channels. This enables:
- User profile information (avatar URL, timezone, pronouns)
- Channel metadata (description, rules URL)
- Real-time presence data (location, status)
- Bot configuration and state

This is a comprehensive extension with significant complexity.

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

| Subcommand | Syntax | Description |
|------------|--------|-------------|
| `GET` | `METADATA <target> GET <key> [key...]` | Retrieve specific keys |
| `LIST` | `METADATA <target> LIST` | List all metadata for target |
| `SET` | `METADATA <target> SET <key> [:<value>]` | Set/delete key |
| `CLEAR` | `METADATA <target> CLEAR` | Remove all metadata |
| `SUB` | `METADATA * SUB <key> [key...]` | Subscribe to key updates |
| `UNSUB` | `METADATA * UNSUB <key> [key...]` | Unsubscribe from keys |
| `SUBS` | `METADATA * SUBS` | List current subscriptions |
| `SYNC` | `METADATA <target> SYNC` | Fetch subscribed keys for target |

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
| `<visibility>` | `*` for public, or visibility token |
| `<value>` | Key value (trailing parameter) |

**Example**:
```
:server METADATA nick avatar * :https://example.com/avatar.png
:server METADATA #channel description * :Welcome to our channel
```

---

## Key Naming

Valid characters: `a-z`, `0-9`, `_`, `.`, `/`, `-`

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
| 770 | `RPL_METADATASUBOK` | Subscription confirmed |
| 771 | `RPL_METADATAUNSUBOK` | Unsubscription confirmed |
| 772 | `RPL_METADATASUBS` | Subscription list |
| 773 | `RPL_METADATASYNCLATER` | Sync postponed |
| 774 | `RPL_METADATAEND` | End of batch |

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

---

## Implementation Architecture

### Storage Options

#### Option A: In-Memory (Simplest)

```c
struct MetadataEntry {
    char key[64];
    char value[1024];
    int visibility;
    struct MetadataEntry *next;
};

struct User {
    /* ... existing ... */
    struct MetadataEntry *metadata;
};

struct Channel {
    /* ... existing ... */
    struct MetadataEntry *metadata;
};
```

**Pros**: Simple, no external dependencies
**Cons**: Lost on restart, no persistence

#### Option B: X3 Services (Recommended for Users)

User metadata stored in X3 account database.

```
Client <--IRC--> Nefarious <--P10--> X3
                              |
                         Account DB
```

**Pros**: Persistent, account-linked
**Cons**: P10 changes needed, X3 modifications

#### Option C: Hybrid

- User metadata: X3 (persistent)
- Channel metadata: Nefarious (in-memory or file)

---

## P10 Protocol Design

### New Token: `MD` (METADATA)

**Format**:
```
[USER_NUMERIC] MD <target> <key> :<value>
```

**Example**:
```
ABAAB MD ABAAB avatar :https://example.com/avatar.png
ABAAB MD #channel description :Welcome
```

### Sync on Connect

When user connects, X3 sends stored metadata:
```
AZ MD ABAAB avatar :https://...
AZ MD ABAAB pronouns :they/them
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_METADATA` |
| `include/ircd_features.h` | Add metadata features |
| `ircd/ircd_features.c` | Register features |
| `ircd/m_cap.c` | Add `draft/metadata-2` to capability list |
| `include/msg.h` | Add `MSG_METADATA`, `TOK_METADATA` |
| `include/handlers.h` | Add handler declarations |
| `ircd/m_metadata.c` | New file: METADATA command handler |
| `ircd/parse.c` | Register METADATA command |
| `ircd/Makefile.in` | Add m_metadata.c |
| `include/client.h` | Add metadata structures |
| `include/channel.h` | Add channel metadata |
| `ircd/numeric.h` | Add new numerics |

---

## Implementation Phases

### Phase 1: Basic GET/SET (In-Memory)

1. Add capability and feature flag
2. Implement metadata storage structures
3. Implement GET, SET, LIST subcommands
4. In-memory only, no persistence

**Effort**: High (24-32 hours)

### Phase 2: Subscriptions

1. Add subscription tracking per client
2. Implement SUB, UNSUB, SUBS subcommands
3. Send notifications on changes

**Effort**: High (16-24 hours)

### Phase 3: Channel Metadata

1. Add metadata to channel structure
2. Permission checks (chanop only)
3. Propagate via P10

**Effort**: Medium (12-16 hours)

### Phase 4: Network Propagation

1. Add P10 MD command
2. Propagate user metadata changes
3. Propagate channel metadata changes

**Effort**: Medium (12-16 hours)

### Phase 5: X3 Integration

1. Store user metadata in X3
2. Sync on connect
3. Persist across reconnects

**Effort**: High (24-32 hours)

### Phase 6: Limits and Rate Limiting

1. Enforce max-keys, max-value-bytes
2. Add rate limiting
3. Cleanup unused subscriptions

**Effort**: Medium (8-12 hours)

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

1. **Visibility**: Public vs private metadata
2. **Rate limiting**: Prevent spam
3. **Size limits**: Prevent abuse
4. **Key restrictions**: Reserved keys
5. **Privacy**: Sensitive user information

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| Basic GET/SET | High | Medium |
| Subscriptions | High | High |
| Channel metadata | Medium | Medium |
| P10 propagation | Medium | Medium |
| X3 integration | High | High |
| Rate limiting | Medium | Low |

**Total**: Very High effort (96-132 hours)

---

## Recommendation

1. **Defer implementation**: Very complex specification
2. **Wait for spec stabilization**: Still draft, may change
3. **Consider simpler alternatives**: Bot-based metadata?
4. **If implementing**: Start with Phase 1-2 only

---

## Alternative: Bot-Based Metadata

Instead of server-side metadata:
1. Dedicated metadata bot
2. Uses standard PRIVMSG
3. Client-side rendering
4. No server changes needed

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| ObsidianIRC | Server |
| soju | Bouncer |

Limited adoption due to complexity.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/metadata
- **Related**: account-tag, bot-mode
- **Deprecated**: metadata-notify (incompatible)
