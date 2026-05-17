# Chathistory Federation & Quality Fixes

## Context

When a message originates on server A, it gets a locally-generated msgid
(`A-<startup>-<counter>`). When relayed to server B via P10, server B generates
a **new** msgid (`B-<startup>-<counter>`) for its own history storage. The same
message is now stored with different msgids on each server.

`FEAT_P10_MESSAGE_TAGS` already propagates `@time=...;msgid=...` through P10 —
the originating server's values arrive in `cli_s2s_msgid(cli_from(sptr))`. But
the storage code in `server_relay_channel_message/notice` ignores these tags and
always generates fresh local msgids.

This causes duplicate messages when `CHATHISTORY` federation queries merge
results from multiple servers. The current workaround is semantic dedup in
`message_exists()` ([m_chathistory.c:2726](nefarious/ircd/m_chathistory.c#L2726))
which compares timestamp+sender+type+content. Exact msgid dedup (line 2721)
would be more reliable if all servers stored the same msgid.

## Implementation

### 1. Channel relay: use S2S msgid when available (ircd_relay.c)

In `server_relay_channel_message()` (line 738) and `server_relay_channel_notice()`
(line 804), replace the local msgid generation with S2S-preferring logic.

**Important**: Use `one` (saved at line 711 before alias source rewriting)
instead of `cli_from(sptr)`. After alias rewriting at line 720, `sptr` becomes
the primary and `cli_from(sptr)` would be the primary's own connection (no S2S
tags). `one` always holds the original server link.

```c
#ifdef USE_MDBX
    if (feature_bool(FEAT_MSGID)) {
      char msgid[64];
      char timestamp[32];
      const char *s2s_mid = NULL;

      /* Prefer originating server's msgid from S2S tags (P10_MESSAGE_TAGS).
       * All servers store the same msgid -> exact dedup in federation. */
      if (feature_bool(FEAT_P10_MESSAGE_TAGS) && one
          && cli_s2s_msgid(one)[0])
        s2s_mid = cli_s2s_msgid(one);

      if (s2s_mid) {
        ircd_strncpy(msgid, s2s_mid, sizeof(msgid));
      } else {
        ircd_snprintf(0, msgid, sizeof(msgid), "%s-%lu-%lu",
                      cli_yxx(&me), (unsigned long)cli_firsttime(&me),
                      ++MsgIdCounter);
      }

      /* Timestamp: always use local time for storage ordering.
       * S2S time is ISO 8601 but storage uses unix.ms -- converting
       * isn't worth it since dedup keys on msgid, not timestamp. */
      struct timeval tv;
      gettimeofday(&tv, NULL);
      ircd_snprintf(0, timestamp, sizeof(timestamp), "%lu.%03lu",
                    (unsigned long)tv.tv_sec,
                    (unsigned long)(tv.tv_usec / 1000));

      store_channel_history(sptr, chptr, text, HISTORY_PRIVMSG, msgid, timestamp);
    }
#endif
```

Apply the same pattern to `server_relay_channel_notice()` (HISTORY_NOTICE).

### 2. Private message relay: same fix (ircd_relay.c)

`server_relay_private_message()` (line 1384) and `server_relay_private_notice()`
(line 1459) also generate fresh msgids via `generate_msgid()`. These need the
same S2S msgid preservation for PM dedup in federation.

The PM relay functions save the original sender as `from = sptr` before alias
rewriting. Use `cli_from(from)` (or save `cli_from(sptr)` before rewriting, as
the channel functions do with `one`) to access S2S tags:

```c
  /* Generate shared msgid + timestamp for alias forwarding and history */
  pm_msgid[0] = '\0';
  pm_timestamp[0] = '\0';
  if (feature_bool(FEAT_MSGID)) {
    const char *s2s_mid = NULL;
    struct timeval tv;

    /* Prefer S2S msgid for federation dedup */
    if (feature_bool(FEAT_P10_MESSAGE_TAGS) && cli_from(sptr)
        && cli_s2s_msgid(cli_from(sptr))[0])
      s2s_mid = cli_s2s_msgid(cli_from(sptr));

    if (s2s_mid) {
      ircd_strncpy(pm_msgid, s2s_mid, sizeof(pm_msgid));
    } else {
      generate_msgid(pm_msgid, sizeof(pm_msgid));
    }

    gettimeofday(&tv, NULL);
    ircd_snprintf(0, pm_timestamp, sizeof(pm_timestamp), "%lu.%03lu",
                  (unsigned long)tv.tv_sec,
                  (unsigned long)(tv.tv_usec / 1000));
  }
```

**Note**: In PM relay functions, the S2S tag check must happen BEFORE alias
rewriting (which changes `from` to the primary). The original `sptr` still
has the correct `cli_from()` at that point since the alias rewriting block
comes first (line 1366) and changes `from` not `sptr`. Verify this is still
the case — if `sptr` is never reassigned, `cli_from(sptr)` remains correct.

### 3. P10 tag skip patches (nefarious-upstream + upstream X3)

Our modernized X3 fork already has this at
[proto-p10.c:3865-3870](x3/src/proto-p10.c#L3865-L3870). Both the upstream
nefarious build and the **upstream X3** (`upstream/bouncer-transfer` branch)
need the same patch — upstream X3 is the version that will actually ship (our
modernized fork serves as the base for the eventual X3-into-nefarious merge).

**Nefarious-upstream**: 6-line patch in `parse_server()` at
[parse.c:1371](nefarious-upstream/ircd/parse.c#L1371), after the `IsDead`
check and before `para[0]`:

```c
  /* Skip P10 message tags if present (compat with tag-aware servers) */
  if (*ch == '@') {
    ch = strchr(ch, ' ');
    if (!ch)
      return -1;
    while (*ch == ' ')
      ch++;
  }
```

Doesn't parse or store tags — just skips the `@...` prefix so the parser
reaches the source numeric correctly. Required for mixed-version networks
where some servers send P10 tags and others don't understand them.

**Upstream X3**: Same pattern in the P10 parser (`proto-p10.c`), before the
`split_line()` call. The upstream X3 `bouncer-transfer` branch needs this
to coexist with tag-aware nefarious servers.

### 4. Config enablement

Enable in all `ircd*.conf`:
```
"P10_MESSAGE_TAGS" = "TRUE";
```

## Files Modified

| File | Change |
|------|--------|
| [ircd_relay.c](nefarious/ircd/ircd_relay.c#L738) | S2S msgid in `server_relay_channel_message` |
| [ircd_relay.c](nefarious/ircd/ircd_relay.c#L804) | S2S msgid in `server_relay_channel_notice` |
| [ircd_relay.c](nefarious/ircd/ircd_relay.c#L1384) | S2S msgid in `server_relay_private_message` |
| [ircd_relay.c](nefarious/ircd/ircd_relay.c#L1459) | S2S msgid in `server_relay_private_notice` |
| [parse.c](nefarious-upstream/ircd/parse.c#L1371) | 6-line tag skip in nefarious-upstream `parse_server()` |
| upstream X3 `proto-p10.c` | Same tag skip in upstream X3 P10 parser |
| `data/ircd*.conf` | Enable `P10_MESSAGE_TAGS = TRUE` |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2789) | Fix `merge_messages()` sort direction (`<` to `>`) |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L1537) | Add `cleanup_cb` field to `FedRequest` struct |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2647) | `free_fed_request()`: use `cleanup_cb` for cb_data |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L1325) | `chathistory_targets()`: over-fetch, federation, `send_targets_batch()` |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L3416) | `ms_chathistory()` Q handler: add 'T' case before channel check |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L3493) | `ms_chathistory()` response handlers: add 'T' handler |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c) | New: `TargetsFedContext`, `should_federate_targets()`, `start_fed_targets_query()`, `add_fed_target()`, `merge_targets()`, `send_targets_batch()`, `complete_targets_fed()`, `cleanup_targets_context()` |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L1999) | Replace `channels[]` in ChathistoryAd with bloom filter fields |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2111) | `server_advertises_channel()`: bloom probe replaces linear search |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2388) | `send_channel_advertisements()`: send CH A B instead of CH A F |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L3752) | CH A handlers: bloom filter parsing replaces channel list parsing |
| [ircd_features.c](nefarious/ircd/ircd_features.c) | Add `FEAT_CHATHISTORY_BLOOM_SIZE`, `FEAT_CHATHISTORY_BLOOM_HASHES` |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L3357) | Q handler: dest_numeric forwarding for multi-hop |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2932) | `count_storage_servers()`: iterate `server_ads[]` instead of `->down` |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L3061) | `start_fed_query()`: iterate `server_ads[]`, append dest_numeric |

