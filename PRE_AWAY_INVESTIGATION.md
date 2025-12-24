# IRCv3 Pre-Away Extension Investigation

## Status: INVESTIGATING (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/pre-away

**Capability**: `draft/pre-away`

---

## Specification Summary

The pre-away extension allows clients to set their away status before completing connection registration. This is useful for:
- Bouncers that reconnect on behalf of absent users
- Mobile clients that connect in background
- Aggregated presence across multiple connections
- Chathistory clients that fetch history without appearing online

---

## AWAY Command (Extended)

### Standard Format (Post-Registration)

```
AWAY                    # Mark as present
AWAY :Going to lunch    # Mark as away with message
```

### Pre-Registration Format

```
AWAY                    # Mark as present
AWAY *                  # Mark as away (unspecified reason)
AWAY :Going to lunch    # Mark as away with message
```

The `*` value indicates the connection is absent without a human-readable reason.

---

## Special `*` Semantics

When `AWAY *` is sent:
1. Server treats connection as if it doesn't exist for presence purposes
2. Server may substitute a human-readable message when relaying
3. `*` should not supersede other connections' away messages
4. Useful for aggregated presence (bouncer with multiple clients)

---

## Server Behavior

### Before Registration

When `draft/pre-away` is negotiated:
1. Accept `AWAY` command before connection completes
2. Store away state for later application
3. Apply state when registration completes

### After Registration

Same as standard away handling.

### Aggregation

For users with multiple connections:
- If any connection is present: user appears present
- If all connections are `*`: user appears away
- Non-`*` away messages take precedence

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `away-notify` | Complete |
| `monitor` | Existing |
| Pre-registration command handling | Partial (CAP only) |

---

## Implementation Architecture

### Client Registration Flow

```
C: CAP LS 302
S: CAP * LS :... draft/pre-away ...
C: CAP REQ :draft/pre-away
S: CAP * ACK :draft/pre-away
C: AWAY *                        <- NEW: Pre-registration AWAY
C: NICK bouncer-client
C: USER ...
S: 001 ...
```

### Connection State

```c
struct Connection {
    /* ... existing fields ... */
    int pre_away;           /* Pre-registration away state */
    char pre_away_msg[AWAYLEN + 1];  /* Pre-registration away message */
};
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_PREAWAY` |
| `include/ircd_features.h` | Add `FEAT_CAP_pre_away` |
| `ircd/ircd_features.c` | Register feature (default: FALSE) |
| `ircd/m_cap.c` | Add `draft/pre-away` to capability list |
| `ircd/m_away.c` | Accept AWAY before registration |
| `include/client.h` | Add pre-away state fields |
| `ircd/s_user.c` | Apply pre-away state after registration |

---

## Changes to m_away.c

Current behavior rejects pre-registration:
```c
int m_away(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
    if (!IsRegistered(sptr))
        return 0;  /* Silently ignore */
    /* ... */
}
```

New behavior:
```c
int m_away(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
    /* Allow pre-registration if pre-away negotiated */
    if (!IsRegistered(sptr)) {
        if (!HasCap(sptr, CAP_PREAWAY))
            return 0;
        return store_pre_away(sptr, parc > 1 ? parv[1] : NULL);
    }
    /* ... existing code ... */
}
```

---

## Pre-Away Storage

```c
static int store_pre_away(struct Client *sptr, const char *msg)
{
    struct Connection *con = cli_connect(sptr);

    if (!msg || !*msg) {
        /* AWAY with no params = present */
        con->pre_away = 0;
        con->pre_away_msg[0] = '\0';
    } else if (msg[0] == '*' && msg[1] == '\0') {
        /* AWAY * = away without message */
        con->pre_away = 2;  /* Special "hidden" away */
        con->pre_away_msg[0] = '\0';
    } else {
        /* AWAY :message = normal away */
        con->pre_away = 1;
        ircd_strncpy(con->pre_away_msg, msg, AWAYLEN);
    }
    return 0;
}
```

---

## Apply After Registration

In `register_user()` (s_user.c):

```c
/* Apply pre-away state if set */
if (con->pre_away) {
    if (con->pre_away == 2) {
        /* AWAY * - set away but don't broadcast */
        SetAway(sptr);
        /* Mark as "hidden" for presence aggregation */
    } else {
        /* Normal away */
        SetAway(sptr);
        ircd_strncpy(cli_away(sptr), con->pre_away_msg, AWAYLEN);
    }
}
```

---

## Presence Aggregation

For bouncers with multiple connections:

```c
int user_effective_away(struct User *user)
{
    struct SLink *link;
    int has_present = 0;
    int has_away = 0;
    char *best_msg = NULL;

    for (link = user->connections; link; link = link->next) {
        struct Client *cptr = link->value.cptr;
        if (!IsAway(cptr)) {
            has_present = 1;
        } else if (cli_away(cptr)[0]) {
            /* Has message, not AWAY * */
            has_away = 1;
            best_msg = cli_away(cptr);
        }
    }

    if (has_present)
        return 0;  /* At least one present connection */
    return has_away ? 1 : 2;  /* Away or hidden */
}
```

---

## Implementation Phases

### Phase 1: Pre-Registration AWAY

1. Add capability and feature flag
2. Modify m_away.c to accept pre-registration
3. Store pre-away state in connection
4. Apply state after registration

**Effort**: Low (8-12 hours)

### Phase 2: AWAY * Support

1. Add special handling for `*` value
2. Don't broadcast `*` to other users
3. Substitute message when relaying if needed

**Effort**: Low (4-8 hours)

### Phase 3: Presence Aggregation

1. Track multiple connections per user
2. Compute effective away state
3. Send appropriate away-notify

**Effort**: Medium (12-16 hours)

---

## Use Cases

### Bouncer Reconnection

```
C1 (active client):  CAP REQ :draft/pre-away
C1:                  NICK user
C1:                  USER ...
S:                   001 ...
C1:                  AWAY          <- Present

C2 (bouncer):        CAP REQ :draft/pre-away
C2:                  AWAY *        <- Away but hidden
C2:                  NICK user
C2:                  USER ...
S:                   001 ...

# User appears present (C1 is active)

C1 disconnects...

# Now user appears away (only C2, which is hidden)
```

### Chathistory Fetch

```
C:  CAP REQ :draft/pre-away chathistory
C:  AWAY *                    <- Don't notify anyone
C:  NICK user
C:  USER ...
S:  001 ...
C:  CHATHISTORY LATEST * 50   <- Fetch history
C:  QUIT                      <- Disconnect silently
```

---

## Configuration Options

```
features {
    "CAP_pre_away" = "TRUE";
    "AWAY_AGGREGATE" = "TRUE";   // Aggregate across connections
};
```

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| Pre-reg AWAY storage | Low | Low |
| Apply after registration | Low | Low |
| AWAY * handling | Low | Medium |
| Presence aggregation | Medium | Medium |

**Total**: Low-Medium effort (24-36 hours)

---

## Recommendation

1. **Implement Phase 1-2**: Basic pre-away and `*` support
2. **Skip aggregation initially**: Complex multi-connection tracking
3. **Low priority**: Bouncer-focused feature
4. **Feature flag disabled by default**

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| soju | Bouncer |
| Goguma | Client |

Limited client support; primarily bouncer-focused.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/pre-away
- **Related**: away-notify, monitor, chathistory
