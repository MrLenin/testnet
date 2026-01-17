# Pre-away Presence Aggregation Implementation Plan

## Status: IMPLEMENTED

**Branch**: `ircv3.2-upgrade` (commit `9f8219d`)

## Overview

This document details the implementation plan for presence aggregation across multiple connections for users logged into the same account. This enhancement builds on the existing `draft/pre-away` implementation.

**Spec Reference**: https://ircv3.net/specs/extensions/pre-away

**Key Principle**: The spec says aggregation is "outside the scope of this specification" but provides guidance that `AWAY *` should be "treated as though the connection did not exist at all" and should not supersede human-readable away messages from other connections.

---

## Current State

### What's Implemented

1. **Pre-away capability** (`draft/pre-away`) - stores away state before registration
2. **Pre-registration AWAY command** (`mu_away` in m_away.c) - handles AWAY before registration
3. **AWAY * semantics** - Special hidden connection state (con_pre_away = 2)
4. **Away-notify** - Broadcasts away changes to channel members with capability

### What's Missing

1. **No account-based connection tracking** - Server has no concept of "all connections for account X"
2. **No presence aggregation logic** - Each connection's away state is independent
3. **No cross-connection awareness** - Setting away on one connection doesn't consider others
4. **AWAY * not truly hidden** - Currently broadcast like regular AWAY

---

## Requirements

### Functional Requirements

1. **Track connections by account**: Maintain a list of all connections logged into each account
2. **Aggregate presence state**: Compute effective away status across all connections
3. **AWAY * hidden semantics**: Connections marked `AWAY *` should not affect presence unless ALL connections are `AWAY *`
4. **Priority rules**:
   - If ANY connection is present (no AWAY) → user appears present
   - If all present connections have AWAY messages → use first/oldest non-`*` message
   - If ALL connections are `AWAY *` → user appears away (can substitute message)
5. **Away-notify integration**: Only send away-notify when effective presence changes

### Non-Functional Requirements

1. **Performance**: Account lookup must be O(1) or O(log n)
2. **Memory**: Minimal overhead for connection tracking
3. **Network traffic**: Reduce unnecessary away-notify broadcasts

---

## Architecture

### Data Structures

#### 1. Account Connection List (New)

Add to `struct User` or create new structure:

```c
/* Account connection tracking */
struct AccountConnection {
  struct Client *client;           /* The connected client */
  unsigned char away_state;        /* 0=present, 1=away, 2=away-star */
  struct AccountConnection *next;
};

/* Hash table: account name -> head of connection list */
static struct {
  struct AccountConnection *head;
  int count;
} account_connections[ACCOUNT_HASH_SIZE];
```

#### 2. Connection State Extensions

Modify `struct User` to track aggregation:

```c
struct User {
  /* ... existing fields ... */
  char *away;                           /* Current away message (computed/aggregated) */
  char *away_own;                       /* This connection's own away message */
  unsigned char away_state;             /* This connection's away state: 0/1/2 */
  struct AccountConnection *acc_link;   /* Link in account connection list */
};
```

### Components

#### 1. Account Connection Registry (`account_conn.c`, `account_conn.h`)

New module for tracking connections per account.

**Functions**:
```c
void account_conn_init(void);
void account_conn_shutdown(void);

/* Add connection to account's list */
int account_conn_add(struct Client *cptr, const char *account);

/* Remove connection from account's list */
void account_conn_remove(struct Client *cptr);

/* Get all connections for an account */
struct AccountConnection *account_conn_list(const char *account);

/* Count connections for an account */
int account_conn_count(const char *account);

/* Compute aggregated presence for account */
int account_presence_compute(const char *account, char **message);
```

#### 2. Presence Aggregation Logic (`presence.c`, `presence.h`)

New module for computing and broadcasting presence changes.

**Functions**:
```c
/* Set this connection's away state (doesn't broadcast yet) */
void presence_set_own(struct Client *cptr, int state, const char *message);

/* Compute and broadcast aggregated presence if changed */
void presence_update(struct Client *cptr);

/* Get effective presence for user (considers all connections) */
int presence_get_effective(struct Client *cptr, char **message);
```

#### 3. Modified AWAY Handler (`m_away.c`)

Update `m_away()` to use presence aggregation:

```c
int m_away(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
  char *away_message = parv[1];
  int new_state;

  /* Determine new state */
  if (EmptyString(away_message))
    new_state = 0;  /* Present */
  else if (away_message[0] == '*' && away_message[1] == '\0')
    new_state = 2;  /* Away-star (hidden) */
  else
    new_state = 1;  /* Normal away */

  /* Set this connection's state */
  presence_set_own(sptr, new_state, away_message);

  /* Compute and broadcast aggregated presence */
  presence_update(sptr);

  /* Send appropriate reply */
  if (new_state == 0)
    send_reply(sptr, RPL_UNAWAY);
  else
    send_reply(sptr, RPL_NOWAWAY);

  return 0;
}
```

---

## Implementation Phases

### Phase 1: Account Connection Registry

**Goal**: Track all connections per account

**Files to create**:
- `include/account_conn.h` - API declarations
- `ircd/account_conn.c` - Implementation

**Integration points**:
- `s_user.c:register_user()` - Call `account_conn_add()` when user authenticates
- `s_user.c:exit_one_client()` - Call `account_conn_remove()` on disconnect
- `m_account.c` - Update registry when account changes

**Data structure**:
```c
#define ACCOUNT_HASH_SIZE 1024

struct AccountConnList {
  char account[ACCOUNTLEN + 1];
  struct AccountConnection *head;
  int count;
  struct AccountConnList *next;  /* Hash collision chain */
};

static struct AccountConnList *account_hash[ACCOUNT_HASH_SIZE];
```

**Effort**: 8-12 hours

### Phase 2: Connection Away State Storage

**Goal**: Store per-connection away state separate from aggregated state

**Changes to `struct User`**:
```c
char *away_own;             /* This connection's away message (NULL if present) */
unsigned char away_state;   /* 0=present, 1=away, 2=away-star */
```

**Changes to away handling**:
- Store message in `away_own` instead of `away`
- `away` becomes the aggregated/effective message

**Effort**: 4-8 hours

### Phase 3: Presence Aggregation Logic

**Goal**: Compute effective presence from all connections

**Algorithm**:
```c
int account_presence_compute(const char *account, char **effective_message)
{
  struct AccountConnection *conn;
  struct AccountConnection *first_away = NULL;
  int has_present = 0;
  int has_away_msg = 0;
  int all_away_star = 1;

  for (conn = account_conn_list(account); conn; conn = conn->next) {
    struct User *user = cli_user(conn->client);

    if (user->away_state == 0) {
      /* This connection is present */
      has_present = 1;
      all_away_star = 0;
      break;  /* User is present - done */
    }
    else if (user->away_state == 1) {
      /* Normal away with message */
      all_away_star = 0;
      if (!first_away)
        first_away = conn;
      has_away_msg = 1;
    }
    /* away_state == 2 is away-star, contributes to all_away_star */
  }

  if (has_present) {
    *effective_message = NULL;
    return 0;  /* Present */
  }

  if (has_away_msg && first_away) {
    *effective_message = cli_user(first_away->client)->away_own;
    return 1;  /* Away with message */
  }

  if (all_away_star) {
    *effective_message = NULL;  /* Or substitute message */
    return 2;  /* All connections are away-star */
  }

  return 0;  /* Fallback: present */
}
```

**Effort**: 8-12 hours

### Phase 4: Presence Change Detection and Broadcast

**Goal**: Only broadcast when effective presence actually changes

