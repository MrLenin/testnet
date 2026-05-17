# SpamServ Investigation Report

**Date:** 2026-01-19
**Investigator:** Claude Code
**Purpose:** Evaluate SpamServ module for decision: fix, remove, or leave disabled

---

## Executive Summary

SpamServ is a **2004-era anti-spam module** (~3,300 lines) that provides channel-based spam protection. It is currently **disabled by default** and reportedly non-functional. This investigation documents the module's functionality, architecture, bugs, and issues to help decide its fate.

**Recommendation:** Remove from build or archive. The module has architectural issues, no test coverage, and provides functionality that modern IRC networks typically handle differently (channel mode +R, server-side rate limiting, or external bots).

---

## 1. What SpamServ Does

### 1.1 Core Features

| Feature | Description | Detection Method |
|---------|-------------|------------------|
| **Spam Detection** | Repeated identical messages | CRC32 hash comparison |
| **Flood Detection** | Too many messages in time window | Counter + timestamp |
| **Join Flood** | Too many joins in time window | Counter per channel |
| **Advertising Detection** | Messages containing channel names | Regex for #channel patterns |
| **Badword Filtering** | Configurable word blacklist | String matching |
| **Caps Abuse** | Excessive uppercase | Percentage threshold |

### 1.2 Punishment System

Escalating punishments based on `warnlevel`:
1. Warning notice
2. Kick
3. Kickban
4. Short timed ban (15 minutes default)
5. Long timed ban (1 hour default)
6. Kill
7. G-line (network ban)

### 1.3 Commands

```
REGISTER/UNREGISTER  - Channel registration
ADDEXCEPTION/DELEXCEPTION - Whitelist words
ADDBADWORD/DELBADWORD - Blacklist words
ADDTRUST/DELTRUST - Trusted accounts (per-channel or global)
SET <option> - Configure 15+ settings per channel
STATUS - Show stats (opers only)
```

---

## 2. Architecture

### 2.1 Data Structures

```
registered_channels_dict  - Channels registered with SpamServ
connected_users_dict      - All network users (keyed by nick)
killed_users_dict         - Users killed by SpamServ (for escalation)
spamserv_trusted_accounts - Globally trusted accounts
```

### 2.2 Message Flow

```
proto-common.c:529
    └── spamserv_channel_message(channel, user, text)
            │
            ├── Check preconditions (line 2607):
            │   - SpamServ enabled?
            │   - SpamServ in channel?
            │   - Channel registered?
            │   - User tracked?
            │   - User not oper?
            │
            ├── Check trusted accounts
            ├── Check user access level vs exception levels
            │
            ├── to_lower(text)  ← MUTATES ORIGINAL
            │
            ├── Caps scan (if enabled)
            ├── Spam scan (if enabled)
            ├── Flood scan (if enabled)
            ├── Badword scan (if enabled)
            ├── Advertising scan (if enabled)
            │
            └── Apply punishment if violation detected
```

### 2.3 ChanServ Integration

SpamServ hooks into ChanServ lifecycle events:

| Event | SpamServ Action |
|-------|-----------------|
| Channel loses all users | Unregister |
| Channel expires | Unregister |
| Channel manually unregistered | Unregister |
| Channel moved | Follow (if allow_move_merge) or unregister |
| Channel merged | Follow (if allow_move_merge) or unregister |
| Channel suspended | Part channel, set suspend flag |
| Channel unsuspended | Clear suspend flag (but doesn't rejoin!) |

---

## 3. Bugs and Issues Found

### 3.1 Critical Issues

#### Bug #1: Text Mutation (Line 2666)
```c
to_lower(text);
```
**Problem:** Modifies the original message buffer passed from proto-common.c. Any handlers that run after SpamServ receive lowercase text.

**Impact:** Could break other message handlers expecting original case.

#### Bug #2: Silent Failure Conditions (Line 2607)
```c
if(!spamserv || quit_services || !GetUserMode(channel, spamserv) ||
   IsOper(user) || !(cInfo = get_chanInfo(channel->name)) ||
   !(uInfo = get_userInfo(user->nick)))
    return;
```
**Problem:** No logging when any precondition fails. If SpamServ isn't working, there's no indication why.

**Impact:** Impossible to diagnose why protection isn't triggering.

#### Bug #3: No Rejoin After Unsuspend
In `spamserv_cs_suspend()` (lines 324-346):
- Suspend: Parts channel ✓
- Unsuspend: Clears flag but **doesn't rejoin** ✗

**Impact:** Channel loses protection after unsuspend until X3 restart.

#### Bug #4: Dictionary Iterator Invalidation (Line 946)
```c
/* have to restart the loop because next is now invalid.
   FIXME: how could we do this better? */
break;
```
**Problem:** Acknowledged FIXME - inefficient O(n²) cleanup of killed users.

### 3.2 Design Issues

#### Issue #1: Move/Merge Disabled by Default
```c
str = database_get_data(conf_node, KEY_ALLOW_MOVE_MERGE, RECDB_QSTRING);
spamserv_conf.allow_move_merge = str ? enabled_string(str) : 0;
```
**Problem:** If ChanServ moves a channel, SpamServ **unregisters** instead of following.

#### Issue #2: Flag System Needs Rewrite (Line 299)
```c
/* XXX Rewrite the flag system */
if (strlen(info) < 5)
    strcat(info, "s");
```
**Problem:** Acknowledged XXX comment. Flag storage uses a character string with hardcoded positions - fragile and unclear.

#### Issue #3: Exception Level Complexity

Each detection type has its own exception access level:
- `exceptlevel` (general)
- `exceptspamlevel`
- `exceptadvlevel`
- `exceptbadwordlevel`
- `exceptcapslevel`
- `exceptfloodlevel`

**Problem:** 6 different levels to configure correctly. Easy to misconfigure.

#### Issue #4: Memory on Silent Failure

When malloc fails, the code logs an error but continues:
```c
if(!uInfo) {
    log_module(SS_LOG, LOG_ERROR, "Couldn't allocate memory for uInfo");
    return;  // Silent failure
}
```
No user notification, no degraded mode.

### 3.3 Security Issues

#### Issue #1: Stack Overflow via alloca()
Multiple uses of `alloca()` with user-influenced sizes:
- Line 1051: `alloca(cInfo->exceptions->used * sizeof(...))`
- Line 2898: `alloca(size)` for gline mask

#### Issue #2: Potential DoS via Exception/Badword Lists
No limit enforcement on exception/badword list sizes during runtime (only on add command).

---

## 4. Code Quality

### 4.1 Statistics

| Metric | Value |
|--------|-------|
| Total Lines | ~3,300 |
| Functions | ~80 |
| Cyclomatic Complexity | High (deep nesting in message handler) |
| Test Coverage | **0%** (no test files found) |
| TODO/FIXME/XXX Comments | 2 |
| Last Significant Update | Unknown (2004 copyright) |

### 4.2 Code Smells

1. **God Function:** `spamserv_channel_message()` is 330 lines with 6+ levels of nesting
2. **Magic Numbers:** Hardcoded thresholds throughout
3. **Copy-Paste:** Similar patterns repeated for each detection type
4. **Global State:** Heavy use of global dictionaries
5. **No Unit Tests:** All testing would be manual via IRC

---

## 5. Configuration

### 5.1 Default Config (x3.conf)
```conf
"spamserv" {
    // "nick" "SpamServ";  ← DISABLED
    // trigger for spamserv
    // "trigger" "!";      ← DISABLED
    ...
}
```

### 5.2 Key Settings
| Setting | Default | Description |
|---------|---------|-------------|
| nick | (commented out) | Must be set to enable |
| trigger | (commented out) | In-channel command trigger |
| short_ban_duration | 15m | Duration for 's' reaction |
| long_ban_duration | 1h | Duration for 'l' reaction |
| gline_duration | 1h | Duration for network bans |
| allow_move_merge | 0 (disabled) | Follow channel moves |
| strip_mirc_codes | 0 | Strip colors before scanning |

---

## 6. Alternatives

### 6.1 If Spam Protection Is Needed

| Alternative | Pros | Cons |
|-------------|------|------|
| **Channel mode +R** | Built-in, no bot needed | Only blocks unregistered users |
| **IRCd rate limiting** | Server-enforced, reliable | Network-wide, not per-channel |
| **External bot (e.g., Anope's BotServ)** | More features, maintained | Another dependency |
| **Modern spam filter (ML-based)** | Better detection | Complex to implement |

### 6.2 If Keeping SpamServ

Minimum fixes required:
1. Fix text mutation bug
2. Add logging for silent failures
3. Fix unsuspend rejoin
4. Replace alloca() with malloc()
5. Add basic test coverage
6. Enable allow_move_merge by default

Estimated effort: 2-4 days of focused work + testing

---

## 7. Recommendations

### Option A: Remove Entirely (Recommended)

**Justification:**
- AfterNET doesn't use it
- No test coverage = high regression risk
- 20+ year old code with architectural issues
- Modern alternatives exist
- Reduces attack surface

**Steps:**
1. Comment out in Makefile.am
2. Remove init call from main-common.c
3. Keep source for reference (or move to `contrib/`)

### Option B: Disable Compilation

**Justification:**
- Preserves code for future reference
- Prevents accidental enablement
- Zero maintenance burden

**Steps:**
1. Add `--enable-spamserv` configure flag (default off)
2. Wrap code in `#ifdef HAVE_SPAMSERV`

### Option C: Fix and Maintain

**Justification:**
- Some networks may want per-channel spam protection
- Already integrated with ChanServ

**Steps:**
1. Fix all Critical bugs (3-4 days)
2. Add test coverage (2-3 days)
3. Refactor message handler (2-3 days)
4. Document configuration
5. Ongoing maintenance commitment

---

## 8. Decision Matrix

| Factor | Remove | Disable | Fix |
|--------|--------|---------|-----|
| Development effort | Low | Low | High |
| Risk of regression | None | None | Medium |
| Future maintenance | None | None | Ongoing |
| Feature availability | None | None | Full |
| Attack surface | Reduced | Reduced | Same |
| AfterNET need | No | No | No |

---

## Appendix A: File References

| File | Description |
|------|-------------|
| `x3/src/spamserv.c` | Main implementation (~3,300 lines) |
| `x3/src/spamserv.h` | Header with exports |
| `x3/src/chanserv.c` | Integration points (8 calls) |
| `x3/src/proto-common.c:529` | Message dispatch |
| `data/x3.conf` | Configuration section |
| `x3/src/spamserv.help` | Help text |

## Appendix B: Integration Points to Update if Removing

```c
// main-common.c:598
init_spamserv(info);

// chanserv.c - 8 calls to spamserv_cs_* functions
// proto-common.c:529 - direct call to spamserv_channel_message()
```

---

*Investigation complete. Awaiting decision from Rubin.*
