# SASL EXTERNAL with Keycloak via Proxy Headers

## Overview

This document describes a method to implement IRC SASL EXTERNAL authentication using Keycloak's X.509 authenticator in "Proxy" mode. This approach allows users to authenticate using TLS client certificates without requiring Keycloak to directly handle the TLS termination.

## Status: Planning

**Important Security Warning**: This approach relies on potentially unsafe mechanisms and requires extremely thorough documentation and careful deployment. Misconfigurations can lead to authentication bypass.

---

## Background

### Traditional SASL EXTERNAL

In IRC, SASL EXTERNAL allows authentication using a TLS client certificate:
1. Client connects with TLS and presents a client certificate
2. IRCd extracts the certificate fingerprint or DN
3. Services (X3) receives the fingerprint via SASL EXTERNAL
4. Services looks up account by certificate fingerprint
5. User is authenticated

### The Keycloak Challenge

Keycloak's X.509 authenticator normally:
1. Terminates TLS directly
2. Validates the client certificate chain
3. Extracts user identity from the certificate

**Problem**: IRCd terminates TLS, not Keycloak. Keycloak never sees the client certificate.

### The Proxy Header Solution

Keycloak supports "Proxy" mode for X.509 authentication where:
1. A trusted proxy terminates TLS and validates the certificate
2. Proxy passes certificate info to Keycloak via HTTP headers
3. Keycloak trusts the header and authenticates based on it

**Key Insight**: X3 can act as this "trusted proxy" by:
1. Receiving the certificate fingerprint from IRCd via SASL EXTERNAL
2. Calling a Keycloak authentication endpoint with the fingerprint in a header
3. Keycloak validates and returns an access token
4. X3 uses this token to identify the user

---

## Architecture

```
                                      SASL EXTERNAL Flow
                                      ==================

 IRC Client                   IRCd (Nefarious)                X3 Services                    Keycloak
     |                              |                              |                             |
     |---[TLS + Client Cert]------->|                              |                             |
     |                              |--[Extract Fingerprint]       |                             |
     |                              |                              |                             |
     |<--AUTHENTICATE +-------------|                              |                             |
     |                              |                              |                             |
     |---AUTHENTICATE +------------>|                              |                             |
     |                              |---SASL S EXTERNAL FP-------->|                             |
     |                              |                              |                             |
     |                              |                              |---[Token Request with]----->|
     |                              |                              |   [X-SSL-Cert-Fingerprint]  |
     |                              |                              |                             |
     |                              |                              |<--[Access Token]------------|
     |                              |                              |                             |
     |                              |                              |---[Introspect Token]------->|
     |                              |                              |<--[User Info]---------------|
     |                              |                              |                             |
     |                              |<--SASL D S (Success)---------|                             |
     |                              |<--SASL L account-------------|                             |
     |<--903 SASLSUCCESS------------|                              |                             |

```

---

## Security Considerations

### Critical Risks

1. **Header Spoofing**: If the Keycloak endpoint is accessible from untrusted networks, attackers could forge the certificate header and authenticate as any user.

2. **Man-in-the-Middle**: The X3 → Keycloak communication MUST be secured (TLS).

3. **Trust Boundary**: Keycloak must ONLY accept certificate headers from trusted sources (X3).

### Mitigations

1. **Network Isolation**: The Keycloak X.509 endpoint should only be accessible from X3's container/host.

2. **Separate Authentication Flow**: Use a dedicated Keycloak authentication flow for X.509 that:
   - Is bound to a specific client
   - Only accepts connections from known IPs
   - Requires additional authentication factors if possible

3. **Fingerprint Binding**: Store allowed certificate fingerprints as user attributes in Keycloak, not DN matching.

4. **Audit Logging**: Log all X.509 authentications with source IP and fingerprint.

5. **Rate Limiting**: Limit authentication attempts per fingerprint and source.

---

## Identity Determination

### Core Principle: Keycloak is Authoritative

The username/account is determined **entirely by Keycloak** based on who owns the fingerprint, not by any client-provided hint. This is fundamental to SASL EXTERNAL's security model.

### SASL EXTERNAL Payload

Per RFC 4422, the SASL EXTERNAL initial response may contain:
- Empty string (most common): "Use my TLS identity"
- Authorization identity (authzid): "I want to act as this user"

**Our handling**:
```
Client sends empty payload  → Keycloak determines identity from fingerprint
Client sends authzid hint   → Keycloak determines identity, X3 verifies it matches hint
                              If mismatch → authentication FAILS
```

### Fingerprint Collision Handling

**Scenario**: Multiple Keycloak users have the same fingerprint in their `x509_fingerprints` attribute.

**This MUST be prevented**:

1. **At Registration Time**: When adding a fingerprint via NickServ CERT ADD:
   ```c
   /* Check if fingerprint is already registered to another account */
   struct handle_info *existing = nickserv_find_handle_by_fingerprint(fp);
   if (existing && existing != hi) {
       reply("NSMSG_CERT_ALREADY_REGISTERED", fp, existing->handle);
       return 0;
   }
   ```

2. **At Keycloak Sync Time**: Before syncing to Keycloak, verify uniqueness:
   ```c
   /* Search Keycloak for existing users with this fingerprint */
   if (keycloak_fingerprint_exists(fp, excluding_user_id)) {
       log_module(NS_LOG, LOG_ERROR,
                  "Fingerprint collision: %s already registered in Keycloak", fp);
       return -1;
   }
   ```

3. **At Authentication Time**: If Keycloak somehow returns multiple matches, fail:
   ```c
   if (keycloak_response.user_count > 1) {
       log_module(NS_LOG, LOG_ERROR,
                  "Fingerprint %s matches multiple Keycloak users - refusing auth", fp);
       irc_sasl(dest, identifier, "D", "F");
       return;
   }
   ```

### Authorization Identity Verification

When client provides an authzid (username hint):

```c
/* After Keycloak returns the authenticated user */
const char *kc_username = token_info->username;
const char *client_authzid = sess->authzid;  /* From SASL payload */

if (client_authzid && *client_authzid) {
    /* Client claimed a specific identity - verify it matches */
    if (strcasecmp(kc_username, client_authzid) != 0) {
        log_module(NS_LOG, LOG_WARNING,
                   "EXTERNAL authzid mismatch: client claimed '%s' but cert belongs to '%s'",
                   client_authzid, kc_username);
        irc_sasl(dest, identifier, "D", "F");
        return;
    }
}

/* Success - use Keycloak's username (authoritative) */
hi = dict_find(nickserv_handle_dict, kc_username, NULL);
```

### Why This Matters

1. **Prevents Impersonation**: User can't present Bob's certificate and claim to be Alice
2. **Single Source of Truth**: Keycloak owns the fingerprint→user mapping
3. **Audit Trail**: Clear record of which user authenticated with which cert
4. **Revocation**: Removing a fingerprint from Keycloak immediately invalidates it

---

## Keycloak Configuration

### 1. Create X.509 Authentication Flow

```
Authentication → Flows → Create Flow
Name: x3-external-auth
Type: basic-flow
```

Add executions:
1. **X509/Validate Username Form** (REQUIRED)
   - User Identity Source: `Match SubjectDN using Certificate Fingerprint`
   - User Attribute: `x509_fingerprints` (multi-valued)
   - A]Regular Expression: `(.*)`

### 2. Configure X.509 Authenticator for Proxy Mode

In the X509 authenticator settings:
- **Certificate Extraction Mode**: `Standard`
- **Certificate Extraction from HTTP Request Header**: `X-SSL-Cert-Fingerprint`
- **Certificate Fingerprint**: `SHA-256` (must match IRCd format)

### 3. Create Dedicated Client

```
Clients → Create
Client ID: x3-external-auth
Client Protocol: openid-connect
Client Authentication: ON
Authentication Flow: x3-external-auth
Valid Redirect URIs: (not needed for direct grant)
```

Enable:
- Direct Access Grants (for direct authentication)
- Service Accounts

### 4. User Attribute Configuration

Each user needs the `x509_fingerprints` attribute:
- Name: `x509_fingerprints`
- Value: Comma-separated list of allowed SHA-256 fingerprints
- Example: `AB:CD:EF:12:34:...`

### 5. Client Scope for Fingerprint Claim

Create a mapper to include fingerprints in tokens:
```
Client → x3-external-auth → Client Scopes → Dedicated
Add mapper:
  Name: x509-fingerprints
  Mapper Type: User Attribute
  User Attribute: x509_fingerprints
  Token Claim Name: x509_fingerprints
  Add to ID token: Yes
  Add to access token: Yes
```

---

## X3 Implementation

### 1. New Configuration Options

Add to `nickserv.h`:
```c
#ifdef WITH_KEYCLOAK
    /* Existing Keycloak options... */

    /* SASL EXTERNAL with Keycloak */
    unsigned int keycloak_external_enable;
    const char *keycloak_external_client_id;
    const char *keycloak_external_client_secret;
    const char *keycloak_external_fingerprint_header;
#endif
```

Add to `x3.conf`:
```
/* SASL EXTERNAL via Keycloak X.509 */
"keycloak_external_enable" "0";
"keycloak_external_client_id" "x3-external-auth";
"keycloak_external_client_secret" "%KEYCLOAK_EXTERNAL_SECRET%";
"keycloak_external_fingerprint_header" "X-SSL-Cert-Fingerprint";
```

