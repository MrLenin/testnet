# Bouncer-analyst pass: webhook plan 4, Task 1 (local-only deauth walk, D2)

Read-only analysis by the bouncer-analyst agent, 2026-09-24, over the worktree at 32e3664. Nothing edited or run. Line numbers refer to that tree.

## Verdict

D2 (SKIP a remote client in the deauth classifier) keeps invariant 12 provided every server applies the event, which is the plan's premise (direct delivery, relay, catch-up). The classifier change is safe and, once D1 fans the SPI out to every ircd, mandatory: with today's remote walk and two receivers every remote client gets two `AC <c> U`, and the second hits `!IsAccount` in the receiver (`m_account.c:172-174`) and raises a DESYNCH wallops for every client of every event (H7). The walk around the classifier needs three additions, one of them (H1) a real regression for exactly the clients invariant 12 covers.

## Facts the rulings rest on

- `bounce_account_deauth_apply` (`bouncer_session.c:6783-6859`) emits `BX U <alias> account=` for every session of the account to all servers, destroys every session of the account locally with plain `bounce_destroy`, clears only `acptr`, and returns 1 only for a local held ghost.
- AC U receiver (`m_account.c:171-215`): `!IsAccount` is a protocol violation; relays AC U; exits its own ghost.
- BX U account receiver (`bouncer_session.c:8835-8870`): string and flag only, idempotent, consults no session; an unknown numeric is deferred and forwarded.
- The hold flag is local-only: a remote replica of a ghost never has `is_hold`.
- Aliases copy the primary's `kc_id` at creation; DB-restored ghosts and X3/LOC logins carry no id.
- Reconcile gates require `IsAccount` and an account match: a deauthed former primary is never merged back.

## Answers

1. Invariant 12 holds with a local-only walk: only the primary's home server emits the account-level clear (BX U to aliases everywhere, AC U to everyone); a split peer promotes the alias it owns and acts on its own delivery or the catch-up. The catch-up runs after the post-burst reconcile, the right order.
2. A local primary's body emits `BX U <alias> account=` per alias unconditionally; the alias's home applies it whether or not it applied the event; a second clear is idempotent; no ordering hazard.
3. A held ghost on a remote server is torn down by its home server's own application; the window equals today's AC U latency on a linked network; a revive in the window self-heals; a split beyond the window is the D7 residue.
4. Two servers acting in the same second are safe; under KILL the switches must be uniform network-wide because a session's fate now depends on the switch on the primary's server.
5. Name-only clients (X3-authenticated, DB-restored ghosts) are reached today through a name resolved on the receiving server and walked network-wide; under D2 the receiver that owns them must learn the name: H1.
6. Nothing beyond SKIP-remote in the classifier; in the walk: H1, H2, and name resolution kept global.

## Hazards

- **H1, blocking for Task 4.** `cache_invalidate_subject` relays only the payload username (`*` for every real USER event) and runs before `subject_account_names`, so the names a server resolves from its cache or from replicas never reach the wire. Scenario: a user logged in through Keycloak SASL on A (cache entry) and later left; a DB-restored held ghost of the same account sits on B (name only). A delete relays `CI * <id> <event> D`; B has no cache entry and no id-carrying replica; the ghost keeps its account until hold expiry. Today A walks by the dropped name and B exits the ghost. Fix: resolve names fully (payload, cache-dropped, every client carrying the id, local or remote) before relaying; the relay's name slot carries the list comma-joined (at most `WH_SUBJECT_MAX_NAMES`); the receiver walks each name and keeps its own resolution global; the log entry holds the list. Test: an X3-authenticated client on the leaf, a SASL login and logout of the same account on the primary, a real-shaped id-only event posted to the primary; the leaf client must lose its account.
- **H2, KILL path, narrow.** A sibling session's AC U destroys the local session record before the local kill pass, so `bounce_get_session` is NULL in Pass 2 and the killed primary's remote aliases are not exited. Fix: when a KILL_SOCKET primary has no session, exit every client whose `cli_alias_primary` is that primary, with the same primitive `bounce_kill_session` uses (an alias exit is BX X, not a KILL, so B-2 does not apply). Today no remote session is killed at all, so this is a partial improvement with a new inconsistency, not a regression.
- **H3, safe.** An accounted client with no session between a sibling's AC U and its own application: a QUIT in the window is a plain exit.
- **H4, mixed rollout only.** A held ghost on a pre-plan-4 server is stranded forever (its session destroyed by a new server's AC U, its hold timer deleted, and the old `ms_cacheinval` never walks). The cost of decision 1's "no switch"; lockstep deploy avoids it.
- **H5, Task 5.** The catch-up replays a disable that a later enable superseded: a server split for both relinks, receives X then E oldest-first, and deauths the re-enabled user's sessions. Fix: per-subject compaction on the sender (an E supersedes earlier X of the same subject, sent as purge-only; D is never superseded); the receiver may apply the same rule inside one batch.
- **H6, self-heals.** Relink after a split where only one side applied: classic TS collision may KILL, the catch-up deauths whatever survived; the user sees a KILL instead of a NOTICE. Plan 4 strictly improves this.
- **H7.** D2 is required once D1 fans out (see the verdict).
- **H8, H9, safe.** Ghost revive races and same-second races.

## Recommended classifier rule

```c
  if (s->is_alias)
    return (do_kill && s->is_local) ? BOUNCE_DEAUTH_KILL_SOCKET : BOUNCE_DEAUTH_SKIP;
  /* A remote client's socket is never ours (B-2); its ACCOUNT is now its
   * home server's job too, reached by the direct delivery, the relay or
   * the catch-up.  remote_ok restores the network-wide clear (rollout). */
  if (!s->is_local)
    return s->remote_ok ? BOUNCE_DEAUTH_CLEAR_ACCOUNT : BOUNCE_DEAUTH_SKIP;
  if (s->is_hold)
    return BOUNCE_DEAUTH_DESTROY_SESSION;
  return do_kill ? BOUNCE_DEAUTH_KILL_SOCKET : BOUNCE_DEAUTH_CLEAR_ACCOUNT;
```

Locality in the classifier gates the action only; name resolution in the walk stays global.

## What the tasks add

- Task 3: the `remote_ok` field and rule; `test_remote_client_is_deauthed_never_killed` sets `remote_ok = 1`; the H2 Pass-2 fallback.
- Task 4: H1 (resolve before relaying, relay the list, receiver walks each name, global resolution, the log holds the list); a doc note that KILL switches must be uniform and that KILL now disconnects sockets on every server; a bed case for H1; the cross-server deauth suite's first two cases now depend on the relay (same observables).
- Task 5: H5 compaction and its cmocka test.

## Open questions

- Whether `webhook_subject_resolve` sets `username` for a real disable (a console save representation); determines how often a relay would be nameless without H1.
- Confirm on the bed that a hub-relayed `AC R` carries the fifth parameter so replicas hold `kc_id`; the global-scan resolution on the receiver relies on it.
- H2's reproduction needs two profiles plus an alias on a third server; otherwise a known KILL residue in the register.
