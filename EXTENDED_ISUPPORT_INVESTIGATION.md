# IRCv3 Extended-ISUPPORT Extension Investigation

## Status: ✅ IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/extended-isupport

**Capability**: `draft/extended-isupport`

**Effort**: ~16-28 hours

**Priority**: Tier 1 - Simple new command, reuses existing ISUPPORT infrastructure

---

## Why Low Effort?

- **Reuses existing code**: `send_supported()` already generates ISUPPORT
- **Simple command**: Just call existing function from new handler
- **Batch support**: Already implemented in Nefarious
- **No state management**: Stateless query/response

---

## Specification Summary

The extended-isupport extension allows clients to request the server's ISUPPORT (005) tokens before completing connection registration. This enables:
- Capability-aware connection setup
- Pre-registration feature discovery
- Better client configuration before joining channels

---

## ISUPPORT Command

### Client Request

```
ISUPPORT
```

Requests the server to send RPL_ISUPPORT (005) messages.

### Server Response

One or more RPL_ISUPPORT messages:

```
:server 005 * KEY1=value1 KEY2=value2 :are supported by this server
```

---

## Pre-Registration Behavior

When capability is negotiated:
1. Server MUST accept `ISUPPORT` command before registration
2. Server sends full ISUPPORT tokens

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `batch` | Complete |
| ISUPPORT infrastructure | Existing |

---

## Implementation Details

### Files Modified

| File | Changes |
|------|---------|
| `include/capab.h` | Added `CAP_DRAFT_EXTISUPPORT` enum value |
| `include/ircd_features.h` | Added `FEAT_CAP_draft_extended_isupport` |
| `ircd/ircd_features.c` | Registered feature (default: TRUE) |
| `ircd/m_cap.c` | Added `draft/extended-isupport` to capability list |
| `include/msg.h` | Added `MSG_ISUPPORT`, `TOK_ISUPPORT`, `CMD_ISUPPORT` |
| `include/handlers.h` | Added `m_isupport` declaration |
| `ircd/m_isupport.c` | **New file**: ISUPPORT command handler |
| `ircd/parse.c` | Registered ISUPPORT command with `MFLG_UNREG` |
| `ircd/Makefile.in` | Added m_isupport.c |

### capab.h

```c
/* Added to enum Capab */
_CAP(DRAFT_EXTISUPPORT, 0, "draft/extended-isupport", 0),
```

### msg.h

```c
#define MSG_ISUPPORT            "ISUPPORT"
#define TOK_ISUPPORT            "IS"
#define CMD_ISUPPORT            MSG_ISUPPORT, TOK_ISUPPORT
```

### m_isupport.c (new file)

```c
int m_isupport(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
  /* Check if capability negotiated */
  if (!HasCap(sptr, CAP_DRAFT_EXTISUPPORT))
    return send_reply(sptr, ERR_UNKNOWNCOMMAND, "ISUPPORT");

  /* Send ISUPPORT - reuses existing infrastructure from s_user.c */
  send_supported(sptr);

  return 0;
}
```

### parse.c

```c
{
  MSG_ISUPPORT,
  TOK_ISUPPORT,
  0, MAXPARA, MFLG_SLOW | MFLG_UNREG, 0, NULL,
  /* UNREG, CLIENT, SERVER, OPER, SERVICE */
  { m_isupport, m_isupport, m_ignore, m_isupport, m_ignore },
  "- Returns ISUPPORT tokens (requires draft/extended-isupport cap)"
},
```

---

## Configuration

```
features {
    "CAP_draft_extended_isupport" = "TRUE";  /* enabled by default */
};
```

To disable:
```
features {
    "CAP_draft_extended_isupport" = "FALSE";
};
```

---

## Example Flow

```
C: CAP LS 302
S: CAP * LS :... draft/extended-isupport batch ...
C: CAP REQ :draft/extended-isupport
S: CAP * ACK :draft/extended-isupport
C: ISUPPORT
S: 005 * NETWORK=AfterNET NICKLEN=30 CHANNELLEN=50 ... :are supported by this server
S: 005 * CHANTYPES=#& PREFIX=(ohv)@%+ ... :are supported by this server
C: NICK user
C: USER user 0 * :Real Name
S: 001 ...
```

---

## Use Cases

### Early Capability Discovery

```
C: CAP REQ :draft/extended-isupport
S: CAP * ACK :draft/extended-isupport
C: ISUPPORT
S: 005 * NICKLEN=30 CHANNELLEN=50 ...

# Client now knows limits before sending NICK
C: NICK a_valid_length_nickname
```

### Network Icon Before Connect

With `draft/ICON`:
```
C: CAP REQ :draft/extended-isupport
C: ISUPPORT
S: 005 * NETWORK=AfterNET draft/ICON=https://... :are supported

# Client can display network icon during connection
```

---

## Edge Cases

1. **Without capability**: Returns ERR_UNKNOWNCOMMAND
2. **After registration**: Works normally (same as pre-reg)
3. **Multiple requests**: Each request sends full ISUPPORT

---

## Client Support

| Software | Support |
|----------|---------|
| UnrealIRCd | Server |
| **Nefarious** | **Server (NEW)** |

Limited adoption currently.

---

## Batch Wrapping ✅ IMPLEMENTED

When both `batch` and `draft/extended-isupport` are enabled, ISUPPORT is wrapped in a batch:

```
S: BATCH +abc draft/isupport
S: @batch=abc :server 005 * KEY1=value1 KEY2=value2 :are supported
S: @batch=abc :server 005 * KEY3=value3 KEY4=value4 :are supported
S: BATCH -abc
```

Implementation details:
- Added `send_supported_batched()` function in s_user.c
- m_isupport.c calls this instead of plain `send_supported()`
- If client lacks batch capability, falls back to unbatched ISUPPORT

---

## References

- **Spec**: https://ircv3.net/specs/extensions/extended-isupport
- **ISUPPORT**: RFC 2812 / modern.ircdocs.horse
- **Batch**: https://ircv3.net/specs/extensions/batch
