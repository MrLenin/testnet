# X3 Session Tokens

Session-based authentication tokens for X3 Services with SCRAM credential support.

## Overview

Session tokens provide an alternative to password-based authentication. When a user authenticates via traditional means (AuthServ AUTH), X3 generates a session token that can be used for subsequent SASL authentication.

## Architecture

```
┌─────────────┐                    ┌────┐
│   Client    │──AUTH────────────►│ X3 │
│             │◄─Cookie───────────│    │
└─────────────┘                    └──┬─┘
      │                               │
      │  Store token                  ▼
      │                          ┌────────┐
      │                          │  LMDB  │
      │                          │ session│
      └──────────────────────────┤ scram  │
         SASL PLAIN (token)      └────────┘
```

## Token Generation

### AUTH Command Flow

1. User authenticates: `PRIVMSG AuthServ :AUTH account password`
2. X3 validates password (local or Keycloak)
3. X3 generates random 32-byte token
4. X3 hashes token and stores in LMDB
5. X3 generates SCRAM credentials from token
6. X3 responds: `NOTICE nick :Your session cookie is: <token>`

### Token Format

```
Generated: 32 random bytes → base64 encode → ~44 characters
Example: xK9mN2pQ8rS3tU6vW1xY4zA7bC0dE3fG5hI8jK1lM4n=
```

## Storage

### LMDB Keys

```
session:<account>           → Token hash:created:lastused
scram:sha1:<account>        → Session SCRAM-SHA-1
scram:sha256:<account>      → Session SCRAM-SHA-256
scram:sha512:<account>      → Session SCRAM-SHA-512
```

### Session Record Format

```
<token_hash>:<created_ts>:<lastused_ts>
```

### SCRAM Record Format

```
<salt>:<iterations>:<stored_key>:<server_key>
```

**Parameters**:
- Salt: 32 random bytes (base64)
- Iterations: 4096 (PBKDF2)
- Keys: Derived per SCRAM spec

## Authentication with Tokens

### SASL PLAIN

Tokens work seamlessly with SASL PLAIN:

```
Client: AUTHENTICATE PLAIN
Server: AUTHENTICATE +
Client: AUTHENTICATE <base64(account\0account\0token)>
Server: 903 :SASL authentication successful
```

### SASL SCRAM

Tokens also support challenge-response authentication:

```
Client: AUTHENTICATE SCRAM-SHA-256
Server: AUTHENTICATE +
Client: AUTHENTICATE <client-first-message>
Server: AUTHENTICATE <server-first-message>
Client: AUTHENTICATE <client-final-message>
Server: AUTHENTICATE <server-final-message>
Server: 903 :SASL authentication successful
```

## SCRAM Credential Types

X3 maintains separate SCRAM credentials for:

### Session Token SCRAM

- Generated on AUTH (when session created)
- Key: `scram:<type>:<account>`
- Used when client authenticates with session token

### Account Password SCRAM

- Generated on registration or password change
- Key: `scram_acct:<type>:<account>`
- Used when client authenticates with password

### Resolution Order

During SCRAM authentication:

1. Try session token SCRAM first
2. Fall back to account password SCRAM
3. Fail if neither matches

## Token Lifecycle

### Creation

- Generated on successful AUTH command
- Also generated on registration (if email verification disabled)

### Usage

- Last-used timestamp updated on each authentication
- Supports multiple concurrent sessions (one per AUTH)

### Revocation

```
PRIVMSG AuthServ :LOGOUT
```

Clears session token and SCRAM credentials from LMDB.

### Expiry

Currently tokens don't expire automatically. Future enhancement may add:
- Idle timeout
- Maximum lifetime
- Per-session configuration

## Benefits

### Client Storage

Clients store the session token instead of plaintext password:
- More secure for client-side storage
- Token revocation doesn't require password change

### SCRAM Enablement

Even if account password uses weak legacy hash:
- Session token generates fresh SCRAM credentials
- Enables SCRAM-SHA-256/512 for all users

### Reduced Password Exposure

- Password only sent once (initial AUTH)
- Subsequent connections use token
- Limits password exposure window

## Example Flow

```
# First connection - authenticate with password
USER nick 0 * :Real Name
NICK nick
PRIVMSG AuthServ :AUTH myaccount mypassword
-AuthServ- Your session cookie is: xK9mN2pQ8rS3tU6vW1xY4zA7...

# Client stores token

# Later connection - authenticate with token
CAP REQ :sasl
AUTHENTICATE PLAIN
AUTHENTICATE bXlhY2NvdW50AG15YWNjb3VudAB4SzltTjJwUThy...
:server 903 * :SASL authentication successful
```

## Security Considerations

1. **Token Secrecy**: Treat session tokens like passwords
2. **TLS Required**: Only use over encrypted connections
3. **Logout on Compromise**: LOGOUT clears all sessions
4. **No Password in Token**: Token cannot derive password

---

*Part of the X3 Services IRCv3.2+ upgrade project.*
