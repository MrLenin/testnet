# Chathistory Access Control Investigation

## Problem Statement

Users raised concerns about chathistory access control:

1. **New members seeing pre-join history**: Someone joins a channel and sees conversations from before they were there. This breaks trust - e.g., #operations discussing whether to make X an ircop, then X joins and sees who opposed them.

2. **Kick gap problem**: User gets kicked, rejoins later, shouldn't see messages from while they were gone. "First join" tracking doesn't handle this.

## Current Nefarious Implementation

### Access Control (`m_chathistory.c:798-844`)

Current checks:
- **Channel membership**: If user IS on channel → always allowed
- **Non-member access**: Controlled by `FEAT_CHATHISTORY_MEMBERSHIP_ONLY` (default: TRUE)
  - If enabled: non-members denied
  - If disabled: check +s/+p modes and ban list
- **PM history**: Both parties must be participants

### What's Stored

Events stored in LMDB (history.c):
- PRIVMSG, NOTICE, TAGMSG
- JOIN, PART, KICK, QUIT
- TOPIC, MODE changes

**Key format**: `target\0timestamp\0msgid`

### Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `FEAT_CHATHISTORY_MEMBERSHIP_ONLY` | TRUE | Require membership for access |
| `FEAT_CHATHISTORY_RETENTION` | 7 days | How long to keep messages |
| `FEAT_CHATHISTORY_MAX` | 100 | Max messages per request |

### Gap: No Time-Based Access Control

Currently **no mechanism** to:
- Track when users joined/parted
- Filter history based on membership periods
- Handle the "kick gap" scenario

---

## Research: Other Implementations

### IRCv3 Specification

