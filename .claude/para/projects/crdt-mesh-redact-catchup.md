# REDACT on the CRDT mesh: live letter + store-side catch-up (design B)

Decided 2026-09-20 (user): redactions are NOT doc state. The doc converges state; a redaction is an
event whose durable record already lives in every store that applied it (the REDACT context row). Option
A (doc collection tombstoned by acknowledgement) was rejected for the dead-store residue and for living in
every snapshot/digest; option C (fixed-age prune) for serving unredacted rows after a long absence when
retention is forever.

## Shape
1. **Live delivery** — CR M letter `R`, target `*`, body `<target> <msgid> <redact_msgid> <time_ms> :<reason>`
   (the P10 REDACT body plus the two S2S-tag values it rides today). Minted at the origin
   (m_redact.c:362 channel path, :473 PM path, m_chathistory.c:5552 the CH-side redact) and at the gateway
   edge in ms_redact for a legacy-arrived REDACT (`IsServer(cptr) && !IsCrdtAware(cptr)`); when minted the
   tree relay goes to legacy links only (needs a CRDT-aware exclusion on the v3 relay). Receiver applies
   through the same function ms_redact uses (factor `redact_apply_remote(target, msgid, redact_msgid,
   time_ms, reason)`), LOCAL only, no legacy re-emit (the origin's tree copy or the gateway serves legacy).
2. **Durable index** — every store that applies a redaction writes an index row in the history CF:
   key `rdx|<time_ms be64>|<redact_msgid>` (new builder next to build_msgid_index_key; never hand-built),
   value `<target>|<msgid>|<reason>`. Written where the REDACT context row is stored. Pruned with the
   parent row's retention (a store that no longer holds the row has nothing to redact).
3. **Catch-up query** — CH subcommand letter `D` (L B A R W S X are taken):
   `CH Q * D <since_ms> <limit> <reqid> <dest>`; the responder scans `rdx` from since_ms and answers with
   `CH E … D <time_ms> <redact_msgid> <target> <msgid> :<reason>` lines + the usual end marker, over the
   existing tunnel (crdt_ch_tunnel_dispatch) or P10. The requester applies each through
   redact_apply_remote (idempotent: repeat REDACT = success, no second context row — verify the msgid-index
   dedup on store, add it if absent).
4. **Watermark + triggers** — a persisted meta key `redact_watermark` (history CF, builder) = the upper
   bound of redactions this store has applied or verified. Triggers: (a) boot, after history_init;
   (b) `chathistory_store_reachable(num)` (an absence closing from our side — covers partitions and the
   peer's outage as seen by us; our own outage is (a)). Action: fan out `D since=watermark-60s` to every
   reachable store (collect_storage_targets), merge replies by redact_msgid, apply, then watermark = the
   min of the replies' upper bounds (now, if all answered). Bounded by store count × redactions in window.
   No timer: absence close and boot are the only two events after which a miss is possible.

## Execution log
- **P1 SHIPPED 2026-09-21 `9c0e221`+`314d278`+`a18d1e7`+`cef9c38` (pushed, fleet on it).** Gate
  `scratchpad/redact_gate.py <origin> <watch>...`: hub2→leaf5/leaf2/primary, leaf5 (overlay-only)→hub2/
  leaf2/primary (legacy via the receiver re-emit), primary (legacy)→hub2/leaf5/leaf4 — every watcher one
  REDACT line, content gone from its page, exactly one REDACT context row. Two defects the gate surfaced on
  the way (both fixed, both pre-existing):
  1. `a18d1e7` the mesh mint after arming the one-shot S2S tags consumed them → the tree copy left untagged
     → legacy stores minted a second redact msgid (two context rows on a federated page). Mint first.
  2. `cef9c38` **the CR M channel receiver delivered locals with sendrawto_one (no @msgid/@time) and re-emitted
     to legacy without S2S tags** → tagged clients on mesh nodes could not reply-quote/REDACT mesh-delivered
     messages, and a legacy store minted its OWN msgid for the gateway copy, so a REDACT naming the origin's
     id never matched there (one-msgid-per-event violated on every mesh→legacy message). Now delivered via
     sendcmdto_channel_butone with client event + S2S tags armed + CRDT-aware servers skipped (the server
     leg IS the gateway copy); mesh-only/server-form sources keep a raw local path that now prepends the
     tags. Probe `tagprobe.py 6674 6669`: `@time=…;msgid=AI…` on hub2 for a leaf5 speaker (was bare).
  NOTE: leaf5's page needs ~8 s on the bed (federated fan-out) and can carry the partial tag while a store is
  slow — the gate waits 8 s; not a REDACT concern.

## P2 wire + storage decisions (grounded 2026-09-21 00:15)
- **Index CF**: a new column family `redact_index` (`history_cf_redact`, opened with the others in
  history_init), key `<time_ms be64><redact_msgid>` (fixed 8-byte prefix keeps the CF time-ordered for a
  seek from `since`), value `<target>\0<parent_msgid>\0<sender>\0<account>\0<reason>`. Written in the
  same writebatch as the REDACT context row (history_store_message, the `type == HISTORY_REDACT` branch
  next to reply_index_put). Deleted with the REDACT row's retention purge (same batch as the row delete).
- **Query**: `CH Q * D <since_ms> <limit> <reqid> <dest>` — target `*` (not a channel), the responder
  branches on `D` BEFORE the channel/presence machinery (like TARGETS): seek `redact_index` from since_ms,
  emit up to limit rows, then `E <reqid> <n>[ T]`.
- **Reply row**: CH R carries no target, so `D` gets its own reply line
  `CH D <reqid> <time_ms> <redact_msgid> <target> <parent_msgid> <sender> <account> :<reason>`; the
  requester's `D` handler appends a HistoryMessage (type REDACT, target set) to req->fed_msgs and the
  request's completion_cb applies each via redact_apply_remote(src=&me-sourced sender mask, …) —
  idempotent (history_message_is_redacted gate). A dedicated letter keeps old peers (no D handler)
  ignoring it cleanly instead of mis-storing.
- **Request**: a FedRequest with completion_cb/cb_data (the SEARCH pattern), client_yxx = our own server
  numeric so `dest` routes replies back to us (tunnel-aware via collect_storage_targets + crdt_ch_tunnel_try).
- **cmocka (pure)**: rdx key encode/decode + ordering, value pack/unpack, D reply line parse.

- **P2+P3 SHIPPED 2026-09-21 `e6bdbf9` (pushed, fleet on it).** New CF `redact_index` (key time-be64 +
  redact msgid, value target/parent/sender/account/reason; same writebatch as the context row; deleted
  with it at purge); `CH Q * D <since> <limit> <reqid> <dest>` responder scans it → `CH D` rows + E;
  requester = FedRequest with completion_cb → redact_apply_row (explicit sender/account, idempotent) →
  watermark (meta key in the same CF, sorts last); trigger = chathistory_store_reachable (boot first-sight
  + absence close), 60 s slack, 200/round, truncated rounds continue (≤8). redact_index.c pure, gated by
  history_cmocka (38/38). Gate `tests/src/ircv3/crdt-mesh-redact.test.ts` (CRDT_BED=1) 2/2: live 12 s;
  stop nefarious6 → redact on hub2 → start → leaf4 logs "REDACT catch-up from AD: applied … " over the
  tunnel and its member page shows the row redacted with one context row, 79 s end to end. Boot on every
  node asks each store once (legacy primary ignores `Q * D` silently → request cut, watermark kept).
  TRAP (test): a page reader must be a MEMBER — presence filtering hides everything from a stranger.
- **FORK PORT SHIPPED 2026-09-21 fork `2b98f1d`** (ircv3.2-hardening = ircv3.2-upgrade on origin AND
  upstream): redact_index.c/CF/scan/watermark + `CH Q * D` + `CH D` + catch-up request verbatim, minus the
  tunnel/stub branches; replies are direct `sendcmdto_one(&me, CMD_CHATHISTORY, sptr, …)` (the fork has no
  ch_reply_out); the trigger is the store's `CH A S` arrival (`absence_close(server_ad_index(sptr))` site).
  history_cmocka 38/38 there too. Bed: tree pair rebuilt on it; gate `tests/src/ircv3/chathistory-redact-
  catchup.test.ts` (SQUIT leaf → REDACT on primary → CONNECT → leaf applies via the re-ad trigger) **2/2 PASS**;
  search-federation 5/5 and chathistory-federation 7/7 unchanged on the port (Q-handler regression).
- Soak on crdt-mesh `e6bdbf9`: 12/12 clean (00:33-01:37).

## Phases (each: cmocka where the logic is pure, bed gate, commit)
- **P1 live letter** — factor redact_apply_remote; CR M `R` mint (3 origin sites + gateway edge); v3
  relay exclusion for CRDT-aware links; receiver. Gate: `redact_gate.py` — redact on hub2, page on leaf5
  shows the placeholder + REDACT row; redact on the primary (legacy) reaches leaf5; P10-linked leaf2 gets
  one copy (count the REDACT client lines like sno_gate).
- **P2 index + query** — build_redact_index_key/parse (history_cmocka: encode/decode, range order,
  prune-with-parent); write on apply; CH Q `D` responder + reply parser (pure parse in cmocka); requester
  apply path. Gate: manual `D` from hub2 against leaf5 returns the redactions since T.
- **P3 watermark + triggers** — meta key; boot and absence-close fan-out; watermark advance. Gate: vitest
  `crdt-mesh-redact.test.ts` (CRDT_BED=1): stop nefarious6, redact on hub2 a row leaf4 holds, start it →
  leaf4's page shows the redaction within the absence-close window; row count of REDACT context rows on
  leaf4 = 1 (idempotent).
- **P4 docs** — docs/features/redact.md "Storage peers" section; skill note (letters R + CH Q D).

## Not in scope
Redaction of rows a store fetched by federation and cached (stores do not cache remote pages).
A REDACT older than the store's retention (nothing to redact). PM redactions ride the same letter.
