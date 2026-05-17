# Ephemeral IRCv3 Identity

## Summary

Make a subset of currently account-gated IRCv3 features (METADATA, READ_MARKER, CHATHISTORY for PMs) usable by non-account ("ephemeral") clients without weakening the security properties that motivate the gating. The mechanism: a per-connection session UUID generated at `make_client()` time, eager cleanup of all ephemeral state on `exit_client()`, an in-memory storage layer parallel to the existing LMDB-backed account-keyed store, and asymmetric persistent storage where any one authenticated party suffices to durably record a conversation.

## Goals

- METADATA visible/usable for ephemeral clients within their session, no LMDB persistence
- READ_MARKER set/get works for ephemeral clients within their session, no LMDB persistence
- CHATHISTORY for PMs queryable both by authed users (LMDB-backed, persistent) and by ephemeral users (in-memory, session-scoped)
- Ephemeral users disconnecting wipes all their session state
- Storage records of conversations involving ephemeral parties carry an unambiguous identifier so that distinct ephemeral sessions never conflate in an authed user's history view

## Non-goals

- WEBPUSH — fundamentally requires a stable identity for offline delivery; stays account-only
- CHATHISTORY auto-replay — only fires on bouncer-class connections, which are inherently account-anchored; no ephemeral path needed (see `project_chathistory_auto_replay_bouncer_only.md`)
- SASL-required class flag — orthogonal policy gate, unchanged
- Numeric-pool locking — explicitly rejected; eager cleanup is the chosen invariant. A reconnect-bridging signed-token mode could be designed later if a use case justifies it; not in scope here

## Architecture

### Per-connection session ID

A 128-bit random session ID generated in `make_client()` using the existing entropy chain (`RAND_bytes()` if OpenSSL available, falling back to `ircrandom()` per the bouncer-token pattern at `bouncer_session.c:337`), stored on every `Client` struct. Lives until `exit_client()`.

Cached alongside it: a derived 6-char shortcode using the same FNV-1a → base64 helper as `derive_channel_msgid()` (see "shared core" in Phase 5). Computed once at session-id generation time, used for all wire emission.

```c
struct Client {
    ...
    unsigned char cli_session_id[16];     /* full random session id */
    char          cli_session_short[7];   /* 6-char b64 shortcode + nul */
    ...
};
```

Used as:
- The in-memory storage key for ephemeral state (replacing or supplementing `cli_user(cli)->account` in the relevant code paths)
- A disambiguating field stored alongside ephemeral parties in persistent records on the authed party's side
- Source of the wire-emitted shortcode tag

### Wire format: vendor tag

No existing IRCv3 tag, draft, or vendor convention fits — see research summary in conversation context. Mint a new tag in the `afternet.org/` vendor namespace already in use (cf. `afternet.org/account` in `m_webirc.c`):

**`afternet.org/sid=<6-char base64>`** — emitted everywhere on the wire (client-facing and S2S)

- Server-injected on PRIVMSG/NOTICE/TAGMSG **only when the sender is non-account**
- Strictly complementary to the standard `account` tag (one or the other, never both — present indicates the source of identity)
- Emitted on chathistory replay messages whose stored sender was ephemeral, allowing clients to distinguish anon-session-A from anon-session-B
- Emitted to recipients only if they negotiated `account-tag` capability (same gate; the session-id is the ephemeral analogue and shares the same client-affordance)
- Same 6-char shortcode form on the wire whether the client is local or remote — the only place the full 16-byte session ID surfaces is in oper-visible diagnostics (`/CHECK` and equivalent), following the existing precedent that `/CHECK` shows richer local-only info

The 6-char shortcode is `derive_shortcode_b64(cli_session_id, 16)`, computed once at session-id generation time and cached on the Client struct. Same FNV-1a-to-base64 derivation used by `derive_channel_msgid()` (s_misc.c:195).

### Two-layer storage

**Layer 1 — LMDB (persistent), unchanged in shape**
- Account-keyed
- Trigger relaxed: write when **at least one** party is authed (was: both)
- For records where only one party is authed, the ephemeral party's identity is stored as `nick!user@host` snapshot at message time PLUS the ephemeral party's `session_id`
- The session_id in the persistent record is used purely for disambiguation in display; it has no live meaning after the ephemeral session ends

**Layer 2 — In-memory, session-scoped**
- Keyed by `session_id`
- Per-client bounded ring (default: 1000 lines per session, FIFO eviction; tunable via `FEAT_EPHEMERAL_HISTORY_LINES`)
- Holds both PMs and channel messages received/sent during the session
- For channel messages, presence intervals are recorded per `session_id` per channel; queries filter messages to within the requesting session's presence intervals (the same presence-required model that applies to authed users — `session_id` simply substitutes for `account` as the presence anchor)
- Wiped on `exit_client()`
- Queryable via `CHATHISTORY` exactly as LMDB is, returning the same wire format

