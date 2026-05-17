# BX EM — Multiline-aware bouncer alias echo across S2S

## Goal

When a user with a bouncer session sends a multiline DM, every connection
in their session — including remote ones — should see the conversation
in the right query window with proper `draft/multiline` BATCH framing
when the receiving alias supports the cap.

Today (commit `f85f0b1`):
- **Local aliases** (same server as sender): proper BATCH wrapper via
  `deliver_multiline_dm_to_one()`.
- **Forward to recipient's remote aliases**: proper BATCH via
  `CMD_MULTILINE` relay (just landed in `f85f0b1`). Wire target IS the
  alias, so standard ML routing works.
- **Echo to sender's remote session members**: per-line `BX E` only.
  Multiline-capable remote aliases see N flat PRIVMSGs instead of a
  BATCH; concat semantics and `@label` correlation are lost.

This plan closes the last gap: a new `BX M` subcommand carries a
multiline batch across S2S to a *specific session member* even though
the inner messages target a different nick (the original DM target).

## Why a new token

Echo is structurally different from forward. For forward, the wire
target is the alias itself, so `CMD_MULTILINE` already works — the
receiving server's `deliver_s2s_multiline_batch()` does
`FindUser(target)`, finds the alias, delivers a BATCH to it.

For echo, the wire we want each session member to see is
`:sender PRIVMSG <original_target> :<line>` (so the alias's IRC client
routes the conversation into the original-target query window). If we
sent that via `CMD_MULTILINE`, the receiving server would deliver to
`<original_target>`'s server, not to the alias.

`BX E` already solves this for single-line: it carries both the routing
target (the alias) and the wire target (the original PM target) as
separate fields. `BX M` is the multi-line cousin.

## Wire format

