# SASL Authentication

Implementation of SASL (Simple Authentication and Security Layer) in Nefarious IRCd and X3 Services.

## Overview

SASL provides secure authentication during IRC connection establishment, before the user fully registers. This enables:

- Pre-registration authentication for cloaked hosts
- Multiple authentication mechanisms (passwords, certificates, challenge-response)
- Integration with external identity providers (Keycloak)

## Supported Mechanisms

| Mechanism | Description | Security |
|-----------|-------------|----------|
| `PLAIN` | Username/password or session token | Requires TLS |
| `EXTERNAL` | TLS client certificate fingerprint | Strong |
| `SCRAM-SHA-1` | Challenge-response with SHA-1 | Good |
| `SCRAM-SHA-256` | Challenge-response with SHA-256 | Strong |
| `SCRAM-SHA-512` | Challenge-response with SHA-512 | Strongest |
| `OAUTHBEARER` | OAuth2 bearer token (Keycloak only) | Strong |

**Note**: OAUTHBEARER is only available when Keycloak integration is enabled.

## Architecture

```
┌─────────┐                    ┌──────────┐                    ┌────┐
│ Client  │──AUTHENTICATE────►│ Nefarious│──SA S/C/D────────►│ X3 │
│         │                    │          │                    │    │
│         │◄─AUTHENTICATE─────│          │◄─SA S/C/D─────────│    │
└─────────┘                    └──────────┘                    └────┘
     │                               │                           │
     │  CAP REQ :sasl               │                           │
     │  AUTHENTICATE PLAIN          │  SA S <user> <mechanism>  │
     │  AUTHENTICATE <base64>       │  SA C <user> <data>       │
     │                               │  SA D <user> <result>     │
```

## P10 Protocol

**Token**: `SA` (SASL)

**Subcommands**:

| Subcmd | Format | Direction | Purpose |
|--------|--------|-----------|---------|
| `S` | `SA S <user> * <mechanism>` | Server → X3 | Start auth |
| `H` | `SA H <user> <hostname> <ip>` | Server → X3 | Host info |
| `C` | `SA C <user> * <base64>` | Bidirectional | Auth data |
| `D` | `SA D <user> <result> :<message>` | X3 → Server | Auth result |
| `L` | `SA L <user> <account>` | X3 → Server | Login notification |
| `M` | `SA * * M :<mechanisms>` | X3 → All | Mechanism broadcast |

**Result codes**:
- `S` - Success
- `F` - Failure

## Client Flow

### PLAIN Authentication

```
Client: CAP LS 302
Server: CAP * LS :sasl=PLAIN,SCRAM-SHA-256

Client: CAP REQ :sasl
Server: CAP * ACK :sasl

Client: AUTHENTICATE PLAIN
Server: AUTHENTICATE +

Client: AUTHENTICATE dXNlcgB1c2VyAHBhc3N3b3Jk   # base64(user\0user\0password)
Server: :server 903 * :SASL authentication successful
Server: :server 900 * nick!user@host nick :You are now logged in as nick
```

### EXTERNAL Authentication

```
Client: CAP REQ :sasl
Server: CAP * ACK :sasl

Client: AUTHENTICATE EXTERNAL
Server: AUTHENTICATE +

Client: AUTHENTICATE +                            # Empty for fingerprint auth
Server: :server 903 * :SASL authentication successful
```

### SCRAM Authentication

```
Client: AUTHENTICATE SCRAM-SHA-256
Server: AUTHENTICATE +

Client: AUTHENTICATE <client-first-message>
Server: AUTHENTICATE <server-first-message>

Client: AUTHENTICATE <client-final-message>
Server: AUTHENTICATE <server-final-message>

Server: :server 903 * :SASL authentication successful
```

### OAUTHBEARER Authentication

For OAuth2-enabled clients (requires Keycloak):