### 2. New Authentication Function

Add to `keycloak.c`:
```c
/**
 * Authenticate via certificate fingerprint using Keycloak's X.509 flow.
 *
 * @param realm         Keycloak realm configuration
 * @param client        Client credentials (x3-external-auth client)
 * @param fingerprint   SHA-256 certificate fingerprint
 * @param info_out      Output: token info if successful
 * @return              0 on success, -1 on failure
 */
int keycloak_auth_by_fingerprint(
    struct kc_realm realm,
    struct kc_client client,
    const char *fingerprint,
    struct kc_token_info **info_out);
```

Implementation:
```c
int keycloak_auth_by_fingerprint(struct kc_realm realm, struct kc_client client,
                                  const char *fingerprint,
                                  struct kc_token_info **info_out)
{
    CURL *curl;
    CURLcode res;
    char url[512];
    char postdata[1024];
    struct curl_slist *headers = NULL;
    struct memory_chunk response = {0};

    /* Build token endpoint URL */
    snprintf(url, sizeof(url), "%s/realms/%s/protocol/openid-connect/token",
             realm.base_url, realm.name);

    /* Build POST data for direct grant */
    snprintf(postdata, sizeof(postdata),
             "grant_type=password"
             "&client_id=%s"
             "&client_secret=%s"
             "&username=x509_dummy"  /* Placeholder - X.509 flow ignores this */
             "&password=x509_dummy",
             client.id, client.secret);

    curl = curl_easy_init();
    if (!curl)
        return -1;

    /* Add fingerprint header - Keycloak X.509 authenticator reads this */
    char fingerprint_header[256];
    snprintf(fingerprint_header, sizeof(fingerprint_header),
             "%s: %s", nickserv_conf.keycloak_external_fingerprint_header,
             fingerprint);
    headers = curl_slist_append(headers, fingerprint_header);
    headers = curl_slist_append(headers, "Content-Type: application/x-www-form-urlencoded");

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postdata);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, memory_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);

    res = curl_easy_perform(curl);

    if (res != CURLE_OK) {
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        free(response.data);
        return -1;
    }

    long http_code;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (http_code != 200) {
        free(response.data);
        return -1;
    }

    /* Parse access token from response */
    json_t *root = json_loads(response.data, 0, NULL);
    free(response.data);

    if (!root)
        return -1;

    const char *access_token = json_string_value(json_object_get(root, "access_token"));
    if (!access_token) {
        json_decref(root);
        return -1;
    }

    /* Introspect token to get user info */
    int ret = keycloak_introspect_token(realm, client, access_token, info_out);

    json_decref(root);
    return ret;
}
```

### 3. Modify SASL EXTERNAL Handler

Update `handle_sasl_input()` in `nickserv.c`:
```c
case 'S': /* Start */
    if (strcmp(sess->mech, "EXTERNAL") == 0) {
        /* EXTERNAL can use Keycloak or local fingerprint lookup */
        if (nickserv_conf.keycloak_external_enable) {
            /* Store fingerprint, wait for empty payload */
            /* Fingerprint comes from H (hostinfo) subcommand */
        } else {
            /* Existing local fingerprint lookup */
        }
    }
    break;

case 'C': /* Continue */
    if (strcmp(sess->mech, "EXTERNAL") == 0) {
        if (nickserv_conf.keycloak_external_enable) {
            /* Empty payload expected for EXTERNAL */
            /* Authenticate via Keycloak with stored fingerprint */
            struct kc_token_info *info = NULL;
            struct kc_client ext_client = {
                .id = nickserv_conf.keycloak_external_client_id,
                .secret = nickserv_conf.keycloak_external_client_secret
            };

            if (keycloak_auth_by_fingerprint(keycloak_realm, ext_client,
                                             sess->cert_fingerprint, &info) == 0) {
                /* Success - look up or create local account */
                hi = loc_auth_oauth_info(info);
                if (hi) {
                    irc_sasl(dest, identifier, "L", hi->handle);
                    irc_sasl(dest, identifier, "D", "S");
                } else {
                    irc_sasl(dest, identifier, "D", "F");
                }
                keycloak_free_token_info(info);
            } else {
                irc_sasl(dest, identifier, "D", "F");
            }
        }
    }
    break;
```

### 4. Fingerprint Extraction from IRCd

The certificate fingerprint arrives via the SASL `H` (hostinfo) subcommand:
```
SASL target source H :user@host:ip:fingerprint
```