### Query dispatch

In `m_chathistory.c`, the entry-point routes by sender identity:

```c
if (IsAccount(sptr))
    return chathistory_query_persistent(sptr, ...);  // existing LMDB path
else
    return chathistory_query_ephemeral(sptr, ...);   // new in-memory path
```

Both paths emit the same BATCH-wrapped reply format.

### Cleanup invariant

Single audited helper:

```c
void ephemeral_purge_session(struct Client *cli);
```

Called from `exit_client()` (and ideally nowhere else). Internally invokes the per-feature cleanup hooks in turn:

- `metadata_ephemeral_purge(cli)` — drops in-memory metadata entries keyed by this client's session_id
- `readmarker_ephemeral_purge(cli)` — drops session-scoped read markers
- `chathistory_ephemeral_purge(cli)` — frees the in-memory PM ring buffer

Each hook is a no-op if the client was authed (those features used the persistent path and have no ephemeral state to clear). Adding a new ephemeral feature in the future means adding one line to `ephemeral_purge_session`.

## Per-feature implementation

### METADATA

- Lift `IsAccount(sptr)` precondition at `m_metadata.c:465` and `m_metadata.c:491` for visibility checks
- The in-memory metadata path (`cli_metadata(cptr)` linked entries) already exists; just expose it to non-account clients via the existing CAP path (CAP DRAFT/METADATA2 is not currently account-gated)
- Persistence skip at `m_metadata.c:1361-1380` already conditional on `!account` — no change there; ephemeral metadata stays in memory only, which is exactly what we want
- Visibility matches: ephemeral metadata is visible to the ephemeral owner via session_id match; private/public semantics unchanged

### READ_MARKER

- Remove the `ACCOUNT_REQUIRED` rejection at `m_markread.c:181-184`
- Add an in-memory read-marker table keyed by `session_id`, with the same target-string keys as the LMDB store (channel name, PM target nick)
- `markread` set: write to LMDB if `IsAccount(sptr)`, else write to session-memory table
- `markread` get: same dispatch
- Auto-replay path (m_chathistory.c:3911-3912) **unchanged** — it only fires for bouncer connections, which are always authed, so it always hits LMDB

### CHATHISTORY (PMs and channels)

**Persistent (LMDB) path:**
- `should_store_pm()` in `ircd_relay.c:265`: change gate from `IsAccount(sender) && IsAccount(recipient)` to `IsAccount(sender) || IsAccount(recipient)`
- When writing a record:
  - Authed party stored by account name (existing format)
  - Ephemeral party stored by `nick!user@host` snapshot + `session_id`
- Channel storage gate (`authusers==0 → no storage`) unchanged — that's intentional consent design per `project_chathistory_design_intent.md`. Channels with at least one authed user present continue to store; ephemerals' messages get tagged with their session_id in those records.
- When the ephemeral party is the sender of a stored message that an authed party retrieves, the replay PRIVMSG carries `afternet.org/session-id=<sid>` (server-injected), gated on the receiving client having `account-tag` cap

**In-memory (session) path:**
- Per-session ring buffer of PMs and channel messages, cap'd by line count
- Channel-message inclusion uses presence-window filtering: ephemeral records JOIN/PART (or equivalent membership entry/exit) timestamps for each channel they enter, keyed by session_id; queries filter messages to those windows
- New query helper `chathistory_query_ephemeral(sptr, target, ...)` walks the session's ring buffer, applies presence filtering for channel targets, and emits the same BATCH-wrapped chathistory reply format
- For channels where `REQUIRE_AUTH=off` and ephemerals have access via the LMDB path too, the dispatch prefers the in-memory ring (richer, includes ephemeral self-state); LMDB is the fallback for time ranges that predate the session

### Mid-session authentication (privacy property)

If an ephemeral client SASLs/authenticates partway through a session: pre-auth messages stay tagged with their `session_id` in any persistent record on the other party's side, **not retroactively re-attributed to the now-known account**. The client's own in-memory ring buffer can either (a) stay session-id keyed and survive the auth event, or (b) flush to LMDB at auth time. Option (a) is simpler and matches the privacy property; option (b) is more user-friendly for the post-auth user. **Decision: (a).** A user who wanted persistence should have authed up front.

## Phasing

Three phases, landable independently. Each can ship behind a feature flag (`FEAT_EPHEMERAL_METADATA`, `FEAT_EPHEMERAL_MARKREAD`, `FEAT_EPHEMERAL_CHATHISTORY`) so the rollout is gated.

### Phase 1 — Session ID + vendor tag plumbing

