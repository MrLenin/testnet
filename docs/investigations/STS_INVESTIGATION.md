# IRCv3 Strict Transport Security (STS) Extension Investigation

## Status: NOT IMPLEMENTED

**Specification**: https://ircv3.net/specs/extensions/sts

**Capability**: `sts`

**Effort**: Medium (32-48 hours)

**Priority**: Medium-High - Important for security, but requires careful implementation

---

## Why This Matters

STS (Strict Transport Security) forces clients to use TLS:
- Prevents downgrade attacks (man-in-the-middle forcing plaintext)
- Automatic upgrade from insecure to secure connections
- Similar to HTTPS HSTS in web browsers
- Critical for networks that want to enforce encryption

### STS vs STARTTLS (Important Distinction)

**STARTTLS** (deprecated, NOT implemented in Nefarious):
- In-band TLS upgrade on existing connection
- Vulnerable to stripping attacks (MITM removes STARTTLS)
- Considered a broken concept - intentionally not implemented

**STS** (this spec):
- NO in-band upgrade - client disconnects and reconnects
- Advertises secure port, client makes fresh TLS connection
- Policy caching prevents future plaintext attempts
- Much more secure design

---

## Specification Summary

### Capability Format

STS is advertised as a capability with key-value parameters:
```
CAP * LS :sts=port=6697,duration=2592000
```

### Keys

| Key | Context | Required | Description |
|-----|---------|----------|-------------|
| `port` | Insecure only | Yes | Secure port to connect to |
| `duration` | Secure only | Yes | Policy lifetime in seconds |
| `preload` | Secure only | No | Consent for preload lists |

### Upgrade Flow (Insecure Connection)

1. Client connects on plaintext port (6667)
2. Server advertises: `CAP * LS :sts=port=6697`
3. Client MUST disconnect immediately
4. Client reconnects on secure port (6697)
5. Client verifies TLS certificate
6. Server advertises: `CAP * LS :sts=duration=2592000`
7. Client caches policy for 30 days

### Persistence

Once a client receives a valid STS policy over TLS:
- Client MUST only use TLS for future connections
- Policy cached until `duration` expires
- Reconnecting extends the timer
- `duration=0` disables the policy

---

## Security Considerations

### Trust on First Use (TOFU)

STS has a bootstrap vulnerability:
- First connection can be intercepted
- Attacker can strip the STS capability
- Preload lists help (like HSTS preload)

### Certificate Validation

- Clients MUST validate TLS certificates
- Self-signed certs should trigger warnings
- Invalid certs should prevent connection

### Policy Removal

- Setting `duration=0` removes the policy
- Attacker could MITM to remove policy
- Some clients may require manual override

---

## Implementation Requirements

### Server-Side Changes

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_STS` enum |
| `include/ircd_features.h` | Add `FEAT_CAP_sts`, `FEAT_STS_PORT`, `FEAT_STS_DURATION` |
| `ircd/ircd_features.c` | Register features |
| `ircd/m_cap.c` | Advertise `sts` with appropriate keys |
| `ircd/listener.c` | Detect secure vs insecure connections |

### Configuration

```
features {
    "CAP_sts" = "TRUE";           /* Enable STS */
    "STS_PORT" = "6697";          /* Secure port */
    "STS_DURATION" = "2592000";   /* 30 days in seconds */
    "STS_PRELOAD" = "FALSE";      /* Consent for preload */
};
```

### Capability Value Generation

```c
/* On insecure connection */
"sts=port=6697"

/* On secure connection */
"sts=duration=2592000"

/* With preload consent */
"sts=duration=2592000,preload"
```

---

## Implementation Phases

### Phase 1: Connection Type Detection (8-12 hours)

1. Track whether connection is TLS or plaintext
2. Add helper function: `IsSecureClient(client)`
3. Ensure SSL/TLS listener properly marked

### Phase 2: Capability Advertisement (12-16 hours)

1. Add CAP_STS to capability system
2. Generate different values for secure vs insecure
3. Parse feature values for port/duration
4. Add preload key support

### Phase 3: Configuration (4-6 hours)

1. Add feature definitions
2. Document configuration options
3. Validate port number is valid
4. Validate duration is reasonable

### Phase 4: Testing (8-14 hours)

1. Test plaintext connection upgrade flow
2. Test secure connection policy caching
3. Test duration=0 policy removal
4. Test with various IRC clients

---

## Example Flows

### Upgrade Flow (Plaintext to TLS)

```
[Client connects to port 6667]
C: CAP LS 302
S: CAP * LS :sts=port=6697 multi-prefix sasl

[Client disconnects, reconnects to 6697 with TLS]
C: CAP LS 302
S: CAP * LS :sts=duration=2592000 multi-prefix sasl
C: CAP REQ :multi-prefix sasl
S: CAP * ACK :multi-prefix sasl
```

### Already Secure Connection

```
[Client connects to port 6697 with TLS]
C: CAP LS 302
S: CAP * LS :sts=duration=2592000 multi-prefix sasl
C: CAP REQ :multi-prefix
S: CAP * ACK :multi-prefix
```

### Policy Removal

```
[Client connects with TLS]
C: CAP LS 302
S: CAP * LS :sts=duration=0 multi-prefix sasl
[Client removes cached STS policy]
```

---

## Effort Breakdown

| Component | Effort |
|-----------|--------|
| Connection type detection | 8-12 hours |
| Capability advertisement | 12-16 hours |
| Configuration | 4-6 hours |
| Testing | 8-14 hours |
| **Total** | **32-48 hours** |

---

## Priority Assessment

**Medium-High Priority**:

1. **Security benefit**: Enforces TLS usage
2. **Modern expectation**: Users expect encrypted connections
3. **Spec compliance**: Part of modern IRCv3 ecosystem
4. **Medium complexity**: Not trivial but well-defined

### Considerations

- Requires TLS to be properly configured first
- Self-signed certs may cause client issues
- Some legacy clients don't support STS
- Misconfiguration can lock out users

---

## Client Support

| Software | Support |
|----------|---------|
| Ergo | Server |
| InspIRCd | Server |
| UnrealIRCd | Server |
| WeeChat | Client |
| Hexchat | Client (partial) |
| The Lounge | Client |
| **Nefarious** | **NOT IMPLEMENTED** |

---

## Prerequisites

Before implementing STS:

1. **TLS must work**: SSL/TLS listener must be functional
2. **Valid certificates**: Ideally use Let's Encrypt or similar
3. **Port configuration**: Both plaintext and secure ports defined
4. **DNS setup**: Clients need to find the server

---

## Edge Cases

1. **Port mismatch**: What if STS port differs from actual secure port?
2. **Listener down**: What if secure port is temporarily unavailable?
3. **Certificate renewal**: Policy continues during cert changes
4. **IPv4/IPv6**: STS applies to hostname, not IP
5. **Bouncer considerations**: Bouncers may need special handling

---

## References

- **Spec**: https://ircv3.net/specs/extensions/sts
- **HSTS (web)**: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security
- **Related**: CAP negotiation, TLS/SSL