Ensure `handle_sasl_input()` extracts and stores this:
```c
case 'H': /* Hostinfo */
    {
        /* Format: user@host:ip[:fingerprint] */
        char *fp = strrchr(data, ':');
        if (fp && strchr(fp+1, ':') == NULL) {
            /* Has fingerprint */
            strncpy(sess->cert_fingerprint, fp + 1, sizeof(sess->cert_fingerprint) - 1);
            *fp = '\0';  /* Remove fingerprint from hostmask */
        }
        strncpy(sess->hostmask, data, sizeof(sess->hostmask) - 1);
    }
    break;
```

---

## IRCd Requirements

Nefarious must send the certificate fingerprint in the SASL H subcommand:

### Current Format
```
SASL target source H :user@host:ip
```

### Required Format
```
SASL target source H :user@host:ip:SHA256_FINGERPRINT
```

### Modification in m_sasl.c

```c
/* In sasl_send_hostinfo() or equivalent */
if (cli_ssl(client) && ssl_get_client_cert_fingerprint(cli_ssl(client), fingerprint, sizeof(fingerprint))) {
    /* Client has a certificate */
    putsock("%s " TOK_SASL " %s %s!%d.%u H :%s@%s:%s:%s",
            NumServ(&me), target_numeric,
            cli_name(&me), cli_fd(client), cli_sasl_cookie(client),
            cli_username(client), cli_sockhost(client),
            ircd_ntoa(&cli_ip(client)), fingerprint);
} else {
    /* No certificate */
    putsock("%s " TOK_SASL " %s %s!%d.%u H :%s@%s:%s",
            NumServ(&me), target_numeric,
            cli_name(&me), cli_fd(client), cli_sasl_cookie(client),
            cli_username(client), cli_sockhost(client),
            ircd_ntoa(&cli_ip(client)));
}
```

---

## Testing Plan

### 1. Unit Tests (Keycloak API)
- Test `keycloak_auth_by_fingerprint()` with valid fingerprint
- Test with invalid/unknown fingerprint
- Test with malformed fingerprint
- Test header injection prevention

### 2. Integration Tests (Full Flow)
- Connect with client certificate
- Initiate SASL EXTERNAL
- Verify fingerprint transmitted in H subcommand
- Verify Keycloak authentication succeeds
- Verify account lookup/creation

### 3. Security Tests
- Attempt authentication with forged fingerprint header (should fail from network isolation)
- Attempt authentication with revoked certificate (if CRL checking enabled)
- Test rate limiting

---

## Deployment Checklist

1. [ ] Keycloak X.509 authentication flow created
2. [ ] Dedicated client for X3 EXTERNAL auth created
3. [ ] User attribute `x509_fingerprints` mapper configured
4. [ ] Network isolation: Keycloak X.509 endpoint only accessible from X3
5. [ ] TLS configured for X3 → Keycloak communication
6. [ ] X3 configuration updated with EXTERNAL Keycloak settings
7. [ ] IRCd modified to send fingerprint in SASL H subcommand
8. [ ] Audit logging enabled
9. [ ] Test users created with certificate fingerprints
10. [ ] Documentation for operators on adding user fingerprints

---

## Fingerprint Format Standardization

Ensure consistent fingerprint format across all components:

| Component | Format | Example |
|-----------|--------|---------|
| IRCd (OpenSSL) | Hex with colons | `AB:CD:EF:12:...` |
| X3 Storage | Hex with colons | `AB:CD:EF:12:...` |
| Keycloak Attribute | Hex with colons | `AB:CD:EF:12:...` |
| SASL H subcommand | Hex with colons | `AB:CD:EF:12:...` |

If formats differ, add normalization:
```c
void normalize_fingerprint(const char *input, char *output, size_t outlen)
{
    /* Convert to uppercase, ensure colons */
    /* Handle sha256:/SHA256: prefix if present */
}
```

---

## Additional Features (Implement Together)

The following features should be implemented alongside the base SASL EXTERNAL support for a complete solution.

### 1. NickServ CERT Commands (Synced to Keycloak)

Allow users to manage their certificate fingerprints via IRC commands, with changes synced to Keycloak's `x509_fingerprints` attribute.

**Commands**:
```
/msg NickServ CERT ADD [fingerprint]   - Add current or specified fingerprint
/msg NickServ CERT DEL <fingerprint>   - Remove a fingerprint
/msg NickServ CERT LIST                - List all registered fingerprints
```

