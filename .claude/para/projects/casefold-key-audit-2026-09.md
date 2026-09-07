# Case-folding of client-typed keys — audit 2026-09-02

Trigger: prod field report (empty BETWEEN on #linux). Root cause of the *first* symptom was the
chathistory lookup keying on the client's spelling while the store keys on `chptr->chname`
(`af31cc3`). The user's follow-up: "this casefolding issue may bite elsewhere" → c-auditor sweep of
every store key / in-memory table / compare fed by a client-typed channel, nick or account name.

Enumeration: 10 key builders, 98 store call sites, 270 API call sites, all 275 non-folding compares
reviewed (nothing sampled).

**Status 2026-09-02 (evening): the durable fix shipped as `80c93e2`** — every key builder folds
its name components (`include/db_casefold.h`) and existing stores are rewritten once at open
(`db_casefold_migrate`, marker `schema/casefold` in each env's default CF). Every item in the
"open" and "design-level" sections below is closed by it; the sections are kept as the record of
what the point fixes could not reach. Prod stores measured that afternoon: history 7.8 MB,
metadata 0.44 MB of live data, so the rewrite is sub-second at boot. Rule for new code: the
`nefarious-codebase` skill, "Persistent store keys fold names".

## Fixed

| Where | Defect | Commit |
|---|---|---|
| `check_history_access` (chathistory lookups, all five subcommands) | typed spelling copied into the lookup key | `af31cc3` |
| `m_redact` / `ms_redact` | delete + REDACT event row keyed by typed spelling | `af31cc3` |
| `build_readmarker_key` (read markers CF) | unfolded target | `af31cc3` (folds with `ToLower`) |
| `m_metadata.c` channel LMDB fallback of `METADATA GET` | `metadata_account_get_vis(target …)` with the typed spelling; rows written under `chptr->chname` | follow-up commit (uses `target_channel->chname`) |
| `m_markread.c` `sm_hash` (ephemeral session marker table) | hash folded only A-Z while `sm_find` compares with `ircd_strcmp` (rfc1459 `[]\~` ≡ `{}|^`) → bucket miss | `4087e9b` (`ToLower`) |
| `m_markread.c` `notify_local_clients` (found while testing the above) | ephemeral MARKREAD SET was stored but never echoed: the notifier matched only accounts, so session-anchored setters were skipped (spec: every connection of the setter receives the marker) | follow-up commit (matches the session_id anchor too) |

## Closed by the builder-level fold (`80c93e2`) — formerly "open"

These were the sites where the typed string was copied straight into an unfolded key because no
live object could supply the canonical case. The builders fold now, so the typed half and the
stored half meet at the same key whatever either party typed:

1. **PM pair key, counterparty offline** (`m_chathistory.c` `normalize_pm_target`, both branches;
   also `history_pm_target_has_sessid` for ephemerals). Store side keys the half as
   `history_pm_identity()` = `cli_user()->account` (X3 canonical case). Typing `bob` for account
   `Bob` scans an empty prefix in every PM subcommand. Online counterparty is safe (`FindUser`).
   Partial mitigation available: `bounce_find_by_account()` folds and can supply the canonical
   account for accounts holding a bouncer session (prod's persistence audience).
2. **`METADATA GET <offline-account>`** (`m_metadata.c` ~419/483): `account = target` typed.
3. **Oper `METADATA SET *account`** offline write + its S2S relay (`m_metadata.c` ~792/822/1494):
   writes/deletes under the typed spelling; `metadata_load_account(acptr, canonical)` never sees
   the stray row; every peer repeats the miss.

## The durable fix (shipped `80c93e2`) — formerly "design-level residue"

What shipped: `db_casefold_bytes` in `history.c` `build_key` / reply index / msgid-index tail /
targets index / quota keys / seek prefixes and in `metadata.c` `build_lmdb_key` (target **and**
key name) / `build_readmarker_key`; `db_casefold_migrate` at `history_init` and
`metadata_lmdb_init` (messages, msgid_index, targets, quotas, reply_index; metadata,
readmarkers) with component masks so msgids/timestamps stay as written; TARGETS shows a live
channel's current spelling; cmocka `db_casefold_cmocka` (13 tests, in-memory fake store);
Vitest `chathistory-target-case.test.ts` grew the PM-offline, METADATA-offline and TARGETS
cases (red on the old image, green after). `bouncer_sessions` (opaque ids), webpush (canonical
accounts) and the presence CF (channel half already folded, account half always canonical) are
untouched. Collision policy: a row already at the folded key wins; unfolded duplicates are
dropped and the first 20 logged.

Found while regressing on the bed and fixed alongside (`b231899`): the PM replay derived "the
other party" as the first row whose sender *nick* differed from the caller's current nick, so a
row the caller sent under an earlier nick opened the batch on that old nick, and the other party
came back under whatever nick they had in the first row met. Own rows are now recognised by
sender account (nick fallback for unauthenticated callers), the newest row the other party sent
is chosen, and that party is shown under their current nick when a client is logged into the
row's account; each row's wire target follows its direction in today's nicks (own rows to the
other party, incoming rows to the caller) instead of the stored original_target, which was the
nick typed at the time and scattered one conversation across buffers. The sender prefix of
incoming rows keeps the nick the other party had at the time — DECIDED (user, 2026-09-02): it
stays historical; sane clients update their buffers on live nick changes, and history playback
is a weaker signal for that anyway (poxchat does not trigger on historical events), so
rewriting prefixes at replay is not wanted. Same family as this audit: identity, not spelling,
is what a lookup keys on.

Test-suite residue seen while regressing (not caused by the fold; recorded so it is not lost):
`redaction.test.ts` had never negotiated `message-tags`, so every echo came back without a
msgid and the whole suite failed on "No msgid in echo" — fixed in the test the same evening.
With that fixed, "REDACT same message twice returns error on second attempt" still failed:
since `d04840b` (2026-04-12, REDACT-as-context) redaction keeps the row as a placeholder with a
REDACT context child, so a second REDACT of the same msgid found it, stored a second context
row and rebroadcast. The spec lists `UNKNOWN_MSGID` as "does not exist or is too old" and is
silent on repeats. Decision (user, 2026-09-02 evening): a repeat is an idempotent success —
REDACT echo to the requester only, nothing stored, nothing repeated; a repeat over the network
is shown and relayed but stores no second row. Shipped in the fork (`history_message_is_redacted`
+ `m_redact`/`ms_redact`), the test now expects the echo and exactly one REDACT row in history,
and `docs/features/redaction.md` describes the placeholder design. The test's retries were also
polluted: `sendAndCaptureMsgid` matched the bouncer's replay of the previous attempt's identical
message; it now ignores batched lines.

The analysis that led there:

- **Key builders never folded** (`history.c` `build_key`, reply/msgid index keys, quota key;
  `metadata.c` `build_lmdb_key`). `af31cc3` pinned lookups to the *current* `chptr->chname`, so:
  - a non-persistent channel that empties and is re-created in different case orphans all prior
    rows (messages, reply index, msgid index, quotas) until retention;
  - **split-brain spellings**: channels created independently on both sides of a netsplit keep each
    server's spelling after the merge (`FindChannel` is case-insensitive; `chname` is never
    rewritten). CH W write-forward rows then land under the forwarder's spelling and local / CH Q
    lookups on the other server miss (`m_chathistory.c` ~2701-2716, ~4972-5052 use the wire
    `parv[2]` verbatim even though `chptr` is resolved). Frequency on prod: unknown.
  - account halves (PM pair keys, metadata, read-marker/presence account halves, webpush, quotas)
    if an account's canonical case ever changes; `m_account.c:253` swallows a case-only `AC M`
    rename (`ircd_strncmp(...) == 0 → return 0`), leaving `cli_user()->account` on the old
    spelling while X3 has the new one.
  - The durable fix was folding inside the builders (casemapping `ToLower`, like the presence CF
    already did) **with a one-time key migration** for existing RocksDB data — shipped as
    above; the size question was answered by the prod listings (under 9 MB in total).
- `persistence_profile.c` `build_profile_key` (verbatim) vs `profile_name_eq` (folds):
  `Work`/`work` could coexist; ATTACH/SET case-sensitive; DELETE could be refused by a
  fold-matched child. Closed by the same commit: the profile name lives inside the metadata
  key name, which `build_lmdb_key` now folds.

## Verified safe (why)

History store side always passes `chptr->chname`; PM keys derive from `history_pm_identity` on
both sides with `ircd_strcmp` ordering; CH A channel ads fold on insert/lookup/remove; presence CF
folds the channel in the key and the in-memory table hashes/compares consistently; read markers
now fold; bouncer `AccountSessions` and `account_conn` fold; persistence-profile channel lists
compare with `ToLower`; webpush keys are canonical accounts; TARGETS access resolves stored
targets through the case-insensitive `FindChannel`.
