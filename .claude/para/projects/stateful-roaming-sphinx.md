# Fix: Labeled-Response Compliance

## Context

Per [IRCv3 labeled-response spec](https://ircv3.net/specs/extensions/labeled-response):
- "If a response consists of more than one message, a batch MUST be used to group them into a single logical response."
- "The start of the batch MUST be tagged with the `label` tag."
- ACK is ONLY for "a labeled command that normally produces no response."

Two categories of breakage:
1. **CHATHISTORY**: Label completely lost — spurious ACK, then unlabeled batch
2. **Multi-numeric commands**: Label on first numeric only, rest unlabeled/unbatched

## Approach: Per-Command Labeled Batch Wrapping

### 1. Helper functions (send.c / send.h)

```c
/** Start a labeled-response batch if client has pending label + batch cap.
 * @return 1 if batch was started, 0 otherwise.
 */
int labeled_batch_start(struct Client *sptr);

/** End a labeled-response batch started by labeled_batch_start(). */
void labeled_batch_end(struct Client *sptr);
```

`labeled_batch_start` checks: `MyConnect(sptr)`, `cli_label(sptr)[0]`, `CAP_LABELEDRESP`, `CAP_BATCH`, feature flags. Calls `send_batch_start(sptr, "labeled-response")` which handles `@label=xxx` on BATCH +start and sets `cli_label_responded = 1`.

### 2. Parse.c safety net (~line 1642)

After handler returns, close any batch left open (safety), then ACK as before:
```c
if (result != CPTR_KILLED) {
  if (has_active_batch(cptr))
    send_batch_end(cptr);
  send_labeled_ack(cptr);
}
```

### 3. CHATHISTORY own-batch fix (m_chathistory.c)

CHATHISTORY manages its own batch (local batchid, not cli_batch_id). Fix:
- Add `const char *label` param to `send_history_batch()` and `send_targets_batch()`
- Attach `@label=xxx` to their BATCH +start when label is present
- Add `char label[64]` to `struct FedRequest`
- Save label + suppress ACK in `start_fed_query()` and `start_fed_targets_query()`
- Pass saved label through `send_fed_response()` and `complete_targets_fed()`
- Pass `NULL` for auto-replay callers

### 4. Per-command wrapping

Add `labeled_batch_start(sptr)` / `labeled_batch_end(sptr)` to each multi-reply handler:

| Command | File | Function(s) | Notes |
|---------|------|-------------|-------|
| WHOIS | m_whois.c | `m_whois`, `ms_whois` / `do_whois` | Always multi-reply on success |
| WHO | m_who.c | `m_who` | Loop + RPL_ENDOFWHO |
| NAMES | m_names.c | `m_names` | RPL_NAMREPLY loop + end |
| LIST | m_list.c | `m_list` | RPL_LISTSTART + loop + end |
| MOTD | m_motd.c | `m_motd`, `ms_motd` | Delegates to motd_send() |
| RULES | m_rules.c | `m_rules`, `ms_rules` | Delegates to motd_send_type() |
| OPERMOTD | m_opermotd.c | `m_opermotd`, `ms_opermotd` | Delegates to motd_send_type() |
| INFO | m_info.c | `m_info`, `ms_info`, `mo_info` | RPL_INFO loop + end |
| HELP | m_help.c | `m_help` | RPL_HELPTXT loop + end |
| LUSERS | m_lusers.c | `m_lusers`, `ms_lusers` | 6-8 numerics always |
| LINKS | m_links.c | `m_links`, `ms_links` | RPL_LINKS loop + end |
| MAP | m_map.c | `m_map`, `mo_map` | Recursive dump_map + end |
| STATS | m_stats.c | `m_stats`, `ms_stats` | RPL_STATS* + end |
| ADMIN | m_admin.c | `m_admin`, `ms_admin`, `mo_admin` | 4 numerics always |
| TRACE | m_trace.c | `m_trace`, `ms_trace`, `mo_trace` | RPL_TRACE* + end |
| VERSION | m_version.c | `m_version`, `ms_version`, `mo_version` | RPL_VERSION + ISUPPORT |
| INVITE | m_invite.c | `m_invite` | Multi when listing invites |
| SILENCE | m_silence.c | `m_silence` | Multi when listing |
| WATCH | m_watch.c | `m_watch` | Multi when listing |
| MONITOR | m_monitor.c | `m_monitor` | Multi on +/L/S subcommands |
| MODE | m_mode.c | `m_mode` | Multi for channel mode query |

Pattern for each handler:
```c
int m_xxx(struct Client *cptr, struct Client *sptr, int parc, char *parv[]) {
  int lb = labeled_batch_start(sptr);
  // ... existing handler logic (unchanged) ...
  if (lb) labeled_batch_end(sptr);
  return result;
}
```

For handlers with early-return error paths: the batch wraps the error too (single reply in a batch — slightly verbose but correct and consistent). Alternatively, place the wrapping after validation, before the multi-reply section.

## Files Modified

| File | Change |
|------|--------|
| `nefarious/ircd/send.c` | Add `labeled_batch_start()` / `labeled_batch_end()` |
| `nefarious/include/send.h` | Declare helpers |
| `nefarious/ircd/parse.c` | Safety net: auto-end unclosed batches |
| `nefarious/ircd/m_chathistory.c` | Label on own BATCH +start, federation label save/restore |
| `nefarious/ircd/m_whois.c` | Labeled batch wrapping |
| `nefarious/ircd/m_who.c` | Labeled batch wrapping |
| `nefarious/ircd/m_names.c` | Labeled batch wrapping |
| `nefarious/ircd/m_list.c` | Labeled batch wrapping |
| `nefarious/ircd/m_motd.c` | Labeled batch wrapping |
| `nefarious/ircd/m_rules.c` | Labeled batch wrapping |
| `nefarious/ircd/m_opermotd.c` | Labeled batch wrapping |
| `nefarious/ircd/m_info.c` | Labeled batch wrapping |
| `nefarious/ircd/m_help.c` | Labeled batch wrapping |
| `nefarious/ircd/m_lusers.c` | Labeled batch wrapping |
| `nefarious/ircd/m_links.c` | Labeled batch wrapping |
| `nefarious/ircd/m_map.c` | Labeled batch wrapping |
| `nefarious/ircd/m_stats.c` | Labeled batch wrapping |
| `nefarious/ircd/m_admin.c` | Labeled batch wrapping |
| `nefarious/ircd/m_trace.c` | Labeled batch wrapping |
| `nefarious/ircd/m_version.c` | Labeled batch wrapping |
| `nefarious/ircd/m_invite.c` | Labeled batch wrapping |
| `nefarious/ircd/m_silence.c` | Labeled batch wrapping |
| `nefarious/ircd/m_watch.c` | Labeled batch wrapping |
| `nefarious/ircd/m_monitor.c` | Labeled batch wrapping |
| `nefarious/ircd/m_mode.c` | Labeled batch wrapping |

## Verification

1. `@label=t1 CHATHISTORY LATEST #ch * 10` → `@label=t1` on BATCH +chathistory, no ACK
2. `@label=t2 WHOIS nick` → `@label=t2` on BATCH +labeled-response, numerics with @batch=
3. `@label=t3 WHO #ch` → same pattern
4. `@label=t4 PONG :x` → ACK only (no batch)
5. `@label=t5 PRIVMSG #ch :hi` → `@label=t5` on echo-message directly
6. Federation CHATHISTORY → label on BATCH +start, no spurious ACK
7. Client without batch cap → label on first reply (graceful degradation)

---

## Audit (2026-03-08)

### Issue 1 — CRITICAL: LIST is Asynchronous — Wrapping Pattern Breaks

**Location**: `m_list.c:420-424`, `hash.c:449-508`, `s_bsd.c:1500-1501`

`m_list()` does NOT send all RPL_LIST replies synchronously. It allocates a `ListingArgs` iterator on the client, calls `list_next_channels(sptr)` to send an initial batch, then **returns immediately**. Subsequent list entries are sent from `s_bsd.c`'s ET_WRITE handler:

```c
if (cli_listing(cptr) && MsgQLength(&(cli_sendQ(cptr))) < 2048)
    list_next_channels(cptr);
```

RPL_LISTEND is sent from `hash.c:506` when all hash buckets are exhausted — potentially many event loop iterations later.

**Impact**: `labeled_batch_start` at function entry opens a batch. `labeled_batch_end` fires when `m_list` returns, closing the batch immediately. All actual LIST data arrives **after** the batch is closed.

**Fix options**:
1. Save the label in `cli_listing()` (or a new field on Connection) and emit the label on a batch opened/closed inside `list_next_channels()` + the `RPL_LISTEND` path.
2. Convert LIST to synchronous (not practical — exists to avoid sendQ flood).
3. Treat LIST specially: don't use the generic wrapping pattern. Instead, open the batch in `m_list()` and close it in the `RPL_LISTEND` path in `hash.c:502-507`. The safety net in parse.c must NOT auto-close this long-lived batch.

Option 3 is cleanest but **conflicts with the parse.c safety net** (Section 2), which would close the batch when m_list returns. The safety net must distinguish handler-managed batches from accidental leaks. A flag on the Connection (e.g., `cli_batch_persistent`) could suppress the safety net.

### Issue 2 — HIGH: Forwarded Commands Lose Labels Across Parse Cycles

**Location**: `parse.c:1389-1391`, `m_whois.c:482-484`, `m_version.c:146-149`

When `hunt_server_cmd()` forwards a command to a remote server (returns `!= HUNTED_ISME`), the handler returns immediately. The current parse cycle ends, and `send_labeled_ack(cptr)` fires — either sending a **spurious ACK** (current behavior) or closing an **empty labeled-response batch** (with the plan's wrapping).

The actual response numerics arrive later as S2S messages in a **different parse cycle**. At that point, `cli_label` has been cleared (`parse.c:1389-1390` clears it at the start of every parse), so the response numerics arrive unlabeled.

**Affected commands**: WHOIS (with server target), VERSION, MOTD, RULES, OPERMOTD, INFO, ADMIN, LINKS, STATS, TRACE — any command with `hunt_server_cmd()`.

**Impact**: The plan's wrapping opens a labeled batch, hunt_server_cmd forwards the command, the handler returns, labeled_batch_end closes an empty batch, and the client receives `@label=xxx BATCH +id labeled-response` / `BATCH -id` with zero content inside. The real responses arrive later, unlabeled.

**Fix**: For forwarded commands, the wrapping should be conditional:
```c
if (hunt_server_cmd(...) != HUNTED_ISME)
    return 0;  // Don't wrap — we're not generating the response
int lb = labeled_batch_start(sptr);
// ... local response logic ...
if (lb) labeled_batch_end(sptr);
```

But this still leaves the remote response unlabeled. To fix that properly:
- Save `cli_label` before `hunt_server_cmd` and restore it after the remote response arrives, OR
- Persist the label on the Connection for the duration of the forwarded request (don't clear it in parse.c if a forwarded response is pending)

This requires a `cli_label_forwarded` flag or similar mechanism. Significant design work needed.

### Issue 3 — MEDIUM: Missing Commands

Several multi-reply commands are absent from the wrapping table:

| Command | File | Reply Pattern |
|---------|------|---------------|
| **WHOWAS** | `m_whowas.c` | RPL_WHOWASUSER + RPL_WHOISSERVER loop + RPL_ENDOFWHOWAS |
| **CHECK** | `m_check.c` | Dozens of RPL_CHECK* + RPL_ENDOFCHECK (6 code paths) |
| **IRCOPS** | `m_ircops.c` | RPL_IRCOPS loop + RPL_ENDOFIRCOPS |
| **JOIN** | `m_join.c` | JOIN echo + RPL_TOPIC + RPL_TOPICWHOTIME + RPL_NAMREPLY + RPL_ENDOFNAMES |

JOIN is debatable — some implementations treat the echo as the "single response" and the numerics as supplementary. But per strict spec reading ("more than one message"), JOIN produces 3-5+ messages and should be batched.

CHECK is oper-only and extremely verbose. Worth wrapping but lower priority.

### Issue 4 — MEDIUM: parse.c Safety Net Conflicts with Long-Lived Batches

**Location**: Plan Section 2

The safety net `has_active_batch(cptr) → send_batch_end(cptr)` fires after EVERY handler returns. This creates a conflict:

1. **LIST** (Issue 1): Batch must stay open across multiple event loop iterations.
2. **CHATHISTORY federation**: `start_fed_query()` returns immediately, response arrives asynchronously. If CHATHISTORY were wrapped with `labeled_batch_start`, the safety net would close it prematurely.

The plan correctly avoids wrapping CHATHISTORY (it has its own label handling in Section 3). But it doesn't account for LIST.

**Fix**: The safety net should only close batches that were opened by `labeled_batch_start()`, not arbitrary batches. Track this with a flag: `cli_labeled_batch_active`. The safety net becomes:
```c
if (cli_labeled_batch_active(cptr)) {
    send_batch_end(cptr);
    cli_labeled_batch_active(cptr) = 0;
}
```

### Issue 5 — MEDIUM: Nested Batch Interaction with CHATHISTORY

The plan's Section 3 correctly puts `@label=xxx` on CHATHISTORY's own BATCH +start. But consider what happens when CHATHISTORY triggers from auto-replay during JOIN:

1. `@label=t1 JOIN #channel` → labeled_batch_start opens a labeled-response batch → cli_batch_id = "lr1"
2. JOIN handler calls auto-replay → `send_history_batch()` sends BATCH +hist1 chathistory
3. Because `cli_batch_id` = "lr1", `format_message_tags_for_ex` adds `@batch=lr1` to the chathistory BATCH +start → nested batch (chathistory inside labeled-response)
4. This is actually correct per spec — the chathistory batch is a nested batch inside the labeled-response batch

However, the plan says "Pass NULL for auto-replay callers" which would NOT put `@label` on the chathistory BATCH +start (correct, because the label is on the outer labeled-response batch). **But JOIN is not in the wrapping table** (see Issue 3). If JOIN isn't wrapped, auto-replay's chathistory batch gets no label anywhere.

### Issue 6 — LOW: CHATHISTORY Federation Label Must Suppress ACK Early

The plan says "Save label + suppress ACK in `start_fed_query()`." The mechanism for suppression needs to be clear: setting `cli_label_responded = 1` before `start_fed_query()` returns prevents the ACK. But `cli_label` is cleared at the start of the next parse cycle (`parse.c:1389`). The saved label in `FedRequest.label[64]` is the only surviving copy.

When `send_fed_response()` fires asynchronously, it calls `send_history_batch()` with the saved label. But at that point, `cli_label(sptr)` is empty (cleared by later parse cycles). `send_history_batch()` needs to temporarily set `cli_label(sptr)` to emit the label tag, then restore it. This restore-after-use pattern is fragile and must be documented.

**Alternative**: Have `send_history_batch()` directly format `@label=xxx` into its BATCH +start message rather than relying on the tag formatting pipeline.

### Issue 7 — LOW: Graceful Degradation (Client Without batch CAP)

Plan Section 4 line 7 says: "Client without batch cap → label on first reply (graceful degradation)."

`labeled_batch_start()` checks for `CAP_BATCH` and returns 0 if missing. This means no batch is opened. The existing `format_message_tags_for_ex()` path puts `@label` on the first reply and sets `cli_label_responded = 1`. Subsequent replies get no label — which is the best possible behavior when batching isn't available.

This is correct and handles gracefully. No issue here — just confirming the plan's claim.

### Summary

| # | Severity | Issue | Plan Correct? |
|---|----------|-------|---------------|
| 1 | CRITICAL | LIST is async — wrapping breaks entirely | ✗ Needs special handling |
| 2 | HIGH | Forwarded commands lose labels across parse cycles | ✗ Not addressed |
| 3 | MEDIUM | Missing commands: WHOWAS, CHECK, IRCOPS, JOIN | ✗ Incomplete table |
| 4 | MEDIUM | Safety net conflicts with long-lived batches | ✗ Needs flag-based scoping |
| 5 | MEDIUM | Nested batch interaction with auto-replay during JOIN | ✗ JOIN not in table |
| 6 | LOW | Federation label must suppress ACK + fragile restore pattern | ~ Mostly addressed |
| 7 | LOW | Graceful degradation without batch CAP | ✓ Correct |

### What the Plan Gets Right

- **Core architecture is sound**: `labeled_batch_start` / `labeled_batch_end` helpers wrapping handlers is the right approach for synchronous multi-reply commands (WHO, NAMES, LUSERS, ADMIN, etc.)
- **CHATHISTORY separate treatment**: Correctly identifies that CHATHISTORY needs its own label handling rather than generic wrapping, because it manages its own batch IDs
- **parse.c safety net concept**: Good defensive programming, just needs scoping to avoid conflicts
- **Federation label save/restore**: Correctly identified need to persist label across async federation responses
- **Verification plan**: Test cases 1-7 cover the right scenarios

---

## Audit Resolutions (2026-03-09)

### Resolution 1 — LIST: Per-Path Handling

LIST has four distinct code paths. Only the async iterator path needs special treatment; the rest are synchronous and can use the standard wrapping pattern.

**Sync paths** (LISTDELAY error, "already listing" cancel, specific channel names, sanity fail): wrap normally with `labeled_batch_start`/`labeled_batch_end` within `m_list()`. These all complete before `m_list()` returns.

**Async iterator path** (`m_list.c:415-424`): Open the batch manually and persist state in `ListingArgs`.

Changes:

1. **Extend `ListingArgs`** (channel.h): add `char batch_id[16]` field.

2. **In `m_list.c` async path** (~line 420), after allocating `ListingArgs`:
   ```c
   cli_listing(sptr)->batch_id[0] = '\0';  /* clear */
   if (MyConnect(sptr) && cli_label(sptr)[0] &&
       feature_bool(FEAT_CAP_labeled_response) &&
       CapActive(sptr, CAP_LABELEDRESP) && CapActive(sptr, CAP_BATCH)) {
     send_batch_start(sptr, "labeled-response");
     /* send_batch_start copies ID to cli_batch_id and attaches @label */
     ircd_strncpy(cli_listing(sptr)->batch_id, cli_batch_id(sptr),
                  sizeof(cli_listing(sptr)->batch_id) - 1);
   }
   list_next_channels(sptr);
   return 0;  /* batch stays open */
   ```

3. **In `hash.c` RPL_LISTEND path** (~line 502-507):
   ```c
   if (args->bucket >= HASHSIZE) {
     char saved_batch[16];
     ircd_strncpy(saved_batch, args->batch_id, sizeof(saved_batch) - 1);
     MyFree(cli_listing(cptr));
     cli_listing(cptr) = NULL;
     send_reply(cptr, RPL_LISTEND);          /* inside the batch */
     if (saved_batch[0] && has_active_batch(cptr))
       send_batch_end(cptr);                 /* close after LISTEND */
   }
   ```

4. **In `m_list.c` cancel path** (~line 382-391): If canceling a listing that had a batch open, close it before RPL_LISTEND:
   ```c
   if (cli_listing(sptr)) {
     if (cli_listing(sptr)->batch_id[0] && has_active_batch(sptr))
       send_batch_end(sptr);
     MyFree(cli_listing(sptr));
     cli_listing(sptr) = 0;
     send_reply(sptr, RPL_LISTEND);
     ...
   }
   ```

**Safety net scoping** (resolves Issue 4): The parse.c safety net must not close LIST's batch. See Resolution 4 below.

### Resolution 2 — Forwarded Commands: Two-Phase Fix

Investigation revealed that forwarded numeric responses go through `do_numeric()` → basic `sendcmdto_one()` (`s_numeric.c:97-99`), which does NOT call `format_message_tags_for_ex()`. Even if `cli_label` were preserved, relayed numerics would never pick up `@label`.

**Phase 1 (this plan):** Label-on-first-numeric for forwarded responses. Minimal, correct, matches graceful degradation behavior for clients without batch CAP.

1. **New Connection fields** (client.h):
   ```c
   char con_forwarded_label[64];      /* Label saved for hunt_server_cmd forwarding */
   unsigned char con_label_forwarded; /* Flag: forwarded response pending */
   ```
   With macros `cli_forwarded_label(cli)`, `cli_label_forwarded(cli)`.

2. **In forwarding handlers** (pattern for WHOIS, VERSION, MOTD, etc.):
   ```c
   int m_whois(...) {
     if (parc > 2) {
       /* Save label before forwarding — it will be cleared by next parse cycle */
       if (cli_label(sptr)[0]) {
         ircd_strncpy(cli_forwarded_label(sptr), cli_label(sptr),
                      sizeof(cli_forwarded_label(sptr)) - 1);
         cli_label_forwarded(sptr) = 1;
         cli_label_responded(sptr) = 1;  /* suppress ACK */
       }
       if (hunt_server_cmd(...) != HUNTED_ISME)
         return 0;  /* DO NOT wrap — response will arrive later */
       /* hunt_server_cmd returned HUNTED_ISME — handle locally */
       cli_label_forwarded(sptr) = 0;
       cli_forwarded_label(sptr)[0] = '\0';
     }
     /* Local response — use normal wrapping */
     int lb = labeled_batch_start(sptr);
     // ... existing logic ...
     if (lb) labeled_batch_end(sptr);
     return 0;
   }
   ```

3. **In `do_numeric()` relay path** (`s_numeric.c:97-99`): Check for forwarded label and use the tag-aware send function:
   ```c
   if (MyConnect(acptr) && cli_label_forwarded(acptr) &&
       cli_forwarded_label(acptr)[0]) {
     /* Restore label for this relay — first numeric picks it up */
     if (!cli_label(acptr)[0])
       ircd_strncpy(cli_label(acptr), cli_forwarded_label(acptr),
                    sizeof(cli_label(acptr)) - 1);
     cli_label_forwarded(acptr) = 0;
     cli_forwarded_label(acptr)[0] = '\0';
   }
   /* Use tag-aware send for local clients */
   if (MyConnect(acptr)) {
     sendcmdto_one_tags(src, num, acptr, NULL, "%C %s", acptr, parv[2]);
   } else {
     sendcmdto_one(src, num, num, acptr, "%C %s", acptr, parv[2]);
   }
   ```
   The first numeric picks up `@label` via `format_message_tags_for_ex()` (which sets `cli_label_responded = 1`). Subsequent numerics get no label — same behavior as graceful degradation.

4. **In `parse.c`**: No change to clearing logic. `cli_label` is cleared each cycle as before. `cli_forwarded_label` persists independently until consumed by `do_numeric()`.

**Phase 2 (future work):** Full batch wrapping for forwarded responses. Requires terminal-numeric detection table (mapping each forwarded command to its RPL_ENDOF* numeric). Open a labeled-response batch when forwarding, close when terminal numeric is relayed. Much more complex — defer.

### Resolution 3 — Missing Commands

Add to the wrapping table:

| Command | File | Function(s) | Notes |
|---------|------|-------------|-------|
| **WHOWAS** | m_whowas.c | `m_whowas` | RPL_WHOWASUSER/WHOISSERVER loop + RPL_ENDOFWHOWAS |
| **CHECK** | m_check.c | `mo_check` | RPL_CHECK* + RPL_ENDOFCHECK (oper-only) |
| **IRCOPS** | m_ircops.c | `m_ircops` | RPL_IRCOPS loop + RPL_ENDOFIRCOPS |
| **JOIN** | m_join.c | `m_join` | See Resolution 5 |

### Resolution 4 — Safety Net Scoping

Replace the generic `has_active_batch` check with a dedicated flag that only `labeled_batch_start` sets.

**New Connection field** (client.h):
```c
unsigned char con_labeled_batch;  /* 1 if labeled_batch_start opened a batch */
```
Macro: `cli_labeled_batch(cli)`.

**`labeled_batch_start()` sets** `cli_labeled_batch(sptr) = 1` on success.

**`labeled_batch_end()` clears** `cli_labeled_batch(sptr) = 0` after closing.

**parse.c safety net** (~line 1642):
```c
if (result != CPTR_KILLED) {
  if (cli_labeled_batch(cptr)) {
    labeled_batch_end(cptr);  /* closes batch + clears flag */
  }
  send_labeled_ack(cptr);
}
```

This is safe because:
- LIST's async batch is NOT opened via `labeled_batch_start` → flag not set → safety net ignores it
- CHATHISTORY's own batches don't use `cli_labeled_batch` → not affected
- Handlers that properly call `labeled_batch_end` clear the flag → safety net is a no-op
- Handlers that crash/error out without closing → safety net cleans up

### Resolution 5 — JOIN Wrapping

JOIN has a message-ordering complication: `do_join()` sends TOPIC, MARKREAD, and NAMES **before** `joinbuf_flush()` sends the JOIN echo. Within a labeled-response batch, this produces `BATCH+, TOPIC, NAMES, JOIN-echo, BATCH-`. Unconventional but spec-compliant — the batch groups "all messages resulting from your command."

For multi-channel JOIN (`JOIN #a,#b,#c`), the loop calls `do_join()` for each channel, then flushes all JOIN echoes together. The batch wraps everything.

**Implementation**: Standard wrapping in `m_join()`:
```c
int m_join(...) {
  int lb;
  // ... validation, early error returns (before multi-reply) ...
  lb = labeled_batch_start(sptr);
  joinbuf_init(&join, ...);
  joinbuf_init(&create, ...);
  for (...) do_join(...);
  joinbuf_flush(&join);
  joinbuf_flush(&create);
  if (lb) labeled_batch_end(sptr);
  return 0;
}
```

**Auto-replay interaction**: When JOIN triggers chathistory auto-replay, `send_history_batch()` creates a nested chathistory batch inside the labeled-response batch. Because `cli_batch_id` is set by `labeled_batch_start`, `format_message_tags_for_ex` adds `@batch=<lr-id>` to the chathistory `BATCH +start`, making it a proper nested batch. This is correct per spec.

The plan's instruction to "Pass NULL for auto-replay callers" remains correct — auto-replay should NOT put `@label` on its own BATCH +start (the label is on the outer labeled-response batch).

For non-bouncer users (`!IsAccount(sptr)`), TOPIC/NAMES are sent inside `do_join()` lines 291-299, before `joinbuf_flush`. The batch wrapping at the `m_join()` level still encompasses these since the batch is opened before `do_join()` is called.

### Resolution 6 — CHATHISTORY Federation Label: Direct Formatting

Avoid the fragile `cli_label` set/restore pattern. Instead, have `send_history_batch()` directly include `@label` in its `BATCH +start` message.

**In `send_history_batch()`** (~line 773-776), when label param is non-NULL:
```c
if (CapRecipientHas(sptr, CAP_BATCH)) {
  if (label && label[0] && CapRecipientHas(sptr, CAP_LABELEDRESP)) {
    sendrawto_one(sptr, "@label=%s :... BATCH +%s chathistory %s",
                  label, batchid, target);
    cli_label_responded(sptr) = 1;
  } else {
    sendcmdto_one(&me, CMD_BATCH_CMD, sptr, "+%s chathistory %s",
                  batchid, target);
  }
}
```

Using `sendrawto_one` with a hand-crafted `@label=` tag avoids relying on `cli_label` state. `cli_label_responded = 1` prevents the ACK from firing.

Similarly for `send_targets_batch()` with its `draft/chathistory-targets` batch type.

---

## Updated Files Modified

| File | Change |
|------|--------|
| `nefarious/ircd/send.c` | Add `labeled_batch_start()` / `labeled_batch_end()` with `cli_labeled_batch` flag |
| `nefarious/include/send.h` | Declare helpers |
| `nefarious/include/client.h` | Add `con_labeled_batch`, `con_forwarded_label[64]`, `con_label_forwarded` |
| `nefarious/include/channel.h` | Add `batch_id[16]` to `struct ListingArgs` |
| `nefarious/ircd/parse.c` | Safety net: scoped to `cli_labeled_batch` only |
| `nefarious/ircd/s_numeric.c` | Use tag-aware send for local clients + forwarded label restore |
| `nefarious/ircd/hash.c` | Close LIST batch before RPL_LISTEND |
| `nefarious/ircd/m_chathistory.c` | Direct `@label` formatting in BATCH +start, federation label save |
| `nefarious/ircd/m_list.c` | Per-path handling: sync paths use wrapping, async uses manual batch |
| `nefarious/ircd/m_join.c` | Labeled batch wrapping around do_join loop + joinbuf_flush |
| `nefarious/ircd/m_whois.c` | Conditional wrapping: save label before hunt_server_cmd, wrap local path |
| `nefarious/ircd/m_version.c` | Same pattern as m_whois for forwarding |
| `nefarious/ircd/m_whowas.c` | Standard labeled batch wrapping |
| `nefarious/ircd/m_check.c` | Standard labeled batch wrapping |
| `nefarious/ircd/m_ircops.c` | Standard labeled batch wrapping |
| All other `m_*.c` from original plan | Standard labeled batch wrapping (unchanged from plan) |

## Updated Verification

1. `@label=t1 CHATHISTORY LATEST #ch * 10` → `@label=t1` on BATCH +chathistory, no ACK
2. `@label=t2 WHOIS nick` → `@label=t2` on BATCH +labeled-response, numerics with @batch=
3. `@label=t3 WHO #ch` → same pattern
4. `@label=t4 PONG :x` → ACK only (no batch)
5. `@label=t5 PRIVMSG #ch :hi` → `@label=t5` on echo-message directly
6. Federation CHATHISTORY → label on BATCH +start via sendrawto_one, no spurious ACK
7. Client without batch cap → label on first reply (graceful degradation)
8. `@label=t6 LIST` → `@label=t6` on BATCH +labeled-response, RPL_LIST entries with @batch=, batch closed after RPL_LISTEND (async)
9. `@label=t7 LIST STOP` (while listing) → previous async batch closed, new labeled batch wraps RPL_LISTEND
10. `@label=t8 WHOIS remotenick remoteserver` → no batch, @label=t8 on first relayed numeric (311)
11. `@label=t9 JOIN #newchan` → `@label=t9` on BATCH +labeled-response containing JOIN echo + TOPIC + NAMES
12. `@label=t10 JOIN #chan` (with auto-replay) → labeled-response batch wrapping nested chathistory batch
13. `@label=t11 WHOWAS oldnick` → `@label=t11` on BATCH +labeled-response

---

## Implementation Status (2026-03-09)

### Phase 1: Core Infrastructure (stateful-roaming-sphinx) ✅

| Component | Status | Notes |
|-----------|--------|-------|
| `labeled_batch_start()`/`labeled_batch_end()` in send.c/send.h | ✅ | |
| `con_labeled_batch` flag in client.h | ✅ | |
| parse.c safety net (scoped to `cli_labeled_batch`) | ✅ | |
| LIST: `batch_id[16]` in ListingArgs (channel.h) | ✅ | |
| LIST: m_list.c per-path handling (4 paths) | ✅ | LISTDELAY, cancel, async, channel names |
| LIST: hash.c RPL_LISTEND batch close | ✅ | |
| JOIN: m_join.c wrapping | ✅ | Around joinbuf_init/do_join/flush |
| CHATHISTORY: label param on send_history_batch/send_targets_batch | ✅ | Direct @label formatting |
| CHATHISTORY: FedRequest.label[64] + federation plumbing | ✅ | All ~11 call sites updated |
| Per-command wrapping (20+ commands) | ✅ | All m_*.c files from plan table |

### Phase 2: Forwarded Commands (warm-hopping-floyd / Resolution 2 replacement) ✅

**Approach changed**: Instead of Phase 1 label-on-first-numeric (Resolution 2), implemented full batch wrapping using compact S2S tag correlation — the "Phase 2" design from the plan.

| Component | Status | Notes |
|-----------|--------|-------|
| ForwardedLabel struct + state machine in client.h | ✅ | EMPTY→PENDING→ACTIVE→DRAINING→EMPTY |
| forwarded_label.h declarations | ✅ | NEW FILE |
| forwarded_label.c implementation | ✅ | NEW FILE; terminal table, save/find/open/close/cleanup |
| forwarded_label.c in Makefile.in | ✅ | |
| send.c: fwd_batch_id_override + sendcmdto_set_fwd_batch | ✅ | Override takes priority over cli_batch_id |
| send.c: s2s_msgid/time overrides + sendcmdto_set_s2s_tags | ✅ | |
| send.c: format_s2s_tags() made non-static | ✅ | For ircd_reply.c access |
| ircd_reply.c: send_reply() compact tag echo for remote recipients | ✅ | |
| s_user.c: fwd_label_save in hunt_server_cmd + hunt_server_prio_cmd | ✅ | |
| s_numeric.c: do_numeric() forwarded label interception | ✅ | Open batch, tag numerics, detect terminal |
| s_numeric.c: remote client compact tag relay | ✅ | |
| parse.c: fwd_label_close_draining at parse_client start | ✅ | |
| ircd_relay.c: NOTICE interception in server_relay_private_notice | ✅ | DRAINING batch wrapping for trailing NOTICEs |
| m_lusers.c: trailing NOTICE compact tag echo (ms_lusers) | ✅ | |
| m_version.c: trailing NOTICE compact tag echo (ms_version) | ✅ | |
| s_misc.c: fwd_label_cleanup in exit_one_client | ✅ | |

### Remaining Work

- [ ] **Build verification**: `docker compose --profile linked up -d --build --no-deps nefarious nefarious2`
- [ ] **Test verification**: Run labeled-response verification tests from Updated Verification section
