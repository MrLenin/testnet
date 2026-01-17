# Nefarious IRCv3 Compliance Audit

**Date**: 2026-01-17

**Summary**: Nefarious has excellent IRCv3 coverage with 30+ capabilities. This document tracks gaps and partial implementations.

---

## Implementation Status Overview

### Fully Implemented (Ratified Specs)

| Spec | Capability | Status |
|------|------------|--------|
| CAP negotiation | CAP LS 302 | ✅ Full |
| message-tags | `message-tags` | ✅ Full |
| msgid | (auto) | ✅ Full |
| server-time | `server-time` | ✅ Full |
| account-tag | `account-tag` | ✅ Full |
| multi-prefix | `multi-prefix` | ✅ Full |
| userhost-in-names | `userhost-in-names` | ✅ Full |
| extended-join | `extended-join` | ✅ Full |
| away-notify | `away-notify` | ✅ Full |
| account-notify | `account-notify` | ✅ Full |
| invite-notify | `invite-notify` | ✅ Full |
| echo-message | `echo-message` | ✅ Full |
| labeled-response | `labeled-response` | ✅ Full |
| batch | `batch` | ✅ Full |
| setname | `setname` | ✅ Full |
| cap-notify | `cap-notify` | ✅ Full |
| standard-replies | `standard-replies` | ✅ Full |
| chghost | `chghost` | ✅ Full |
| SASL | `sasl` | ✅ Full (PLAIN, EXTERNAL, SCRAM-*, OAUTHBEARER) |
| TLS | `tls` | ✅ Full |
| WHOX | ISUPPORT | ✅ Full |
| Bot mode | ISUPPORT BOT=B | ✅ Full |

### Fully Implemented (Draft Specs)

| Spec | Capability | Status |
|------|------------|--------|
| draft/chathistory | `draft/chathistory` | ✅ Full (with federation) |
| draft/event-playback | `draft/event-playback` | ✅ Full |
| draft/message-redaction | `draft/message-redaction` | ✅ Full |
| draft/account-registration | `draft/account-registration` | ✅ Full |
| draft/read-marker | `draft/read-marker` | ✅ Full |
| draft/channel-rename | `draft/channel-rename` | ✅ Full |
| draft/metadata-2 | `draft/metadata-2` | ✅ Full |
| draft/multiline | `draft/multiline` | ✅ Full |
| draft/webpush | `draft/webpush` | ✅ Full |
| draft/no-implicit-names | `draft/no-implicit-names` | ✅ Full |
| draft/extended-isupport | `draft/extended-isupport` | ✅ Full |
| draft/pre-away | `draft/pre-away` | ✅ Full |

---

## Gaps and Partial Implementations

### PARTIAL: Client Tags on PRIVMSG/NOTICE

**Issue**: Client-only tags (prefixed with `+`) are only relayed on TAGMSG, not PRIVMSG/NOTICE.

**Affected tags**:
- `+typing` - Typing indicators
- `+reply` - Reply to specific message
- `+react` - Emoji reactions
- `+channel-context` - Channel context for PMs

**Current behavior**:
- TAGMSG: ✅ Relays `cli_client_tags()` to recipients
- PRIVMSG: ❌ Does NOT relay client tags
- NOTICE: ❌ Does NOT relay client tags

**Fix needed**: Modify `ircd_relay.c` to use `sendcmdto_channel_client_tags()` for recipients with message-tags capability.

**Effort**: 4-8 hours

**Investigation**: [CHANNEL_CONTEXT_INVESTIGATION.md](CHANNEL_CONTEXT_INVESTIGATION.md)

---

### NOT IMPLEMENTED: MONITOR

**Spec**: https://ircv3.net/specs/extensions/monitor

**Issue**: MONITOR command not implemented. Nefarious uses WATCH instead.

**Difference**:
- WATCH: Non-standard, Nefarious implementation
- MONITOR: IRCv3 standard, different command syntax

**Priority**: Low (WATCH serves the same purpose)

**Effort**: 24-40 hours

**Investigation**: [MONITOR_INVESTIGATION.md](MONITOR_INVESTIGATION.md)

---

### NOT IMPLEMENTED: STS (Strict Transport Security)

**Spec**: https://ircv3.net/specs/extensions/sts

**Issue**: No STS capability to enforce TLS connections.

**Priority**: Medium-High (security benefit)

**Effort**: 32-48 hours

**Note**: STARTTLS intentionally not implemented (broken concept).

**Investigation**: [STS_INVESTIGATION.md](STS_INVESTIGATION.md)

---

### NOT IMPLEMENTED: UTF8ONLY

**Spec**: https://ircv3.net/specs/extensions/utf8only

**Issue**: No `UTF8ONLY` ISUPPORT token or enforcement.

**Priority**: Low

**Effort**: 8-16 hours

**Investigation**: [UTF8ONLY_INVESTIGATION.md](UTF8ONLY_INVESTIGATION.md)

---

### NOT IMPLEMENTED: network-icon

**Spec**: https://ircv3.net/specs/extensions/network-icon (proposal)

**Issue**: No branding icon metadata.

**Priority**: Very Low

**Effort**: 4-8 hours

**Investigation**: [NETWORK_ICON_INVESTIGATION.md](NETWORK_ICON_INVESTIGATION.md)

---

### MISSING ISUPPORT: TARGMAX

**Spec**: https://modern.ircdocs.horse/#targmax-parameter

**Issue**: TARGMAX token not advertised, which tells clients the max targets per command.

**Expected format**:
```
TARGMAX=PRIVMSG:4,NOTICE:4,KICK:4,JOIN:,PART:
```

**Priority**: Low (informational)

**Effort**: 1-2 hours

---

## Intentionally Not Implemented

| Spec | Reason |
|------|--------|
| STARTTLS | Broken concept - MITM can strip. Use direct TLS instead. |

---

## Client Tag Support Summary

| Tag | TAGMSG | PRIVMSG | NOTICE |
|-----|--------|---------|--------|
| `+typing` | ✅ | ❌ | ❌ |
| `+reply` | ✅ | ❌ | ❌ |
| `+react` | ✅ | ❌ | ❌ |
| `+channel-context` | ✅ | ❌ | ❌ |

---

## Recommendations

### High Priority
1. **STS** - Security improvement for enforcing TLS

### Medium Priority
2. **Client tags on PRIVMSG/NOTICE** - Easy fix, improves client compatibility
3. **TARGMAX ISUPPORT** - Quick addition

### Low Priority
4. MONITOR (WATCH alternative exists)
5. UTF8ONLY
6. network-icon

---

## Sources

- [IRCv3 Specifications](https://ircv3.net/irc/)
- [IRCv3 GitHub](https://github.com/ircv3/ircv3-specifications)
- [Modern IRC Docs](https://modern.ircdocs.horse/)
