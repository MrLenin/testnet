# ECDSA-NIST256P-CHALLENGE SASL Mechanism Investigation

## Status: NOT IMPLEMENTED

**Mechanism**: `ECDSA-NIST256P-CHALLENGE`

**Reference**: [Atheme implementation](https://github.com/atheme/atheme/blob/master/modules/saslserv/ecdsa-nist256p-challenge.c)

**Effort**: Medium (24-40 hours)

**Priority**: Medium - Passwordless auth, good security

---

## Why This Matters

ECDSA-NIST256P-CHALLENGE provides passwordless SASL authentication:
- No password transmitted over the wire (unlike PLAIN)
- No challenge-response hash (unlike SCRAM) - uses asymmetric crypto
- User registers public key, authenticates with private key
- Similar security model to SSH public key authentication
- Supported by WeeChat, KICL, Irssi, and other modern clients

### Comparison with Other Mechanisms

| Mechanism | Credential | Security | Client Support |
|-----------|------------|----------|----------------|
| PLAIN | Password | Weak (requires TLS) | Universal |
| SCRAM-SHA-256 | Password | Strong | Good |
| EXTERNAL | TLS cert | Strong | Moderate |
| **ECDSA-NIST256P** | ECDSA key | Strong | Good |

---

## Specification Summary

### Cryptographic Details

- **Curve**: NIST P-256 (secp256r1, prime256v1)
- **Challenge size**: 32 bytes
- **Signature**: ECDSA signature of raw challenge bytes
- **Public key format**: X9.62 compressed point, base64 encoded

### Authentication Flow

```
Client: CAP REQ :sasl
Server: CAP * ACK :sasl

Client: AUTHENTICATE ECDSA-NIST256P-CHALLENGE
Server: AUTHENTICATE +

Client: AUTHENTICATE <base64(accountname\0accountname)>
Server: AUTHENTICATE <base64(32-byte-challenge)>

Client: AUTHENTICATE <base64(ecdsa-signature)>
Server: :server 903 * :SASL authentication successful
```

### Key Registration

Users register their public key with NickServ:
```
/msg NickServ SET PUBKEY <base64-compressed-pubkey>
```

Public key format (X9.62 compressed):
- 33 bytes: 0x02 or 0x03 prefix + 32-byte X coordinate
- Base64 encoded for storage

---

## Implementation Requirements

### X3 Changes

| Component | Changes |
|-----------|---------|
| `src/nickserv.c` | Add `SET PUBKEY` command |
| `src/proto-p10.c` | Handle ECDSA SASL in SA handler |
| `src/keycloak.c` | Optional: Store pubkey as user attribute |
| Database | Add `pubkey` field to account storage |

### NickServ Commands

```
SET PUBKEY <base64-pubkey>    Set ECDSA public key
SET PUBKEY *                  Remove ECDSA public key
SHOWCOMMANDS                  Show if PUBKEY is set
```

### SASL Handler

```c
/* In SA handler for ECDSA-NIST256P-CHALLENGE */
case SASL_STATE_ECDSA_WAIT_ACCOUNT:
    /* Decode account name, lookup pubkey */
    break;

case SASL_STATE_ECDSA_WAIT_SIGNATURE:
    /* Verify ECDSA signature against challenge */
    if (ecdsa_verify(pubkey, challenge, signature))
        sasl_success();
    else
        sasl_fail();
    break;
```

### Dependencies

- OpenSSL (already used for TLS)
- `EC_KEY` APIs for NIST P-256
- `ECDSA_verify()` for signature verification

---

## Implementation Phases

### Phase 1: Key Storage (8-12 hours)

1. Add `pubkey` field to NickServ account struct
2. Add `SET PUBKEY` command to NickServ
3. Validate public key format (33 bytes, valid curve point)
4. Store in SAXDB/LMDB

### Phase 2: SASL Handler (12-16 hours)

1. Add `ECDSA-NIST256P-CHALLENGE` to mechanism list
2. Implement challenge generation (32 random bytes)
3. Implement signature verification using OpenSSL EC APIs
4. Add state machine states for ECDSA flow

### Phase 3: Keycloak Integration (Optional) (4-8 hours)

1. Store pubkey as user attribute in Keycloak
2. Sync pubkey on SASL success
3. Support pubkey in Keycloak-managed accounts

### Phase 4: Testing (4-6 hours)

1. Generate test keypairs with ecdsatool
2. Test with WeeChat ECDSA support
3. Test edge cases (invalid signature, wrong key, etc.)

---

## Code Examples

### Public Key Validation

```c
#include <openssl/ec.h>
#include <openssl/ecdsa.h>

int validate_ecdsa_pubkey(const char *base64_pubkey) {
    unsigned char *pubkey_bytes;
    size_t pubkey_len;
    EC_KEY *eckey;
    EC_GROUP *group;
    EC_POINT *point;

    /* Decode base64 */
    pubkey_bytes = base64_decode(base64_pubkey, &pubkey_len);
    if (pubkey_len != 33) return 0;  /* Compressed point is 33 bytes */

    /* Create EC key with P-256 curve */
    group = EC_GROUP_new_by_curve_name(NID_X9_62_prime256v1);
    point = EC_POINT_new(group);

    /* Decode compressed point */
    if (!EC_POINT_oct2point(group, point, pubkey_bytes, pubkey_len, NULL)) {
        /* Invalid point */
        return 0;
    }

    /* Point is valid */
    EC_POINT_free(point);
    EC_GROUP_free(group);
    return 1;
}
```

### Signature Verification

```c
int verify_ecdsa_signature(const char *base64_pubkey,
                           const unsigned char *challenge,
                           size_t challenge_len,
                           const unsigned char *signature,
                           size_t sig_len) {
    EC_KEY *eckey;
    unsigned char *pubkey_bytes;
    size_t pubkey_len;
    int result;

    pubkey_bytes = base64_decode(base64_pubkey, &pubkey_len);

    eckey = EC_KEY_new_by_curve_name(NID_X9_62_prime256v1);
    EC_KEY_oct2key(eckey, pubkey_bytes, pubkey_len, NULL);

    /* IMPORTANT: Sign raw challenge, NOT a hash of it */
    result = ECDSA_verify(0, challenge, challenge_len,
                          signature, sig_len, eckey);

    EC_KEY_free(eckey);
    return result == 1;
}
```

---

## Effort Breakdown

| Component | Effort |
|-----------|--------|
| Key storage & NickServ command | 8-12 hours |
| SASL handler implementation | 12-16 hours |
| Keycloak integration (optional) | 4-8 hours |
| Testing | 4-6 hours |
| **Total** | **28-42 hours** |

---

## Priority Assessment

**Medium Priority**:

1. **Security benefit**: No password transmission
2. **Modern approach**: SSH-style public key auth
3. **Client support**: WeeChat, KICL, Irssi already support it
4. **Complements EXTERNAL**: Alternative to TLS client certs
5. **Medium complexity**: Well-defined, reference implementation exists

### Considerations

- Only Atheme implements this on server side currently
- Requires user key management (ecdsatool or openssl)
- Less intuitive than passwords for casual users
- Best for power users and bots

---

## Client Support

| Software | Support |
|----------|---------|
| WeeChat | ✅ Client |
| KICL | ✅ Client |
| Irssi | ✅ Client (cap_sasl.pl) |
| Textual | ✅ Client |
| HexChat | ❌ Not supported |
| **Atheme** | ✅ **Server** |
| **X3** | ❌ **NOT IMPLEMENTED** |

---

## Key Generation

### Using ecdsatool

```bash
# Install ecdsatool
git clone https://github.com/kaniini/ecdsatool
cd ecdsatool && make

# Generate keypair
ecdsatool keygen > ~/.irc_ecdsa_key.pem

# Get public key for NickServ
ecdsatool pubkey ~/.irc_ecdsa_key.pem
# Output: AhR7...base64...
```

### Using OpenSSL

```bash
# Generate private key
openssl ecparam -name prime256v1 -genkey -out key.pem

# Extract public key (compressed)
openssl ec -in key.pem -pubout -conv_form compressed -outform DER | \
    tail -c 33 | base64
```

---

## References

- [Atheme Implementation](https://github.com/atheme/atheme/blob/master/modules/saslserv/ecdsa-nist256p-challenge.c)
- [ecdsatool](https://github.com/kaniini/ecdsatool)
- [WeeChat ECDSA Blog Post](https://blog.weechat.org/post/2015/02/08/SASL-ECDSA-NIST256P-CHALLENGE)
- [KICL ECDSA Docs](https://kitteh-irc-client-library.readthedocs.io/en/latest/advanced/ecdsa/)
- [macOS Setup Guide](https://gist.github.com/Someguy123/c420aa05e7c4ca62ba109b3487f099a3)