**Logic**:
```c
void presence_update(struct Client *cptr)
{
  const char *account;
  char *new_effective;
  int new_state;
  int old_state;
  char *old_effective;

  if (!IsAccount(cptr))
    return;  /* Non-authenticated users: use per-connection behavior */

  account = cli_account(cptr);

  /* Get current effective state */
  old_state = cli_user(cptr)->away ? 1 : 0;
  old_effective = cli_user(cptr)->away;

  /* Compute new effective state */
  new_state = account_presence_compute(account, &new_effective);

  /* Check if effective presence changed */
  if (old_state != new_state ||
      (old_effective && new_effective && strcmp(old_effective, new_effective) != 0) ||
      (old_effective != new_effective)) {

    /* Update user->away to effective message */
    if (cli_user(cptr)->away)
      MyFree(cli_user(cptr)->away);

    if (new_effective) {
      cli_user(cptr)->away = MyStrdup(new_effective);
    } else {
      cli_user(cptr)->away = NULL;
    }

    /* Broadcast change to network and away-notify clients */
    if (new_state == 0) {
      sendcmdto_serv_butone(cptr, CMD_AWAY, cptr, "");
      sendcmdto_common_channels_capab_butone(cptr, CMD_AWAY, cptr,
                                             CAP_AWAYNOTIFY, CAP_NONE, "");
    } else if (new_state == 2) {
      /* Away-star: broadcast to network but maybe hide from away-notify? */
      /* Or substitute a message */
      sendcmdto_serv_butone(cptr, CMD_AWAY, cptr, ":Away");
      sendcmdto_common_channels_capab_butone(cptr, CMD_AWAY, cptr,
                                             CAP_AWAYNOTIFY, CAP_NONE, ":Away");
    } else {
      sendcmdto_serv_butone(cptr, CMD_AWAY, cptr, ":%s", new_effective);
      sendcmdto_common_channels_capab_butone(cptr, CMD_AWAY, cptr,
                                             CAP_AWAYNOTIFY, CAP_NONE,
                                             ":%s", new_effective);
    }
  }
}
```

**Effort**: 12-16 hours

### Phase 5: Away-Star Network Handling

**Goal**: Proper P10 propagation of AWAY * semantics

**Options**:
1. **Propagate as-is**: Send `AWAY :*` over P10, let each server aggregate
2. **Don't propagate away-star**: Only propagate effective state
3. **New P10 extension**: Add away-state flag to user burst

**Recommendation**: Option 1 initially - simplest, allows each server to aggregate

**Effort**: 4-8 hours

### Phase 6: AWAY Substitution for Away-Star

**Goal**: Substitute human-readable message for AWAY * users

**Implementation**:
```c
/* Config option for substitution message */
FEAT_AWAY_STAR_MSG = "Away"

/* In presence_update when broadcasting away-star */
if (new_state == 2) {
  const char *subst_msg = feature_str(FEAT_AWAY_STAR_MSG);
  if (EmptyString(subst_msg))
    subst_msg = "Away";
  sendcmdto_serv_butone(cptr, CMD_AWAY, cptr, ":%s", subst_msg);
  /* ... */
}
```

**Effort**: 2-4 hours

---

## Configuration Options

| Feature | Default | Description |
|---------|---------|-------------|
| `FEAT_PRESENCE_AGGREGATION` | FALSE | Enable presence aggregation (disabled by default for safety) |
| `FEAT_AWAY_STAR_MSG` | "Away" | Substitute message for AWAY * in away-notify |

---

## Testing Strategy

### Unit Tests

1. **Account registry**: Add/remove connections, hash collisions
2. **Presence computation**: All state combinations
3. **Edge cases**: Single connection, logout, re-login

### Integration Tests

1. **Two-client scenario**:
   - Client A connects as account X, sets AWAY
   - Client B connects as account X, stays present
   - Verify: User appears present
   - Client B sets AWAY
   - Verify: User appears away with A's message

2. **Away-star scenario**:
   - Client A connects as account X, sets AWAY *
   - Client B connects as account X, stays present
   - Verify: User appears present
   - Client B disconnects
   - Verify: User appears away (with substituted message)

3. **Network propagation**:
   - Verify AWAY messages propagate correctly via P10
   - Verify away-notify only sent on effective change

### Performance Tests

1. Account with 100 connections - verify O(n) scan is acceptable
2. Rapid away/unaway cycling - verify no excessive broadcasts

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Performance with many connections per account | Medium | Cap connections per account, optimize with cached state |
| Breaking existing away behavior | High | Feature flag (FEAT_PRESENCE_AGGREGATION), disabled by default |
| P10 compatibility with old servers | Medium | Old servers ignore enhanced semantics, fall back to per-connection |
| Complexity in distributed state | High | Each server computes locally, P10 carries per-connection state |

---

## Dependencies

- Existing `draft/pre-away` implementation (complete)
- Account authentication (IsAccount, cli_account)
- away-notify capability (complete)

---

## Effort Summary

