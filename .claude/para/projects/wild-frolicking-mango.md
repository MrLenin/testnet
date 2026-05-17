# P10 Compact S2S Message Tags

**Status**: ✅ Implementation complete — all 12 steps done. Needs build verification.

## Context

P10 is traditionally a very terse protocol: single-letter tokens (`P`, `O`, `N`), base64 numerics (`ABAAA`), base64-encoded IPs. But `P10_MESSAGE_TAGS` bolts on verbose IRCv3 C2S tag syntax:

```
@time=2026-03-06T12:34:56.789Z;msgid=AA-1772784000-42 ABAAA P #channel :Hello
```

That's ~55 bytes of tag overhead on a ~30 byte P10 message — nearly tripling it. This is inconsistent with P10's design philosophy and adds unnecessary wire bloat on every PRIVMSG/NOTICE across every S2S link.

Additionally, the current implementation has several design issues:
1. **Only two tags hardcoded** — `@time` and `@msgid` with fixed-size buffers, no extensibility mechanism
2. **Only PRIVMSG/NOTICE** — no path for future tag-bearing commands (channel events need tags for chathistory dedup)

This plan replaces the verbose format with a compact, P10-native wire encoding and extends tags to channel events.

**Design decision**: No per-server negotiation. `P10_MESSAGE_TAGS` always sends compact format. S2S tags only exist on IRCv3-capable servers; legacy/upstream servers that don't understand tags simply ignore them (X3 strips them). The parser auto-detects both formats for robustness.

## Compact Wire Format

### Current vs Compact

```
CURRENT (~55 bytes tag overhead):
@time=2026-03-06T12:34:56.789Z;msgid=AA-1772784000-42 ABAAA P #ch :hi

COMPACT (24 bytes tag overhead):
@ABYjklmAAABJrQAAAAAAmk ABAAA P #ch :hi
 │└─time─┘└──-msgid-───┘
 └─version byte
```

**56% reduction** in tag overhead.

### Format Specification

```
@<version:1><time:7><msgid:14> <P10_message>
```

| Field | Chars | Encoding | Range |
|-------|-------|----------|-------|
| `@` | 1 | literal | tag prefix |
| version | 1 | P10 base64 | `A` = v0 (time+msgid). 64 possible versions. |
| time | 7 | P10 base64 epoch_ms | 42 bits → covers until year 2109 |
| msgid | 14 | `YY`(2 chars, server numeric) + `EEEEEE`(6 chars, creation epoch b64) + `QQQQQQ`(6 chars, counter b64) | 12+36+36 = 84 bits total |
| ` ` | 1 | literal | separator |
| **Total** | **24** | | |

### Format Auto-Detection

P10 base64 alphabet (`A-Za-z0-9[]`) does **not** contain `=`. Verbose IRCv3 tags always contain `=` (`time=...;msgid=...`). So:
- Contains `=` → verbose format (parse as key=value pairs)
- No `=` → compact format (positional decode from version byte)

This allows parsers to accept both formats. Incoming verbose tags from older servers or during migration are handled transparently.

### Msgid Format Change

`generate_msgid()` changes from decimal to compact base64:

```
OLD:  AA-1772784000-42     (variable length, up to ~25 chars)
NEW:  AABJrQAAAAAAmk       (fixed 14 chars)
```

Msgids are opaque strings everywhere — chathistory storage, client `@msgid=` delivery, CH W federation. Old and new format msgids coexist in the DB without issues. The `channel.c` duplicate msgid generator consolidates to use `generate_msgid()`.

### Version Byte Extensibility

Version `A` (initial and only version) defines: time(7) + msgid(14) = 22 payload chars. Future versions could add fields (batch_ref, etc.). Parsers encountering an unknown version byte skip the tag block. Costs 1 byte, provides clean forward compatibility.

## Implementation

### Step 1: 64-bit Base64 Functions

**Files**: `nefarious/ircd/numnicks.c`, `nefarious/include/numnicks.h`

