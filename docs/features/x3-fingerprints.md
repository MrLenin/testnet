# X3 Certificate Fingerprint Authentication

TLS client certificate authentication (SASL EXTERNAL) for X3 Services.

## Overview

Users can register TLS client certificate fingerprints with their accounts. When connecting with a registered certificate, SASL EXTERNAL authentication succeeds without a password.

## Architecture

```
┌─────────────┐                    ┌──────────┐                    ┌────┐
│   Client    │──TLS+Cert────────►│ Nefarious│──SA H + SA S─────►│ X3 │
│             │                    │ (extract │                    │    │
│             │◄─903 Success──────│  SHA256) │◄─SA D S───────────│    │
└─────────────┘                    └──────────┘                    └────┘
                                                                     │
                                                                ┌────▼────┐
                                                                │  LMDB   │
                                                                │ sslfp   │
                                                                │ certexp │
                                                                └─────────┘
```

## Fingerprint Registration

### Commands

```
PRIVMSG AuthServ :ADDSSLFP <fingerprint>     # Add fingerprint
PRIVMSG AuthServ :DELSSLFP <fingerprint>     # Remove fingerprint
PRIVMSG AuthServ :LISTSSLFP                  # List all fingerprints
```

### Automatic Registration

When `cert_autoregister=1`:

1. User connects with TLS client certificate
2. User authenticates via SASL PLAIN (password)
3. X3 automatically registers the certificate fingerprint
4. Future connections can use SASL EXTERNAL

## SASL EXTERNAL Flow

1. Client connects with TLS client certificate
2. Client requests: `AUTHENTICATE EXTERNAL`
3. Server extracts certificate SHA-256 fingerprint
4. Server sends fingerprint to X3 via `SA H`
5. X3 looks up fingerprint in LMDB
6. Match found: X3 returns `SA D S` (success)
7. Server completes authentication

## Storage

### LMDB Keys

```
sslfp:<account>:<fingerprint>    → Registration timestamp
certexp:<fingerprint>            → Certificate expiry timestamp
```

### Keycloak Attribute (optional)

```
sslfp.<fingerprint> = "<created_timestamp>:<last_used>"
```

## Certificate Expiry Tracking

Nefarious extracts certificate expiry and sends via P10 MARK:

```
AB MK ABAAB SSLCLIEXP :1735689600
```

X3 stores expiry and warns users:

**On Authentication**:
```
-AuthServ- Warning: Your certificate expires in 7 days
-AuthServ- Warning: Your certificate has EXPIRED
```

**In LISTSSLFP**:
```
-AuthServ- Fingerprint: SHA256:abc123...
-AuthServ-   Registered: 2024-12-01
-AuthServ-   Expires: 2025-03-01
```

## Configuration

### X3 Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `cert_autoregister` | 0 | Auto-register on PLAIN auth |

### Nefarious Settings

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CERT_EXPIRY_TRACKING` | TRUE | Send cert expiry via P10 |

## Multiple Fingerprints

Users can register multiple certificates:

- One per device (laptop, phone, etc.)
- Different expiry dates tracked separately
- Any registered fingerprint authenticates

## Security Considerations

### Fingerprint Format

- SHA-256 hash of DER-encoded certificate
- 64 hexadecimal characters
- Case-insensitive matching

### Revocation

No CRL/OCSP checking is performed. Users must manually remove compromised fingerprints:

```
PRIVMSG AuthServ :DELSSLFP <compromised_fingerprint>
```

### Certificate Requirements

- TLS client certificate must be presented during handshake
- Self-signed certificates are accepted
- X.509 format required

## Example Workflow

### First-Time Setup

```
# Connect with certificate, authenticate with password
/connect -ssl -ssl_cert /path/to/client.pem irc.example.com

# Register the fingerprint
/msg AuthServ ADDSSLFP SHA256:abc123def456...

# Or enable auto-registration
# (server config: cert_autoregister=1)
# Just authenticate once with PLAIN
```

### Subsequent Connections

```
# Connect with certificate
/connect -ssl -ssl_cert /path/to/client.pem irc.example.com

# Client automatically uses SASL EXTERNAL
CAP REQ :sasl
AUTHENTICATE EXTERNAL
AUTHENTICATE +
:server 903 * :SASL authentication successful
```

## P10 Protocol

### SA H (Host Info)

Sends client fingerprint to X3:

```
AB SA H ABAAB <hostname> <ip> <fingerprint>
```

### MARK SSLCLIEXP

Sends certificate expiry timestamp:

```
AB MK ABAAB SSLCLIEXP :1735689600
```

## OpServ Commands

```
SEARCH FINGERPRINT <partial>    # Find accounts by fingerprint
```

---

*Part of the X3 Services IRCv3.2+ upgrade project.*
