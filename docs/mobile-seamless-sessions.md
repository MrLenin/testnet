# Seamless mobile sessions over Nefarious (fork)

**Status:** design guide / capability map — describes the recommended
client+server flow over machinery that already exists on the fork's
`ircv3.2-upgrade` line, plus the residual polish gaps. Nothing here proposes
new protocol; the gaps section proposes future work.

**Audience:** mobile client authors targeting this network, and fork
developers deciding where the next unit of "seamlessness" effort goes.

## The problem

Mobile connections die constantly and blamelessly: the OS suspends backgrounded
apps, cell↔wifi handoffs change addresses, doze kills sockets. A classic IRC
server turns each of those into a visible QUIT/JOIN cycle, lost scrollback, and
phantom unreads. The goal is that neither the user nor the channels they sit in
ever perceive transport death.

## The core model: the socket is not the session

The fork's bouncer subsystem already decouples transport from presence.
Sessions are **account-anchored** and survive disconnection: on socket death
the session is *held* — the ghost stays in its channels with nick, modes, and
standing intact, and no QUIT is emitted. Reconnection *revives* the session
rather than creating a new identity. Mobile support is therefore a transport
problem layered on a presence model that already tolerates transport death —
the inverse of a copyover design, which teleports sockets: here socket death is
simply a non-event.

## The recipe

### 1. Connect cheap, reconnect cheaper

- **Transport:** websocket + TLS 1.3. TLS session resumption cuts a round trip
  on every reconnect. Do **not** use 0-RTT early data — replayable IRC commands
  are a footgun.
- **Auth:** SASL `OAUTHBEARER` with the Keycloak token the app already holds —
  no password round trip on the IRC path, and the server-side SASL auth cache
  (positive TTL 300s) keeps reconnect storms cheap. Token refresh is the app's
  out-of-band job, never on the reconnect critical path.
- **Pipeline the registration.** The fork supports pipelined registration
  (added for the Goguma mobile client): a client may fire
  CAP REQ / AUTHENTICATE / NICK / USER / CAP END without waiting for
  intermediate replies. A dedicated auth-request state (`AR_SASL_PENDING`,
  `s_auth.c` — set at `auth_sasl_start()`, cleared at `auth_sasl_done()`)
  holds registration open so a pipelined `CAP END` cannot land 001 before the
  SASL reply (including the X3/services relay round trip) has arrived. One
  write, then wait for 001.

### 2. Negotiate the right capabilities

| Cap | Why it matters here |
|---|---|
| `sasl`, `cap-notify` | fast reauth; live cap changes while connected |
| `server-time`, `message-tags` (msgid) | replayed history is timestamped and **dedupable** |
| `batch`, `labeled-response` | catch-up arrives as coherent units; request/response correlation |
| `echo-message` | the client's own sends confirm without local-echo guessing |
| `draft/chathistory` | client-driven gapless backfill (see tier 2 below) |
| `draft/event-playback` | non-message events (joins/parts/topics) replay too, so state doesn't drift |
| `draft/read-marker` | cross-device read state — no phantom unreads |
| `draft/metadata-2` | client preference/state sync |
| `draft/webpush` | delivery while the socket is dead (see §4) |

The msgid invariant is the linchpin: the fork guarantees **one msgid per event
across all delivery paths** (live, replay, chathistory, playback), so a client
can overlap its catch-up windows aggressively and render each event exactly
once by msgid-dedup.

### 3. Background / drop → hold, not quit

When the OS kills the socket, the session holds. Channels see nothing; the
user's presence and standing are untouched. Holding is per-session preference
(currently umode `+b` / `FLAG_BNC_HOLDPREF`; slated to migrate to a metadata
key per the mode-budget audit — this use case is exactly why it is a
client-local preference rather than a network signal).

### 4. While held → WebPush

The piece most IRC stacks lack and this fork has: server-side Web Push
(`draft/webpush` cap, `WEBPUSH`/`WP` verb, VAPID keys). Highlights and PMs that
arrive while the socket is dead go out the platform push channel — the only
background delivery path mobile OSes actually guarantee. The app renders an OS
notification; tapping it triggers reconnect. The client registers its push
subscription over the cap and re-registers when the platform rotates the
endpoint.

### 5. Reconnect → revive + gapless catch-up

