# Chathistory PM Storage Simplification Plan

## Objective

Replace the consent-based PM storage model with a simpler account-based model:
- **Old**: Three consent modes, per-user metadata preferences, per-message consent checks
- **New**: If both parties are authenticated and neither has opted out, store the PM.

## Rationale

1. **IRC has no privacy guarantee** - Any participant can log and publish conversations
2. **Consent theater** - The current model gives false sense of privacy control
3. **Complexity cost** - Three modes, metadata sync, per-message checks, user notifications
4. **User confusion** - Most users won't understand or configure `chathistory.pm` metadata
5. **Consistent with channels** - Channel history doesn't require consent from every member

## Current Implementation (to be simplified)

### Consent Modes (FEAT_CHATHISTORY_PRIVATE_CONSENT)
| Mode | Name | Logic |
|------|------|-------|
| 0 | GLOBAL | Store unless either party opted out |
| 1 | SINGLE | Store if either opted in, neither opted out |
| 2 | MULTI | Store only if both explicitly opted in |

### Current Components
- `FEAT_CHATHISTORY_PRIVATE_CONSENT` - Mode selector (0/1/2)
- `FEAT_CHATHISTORY_ADVERTISE_PM` - Advertise `pm=<mode>` in CAP
- `FEAT_CHATHISTORY_PM_NOTICE` - Send notice on connect explaining consent
- Metadata key `chathistory.pm` - Per-user preference (0/1/unset)
- `get_pm_consent_preference()` - Look up user's preference
- `check_pm_consent()` - Evaluate consent for a message pair
- Connect-time notices explaining the consent model

### Files Affected
- `ircd/ircd_relay.c` - Consent check logic (lines 208-323)
- `ircd/m_cap.c` - CAP advertisement with `pm=<mode>`
- `ircd/s_user.c` - Connect-time consent notices
- `ircd/ircd_features.c` - Feature flag definitions
- `include/ircd_features.h` - Feature flag enums

---

## Proposed New Model

### Simple Rule
```
Store PM if:
  1. FEAT_CHATHISTORY_PRIVATE is enabled (master switch)
  2. Sender is authenticated (has account)
  3. Recipient is authenticated (has account)
  4. Neither party has opted out via metadata
```

### Per-Account Opt-Out

Single metadata key for users who want to disable PM history:
- Key: `chathistory.pm.optout` (public visibility)
- Value: `"1"` = opted out, anything else or unset = opted in
- Check: If either sender OR recipient has opted out, don't store

This is much simpler than three consent modes - just one boolean per account.

### Why Account-Based?

1. **Identity requirement** - Anonymous users shouldn't have history stored (no way to retrieve it)
2. **Natural opt-out** - Don't want PM history? Don't authenticate
3. **Consistent** - Same model as other account-tied features (read markers, metadata)
4. **Simple to explain** - "PMs between registered users are stored for X days"

---

## Implementation Changes

### Phase 1: Simplify Consent Check

**ircd/ircd_relay.c** - Replace consent logic:

```c
// OLD (complex)
static int check_pm_consent(struct Client *from, struct Client *to) {
  int mode = feature_int(FEAT_CHATHISTORY_PRIVATE_CONSENT);
  int sender_pref = get_pm_consent_preference(from);
  int recipient_pref = get_pm_consent_preference(to);

  switch (mode) {
    case 0: return (sender_pref != 0 && recipient_pref != 0);
    case 1: return (sender_pref != 0 && recipient_pref != 0 &&
                   (sender_pref == 1 || recipient_pref == 1));
    case 2: return (sender_pref == 1 && recipient_pref == 1);
  }
}

// NEW (simple)
static int check_pm_storage(struct Client *from, struct Client *to) {
  // Both must be authenticated
  if (!IsAccount(from) || !IsAccount(to))
    return 0;

  // Check opt-out metadata (either party can opt out)
  if (has_metadata_optout(from, "chathistory.pm.optout") ||
      has_metadata_optout(to, "chathistory.pm.optout"))
    return 0;

  return 1;
}
```

**Affected functions:**
- `relay_private_message()` - Use new check
- `relay_private_notice()` - Use new check
- `server_relay_private_message()` - Use new check
- `server_relay_private_notice()` - Use new check

