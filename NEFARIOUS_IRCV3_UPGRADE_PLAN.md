# Nefarious IRCd: IRCv3.2+ Upgrade Plan

## Overview

Upgrade Nefarious IRCd from IRCv3.0/3.1 to full IRCv3.2+ compliance, including SASL improvements needed for OAUTHBEARER token refresh and modern protocol features for client compatibility.

---

## Current State

### Existing IRCv3 Capabilities (7 total)
| Capability | Status | Location |
|------------|--------|----------|
| `multi-prefix` | ✅ | CAP_NAMESX |
| `userhost-in-names` | ✅ | CAP_UHNAMES |
| `extended-join` | ✅ | CAP_EXTJOIN |
| `away-notify` | ✅ | CAP_AWAYNOTIFY |
| `account-notify` | ✅ | CAP_ACCNOTIFY |
| `sasl` | ✅ (3.0 style) | CAP_SASL |
| `tls` | ✅ (conditional) | CAP_TLS |

### Current SASL Limitations
- No mechanism values in CAP (`sasl` not `sasl=PLAIN,EXTERNAL`)
- No REAUTHENTICATE for mid-session re-auth (OAuth token refresh)
- No cap-notify for dynamic capability changes

### Key Source Files

**Nefarious IRCd:**
| Component | Path |
|-----------|------|
| CAP handler | `nefarious/ircd/m_cap.c` |
| CAP definitions | `nefarious/include/capab.h` |
| SASL P10 relay | `nefarious/ircd/m_sasl.c` |
| AUTHENTICATE cmd | `nefarious/ircd/m_authenticate.c` |
| Client struct | `nefarious/include/client.h` |
| Feature flags | `nefarious/include/ircd_features.h` |
| Send functions | `nefarious/ircd/send.c` |
| Message parsing | `nefarious/ircd/parse.c` |
| Command defs | `nefarious/include/msg.h` |

**X3 Services (for REAUTHENTICATE):**
| Component | Path |
|-----------|------|
| P10 protocol | `x3/src/proto-p10.c` |
| SASL handler | `x3/src/nickserv.c` (sasl_packet, handle_sasl_input) |
| Callback system | `x3/src/hash.c` |

---

## Implementation Phases

### Phase 1: CAP 302 Foundation

**Goal**: Support IRCv3.2 capability negotiation with values

**Files to modify**:
- `nefarious/include/client.h` - Add `cli_capab_version` field
- `nefarious/ircd/m_cap.c` - Parse version in CAP LS, output values for 302+

**Changes**:
1. Add version tracking to client structure:
   ```c
   unsigned short cli_capab_version;  // 0, 301, 302
   ```

2. Update `cap_ls()` to parse version parameter:
   ```c
   // CAP LS 302 -> version = 302
   if (caplist && *caplist)
       cli_capab_version(sptr) = atoi(caplist);
   ```

3. For version >= 302, output capability values:
   ```
   CAP LS :... sasl=PLAIN,EXTERNAL,OAUTHBEARER ...
   ```

4. Support multi-line CAP LS with `*` continuation

---

### Phase 2: SASL 3.2 Enhancements ✅ COMPLETE

**Goal**: Enable OAUTHBEARER token refresh via post-registration AUTHENTICATE

**Files modified**:
- `nefarious/include/capab.h` - Add CAP_CAPNOTIFY ✅
- `nefarious/ircd/m_cap.c` - Add cap-notify, mechanism values ✅
- `nefarious/ircd/m_authenticate.c` - Allow AUTHENTICATE after registration ✅
- `nefarious/ircd/m_sasl.c` - Send AC after successful reauth ✅
- `nefarious/include/client.h` - Add ClearSASLComplete macro ✅

**Changes**:

1. Add `cap-notify` capability: ✅ (for future CAP NEW/DEL, not required for reauth)

2. SASL mechanism advertisement in CAP value: ✅
   - Output `sasl=PLAIN,EXTERNAL,OAUTHBEARER` for CAP 302

3. Allow post-registration AUTHENTICATE: ✅
   - Remove `IsSASLComplete` blocker in m_authenticate.c
   - Reset SASL state (agent, cookie, timer) for new auth attempt
   - Add `ClearSASLComplete` macro to client.h
   - Reuse existing `S` subcmd - no P10 changes needed

4. Send AC after successful reauth: ✅
   - In m_sasl.c `D` handler success path, detect if user already registered
   - Send `AC` command to propagate account change network-wide
   - Uses correct format based on `FEAT_EXTENDED_ACCOUNTS` setting

---

### Phase 2.5: Server-Time Capability ✅ COMPLETE

