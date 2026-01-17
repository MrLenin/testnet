# IRCv3 Network Icon Draft Extension Investigation

## Status: NOT IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/network-icon (DRAFT)

**ISUPPORT Token**: `draft/ICON`

**Effort**: Very Low (4-8 hours)

**Priority**: Very Low - Cosmetic feature, draft specification

---

## Why This Matters

Network icon allows servers to advertise a logo/icon:
- Clients can display network branding
- Consistent visual identity across clients
- Modern chat platform expectation (Discord/Slack have server icons)
- Nice polish for network presentation

---

## Specification Summary

### ISUPPORT Token

Server advertises icon URL via ISUPPORT:
```
005 nick NETWORK=TestNet draft/ICON=https://example.org/icon.svg :are supported
```

### URL Requirements

- SHOULD use `https` scheme (recommended, not required)
- Must point to an image file
- No specific format/size requirements in spec

### Image Recommendations

While the spec doesn't mandate specifics, best practices:
- Format: SVG, PNG, or ICO
- Size: 64x64 to 256x256 pixels
- Aspect: Square (1:1)
- File size: < 50KB

---

## Implementation Requirements

### Modified Files

| File | Changes |
|------|---------|
| `include/ircd_features.h` | Add `FEAT_NETWORK_ICON` |
| `ircd/ircd_features.c` | Register feature (string, default: empty) |
| `ircd/s_user.c` | Add `draft/ICON=<url>` to ISUPPORT when configured |

### Configuration

```
features {
    "NETWORK_ICON" = "https://example.org/icon.svg";
};
```

When empty or not set, the token is not advertised.

---

## Implementation

### Single Change Required

Add to ISUPPORT output in `s_user.c`:

```c
/* In send_supported() or equivalent */
if (feature_str(FEAT_NETWORK_ICON) && *feature_str(FEAT_NETWORK_ICON))
    send_reply(sptr, RPL_ISUPPORT, "draft/ICON=%s", feature_str(FEAT_NETWORK_ICON));
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
S: 005 user NETWORK=TestNet draft/ICON=https://testnet.org/icon.png ...
```

---

## Effort Breakdown

| Component | Effort |
|-----------|--------|
| Feature definition | 1-2 hours |
| ISUPPORT integration | 2-3 hours |
| Testing | 1-3 hours |
| **Total** | **4-8 hours** |

---

## Priority Assessment

**Very Low Priority**:

1. **Draft specification**: Subject to change without notice
2. **Cosmetic only**: No functional impact
3. **Limited client support**: Few clients display it
4. **Production not recommended**: Spec warns against production use

### When to Consider

- After all core IRCv3 features are implemented
- When the spec is finalized (no longer draft)
- If network branding is a priority

---

## Client Support

| Software | Support |
|----------|---------|
| UnrealIRCd | Server |
| Ergo | Server |
| (limited clients) | - |
| **Nefarious** | **NOT IMPLEMENTED** |

Most IRC clients do not yet display network icons.

---

## Draft Status Warning

From the specification:

> This is a draft specification. It is a work in progress, and is subject to major changes without notice. Production implementation is not recommended.

Consider waiting for the specification to be finalized before implementing.

---

## Related: Extended ISUPPORT

The spec mentions that servers may use `extended-isupport` capability to allow clients to retrieve the network icon before completing connection registration. This would allow clients to display the icon during the connection process.

Extended ISUPPORT is defined in: https://ircv3.net/specs/extensions/extended-isupport

---

## Configuration Example

```
# ircd.conf
features {
    "NETWORK_ICON" = "https://cdn.testnet.org/icons/network.svg";
};
```

Recommendations for the icon URL:
- Use HTTPS for security
- Host on a CDN for reliability
- Use a stable URL that won't change
- Consider caching headers

---

## Alternative Approaches

### Option A: ISUPPORT Only (Recommended)
- Simplest implementation
- Just add the token when configured
- No additional capability required

### Option B: With Extended ISUPPORT
- More complex
- Allows pre-registration retrieval
- Probably overkill for this feature

**Recommendation**: Option A for now; revisit when spec is finalized.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/network-icon
- **Extended ISUPPORT**: https://ircv3.net/specs/extensions/extended-isupport
- **NETWORK token**: Standard ISUPPORT network name
