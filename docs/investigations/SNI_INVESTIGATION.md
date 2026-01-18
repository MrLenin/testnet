# SNI (Server Name Indication) Investigation

## Status: IMPLEMENTED ✅

**Documentation**: https://ircv3.net/docs/sni

**Protocol**: TLS extension (RFC 6066)

**Implementation Date**: 2026-01-17

**Priority**: Medium - Important for multi-certificate deployments

---

## Implementation Summary

SNI support is implemented using a dedicated `SSL` config block for unlimited hostname/certificate pairs.

### Configuration

```
SSL {
    "irc.example.net" {
        certificate = "/path/to/irc.example.net.crt";
        key = "/path/to/irc.example.net.key";
    };
    "server.example.net" {
        certificate = "/path/to/server.example.net.crt";
        key = "/path/to/server.example.net.key";
    };
};
```

### Files Modified

| File | Changes |
|------|---------|
| `include/s_conf.h` | Added `struct SSLCertConf`, `sslCertConfList` extern |
| `ircd/s_conf.c` | Added `sslCertConfList` definition, `clear_sslcert_confs()` |
| `ircd/ircd_lexer.l` | Added `CERTIFICATE` and `KEY` tokens |
| `ircd/ircd_parser.y` | Added `sslblock` grammar |
| `ircd/ssl.c` | Added SNI callback, certificate loading, uses config list |

### How It Works

1. Config parser reads SSL block entries into `sslCertConfList` linked list
2. On startup, `sni_init_certs()` loads certificates from the config list
3. SNI callback registered via `SSL_CTX_set_tlsext_servername_callback()`
4. During TLS handshake, `sni_callback()` checks client's SNI hostname
5. If match found, `SSL_set_SSL_CTX()` switches to the matching certificate
6. On rehash, `clear_sslcert_confs()` clears the list before reparsing config
7. On SIGUSR1, certificates are reloaded automatically

---

## Why This Matters

SNI allows a server to host multiple TLS certificates and select the correct one based on the hostname the client requests:
- Server can have different certs for `irc.example.net` and `server.example.net`
- Virtual hosting for IRC networks with multiple server names
- Load balancers can route based on SNI hostname
- Required by modern TLS best practices

### Use Cases

1. **Multiple server names**: One IRCd serving multiple hostnames with different certificates
2. **Certificate renewal**: Seamlessly switch between old and new certificates
3. **Network federation**: Different certificates for different network segments
4. **Reverse proxies**: Load balancers use SNI for routing decisions

---

## Specification Summary

### Client Requirements

Per IRCv3 recommendation:
> Clients MUST use SNI when connecting to servers via TLS.

This requires TLS 1.1 or higher.

### Server Requirements

1. Accept SNI extension from client during TLS handshake
2. Select appropriate certificate based on requested hostname
3. Fall back to default certificate if hostname unknown

### Protocol Flow

```
Client ──────────────────────────────────────────────► Server
        TLS ClientHello
        + SNI extension: "irc.example.net"

Server ◄─────────────────────────────────────────────
        Selects certificate for "irc.example.net"
        TLS ServerHello + Certificate
```

---

## Current Implementation

**Nefarious**: Full SNI support in `ircd/ssl.c`
- Default `ssl_server_ctx` used when no SNI match
- `SSL_CTX_set_tlsext_servername_callback()` registered for hostname matching
- Up to 2 additional certificates selectable via SNI hostname
- Automatic reload on SIGUSR1

---

## Implementation Requirements

### OpenSSL APIs Needed

```c
#include <openssl/ssl.h>

/* Set SNI callback */
SSL_CTX_set_tlsext_servername_callback(ctx, sni_callback);
SSL_CTX_set_tlsext_servername_arg(ctx, user_data);

/* In callback, get requested hostname */
const char *hostname = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);

/* Switch SSL context based on hostname */
SSL_set_SSL_CTX(ssl, matching_ctx);
```

### Configuration

```
SSL {
    default {
        certificate = "certs/default.crt";
        key = "certs/default.key";
    };

    /* Additional certificates for SNI */
    "irc.example.net" {
        certificate = "certs/irc.example.net.crt";
        key = "certs/irc.example.net.key";
    };

    "server.example.net" {
        certificate = "certs/server.example.net.crt";
        key = "certs/server.example.net.key";
    };
};
```