From [IRCv3 chathistory spec](https://ircv3.net/specs/extensions/chathistory):

> "Servers MUST ensure that users cannot obtain history they are not authorised to view."
>
> "Servers MAY wish to disallow clients from querying the history of channels they are not joined to. If they do not, they SHOULD disallow clients from querying channels that they are banned from, or which are private."

The spec **leaves policy decisions to implementations** - doesn't mandate a specific approach.

### Ergo IRC (`query-cutoff` setting)

[Ergo](https://github.com/ergochat/ergo) has the most sophisticated implementation via the `query-cutoff` channel setting:

| Value | Description |
|-------|-------------|
| `none` | No restrictions - all members see all history |
| `registration-time` | Users see history from account registration + grace period |
| `join-time` | Users see history from when they joined the channel |
| `operator-only` | Only channel operators can query history |
| `default` | Use server default |

**Per-channel setting**: `/CS SET #channel query-cutoff join-time`

**Server default**: Configured in `history.restrictions.query-cutoff`

### Matrix/Element

Matrix uses "visibility" settings:
- `shared` - Members see history from when they joined
- `invited` - Members see history from when they were invited
- `world_readable` - Anyone can see all history

### Discord

- **Public channels**: All history visible to members
- **Private channels**: History from join time only
- No option to see pre-join history (except for server admins)

### Slack

- Free tier: Limited history retention
- Paid: Full history, visible from join time by default
- Admin option: "Allow access to messages from before they joined"

---

## Access Control Models

### Model 1: No Restriction (Current for Members)

```
Member joins → sees all stored history
```

**Pros**: Simple, consistent, good for public channels
**Cons**: Trust violation for private discussions

### Model 2: First-Join Time

```
Track: first_join_time per account per channel
Query: WHERE message_time >= first_join_time
```

**Pros**: Simple to implement
**Cons**: Doesn't handle kick/rejoin - user sees gap they shouldn't

### Model 3: Last-Join Time (Ergo's `join-time`)

```
Track: last_join_time per account per channel (reset on kick/ban)
Query: WHERE message_time >= last_join_time
```

**Pros**: Handles kick scenario correctly
**Cons**: Loses legitimate history from previous membership periods

### Model 4: Continuous Membership Periods

```
Track: membership_periods[] per account per channel
  [{join: T1, part: T2}, {join: T3, part: null}]
Query: WHERE message_time IN any_period
```

**Pros**: Preserves legitimate history, handles all scenarios correctly
**Cons**: Complex storage, expensive queries

### Model 5: Access-Level Based

```
Ops: See all history
Regular users: See from last join
```

**Pros**: Simple, ops can moderate effectively
**Cons**: Still has trust issues for regular users

### Model 6: Channel Setting (Ergo approach)

```
/CS SET #channel HISTORY-CUTOFF [none|join-time|operator-only]
```

**Pros**: Flexibility per channel, owner controls policy
**Cons**: Requires user awareness, inconsistent UX across channels

---

## Comparison Matrix

| Model | Kick-Gap Safe | Preserves Old History | Implementation | Query Performance |
|-------|--------------|----------------------|----------------|-------------------|
| No restriction | No | Yes | Trivial | O(1) |
| First-join | No | No | Simple | O(1) |
| Last-join | Yes | No | Simple | O(1) |
| Continuous membership | Yes | Yes | Complex | O(n periods) |
| Access-level | Partial | Yes for ops | Simple | O(1) |
| Channel setting | Configurable | Configurable | Medium | O(1) |

---

## Recommended Approach

### Phase 1: Last-Join Time (Quick Win)

Implement Ergo-style `join-time` cutoff:

1. **Store `last_join_time`** per account per channel in LMDB
   - Key: `join_time\0account\0#channel`
   - Value: Unix timestamp

2. **Update on events**:
   - JOIN → set to current time
   - KICK/BAN → clear (set to 0 or delete)
   - PART → keep (intentional leave preserves history access)

3. **Query filter**:
   ```c
   if (account_join_time > 0 && message_time < account_join_time)
       skip_message();
   ```

4. **ChanServ setting**:
   ```
   /CS SET #channel HISTORY-CUTOFF [none|join-time]
   ```

### Phase 2: Continuous Membership (Future)

For channels that need history preservation across rejoins:

1. Store membership periods in LMDB
2. Query with period overlap check
3. Optional per-channel setting: `HISTORY-CUTOFF continuous`

### Implementation Locations

**Nefarious:**
- `ircd/m_chathistory.c`: Add `get_account_join_time()` check in `check_history_access()`
- `ircd/channel.c`: Store join time on JOIN, clear on KICK
- `ircd/history.c`: Add join_time LMDB database
- `include/ircd_features.h`: Add `FEAT_CHATHISTORY_DEFAULT_CUTOFF`

**X3 (ChanServ):**
- Add `HISTORY-CUTOFF` channel setting
- Store in channel info struct
- Expose via P10 metadata or dedicated token

---

## Storage Overhead

### Last-Join Time

- ~50 bytes per account per channel
- 1000 users × 100 channels = 5MB
- Negligible

### Continuous Membership

- ~100 bytes per period per account per channel
- Grows over time with rejoins
- May need pruning strategy

---

## Edge Cases

| Scenario | Last-Join | Continuous |
|----------|-----------|------------|
| User kicked, rejoins | Sees only post-rejoin ✓ | Sees both periods ✓ |
| User parts voluntarily | Sees from original join | Sees from original join |
| User's account expires, re-registers | Fresh start | Fresh start |
| Channel unregistered, re-registered | Configurable | Configurable |
| Netsplit rejoin | Should NOT reset time | Should NOT create new period |

### Netsplit Handling

Critical: Netsplit rejoins must not reset join time. Detect via:
- Server burst flag
- Existing membership state before "rejoin"

---

## Recommendation

**Implement Phase 1 (Last-Join Time)** with ChanServ setting:

1. Default: `join-time` for new channels (privacy-respecting)
2. Option: `none` for public/logged channels
3. Future: `continuous` for advanced use cases

This matches Ergo's approach, handles Rubin's concerns, and is implementable without major architectural changes.

---

## References

- [IRCv3 chathistory specification](https://ircv3.net/specs/extensions/chathistory)
- [Ergo IRC server](https://github.com/ergochat/ergo)
- [Ergo MANUAL.md](https://github.com/ergochat/ergo/blob/master/docs/MANUAL.md)
- [Event playback discussion (IRCv3 #293)](https://github.com/ircv3/ircv3-specifications/issues/293)
- [IRCv3 2024 spec round-up](https://ircv3.net/2024/11/13/spec-round-up)
