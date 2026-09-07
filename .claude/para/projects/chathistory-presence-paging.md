# Chathistory: presence-aware paging (query-time filter)

**Status:** SHIPPED 2026-09-02 as three commits (approved by the user: "plan looks good"):
`62cd953` (row hook + boundary seeks), `6b8ec45` (requester token on CH Q so responders page by
presence), `d55797c` (remote JOIN/PART/CREATE rows keep the origin's msgid — found on the way, see
below). Companion fixes the same day: case-folded lookups (`af31cc3`), audit follow-up (`4087e9b`),
ephemeral MARKREAD echo (`5ff8578`); findings in `casefold-key-audit-2026-09.md`. Verification:
cmocka `test_presence_next_visible_boundaries` red→green; bed `chathistory-presence-paging.test.ts`
red→green (4 scenarios incl. end tags; U is an account user, strict presence flipped on both bed
servers, 32s absence gap because presence coalesces part/rejoin gaps ≤30s; limit 10 sits between
the ≤9 visible rows and the 15-row invisible run). The history.c walk changes have no cmocka
scaffolding (suite re-declares helpers, no DB) — bed only.

## Field report

prod (FractalRealities), 2026-09-02 ~03:00 EDT, from a bouncer account long-present in #linux:

```
<< CHATHISTORY BETWEEN #linux timestamp=2026-08-15T15:02:51.000Z timestamp=2026-09-02T04:32:46.000Z 100
>> BATCH +hist104AAQ chathistory #linux          (labelled run: NO draft/chathistory-end tag)
>> BATCH -hist104AAQ
<< CHATHISTORY BETWEEN #Linux ... 100
>> @draft/chathistory-end BATCH +hist105AAQ ...  (end tag present, empty)
<< CHATHISTORY BETWEEN #linux ... 100
>> BATCH +hist106AAQ chathistory #linux          (no end tag, empty)
```

## Diagnosis

Two independent defects, one of which is prod's cause:

1. **Case-folded lookups (SHIPPED).** The store keys rows under `chptr->chname`; the query copied the
   client's spelling verbatim and `build_key` never folds. `#Linux` therefore scanned an empty
   prefix. That is why the `#Linux` run got the end tag: zero raw rows → `count < limit` → complete.
   Red→green on the bed (`chathistory-target-case.test.ts`). Same hole closed in REDACT (delete +
   event row) and read-marker keys.

2. **Post-filter paging (THIS PLAN).** The `#linux` runs returned an empty batch WITHOUT the end
   tag. `complete = raw_count < limit`, so the raw page was full (100 rows) and every one of them
   was dropped afterwards by `presence_filter_messages`. BETWEEN walks forward from ts1, so the
   page is the oldest 100 rows of the window — mid-August — for which no presence record exists
   (strict presence began recording on prod on 2026-08-30; nothing before that is visible to
   anyone, by design). The client gets an empty page, no end tag and no cursor: it cannot page
   past the invisible region. The same shape breaks LATEST/BEFORE/AFTER/AROUND whenever the raw
   page is dominated by rows outside the caller's presence (e.g. LATEST after a long absence
   returns nothing although older visible rows exist), and the bouncer auto-replay
   (`history_query_latest_after` + post-filter).

   The presence filter runs AFTER the store query fills the page, so it can only shrink a page,
   never extend the walk. Correct behaviour: the walk skips invisible rows without counting them,
   fills the page with visible rows, and reports exhaustion honestly.

## Design: row filter hook with interval-driven seeks

### history.h / history.c

```c
struct HistoryRowFilter {
  /* 1 = keep row; 0 = skip row (optionally set *skip_to = unix seconds at which rows can become
   * visible again in the walk direction, so the iterator SEEKS instead of stepping);
   * -1 = skip and STOP (nothing further visible in this direction). */
  int (*fn)(const struct HistoryMessage *msg, int reverse, void *ctx, int64_t *skip_to);
  void *ctx;
  int scan_max;    /* raw rows examined before giving up (0 = HISTORY_FILTER_SCAN_MAX 20000) */
  int scanned;     /* out: rows examined */
  int truncated;   /* out: scan_max hit — page may be incomplete even though count < limit */
};
```