Epoch milliseconds needs >32 bits. Add `uint64_t` variants alongside existing 32-bit functions:

```c
const char* inttobase64_64(char* buf, uint64_t v, unsigned int count);
uint64_t base64toint_64(const char* s);
```

Same shift-and-mask algorithm as existing `inttobase64`/`base64toint` (which use `unsigned int`), just with `uint64_t` types. Uses the existing static `convert2y`/`convert2n` tables.

### Step 2: Connection Struct Changes

**Files**: `nefarious/include/client.h`

#### Time storage: `char[32]` → `uint64_t`

The current `con_s2s_time[32]` stores ISO 8601 strings, creating a wasteful encode→decode→encode cycle when relaying between servers (compact→ISO on receive, ISO→compact on send). Store epoch milliseconds directly:

```c
/* Old: */
char                con_s2s_time[32];  /**< S2S @time tag from incoming message */

/* New: */
uint64_t            con_s2s_time_ms;   /**< S2S @time as epoch milliseconds (0 = not set) */
```

Update macros:

```c
/* Old: */
#define cli_s2s_time(cli)   con_s2s_time(cli_connect(cli))
#define con_s2s_time(con)   ((con)->con_s2s_time)

/* New: */
#define cli_s2s_time_ms(cli)  con_s2s_time_ms(cli_connect(cli))
#define con_s2s_time_ms(con)  ((con)->con_s2s_time_ms)
```

Only 3 call sites use the time field (parse.c write, send.c read, parse.c clear) — clean conversion.

#### Msgid buffer size constant

Add a named constant for the msgid buffer. **Cannot shrink from 64 yet** — during mixed-version operation, verbose-format msgids from older servers can be up to ~34 chars. The buffer must accommodate both formats until all servers are upgraded.

```c
/** S2S msgid buffer size. Large enough for both verbose (AA-1772784000-42, ~34 chars max)
 * and compact (AABJrQAAAAAAmk, 14 chars) formats during mixed-version transition.
 * TODO: Shrink to 16 once all network servers use compact format. */
#define S2S_MSGID_BUFSIZE 64
```

Replace the struct field:

```c
/* Old: */
char                con_s2s_msgid[64];

/* New: */
char                con_s2s_msgid[S2S_MSGID_BUFSIZE];
```

### Step 3: Compact generate_msgid()

**File**: `nefarious/ircd/send.c` (line ~283)

```c
char *generate_msgid(char *buf, size_t buflen)
{
    char creation_b64[7], counter_b64[7];
    inttobase64_64(creation_b64, (uint64_t)cli_firsttime(&me), 6);
    inttobase64_64(counter_b64, (uint64_t)(++MsgIdCounter), 6);
    snprintf(buf, buflen, "%s%s%s",
             cli_yxx(&me), creation_b64, counter_b64);
    return buf;
}
```

Uses `inttobase64_64()` (from Step 1) to encode both fields with their full value range — 6 base64 chars = 36 bits each. Output: 14 chars fixed (`YYEEEEEEQQQQQQ`). 36 bits for counter = ~68 billion msgs before wrap.

**Note**: `generate_msgid()` is already declared in `send.h:256`. No header changes needed.

### Step 4: Verbose Time Parsing Helper

**Files**: `nefarious/ircd/send.c`, `nefarious/include/send.h`

Only needed for backward compatibility — parsing verbose ISO 8601 timestamps from older servers into `uint64_t` epoch_ms. Used in both `send.c` (Step 5) and `parse.c` (Step 6), so must be non-static with a header declaration:

