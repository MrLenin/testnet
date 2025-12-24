# IRCv3 Account Registration Extension Investigation

## Status: INVESTIGATING (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/account-registration

**Capability**: `draft/account-registration`

---

## Specification Summary

The account-registration extension enables clients to register accounts directly via IRC protocol, without requiring web interfaces or email-based registration systems. This modernizes IRC by allowing:
- In-client account creation
- Pre-connection registration (for bouncers)
- Verification workflows (email, CAPTCHA, etc.)

---

## Capability Value Tokens

The capability may include comma-separated tokens:

| Token | Description |
|-------|-------------|
| `before-connect` | Registration allowed before connection completion |
| `email-required` | Valid email address mandatory |
| `custom-account-name` | Account name can differ from current nickname |

**Example**: `CAP LS :draft/account-registration=before-connect,email-required`

---

## REGISTER Command

**Syntax**: `REGISTER <account> {<email> | "*"} <password>`

| Parameter | Description |
|-----------|-------------|
| `<account>` | Account name to register (`*` = current nickname) |
| `<email>` | Email address (`*` = none/anonymous) |
| `<password>` | Account password (UTF-8 recommended, max ~300 bytes) |

**Example**:
```
REGISTER mynick user@example.com mysecretpassword
REGISTER * * mypassword
```

---

## VERIFY Command

**Syntax**: `VERIFY <account> <code>`

Used to complete registrations that require additional verification.

**Example**:
```
VERIFY mynick ABC123
```

---

## Server Responses

### Success Responses

| Response | Description |
|----------|-------------|
| `REGISTER SUCCESS <account> <message>` | Registration complete, client authenticated |
| `VERIFY SUCCESS <account> <message>` | Verification complete, client authenticated |
| `REGISTER VERIFICATION_REQUIRED <account> <message>` | Further action needed |

### Error Responses (using standard-replies)

| Error Code | Condition |
|------------|-----------|
| `ACCOUNT_EXISTS` | Account name already registered |
| `BAD_ACCOUNT_NAME` | Invalid or restricted name |
| `ACCOUNT_NAME_MUST_BE_NICK` | Name must match current nickname |
| `NEED_NICK` | Sent before NICK command (with `before-connect`) |
| `ALREADY_AUTHENTICATED` | Client already logged in |
| `WEAK_PASSWORD` | Password doesn't meet strength requirements |
| `INVALID_EMAIL` | Email address unreachable/invalid |
| `TEMPORARILY_UNAVAILABLE` | Service temporarily unavailable |

### Verification Errors

| Error Code | Condition |
|------------|-----------|
| `INVALID_CODE` | Verification code invalid or expired |

---

## Dependencies

| Dependency | Status in Nefarious |
|------------|---------------------|
| `standard-replies` | Complete |
| SASL framework | Complete |

---

## Implementation Architecture

### Option A: X3 Services Integration (Recommended)

Since X3 already handles account management, registration should flow through X3:

```
Client <--IRC--> Nefarious <--P10--> X3
                              |
                         Account DB
```

**Flow**:
1. Client sends `REGISTER` to Nefarious
2. Nefarious relays to X3 via new P10 command
3. X3 validates and creates account
4. X3 sends success/failure back to Nefarious
5. Nefarious responds to client

### Option B: Direct to Keycloak

If using Keycloak for auth:

```
Client <--IRC--> Nefarious <--P10--> X3 <--HTTP--> Keycloak
```

**Flow**:
1. Client sends `REGISTER` to Nefarious
2. Relayed to X3
3. X3 calls Keycloak Admin API to create user
4. Result returned to client

---

## P10 Protocol Design

### New Token: `RG` (REGISTER)

**Format**:
```
[USER_NUMERIC] RG <account> <email> <password_hash>
```

Note: Password should be hashed before P10 transmission, or sent over secure link only.

### Response Token: `RR` (REGISTER RESPONSE)

**Format**:
```
[SERVER] RR <user_numeric> <status> <account> :<message>
```

Where `<status>` is:
- `S` - Success
- `F` - Failure
- `V` - Verification required

---

## Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `include/capab.h` | Add `CAP_ACCOUNTREG` |
| `include/ircd_features.h` | Add `FEAT_CAP_account_registration` |
| `ircd/ircd_features.c` | Register feature (default: FALSE) |
| `ircd/m_cap.c` | Add `draft/account-registration` to capability list |
| `include/msg.h` | Add `MSG_REGISTER`, `MSG_VERIFY`, tokens |
| `include/handlers.h` | Add handler declarations |
| `ircd/m_register.c` | New file: REGISTER/VERIFY handlers |
| `ircd/parse.c` | Register commands |
| `ircd/Makefile.in` | Add m_register.c |

---

## Files to Modify (X3)

| File | Changes |
|------|---------|
| `src/proto-p10.c` | Handle RG command |
| `src/nickserv.c` | Registration logic, Keycloak integration |
| `src/nickserv.h` | Data structures |

---

## Implementation Phases

### Phase 1: Basic Registration (No Verification)

1. Add capability and feature flag
2. Implement REGISTER command in Nefarious
3. Add P10 RG command
4. X3 handler creates account
5. Return success/failure to client

**Effort**: Medium (16-24 hours)

### Phase 2: Email Verification

1. Add `email-required` capability token
2. X3 sends verification email
3. Implement VERIFY command
4. Track pending verifications

**Effort**: High (24-32 hours, requires email infrastructure)

### Phase 3: Keycloak Integration

1. X3 calls Keycloak Admin API
2. Handle Keycloak-specific errors
3. Support Keycloak email verification

**Effort**: Medium (16-24 hours)

---

## Security Considerations

1. **Rate limiting**: Prevent registration spam
2. **Password hashing**: Never transmit/log plaintext passwords
3. **Email validation**: Verify email format before sending
4. **CAPTCHA**: Consider CAPTCHA for anonymous registration
5. **IP tracking**: Log registration IPs for abuse prevention

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Capability negotiation | Low | Low |
| REGISTER command | Medium | Low |
| P10 protocol | Medium | Medium |
| X3 integration | High | Medium |
| Email verification | High | High |
| Keycloak integration | Medium | Medium |

**Total**: High effort (56-80 hours for full implementation)

---

## Recommendation

1. **Implement Phase 1 first**: Basic registration without verification
2. **Skip email verification initially**: Complex infrastructure requirement
3. **Keycloak integration optional**: Depends on deployment needs
4. **Feature flag disabled by default**: `FEAT_CAP_account_registration = FALSE`

---

## Client Support

| Client | Support |
|--------|---------|
| Ergo | Native (server) |
| soju | Bouncer support |
| Goguma | Mobile client |

Note: Limited client support currently.

---

## References

- **Spec**: https://ircv3.net/specs/extensions/account-registration
- **Standard Replies**: https://ircv3.net/specs/extensions/standard-replies
- **Related**: SASL authentication