### Files to Modify

| File | Changes |
|------|---------|
| `ircd/ssl.c` | Add SNI callback, certificate selection |
| `include/ssl.h` | Add multi-cert data structures |
| `ircd/s_conf.c` | Parse multi-cert configuration |
| `ircd/ircd_parser.y` | Add SSL block grammar |
| `include/s_conf.h` | Add cert storage structures |

---

## Implementation Steps

### Step 1: Certificate Storage (3-4 hours)

Create data structure for multiple certificates:

```c
struct ssl_cert {
    char *hostname;        /* NULL for default */
    SSL_CTX *ctx;          /* Context with this cert loaded */
    char *cert_file;
    char *key_file;
    struct ssl_cert *next;
};

static struct ssl_cert *ssl_certs = NULL;
```

### Step 2: SNI Callback (2-3 hours)

```c
static int sni_callback(SSL *ssl, int *al, void *arg)
{
    const char *hostname = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
    struct ssl_cert *cert;

    if (!hostname)
        return SSL_TLSEXT_ERR_NOACK;

    /* Find matching certificate */
    for (cert = ssl_certs; cert; cert = cert->next) {
        if (cert->hostname && !strcasecmp(cert->hostname, hostname)) {
            SSL_set_SSL_CTX(ssl, cert->ctx);
            return SSL_TLSEXT_ERR_OK;
        }
    }

    /* No match - use default */
    return SSL_TLSEXT_ERR_NOACK;
}
```

### Step 3: Context Initialization (2-3 hours)

```c
SSL_CTX *ssl_init_server_ctx(void)
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());

    /* ... existing setup ... */

    /* Set SNI callback */
    SSL_CTX_set_tlsext_servername_callback(ctx, sni_callback);

    return ctx;
}
```

### Step 4: Configuration Parsing (3-4 hours)

Add grammar to ircd_parser.y for multi-cert SSL blocks.

### Step 5: Testing (2-3 hours)

1. Configure multiple certificates
2. Test with `openssl s_client -servername hostname`
3. Verify correct certificate selected
4. Test fallback to default

---

## Effort Breakdown

| Component | Effort |
|-----------|--------|
| Certificate storage | 3-4 hours |
| SNI callback | 2-3 hours |
| Context initialization | 2-3 hours |
| Configuration parsing | 3-4 hours |
| Testing | 2-3 hours |
| **Total** | **12-17 hours** |

---

## Priority Assessment

**Medium Priority**:

1. **Modern TLS requirement**: Clients should use SNI
2. **Multi-server networks**: Common to have different hostnames
3. **Reverse proxy compatibility**: SNI needed for routing
4. **Certificate management**: Easier with multiple certs per hostname

### When NOT Critical

- Single-hostname deployments
- Networks using wildcard certificates
- Behind TLS-terminating proxy that handles SNI

---

## Testing

### Manual Testing

```bash
# Test SNI with specific hostname
openssl s_client -connect irc.example.net:6697 -servername irc.example.net

# Test without SNI (should get default cert)
openssl s_client -connect irc.example.net:6697 -noservername

# Verify certificate subject
openssl s_client -connect irc.example.net:6697 -servername irc.example.net 2>/dev/null | \
    openssl x509 -noout -subject
```

### Integration Testing

1. Configure two different certificates
2. Connect with each hostname via SNI
3. Verify correct certificate returned
4. Test certificate reload with SIGHUP

---

## Client Support

Most modern IRC clients support SNI by default:

| Client | SNI Support |
|--------|-------------|
| WeeChat | ✅ Yes |
| The Lounge | ✅ Yes |
| HexChat | ✅ Yes |
| Irssi | ✅ Yes |
| mIRC | ✅ Yes |
| IRCCloud | ✅ Yes |

---

## Related Work

- **STS**: Uses SNI hostname for policy caching
- **Certificate fingerprints**: SASL EXTERNAL relies on correct cert
- **Let's Encrypt**: Can issue multiple certs for different hostnames

---

## References

- **IRCv3 SNI Doc**: https://ircv3.net/docs/sni
- **RFC 6066**: TLS Extensions (SNI specification)
- **OpenSSL SNI**: https://wiki.openssl.org/index.php/Hostname_validation
