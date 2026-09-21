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
