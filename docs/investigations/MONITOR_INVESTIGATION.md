# IRCv3 MONITOR Extension Investigation

## Status: NOT IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/monitor

**ISUPPORT Token**: `MONITOR=<limit>`

**Effort**: Medium (40-60 hours)

**Priority**: Low - Nefarious already has WATCH which provides similar functionality

---

## Why This Matters

MONITOR is the IRCv3-standardized replacement for non-standard WATCH/NOTIFY commands:
- Provides online/offline notifications for tracked nicks
- More efficient than polling with ISON
- Multicast delivery when multiple clients watch the same nick
- Standardized across servers (unlike WATCH variants)

---

## Existing Implementation: WATCH

Nefarious already implements the **WATCH** command which provides similar functionality:

### WATCH Commands (Current)
| Command | Description |
|---------|-------------|
| `WATCH +nick` | Add nick to watch list |
| `WATCH -nick` | Remove nick from watch list |
| `WATCH C` | Clear entire watch list |
| `WATCH S` | Status (count + list) |
| `WATCH l` | List online nicks |
| `WATCH L` | List online and offline nicks |

### WATCH Files
| File | Purpose |
|------|---------|
| `ircd/m_watch.c` | WATCH command handler |
| `ircd/watch.c` | Watch list management |
| `include/watch.h` | Data structures and API |

### WATCH Numerics (Non-standard)
| Numeric | Name | Description |
|---------|------|-------------|
| 600 | RPL_NOWON | Nick is online |
| 601 | RPL_NOWOFF | Nick is offline |
| 602 | RPL_WATCHOFF | Nick removed from watch |
| 603 | RPL_WATCHSTAT | Watch list statistics |
| 604 | RPL_NOWON | Nick came online |
| 605 | RPL_NOWOFF | Nick went offline |
| 606 | RPL_WATCHLIST | Watch list entry |
| 607 | RPL_ENDOFWATCHLIST | End of watch list |
| 512 | ERR_TOOMANYWATCH | Watch list full |

---

## MONITOR Specification Summary

### Commands
| Command | Description |
|---------|-------------|
| `MONITOR + nick,nick,...` | Add nicks to monitor list |
| `MONITOR - nick,nick,...` | Remove nicks from monitor list |
| `MONITOR C` | Clear entire monitor list |
| `MONITOR L` | List all monitored nicks |
| `MONITOR S` | Status of all monitored nicks |

### Numerics (Standard)
| Numeric | Name | Description |
|---------|------|-------------|
| 730 | RPL_MONONLINE | Nick is online (with hostmask) |
| 731 | RPL_MONOFFLINE | Nick is offline |
| 732 | RPL_MONLIST | Monitor list entry |
| 733 | RPL_ENDOFMONLIST | End of monitor list |
| 734 | ERR_MONLISTFULL | Monitor list at capacity |

### Key Differences from WATCH
1. Uses comma-separated nick lists (not separate params)
2. Standard numeric replies (730-734 vs 600-607)
3. ISUPPORT advertisement (`MONITOR=<limit>`)
4. May include hostmask in online notifications
5. More strict about wildcards (none allowed)

---

## Implementation Options

### Option A: Add MONITOR Alongside WATCH
- Keep existing WATCH for compatibility
- Add new MONITOR command with standard numerics
- Share internal watch list infrastructure

### Option B: Replace WATCH with MONITOR
- Full MONITOR implementation
- Remove WATCH command
- Breaking change for existing clients

### Option C: Alias MONITOR to WATCH
- Add MONITOR as command alias
- Translate numerics
- Quick but imperfect solution

**Recommendation**: Option A - Add MONITOR alongside WATCH, sharing the internal infrastructure.

---

## Implementation Requirements

### New Files
| File | Description |
|------|-------------|
| `ircd/m_monitor.c` | MONITOR command handler |

### Modified Files
| File | Changes |
|------|---------|
| `include/numeric.h` | Add RPL_MONONLINE (730), RPL_MONOFFLINE (731), RPL_MONLIST (732), RPL_ENDOFMONLIST (733), ERR_MONLISTFULL (734) |
| `ircd/s_err.c` | Numeric format strings |
| `ircd/s_user.c` | ISUPPORT: Add MONITOR=<limit> token |
| `ircd/parse.c` | Register MONITOR command |
| `include/handlers.h` | Add m_monitor declaration |
| `ircd/Makefile.in` | Add m_monitor.o |

### Configuration
```
features {
    "MAXWATCHS" = "512";  /* Existing - shared limit */
};
```

---

## Implementation Phases

### Phase 1: Command Parser
- Parse MONITOR +/-/C/L/S subcommands
- Handle comma-separated nick lists
- Validate nick format (no wildcards)

### Phase 2: Numeric Responses
- Add 730-734 numeric definitions
- Format responses per specification
- Include optional hostmask in RPL_MONONLINE

### Phase 3: ISUPPORT Advertisement
- Add `MONITOR=<limit>` to ISUPPORT
- Use same limit as MAXWATCHS

### Phase 4: Shared Infrastructure
- Reuse watch.c functions for list management
- Create wrapper functions for MONITOR format

---

## Example Flow

```
C: CAP LS 302
S: CAP * LS :...
C: CAP END
C: NICK user
C: USER user 0 * :User
S: 001 user :Welcome ...
S: 005 user MONITOR=512 ...

C: MONITOR + friend1,friend2,friend3
S: :server 730 user :friend1!ident@host,friend2!ident@host
S: :server 731 user :friend3

C: MONITOR L
S: :server 732 user :friend1,friend2,friend3
S: :server 733 user :End of MONITOR list

[friend3 connects]
S: :server 730 user :friend3!ident@host

[friend1 disconnects]
S: :server 731 user :friend1
```

---

## Priority Assessment

**Low Priority** for the following reasons:

1. **WATCH already works**: Nefarious has functional online/offline notification
2. **Limited client adoption**: Many clients still use WATCH or ISON
3. **No capability negotiation**: MONITOR uses ISUPPORT, not CAP
4. **Non-critical feature**: Nice to have, not essential for modern IRC

Consider implementing after higher-priority IRCv3 extensions.

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| InspIRCd | Server |
| UnrealIRCd | Server |
| irssi | Client |
| WeeChat | Client |
| HexChat | Client |
| **Nefarious** | **Has WATCH (non-standard)** |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/monitor
- **WATCH (current)**: `nefarious/ircd/m_watch.c`
- **Related**: ISON command (legacy polling)
