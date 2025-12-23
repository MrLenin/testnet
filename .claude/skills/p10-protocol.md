# P10 Protocol Skill

This skill provides expertise on the P10 server-to-server protocol used between Nefarious IRCd and X3 Services.

## Protocol Overview

P10 is the server-to-server protocol used by Undernet-derived IRC servers (including Nefarious). Messages use numeric identifiers for servers and users rather than names.

## Message Format

```
[SOURCE_NUMERIC] [TOKEN] [PARAMETERS...]
```

- **Source Numeric**: 2-char server numeric or 5-char user numeric (server + 3-char client)
- **Token**: 1-2 character command abbreviation (defined in `msg.h`)
- **Parameters**: Space-separated, last param can be prefixed with `:` for spaces

## Numeric Format

| Type | Format | Example | Description |
|------|--------|---------|-------------|
| Server | 2 chars | `AB` | Base64-encoded server ID |
| User | 5 chars | `ABAAA` | Server (2) + client suffix (3) |

The numeric is derived from the server's position in the network and uses a base64-like encoding (A-Z, a-z, 0-9, [, ]).

## Complete P10 Token Reference

### Core Commands
| Token | Full Command | Purpose |
|-------|--------------|---------|
| `N` | NICK | Introduce user / nick change |
| `Q` | QUIT | User disconnect |
| `S` | SERVER | Server introduction |
| `SQ` | SQUIT | Server quit |
| `P` | PRIVMSG | Private message |
| `O` | NOTICE | Notice message |
| `G` | PING | Ping request |
| `Z` | PONG | Ping response |

### Channel Commands
| Token | Full Command | Purpose |
|-------|--------------|---------|
| `J` | JOIN | Channel join |
| `L` | PART | Channel part |
| `K` | KICK | Channel kick |
| `I` | INVITE | Channel invite |
| `M` | MODE | Mode change |
| `T` | TOPIC | Topic change |
| `C` | CREATE | Channel creation |
| `B` | BURST | Netburst channel state |

### Services Commands
| Token | Full Command | Purpose |
|-------|--------------|---------|
| `AC` | ACCOUNT | Set/update user account |
| `FA` | FAKE/FAKEHOST | Set virtual host |
| `SASL` | SASL | SASL authentication relay |
| `MK` | MARK | Mark user with metadata |
| `SW` | SWHOIS | Set WHOIS extra info |
| `SM` | SVSMODE | Services mode change |
| `SN` | SVSNICK | Force nick change |
| `SJ` | SVSJOIN | Force channel join |
| `SP` | SVSPART | Force channel part |
| `SX` | SVSQUIT | Force quit |

### Administrative
| Token | Full Command | Purpose |
|-------|--------------|---------|
| `D` | KILL | Kill user |
| `GL` | GLINE | G-line (global ban) |
| `SU` | SHUN | Shun user |
| `ZL` | ZLINE | Z-line (IP ban) |
| `OM` | OPMODE | Oper mode change |
| `CM` | CLEARMODE | Clear channel modes |

### Netburst
| Token | Full Command | Purpose |
|-------|--------------|---------|
| `EB` | END_OF_BURST | End of netburst |
| `EA` | EOB_ACK | End of burst acknowledgment |

## SASL P10 Protocol

### Message Format
```
SASL <target> <source>!<fd>.<cookie> <subcmd> <data> [ext]
```

- **target**: Server numeric to route to (or `*` for broadcast)
- **source**: Server numeric that originated the request
- **fd**: File descriptor of the client connection
- **cookie**: Random session identifier for correlation
- **subcmd**: Single-character operation code
- **data**: Base64-encoded payload or mechanism name
- **ext**: Optional extension data (e.g., SSL client fingerprint)

### SASL Subcmd Codes

| Code | Direction | Meaning | Nef Handler | X3 Handler |
|------|-----------|---------|-------------|------------|
| `S` | Nef→X3 | Start (mechanism name) | Outbound only | `handle_sasl_input()` |
| `H` | Nef→X3 | Host info (`user@host:ip`) | Outbound only | `handle_sasl_input()` |
| `C` | Both | Continue (base64 auth data) | `m_sasl.c:178` | `handle_sasl_input()` |
| `D` | Both | Done (`S`=success, `F`=fail, `A`=abort) | `m_sasl.c:197` | `handle_sasl_input()` |
| `L` | X3→Nef | Login (account name, timestamp) | `m_sasl.c:181` | Outbound only |
| `M` | X3→Nef | Mechanisms list (for 908 numeric) | `m_sasl.c:212` | Outbound only |

**Important**: X3 may send `I` (Impersonation) but Nefarious does NOT handle it - silently ignored.

### SASL Flow - Pre-Registration

```
Client              Nefarious                    X3
  |                     |                         |
  |--CAP REQ :sasl----->|                         |
  |<--CAP ACK :sasl-----|                         |
  |--AUTHENTICATE PLAIN-|                         |
  |                     |--SASL tgt src S PLAIN-->|
  |                     |--SASL tgt src H user@host:ip
  |                     |                         |
  |                     |<--SASL src tgt C +------|  (request creds)
  |<--AUTHENTICATE +----|                         |
  |                     |                         |
  |--AUTHENTICATE <b64>-|                         |
  |                     |--SASL tgt src C <b64>-->|
  |                     |                         |
  |                     |<--SASL src tgt L acct---|  (login info)
  |                     |<--SASL src tgt D S------|  (done, success)
  |<--904 LOGGEDIN------|                         |
  |<--903 SASLSUCCESS---|                         |
  |--CAP END----------->|                         |
  |                     |                         |
```