```c
/* In send.c: */
/** Parse ISO 8601 timestamp to epoch milliseconds.
 * Used for re-encoding verbose-format S2S time tags to compact format.
 * Returns 0 on parse failure. */
uint64_t iso8601_to_epoch_ms(const char *iso)
{
    struct tm tm;
    int ms = 0;
    memset(&tm, 0, sizeof(tm));
    if (sscanf(iso, "%d-%d-%dT%d:%d:%d.%dZ",
               &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
               &tm.tm_hour, &tm.tm_min, &tm.tm_sec, &ms) < 6)
        return 0;
    tm.tm_year -= 1900;
    tm.tm_mon -= 1;
    return (uint64_t)timegm(&tm) * 1000 + ms;
}

/* In send.h: */
extern uint64_t iso8601_to_epoch_ms(const char *iso);
```

No separate `encode_time_b64`/`decode_time_b64` wrappers needed — `inttobase64_64(buf, epoch_ms, 7)` and `base64toint_64(buf)` from Step 1 are used directly.

### Step 5: Compact format_s2s_tags()

**File**: `nefarious/ircd/send.c` (line ~302)

Rework `format_s2s_tags()` to always produce compact format, reading epoch_ms directly:

```c
static char *format_s2s_tags(char *buf, size_t buflen, struct Client *cptr,
                             char *msgid_out, size_t msgid_out_len)
{
    char time_b64[8], msgidbuf[S2S_MSGID_BUFSIZE];
    uint64_t epoch_ms;
    const char *msgid_tag = NULL;

    if (!feature_bool(FEAT_P10_MESSAGE_TAGS))
        return NULL;

    /* Time: use preserved epoch_ms from incoming, or generate fresh */
    if (cptr && cli_s2s_time_ms(cptr))
        epoch_ms = cli_s2s_time_ms(cptr);
    else {
        struct timeval tv;
        gettimeofday(&tv, NULL);
        epoch_ms = (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    }

    /* Msgid: use preserved from incoming, or generate new */
    if (cptr && cli_s2s_msgid(cptr)[0])
        msgid_tag = cli_s2s_msgid(cptr);
    else {
        generate_msgid(msgidbuf, sizeof(msgidbuf));
        msgid_tag = msgidbuf;
    }

    /* Store msgid for caller if requested (for echo-message) */
    if (msgid_out && msgid_out_len > 0) {
        ircd_strncpy(msgid_out, msgid_tag, msgid_out_len);
    }

    /* Compact: @A<time_7><msgid_14> */
    inttobase64_64(time_b64, epoch_ms, 7);
    snprintf(buf, buflen, "@A%s%s ", time_b64, msgid_tag);
    return buf;
}
```

No ISO 8601 formatting on the output path — epoch_ms encodes directly to base64. The encode→decode→encode cycle from the original design is eliminated.

### Step 6: Compact Parsing in parse.c

**File**: `nefarious/ircd/parse.c` (line ~1668)

Replace tag clearing and add compact format auto-detection before existing verbose parsing:

```c
/* Clear previous S2S tags */
cli_s2s_time_ms(cptr) = 0;
cli_s2s_msgid(cptr)[0] = '\0';

if (*ch == '@') {
    char *tagend = strchr(ch, ' ');
    if (tagend) {
        if (!memchr(ch + 1, '=', tagend - ch - 1)) {
            /* COMPACT FORMAT: @<version><time_7><msgid_14> */
            int tag_len = tagend - ch - 1;
            if (tag_len >= 22 && ch[1] == 'A') {  /* version A, 1+7+14=22 */
                char time_b64[8];

                /* Decode time: 7 base64 chars → epoch_ms */
                memcpy(time_b64, ch + 2, 7);
                time_b64[7] = '\0';
                cli_s2s_time_ms(cptr) = base64toint_64(time_b64);

                /* Extract msgid: 14 chars */
                if (14 < S2S_MSGID_BUFSIZE) {
                    memcpy(cli_s2s_msgid(cptr), ch + 9, 14);
                    cli_s2s_msgid(cptr)[14] = '\0';
                }
            }
        } else {
            /* VERBOSE FORMAT: existing key=value parsing */
            char *tagpos = ch + 1;
            while (tagpos < tagend) {
                char *tag_name = tagpos;
                char *semicolon = memchr(tagpos, ';', tagend - tagpos);
                int tag_len = semicolon ? (semicolon - tagpos) : (tagend - tagpos);

                if (tag_len >= 5 && memcmp(tag_name, "time=", 5) == 0) {
                    int value_len = tag_len - 5;
                    /* Convert verbose ISO 8601 to epoch_ms */
                    char iso_buf[32];
                    if (value_len < (int)sizeof(iso_buf)) {
                        memcpy(iso_buf, tag_name + 5, value_len);
                        iso_buf[value_len] = '\0';
                        cli_s2s_time_ms(cptr) = iso8601_to_epoch_ms(iso_buf);
                    }
                }
                else if (tag_len >= 6 && memcmp(tag_name, "msgid=", 6) == 0) {
                    int value_len = tag_len - 6;
                    if (value_len < S2S_MSGID_BUFSIZE) {
                        memcpy(cli_s2s_msgid(cptr), tag_name + 6, value_len);
                        cli_s2s_msgid(cptr)[value_len] = '\0';
                    }
                }

                if (semicolon) tagpos = semicolon + 1;
                else break;
            }
        }
        ch = tagend;
        while (*ch == ' ') ch++;
    }
}
```

