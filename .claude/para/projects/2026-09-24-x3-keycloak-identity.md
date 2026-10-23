# X3: identity by Keycloak id, timestamp check as it was before the bridge — Implementation Plan

> Executed inline (superpowers:executing-plans). Spec: the user's directions of 2026-09-24
> 15:29-16:02 on top of `account-timestamp-authority-2026-09.md` (design F) and Rubin's
> positions (memory `rubin-positions-2026-09-24`).

**Goal:** X3 binds each handle to the Keycloak user id the ircd announces; a different id
under the same name means the account was recreated, so the handle's data is reset and the
name carries on (Rubin: "if field in x3 is empty, populate it. if its there but different,
delete+recreate data in x3.db"). The timestamp check goes back to what it was before the
LDAP bridge commit a52968b: X3's own `registered` is canonical, never rewritten on a bind,
and a wire timestamp that differs refuses the bind. Legacy servers still authenticate through
X3 over LDAP, so the check cannot be retired yet (user, 15:45/15:47). The fork ircd stops
stamping Keycloak's creation time on SASL logins: that is the directory's date, not X3's,
and "the ircd/keycloak do not have anything useful to give it" (user, 15:38).

**Decisions (user, 2026-09-24):**
- 15:29 "make things work as rubin wants"; 15:38 X3's timestamp check does the wrong thing
  on a mismatch (it overwrites), and the ircd/Keycloak have nothing useful to give it;
  15:45 "can't retire it yet"; 15:47 "fix it to work like it did — legacy servers don't do
  sasl on their own, so they still go via x3 over ldap for now"; 16:02 "like it did" means
  before the PR that overwrote them (a52968b), not a reconstruction.
- Rubin's reset replaces design F's D2 (refuse + KILL + REBIND-to-recover). REBIND stays as
  an operator tool; ACCOUNTINFO keeps its id line.
- Consequences I drew (open until the user objects): the fork sends `0` in the timestamp
  field on SASL logins (nefarious `fix/no-ircd-account-timestamp`, one hunk in
  `sasl_auth.c`), so a SASL login never mismatches and no seeding pass is needed for the
  dormant tail; the check only ever sees stamps X3 made itself. The register-time
  directory date (7864ce6, a different commit) is left alone: it is a creation-time value,
  not the overwrite. A reset remembers the id it replaced, because sessions from before the
  recreate keep announcing the old id (bursts, alias attaches, the ircd's login cache) and
  would otherwise flip the account back and forth.

**Branches:** x3 `feature/keycloak-identity` off `upstream/master` (5d7fadb), 5 commits:
`14931a0` timestamp check as before a52968b (+ the autocreate directory-date block of that
commit removed), `b156d6f` kc_id field + saxdb, `7ac40e9` ACCOUNTINFO line, `03ade7f` REBIND,
`bedb654` bind + reset + remembered previous id. Not stacked on #62; the bed builds
`bed-x3-identity` = master + #62 + this. nefarious `fix/no-ircd-account-timestamp` (f607b31
off the pushed 028de05; worktree `scratchpad/nef-nots`), merged into `bed-deploy` for the bed.

## Behaviour (handle_account, P10)

1. Parse `account[:ts[:id]]` (as before).
2. `hi = dict_find(name)`. If `hi` has a stored id, the wire carries one, and they differ:
   if the wire id is the one a reset replaced (`kc_id_prev`) it is one of this name's
   earlier sessions — bind it, log at INFO; otherwise **reset** —
   `nickserv_reset_handle()`: log + oper notice (`NSMSG_IDENTITY_RESET`), detach the
   logged-in users (stamp = 0, nothing to the ircd), run the unregister hooks (ChanServ
   access, memos, HelpServ, python), drop the handle (no LDAP delete: the entry belongs to
   the new user), `nickserv_register(NULL, NULL, name, NULL, 1)` (X3's own date, no
   password, the existing directory entry is tolerated), bind the new id, remember the old
   one, re-attach the users. Same in and out of a burst; nobody is disconnected.
3. Timestamp: `if (hi && timestamp && hi->registered != timestamp) { log; return; }` — the
   check as it was before a52968b (with 291ec17's `%lu` log form).
4. LDAP autocreate of an unknown name, unchanged (dated by `nickserv_register` from the
   directory, 7864ce6).
5. SUSPENDED → return. Adopt the id on an accepted login when none is stored. Bind.

## Tasks

1. Red tests (testnet): `keycloak-id-rebind.test.ts` (recreated user is reset: login
   accepted, new id and remembered previous id on ACCOUNTINFO, channel access gone, date is
   X3's fresh date, an older session is carried over; a login the ircd answers from its
   cache with the old id binds without another reset; REBIND set/clear/bad-id),
   `keycloak-id-burst.test.ts` (reset during a burst, no disconnect),
   `account-timestamp.test.ts` → gate `X3_TS_ORIGINAL=1` (an X3-made stamp replayed after
   saxdb was changed is refused and the date is never rewritten; a SASL login, which
   carries no timestamp, binds and leaves the date), `account-id-wire.test.ts` (the ts
   field is `0`). Red confirmed on the unchanged bed 16:00 (rebind 2 failed, burst failed,
   timestamp 2 failed).
2. x3 commits 1-5 (above). Host compile of nickserv.c with the image's configure flags: clean.
3. nefarious commit f607b31.
4. Bed: `deploy-identity.sh` (merges, three images, flush + backup of x3.db, recreate,
   link wait), then `suites-identity.sh`: account-id-wire (WIRE_KC_ID=1), the three above
   + keycloak-id-accountinfo (KC_ID_BIND=1), x3-account-change (X3_AC_CHANGE=1),
   sasl-reauth.
5. Docs: design doc rulings (D2 superseded; the ircd stamps no timestamp), step5-pr-drafts
   (PR 2 text, nefarious push note), register, memory.

## Review Focus

- A reset while the old handle's users include the claimant's own other sessions (bouncer
  aliases logged in before the recreate): they must end up on the fresh handle, not unbound.
- A reset for a handle with `opserv_level > 0`: the level is gone with the data (Rubin: "it
  resets them"); the log line names the old level.
- A recreated user recreated twice: the second reset remembers only the latest replaced id;
  sessions from the first incarnation would reset again (accepted; noted).
- An id-less announcement of a recreated name (legacy hop, impersonation): timestamp check
  refuses as before; nothing is reset.
- REBIND to a wrong id followed by a login with the real id: that login resets the account
  (the operator surface cannot make a mismatch harmless any more) — documented in help.

## Execution record (2026-09-24)

- Red run 16:00 on the unchanged bed: rebind 2 failed, burst failed, timestamp 2 failed (each on the behaviour, once a test-helper error was fixed).
- Wave 1 (x3 `bedb654`, nefarious f607b31): the ircd still put the directory time on the wire — the pre-registration path copies the SASL session field, which a second site fills. Fixed at the source (08ce54b: every local login hands `sasl_complete_login()` 0; the relay path keeps X3's stamp). Wave 1 results on the old ircd: burst 1/1, accountinfo 1/1, x3-account-change 2/2, sasl-reauth 4/4; wire and timestamp failed as expected; rebind failed on the test's access check (single-account `ACCESS` reply is not parsed; switched to the `USERS` listing).
- **Fresh review (fable) findings and the fix pass (x3 `9e13f54`, nefarious `fc2511a` on `fix/alias-account-identity-follows`):**
  1. Critical — `set_user_handle_info(u, NULL)` nulls `u->next_authed`, so the reset carried only the first session and freed the handle with the others attached. Fixed: users are taken off the head one at a time onto a private chain (dead users skipped) and re-attached from it. Test: two pre-recreate sessions in `keycloak-id-rebind`.
  2. Important — the fresh record was built by `nickserv_register()`, whose LDAP writeback can fail after the old record is gone. Fixed: `register_handle()` + the same field init, no directory step, no registered nick (also closes minor 6: `register_nick()` on a name another handle owns frees that owner's `nick_info`).
  3. Important — REBIND to a new id forgot the replaced id, so the documented use (re-bind ahead of the owner's login) made that login's earlier sessions reset the account. Fixed: REBIND keeps the replaced id like a reset. Test: REBIND case asserts the "Previous Keycloak ID" line.
  4. Important (ircd) — an alias's account-field update copied only the name; the alias kept the previous account's `acc_create`/`kc_id` and the next burst announced `newaccount:oldts:oldid`, which the reset rule would take for a recreated account. Fixed in `bounce_apply_alias_field`: take both from the primary when the alias now names the primary's account, clear both otherwise. Test: "an alias follows its primary to the new account with the new id" in `account-id-wire` (debug line on both servers).
  5. Minor — N(N-1)/2 clone-login warnings on re-attach: suppressed for the carried walk.
  Reviewer's notes kept as residue: the bouncer rebind gate's clause (c) `acc_ts_match` can no longer fire for SASL-authenticated ghosts (degrades to origin/sessid); `L` without a timestamp and the iauth account path leave a previous session value in place (pre-existing).
- Rulings: none against the spec; `nickserv_reset_handle` cannot fail any more (no NULL branch).
- **Final state 2026-09-24 18:56:** bed-deploy 5e281a4 = 028de05 + `fix/no-ircd-account-timestamp` 08ce54b + `fix/oauthbearer-introspection` (829a587, 56ac1c4) + `fix/alias-account-identity-follows` fc2511a (dormant) + `fix/pm-conversation-nick` (e1554fc, 1a0f3a4); x3 bed-x3-identity = master + #62 + `feature/keycloak-identity` (6 commits, tip 9e13f54). Green on these images: wire 3/3, keycloak-id-rebind 5/5, burst 1/1, accountinfo 1/1, account-timestamp 2/2, x3-account-change 2/2, sasl-reauth 4/4, oauth invalid-token 1/1, chathistory-targets-account-alt 1/1, targets-identity 2/2, targets-presence 1/1, targets-crowding 1/1 (identity suites rerun on the final ircd images 19:25: wire 3/3, rebind 5/5, burst 1/1, accountinfo 1/1, timestamp 2/2, account-change 2/2, sasl-reauth 4/4, invalid-token 1/1 — all green). Nothing pushed; testnet main uncommitted (tests, docs, register, plan, setup script).

## 2026-10-20 — the reset becomes a config option (user: "1 and 2", then 19:19-19:20)

Decided: default = adopt the id when none is stored; on a real mismatch REFUSE the bind
(like the timestamp check: return, nobody killed), log it and tell opers
(`NSMSG_IDENTITY_MISMATCH`), keep the stored id and the data. The switch
`keycloak_id_reset` (nickserv conf; docker `X3_KC_ID_RESET`, default 0) means "do not
refuse, remove the old": the bedb654 reset, still logging and telling opers. My first cut
(786c8aa) bound anyway on a mismatch; the user corrected it ("a real mismatch should refuse
on X3's part") → 3abfa4b. Tests `keycloak-id-rebind` and `keycloak-id-burst` parametrised
on `KC_ID_RESET=1` (the bed's volume conf is frozen and has no key, so the bed runs the
default; the reset path needs the key appended to the running conf + REHASH, or a fresh
volume). Red confirmed 19:15 on the old image (2 of 5 rebind cases). Not pushed: the PR
update is the user's call.
