# X3 Keycloak Integration

## Project Status: ✅ COMPLETE

**Completion Date**: December 2024

All phases implemented and committed to `x3` submodule on branch `keycloak-integration`.

### Summary

| Component | Status | Description |
|-----------|--------|-------------|
| Keycloak API | ✅ Complete | Full REST API wrapper in `keycloak.c` |
| NickServ Integration | ✅ Complete | Auth, register, password, email sync |
| SASL OAUTHBEARER | ✅ Complete | RFC 7628 compliant token auth |
| Dynamic SASL Mechanisms | ✅ Complete | SA M subcmd broadcast |
| P10 Tag Compatibility | ✅ Complete | Tag prefix skipping in parser |

---

## Overview

X3 IRC Services has been extended to support Keycloak as an authentication backend alongside existing methods. This enables:
- OAuth 2.0 / OpenID Connect authentication
- SASL OAUTHBEARER mechanism for IRC clients
- Centralized user management via Keycloak
- Dynamic SASL mechanism advertisement based on backend availability

## Goals

1. ✅ Add Keycloak as an alternative authentication backend (alongside LDAP)
2. ✅ Implement SASL OAUTHBEARER mechanism for IRC client authentication
3. ✅ Support auto-creation of local accounts from Keycloak
4. ✅ Store opserv_level as custom Keycloak user attribute + optional group membership

---

## Phase 1: Expand Keycloak API (`keycloak.c` / `keycloak.h`) ✅

### 1.1 User Management Functions ✅

```c
int keycloak_update_user(struct kc_realm realm, struct kc_client client,
                         const char* user_id, const char* new_password,
                         const char* new_email);

int keycloak_delete_user(struct kc_realm realm, struct kc_client client,
                         const char* user_id);
```

### 1.2 Custom Attribute Support ✅

```c
int keycloak_set_user_attribute(struct kc_realm realm, struct kc_client client,
                                const char* user_id, const char* attr_name,
                                const char* attr_value);

int keycloak_get_user_attribute(struct kc_realm realm, struct kc_client client,
                                const char* user_id, const char* attr_name,
                                char** value_out);
```

### 1.3 Group Management ✅

```c
int keycloak_add_user_to_group(struct kc_realm realm, struct kc_client client,
                               const char* user_id, const char* group_id);

int keycloak_remove_user_from_group(struct kc_realm realm, struct kc_client client,
                                    const char* user_id, const char* group_id);

int keycloak_get_group_by_name(struct kc_realm realm, struct kc_client client,
                               const char* group_name, char** group_id_out);
```

### 1.4 Token Introspection ✅

```c
struct kc_token_info {
    bool active;
    char* username;
    size_t username_size;
    char* email;
    size_t email_size;
    char* sub;              // Subject (user ID)
    size_t sub_size;
    int opserv_level;       // From token claims or user attributes
    long exp;               // Expiration timestamp
    long iat;               // Issued at timestamp
};

int keycloak_introspect_token(struct kc_realm realm, struct kc_client client,
                              const char* bearer_token,
                              struct kc_token_info** info_out);

void keycloak_free_token_info(struct kc_token_info* info);
```

---

## Phase 2: NickServ Keycloak Integration ✅

### 2.1 Configuration Structure ✅

Added to `nickserv.h`:
```c
unsigned int keycloak_enable;
#ifdef WITH_KEYCLOAK
    const char *keycloak_uri;
    const char *keycloak_realm;
    const char *keycloak_client_id;
    const char *keycloak_client_secret;
    unsigned int keycloak_autocreate;
    const char *keycloak_oper_group;
    unsigned int keycloak_oper_group_level;
    const char *keycloak_attr_oslevel;
#endif
```

### 2.2 Configuration Parsing ✅

Added to `nickserv_conf_read()` in `nickserv.c`.

### 2.3 Keycloak Auth Wrappers ✅

Implemented in `nickserv.c`:
- `kc_check_auth()` - Password authentication
- `kc_do_add()` - User creation
- `kc_do_modify()` - Password/email updates
- `kc_delete_account()` - User deletion
- `kc_do_oslevel()` - Opserv level attribute management

