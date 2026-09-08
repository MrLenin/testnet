# Chat History

Implementation of `draft/chathistory` IRCv3 extension in Nefarious IRCd with federation support.

## Overview

Chathistory provides message replay functionality, allowing clients to retrieve messages sent while they were offline or before they joined a channel. Nefarious implements both local LMDB storage and cross-server federation.

## Architecture

### Local Storage

```
Client Request
      │
      ▼
┌──────────────────┐
│ CHATHISTORY cmd  │
│ (m_chathistory.c)│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   LMDB Storage   │
│ (history/*.mdb)  │
└──────────────────┘
```

### Federation (Multi-Server)

```
Client ─► Server A ─┬─► Local LMDB
                    │
                    └─► CH Q ─► Server B ─► CH R ─► Merge ─► Client
                              ├─► Server C ─► CH R ─┘
                              └─► Server D ─► CH R ─┘
```

## Feature Flags

### Storage Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_chathistory` | TRUE | Enable capability advertisement |
| `FEAT_CHATHISTORY_STORE` | TRUE | Store messages locally |
| `FEAT_CHATHISTORY_MAX` | 100 | Max messages per request |
| `FEAT_CHATHISTORY_DB` | "history" | LMDB database path |
| `FEAT_CHATHISTORY_RETENTION` | 7 | Days to keep messages |

### Federation Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CHATHISTORY_FEDERATION` | TRUE | Enable S2S queries |
| `FEAT_CHATHISTORY_TIMEOUT` | 5 | S2S response timeout (sec) |
| `FEAT_CHATHISTORY_WRITE_FORWARD` | TRUE | Forward writes to storage servers |
| `FEAT_CHATHISTORY_STORE_REGISTERED` | TRUE | Store registered channels on non-storage servers |

### Storage Management

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CHATHISTORY_HIGH_WATERMARK` | 85 | % usage to trigger eviction |
| `FEAT_CHATHISTORY_LOW_WATERMARK` | 75 | % usage target after eviction |
| `FEAT_CHATHISTORY_MAINTENANCE_INTERVAL` | 300 | Seconds between maintenance |
| `FEAT_CHATHISTORY_EVICT_BATCH_SIZE` | 1000 | Max entries per eviction cycle |
| `FEAT_CHATHISTORY_STRICT_TIMESTAMPS` | FALSE | Reject old timestamps |

### PM History Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CHATHISTORY_PRIVATE` | FALSE | Enable PM history |
| `FEAT_CHATHISTORY_PRIVATE_CONSENT` | 2 | PM consent mode |
| `FEAT_CHATHISTORY_ADVERTISE_PM` | FALSE | Advertise PM policy in CAP |
| `FEAT_CHATHISTORY_PM_NOTICE` | FALSE | Send policy notice on connect |

## Client Commands

### CHATHISTORY Subcommands

```
CHATHISTORY LATEST <target> * <limit>
CHATHISTORY BEFORE <target> <msgid|timestamp> <limit>
CHATHISTORY AFTER <target> <msgid|timestamp> <limit>
CHATHISTORY AROUND <target> <msgid|timestamp> <limit>
CHATHISTORY BETWEEN <target> <start> <end> <limit>
CHATHISTORY TARGETS <timestamp> <timestamp> <limit>
```

### Reference Formats

- **Timestamp**: `timestamp=2024-01-15T10:30:00.000Z`
- **Message ID**: `msgid=ABC123-DEF456`

### ISUPPORT tokens

| Token | Source | Meaning |
|---|---|---|
| `CHATHISTORY=<n>` | draft/chathistory spec | Maximum rows per request (`CHATHISTORY_MAX`). |
| `MSGREFTYPES=timestamp,msgid` | draft/chathistory spec | Reference types accepted. |
| `evilnet/CHATHISTORYRETENTION=<seconds>` | **fork extension** | This server does not retain history older than `now - seconds` (`CHATHISTORY_RETENTION` days × 86400). Storage servers only. |

