# IRCv3 No-Implicit-Names Extension Investigation

## Status: ✅ IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/no-implicit-names

**Capability**: `draft/no-implicit-names`

**Effort**: ~2-4 hours (single if-statement change)

**Priority**: Tier 1 - Trivial implementation, immediate value

---

## Why Implement First?

This is the easiest IRCv3 extension to implement:
- **One line of code**: Add capability check before `do_names()` call
- **No new commands**: Just skip existing behavior
- **No state management**: Stateless capability
- **Low risk**: Cannot break anything

---

## Specification Summary

The no-implicit-names extension allows clients to suppress the automatic NAMES reply that servers send after JOIN. This is useful for:
- Mobile clients with limited bandwidth
- Clients joining many channels at once
- Clients that fetch names on-demand
- Reducing connection overhead

---

## Current Behavior

When a client joins a channel, server sends:

```
:nick!user@host JOIN #channel
:server 332 nick #channel :Topic text
:server 333 nick #channel setter 1234567890
:server 353 nick = #channel :@op +voice user1 user2 ...
:server 353 nick = #channel :user3 user4 user5 ...
:server 366 nick #channel :End of /NAMES list
```

---

## New Behavior

With `draft/no-implicit-names` negotiated:

```
:nick!user@host JOIN #channel
:server 332 nick #channel :Topic text
:server 333 nick #channel setter 1234567890
```

No RPL_NAMREPLY (353) or RPL_ENDOFNAMES (366) sent automatically.

---

## Explicit NAMES

Clients can still request names explicitly:

```
C: NAMES #channel
S: :server 353 nick = #channel :@op +voice user1 user2 ...
S: :server 366 nick #channel :End of /NAMES list
```

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| JOIN handling | Existing |
| NAMES command | Existing |

No external dependencies.

---

## Implementation Details

### Files Modified

| File | Changes |
|------|---------|
| `include/capab.h` | Added `CAP_DRAFT_NOIMPLICITNAMES` enum value |
| `include/ircd_features.h` | Added `FEAT_CAP_draft_no_implicit_names` |
| `ircd/ircd_features.c` | Registered feature (default: TRUE) |
| `ircd/m_cap.c` | Added `draft/no-implicit-names` to capability list |
| `ircd/m_join.c` | Added `#include "capab.h"`, conditionally skip `do_names()` |
| `ircd/m_svsjoin.c` | Added `#include "capab.h"`, conditionally skip `do_names()` |

### capab.h

```c
/* Added to enum Capab before TLS */
_CAP(DRAFT_NOIMPLICITNAMES, 0, "draft/no-implicit-names", 0),
```

### ircd_features.h

```c
/* Added after FEAT_CAP_standard_replies */
FEAT_CAP_draft_no_implicit_names,
```

### ircd_features.c

```c
/* Added after CAP_standard_replies */
F_B(CAP_draft_no_implicit_names, 0, 1, 0),
```

### m_cap.c

```c
/* Added to capab_list[] */
_CAP(DRAFT_NOIMPLICITNAMES, 0, "draft/no-implicit-names", FEAT_CAP_draft_no_implicit_names),
```

### m_join.c

```c
/* Added include at top */
#include "capab.h"

/* Modified do_names() call (line ~284) */
/* Skip implicit NAMES if client has draft/no-implicit-names capability */
if (!HasCap(sptr, CAP_DRAFT_NOIMPLICITNAMES))
  do_names(sptr, chptr, NAMES_ALL|NAMES_EON); /* send /names list */
```

### m_svsjoin.c

```c
/* Added include at top */
#include "capab.h"

/* Modified do_names() call (line ~198) */
/* Skip implicit NAMES if client has draft/no-implicit-names capability */
if (!HasCap(acptr, CAP_DRAFT_NOIMPLICITNAMES))
  do_names(acptr, chptr, NAMES_ALL|NAMES_EON); /* send /names list */
```

---

## Configuration

```
features {
    "CAP_draft_no_implicit_names" = "TRUE";  /* enabled by default */
};
```

To disable:
```
features {
    "CAP_draft_no_implicit_names" = "FALSE";
};
```

---

## Use Cases

### Mobile Client Joining Many Channels

```
C: CAP REQ :draft/no-implicit-names
S: CAP * ACK :draft/no-implicit-names
C: JOIN #channel1,#channel2,#channel3,#channel4,#channel5

# Server sends JOINs and topics, but NOT names for each channel
# Saves significant bandwidth for channels with many users
```

### On-Demand Names Fetch

Client only requests names when user actually views the channel:

```
# User opens #busy-channel tab
C: NAMES #busy-channel
S: 353 ...
S: 366 ...
```

---

## Bandwidth Savings

For a channel with 500 users:
- ~40 RPL_NAMREPLY messages (~20KB)
- ~1 RPL_ENDOFNAMES message

For a client joining 20 channels:
- Potential savings: ~400KB per connect

---

## Edge Cases

1. **WHO vs NAMES**: Some clients use WHO instead of NAMES
   - This extension doesn't affect WHO behavior

2. **Multi-prefix interaction**: Works normally
   - When NAMES is explicitly requested, multi-prefix still applies

3. **Extended-join interaction**: Works normally
   - Extended JOIN info still sent for other users joining

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| UnrealIRCd | Server |
| ObsidianIRC | Server |
| Goguma | Client |
| soju | Bouncer |
| Matrix2051 | Bridge |
| **Nefarious** | **Server (NEW)** |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/no-implicit-names
- **NAMES**: RFC 2812 Section 3.2.5