**Implementation** (`nickserv.c`):
```c
static NICKSERV_FUNC(cmd_cert)
{
    struct handle_info *hi;
    const char *subcmd;

    NICKSERV_MIN_PARMS(2);
    hi = user->handle_info;
    if (!hi) {
        reply("NSMSG_MUST_AUTH");
        return 0;
    }

    subcmd = argv[1];

    if (!strcasecmp(subcmd, "ADD")) {
        const char *fp;
        if (argc > 2) {
            fp = argv[2];
        } else {
            /* Get fingerprint from current connection */
            fp = user->cert_fingerprint;
            if (!fp || !*fp) {
                reply("NSMSG_CERT_NO_CURRENT");
                return 0;
            }
        }

        /* Validate fingerprint format */
        if (!is_valid_fingerprint(fp)) {
            reply("NSMSG_CERT_INVALID_FORMAT", fp);
            return 0;
        }

        /* Check if already registered to THIS account */
        if (nickserv_cert_exists(hi, fp)) {
            reply("NSMSG_CERT_ALREADY_EXISTS", fp);
            return 0;
        }

        /* Check if registered to ANOTHER account (collision prevention) */
        struct handle_info *existing = nickserv_find_handle_by_fingerprint(fp);
        if (existing && existing != hi) {
            reply("NSMSG_CERT_BELONGS_TO_OTHER", fp);
            return 0;
        }

#ifdef WITH_KEYCLOAK
        /* Also check Keycloak for collisions (belt and suspenders) */
        if (nickserv_conf.keycloak_enable && hi->keycloak_id) {
            char *existing_user = NULL;
            if (keycloak_find_user_by_fingerprint(keycloak_realm, keycloak_client,
                                                   fp, &existing_user) == 0) {
                if (existing_user && strcasecmp(existing_user, hi->handle) != 0) {
                    reply("NSMSG_CERT_BELONGS_TO_OTHER", fp);
                    free(existing_user);
                    return 0;
                }
                free(existing_user);
            }
        }
#endif

        /* Add to local storage */
        nickserv_cert_add(hi, fp);

        /* Sync to Keycloak */
#ifdef WITH_KEYCLOAK
        if (nickserv_conf.keycloak_enable) {
            kc_sync_cert_fingerprints(hi);
        }
#endif

        reply("NSMSG_CERT_ADDED", fp);
        return 1;
    }
    else if (!strcasecmp(subcmd, "DEL")) {
        const char *fp;
        NICKSERV_MIN_PARMS(3);
        fp = argv[2];

        if (!nickserv_cert_exists(hi, fp)) {
            reply("NSMSG_CERT_NOT_FOUND", fp);
            return 0;
        }

        nickserv_cert_del(hi, fp);

#ifdef WITH_KEYCLOAK
        if (nickserv_conf.keycloak_enable) {
            kc_sync_cert_fingerprints(hi);
        }
#endif

        reply("NSMSG_CERT_REMOVED", fp);
        return 1;
    }
    else if (!strcasecmp(subcmd, "LIST")) {
        struct string_list *certs = hi->cert_fingerprints;
        if (!certs || !certs->used) {
            reply("NSMSG_CERT_LIST_EMPTY");
            return 1;
        }

        reply("NSMSG_CERT_LIST_HEADER", hi->handle);
        for (unsigned int i = 0; i < certs->used; i++) {
            reply("NSMSG_CERT_LIST_ENTRY", i + 1, certs->list[i]);
        }
        reply("NSMSG_CERT_LIST_FOOTER", certs->used);
        return 1;
    }

    reply("NSMSG_CERT_UNKNOWN_SUBCMD", subcmd);
    return 0;
}
```

**Keycloak Sync Function**:
```c
static void kc_sync_cert_fingerprints(struct handle_info *hi)
{
    if (!hi->keycloak_id)
        return;

    /* Build comma-separated list of fingerprints */
    char fp_list[4096] = "";
    struct string_list *certs = hi->cert_fingerprints;

    if (certs && certs->used > 0) {
        for (unsigned int i = 0; i < certs->used; i++) {
            if (i > 0) strcat(fp_list, ",");
            strcat(fp_list, certs->list[i]);
        }
    }

    keycloak_set_user_attribute(keycloak_realm, keycloak_client,
                                 hi->keycloak_id, "x509_fingerprints", fp_list);
}
```

**Keycloak Fingerprint Lookup** (add to `keycloak.c`):

Uses the existing `struct curl_opts` + `curl_perform()` pattern:

```c
/**
 * Find which Keycloak user owns a fingerprint.
 *
 * @param realm         Keycloak realm configuration
 * @param client        Client credentials (must have access_token)
 * @param fingerprint   SHA-256 certificate fingerprint
 * @param username_out  Output: username if found (caller must free)
 * @return              KC_SUCCESS if found, KC_NOT_FOUND if not found,
 *                      KC_ERROR on error, KC_COLLISION if multiple users found
 */
int keycloak_find_user_by_fingerprint(struct kc_realm realm,
                                       struct kc_client client,
                                       const char *fingerprint,
                                       char **username_out)
{
    if (!realm.base_uri || !realm.realm || !client.access_token ||
        !fingerprint || !username_out) {
        log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Invalid arguments");
        return KC_ERROR;
    }

    *username_out = NULL;
    int result = KC_ERROR;
    char* uri = NULL;
    char* escaped_fp = NULL;
    struct memory chunk = { .response = NULL, .size = 0 };

    /* URL-encode the fingerprint for query parameter */
    escaped_fp = curl_easy_escape(NULL, fingerprint, 0);
    if (!escaped_fp) {
        log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Failed to escape fingerprint");
        goto cleanup;
    }

    /* Search users by x509_fingerprints attribute */
    static const char uri_tmpl[] = "%s/admin/realms/%s/users?q=x509_fingerprints:%s";
    int uri_len = snprintf(NULL, 0, uri_tmpl, realm.base_uri, realm.realm, escaped_fp) + 1;
    uri = malloc(uri_len);
    if (!uri) {
        log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Failed to allocate uri");
        goto cleanup;
    }
    snprintf(uri, uri_len, uri_tmpl, realm.base_uri, realm.realm, escaped_fp);

    struct curl_opts opts = {
        .uri = uri,
        .method = HTTP_GET,
        .xoauth2_bearer = client.access_token->access_token,
        .write_callback = curl_write_cb,
        .header_count = 0
    };

    long http_code = curl_perform(opts, &chunk);

    if (http_code != 200 || !chunk.response) {
        log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Failed with HTTP %ld",
            http_code);
        goto cleanup;
    }

    /* Parse JSON array response */
    json_error_t error;
    json_t* root = json_loads(chunk.response, 0, &error);
    if (!root) {
        log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Failed to parse JSON: %s",
            error.text);
        goto cleanup;
    }

    if (!json_is_array(root)) {
        log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Response is not an array");
        json_decref(root);
        goto cleanup;
    }

    size_t count = json_array_size(root);

    if (count == 0) {
        /* Fingerprint not registered to any user */
        log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Fingerprint not found");
        result = KC_NOT_FOUND;
        json_decref(root);
        goto cleanup;
    }

    if (count > 1) {
        /* Fingerprint collision! This should never happen if we enforce uniqueness */
        log_module(KC_LOG, LOG_ERROR,
                   "SECURITY: Fingerprint %s registered to %zu users!",
                   fingerprint, count);
        result = KC_COLLISION;  /* New error code for this case */
        json_decref(root);
        goto cleanup;
    }

    /* Exactly one user - extract username */
    json_t* user = json_array_get(root, 0);
    const char* username = json_string_value(json_object_get(user, "username"));

    if (username) {
        *username_out = strdup(username);
        if (*username_out) {
            result = KC_SUCCESS;
            log_module(KC_LOG, LOG_DEBUG, "keycloak_find_user_by_fingerprint: Found user '%s'",
                *username_out);
        }
    }

    json_decref(root);

cleanup:
    if (chunk.response) {
        memset(chunk.response, 0, chunk.size);
        free(chunk.response);
    }
    if (escaped_fp) {
        curl_free(escaped_fp);
    }
    if (uri) {
        free(uri);
    }

    return result;
}
```

**New return code** (add to `keycloak.h`):
```c
#define KC_COLLISION -5  /* Multiple users matched (fingerprint collision) */
```

**Data Structure** (add to `nickserv.h`):
```c
struct handle_info {
    /* ... existing fields ... */
    struct string_list *cert_fingerprints;  /* List of allowed cert fingerprints */
};
```

**Messages** (add to `mod-nickserv.help`):
```
"NSMSG_CERT_ADDED" "Certificate fingerprint %s added to your account."
"NSMSG_CERT_REMOVED" "Certificate fingerprint %s removed from your account."
"NSMSG_CERT_NOT_FOUND" "Certificate fingerprint %s is not registered to your account."
"NSMSG_CERT_ALREADY_EXISTS" "Certificate fingerprint %s is already registered to your account."
"NSMSG_CERT_BELONGS_TO_OTHER" "Certificate fingerprint %s is already registered to another account."
"NSMSG_CERT_NO_CURRENT" "You are not connected with a client certificate."
"NSMSG_CERT_INVALID_FORMAT" "Invalid fingerprint format: %s (expected SHA-256 hex with colons)"
"NSMSG_CERT_LIST_EMPTY" "No certificate fingerprints registered to your account."
"NSMSG_CERT_LIST_HEADER" "Certificate fingerprints for %s:"
"NSMSG_CERT_LIST_ENTRY" "  %d. %s"
"NSMSG_CERT_LIST_FOOTER" "Total: %d fingerprint(s)"
"NSMSG_CERT_UNKNOWN_SUBCMD" "Unknown CERT subcommand: %s (use ADD, DEL, or LIST)"
```