**Goal**: Add ISO 8601 timestamps to messages for clients that request it

**Files modified**:
- `nefarious/include/capab.h` - Add CAP_SERVERTIME ✅
- `nefarious/include/ircd_features.h` - Add FEAT_CAP_server_time ✅
- `nefarious/ircd/ircd_features.c` - Register feature ✅
- `nefarious/ircd/m_cap.c` - Add server-time to capability list ✅
- `nefarious/ircd/send.c` - Add @time tag to channel messages ✅

**Implementation**:
1. Added `format_server_time()` helper function that outputs ISO 8601 timestamps:
   ```c
   @time=2025-12-23T12:30:00.123Z
   ```

2. Modified key send functions to build two message buffers:
   - One with `@time=` prefix for CAP_SERVERTIME clients
   - One without for legacy clients

3. Functions updated:
   - `sendcmdto_channel_butserv_butone()` - Channel messages (MODE, KICK, etc.)
   - `sendcmdto_channel_capab_butserv_butone()` - Capability-filtered channel messages
   - `sendcmdto_common_channels_butone()` - Common channel notifications (QUIT, NICK)
   - `sendcmdto_common_channels_capab_butone()` - Capability-filtered common channels
   - `sendcmdto_channel_butone()` - PRIVMSG/NOTICE to channels

**Feature flag**: `FEAT_CAP_server_time` (default: TRUE)

---

### Phase 3: Message Tags Infrastructure

**Goal**: Foundation for account-tag, echo-message, labeled-response (server-time implemented standalone)

**Files to modify**:
- `nefarious/include/capab.h` - Add CAP_MESSAGETAGS
- `nefarious/ircd/parse.c` - Parse `@tag=value;...` prefix
- `nefarious/ircd/send.c` - Add tag-aware send functions

**New structures**:
```c
struct MessageTag {
    char* key;
    char* value;
    int client_only;  // Prefixed with +
    struct MessageTag* next;
};
```

**New functions**:
```c
struct MessageTag* parse_message_tags(const char* line);
void free_message_tags(struct MessageTag* tags);
void sendcmdto_one_tags(..., struct MessageTag* tags, ...);
```

---

### Phase 4: Server-Time

**Goal**: Timestamp all messages for clients that request it

**Files to modify**:
- `nefarious/include/capab.h` - Add CAP_SERVERTIME
- `nefarious/ircd/send.c` - Add @time tag to messages

**Format**: `@time=2025-12-23T12:30:00.000Z`

---

### Phase 5: Echo-Message ✅ COMPLETE

**Goal**: Let clients receive their own sent messages back

**Files modified**:
- `nefarious/include/capab.h` - Add CAP_ECHOMSG ✅
- `nefarious/include/ircd_features.h` - Add FEAT_CAP_echo_message ✅
- `nefarious/ircd/ircd_features.c` - Register feature ✅
- `nefarious/ircd/m_cap.c` - Add echo-message to capability list ✅
- `nefarious/ircd/ircd_relay.c` - Echo PRIVMSG/NOTICE back to sender ✅

**Implementation**:
1. Added `CAP_ECHOMSG` capability and `FEAT_CAP_echo_message` feature flag

2. Modified relay functions to echo messages back to sender:
   - `relay_channel_message()` - Echo channel PRIVMSG
   - `relay_channel_notice()` - Echo channel NOTICE
   - `relay_private_message()` - Echo private PRIVMSG (with sptr != acptr check)
   - `relay_private_notice()` - Echo private NOTICE (with sptr != acptr check)

3. Each function checks:
   ```c
   if (feature_bool(FEAT_CAP_echo_message) && CapActive(sptr, CAP_ECHOMSG))
       sendcmdto_one(sptr, CMD_PRIVATE/NOTICE, sptr, ...);
   ```

4. For private messages, added `sptr != acptr` check to avoid duplicate when messaging self

**Feature flag**: `FEAT_CAP_echo_message` (default: TRUE)

---

### Phase 6: Account-Tag ✅ COMPLETE

**Goal**: Include sender's account in messages

**Files modified**:
- `nefarious/include/capab.h` - Add CAP_ACCOUNTTAG ✅
- `nefarious/include/ircd_features.h` - Add FEAT_CAP_account_tag ✅
- `nefarious/ircd/ircd_features.c` - Register feature ✅
- `nefarious/ircd/m_cap.c` - Add account-tag to capability list ✅
- `nefarious/ircd/send.c` - Add @account tag support ✅

**Implementation**:
1. Added `CAP_ACCOUNTTAG` capability and `FEAT_CAP_account_tag` feature flag

