# IRCv3 Channel Rename Extension Investigation

## Status: IMPLEMENTED (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/channel-rename

**Capability**: `draft/channel-rename`

**Feature Flag**: `FEAT_CAP_draft_channel_rename` (disabled by default - draft spec)

---

## Implementation Status

Full implementation in Nefarious with P10 propagation and capability-aware fallback:

### Files Modified

| File | Changes |
|------|---------|
| `include/capab.h` | Added `CAP_DRAFT_CHANRENAME` capability |
| `include/ircd_features.h` | Added `FEAT_CAP_draft_channel_rename` |
| `ircd/ircd_features.c` | Feature registration (default: FALSE) |
| `ircd/m_cap.c` | `draft/channel-rename` capability |
| `include/msg.h` | `MSG_RENAME`, `TOK_RENAME` ("RN") |
| `include/handlers.h` | `m_rename`, `ms_rename` declarations |
| `ircd/m_rename.c` | New file: RENAME command handler |
| `ircd/parse.c` | Command registration |
| `ircd/Makefile.in` | Added m_rename.c |
| `include/hash.h` | Added `hChangeChannel()` declaration |
| `ircd/hash.c` | Added `hChangeChannel()` for hash table rename |
| `include/channel.h` | Added `rename_channel()` declaration |
| `ircd/channel.c` | Added `rename_channel()` function |

### X3 Files Modified

| File | Changes |
|------|---------|
| `src/hash.h` | Added `RenameChannel()` declaration, `rename_channel_func_t` callback |
| `src/hash.c` | Added `RenameChannel()` function and `reg_rename_channel_func()` |
| `src/proto-p10.c` | Added `CMD_RENAME`/`TOK_RENAME` and `cmd_rename()` P10 handler |
| `src/chanserv.c` | Added `handle_rename_channel()` callback for channel_info updates |

### Features Implemented

- RENAME command for channel operators
- Preserves all channel state (members, modes, topic, bans)
- P10 propagation to other servers via "RN" token
- X3 handles RN token and updates internal channel structures
- ChanServ channel registrations follow the renamed channel
- Fallback for non-supporting clients (PART/JOIN + state resend)
- standard-replies error handling
- Restriction: new name must not be longer than old name (memory allocation constraint)

### Configuration

To enable channel-rename (disabled by default):
```
features {
    "CAP_draft_channel_rename" = "TRUE";  /* Enable capability */
};
```

---

## Specification Summary

The channel-rename extension allows channel operators to rename channels while preserving all channel state including membership, modes, topic, and bans. This is useful for:
- Correcting typos in channel names
- Rebranding channels
- Case normalization

---

## RENAME Command

### Client to Server

**Syntax**: `RENAME <oldchannel> <newchannel> [:<reason>]`

| Parameter | Description |
|-----------|-------------|
| `<oldchannel>` | Current channel name |
| `<newchannel>` | New channel name |
| `<reason>` | Optional reason for rename (trailing) |

**Example**:
```
RENAME #OldName #newname :Correcting capitalization
```

### Server to Client

**Syntax**: `:nick!user@host RENAME <oldchannel> <newchannel> :<reason>`

Reason is always included (empty string if not provided).

---

## State Preservation

When a channel is renamed, the following MUST be preserved:
- All channel members and their modes (+o, +v, etc.)
- Channel modes (+n, +t, +k, etc.)
- Channel topic and topic metadata
- Ban list, invite list, exception list
- Any other channel state

---

## Error Responses

| Error Code | Condition |
|------------|-----------|
| `FAIL RENAME CHANNEL_NAME_IN_USE <old> <new>` | Target name already exists |
| `FAIL RENAME CANNOT_RENAME <old> <new>` | Server disallows this rename |
| `ERR_CHANOPRIVSNEEDED` (482) | User lacks operator privileges |
| `ERR_NOSUCHCHANNEL` (403) | Channel doesn't exist |
| `ERR_NOTONCHANNEL` (442) | User not on channel |

---

## Fallback for Non-Supporting Clients

For clients without the capability:
1. Send `PART <oldchannel> :Channel renamed to <newchannel>`
2. Send `JOIN <newchannel>`
3. Send standard join responses (RPL_TOPIC, RPL_NAMREPLY, etc.)

**Exception**: If rename only changes case, skip fallback (client likely handles this).

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `standard-replies` | Complete |
| Channel infrastructure | Existing |

---

## Implementation Architecture

### Network Propagation

Channel renames must propagate across all servers:

```
Client -> Server1 -> [P10] -> Server2
                  -> [P10] -> Server3
                            -> X3
```

### P10 Protocol Design

**New Token**: `RN` (RENAME)

**Format**:
```
[USER_NUMERIC] RN <oldchannel> <newchannel> :<reason>
```