Subcommand char `M` (Multiline echo) — single new char fits the existing
`bounce_handle_bt` dispatch shape ([bouncer_session.c:3920](nefarious/ircd/bouncer_session.c#L3920)).

State machine mirrors `CMD_MULTILINE`: `+` start, plain continuation,
`c` concat continuation, `-` end. The batch-id prefix carries the
state; per-link buffer tracks accumulation.

```
Start (carries first line + all metadata):
  BX M+<bid> <alias_num> <from_num><tok> <target_nick> <msgid> [@<ctags>] :<line>

Continuation (plain):
  BX M <bid> <alias_num> :<line>

Continuation (multiline-concat):
  BX Mc<bid> <alias_num> :<line>

End (optional paste URL):
  BX M-<bid> <alias_num> :<paste_url>
```

Field semantics:
- `<bid>` — server-numeric-prefixed batch id, scoped per S2S link (collision
  domain is the receiving link's `S2SBxmBatch` table, not global).
- `<alias_num>` — final destination, the session member receiving the echo.
- `<from_num><tok>` — concatenated 5-char numeric of the from source
  (= `sender_primary` per bouncer-session convention) plus single-char
  command token (`P`/`O` for PRIVMSG/NOTICE). Mirrors `BX E`.
- `<target_nick>` — original PM recipient's nick, used as the `%C` wire
  target on the inner PRIVMSGs the alias reconstructs.
- `<msgid>` — base msgid for the batch, or `*` if absent.
- `<ctags>` — optional client-only tags string, `@`-prefixed when present
  (mirrors `CMD_MULTILINE`).
- `<line>` — message text.

`-` end carries an optional paste URL string (forwarded from origin)
matching `CMD_MULTILINE`'s convention.

## Capability assumption

`BX M` ships in the nefarious fork together with `IsMultiline()`-flagged
multiline support. Sender-side check is `IsMultiline(alias_server)` —
multiline-capable servers in this fork know `BX M`.

A bouncer-aware server that does NOT know `BX M` will hit the default
case in `bounce_handle_bt` and forward without local processing — the
alias on that server gets nothing. This is the same risk profile as any
new BX subcommand, and the multiline-cap proxy keeps it contained.

For non-multiline alias servers, the sender continues to emit per-line
`BX E` — the alias gets bounded individual PRIVMSGs (current behavior).

## Sender-side changes (m_batch.c)

Echo block at [m_batch.c:1086+](nefarious/ircd/m_batch.c#L1086) (post-
`f85f0b1`). For each remote session member:

```c
if (MyConnect(member)) {
    /* unchanged: proper local batch via helper */
} else if (IsMultiline(cli_from(member))) {
    /* NEW: BX M batch to multiline-capable bouncer server */
    emit_bx_m_batch(member, sender_primary, acptr, ...);
} else {
    /* unchanged: per-line BX E */
}
```

`emit_bx_m_batch()` walks `con_ml_messages(con)` and emits
`BX M+<bid>` / `BX M<bid>` / `BX Mc<bid>` / `BX M-<bid>` to
`cli_from(member)`. Same pattern for the `sender_primary` echo branch
above (when sender is an alias).

Per-target `bid` (`cli_yxx(sender_primary) + CurrentTime + member_index`)
keeps concurrent BX M batches from colliding on the receiver's per-link
table.

## Receiver-side changes (bouncer_session.c)

### Dispatch

Add to `bounce_handle_bt`'s switch:

```c
case 'M':
  return bounce_alias_multiline_echo(cptr, sptr, parc, parv);
```

### Buffer state

New struct `S2SBxmBatch`, shape parallel to `S2SMultilineBatch` but
keyed on `(cptr, batch_id)` (per-link; allows the same batch-id from
different links concurrently). Stored in a fixed-size array indexed
by some hash or just linear-scan like the existing multiline state at
[m_batch.c:1731](nefarious/ircd/m_batch.c#L1731).

```c
struct S2SBxmBatch {
    struct Client *link;       /* incoming S2S link (cptr) */
    char batch_id[16];
    char alias_numeric[6];     /* final target session member */
    struct Client *from_user;  /* sender_primary (for the wire :from) */
    char target_nick[NICKLEN+1]; /* original PM target; %C on inner lines */
    char msgid[64];            /* base msgid */
    char client_tags[512];     /* @-prefixed ctags from start opener */
    int  is_notice;            /* P=0, O=1 */
    char paste_url[256];       /* from -end */
    struct SLink *messages;    /* same SLink<concat-flag-byte + text> shape */
    int  msg_count;
    unsigned int total_bytes;
    time_t start_time;
};
```

### Handler `bounce_alias_multiline_echo`

```c
static int bounce_alias_multiline_echo(struct Client *cptr,
                                        struct Client *sptr,
                                        int parc, char *parv[])
{
    /* parv[1] = "M", parv[2] = "+bid"/"bid"/"cbid"/"-bid", ... */

    parse prefix on parv[2] → is_start / is_concat / is_end / continuation
    bid = parv[2] + (prefix ? 1 : 0)
    alias_num = parv[3]

    if is_start:
        validate parc >= 8
        from_num = parv[4], tok = parv[5], target_nick = parv[6],
        msgid = parv[7]
        if parv[8][0] == '@': ctags = parv[8]+1, line = parv[9]
        else: line = parv[8]

        Forward upstream-of-alias if not local: relay BX M+ unchanged.

        Else (alias is local):
            create S2SBxmBatch entry
            populate fields
            append first line if non-empty

    else if is_end:
        find batch by (cptr, bid)
        if !batch: drop silently
        capture paste_url from text param
        deliver_bxm_batch(batch)
        free

    else:  /* continuation */
        find batch by (cptr, bid)
        append message with concat flag
```

### Forwarding

If `findNUser(alias_num)` is not local, mirror the BX E forward pattern
([bouncer_session.c:4879](nefarious/ircd/bouncer_session.c#L4879)) —
re-emit the same `BX M` line to `cli_from(alias)`. Per-link state
buffering happens only on the *terminating* server (where the alias is
local).

### `deliver_bxm_batch()`

```c
static void deliver_bxm_batch(struct S2SBxmBatch *batch)
{
    alias = findNUser(batch->alias_numeric);
    if (!alias || !MyConnect(alias) || !IsBouncerAlias(alias))
        return;

    if (CapActive(alias, CAP_DRAFT_MULTILINE)
        && CapActive(alias, CAP_BATCH)) {
        /* Proper labeled batch wrapper to alias.  Wire target on the
         * inner messages is target_nick, not alias_nick. */
        emit BATCH +id draft/multiline <target_nick>
        for each message:
            sendrawto_one(alias,
                "@batch=%s%s :%s!%s@%s %s %s :%s",
                batchid,
                concat ? ";draft/multiline-concat" : "",
                cli_name(from), user, host,
                cmd_str, target_nick, text);
        emit BATCH -id
    } else {
        /* Bounded fallback.  send_multiline_fallback already accepts
         * (route_to=alias, wire_target=target_nick) — exactly what we
         * need here. */
        send_multiline_fallback(from_user, alias, target_resolved_client,
                                msgid, messages, msg_count, 0, NULL,
                                paste_url, client_tags, is_notice);
    }
}
```

`from_user` resolves via `findNUser(batch->from_num)`. If it's NULL
(user gone since the batch started), use `&me` as a graceful fallback —
unlikely but cheap to handle.

## Edge cases

### Batch-id collision across links
Per-link keying. Two different upstream servers can both send `BX M+xyz`
without conflict.

### Partial batches when alias quits mid-stream
If the alias quits between `+` and `-`, `findNUser` returns the alias
during accumulation but it's gone by `-end`. `deliver_bxm_batch` checks
`MyConnect(alias)` → returns silently. Free the batch state without
delivery.

### S2S link dies mid-batch
On link drop, the link's pending `S2SBxmBatch` entries leak unless we
wire them into the existing link-cleanup path. Add a cleanup hook from
the same place `S2SMultilineBatch` is cleaned (search for
`free_s2s_multiline_batch` callsites in link teardown — there are none
today; both leak on link drop). Track as known issue, don't block on
fixing both at once.

### Total-bytes / line-count limits
Reuse `compute_network_ml_max_bytes()` / `compute_network_ml_max_lines()`
([m_batch.c:1742](nefarious/ircd/m_batch.c#L1742)) the same way
`add_s2s_multiline_message` does. Reject lines past the limit, log
warning, finish with what's accumulated.

### Truncation fallback wire format
`send_multiline_fallback` takes `route_to` and `acptr` (wire %C target)
separately — already supports the echo case. Pass `route_to=alias`,
`acptr=target_resolved` so the alias's IRC client routes the truncated
preview into the right query window.

## Test plan

1. **Three-server topology** (testnet, leaf, secondary leaf or similar).
2. Set up a bouncer session with aliases on testnet AND leaf.
3. Sender (alias on testnet) sends a multiline DM to a third user on
   secondary leaf.
4. Verify on alias-on-leaf:
   - With multiline cap: receives `BATCH +id draft/multiline <target>`
     opener + N inner PRIVMSGs targeted at `<target>` + `BATCH -id`.
   - Without multiline cap: receives bounded preview + truncation NOTICE
     with paste URL, all with wire target `<target>` so the conversation
     window is correct.
5. Verify on testnet (sender's server): `con_ml_lag_accum` discount
   logic unchanged from `eea88ed`.
6. Verify on the recipient's leaf: standard delivery via the existing
   `CMD_MULTILINE` relay (unchanged by this work).

## Files touched

- `ircd/m_batch.c`:
  - Replace remote-member per-line BX E loop in echo block with
    `IsMultiline(member_server)` ? `BX M` batch : per-line BX E.
- `ircd/bouncer_session.c`:
  - New `S2SBxmBatch` struct + per-link fixed array.
  - New `bounce_alias_multiline_echo` handler.
  - New `deliver_bxm_batch` helper.
  - Dispatch case `'M'` in `bounce_handle_bt`.
- `include/bouncer_session.h`:
  - No public API changes expected — all new functions are static.

## Out of scope

### Cross-server forward batching

Already done in commit `f85f0b1`. The forward case (delivering a copy
of a DM to the *recipient's* remote bouncer aliases) is structurally
simpler than echo because the wire target IS the alias — the alias
appears as a normal recipient at the protocol layer. That means the
existing `CMD_MULTILINE` S2S relay does the right thing without a new
token: send `ML +<bid> <alias_nick> :<line>` etc. to the alias's server,
and `deliver_s2s_multiline_batch()` resolves `FindUser(<alias_nick>)`,
finds the local alias, and emits a proper BATCH wrapper.

The only reason BX M is needed *at all* is for echo, where the wire
target is the original DM target (a different user) but the routing
target is the alias. Forwarding doesn't have that mismatch.

We could reconsider whether forward should also migrate to BX M for
symmetry — see "Future work" below — but for the scope of this plan,
forward stays on `CMD_MULTILINE`.

### Non-bouncer-aware peers

A server that doesn't speak the `draft/bouncer` protocol cannot host
session aliases at all — it doesn't track `BounceSession`/`BounceAlias`
state, and won't relay BX subcommands meaningfully. From the sender's
perspective, the `hs_aliases[]` array on the local session only contains
numerics for clients on bouncer-aware servers (aliases are introduced
network-wide via `BX C`, which legacy peers drop). So the iteration
that drives BX M emission can never produce a target on a non-bouncer
server in the first place.

Equivalently: there's no BX EM "downgrade for legacy bouncer-less peers"
case to design. Either the peer speaks BX (and the alias exists there)
or it doesn't (and there's no alias to send to). The fallback we DO
care about is bouncer-aware-but-not-multiline-capable, handled by the
sender-side `IsMultiline(alias_server)` check that picks BX E
single-line for those.

### Cleanup of leaked S2S batch state on link drop

When an S2S link drops mid-batch, any `S2SMultilineBatch` entries
buffered for that link become unreachable: the cleanup path
([s_bsd.c::exit_one_client](nefarious/ircd/s_bsd.c) and friends) doesn't
walk the `s2s_ml_batches[]` array to free entries pinned to the dying
link. The struct stays allocated and the slot stays occupied until
some other batch happens to find it via `find_s2s_multiline_batch` —
which never matches because the batch_id was scoped to the dead link.

In practice this is bounded by `MAXCONNECTIONS` slots and is tiny per
slot, so it's been a tolerable leak. It also rarely triggers — a
mid-batch link drop requires the originating server to crash or netsplit
during the `~1ms-100ms` window of an active multiline send.

`S2SBxmBatch` would inherit the same leak shape if I model it the same
way. Two options:

1. **Match the existing pattern**: leak parity with `S2SMultilineBatch`,
   document the issue once for both. This is what the plan currently
   assumes.
2. **Fix both at once**: register a per-link cleanup hook that walks
   both arrays on `exit_one_client` for a server. ~30 lines, but
   touches a hot path and warrants its own commit + review.

The plan ships option (1) — keep behavior consistent with the existing
multiline state, file (2) as separate work. If the leak ever moves
from "theoretical bounded annoyance" to "observable problem," do (2)
in one go for both batch types.

## Future work

### Forward via BX M for protocol symmetry

Could migrate the forward path (currently `CMD_MULTILINE` to the
alias's server, see `f85f0b1`) to BX M for a single token shape
across all bouncer-related batched delivery.  Tradeoff: `CMD_MULTILINE`
already does what we need cleanly because the wire target IS the
alias for forwards.  Lean toward keeping forward on `CMD_MULTILINE`
unless future work calls for BX M-only consolidation.

## Closed gaps (post-landing)

- **Mid-batch alias destruction sweep** — `bounce_alias_untrack` now
  calls `s2s_bxm_cleanup_alias` to free buffered BX M batches keyed
  on the destroyed alias's numeric.  No need to wait for the link
  drop or MAXCONNECTIONS pressure.
- **Identity changes during a batch** — verified non-issue.
  `deliver_s2s_bxm_batch` resolves `from = findNUser(b->from_numeric)`
  once and uses it for opener, inner messages, and closer in a single
  synchronous call.  Hostmask is consistent across the wrapper.
- **BATCH wrapper source** — landed in commit `8c70a25`.  Per IRCv3
  multiline spec the BATCH `+/-` opener uses the user as source,
  matching the inner `@batch=` PRIVMSGs, so clients route the wrapper
  to the right conversation window.
- **BX C arrival race** — landed in commit `7b15014`.  Pending-BX
  queue (`pending_bx[MAXCONNECTIONS]`, `BX_PENDING_TTL = 30s`) buffers
  BX E / BX M / BX K / BX U messages that target an alias whose BX C
  hasn't been processed yet on this server.  Drain hook at the end of
  `bounce_alias_create` replays matching entries through
  `bounce_handle_bt`; `bx_drain_in_progress` flag prevents infinite
  re-defer if the alias is destroyed mid-replay and gates the forward
  step on BX K/U so replay doesn't duplicate broadcasts.  Link-drop
  cleanup wired into `exit_one_client`.
- **Per-alias cap discovery** — landed in commit `7abf95d`.  See
  [.claude/plans/bx-per-alias-cap-discovery.md](bx-per-alias-cap-discovery.md)
  for the full design.  Sender now uses the alias's actual cap state
  (propagated via `BX U <alias_num> caps=<hex>`) to pick BX M vs BX E,
  rather than the link-level `IsMultiline` proxy.  `BX_CAP_*` defines
  a curated subset of bouncer-relevant caps; both
  `BX_CAP_DRAFT_MULTILINE` and `BX_CAP_BATCH` must be set for BX M
  to fire.  Falls back to the proxy when `ba_caps_known == 0` (older
  fork or pre-CAP-REQ window).