Note: `iso8601_to_epoch_ms()` (from Step 4) is declared in `send.h` — parse.c already includes it.

### Step 7: Update ircd_relay.c Hardcoded Buffer Sizes

**File**: `nefarious/ircd/ircd_relay.c`

Four call sites pass hardcoded `64` as the buffer size to `generate_msgid()`:

```c
/* All follow this pattern: */
generate_msgid(cli_s2s_msgid(one), 64);
```

Replace with the named constant:

```c
generate_msgid(cli_s2s_msgid(one), S2S_MSGID_BUFSIZE);
```

This ensures the buffer size stays consistent with the struct definition. All four locations:
- Line 643 (channel PRIVMSG relay — alias tag preservation)
- Line 731 (channel NOTICE relay — alias tag preservation)
- Line 1290 (PM PRIVMSG relay — remote origin)
- Line 1387 (PM NOTICE relay — remote origin)

Note: Four other `generate_msgid()` calls in ircd_relay.c use `sizeof(pm_msgid)` for local buffers — those are already correct and don't need updating.

### Step 8: Simplify Send Functions

**File**: `nefarious/ircd/send.c`

`format_s2s_tags()` now always produces compact format — no format switching needed. The existing send functions already use a simple pattern with local `s2s_tagbuf[128]` buffers. No structural changes required to the send functions themselves; they call `format_s2s_tags()` which now returns compact output.

**`sendcmdto_one()` (line ~960)**: No changes needed — already calls `format_s2s_tags()` and uses the result.

**`sendcmdto_channel_butone()`** and **`sendcmdto_channel_butone_with_client_tags()`**: Same — `format_s2s_tags()` call stays unchanged.

The 128-byte `s2s_tagbuf` is still adequate — compact format is only 24 chars.

### Step 9: Consolidate channel.c Msgid

**File**: `nefarious/ircd/channel.c` (line 85, 129-131)

Remove `channel_history_msgid_counter`. Call `generate_msgid()` instead:

```c
/* Before: */
ircd_snprintf(0, msgid, sizeof(msgid), "%s-%lu-%lu",
              cli_yxx(&me), (unsigned long)cli_firsttime(&me),
              ++channel_history_msgid_counter);

/* After: */
generate_msgid(msgid, sizeof(msgid));
```

Counter uniqueness is maintained since channel events and messages share `MsgIdCounter`. `generate_msgid()` is already declared in `send.h` — just ensure `channel.c` includes it (likely already does).

## S2S Tags on Channel Events (JOIN, PART, KICK, TOPIC)

### Why Events Need Tags Too

Channel events have the same chathistory dedup problem as PRIVMSG/NOTICE. If a user JOINs #channel and both servers store that event with independently-generated msgids, federated chathistory queries can't deduplicate them. Timestamp-based dedup is unreliable due to clock skew.

