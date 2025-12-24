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

## Implementation Priority

### Tier 1: Essential for OAUTHBEARER (Do First)
1. CAP LS 302 with values (Phase 1)
2. cap-notify capability (Phase 2)
3. SASL mechanism advertisement (Phase 2)
4. REAUTHENTICATE command (Phase 2)

### Tier 2: Modern Client Compatibility
5. message-tags infrastructure (Phase 3)
6. server-time (Phase 4)
7. account-tag (Phase 6)
8. echo-message (Phase 5)

### Tier 3: Enhanced Features
9. labeled-response (Phase 7)
10. batch support (Phase 8)
11. chghost (Phase 9)
12. invite-notify (Phase 9)
13. setname (Phase 9)

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
| 10 | labeled-response | Client-side only | Medium |
| 11 | batch | Client-side only | Medium |
| 12 | setname | New SN command | Medium |
| 13 | message-tags S2S | **Major format change** | Very High |

---

## Tier 3 Detailed Analysis

### Key Insight: Client-Side vs S2S Distinction

Most Tier 3 features can be implemented **client-side only** without P10 protocol changes:

| Feature | Client-Side | S2S Required? | Notes |
|---------|-------------|---------------|-------|
| labeled-response | ✅ Track label per-command | ❌ No | Label only needs to echo back |
| batch | ✅ Wrap responses | ❌ No | Server generates batch markers locally |
| setname | ❌ Need to receive changes | ✅ Yes | Need SN command for network propagation |
| message-tags S2S | N/A | ✅ Yes | Only needed for cross-server tag relay |

**Recommendation**: Implement labeled-response and batch as client-side features first. Defer full S2S message tag infrastructure.

---

### Phase 10: Labeled-Response (Client-Side Only) ✅ COMPLETE

**Goal**: Allow clients to correlate commands with server responses using `@label` tag

**IRCv3 Spec**: https://ircv3.net/specs/extensions/labeled-response

**Flow**:
```
Client: @label=abc123 PRIVMSG #channel :hello
Server: @label=abc123 :nick!user@host PRIVMSG #channel :hello  (echo)
Server: @label=abc123 :server 001 nick :Welcome...           (if applicable)
```

**Files modified**:
- `nefarious/include/client.h` - Added `con_label[64]` field and `cli_label()` macro ✅
- `nefarious/ircd/parse.c` - Parse `@label=` from client input before command ✅
- `nefarious/ircd/send.c` - Added `format_message_tags_for()` and `sendcmdto_one_tags()` ✅
- `nefarious/include/send.h` - Added `sendcmdto_one_tags()` declaration ✅
- `nefarious/ircd/ircd_reply.c` - Modified `send_reply()` to include label+time tags ✅
- `nefarious/ircd/ircd_relay.c` - Updated echo-message calls to use `sendcmdto_one_tags()` ✅
- `nefarious/include/capab.h` - Added CAP_LABELEDRESP ✅
- `nefarious/include/ircd_features.h` - Added FEAT_CAP_labeled_response ✅
- `nefarious/ircd/ircd_features.c` - Registered feature (default: TRUE) ✅
- `nefarious/ircd/m_cap.c` - Added labeled-response to capability list ✅

**Implementation details**:
1. Label stored per-connection in `con_label[64]`
2. Label extracted from `@label=value` tag at start of client message
3. Label cleared at start of each new command
4. All `send_reply()` responses include label when client has capability
5. Echo-message uses `sendcmdto_one_tags()` to include label in echoed messages

**Feature flag**: `FEAT_CAP_labeled_response` (default: TRUE)

**P10 Impact**: None - labels are not propagated between servers

---

### Phase 11: Batch Support (Client-Side Only) ✅ COMPLETE

**Goal**: Group related server responses for client processing

**IRCv3 Spec**: https://ircv3.net/specs/extensions/batch

**Format**:
```
:server BATCH +abc123 type [params]
... messages with @batch=abc123 ...
:server BATCH -abc123
```

**Files modified**:
- `nefarious/include/capab.h` - Added CAP_BATCH ✅
- `nefarious/include/ircd_features.h` - Added FEAT_CAP_batch ✅
- `nefarious/ircd/ircd_features.c` - Registered feature (default: TRUE) ✅
- `nefarious/ircd/m_cap.c` - Added batch to capability list ✅
- `nefarious/include/client.h` - Added con_batch_id[16] and con_batch_seq ✅
- `nefarious/include/msg.h` - Added MSG_BATCH, TOK_BATCH, CMD_BATCH ✅
- `nefarious/include/send.h` - Added batch function declarations ✅
- `nefarious/ircd/send.c` - Added batch functions and @batch tag support ✅
- `nefarious/ircd/ircd_reply.c` - Updated send_reply() for batch support ✅

**Implementation details**:
1. Batch ID stored per-connection in `con_batch_id[16]`
2. Unique IDs generated using server numeric + sequence number
3. `send_batch_start(to, type)` - Sends BATCH +id with @label tag
4. `send_batch_end(to)` - Sends BATCH -id and clears batch ID
5. Messages within batch use @batch=id instead of @label

**Feature flag**: `FEAT_CAP_batch` (default: TRUE)

**P10 Impact**: None for client-side batching

**Future work**: Option B (S2S batch coordination) for netjoin/netsplit

---

### Phase 12: Setname ✅ COMPLETE

**Goal**: Allow users to change realname mid-session

**IRCv3 Spec**: https://ircv3.net/specs/extensions/setname

**Client Format**: `:nick!user@host SETNAME :New Real Name`

**P10 Token**: `SE` (note: `SN` was already taken by SVSNICK)

**P10 Format**:
```
[USER_NUMERIC] SE :[NEW_REALNAME]
```

**Files modified**:
- `nefarious/include/capab.h` - Added CAP_SETNAME ✅
- `nefarious/include/ircd_features.h` - Added FEAT_CAP_setname ✅
- `nefarious/ircd/ircd_features.c` - Registered feature (default: TRUE) ✅
- `nefarious/ircd/m_cap.c` - Added setname to capability list ✅
- `nefarious/include/msg.h` - Added MSG_SETNAME, TOK_SETNAME ("SE") ✅
- `nefarious/include/handlers.h` - Added m_setname, ms_setname declarations ✅
- `nefarious/ircd/m_setname.c` - New file: command handlers ✅
- `nefarious/ircd/parse.c` - Registered SETNAME command in msgtab ✅
- `nefarious/ircd/Makefile.in` - Added m_setname.c to build ✅

**Implementation details**:
1. Client sends `SETNAME :new realname` to local server
2. Server validates length (max REALLEN = 50 chars)
3. Server updates `cli_info(sptr)` with new realname
4. Server propagates `SE :[realname]` to all other servers via P10
5. Server notifies channel members who have `setname` capability via `sendcmdto_common_channels_capab_butone()`

**Feature flag**: `FEAT_CAP_setname` (default: TRUE)

**Services (X3) handling**: X3 can safely ignore SE command (informational only)

---

### Phase 13: Message Tags S2S - Detailed Architecture

**Goal**: Full server-to-server message tag propagation

**Status**: Planning - Very High Effort

---

#### Current P10 Format
```
[NUMERIC] [TOKEN] [PARAMS] :[TRAILING]
```
Example: `ABAAB P #channel :Hello world`

#### Proposed P10 Format with Tags
```
@tag1=val;tag2;+clienttag=val [NUMERIC] [TOKEN] [PARAMS] :[TRAILING]
```
Example: `@time=2025-01-15T12:30:00.000Z;msgid=AB-1705323000-42 ABAAB P #channel :Hello`

