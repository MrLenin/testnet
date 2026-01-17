# IRCv3 Bot Mode Extension Investigation

## Status: ✅ FULLY IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/bot-mode

**ISUPPORT Token**: `BOT=B` (advertised)

**Capability**: None (uses ISUPPORT)

**Implementation**: Complete in Nefarious IRCv3 branch

---

## Why This Matters

Bot mode provides a standardized way to identify automated clients:
- Clients can visually distinguish bots from humans
- Channel operators can apply bot-specific policies
- WHO/WHOX queries can filter or identify bots
- Modern chat platforms have similar "bot" badges

---

## Specification Summary

### ISUPPORT Token

Server advertises bot mode support via:
```
005 nick BOT=B :are supported by this server
```

The value (`B` in this example) is the user mode character for bot status.

### User Mode

Bots set their status using the advertised mode character:
```
MODE nick +B
```

### WHOIS Response

When a user is marked as a bot, WHOIS includes numeric 335:
```
:server 335 querier botnick :is a Bot on NetworkName
```

### WHO Response

In `RPL_WHOREPLY` (352), the bot mode character appears in the flags field:
```
:server 352 user #channel ident host server botnick HB :0 Bot Name
```
(Note the `B` after `H` for "Here + Bot")

### WHOX Response

Bot flag available in WHOX responses using the `B` flag.

### Message Tag (Optional)

Servers may add `@bot` tag to messages from bots:
```
@bot :botnick!ident@host PRIVMSG #channel :Automated message
```

Requires `message-tags` capability.

---

## Current Implementation

### Implementation Files

| File | Implementation |
|------|----------------|
| `include/client.h` | `FLAG_BOT` with `IsBot()`, `SetBot()`, `ClearBot()` macros |
| `ircd/s_user.c` | User mode `+B` mapped to `FLAG_BOT`; ISUPPORT `BOT=B` |
| `ircd/m_whois.c` | RPL_WHOISBOT (335) for bot users |
| `include/numeric.h` | `RPL_WHOISBOT` defined as 335 |
| `ircd/s_err.c` | Format string for RPL_WHOISBOT |
| `ircd/send.c` | `@bot` message tag via `TAGS_BOT` flag |

### Features

| Feature | Status |
|---------|--------|
| User mode +B | ✅ Implemented |
| ISUPPORT BOT=B | ✅ Advertised |
| RPL_WHOISBOT (335) | ✅ Sent in WHOIS |
| @bot message tag | ✅ Added to messages from +B users |
| WHO/WHOX B flag | ✅ Included in responses |

### Usage

```
C: MODE botnick +B
S: :botnick!ident@host MODE botnick :+B

C: WHOIS botnick
S: :server 311 user botnick ident host * :Bot Name
S: :server 335 user botnick :is a Bot on TestNet
S: :server 318 user botnick :End of /WHOIS list

[Messages from bot include @bot tag]
@bot;time=... :botnick!ident@host PRIVMSG #channel :Automated message
```

---

## Example Flow

```
S: 005 user BOT=B NETWORK=TestNet ...

C: MODE botnick +B
S: :botnick!ident@host MODE botnick :+B

C: WHOIS botnick
S: :server 311 user botnick ident host * :Bot Name
S: :server 335 user botnick :is a Bot on TestNet
S: :server 318 user botnick :End of /WHOIS list

C: WHO #channel
S: :server 352 user #channel ident host server botnick HB :0 Bot Name
```

---

## Server Support

| Software | Support |
|----------|---------|
| Ergo | ✅ Server |
| InspIRCd | ✅ Server |
| UnrealIRCd | ✅ Server |
| **Nefarious** | ✅ **IMPLEMENTED** |

## Client Support

| Software | Support |
|----------|---------|
| mIRC | Client |
| WeeChat | Client |
| IRCCloud | Client |
| Eggdrop | Bot |
| Sopel | Bot |

---

## Implementation Notes

### User Modes in Nefarious

The +B mode follows the same pattern as other user modes:
- `+o` - IRC Operator
- `+i` - Invisible
- `+w` - Wallops
- `+d` - Deaf
- `+x` - Hidden host
- `+r` - Registered (account)
- **`+B` - Bot** (implemented)

### Behavior Details

1. **Oper count**: Bot users with +B don't count toward oper statistics
2. **Message tags**: @bot tag automatically added to messages from +B users
3. **WHOIS**: RPL_WHOISBOT (335) included in WHOIS response
4. **Propagation**: Mode propagates via P10 to linked servers

---

## References

- **Spec**: https://ircv3.net/specs/extensions/bot-mode
- **Related**: message-tags (for @bot tag)
- **WHO/WHOX**: https://ircv3.net/specs/extensions/whox