### 2.4 Integration Points ✅

| Function | Status | Description |
|----------|--------|-------------|
| `cmd_auth()` | ✅ | Keycloak password auth with autocreate |
| `nickserv_register()` | ✅ | Sync new accounts to Keycloak |
| `nickserv_unregister_handle()` | ✅ | Delete from Keycloak |
| `cmd_pass()` | ✅ | Sync password changes |
| `opt_email()` | ✅ | Sync email changes |
| `oper_try_set_access()` | ✅ | Opserv level + group management |

---

## Phase 3: SASL OAUTHBEARER Implementation ✅

### 3.1 Mechanism List ✅

Added OAUTHBEARER to SASL mechanism advertisement when `keycloak_enable` is set.

### 3.2 RFC 7628 Parser ✅

Implemented OAUTHBEARER format parsing:
- Base64 decode
- GS2 header parsing for authzid
- Key-value extraction (separated by `\x01`)
- Bearer token extraction from `auth=Bearer <token>`

### 3.3 OAuth Authentication Function ✅

```c
struct handle_info* loc_auth_oauth(const char* bearer_token,
                                   const char* username_hint,
                                   const char* hostmask);
```

Flow:
1. Call `keycloak_introspect_token()` to validate
2. Extract username from token claims
3. Look up local handle
4. Auto-create if enabled and not found
5. Return `handle_info*`

### 3.4 Error Response ✅

Implemented RFC 7628 JSON error response with openid-configuration URL.

---

## Phase 4: Build System & Configuration ✅

### 4.1 Autotools Changes ✅

**configure.in:**
- Added `--with-keycloak` option
- Checks for libcurl and libjansson
- Defines `WITH_KEYCLOAK`

**src/Makefile.am:**
- Added `keycloak.c keycloak.h` to sources

### 4.2 Configuration Template ✅

Added to `docker/x3.conf-dist`:
```
/* Keycloak Authentication */
"keycloak_enable" "0";
"keycloak_uri" "https://keycloak.example.com";
"keycloak_realm" "afternet";
"keycloak_client_id" "x3-services";
"keycloak_client_secret" "%KEYCLOAK_CLIENT_SECRET%";
"keycloak_autocreate" "1";
"keycloak_oper_group" "x3-opers";
"keycloak_oper_group_level" "99";
"keycloak_attr_oslevel" "x3_opserv_level";
```

### 4.3 Dockerfile ✅

Added build dependencies:
- `libcurl4-openssl-dev`
- `libjansson-dev`

Added `--with-keycloak` to configure command.

---

## Files Modified

| File | Changes |
|------|---------|
| `x3/src/keycloak.h` | New structs and function declarations |
| `x3/src/keycloak.c` | Full Keycloak REST API implementation |
| `x3/src/nickserv.h` | Keycloak config fields in `nickserv_conf` |
| `x3/src/nickserv.c` | Config parsing, auth wrappers, SASL OAUTHBEARER |
| `x3/configure.in` | `--with-keycloak` option |
| `x3/src/Makefile.am` | Added keycloak sources |
| `x3/docker/x3.conf-dist` | Keycloak config template |
| `x3/Dockerfile` | Build dependencies |

---

## Testing Strategy

1. **Unit test keycloak.c** against running Keycloak instance
2. **Test password auth** via `/msg NickServ AUTH user pass`
3. **Test account creation** via `/msg NickServ REGISTER`
4. **Test SASL PLAIN** with Keycloak backend
5. **Test SASL OAUTHBEARER** with Keycloak-issued JWT
6. **Test auto-creation** - auth with Keycloak user not in X3 DB

---

## Keycloak Setup Requirements

1. Create realm (e.g., `afternet`)
2. Create service account client with:
   - Client authentication: ON
   - Service accounts roles: ON
   - Roles: `manage-users`, `view-users`, `query-users`
3. Create custom user attribute: `x3_opserv_level`
4. Create group: `x3-opers` (optional)
5. Configure token introspection permissions

---

## Design Decisions

### Token Validation: Introspection vs Local JWT

