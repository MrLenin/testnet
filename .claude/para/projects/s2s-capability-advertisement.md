# S2S Capability Advertisement — Fix Multiline Duplication

## Problem

When a multiline message is sent to a channel with users on both modern and legacy servers:
1. Current code iterates ALL channel members (including remote)
2. For each remote member, it sends fallback PRIVMSGs via `sendcmdto_one()`
3. Each PRIVMSG goes to the remote server, which delivers to ALL local channel members
4. With N remote users, N copies of the fallback are sent → N² message delivery
5. Additionally, ML tokens are sent but legacy servers ignore them

## Solution

Advertise S2S capabilities during BURST using a blank ML token. Modern servers recognize it and set a flag; legacy servers ignore it. Then route appropriately:
- **ML-capable servers**: Send ML tokens only (full batching)
- **Legacy servers**: Send fallback PRIVMSGs once per server (truncated preview)

## Design

### Capability Advertisement

During server link BURST, send a blank ML message:
```
AB ML
```

- Legacy servers ignore unknown token (standard P10 behavior)
- Modern servers detect empty ML and set `FLAG_MULTILINE` on the server struct
- Must also propagate to other servers so entire network knows capabilities

### Server Flag

Add `FLAG_MULTILINE` to track which servers support multiline:
```c
// include/client.h
FLAG_MULTILINE,  /**< Server supports P10 multiline batches */

#define IsMultiline(x)    HasFlag(x, FLAG_MULTILINE)
#define SetMultiline(x)   SetFlag(x, FLAG_MULTILINE)
```

### Routing Logic

When sending multiline to a channel:
1. Skip remote users in direct delivery loop (fixes N² bug)
2. For S2S relay, check each server's capability:
   - `IsMultiline(server)` → send ML tokens
   - Not multiline → send fallback PRIVMSGs once

### Fallback Notice for Legacy

Update truncation notice for users on legacy servers:
```
[N more lines - connect to a multiline-capable server to view full message]
```

This is honest about the limitation and encourages upgrades.

## Implementation Status

✅ All implementation steps completed.

## Implementation

### 1. Add FLAG_MULTILINE (include/client.h) ✅

After existing server flags:
```c
FLAG_MULTILINE,  /**< Server supports P10 multiline batches */
```

Add accessor macros near other server predicates:
```c
#define IsMultiline(x)    HasFlag(x, FLAG_MULTILINE)
#define SetMultiline(x)   SetFlag(x, FLAG_MULTILINE)
#define ClrMultiline(x)   ClrFlag(x, FLAG_MULTILINE)
```

### 2. Send ML Advertisement During BURST (ircd/s_serv.c) ✅

In `server_estab()`, after sending SERVER message and before other BURST content.
Also bursts ML capability for all known ML-capable servers (multi-server fix):
```c
/* Advertise multiline capability - legacy servers ignore, modern sets flag.
 * Also burst ML capability for all known ML-capable servers so that when
 * server C links to B after A already linked to B, C learns about A's
 * capability (not just B's).
 */
if (feature_bool(FEAT_CAP_draft_multiline)) {
  struct Client *srv;
  sendcmdto_one(&me, CMD_MULTILINE, cptr, "");
  for (srv = GlobalClientList; srv; srv = cli_next(srv)) {
    if (IsServer(srv) && !IsMe(srv) && srv != cptr && IsMultiline(srv))
      sendcmdto_one(srv, CMD_MULTILINE, cptr, "");
  }
}
```

### 3. Receive ML Advertisement (ircd/m_batch.c) ✅

In `ms_multiline()`, detect capability advertisement at start:
```c
int ms_multiline(struct Client* cptr, struct Client* sptr, int parc, char* parv[])
{
  /* Empty ML = capability advertisement during BURST */
  if (parc < 2 || EmptyString(parv[1])) {
    if (IsServer(sptr)) {
      SetMultiline(sptr);
      /* Propagate to other servers */
      sendcmdto_serv_butone(sptr, CMD_MULTILINE, cptr, "");
    }
    return 0;
  }

  /* ... existing ML handling ... */
}
```

### 4. Fix Channel Member Loop (ircd/m_batch.c) ✅

In `batch_client_complete()`, skip remote users in the local delivery loop:
```c
for (member = chptr->members; member; member = member->next_member) {
  struct Client *to = member->user;

  if (to == sptr)
    continue;  /* Skip sender */

  if (!MyConnect(to))
    continue;  /* Skip remote - handled by S2S relay */

  /* ... existing local delivery ... */
}
```

### 5. Capability-Aware S2S Relay (ircd/m_batch.c) ✅

Replace the current S2S relay section with capability-aware routing:
```c
/* S2S relay for channel messages - route based on server capability */
if (is_channel && chptr) {
  struct DLink *lp;
  int max_preview = feature_int(FEAT_MULTILINE_LEGACY_MAX_LINES);
  int total_lines = con_ml_msg_count(con);

  /* Track which servers we've sent to */
  bump_sentalong(NULL);
  cli_sentalong(sptr) = sentalong_marker;

  for (member = chptr->members; member; member = member->next_member) {
    struct Client *server;

    if (MyConnect(member->user))
      continue;  /* Local users already handled */

    server = cli_from(member->user);
    if (IsServer(server) && cli_sentalong(server) != sentalong_marker) {
      cli_sentalong(server) = sentalong_marker;

      if (IsMultiline(server)) {
        /* Send ML tokens to capable servers */
        send_multiline_to_server(sptr, server, chptr, con);
      } else {
        /* Send fallback PRIVMSGs to legacy servers */
        send_multiline_fallback_to_server(sptr, server, chptr,
            con_ml_messages(con), total_lines, max_preview);
      }
    }
  }
}
```