| Phase | Description | Effort |
|-------|-------------|--------|
| 1 | Account Connection Registry | 8-12 hours |
| 2 | Connection Away State Storage | 4-8 hours |
| 3 | Presence Aggregation Logic | 8-12 hours |
| 4 | Presence Change Detection/Broadcast | 12-16 hours |
| 5 | Away-Star Network Handling | 4-8 hours |
| 6 | Away Substitution | 2-4 hours |
| Testing | All phases | 8-12 hours |

**Total Estimate**: 46-72 hours

---

## Decision Points

### Decision 1: Scope

**Question**: Implement full presence aggregation or just AWAY * (away-star) handling?

| Option | Complexity | User Benefit |
|--------|------------|--------------|
| **AWAY * only** | Low | Hides "zombie" connections |
| **Full aggregation** | High | True multi-device presence |

**Analysis**:

AWAY * semantics (from spec):
> "treated as though the connection did not exist at all"

This suggests AWAY * connections should be invisible to presence, but other connections still matter.

**Recommendation: Full aggregation**

Rationale:
- AWAY * without aggregation is incomplete - still shows "away" when user has present connection
- Full aggregation is the spec's intent for multi-connection scenarios
- Implementation complexity is similar once account tracking exists
- Provides better UX for users with multiple devices

**Decision: Implement full presence aggregation. AWAY * is just one state in the aggregation logic.**

---

### Decision 2: P10 Format

**Question**: How to propagate per-connection away state across servers?

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Existing AWAY** | `AWAY :*` for away-star | No protocol changes | Servers can't distinguish AWAY * from message "*" |
| **Extended AWAY** | `AWAY * :message` (star as flag) | Clear semantics | Minor protocol extension |
| **New token** | `AWAYSTATE 0/1/2` per connection | Full control | New token needed |

**Current implementation**:
```
AWAY :message  → Normal away
AWAY           → Present (clear away)
AWAY :*        → Away-star (ambiguous - could be literal "*" message)
```

**Recommendation: Use extended AWAY with visibility-style flag**

```
AWAY           → Present (clear away)
AWAY :message  → Normal away with message
AWAY * :       → Away-star (no message, hidden)
AWAY * :msg    → Away-star with fallback message (for old clients)
```

This mirrors the metadata visibility syntax (`*` = public, `P` = private) and is backwards-compatible - old servers treat `* :` as a message starting with "* ".

**Decision: Extend AWAY to use `*` prefix for away-star state. Backwards compatible.**

---

### Decision 3: Multi-Server / X3 Involvement

**Question**: Should X3 be involved in presence aggregation, or should each IRCd handle it locally?

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **IRCd-only** | Each server aggregates locally | Simple, no X3 changes | Inconsistent if connections on different servers |
| **X3 authoritative** | X3 tracks all connections, broadcasts effective state | Consistent network-wide | X3 dependency, latency |
| **Hybrid** | IRCd aggregates local, X3 aggregates cross-server | Best of both | Most complex |

**Analysis of multi-server scenario**:
```
Server A: User connects with AWAY *
Server B: User connects, present

Without coordination:
- Server A thinks user is away (only sees local connection)
- Server B thinks user is present (only sees local connection)
- Different users on A vs B see different presence!
```

**Recommendation: IRCd-only with P10 propagation**

Rationale:
- P10 already propagates AWAY messages to all servers
- Each server receives all connection states via P10
- No X3 involvement needed - IRCd has full picture
- Account connection registry (Phase 1) tracks all connections network-wide via P10

```
User connects to Server A, AWAY *:
  A broadcasts: AB AWAY ABAAB * :
  B receives, stores in account connection list

User connects to Server B, present:
  B broadcasts: CD AWAY CDAAC    (empty = present)
  A receives, updates account connection list

Both servers now know: 2 connections, one AWAY *, one present
Aggregation: User is PRESENT (present > away-star)
```

**Decision: IRCd handles aggregation using P10-propagated state. No X3 involvement needed.**

---

### Decision 4: Feature Flag

**Question**: Should presence aggregation be enabled by default or require opt-in?

| Option | Pros | Cons |
|--------|------|------|
| **Enabled by default** | Users get benefit immediately | May surprise admins, harder to debug |
| **Disabled by default** | Safe rollout, explicit opt-in | Users don't benefit until enabled |
| **Enabled with override** | Best of both | Slightly more complex config |