`evilnet/CHATHISTORYRETENTION` is a hint, not a permission. A client should not page
past the horizon it names: a request past it still gets an honest answer (an
empty batch with `draft/chathistory-end`, or `FAIL CHATHISTORY MESSAGE_ERROR`
for an anchor msgid the store cannot place), it is just wasted round trips.
Federated peers may keep more or less; the token describes the server the
client is connected to. The value follows a rehash or `SET
CHATHISTORY_RETENTION` and is re-announced to clients that negotiated
`draft/extended-isupport`. Why an ISUPPORT token and not a capability:
every client keeps an ISUPPORT map and no negotiation is needed. Why the
`evilnet/` prefix: IRCv3 prefixes work-in-progress ISUPPORT names the same
way it prefixes capabilities (the network-icon draft mandates `draft/ICON`
and reserves bare `ICON` for the final spec), so a fork-only token belongs
under the vendor namespace. The fork's older bare `RELOCATE` predates this
rule (`VAPID` is the draft/webpush spec's own token, not a fork one). Motivating case
(2026-09-08): a client kept paging a PM buffer back to May using a pre-repack
msgid, four months past a 7-day retention.

### Example

```
CHATHISTORY LATEST #channel * 50
:server BATCH +abc chathistory #channel
@batch=abc;time=... :nick!user@host PRIVMSG #channel :Hello
@batch=abc;time=... :nick!user@host PRIVMSG #channel :World
:server BATCH -abc
```

### Completeness: the `evilnet.github.io/chathistory-partial` batch tag

Stores can only diverge through a netsplit: every storage server records every
message it sees while linked, so two stores disagree exactly over windows in
which one of them was not linked. A query is answered by the local store plus a
fan-out to the storage servers currently linked, and the fan-out only happens
when the local page is short. Two things follow, and the tag covers both:

1. **A store that is split is not consulted and, until now, forgotten.** The
   server keeps an *absence interval* per storage server it has ever seen
   advertise (`[SQUIT time, relink time)`, open while the server is away,
   pruned once older than retention). A query whose span overlaps an absence
   interval of a server that is **still absent** is answered `partial`.
2. **After a relink a full local page hides the other side's rows.** A query
   whose span overlaps a *closed* absence interval always fans out, even when
   the local page is full, so the merged answer really covers the span.

The span of a query is the rows returned when the page was full (that is what
the answer covers), else the requested window with open ends at `now` and
`now - retention`.

`evilnet.github.io/chathistory-partial` is set on the `chathistory` batch
opener when any of these held when the answer was assembled:

- a storage server whose absence interval overlaps the span is still absent;
- a responder was still outstanding when the federation timeout fired or when
  it was SQUIT mid-query;
- the aggregate federation cap dropped rows from the merge;
- no federation slot was free and the page fell back to local-only.

When the tag is set `draft/chathistory-end` is withheld, so a client that does
not know the tag keeps its existing safe behaviour. When the tag is absent the
rows are a durable answer for the span they cover, whether or not the end tag
is present (the end tag still means only "the walk was exhausted"). A local
scan-cap truncation is not partial: it stops early but leaves no hole inside
the rows returned.

Limits: the absence table is per origin, so a server that never saw a store's
ad cannot flag its absence (wave-3 re-flooding makes that rare after the first
link cycle); and a window older than a store's own advertised retention is
complete without that store by design, not partial.

Motivation (2026-09-08): a client-side coverage map ("verified spans") needs to
know whether an answer can be trusted durably; without this bit it has to guess
splits from QUIT floods.

#### Companions: incarnation filter and gate-derived storage

Forcing the fan-out over split windows would surface a hole that already exists
today: a channel recreated on the split side (new creation timestamp; the burst
wipes it on relink) is a different incarnation, and its rows must not become
the surviving channel's history just because a main-side member's presence
record for that name was open. Every channel row records the channel's creation
timestamp at store time; the local walk and the federated responder drop rows
whose incarnation is not the live channel's (rows without a stamp, from before
this change, count as current). The losing side also **prunes** them: the burst
wipeout is the moment a server learns its incarnation lost, so it deletes every
row of that channel stamped with the losing creationtime (`history_purge_incarnation`,
called from `m_burst.c`). Every store that held them is on the losing side, so
all of them prune; the read-time filter stays as belt and braces. Prune, not
tombstone: the only person who could ever have reported those rows is a
bystander who saw them live, so an audit trail nobody can find is not one.

**Open (2026-09-08): identity across cold starts.** A channel's creation
timestamp is its incarnation, and today two paths mint a fresh one on a
network-wide cold start: X3 bursts registered channels at its own start time,
and the bouncer restore recreates held ghosts' channels at boot time. A whole-
network restart would therefore hide all stamped history (rows stamped before
this change count as current). Agreed direction with upstream: X3 captures the
channel's timestamp at registration and bursts it thereafter (the registered
channel's key becomes name + timestamp, like accounts), the bouncer record
persists the creation time for held channels, and unregistered unheld channels
are ephemeral: their history dies with the incarnation (purge on destruct, to
follow). Losing that history on a full-network crash is accepted. A same-incarnation split (both sides kept the
channel) merges normally: those rows are that channel's history and everyone
present on the surviving side sees them, ops included, and can REDACT.