```
Client: CAP LS 302
Server: CAP * LS :sasl=PLAIN,OAUTHBEARER,...

Client: CAP REQ :sasl
Server: CAP * ACK :sasl

Client: AUTHENTICATE OAUTHBEARER
Server: AUTHENTICATE +

Client: AUTHENTICATE <base64(n,a=user,^Aauth=Bearer <token>^A^A)>
Server: :server 903 * :SASL authentication successful
```

**Payload Format** (RFC 7628):
```
n,a=<authzid>,\x01auth=Bearer <access_token>\x01\x01
```

**Auto-Account Creation**: With `keycloak_autocreate=1`, accounts are automatically created for Keycloak users authenticating via OAUTHBEARER.

## Session Tokens

X3 implements a dual-credential system where users can authenticate with either their account password OR a session token.

### Token Generation

1. User authenticates traditionally: `PRIVMSG AuthServ :AUTH account password`
2. X3 generates random session token
3. X3 stores token hash in LMDB: `session:<account>`
4. X3 responds: `NOTICE nick :Your session cookie is: <token>`

### Token Usage

Session tokens work with both PLAIN and SCRAM:

```
AUTHENTICATE PLAIN
AUTHENTICATE <base64(account\0account\0sessiontoken)>
```

### Token Benefits

- Clients store token instead of plaintext password
- Tokens can be revoked without changing password
- Enables SCRAM even with legacy password hashes

## SCRAM Credential Storage

X3 generates SCRAM credentials for both session tokens and account passwords:

```
LMDB Keys:
  scram:sha1:<account>      → Session token SCRAM-SHA-1
  scram:sha256:<account>    → Session token SCRAM-SHA-256
  scram:sha512:<account>    → Session token SCRAM-SHA-512
  scram_acct:sha1:<account> → Password SCRAM-SHA-1
  scram_acct:sha256:<account> → Password SCRAM-SHA-256
  scram_acct:sha512:<account> → Password SCRAM-SHA-512
```

**Value Format**:
```
<salt>:<iterations>:<stored_key>:<server_key>
```

**Parameters**:
- Salt: 32 random bytes (base64)
- Iterations: 4096 (PBKDF2)
- Keys: SHA-derived from password/token

## Mechanism Broadcast

On startup, X3 broadcasts available mechanisms to all servers:

```
Az SA * * M :PLAIN,EXTERNAL,SCRAM-SHA-1,SCRAM-SHA-256,SCRAM-SHA-512
```

Nefarious uses this to populate the `sasl=` capability value.

## Keycloak Integration

When Keycloak is enabled:

1. PLAIN credentials validated against Keycloak REST API
2. Session tokens still stored in LMDB (local to X3)
3. SCRAM credentials generated from Keycloak password (when available)
4. Certificate fingerprints stored as Keycloak user attributes

## Feature Flags

### Nefarious

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_sasl` | TRUE | Advertise SASL capability |

### X3

| Setting | Description |
|---------|-------------|
| `sasl_enable` | Enable SASL authentication |
| `sasl_timeout` | Auth timeout in seconds |

## Certificate Fingerprint Authentication

SASL EXTERNAL uses TLS client certificate fingerprints:

1. Client connects with TLS client certificate
2. Client requests SASL EXTERNAL
3. Server extracts certificate SHA-256 fingerprint
4. X3 matches fingerprint to registered account
5. Authentication succeeds without password

### Registering Fingerprints

```
/msg AuthServ ADDSSLFP <fingerprint>
/msg AuthServ LISTSSLFP
/msg AuthServ DELSSLFP <fingerprint>
```

### Auto-Registration

With `cert_autoregister=1`, fingerprints are automatically registered when a user authenticates via SASL PLAIN while connected with a TLS certificate.

## Error Handling

| Numeric | Meaning |
|---------|---------|
| 903 | Authentication successful |
| 904 | Authentication failed |
| 905 | Mechanism too long |
| 906 | Aborted |
| 907 | Already authenticated |
| 908 | Mechanisms available |

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*