### Phase 2: Remove Consent Infrastructure

**Remove feature flags:**
- `FEAT_CHATHISTORY_PRIVATE_CONSENT` - No longer needed
- `FEAT_CHATHISTORY_ADVERTISE_PM` - Simplify to just "pm" presence
- `FEAT_CHATHISTORY_PM_NOTICE` - No longer needed

**Keep:**
- `FEAT_CHATHISTORY_PRIVATE` - Master switch (keep for operators who want it off entirely)

**Remove functions:**
- `get_pm_consent_preference()` in ircd_relay.c
- `check_pm_consent()` in ircd_relay.c

**Remove from s_user.c:**
- Connect-time consent explanation notices (lines 469-494)

### Phase 3: Simplify CAP Advertisement

**ircd/m_cap.c** - Change from:
```
draft/chathistory=limit=100,retention=7d,pm=global
draft/chathistory=limit=100,retention=7d,pm=single
draft/chathistory=limit=100,retention=7d,pm=multi
```

To simply:
```
draft/chathistory=limit=100,retention=7d,pm
```

The `pm` key (without value) indicates PM history is available for authenticated users.

### Phase 4: Update Query Access Control

**ircd/m_chathistory.c** - Simplify PM query authorization:

```c
// OLD: Check if user has "consent" to view PM history
// NEW: Check if user is authenticated and was a participant

static int can_access_pm_history(struct Client *cptr, const char *target) {
  // Must be authenticated
  if (!IsAccount(cptr))
    return 0;

  // Must be one of the participants (already checked by normalize_pm_target)
  return 1;
}
```

### Phase 5: Documentation Updates

- Update FEATURE_FLAGS_CONFIG.md - Remove consent mode documentation
- Update any user-facing help text
- Update IRCv3 capability documentation

---

## Code Locations

| File | Changes |
|------|---------|
| `ircd/ircd_relay.c:208-323` | Replace consent logic with account + opt-out check |
| `ircd/ircd_relay.c:890-920` | Remove get_pm_consent_preference(), add has_metadata_optout() |
| `ircd/m_cap.c:308-321` | Simplify pm advertisement |
| `ircd/s_user.c:469-494` | Remove consent notices |
| `ircd/ircd_features.c:883-886` | Remove CONSENT/ADVERTISE_PM/PM_NOTICE |
| `include/ircd_features.h` | Remove corresponding enums |
| `ircd/m_chathistory.c` | Simplify access checks |

### Helper Function: has_metadata_optout()

```c
// Check if client has opted out via metadata key
static int has_metadata_optout(struct Client *cptr, const char *key) {
  const char *value;

  if (!IsAccount(cptr))
    return 0;

  value = get_user_metadata(cli_user(cptr)->account, key);
  return (value && value[0] == '1' && value[1] == '\0');
}
```

This leverages the existing metadata infrastructure - no new storage needed.

---

## Testing

### Storage Tests
1. **PM between two authenticated users** - Should be stored and retrievable
2. **PM from authenticated to unauthenticated** - Should NOT be stored
3. **PM from unauthenticated to authenticated** - Should NOT be stored
4. **PM between two unauthenticated users** - Should NOT be stored

### Opt-Out Tests
5. **Sender has opt-out set** - PM should NOT be stored
6. **Recipient has opt-out set** - PM should NOT be stored
7. **Both have opt-out set** - PM should NOT be stored
8. **Opt-out value "1"** - Should opt out
9. **Opt-out value "0" or unset** - Should NOT opt out (storage enabled)

### CAP/Query Tests
10. **CAP LS** - Should show `pm` without mode value
11. **CHATHISTORY query** - Should work for authenticated participant
12. **CHATHISTORY query with opt-out** - Should still return stored history (opt-out only affects future storage)

---

## Summary

| Aspect | Old | New |
|--------|-----|-----|
| Consent modes | 3 (global/single/multi) | 0 |
| Feature flags | 4 | 1 (master switch only) |
| Per-user preferences | Complex (0/1/unset for 3 modes) | Simple opt-out only |
| Connect notices | Yes | No |
| Storage rule | Complex consent check | Both authenticated + no opt-out |
| Lines of code | ~150 | ~20 |

**Result**: Dramatically simpler code, clearer semantics, straightforward opt-out for users who want it.
