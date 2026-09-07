# WebPush: wire the trigger, decide the payload (design)

**Status:** SHIPPED 2026-08-28 — v1 PM trigger `414b147`, v2 channel highlights `9fbcb3b` (plan amended at build: drift-proof member walk + TTL subs cache instead of the transition-instrumented counter). Keywords (v2.1) remain future work. Live hold→push→revive verification needs a push-endpoint stub on the bed.
Covers gist residual gap 3 (push payload policy) — which turned out to be
premature: **the notification path is dead code**. Everything below the
trigger exists and works; the trigger itself was never wired.

## Facts (verified in tree @ 7a47da1)

- `webpush_notify_account(account, message, len)` (m_webpush.c) has **zero
  call sites**. No relay-path, hold-path, or highlight code references
  webpush at all.
- Everything beneath it is real and live: per-subscription RFC 8291
  aes128gcm encryption (proper HKDF/ECDH/AES-GCM), VAPID auth, async libkc
  HTTP delivery, subscription store with S2S sync (`WEBPUSH R/U/V`), and
  410-expired reaping. Payload is an opaque caller-supplied blob — no
  formatting, no truncation (oversize = logged reject, no push).
- Limits: plaintext ≤ 4096; encrypted ≤ 4352; endpoint ≤ 512.
- S2S has no "deliver a push" token — pushes are local-origin by design;
  correct, because the held ghost lives on one server and all traffic for
  it arrives there.

## Trigger design (v1 scope: PMs to held users)

Call site: the PM delivery paths where the target resolves to a held
bouncer ghost (`IsBouncerHold` / session `BOUNCE_HOLDING`) — the point
where today the message goes only to history. Gate stack, all must hold:

1. target account has ≥1 stored webpush subscription;
2. target session is HOLDING (no live attached connection — a live alias
   anywhere means no push);
3. per-account rate limit passes (below).

Channel highlights ship as **v2** — plan below; v1 = PMs (and NOTICEs
to the user) only, so the trigger machinery, cooldown, and payload
tiers land and get exercised before the higher-volume path turns on.

## Channel-highlight pushes (v2 plan)

The cost problem is per-message work in channels, so the design makes
the common case (no held members in the channel) exactly O(1):

1. **Drift-proof member walk, not an eligibility counter (plan amended
   at build time, 2026-08-28).** The original counter design required
   instrumenting every hold/revive transition — the tree has 5
   HOLDING-transition sites and 13 ACTIVE-transition sites, and an
   18-site maintenance obligation is precisely the drift hazard the
   counter was meant to avoid (a stuck-at-zero counter silently kills
   highlights forever). Instead: the per-message check walks the
   channel's membership testing `IsBouncerHold` — a bit test per
   member, sub-microsecond even on large channels — and only for the
   rare held member consults a small TTL'd per-account subscription-
   count cache (invalidated inside the store's add/remove/clear, so
   `WEBPUSH R/U` and reaping stay coherent with zero call-site
   burden). No transition instrumentation at all; correct by
   construction. Revisit the counter only if profiling ever shows the
   walk mattering.
2. **Hook point:** a single call in the channel PRIVMSG relay path
   (post-delivery, beside where history storage already sees the
   message): `webpush_channel_highlight_check(sptr, chptr, text)`,
   gated on `held_push_members > 0` and `feature_bool` kill switch.
3. **Match rule (v2):** case-mapped (IRC casemapping) word-boundary
   match of each eligible held member's **nick** in the message text
   (ACTION text included; other CTCPs and channel NOTICEs excluded —
   deliberate: channel notices are bot noise). Eligible set per
   message = held members of this channel with subs, typically 0–2;
   one pass over the text per eligible nick.
4. **Keywords (v2.1):** per-account `draft/webpush/keywords` metadata
   key (comma list, count- and length-capped) extends the match set.
   Deferred behind nick-match shipping first.
5. **Cooldown scope generalizes v1's:** (account, origin) where origin
   = sender for PMs, channel for highlights — one FEAT, one code path.
   A highlight storm in one channel collapses to one push; the
   reconnect+replay carries the backlog.
6. **Sender exclusions:** no self-highlights (own aliases/account),
   and no pushes for messages from ignored/silenced senders (reuse the
   existing SILENCE check against the held ghost).
7. **Scaling escape hatch (explicit YAGNI):** if eligible sets ever
   grow past hand-scan size, the deferred bloom-filter structure
   (project_bloom_filter_channel_ads) is the drop-in — a bloom over
   eligible nicks/keywords consulted once per message. Not built until
   measured need.

## Rate limiting

One push per (account, sender) per cooldown window (FEAT_WEBPUSH_COOLDOWN,
default ~60s), all counters reset on revive. A push says "wake up and
reconnect" — the reconnect + replay carries the actual backlog, so
collapsing bursts is correct behavior, not loss.

## Payload policy (the original gap-3 question)

Three tiers; per-account choice via metadata key
(`draft/webpush/payload` = `ping` | `route` | `full`):

- **ping** — `{"t":"msg"}`. Zero content leak (push provider sees only
  timing/size patterns). Client shows a generic notification.
- **route** (DEFAULT) — sender nick, target, msgid, server-time. No message
  text. Enables deep-linking the notification to the right buffer and
  msgid-dedup against later replay; lock screens show "message from X"
  without content. Bounded size by construction.
- **full** — route + message text, clamped to fit the 4096 pre-encryption
  cap (truncate with an ellipsis flag rather than the current
  reject-and-drop). Content is aes128gcm-encrypted end-to-end to the
  subscription, so push providers can't read it — the exposure is device
  lock-screen display and traffic analysis, which is the user's call.

Server default is `route`; `ping` for the paranoid, `full` for convenience.
The metadata key rides the existing draft/metadata-2 machinery, so clients
can set it without new protocol.

## Explicitly out of scope (v1)

- (v1 only) Channel-highlight pushes — planned above, ships as v2.
- S2S push-forwarding token (unneeded — ghost's server sees everything).
- Delivery receipts / push-to-replay coupling (the reattach-pipeline design
  handles catch-up independently).

## Gist correction

mobile-seamless-sessions §4 previously implied pushes flow today; corrected
to state the machinery/trigger split honestly (done 2026-08-28 alongside
this design).

## Size estimate

Trigger + gates + cooldown: ~100 lines in the PM relay/hold path +
m_webpush helper to format the route payload (~60 lines) + FEAT +
metadata-key read. Truncation fix in webpush_encrypt caller (~10 lines).
Tests: CMocka for payload formatting/clamping; live bed test for
hold→push→revive flow (needs a push-endpoint stub).