Revive restores the session — channels and standing return with no visible
rejoin traffic. Catch-up is two-tier:

- **Simple client (no `draft/chathistory`):** the server auto-replays from the
  held session's last-activity point — reattach computes the "since" time from
  the ghost's idle time and streams the gap (`m_bouncer.c`, auto-replay gated
  on the client lacking the chathistory cap and on the persistence-replay
  feature).
- **Smart client:** drives its own backfill — `CHATHISTORY TARGETS` since its
  last-sync marker to learn which buffers have activity, then per-buffer
  `CHATHISTORY AFTER <msgid>`, lazily: active buffer first, the rest on
  demand. `draft/event-playback` fills in the non-message events so member
  lists and topics converge without a NAMES storm.

`draft/read-marker` then syncs read state, so what was read on the desktop is
already marked read on the phone.

### 6. The client-side contract

The server cannot do these; a client that wants the seamless experience must:

- persist a last-seen msgid per buffer (the catch-up cursor);
- reconnect on OS network-change events, not just timers, with jittered
  exponential backoff;
- treat replayed history as the source of truth and render by msgid-dedup
  (never assume "live" and "replayed" are disjoint);
- keep its push subscription registered and rotate it when the platform
  rotates the endpoint;
- refresh its auth token out-of-band so reconnect never waits on an OAuth
  round trip.

### Net effect

To everyone else you never left. To you, the app wakes, revives, backfills the
gap, and your read state is already correct. This is as seamless as IRC
semantics permit.

## Residual gaps (future work, none blocking)

1. **Attach RTT count.** Registration itself already pipelines into one write
   (see §1 — the Goguma work). What remains serial is the transport ladder
   below it (TCP → TLS → websocket handshake) and the **post-001 steps**:
   bouncer attach and the catch-up requests each cost their own round trip.
   The residual polish is extending the pipeline past 001 — letting the attach
   (and ideally the catch-up cursor) ride in the same flight as registration —
   plus TLS session resumption to shave the handshake.
2. **Generalize auto-replay to smart clients.** Not new machinery — two
   upgrades to the existing reattach auto-replay (§5 tier 1):
   (a) *cursor precision:* today's "since" is a heuristic — the ghost's idle
   time, falling back to disconnect time (`m_bouncer.c`) — which by design can
   only over-replay (msgid-dedup absorbs the overlap, but on a mobile link the
   waste is real bytes); tracking the exact last-delivered msgid per session
   would replay precisely the gap. (b) *audience:* the replay is currently
   skipped for `draft/chathistory` clients on the theory that smart clients
   pull; an opt-in that lets them take the push instead spares the
   TARGETS + N×CHATHISTORY dance. The HLC-seeded msgid format already supplies
   the total order both need.

   *Cursor choice* is the interesting design point — three candidates
   answering different questions: **idle/disconnect time** (today) — "when did
   this session stop seeing traffic"; **last-delivered msgid** — "what has this
   *device* stored" (the right cursor for gapless local scrollback,
   per-session); **read-marker** — "what has the *user* seen" (per-account,
   cross-device). Replaying since the read-marker is the smallest possible
   delta ("send me what's unread") and ideal for a single-device user — but
   multi-device it leaves holes: a desktop that read ahead advances the marker
   past messages the phone never received. That is fine precisely when the
   client treats history as server-backed and lazily backfills older content
   with `CHATHISTORY BEFORE` on scroll — which is also the leanest mobile
   strategy overall: replay only unread on reconnect, pull the rest on demand.
3. **Push payload policy.** How much content rides in a push (encrypted
   payloads vs. bare "you have a message" pings) is a privacy/UX knob that
   deserves a deliberate decision rather than a default.

## Pointers

- Bouncer model and invariants: `bouncer-architecture` skill
  (`.claude/skills/`); session/hold/revive core in
  `nefarious/ircd/bouncer_session.c`, reattach + auto-replay in
  `nefarious/ircd/m_bouncer.c`.
- Chathistory subcommands (incl. `TARGETS`): `nefarious/ircd/m_chathistory.c`.
- WebPush: `nefarious/ircd/webpush.c`, `m_webpush.c` (`draft/webpush`, VAPID).
- msgid format and single-msgid invariant: HLC-seeded S2S msgid
  (`@A<time_7><msgid_14>`); one msgid per event across all delivery paths.