---

## Bug: Federation merge returns wrong order

### Root Cause

`merge_messages()` at [m_chathistory.c:2778-2789](nefarious/ircd/m_chathistory.c#L2778)
sorts **descending** (newest-first):

```c
/* Sort descending by timestamp (newest first) */
if (strcmp(a->timestamp, b->timestamp) < 0) {
```

When `a` is older (smaller timestamp), `strcmp < 0` triggers a swap, pushing
newer messages to the head. The result is newest-first. But the IRCv3 spec
requires chronological (oldest-first) for ALL subcommands:

> Returned messages MUST be in chronological order.

The local (non-federated) path is correct — `history_query_internal()` uses
prepend-during-backward-iteration for BEFORE/LATEST, producing chronological
order. Only the federation merge path is wrong.

### Impact

Any federated `CHATHISTORY` query (BEFORE, AFTER, LATEST, AROUND) returns
messages in reverse order. This caused duplicate messages and reversed display
in HexChat (which assumed spec-compliant ordering for pagination).

### Fix

One-character change in `merge_messages()`:

```c
/* Sort ascending by timestamp (chronological, per IRCv3 spec) */
if (strcmp(a->timestamp, b->timestamp) > 0) {
```

Change `< 0` to `> 0`. Update the comment to say ascending/chronological.

---

## CHATHISTORY TARGETS: Federation & Quality Fixes

TARGETS exists and is functional ([m_chathistory.c:1325-1405](nefarious/ircd/m_chathistory.c#L1325)),
with a dedicated MDBX `targets` database (key=target name, value=last timestamp).
Three quality issues plus missing federation support.

### Known Issues

**Issue 1 — No recency sort**: IRCv3 spec requires TARGETS sorted by last-message
timestamp (most recent first). Current implementation iterates MDBX in key order
(alphabetical by target name). No sort step exists.

**Issue 2 — No federation**: Unlike BEFORE/AFTER/LATEST, TARGETS queries local
MDBX only. A user on a leaf server won't see channels/PMs whose history lives
only on the hub. The S2S mapping character `T` exists in `subcmd_to_s2s()` (line
375/389), but `chathistory_targets()` never calls `start_fed_query()`, and the
`ms_chathistory()` Q handler has no `'T'` case — it falls through to "unsupported"
and returns `CH E <reqid> 0`. Write forwarding doesn't help here — it's for
relay-only servers (`STORE=FALSE`) that don't store history at all. Servers that
do store each have their own partial view of targets.

**Issue 3 — Pre-filter limit**: The MDBX scan loop stops at `limit` results
([history.c:1602](nefarious/ircd/history.c#L1602)), but `check_history_access()`
in [m_chathistory.c:1379](nefarious/ircd/m_chathistory.c#L1379) further filters
results. Client can get fewer than `limit` results even though more qualifying
targets exist in MDBX.

### Design Approach

**Core insight**: The federation pipeline (FedRequest → S2S → accumulator → merge
→ completion) is built around `HistoryMessage` linked lists, but the existing
`completion_cb` + `cb_data` pattern (used by federated REDACT at line 3118) gives
us a clean extension point. We store TARGETS-specific state in `cb_data`, use a
custom completion callback for the merge+send step, and add a new `CH T` S2S
response type alongside CH R/Z/B. No restructuring of the core pipeline needed.

All three issues are fixed by the same refactoring: extract response sending into
`send_targets_batch()` which sorts by recency, applies access filtering, and
enforces the limit post-filter. Both the local-only and federated paths converge
on this function.

### S2S Wire Format

**Query** (reuses existing `CH Q` frame):
```
CH Q * T <ts1>,<ts2> <limit> <reqid>
```
- Target: `*` (TARGETS queries all targets, not a specific channel)
- Subcmd: `T`
- Ref: Dual timestamp, comma-separated (both Unix format: `seconds.milliseconds`)
- `ts1` is the earlier timestamp; comma separates from `ts2`

**Response** (new type `CH T` alongside R/Z/B):
```
CH T <reqid> <target> <last_timestamp>
```
- One line per target. No compression needed (targets are tiny).
- `target`: Channel name or PM target identifier
- `last_timestamp`: Unix format (`seconds.milliseconds`)

**End marker**: Reuses existing `CH E <reqid> <count>`.

### Data Structures

**TargetsFedContext** — stored in `FedRequest.cb_data`:
```c
struct TargetsFedContext {
  struct HistoryTarget *local_targets;   /* Local MDBX results */
  struct HistoryTarget *fed_targets;     /* Accumulated federated results */
  int local_count;
  int fed_count;
};
```

**FedRequest addition** — one new field for proper cleanup:
```c
struct FedRequest {
  /* ... existing fields ... */
  void (*cleanup_cb)(void *cb_data);  /**< Custom cleanup for cb_data (NULL = MyFree) */
};
```

The `cleanup_cb` lets TARGETS free inner linked lists before freeing the context
struct. REDACT's `cb_data` (which has no dynamic allocations) continues to use
the default `MyFree` path when `cleanup_cb` is NULL.

### New Functions

#### `should_federate_targets()` — Federation decision

```c
static int should_federate_targets(int local_count, int limit)
{
  if (!feature_bool(FEAT_CHATHISTORY_FEDERATION))
    return 0;
  if (local_count >= limit)
    return 0;  /* Local DB satisfied the request */
  if (count_storage_servers(NULL, 0) == 0)
    return 0;  /* No storage servers to query */
  return 1;
}
```

Passing `NULL` as target to `count_storage_servers()` skips the channel-level
advertisement filter (line 2953: `if (target && ...)`), since TARGETS has no
single target channel.

#### `start_fed_targets_query()` — Initiate TARGETS federation

Dedicated function (not shoehorned into `start_fed_query()`) because the
parameter types are fundamentally different: dual timestamps instead of single
ref, `HistoryTarget *` instead of `HistoryMessage *`, `*` as target, no channel
advertisement filtering.

```c
static struct FedRequest *start_fed_targets_query(
  struct Client *sptr,
  const char *ts1, const char *ts2,
  int limit,
  struct HistoryTarget *local_targets,
  int local_count)
{
  struct FedRequest *req;
  struct TargetsFedContext *ctx;
  char reqid[32];
  char s2s_ref[64];
  int i, server_count;
  struct DLink *lp;

  server_count = count_storage_servers(NULL, 0);
  if (server_count == 0)
    return NULL;

  /* Find empty slot */
  for (i = 0; i < MAX_FED_REQUESTS; i++) {
    if (!fed_requests[i])
      break;
  }
  if (i >= MAX_FED_REQUESTS)
    return NULL;

  /* Build S2S dual-timestamp ref: <ts1>,<ts2> */
  ircd_snprintf(0, s2s_ref, sizeof(s2s_ref), "%s,%s", ts1, ts2);

  /* Generate request ID */
  ircd_snprintf(0, reqid, sizeof(reqid), "%s%lu",
                cli_yxx(&me), ++fed_reqid_counter);

  /* Create context for targets accumulation */
  ctx = (struct TargetsFedContext *)MyCalloc(1, sizeof(struct TargetsFedContext));
  ctx->local_targets = local_targets;
  ctx->local_count = local_count;

  /* Create request */
  req = (struct FedRequest *)MyCalloc(1, sizeof(struct FedRequest));
  ircd_strncpy(req->reqid, reqid, sizeof(req->reqid) - 1);
  req->target[0] = '*';
  req->target[1] = '\0';
  ircd_snprintf(0, req->client_yxx, sizeof(req->client_yxx), "%s%s",
                cli_yxx(cli_user(sptr)->server), cli_yxx(sptr));
  req->servers_pending = server_count;
  req->start_time = CurrentTime;
  req->limit = limit;
  req->completion_cb = complete_targets_fed;
  req->cb_data = ctx;
  req->cleanup_cb = cleanup_targets_context;

  fed_requests[i] = req;

  /* Set timeout timer */
  timer_add(timer_init(&req->timer), fed_timeout_callback,
            (void *)req, TT_RELATIVE,
            feature_int(FEAT_CHATHISTORY_TIMEOUT));
  req->timer_active = 1;

  /* Send query to storage servers */
  for (lp = cli_serv(&me)->down; lp; lp = lp->next) {
    struct Client *server = lp->value.cptr;
    if (is_ulined_server(server))
      continue;
    if (!has_chathistory_advertisement(server))
      continue;
    sendcmdto_one(&me, CMD_CHATHISTORY, server, "Q * T %s %d %s",
                  s2s_ref, limit, reqid);
  }

  return req;
}
```

No retention filtering for TARGETS queries — the timestamp range in the ref
specifies the window of interest, and remote servers filter internally via
`history_query_targets()`.

#### `add_fed_target()` — Accumulate CH T responses

```c
static void add_fed_target(struct FedRequest *req, const char *target,
                           const char *last_timestamp)
{
  struct TargetsFedContext *ctx;
  struct HistoryTarget *tgt;

  if (!req || !req->cb_data)
    return;

  ctx = (struct TargetsFedContext *)req->cb_data;

  tgt = (struct HistoryTarget *)MyCalloc(1, sizeof(struct HistoryTarget));
  ircd_strncpy(tgt->target, target, sizeof(tgt->target) - 1);
  ircd_strncpy(tgt->last_timestamp, last_timestamp,
               sizeof(tgt->last_timestamp) - 1);

  /* Prepend to list (order doesn't matter pre-merge) */
  tgt->next = ctx->fed_targets;
  ctx->fed_targets = tgt;
  ctx->fed_count++;
}
```

#### `merge_targets()` — Dedup + sort

```c
static struct HistoryTarget *merge_targets(struct HistoryTarget *local,
                                            struct HistoryTarget *remote)
{
  struct HistoryTarget *result = NULL, *tail = NULL;
  struct HistoryTarget *tgt, *next, *existing;

  /* 1. Start with copies of all local targets */
  for (tgt = local; tgt; tgt = tgt->next) {
    struct HistoryTarget *copy = MyCalloc(1, sizeof(struct HistoryTarget));
    memcpy(copy, tgt, sizeof(struct HistoryTarget));
    copy->next = NULL;
    if (tail) { tail->next = copy; tail = copy; }
    else { result = tail = copy; }
  }

  /* 2. Merge remote targets: dedup by target name, keep latest timestamp */
  for (tgt = remote; tgt; tgt = tgt->next) {
    existing = NULL;
    for (struct HistoryTarget *r = result; r; r = r->next) {
      if (ircd_strcmp(r->target, tgt->target) == 0) {
        existing = r;
        break;
      }
    }
    if (existing) {
      /* Keep the later timestamp */
      if (strcmp(tgt->last_timestamp, existing->last_timestamp) > 0)
        ircd_strncpy(existing->last_timestamp, tgt->last_timestamp,
                     sizeof(existing->last_timestamp) - 1);
    } else {
      struct HistoryTarget *copy = MyCalloc(1, sizeof(struct HistoryTarget));
      memcpy(copy, tgt, sizeof(struct HistoryTarget));
      copy->next = NULL;
      if (tail) { tail->next = copy; tail = copy; }
      else { result = tail = copy; }
    }
  }

  /* 3. Sort descending by last_timestamp (most recent first).
   * Bubble sort — target lists are small (capped by limit * over-fetch). */
  if (result && result->next) {
    int swapped;
    do {
      swapped = 0;
      struct HistoryTarget **pp = &result;
      while ((*pp)->next) {
        struct HistoryTarget *a = *pp;
        struct HistoryTarget *b = a->next;
        if (strcmp(a->last_timestamp, b->last_timestamp) < 0) {
          a->next = b->next;
          b->next = a;
          *pp = b;
          swapped = 1;
        }
        pp = &((*pp)->next);
      }
    } while (swapped);
    /* Fix tail pointer after sort */
    for (tail = result; tail->next; tail = tail->next) ;
  }

  return result;
}
```

No limit truncation here — `send_targets_batch()` handles limit + access filtering.

#### `send_targets_batch()` — Extracted response sender (fixes Issues 1 + 3)

Replaces the inline response loop in `chathistory_targets()`. Used by both the
local-only path and the federated completion callback.

```c
static void send_targets_batch(struct Client *sptr, struct HistoryTarget *targets,
                               int limit)
{
  char batchid[BATCH_ID_LEN];
  char iso_time[32];
  const char *time_str;
  int sent = 0;

  generate_batch_id(batchid, sizeof(batchid), sptr);

  if (CapRecipientHas(sptr, CAP_BATCH))
    sendcmdto_one(&me, CMD_BATCH_CMD, sptr, "+%s draft/chathistory-targets",
                  batchid);

  for (struct HistoryTarget *tgt = targets; tgt && sent < limit; tgt = tgt->next) {
    /* Access filter — skip targets the client can't read */
    if (check_history_access(sptr, tgt->target, NULL, 0) != 0)
      continue;

    if (history_unix_to_iso(tgt->last_timestamp, iso_time, sizeof(iso_time)) == 0)
      time_str = iso_time;
    else
      time_str = tgt->last_timestamp;

    if (CapRecipientHas(sptr, CAP_BATCH))
      sendrawto_one(sptr, "@batch=%s :%s!%s@%s CHATHISTORY TARGETS %s timestamp=%s",
                    batchid, cli_name(&me), "chathistory", cli_name(&me),
                    tgt->target, time_str);
    else
      sendrawto_one(sptr, ":%s!%s@%s CHATHISTORY TARGETS %s timestamp=%s",
                    cli_name(&me), "chathistory", cli_name(&me),
                    tgt->target, time_str);
    sent++;
  }

  if (CapRecipientHas(sptr, CAP_BATCH))
    sendcmdto_one(&me, CMD_BATCH_CMD, sptr, "-%s", batchid);
}
```

Fixes Issue 3: `sent` only increments for accessible targets, so the limit
applies post-filter. The input list is pre-sorted by recency (from
`merge_targets()` or local sort), fixing Issue 1.

#### `complete_targets_fed()` — Federation completion callback

```c
static void complete_targets_fed(struct FedRequest *req)
{
  struct TargetsFedContext *ctx;
  struct HistoryTarget *merged;
  struct Client *client;

  if (!req || req->response_sent || !req->cb_data)
    return;

  req->response_sent = 1;

  client = findNUser(req->client_yxx);
  if (!client)
    return;  /* Client disconnected */

  ctx = (struct TargetsFedContext *)req->cb_data;

  /* Merge local + federated targets (dedup + sort by recency) */
  merged = merge_targets(ctx->local_targets, ctx->fed_targets);

  /* Send to client with access filtering and limit enforcement */
  send_targets_batch(client, merged, req->limit);

  history_free_targets(merged);
}
```

#### `cleanup_targets_context()` — Custom cb_data cleanup

```c
static void cleanup_targets_context(void *data)
{
  struct TargetsFedContext *ctx = (struct TargetsFedContext *)data;
  if (!ctx)
    return;
  if (ctx->local_targets)
    history_free_targets(ctx->local_targets);
  if (ctx->fed_targets)
    history_free_targets(ctx->fed_targets);
  MyFree(ctx);
}
```

### Changes to Existing Functions

#### `free_fed_request()` — Use cleanup_cb ([m_chathistory.c:2647](nefarious/ircd/m_chathistory.c#L2647))

```c
  /* Free custom callback data */
  if (req->cb_data) {
    if (req->cleanup_cb)
      req->cleanup_cb(req->cb_data);
    else
      MyFree(req->cb_data);
    req->cb_data = NULL;
  }
```

Replaces the existing `MyFree(req->cb_data)` at line 2662. REDACT's `cb_data`
(no inner allocations) continues to use the default `MyFree` path since its
`cleanup_cb` is NULL.

#### `chathistory_targets()` — Add federation + use send_targets_batch ([m_chathistory.c:1325](nefarious/ircd/m_chathistory.c#L1325))

Replace the inline response loop (lines 1360-1402) with:

```c
  /* Over-fetch from MDBX to compensate for post-query access filtering */
  int fetch_limit = limit * 3;
  if (fetch_limit > 500)
    fetch_limit = 500;

  count = history_query_targets(ts1, ts2, fetch_limit, &targets);
  if (count < 0) {
    send_fail(sptr, "CHATHISTORY", "MESSAGE_ERROR", "*",
              "Failed to retrieve targets");
    return 0;
  }

  /* Federation decision: if local didn't fill the request, ask storage servers */
  if (should_federate_targets(count, limit)) {
    struct FedRequest *req = start_fed_targets_query(sptr, ts1, ts2, limit,
                                                      targets, count);
    if (req)
      return 0;  /* Deferred — response sent asynchronously by complete_targets_fed */
    /* Federation failed to start — fall through to local-only response.
     * targets ownership stays with us (not transferred to FedRequest). */
  }

  /* Local-only path: sort by recency and send */
  struct HistoryTarget *sorted = merge_targets(targets, NULL);
  send_targets_batch(sptr, sorted, limit);
  history_free_targets(sorted);
  history_free_targets(targets);

  return 0;
```

**Ownership semantics**: When federation starts, `targets` is transferred into
`TargetsFedContext.local_targets` and freed by `cleanup_targets_context()`. When
federation doesn't start, `targets` stays owned by this function.

The local-only path calls `merge_targets(targets, NULL)` which copies + sorts
(returning a new list). Both the sorted copy and the original are freed.

#### `ms_chathistory()` Q handler — Add 'T' case ([m_chathistory.c:3416](nefarious/ircd/m_chathistory.c#L3416))

Insert **before** the `!IsChannelName(target)` check at line 3416, since TARGETS
uses `*` as target which would be rejected by that check:

```c
    /* TARGETS: handle before channel check (uses * as target) */
    if (parv[3][0] == 'T') {
      struct HistoryTarget *targets = NULL;
      struct HistoryTarget *tgt;
      char *comma;
      char ts1_buf[HISTORY_TIMESTAMP_LEN], ts2_buf[HISTORY_TIMESTAMP_LEN];
      int tgt_count;

      if (!history_is_available()) {
        sendcmdto_one(&me, CMD_CHATHISTORY, sptr, "E %s 0", reqid);
        return 0;
      }

      /* Parse dual timestamp from ref: <ts1>,<ts2> */
      comma = strchr(ref, ',');
      if (!comma) {
        sendcmdto_one(&me, CMD_CHATHISTORY, sptr, "E %s 0", reqid);
        return 0;
      }
      *comma = '\0';
      ircd_strncpy(ts1_buf, ref, sizeof(ts1_buf) - 1);
      ircd_strncpy(ts2_buf, comma + 1, sizeof(ts2_buf) - 1);
      *comma = ',';  /* Restore for propagation */

      /* Over-fetch to give originating server room for access filtering */
      int fetch_limit = limit * 3;
      if (fetch_limit > 500)
        fetch_limit = 500;

      tgt_count = history_query_targets(ts1_buf, ts2_buf, fetch_limit, &targets);
      if (tgt_count <= 0) {
        sendcmdto_one(&me, CMD_CHATHISTORY, sptr, "E %s 0", reqid);
        return 0;
      }

      /* Send CH T responses */
      for (tgt = targets; tgt; tgt = tgt->next) {
        sendcmdto_one(&me, CMD_CHATHISTORY, sptr, "T %s %s %s",
                      reqid, tgt->target, tgt->last_timestamp);
      }

      /* End marker */
      sendcmdto_one(&me, CMD_CHATHISTORY, sptr, "E %s %d", reqid, tgt_count);
      history_free_targets(targets);
      return 0;
    }

    /* Only process for channels (not PMs) — existing check */
    if (!IsChannelName(target)) {
```

No access filtering on the remote side — the originating server does all filtering
in `send_targets_batch()`. The remote server just returns all targets matching the
timestamp range. This is intentional: the remote server doesn't know which channels
the requesting client is in.

#### `ms_chathistory()` response handlers — Add 'T' handler ([m_chathistory.c:3493](nefarious/ircd/m_chathistory.c#L3493))

Add alongside the existing R/Z/B/E handlers:

```c
  else if (strcmp(subcmd, "T") == 0) {
    /* Target Response: T <reqid> <target> <last_timestamp> */
    char *reqid, *target, *last_timestamp;
    struct FedRequest *req;

    if (parc < 5)
      return 0;

    reqid = parv[2];
    target = parv[3];
    last_timestamp = parv[4];

    req = find_fed_request(reqid);
    if (!req)
      return 0;

    add_fed_target(req, target, last_timestamp);
  }
```

The `CH E` handler (line 3671) already handles all request types — no changes
needed. When `servers_pending` reaches 0, `complete_fed_request()` calls
`req->completion_cb` which is `complete_targets_fed()`.

#### `history_query_targets()` — Accept larger limits ([history.c:1554](nefarious/ircd/history.c#L1554))

No code change needed in this function — the caller now passes `limit * 3`
(capped at 500) instead of the client's requested limit. The function already
respects whatever limit is passed.

### Control Flow Summary

**Local-only path** (federation disabled or local DB satisfies request):
```
chathistory_targets()
  → history_query_targets(ts1, ts2, limit*3)  [over-fetch]
  → should_federate_targets() → NO
  → merge_targets(local, NULL)                [sort by recency]
  → send_targets_batch(sptr, sorted, limit)   [access filter + limit]
```

**Federated path**:
```
chathistory_targets()
  → history_query_targets(ts1, ts2, limit*3)
  → should_federate_targets() → YES
  → start_fed_targets_query()
      → count_storage_servers(NULL, 0)
      → send CH Q * T <ts1>,<ts2> <limit> <reqid> to storage servers
      → return FedRequest (deferred)
  → return 0 immediately

  [async: remote servers process query]
  ms_chathistory() Q handler 'T' case:
      → history_query_targets(ts1, ts2, limit*3)
      → send CH T <reqid> <target> <ts> for each target
      → send CH E <reqid> <count>

  [async: responses arrive]
  ms_chathistory() T handler:
      → find_fed_request(reqid)
      → add_fed_target(req, target, timestamp)

  ms_chathistory() E handler:
      → req->servers_pending--
      → if 0: complete_fed_request(req)
          → complete_targets_fed(req)             [completion_cb]
              → merge_targets(local, federated)   [dedup + sort]
              → send_targets_batch(client, merged, limit)
              → history_free_targets(merged)

  [cleanup: timer ET_DESTROY]
  fed_timeout_callback()
      → free_fed_request(req)
          → cleanup_targets_context(cb_data)      [frees local + fed target lists]
```

### Multi-Hop Federation Fix: Destination-Addressed Queries

**Problem**: In a 3+ hop topology (A → B → C), federation is broken. The
failure mode:

1. **A** calls `start_fed_query()` → `count_storage_servers()` iterates
   `cli_serv(&me)->down` (direct links only) → counts B, sets `servers_pending=1`
   → sends `CH Q` to B only
2. **B** receives Q → propagation block (lines 3380-3413) forwards Q to C →
   B processes locally, sends `CH R`/`CH E` back to A
3. **C** receives Q from B → processes locally → sends `CH R`/`CH E` to B
   (its direct link, since `sptr` in ms_chathistory is B)
4. **B** receives C's response → `find_fed_request(reqid)` returns NULL (B
   didn't originate this query) → **response silently dropped** at line 3686
5. **A** gets B's response, `servers_pending` hits 0, request completes.
   C's data is lost.

The data to fix this already exists: `server_ads[]` is indexed by server
numeric and tracks ALL storage servers in the network (populated via
`sendcmdto_serv_butone()` propagation of `CH A S`). The bug is that
`count_storage_servers()` and `start_fed_query()` only walk
`cli_serv(&me)->down` (direct links) instead of iterating `server_ads[]`.

**P10 routing complication**: Naively sending `sendcmdto_one(&me,
CMD_CHATHISTORY, remote_server, ...)` to a non-direct server routes through
intermediates, but intermediate servers' `ms_chathistory()` Q handler both
processes AND propagates the query — so the destination gets it twice (once
via P10 routing, once via propagation). P10 doesn't have transparent
pass-through for arbitrary tokens the way PING does.

**Solution**: Destination-addressed queries, mirroring the P10 PING pattern.
PING has a destination field — if the intermediate isn't the destination, it
forwards without processing. Same pattern for CH Q.

#### Wire Format Change

Add optional destination numeric to CH Q:

```
CH Q <target> <subcmd> <ref> <limit> <reqid> [<dest_numeric>]
```

- `dest_numeric`: 2-char base64 server numeric of the intended recipient
- When absent: legacy behavior (process locally + propagate) — backwards compat
- When present: only the destination server processes; intermediates forward

#### ms_chathistory() Q Handler Change

Insert at the top of the Q handler, before any processing or propagation:

```c
  if (strcmp(subcmd, "Q") == 0) {
    char *target, *query_subcmd_str, *ref, *reqid;
    char *dest_numeric = NULL;
    int limit;

    if (parc < 7)
      return 0;

    target = parv[2];
    query_subcmd_str = parv[3];
    ref = parv[4];
    limit = atoi(parv[5]);
    reqid = parv[6];

    /* Optional destination numeric (multi-hop direct addressing) */
    if (parc >= 8 && parv[7][0] != '\0')
      dest_numeric = parv[7];

    /* Destination-addressed query: if not for us, forward and skip */
    if (dest_numeric) {
      struct Client *dest = FindNServer(dest_numeric);
      if (dest && dest != &me) {
        /* Forward to destination via P10 routing — don't process locally */
        sendcmdto_one(sptr, CMD_CHATHISTORY, dest, "Q %s %s %s %d %s %s",
                      target, query_subcmd_str, ref, limit, reqid,
                      dest_numeric);
        return 0;
      }
      /* dest_numeric is us — fall through to normal processing.
       * Don't propagate (query was targeted at us specifically). */
    }

    /* Legacy path (no dest_numeric): propagate to direct links as before */
    if (!dest_numeric) {
      /* ... existing propagation block (lines 3380-3413) unchanged ... */
    }

    /* ... rest of Q handler (local processing) unchanged ... */
```

When `dest_numeric` is present and not `&me`: forward via `sendcmdto_one()`
to the destination server. P10 routing handles the intermediate hops.
When `dest_numeric` IS us: process locally, skip propagation (the originator
already sent targeted queries to each storage server individually).
When `dest_numeric` is absent: legacy propagation behavior preserved.

#### count_storage_servers() Change

Iterate `server_ads[]` instead of `cli_serv(&me)->down`:

```c
static int count_storage_servers(const char *target, time_t query_time)
{
  int count = 0;
  int i;

  for (i = 0; i < MAX_AD_SERVERS; i++) {
    struct ChathistoryAd *ad = server_ads[i];
    struct Client *server;

    if (!ad || !ad->has_advertisement || !ad->is_storage_server)
      continue;

    /* Resolve numeric to server struct */
    server = FindNServer(inttobase64(buf, i, 2));
    if (!server || server == &me)
      continue;  /* Skip self and missing servers */

    /* Skip U-lined servers (services) */
    if (is_ulined_server(server))
      continue;

    /* Skip servers whose retention doesn't cover query time */
    if (query_time != 0 && !server_retention_covers(server, query_time))
      continue;

    /* Bloom filter check (or legacy channel list check) */
    if (target && has_channel_advertisement(server) &&
        !server_advertises_channel(server, target))
      continue;

    count++;
  }

  return count;
}
```

Now counts ALL storage servers in the network, not just direct links.

#### start_fed_query() Change

Same iteration change, plus add `dest_numeric` to each CH Q:

```c
  /* Send targeted queries to all storage servers in the network */
  for (i = 0; i < MAX_AD_SERVERS; i++) {
    struct ChathistoryAd *ad = server_ads[i];
    struct Client *server;
    char dest_yxx[4];

    if (!ad || !ad->has_advertisement || !ad->is_storage_server)
      continue;

    inttobase64(dest_yxx, i, 2);
    server = FindNServer(dest_yxx);
    if (!server || server == &me)
      continue;

    if (is_ulined_server(server))
      continue;

    if (query_time != 0 && !server_retention_covers(server, query_time))
      continue;

    if (has_channel_advertisement(server) &&
        !server_advertises_channel(server, target))
      continue;

    /* Send with destination numeric for multi-hop routing */
    sendcmdto_one(&me, CMD_CHATHISTORY, server, "Q %s %c %s %d %s %s",
                  target, s2s_subcmd, s2s_ref, limit, reqid, dest_yxx);
  }
```

Key changes:
- Iterates `server_ads[]` (all storage servers) instead of `cli_serv(&me)->down`
- Uses `sendcmdto_one(&me, ..., server, ...)` which P10-routes to the server
- Appends `dest_yxx` so intermediates forward without processing
- `servers_pending` is now accurate — counts real storage servers, not hops

#### start_fed_targets_query() Change

Same pattern — iterate `server_ads[]` with `dest_numeric`:

```c
  /* Send targeted TARGETS queries to all storage servers */
  for (i = 0; i < MAX_AD_SERVERS; i++) {
    struct ChathistoryAd *ad = server_ads[i];
    struct Client *server;
    char dest_yxx[4];

    if (!ad || !ad->has_advertisement || !ad->is_storage_server)
      continue;

    inttobase64(dest_yxx, i, 2);
    server = FindNServer(dest_yxx);
    if (!server || server == &me)
      continue;

    if (is_ulined_server(server))
      continue;

    /* No channel-level filtering for TARGETS (queries all targets) */

    sendcmdto_one(&me, CMD_CHATHISTORY, server, "Q * T %s %d %s %s",
                  s2s_ref, limit, reqid, dest_yxx);
  }
```

#### Response Routing (Already Works)

Responses (`CH R`/`CH Z`/`CH B`/`CH T`/`CH E`) are sent back via
`sendcmdto_one(&me, CMD_CHATHISTORY, sptr, ...)` where `sptr` is the
originating server. P10 routes them back through the tree. The originator's
`find_fed_request(reqid)` finds the request because the originator created it.

Intermediate servers that receive responses for unknown reqids still hit
`find_fed_request() → NULL → return 0`. But this is now a no-op — responses
are P10-routed directly to the originator, never arriving at intermediates
in the first place. The intermediate only sees the CH Q pass through (and
forwards it via the dest_numeric logic), not the responses.

**Exception**: If the intermediate IS a storage server, it received its own
targeted CH Q (with its own numeric as dest_numeric). It processes that query
and sends its own responses directly back to the originator. No confusion.

#### Propagation Block Cleanup

The existing propagation block (lines 3380-3413) becomes a legacy fallback
for queries without `dest_numeric`. When all servers support destination-
addressed queries, it can be removed entirely. During mixed-version transition:

- New servers send CH Q with `dest_numeric` → intermediates forward
- Old servers send CH Q without `dest_numeric` → existing propagation works
  (with the known multi-hop response-drop bug for 3+ hop topologies)

#### Files Modified (Multi-Hop Fix)

| File | Change |
|------|--------|
| [m_chathistory.c:3357](nefarious/ircd/m_chathistory.c#L3357) | Q handler: dest_numeric check + forward-or-process logic |
| [m_chathistory.c:2932](nefarious/ircd/m_chathistory.c#L2932) | `count_storage_servers()`: iterate `server_ads[]` |
| [m_chathistory.c:3061](nefarious/ircd/m_chathistory.c#L3061) | `start_fed_query()`: iterate `server_ads[]`, add dest_numeric |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c) | `start_fed_targets_query()`: same pattern |

**No PM target dedup across servers**: If a PM conversation is stored on both
servers (via write forwarding), both might report the same PM target with slightly
different timestamps. `merge_targets()` deduplicates by target name and keeps the
latest timestamp. This works correctly for the `p:<account1>:<account2>` key
format since both servers use the same normalized form.

---

## Channel Advertisement Optimization: Bloom Filter

### Problem

On a server with many channels in history, the `CH A F` (full channel list)
burst is bandwidth-intensive. Each P10 line carries ~400 bytes of channel names,
so 1000 channels (~15 chars each) produces ~37 P10 lines during every server
burst. The incremental updates (`CH A +`/`CH A -`) are lightweight individually,
but the full-list burst dominates.

The channel-level advertisements exist to skip unnecessary federation queries —
if server B doesn't have `#channel` in history, don't send `CH Q #channel` to B.
Without them, every federation query goes to every storage server, and some
respond with `CH E <reqid> 0` (empty). The question is whether the cost of
maintaining full channel lists exceeds the cost of occasional empty responses.

### Design: Replace channel list with bloom filter

A bloom filter compresses the channel set into a fixed-size bitfield with
probabilistic membership testing. False positives (saying "yes" when the channel
isn't stored) cause a harmless `CH E 0` response. False negatives are impossible
by design — if a channel IS in the filter, the probe always returns true.

**What changes**:

| S2S Subcmd | Old | New |
|------------|-----|-----|
| `CH A S` | Storage capability | Unchanged |
| `CH A R` | Retention update | Unchanged |
| `CH A F` | Full channel list (multi-line) | **Removed** — replaced by `CH A B` |
| `CH A B` | *(new)* | Bloom filter (chunked base64) |
| `CH A +` | Add channel to list | **Changed** — sets bits in remote filter |
| `CH A -` | Remove channel from list | **Removed** — stale bits are harmless FPs |

**What stays the same**: `CH A S` (storage capability), `CH A R` (retention).
The bloom filter only replaces the channel-level membership data.

### Wire Format

```
CH A B <m_bytes> <k_hashes> [+] :<base64_chunk>
```

- `m_bytes`: Filter size in bytes (e.g., 1024)
- `k_hashes`: Number of hash functions (e.g., 3)
- `+`: Continuation marker (more chunks follow). Absent on last/only chunk.
- Payload chunked at 350 bytes of base64 per line (fits P10 line limits)

**Example** (1024-byte filter, ~4 lines):
```
CH A B 1024 3 + :SGVsbG8gV29ybGQh...  (350 chars)
CH A B 1024 3 + :bW9yZSBkYXRhIGhl...  (350 chars)
CH A B 1024 3 + :eWV0IG1vcmUgZGF0...  (350 chars)
CH A B 1024 3 :YSBsYXN0IGNodW5r...    (remaining)
```

vs. old CH A F for same 1000 channels: ~37 lines.

**CH A + (modified)**: Still sent for real-time new channel notification. The
receiving server computes the same hash functions and sets the bits in its
in-memory filter. No list management needed.

```
CH A + :#newchannel
```

### Filter Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `m_bytes` | 1024 | Filter size (8192 bits) |
| `k_hashes` | 3 | Hash function count |

**False positive rates** (k=3, m=1024 bytes):

| Channels | FPR | Impact |
|----------|-----|--------|
| 100 | <0.1% | Negligible |
| 500 | ~4% | 1 in 25 queries gets empty response |
| 1000 | ~14% | 1 in 7 — still cheaper than full list |
| 2000 | ~38% | Consider larger filter |

For networks with >1000 active channels, operators can increase `m_bytes` via
FEAT. The parameters are encoded in the wire format, so mixed-size filters work
across the network.

### Hash Function

Use FNV-1a with `k` different initial offsets:

```c
static uint32_t bloom_hash(const char *channel, int seed) {
  uint32_t hash = 2166136261u ^ (seed * 16777619u);
  for (const char *p = channel; *p; p++) {
    hash ^= (uint32_t)ToLower(*p);
    hash *= 16777619u;
  }
  return hash;
}

static void bloom_set(unsigned char *filter, int m_bytes, int k,
                      const char *channel) {
  for (int i = 0; i < k; i++) {
    uint32_t h = bloom_hash(channel, i);
    int bit = h % (m_bytes * 8);
    filter[bit / 8] |= (1 << (bit % 8));
  }
}

static int bloom_test(const unsigned char *filter, int m_bytes, int k,
                      const char *channel) {
  for (int i = 0; i < k; i++) {
    uint32_t h = bloom_hash(channel, i);
    int bit = h % (m_bytes * 8);
    if (!(filter[bit / 8] & (1 << (bit % 8))))
      return 0;  /* Definitely not present */
  }
  return 1;  /* Probably present */
}
```

Both sender and receiver use identical `bloom_hash()` — deterministic, no
external dependency. `ToLower()` ensures case-insensitive matching consistent
with IRC channel names.

### ChathistoryAd Structure Change

```c
struct ChathistoryAd {
  int has_advertisement;
  int retention_days;
  int is_storage_server;
  time_t last_update;
  /* Replace channel list with bloom filter */
  unsigned char *bloom_filter;    /* NULL if no filter received */
  int bloom_m_bytes;              /* Filter size (0 = no filter) */
  int bloom_k_hashes;             /* Hash function count */
};
```

**Removed**: `has_channel_ads`, `channel_count`, `channels` (char** array).

### Changes to Existing Functions

**`server_advertises_channel()`** — Replace linear search with bloom probe:

```c
int server_advertises_channel(struct Client *server, const char *channel) {
  int idx = server_ad_index(server);
  if (idx < 0 || !server_ads[idx])
    return 0;
  if (!server_ads[idx]->bloom_filter)
    return 1;  /* No filter → assume all channels (conservative) */
  return bloom_test(server_ads[idx]->bloom_filter,
                    server_ads[idx]->bloom_m_bytes,
                    server_ads[idx]->bloom_k_hashes, channel);
}
```

O(k) instead of O(n). When no filter has been received (pre-burst or legacy
server), returns 1 (query everything) — safe fallback.

**`send_channel_advertisements()`** — Generate and send bloom filter:

```c
static void send_channel_advertisements(struct Client *server) {
  unsigned char *filter;
  int m_bytes = feature_int(FEAT_CHATHISTORY_BLOOM_SIZE);
  int k = feature_int(FEAT_CHATHISTORY_BLOOM_HASHES);
  char *b64;
  int b64_len;

  if (!feature_bool(FEAT_CHATHISTORY_STORE))
    return;

  /* CH A S (storage capability — unchanged) */
  sendcmdto_one(&me, CMD_CHATHISTORY, server, "A S %d",
                feature_int(FEAT_CHATHISTORY_RETENTION));

  /* Build bloom filter from all stored channels */
  filter = (unsigned char *)MyCalloc(1, m_bytes);
  history_iterate_channels(bloom_channel_callback, filter, m_bytes, k);

  /* Base64 encode and send chunked */
  b64 = base64_encode(filter, m_bytes, &b64_len);
  send_bloom_chunks(server, m_bytes, k, b64, b64_len);

  MyFree(filter);
  MyFree(b64);
}
```

**`broadcast_channel_advertisement()`** — CH A + now sets bloom bits:

Unchanged on the wire (still `CH A + :#channel`). The receiver's handler
computes `bloom_set()` on its in-memory filter instead of appending to a
channel list. Idempotent — setting already-set bits is a no-op.

### Refresh Strategy

Bloom filters accumulate false positives over time as channels are removed
from MDBX but their bits remain set. Periodic refresh bounds the FPR:

1. **On burst**: Full filter sent via `CH A B` (same trigger as old CH A F)
2. **On maintenance timer**: If significant eviction occurred since last
   broadcast, regenerate and re-send `CH A B` to all peers
3. **Threshold**: Re-broadcast when estimated FPR exceeds 2x the theoretical
   rate (track eviction count since last broadcast)

The existing `FEAT_CHATHISTORY_MAINTENANCE_INTERVAL` (default 300s) provides
the timer. No new feature flag needed for refresh — it piggybacks on the
existing maintenance cycle.

### Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CHATHISTORY_BLOOM_SIZE` | 1024 | Bloom filter size in bytes |
| `FEAT_CHATHISTORY_BLOOM_HASHES` | 3 | Number of hash functions |

### Migration / Backwards Compatibility

Servers that don't understand `CH A B` will ignore it (standard P10 unknown
subcmd handling). They'll also stop receiving `CH A F` (removed). The fallback
in `server_advertises_channel()` — returning 1 when no filter is present —
means the querying server will still send CH Q to legacy servers. They just
won't benefit from the bloom filter optimization.

The transition path:
1. Upgrade all servers to bloom-filter-aware code
2. Remove CH A F sending code
3. Legacy servers that still send CH A F: handle as before (populate channels
   array as a fallback, gradually phase out)

### Files Modified (Bloom Filter)

| File | Change |
|------|--------|
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L1999) | Replace `channels`/`channel_count` with bloom fields in ChathistoryAd |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2111) | `server_advertises_channel()`: bloom probe instead of linear search |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2352) | Replace CH A F callback with bloom filter generation |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2388) | `send_channel_advertisements()`: send CH A B instead of CH A F |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L2443) | Remove `broadcast_channel_removal()` (CH A - no longer needed) |
| [m_chathistory.c](nefarious/ircd/m_chathistory.c#L3752) | CH A F/B/+ handlers: replace list parsing with bloom operations |
| [ircd_features.c](nefarious/ircd/ircd_features.c) | Add `FEAT_CHATHISTORY_BLOOM_SIZE`, `FEAT_CHATHISTORY_BLOOM_HASHES` |
| [ircd_features.h](nefarious/include/ircd_features.h) | Feature flag enums |

---

## Backwards Compatibility

`P10_MESSAGE_TAGS` is already a per-network opt-in (default OFF). Legacy servers
that can't parse `@tag=value` P10 prefixes won't see tags. When the network is
all-nefarious-fork, enable it and exact msgid dedup works. The semantic dedup
fallback in `message_exists()` handles mixed networks where some servers don't
propagate tags.

## Verification

1. Rebuild: `dc --profile linked up -d --build --no-deps nefarious nefarious2`
2. Enable `P10_MESSAGE_TAGS = TRUE` on all servers, rehash

**Test A**: Send message on hub, query `CHATHISTORY LATEST #channel * 50` on
leaf — message appears exactly once (not duplicated with different msgid)
**Test B**: Send message on leaf, query on hub — same dedup behavior
**Test C**: Send PM between users on different servers, query
`CHATHISTORY LATEST target * 50` — PM appears once
**Test D**: With `P10_MESSAGE_TAGS = FALSE`, semantic dedup fallback still works
(messages deduplicated by timestamp+sender+content)
**Test E**: Upstream nefarious server with tag skip patch can link to
tag-aware servers without parse errors

### Federation ordering

**Test F**: Federated `CHATHISTORY BEFORE` returns messages in chronological
order (oldest-first), matching the local-only path
**Test G**: Federated `CHATHISTORY LATEST` returns messages in chronological
order — verify HexChat/clients display correctly without client-side sort

### TARGETS (local quality fixes)

**Test H**: `CHATHISTORY TARGETS timestamp=<1h_ago> timestamp=<now> 50`
returns targets sorted by most-recent-message first (not alphabetical)
**Test I**: User in 10 channels, only 3 with recent activity — returns
exactly 3 targets (not 10 alphabetical entries)
**Test J**: With limit=5 and 10 qualifying targets (after access filtering),
returns 5 targets (not fewer due to pre-filter limit bug)
**Test K**: Channels the user can't access (not joined, not +H) are excluded
from TARGETS results

### TARGETS federation

**Test L**: User on leaf server, messages only on hub — `CHATHISTORY TARGETS`
returns channels that have history on the hub (not empty local-only result)
**Test M**: Same channel has history on both servers — TARGETS returns it once
with the latest timestamp (dedup works correctly)
**Test N**: PM target stored on hub via write forwarding — appears in TARGETS
query from leaf
**Test O**: Federation timeout — if remote server is slow, partial results
from local DB are returned after `CHATHISTORY_TIMEOUT` seconds
**Test P**: Client disconnects during federation — no crash (completion
callback checks `findNUser` and silently discards)
**Test Q**: `MAX_FED_REQUESTS` slots exhausted — federation falls through to
local-only response (no error, graceful degradation)

### Bloom filter advertisements

**Test R**: After server link, debug log shows `CH A B` (not `CH A F`) with
filter parameters — verify base64 payload is reasonable size
**Test S**: Send message to `#newchannel` on hub, verify leaf receives
`CH A +` and subsequent `CHATHISTORY LATEST #newchannel * 10` from leaf
successfully federates (bloom filter updated in-place)
**Test T**: Channel evicted from hub — leaf's bloom filter still has stale bits
(false positive). Federation query returns `CH E 0` — no error, client gets
empty batch. Filter refreshed on next maintenance cycle.
**Test U**: Server with no bloom filter received (pre-burst or legacy) —
`server_advertises_channel()` returns 1 (query everything), federation works

### Multi-hop federation (requires multi profile: 4 servers)

**Test V**: 3-hop topology (nefarious → nefarious2 → nefarious3), all with
`CHATHISTORY_STORE=TRUE`. Send message on nefarious3, query
`CHATHISTORY LATEST #channel * 50` from nefarious — message appears
(dest_numeric routes CH Q through nefarious2 to nefarious3)
**Test W**: Same topology — `count_storage_servers()` on nefarious returns 2+
(includes nefarious3 behind nefarious2, not just direct link nefarious2)
**Test X**: Debug log on nefarious2 (intermediate) shows CH Q forwarded to
nefarious3 without local processing (dest_numeric != self)
**Test Y**: Legacy CH Q without dest_numeric — still works via existing
propagation path (backwards compatibility)
**Test Z**: `CHATHISTORY TARGETS` from nefarious returns targets from
nefarious3 (multi-hop TARGETS federation with dest_numeric)