**Example**:
```
ABAAB RN #OldName #newname :Correcting case
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_CHANRENAME` |
| `include/ircd_features.h` | Add `FEAT_CAP_channel_rename` |
| `ircd/ircd_features.c` | Register feature (default: FALSE) |
| `ircd/m_cap.c` | Add `draft/channel-rename` to capability list |
| `include/msg.h` | Add `MSG_RENAME`, `TOK_RENAME` ("RN") |
| `include/handlers.h` | Add `m_rename`, `ms_rename` declarations |
| `ircd/m_rename.c` | New file: RENAME command handler |
| `ircd/parse.c` | Register RENAME command |
| `ircd/Makefile.in` | Add m_rename.c |
| `ircd/channel.c` | Add `rename_channel()` function |
| `include/channel.h` | Declare `rename_channel()` |

---

## Core Implementation: rename_channel()

```c
int rename_channel(struct Channel *chptr, const char *newname)
{
    /* 1. Validate new name doesn't exist */
    /* 2. Remove from channel hash table */
    /* 3. Update chptr->chname */
    /* 4. Re-insert into hash table */
    /* 5. Update all member's channel lists */
    /* 6. Propagate to other servers via P10 */
    /* 7. Notify all members (capability-aware) */
    return 0;
}
```

---

## Fallback Implementation

For clients without `draft/channel-rename`:

```c
void send_rename_fallback(struct Client *cptr, struct Channel *oldch,
                          const char *newname, const char *reason)
{
    /* Send PART from old channel */
    sendcmdto_one(..., "PART", cptr, "%s :Channel renamed to %s%s%s",
                  oldch->chname, newname,
                  reason ? ": " : "", reason ? reason : "");

    /* Send JOIN to new channel */
    sendcmdto_one(..., "JOIN", cptr, "%s", newname);

    /* Send topic, names, etc. */
    send_topic_burst(cptr, chptr);
    send_channel_modes(cptr, chptr);
    do_names(cptr, chptr, NAMES_ALL);
}
```

---

## Channel Redirection (Optional)

The spec suggests optional tracking of renames for a cooldown period:

```c
struct ChannelRedirect {
    char oldname[CHANNELLEN + 1];
    char newname[CHANNELLEN + 1];
    time_t expires;
    struct ChannelRedirect *next;
};
```

When client tries to join old name:
```
FAIL JOIN CHANNEL_RENAMED <oldname> <newname> :Channel was renamed
```

---

## X3 Services Considerations

### ChanServ Impact

If ChanServ is registered to `#OldName`, it must be updated:
1. Option A: X3 automatically updates registration on rename
2. Option B: Require ChanServ deregistration before rename
3. Option C: Reject rename if channel is registered

### P10 Handling in X3

```c
/* In proto-p10.c */
static void handle_rename(struct userNode *source,
                          struct chanNode *chan,
                          const char *newname,
                          const char *reason)
{
    /* Update ChanServ registration if applicable */
    /* Log the rename */
}
```

---

## Implementation Phases

### Phase 1: Basic Rename (No Fallback)

1. Add capability and feature flag
2. Implement RENAME command (local only)
3. Add `rename_channel()` to channel.c
4. Update hash tables correctly

**Effort**: Medium (16-24 hours)

### Phase 2: Network Propagation

1. Add P10 RN token
2. Implement `ms_rename()` for S2S
3. Propagate to all servers

**Effort**: Medium (8-16 hours)

### Phase 3: Fallback for Legacy Clients

1. Detect clients without capability
2. Send PART/JOIN sequence
3. Re-send channel state

**Effort**: Medium (8-16 hours)

### Phase 4: X3 Integration ✅ COMPLETE

1. ✅ Handle RN in X3 - Added `cmd_rename()` P10 handler
2. ✅ Update ChanServ registrations - Via `handle_rename_channel()` callback
3. ✅ Maintain ban/access lists - `RenameChannel()` moves all channel data

**Implementation**: Uses callback pattern (`reg_rename_channel_func`) allowing ChanServ
to update the `channel_info->channel` back-pointer when the underlying chanNode is replaced.

---

## Edge Cases

1. **Case-only rename**: `#Channel` -> `#CHANNEL`
   - Hash table may need special handling
   - Fallback might not be needed

2. **Prefix change**: `#channel` -> `&channel`
   - Some servers may prohibit this

3. **Collision during netsplit**:
   - What if new name exists on another server?
   - Need collision resolution

4. **Services registration**:
   - How to handle registered channels?

---

## Security Considerations

1. **Privilege check**: Only chanops can rename
2. **Rate limiting**: Prevent rename spam
3. **Cooldown**: Prevent rename loops
4. **Reserved names**: Block rename to reserved channels

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| Basic rename | Medium | Medium |
| Hash table update | Medium | High |
| P10 propagation | Medium | Medium |
| Fallback messages | Medium | Low |
| X3 integration | High | High |

**Total**: High effort (48-80 hours for full implementation)

---

## Recommendation

1. **Implement Phase 1-2 first**: Basic rename with propagation
2. **Skip X3 integration initially**: Complex registration updates
3. **Feature flag disabled by default**: `FEAT_CAP_channel_rename = FALSE`
4. **Consider collision edge cases carefully**

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server support |
| soju | Bouncer support |
| Goguma | Client support |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/channel-rename
- **Related**: Channel modes, ChanServ
