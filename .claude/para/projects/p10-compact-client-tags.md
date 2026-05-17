# P10 compact-tag extension: client-only tag relay

**Status:** Investigation / planning
**Author:** ibutsu
**Date:** 2026-04-29
**Depends on:** [ircv3aware-s2s-framework.md](ircv3aware-s2s-framework.md)
(uses `FLAG_IRCV3AWARE` for emission gating).

## Problem

Client-only tags (`+typing`, `+reply`, `+react`, `+channel-context`,
`+draft/multiline-concat`, etc.) are not relayed across server boundaries
on PRIVMSG/NOTICE. They survive locally and via two ad-hoc S2S
conventions retired in the framework plan (TAGMSG parv[1] `@<tags>` and
multiline start-token `@`-prefixed param), but on regular PRIVMSG/NOTICE
they're silently dropped at the S2S boundary.

[send.c:2360](nefarious/ircd/send.c#L2360) builds `serv_mb` from
`@A<time_7><msgid_14>` only — no client tags. No P10 token carries them
today on PRIVMSG/NOTICE.

This plan extends the compact P10 tag format with a `,C<client_tags>`
segment to relay the tags. Emission is gated on `FLAG_IRCV3AWARE` per
the framework plan — non-IRCV3AWARE peers receive bare commands with
no `@A...` prefix at all (the framework drops the prefix entirely on
emit to legacy, since they strip it on receive anyway).

## Wire format

Current ([parse.c:1709-1750](nefarious/ircd/parse.c#L1709-L1750)):

```
@A<time_7><msgid_14>                          base (22 chars after @)
@A<time_7><msgid_14>+<msgid_14>+...           multi-msgid
```

`time_7` is `inttobase64_64(epoch_ms, 7)`. `msgid_14` is the HLC-seeded
P10 msgid.

Proposed extension:

```
@A<time_7><msgid_14>,C<client_tags>           with client tags
@A<time_7><msgid_14>+<msgid_14>...,C<client_tags>   both
```

Where:
- `,` is a segment separator. Not in the P10 base64 alphabet
  (`A-Za-z0-9[]`), so unambiguous against the existing payload.
- `C` is the segment marker for client tags. Single char so other
  segments (`,M<...>`, `,X<...>`) can be added later.
- `<client_tags>` is the verbatim IRCv3 client-tag string —
  `+key=value;+key=value;...` — what `cli_client_tags(sptr)` already
  holds. No additional encoding.
- The tag ends at the first space, as today. Client tags must not
  contain space (IRCv3 message-tags requires escaping); existing parser
  at [parse.c:1486-1492](nefarious/ircd/parse.c#L1486-L1492) enforces
  that on the way in.

### Backward compat

- **Legacy peers (non-IRCV3AWARE):** receive no `@A...` prefix at all
  per the framework plan's emission gate. They get bare commands; no
  prefix to strip, no tag information traverses. Saves 23+ bytes per
  message on the legacy leg vs. today.
- **Pre-extension fork peers (IRCV3AWARE but on older code without `,C`
  parsing):** parser at [parse.c:1708-1711](nefarious/ircd/parse.c#L1708-L1711)
  reads time + msgid, stops at 22 chars or absorbs trailing as
  multi-msgid (via `+` separator). The `,` after msgid is not `+`, so
  multi-msgid loop stops at the right offset. Time/msgid extracted
  correctly; the `,C...` portion is ignored. Tags lost, no parse error.
- **New servers:** full extraction.

### Drop the verbose-format S2S parser path

[parse.c:1751-1782](nefarious/ircd/parse.c#L1751-L1782) currently has a
verbose-format fallback (`@time=ISO8601;msgid=...`) on the S2S receive
side. Nothing emits this — receive-side dead code. The current dispatch
heuristic ("no `=` → compact, has `=` → verbose") *does* break once
`+key=value;...` lands inside compact, since client tags contain `=`.

Drop the verbose path. Dispatch collapses to:

```c
if (ch[1] == 'A' && (tagend - ch) >= 23) {  /* 1 (@) + 1 (A) + 7 + 14 */
  /* compact format A */
}
/* else: malformed or unknown version; skip past @... to message proper */
```

Separate cleanup commit, but the right time to do it.

## Buffer sizing

- New per-Connection field: `cli_s2s_client_tags(cptr)`, sized 4096 to
  hold up to 4094 bytes of client tags (IRCv3 cap) plus null terminator
  and a few bytes of headroom. Mirrors the existing
  `con_client_tags[4096]` on the client side
  ([client.h:390](nefarious/include/client.h#L390)). Stored alongside
  `cli_s2s_msgid`.
- `format_s2s_tags` output buffer in `send.c` callers is currently 128
  bytes — needs ~4128 when client tags are present (4096 client tags +
  ~30 bytes for `@A`+time+msgid+`,C`+space). Suggest a separate
  `format_s2s_tags_with_client()` taking buflen.

The S2S receive line as a whole is bounded by `FULL_MSG_SIZE`
(8703 = `IRCV3_TAG_MAX` + `BUFSIZE`); we're well under that even with a
max-sized `,C` segment.

## Sender-side changes

### 1. format_s2s_tags extension

[send.c:422-462](nefarious/ircd/send.c#L422-L462) currently produces
`@A<time><msgid> `. Add a variant or extension that takes optional
client tags and appends `,C<tags>` before the trailing space:

```c
char *format_s2s_tags_with_client(char *buf, size_t buflen,
                                   struct Client *cptr,
                                   const char *client_tags,
                                   char *msgid_out, size_t msgid_out_len);
```

When `client_tags` is NULL or empty, behaves identically to
`format_s2s_tags`. When set, appends the `,C<tags>` segment.

### 2. Channel/private message relay

Pass `client_tags` through to the S2S formatter at the existing relay
sites:
- `sendcmdto_channel_butone_with_client_tags`
  ([send.c:2300](nefarious/ircd/send.c#L2300))
- `sendcmdto_one_client_tags`
- `sendcmdto_channel_client_tags`
- relay paths in `ircd_relay.c`: `relay_channel_message`,
  `relay_channel_notice`, `relay_private_message`,
  `relay_private_notice`. The four directed/masked variants currently
  drop tags entirely on send (they pass through bare `sendcmdto_one`/
  `sendcmdto_match_butone`); fix at the same time.

### 3. Per-link emission gate

Per the framework plan, the entire `@A...` compact-tag prefix is
dropped on emission to non-IRCV3AWARE peers (saves 23+ bytes on the
512-budget legacy leg). So:

- **IRCV3AWARE peer:** emit `@A<time><msgid>,C<client_tags>` prefix.
- **Non-IRCV3AWARE peer:** no `@A...` prefix at all. Bare command.

This is handled by the framework's per-destination two-buffer dispatch
described in [ircv3aware-s2s-framework.md](ircv3aware-s2s-framework.md).
This plan just specifies what the with-prefix buffer should contain
when client tags are present (the `,C<client_tags>` segment).

## Receiver-side changes

### 1. Parser

[parse.c:1709-1750](nefarious/ircd/parse.c#L1709-L1750) base parser:

- Drop the verbose-format path at
  [parse.c:1751-1782](nefarious/ircd/parse.c#L1751-L1782) (separate
  cleanup commit).
- Dispatch on version letter (`ch[1] == 'A'`), not `=` presence.
- After parsing time + msgid + optional multi-msgid, scan for `,C`
  segment. If present, copy the rest of the segment data into
  `cli_s2s_client_tags(cptr)`.
- HLC receive logic only on the time/msgid portion, not segment data.

### 2. ms_privmsg / ms_notice consumption

Pull `cli_s2s_client_tags(cptr)` and pass to local relay
(`sendcmdto_channel_butone_with_client_tags` etc.) so local recipients
see the tags. Today these handlers don't read client tags from the wire
at all; this is new code.

### 3. Connection state

- `cli_s2s_client_tags(cptr)` field on `Connection`, sized 4096.
- Cleared at top of parse_server() (where `cli_s2s_msgid` is cleared
  today, lines 1697-1700).

## Storage and bouncer interaction

Local storage (`store_channel_history`, etc.) already includes
`client_tags` from `cli_client_tags(sptr)`. The new wire path arrives at
the same cli_client_tags equivalent on the receive side, so storage is
transparent.

Bouncer alias relay uses local routing primitives that already pass
client tags. No change needed once the wire format is in place.

## Testing plan

### Unit-level

- Encode/decode round-trip:
  `format_s2s_tags_with_client(time, msgid, "+typing=active;+reply=ABC")`
  → parse on receive side → assert the same string comes out.
- Empty client_tags must produce no `,C` segment (zero overhead in the
  common case).
- Tags at the 4094-byte boundary.
- Multi-msgid + client tags simultaneously.
- Parser dispatch: malformed `@...` (no version letter) skips cleanly
  to the message proper without parse error.

### Integration

- Two-server testnet: client on hub PMs client on leaf with
  `+typing=active`, assert leaf client receives `+typing` tag.
- Same with `+channel-context`, `+reply`, `+react`.
- Mixed-version: hub on this code, leaf on previous code (compact-tag-
  aware but not extension-aware). Assert leaf parses time/msgid
  correctly and silently drops client tags (no parse error, no message
  loss).
- Legacy: leaf running upstream nefarious. Assert hub emits no
  `@A...` prefix toward legacy leaf (per framework gate). Bare command
  arrives; legacy parses normally. Tags lost (never sent), message
  intact, no `@A` strip-patch path exercised.
- Strip-patch fallback: if a legacy leaf somehow receives an `@A...`
  prefix from an older fork peer that hasn't yet adopted the per-link
  drop, the strip patch must still handle it correctly (its purpose
  doesn't go away, it's just exercised less). Verify the patch is in
  place on legacy peers as a safety net during rollout.

## Rollout

1. **Verbose-path drop** (separate commit, can land any time).
2. **Parser-side `,C<tags>` extraction.** No sender-side emission yet.
   Servers on this code parse the new segment from peers that emit it
   and pass through to local recipients. Ship.
3. **Sender-side, gated.** Emit the with-prefix buffer
   (`@A<time><msgid>,C<tags>`) only to IRCV3AWARE peers per the
   framework plan; non-IRCV3AWARE peers get the bare-command buffer
   (no `@A...`). Refuse-and-warn if a with-prefix line would exceed a
   sender-side cap (suggest 8000 bytes — leaves headroom under
   FULL_MSG_SIZE). On overflow: log, omit `,C` segment, send the base
   `@A<time><msgid>` form to that IRCV3AWARE peer (no fallback to
   legacy form — they're IRCV3AWARE, just over the size cap).

Steps 2 and 3 require the framework plan's CAPAB plumbing to be in
place; otherwise step 3 has no safe way to gate.

## Considered: tokenized client tags

P10 itself uses single-byte command tokens (`P` for PRIVMSG, etc.) and
the same logic could apply to known client tags — a registry mapping
`+typing` / `+reply` / `+react` etc. to short tokens with a literal
fallback for unknown names.

Declined for now. Savings are marginal in the common case (most
messages have 0-1 tags; tag names are already short — `+typing=active`
is 14 bytes), and on IRCV3AWARE hops the line budget is `FULL_MSG_SIZE`
(8703), so byte pressure isn't a real constraint. The case where every
byte matters — passing through legacy 512-byte hops — is exactly the
path where the extension carries no tags at all (CAPAB-gated).

If telemetry later shows a meaningful tag-heavy workload, reconsider as
an additional segment letter (`,T<tokenized>`) so receivers can handle
a mix from senders that adopted it before others. The format is
extensible in this direction; nothing here forecloses it.

## Out of scope

- IRCV3AWARE CAPAB plumbing — see framework plan.
- Multiline limits enforcement — separate plan
  ([s2s-multiline-limits.md](s2s-multiline-limits.md)), independent.
- Tokenized client tags (see "Considered").

## Open questions

1. Should `,C` be present when client_tags is the empty string? Default
   no — drop the segment entirely so common-case overhead is zero.
2. Cap client_tags at 4094 (IRCv3 max) at the sender, or rely on the
   parser at [parse.c:1487](nefarious/ircd/parse.c#L1487) to have
   already truncated? Sender-side belt-and-braces is cheap.
3. Multi-msgid + client_tags ordering: confirmed
   `+<msgid>+<msgid>...,C<tags>` — multi-msgid first, segments after.