`history_query_before/after/latest/latest_after/around/between` gain a trailing
`struct HistoryRowFilter *filter` (NULL = today's behaviour). Only the three walk loops change:

- `history_query_internal` (before/after/latest/latest_after): after `deserialize_message` +
  `ml_content_resolve`, call the hook. 1 → append as today. 0 → free the row; if `*skip_to` set,
  build `key(target, "%ld.000")` (forward) or `key(target, "%ld.000" of skip_to+1)` then `prev`
  (reverse) and `db_iter_seek` there, else step; progress guard: if the seek does not move the
  iterator, step. -1 → free the row, break. Floor/target-prefix checks stay per row, so a reverse
  seek below the auto-replay floor is caught by the existing floor test.
- `history_query_between`: same, forward only; the end-prefix check stays per row.
- `history_query_around`: passes the filter to its before/after halves.
- `scan_max` counts raw rows examined (kept + skipped + seeks); on hit set `truncated`, break.

history.c stays Client-free: the hook is a function pointer + ctx.

### chathistory_presence.h / .c

```c
struct PresenceQueryFilter {
  struct HistoryRowFilter hook;   /* pass &pf->hook */
  char channel[CHANNELLEN + 1];
  struct presence_record rec;     /* one snapshot of the anchor's record (today: one db_get PER ROW) */
};
/* 0 = no filtering needed (feature off, PM, +H, effective override) — pass NULL to the query
 * 1 = armed
 * -1 = fail closed (no anchor / presence store unavailable) — caller answers an empty, complete page */
int presence_query_filter_init(struct PresenceQueryFilter *pf, struct Client *requestor,
                               const char *target, int effective_override);
/* Pure interval logic, cmocka-tested: next second in the walk direction at which the record is
 * present, or -1 if none. */
int64_t presence_next_visible(const struct presence_record *r, time_t t, int reverse);
```

`struct presence_record` moves to the header (opaque today). Hook semantics: `t = parse_history_seconds`
(0 → skip, no boundary — matches the fail-closed rule); present → 1; else forward: smallest
`start > t` or `open_since > t`, reverse: largest `end < t`; none → -1.

REDACT inheritance: not needed in the hook. Redact rows for visible parents reach the client via
`history_attach_context` (context children, uncounted), which already runs before the post-filter;
the post-filter's inheritance branch keeps handling them.

### m_chathistory.c / replay.c

- Each client handler (LATEST/BEFORE/AFTER/AROUND/BETWEEN) computes the effective override
  (`ops_override && has_ops_override`) BEFORE the query, inits the filter, passes `&pf.hook` (or
  NULL), and computes `complete = (count < limit) && !pf.hook.truncated`. -1 → empty complete batch.
- `presence_filter_and_replay` keeps the post-filter (defence in depth; still the only filter for
  federated rows and for context children).
- Auto-replay (`replay.c:398/462`, `m_chathistory.c:4528`) passes the filter too, so a long
  absence no longer produces an empty replay when older visible rows fit the since-window.
- Fed responder (`ms_chathistory` Q): **the requester is now named on the wire** (second commit,
  same day). `start_fed_query` appends `P<yxx>` / `F<yxx>` (F = ":full" requested) after
  `dest_numeric` and `ref2` (`*` when absent so the token keeps its slot); intermediates forward
  it; X3 / older responders ignore it. The responder resolves the client with `findNUser`, and
  for an ACCOUNT anchor (presence replicates by observation) walks with the same hook, so its
  limit+1 truncation probe counts visible rows and the origin's
  `total < limit && !fed_truncated` completeness holds. Session-anchored (in-memory on the
  origin only) or unresolvable requesters get the unfiltered walk and the origin post-filters
  as before. Without this, any storage peer holding a copy of the channel made LATEST/BETWEEN
  lose the end tag (bed: nefarious2 stores every channel it sees).

### Tests (TDD)

1. cmocka `chathistory_presence_cmocka.c`: `presence_next_visible` over records with closed
   intervals, an open interval, gaps, both directions, none-left → -1. Red first.
2. Vitest `chathistory-presence-paging.test.ts` (strict presence flipped on via oper `SET`, the
   existing pattern): witness W, user U. U joins; W sends 3 (visible); U parts; W sends 12
   (invisible); U rejoins; W sends 2 (visible). With limit 5: LATEST returns 5 (2 recent + 3 early)
   with the end tag; BETWEEN over the whole window returns 5 with the end tag; BEFORE the newest
   with limit 4 returns the 4 older visible rows; AFTER the first visible with limit 4 returns 2
   early + 2 recent. Today: LATEST returns 2, BETWEEN returns 3 without the end tag.
3. The history.c walk changes have no cmocka scaffolding (the suite re-declares helpers, no DB);
   integration-tested on the bed only (noted per `feedback_no_silent_defer`).

## Found on the way: per-server msgids for remote JOIN/PART/CREATE rows (fixed, third commit)

With the responder walk in place the bed still withheld the end tag: the leaf answered three
rows for U's own JOIN, PART and rejoin under leaf-minted msgids (`AC…`) while the primary held
the same events under `Bj…`. `merge_messages` dedups by msgid only, so the events counted twice
and the merged total hit the limit. Root cause: the origin tags single-channel S2S
JOIN/PART/CREATE with the plain `@A<time><msgid>` form, but `parse.c` fills
`cli_s2s_multi_msgid` only for 2+ channels, `ms_part`/`ms_create` read only that buffer, and
`ms_join` read nothing — every receiver re-minted. `joinbuf_load_s2s_msgids()` now feeds both
forms positionally into the joinbuf on all three receive paths. Also fixes duplicate event rows
for event-playback clients over federation and makes event msgids resolvable anchors network-wide.

## Follow-ups (not in this change)

- **Session-anchored requesters over federation** still get unfiltered remote pages (their
  presence is not replicated); completeness stays conservative (no end tag when the raw merged
  total hits the limit). Replicating session presence is not worth it — ephemerals are the
  minority and lose access on disconnect anyway.
- `redact_filter_messages` (drops redacted originals post-query) has the same page-shrinking shape
  but never a full page of them; could join the hook chain later.
- `history_query_internal` logs four `L_INFO` lines per query — prod noise, unrelated.

## 2026-09-06 — unreceivable row types moved into the walk (`7920490`)

The user's stated flaw ("a slightly dated client doesn't do the end tag, and a presence gap can
return empty even when there's more history that is accessible") reproduced on the bed without
any presence at all: `BEFORE late0 2` → empty page, no end tag, while three visible PRIVMSGs sat
behind two JOIN rows. Cause: rows the requester cannot receive (event rows without
draft/event-playback, REDACT without draft/message-redaction) were walked and counted toward
the limit, then dropped in the send loop by `should_send_message_type`. Strict presence makes
the shape common — every absence is bracketed by PART/JOIN rows — but it was a general
paging defect: any run of unreceivable rows at least `limit` long produced an empty page.
Old-spec clients (stop on empty) truncate there; end-tag clients re-ask with the same anchor and
receive the same empty page, so they stall too.

Fix: `HistoryRowFilter.type_mask` (bit per `HistoryMessageType`, 0 = all) applied inside
`history_filter_row` before the presence hook, as an uncounted skip. Every local walk now carries
a filter (`query_row_filter`: the presence hook when strict presence opened one, else a bare
mask-only filter), and `query_page_complete` reads truncation off that hook. The federated
responder still filters at send time (the remote requester's caps are not known there) — a
remote page across a long event run can still come back short; that is the residue.

Pinned by `chathistory-presence-paging.test.ts` (empty-page walk with limit 2). The earlier
"LATEST fills the page" failure in that suite was this bug, not leaf-link flakiness.

Residue found during the regression sweep for `7920490`: `chathistory-targets-crowding.test.ts`
(limit 1) fails when run right after other suites that used the same pooled account within the
five-minute TARGETS window. The account's other in-window targets (PM pairs, earlier channels)
pass the walk filter, fill the 3x over-fetch, and the requested channel never enters the page;
alone on a quiet bed it passes. Test-order artefact of the pool + the small over-fetch, not a
server regression; a real client asks with a much larger limit. Left as is.