### QUIT: Derived Msgids

**Note: Forward-looking infrastructure.** Currently `store_quit_events()` only stores events for local users (`if (!MyUser(sptr)) return`), so there's no cross-server duplication to deduplicate today. This derivation system lays the groundwork for when remote QUIT storage is added (see "Event Storage Note" below). The S2S tag on QUIT is still useful immediately for preserving timestamp fidelity across relays.

QUIT is a 1:N case — one S2S QUIT message produces N separate chathistory entries (one per channel). A single S2S msgid can't serve as the storage ID for N independent events. But the IRCv3 `msgid` spec explicitly allows encoding additional information within the ID:

> "Servers might wish to encode additional information within the ID, for internal use only."

**Solution**: The S2S QUIT carries one **base msgid** in its tag. Each server deterministically **derives** per-channel msgids from it. Both servers compute the same derived ID → dedup works.

#### Derivation Function

```c
/** Derive a per-channel msgid from a base msgid and channel name.
 * Deterministic: same (base, channel) → same result on every server.
 * Used for QUIT events where one S2S msgid maps to N channel entries. */
static char *derive_channel_msgid(char *buf, size_t buflen,
                                  const char *base_msgid, const char *channel)
{
    /* FNV-1a hash of channel name (case-insensitive) */
    uint32_t h = 2166136261u;
    const char *p;
    char disc[7];

    for (p = channel; *p; p++) {
        h ^= (uint32_t)(unsigned char)ToLower(*p);
        h *= 16777619u;
    }

    /* 6 base64 chars = 32 bits effective (top 4 bits zero).
     * Birthday collision at 1000 channels: ~10^-4. Acceptable. */
    inttobase64(disc, h, 6);
    snprintf(buf, buflen, "%s%s", base_msgid, disc);
    return buf;
}
```

Output: 14 (base) + 6 (discriminator) = **20 chars** — well within `S2S_MSGID_BUFSIZE`.

#### QUIT S2S Tag Flow

**Local user QUIT** (in `exit_client()`, `s_misc.c`):
1. Pre-populate base msgid and time on victim before the S2S send loop:
   ```c
   if (feature_bool(FEAT_P10_MESSAGE_TAGS) && IsUser(victim)
       && !IsBouncerAlias(victim) && MyConnect(victim)) {
       struct timeval tv;
       gettimeofday(&tv, NULL);
       cli_s2s_time_ms(victim) = (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
       generate_msgid(cli_s2s_msgid(victim), S2S_MSGID_BUFSIZE);
   }
   ```
2. Before each `sendcmdto_one()` in the loop, set `s2s_cptr_override` to victim so `format_s2s_tags()` reads the pre-populated tags:
   ```c
   sendcmdto_set_s2s_cptr(victim);
   sendcmdto_one(victim, CMD_QUIT, dlp->value.cptr, ":%s", comment);
   ```
3. All servers receive the same base msgid.

**Remote user QUIT**: Tags flow naturally. `parse_server()` stores the base msgid in `cli_s2s_msgid(cptr)` (the server link). When `exit_client()` relays the QUIT, `cli_from(victim)` points to that server link → `format_s2s_tags()` reads the base msgid → forwarded unchanged.

#### sendcmdto_one() Tag Condition

**File**: `nefarious/ircd/send.c` (line ~976)

Add `TOK_QUIT` to the S2S tag condition:

```c
/* Old: */
(strcmp(tok, TOK_PRIVATE) == 0 || strcmp(tok, TOK_NOTICE) == 0)

/* New: */
(strcmp(tok, TOK_PRIVATE) == 0 || strcmp(tok, TOK_NOTICE) == 0
 || strcmp(tok, TOK_QUIT) == 0)
```

#### store_quit_events() Changes

**File**: `nefarious/ircd/s_misc.c`

Remove `quit_history_msgid_counter`. Use the pre-populated base msgid from `cli_s2s_msgid(sptr)` and derive per-channel:

```c
static void store_quit_events(struct Client *sptr, const char *comment)
{
    /* ... existing checks (history available, chathistory store, MyUser) ... */
    /* ... existing timestamp, sender, account setup ... */

    const char *base_msgid = cli_s2s_msgid(sptr)[0]
                           ? cli_s2s_msgid(sptr) : NULL;
    char base_buf[S2S_MSGID_BUFSIZE];

    /* Generate base if not pre-populated (shouldn't happen, but defensive) */
    if (!base_msgid)
        base_msgid = generate_msgid(base_buf, sizeof(base_buf));

    for (member = cli_user(sptr)->channel; member; member = member->next_channel) {
        if (member->channel->mode.exmode & EXMODE_NOSTORAGE)
            continue;

        /* Derive per-channel msgid from base + channel name */
        derive_channel_msgid(msgid, sizeof(msgid),
                             base_msgid, member->channel->chname);

        history_store_message(msgid, timestamp, member->channel->chname,
                              sender, account, HISTORY_QUIT,
                              comment ? comment : "");
    }
}
```

Both the local server and any remote server receiving the same base msgid will compute identical derived msgids for the same channels → chathistory federation dedup works.

### Why BURST Is Excluded

BURST messages carry channel state during netsplit recovery — they're state synchronization, not user-visible events. They don't generate chathistory entries and don't need dedup. BURST continues to be sent without tags.

### Step 10: S2S Tags in sendcmdto_serv_butone()

**File**: `nefarious/ircd/send.c` (line ~1316)

`sendcmdto_serv_butone()` is the S2S relay function for JOIN, PART, KICK, TOPIC. Currently builds a single untagged MsgBuf. Add opt-in tag support using a static flag (same pattern as `s2s_cptr_override` and `s2s_alias_source`):

```c
static int s2s_want_tags = 0;

void sendcmdto_want_s2s_tags(int want)
{
    s2s_want_tags = want;
}
```

When `s2s_want_tags` is set, build the tagged MsgBuf instead of untagged:

```c
void sendcmdto_serv_butone(struct Client *from, const char *cmd,
                           const char *tok, struct Client *one,
                           const char *pattern, ...)
{
    /* ... existing alias setup ... */

    int want_tags = s2s_want_tags;
    s2s_want_tags = 0;  /* auto-clear */

    if (want_tags && feature_bool(FEAT_P10_MESSAGE_TAGS)) {
        struct Client *tag_cptr = s2s_cptr_override ? s2s_cptr_override
                                : (MyConnect(from) ? NULL : cli_from(from));
        s2s_cptr_override = NULL;

        if (format_s2s_tags(s2s_tagbuf, sizeof(s2s_tagbuf), tag_cptr, NULL, 0)) {
            va_start(vd.vd_args, pattern);
            mb = msgq_make(&me, "%s%C %s %v", s2s_tagbuf, from, tok, &vd);
            va_end(vd.vd_args);

            /* Alias buffer also needs tag prefix */
            if (alias_from) {
                va_start(vd.vd_args, pattern);
                mb_alias = msgq_make(&me, "%s%C %s %v", s2s_tagbuf, alias_from, tok, &vd);
                va_end(vd.vd_args);
            }
        }
    }

    if (!mb) {
        /* No tags or tags disabled — existing untagged path */
        va_start(vd.vd_args, pattern);
        mb = msgq_make(&me, "%C %s %v", from, tok, &vd);
        va_end(vd.vd_args);

        if (alias_from) {
            va_start(vd.vd_args, pattern);
            mb_alias = msgq_make(&me, "%C %s %v", alias_from, tok, &vd);
            va_end(vd.vd_args);
        }
    }

    /* ... existing send loop and cleanup unchanged ... */
}
```

