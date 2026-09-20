# Federated SEARCH — scope (not scheduled)

Written 2026-09-20, the day local `SEARCH` (soju.im/search) shipped
(fork `75fb365` + `c255136`, `docs/features/search.md`). Prod is a single
server, so local search is complete for it today. This is the plan for the
day a second storage server exists (the bed already has one: nefarious2
stores every channel it sees). Scoped while the machinery was fresh; **not
to be built now.**

## What local search is

A brute scan: `history_query_before` from `before` (default now) back to
`after`, a row hook that runs the strict-presence hook first and then the
type / `from` / `text` match, the newest `limit` matches, a scan budget of
`SEARCH_SCAN_MAX` (50 000) raw rows per request shared across the channels
covered, results through the redaction and presence reply filters, emitted
ascending in a `search` batch. Without `in`, every channel the requester
is in; PMs need `in=<nick>`.

## Why federate

A channel's rows can live on more than one storage server (a store that
was away during a split holds rows the others lack; the absence table and
the `partial` opener tag exist for exactly that). CHATHISTORY pages fan
out to the other stores and merge; a search that does not would silently
miss rows that a page of the same window would show. Same completeness
contract, or users will not trust it.

## Reuse: the CHATHISTORY federation path

Everything needed exists for pages (`ircd/m_chathistory.c`):

- **Request**: `struct FedRequest` (64 slots, `MAX_FED_REQUESTS`), a timer,
  `local_msgs` + `fed_msgs`, `partial` (a known store is away over the
  span), `cut` (a responder lost, or the aggregate cap trimmed), `fed_truncated`
  (a responder hit its scan cap), `keep_oldest` (merge trim direction),
  `completion_cb` for a non-page reply.
- **Fan-out**: `start_fed_query()` picks responders from the store
  advertisements (`server_ads[]`, `count_storage_servers(target, t)`) and
  sends `CH Q <target> <subcmd> <ref> <limit> <reqid> [<dest>] [<ref2>] [P|F<yxx>]`;
  the trailing requester token makes the responder walk with the
  requester's replicated ACCOUNT presence (`P<yxx>`), or fall back to the
  unfiltered walk plus origin post-filter for session anchors (`F<yxx>`).
- **Responder**: `ms_chathistory` case `Q` runs the same `history_query_*`
  with the presence row filter, answers `CH R` rows (`CH Z` zstd / `CH B`
  base64 chunks for what does not fit), then `CH E <reqid> <n> [T]`.
- **Merge**: dedup by msgid, sort by time, trim to `limit` in the
  `keep_oldest` direction; `partial`/`cut`/`fed_truncated` decide the
  completeness the client is told.

Federated search is a new **subcommand letter** on that path, not a new
mechanism.

## Wire (proposed)

`CH Q <target> S <before-ts> <limit> <reqid> <dest> <after-ts|*> <requester> :<selectors>`

- Subcommand letter `S` (free in the L/B/A/R/W/T set; the letter map is
  `subcmd_to_char`/`char_to_subcmd`).
- `ref` = `before` as a unix `sec.ms` (the walk's anchor), `ref2` = `after`
  or `*`. Both are already fields of CH Q.
- The selectors ride in the **trailing parameter** as `key=value` pairs
  joined by spaces, escaped the way client tags escape (`\s` for space,
  `\\`), so a `text` with spaces survives as one parameter: `from=<nick>
  text=<escaped>`. Only these two travel; `in`/`limit`/`after`/`before`
  are already positional.
- **The 512-byte S2S body cap** (P10 body is fixed; see
  `project_s2s_512_compression_rationale`) bounds `text`. Reserve ~100
  bytes for the fixed fields and cap the escaped selector string at ~380
  bytes; a longer `text` is refused at the origin with `INVALID_PARAMS`
  *before* fan-out, so local and federated behaviour agree.
- Responder answers `CH R/Z/B` rows and `CH E <reqid> <n> [T]` exactly as
  for a page; `T` when its scan budget cut the window short.

## Responder semantics

- Runs `search_one_target()` (factor it so `ms_chathistory` can call it
  with a requester token instead of a local Client): the same hook chain,
  presence by the requester token as pages do, the same reply filters.
- Its own `SEARCH_SCAN_MAX` budget applies per responder; a responder that
  hits it says `T`.
- A responder with no rows for the channel answers `CH E <reqid> 0` (X3
  already does this for pages).

## Origin merge and completeness

- Merge = the page merge (`fed_merge`, dedup by msgid; search rows are
  PRIVMSG/NOTICE/MULTILINE only so the context-children machinery is
  unused), `keep_oldest = 0` (newest `limit` matches), emitted ascending.
- **Completeness**: the soju spec has no marker for "more exists" or "the
  scan was cut". Options, in order of preference:
  1. Say nothing (spec-exact). The client narrows the window when a full
     `limit` comes back, exactly as it does for a single server today.
     Truncation on one responder is then indistinguishable from "no more",
     which a page would have surfaced as a missing end tag.
  2. A vendor tag on the batch opener, e.g. `@evilnet/search-cut` when
     `cut || fed_truncated || local_incomplete`. Cheap, opt-in for the
     client, propose it as an explicit deviation (never invent silently;
     `feedback_no_invented_extensions`). Seance would use it to keep the
     "search older" affordance alive.
  Decide when building; lean to 2 with the tag documented.
- Timeouts: the FedRequest timer as for pages; a responder that does not
  answer marks `cut`, and the origin still replies with what it has.

## Fan-out cost and limits

- `in=` given: fan out to the stores advertising that channel, as a page
  does. Bounded and cheap to reason about.
- **No `in=`**: local search already walks every channel the requester is
  in. Federating that multiplies by responders and would need one
  FedRequest per channel or a multi-target CH Q that does not exist. Scope
  decision: **federated search requires `in=`**; a no-`in` search stays
  local and the doc says so. Revisit only if a client needs it.
- PMs (`in=<nick>`): the pair key is the target; stores advertise PM pair
  keys the same way? Verify (`count_storage_servers` with a pair key) before
  promising; if not advertised, PM search stays local in v1.
- The 64-slot cap and `fed_start_capacity_miss` apply; on a miss, answer
  locally and (option 2 above) mark cut.

## Security / trust

- Selectors cross the S2S link in clear, as page references already do.
  The P10 server-trust model covers responders; nothing new leaks that a
  page request does not, except the search terms themselves, which are the
  requester's. Acceptable on a network of one operator; note it.
- Presence on responders comes from the replicated account presence
  (`P<yxx>` token). A session-anchored requester (`F<yxx>`) gets the
  conservative path pages get. No new filter surface.

## Phasing (when it is time)

1. `in=<channel>` only: letter `S`, selectors in the trailing param with the
   512-byte guard, responder via the factored `search_one_target`, page
   merge with `keep_oldest = 0`. Tests: two-server bed, rows only on
   nefarious2 must appear in a search issued on the hub; a responder
   timeout still yields the local rows.
2. Completeness marker decision (option 2 tag) and Seance's use of it.
3. PMs, after verifying pair-key advertisements.
4. No-`in` stays local unless a real need appears.

## Open questions to settle first

- Does `count_storage_servers(pair_key, t)` see PM pair keys, or only
  channels? Decides phase 3.
- Is the trailing parameter preserved intact through the P10 parser for
  `CH` (some tokens re-split)? Check `ms_chathistory`'s `parc` handling
  before relying on it.
- Does the absence table's `split_check` apply unchanged to a search span
  (`query_span` over rows that are matches only, not the scanned span)?
  Probably needs the scanned range, not the matched rows.
