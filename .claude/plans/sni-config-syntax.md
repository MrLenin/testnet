# SNI Proper Config Syntax Plan

## Status: IMPLEMENTED ✅

**Implementation Date**: 2026-01-18

---

## Implementation Summary

### Files Modified

| File | Changes |
|------|---------|
| `include/s_conf.h` | Added `struct SSLCertConf`, `sslCertConfList` extern, `clear_sslcert_confs()` |
| `ircd/s_conf.c` | Added `sslCertConfList` definition, `clear_sslcert_confs()`, rehash integration |
| `ircd/ircd_lexer.l` | Added `CERTIFICATE` and `KEY` tokens |
| `ircd/ircd_parser.y` | Added `sslblock` grammar with nested hostname blocks |
| `ircd/ssl.c` | Changed from fixed array to linked list, use config list instead of feature flags |
| `include/ircd_features.h` | Removed `FEAT_SNI_HOSTNAME1/2`, `FEAT_SNI_CERTFILE1/2`, `FEAT_SNI_KEYFILE1/2` |
| `ircd/ircd_features.c` | Removed corresponding feature flag definitions |

### New Config Syntax

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

---

## Previous State (Removed)

SNI was implemented using numbered feature flags:
```
features {
    "SNI_HOSTNAME1" = "irc.example.net";
    "SNI_CERTFILE1" = "/path/to/cert.crt";
    "SNI_KEYFILE1" = "/path/to/key.key";
    "SNI_HOSTNAME2" = "server.example.net";
    "SNI_CERTFILE2" = "/path/to/cert2.crt";
    "SNI_KEYFILE2" = "/path/to/key2.key";
};
```

This works but is awkward:
- Limited to 2 additional certificates
- Not consistent with other config blocks
- Feature flags aren't the right abstraction for this

## Target State

Proper SSL block syntax:
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

Benefits:
- Unlimited SNI certificates (limited only by memory)
- Clean, consistent config syntax
- Hostname is the block identifier (natural mapping)
- Easy to add more per-certificate options later (ciphers, TLS versions, etc.)

---

## Implementation Plan

### Phase 1: Data Structures (s_conf.h)

Add new structure for SNI certificates:

```c
/** SNI certificate configuration */
struct SSLCertConf {
    char *hostname;           /**< SNI hostname to match */
    char *cert_file;          /**< Path to certificate file */
    char *key_file;           /**< Path to private key file */
    struct SSLCertConf *next; /**< Next in linked list */
};

extern struct SSLCertConf *sslCertConfList;
```

### Phase 2: Lexer Updates (ircd_lexer.l)

Add tokens:
- `CERTIFICATE` - for "certificate" keyword
- `KEY` - for "key" keyword (already have it? check)

Note: `SSLTOK` already exists for "ssl" keyword.

### Phase 3: Parser Updates (ircd_parser.y)

Add global variable:
```c
extern struct SSLCertConf *sslCertConfList;
```

Add to block list:
```yacc
block: adminblock | generalblock | classblock | connectblock |
       ... | sslblock | error ';';
```

Add SSL block grammar:
```yacc
sslblock: SSLTOK '{' sslcertitems '}' ';';
sslcertitems: sslcertitems sslcertitem | sslcertitem;
sslcertitem: QSTRING
{
    /* QSTRING is the hostname */
    host = $1;
} '{' sslcertprops '}' ';'
{
    struct SSLCertConf *conf;
    if (host == NULL)
        parse_error("Missing hostname in SSL block");
    else if (pass == NULL)  /* reuse 'pass' for cert_file */
        parse_error("Missing certificate in SSL block for %s", host);
    else if (origin == NULL)  /* reuse 'origin' for key_file */
        parse_error("Missing key in SSL block for %s", host);
    else {
        conf = MyCalloc(1, sizeof(*conf));
        conf->hostname = host;
        conf->cert_file = pass;
        conf->key_file = origin;
        conf->next = sslCertConfList;
        sslCertConfList = conf;
    }
    host = pass = origin = NULL;
};
sslcertprops: sslcertprops sslcertprop | sslcertprop;
sslcertprop: sslcertfile | sslkeyfile;
sslcertfile: CERTIFICATE '=' QSTRING ';'
{
    MyFree(pass);
    pass = $3;
};
sslkeyfile: KEY '=' QSTRING ';'
{
    MyFree(origin);
    origin = $3;
};
```

