# X3 Keycloak Integration Plan

## Status: COMPLETE

All phases implemented and committed to `x3` submodule on branch `keycloak-integration` (commit `461859d`).

---

## Overview

Convert X3 IRC Services from LDAP to Keycloak for authentication and user management, including SASL OAUTHBEARER support for S2S protocol.

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

## Future Enhancements

- **IRCv3.2 SASL in Nefarious** - For proper token re-authentication (SASL REAUTHENTICATE)
- **Token refresh handling** - Client-side token refresh before expiry
