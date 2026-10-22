# Deferred-items batch: realname clobber, open bugs, identity leftovers, bed hygiene

Started 2026-10-21 22:10 (user: "Need to handle the realname clobber, open bugs, and the identity
leftovers. And the bed hygiene. We'll consider the borderline once those are done."). Source rows:
`.claude/para/areas/deferred-items.md`. Borderline (deauth plan 1 residue) waits.

Working rules: TDD per item (failing bed test or cmocka first, where a test can be built; say so where
not); fork work on a branch off `ircv3.2-upgrade`, cherry-picked to `ircv3.2-hardening`; x3 work on
`feature/keycloak-identity` (draft PR #63) unless the item stands alone; no commit or push without the
user's OK; unverified items are verified (reproduced or disproved) before any code.

## A. Realname clobber (rdrake 2026-10-02)
`dead_link` writes "Write error: ..." into `cli_info`; a held client keeps it, `bounce_db_put` persists
it, revive and every legacy N replay it (prod: rdrake shows "Write error: Internal OpenSSL error or
protocol er"). Direction from the register: a connection-scoped exit reason written by `dead_link`,
read where the exit message is built; the realname is never overwritten. Analysis: bouncer-analyst
(every reader/writer of cli_info on the exit path, s_bsd.c ~1807-1916 fallbacks, s_misc.c, the hold
path). Test: bed -- a client killed by a write error / EOF that holds, revives; WHOIS realname intact
locally and on the leaf.

## B. Open bugs
| # | Item | Status | First step |
|---|---|---|---|
| B1 | Live umode changes not announced to a session's other connections (`bounce_sync_session_umodes` silent) | confirmed by design | decide the announce rule with A-analyst output; test: OPER on one device, the other sees MODE +o |
| B2 | Same-server alias keeps oper privs/OPER_HANDLER after -o (APPLY_TO copies on +o, never clears) | UNVERIFIED | bed repro (alias runs an oper command after primary -o) |
| B3 | Replica `hs_total_active` only from the BS C burst; a replica that becomes holder arms a stale hold | confirmed (found while fixing accrual) | analyst: where to replicate (BX U field like cc=) |
| B4 | A revived client still read IsBouncerHold ~2 s later and a deauth exited it | UNVERIFIED | analyst + bed repro |
| B5 | Rebind gate clause (c) `acc_ts_match` (~6004) can no longer fire (local logins carry no timestamp) | confirmed by reviewer | analyst: replace with the kc_id or sessid agreement |
| B6 | SASL relay `L` reply without timestamp (parc <= 5) and the iauth account path (s_auth.c ~3090) leave a previous session's timestamp | confirmed by reviewer | clear the field; test where reachable |
| B7 | `ssl.c` ~825 drains the ERR queue before the SNO_TCPCOMMON notice, hiding the reason | proposed | guard / report the real reason |
| B8 | TLS priority line vs pending record ("bad write retry"); prod has FLUSH_ULINE_IMMEDIATE ON (default TRUE, not in gitsync.conf), ping/WALLOPS always priority. Fix exists on `fix/ws-oob-frame-pending` (55daa07 + the WS OOB frame commits f3246b6/f249c63/19e1ad7), bed-only, never reproduced | unverified fix | time-boxed deterministic repro (slow-drip TLS reader + priority line), then push the branch |
| B9 | `bounce_pending_canon_register` has no callers (dead) | confirmed | remove, or wire it if A/stale-face work needs it -- decide with the analyst |
| B10 | `log_vwrite` writes stack bytes for a line > 2 KB (valgrind, ircd_log.c ~466) | confirmed | cmocka or valgrind repro, bound the copy |

## C. Identity leftovers (step 5 / 5c)
| # | Item | Side |
|---|---|---|
| C1 | Restored ghosts never regain a Keycloak id; BX U `account=` receiver keeps the previous id/ts on aliases; persist `kc_id` in the session record (record v12) | nefarious |
| C2 | `kc_id_prev` remembers only the latest replaced id (a small list) | x3 |
| C3 | `created_at` fetched, cached (positive SASL cache) and kept (`acc_created_at`) but unused on the wire: strip | nefarious |
| C4 | `isalnum` in `account_id.c:67` is locale-dependent: explicit ASCII test (cmocka) | nefarious |
| C5 | `sasl_id_for` outside the keycloak block: unused-function warning without Keycloak | nefarious |
| C6 | LOC reply `A` keeps a stale `acc_create` when `parc <= 4` | nefarious |
| C7 | X3 checks the id's length only, not its alphabet | x3 |
| C8 | X3 Part A legacy fall-through binds unknown single-letter subcommands | x3 |
| C9 | Fail-open when the grant reply lacks `id_token` logs at DEBUG only | nefarious |
| C10 | ACCOUNTINFO shows the id to the account's owner too (plan said opers) | x3 |
| C11 | Tests: multi-user handle reset (legacy-slot test); D3 trusted-authzid bed config; binding test asserts the kill reason; REBIND operator note | tests/docs |

## D. Bed hygiene
| # | Item |
|---|---|
| D1 | Hub restart splits the stock slot (+X3) and the leaf off and they never come back (slot Connect class connectfreq 5 min; cause not found) -- find why autoconnect fails; until then the restart tests relink themselves |
| D2 | x3 `bed-x3` branch is stale (bed runs `bed-x3-identity`) -- retire it |
| D3 | nefarious tree `.claude/skills` mirrors drifted from the testnet copies -- sync in a chore commit |
| D4 | `bouncer-hold-lifecycle.test.ts` asserts sessids start `AZ` (UUIDv7 time-bomb, now `Aa`) |
| D5 | #122/#123 label edge cases (low): labeled-response without batch; per-line @label on multi-line ISON |

## Decisions (user, 2026-10-21 22:30-22:40)
- A: already-clobbered realnames are REPAIRED at revive (stored realname matches a dead_link text ->
  adopt the reviving connection's, spread like SETNAME: v3 SETNAME, BX U realname=, SI to legacy).
- A: a bouncer primary whose socket dies by write error / sendQ overflow HOLDS like a network drop
  (packet.c / check_pings paths today exit it; reproduce first).
- A: the exit reason gets a LONGER buffer than REALLEN (full OpenSSL text in QUIT/ERROR).
- C1: revive with a Keycloak id that DIFFERS from the held ghost's -> REFUSE the revive; the stale
  ghost is ENDED (quiet exit with a stated reason) and the login registers a fresh session. A ghost
  with NO id adopts the reviving login's id (otherwise every pre-v12 session fails to revive).
- C1 (user, 2026-10-22 11:50): the adopt rule "has to do that, otherwise it breaks the transition" --
  pre-v12 records and every session begun by an X3 login carry no id.  Webhooks "aren't happening for
  now", so nothing ends a held session when its Keycloak account is deleted: a name re-registered while
  the old session is held revives into it (residual risk, same class as the x3 name-reuse item; Rubin:
  names are never reused).  Security review flagged it 10-22; kept by decision.
Analyst findings driving the rest (2026-10-21): B2 real and a crash (alias keeps OPER_HANDLER after
-o; KILL asserts); B4 most likely a test-run misread (harden the ACTIVE-branch revive only); B3 real
(BX U ta=); B5 premise out of date (clause (c) retired in 95e61e3) -- my default, not a user decision:
a kc_id VETO on the rebind gate (both present and differ -> refuse); B9 delete the whole dead
frontier introducer (done in the worktree); C1 BX U account emits run before the primary's ts/id are
set (sasl_auth.c:731, m_account.c:249) -- reorder; side findings: the live sync copies FLAG_SSL; the
IsServer MODE branch may parse mode ARGUMENTS as letters (UNVERIFIED, possible +o grant -- check
first); the demote path introduces no new legacy face (register).

## Status (2026-10-22 02:10; committed locally, nothing pushed)
Fork: split into local commits (worktree `scratchpad/nef-split`): `fix/deferred-batch-split` = 20 commits on
upgrade ce56879 (3 cherry-picked rebind-gate commits with their authorship, the items, the skills sync);
`fix/ws-oob-frame-pending-port` = B8 on top (4 cherry-picks + the update_write fix). Hardening copies:
`fix/deferred-batch-hardening` / `fix/ws-oob-frame-pending-port-hardening` on 323433f (`scratchpad/nef-hard`;
the two branches had identical trees, so the trees match). Every commit builds; clean builds at the
header-changing commits; cmocka at both tips. Snapshot of the working state: `refs/batch/final-snapshot`.
X3: `fix/identity-leftovers-split` (C7, C10, C2 on #63 head 5054da8, `scratchpad/x3-split`) and
`fix/ac-unknown-subcommand` (C8 on #62 head 5ee1a88, `scratchpad/x3-ac-subcmd`). Bed: nefarious = bed-deploy
9074e3b + batch v3 uncommitted (no B8); x3 = bed-x3-identity + C2/C7/C8/C10 uncommitted.

| Item | State | Evidence |
|---|---|---|
| A | done: `cli_exit_reason` (EXITREASONLEN 127), `exit_dead_client` holds a dead primary on every path, revive clears the reason and repairs a clobbered realname (`exit_reason.c`, cmocka) | `bouncer-dead-link-hold.test.ts` red on batch 1, green on batch 2 |
| B1 | done: `bounce_sync_session_umodes(source, source_before, told)` tells each member its own MODE diff (+008); FLAG_SSL no longer synced | `bouncer-umode-announce.test.ts` 4/5 red on batch 2, 5/5 green on batch 3 (one TLS-case timeout traced to the purge stall, below) |
| B2 | done: `bounce_strip_oper_privs` on -o; IsServer MODE branch skips mode arguments | `bouncer-oper-sync.test.ts` red then green; the argument parse is untested (needs X3 to send letter args) |
| B3 | done: `BX U <primary> ta=` (hold, promote, burst, adopt; max) + CHECK -b "Active time" | `bouncer-active-time.test.ts` red then green |
| B4 | done: hardened (clear the hold flags if was_holding OR IsBouncerHold) | analyst: likely a misread; no repro |
| B5 | done: rebind gate from `fix/retire-rebind-acc-ts-gate` (396c423, 95e61e3, 8fdaf50, cherry-pick with authorship) + kc_id veto `bounce_rebind_kc_conflict` | cmocka 10/10; a vetoed rebind falls back to collision handling (ending the stale ghost there = follow-up) |
| B6, C6 | done: clear stale acc_create / kc_id on the relay L, iauth and LOC A paths | not reachable on the bed (no test) |
| B7 | done: `ssl_take_error` reports the first queued reason | none (no deterministic OpenSSL error on the bed) |
| B8 | ported on its own branch (above) + a fix of mine: `update_write` dropped writable interest when only a stashed WS frame was pending, so 19e1ad7's send_queued branch never ran. NOT run on the bed; my repro attempt was abandoned. Ship on review or verify another way: user's call | websocket cmocka 14/14 |
| B9 | done: dead frontier introducer removed | build |
| B10 | done: `log_written_len` clamps | none |
| C1 | done: `bsr_kc_id` (DB v12, v11 frozen + migration), revive refuses a differing id and ends an alias-less held ghost, a ghost with no id adopts; alias emits after ts/id are set; `bounce_sync_alias_identity`; CHECK "Keycloak id" line | v11->v12 migration verified on the bed; bed tests for refuse/adopt still OWED |
| C3, C4, C5, C9 | done | cmocka (C4) / build |
| C2, C7, C8, C10 | done (agent, reviewed): C7 alphabet check `handle_kcid_valid`; C10 ACCOUNTINFO id lines under IsOper; C2 `kc_id_replaced[4]` list, saxdb string list under the same key (old string still read); C8 unknown 1-letter AC subcommand ignored (on #62's branch: its subject) | C2 `keycloak-id-rebind.test.ts` "every id a change replaced" and C10 `keycloak-id-accountinfo.test.ts` owner case green (not run red); C7/C8 unreachable on the bed |
| C11 | partly: the C2 two-back case and the C10 owner case written; multi-user handle reset legacy-slot test, D3 trusted-authzid bed config, binding-test kill reason, REBIND operator note still open | -- |
| D1 | done (bed confs, uncommitted, never committed: data/ holds secrets): class Server connectfreq 30 s, X3's Connect in its own class "Services" (X3's link filled class Server: maxlinks 1, ref_count = links + 1), CONNECTFREQUENCY 60 | slot, X3, leaf relink 15-55 s after a hub restart / SQUIT |
| D2 | done: `bed-x3` archived as tag `archive/bed-x3-2026-10-21` and deleted | -- |
| D3 | done in both trees (uncommitted): nefarious `.claude/skills` merged + invariants 14-16 for this batch; testnet copies synced from them (+ a testnet-only secrets line) | -- |
| D4 | done: sessid regex `^[A-Za-z0-9+/]{22}$` | -- |
| D5 | spec read (labeled-response: batch MUST be negotiated; a multi-message response MUST be batched; the label on exactly one message): without batch the fork labels the first message only, nothing to change; `reply_tags()` labels EVERY non-batched send_reply line (no `cli_label_responded` check) and ISON's split path opens no labeled batch -- fix not written | -- |

New register rows owed: demote path has no legacy face; revive refusal while aliases live elsewhere;
same-name AC announcement waits for the hops; IsServer argument parse untested; 17 pre-existing
no-Keycloak warnings in sasl_auth.c; stale unknown features in data/ircd2.conf; vetoed rebind leaves the
stale ghost to collision handling.
