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

### Phase 2: SASL 3.2 Enhancements

**Goal**: Enable OAUTHBEARER token refresh via REAUTHENTICATE

**Files to modify**:
- `nefarious/include/capab.h` - Add CAP_CAPNOTIFY
- `nefarious/ircd/m_cap.c` - Add cap-notify, mechanism values
- `nefarious/ircd/m_authenticate.c` - Add REAUTHENTICATE handler
- `nefarious/ircd/parse.c` - Register REAUTHENTICATE command

**Changes**:

1. Add `cap-notify` capability:
   ```c
   #define CAP_CAPNOTIFY  0x0080
   ```

2. SASL mechanism advertisement in CAP value:
   - Query services for mechanism list
   - Output `sasl=PLAIN,EXTERNAL,OAUTHBEARER` for CAP 302

3. Implement REAUTHENTICATE command:
   - Only for registered clients with cap-notify
   - Preserve existing auth until success
   - On success: update account, send ACCOUNT notification
   - On failure: keep existing auth state

4. CAP NEW/DEL notifications for cap-notify clients

---

### Phase 3: Message Tags Infrastructure

**Goal**: Foundation for server-time, account-tag, echo-message, etc.

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

### Phase 5: Echo-Message

**Goal**: Let clients receive their own sent messages back

**Files to modify**:
- `nefarious/include/capab.h` - Add CAP_ECHOMSG
- `nefarious/ircd/m_privmsg.c` - Echo back to sender

---

### Phase 6: Account-Tag

**Goal**: Include sender's account in messages

**Files to modify**:
- `nefarious/include/capab.h` - Add CAP_ACCOUNTTAG
- `nefarious/ircd/send.c` - Add @account tag

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

### Phase 9: Additional Capabilities

**chghost** - Host/ident change notifications
```c
:old!user@old.host CHGHOST newuser new.host
```

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

| Code | Direction | Meaning |
|------|-----------|---------|
| `S` | Nef→X3 | Start (mechanism selection) |
| `H` | Nef→X3 | Host info (`user@host:ip`) |
| `C` | Both | Continue (auth data) |
| `D` | X3→Nef | Done (`S`=success, `F`=fail, `A`=abort) |
| `L` | X3→Nef | Login (`handle timestamp`) |
| `M` | X3→Nef | Mechanisms list |
| `I` | X3→Nef | Impersonation |

### New Code for REAUTHENTICATE: `R`

**Purpose**: Allow re-authentication after initial SASL success (token refresh)

**Direction**: Nef→X3 (client-initiated via new REAUTHENTICATE command)

**Format**:
```
SASL <target> <server>!<fd>.<cookie> R <mechanism>
```

### Nefarious Changes Required

**File**: `nefarious/ircd/m_authenticate.c`

Current blocker (line ~121):
```c
if (IsSASLComplete(cptr))
    return send_reply(cptr, ERR_SASLALREADY);
```

Changes needed:
1. Add `m_reauthenticate()` handler that bypasses `IsSASLComplete` check
2. Clear SASL state but preserve account until new auth succeeds
3. Send `R` subcmd instead of `S` to signal reauth to services

**File**: `nefarious/ircd/m_sasl.c`

Changes needed:
1. Handle `R` response from services (mirror of `S` but for reauth)
2. On reauth success: update account, send ACCOUNT notification to channel members

### X3 Changes Required

**File**: `x3/src/nickserv.c` (`handle_sasl_input()` and `sasl_packet()`)

Changes needed:
1. Handle `R` subcmd in `handle_sasl_input()`
2. Track reauth state in `SASLSession` struct:
   ```c
   struct SASLSession {
       // ... existing fields ...
       int is_reauth;           // Flag for reauthentication
       char* old_account;       // Preserve until success
   };
   ```
3. On reauth success:
   - Compare old vs new account
   - Send `L` with new account info
   - Send `D S` for success
4. On reauth failure:
   - Keep old account active
   - Send `D F`

### REAUTHENTICATE Flow (End-to-End)

```
Client                Nefarious              X3                  Keycloak
   |                      |                   |                      |
   +--REAUTHENTICATE----->|                   |                      |
   |  OAUTHBEARER         |                   |                      |
   |                      |-SASL R OAUTHBEARER|                      |
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
   |                      |--ACCOUNT nick acc-| (to channel members) |
```

### Key Implementation Details

1. **Session Preservation**: During reauth, old session cookie is reused
2. **Account Continuity**: Old account remains valid until new auth succeeds
3. **Failure Handling**: On reauth failure, client stays logged in with old account
4. **ACCOUNT Notification**: After successful reauth, notify channel members if account changed

---

## P10 Protocol Requirements by Feature

### Summary Table

| Feature | P10 Changes | Complexity | Notes |
|---------|-------------|------------|-------|
| REAUTHENTICATE | New `R` subcmd | Medium | See above |
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
| Step | Feature | P10 Changes | Effort |
|------|---------|-------------|--------|
| 1 | CAP LS 302 with values | None | Low |
| 2 | cap-notify capability | None | Low |
| 3 | SASL mechanism advertisement | None | Low |
| 4 | REAUTHENTICATE command | New `R` subcmd | Medium |

### Tier 2: Quick Wins (No P10 Changes)
| Step | Feature | P10 Changes | Effort |
|------|---------|-------------|--------|
| 5 | server-time | None | Low |
| 6 | echo-message | None | Low |
| 7 | account-tag | None | Low |
| - | chghost | **Already done** (FA) | None |
| 8 | invite-notify | None | Low |

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
4. **P10 flow**: Verify SASL `R` subcmd flows correctly Nef↔X3
5. **Message tags**: Verify @time, @account formatting (client-side)
6. **Client compatibility**: Test with IRCCloud, The Lounge, WeeChat

---

## Compatibility Notes

- All features are opt-in via CAP negotiation
- Legacy clients (no CAP 302) get existing behavior
- P10 `R` subcmd for REAUTHENTICATE is additive (backward compatible)
- Message tags S2S can be deferred - implement client-side first
- Feature flags in ircd_features.h control each capability
- X3 keycloak-integration branch already has OAUTHBEARER support