---

#### Tag Categories

| Category | Prefix | Propagation | Examples |
|----------|--------|-------------|----------|
| Server tags | (none) | Server generates, relay S2S | `@time`, `@msgid`, `@batch`, `@account` |
| Client-only tags | `+` | Client sends, relay S2S | `+typing`, `+reply`, `+react` |

---

#### P10 Protocol Changes Required

##### 1. New Message Format (Backward Compatible)

The tag prefix is **optional** - servers without tag support will ignore leading `@...` and parse from numeric.

**Compatibility strategy**:
- Tags MUST be valid UTF-8, no spaces, no NUL
- Tags separated by `;`
- Tag values after `=`, value-less tags allowed
- Tag section ends at first space
- Max tag section: 8191 bytes (IRCv3 spec)
- Max total message: 8191 (tags) + 512 (rest) = 8703 bytes

##### 2. New P10 Commands

**TAGMSG** - Tag-only message (no content)
```
Token: TM
Format: @+typing=active [USER_NUMERIC] TM [TARGET]
```
- Target can be channel (#channel) or user numeric
- Only relays client-only tags (prefixed with `+`)
- No message content

**S2S BATCH** - Coordinated batch markers (future)
```
Token: BT
Format: @batch=parentid [SERVER_NUMERIC] BT +batchid type [params]
        @batch=batchid [SERVER_NUMERIC] BT -batchid
```
- For netjoin/netsplit coordination
- Enables chat history batches

##### 3. Modified P10 Commands

Commands that need tag-aware variants:

| Command | Token | Tag Support Needed |
|---------|-------|-------------------|
| PRIVMSG | P | `@time`, `@msgid`, `@account`, `+client-tags` |
| NOTICE | O | `@time`, `@msgid`, `@account` |
| TAGMSG | TM | `+client-tags` (new command) |
| BATCH | BT | `@batch` reference (new command) |

---

#### Nefarious Implementation

##### Files to Modify

| File | Changes |
|------|---------|
| `parse.c` | Extract tags before numeric in `parse_server()` |
| `send.c` | Add `sendcmdto_serv_butone_tags()` variants |
| `client.h` | Add tag storage to message context |
| `msg.h` | Add MSG_TAGMSG, TOK_TAGMSG ("TM") |
| `m_tagmsg.c` | New file: TAGMSG handler |
| `m_privmsg.c` | Pass tags through relay |
| `ircd_relay.c` | Include tags in S2S relay |

##### New Data Structures

```c
/* Message tag structure */
struct MessageTag {
    char *key;           /* Tag name (without + prefix) */
    char *value;         /* Tag value (NULL if value-less) */
    int client_only;     /* 1 if prefixed with + */
    struct MessageTag *next;
};

/* Add to message parsing context */
struct MessageContext {
    struct MessageTag *tags;  /* Linked list of tags */
    char *msgid;              /* Cached msgid for this message */
};
```

##### Parser Changes (parse.c)

```c
/* In parse_server() - extract tags before numeric */
static struct MessageTag *extract_tags(char **bufptr) {
    char *s = *bufptr;
    struct MessageTag *tags = NULL;

    if (*s != '@')
        return NULL;

    s++;  /* Skip @ */
    char *tagend = strchr(s, ' ');
    if (!tagend)
        return NULL;

    *tagend = '\0';
    /* Parse tag1=val;tag2;+tag3=val */
    /* ... parsing logic ... */

    *bufptr = tagend + 1;  /* Advance past tags */
    return tags;
}
```

##### Send Function Changes (send.c)

```c
/* New tag-aware server send */
void sendcmdto_serv_butone_tags(struct Client *from, const char *cmd,
                                 const char *tok, struct Client *one,
                                 struct MessageTag *tags,
                                 const char *pattern, ...) {
    char tagbuf[8192];
    format_tags_for_server(tagbuf, sizeof(tagbuf), tags);
    /* Prepend tagbuf to message */
}

/* Format tags for S2S */
static void format_tags_for_server(char *buf, size_t buflen,
                                    struct MessageTag *tags) {
    int pos = 0;
    if (!tags) {
        buf[0] = '\0';
        return;
    }

    buf[pos++] = '@';
    for (struct MessageTag *t = tags; t; t = t->next) {
        if (pos > 1) buf[pos++] = ';';
        if (t->client_only) buf[pos++] = '+';
        pos += snprintf(buf + pos, buflen - pos, "%s", t->key);
        if (t->value)
            pos += snprintf(buf + pos, buflen - pos, "=%s", t->value);
    }
    buf[pos++] = ' ';
    buf[pos] = '\0';
}
```

---

#### X3 Implementation

##### Files to Modify

| File | Changes |
|------|---------|
| `proto-p10.c` | Extract tags in message parsing |
| `tools.c` | Update `split_line()` for tag prefix |
| `hash.c` | Store tags in message callbacks |
| `nickserv.c` | Ignore tags in SASL (no changes needed) |

##### Parser Changes (proto-p10.c)

```c
/* In parse_line() - extract tags before origin */
static dict_t extract_message_tags(char **line) {
    dict_t tags = NULL;
    char *s = *line;

    if (*s != '@')
        return NULL;

    tags = dict_new();
    s++;
    char *tagend = strchr(s, ' ');
    /* ... parse tags into dict ... */

    *line = tagend + 1;
    return tags;
}
```

##### Callback Changes

Most X3 message handlers can ignore tags. Only relevant for:
- Chat history (future feature)
- TAGMSG relay (if X3 needs to see typing indicators - unlikely)

---

#### Migration Strategy

##### Phase 13a: Parser Foundation ✅ COMPLETE
1. ✅ Add tag extraction to `parse_server()` - skip tags (backward compatible)
2. X3 `parse_line()` changes - not yet implemented (low priority)
3. ✅ Existing messages parse correctly when prefixed with tags

**Implementation**: Added tag skipping at start of `parse_server()` in parse.c.
Messages starting with `@tags ` have tags silently skipped, enabling backward
compatibility when other servers send tagged messages.

##### Phase 13b: TAGMSG with Client-Only Tags ✅ COMPLETE
1. ✅ Add MSG_TAGMSG/TOK_TAGMSG to msg.h
2. ✅ Implement m_tagmsg.c for local relay
3. ✅ Add con_client_tags[512] field for client-only tag storage
4. ✅ Extract +tag client-only tags in parse_client()
5. ✅ Add sendcmdto_one_client_tags() and sendcmdto_channel_client_tags()
6. ✅ S2S TAGMSG relay with client-only tags via P10 format: TM @+tag=val target
7. ✅ ms_tagmsg parses incoming @tags from first parameter

##### Phase 13c: PRIVMSG/NOTICE Tags ✅ COMPLETE
1. ✅ Generate `@time` and `@msgid` for outgoing messages
2. ✅ Pass tags through S2S relay via format_s2s_tags()
3. ✅ Preserve tags from remote servers in cli_s2s_time() and cli_s2s_msgid()
4. ✅ Modified sendcmdto_channel_butone() and sendcmdto_one() for S2S tags

**Files modified**: parse.c, client.h, send.c, ircd_features.h, ircd_features.c, msg.h, capab.h, m_tagmsg.c

**Build fixes**:
- Fixed circular dependency between capab.h and client.h
- Renamed MSG_BATCH to MSG_BATCH_CMD to avoid system header conflict

##### Phase 13d: S2S BATCH Command for Netjoin/Netsplit ✅ COMPLETE

**Goal**: Coordinate batch markers across servers for netjoin/netsplit events

**P10 Token**: `BT` (already defined as TOK_BATCH_CMD)

**P10 Format**:
```
[SERVER_NUMERIC] BT +batchid type [params]    # Start batch
[SERVER_NUMERIC] BT -batchid                   # End batch
```

**Batch Types**:
- `netjoin` - Server reconnecting, users rejoining channels
- `netsplit` - Server disconnecting, users quitting

**Implementation**:
1. ✅ Added ms_batch() server handler for BT command
2. ✅ Added S2S batch tracking fields to client.h (con_s2s_batch_id, con_s2s_batch_type)
3. ✅ Registered BATCH command for servers in parse.c
4. ✅ Added send_s2s_batch_start() and send_s2s_batch_end() to send.c
5. ✅ Propagate batch markers to local clients with batch capability

**Files modified**:
- `nefarious/include/handlers.h` - Added ms_batch declaration ✅
- `nefarious/ircd/m_batch.c` - New file: S2S BATCH handler ✅
- `nefarious/ircd/parse.c` - Registered BATCH command for servers ✅
- `nefarious/include/client.h` - Added S2S batch tracking fields ✅
- `nefarious/include/send.h` - Added S2S batch function declarations ✅
- `nefarious/ircd/send.c` - Added send_s2s_batch_start(), send_s2s_batch_end() ✅
- `nefarious/ircd/Makefile.in` - Added m_batch.c ✅

##### Phase 13e: Automatic Netjoin/Netsplit Batching ✅ COMPLETE

**Goal**: Automatically send IRCv3 batch markers to local clients during network events

**Implementation**:
- **Netjoin**: Server reconnects with 'J' flag (junction)
  - Batch start in `m_server.c` when `SetBurst/SetJunction` detected
  - Batch ID stored on `struct Server->batch_id`
  - Batch end in `m_endburst.c` when `END_OF_BURST` received
- **Netsplit**: Server disconnects via SQUIT
  - Batch start/end wraps `exit_downlinks()` in `s_misc.c`
  - Uses local variable for batch ID (immediate operation)

**New functions** (send.c):
- `send_netjoin_batch_start(server, uplink)` - Generates batch ID, stores on server struct
- `send_netjoin_batch_end(server)` - Sends BATCH -id, clears stored ID
- `send_netsplit_batch_start(server, uplink, batch_id_out, len)` - Returns batch ID via output param
- `send_netsplit_batch_end(batch_id)` - Sends BATCH -id

**Files modified**:
- `nefarious/include/struct.h` - Added `batch_id[32]` to struct Server
- `nefarious/include/send.h` - Added new function declarations
- `nefarious/ircd/m_server.c` - Call `send_netjoin_batch_start()` on junction
- `nefarious/ircd/m_endburst.c` - Call `send_netjoin_batch_end()` on END_OF_BURST
- `nefarious/ircd/s_misc.c` - Wrap `exit_downlinks()` with netsplit batch
- `nefarious/ircd/send.c` - Implement new functions

---

#### Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| Old server receives tagged message | Ignores `@...` prefix, parses from numeric |
| New server sends to old server | Can omit tags (feature flag) |
| Mixed network | Tags may be stripped at old server boundaries |

**Feature flag**: `FEAT_P10_MESSAGE_TAGS` (default: FALSE initially)

---

#### Tag Filtering Rules

Not all tags should propagate S2S:

| Tag | Propagate S2S? | Reason |
|-----|---------------|--------|
| `@time` | ✅ Yes | Preserve original timestamp |
| `@msgid` | ✅ Yes | Message deduplication |
| `@batch` | ✅ Yes | Coordinated batches |
| `@account` | ❌ No | Already have AC command |
| `@label` | ❌ No | Client-specific, not relayed |
| `+typing` | ✅ Yes | Client-only, relay to other servers |
| `+reply` | ✅ Yes | Client-only, relay to other servers |

---

#### Effort Estimate

| Component | Files | Complexity |
|-----------|-------|------------|
| Nefarious parser | parse.c | Medium |
| Nefarious send functions | send.c | High |
| Nefarious TAGMSG | new m_tagmsg.c | Medium |
| X3 parser | proto-p10.c, tools.c | Medium |
| Testing & debugging | - | High |

**Total**: Very High effort, estimated 40-60 hours of development

---

#### Why This Is Worth It

1. **Chat History**: Consistent `@msgid` and `@time` across network enables proper history playback
2. **Typing Indicators**: `+typing` can cross server boundaries
3. **Message Threading**: `+reply` tag enables threaded conversations
4. **Future Features**: Foundation for reactions, read receipts, etc.

---

#### Alternative: Minimal S2S Tags

If full implementation is too heavy, a minimal approach:

1. Only propagate `@msgid` and `@time` on PRIVMSG/NOTICE
2. Skip TAGMSG S2S entirely (typing only works locally)
3. Skip BATCH S2S (batches are server-local)

This gives 80% of the benefit with 40% of the effort.

---

## Tier 3 Recommended Implementation Order

Based on the analysis, here's the recommended order for Tier 3:

### Step 1: Labeled-Response ✅ COMPLETE
**Status**: Implemented
**Files modified**: parse.c, client.h, send.c, send.h, ircd_reply.c, ircd_relay.c, capab.h, ircd_features.h, ircd_features.c, m_cap.c

### Step 2: Batch - Option A ✅ COMPLETE
**Status**: Implemented
**Files modified**: capab.h, ircd_features.h, ircd_features.c, m_cap.c, client.h, msg.h, send.h, send.c, ircd_reply.c
**Note**: Future work - Option B (S2S coordination) for netjoin/netsplit batches

### Step 3: Setname ✅ COMPLETE
**Status**: Implemented
**Changes**: New SE P10 token, SETNAME client command handler (SN was taken by SVSNICK)
**Files modified**: msg.h, parse.c, handlers.h, new m_setname.c, capab.h, ircd_features.h, ircd_features.c, m_cap.c, Makefile.in

### Step 4: Message Tags S2S (High effort - Future)
**Why later**: High complexity, but needed for long-term goals
**Enables**:
- Chat history with cross-server message ordering
- Coordinated netjoin/netsplit batches (Option B)
**Changes**: Parse @tags in parse_server(), modify sendcmdto_serv_* functions, X3 parser changes
**Minimum tags**: @time, @msgid, @batch

---

## Phase 14: Bot Mode Tag Enhancement ✅ COMPLETE

**Goal**: Complete IRCv3 bot-mode compliance by adding `@bot` message tag

**IRCv3 Spec**: https://ircv3.net/specs/extensions/bot-mode

**Status**: ✅ Implemented

**Files modified**:
- `nefarious/ircd/send.c` - Added @bot to `format_message_tags()` and `format_message_tags_for_ex()`

**Implementation**:
- Added `@bot` tag (no value) to messages from users with +B mode
- Tag only sent to clients with message-tags capability (server-time, account-tag, etc.)

**P10 Impact**: None - bot status already propagates via user modes in NICK

---

## Phase 15: Standard Replies ✅ COMPLETE

**Goal**: Implement FAIL/WARN/NOTE structured replies

**IRCv3 Spec**: https://ircv3.net/specs/extensions/standard-replies

**Status**: ✅ Implemented

**Files modified**:
- `nefarious/include/capab.h` - Added CAP_STANDARDREPLIES
- `nefarious/include/ircd_features.h` - Added FEAT_CAP_standard_replies
- `nefarious/ircd/ircd_features.c` - Registered feature (default: TRUE)
- `nefarious/ircd/m_cap.c` - Added standard-replies to capability list
- `nefarious/include/send.h` - Added send_fail(), send_warn(), send_note() declarations
- `nefarious/ircd/send.c` - Implemented new send functions

**New functions**:
```c
void send_fail(struct Client *to, const char *command, const char *code,
               const char *context, const char *description);
void send_warn(struct Client *to, const char *command, const char *code,
               const char *context, const char *description);
void send_note(struct Client *to, const char *command, const char *code,
               const char *context, const char *description);
```

**Feature flag**: `FEAT_CAP_standard_replies` (default: TRUE)

**P10 Impact**: None - client-only feature

---

## Phase 16: Message IDs (msgid tag) ✅ COMPLETE

**Goal**: Add unique message IDs for deduplication and history

**IRCv3 Spec**: https://ircv3.net/specs/extensions/message-ids

**Status**: ✅ Implemented

**ID Generation Strategy**:
```
<server_numeric>-<startup_ts>-<counter>
```
Example: `AB-1703334400-12345`

**Files modified**:
- `nefarious/include/ircd.h` - Added MsgIdCounter global
- `nefarious/ircd/ircd.c` - Defined MsgIdCounter
- `nefarious/include/ircd_features.h` - Added FEAT_MSGID
- `nefarious/ircd/ircd_features.c` - Registered feature (default: TRUE)
- `nefarious/ircd/send.c` - Added `generate_msgid()` function and `format_message_tags_for_ex()` with msgid support

**Implementation**:
- `generate_msgid()` creates IDs using server numeric + startup time + counter
- `sendcmdto_one_tags()` auto-generates msgid for PRIVMSG/NOTICE commands
- `format_message_tags_for_ex()` accepts optional msgid parameter

**Feature flag**: `FEAT_MSGID` (default: TRUE)

**P10 Impact**: For S2S message tag propagation (deferred - Phase 13)

---

## Phase 17: TAGMSG Command ✅ COMPLETE

**Goal**: Implement TAGMSG for sending messages with only tags (no content)

**IRCv3 Spec**: https://ircv3.net/specs/extensions/message-tags

**Status**: ✅ Implemented

**P10 Token**: `TM`

**Files modified**:
- `nefarious/include/msg.h` - Added MSG_TAGMSG, TOK_TAGMSG ("TM")
- `nefarious/include/handlers.h` - Added m_tagmsg, ms_tagmsg declarations
- `nefarious/ircd/m_tagmsg.c` - New file: TAGMSG command handlers
- `nefarious/ircd/parse.c` - Registered TAGMSG command
- `nefarious/ircd/Makefile.in` - Added m_tagmsg.c

**Implementation**:
1. TAGMSG command sends tag-only messages to channels or users
2. Local relay to clients with message-tags capability
3. S2S relay using TM token (client-only tag propagation deferred to Phase 13b)

**Note**: Full client-only tag (`+typing`) propagation requires Phase 13b/c

---

## Phase 18: Typing Indicator (Tier 4) ✅ COMPLETE

**Goal**: Support `+typing` client-only tag

**IRCv3 Spec**: https://ircv3.net/specs/client-tags/typing

**Status**: ✅ Implemented (via TAGMSG infrastructure from Phase 13b/17)

---

### Tag Specification

**Tag Name**: `+typing` (client-only, prefixed with `+`)

**Values**:
| Value | Meaning |
|-------|---------|
| `active` | User is actively typing |
| `paused` | User stopped typing but has text in input |
| `done` | User cleared input without sending |

**Client Example**:
```
@+typing=active TAGMSG #channel
@+typing=paused TAGMSG nickname
@+typing=done TAGMSG #channel
```

---

### Implementation Status

All server-side requirements are met by existing TAGMSG infrastructure:

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Accept `+typing` tag on TAGMSG | ✅ | parse.c extracts client-only tags |
| Relay to channel members | ✅ | sendcmdto_channel_client_tags() |
| Relay to private message target | ✅ | sendcmdto_one_client_tags() |
| S2S propagation | ✅ | TM @+typing=active #channel |
| No server-side validation | ✅ | Tags passed through as-is |

**Files involved** (no changes needed):
- `ircd/parse.c` - Extracts `+typing=value` into cli_client_tags()
- `ircd/m_tagmsg.c` - Relays TAGMSG with client-only tags
- `ircd/send.c` - sendcmdto_channel_client_tags(), sendcmdto_one_client_tags()

---

### Client Behavior (per IRCv3 spec)

**Sending (client responsibility)**:
- Send `+typing=active` continuously while typing (throttled to every 3 seconds)
- Send `+typing=paused` once when user stops typing but text remains
- Send `+typing=done` once when text field cleared without sending
- Don't send for `/slash commands`

**Receiving (client responsibility)**:
- Assume typing continues until:
  - Message received from sender
  - Sender leaves/quits channel
  - `+typing=done` received
  - 30+ seconds since `paused` notification
  - 6+ seconds since `active` notification

---

### Supported Clients

Clients that support `+typing`:
- mIRC, WeeChat, IRCCloud, The Lounge, Textual, Quassel
- gamja, Goguma, Halloy, Kiwi IRC, senpai

---

### Testing

```
# Client sends (requires message-tags capability)
@+typing=active TAGMSG #test

# Other channel members with message-tags receive
@+typing=active;time=2025-12-23T12:00:00.000Z :nick!user@host TAGMSG #test

# Cross-server (P10)
ABAAB TM @+typing=active #test
```

---

### P10 Format

**Token**: `TM` (TAGMSG)

**Format**:
```
[USER_NUMERIC] TM @+typing=active [TARGET]
[USER_NUMERIC] TM @+typing=paused [TARGET]
[USER_NUMERIC] TM @+typing=done [TARGET]
```

Target can be channel name or user numeric

---

## Phase 19: Read Marker (Tier 4 - Draft) - DETAILED PLAN

**Goal**: Implement draft/read-marker for syncing read status across multiple client connections

**IRCv3 Spec**: https://ircv3.net/specs/extensions/read-marker (draft)

**Capability**: `draft/read-marker` (work-in-progress, not production ready)

**Status**: Planning complete, implementation deferred

---

### Specification Summary

The read-marker extension enables multiple clients of the same user to synchronize which messages have been read in each buffer (channel or query). This is primarily useful for:
- Bouncers serving multiple clients
- Servers with chathistory support
- Clearing notifications across devices

---

### MARKREAD Command Format

**Client → Server (Set):**
```
MARKREAD <target> timestamp=YYYY-MM-DDThh:mm:ss.sssZ
```
Signals that user has read messages up to the specified timestamp.

**Client → Server (Get):**
```
MARKREAD <target>
```
Requests the server's stored read timestamp for a target.

**Server → Client:**
```
MARKREAD <target> timestamp=YYYY-MM-DDThh:mm:ss.sssZ
```
Notifies client of the last read timestamp. Timestamp can be `*` if unknown.

---

### Server Behavior Requirements

1. **On JOIN**: After sending JOIN to client, MUST send MARKREAD for that channel BEFORE RPL_ENDOFNAMES (366)
2. **On MARKREAD from client**:
   - Validate timestamp format
   - Only accept if timestamp > stored timestamp (timestamps only increase)
   - Broadcast updated timestamp to ALL of user's connected clients
   - If client sends older timestamp, respond with current stored value
3. **Privacy**: MUST NOT disclose read markers to other users without explicit opt-in
4. **Persistence**: Should persist across reconnects (requires storage)

---

### Error Handling (using standard-replies)

| Error Code | Condition | Response |
|------------|-----------|----------|
| `NEED_MORE_PARAMS` | Missing target | `FAIL MARKREAD NEED_MORE_PARAMS :Missing target` |
| `INVALID_PARAMS` | Invalid target | `FAIL MARKREAD INVALID_PARAMS <target> :Invalid target` |
| `INVALID_PARAMS` | Bad timestamp format | `FAIL MARKREAD INVALID_PARAMS <target> :Invalid timestamp` |
| `INTERNAL_ERROR` | Storage failure | `FAIL MARKREAD INTERNAL_ERROR <target> :Could not save` |

---

### Implementation Architecture

#### Option A: In-Memory Only (Simpler)
- Store read markers in user's Client struct
- Lost on disconnect/restart
- Suitable for single-server, non-bouncer use

#### Option B: X3 Services Integration (Recommended)
- Store read markers in X3's database
- Persist across reconnects
- Requires new P10 command for sync

#### Option C: File-based Persistence
- Write to disk periodically
- Moderate complexity
- No X3 changes needed

---

### Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_READMARKER` |
| `include/ircd_features.h` | Add `FEAT_CAP_read_marker` |
| `ircd/ircd_features.c` | Register feature (default: FALSE - draft) |
| `ircd/m_cap.c` | Add `draft/read-marker` to capability list |
| `include/msg.h` | Add `MSG_MARKREAD`, `TOK_MARKREAD` ("MR") |
| `include/handlers.h` | Add `m_markread` declaration |
| `ircd/m_markread.c` | New file: MARKREAD command handler |
| `ircd/parse.c` | Register MARKREAD command |
| `ircd/Makefile.in` | Add m_markread.c |
| `include/client.h` | Add read marker storage (Option A) |
| `ircd/m_join.c` | Send MARKREAD after JOIN, before 366 |

---

### Data Structures (Option A - In-Memory)

```c
/* Read marker entry */
struct ReadMarker {
  char target[CHANNELLEN + 1];  /* Channel name or nick */
  char timestamp[32];            /* ISO 8601 timestamp */
  struct ReadMarker *next;
};

/* Add to struct User */
struct ReadMarker *read_markers;  /* Linked list of read markers */
```

---

### P10 Protocol (Option B - X3 Integration)

**New P10 Token**: `MR` (MARKREAD)

**Format**:
```
[USER_NUMERIC] MR <target> <timestamp>
```

**X3 Changes Required**:
- `proto-p10.c`: Handle MR command
- `nickserv.c` or new module: Store/retrieve read markers per account
- Database schema: New table for read markers

---

### Implementation Steps

#### Step 1: Basic In-Memory (Option A)
1. Add capability and feature flag
2. Implement m_markread.c with in-memory storage
3. Hook into m_join.c to send MARKREAD after JOIN
4. Test with single client

#### Step 2: Multi-Client Broadcast
1. Track all connections for a user (already exists via account)
2. On MARKREAD update, broadcast to all user's connections
3. Test with multiple clients same account

#### Step 3: Persistence (Option B/C)
1. Either add P10 MR command and X3 storage
2. Or implement file-based persistence
3. Test reconnect behavior

---

### Testing Plan

1. **Basic flow**: `CAP REQ draft/read-marker`, join channel, verify MARKREAD received
2. **Set marker**: Send `MARKREAD #channel timestamp=...`, verify echo
3. **Multi-client**: Connect two clients, update marker on one, verify other receives
4. **Timestamp validation**: Send invalid timestamp, expect FAIL response
5. **Ordering**: Send older timestamp, expect server to respond with current value
6. **JOIN behavior**: Join channel, verify MARKREAD arrives before 366

---

### Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability/command parsing | Low | Low |
| In-memory storage | Low | Low |
| Multi-client broadcast | Medium | Medium |
| JOIN hook | Low | Low |
| Persistence (X3) | High | Medium |
| Error handling | Low | Low |

**Total**: High effort primarily due to persistence requirements

---

### Recommendation

1. **Wait for spec to stabilize** - Still draft, may change
2. **Start with Option A** - In-memory only, no persistence
3. **Add Option B later** - X3 integration for proper persistence
4. **Feature flag disabled by default** - `FEAT_CAP_read_marker = FALSE`

---

### Software Compatibility

Clients/servers supporting draft/read-marker:
- **Servers**: Ergo, soju (bouncer)
- **Clients**: Halloy, gamja, Goguma

Note: Most major clients (IRCCloud, The Lounge, WeeChat) don't support it yet.

---

## Tier 4: Additional Features Summary

| Phase | Feature | Complexity | P10 Changes | Status |
|-------|---------|------------|-------------|--------|
| 14 | @bot message tag | Low | None | ✅ Complete |
| 15 | standard-replies | Medium | None | ✅ Complete |
| 16 | msgid tag | Medium | Deferred | ✅ Complete |
| 17 | TAGMSG command | Medium | TM token | ✅ Complete |
| 18 | +typing tag | Low | Via TAGMSG | ✅ Complete |
| 19 | draft/read-marker | High | MR token | 📋 Planned |

---

## Tier 4 Implementation Order

1. ✅ **@bot tag** (Phase 14) - Added to format_message_tags_for()
2. ✅ **standard-replies** (Phase 15) - send_fail/warn/note() functions
3. ✅ **msgid tag** (Phase 16) - generate_msgid() with unique IDs
4. ✅ **TAGMSG** (Phase 17) - Full client-only tag relay via TM token
5. ✅ **+typing** (Phase 18) - Works via TAGMSG infrastructure
6. 📋 **read-marker** (Phase 19) - Planned, defer until spec stabilizes

---

## Testing Strategy

### Tier 1 & 2 (Completed)
1. **CAP negotiation**: Test `CAP LS 302` response includes values
2. **SASL mechanisms**: Verify `sasl=PLAIN,EXTERNAL,OAUTHBEARER`
3. **Post-reg AUTHENTICATE**: Test mid-session token refresh with Keycloak
4. **Message tags**: Verify @time, @account formatting (client-side)
5. **Client compatibility**: Test with IRCCloud, The Lounge, WeeChat

### Tier 3 Testing
6. **labeled-response**: Send `@label=test PRIVMSG #chan :msg`, verify label echoed
7. **batch**: Test WHO response wrapped in batch markers
8. **setname**: Test `SETNAME :new name` propagates across servers
9. **Multi-server**: Verify setname SE command received by other servers

### Tier 4 Testing
10. **@bot tag**: Set +B mode, send message, verify `@bot` tag appears for message-tags clients
11. **standard-replies**: Test FAIL/WARN/NOTE responses from server
12. **msgid**: Verify unique `@msgid` tags on PRIVMSG/NOTICE
13. **TAGMSG**: Send `@+typing=active TAGMSG #channel`, verify relay to other clients
14. **+typing**: Test active/paused/done values relayed correctly
15. **read-marker**: Test MARKREAD command and response (draft)

---

## Compatibility Notes

- All features are opt-in via CAP negotiation
- Legacy clients (no CAP 302) get existing behavior
- P10 `R` subcmd for REAUTHENTICATE is additive (backward compatible)
- Message tags S2S can be deferred - implement client-side first
- Feature flags in ircd_features.h control each capability
- X3 keycloak-integration branch already has OAUTHBEARER support

---

## Phase 20: Standard Replies Usage ✅ COMPLETE

**Goal**: Use `send_fail()`/`send_warn()`/`send_note()` in new IRCv3 commands

**Status**: ✅ Implemented

**Functions exist at**: `nefarious/ircd/send.c:2180-2225`

### Implementation Completed

| File | Error Type | Standard Reply Sent |
|------|------------|---------------------|
| m_tagmsg.c | Missing target | `FAIL TAGMSG NEED_MORE_PARAMS :Missing target` |
| m_tagmsg.c | Invalid channel | `FAIL TAGMSG INVALID_TARGET <target> :No such channel` |
| m_tagmsg.c | Can't send | `FAIL TAGMSG CANNOT_SEND <target> :Cannot send to channel` |
| m_setname.c | Command disabled | `FAIL SETNAME DISABLED :SETNAME command is disabled` |
| m_setname.c | Missing realname | `FAIL SETNAME NEED_MORE_PARAMS :Missing realname` |
| m_authenticate.c | Message too long | `FAIL AUTHENTICATE TOO_LONG :SASL message too long` |
| m_authenticate.c | Service unavailable | `FAIL AUTHENTICATE SASL_FAIL :SASL service unavailable` |

### Implementation Pattern Used

```c
/* Check if client supports standard-replies, send both for compatibility */
if (CapActive(sptr, CAP_STANDARDREPLIES))
  send_fail(sptr, "TAGMSG", "NEED_MORE_PARAMS", NULL, "Missing target");
return send_reply(sptr, ERR_NEEDMOREPARAMS, "TAGMSG");
```

**P10 Impact**: None - client-only feature

---

## Phase 21: X3 Tag Parsing ✅ COMPLETE

**Goal**: Enable X3 to handle P10 messages with `@tags` prefix

**Status**: ✅ Implemented (Option A - Simple Skip)

### Implementation

Added to `parse_line()` in `x3/src/proto-p10.c:2872-2877`:

```c
/* Skip IRCv3 message tags if present (backward compatibility) */
if (line[0] == '@') {
    char *tag_end = strchr(line, ' ');
    if (tag_end)
        line = tag_end + 1;
}
```

### Behavior

- X3 can now receive P10 messages with `@tags` prefix
- Tags are silently skipped (X3 doesn't need tag data currently)
- Enables backward compatibility when Nefarious or other servers send tagged messages
- No functional change to X3's message handling

**P10 Impact**: X3 now tolerates but ignores message tags

---

## Phase 22: Dynamic SASL Mechanism List ✅ COMPLETE

**Goal**: Dynamically advertise SASL mechanisms based on backend availability

**Status**: ✅ Implemented

### Problem Solved

1. SASL mechanisms were hardcoded, not reflecting actual X3 capabilities
2. SASL was advertised even when services were offline
3. OAUTHBEARER was offered even when Keycloak was down

### Solution: New P10 SASL Subcmd `M` (Mechanisms)

**Direction**: X3 → Nefarious (broadcast)

**P10 Format**:
```
[X3_NUMERIC] SA * * M :[MECHANISM_LIST]
```

**Example**:
```
Az SA * * M :PLAIN,EXTERNAL,OAUTHBEARER
```

**Fields**:
| Field | Value | Meaning |
|-------|-------|---------|
| Target | `*` | Broadcast to all servers |
| Token | `*` | No specific client session |
| Subcmd | `M` | Mechanisms list |
| Data | `:PLAIN,EXTERNAL,OAUTHBEARER` | Comma-separated mechanism names |

### Nefarious Implementation

**Files modified**:
- `nefarious/include/ircd.h` - Added `SaslMechanisms[128]` global, `set_sasl_mechanisms()`, `get_sasl_mechanisms()`
- `nefarious/ircd/ircd.c` - Implemented mechanism storage functions
- `nefarious/ircd/m_sasl.c` - Added `M` subcmd handler in `ms_sasl()`
- `nefarious/ircd/m_cap.c` - Added `sasl_server_available()` check, use dynamic mechanism list

**Key Code** (`m_sasl.c:124-129`):
```c
if (!strcmp(parv[1], "*")) {
  /* Check for mechanism list broadcast: SASL * * M :PLAIN,EXTERNAL,... */
  if (!strcmp(token, "*") && reply[0] == 'M') {
    set_sasl_mechanisms(data);
    log_write(LS_SYSTEM, L_INFO, 0, "SASL mechanisms set to: %s", data);
  }
```

**Key Code** (`m_cap.c:50-61`):
```c
static int sasl_server_available(void)
{
  const char *sasl_server = feature_str(FEAT_SASL_SERVER);
  if (!strcmp(sasl_server, "*"))
    return (UserStats.servers > 0);
  return (find_match_server((char *)sasl_server) != NULL);
}
```

### X3 Implementation

**Files modified**:
- `x3/src/nickserv.h` - Added `nickserv_get_sasl_mechanisms()`, `nickserv_update_sasl_mechanisms()`
- `x3/src/nickserv.c` - Implemented mechanism functions with Keycloak availability tracking
- `x3/src/proto.h` - Added `irc_sasl_mechs_broadcast()` declaration
- `x3/src/proto-p10.c` - Implemented `irc_sasl_mechs_broadcast()`, call in `cmd_eob()`

**Key Code** (`nickserv.c:2410-2427`):
```c
const char *nickserv_get_sasl_mechanisms(void)
{
    static char mechs[128];
    strcpy(mechs, "PLAIN");
    strcat(mechs, ",EXTERNAL");
#ifdef WITH_KEYCLOAK
    if (nickserv_conf.keycloak_enable && keycloak_available)
        strcat(mechs, ",OAUTHBEARER");
#endif
    return mechs;
}
```

**Key Code** (`proto-p10.c:1273-1278`):
```c
void irc_sasl_mechs_broadcast(const char *mechs)
{
    /* Broadcast SASL mechanism list to all servers */
    putsock("%s " P10_SASL " * * M :%s", self->numeric, mechs);
}
```

### Dynamic Updates on Backend Availability Changes

**Keycloak Tracking** (`nickserv.c:5443-5452`):
```c
static void kc_set_available(int available)
{
    if (keycloak_available != available) {
        keycloak_available = available;
        log_module(NS_LOG, LOG_INFO, "Keycloak availability changed: %s",
                   available ? "available" : "unavailable");
        nickserv_update_sasl_mechanisms();
    }
}
```

**Change Detection** (`nickserv.c:2429-2441`):
```c
void nickserv_update_sasl_mechanisms(void)
{
    const char *mechs = nickserv_get_sasl_mechanisms();
    /* Only broadcast if mechanism list has changed */
    if (strcmp(mechs, last_sasl_mechs) != 0) {
        strcpy(last_sasl_mechs, mechs);
        irc_sasl_mechs_broadcast(mechs);
        log_module(NS_LOG, LOG_INFO, "SASL mechanisms updated: %s", mechs);
    }
}
```

### Workflow

1. **On X3 Connect**: After EOB, broadcasts `SASL * * M :PLAIN,EXTERNAL,OAUTHBEARER`
2. **On Keycloak Failure**: `kc_ensure_token()` fails → marks unavailable → broadcasts `SASL * * M :PLAIN,EXTERNAL`
3. **On Keycloak Recovery**: `kc_ensure_token()` succeeds → marks available → broadcasts `SASL * * M :PLAIN,EXTERNAL,OAUTHBEARER`
4. **Nefarious Receives**: Updates `SaslMechanisms[]` → next `CAP LS 302` shows correct list

### CAP LS Output

Before (static):
```
CAP LS :... sasl ...
```

After (dynamic, CAP 302):
```
CAP LS :... sasl=PLAIN,EXTERNAL,OAUTHBEARER ...
```

If Keycloak down:
```
CAP LS :... sasl=PLAIN,EXTERNAL ...
```

If services offline:
```
CAP LS :... (no sasl) ...
```

---

# P10 Protocol Reference

This section documents all P10 protocol changes implemented as part of the IRCv3.2+ upgrade.

---

## Complete P10 Token Summary

### New Tokens Added

| Token | Command | Direction | Purpose | Phase |
|-------|---------|-----------|---------|-------|
| `SE` | SETNAME | Both | Mid-session realname change | 12 |
| `TM` | TAGMSG | Both | Tag-only messages (typing, etc.) | 17 |
| `BT` | BATCH | Both | S2S batch coordination | 13d |

### Modified SASL Subcmds

| Subcmd | Direction | Purpose | Phase |
|--------|-----------|---------|-------|
| `M` | X3→Nef | Mechanism list broadcast | 22 |

### Existing Tokens (No Changes)

| Token | Command | Notes |
|-------|---------|-------|
| `SA` | SASL | Extended with `M` subcmd |
| `AC` | ACCOUNT | Already supports R/M/U types |
| `FA` | FAKEHOST | Used for chghost capability |
| `I` | INVITE | Used for invite-notify capability |

---

## SETNAME (SE) - Phase 12

**Purpose**: Allow users to change their realname (GECOS) mid-session

**IRCv3 Spec**: https://ircv3.net/specs/extensions/setname

### P10 Format

```
[USER_NUMERIC] SE :[NEW_REALNAME]
```

### Examples

```
# User ABAAB changes realname to "New Real Name"
ABAAB SE :New Real Name

# Server propagates to other servers
ABAAB SE :New Real Name
```

### Fields

| Field | Description |
|-------|-------------|
| `USER_NUMERIC` | 5-character numeric of the user changing realname |
| `NEW_REALNAME` | New realname string (max REALLEN=50 chars) |

### Nefarious Handling

**Client → Server** (`m_setname()` in `m_setname.c`):
1. Validate command enabled (`FEAT_CAP_setname`)
2. Validate parameter present and non-empty
3. Truncate to REALLEN if necessary
4. Update `cli_info(sptr)`
5. Propagate via P10 to other servers
6. Notify channel members with `setname` capability

**Server → Server** (`ms_setname()` in `m_setname.c`):
1. Validate sender is not a server
2. Truncate to REALLEN if necessary
3. Update `cli_info(sptr)`
4. Propagate to other servers
5. Notify local channel members with `setname` capability

### X3 Handling

X3 can safely ignore SE commands - they are informational only and don't affect account state.

### Client Notification Format

```
:nick!user@host SETNAME :New Real Name
```

Only sent to clients with `CAP_SETNAME` capability active.

---

## TAGMSG (TM) - Phase 17

**Purpose**: Send tag-only messages (no content) for typing indicators, reactions, etc.

**IRCv3 Spec**: https://ircv3.net/specs/extensions/message-tags

### P10 Format

```
[USER_NUMERIC] TM @[TAGS] [TARGET]
```

### Examples

```
# User ABAAB sends typing indicator to #channel
ABAAB TM @+typing=active #channel

# User ABAAB sends typing indicator to user BBAAC
ABAAB TM @+typing=paused BBAAC

# Multiple tags
ABAAB TM @+typing=active;+react=👍 #channel
```

### Fields

| Field | Description |
|-------|-------------|
| `USER_NUMERIC` | 5-character numeric of the sending user |
| `@TAGS` | Client-only tags prefixed with `+` (e.g., `@+typing=active`) |
| `TARGET` | Channel name (e.g., `#channel`) or user numeric (e.g., `BBAAC`) |

### Tag Format

Tags are semicolon-separated key=value pairs:
- Client-only tags MUST be prefixed with `+`
- Tag values are optional (e.g., `+typing` without value)
- Special characters in values should be escaped

### Common Tags

| Tag | Values | Purpose |
|-----|--------|---------|
| `+typing` | `active`, `paused`, `done` | Typing indicator |
| `+reply` | `msgid` | Reply to specific message |
| `+react` | emoji | Reaction to message |

### Nefarious Handling

**Client → Server** (`m_tagmsg()` in `m_tagmsg.c`):
1. Validate client has `message-tags` capability
2. Extract client-only tags from `cli_client_tags()`
3. Validate target exists and is accessible
4. Relay to local recipients with `message-tags` capability
5. Propagate via P10 to other servers

**Server → Server** (`ms_tagmsg()` in `m_tagmsg.c`):
1. Parse `@tags` from first parameter
2. Validate target
3. Relay to local recipients with `message-tags` capability
4. Propagate to other servers

### X3 Handling

X3 ignores TAGMSG - no action needed for typing indicators.

### Client Notification Format

```
@+typing=active;time=2025-12-23T12:00:00.000Z :nick!user@host TAGMSG #channel
```

Only sent to clients with `message-tags` capability active.

---

## BATCH (BT) - Phase 13d

**Purpose**: Coordinate batch markers across servers for netjoin/netsplit events

**IRCv3 Spec**: https://ircv3.net/specs/extensions/batch

### P10 Format

**Start Batch**:
```
[SERVER_NUMERIC] BT +[BATCH_ID] [TYPE] [PARAMS...]
```

**End Batch**:
```
[SERVER_NUMERIC] BT -[BATCH_ID]
```

### Examples

```
# Server AB starts netjoin batch for server CD
AB BT +AB1703334400 netjoin CD irc.example.com

# Server AB ends netjoin batch
AB BT -AB1703334400

# Server AB starts netsplit batch
AB BT +AB1703334401 netsplit CD irc.example.com

# Server AB ends netsplit batch
AB BT -AB1703334401
```

### Fields

| Field | Description |
|-------|-------------|
| `SERVER_NUMERIC` | 2-character numeric of the server |
| `+BATCH_ID` | Unique batch identifier (prefixed with `+` for start) |
| `-BATCH_ID` | Batch identifier (prefixed with `-` for end) |
| `TYPE` | Batch type: `netjoin` or `netsplit` |
| `PARAMS` | Type-specific parameters |

### Batch ID Format

```
[SERVER_NUMERIC][TIMESTAMP_OR_SEQUENCE]
```

Example: `AB1703334400` (server AB, timestamp-based)

### Batch Types

| Type | Params | Purpose |
|------|--------|---------|
| `netjoin` | `<server_numeric> <server_name>` | Server reconnecting |
| `netsplit` | `<server_numeric> <server_name>` | Server disconnecting |

### Nefarious Handling

**Automatic Netjoin Batching**:
1. `m_server.c`: Calls `send_netjoin_batch_start()` when junction detected
2. Batch ID stored in `struct Server->batch_id`
3. `m_endburst.c`: Calls `send_netjoin_batch_end()` on END_OF_BURST
4. All JOIN/MODE/etc. during burst include `@batch=id` tag for local clients

**Automatic Netsplit Batching**:
1. `s_misc.c`: Calls `send_netsplit_batch_start()` before `exit_downlinks()`
2. All QUIT messages include `@batch=id` tag for local clients
3. Calls `send_netsplit_batch_end()` after processing

**Server → Server** (`ms_batch()` in `m_batch.c`):
1. Parse batch start (+) or end (-)
2. Extract batch type and parameters
3. Store in `cli_server(cptr)->batch_id` for tracking
4. Propagate to other servers
5. Notify local clients with `batch` capability

### X3 Handling

X3 can ignore BT commands - batch markers are for client display only.

### Client Notification Format

**Batch Start**:
```
:server.name BATCH +ABC123 netjoin irc.remote.com
```

**Messages within batch**:
```
@batch=ABC123 :nick!user@host JOIN #channel
```

**Batch End**:
```
:server.name BATCH -ABC123
```

---

## SASL Mechanism Broadcast (SA M) - Phase 22

**Purpose**: Dynamically advertise available SASL mechanisms from services

**Note**: This is an extension of the existing SASL (SA) command, adding a new subcmd `M`.

### P10 Format

```
[X3_NUMERIC] SA * * M :[MECHANISM_LIST]
```

### Examples

```
# X3 (numeric Az) broadcasts all mechanisms
Az SA * * M :PLAIN,EXTERNAL,OAUTHBEARER

# X3 broadcasts without OAUTHBEARER (Keycloak down)
Az SA * * M :PLAIN,EXTERNAL
```

### Fields

| Field | Description |
|-------|-------------|
| `X3_NUMERIC` | Numeric of X3 services server |
| `*` (target) | Broadcast to all servers |
| `*` (token) | No specific client session |
| `M` | Mechanisms subcmd |
| `MECHANISM_LIST` | Comma-separated list of SASL mechanism names |

### Existing SASL Subcmds (Reference)

| Subcmd | Direction | Meaning |
|--------|-----------|---------|
| `S` | Nef→X3 | Start SASL (mechanism selection) |
| `H` | Nef→X3 | Host info (`user@host:ip`) |
| `C` | Both | Continue (auth data exchange) |
| `D` | X3→Nef | Done: `S`=success, `F`=fail, `A`=abort |
| `L` | X3→Nef | Login info (`account timestamp`) |
| `M` | X3→Nef | **NEW**: Mechanisms list broadcast |
| `I` | X3→Nef | Impersonation |

### Nefarious Handling

**Receive Mechanism Broadcast** (`ms_sasl()` in `m_sasl.c`):
```c
if (!strcmp(parv[1], "*") && !strcmp(token, "*") && reply[0] == 'M') {
    set_sasl_mechanisms(data);
}
```

**Use in CAP LS** (`send_caplist()` in `m_cap.c`):
```c
const char *mechs = get_sasl_mechanisms();
if (mechs)
    val_len = ircd_snprintf(0, valbuf, sizeof(valbuf), "=%s", mechs);
```

### X3 Handling

**Broadcast on Connect** (`cmd_eob()` in `proto-p10.c`):
```c
nickserv_update_sasl_mechanisms();
```

**Broadcast on Change** (`kc_set_available()` in `nickserv.c`):
```c
if (keycloak_available != available) {
    keycloak_available = available;
    nickserv_update_sasl_mechanisms();
}
```

### When Broadcasts Occur

1. After X3 completes burst (EOB acknowledgment)
2. When Keycloak availability changes (token refresh success/failure)
3. When any other backend availability changes (extensible)

---

## P10 Message Tags Support

### Overview

P10 messages can now optionally include IRCv3 message tags as a prefix:

```
@tag1=value;tag2;+clienttag=value [REST_OF_P10_MESSAGE]
```

### Backward Compatibility

- **Old servers**: Ignore `@...` prefix, parse from numeric (compatibility maintained)
- **New servers**: Can parse or skip tags based on feature flag
- **X3**: Skips tags silently (implemented in Phase 21)

### Tag Format

```
@[+]name[=value][;[+]name[=value]...]
```

- Server tags: no prefix (e.g., `time`, `msgid`)
- Client-only tags: `+` prefix (e.g., `+typing`, `+reply`)
- Tag values are optional
- Multiple tags separated by `;`

### Tag Propagation Rules

| Tag | Propagate S2S | Notes |
|-----|---------------|-------|
| `@time` | ✅ Yes | Preserve original timestamp |
| `@msgid` | ✅ Yes | Message deduplication |
| `@batch` | ✅ Yes | Coordinated batches |
| `@account` | ❌ No | Already have AC command |
| `@label` | ❌ No | Client-specific |
| `+typing` | ✅ Yes | Via TAGMSG only |
| `+reply` | ✅ Yes | Via TAGMSG only |

### Nefarious Implementation

**Parser** (`parse_server()` in `parse.c`):
```c
/* Skip IRCv3 message tags if present */
if (buffer[0] == '@') {
    char *tag_end = strchr(buffer, ' ');
    if (tag_end)
        buffer = tag_end + 1;
}
```

### X3 Implementation

**Parser** (`parse_line()` in `proto-p10.c`):
```c
/* Skip IRCv3 message tags if present */
if (line[0] == '@') {
    char *tag_end = strchr(line, ' ');
    if (tag_end)
        line = tag_end + 1;
}
```

---

## Active Network Batch Tracking

For automatic netjoin/netsplit batching, Nefarious maintains active batch state:

### Data Structures

**Per-Server** (`struct Server` in `struct.h`):
```c
char batch_id[32];  /* IRCv3 batch ID for netjoin/netsplit */
```

### Functions

```c
/* Start/end network batches */
void send_netjoin_batch_start(struct Client *server, struct Client *uplink);
void send_netjoin_batch_end(struct Client *server);
void send_netsplit_batch_start(struct Client *server, struct Client *uplink,
                                char *batch_id_out, size_t batch_id_len);
void send_netsplit_batch_end(const char *batch_id);

/* Active batch tracking for @batch tag inclusion */
void set_active_network_batch(const char *batch_id);
const char *get_active_network_batch(void);
```

### Workflow

**Netjoin**:
1. Server connects with junction flag → `send_netjoin_batch_start()`
2. Batch ID stored in `server->batch_id`
3. All user introductions include `@batch=id` for local clients
4. END_OF_BURST received → `send_netjoin_batch_end()`

**Netsplit**:
1. SQUIT received → `send_netsplit_batch_start()`
2. Batch ID returned via output parameter
3. All QUIT messages include `@batch=id` for local clients
4. Downlinks processed → `send_netsplit_batch_end()`

---

## Summary of P10 Changes by Phase

| Phase | Change | Impact |
|-------|--------|--------|
| 12 | Added SE (SETNAME) token | New command |
| 13a | Tag prefix skipping in parser | Compatibility |
| 13b | Added TM (TAGMSG) token | New command |
| 13d | Added BT (BATCH) token | New command |
| 13e | Automatic netjoin/netsplit batching | Integration |
| 21 | X3 tag prefix skipping | Compatibility |
| 22 | Added SA M (mechanisms) subcmd | Extended command |

---

## Backward Compatibility Matrix

| Scenario | Old Nefarious | New Nefarious | Old X3 | New X3 |
|----------|---------------|---------------|--------|--------|
| SE received | Ignored | Processed | Ignored | Ignored |
| TM received | Ignored | Processed | Ignored | Ignored |
| BT received | Ignored | Processed | Ignored | Ignored |
| SA M received | Ignored | Processed | N/A | Sent |
| Tagged message | Error (unlikely) | Parsed | Error | Parsed |

All changes maintain backward compatibility - old servers ignore unknown tokens.
