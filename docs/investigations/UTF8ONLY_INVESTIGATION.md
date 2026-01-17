# IRCv3 UTF8ONLY Extension Investigation

## Status: NOT IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/utf8-only

**ISUPPORT Token**: `UTF8ONLY`

**Effort**: Low (12-20 hours)

**Priority**: Low - Nice to have, but IRC traditionally allows arbitrary encodings

---

## Why This Matters

UTF8ONLY declares that the server only accepts UTF-8 encoded messages:
- Modern clients can auto-switch to UTF-8
- Eliminates encoding confusion
- Consistent experience across clients
- Simplifies message handling (no encoding detection)

---

## Specification Summary

### ISUPPORT Token

Server advertises UTF-8 requirement:
```
005 nick UTF8ONLY :are supported by this server
```

### Client Behavior

When a client sees `UTF8ONLY`:
1. Client MUST switch to UTF-8 encoding
2. Client MUST NOT send non-UTF-8 data
3. No user configuration required (automatic)

### Server Behavior

When `UTF8ONLY` is enabled:
1. Server MUST NOT relay non-UTF-8 content to clients
2. Server MAY reject non-UTF-8 messages
3. Server MAY modify messages to make them valid UTF-8

### Error Handling

Uses standard replies with `INVALID_UTF8` code:
```
FAIL PRIVMSG INVALID_UTF8 #channel :Message rejected - invalid UTF-8
WARN PRIVMSG INVALID_UTF8 #channel :Message modified - invalid UTF-8 replaced
```

---

## Implementation Requirements

### Modified Files

| File | Changes |
|------|---------|
| `ircd/s_user.c` | Add `UTF8ONLY` to ISUPPORT |
| `include/ircd_features.h` | Add `FEAT_UTF8ONLY` |
| `ircd/ircd_features.c` | Register feature (default: FALSE) |
| `ircd/ircd_relay.c` | Validate UTF-8 on PRIVMSG/NOTICE |
| `ircd/send.c` | Standard reply for INVALID_UTF8 |

### Configuration

```
features {
    "UTF8ONLY" = "FALSE";              /* Enable UTF-8 only mode */
    "UTF8_REJECT_INVALID" = "TRUE";    /* Reject vs modify invalid */
};
```

---

## Implementation Phases

### Phase 1: ISUPPORT Advertisement (2-3 hours)

1. Add `FEAT_UTF8ONLY` feature
2. Include `UTF8ONLY` in ISUPPORT when enabled
3. Document configuration

### Phase 2: UTF-8 Validation (6-10 hours)

