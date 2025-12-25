# Pre-away Presence Aggregation Implementation Plan

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

1. **X3 integration**: X3 could track account presence across the network
2. **Presence API**: Expose aggregated presence via METADATA or new command
3. **Mobile awareness**: Different presence priorities for mobile vs desktop connections
4. **Presence history**: Track when user was last present

---

## References

- [IRCv3 pre-away specification](https://ircv3.net/specs/extensions/pre-away)
- [IRCv3 away-notify specification](https://ircv3.net/specs/extensions/away-notify)
- Nefarious m_away.c - Current implementation
- Nefarious s_user.c - User registration and exit
