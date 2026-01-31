# Union Caps + Per-Client Content Filtering

## Status: ✅ Implemented

## Problem Statement

`cli_active()` reflected only the primary connection's caps. When a shadow had a cap the primary didn't, `CapActive()` checks returned false and content meant for the shadow was never generated — even when `current_shadow` routing would correctly deliver it.

## Solution: Two-Level Cap System

### Storage
- `con_active` (existing) — now stores the **union** of all session connections' caps
- `con_active_own` (new) — stores this connection's own negotiated caps

### New Macros/Functions
- `CapSetOR(dst, src)` — bitwise OR two CapSets (capab.h)
- `cli_active_own(cli)` / `con_active_own(con)` — access per-connection own caps (client.h)
- `CapOwnHas(cli, cap)` — check per-connection own caps (client.h)
- `CapRecipientHas(cli, cap)` — check the *receiving* connection's caps: uses `current_shadow->sh_active` when shadow is active, otherwise `cli_active_own` (bouncer_session.h)
- `cap_lookup()` — public cap name→enum lookup for shadow CAP handler (capab.h, m_cap.c)
- `bounce_recompute_session_caps(primary)` — recompute `cli_active` union (bouncer_session.c)

### Files Modified

1. **`include/client.h`** ✅
   - Added `con_active_own` field to `struct Connection`
   - Added `con_active_own()`, `cli_active_own()`, `CapOwnHas()` macros

2. **`include/capab.h`** ✅
   - Added `CapSetOR()` macro
   - Added `cap_lookup()` declaration

3. **`include/bouncer_session.h`** ✅
   - Added `CapRecipientHas()` macro
   - Added `bounce_recompute_session_caps()` declaration

4. **`ircd/m_cap.c`** ✅
   - `cap_req()`: writes to `cli_active_own` then calls `bounce_recompute_session_caps()`
   - `cap_ack()`: same pattern
   - `cap_clear()`: same pattern
   - Added `cap_lookup()` public function wrapping `find_cap()`
   - Added `#include "bouncer_session.h"`

5. **`ircd/bouncer_session.c`** ✅
   - Added `bounce_recompute_session_caps()` — computes `cli_active = own | shadow1 | shadow2 | ...`
   - Added `shadow_handle_cap()` — intercepts CAP REQ/LIST/END from shadows, processes locally instead of forwarding to `parse_client(primary)` which would modify the primary's caps
   - Shadow attach: calls recompute after shadow caps are copied
   - Shadow removal: calls recompute after shadow is unlinked
   - `bounce_attach()`: calls recompute for new primary + existing shadows
   - Shadow promotion: sets `con_active_own` from promoted shadow's caps, calls recompute
   - Shadow welcome channel replay: removed redundant `CapHas(&shadow->sh_active, ...)` guards in favor of union + `CapRecipientHas`

6. **`ircd/channel.c`** ✅
   - Self-JOIN echo: `CapActive → CapRecipientHas` for EXTJOIN
   - Added `#include "bouncer_session.h"`

7. **`ircd/m_kick.c`** ✅
   - Delayed kick JOIN redisplay: `CapActive → CapRecipientHas` for EXTJOIN
   - Added `#include "bouncer_session.h"`

8. **`ircd/m_names.c`** ✅
   - NAMES reply: `CapActive → CapRecipientHas` for NAMESX, UHNAMES
   - Added `#include "bouncer_session.h"`

9. **`ircd/s_user.c`** ✅
   - Auto-replay: `CapActive → CapOwnHas` for CHATHISTORY (per-connection decision)

### How It Works

**Non-bouncer clients**: `cli_active == cli_active_own` (no shadows to merge). `bounce_recompute_session_caps` is a no-op. Zero overhead.

**Bouncer sessions**: `cli_active = primary's own | shadow1 | shadow2 | ...`. This means:
- Command gating (`CapActive(sptr, CAP_DRAFT_CHATHISTORY)`) returns true if *any* connection has the cap → shadow-initiated commands work
- Tag formatting uses the union → all tags are generated, then stripped per-connection by `send_buffer()`
- Content generation (MARKREAD, METADATA responses, etc.) uses the union → content is generated even if only a shadow needs it

**Format-sensitive sites** use `CapRecipientHas()` which checks the *actual recipient's* caps:
- When `current_shadow` is set → checks `shadow->sh_active`
- When NULL → checks primary's `cli_active_own`

**Shadow CAP renegotiation**: Previously a bug — shadow's `CAP REQ` went through `parse_client(primary)` and modified the primary's caps. Now intercepted in `shadow_read_packet()` and processed locally, updating `sh_active` and recomputing the union.

### What This Fixes

- `send_markread_on_join(primary, ...)` works for shadows — `CapActive` returns true from union
- Command gating (METADATA, CHATHISTORY, etc.) works for shadow-initiated commands
- Standard-replies error formatting works if shadow negotiated it
- All send/suppress decisions correctly reflect session-wide capabilities
- Primary connection still gets correct per-client formatting
- Shadow CAP REQ no longer corrupts primary's cap state

### Edge Cases Handled

- **Shadow with caps primary lacks**: Union includes the cap, content is generated. `send_buffer()` routes to shadow. Format-sensitive output uses `CapRecipientHas` to match recipient.
- **Primary with caps shadow lacks**: Union includes the cap. Format-sensitive output for primary uses `CapRecipientHas` (checks own caps). Shadow gets correct format via its own `sh_active`.
- **Auto-replay decision**: Uses `CapOwnHas` (not union). If only a shadow has chathistory, primary still gets auto-replay since it can't fetch history itself.
- **Shadow promotion**: New primary's `con_active_own` is set from the promoted shadow's caps, then union is recomputed with remaining shadows.