### 6. New Helper Functions (ircd/m_batch.c) ✅

Note: Instead of separate helper functions, the logic was inlined directly in the S2S relay section for simplicity.

```c
/* Send ML tokens to a single capable server */
static void send_multiline_to_server(struct Client *sptr, struct Client *server,
                                      struct Channel *chptr, struct Connection *con)
{
  char s2s_batch_id[16];
  struct SLink *lp;
  int first = 1;

  ircd_snprintf(0, s2s_batch_id, sizeof(s2s_batch_id), "%s%lu",
                cli_yxx(sptr), (unsigned long)CurrentTime);

  for (lp = con_ml_messages(con); lp; lp = lp->next) {
    int concat = lp->value.cp[0];
    char *text = lp->value.cp + 1;

    if (first) {
      sendcmdto_one(sptr, CMD_MULTILINE, server, "+%s %s :%s",
                    s2s_batch_id, chptr->chname, text);
      first = 0;
    } else if (concat) {
      sendcmdto_one(sptr, CMD_MULTILINE, server, "c%s %s :%s",
                    s2s_batch_id, chptr->chname, text);
    } else {
      sendcmdto_one(sptr, CMD_MULTILINE, server, "%s %s :%s",
                    s2s_batch_id, chptr->chname, text);
    }
  }
  sendcmdto_one(sptr, CMD_MULTILINE, server, "-%s %s :",
                s2s_batch_id, chptr->chname);
}

/* Send fallback PRIVMSGs to a legacy server */
static void send_multiline_fallback_to_server(struct Client *sptr,
    struct Client *server, struct Channel *chptr,
    struct SLink *messages, int total_lines, int max_preview)
{
  struct SLink *lp;
  int sent = 0;
  int lines_to_send = (total_lines <= max_preview) ? total_lines : max_preview;

  /* Send preview lines */
  for (lp = messages; lp && sent < lines_to_send; lp = lp->next, sent++) {
    char *text = lp->value.cp + 1;
    if (*text == '\0')
      continue;
    sendcmdto_one(sptr, CMD_PRIVATE, server, "%H :%s", chptr, text);
  }

  /* Send truncation notice if needed */
  if (total_lines > max_preview) {
    int remaining = total_lines - sent;
    sendcmdto_one(&me, CMD_NOTICE, server,
        "%H :[%d more lines - connect to a multiline-capable server to view]",
        chptr, remaining);
  }
}
```

### 7. Handle SQUIT (ircd/m_squit.c or exit_client)

When a server disconnects, no special handling needed - the FLAG_MULTILINE is on the server struct which gets cleaned up naturally.

## Files to Modify

| File | Changes |
|------|---------|
| `include/client.h` | Add `FLAG_MULTILINE`, `IsMultiline()`, `SetMultiline()` |
| `ircd/s_serv.c` | Send blank ML during BURST in `server_estab()` |
| `ircd/m_batch.c` | Detect ML advertisement, skip remote users, add capability-aware S2S relay |

## Testing

1. **Modern-to-Modern**: Link two modern servers, send multiline, verify batch arrives intact
2. **Modern-to-Legacy**: Link modern to upstream, send multiline, verify legacy gets truncated PRIVMSGs (not N²)
3. **Legacy-to-Modern**: Send from legacy to modern, verify normal PRIVMSG behavior
4. **Mixed Channel**: Channel with users on both modern and legacy, verify each gets appropriate format
5. **Reconnect**: Disconnect/reconnect server, verify capability re-advertised

## Edge Cases

### Server Behind Server
When serverA → serverB → serverC, if serverB is legacy:
- serverA sends ML to network
- serverB ignores ML (doesn't propagate)
- serverC never sees ML from serverA

Solution: Propagate ML advertisement in `ms_multiline()` so all servers know capabilities.

### Late-Linking Servers
When serverC links to serverB after serverA already linked to serverB:
- Without fix: C would only learn B's capability, not A's
- With fix: B bursts ML capability for ALL known ML-capable servers during BURST

Solution: In `server_estab()`, iterate all servers with `FLAG_MULTILINE` and send their ML to the newly linked server.

### Services (X3)
X3 is a service, not a user-facing server. It doesn't need to understand ML for message relay since:
- X3 doesn't have regular users receiving channel messages
- X3's pseudo-clients handle messages differently

No special handling needed.

### Feature Flag Disabled
If `FEAT_CAP_draft_multiline` is FALSE:
- Don't send ML advertisement during BURST
- Don't send ML tokens for relay
- Send fallback PRIVMSGs to all servers

## Future Considerations

This pattern can be extended for other S2S capabilities:
- Could send multiple capability tokens during BURST: `ML`, `MD`, `TG`, etc.
- Could create a general `CAPS` token listing all capabilities
- For now, ML-only is sufficient since it's the only one needing fallback behavior
