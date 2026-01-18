# IRCv3 Spec Compliance Remediation Plan

Based on the audit in [ircv3-spec-compliance-audit.md](./ircv3-spec-compliance-audit.md), this plan categorizes all deviations and provides remediation steps.

---

## Categories

| Category | Description | Action |
|----------|-------------|--------|
| **FIX** | Clear spec violations that break client expectations | Implement fix |
| **CONFIG-GATE** | Behaviors that some users may want, add feature flag | Add toggle |
| **DOCUMENT** | Intentional deviations or permissive extensions | Document rationale |

---

## Summary Table

| Issue | Severity | Category | Effort | Status |
|-------|----------|----------|--------|--------|
| SASL AUTHENTICATE * abort | Medium | FIX | Medium (IAuth protocol extension) | ✅ Done |
| Labeled Response ACK missing | Medium | FIX | Medium | ✅ Done |
| Multiline blank lines in fallback | Low | FIX | Low | ✅ Done |
| Account-tag sends `*` for unauth | Low | FIX | Low | ✅ Done |
| Setname truncates vs FAIL | Low | CONFIG-GATE | Low | ✅ Done |
| CAP NEW/DEL not implemented | Low | FIX | Medium | ✅ Done |
| SASL ERR_NICKLOCKED not defined | Low | FIX | Trivial | ✅ Done |
| Multiline concat+blank validation | Low | FIX | Low | ✅ Done |
| SASL ERR_SASLALREADY for non-OAUTHBEARER | Low | FIX | Medium | ✅ Done |
| Metadata colon in keys | Very Low | FIX | Trivial | ✅ Done |
| Message Tags escaping pass-through | Very Low | DOCUMENT | N/A | - |
| Message Tags length limits | Low | FIX | Low | ✅ Done |
| Message Tags CLIENTTAGDENY | Low | FUTURE | Medium | Pending |

---

## FIX: SASL AUTHENTICATE * (abort)

**Severity**: Medium
**Location**: `ircd/m_authenticate.c:106+`
**Spec**: Client sends `AUTHENTICATE *` to abort, server MUST send 906 ERR_SASLABORTED
**Actual**: The `*` is forwarded to services as if it were a mechanism name

### Implementation

Add check at the start of `m_authenticate()` before any other processing:

```c
/* Check for AUTHENTICATE * (abort request) */
if (strcmp(parv[1], "*") == 0) {
  /* IAuth path needs explicit abort notification */
  if (auth_iauth_handles_sasl() && cli_saslcookie(cptr)) {
    auth_send_sasl_abort(cptr);  /* NEW: Need to implement */
  }
  return abort_sasl(cptr, 0);
}
```

The `abort_sasl()` function already:
- Sends 906 ERR_SASLABORTED to client
- Sends `SA ... D A` (Done/Abort) to X3/services via P10
- Cleans up local SASL state

**X3 Impact**: Already handled - `abort_sasl()` sends `SA ... D A`

**IAuth Impact**: NOT currently handled. Need to add:
1. New IAuth command `X <id> <ip> <port>` for SASL abort
2. `auth_send_sasl_abort()` function in `s_auth.c`
3. Handler in iauthd-ts to clean up session state

```c
/* New function in s_auth.c */
int auth_send_sasl_abort(struct Client *cptr)
{
  if (!IAuthHas(iauth, IAUTH_SASL))
    return 0;
  return sendto_iauth(cptr, "X");  /* X = SASL abort */
}
```

**Files to modify**:
- `ircd/m_authenticate.c` - Add abort check with IAuth notification
- `ircd/s_auth.c` - Add `auth_send_sasl_abort()` function
- `include/s_auth.h` - Declare new function
- `tools/iauthd-ts/src/iauth.ts` - Handle `X` command (optional, can just ignore)

**Test**: Send AUTHENTICATE * mid-flow, verify 906 ERR_SASLABORTED received

---

## FIX: Labeled Response ACK

**Severity**: Medium
**Location**: No current implementation
**Spec**: Server MUST send ACK when a labeled command produces no response
**Actual**: No ACK mechanism exists

### Implementation

1. Define new command/message format: `:server ACK`
2. Track whether a response was sent for a labeled command
3. At end of command processing, if labeled and no response, send ACK

This requires:

1. **New flag or counter** to track if response was sent during command processing
2. **New function** `send_labeled_ack(cptr)`
3. **Modification to command dispatch** to check after command completes

