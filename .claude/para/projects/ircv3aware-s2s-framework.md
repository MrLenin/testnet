# IRCv3-aware S2S framework

**Status:** Investigation / planning
**Author:** ibutsu
**Date:** 2026-04-29

## Problem

Our fork has accumulated 22 P10 tokens not present in upstream legacy
nefarious — multiline, batch, chathistory, metadata, redact, monitor,
tagmsg, webpush, register, verify, gitsync, isupport, markread, mdbx, etc.
Each represents some IRCv3 (or fork-specific) capability that legacy
peers fundamentally cannot consume: their clients don't negotiate the
relevant CAPs, their parsers reject unknown tokens at
[parse.c:1572](nefarious-upstream/ircd/parse.c#L1572) with `is_unco++` and
no relay.

Today we emit these tokens to all server peers via `sendcmdto_serv_butone`
unconditionally. Legacy peers silently drop them. Two costs:

- **Wire bytes wasted** on every fork-only emission to a legacy peer.
- **512-byte line risk** — `dbuf_getmsg(..., BUFSIZE=512)` at
  [s_bsd.c:771](nefarious-upstream/ircd/s_bsd.c#L771) drops the entire
  line if it exceeds 512 bytes pre-strip. Adding `@A` compact-tag
  segments or large batch params can push routine messages near or over
  the limit on routes that include legacy hops, causing message loss
  rather than mere tag/extension loss.

Plus there's no clean way to add new fork-only S2S extensions without
each independently dealing with this concern.

## Solution: per-link IRCV3 capability

Add a P10 CAPAB token negotiated at server link time. Peers that
advertise it are flagged `FLAG_IRCV3AWARE`. Fork-only token emission is
gated on the flag.

Naming: `IRCV3` (token) and `FLAG_IRCV3AWARE` (Connection flag) — chosen
to describe the actual capability ("this peer speaks IRCv3 message-tag
extensions on the wire"), not the implementation ("we're a fork"). This
naming will survive a future merge upstream cleanly.

## Token gating rules

Mechanical rule:

- **Token in legacy/upstream `msg.h`** → always emit (it's known).
- **Token in our fork only** → skip emission to non-IRCV3AWARE peers.
- **BX (BOUNCER_TRANSFER) is the explicit exception** — see "Why BX
  is exempt" below.

The current set of fork-only tokens (diff our `msg.h` against
upstream's):

```
BO  BOUNCER             skip
BS  BOUNCER_SESSION     skip
BT  BATCH_CMD           skip
CH  CHATHISTORY         skip
CHGHOST                 skip (QUIT+JOIN fallback — see below)
CI  CACHEINVAL          skip
GS  GITSYNC             skip
HY  HISTORY             skip
IS  ISUPPORT            skip
MD  METADATA            skip
MDQ METADATAQUERY       skip
ML  MULTILINE           skip
MR  MARKREAD            skip
MX  MDBX                skip
RD  REDACT              skip
RG  REGISTER            skip
RN  RENAME              skip
RR  REGREPLY            skip
SR  SETNAME             skip (no fallback — see below)
TM  TAGMSG              skip (no-op fallback — see below)
VF  VERIFY              skip
WP  WEBPUSH             skip

BX  BOUNCER_TRANSFER    KEEP (always emit, see below)
```

### Note: MONITOR is not in the gating set

MONITOR (`MSG_MONITOR`/`TOK_MONITOR`) exists in our `msg.h` for parse
table consistency but is never emitted S2S — the parse table at
[parse.c:1139](nefarious/ircd/parse.c#L1139) has `m_ignore` in the
server state slot, so a MONITOR token from a peer is silently dropped.

Notifications cross servers via the underlying NICK / QUIT / NICK
change events, which each receiving server processes through
`check_status_watch()` locally. That function emits both the legacy
600-607 (WATCH) and IRCv3 730-734 (MONITOR) numeric formats to local
clients based on per-client `WATCH_FLAG_MONITOR` state, so legacy and
IRCv3 clients on either server get correct notifications without
MONITOR-the-command needing to traverse S2S.

No emission gate needed.

### Why BX is exempt

Legacy nefarious has been patched to handle the BX P numeric swap
(alias↔primary promotion) so the nick↔numeric map stays coherent
through mixed-version paths. Missing a BX P propagation through a
legacy hop desyncs that hop's view of nick ownership, breaking message
routing for the affected user.

The wasted bytes on the now-known-to-legacy BX token are accepted as
the cost of correctness. Other BX subcommands (C, X, A, …) ride the
same path because partitioning at the subcommand level isn't worth the
complexity.

## Spec-compliant fallbacks

For multiline and TAGMSG specifically, the IRCv3 spec defines what to
do when a peer can't consume the extension. Use those instead of the
ad-hoc parv hacks we accumulated pre-CAPAB.

### Multiline fallback (peer is non-IRCV3AWARE)

Per the multiline spec: emit the component messages as separate
PRIVMSG/NOTICE lines. Optionally apply our local truncation + paste-link
policy. **No `@`-prefixed start-token convention** — that was a fork
invention to squeeze tags through pre-CAPAB; with CAPAB in place, the
spec fallback is the right path.

The receive-side parser for the legacy ML start-token convention stays
in place for one cycle to handle peers still on old fork code, but new
emission stops.

### TAGMSG fallback (peer is non-IRCV3AWARE)

TAGMSG carries only message tags; with no tag-aware client on the
legacy side, the message is meaningless. **Don't send.** The current
parv[1] `@<tags>` convention at [m_tagmsg.c:290-291](nefarious/ircd/m_tagmsg.c#L290-L291)
was a fork invention to carry tags through; retire it on emit.
Receive-side parser stays for one cycle for peers still on old code.

### CHGHOST: not actually emitted S2S — n/a

[Verified during framework implementation 2026-04-30] CHGHOST in this
codebase is **only** emitted locally via
`sendcmdto_common_channels_capab_butone()` to clients on common
channels with the chghost CAP. There is no `sendcmdto_serv_butone(...
CMD_CHGHOST...)` anywhere — host changes propagate S2S via the user
mode change (+x and friends) emitting MODE on the wire, and each
receiving server runs its own `hide_hostmask()` locally to update its
copy of the user.

The framework gate (skip-list) entry for CHGHOST therefore has no
effect — there's no S2S emission to gate. No fallback needed. The
section below describing a QUIT+JOIN+MODE dance was based on a misread
of the code and is left for reference only; future maintainers should
ignore it unless someone adds an S2S CHGHOST emitter.

---

(historical, do not implement)

### CHGHOST fallback (peer is non-IRCV3AWARE) — superseded by note above

CHGHOST silently dropped on a legacy peer would leave that peer's
local clients with stale host information for the affected user — a
real desync, not just a feature gap. The traditional way to
communicate a host change is the QUIT/JOIN dance: emit a synthetic
QUIT for the user from the legacy peer's perspective, then re-JOIN
them to every common channel with the new host, plus a MODE to
restore any channel op/halfop/voice status.

**Existing art:** `hide_hostmask()` at
[s_user.c:1497-1648](nefarious/ircd/s_user.c#L1497-L1648) already does
exactly this dance locally on +x activation. It splits delivery
between CHGHOST-cap and non-CHGHOST-cap clients with the
`sendcmdto_common_channels_capab_butone()` cap-filter routing:

```c
/* QUIT for clients without chghost cap */
if (feature_bool(FEAT_HIDDEN_HOST_QUIT))
  sendcmdto_common_channels_capab_butone(cptr, CMD_QUIT, cptr,
                CAP_NONE, CAP_CHGHOST, ":%s",
                feature_str(FEAT_HIDDEN_HOST_SET_MESSAGE));

/* CHGHOST for clients with chghost cap */
if (feature_bool(FEAT_CAP_chghost))
  sendcmdto_common_channels_capab_butone(cptr, CMD_CHGHOST, cptr,
                CAP_CHGHOST, CAP_NONE, "%s %s",
                cli_user(cptr)->username, cli_user(cptr)->host);

/* JOIN + EXTJOIN variant + MODE +ohv restore per channel */
```

**Emit toward legacy peers as the same synthetic QUIT + JOIN + MODE
sequence**, scoped to the S2S wire (so the legacy peer's local clients
all see the change, regardless of whether they have chghost themselves
— legacy clients won't, fork-on-legacy clients might, doesn't matter
because the dance covers both). Fork peers receive the canonical
CHGHOST and process it directly via the existing local code path.

The S2S form just substitutes `FLAG_IRCV3AWARE` for `CAP_CHGHOST` in
the cap-filter routing — IRCV3AWARE peer = "speaks CHGHOST natively,"
non-IRCV3AWARE peer = "fall back to QUIT/JOIN."

Implementation cost: one Q + one J + one MODE per affected channel,
emitted only on the wire toward legacy peers. Cost scales with channel
count for the changed user; acceptable for typical use (handful of
channels).

### SETNAME fallback (peer is non-IRCV3AWARE)

There is no legacy IRC mechanism to push a realname change to a
client. Realname is shown in WHOIS but never pushed proactively.
Legacy clients with no `setname` CAP won't learn about a realname
change without explicit /WHOIS.

**No useful fallback exists.** Accept the desync: emit SETNAME to
IRCV3AWARE peers, skip to legacy peers. Legacy peer's clients hold
the previous realname until next WHOIS. Document as a known
limitation.

A QUIT+JOIN dance would update channel-visible state (which doesn't
include realname in the legacy JOIN format anyway) at the cost of
spurious join-spam in client UIs. Not worth it.

## Implementation

### Single helper

A wrapper around `sendcmdto_serv_butone` that filters out
non-IRCV3AWARE peers:

```c
void sendcmdto_serv_butone_v3(struct Client *from, const char *cmd,
                               struct Client *one, const char *pattern, ...);
```

Internally walks `cli_serv(&me)->down` (or wherever the down list lives),
emits only to peers with `FLAG_IRCV3AWARE` set. Replace the
unconditional `sendcmdto_serv_butone` call at every fork-only emission
site.

For BX, keep using the unconditional `sendcmdto_serv_butone`.

### CAPAB negotiation

Slot the new token into the existing CAPAB exchange in
`s_serv.c`/`m_server.c`. Token: `IRCV3`. On link establishment:
- Both sides advertise their CAPAB list.
- If both ends advertise `IRCV3`, set `FLAG_IRCV3AWARE` on the
  Connection.
- Otherwise, leave the flag clear; peer is treated as legacy.

### Connection flag

```c
#define FLAG_IRCV3AWARE  <next available bit>
#define IsIRCv3Aware(cli)  HasFlag((cli), FLAG_IRCV3AWARE)
```

Set during CAPAB exchange completion. Cleared on SQUIT/disconnect via
the standard flag-clear path.

## Rollout

1. **CAPAB token visibility** — DONE. Implemented as `+v` flag char in
   the existing P10 SERVER flag string (rather than a separate CAPAB
   exchange — same wire mechanism h/s/6/o use). `FLAG_IRCV3AWARE` set
   on `&me` at boot and on each peer when their SERVER advertises `v`.
   Initial-handshake emission at completed_connection() and
   completed_server_connection() updated to include `v`. Commits
   `e377159` and `f90c503`.

2. **Helper + emission gates** — DONE. `sendcmdto_serv_butone_v3()`
   added at `cab0db4`; 14 fork-only token call sites converted at
   `350769a`. BX call sites unchanged. CHGHOST turned out to never be
   emitted S2S so no gating site exists for it — see "CHGHOST: not
   actually emitted S2S" note above.

3. **Spec-compliant fallbacks** — partial:
   - **TAGMSG** — DONE by virtue of v3 gating. Legacy peers don't
     receive TAGMSG at all (which IS the spec fallback — TAGMSG without
     message-tags client cap is meaningless). The parv[1] `@<tags>`
     receive-side parser stays for backward compat with older fork
     peers; consumer-side handling lands at `3bf7fa8`.
   - **SETNAME** — DONE by gating. Legacy peers don't receive; their
     local clients hold stale realname until next WHOIS. Documented as
     accepted limitation.
   - **Multiline** — TODO. Currently legacy peers receive nothing
     (their multiline-incompatible clients can't reassemble batches
     anyway), but the spec recommends emitting component messages
     individually. This is a substantial change to the multiline emit
     path and is deferred to a separate commit.

4. **Removal of legacy ad-hoc receive parsers** — TODO, after observed
   traffic confirms no peer still emits them. Long horizon.

Steps 1-2 plus partial step 3 are shipped and operational. Multiline
component-message fallback (the remaining piece of step 3) is the
biggest deferred item.

## Buffer/size implications on legacy hops

Pre-strip 512-byte limit ([s_bsd.c:771](nefarious-upstream/ircd/s_bsd.c#L771))
means any line we emit toward a legacy peer must fit in 512 bytes.
With this plan, fork-only tokens aren't sent to legacy at all, so
token-induced overflow is no longer a concern on legacy hops.

Additionally: **drop the `@A<time><msgid>` compact-tag prefix entirely
when emitting to non-IRCV3AWARE peers.** Legacy strips it on receive
anyway (per the legacy strip-patch), and even via the legacy peer to a
downstream fork peer the prefix doesn't survive — it's stripped before
forward. So the 23 bytes are pure overhead on the legacy leg with no
upside.

Effect: per-link two-buffer dispatch. The S2S send infrastructure
builds two MsgBufs per emission:
- **with-prefix** (for IRCV3AWARE peers): `@A<time><msgid>` + command,
  optionally with `,C<client_tags>` (per the compact-client-tags plan)
- **without-prefix** (for non-IRCV3AWARE peers): bare command, no `@A`

The per-destination dispatch loop picks based on the peer's
`FLAG_IRCV3AWARE`. This pattern already exists locally in
[send.c:2310-2369](nefarious/ircd/send.c#L2310-L2369) where
`serv_mb_tags` and `serv_mb` are built side-by-side; the change is to
make the choice per-destination rather than globally based on
`FEAT_P10_MESSAGE_TAGS`.

The 512-byte risk on legacy hops is now just normal command params
(PRIVMSG, NICK, etc.) — better than today, since the 23-byte prefix
overhead is gone.

For IRCV3AWARE hops, the budget is `FULL_MSG_SIZE` (8703), comfortably
accommodating compact-tag prefix + `,C<client_tags>`.

## Out of scope

- The `,C<client_tags>` compact-tag extension itself —
  see [p10-compact-client-tags.md](p10-compact-client-tags.md), which
  consumes this framework.
- Multiline limits enforcement (network-max-receive, local-cap-send) —
  see [s2s-multiline-limits.md](s2s-multiline-limits.md), independent of
  this framework.
- Replacing the legacy strip-patch — assumed prereq.
- Path-aware capability tracking. P10 doesn't easily express "my peer's
  downstream supports the extension," so behaviour is per-hop only:
  fork-only tokens reach as far as a contiguous chain of IRCV3AWARE
  peers and stop at the first legacy hop. Acceptable.

## Open questions

1. Does `BO` (BOUNCER) need to be on the keep list for any reason?
   Default is skip; check if there's an operational dependency on it
   reaching legacy peers.
2. `CHGHOST` is widely supported on other ircds but not legacy
   nefarious specifically. Skip is consistent with the rule but worth
   confirming no legacy peer in the network depends on it.
3. Should `sendcmdto_serv_butone_v3()` log dropped emissions for
   diagnostic purposes, or stay silent? Default suggest silent;
   add behind a debug flag if needed.
