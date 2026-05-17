# Step 4 — KILL semantics audit (invariant #12 verification)

Read against design intent invariant #12: *"Network KILL of any session connection ends the entire session. Aliases on other servers do not survive a KILL of the primary (or of any other session connection)."*

Three places to check: `exit_one_client` for primary, the alias-exit early-return branch, and `bounce_promote_alias` call sites.

## Surface

| location | what it handles |
|----------|-----------------|
| [s_misc.c:501–555](nefarious/ircd/s_misc.c#L501-L555) | Bouncer-aware exit logic for the session's primary. Branches on `hs_state` (HOLDING vs ACTIVE) and on `FLAG_KILLED`. |
| [s_misc.c:339–352](nefarious/ircd/s_misc.c#L339-L352) | `IsBouncerAlias` early-return: minimal cleanup, no session-destroy check. |
| [s_misc.c:361+](nefarious/ircd/s_misc.c#L361) | `IsBouncerHold` branch (held ghost), similar minimal cleanup. |
| [bouncer_session.c:2600+](nefarious/ircd/bouncer_session.c#L2600) | `bounce_promote_alias` — selects alias and promotes; no FLAG_KILLED awareness. |
| [m_kill.c:138–143](nefarious/ircd/m_kill.c#L138-L143) | Sets `FLAG_KILLED` on the victim before `exit_client_msg`. |

## Findings

### K1 — KILL of held ghost while aliases exist promotes instead of ending session

[s_misc.c:504–513](nefarious/ircd/s_misc.c#L504-L513):

```c
if (bsess->hs_state == BOUNCE_HOLDING) {
    if (t_active(&bsess->hs_hold_timer)) timer_del(&bsess->hs_hold_timer);
    if (bsess->hs_alias_count > 0) {
        /* Ghost exited externally (e.g., /KILL) while aliases exist.
         * Promote before we lose the ghost reference — promote needs
         * hs_client to remove ghost from channels silently. */
        bounce_promote_alias(bsess);
        ...
    } else {
        /* No aliases — destroy session */
        ...
    }
}
```

The `BOUNCE_HOLDING` branch does **not** check `FLAG_KILLED` before deciding to promote. The comment on line 508 even acknowledges that `/KILL` is one of the trigger paths — but proceeds with promote anyway.

**Per invariant #12, KILL of the held ghost should destroy the session and kill all aliases**, not promote one of them to primary.

Reachability: HOLDING + aliases is reachable when a server's local connections all dropped but aliases on other servers persist (netsplit scenario, or local server's primary dropped while remote aliases stayed). Then oper KILL hits the local held ghost. Currently → promote. Wrong.

### K2 — KILL of an alias does not end the session

[s_misc.c:339–352](nefarious/ircd/s_misc.c#L339-L352):

```c
if (IsBouncerAlias(bcptr)) {
    if (MyConnect(bcptr)) {
        if (IsIPChecked(bcptr)) IPcheck_disconnect(bcptr);
        Count_clientdisconnects(bcptr, UserStats);
    }
    if (MyUser(bcptr)) del_list_watch(bcptr);
    bounce_alias_untrack(bcptr);
    remove_user_from_all_channels(bcptr);
    RemoveYXXClient(cli_user(bcptr)->server, cli_yxx(bcptr));
    remove_client_from_list(bcptr);
    return;          /* ← returns early; never reaches the session-aware branch below */
}
```

The alias-exit branch does its cleanup (`bounce_alias_untrack` removes the alias from `hs_aliases[]`) and returns. **No `FLAG_KILLED` check, no session-destroy logic.**

Per invariant #12, KILL of an alias should end the entire session — kill the primary and any sibling aliases. Currently the alias just disappears and the rest of the session is untouched. Wrong.

### K3 — ACTIVE primary + FLAG_KILLED IS correctly handled

[s_misc.c:525–541](nefarious/ircd/s_misc.c#L525-L541):

```c
} else if (bsess->hs_state == BOUNCE_ACTIVE) {
    bsess->hs_client = NULL;
    if (HasFlag(bcptr, FLAG_KILLED)) {
        /* KILL: force-destroy session regardless of aliases */
        ...
        if (bsess->hs_alias_count > 0) {
            int i;
            for (i = bsess->hs_alias_count - 1; i >= 0; i--) {
                struct Client *alias = findNUser(bsess->hs_aliases[i].ba_numeric);
                if (alias) exit_client(alias, alias, &me, "Session killed");
            }
        }
        bounce_broadcast(bsess, 'X', NULL);
        bounce_destroy(bsess);
    }
    ...
}
```

This path does the right thing under invariant #12: detects `FLAG_KILLED`, exits all aliases, broadcasts BS X, destroys session. Comment is explicit ("KILL: force-destroy session regardless of aliases").

So **the code already understands invariant #12 in the ACTIVE-primary case**. The bug is that the same logic isn't applied in the HOLDING and alias-exit branches.

### K4 — FLAG_KILLED is overloaded between network-KILL and bouncer-internal silent-destroy

The flag carries two semantically distinct meanings in the codebase:

1. **Network KILL**: m_kill.c sets it before exit_client_msg. Per invariant #12, should end the session.
2. **Bouncer-internal silent-destroy marker**: `bounce_destroy_silent_held_ghost` (`bouncer_session.c:6281`), and the BX-C-in-place-conversion session-move retire path (`bouncer_session.c:5134`) both `SetFlag(ghost, FLAG_KILLED)` to suppress the Q broadcast that exit_one_client would otherwise emit on legacy peers. **This is bouncer-internal cleanup, not a network-KILL event.**

The `s_misc.c:527` check `if (HasFlag(bcptr, FLAG_KILLED))` cannot distinguish the two. **Currently this happens to work** because the bouncer-internal silent-destroy paths fire only on `IsBouncerHold` (held ghosts), and the HOLDING branch (K1) doesn't check FLAG_KILLED — so the bouncer-internal silent-destroys avoid hitting the active-killed path. But the conflation is fragile: any future use of `FLAG_KILLED` as a silent-destroy marker on an ACTIVE primary would unintentionally trigger session-destruction.

**Discriminating the two cases requires either**:
- Reserving a separate flag (`FLAG_BOUNCER_INTERNAL_DESTROY` or similar) for bouncer-internal cleanup, leaving `FLAG_KILLED` as the strict network-KILL signal.
- Inspecting the source/reason to infer which case applies — fragile, not recommended.

### K5 — `bounce_promote_alias` has no FLAG_KILLED awareness

[bouncer_session.c:2600+](nefarious/ircd/bouncer_session.c#L2600). The function picks an alias and promotes it unconditionally — it doesn't know whether the calling exit was a clean disconnect or a KILL. So even if K1 were fixed by adding a FLAG_KILLED check at the call site, the function itself is fine; it's the call sites that need to gate.

Note: this is actually correct API design — promotion is "the policy is that an alias takes over"; the policy decision belongs to the caller. The bug is in the caller.

## Bug fix surface (concrete and small)

The KILL-semantics violations are localized:

1. **K1 — HOLDING-with-aliases-and-FLAG_KILLED**. Add a `HasFlag(bcptr, FLAG_KILLED)` check in the HOLDING branch parallel to the ACTIVE branch's check. If set: skip promote, exit aliases, destroy session.
2. **K2 — KILL-of-alias**. Add a `HasFlag(bcptr, FLAG_KILLED)` check in the alias early-return branch. If set: locate the session, exit primary and sibling aliases, broadcast BS X, destroy session. (The alias's own `bounce_alias_untrack` would presumably still run as part of that teardown.)
3. **K4 — flag overloading**. Larger change. Either add a dedicated flag for bouncer-internal silent-destroy or audit every `SetFlag(*, FLAG_KILLED)` outside m_kill.c and document the conflation as intentional. Recommended path: dedicated flag, gated only at the bouncer-cleanup paths, with `FLAG_KILLED` reserved for actual network KILL events.

K1 and K2 are small, well-bounded fixes that shouldn't interact with the larger persistence/reconciliation redesign — they're orthogonal to cluster B's restructuring. Could land independently.

K4 is a refactor that's worth doing alongside any other significant cleanup of the bouncer system, since it touches multiple FLAG_KILLED uses.

## Cross-cluster integration note

These findings interact with the cluster B observations on `bounce_destroy_yielded_ghost` and `bounce_destroy_silent_held_ghost`:

- `bounce_destroy_yielded_ghost`: exits ghost via `exit_client(...)`, no FLAG_KILLED set → standard Q broadcast. **Fine under invariant #12** because no FLAG_KILLED means "not a KILL," so session-destruction logic isn't triggered.
- `bounce_destroy_silent_held_ghost`: SetFlag(ghost, FLAG_KILLED) + exit_client. Under K4, this is the conflation case — looks like a KILL to s_misc.c logic. Under K1, the HOLDING branch ignores FLAG_KILLED, so the cluster-B silent-destroy currently dodges accidental session-destruction. Fragile.

If K1 is fixed (add FLAG_KILLED check in HOLDING branch), then `bounce_destroy_silent_held_ghost`'s SetFlag(FLAG_KILLED) would suddenly trigger session destruction — **regression risk**. The fix needs to happen alongside K4 (separate flag for bouncer-internal silent destroy), or the silent-destroy path needs to be reworked to not rely on FLAG_KILLED.

Step 5 should land K4 first (semantic separation of flags), then K1 and K2 (proper invariant-#12 enforcement). Order matters.