Storage follows the retrieval policy: a row that no enabled gate would ever let
anyone retrieve is not stored. This is existing behaviour (channel.c /
ircd_relay.c storage gate): with `CHATHISTORY_REQUIRE_AUTH` on, a row sent into
a channel with no authenticated member (`authusers == 0`) is skipped unless the
channel is `+H` public-history. Strict presence never gates storage: every
connection has a presence anchor (account or ephemeral session), so someone
present can always retrieve. The sender counts as a member, so a user alone in
a scratchpad channel keeps their own history. There is no sole-member cull: it
would make history incomplete and break single-user channels. Policy changes
are not retroactive: rows skipped while a gate was on are gone.

## P10 Federation Protocol

### Token: `CH` (CHATHISTORY)

### Advertisement Subcommands (Phase 3)

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `A S` | `CH A S <retention>` | Storage capability |
| `A R` | `CH A R <retention>` | Retention update |
| `A F` | `CH A F :<channels>` | Full channel list |
| `A +` | `CH A + :<channels>` | Add channel(s) |
| `A -` | `CH A - :<channels>` | Remove channel(s) |

### Query Subcommands

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `Q` | `CH Q <target> <subcmd> <ref> <limit> <reqid>` | Query request |
| `R` | `CH R <reqid> <msgid> <ts> <type> <sender> <acct> :<text>` | Response (plain text) |
| `Z` | `CH Z <reqid> <msgid> <ts> <type> <sender> <acct> :<b64_zstd>` | Response (compressed) |
| `B` | `CH B <reqid> <msgid> <ts> <type> <sender> <acct> [+] :<b64>` | Response (chunked) |
| `E` | `CH E <reqid> <count>` | End of response |

**Response Types**:
- `CH R`: Plain text content, used when message fits in single P10 line
- `CH Z`: Zstd-compressed content (base64 encoded) for bandwidth savings
- `CH B`: Base64-encoded content with chunking for large/multiline messages

### Write Forward Subcommands (Phase 4)

| Subcmd | Format | Purpose |
|--------|--------|---------|
| `W` | `CH W <target> <msgid> <ts> <sender> <acct> <type> :<text>` | Single message |
| `WB` | `CH WB <target> <msgid> <ts> <sender> <acct> <type> [+] :<b64>` | Batch chunk |

## PM Consent Modes

Users control PM history storage via metadata:

```
METADATA * SET chathistory.pm * :1    # Opt in
METADATA * SET chathistory.pm * :0    # Opt out
METADATA * CLEAR chathistory.pm       # Use server default
```

### Mode 0: Global (Least Private)

All PMs stored unless either party explicitly opts out.

### Mode 1: Single-Party

Store if sender OR recipient has opted in. Opt-out overrides.

### Mode 2: Multi-Party (Default, Most Private)

Store only if BOTH sender AND recipient have opted in.

## Storage Decoupling

The `STORE` flag decouples storage from capability:

| STORE | CAP | Behavior |
|-------|-----|----------|
| TRUE | TRUE | Full storage server |
| FALSE | TRUE | Relay server (queries only) |
| TRUE | FALSE | Silent storage |
| FALSE | FALSE | No chathistory |

**Relay servers** forward queries via federation without local storage overhead.

## Write Forwarding

When `STORE=FALSE` and `WRITE_FORWARD=TRUE`:

1. Message arrives at relay server
2. Relay forwards via `CH W` to storage servers
3. Storage servers store and ACK
4. Client queries hit storage servers via federation

## Watermark Eviction

Prevents unbounded storage growth:

1. Maintenance timer checks usage every `MAINTENANCE_INTERVAL`
2. If usage > `HIGH_WATERMARK` (85%), eviction starts
3. Oldest entries evicted in batches of `EVICT_BATCH_SIZE`
4. Continues until usage <= `LOW_WATERMARK` (75%)

## LMDB Storage Format

### Key Structure

```
Channel: c:<channel>:<msgid>
PM:      p:<account1>:<account2>:<msgid>
```

### Value Structure

```
<timestamp>|<sender>|<account>|<type>|<text>
```

## Example Configuration

```
features {
    "CAP_chathistory" = "TRUE";
    "CHATHISTORY_STORE" = "TRUE";
    "CHATHISTORY_MAX" = "100";
    "CHATHISTORY_DB" = "history";
    "CHATHISTORY_RETENTION" = "7";
    "CHATHISTORY_FEDERATION" = "TRUE";
    "CHATHISTORY_WRITE_FORWARD" = "TRUE";
    "CHATHISTORY_PRIVATE" = "TRUE";
    "CHATHISTORY_PRIVATE_CONSENT" = "2";
};
```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*