---

### 2. Certificate Expiration Tracking

Store and check certificate expiration dates. Warn users before expiry, prevent auth with expired certs.

**Extended Fingerprint Storage**:
```c
struct cert_entry {
    char fingerprint[128];      /* SHA-256 fingerprint */
    time_t not_before;          /* Certificate validity start */
    time_t not_after;           /* Certificate expiration */
    char subject_cn[256];       /* Common Name for display */
    time_t added;               /* When fingerprint was registered */
};
```

**IRCd Changes** - Send expiration in SASL H subcommand:
```
SASL target source H :user@host:ip:fingerprint:expiry_timestamp
```

**X3 Validation**:
```c
static int validate_cert_expiry(struct cert_entry *cert)
{
    time_t now = time(NULL);

    if (now < cert->not_before) {
        /* Certificate not yet valid */
        return CERT_NOT_YET_VALID;
    }

    if (now > cert->not_after) {
        /* Certificate expired */
        return CERT_EXPIRED;
    }

    /* Warn if expiring within 30 days */
    if (now > cert->not_after - (30 * 24 * 60 * 60)) {
        return CERT_EXPIRING_SOON;
    }

    return CERT_VALID;
}
```

**Login Warning**:
```c
if (cert_status == CERT_EXPIRING_SOON) {
    int days_left = (cert->not_after - time(NULL)) / (24 * 60 * 60);
    send_message(user, nickserv, "NSMSG_CERT_EXPIRING", days_left);
}
```

---

### 3. Certificate Revocation Checking

> **⚠️ NOT RECOMMENDED FOR IRC USE CASES**
>
> Traditional CRL/OCSP revocation checking **does not work with self-signed certificates**, which are the norm for IRC client authentication. Self-signed certs have no issuing CA to provide revocation infrastructure.

#### Why This Doesn't Apply

| Certificate Type | CRL/OCSP Works? | Common in IRC? |
|------------------|-----------------|----------------|
| CA-issued (enterprise PKI) | ✅ Yes | Rare |
| Self-signed (user-generated) | ❌ No | Very common |
| Let's Encrypt / public CA | ✅ Yes | Never for client certs |

#### Our Revocation Model

Instead of CRL/OCSP, we use **fingerprint-based revocation**:

1. **User removes fingerprint**: `CERT DEL <fingerprint>` removes it from their account
2. **Admin removes fingerprint**: OpServ can remove fingerprints from any account
3. **Keycloak sync**: Removal syncs to Keycloak's `x509_fingerprints` attribute
4. **Immediate effect**: Next SASL EXTERNAL attempt with that fingerprint fails

This is actually **more appropriate** for IRC because:
- Users control their own certificates
- No dependency on external revocation infrastructure
- Works with self-signed certs
- Instant revocation (no CRL caching delays)

#### If Enterprise PKI Is Required (Future)

For networks that require CA-issued client certificates, CRL/OCSP could be added as an **optional** feature:

```c
/* Only if configured and cert has CRL/OCSP info */
if (nickserv_conf.require_ca_issued_certs) {
    /* Keycloak's X.509 authenticator handles this */
    /* We just trust Keycloak's validation */
}
```

**Recommendation**: Do not implement CRL/OCSP. Fingerprint removal is sufficient revocation for IRC.

---

### 4. Multi-Factor Authentication

Require additional authentication after EXTERNAL for sensitive accounts (e.g., network operators).

**Configuration**:
```c
/* In nickserv.conf */
"external_mfa_required_level" "100";  /* OpServ level requiring MFA */
"external_mfa_method" "PLAIN";        /* Secondary auth method */
```

**Implementation Flow**:
```
1. User authenticates via SASL EXTERNAL
2. X3 checks if user's opserv_level >= external_mfa_required_level
3. If yes, send partial success (900) but not full success (903)
4. X3 sends challenge requesting additional auth
5. User provides password via SASL PLAIN continuation
6. X3 verifies password against Keycloak
7. Full authentication complete
```

**SASL Response for MFA Required**:
```c
if (hi->opserv_level >= nickserv_conf.external_mfa_required_level) {
    /* Partial auth - require password */
    irc_sasl(dest, identifier, "C",
             base64_encode("{\"status\":\"continue\",\"message\":\"Password required\"}"));
    sess->mfa_pending = 1;
    sess->mfa_handle = hi;
    return;
}
```

**Note**: This deviates from standard SASL flow. Consider using a custom SASL mechanism like `EXTERNAL-MFA` instead for cleaner separation.

---

### 5. Fingerprint-to-Account Lookup (Reverse Query)

Allow operators to find which account owns a fingerprint.

