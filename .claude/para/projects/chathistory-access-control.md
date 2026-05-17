# Chathistory Access Control Implementation Plan

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Problem Statement](#problem-statement)
- [Design Principles](#design-principles)
- [New Modes](#new-modes)
  - [Channel Mode +H](#channel-mode-h-public-history)
  - [Channel Mode +P](#channel-mode-p-no-storage)
  - [User Mode +h](#user-mode-h-no-history)
- [Access Control Modes](#access-control-modes)
  - [HISTORY-ACCESS Setting](#chanserv-history-access-setting)
  - [Query Without Current Membership](#query-without-current-membership)
  - [Ops Override](#ops-override)
- [Capacity Limits](#capacity-limits)
  - [Global Defaults](#global-defaults-feature-flags)
  - [Per-Channel Limit Overrides](#per-channel-overrides-opserv) (OpServ)
  - [Per-Channel Quota Override](#per-channel-quota-override-chanserv) (ChanServ)
  - [Per-User Quota Override](#per-user-quota-override-chanserv) (ChanServ)
  - [Anti-Flooding Protection](#anti-flooding-protection)
- [Implementation Phases](#implementation-phases)
  - [Phase 1: Kick-Gap Mode](#phase-1-kick-gap-mode-default)
  - [Phase 2: Membership Mode + Refinements](#phase-2-membership-mode--refinements)
  - [Phase 3: PM Simplification](#phase-3-pm-history-simplification)
  - [Phase 4: PM Access Control](#phase-4-pm-history-access-control)
  - [Phase 5: HistServ Integration](#phase-5-histserv-integration)
- [Feature Flags](#feature-flags-summary)
- [Implementation Order](#implementation-order)
- [Edge Cases](#edge-cases)
- [Testing Requirements](#testing-requirements)
- [Comparison Summary](#comparison-summary)
- [Future Work](#future-work)
  - [GDPR Message Deletion](#future-gdpr-message-deletion)
  - [Permanent Tenure Tracking](#future-permanent-tenure-tracking)
- [References](#references)

---

## Overview

This plan unifies two related improvements under a common **account-based access control** philosophy:

1. **Channel History Access Control** - Prevent users from seeing history from before they were members
2. **PM History Simplification** - Replace complex consent modes with account-based storage

Both share the principle: **Authenticated accounts are the unit of identity and access control.**

---

## Requirements

### Must Have

1. **Bounded storage** - Access control metadata must not grow beyond retention period
2. **Bounded history** - Per-channel message limits for high-traffic channels (see [Capacity Limits](#capacity-limits))
3. **Pre-join filtering** - Users cannot see history from before they joined
4. **Kick-gap filtering** - Users cannot see history during periods they were kicked
5. **Channel opt-out mode** - Channel mode `+H` disables chathistory for that channel
6. **User opt-out mode** - User mode `+h` prevents user's messages from being stored

### Should Have

6. **Ops override** - ChanServ access 200+ can see full history for moderation
7. **Secret channel default** - `+s`/`+p` channels default to `+H` (no history)
8. **Per-channel retention** - ChanServ setting to reduce retention (cannot exceed global)

### Could Have

9. **Rate limiting** - Prevent history scraping via CHATHISTORY queries
10. **Registered-only option** - Feature flag to only store history for registered channels
11. **GDPR deletion** - Allow users to request deletion of their stored messages
12. **Permanent tenure tracking** - Preserve first_join_time beyond retention for "founding member" features

---

## Problem Statement

### Channel History Trust Violation

Users raised concerns about chathistory access:

1. **Pre-join history exposure**: New members see conversations from before they joined. Example: #operations discussing whether to make X an ircop, then X joins and sees who opposed them.

2. **Kick-gap problem**: User gets kicked, rejoins later, sees messages from when they were gone. "First join" tracking doesn't handle this.

### PM Consent Complexity

The current 3-mode consent system (GLOBAL/SINGLE/MULTI) is:
- Confusing to users
- Complex to implement
- Provides false sense of privacy control
- Inconsistent with channel history (which has no consent requirement)

---

## Design Principles

| Principle | Application |
|-----------|-------------|
| **Account-based identity** | History keyed to accounts, not nicks/connections |
| **Simple opt-out** | One boolean, not multiple modes |
| **Membership-aware** | Filter history based on membership periods |
| **Configurable per-channel** | Channel owners control access policy |
| **Preserve legitimate access** | Multi-session users see their own history |

---

## New Modes

### Channel Mode: `+H` (Public History)

Makes channel history fully public - bypasses all access control filtering.

```
MODE #channel +H      <- History is public, no filtering
MODE #channel -H      <- History access-controlled (default)
```

**Behavior:**
- `+H` channels: Anyone can query full history (no pre-join/kick-gap filtering)
- Without `+H`: History filtered by user's membership (default, protected)
- Messages are stored regardless of `+H` - the mode only affects *access*

**Use cases for `+H`:**
- Help channels where new users should see recent Q&A
- Public archive channels (logs, announcements)
- Community channels that want open access

**Default protection:**
- All channels start without `+H` (access-controlled)
- Secret/private channels (`+s`/`+p`) work like any other channel - access-controlled by default
- Channels that want public history must explicitly set `+H`

### Channel Mode: `+P` (No Storage)

Disables chathistory storage for the channel entirely.

```
MODE #channel +P      <- No messages stored (Private)
MODE #channel -P      <- Resume storage
```

**Behavior:**
- Messages to `+P` channels are not stored in LMDB
- CHATHISTORY queries return empty/error
- Existing history (from before `+P`) remains accessible until it expires

**Use cases for `+P`:**
- Sensitive channels where no logs should exist
- Temporary channels
- Channels with strict privacy requirements

**Default for secret/private channels:**
- Feature flag `FEAT_CHATHISTORY_SECRET_NO_STORAGE` (default OFF)
- When ON: `+s` and `+p` channels auto-set `+P` (no storage)
- Channels can override: `MODE #secret-channel -P` to enable storage
- When OFF: Secret channels get access-controlled history like any other channel

### User Mode: `+h` (No Storage)

Prevents the user's messages from being stored anywhere (analogous to `+P` for channels).

```
MODE yournick +h      <- Your messages not stored
MODE yournick -h      <- Resume storage
```

**Behavior:**
- Messages FROM this user are not stored (channels or PMs)
- Messages TO this user in PMs are still stored (sender's choice)
- User can still query history (they just won't appear in it)

**Use case:** Privacy-conscious users who don't want their messages logged.

### Mode Summary

| Mode | Type | Storage | Access Control |
|------|------|---------|----------------|
| `+H` | Channel | Normal | **Bypassed** (public) |
| `+P` | Channel | **Disabled** | N/A (nothing to access) |
| `+h` | User | **Disabled** (user's msgs) | N/A |
| (none) | Channel | Normal | **Enforced** (default) |

**Key distinction:**
- `+H` affects **who can see** stored history (everyone)
- `+P` and `+h` affect **whether messages are stored** (they're not)

---

## Access Control Modes

### ChanServ HISTORY-ACCESS Setting

```
/CS SET #channel HISTORY-ACCESS [none|kick-gap|membership]
```

| Value | Voluntary Part | Kicked | Pre-join |
|-------|---------------|--------|----------|
| `none` | See gap | See gap | See all |
| `kick-gap` | **See gap** | Can't see | Can't see |
| `membership` | Can't see | Can't see | Can't see |

**Default:** `kick-gap` (blocks trust violations while preserving convenience for voluntary parts).

**Rationale:**
- `kick-gap` solves the trust violation (kicked users can't spy on what happened while gone)
- But allows legitimate "I'll be back" scenarios (voluntary part, return later, see what you missed)
- `membership` available for privacy-sensitive channels that want strict presence-only access

### Query Without Current Membership

With access control filtering in place, the "must be joined" requirement becomes unnecessary.

**Old (strict):**
```
Can query? -> Must be joined right now
```

**New (relaxed):**
```
Can query? -> Must have membership history (first_join_time exists)
What can you see? -> Filtered by your access mode
```

| Scenario | Query Allowed? | What They See |
|----------|----------------|---------------|
| Currently joined | Yes | Filtered by access mode |
| Parted voluntarily | Yes | Their membership periods |
| Kicked, not rejoined | Yes | Up to kick time |
| Never been member | No | Nothing |
| Banned, never joined | No | Nothing |

**Feature flag:** `FEAT_CHATHISTORY_REQUIRE_JOINED`
- `OFF` (default): Can query channels with membership history
- `ON`: Must be currently joined (legacy strict mode)

This enables the UX: part a channel, later realize you need to check something, still can query your history.

### Ops Override

ChanServ access level 200+ (Op) can bypass access control for moderation:

```
CHATHISTORY LATEST #channel * 100          <- Normal, filtered by membership
CHATHISTORY LATEST #channel * 100 :full    <- Ops only, unfiltered
```

Or via ChanServ:
```
/CS HISTORY #channel 100                   <- Returns full history for ops
```

---

## Capacity Limits

High-traffic channels can accumulate large amounts of history. Capacity limits prevent unbounded growth and ensure fair resource usage.

**Design principle:** Capacity limits are admin-controlled, not channel-owner controlled. Channel owners can't properly account for storage costs, and giving them control could lead to abuse or misconfiguration.

### Storage Model Assumption

The current Nefarious LMDB implementation uses **per-channel storage**:
```
Key:   history\0<#channel>\0<msgid>
Value: {timestamp, sender_account, message, ...}
```

This makes per-channel limits straightforward (count entries with channel prefix). Per-user quotas require a secondary index or counter:
```
Key:   history_count\0<#channel>\0<account>
Value: <message_count:4>
```

Alternative approaches:
- **Per-user storage with channel index** - Natural user quotas, but channel limits need aggregation
- **Per-channel files with rotation** - File size limits, breakpoints at nick boundaries, simpler GC
- **Time-bucketed files** - One file per channel per hour/day, natural retention expiry

The per-user quota approach described below works with any storage model - it just needs message counts tracked per-user-per-channel.

### Global Defaults (Feature Flags)

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `FEAT_CHATHISTORY_MAX_MESSAGES` | int | 50000 | Max messages per channel |
| `FEAT_CHATHISTORY_MAX_MESSAGES_PM` | int | 10000 | Max messages per PM conversation |
| `FEAT_CHATHISTORY_USER_QUOTA_PCT` | int | 10 | Max % of channel limit per user (anti-flood) |

**Example:** With defaults, a channel stores up to 50,000 messages. No single user can occupy more than 5,000 of those (10%).

### Per-Channel Overrides (OpServ)

Network admins can adjust limits for specific channels:

```
/MSG O3 HISTORYLIMIT #channel              <- Show current limit
/MSG O3 HISTORYLIMIT #channel 100000       <- Set to 100k messages
/MSG O3 HISTORYLIMIT #channel DEFAULT      <- Reset to global default
```

**Use cases:**
- High-traffic help channels: Increase limit
- Channels under flooding attack: Temporarily reduce limit
- Archive channels: Increase limit for long-term storage

Stored in X3's channel metadata, synced to Nefarious via MD.

### Per-Channel Quota Override (ChanServ)

Channel admins can adjust the per-user quota for their channel:

```
/CS SET #channel HISTORY-QUOTA [0-100|DEFAULT]
```

| Value | Behavior |
|-------|----------|
| `0` | Disable per-user quota (pure FIFO, vulnerable to flooding) |
| `1-100` | Per-user quota as % of channel limit |
| `DEFAULT` | Use global `FEAT_CHATHISTORY_USER_QUOTA_PCT` |

**Use cases:**
- Bot channel with single poster: Set to 100% (no quota needed)
- Channel with known high-volume user: Increase from 10% to 25%
- Extra flood protection: Reduce to 5%

**Note:** This only affects how the channel's capacity is distributed among users - the total channel limit is still admin-controlled.

### Per-User Quota Override (ChanServ)

Channel admins can override the quota for specific users in their channel:

```
/CS SET #channel HISTORY-USERQUOTA *account [0-100|DEFAULT]
```

| Value | Behavior |
|-------|----------|
| `0` | User's messages not subject to quota (can fill channel) |
| `1-100` | Custom quota % for this user |
| `DEFAULT` | Use channel's HISTORY-QUOTA setting |

**Use cases:**
- Channel bot: Set to 0 or 100% (exempt from quota)
- Trusted high-volume user: Increase to 25%
- Known spammer rejoined: Reduce to 1%

**Priority order:**
1. Per-user override (if set)
2. Channel quota setting (if set)
3. Global `FEAT_CHATHISTORY_USER_QUOTA_PCT`

### Anti-Flooding Protection

**Problem:** Simple FIFO eviction lets a flooder intentionally fill the buffer to push out older messages from other users.

**Solution:** Per-user quota within the channel limit.

```
Channel limit: 50,000 messages
User quota: 10% = 5,000 messages per user

Flooder sends 10,000 messages:
- First 5,000 stored normally
- Next 5,000 evict flooder's own oldest messages (FIFO within their quota)
- Other users' history preserved
```

#### Eviction Logic

```c
void store_message(const char *channel, const char *account, const char *msg) {
    int channel_count = get_channel_message_count(channel);
    int user_count = get_user_message_count(channel, account);
    int channel_limit = get_channel_limit(channel);
    int user_limit = channel_limit * FEAT_CHATHISTORY_USER_QUOTA_PCT / 100;

    // Check user quota first
    if (user_count >= user_limit) {
        evict_oldest_from_user(channel, account);  // Evict own oldest
    }
    // Then check channel limit (evicts globally oldest)
    else if (channel_count >= channel_limit) {
        evict_oldest_from_channel(channel);
    }

    store_message_impl(channel, account, msg);
}
```

#### Edge Cases

| Scenario | Behavior |
|----------|----------|
| User hits quota | Evicts their own oldest messages |
| Channel hits limit, no user over quota | Evicts globally oldest message |
| Flooder tries to evict others | Can only evict own messages |
| Legitimate high-volume user | Admin can increase channel limit |
| Bot flooding detected | Ops can kick/ban + optionally purge bot's history |

#### Optional: Flood Detection Alert

```c
// Alert ops when a user is rapidly hitting their quota
if (user_eviction_count_last_minute > FLOOD_THRESHOLD) {
    send_to_opers("HISTORY FLOOD: %s in %s evicting %d msgs/min",
                  account, channel, user_eviction_count_last_minute);
}
```

Feature flag: `FEAT_CHATHISTORY_FLOOD_ALERT` (default ON), `FEAT_CHATHISTORY_FLOOD_THRESHOLD` (default 100 msgs/min).

---

## Implementation Phases

### Phase 1: Kick-Gap Mode (Default)

**Goal:** Implement the simpler kick-gap tracking as the default access control mode.

#### Data Model

Store per account per channel:
```
Key:   membership\0<account>\0<#channel>
Value: {
  first_join_time: timestamp,
  kick_gaps: [(kick_time, rejoin_time), ...]
}
```

#### Event Handling

| Event | Action |
|-------|--------|
| JOIN | Set `first_join_time` if not set; close any open kick-gap |
| KICK | Open new kick-gap: `(now, null)` |
| PART | No action (voluntary - no gap created) |
| Netsplit rejoin | Skip (detect via burst flag) |

#### Access Check

```c
int check_kick_gap_access(const char *account, const char *channel,
                          time_t msg_time) {
    membership_t *m = get_membership(account, channel);
    if (!m) return 0;  // Never been member

    // Pre-join check
    if (msg_time < m->first_join_time)
        return 0;

    // Kick-gap check
    for (int i = 0; i < m->num_gaps; i++) {
        if (msg_time >= m->gaps[i].kick_time &&
            (m->gaps[i].rejoin_time == 0 ||
             msg_time < m->gaps[i].rejoin_time))
            return 0;  // Within a kick-gap
    }

    return 1;
}
```

#### Storage

- Gaps pruned when older than retention period
- Bounded: O(kick events within retention) per user per channel
- Typical user: 0-3 gaps, ~50 bytes per membership record

#### Files to Modify

**Nefarious:**

| File | Changes |
|------|---------|
| `ircd/m_chathistory.c` | Add kick-gap check in `check_history_access()` |
| `ircd/m_join.c` | Record first_join_time, close kick-gaps |
| `ircd/m_kick.c` | Open new kick-gap |
| `ircd/m_mode.c` | Add `+H` (public), `+P` (no storage) channel modes, `+h` user mode |
| `ircd/history.c` | Add membership LMDB database |
| `include/ircd_features.h` | Add feature flags |

**X3:**

| File | Changes |
|------|---------|
| `src/chanserv.c` | Add `HISTORY-ACCESS` channel setting |

---

### Phase 2: Membership Mode + Refinements

**Goal:** Add strict membership mode (hourly presence bitmap) and refinements.

#### Presence Bitmap (for `membership` mode only)

Store hourly presence bits per account per channel:

```
Key:   presence\0<account>\0<#channel>
Value: <bitmap>[retention_hours bits] + <epoch_hour:4>
```

**Example for 7-day retention:**
```
168 bits = 21 bytes bitmap + 4 bytes epoch = 25 bytes per user per channel
```

#### Bitmap Operations

```c
#define BUCKET_HOURS 1
#define RETENTION_HOURS (CHATHISTORY_RETENTION_DAYS * 24)
#define BITMAP_SIZE ((RETENTION_HOURS + 7) / 8)

void mark_presence(const char *account, const char *channel) {
    int bucket = (CurrentTime / 3600) % RETENTION_HOURS;
    bitmap[bucket / 8] |= (1 << (bucket % 8));
}

int was_present(const char *account, const char *channel, time_t msg_time) {
    int bucket = (msg_time / 3600) % RETENTION_HOURS;
    return (bitmap[bucket / 8] >> (bucket % 8)) & 1;
}
```

#### Event Handling (Membership Mode)

| Event | Action |
|-------|--------|
| JOIN | Mark current bucket |
| Periodic (every 15 min) | If in channel, mark current bucket |
| KICK | Stop marking (bits naturally decay) |
| PART | Stop marking |

**Key insight:** No explicit "clear" needed. Old buckets naturally rotate out.

#### Ban Tracking

For "banned AND not present" filtering, track ban periods separately:

```
Key:   banned\0<account>\0<#channel>
Value: <bitmap>[retention_hours bits]
```

#### Additional Refinements

**Per-Channel Retention:**
```
/CS SET #channel HISTORY-RETENTION 3d    <- Keep only 3 days (max is global)
/CS SET #channel HISTORY-RETENTION 0     <- Use global default
```

#### Files to Modify (Phase 2)

**Nefarious:**

| File | Changes |
|------|---------|
| `ircd/history.c` | Add capacity limit checks, per-user quota tracking |
| `include/ircd_features.h` | Add capacity limit feature flags |

**X3:**

| File | Changes |
|------|---------|
| `src/opserv.c` | Add `HISTORYLIMIT` command |
| `src/chanserv.c` | Add `HISTORY-QUOTA` setting, store per-channel overrides |

---

### Phase 3: PM History Simplification

**Goal:** Replace 3-mode consent with simple account-based storage + opt-out.

#### New Storage Rule

```c
int should_store_pm(struct Client *from, struct Client *to) {
    // Both must be authenticated
    if (!IsAccount(from) || !IsAccount(to))
        return 0;

    // Check user mode +h
    if (IsNoHistory(from))
        return 0;

    // Check opt-out metadata (either party can opt out)
    if (has_metadata_optout(from, "chathistory.pm.optout") ||
        has_metadata_optout(to, "chathistory.pm.optout"))
        return 0;

    return 1;
}
```

#### What to Remove

| Component | Action |
|-----------|--------|
| `FEAT_CHATHISTORY_PRIVATE_CONSENT` | Remove (no modes) |
| `FEAT_CHATHISTORY_ADVERTISE_PM` | Simplify to just `pm` presence |
| `FEAT_CHATHISTORY_PM_NOTICE` | Remove (no consent notices) |
| `get_pm_consent_preference()` | Remove |
| `check_pm_consent()` | Replace with `should_store_pm()` |

#### What to Keep

| Component | Purpose |
|-----------|---------|
| `FEAT_CHATHISTORY_PRIVATE` | Master switch for operators |
| `chathistory.pm.optout` metadata | Per-account opt-out |

#### CAP Advertisement

Change from:
```
draft/chathistory=limit=100,retention=7d,pm=global
```

To:
```
draft/chathistory=limit=100,retention=7d,pm
```

#### Files to Modify

| File | Changes |
|------|---------|
| `ircd/ircd_relay.c` | Replace consent logic with account + opt-out |
| `ircd/m_cap.c` | Simplify pm advertisement |
| `ircd/s_user.c` | Remove consent notices |
| `ircd/ircd_features.c` | Remove consent feature flags |

---

### Phase 4: PM History Access Control

**Goal:** Simplify PM query authorization.

#### New Access Rule

```c
int can_access_pm_history(struct Client *cptr, const char *target_account) {
    // Must be authenticated
    if (!IsAccount(cptr))
        return 0;

    // Must have been a participant in the conversation
    if (!is_pm_participant(cli_account(cptr), target_account))
        return 0;

    // Opt-out only affects future storage, not past retrieval
    return 1;
}
```

#### Key Difference from Channels

- No "membership period" concept - PM history is forever between two accounts
- Opt-out prevents future storage but doesn't revoke access to existing history
- Access check is simpler: are you one of the two participants?

---

### Phase 5: HistServ Integration

**Goal:** Ensure X3's HistServ respects the same access control rules.

#### Current HistServ Commands

```
/MSG HistServ HISTORY #channel [count]
/MSG HistServ HISTORY nick [count]
```

#### Access Control Options

**Option A: Query through Nefarious (Preferred)**

HistServ sends CHATHISTORY command to Nefarious, which applies access control:
- No duplicate logic in X3
- Single source of truth for access rules
- HistServ just formats the response

**Option B: Replicate logic in X3**

HistServ queries LMDB directly with its own access checks:
- Requires syncing membership data to X3
- Duplicate implementation (maintenance burden)
- Risk of divergence

**Recommendation:** Option A - HistServ should proxy through Nefarious's CHATHISTORY.

#### HistServ Changes

| Current | New |
|---------|-----|
| Direct LMDB query | Send CHATHISTORY to IRCd, format response |
| No access control | IRCd applies filtering |
| Own permission check | Defer to IRCd |

#### Command Updates

```
/MSG HistServ HISTORY #channel [count]     <- Filtered by user's access
/MSG HistServ HISTORY #channel [count] FULL <- Ops only, unfiltered
```

The `FULL` flag maps to the `:full` modifier in CHATHISTORY.

#### Files to Modify

**X3:**

| File | Changes |
|------|---------|
| `src/histserv.c` | Replace direct LMDB with CHATHISTORY proxy |
| `src/proto-p10.c` | Handle CHATHISTORY response parsing |

---

## Feature Flags Summary

### Access Control Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `FEAT_CHATHISTORY_ACCESS_CONTROL` | bool | ON | Enable access filtering |
| `FEAT_CHATHISTORY_DEFAULT_ACCESS` | enum | kick-gap | Default for new channels |
| `FEAT_CHATHISTORY_REQUIRE_JOINED` | bool | OFF | Must be joined to query |
| `FEAT_CHATHISTORY_SECRET_NO_STORAGE` | bool | OFF | +s/+p channels auto-set +P |
| `FEAT_CHATHISTORY_OPS_OVERRIDE` | bool | ON | Allow ops to see full history |
| `FEAT_CHATHISTORY_OPS_LEVEL` | int | 200 | Minimum ChanServ level for override |
| `FEAT_CHATHISTORY_GDPR_DELETE` | bool | ON | Allow user-initiated deletion |

### Capacity Limit Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `FEAT_CHATHISTORY_MAX_MESSAGES` | int | 50000 | Max messages per channel |
| `FEAT_CHATHISTORY_MAX_MESSAGES_PM` | int | 10000 | Max messages per PM conversation |
| `FEAT_CHATHISTORY_USER_QUOTA_PCT` | int | 10 | Max % of channel limit per user |
| `FEAT_CHATHISTORY_FLOOD_ALERT` | bool | ON | Alert ops on rapid eviction |
| `FEAT_CHATHISTORY_FLOOD_THRESHOLD` | int | 100 | Evictions/min to trigger alert |

---

## Implementation Order

### Track A: Channel History (Phases 1-2)

```
Phase 1: Kick-Gap Mode + Modes
|-- Add +H channel mode (public history)
|-- Add +P channel mode (no storage)
|-- Add +h user mode (no storage)
|-- Store first_join_time per account per channel
|-- Store kick_gaps[] array per account per channel
|-- Track KICK events to create gaps
|-- Track JOIN events to close gaps
|-- Filter history queries by first_join + kick_gaps
|-- Relax query requirement (membership history, not current join)
|-- Add ChanServ HISTORY-ACCESS setting (none/kick-gap)
+-- Tests for kick-gap filtering + query without membership

Phase 2: Membership Mode + Refinements
|-- Add presence bitmap for membership mode
|-- Implement periodic presence marking
|-- Add `membership` option to HISTORY-ACCESS
|-- Add ops override with :full flag
|-- Add per-channel retention setting
|-- Add ban bitmap tracking
|-- Add capacity limits (global feature flags)
|-- Add per-user quota tracking (anti-flood)
|-- Add OpServ HISTORYLIMIT command for per-channel overrides
+-- Add flood alert to opers
```

### Track B: PM Simplification (Phases 3-4)

```
Phase 3: Remove Consent Modes
|-- Replace check_pm_consent() with should_store_pm()
|-- Remove feature flags and notices
|-- Simplify CAP advertisement
+-- Update tests

Phase 4: PM Access Control
|-- Simplify PM query authorization
|-- Ensure account-based access
+-- Test opt-out behavior
```

### Track C: X3 Integration (Phase 5)

```
Phase 5: HistServ Integration
|-- Replace direct LMDB queries with CHATHISTORY proxy
|-- Add FULL flag for ops override
|-- Handle CHATHISTORY response parsing
+-- Tests for filtered vs unfiltered access
```

Track A and B can proceed in parallel. Track C depends on Track A (Phase 1) being complete.

---

## Edge Cases

### Channel History

| Scenario | `kick-gap` (default) | `membership` (strict) |
|----------|---------------------|----------------------|
| User kicked, rejoins | Can't see kick-gap | Can't see kick-gap |
| User parts voluntarily | **Can see gap** | Can't see gap |
| User banned but in channel | Can see (still present) | Can see (still present) |
| User banned AND kicked | Can't see gap | Can't see gap |
| Pre-join history | Can't see | Can't see |
| Netsplit rejoin | No gap created | Periodic marking continues |
| Channel +H set | Full history visible | Full history visible |
| Channel +P set | No storage | No storage |
| Secret channel (+s/+p) | Access-controlled (or +P if flag) | Access-controlled (or +P if flag) |
| User +h set | Messages not stored | Messages not stored |
| Ops query with :full | Bypasses all checks | Bypasses all checks |
| Query after parting | Can query, filtered | Can query, filtered |
| Query after kick | Can query, up to kick | Can query, up to kick |
| Never been member | Query denied | Query denied |

### PM History

| Scenario | Behavior |
|----------|----------|
| Both authenticated | Store, both can retrieve |
| One unauthenticated | Don't store |
| Sender has +h mode | Don't store |
| Sender opts out via metadata | Don't store future PMs |
| Recipient opts out | Don't store future PMs |
| Opt out after conversation | Existing history still accessible |
| Account deleted | Trigger GDPR deletion cascade |

### Storage

| Scenario | `kick-gap` mode | `membership` mode |
|----------|----------------|-------------------|
| Many kick/rejoins | Array grows (pruned by retention) | Fixed bitmap size |
| Message at boundary | Exact timestamps | +/-1 hour precision |
| Very long session | No overhead | Periodic marking |
| Server restart | Gaps persisted in LMDB | Bitmap persisted in LMDB |
| Retention changes | Old gaps pruned | Old bits rotate out |

### HistServ

| Scenario | Behavior |
|----------|----------|
| User queries own channel history | Filtered same as CHATHISTORY |
| User queries +H channel | Empty/error |
| Op queries with FULL | Unfiltered access |
| Non-op tries FULL | Denied, falls back to filtered |
| Query PM history | Filtered by participant check |

### Capacity Limits

| Scenario | Behavior |
|----------|----------|
| Channel at limit, new message | Evict globally oldest message |
| User at quota, new message | Evict user's own oldest message |
| Flooder sends 10x their quota | Only evicts own messages, others preserved |
| OpServ increases channel limit | New limit takes effect immediately |
| OpServ resets to DEFAULT | Uses global feature flag value |
| High eviction rate detected | Alert sent to opers (if enabled) |
| Channel under limit, user over quota | Evict user's oldest only |
| Bot floods then gets banned | History preserved, bot can't evict more |
| Channel quota set to 0 | Pure FIFO eviction (no per-user protection) |
| Channel quota set to 100 | Single user can fill entire channel |
| ChanServ HISTORY-QUOTA DEFAULT | Uses global feature flag value |
| Per-user quota override set | Uses user-specific quota instead of channel default |
| Bot with quota 0 | Bot exempt from quota, can fill to channel limit |
| User quota override to DEFAULT | Falls back to channel quota setting |

---

## Testing Requirements

### Channel Mode Tests

```typescript
describe('Channel +H Mode (Public History)', () => {
  it('should bypass access control when +H is set')
  it('should show pre-join history to new members on +H channel')
  it('should show kick-gap history on +H channel')
  it('should restore access control when -H is set')
})

describe('Channel +P Mode (No Storage)', () => {
  it('should not store messages when +P is set')
  it('should return empty for CHATHISTORY on +P channel')
  it('should preserve old history until expiry after +P set')
  it('should resume storage when -P is set')
  it('should auto-set +P on +s channel if SECRET_NO_STORAGE enabled')
  it('should allow -P override on secret channel')
})
```

### User Mode Tests

```typescript
describe('User +h Mode', () => {
  it('should not store channel messages from +h user')
  it('should not store PM messages from +h user')
  it('should still allow +h user to query history')
  it('should store messages TO +h user in PMs')
})
```

### Access Control Mode Tests

```typescript
describe('Channel History Access Control', () => {
  // Common (all modes)
  it('should not show history from before user first joined')
  it('should not show history during kick-gap period')
  it('should handle netsplit without creating gaps')

  // kick-gap mode (default)
  describe('kick-gap mode', () => {
    it('should allow seeing history during voluntary part gap')
    it('should block history during kick-to-rejoin gap')
    it('should track multiple kick-gaps correctly')
  })

  // membership mode (strict)
  describe('membership mode', () => {
    it('should NOT show history during voluntary part gap')
    it('should only show hours with presence marked')
    it('should handle periodic marking correctly')
  })

  // none mode
  describe('none mode', () => {
    it('should show all history regardless of membership')
  })
})
```

### Query Without Membership Tests

```typescript
describe('Query Without Current Membership', () => {
  it('should allow query after voluntary part')
  it('should allow query after kick (sees up to kick time)')
  it('should deny query if never been member')
  it('should deny query if banned before ever joining')
  it('should respect FEAT_CHATHISTORY_REQUIRE_JOINED=ON')
})
```

### Ops Override Tests

```typescript
describe('Ops History Override', () => {
  it('should allow ops to query full history with :full flag')
  it('should deny :full flag to non-ops')
  it('should respect FEAT_CHATHISTORY_OPS_LEVEL threshold')
})
```

### Ban Tracking Tests

```typescript
describe('Ban + Kick Filtering', () => {
  it('should show history when banned but still in channel')
  it('should NOT show history when banned AND kicked')
  it('should show history after unban and rejoin')
})
```

### PM History Tests

```typescript
describe('PM History Simplification', () => {
  it('should store PM between two authenticated users')
  it('should NOT store PM when sender is unauthenticated')
  it('should NOT store PM when recipient is unauthenticated')
  it('should NOT store PM when sender has +h mode')
  it('should respect sender metadata opt-out')
  it('should respect recipient metadata opt-out')
  it('should allow retrieval of history stored before opt-out')
  it('should show simple pm in CAP without mode value')
})
```

### HistServ Tests

```typescript
describe('HistServ Access Control', () => {
  it('should filter history same as CHATHISTORY command')
  it('should not show pre-join history')
  it('should not show kick-gap history')
  it('should allow FULL flag for ops')
  it('should deny FULL flag for non-ops')
  it('should respect +H channel mode')
})
```

### Capacity Limit Tests

```typescript
describe('Channel Capacity Limits', () => {
  it('should evict oldest message when channel limit reached')
  it('should respect per-channel override from OpServ')
  it('should reset to global default with HISTORYLIMIT DEFAULT')
})

describe('Anti-Flooding (User Quota)', () => {
  it('should evict flooder own messages when hitting user quota')
  it('should preserve other users messages when one user floods')
  it('should allow legitimate high-volume user up to channel limit')
  it('should trigger flood alert when eviction rate exceeds threshold')
  it('should respect ChanServ HISTORY-QUOTA channel override')
  it('should disable per-user quota when channel set to 0')
  it('should allow single user to fill channel when quota is 100')
  it('should respect per-user HISTORY-USERQUOTA override')
  it('should exempt bot from quota when user quota set to 0')
  it('should prioritize user override over channel override')
})

describe('PM Capacity Limits', () => {
  it('should evict oldest PM when conversation limit reached')
  it('should track limits per conversation pair, not globally')
})
```

---

## Comparison Summary

| Aspect | Before | After |
|--------|--------|-------|
| Query requirement | Must be joined | Membership history (relaxed) |
| Channel pre-join | All history visible | Blocked (all modes) |
| Channel kick-gap | All history visible | Blocked (all modes) |
| Voluntary part gap | N/A | Allowed (`kick-gap`) or blocked (`membership`) |
| Ban + not present | All history visible | Blocked |
| Public history opt-in | N/A | `+H` mode (bypasses filtering) |
| Storage opt-out | Not possible | `+P` mode (no storage) |
| User opt-out | Not possible | `+h` mode |
| Secret channels | History stored | Access-controlled (or +P if `SECRET_NO_STORAGE` enabled) |
| Ops access | Same as users | Can bypass with `:full` |
| Access control storage | Unbounded | Bounded (kick-gaps or bitmap) |
| Message storage | Unbounded | Bounded (per-channel + per-user quota) |
| Flood protection | None | Per-user quota (flooder evicts own msgs) |
| Capacity control | None | Admin-controlled (feature flags + OpServ) |
| PM consent modes | 3 complex modes | Account-based + opt-out |
| PM feature flags | 4 | 1 (master switch) |
| Default mode | N/A | `kick-gap` |

---

## Future Work

### Future: GDPR Message Deletion

#### User-Initiated Deletion

Allow users to request deletion of their stored messages:

```
/AS GDPR DELETE              <- Delete all my stored messages
/AS GDPR DELETE #channel     <- Delete my messages from specific channel
/AS GDPR DELETE 30d          <- Delete messages older than 30 days
```

#### Implementation Options

| Approach | Pros | Cons |
|----------|------|------|
| **Hard delete** | Complete removal | Breaks conversation context |
| **Pseudonymize** | Preserves context | "[deleted]" may still be identifiable |
| **Tombstone** | Audit trail | Still stores metadata |

#### Recommended: Pseudonymization + Tombstone

```
Before: <alice> I think Bob is wrong about this
After:  <[deleted-user-12345]> [message deleted by user request]
```

- Replace nick/account with opaque ID
- Replace message content with deletion notice
- Preserve timestamp and channel for context
- Log deletion request for audit

#### ChanServ Integration

Channel owners may want to preserve messages for moderation:

```
/CS SET #channel HISTORY-GDPR [allow|deny|delay]
```

| Value | Behavior |
|-------|----------|
| `allow` | User can delete immediately |
| `deny` | User deletion requests denied (legal hold) |
| `delay` | User notified, deletion after 7 days (ops can review) |

#### Account Deletion Cascade

When an account is deleted via AuthServ or Keycloak:
1. Trigger GDPR deletion for all stored messages
2. Clear all membership tracking data
3. Log deletion for compliance

---

### Future: Permanent Tenure Tracking

#### Purpose

Preserve `first_join_time` permanently (beyond retention) for tenure-based features.

#### Benefits

| Feature | Use Case |
|---------|----------|
| Founding member badge | Users who joined in first N days |
| Tenure-based trust | "Member since 2015" context |
| Auto-access grants | ChanServ auto-voice for 1yr+ members |
| $tenure metadata | Expose days-since-first-join |

#### Implementation

Separate LMDB database for permanent tenure:
```
Key:   tenure\0<account>\0<#channel>
Value: <first_join_timestamp:8>
```

Never pruned by retention - only deleted on GDPR request or account deletion.

#### Metadata Exposure

```
/METADATA * GET $tenure:#channel
-> 1825   (days since first join)
```

---

## References

- [IRCv3 chathistory specification](https://ircv3.net/specs/extensions/chathistory)
- [Ergo IRC server](https://github.com/ergochat/ergo) - query-cutoff implementation
- [Investigation: CHATHISTORY_ACCESS_CONTROL_INVESTIGATION.md](../docs/investigations/CHATHISTORY_ACCESS_CONTROL_INVESTIGATION.md)
- [Previous plan: chathistory-pm-simplification.md](./chathistory-pm-simplification.md)