**Flag leak risk**: If `sendcmdto_want_s2s_tags(1)` is called but the subsequent `sendcmdto_serv_butone()` doesn't execute (e.g., early return in the command handler), the flag persists until the next `sendcmdto_serv_butone()` call. This matches the accepted pattern for `s2s_cptr_override` and `s2s_alias_source` in this codebase. The auto-clear at function entry prevents cross-message contamination.

Declare `sendcmdto_want_s2s_tags()` in `send.h`.

### Step 11: Tag Call Sites in Command Handlers

Each command handler calls `sendcmdto_want_s2s_tags(1)` before the S2S relay call:

**JOIN** — `nefarious/ircd/channel.c`
- `joinbuf_join()` line ~5139 (single-channel JOIN)
- `joinbuf_flush()` line ~5277 (batched JOINs)

**PART** — `nefarious/ircd/channel.c`
- `joinbuf_flush()` line ~5277 (batched PARTs — same function, different JOINBUF_TYPE)

**KICK** — `nefarious/ircd/m_kick.c`
- Line 269 (local user KICK)
- Line 389 (remote user KICK)

**TOPIC** — `nefarious/ircd/m_topic.c`
- Lines 164, 168 (both setter and non-setter variants)

Pattern for each:
```c
sendcmdto_want_s2s_tags(1);
sendcmdto_serv_butone(from, CMD_XXX, cptr, ...);
```

### Event Storage Note (Follow-up)

Currently `store_channel_event()` only stores events from local users and generates its own msgid. For full dedup benefit, event storage should eventually adopt the "unified msgid" pattern (check incoming S2S msgid → use it or generate → pass to both storage and relay). This is a follow-up change — the S2S tag infrastructure comes first.

## Chathistory Transition Notes

### Mixed-Version Operation

During network upgrade, some servers send verbose tags (`@time=ISO;msgid=AA-123-456`) while upgraded servers send compact (`@ABYjklm...`). The auto-detection parser handles both directions transparently. No coordination needed — servers upgrade independently.

### DB Compatibility

Old-format msgids (e.g., `AA-1772784000-42`) and new compact msgids (e.g., `AABJrQAAAAAAmk`) coexist in chathistory databases without issues — msgids are opaque strings compared by equality. However, messages sent *during* the transition won't deduplicate across servers that stored them under different formats (one old, one new). This only affects the brief upgrade window and is acceptable.

### Post-Migration Cleanup

Once all network servers run compact format:
- `S2S_MSGID_BUFSIZE` can shrink from 64 to 24 (longest msgid is a QUIT-derived 20 chars + null; round up)
- Verbose parsing path in parse.c can be removed (or kept for robustness)
- `iso8601_to_epoch_ms()` helper can be removed

## Upstream / Backport Considerations

### Upstream X3 (`bouncer-transfer` branch) — CRITICAL

**The upstream X3 `bouncer-transfer` branch will BREAK on any P10 message tags.** Its `parse_line()` passes the raw line directly to `split_line()` — if a message starts with `@tags...`, it tries to look up the tag block as a server numeric and fails.

Our fork (`keycloak-integration`) has a 4-line fix (commit `e18385e`) that strips tags before parsing:
```c
if (line[0] == '@') {
    char *tag_end = strchr(line, ' ');
    if (tag_end)
        line = tag_end + 1;
}
```

**This fix must be backported to upstream X3 `bouncer-transfer` BEFORE `P10_MESSAGE_TAGS` is enabled on the live network.** Cherry-pick from `keycloak-integration` — 4 lines, zero side effects.

### Upstream Nefarious (`bouncer-transfer` branch)

**Minimal backport (understand compact tags):**
1. Compact format auto-detection in `parse.c` — so upstream can receive compact tags without losing them
2. `inttobase64_64()` / `base64toint_64()` in `numnicks.c` — needed by the parser

With this minimal backport, upstream servers parse compact-format tags transparently. They continue sending verbose format (their existing `format_s2s_tags()`). Our servers auto-detect verbose from upstream and handle it fine.

