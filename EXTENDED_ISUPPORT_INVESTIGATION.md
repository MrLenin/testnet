# IRCv3 Extended-ISUPPORT Extension Investigation

## Status: INVESTIGATING (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/extended-isupport

**Capability**: `draft/extended-isupport`

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

One or more RPL_ISUPPORT messages, optionally wrapped in a batch:

```
:server 005 * KEY1=value1 KEY2=value2 :are supported by this server
```

When both `batch` and `draft/extended-isupport` are enabled:

```
:server BATCH +abc draft/isupport
@batch=abc :server 005 * KEY1=value1 KEY2=value2 :are supported
@batch=abc :server 005 * KEY3=value3 KEY4=value4 :are supported
:server BATCH -abc
```

---

## Pre-Registration Behavior

When capability is negotiated:
1. Server MUST accept `ISUPPORT` command before registration
2. Server MAY send subset of tokens pre-registration
3. Server MUST send any omitted tokens after registration completes

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `batch` | Complete |
| ISUPPORT infrastructure | Existing |

---

## Batch Type

**Type**: `draft/isupport`

Used to group multiple RPL_ISUPPORT messages.

---

## Implementation Architecture

### Current ISUPPORT Handling

ISUPPORT tokens are sent in `register_user()` after connection completes:

```c
/* In s_user.c register_user() */
send_supported(sptr);  /* Sends RPL_ISUPPORT */
```

### New Flow

```
C: CAP LS 302
S: CAP * LS :... draft/extended-isupport batch ...
C: CAP REQ :draft/extended-isupport batch
S: CAP * ACK :draft/extended-isupport batch
C: ISUPPORT                        <- NEW
S: BATCH +abc draft/isupport
S: @batch=abc :server 005 * NETWORK=Test CHANTYPES=#& :are supported
S: @batch=abc :server 005 * NICKLEN=30 CHANNELLEN=50 :are supported
S: BATCH -abc
C: NICK user
C: USER ...
S: 001 ...
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_EXTISUPPORT` |
| `include/ircd_features.h` | Add `FEAT_CAP_extended_isupport` |
| `ircd/ircd_features.c` | Register feature (default: FALSE) |
| `ircd/m_cap.c` | Add `draft/extended-isupport` to capability list |
| `include/msg.h` | Add `MSG_ISUPPORT` |
| `include/handlers.h` | Add `m_isupport` declaration |
| `ircd/m_isupport.c` | New file: ISUPPORT command handler |
| `ircd/parse.c` | Register ISUPPORT command |
| `ircd/Makefile.in` | Add m_isupport.c |
| `ircd/supported.c` | Add batch-aware sending |

---

## New Command Handler

```c
/* m_isupport.c */
int m_isupport(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
    /* Check if capability negotiated */
    if (!HasCap(sptr, CAP_EXTISUPPORT))
        return send_reply(sptr, ERR_UNKNOWNCOMMAND, "ISUPPORT");

    /* Send ISUPPORT with batch wrapper if client has batch cap */
    if (HasCap(sptr, CAP_BATCH)) {
        char batchid[16];
        generate_batch_id(batchid, sizeof(batchid));

        /* Start batch */
        sendcmdto_one(&me, CMD_BATCH, sptr, "+%s draft/isupport", batchid);

        /* Send ISUPPORT with batch tag */
        send_supported_batched(sptr, batchid);

        /* End batch */
        sendcmdto_one(&me, CMD_BATCH, sptr, "-%s", batchid);
    } else {
        /* Send without batch */
        send_supported(sptr);
    }

    return 0;
}
```

---

## Batch-Aware ISUPPORT

Modify `supported.c` to support batch tags:

```c
void send_supported_batched(struct Client *cptr, const char *batchid)
{
    char buffer[512];
    int pos = 0;
    int count = 0;

    for (int i = 0; isupport_tokens[i].name; i++) {
        int len = format_token(&isupport_tokens[i], buffer + pos, sizeof(buffer) - pos);
        pos += len;
        count++;

        if (count >= 13 || pos > 400) {
            /* Send line with batch tag */
            send_reply_batched(cptr, RPL_ISUPPORT, batchid, buffer);
            pos = 0;
            count = 0;
        }
    }

    if (pos > 0) {
        send_reply_batched(cptr, RPL_ISUPPORT, batchid, buffer);
    }
}
```

---

## Pre-Registration Token Subset

Some tokens may not be available pre-registration:

| Token | Available Pre-Reg |
|-------|-------------------|
| `NETWORK` | Yes |
| `CHANTYPES` | Yes |
| `NICKLEN` | Yes |
| `CHANNELLEN` | Yes |
| `PREFIX` | Yes |
| `MODES` | Yes |
| `MAXTARGETS` | Yes |
| `draft/ICON` | Yes |
| User-specific tokens | No |

---

## Implementation Phases

### Phase 1: Basic ISUPPORT Command

1. Add capability and feature flag
2. Implement `m_isupport.c`
3. Allow pre-registration sending
4. No batching initially

**Effort**: Low (8-12 hours)

### Phase 2: Batch Support

1. Add `draft/isupport` batch type
2. Wrap ISUPPORT in batch when client supports
3. Add batch tag to 005 messages

**Effort**: Low (4-8 hours)

### Phase 3: Subset Handling

1. Identify pre-reg vs post-reg tokens
2. Send subset pre-registration
3. Send remainder after registration

**Effort**: Low (4-8 hours)

---

## Use Cases

### Early Capability Discovery

```
C: CAP LS 302
S: CAP * LS :draft/extended-isupport
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

## Configuration Options

```
features {
    "CAP_extended_isupport" = "TRUE";
};
```

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| ISUPPORT command | Low | Low |
| Batch wrapping | Low | Low |
| Token subset | Low | Low |

**Total**: Low effort (16-28 hours)

---

## Recommendation

1. **Implement all phases**: Simple extension
2. **Low priority**: Nice-to-have, not essential
3. **Feature flag enabled by default**: Low risk

---

## Related Extensions

- **draft/ICON**: Network icon ISUPPORT token
- **batch**: For grouping ISUPPORT messages

---

## Client Support

| Software | Support |
|----------|---------|
| UnrealIRCd | Server |

Limited adoption currently.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/extended-isupport
- **ISUPPORT**: RFC 2812 / modern.ircdocs.horse
- **Batch**: https://ircv3.net/specs/extensions/batch
