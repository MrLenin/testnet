# Bouncer Bug Fixes + Session-Wide TLS Enforcement

## Part 1: Bug Fixes

### Bug A: JOIN from shadow not reflected to primary/other shadows

**Root cause**: `send_buffer()` in [send.c:890-932](nefarious/ircd/send.c#L890-L932)
intercepts ALL messages to the primary when `current_shadow` is set, routing
them ONLY to the originating shadow and returning before the primary sendQ or
the shadow duplication loop are reached.

This is correct for **direct replies** (numerics, error responses) — they should
only go to the shadow that sent the command. But for **channel broadcasts**
(JOIN, PART, PRIVMSG, MODE, KICK, etc.), all connections are mirrors and need
the message.

**Fix**: Skip the `current_shadow` intercept when `shadow_tag_ctx.stc_active`
is true. This flag is set by all `sendcmdto_channel_*` functions during their
member iteration loop, precisely identifying channel broadcast traffic.

**File**: `nefarious/ircd/send.c` line 890

Replace:
```c
  if (current_shadow && MyUser(to) && !IsServer(to)) {
```
with:
```c
  if (current_shadow && MyUser(to) && !IsServer(to) && !shadow_tag_ctx.stc_active) {
```

When `stc_active` is true, the message flows normally to the primary's sendQ,
and the shadow duplication loop (line 960+) delivers it to all shadows —
including the originating one. All mirrors see the JOIN/PART/etc.

### Bug B: Periodic blank messages to shadow

**Likely cause**: Needs debug investigation. Possible sources:
1. Tag stripping producing empty messages
2. A broadcast message that becomes empty after CAP filtering
3. Some periodic mechanism writing to shadow sendQ

**Debug approach**: Add temporary logging to `shadow_flush_sendq()` to print
the raw bytes being written. The 30-second interval matches PING frequency,
so the PING duplicated from primary to shadow via the shadow duplication loop
is the prime suspect — but `PING :servername` isn't blank, so something in
the MsgBuf processing may be mangling it.

**Investigate after Part 1 Bug A fix** — the `stc_active` fix may also resolve
this if the blank messages are a side effect of the `current_shadow` intercept
producing empty MsgBufs.

---

## Part 2: Session-Wide TLS Enforcement for +Z Channels

**Principle: "One non-TLS connection means none do."**

### Approach: Two Hard Gates + Promotion Refusal + Invariant Enforcer

**Gate A** — Block non-TLS shadow attach when session is in any +Z channel.
Send a NOTE explaining why the attach was refused.

**Gate B** — Block +Z channel joins when session has ANY non-TLS connection.
New helper `bounce_session_has_plaintext()` used in m_join.c and channel.c.

**Promotion refusal** — If primary was TLS and only plaintext shadows remain,
and the user is in +Z channels, refuse promotion. Session goes to HOLDING.

**Invariant enforcer** — If somehow a non-TLS session ends up in +Z (bug),
the speaking check kicks them from the channel instead of silently muting.

Keep existing promotion counter dance for non-+Z channels.

---

### 1. New helper: `bounce_session_has_plaintext()`

**File**: `nefarious/include/bouncer_session.h` (after `bounce_enabled` ~line 428)

```c
extern int bounce_session_has_plaintext(struct Client *cptr);
```

**File**: `nefarious/ircd/bouncer_session.c` (before `bounce_auto_resume`)

```c
/** Check if a bouncer session has any non-TLS connection.
 * Used for session-wide TLS enforcement: one plaintext connection
 * means the entire session is treated as non-TLS.
 * @param[in] cptr Client to check (must be the primary).
 * @return 1 if any connection (primary or shadow) lacks TLS, 0 otherwise.
 */
int bounce_session_has_plaintext(struct Client *cptr)
{
#ifdef USE_SSL
  struct BouncerSession *session;
  struct ShadowConnection *shadow;

  session = bounce_get_session(cptr);
  if (!session || session->hs_state != BOUNCE_ACTIVE)
    return 0;

  /* Check primary */
  if (session->hs_client && !cli_socket(session->hs_client).ssl)
    return 1;

  /* Check all live shadows */
  for (shadow = session->hs_shadows; shadow; shadow = shadow->sh_next) {
    if (!(shadow->sh_flags & SHADOW_FLAGS_DEAD) && !shadow->sh_socket.ssl)
      return 1;
  }

  return 0;
#else
  return 0;
#endif
}
```

### 2. Gate A: Block plaintext shadow when session in +Z (with NOTE)

**File**: `nefarious/ircd/bouncer_session.c` (~line 510, after existing REQUIRE_TLS gate)

```c
    /* Gate A: Block plaintext shadow if primary is in any +Z channel.
     * One non-TLS connection compromises the entire session's +Z access. */
    if (!cli_socket(cptr).ssl && cli_user(session->hs_client)) {
      struct Membership *m;
      for (m = cli_user(session->hs_client)->channel; m; m = m->next_channel) {
        if (m->channel->mode.exmode & EXMODE_SSLONLY) {
          Debug((DEBUG_INFO,
                 "Bouncer: blocking plaintext shadow for %s (session in +Z channel %s)",
                 cli_name(cptr), m->channel->chname));
          sendrawto_one(cptr,
            ":%s NOTE BOUNCER TLS_REQUIRED "
            ":Cannot attach to session — active session is in SSL-only (+Z) "
            "channels. Connect with TLS to attach.",
            cli_name(&me));
          goto skip_shadow;
        }
      }
    }
```

### 3. Gate B: Block +Z join when session has plaintext

**File**: `nefarious/ircd/m_join.c`

Add include:
```c
#include "bouncer_session.h"
```

Line 177 — STRICT check:
```c
    if (feature_bool(FEAT_CHMODE_Z_STRICT) && (chptr->mode.exmode & EXMODE_SSLONLY) &&
        (!IsSSL(sptr) || bounce_session_has_plaintext(sptr)))
```

Line 189 — standard check:
```c
    else if ((chptr->mode.exmode & EXMODE_SSLONLY) &&
             (!IsSSL(sptr) || bounce_session_has_plaintext(sptr)))
```

### 4. Invariant enforcer: Kick from +Z if session has plaintext

**File**: `nefarious/ircd/channel.c` (already includes bouncer_session.h and msg.h)

Line 1025-1026, replace:
```c
  if (member->channel->mode.exmode & EXMODE_SSLONLY && !IsSSL(member->user))
    return 0;
```
with:
```c
  if ((member->channel->mode.exmode & EXMODE_SSLONLY) &&
      (!IsSSL(member->user) || bounce_session_has_plaintext(member->user))) {
    if (IsSSL(member->user) && bounce_session_has_plaintext(member->user)) {
      /* Invariant violation: TLS primary in +Z but session has plaintext.
       * Kick from channel — this shouldn't happen with gates A/B working. */
      sendcmdto_serv_butone(&me, CMD_KICK, NULL,
                            "%H %C :SSL-only channel (insecure session)",
                            member->channel, member->user);
      sendcmdto_channel_butserv_butone(&me, CMD_KICK, member->channel, NULL, 0,
                                       "%H %C :SSL-only channel (insecure session)",
                                       member->channel, member->user);
      make_zombie(member, member->user, &me, &me, member->channel);
    }
    return 0;
  }
```

### 5. Promotion: Refuse when +Z would be violated

**File**: `nefarious/ircd/bouncer_session.c` (~line 2171, after TLS shadow preference)

```c
  /* Refuse promotion if it would put a non-TLS connection in +Z channels.
   * Primary was TLS, best shadow is plaintext, user is in +Z → HOLDING. */
  if (IsSSL(cptr) && !shadow->sh_socket.ssl && cli_user(cptr)) {
    struct Membership *m;
    for (m = cli_user(cptr)->channel; m; m = m->next_channel) {
      if (m->channel->mode.exmode & EXMODE_SSLONLY) {
        Debug((DEBUG_INFO,
               "Bouncer: refusing promotion for %s — no TLS shadow, in +Z channel %s",
               cli_name(cptr), m->channel->chname));
        return -1;  /* Session goes to HOLDING */
      }
    }
  }
```

Keep existing counter dance unchanged — needed for non-+Z channels.

---

## Files modified

| File | Changes |
|------|---------|
| `nefarious/ircd/send.c` | Bug A: skip `current_shadow` intercept during channel broadcasts |
| `nefarious/include/bouncer_session.h` | Declare `bounce_session_has_plaintext()` |
| `nefarious/ircd/bouncer_session.c` | Implement helper, Gate A (with NOTE), promotion +Z refusal |
| `nefarious/ircd/m_join.c` | Add include, Gate B (2 locations) |
| `nefarious/ircd/channel.c` | Invariant enforcer: kick from +Z if session has plaintext |

## Verification

1. Rebuild nefarious
2. Test JOIN from shadow appears on primary and other shadows
3. Existing bouncer tests: `npm test -- src/ircv3/bouncer.test.ts`
4. Investigate blank messages (may be resolved by Bug A fix)
5. Manual +Z tests: plaintext shadow refused, +Z join blocked with plaintext session