**Recommendation: Disabled by default initially, enabled after stabilization**

Rationale:
- New feature with network-wide impact
- Admins should explicitly enable after testing
- Can flip default in future release once proven stable
- Feature flag allows quick disable if issues found

```c
/* ircd.conf */
FEAT_PRESENCE_AGGREGATION = FALSE;  /* Default: disabled */

/* After testing */
FEAT_PRESENCE_AGGREGATION = TRUE;
```

**Decision: Disabled by default via `FEAT_PRESENCE_AGGREGATION`. Flip to enabled in future release after stabilization.**

---

### Decision Summary

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Scope | Full aggregation (not just AWAY *) |
| 2 | P10 format | Extended AWAY with `*` prefix for away-star |
| 3 | Multi-server | IRCd-only via P10 propagation, no X3 |
| 4 | Feature flag | Disabled by default initially |

---

## Future Considerations

### 1. X3 Integration for Presence Tracking

**Question**: Should X3 track account presence across the network?

**Current Model (IRCd-Only)**:
```
Server A             Server B             X3
    │                    │                 │
    ├─────AWAY P10───────┤                 │
    │    (to all)        │                 │
    │                    ├─────AWAY P10────┤ (receives but ignores)
    │                    │                 │
Each IRCd maintains its own account connection registry
X3 only knows about connections to services
```

**X3-Integrated Model**:
```
Server A             Server B             X3
    │                    │                 │
    ├─────AWAY P10───────┼────────────────▶│ X3 maintains master registry
    │                    │                 │
    │◀───────────────────┼─────PRESENCE────│ X3 broadcasts effective state
    │                    │◀────────────────│
All servers receive authoritative presence from X3
```

**Benefits of X3 Integration**:

| Benefit | Description |
|---------|-------------|
| Single source of truth | X3 is authoritative for account state |
| Persistent presence | Survives netsplits better |
| Service awareness | MemoServ can use presence for notifications |
| Cross-network queries | "Is user X present?" can be answered by X3 |
| NickServ integration | Link presence to account status |

**Implementation Approach**:

1. **X3 Presence Registry** (`nickserv.c`):
   ```c
   struct AccountPresence {
     char account[ACCOUNTLEN];
     int connection_count;
     int present_count;      /* Connections without AWAY */
     int away_count;         /* Connections with AWAY message */
     int away_star_count;    /* Connections with AWAY * */
     time_t last_present;    /* When user was last present */
     char *away_message;     /* Current effective away message */
   };
   ```

2. **P10 Handler Extensions** (`proto-p10.c`):
   ```c
   /* Track AWAY changes for presence aggregation */
   static CMD_FUNC(cmd_away_presence) {
     const char *account = /* from user lookup */;
     struct AccountPresence *pres = presence_get(account);

     update_presence_state(pres, user, new_away_state);

     if (presence_effective_changed(pres)) {
       /* Notify interested parties */
       presence_broadcast_change(pres);
     }
   }
   ```

3. **Presence Query Command**:
   ```
   /msg NickServ PRESENCE <account>
   -NickServ- User 'Rubin' is currently PRESENT
   -NickServ- Last seen: now
   -NickServ- Connections: 3 (2 present, 1 away-star)
   ```

**Trade-offs**:

| Aspect | IRCd-Only | X3-Integrated |
|--------|-----------|---------------|
| Complexity | Lower | Higher |
| Latency | None | P10 round-trip |
| X3 dependency | None | Presence breaks if X3 down |
| Consistency | Per-server view | Network-wide consistency |
| Extensibility | Limited | Rich service integration |

**Recommendation**: Start with IRCd-only (current plan), add X3 integration as Phase 7

**Effort**: 16-24 hours

---

### 2. Presence API via METADATA or New Command

**Question**: How should clients query aggregated presence?

**Current Access Methods**:
- WHOIS: Shows away message (per-connection, not aggregated)
- AWAY-NOTIFY: Real-time notifications (capability-based)

**Proposed: METADATA-Based Presence**

Store aggregated presence as a special metadata key:

```
Key: $presence (special, system-managed)
Value: JSON-encoded presence state

Example:
METADATA Rubin $presence * :{"status":"present","connections":3,"last_away":"2024-01-15T10:30:00Z"}
```

**Benefits**:
- Uses existing METADATA infrastructure
- Clients can query via standard METADATA GET
- Supports subscription via METADATA NOTIFY (future)
- Extensible JSON format

**Implementation**:

1. **Reserved Key** (`$presence`):
   ```c
   /* In metadata.c */
   #define METADATA_PRESENCE_KEY "$presence"

   /* Updated on every presence change */
   void presence_update_metadata(struct Client *cptr, int state) {
     char json[256];
     snprintf(json, sizeof(json),
       "{\"status\":\"%s\",\"connections\":%d}",
       state == 0 ? "present" : "away",
       account_conn_count(cli_account(cptr)));
     metadata_set_client(cptr, METADATA_PRESENCE_KEY, json, METADATA_VIS_PUBLIC);
   }
   ```

2. **Client Query**:
   ```
   METADATA Rubin GET $presence
   :server METADATA Rubin $presence * :{"status":"present","connections":3}
   ```

**Alternative: Dedicated PRESENCE Command**

New IRC command for presence queries:

```
PRESENCE <target>

Response:
:server 320 mynick Rubin :is currently present
:server 321 mynick Rubin :Last away: 2024-01-15 10:30:00
:server 322 mynick Rubin :3 connections (2 present, 1 away-star)
```

**Comparison**:

| Aspect | METADATA Approach | PRESENCE Command |
|--------|-------------------|------------------|
| Standards | Uses existing IRCv3 | New protocol addition |
| Client support | Existing METADATA clients | Requires new client code |
| Format | JSON (flexible) | Numeric replies (IRC-native) |
| Batch query | METADATA GET for multiple | Separate command per user |
| Subscription | Via METADATA NOTIFY | Would need PRESENCE-NOTIFY |

**Recommendation**: METADATA approach for consistency with existing infrastructure

**Effort**: 8-12 hours

---

### 3. Mobile Awareness (Device-Type Priority)

**Question**: Should presence aggregation consider device type (mobile vs desktop)?

**Motivation**:

Mobile devices often use AWAY * to indicate backgrounded apps:
- Phone screen locked → client sends AWAY *
- Phone unlocked → client clears AWAY

Desktop clients typically have more stable presence:
- User at keyboard → present
- User AFK → explicit AWAY with message

**Priority Model**:

```
Priority (highest to lowest):
1. Desktop present
2. Mobile present
3. Desktop away with message
4. Mobile away with message
5. Desktop away-star
6. Mobile away-star (lowest - essentially invisible)
```

**Detection Methods**:

1. **Client Capability** (new `device-type` extension):
   ```
   CAP REQ device-type=mobile
   CAP REQ device-type=desktop
   CAP REQ device-type=bot
   ```

2. **User-Agent Parsing** (if available):
   ```c
   int detect_device_type(const char *user_agent) {
     if (strstr(user_agent, "Android") || strstr(user_agent, "iOS"))
       return DEVICE_MOBILE;
     if (strstr(user_agent, "Bot") || strstr(user_agent, "bridge"))
       return DEVICE_BOT;
     return DEVICE_DESKTOP;
   }
   ```

3. **Client Software Hints**:
   Some clients identify themselves in VERSION reply or CTCP

**Implementation**:

```c
struct AccountConnection {
  struct Client *client;
  unsigned char away_state;    /* 0=present, 1=away, 2=away-star */
  unsigned char device_type;   /* 0=unknown, 1=desktop, 2=mobile, 3=bot */
  struct AccountConnection *next;
};

/* Enhanced aggregation considering device type */
int account_presence_compute_v2(const char *account, char **message) {
  /* Priority: desktop present > mobile present > desktop away > ... */

  struct AccountConnection *best = NULL;
  int best_priority = 999;

  for (conn = ...; conn; conn = conn->next) {
    int priority = compute_priority(conn->away_state, conn->device_type);
    if (priority < best_priority) {
      best_priority = priority;
      best = conn;
    }
  }

  /* Return state from highest-priority connection */
  return best ? best->away_state : 0;
}
```

**Use Cases**:

| Scenario | Without Device Awareness | With Device Awareness |
|----------|--------------------------|----------------------|
| Desktop AFK, phone in pocket | Shows "away" | Shows "away" (correct) |
| Desktop closed, phone active | Shows "present" | Shows "present" (correct) |
| Desktop active, phone locked | Shows "present" | Shows "present" (both correct) |
| Only phone, locked | Shows "away" | Shows "away" or hidden (better) |

**Recommendation**: Defer to future phase, implement only if clients adopt device-type capability

**Effort**: 12-16 hours

---

### 4. Presence History

**Question**: Should we track when a user was last present?

**Use Cases**:

| Use Case | Benefit |
|----------|---------|
| "Last seen" info | Know when user was last active |
| Idle time calculation | Show how long user has been away |
| Notification decisions | Don't notify if user hasn't been seen in weeks |
| Analytics | Network activity patterns |

**Implementation Approaches**:

#### Approach A: In-Memory Only

Store last-present time in account connection registry:

```c
struct AccountPresence {
  /* ... */
  time_t last_present;     /* Last time any connection was present */
  time_t first_away;       /* When user first went away */
};

/* Update on presence change */
void presence_record_change(struct AccountPresence *pres, int new_state) {
  if (new_state == 0) {  /* Becoming present */
    pres->last_present = CurrentTime;
    pres->first_away = 0;
  } else if (pres->first_away == 0) {  /* First away */
    pres->first_away = CurrentTime;
  }
}
```

**Pros**: Simple, no persistence needed
**Cons**: Lost on restart, only covers current session

#### Approach B: Persistent in LMDB

Store in account metadata (Nefarious LMDB or X3):

```c
/* Special metadata keys */
#define MD_LAST_PRESENT "$last_present"
#define MD_LAST_AWAY    "$last_away"

/* Store as Unix timestamp */
metadata_account_set(account, MD_LAST_PRESENT, timestamp_str, METADATA_VIS_PUBLIC);
```

**Pros**: Survives restarts, queryable
**Cons**: LMDB writes on every presence change

#### Approach C: Hybrid (Periodic Persistence)

Track in memory, persist periodically:

```c
/* Every 5 minutes, persist presence history to LMDB */
void presence_persist_timer(void) {
  for_each_account_presence(pres) {
    if (pres->dirty) {
      metadata_account_set(pres->account, MD_LAST_PRESENT, ...);
      pres->dirty = 0;
    }
  }
}
```

**Recommendation**: Approach C (Hybrid) for balance of accuracy and performance

**Exposure to Clients**:

1. **WHOIS Extension**:
   ```
   :server 317 mynick Rubin 3600 1705312200 :seconds idle, signon time
   :server 320 mynick Rubin :Last present: 2024-01-15 10:30:00 UTC
   ```

2. **METADATA Key**:
   ```
   METADATA Rubin $last_present * :1705312200
   ```

3. **NickServ INFO**:
   ```
   /msg NickServ INFO Rubin
   -NickServ- Rubin is currently AWAY
   -NickServ- Last seen present: 2 hours ago
   ```

**Privacy Considerations**:

- Should last-present be public by default?
- Consider user setting to hide presence history
- Respect "invisible" mode (+i) for presence info

**Effort**: 8-12 hours for basic implementation, 12-16 hours with persistence

---

### 5. Presence-Based Notifications

**Question**: How should services (like MemoServ) use presence information?

**Current MemoServ Behavior**:
- Delivers memos when user logs in
- No awareness of multi-connection or away state

**Enhanced Behavior with Presence Awareness**:

| Scenario | Current Behavior | Enhanced Behavior |
|----------|------------------|-------------------|
| User has 3 connections, one present | Delivers memo to all | Delivers only to present connection |
| User is AWAY * on all connections | Delivers on login | Queues until present, or delivers after timeout |
| User just went away | Delivers immediately | May queue for "soon to return" cases |

**Implementation**:

```c
/* In memoserv.c */
int memoserv_should_deliver(struct userNode *user) {
  /* Check aggregated presence */
  int state = presence_get_effective(user, NULL);

  switch (state) {
    case PRESENCE_PRESENT:
      return 1;  /* Deliver now */
    case PRESENCE_AWAY:
      return 1;  /* Deliver - user set explicit away */
    case PRESENCE_AWAY_STAR:
      return 0;  /* Queue - user's connection is hidden */
    default:
      return 1;
  }
}

/* Find best connection for delivery */
struct Client *memoserv_best_connection(const char *account) {
  struct AccountConnection *conn;
  struct Client *best = NULL;

  for (conn = account_conn_list(account); conn; conn = conn->next) {
    /* Prefer present connections over away */
    if (conn->away_state == 0) {
      return conn->client;  /* Present - deliver here */
    }
    if (!best && conn->away_state != 2) {
      best = conn->client;  /* Away but not away-star */
    }
  }

  return best;
}
```

**Effort**: 8-12 hours

---

### 6. Presence Federation (Multi-Network)

**Question**: Could presence be shared across linked networks?

**Scenario**: AfterNET links with another IRC network via a bridge

**Challenges**:

1. **Account namespace conflicts**: "Rubin" on AfterNET ≠ "Rubin" on OtherNet
2. **Trust**: Should foreign network's presence claims be trusted?
3. **Protocol differences**: Other network may not support presence aggregation

**Possible Approach**:

```
Network A (AfterNET)      Bridge Bot        Network B
      │                      │                  │
      ├────AWAY P10─────────▶│                  │
      │                      ├──AWAY (IRC)──────▶
      │                      │                  │
      │◀─────────────────────┤◀──AWAY (IRC)─────│
```

Bridge bot translates presence between networks:
- Maps accounts across networks (if identity linked)
- Propagates away state bidirectionally
- Handles format differences

**Recommendation**: Out of scope for initial implementation, document as future possibility

**Effort**: 24-40 hours (if implemented)

---

### 7. Presence Webhooks / Event System

**Question**: Could external systems subscribe to presence changes?

**Use Cases**:

| Subscriber | Use Case |
|------------|----------|
| Discord bridge | Sync presence to Discord status |
| Monitoring | Alert when critical users go offline |
| Analytics | Track network activity |
| Bots | React to user presence changes |

**Implementation Approach**:

1. **Internal Event System**:
   ```c
   /* Presence event callback */
   typedef void (*presence_callback_t)(const char *account,
                                       int old_state, int new_state,
                                       const char *message);

   void presence_add_listener(presence_callback_t cb);
   void presence_remove_listener(presence_callback_t cb);

   /* When presence changes */
   void presence_notify_listeners(const char *account, ...) {
     for (listener in listeners) {
       listener(account, old_state, new_state, message);
     }
   }
   ```

2. **Webhook Delivery** (via X3 or external service):
   ```json
   POST /webhook/presence
   {
     "account": "Rubin",
     "old_state": "present",
     "new_state": "away",
     "message": "BRB",
     "timestamp": "2024-01-15T10:30:00Z",
     "connections": 2
   }
   ```

3. **Internal Pub/Sub** (for bots on same network):
   ```
   New capability: presence-subscribe

   Client: CAP REQ presence-subscribe
   Client: PRESENCE SUBSCRIBE Rubin
   Server: PRESENCE Rubin AWAY :BRB
   ```

**Recommendation**: Add internal event system first (hooks), webhooks later

**Effort**: 12-16 hours for internal events, 16-24 hours for webhooks

---

### Summary of Future Considerations

| # | Consideration | Priority | Effort | Dependencies |
|---|---------------|----------|--------|--------------|
| 1 | X3 Integration | Medium | 16-24h | Core presence aggregation |
| 2 | Presence API | Medium | 8-12h | Core presence aggregation |
| 3 | Mobile Awareness | Low | 12-16h | Device-type capability |
| 4 | Presence History | Medium | 12-16h | Core presence aggregation |
| 5 | Presence Notifications | Medium | 8-12h | X3 Integration |
| 6 | Federation | Low | 24-40h | Bridge protocol |
| 7 | Webhooks | Low | 16-24h | Internal event system |

**Recommended Order**: 2 → 4 → 1 → 5 → 3 → 7 → 6

---

## References

- [IRCv3 pre-away specification](https://ircv3.net/specs/extensions/pre-away)
- [IRCv3 away-notify specification](https://ircv3.net/specs/extensions/away-notify)
- Nefarious m_away.c - Current implementation
- Nefarious s_user.c - User registration and exit
