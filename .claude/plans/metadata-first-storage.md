# IRCv3 Metadata Exposure Plan

## Status: IMPLEMENTED

## Implementation Summary

**Completed 2026-01-18:**

1. **Account Profile Metadata** (`x3/src/nickserv.c`):
   - Added `nickserv_sync_profile_metadata_to_ircd()` function
   - Syncs x3.title, x3.registered, x3.karma (public) and x3.email, x3.lasthost (private) on auth
   - Called from `set_user_handle_info()` after user authenticates

2. **Infoline Metadata** (`x3/src/chanserv.c`):
   - Added `X3_META_INFOLINE_PREFIX` macro for `x3.infoline.` keys
   - Syncs infoline on USET INFO command in `user_opt_info()`
   - Syncs all infolines on auth in `handle_auth()` for each channel access

3. **Client SET Support** (`x3/src/nickserv.c`, `x3/src/proto-p10.c`):
   - Extended `handle_x3_preference_metadata()` to handle `x3.title`
   - Modified `nickserv_set_user_metadata()` to distinguish profile (public) vs preference (private) keys
   - Added infoline SET handling in `cmd_metadata()` for `x3.infoline.#channel` keys
   - Clients can now set their title via `METADATA SET * x3.title :My signature`
   - Clients can now set infolines via `METADATA SET * x3.infoline.#channel :Role description`

---

## Objective

Expose select account and channel data via IRCv3 METADATA protocol to encourage client ecosystem adoption and provide standards-compliant data access.

**Key insight**: This is NOT about changing storage. LMDB storage (via saxdb-optional branch) already works. This is about exposing user-facing data to compliant IRCv3 clients.

---

## Architecture

```
Three-Layer Model:

1. Storage Layer (unchanged):
   handle_info/chanData → LMDB → Keycloak (accounts)

2. Internal Transport (P10 MD/MDQ):
   X3 ↔ Nefarious - No spec constraints, can send any size

3. Client-Facing (IRCv3 METADATA):
   Clients query via METADATA GET - Must respect 300-byte limit
   Selective exposure of user-facing fields only
```

**Storage stays in LMDB** - The saxdb-optional branch already handles this.
**This plan is about the client-facing layer** - What do we expose via IRCv3?

---

## Why Expose via IRCv3 METADATA?

1. **Standards compliance** - Clients supporting `draft/metadata-2` can query user/channel info
2. **Ecosystem adoption** - More usable data encourages client developers to implement METADATA
3. **Discoverability** - Users can query profile info without needing X3 commands
4. **Modern IRC** - Align with where the protocol is heading

The internal P10 MD/MDQ protocol already handles all X3 state sync without spec constraints. This plan adds the user-facing client layer on top.

---

## Fields to Expose via IRCv3 METADATA

### Account Data (User Profile)

| Field | Metadata Key | Visibility | Client Use Case |
|-------|--------------|------------|-----------------|
| `epithet` | `x3.title` | **public** | User's custom title/signature, shown in WHO/WHOIS extensions |
| `registered` | `x3.registered` | **public** | Account age, trust indicator |
| `karma` | `x3.karma` | **public** | Reputation score, community standing |
| `email_addr` | `x3.email` | **private** | Self-access only, account recovery |
| `last_quit_host` | `x3.lasthost` | **private** | Self-access, device tracking |

**Why these fields?**
- `x3.title` - User-set, user wants it visible, analogous to away message
- `x3.registered` - Public record, used for trust assessment (older = more trusted)
- `x3.karma` - Reputation is meant to be public
- `x3.email` - Private but useful for account owner to verify
- `x3.lasthost` - Private, helps user know last login location

### Per-Channel User Data

| Field | Metadata Key | Visibility | Client Use Case |
|-------|--------------|------------|-----------------|
| `infoline` | `x3.infoline.#channel` | **public** | Shown on channel join, user's role description |

**Why infolines?**
- Already displayed publicly on JOIN (via ChanServ NOTICE)
- User-controlled content
- Per-channel scoping fits metadata key pattern perfectly
- Small values (typical infoline is 20-80 bytes)
- Encourages clients to show infolines natively instead of parsing NOTICEs

### Channel Data (Already Implemented)

These are already synced via P10 MD. Verify they're exposed to clients:

| Field | Metadata Key | Visibility | Status |
|-------|--------------|------------|--------|
| `registered` | `x3.registered` | **public** | ✅ Verify exposed |
| `registrar` | `x3.founder` | **public** | ✅ Verify exposed |
| `greeting` | `x3.greeting` | **public** | ✅ Verify exposed |
| `user_greeting` | `x3.user_greeting` | **public** | ✅ Verify exposed |
| `topic_mask` | `x3.topic_mask` | **public** | ✅ Verify exposed |
| `modes` | `x3.modes` | **public** | ✅ Verify exposed |

---

## Fields NOT to Expose

### Access Levels - NO

```
x3.access.#channel - NOT EXPOSED
```

**Rationale:**
- Internal security state - who can do what in a channel
- No client use case for querying another user's access level
- Users can check their own via `/msg ChanServ ACCESS #channel`
- Exposing would require careful authorization (only show your own)
- Complexity outweighs benefit

### Channel Bans - NO

```
x3.bans - NOT EXPOSED
```

**Rationale:**
- Would exceed 300-byte limit (20+ bans common, ~100 bytes each)
- Internal ChanServ state, not user-queryable data
- Clients don't need ban lists - they see MODE +b when they're ops
- Bans are operational, not informational

### Internal Flags - NO

```
x3.flags (account) - NOT EXPOSED
x3.flags (channel) - NOT EXPOSED
x3.olevel - NOT EXPOSED
```

**Rationale:**
- Internal bitmasks, meaningless to clients
- Security-sensitive (oper levels especially)
- No user-facing purpose

### Preferences - NO

```
x3.screen_width, x3.table_width, x3.style, etc. - NOT EXPOSED
```

**Rationale:**
- Internal X3 display preferences
- No client needs to query another user's X3 preferences
- Already work via P10 MD for X3's internal sync

### Authentication Data - NO

```
x3.fingerprints - NOT EXPOSED
x3.nicks - NOT EXPOSED
x3.pubkey - NOT EXPOSED
```

**Rationale:**
- Security-sensitive authentication material
- Fingerprints could enable targeted attacks
- Nick ownership is internal NickServ state

---

## Implementation

### Phase 1: Verify Existing Channel Exposure ✅

Channel metadata (x3.registered, x3.founder, x3.greeting, x3.topic_mask, x3.modes) is already synced via `chanserv_sync_x3_metadata()` and exposed to clients via IRCv3 METADATA GET.

### Phase 2: Add Account Profile Keys ✅

Extend `nickserv_sync_account_metadata_to_ircd()` to push profile data:

```c
// In nickserv.c

// Public profile fields
if (hi->epithet[0])
  irc_metadata(user, "x3.title", hi->epithet, METADATA_VIS_PUBLIC);

snprintf(buf, sizeof(buf), "%lu", hi->registered);
irc_metadata(user, "x3.registered", buf, METADATA_VIS_PUBLIC);

if (hi->karma) {
  snprintf(buf, sizeof(buf), "%d", hi->karma);
  irc_metadata(user, "x3.karma", buf, METADATA_VIS_PUBLIC);
}

// Private (self-only) fields
if (hi->email_addr)
  irc_metadata(user, "x3.email", hi->email_addr, METADATA_VIS_PRIVATE);

if (hi->last_quit_host[0])
  irc_metadata(user, "x3.lasthost", hi->last_quit_host, METADATA_VIS_PRIVATE);
```

### Phase 3: Add Infoline Keys ✅

When a user has an infoline set for a channel, sync it as metadata:

```c
// In chanserv.c - when infoline is set or user identifies

snprintf(key, sizeof(key), "x3.infoline.%s", chan->channel->name);
irc_metadata(user, key, uData->info, METADATA_VIS_PUBLIC);
```

**Key insight:** Infoline is per-channel-access, so it's stored on the user's metadata with the channel name in the key. This allows:
- `METADATA GET nick x3.infoline.#channel` - Get specific channel infoline
- `METADATA LIST nick x3.infoline.*` - List all infolines (if supported)

### Phase 4: Client SET Support ✅

Allow clients to set their own title and infolines via IRCv3 METADATA:

```
METADATA SET * x3.title :My custom signature
METADATA SET * x3.infoline.#channel :My role in this channel
```