**Backport order:**
1. **X3 tag-stripping** to `upstream/bouncer-transfer` — prerequisite for any P10 tags
2. Nefarious minimal backport to `upstream/bouncer-transfer` — parse-only, zero behavior change
3. Full backport when ready for live deployment

### Compact Msgid Format and Upstream

The `generate_msgid()` format change from `AA-1772784000-42` to `AABJrQAAAAAAmk` is purely internal — msgids are opaque strings everywhere. No compatibility issue.

## Files Summary

| File | Changes |
|------|---------|
| `nefarious/ircd/numnicks.c` | Add `inttobase64_64()`, `base64toint_64()` |
| `nefarious/include/numnicks.h` | Declare 64-bit variants |
| `nefarious/include/client.h` | `con_s2s_time[32]` → `uint64_t con_s2s_time_ms`, add `S2S_MSGID_BUFSIZE`, update macros |
| `nefarious/ircd/send.c` | `format_s2s_tags()` compact output with epoch_ms, `generate_msgid()` compact format, `iso8601_to_epoch_ms()` helper, `sendcmdto_serv_butone()` tag support, `sendcmdto_want_s2s_tags()`, add `TOK_QUIT` to `sendcmdto_one()` tag condition |
| `nefarious/include/send.h` | Declare `sendcmdto_want_s2s_tags()`, `iso8601_to_epoch_ms()` |
| `nefarious/ircd/s_misc.c` | `store_quit_events()` uses derived msgids, remove `quit_history_msgid_counter`, `exit_client()` pre-populates base msgid + `s2s_cptr_override` for QUIT loop |
| `nefarious/ircd/parse.c` | Compact format auto-detection, epoch_ms storage, verbose compat path |
| `nefarious/ircd/ircd_relay.c` | Replace hardcoded `64` with `S2S_MSGID_BUFSIZE` (4 call sites) |
| `nefarious/ircd/channel.c` | Consolidate msgid generation, `sendcmdto_want_s2s_tags(1)` before JOIN/PART relay |
| `nefarious/ircd/m_kick.c` | `sendcmdto_want_s2s_tags(1)` before KICK relay |
| `nefarious/ircd/m_topic.c` | `sendcmdto_want_s2s_tags(1)` before TOPIC relay |

## Verification

1. **Build**: `docker compose --profile linked up -d --build --no-deps nefarious nefarious2`
2. **Enable feature** in ircd.conf on both servers: `"P10_MESSAGE_TAGS" = "TRUE";`
3. **Wire format check**: Enable debug logging, send PRIVMSG between servers, verify compact tag prefix (`@A` + 21 base64 chars, no `=` signs)
4. **Chathistory dedup**: Send message on server 1, query chathistory on both servers, verify same msgid
5. **Echo-message**: Send PRIVMSG with echo-message cap enabled, verify client receives `@msgid=` with compact format msgid string
6. **Msgid format**: Verify all new msgids are 14 chars, P10 base64 alphabet only
7. **Event tags**: With debug logging, verify JOIN/PART/KICK/TOPIC/QUIT S2S messages carry compact tag prefix. Verify BURST does NOT carry tags.
8. **Event tag preservation**: Remote user JOINs on server 2, verify server 1 parses the tags (`cli_s2s_time_ms`/`cli_s2s_msgid` populated)
9. **Verbose auto-detect**: If a verbose-format tag is received (e.g. from older server), verify it's parsed correctly via the `=` detection path and epoch_ms is stored correctly
10. **Transition**: Verify old-format msgids in chathistory DB remain queryable and functional alongside new compact msgids
11. **QUIT derived msgids**: User on server 1 QUITs while on #chan1 and #chan2. Query chathistory on both servers for each channel. Verify: (a) same derived msgid for #chan1 on both servers, (b) different derived msgids for #chan1 vs #chan2, (c) all QUIT S2S messages in the loop carry the same base msgid
12. **QUIT base msgid consistency**: With 3+ servers, verify all receive identical base msgid in the S2S QUIT tag (not independently generated per server link)
