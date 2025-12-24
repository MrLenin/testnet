# IRCv3 No-Implicit-Names Extension Investigation

## Status: QUICK WIN - IMPLEMENT FIRST

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

## Implementation Architecture

### Current JOIN Flow

In `m_join.c`:

```c
/* After successful join */
send_topic_burst(cptr, chptr);   /* 332, 333 */
do_names(cptr, chptr, NAMES_ALL); /* 353, 366 */
```

### New JOIN Flow

```c
/* After successful join */
send_topic_burst(cptr, chptr);   /* 332, 333 */

/* Skip names if no-implicit-names negotiated */
if (!HasCap(cptr, CAP_NOIMPLICITNAMES))
    do_names(cptr, chptr, NAMES_ALL);
```

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_NOIMPLICITNAMES` |
| `include/ircd_features.h` | Add `FEAT_CAP_no_implicit_names` |
| `ircd/ircd_features.c` | Register feature (default: FALSE) |
| `ircd/m_cap.c` | Add `draft/no-implicit-names` to capability list |
| `ircd/m_join.c` | Conditionally skip names |

---

## Code Changes

### capab.h

```c
#define CAP_NOIMPLICITNAMES  0x80000  /* draft/no-implicit-names */
```

### m_cap.c

```c
{ "draft/no-implicit-names", CAP_NOIMPLICITNAMES, FEAT_CAP_no_implicit_names },
```

### m_join.c

Find the `do_names()` call after join:

```c
/* Before */
do_names(sptr, chptr, NAMES_EON);

/* After */
if (!HasCap(sptr, CAP_NOIMPLICITNAMES))
    do_names(sptr, chptr, NAMES_EON);
```

---

## Implementation Phases

### Phase 1: Basic Implementation

1. Add capability and feature flag
2. Add capability check before do_names()
3. Test with capable client

**Effort**: Very Low (2-4 hours)

This is one of the simplest IRCv3 extensions to implement.

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

## Configuration Options

```
features {
    "CAP_no_implicit_names" = "TRUE";
};
```

---

## Edge Cases

1. **WHO vs NAMES**: Some clients use WHO instead of NAMES
   - This extension doesn't affect WHO behavior

2. **Multi-prefix interaction**: Works normally
   - When NAMES is explicitly requested, multi-prefix still applies

3. **Extended-join interaction**: Works normally
   - Extended JOIN info still sent for other users joining

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| Join modification | Very Low | Low |
| Testing | Low | Low |

**Total**: Very Low effort (2-4 hours)

---

## Recommendation

1. **Implement immediately**: Trivial change
2. **Low risk**: No complex state management
3. **Feature flag enabled by default**: Simple and safe

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

Reasonable adoption for a draft spec.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/no-implicit-names
- **NAMES**: RFC 2812 Section 3.2.5
