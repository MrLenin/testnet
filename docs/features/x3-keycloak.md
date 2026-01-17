# X3 Keycloak Integration

OAuth2/OIDC integration for X3 Services with Keycloak identity provider.

## Overview

X3 integrates with Keycloak to provide centralized user management, OAuth2 authentication, and group-based channel access. This enables web-based account management, SSO across IRC and web services, and enterprise identity federation.

## Architecture

```
┌─────────┐                    ┌────┐                    ┌──────────┐
│ IRC     │──SASL────────────►│ X3 │──REST API────────►│ Keycloak │
│ Client  │                    │    │                    │          │
│         │◄─────────────────│    │◄─────────────────│          │
└─────────┘                    └─┬──┘                    └──────────┘
                                 │
                            ┌────▼────┐
                            │  LMDB   │
                            │ (cache) │
                            └─────────┘
```

## Configuration

### NickServ Settings

| Setting | Description |
|---------|-------------|
| `keycloak_enable` | Enable Keycloak integration |
| `keycloak_url` | Keycloak server URL |
| `keycloak_realm` | Realm name |
| `keycloak_client_id` | OAuth client ID |
| `keycloak_client_secret` | OAuth client secret |

### ChanServ Settings

| Setting | Description |
|---------|-------------|
| `keycloak_access_sync` | Enable group-based channel access |
| `keycloak_hierarchical_groups` | Use hierarchical group paths |
| `keycloak_use_group_attributes` | Enable user attribute mode (recommended) |
| `keycloak_bidirectional_sync` | Push changes to Keycloak |
| `keycloak_sync_frequency` | Sync interval (seconds) |

### Example Configuration

```
"nickserv" {
    "keycloak_enable" = "1";
    "keycloak_url" = "https://keycloak.example.com";
    "keycloak_realm" = "irc";
    "keycloak_client_id" = "x3-services";
    "keycloak_client_secret" = "secret-here";
};

"chanserv" {
    "keycloak_access_sync" = "1";
    "keycloak_bidirectional_sync" = "1";
    "keycloak_use_group_attributes" = "1";
    "keycloak_sync_frequency" = "3600";
};
```

## Authentication Flow

### SASL PLAIN with Keycloak

1. Client sends SASL PLAIN credentials
2. X3 checks LMDB cache for user
3. Cache miss: X3 queries Keycloak REST API
4. Keycloak validates password
5. X3 caches user representation
6. Authentication succeeds/fails

### Password Validation

```
POST /auth/realms/{realm}/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&client_id=x3&username=user&password=pass
```

## User Management

### Keycloak User Attributes

X3 stores IRC-specific data in Keycloak user attributes:

| Attribute | Purpose |
|-----------|---------|
| `metadata.*` | IRCv3 metadata key-value pairs |
| `webpush.*` | Push notification subscriptions |
| `readmarker.*` | Read marker timestamps |
| `sslfp.*` | Certificate fingerprints |

### Account Operations

| IRC Command | Keycloak API |
|-------------|--------------|
| REGISTER | Create user |
| SET PASSWORD | Update credentials |
| SET EMAIL | Update email |
| DROP | Delete user (soft/hard) |

## Group-Based Channel Access

### Group Naming Modes

**Legacy Suffix Mode**:
```
irc-channel-#help-owner    → Access level 500
irc-channel-#help-op       → Access level 200
irc-channel-#help-halfop   → Access level 150
```

**Attribute Mode** (recommended):
```
irc-channel-#help (x3_access_level=350) → Access level 350
```

### Sync Direction

**Keycloak → X3** (periodic sync):
1. Timer fires every `sync_frequency` seconds
2. X3 queries Keycloak for group memberships
3. X3 updates LMDB with access levels
4. Channel ops reflect Keycloak groups

**X3 → Keycloak** (bidirectional sync):
1. User runs `ADDUSER #channel user 200`
2. X3 creates group in Keycloak (if needed)
3. X3 adds user to Keycloak group
4. X3 sets x3_access_level attribute

## Caching

### User Cache

| Cache | TTL | Purpose |
|-------|-----|---------|
| User representation | 300s | Full Keycloak user object |
| Password validation | Per-auth | No caching (always verify) |
| Group membership | 3600s | Channel access |

### Cache Invalidation

1. **TTL expiry**: Automatic after configured duration
2. **Webhook** (recommended): Real-time via Keycloak events
3. **Manual**: `/msg NickServ KEYCLOAK FLUSH user`

## Async HTTP

X3 uses non-blocking HTTP for Keycloak API calls:

1. Request queued with callback
2. Event loop continues (no blocking)
3. Response triggers callback
4. Result processed asynchronously

**Benefits**:
- No thread blocking during API calls
- Multiple concurrent requests
- Graceful timeout handling

## Error Handling

### API Failures

| Scenario | Behavior |
|----------|----------|
| Network timeout | Use cached data |
| 401 Unauthorized | Refresh client token |
| 404 Not Found | User doesn't exist |
| 5xx Error | Retry with backoff |

### Backoff Strategy

Exponential backoff on repeated failures:
- First retry: 1 second
- Second retry: 2 seconds
- Third retry: 4 seconds
- Max: 60 seconds

## OpServ Commands

```
KEYCLOAK STATUS     - Show connection status
KEYCLOAK STATS      - HTTP request statistics
KEYCLOAK FLUSH <u>  - Flush cache for user
KEYCLOAK SYNC       - Trigger manual group sync
```

## Build Requirements

```bash
./configure --with-keycloak
```

Requires: `libcurl-dev`

## Keycloak Configuration

### Required Client Settings

1. Create client in Keycloak admin console
2. Set access type: confidential
3. Enable service accounts
4. Assign roles: manage-users, view-users

### Required Realm Roles

For bidirectional sync:
- `manage-users`: Create/update users
- `manage-groups`: Create/update groups
- `view-users`: List users

---

*Part of the X3 Services IRCv3.2+ upgrade project.*
