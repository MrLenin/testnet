# IRCv3 Pre-Away Extension Investigation

## Status: ✅ IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/pre-away

**Capability**: `draft/pre-away`

**Effort**: ~24-36 hours

**Priority**: Tier 1 - Small modification to existing m_away.c

---

## Why Low Effort?

- **Existing infrastructure**: AWAY command already implemented
- **Small change**: Allow AWAY before registration if capability negotiated
- **Store and apply**: Store pre-away state, apply after registration completes
- **Useful for bouncers**: Enables soju-style background connections

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
| Pre-registration command handling | Complete |

---

## Implementation Details

### Files Modified

| File | Changes |
|------|---------|
| `include/capab.h` | Added `CAP_DRAFT_PREAWAY` enum value |
| `include/ircd_features.h` | Added `FEAT_CAP_draft_pre_away` |
| `ircd/ircd_features.c` | Registered feature (default: TRUE) |
| `ircd/m_cap.c` | Added `draft/pre-away` to capability list |
| `include/client.h` | Added `con_pre_away` and `con_pre_away_msg` fields to Connection struct |
| `include/handlers.h` | Added `mu_away` declaration |
| `ircd/m_away.c` | Added `mu_away` handler for pre-registration AWAY |
| `ircd/parse.c` | Changed UNREG handler for AWAY from `m_unregistered` to `mu_away` |
| `ircd/s_user.c` | Apply pre-away state after registration completes |

### capab.h

```c
/* Added to enum Capab */
_CAP(DRAFT_PREAWAY, 0, "draft/pre-away", 0),
```

### client.h

```c
/* Added to struct Connection */
unsigned char       con_pre_away;   /**< Pre-registration away state: 0=none, 1=away, 2=away-star */
char                con_pre_away_msg[AWAYLEN + 1]; /**< Pre-registration away message */

/* Added accessor macros */
#define con_pre_away(con)       ((con)->con_pre_away)
#define con_pre_away_msg(con)   ((con)->con_pre_away_msg)
```

### m_away.c (new handler)

```c
int mu_away(struct Client* cptr, struct Client* sptr, int parc, char* parv[])
{
  struct Connection *con;
  char* away_message = (parc > 1) ? parv[1] : NULL;

  /* Require draft/pre-away capability */
  if (!HasCap(sptr, CAP_DRAFT_PREAWAY))
    return 0;  /* Silently ignore if capability not negotiated */

  con = cli_connect(sptr);

  if (EmptyString(away_message)) {
    /* AWAY with no params = present (clear pre-away) */
    con_pre_away(con) = 0;
    con_pre_away_msg(con)[0] = '\0';
  } else if (away_message[0] == '*' && away_message[1] == '\0') {
    /* AWAY * = away without message (special hidden state) */
    con_pre_away(con) = 2;
    con_pre_away_msg(con)[0] = '\0';
  } else {
    /* AWAY :message = normal away */
    con_pre_away(con) = 1;
    ircd_strncpy(con_pre_away_msg(con), away_message, AWAYLEN);
    con_pre_away_msg(con)[AWAYLEN] = '\0';
  }

  return 0;
}
```

### parse.c

```c
{
  MSG_AWAY,
  TOK_AWAY,
  0, MAXPARA, MFLG_SLOW, 0, NULL,
  /* UNREG, CLIENT, SERVER, OPER, SERVICE */
  { mu_away, m_away, ms_away, m_away, m_ignore },
  "[:<reason>] - Marks yourself as away, or back."
},
```

### s_user.c (register_user)

```c
/* Apply pre-away state if set (IRCv3 draft/pre-away) */
if (con_pre_away(cli_connect(sptr))) {
  if (con_pre_away(cli_connect(sptr)) == 2) {
    /* AWAY * - set away but with empty message (hidden connection) */
    if (!user->away) {
      user->away = (char*) MyMalloc(1);
      user->away[0] = '\0';
    }
    /* Don't broadcast AWAY * to servers - it's a hidden connection */
  } else {
    /* Normal away with message */
    unsigned int len = strlen(con_pre_away_msg(cli_connect(sptr)));
    if (user->away)
      MyFree(user->away);
    user->away = (char*) MyMalloc(len + 1);
    strcpy(user->away, con_pre_away_msg(cli_connect(sptr)));
    /* Broadcast to servers */
    sendcmdto_serv_butone(sptr, CMD_AWAY, cptr, ":%s", user->away);
  }
  /* Clear pre-away state */
  con_pre_away(cli_connect(sptr)) = 0;
  con_pre_away_msg(cli_connect(sptr))[0] = '\0';
}
```

---

## Configuration

```
features {
    "CAP_draft_pre_away" = "TRUE";  /* enabled by default */
};
```

To disable:
```
features {
    "CAP_draft_pre_away" = "FALSE";
};
```

---

## Example Flow

```
C: CAP LS 302
S: CAP * LS :... draft/pre-away ...
C: CAP REQ :draft/pre-away
S: CAP * ACK :draft/pre-away
C: AWAY *                        <- Pre-registration AWAY
C: NICK bouncer-client
C: USER ...
S: 001 ...
```

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

## Edge Cases

1. **Without capability**: Silently ignored (same as before)
2. **After registration**: Normal AWAY handling (m_away)
3. **AWAY * handling**: Sets away with empty message, not broadcast
4. **Multiple pre-away commands**: Last one wins

---

## Future Enhancement: Presence Aggregation

For bouncers with multiple connections, presence aggregation would compute effective away state across all connections. This is NOT implemented in the current version but could be added later.

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| soju | Bouncer |
| Goguma | Client |
| **Nefarious** | **Server (NEW)** |

Limited client support; primarily bouncer-focused.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/pre-away
- **Related**: away-notify, monitor, chathistory