1. Implement UTF-8 validation function
2. Add validation to PRIVMSG/NOTICE handlers
3. Handle truncation edge case (don't split multi-byte chars)

### Phase 3: Error Handling (4-7 hours)

1. Add `INVALID_UTF8` standard reply
2. Implement FAIL response for rejection
3. Implement WARN response for modification
4. Replace invalid bytes with replacement character (U+FFFD)

---

## UTF-8 Validation

### Valid UTF-8 Byte Sequences

| First Byte | Bytes | Range |
|------------|-------|-------|
| 0x00-0x7F | 1 | ASCII |
| 0xC2-0xDF | 2 | U+0080 to U+07FF |
| 0xE0-0xEF | 3 | U+0800 to U+FFFF |
| 0xF0-0xF4 | 4 | U+10000 to U+10FFFF |

### Invalid Sequences to Reject

- Overlong encodings (e.g., 0xC0 0x80 for NUL)
- Invalid start bytes (0x80-0xBF, 0xF5+)
- Truncated sequences
- Surrogates (0xD800-0xDFFF)

### Validation Function

```c
int is_valid_utf8(const char *str, size_t len) {
    const unsigned char *s = (const unsigned char *)str;
    const unsigned char *end = s + len;

    while (s < end) {
        if (*s < 0x80) {
            s++;
        } else if ((*s & 0xE0) == 0xC0) {
            if (s + 1 >= end || (s[1] & 0xC0) != 0x80)
                return 0;
            if (*s < 0xC2)  /* overlong */
                return 0;
            s += 2;
        } else if ((*s & 0xF0) == 0xE0) {
            if (s + 2 >= end || (s[1] & 0xC0) != 0x80 || (s[2] & 0xC0) != 0x80)
                return 0;
            s += 3;
        } else if ((*s & 0xF8) == 0xF0) {
            if (s + 3 >= end || (s[1] & 0xC0) != 0x80 ||
                (s[2] & 0xC0) != 0x80 || (s[3] & 0xC0) != 0x80)
                return 0;
            if (*s > 0xF4)  /* beyond Unicode range */
                return 0;
            s += 4;
        } else {
            return 0;  /* invalid start byte */
        }
    }
    return 1;
}
```

---

## Example Flow

```
C: CAP LS 302
S: CAP * LS :...
C: CAP END
C: NICK user
C: USER user 0 * :User
S: 001 user :Welcome
S: 005 user UTF8ONLY NETWORK=TestNet ...

C: PRIVMSG #channel :Hello, \xFF world
S: FAIL PRIVMSG INVALID_UTF8 #channel :Message rejected - invalid UTF-8

C: PRIVMSG #channel :Hello, world!
[Message delivered normally]
```

---

## Truncation Edge Case

When truncating messages to fit PRIVMSG limits, servers MUST NOT split UTF-8 multi-byte sequences:

```c
/* Safe UTF-8 truncation */
size_t utf8_safe_truncate(const char *str, size_t max_len) {
    size_t len = strlen(str);
    if (len <= max_len) return len;

    /* Back up to valid UTF-8 boundary */
    const unsigned char *s = (const unsigned char *)str;
    size_t i = max_len;
    while (i > 0 && (s[i] & 0xC0) == 0x80)
        i--;
    return i;
}
```

---

## Effort Breakdown

| Component | Effort |
|-----------|--------|
| ISUPPORT advertisement | 2-3 hours |
| UTF-8 validation | 6-10 hours |
| Error handling | 4-7 hours |
| **Total** | **12-20 hours** |

---

## Priority Assessment

**Low Priority**:

1. **Breaking change**: Rejects previously-valid messages
2. **Legacy compatibility**: Many IRC clients use non-UTF-8
3. **Regional considerations**: Some regions still use legacy encodings
4. **Limited benefit**: Most modern clients already use UTF-8

### When to Consider

- New networks starting fresh
- Networks with modern client base
- Networks requiring internationalization consistency

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| UnrealIRCd | Server |
| HexChat | Client |
| mIRC | Client |
| WeeChat | Client |
| soju | Bouncer |
| **Nefarious** | **NOT IMPLEMENTED** |

---

## Alternative Approaches

### Option A: Strict Rejection (Recommended)
- Reject non-UTF-8 messages with FAIL
- Clear feedback to clients
- No data modification

### Option B: Replacement
- Replace invalid bytes with U+FFFD
- Send WARN response
- Allows message through (modified)

### Option C: Silent Drop
- Don't relay non-UTF-8
- No error message
- Confusing for users

**Recommendation**: Option A with configuration to allow Option B.

---

## Edge Cases

1. **Binary in CTCP**: Some CTCP uses binary data (DCC, etc.)
2. **File transfers**: DCC file names may use non-UTF-8
3. **Bot data**: Some bots send binary metadata
4. **Nick changes**: Enforce on NICK command too?
5. **Existing users**: What about users already connected?

---

## References

- **Spec**: https://ircv3.net/specs/extensions/utf8-only
- **UTF-8**: https://tools.ietf.org/html/rfc3629
- **Standard Replies**: https://ircv3.net/specs/extensions/standard-replies
- **Related**: CASEMAPPING, CHARSET (legacy)