```c
/* In send.c or ircd_reply.c */
void send_labeled_ack(struct Client *cptr)
{
  if (!CapActive(cptr, CAP_LABELEDRESP) || EmptyString(cli_label(cptr)))
    return;

  sendrawto_one(cptr, "@label=%s :server ACK", cli_label(cptr));
}
```

**Commands that need ACK**:
- PONG (no normal response)
- Successfully delivered PRIVMSG/NOTICE without echo-message
- MODE with no changes
- Other commands that silently succeed

**Complexity note**: This is the most complex fix. May need to audit all commands that can complete without sending a reply.

**Files to modify**:
- `ircd/send.c` - Add send_labeled_ack()
- `ircd/parse.c` - Track response sent, call ACK after dispatch
- `include/send.h` - Declare function

---

## FIX: Multiline Blank Lines in Fallback

**Severity**: Low
**Location**: `ircd/m_batch.c:110-119` (send_multiline_fallback)
**Spec**: "Servers MUST NOT send blank lines" when delivering to non-multiline clients
**Actual**: All lines including blank ones are sent

### Implementation

```c
/* In send_multiline_fallback() - add check before sending */
for (lp = state->line_head; lp; lp = lp->next) {
  text = lp->value.cp + 1;  /* Skip concat flag byte */

  /* Skip blank lines per spec */
  if (*text == '\0')
    continue;

  /* Send the line */
  ...
}
```

**Files to modify**:
- `ircd/m_batch.c` - Add blank line check in send_multiline_fallback()

---

## FIX: Account-tag for Unauthenticated Users

**Severity**: Low
**Location**: `ircd/send.c:197-200`
**Spec**: "If the user is not identified to any services account, the tag MUST NOT be sent"
**Actual**: Sends `account=*` for unauthenticated users

### Implementation

Change from:

```c
if (IsAccount(from))
  pos += snprintf(buf + pos, buflen - pos, ";account=%s", cli_user(from)->account);
else
  pos += snprintf(buf + pos, buflen - pos, ";account=*");
```

To:

```c
if (IsAccount(from))
  pos += snprintf(buf + pos, buflen - pos, ";account=%s", cli_user(from)->account);
/* Per spec: omit account tag entirely if not authenticated */
```

**Files to modify**:
- `ircd/send.c` - Remove the `else` branch that sends `account=*`

---

## CONFIG-GATE: Setname Length Handling

**Severity**: Low
**Location**: `ircd/m_setname.c:129-130`
**Spec**: Return `FAIL SETNAME INVALID_REALNAME` if realname too long
**Actual**: Silently truncates to REALLEN characters

### Reasoning for CONFIG-GATE

Truncation is arguably more user-friendly - the realname change still works, just shortened. Some operators may prefer this behavior. Add a feature flag to choose.

### Implementation

```c
/* Add feature flag */
FEAT_SETNAME_STRICT_LENGTH  /* Default: 0 (truncate), 1 = FAIL per spec */

/* In m_setname() */
if (strlen(newname) > REALLEN) {
  if (feature_bool(FEAT_SETNAME_STRICT_LENGTH)) {
    if (CapActive(sptr, CAP_STANDARDREPLIES))
      send_fail(sptr, "SETNAME", "INVALID_REALNAME", NULL, "Realname too long");
    return 0;  /* Reject without processing */
  }
  newname[REALLEN] = '\0';  /* Legacy: truncate */
}
```

**Files to modify**:
- `include/ircd_features.h` - Add FEAT_SETNAME_STRICT_LENGTH
- `ircd/ircd_features.c` - Define feature (boolean, default 0)
- `ircd/m_setname.c` - Add conditional handling

---

## FIX: CAP NEW/DEL

**Severity**: Low
**Location**: `ircd/m_cap.c`
**Spec**: Servers MUST send CAP NEW when capability becomes available, CAP DEL when removed
**Actual**: No CAP NEW/DEL messages sent (cap-notify capability is defined but unused)

### Implementation

This requires:

1. **Detecting capability availability changes** (e.g., SASL server connects/disconnects)
2. **Sending CAP NEW/DEL to clients with cap-notify**

For SASL specifically:
- When services (X3) connects and sends SASL mechanism list: `CAP NEW :sasl`
- When services disconnects or stops advertising SASL: `CAP DEL :sasl`

```c
/* New function in m_cap.c or send.c */
void send_cap_notify(int capbit, int available)
{
  struct Client *cptr;
  const char *capname = /* lookup cap name from capbit */;

  for (cptr = GlobalClientList; cptr; cptr = cli_next(cptr)) {
    if (IsUser(cptr) && CapActive(cptr, CAP_CAPNOTIFY)) {
      if (available)
        sendrawto_one(cptr, "CAP * NEW :%s", capname);
      else
        sendrawto_one(cptr, "CAP * DEL :%s", capname);
    }
  }
}
```