Two approaches were considered for validating OAuth tokens:

1. **Token Introspection** (Implemented): Call Keycloak's introspection endpoint
   - Always current - respects token revocation
   - Simpler implementation - no key management
   - Slight latency cost per auth

2. **Local JWT Validation**: Verify JWT signature with Keycloak's public key
   - Faster - no network call
   - Cannot detect token revocation
   - Requires key rotation handling

**Decision**: Token introspection was chosen because:
- IRC authentication is infrequent (once per session)
- Token revocation must be respected for security
- Simpler implementation reduces maintenance burden

### Re-Authentication Flow

A separate REAUTHENTICATE command was originally planned but determined unnecessary:
- Nefarious clears the `SASLComplete` flag on new AUTHENTICATE
- Existing SASL flow handles token refresh correctly
- Better client compatibility (no new command needed)

### Token Refresh

Token refresh is a **client-side responsibility**:
- Clients should refresh OAuth tokens before expiry
- IRC server infrastructure supports re-authentication
- No server-side token refresh mechanism needed

---

## Related Documentation

- [NEFARIOUS_IRCV3_UPGRADE_PLAN.md](NEFARIOUS_IRCV3_UPGRADE_PLAN.md) - Full IRCv3.2+ upgrade plan
- [P10_PROTOCOL_REFERENCE.md](P10_PROTOCOL_REFERENCE.md) - P10 protocol documentation

---

## Phase 5: IRCv3 Integration ✅ COMPLETE

### 5.1 Dynamic SASL Mechanism Advertisement ✅

X3 now broadcasts available SASL mechanisms to Nefarious using a new P10 subcmd.

**P10 Format**:
```
[X3_NUMERIC] SA * * M :[MECHANISM_LIST]
```

**Implementation** (`nickserv.c`):
```c
const char *nickserv_get_sasl_mechanisms(void)
{
    static char mechs[128];
    strcpy(mechs, "PLAIN");
    strcat(mechs, ",EXTERNAL");
#ifdef WITH_KEYCLOAK
    if (nickserv_conf.keycloak_enable && keycloak_available)
        strcat(mechs, ",OAUTHBEARER");
#endif
    return mechs;
}

void nickserv_update_sasl_mechanisms(void)
{
    const char *mechs = nickserv_get_sasl_mechanisms();
    if (strcmp(mechs, last_sasl_mechs) != 0) {
        strcpy(last_sasl_mechs, mechs);
        irc_sasl_mechs_broadcast(mechs);
    }
}
```

**When Broadcasts Occur**:
1. After X3 completes burst (EOB acknowledgment)
2. When Keycloak availability changes
3. Automatic tracking of backend health

### 5.2 Keycloak Availability Tracking ✅

```c
static void kc_set_available(int available)
{
    if (keycloak_available != available) {
        keycloak_available = available;
        log_module(NS_LOG, LOG_INFO, "Keycloak availability changed: %s",
                   available ? "available" : "unavailable");
        nickserv_update_sasl_mechanisms();
    }
}
```

### 5.3 P10 Message Tag Compatibility ✅

X3's P10 parser now handles message tags:

```c
/* Skip IRCv3 message tags if present (backward compatibility) */
if (line[0] == '@') {
    char *tag_end = strchr(line, ' ');
    if (tag_end)
        line = tag_end + 1;
}
```

---

## Files Modified (Complete List)

| File | Changes |
|------|---------|
| `x3/src/keycloak.h` | Structs and function declarations |
| `x3/src/keycloak.c` | Full Keycloak REST API implementation |
| `x3/src/nickserv.h` | Config fields, mechanism functions |
| `x3/src/nickserv.c` | Auth, SASL, mechanism broadcast |
| `x3/src/proto.h` | `irc_sasl_mechs_broadcast()` declaration |
| `x3/src/proto-p10.c` | Mechanism broadcast, tag parsing |
| `x3/configure.in` | `--with-keycloak` option |
| `x3/src/Makefile.am` | Added keycloak sources |
| `x3/docker/x3.conf-dist` | Keycloak config template |
| `x3/Dockerfile` | Build dependencies |
