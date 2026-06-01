# CHATHISTORY S2S → Tag-Driven Wire Migration

**Status**: Deferred — design captured, no implementation work scheduled.
**Memory**: `project_chathistory_s2s_tag_migration` (constraint, design choices, audit pointers).

## Why

P10 S2S body is fixed at 512b; tags grow without counting against the cap. The CH compact subcmds (L/B/A/R/W/T/X/Q/E/Z) were designed *before* S2S message tags landed, so every byte of `msgid` / `time` / `batch` / `compression sentinel` they carry comes out of the 512b allotment for actual message payload. Moving those to tags frees the body for what it should be — the actual message text. Sender-side cost is roughly free (we already emit tags on client-facing relay); receiver-side cost is a small parse refactor.

## Guiding principles

1. **Minimal wire when possible**. No dual-emit. No data carried redundantly between body and tags. No longer encodings than necessary. Single source of truth per field.
2. **Compact tags only**. Single-letter compact tag names — no vendor prefixes (`@+nef/…`), no long IRCv3 client-tag names. We only support Nefarious, so namespace-sharing isn't a concern. Precedent: [[project_hlc_msgid_format]] uses `@A<time_7><msgid_14>` — single-letter `A` for the HLC-seeded msgid, value packed.
3. **No legacy-peer dance for CH**. CHATHISTORY is a fork-exclusive IRCv3 extension — evilnet/nefarious2 upstream doesn't implement it at all. Both sides of any CH-speaking link are Nefarious fork builds we control directly. We get to rewrite the wire format in place without a parallel scheme, opt-in letter, or capability negotiation. (For *core* P10 wire — BS/BX/AC/MARK — legacy peers exist and matter; see [[feedback_ircv3_vs_core_legacy_split]]. CH is not in that bucket.)

## Approach

Rewrite the CH S2S wire to tag-form in place. Existing subcmd letters (L / B / A / R / W / T / X / Q / E) keep their dispatch semantics; per-message metadata moves out of the body into compact letter tags. CH X (exact lookup), CH Q (federated query), and CH E (end) carry no per-message metadata in the first place, so they're essentially unchanged.

### Wire shape change

**Current (CH L example)** — per-message metadata in the body:
```
[SERVER] CH L #channel <msgid_or_time_ref> [<msgid_or_time_ref> ...] :<payload>
```

**Tag-form** — per-message metadata in compact letter tags; body is subcmd + target + payload:
```
@<letter>=<msgid_packed>;<letter>=<ts>;<letter>=<bid> [SERVER] CH L #channel :<payload>
```

For multi-message responses (e.g. CH B base64-chunked): each S2S message carries its own tag set with the msgid for that specific message. Chunking framing (`CH B+` / `CH B` / `CH B-` or whatever the current shape uses) stays in the body because it's framing — not metadata — and is needed for parse-time dispatch *before* the receiver inspects tags. Chunks group by the batch-id tag.

Specific letter assignments are an implementation-phase decision once the candidate set is locked. Constraints: pick characters with no current allocation in other S2S tag schemes, and consider continuity with [[project_hlc_msgid_format]]'s `@A` so packed-msgid carries seamlessly between contexts.

### Compression sentinel

The current Z body-level flag (compressed-passthrough) becomes a single-letter tag (specific letter TBD at implementation). Extensible to future codecs by extending the value encoding, not the tag name. Per-CF compression on Nefarious's RocksDB CFs is already `compress=0` so the tag-form is round-trip safe.

## Migration shape

CH-speaking peers are all Nefarious fork builds we control. The migration is just:

1. Implement parse + emit of the tag-form on the fork.
2. Cut over senders to emit tag-form unconditionally.
3. Drop the legacy compact body form from the parser at the same time, since nothing emits it any more.

Implementation order: receive-side handlers first (parse tags into per-message metadata, no behaviour change yet), then sender-side cut over in a single change, then receive-side removes the legacy body-form parser. No dual-emit phase; no fallback path to maintain forever.

Roll across the network in a build cycle: prod-test gets the receive-side first, then the sender flip, then the legacy-form parser removal — each step is a clean stable point. Whole rollout fits in one weekend's worth of restarts since both servers are ours.

## Audit pointers

- `nefarious/ircd/history.c` — federation send/receive paths
- `nefarious/ircd/m_chathistory.c` — client-facing dispatch
- `nefarious/ircd/parse.c` — CH subcmd registration
- `P10_PROTOCOL_REFERENCE.md` `### CHATHISTORY (CH)` — current wire reference (rewrite in place — no parallel Compact-Form section to maintain)
- `FEAT_P10_MESSAGE_TAGS` — gates whether tag-form is sendable at all (probably should become always-on for CH once the cutover lands)

## Acceptance

- Tag-form parsing + emission implemented on all CH subcmds carrying per-message metadata (L / B / A / R / W / T)
- Sender side cut over in a single change; no dual-emit phase
- Legacy compact body-form parser removed; no fallback to maintain
- Legacy peers continue to receive the existing compact form
- `irctest` (`evilnet/irctest` submodule under `nefarious/.irctest`) gains conformance tests against both wire forms
- Memory entry [[project_chathistory_s2s_tag_migration]] gets updated with the FIXED stamp + the actual letter assignments chosen