**Trigger points**:
- `ircd/m_sasl.c` when services broadcasts mechanism list (NEW)
- `ircd/s_bsd.c` or equivalent when services server disconnects (DEL)

**Files to modify**:
- `ircd/m_cap.c` - Add send_cap_notify()
- `include/capab.h` - Declare function
- `ircd/m_sasl.c` - Call on mechanism broadcast
- Server disconnect handler - Call on services SQUIT

---

## FIX: ERR_NICKLOCKED (902) Definition

**Severity**: Low
**Location**: `include/numeric.h`
**Spec**: 902 ERR_NICKLOCKED for admin-locked accounts
**Actual**: Numeric not defined

### Implementation

Add to numeric.h:

```c
#define ERR_NICKLOCKED    902  /* SASL nick locked by admin */
```

Add to s_err.c replies array:
```c
/* 902 */
{ ERR_NICKLOCKED, "%s :You must use a nick associated with your account", "902" },
```

**Note**: This is only needed if services want to reject nick changes for locked accounts. Low priority since X3 may not use this.

**Files to modify**:
- `include/numeric.h` - Add #define
- `ircd/s_err.c` - Add to replies array

---

## FIX: Multiline Concat+Blank Validation

**Severity**: Low
**Location**: `ircd/m_batch.c` (add_message or batch validation)
**Spec**: Concat flag + blank line is prohibited
**Actual**: Not validated

### Implementation

When adding a message to a multiline batch, check:

```c
/* Reject concat flag on blank line */
if (has_concat_tag && EmptyString(message_text)) {
  if (CapActive(cptr, CAP_STANDARDREPLIES))
    send_fail(cptr, "BATCH", "INVALID_MULTILINE", NULL,
              "Cannot use concat tag on blank line");
  return 0;
}
```

**Files to modify**:
- `ircd/m_batch.c` - Add validation in message accumulation

---

## FIX: SASL ERR_SASLALREADY for Non-Refresh Mechanisms

**Severity**: Low
**Location**: `ircd/m_authenticate.c:125-139`
**Spec says**: Server MAY send 907 if reauthentication not allowed
**Current behavior**: Server allows ALL re-authentication by clearing SASL state
**Desired behavior**: Only allow re-auth for token-based mechanisms (OAUTHBEARER)

### Rationale

The current blanket allowance is too permissive:
- **OAUTHBEARER**: Re-auth makes sense (token refresh when expired)
- **PLAIN/EXTERNAL/SCRAM-***: Re-auth doesn't make sense - if you authenticated once, why authenticate again with the same credentials?

### Implementation

Track the mechanism used during initial auth, then check on re-auth attempt:

```c
/* In m_authenticate() - after checking IsSASLComplete(cptr) */
if (IsSASLComplete(cptr)) {
  /* Only OAUTHBEARER allows re-authentication (token refresh) */
  if (cli_saslmech(cptr) != SASL_MECH_OAUTHBEARER) {
    if (CapActive(cptr, CAP_STANDARDREPLIES))
      send_fail(cptr, "AUTHENTICATE", "ALREADY_AUTHENTICATED", NULL,
                "You have already authenticated");
    return send_reply(cptr, ERR_SASLALREADY);
  }

  /* OAUTHBEARER: Clear state and allow re-auth for token refresh */
  ClearSASLComplete(cptr);
  /* ... existing cleanup code ... */
}
```

This requires:
1. **Define ERR_SASLALREADY (907)** in numeric.h
2. **Track mechanism** - add `cli_saslmech` field or flag
3. **Define mechanism constants** (if not already)

**Alternative (simpler)**: Track if the mechanism was OAUTHBEARER specifically:

```c
/* Store OAUTHBEARER flag when auth succeeds */
if (mechanism == OAUTHBEARER)
  SetSASLRefreshable(cptr);

/* On re-auth attempt */
if (IsSASLComplete(cptr)) {
  if (!IsSASLRefreshable(cptr)) {
    return send_reply(cptr, ERR_SASLALREADY);
  }
  /* Clear and allow re-auth */
}
```

**Files to modify**:
- `include/numeric.h` - Add ERR_SASLALREADY (907)
- `ircd/s_err.c` - Add reply format
- `include/client.h` - Add FLAG_SASLREFRESHABLE (or cli_saslmech field)
- `ircd/m_authenticate.c` - Add mechanism check on re-auth
- `ircd/m_sasl.c` - Set refreshable flag when OAUTHBEARER succeeds