**Command**:
```
/msg NickServ CERT SEARCH <fingerprint>
```

**Implementation**:
```c
static NICKSERV_FUNC(cmd_cert_search)
{
    const char *fp;
    struct handle_info *hi;

    NICKSERV_MIN_PARMS(3);

    /* Require oper access */
    if (!IsOper(user)) {
        reply("NSMSG_NO_ACCESS");
        return 0;
    }

    fp = argv[2];

    /* Search all handles for matching fingerprint */
    hi = nickserv_find_handle_by_fingerprint(fp);

    if (hi) {
        reply("NSMSG_CERT_OWNER", fp, hi->handle);
    } else {
        reply("NSMSG_CERT_NOT_REGISTERED", fp);
    }

    return 1;
}
```

---

### 6. Import Fingerprints from Existing SASL EXTERNAL

If migrating from a non-Keycloak setup, import existing fingerprint mappings:

**Migration Script** (`scripts/migrate-certfp-to-keycloak.sh`):
```bash
#!/bin/bash
# Reads X3 database and creates Keycloak user attributes

KEYCLOAK_URL="http://localhost:8080"
REALM="testnet"
TOKEN=$(get_admin_token)

# For each user with cert fingerprints in X3 DB:
while read username fingerprints; do
    # Get Keycloak user ID
    USER_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
        "$KEYCLOAK_URL/admin/realms/$REALM/users?username=$username&exact=true" \
        | jq -r '.[0].id')

    if [ "$USER_ID" != "null" ]; then
        # Update user attributes
        curl -s -X PUT "$KEYCLOAK_URL/admin/realms/$REALM/users/$USER_ID" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"attributes\":{\"x509_fingerprints\":[\"$fingerprints\"]}}"
        echo "Migrated $username"
    fi
done < x3_certfp_export.txt
```

---

### 7. Automatic Fingerprint Registration on First Use

When a user authenticates via SASL PLAIN while connected with a client certificate, offer to register the fingerprint:

**Flow**:
```
1. User connects with TLS + client certificate
2. User authenticates via SASL PLAIN (username/password)
3. X3 notices user has a certificate fingerprint
4. X3 sends notice: "You are connected with certificate fingerprint ABC:DEF...
   To enable certificate-based login, use: /msg NickServ CERT ADD"
5. Optionally: auto-add if config option "cert_auto_register" is set
```

**Implementation**:
```c
/* After successful PLAIN auth, check for cert */
if (user->cert_fingerprint && *user->cert_fingerprint) {
    if (nickserv_conf.cert_auto_register) {
        if (!nickserv_cert_exists(hi, user->cert_fingerprint)) {
            nickserv_cert_add(hi, user->cert_fingerprint);
            send_message(user, nickserv, "NSMSG_CERT_AUTO_ADDED",
                        user->cert_fingerprint);
#ifdef WITH_KEYCLOAK
            if (nickserv_conf.keycloak_enable) {
                kc_sync_cert_fingerprints(hi);
            }
#endif
        }
    } else {
        send_message(user, nickserv, "NSMSG_CERT_SUGGEST",
                    user->cert_fingerprint);
    }
}
```

---

## Implementation Priority

| Feature | Priority | Complexity | Dependencies |
|---------|----------|------------|--------------|
| Base SASL EXTERNAL + Keycloak | P0 | High | IRCd fingerprint in H subcmd |
| NickServ CERT commands | P0 | Medium | Base implementation |
| Keycloak fingerprint sync | P0 | Medium | CERT commands |
| Expiration tracking | P1 | Medium | IRCd expiry in H subcmd |
| Auto-register on PLAIN | P2 | Low | CERT commands |
| Fingerprint search (oper) | P2 | Low | CERT commands |
| ~~Certificate revocation~~ | ~~P3~~ | N/A | Not needed - fingerprint removal is revocation |
| Multi-factor auth | P3 | High | Custom SASL flow |

**Recommended Implementation Order**:
1. Base SASL EXTERNAL with Keycloak X.509 flow
2. NickServ CERT ADD/DEL/LIST commands
3. Keycloak x509_fingerprints attribute sync
4. Certificate expiration in H subcommand + warnings
5. Auto-register suggestion on PLAIN auth
6. Oper CERT SEARCH command

---

## Related Documentation

- [X3_KEYCLOAK_INTEGRATION.md](../../X3_KEYCLOAK_INTEGRATION.md) - OAUTHBEARER implementation
- [NEFARIOUS_IRCV3_UPGRADE_PLAN.md](NEFARIOUS_IRCV3_UPGRADE_PLAN.md) - IRCv3 SASL infrastructure
- Keycloak X.509 Documentation: https://www.keycloak.org/docs/latest/server_admin/#_x509