1. Extract the FNV-1a-to-base64 helper from `derive_channel_msgid()` (s_misc.c:195) into a generic `derive_shortcode_b64(bytes, len, out, out_len)` in `numnicks.c` or `ircd_string.c`. Refactor existing call site to use it; behavior identical.
2. Add `cli_session_id[16]` and `cli_session_short[7]` to `Client` struct
3. Generate session_id at `make_client()` time using the existing `RAND_bytes()`/`ircrandom()` chain (bouncer_session.c:337 pattern). Compute and cache the shortcode immediately.
4. Helper `format_session_id_full(sid, buf)` → 22-char base64 (used only by `/CHECK`-style oper output)
5. Wire `ephemeral_purge_session(cli)` skeleton into `exit_client()`, currently no-op
6. Vendor tag emission helper `tag_session_short_if_ephemeral(cli, msgbuf)` — used by PRIVMSG/NOTICE/TAGMSG paths to inject `afternet.org/sid=<6char>` for ephemeral senders when the recipient has `account-tag` cap
7. Add session_id (full 22-char form) to `/CHECK` output for oper visibility
8. P10: session_id does **not** propagate over S2S in this phase. Ephemeral identity is local-only initially. Cross-server PM history with ephemeral parties is a Phase 5 concern.

### Phase 2 — METADATA ephemeral path