2. Refactored send.c tag handling:
   - Created `format_message_tags()` function that builds combined tag string
   - Created `wants_message_tags()` helper to check if client wants any tags
   - Renamed `mb_st` to `mb_tags` throughout for clarity

3. Tag format: `@time=...;account=accountname ` or `@time=...;account=* ` (not logged in)

4. Modified 5 send functions to use combined tags:
   - `sendcmdto_common_channels_butone()`
   - `sendcmdto_common_channels_capab_butone()`
   - `sendcmdto_channel_butserv_butone()`
   - `sendcmdto_channel_capab_butserv_butone()`
   - `sendcmdto_channel_butone()`

**Feature flag**: `FEAT_CAP_account_tag` (default: TRUE)

---

### Phase 7: Labeled-Response

**Goal**: Correlate commands with responses

**Files to modify**:
- `nefarious/include/capab.h` - Add CAP_LABELEDRESP
- `nefarious/include/client.h` - Add cli_label field
- `nefarious/ircd/parse.c` - Extract @label from commands
- `nefarious/ircd/send.c` - Include @label in responses

---

### Phase 8: Batch Support

**Goal**: Group related messages (netjoin, netsplit, history)

**Files to create**:
- `nefarious/ircd/m_batch.c` - BATCH command handler

**Files to modify**:
- `nefarious/include/capab.h` - Add CAP_BATCH
- `nefarious/ircd/parse.c` - Register BATCH

---

### Phase 9: Chghost ✅ COMPLETE

**Goal**: Notify clients when a user's host/username changes

**Files modified**:
- `nefarious/include/capab.h` - Add CAP_CHGHOST ✅
- `nefarious/include/ircd_features.h` - Add FEAT_CAP_chghost ✅
- `nefarious/ircd/ircd_features.c` - Register feature ✅
- `nefarious/ircd/m_cap.c` - Add chghost to capability list ✅
- `nefarious/include/msg.h` - Add CMD_CHGHOST ✅
- `nefarious/include/send.h` - Add SKIP_CHGHOST flag ✅
- `nefarious/ircd/send.c` - Handle SKIP_CHGHOST in send functions ✅
- `nefarious/ircd/s_user.c` - Send CHGHOST from hide_hostmask/unhide_hostmask ✅

**Implementation**:
1. Added `CAP_CHGHOST` capability and `FEAT_CAP_chghost` feature flag
2. Added `CMD_CHGHOST` to msg.h for the CHGHOST command
3. Added `SKIP_CHGHOST` flag to send.h for skipping clients with chghost capability
4. Modified `hide_hostmask()` and `unhide_hostmask()` in s_user.c:
   - Save old user/host before change
   - Send CHGHOST to clients with chghost capability
   - Skip CHGHOST clients when doing QUIT+JOIN workaround

**Format**: `:nick!olduser@old.host CHGHOST newuser new.host`

**Feature flag**: `FEAT_CAP_chghost` (default: TRUE)

**Note**: The P10 FAKEHOST (FA) command already exists for S2S host propagation.
The chghost capability is purely client-facing notification.

---

### Phase 10: Invite-Notify

**invite-notify** - Notify ops of channel invitations
```c
:inviter!u@h INVITE invited #channel
```

**setname** - Realname change notifications
```c
:nick!u@h SETNAME :New Real Name
```

---

## New Capability Defines (capab.h)

```c
// Add after existing caps
#define CAP_CAPNOTIFY    0x0080   // cap-notify
#define CAP_MESSAGETAGS  0x0100   // message-tags
#define CAP_SERVERTIME   0x0200   // server-time
#define CAP_ECHOMSG      0x0400   // echo-message
#define CAP_LABELEDRESP  0x0800   // labeled-response
#define CAP_ACCOUNTTAG   0x1000   // account-tag
#define CAP_BATCH        0x2000   // batch
#define CAP_CHGHOST      0x4000   // chghost
#define CAP_INVITENOTIFY 0x8000   // invite-notify
#define CAP_SETNAME      0x10000  // setname
```

---

## P10 Protocol Updates (CRITICAL)

### Current P10 SASL Message Format
```
SASL <target> <server>!<fd>.<cookie> <subcmd> <data> [ext]
```

### Existing Subcmd Codes