### SASL Flow - Post-Registration (REAUTHENTICATE)

For token refresh after the user is already registered (introduced via `N`):

```
Client              Nefarious                    X3
  |                     |                         |
  |--AUTHENTICATE OAUTH-|                         |
  |                     |--SASL tgt src S OAUTH-->|  (reuse S subcmd)
  |                     |--SASL tgt src H user@host:ip
  |                     |                         |
  |                     |<--SASL src tgt C +------|
  |<--AUTHENTICATE +----|                         |
  |                     |                         |
  |--AUTHENTICATE <jwt>-|                         |
  |                     |--SASL tgt src C <jwt>-->|
  |                     |                         |
  |                     |<--SASL src tgt L newacct|  (may be same or different)
  |                     |<--SASL src tgt D S------|
  |<--904 LOGGEDIN------|                         |
  |<--903 SASLSUCCESS---|                         |
  |                     |                         |
  |                     |==AC usrnum newacct ts==>|  (broadcast if registered)
```

**Key**: After successful post-registration SASL, Nefarious MUST send `AC` to propagate the account change network-wide (only if user was already introduced via `N`).

## ACCOUNT (AC) Command

### Format
```
[SERVER] AC [USER_NUMERIC] [ACCOUNT_NAME] [TIMESTAMP] [SUBTYPE]
```

### Subtypes
| Code | Meaning |
|------|---------|
| `R` | Register (new account login) |
| `U` | Unregister (logout) |
| `M` | Modify (account change) |

### When to Send AC
- After successful SASL for a **registered** user (already introduced via `N`)
- When user logs in via NickServ IDENTIFY
- When user's account changes for any reason

### Example
```
AB AC ABAAB accountname 1703345678 R
```

## FAKEHOST (FA) Command

### Format
```
[SERVER] FA [USER_NUMERIC] [HOSTNAME]
```

Used for virtual hosts/cloaking. Fully implemented in both Nefarious (`TOK_FAKE`) and X3 (`irc_fakehost()`).

### Example
```
AB FA ABAAB user.vhost.network
```

## Key Implementation Files

### Nefarious
| File | Purpose |
|------|---------|
| `include/msg.h` | Token definitions (`MSG_*`, `TOK_*`, `CMD_*`) |
| `ircd/parse.c` | P10 message parsing and routing |
| `ircd/m_sasl.c` | SASL P10 message handler (inbound from X3) |
| `ircd/m_authenticate.c` | Client AUTHENTICATE → SASL P10 outbound |
| `ircd/send.c` | `sendcmdto_*` functions for P10 output |

### X3
| File | Purpose |
|------|---------|
| `src/proto-p10.c` | P10 protocol implementation, all `irc_*()` functions |
| `src/nickserv.c` | SASL handling (`sasl_packet()`, `handle_sasl_input()`) |
| `src/nickserv.c:6416` | `struct SASLSession` definition |

## X3 SASL Session Structure

```c
struct SASLSession {
    struct SASLSession* next;
    struct SASLSession* prev;
    struct server* source;      // Originating server
    char* buf, *p;              // Message buffer
    int buflen;
    char uid[128];              // Client identifier (server!fd.cookie)
    char mech[16];              // Mechanism (PLAIN, EXTERNAL, OAUTHBEARER)
    char* sslclifp;             // SSL client fingerprint
    char* hostmask;             // user@host:ip from H subcmd
    int flags;                  // SDFLAG_STALE etc.
};
```

## Validation Rules for P10 Changes

When reviewing P10 protocol changes:

1. **Backward Compatibility**: New subcmds should be additive; old servers should ignore unknown codes
2. **Numeric Format**: Server numerics are 2 chars, user numerics are 5 chars (server + 3-char suffix)
3. **Token Consistency**: Use existing tokens where applicable before creating new ones
4. **Direction Matters**: Verify which direction (Nef→X3 or X3→Nef) the message flows
5. **Handler Existence**: Check if Nefarious actually handles the subcmd (see table above)
6. **Cookie Preservation**: SASL sessions use `fd.cookie` for correlation - must be preserved across the session
7. **Account Propagation**: After successful auth for registered users, `AC` must be sent network-wide
8. **Token Definitions**: New commands need entries in `msg.h` (`MSG_*`, `TOK_*`, `CMD_*`)

## Common Mistakes to Avoid

1. **Assuming all X3 subcmds are handled by Nefarious** - e.g., `I` (Impersonation) is ignored
2. **Creating new P10 commands when existing ones suffice** - e.g., reuse `S` for reauth instead of new subcmd
3. **Forgetting to send `AC` after successful post-registration SASL**
4. **Incorrect numeric format** - must match server/user context
5. **Missing the `H` (host info) message after `S` in SASL flow**
6. **Not checking `IsSASLComplete()` state correctly** - this blocks re-auth in current code
7. **Forgetting that SASL data >400 bytes is chunked** - multiple `C` messages are concatenated

## Testing P10 Changes

1. **Packet Capture**: Use `tcpdump` or similar to capture S2S traffic
2. **Debug Logging**: Both Nefarious and X3 have debug log levels for SASL
3. **Single Server Test**: Test with one Nefarious + one X3 first
4. **Multi-Server Test**: Verify `AC` propagation across multiple servers
5. **Error Cases**: Test auth failure, timeout, abort scenarios
