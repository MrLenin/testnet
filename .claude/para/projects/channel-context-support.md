# channel-context client tag support (IRCv3 #596)

**Status:** Investigation / planning
**Spec:** [client-tags/channel-context.md](https://github.com/ircv3/ircv3-specifications/blob/master/client-tags/channel-context.md)
**Ratified:** 2026-04-09
**Author:** ibutsu

## Spec summary

`+channel-context=<channel>` is a **client-only** message tag (`+` prefix) that:
- Attaches to PRIVMSG/NOTICE messages **directed to a user** (not channels)
- Names a channel that provides display context for the message
- Allows bots responding to channel messages with PMs to indicate which channel the response relates to
- Recipient client may render the PM in the named channel's buffer

Required client capability: `message-tags`.
No new server CAP. No new ISUPPORT token. Server is a passthrough.

## Existing infrastructure we can rely on

Our parser already accepts arbitrary `+`-prefixed client-only tags and stores them
in `cli_client_tags(cptr)` for relay ([parse.c:1476-1496](nefarious/ircd/parse.c#L1476-L1496)).
TAGMSG and PRIVMSG/NOTICE relay paths already include `cli_client_tags` when the
recipient has `message-tags` negotiated. So the **wire-level minimum** for
channel-context support is already implemented — clients can send and receive
the tag today against our server.

What's *not* yet validated:

1. End-to-end behavior with a real client/bot pair
2. Storage and replay through CHATHISTORY (PMs to a user are stored in the user's
   per-account history per [project_chathistory_design_intent.md](memory/project_chathistory_design_intent.md))
3. Bouncer alias relay — does the tag survive when delivered via an alias connection?
4. S2S federation — does our P10 client-tag relay preserve `+channel-context`
   across server hops?
5. CLIENTTAGDENY interaction — operators may want to allow/deny channel-context
   independently
6. Whether the named channel must exist on this server (spec says "MUST be a
   valid channel name" but is silent on existence)

## Phases

### Phase 1: Validate passthrough end-to-end

**Goal:** confirm a client sending `@+channel-context=#x PRIVMSG bob :hi` results
in bob's client receiving the tag attached to the PRIVMSG, with no munging.

- [ ] irctest scenario: two clients with `message-tags` capability, one sends a
      tagged PRIVMSG to the other, assert the tag arrives intact
- [ ] Same scenario with NOTICE
- [ ] Verify the tag does NOT leak into channel-targeted PRIVMSGs/NOTICEs (spec
      says clients MUST disregard it on channel messages — server doesn't have
      to strip, but worth knowing if our relay does)

### Phase 2: CHATHISTORY interaction

**Goal:** verify channel-context survives store/replay of PMs.

- [ ] Confirm PM-to-user history (`store_pm_history` / equivalent) preserves
      client-only tags. We already store `+reply` and `+draft/react` per
      [history.c](nefarious/ircd/history.c) — channel-context should ride the
      same path.
- [ ] CHATHISTORY query for the user's PM history returns messages with
      `+channel-context` tag intact
- [ ] If we don't currently store client-only tags on PMs, scope what's needed
      to store the relevant subset

### Phase 3: Bouncer relay

**Goal:** verify primary↔alias relay preserves the tag.

- [ ] Send a tagged PM to a user with active bouncer aliases. Verify all
      recipient connections (primary + each alias with `message-tags`) see the
      tag. See [send.c CapRouteContext](nefarious/ircd/send.c) for the routing.
- [ ] Bouncer auto-replay on reconnect: stored tagged messages re-emit with the
      tag intact

### Phase 4: S2S federation

**Goal:** verify `+channel-context` traverses server links unchanged.

- [ ] In a 2-server testnet, sender on hub PMs receiver on leaf with
      `+channel-context` tag, verify receiver sees the tag
- [ ] Verify our P10 client-tag relay doesn't drop tags it doesn't recognize

### Phase 5: CLIENTTAGDENY policy

**Goal:** decide whether channel-context should be in any default deny list.

- [ ] Review `is_client_tag_denied()` interaction. Operators may want to deny
      channel-context if they consider it a privacy risk (lets bot disclose what
      channels you've spoken in to recipients).
- [ ] Default policy: allow. Document in `doc/example.conf`.

### Phase 6: (Optional) ISUPPORT signaling / validation

**Goal:** decide if we want to validate the `<channel>` value or signal support.

The spec doesn't require validation or ISUPPORT. Possible value-adds:

- [ ] Reject (or strip) `+channel-context=` values that aren't valid channel
      names (saves recipient clients the work). Spec says clients MUST
      disregard invalid values, so server-side validation is purely defensive.
- [ ] If we do strip on the way in, document that we've narrowed the spec.

Recommendation: skip validation in phase 1. Bots will be fine and clients
already have to handle invalid values per spec.

## Files likely touched

- `tests/src/ircv3/channel-context.test.ts` (new) — phase 1 conformance tests
- `irctest` scenarios — phase 4 federation tests
- `ircd/history.c` — phase 2 if we need to extend tag storage to PMs
- `ircd/send.c` / bouncer relay paths — phase 3 verification (likely no code changes)
- `doc/example.conf` — phase 5 documentation

## Out of scope

- Client-side rendering policy (which buffer to display in) — that's the
  receiving client's concern
- Cross-account channel-context (sender claims a channel the recipient isn't on
  — spec leaves display policy to client; server still relays)
- Anti-spoofing (sender claims `#staff` they're not on) — same; client policy
- Rate limiting — same as any other tag

## Open questions

1. Should CHATHISTORY persistence include client-only tags for PMs? We persist
   them for channel messages already. For PMs (when stored at all per
   chathistory-pm-simplification design intent), the cost is small.
2. Bouncer alias replay: our existing `+reply` / `+react` storage already
   handles this; is channel-context different? Probably not.
3. Should we proactively scrub `+channel-context` if attached to a *channel*-
   targeted PRIVMSG/NOTICE? Spec says client MUST disregard it in that case;
   server stripping would be defense-in-depth but not required.
