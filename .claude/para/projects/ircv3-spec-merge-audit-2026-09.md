# IRCv3 spec-merge conformance audit (2026-09-01)

User-requested sweep of everything merged into ircv3/ircv3-specifications since ~Dec 2025 (26 PRs), audited against ircv3.2-hardening @ 183eb75 by two research agents (WS/tags/multiline + chathistory/metadata/registration). Full verdicts in the session transcript; summary:

## CONFORMANT (no action)
#548 WS ratification (subprotocols, frames, close — exceeds spec), #551 WS binary+text (both paths), #582 WS 510-byte accounting, #583 multiline max-lines counting, #573 batch FAIL codes (full set + context params), #592 tag namespaces, #568/#596 unreact/channel-context passthrough+storage, #526 chathistory-context tag (emitted, spliced after parent, uncounted), #565 TARGETS latest-message matching, #606 metadata erratas, #575 WHOIS keyvalue, #587 account-extban (MUST-pair + matching), #590 no-implicit-names (ratified+draft names), #594 standard replies, #535 reply tag (prior), #598 chathistory-end (prior, this session).

## FIX LIST — user-visible
1. TARGETS response rows emit `timestamp=` prefix (request syntax) — spec wants bare ISO; conformant clients can't parse ANY row (m_chathistory.c:2009,2013).
2. TARGETS PM rows emit raw pair-key (alice:bob) instead of the other participant's nick (send_targets_batch).
3. METADATA CLEAR sends the requester NOTHING (dangling "send empty keyvalue?" comment) — spec: metadata batch + RPL_KEYNOTSET(766) per cleared key (m_metadata.c:~1043-1092).
4. require-sasl class reject exits without `FAIL * ACCOUNT_REQUIRED` (s_user.c:435-441) — the load-bearing signal that makes our advertised before-connect registration actionable; ISUPPORT token correctly stays out (class-conditional gating).
5. Dead-batch line leakage: after FAIL (INVALID_REFTAG/UNKNOWN_TYPE/TIMEOUT/mid-batch clear), `@batch=<dead-ref>` lines deliver as normal messages instead of being ignored (m_privmsg.c:137, m_notice.c:188) — spray-into-channel failure mode.
6. multiline max-bytes undercounts join LFs (+1 per non-concat join; m_batch.c:813,841).

## Minor/cosmetic
7. CLIENTTAGDENY advertised verbatim → dedupe/validate at set time (ircd_features.c:486-497; evaluator already dup-safe). 8. VERIFY "*" not mapped to nick (m_register.c:628). 9. WS handshake nits (multi-header preference inversion; strstr boundary). 10. RPL_METADATAEND dead numeric.

## Deferred/candidates
- draft/oper-tag (#494): NOT-IMPLEMENTED; scoped (cap + tag on all user commands, value=opername, FEAT-gated visibility). Low urgency, awaiting user interest.
- Federated TARGETS: no post-merge window re-filter (can admit target whose network-wide latest is out-of-window); remote-only context children omitted (spec-discretionary). Federation backlog.

## Implementation status (2026-09-01)

All six user-visible gaps plus the four minors SHIPPED in `d961068` (pushed to origin + evilnet upstream, deployed to bed `ircd.202609012004`): dead-batch line swallow (per-connection dead-ref, m_privmsg + both m_notice interception sites; pinned red->green by `multiline-dead-batch.test.ts`), TARGETS bare-ISO rows + PM other-participant identity, METADATA CLEAR batch of RPL_KEYNOTSET, FAIL * ACCOUNT_REQUIRED on require-sasl exit, multiline max-bytes join-LF accounting, CLIENTTAGDENY dedupe/negation-wins sanitize, VERIFY `*` mapping, WS Sec-WebSocket-Protocol token-boundary scan. Verified on bed: new tests green, multiline + chathistory regression suites green.

## Parked items implemented (2026-09-01, same day — `b37fd53`)

All four parked items landed, plus two field-driven fixes, in `b37fd53` + `c98f1f8` + `1d323e0` (pushed both remotes, bed `ircd.202609012258`, all red->green):

- **Federated TARGETS window veto**: responders query with include_newer so out-of-window-high latests travel as veto rows; requester re-filters the merged per-target max to the window (#565 network-wide latest-message matching). Lesson from the live trace: the SQUIT de-advertises a storage peer and re-advertisement lands ~30s post-heal — federated queries legitimately skip it in that gap (test polls for readiness).
- **Remote-only context children**: responders attach context pre-emit; `CH C <reqid> <parent> <child> [:client_tags]` declares each child (tags ride the declaration — the CH R wire never carried client_tags, so federated TAGMSG reactions arrived empty). Requester splices after parent, uncounted, deduped. RESIDUE: ordinary (non-context) federated TAGMSG rows still lose client tags on CH R — pre-existing, narrower now, unfixed.
- **draft/oper-tag** (#494): cap + tag at all six send-path composition surfaces; displayed-opers-only (never disclose +H/hidden); opername value behind FEAT_OPERTAG_VALUE (default off). Numeric-reply tagging (SHOULD) not implemented. COST LESSON: the new TAGS_OPER 0x20 bit overran five hard-sized [32] per-flag MsgBuf caches -> SIGSEGV on first oper-tagged channel message; caches now sized TAGS_CACHE_SIZE derived from the flag defs.
- **draft/ACCOUNTREQUIRED** (#585) per-CLASS: token emitted per-connection in the 005 burst (plain + batched) when the resolved class carries require_sasl — per-port/class per user direction. Bed got a gated test class (port 6675, data/ircd.conf + compose).
- **labeled-response forwarded-label fixes** (`c98f1f8`, `2138c18`): batches never closed (DRAINING waited on the client's next command) → close at the terminal numeric + 2s sweep + WHOWAS/NAMES terminals; and the positional FIFO fallback (any msgid-less numeric captured into whatever label was pending) removed, labels created only toward IRCv3-aware destinations. Both real — but NOT the reported bug.
- **The actual "remote WHOIS returns nothing" cause** (`2b7c638`, 2026-09-02): bouncer **alias** egress. `hunt_server_cmd` never rewrote alias→primary, so an alias-sourced routed command was an unknown source at the first legacy hop (prod: every route crosses Thunderbird.US.Hub) and was dropped silently — unlabeled too. Fixed with the rewrite + `do_numeric` mirroring S2S reply numerics to the session's local aliases (send_buffer delivers only to the addressed connection). Pinned with the legacy comparison slot + a real alias (`bouncer-alias-remote-whois.test.ts`). Lesson: fork↔fork bed repros can't see alias/legacy-hop failures.
- **bouncer restored-hold gate bug** (`1d323e0`, found by test triage): BX R's Phase 5 retirement dropped the burst-time clear of hs_restore_pending -> one unclaimed DB-restored HOLDING session gated EVERY server link's burst 30s for the life of the process (broke anything cross-server within 30s of a link/heal). Fixed: post-burst settle clear + hs_restore_deadline ceiling.

Remaining parked: RPL_METADATAEND dead-numeric cleanup (cosmetic); federated non-context TAGMSG tag fidelity (above).