X3 receives these via P10 MD, validates, and stores appropriately:
- `x3.title` → Stored in Keycloak user attributes
- `x3.infoline.#channel` → Stored in channel access record (userData->info)

**Infoline SET validation:**
- User must have channel access (registered and in access list)
- Length must not exceed channel's `maxsetinfo` setting
- No control characters allowed
- Set to `*` to clear

**Constraints:**
- Only for public profile fields user controls (x3.title, x3.infoline.*)
- Not for computed fields (x3.registered, x3.karma)

---

## Protocol Considerations

### 300-Byte Limit

All exposed values must fit within IRCv3's default `max-value-bytes=300`:

| Key | Typical Size | Max Size | Safe? |
|-----|--------------|----------|-------|
| x3.title | 30-80 bytes | 150 bytes | ✅ |
| x3.registered | 10 bytes | 10 bytes | ✅ |
| x3.karma | 5 bytes | 10 bytes | ✅ |
| x3.email | 30-60 bytes | 255 bytes | ✅ |
| x3.lasthost | 20-60 bytes | 100 bytes | ✅ |
| x3.infoline.#chan | 30-80 bytes | 200 bytes | ✅ |
| x3.greeting | 50-150 bytes | 300 bytes | ⚠️ Truncation possible |

For fields that might exceed 300 bytes (greetings), either:
1. Truncate at 300 bytes when exposing to clients
2. Rely on future chunking extension (see metadata-value-chunking.md)

### Visibility Enforcement

IRCv3 METADATA visibility is enforced at the IRCd level:
- **public** - Anyone can query
- **private** - Only the target user can query their own

X3 marks visibility when sending metadata to IRCd. IRCd enforces it.

---

## Testing

### Client Query Tests

1. **Public profile query** - Any user can `METADATA GET nick x3.title`
2. **Private profile query** - Only owner can `METADATA GET nick x3.email`
3. **Channel info query** - Any user can `METADATA GET #channel x3.founder`
4. **Infoline query** - Any user can `METADATA GET nick x3.infoline.#channel`

### Value Size Tests

5. **Long title** - Set 250-byte title, verify exposed correctly
6. **Long infoline** - Set 200-byte infoline, verify exposed correctly
7. **Truncation** - If value exceeds 300 bytes, verify graceful handling

### Sync Tests

8. **Title change** - User sets title via NickServ, verify METADATA updated
9. **Infoline change** - User sets infoline, verify METADATA updated
10. **Reconnect** - User reconnects, verify metadata re-synced

### Client SET Tests

11. **Title SET via METADATA** - `METADATA SET * x3.title :Test` updates profile
12. **Infoline SET via METADATA** - `METADATA SET * x3.infoline.#channel :Role` updates access record
13. **Infoline SET without access** - Should silently fail (user lacks channel access)
14. **Infoline SET too long** - Should silently fail if exceeds maxsetinfo
15. **Infoline clear via METADATA** - `METADATA SET * x3.infoline.#channel :*` clears infoline

---

## Files Modified

| File | Changes | Status |
|------|---------|--------|
| `x3/src/nickserv.c` | Added profile metadata sync, x3.title SET handling | ✅ Done |
| `x3/src/nickserv.h` | Added `nickserv_sync_profile_metadata_to_ircd()` declaration | ✅ Done |
| `x3/src/chanserv.c` | Added infoline metadata sync on set and auth | ✅ Done |
| `x3/src/proto-p10.c` | Added infoline SET handling in `cmd_metadata()` | ✅ Done |
| `nefarious/ircd/m_metadata.c` | Already handles client GET via LMDB cache | ✅ Verified |

---

## What This Plan Does NOT Change

- **Storage**: LMDB remains primary storage (saxdb-optional handles this)
- **P10 MD/MDQ**: Internal sync continues unchanged
- **Bans/access**: Stay in LMDB, not exposed via IRCv3
- **Preferences**: Stay internal to X3

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Storage | LMDB (no change) | LMDB (no change) |
| Internal sync | P10 MD/MDQ (no change) | P10 MD/MDQ (no change) |
| Client exposure | Limited | Profile + infolines via IRCv3 METADATA |
| Ecosystem benefit | None | Clients can use standard METADATA queries |

**Result**: Standards-compliant exposure of user-facing data that encourages IRCv3 client adoption while keeping storage and internal sync unchanged.
