# Registered marker (R) vs persist (z) — RESOLVED 2026-08-01

Status: **RESOLVED — no transition needed.** Final design shipped on the
`feature/channel-rename` branches (X3 `b44a20b`, fork `95e6ef1`, upstream
backport `2cbc830`). This file records the root cause, the decision path
(including two abandoned intermediate designs), and the validation gates.

## Root cause (what was actually broken)

- X3's `MODE_REGISTERED` bit (hash.h comment `/* Bahamut +r */` — the bit
  descends from Bahamut's registered-mode concept; the `z` wire mapping was
  X3's own) was wired to channel-mode letter `z`. On nefarious, `z` is the
  **persist exmode** (`EXMODE_PERSIST`) — a services-settable keep-alive,
  not a registration marker.
- Independently, every X3 site announcing the marker was gated behind
  `off_channel > 0`; deployed confs run `off_channel=no`. Net effect:
  **X3 emitted no registered marker at all.** Registered channels carried
  neither `z` nor `R`.
- Silent consequences on the fork:
  - `FEAT_CHATHISTORY_STORE_REGISTERED` never fired → storage depended on
    local-member topology. **Likely root of chathistory not-always-storing
    flakiness and the 5/7 federation failures**
    (`project_chathistory_federation_gap`).
  - Channel metadata never reached the permanent store tier.
  - `m_rename`'s services-arbitration gate unreachable → a RENAME of a
    registered channel would take the DIRECT path, bypassing X3.

## Decision path (three designs, last one stands)

1. ~~X3 remaps letter `z`→`R`~~ (`129a0d8`): rejected — silently drops the
   accidental-but-real persist semantics `off_channel>0` networks had.
2. ~~Keep `z` as the registered letter; fork mirrors services `±z` onto
   `MODE_REGISTERED` (`FEAT_REGISTERED_FROM_PERSIST`)~~: built, gated
   (`324 +tnRz` verified live), then superseded same session. Reverted:
   fork `95e6ef1`, upstream `2cbc830`; X3 letter-revert `0a92a7b` remains
   in history under the final commit.
3. **FINAL: both letters, true meanings, orthogonal:**
   - `R` = `MODE_REGISTERED`. X3 emits it **unconditionally** on
     register/unregister/move/DB-load (the `129a0d8` announce fixes —
     off_channel un-gating + handle_join self-heal — stand).
   - `z` = `MODE_PERSIST` (new X3 bit), the persist exmode used as
     originally intended: set alongside `+R` **only when `off_channel>0`**
     — exactly when no ChanServ presence holds the registered channel open
     while empty. Cleared with `R` on unregistration (ircd's `-z`-on-empty
     schedules the destruct), moved on `cmd_move`, healed on join.
   - Parse: `z` → `MODE_PERSIST` (never REGISTERED); both letters guarded
     from user-typed modelocks via `MCP_REGISTERED`; CLEARMODE takes both;
     cmd_burst unknown-channel correction strips `-zR`.
   - Ircd side: **no special code at all** — the fork's R machinery
     (rename arbitration, chathistory store-registered, metadata
     persistence tier) keys off the `R` X3 now actually emits.

## Compatibility notes

- Legacy nefarious2 + new X3: `R` is upstream's accepted inert marker;
  `z` behaves exactly as it always did (persist), and only appears with
  `off_channel>0` — the same networks that had it before. No regression at
  any upgrade order.
- Old X3 (z-as-registered) + fork: same dead-marker status quo as today;
  fixed by upgrading X3, not by ircd-side compat shims.

## Validation gates

1. Register via ChanServ (deployed conf `off_channel=no`) → wire MODE
   carries `+R` only (no `z`); `324` shows `R`, not `z`. **[GATED GREEN
   2026-08-01: `MODE #zrr… +Ro X3`, `324 … +tnR`]**
2. Owner RENAME routes through AC R services arbitration (needs the
   legacy-blocker-free window: SQUIT `upstream.fractalrealities.net` AND
   the crdt anchor stubs `leaf4`/`leaf5` — anchors introduce with `+6`
   only, so `rename_legacy_blocker()` counts them as legacy).
   **[GATED GREEN 2026-08-01: `AC … R 1 #zrs8678 RENAME` → `AC 1 A RENAME`
   → RN broadcast; new name `324 +tnR`, old name 403. NOTE: X3's
   arbitration reply lagged ~20s behind the anchor-SQUIT QUIT storm —
   probes need generous timeouts inside that window.]**
3. `channel-rename-services.test.ts` 8/8. **[GATED GREEN 2026-08-01, run
   inside the same legacy-free window]**
4. `off_channel>0` bed variant: register → `+Rz`, drop → `-zR` + empty
   channel destructs after ~1m. [NOT RUN — deployed conf is off_channel=no;
   run if that conf ever flips]
5. Chathistory federation suite re-ran **7/7 GREEN 2026-08-01** — but note
   those tests use UNREGISTERED channels (their old 5/7 failures were
   test-environment artifacts, resolved 2026-07-26 per
   `project_chathistory_federation_gap`). The `R`-gated
   `FEAT_CHATHISTORY_STORE_REGISTERED` path — now reachable for the first
   time — has NO test coverage: a registered-channel federation case
   (message to a +R channel with zero local members on the storing node)
   is the missing test. [COVERAGE GAP — candidate follow-up]