### Phase 4: SSL Integration (ssl.c)

Modify SNI initialization to use config list:

```c
void sni_init_certs(void)
{
    struct SSLCertConf *conf;

    sni_free_certs();  /* Clear existing */

    for (conf = sslCertConfList; conf; conf = conf->next) {
        SSL_CTX *ctx = ssl_create_ctx_for_cert(conf->cert_file, conf->key_file);
        if (ctx) {
            sni_add_cert(conf->hostname, ctx);
        }
    }
}
```

Change from fixed array to dynamic list:
```c
struct sni_cert {
    char *hostname;
    SSL_CTX *ctx;
    struct sni_cert *next;
};

static struct sni_cert *sni_cert_list = NULL;
```

### Phase 5: Config Reload (s_conf.c)

Add function to clear SSL cert configs on rehash:
```c
void clear_ssl_cert_confs(void)
{
    struct SSLCertConf *conf, *next;
    for (conf = sslCertConfList; conf; conf = next) {
        next = conf->next;
        MyFree(conf->hostname);
        MyFree(conf->cert_file);
        MyFree(conf->key_file);
        MyFree(conf);
    }
    sslCertConfList = NULL;
}
```

Call from rehash before parsing new config.

### Phase 6: Remove Feature Flags

Remove from ircd_features.h:
- FEAT_SNI_HOSTNAME1, FEAT_SNI_HOSTNAME2
- FEAT_SNI_CERTFILE1, FEAT_SNI_CERTFILE2
- FEAT_SNI_KEYFILE1, FEAT_SNI_KEYFILE2

Remove from ircd_features.c the corresponding F_S entries.

---

## Files to Modify

| File | Changes |
|------|---------|
| `include/s_conf.h` | Add `struct SSLCertConf`, extern declaration |
| `ircd/s_conf.c` | Add `sslCertConfList` definition, `clear_ssl_cert_confs()` |
| `ircd/ircd_lexer.l` | Add `CERTIFICATE`, verify `KEY` exists |
| `ircd/ircd_parser.y` | Add `sslblock` grammar, tokens |
| `ircd/ssl.c` | Modify `sni_init_certs()` to use config list, change to dynamic list |
| `include/ircd_features.h` | Remove SNI feature flags |
| `ircd/ircd_features.c` | Remove SNI feature entries |

---

## Effort Estimate

| Phase | Effort |
|-------|--------|
| Data structures | 1 hour |
| Lexer updates | 30 min |
| Parser updates | 2-3 hours |
| SSL integration | 2 hours |
| Config reload | 1 hour |
| Remove feature flags | 30 min |
| Testing | 2-3 hours |
| **Total** | **9-11 hours** |

---

## Testing Plan

1. Basic SNI: Configure 2 hostnames, verify correct cert served
2. Rehash: Add/remove SNI certs, verify reload works
3. Invalid config: Missing cert/key, verify error messages
4. Fallback: Unknown hostname gets default cert
5. openssl s_client: Test with `-servername` flag

---

## Alternative: Keep Feature Flags

If proper config syntax is too complex, alternative is to:
1. Keep current feature flags
2. Increase limit from 2 to 5 or 10
3. Add validation for hostname format

This is less elegant but much simpler to implement. The feature flag approach is already working.

---

## Decision

Recommend implementing proper config syntax because:
1. More maintainable long-term
2. No artificial certificate limit
3. Consistent with other config blocks
4. Foundation for future SSL options (per-cert ciphers, etc.)

The feature flag approach can remain as a fallback during transition.