1. Lift `IsAccount` visibility checks at the two call sites
2. Verify in-memory path already keyed correctly (it's keyed by `Client *`, which is fine since session_id and Client lifetime are the same)
3. Wire `metadata_ephemeral_purge(cli)` — likely a no-op since the metadata is already on `cli_metadata(cli)` and freed when the client struct is freed; confirm
4. Tests: ephemeral client sets metadata, retrieves it, sees visibility matches; on disconnect+reconnect (different session) the data is gone

### Phase 3 — READ_MARKER ephemeral path

1. Remove `ACCOUNT_REQUIRED` rejection at `m_markread.c:181`
2. Add `struct EphemeralMarkerTable` to bouncer/session helpers, indexed by client
3. Set/get dispatch on `IsAccount(sptr)`
4. Wire `readmarker_ephemeral_purge(cli)`
5. Tests: ephemeral set, get, disconnect-wipe, no LMDB writes for ephemeral

### Phase 4 — CHATHISTORY (PM) ephemeral path

This is the largest phase. Sub-steps:

4a. **Persistent path**: relax `should_store_pm()` gate; store ephemeral parties' identity-snapshot + session_id alongside their record. Confirm record format extension is backward-compatible (or version-bump the LMDB schema if not).

4b. **Replay vendor tag**: when the receiving client has `account-tag` cap and the original sender was ephemeral, emit `afternet.org/session-id` on the replay PRIVMSG.

4c. **In-memory ring buffer**: per-session bounded ring of PMs, cap'd by `FEAT_EPHEMERAL_HISTORY_BYTES`. Insertion on PRIVMSG send and receive when the local client is ephemeral.

4d. **Ephemeral query path**: new function `chathistory_query_ephemeral(sptr, target, ...)` that filters the ring buffer by target and emits BATCH-wrapped chathistory replies in the existing format.

4e. **Dispatch**: query entry point routes on `IsAccount(sptr)`.

4f. **Cleanup**: `chathistory_ephemeral_purge(cli)` frees the ring buffer.

4g. **Tests**: ephemeral-to-ephemeral conversation, ephemeral-to-account, account-to-ephemeral, query-from-each-side, disconnect-wipe-on-ephemeral-side, account-side-history-survives-ephemeral-disconnect, two distinct anon sessions on the same nick produce two distinct disambiguated entries in the authed party's history.

### Phase 5 — Cross-server ephemeral identity (reuse existing shortcode infrastructure)

Nefarious already does a directly-analogous thing for QUIT messages: `derive_channel_msgid()` in `s_misc.c:195` derives a deterministic per-channel suffix using FNV-1a over the channel name, appending it to the originator's base msgid. All servers compute the same suffix from the same channel name — disambiguation across servers without per-message wire overhead beyond the suffix itself. This is the "form of B" already in production for QUITs.

The session-identity case is structurally identical: derive a shortcode from `session_id` bytes using the same FNV-1a pattern, emit it as a compact tag on S2S messages from ephemeral senders, and let all servers recover the same shortcode given the same session_id input. No msgid format change needed — the existing `<time_7><node_2><logical_3><counter_9>` format stays untouched.

**Shared core to extract:**
- Generalize `derive_channel_msgid()`'s FNV-1a-over-bytes-to-base64 helper into a reusable function: `derive_shortcode_b64(input, input_len, out_buf, out_len)`. Used by both the QUIT-channel-msgid path (existing caller) and the new session-shortcode path.
- Place in `ircd_string.c` or `support.c` alongside the existing `inttobase64`/`base64toint_64` helpers in `numnicks.c`.
- The existing per-channel-msgid call site refactors to use the generic helper passing `(channel_name, strlen(channel_name))`; behavior identical, just a code-share.

**Wire format on S2S:**

Compact vendor tag: `afternet.org/sid=<6char>` where `<6char>` = `derive_shortcode_b64(session_id_bytes, 16)`.

- 6 base64 chars = 36 bits of disambiguation. Birthday collisions at ~262K concurrent ephemeral sessions per server — far beyond realistic load.
- ~25 bytes of overhead per message from ephemeral senders. Acceptable — matches the QUIT-msgid suffix overhead.
- Legacy servers ignore the tag per IRCv3 message-tags spec; only IRCv3-capable replicas process it.
- Local emission to clients keeps the longer `afternet.org/session-id=<22char>` form on chathistory replays for richer client-side disambiguation. Servers can render either form depending on whether they have the full session_id (originating server does; remote servers may only have the shortcode if we don't replicate session_id S2S — see below).

**Whether to replicate full session_id S2S:**

Two sub-options:

- **5α: Shortcode-only replication.** Remote servers only ever see the 6-char shortcode (in tags, persisted into LMDB records). They render `afternet.org/sid=<6char>` to local authed users in chathistory replay. Simpler, but clients see different tag forms depending on whether the conversation was local or cross-server. Acceptable since clients use the value opaquely.

- **5β: Full session_id replication via BS-style broadcast.** Reuse the existing bouncer-session BS P10 token mechanism (`bouncer_session.c:1929-1943`) to broadcast `(client, session_id)` mappings on user introduction. Remote servers can then emit the full 22-char form to their local clients. Requires extending the BS broadcast path; nontrivial.

**Tentative: 5α** — same-format-everywhere semantics for tag values is desirable but not load-bearing; clients should treat session-id values as opaque tokens regardless of length. Simpler is better. 5β can be added later if some specific use case demands the full UUID at remote endpoints.

**Phasing:**
- 5a. Extract the FNV-1a shortcode helper from `derive_channel_msgid` into a generic utility; refactor existing caller
- 5b. Compute and emit `afternet.org/sid` on S2S PRIVMSG/NOTICE/TAGMSG when local sender is ephemeral
- 5c. S2S receipt: parse tag, persist shortcode into LMDB record alongside ephemeral party's nick snapshot
- 5d. Cross-server chathistory replay re-emits the persisted shortcode to local clients
- 5e. Tests with linked / multi profiles to confirm shortcode survives S2S hops and disambiguates correctly across servers

## Resolved decisions

1. **Storage cap default.** Cap in **line count**, not bytes. Easier to reason about visually ("last N messages") and matches user intuition. Proposed default: 1000 lines per session, FIFO eviction. Tunable via `FEAT_EPHEMERAL_HISTORY_LINES`.

2. **Ring buffer scope — channels included with presence filtering.** Ephemerals can have channel history, subject to the same presence conditions as authed users (you only see what was said while you were present). The session_id functions as the server-generated token that anchors presence windows for the ephemeral side: presence intervals are recorded per `session_id` for each channel joined, and history queries filter to those intervals. On disconnect, presence windows are purged with the rest of the session state. This is consistent with `project_chathistory_design_intent.md` (account-presence-required + filter to presence windows) — session_id just substitutes for account as the presence-window anchor for ephemerals. Implementation note: this means the ephemeral ring buffer is per-session, not per-conversation, and channel messages are included alongside PMs subject to retention cap.

3. **Session-id visibility to operators.** Display in `/CHECK` and equivalent oper-visible commands alongside numeric and nick. Trivial addition; include in Phase 1.

4. **Backward compat of stored-record format.** No migration needed — under the old gate, records involving ephemeral parties weren't stored at all, so there's nothing to convert. New records carry the extended `(nick_snapshot, session_id)` ephemeral-party fields; old records (account-only on both sides) are unaffected.

5. **Tag negotiation — no new CAP, piggyback on `account-tag`.** Per IRCv3 working-group guidance (capabilities should be used when they change parsing semantics, not merely to announce a new tag), `afternet.org/session-id` is emitted under the existing `account-tag` capability. The tag's syntax is identical to other vendor tags and requires no new parsing rules; clients that don't recognize the name simply ignore it, which is the correct behavior.

6. **Privacy concern on the tag.** UUIDv4 is opaque, carries no PII, leaks no connection metadata, and is per-session-disposable. Including a security-review pass in the Phase 4 acceptance criteria.

## Memory references

- `project_chathistory_auto_replay_bouncer_only.md` — auto-replay path is account-only, no fall-through needed
- `project_chathistory_design_intent.md` — `authusers==0 → no storage` is intentional; ephemeral path must respect this
- `feedback_single_msgid.md` — every event uses one msgid across all delivery paths; ephemeral replay must reuse the same msgid as the original PRIVMSG
- `bouncer_session.c` — provides the existing pattern for hooks on `exit_client()`; cleanup helper should follow the same pattern