| Code | Direction | Meaning | Nefarious Handler |
|------|-----------|---------|-------------------|
| `S` | Nef→X3 | Start (mechanism selection) | Outbound only |
| `H` | Nef→X3 | Host info (`user@host:ip`) | Outbound only |
| `C` | Both | Continue (auth data) | ✅ m_sasl.c:178 |
| `D` | X3→Nef | Done (`S`=success, `F`=fail, `A`=abort) | ✅ m_sasl.c:197 |
| `L` | X3→Nef | Login (`handle timestamp`) | ✅ m_sasl.c:181 |
| `M` | X3→Nef | Mechanisms list | ✅ m_sasl.c:212 |

**Note**: X3 sends `I` (Impersonation) but Nefarious does not handle it - silently ignored.

### REAUTHENTICATE: Backwards-Compatible Approach

**Key Design Decision**: No new P10 subcmd needed. Reuse existing `S` (Start) subcmd.

The existing SASL P10 flow works for both pre-registration and post-registration auth.
The only difference is what happens after success:
- Pre-registration: Client completes registration normally
- Post-registration: Nefarious sends `AC` to propagate account change network-wide

### Nefarious Changes Required

**File**: `nefarious/ircd/m_authenticate.c`

Current blocker (line ~120):
```c
if (IsSASLComplete(cptr))
    return send_reply(cptr, ERR_SASLALREADY);
```

Changes needed:
1. Remove or modify the `IsSASLComplete` check to allow re-authentication
2. Reset SASL state for new auth attempt (clear cookie, generate new one)
3. Continue using `S` subcmd - no P10 protocol changes needed

**File**: `nefarious/ircd/m_sasl.c`

Changes needed (in `D` handler success path):
1. Detect if client is already registered (has been introduced via `N`)
2. If registered and account changed, send `AC` command network-wide
3. **Must check `FEAT_EXTENDED_ACCOUNTS`** to use correct format:
   ```c
   if (feature_bool(FEAT_EXTENDED_ACCOUNTS)) {
       // Extended: AC <user> <R|M> <account> [timestamp]
       sendcmdto_serv_butone(&me, CMD_ACCOUNT, NULL, "%C %c %s %Tu",
                             acptr, type, account, timestamp);
   } else {
       // Non-extended: AC <user> <account> [timestamp]
       sendcmdto_serv_butone(&me, CMD_ACCOUNT, NULL, "%C %s %Tu",
                             acptr, account, timestamp);
   }
   ```

### X3 Changes Required

**File**: `x3/src/nickserv.c`

Minimal changes - X3 already handles `S` subcmd correctly. The flow is:
1. Receive `S` with mechanism
2. Process auth (same as pre-registration)
3. Send `L` with account info
4. Send `D S` for success

X3 doesn't need to know if this is initial auth or reauth - the protocol is identical.

### REAUTHENTICATE Flow (End-to-End)

```
Client                Nefarious              X3                  Keycloak
   |                      |                   |                      |
   +--AUTHENTICATE------->|                   |                      |
   |  OAUTHBEARER         |                   |                      |
   |                      |-SASL S OAUTHBEARER|  (reuses S subcmd)   |
   |                      |-SASL H user@host  |                      |
   |                      |                   |                      |
   |<--AUTHENTICATE +-----|<--SASL C +--------|                      |
   |                      |                   |                      |
   +--AUTHENTICATE <jwt>->|                   |                      |
   |                      |--SASL C <jwt>---->|                      |
   |                      |                   |--introspect token--->|
   |                      |                   |<--token valid--------|
   |                      |                   |                      |
   |                      |<--SASL L account--|                      |
   |                      |<--SASL D S--------|                      |
   |                      |                   |                      |
   |<--904 LOGGEDIN-------|                   |                      |
   |<--903 SASLSUCCESS----|                   |                      |
   |                      |                   |                      |
   |                      |==AC user account==|  (broadcast if user  |
   |                      |                   |   already registered)|
```

### Key Implementation Details

1. **No New P10 Subcmd**: Reuse existing `S` - fully backwards compatible
2. **Session Reset**: Generate new cookie for each auth attempt
3. **Account Propagation**: Send `AC` after successful reauth for registered users
4. **Failure Handling**: On failure, client keeps existing account (if any)
5. **cap-notify NOT required**: REAUTHENTICATE works independently of cap-notify

---

## P10 Protocol Requirements by Feature

### Summary Table

| Feature | P10 Changes | Complexity | Notes |
|---------|-------------|------------|-------|
| REAUTHENTICATE | **None** | Low | Reuse existing `S` subcmd + send `AC` after |
| Message Tags | **Major redesign** | Very High | Fundamental format change |
| Account-tag | None | Low | Account already flows via `AC` |
| Server-time | None | Low | Timestamps exist in protocol |
| Echo-message | None | None | Pure client-side |
| Batch | New `BT` command | High | Needs message tags first |
| chghost | **Already exists** | None | `FA` (FAKEHOST) command |
| setname | New command | Medium | No mid-session realname change |
| invite-notify | None | Low | `I` (INVITE) already exists |

