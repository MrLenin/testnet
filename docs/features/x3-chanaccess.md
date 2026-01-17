# X3 Channel Access Sync

Keycloak group-based channel access synchronization for X3 ChanServ.

## Overview

ChanServ can synchronize channel access from Keycloak groups, enabling centralized access management. Optionally supports bidirectional sync where X3 changes are pushed to Keycloak.

## Architecture

### Unidirectional (Keycloak → X3)

```
┌──────────┐                    ┌────┐
│ Keycloak │──(timer sync)────►│ X3 │
│  Groups  │                    │    │
│          │                    │    │
└──────────┘                    └──┬─┘
                                   │
                               ┌───▼───┐
                               │ LMDB  │
                               │chanaccess│
                               └───────┘
```

### Bidirectional (X3 ↔ Keycloak)

```
┌──────────┐                    ┌────┐
│ Keycloak │◄─────────────────►│ X3 │
│  Groups  │  (REST API)        │    │
│          │                    │    │
└──────────┘                    └──┬─┘
                                   │
                               ┌───▼───┐
                               │ LMDB  │
                               │chanaccess│
                               └───────┘
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `keycloak_access_sync` | 0 | Enable group sync |
| `keycloak_hierarchical_groups` | 0 | Use hierarchical paths |
| `keycloak_use_group_attributes` | 0 | Use x3_access_level attribute |
| `keycloak_bidirectional_sync` | 0 | Push changes to Keycloak |
| `keycloak_group_prefix` | (auto) | Group name/path prefix |
| `keycloak_access_level_attr` | x3_access_level | Attribute name |
| `keycloak_sync_frequency` | 3600 | Sync interval (seconds) |

## Group Naming Modes

### Legacy Suffix Mode (keycloak_use_group_attributes=0)

Groups named with access level suffix:

**Flat mode**:
```
irc-channel-#help-owner     → 500
irc-channel-#help-coowner   → 400
irc-channel-#help-manager   → 300
irc-channel-#help-op        → 200
irc-channel-#help-halfop    → 150
irc-channel-#help-peon      → 1
```

**Hierarchical mode**:
```
/irc-channels/#help/owner   → 500
/irc-channels/#help/op      → 200
```

### Attribute Mode (keycloak_use_group_attributes=1)

Groups use `x3_access_level` attribute for any numeric level:

**Flat mode**:
```
irc-channel-#help-seniors   (x3_access_level=350) → 350
irc-channel-#help-juniors   (x3_access_level=250) → 250
```

**Hierarchical mode**:
```
/irc-channels/#help         (x3_access_level=200) → 200
```

## Access Levels

| Level | Name | ChanServ Role |
|-------|------|---------------|
| 1-99 | Peon | Basic access |
| 100-199 | HalfOp | Half-operator |
| 200-299 | Op | Operator |
| 300-399 | Manager | Can modify users <300 |
| 400-499 | CoOwner | Can modify users <500 |
| 500 | Owner | Full control |

## Sync Behavior

### Startup Sync

1. X3 starts, waits 30 seconds
2. Queries Keycloak for all relevant groups
3. Populates LMDB with memberships
4. ChanServ uses LMDB for access checks

### Periodic Sync

If `keycloak_sync_frequency > 0`:

1. Timer fires every N seconds
2. Full resync of group memberships
3. Handles adds, removes, level changes

### LMDB Lookup

ChanServ access checks:

1. Check SAXDB (traditional access)
2. Check LMDB (Keycloak sync)
3. Use highest access level found

## Bidirectional Sync

When `keycloak_bidirectional_sync=1`:

### ADDUSER

```
/msg ChanServ ADDUSER #help JohnDoe 350
```

1. X3 adds to internal access (SAXDB/LMDB)
2. X3 creates `/irc-channels/#help` group (if needed)
3. X3 sets `x3_access_level=350` attribute
4. X3 adds JohnDoe to group

### CLVL

```
/msg ChanServ CLVL #help JohnDoe 400
```

1. X3 updates internal access level
2. X3 updates group's `x3_access_level` attribute

### DELUSER

```
/msg ChanServ DELUSER #help JohnDoe
```

1. X3 removes from internal access
2. X3 removes JohnDoe from Keycloak group

### UNREGISTER

```
/msg ChanServ UNREGISTER #help
```

1. X3 unregisters channel
2. X3 deletes `/irc-channels/#help` group from Keycloak

## Keycloak Group Structure

### Flat Groups

```
Groups:
├── irc-channel-#help (x3_access_level=200)
│   └── Members: user1, user2
├── irc-channel-#support (x3_access_level=150)
│   └── Members: user3
└── irc-channel-#dev-owner
    └── Members: admin1
```

### Hierarchical Groups

```
/irc-channels/
├── #help/
│   ├── Attributes: x3_access_level=200
│   └── Members: user1, user2
├── #support/
│   ├── Attributes: x3_access_level=150
│   └── Members: user3
└── #dev/
    └── owner/
        └── Members: admin1
```

## Error Handling

### Keycloak Unavailable

- Use cached LMDB data
- Log warning
- Retry with exponential backoff

### Group Creation Failure

- Log error
- Local change succeeds
- Queue for retry

### Rate Limiting

- Batch group operations
- Respect Keycloak rate limits
- Backoff on 429 responses

## Example Configuration

```
"chanserv" {
    "keycloak_access_sync" = "1";
    "keycloak_bidirectional_sync" = "1";
    "keycloak_use_group_attributes" = "1";
    "keycloak_hierarchical_groups" = "1";
    "keycloak_group_prefix" = "irc-channels";
    "keycloak_sync_frequency" = "3600";
};
```

## OpServ Commands

```
KEYCLOAK SYNC           # Trigger manual sync
KEYCLOAK STATUS         # Show sync status
```

## Keycloak Admin API

### Get Groups

```
GET /admin/realms/{realm}/groups?search=irc-channel
```

### Create Group

```
POST /admin/realms/{realm}/groups
{
  "name": "#help",
  "path": "/irc-channels/#help",
  "attributes": {
    "x3_access_level": ["200"]
  }
}
```

### Add User to Group

```
PUT /admin/realms/{realm}/users/{userId}/groups/{groupId}
```

---

*Part of the X3 Services IRCv3.2+ upgrade project.*