**Documentation** (still needed):
```markdown
### SASL Re-authentication

Nefarious sends 907 ERR_SASLALREADY when a client attempts to re-authenticate
using non-refreshable mechanisms (PLAIN, EXTERNAL, SCRAM-*).

Re-authentication IS allowed for OAUTHBEARER to support OAuth token refresh
when tokens expire during a session.
```

---

## FIX: Metadata Colon in Keys

**Severity**: Very Low
**Location**: `ircd/m_metadata.c:119`
**Spec says**: Keys may contain "a-z, 0-9, underscore, period, forward slash, or hyphen"
**Actual**: Also allows colon (:) for namespaced keys

### Rationale

Since metadata is a new feature with no existing deployments relying on colons, we can simply make it spec-compliant with no breaking changes.

The original motivation (hierarchical namespacing like `x3:chanserv:access`) can be achieved with spec-compliant alternatives:
- `x3/chanserv/access` (forward slash)
- `x3.chanserv.access` (period)

### Implementation

Remove colon from allowed characters:

```c
/* In is_valid_key() - m_metadata.c:119 */
/* Remove the case for ':' - it shouldn't be there */
/* Current code allows: a-z, 0-9, _, ., /, -, : */
/* Should allow:        a-z, 0-9, _, ., /, -     */
```

**Files to modify**:
- `ircd/m_metadata.c` - Remove colon from is_valid_key() allowed chars

---

## DOCUMENT: Message Tags Pass-through

**Status**: ACCEPTABLE DESIGN

**Location**: `ircd/parse.c:1396-1404`, `ircd/send.c:438-441`
**Spec says**: Servers MUST unescape incoming tags, MUST escape outgoing tags
**Actual**: Tags passed through verbatim

**Rationale**:
- IRCd doesn't interpret tag VALUES, only key names
- Client-only tags are just relayed, not processed
- Server-generated tags (time=, msgid=, account=) never contain escapable characters
- This is pragmatically correct for relay-focused behavior

---

## FIX: Message Tags Length Limits

**Severity**: Low
**Location**: `ircd/parse.c` (tag parsing)
**Spec says**: Max 8191 bytes total, 4094 bytes for client-only tags
**Actual**: No explicit enforcement

### Implementation

Add explicit length checking during tag parsing:

```c
/* In parse.c tag parsing section */
#define MAX_TAGS_LENGTH      8191  /* Total tags including server tags */
#define MAX_CLIENT_TAGS_LEN  4094  /* Client-only tags (+prefix) only */

/* During tag parsing */
size_t total_tags_len = 0;
size_t client_tags_len = 0;

/* For each tag parsed */
size_t tag_len = strlen(tag_start);
total_tags_len += tag_len + 1;  /* +1 for ; separator */

if (tag_start[0] == '+') {
  /* Client-only tag */
  client_tags_len += tag_len + 1;
  if (client_tags_len > MAX_CLIENT_TAGS_LEN) {
    /* Reject or truncate - spec doesn't specify behavior */
    /* Option 1: Reject entire message */
    return parse_error(cptr, "Client tags exceed 4094 byte limit");
    /* Option 2: Silently drop excess client tags */
  }
}

if (total_tags_len > MAX_TAGS_LENGTH) {
  return parse_error(cptr, "Tags exceed 8191 byte limit");
}
```

**Design decision needed**: What to do when limits exceeded?
1. **Reject entire message** - Strict, may break misbehaving clients
2. **Truncate/drop excess tags** - Permissive, message still delivered
3. **Config option** - Let operators choose

Recommendation: Option 2 (truncate) with logging, since spec doesn't mandate rejection.

**Files to modify**:
- `ircd/parse.c` - Add length tracking in tag parsing loop
- `include/ircd_defs.h` - Define MAX_TAGS_LENGTH, MAX_CLIENT_TAGS_LEN constants

---

## FUTURE: CLIENTTAGDENY Tag Blocking

**Severity**: Low (feature request, not compliance issue)
**Status**: Desirable feature for operators

### Use Cases

- **Spam prevention**: Block `+draft/react` if emoji reactions are abused
- **Privacy**: Block `+typing` if users complain about surveillance
- **Policy enforcement**: Block custom tags that violate network rules
- **Bandwidth**: Block verbose tags on resource-constrained networks

### Implementation

1. **Config option** for blocked tag prefixes:
   ```
   # In ircd.conf features block
   "CLIENTTAGDENY" = "+draft/react,+typing,+custom/*";
   ```