### Features Already Supported in P10

**CHGHOST / FAKEHOST** - Fully implemented:
```
[SERVER] FA [USER_NUMERIC] [HOSTNAME]
```
- X3: `irc_fakehost()` in `proto-p10.c` line 631
- Nefarious: `MSG_FAKE` / `TOK_FAKE` = "FA" in `msg.h`

**ACCOUNT** - Fully implemented:
```
[SERVER] AC [USER_NUMERIC] [ACCOUNT_NAME] [TIMESTAMP]
```
- Already propagates account changes S2S
- Subtypes: 'U' (unregister), 'R' (register), 'M' (modify)

**INVITE** - Fully implemented:
```
[FROM_NUMERIC] I [TARGET_NICK] [CHANNEL_NAME]
```
- invite-notify only needs client-side capability check

### Features Needing New P10 Commands

**SETNAME** - New command required:
```
[SERVER] SN [USER_NUMERIC] :[NEW_REALNAME]
```
- Currently realname is only sent in initial NICK
- No way to change mid-session
- Requires: msg.h definition, parse.c handler, proto-p10.c sender

**BATCH** - New command required:
```
[SERVER] BT +<batchid> <type> [params]
[SERVER] BT -<batchid>
```
- Needs message tags infrastructure first
- Use cases: netjoin, netsplit, chathistory

### Message Tags Infrastructure (Foundation)

**Current P10 format:**
```
[NUMERIC] [TOKEN] [PARAMS]
```

**With tags (proposed):**
```
@tag1=value;tag2 [NUMERIC] [TOKEN] [PARAMS]
```

**Impact:**
- Requires parser changes in both Nefarious and X3
- All `putsock()` calls in X3 need optional tag support
- All message handlers in Nefarious need tag extraction
- **Recommendation**: Implement tags as optional prefix, backward compatible

### Features That Are Pure Client-Side

These require NO P10 changes:
- **echo-message** - Server echoes to sender only
- **server-time** - Add @time tag at client delivery
- **account-tag** - Add @account tag at client delivery
- **labeled-response** - Track label per-client, add to responses

---

## Revised Implementation Priority

### Tier 1: OAUTHBEARER Token Refresh (Primary Goal)
| Step | Feature | P10 Changes | Effort | Status |
|------|---------|-------------|--------|--------|
| 1 | CAP LS 302 with values | None | Low | ✅ Done |
| 2 | cap-notify capability | None | Low | ✅ Done |
| 3 | SASL mechanism advertisement | None | Low | ✅ Done |
| 4 | Post-registration AUTHENTICATE | **None** (reuse `S`) | Low | ✅ Done |

### Tier 2: Quick Wins (No P10 Changes)
| Step | Feature | P10 Changes | Effort | Status |
|------|---------|-------------|--------|--------|
| 5 | server-time | None | Low | ✅ Done |
| 6 | echo-message | None | Low | ✅ Done |
| 7 | account-tag | None | Low | ✅ Done |
| 8 | chghost | None (FA exists) | Low | ✅ Done |
| 9 | invite-notify | None | Low | |

### Tier 3: P10 Infrastructure Required
| Step | Feature | P10 Changes | Effort |
|------|---------|-------------|--------|
| 9 | message-tags S2S | **Major format change** | Very High |
| 10 | labeled-response | Needs tags | High |
| 11 | batch | New BT command + tags | High |
| 12 | setname | New SN command | Medium |

---

## Testing Strategy

1. **CAP negotiation**: Test `CAP LS 302` response includes values
2. **SASL mechanisms**: Verify `sasl=PLAIN,EXTERNAL,OAUTHBEARER`
3. **REAUTHENTICATE**: Test mid-session token refresh with Keycloak
4. **P10 flow**: Verify existing `S` subcmd works for reauth, `AC` sent after
5. **Message tags**: Verify @time, @account formatting (client-side)
6. **Client compatibility**: Test with IRCCloud, The Lounge, WeeChat

---

## Compatibility Notes

- All features are opt-in via CAP negotiation
- Legacy clients (no CAP 302) get existing behavior
- **REAUTHENTICATE requires NO P10 changes** - reuses existing `S` subcmd
- `AC` command already exists for account propagation
- Message tags S2S can be deferred - implement client-side first
- Feature flags in ircd_features.h control each capability
- X3 keycloak-integration branch already has OAUTHBEARER support