2. **Tag filtering** during relay:
   ```c
   /* In tag relay code */
   if (is_client_tag(tag) && is_tag_denied(tag))
     continue;  /* Skip this tag */
   ```

3. **ISUPPORT advertisement**:
   ```
   CLIENTTAGDENY=+draft/react,+typing,+custom/*
   ```

**Complexity**: Medium - requires config parsing, ISUPPORT generation, and tag filtering

**Files to modify**:
- `include/ircd_features.h` - Add FEAT_CLIENTTAGDENY (string list)
- `ircd/ircd_features.c` - Parse comma-separated list
- `ircd/parse.c` or `ircd/send.c` - Filter denied tags
- `ircd/s_user.c` - Add to ISUPPORT output

**Priority**: Phase 4 (after core compliance fixes)

---

## Implementation Priority

### Phase 1: Quick Wins (Low effort, clear benefit)

1. **Account-tag `*` removal** - ~3 lines, spec compliance
2. **Multiline blank lines in fallback** - ~3 lines, spec compliance
3. **ERR_NICKLOCKED definition** - ~5 lines, completeness
4. **ERR_SASLALREADY definition** - ~5 lines, needed for phase 2
5. **Metadata colon removal** - ~1 line, spec compliance

### Phase 2: Moderate Effort

6. **SASL AUTHENTICATE * abort** - ~20 lines + IAuth protocol extension
7. **Multiline concat+blank validation** - ~10 lines
8. **Setname CONFIG-GATE** - ~15 lines + feature flag
9. **SASL ERR_SASLALREADY for non-OAUTHBEARER** - ~20 lines + flag tracking
10. **Message Tags length limits** - ~15 lines, proper spec enforcement

### Phase 3: Complex

11. **Labeled Response ACK** - Requires audit of all commands
12. **CAP NEW/DEL** - Requires integration with services connect/disconnect

### Phase 4: New Features

13. **CLIENTTAGDENY tag blocking** - Config, filtering, ISUPPORT

### X3 / IAuth Coordination Required

Some fixes require corresponding X3 or IAuth changes:

| Fix | X3 Impact | IAuth Impact |
|-----|-----------|--------------|
| **SASL AUTHENTICATE * abort** | ✓ Already handled via `SA ... D A` | ✗ Needs new `X` abort command |
| **Metadata colon removal** | Audit for colon usage in keys | N/A |
| **SASL re-auth mechanism tracking** | Need to communicate mechanism used | Need to communicate mechanism used |
| **CAP NEW/DEL** | X3 SASL availability triggers CAP NEW | IAuth SASL availability triggers CAP NEW |

**Metadata colon audit needed**: Search X3 for any metadata keys using colons:
```bash
grep -r 'metadata.*:' x3/src/
grep -r 'MD.*:' x3/src/
```

If X3 uses colons, need to:
1. Update X3 to use `/` or `.` instead
2. Coordinate deployment (X3 first, then IRCd)

**SASL mechanism tracking options**:
1. **IRCd tracks**: Store initial `AUTHENTICATE <mechanism>` in client state (simpler)
2. **Services report**: X3/IAuth include mechanism in success response (cleaner but protocol change)

Recommendation: Option 1 (IRCd tracks) - no protocol changes needed.

**IAuth SASL abort**: New protocol command needed:
```
IRCd → iauthd: X <id> <ip> <port>   # SASL abort
```
iauthd-ts should handle this by cleaning up any pending SASL session state for that client.

### Documentation Updates

Update these files:
- `FEATURE_FLAGS_CONFIG.md` - Add new feature flags
- Create `docs/IRCV3_COMPLIANCE_NOTES.md` - Document intentional deviations

---

## Testing Requirements

Each fix should have a test case in `tests/`:

| Fix | Test |
|-----|------|
| SASL abort | Send AUTHENTICATE * mid-auth, verify 906 |
| SASL re-auth PLAIN | Auth with PLAIN, try re-auth, verify 907 |
| SASL re-auth OAUTHBEARER | Auth with OAUTHBEARER, re-auth succeeds (no 907) |
| Account-tag | Check message from unauthed user has no account tag |
| Multiline blank | Send multiline with blank, verify fallback omits blank |
| Setname strict | Enable flag, send long realname, verify FAIL |
| Labeled ACK | Send labeled PONG, verify ACK received |
| CAP NEW/DEL | Connect services, verify CAP NEW :sasl sent |
| Metadata colon | METADATA SET with colon in key, verify rejection |
| Tag length | Send >4094 bytes client tags, verify truncation/rejection |
| CLIENTTAGDENY | Configure blocked tag, send it, verify filtered |
