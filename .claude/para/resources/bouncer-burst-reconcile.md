# Bouncer session reconciliation across server burst

## Problem

`bounce_db_restore()` creates a ghost `Client*` for every persisted
session at boot, before any S2S link forms.  Each server in the network
independently does this from its own MDBX store.  When a previously-
linked pair of servers boot and re-establish their link, they each
have a ghost for the same `BouncerSession` (often with the same nick,
account, and host), and burst N-token introductions trigger nick
collision resolution.  The "Same user@host" branch kills one ghost,
and the survivor's session state diverges from the network's view.

Concrete symptom (production trace 2026-05-01):
```
04:34:54 Notice -- Net junction: testnet leaf
04:34:54 Notice -- Nick collision on ibutsu (ibutsu 1777611153
                   <- leaf 1777624492 (Same user@host))
04:34:54 Closing Link: ibutsu by testnet (Killed (... (nick collision)))
```

After the kill, BX C state on the surviving side references a primary
numeric (`ACAAA`) that no longer corresponds to any local Client; BX M
echo to that primary then fails `findNUser` and silently drops.

## Existing notes pointing at this

- [project_bouncer_burst_desync.md](.claude/projects/-home-ibutsu-testnet/memory/project_bouncer_burst_desync.md):
  "Pre-existing burst-vs-MDBX-restore race causes BX C to reference
  primary the leaf hasn't seen yet; alias mirroring breaks. Defer until
  IRCv3 framework done."  IRCv3 framework is now done; this plan is
  the deferred fix.
- `bounce_db_restore` comment chain: "creates ghosts with NO validation
  of account existence, bans, or channel state. Needs deferred
  validation pass after server link is established."

## Design

### High-level rule

After link establishment, if both ends have a ghost for the same
`hs_sessid`, exactly one survives.  Tiebreaker: most-recent
`hs_last_active`.  Loser destroys its ghost silently (no QUIT
broadcast — the network never saw the loser as a real user since
collision resolution would have killed it on the next message
anyway).

Aliases co-exist as long as their primary references converge —
that's just normal multi-connection bouncer state and doesn't need
reconciliation beyond rebinding an alias's `alias_primary` pointer
to the surviving primary.

### Wire format

New BX subcommand `R` (Reconcile):

```
BX R <ghost_numeric> <sessid> <last_active_seconds> <role>
```

- `<ghost_numeric>` — local YYXXX of the restored ghost
- `<sessid>` — `<server>-<seq>` session identifier (matches across
  the network)
- `<last_active_seconds>` — `hs_last_active` epoch seconds
- `<role>` — `P` (primary) or `A` (alias of someone else's primary)

### Burst integration

Each restored session is tagged with `hs_restore_pending = 1` in
`bounce_db_restore` so we know which ones haven't been reconciled
yet.

After EOB (end-of-burst) is acknowledged on a link, walk all
sessions with `hs_restore_pending` set; for each, emit `BX R`
toward the newly-linked peer.

If the link is part of a multi-link burst (rare during normal
operation but happens on initial join), repeat the reconcile pass
once per link.

### Receiver logic

```
on BX R <ghost_num> <sessid> <last_active> <role>:
  remote_session = lookup_by_sessid(sessid)
  if !remote_session:
    /* Their session, we have no record of it.  Just track their
     * announcement; if a local user later connects with this
     * sessid via account, normal alias-attach handles it. */
    return

  if remote_session.hs_restore_pending:
    /* Their ghost is also tentative.  Compare last_active. */
    if their last_active > our last_active:
      destroy our ghost silently
      our session.hs_client = NULL  /* will populate via BX C */
      our session.hs_restore_pending = 0  /* reconciled */
    else if their last_active < our last_active:
      /* Wait for them to receive our BX R and yield. */
      no-op locally
    else:
      /* Tied — deterministic by ghost numeric (lexicographic). */
      if their numeric < our numeric:
        destroy our ghost silently
        ...

  else:
    /* Their session is already firm (active client attached or
     * already reconciled). They win unconditionally. */
    destroy our ghost silently
    ...

  forward BX R unchanged for non-leaf path
```

After reconciliation completes (no opposing entries remain), clear
`hs_restore_pending` on both sides.

### Silent ghost destruction

The existing `exit_one_client` on a ghost emits QUIT broadcasts.
For reconciliation we want NO network notice — both sides agree to
yield, and the user-visible state ends up right.  Add a helper:

```c
void bounce_destroy_ghost_silent(struct BouncerSession *session)
{
    struct Client *ghost = session->hs_client;
    if (!ghost || !MyConnect(ghost) || !IsBouncerHold(ghost))
        return;
    /* Detach ghost from session before exit so exit_one_client
     * doesn't try to revive or emit hold-related state. */
    session->hs_client = NULL;
    SetFlag(ghost, FLAG_KILLED);  /* suppress S2S quit */
    exit_client(ghost, ghost, &me, "Bouncer ghost reconciled");
}
```

`FLAG_KILLED` is the same suppression pattern `bounce_initiate_transfer`
uses to silence S2S quit (per project memory).

### Session continuity on the loser

After ghost destruction, the loser's session record:
- Keeps `hs_account`, `hs_sessid`, `hs_token`, `hs_last_active` etc.
- Has `hs_client = NULL` (no local ghost)
- Has `hs_state = BOUNCE_HOLDING` still
- Loses its channel memberships locally

When the user reconnects to the loser server, `bounce_setup_local_alias`
finds the session by account, sees `hs_client` references a remote
primary (from the winner's BX C broadcast), and creates a local alias
in the normal flow.  Channel state replays from the winner via existing
`bounce_send_channel_state` after attach.

## Edge cases

### Both sides have role=alias (no primary)

If two servers both restored aliases of a primary that was on a
third server, and the third server hasn't linked yet: both keep
their ghosts, no destruction.  When the third server links and
announces its primary via BX C, both aliases re-bind their
`alias_primary` to the announced primary.

### Hold timer

The loser's ghost gets exit'd by `bounce_destroy_ghost_silent`,
but the session record stays.  Its existing hold timer continues
to count down based on persisted `hs_disconnect_time`.  If the
session expires before the user reconnects, normal expiry path
removes the session record on both sides.

### Reconcile token loss

If `BX R` is dropped (link drop mid-reconcile), the loser keeps
`hs_restore_pending = 1` and the ghost stays.  Next link
establishment re-runs reconciliation.  No permanent stuck state.

### Race with active reconnection

User reconnects to the loser between restore and reconcile:
1. User connects, sees ghost → bounce_revive transplants socket.
2. `hs_restore_pending` is still 1 but ghost is now an active client.
3. BX R arrives from peer.
4. Receiver sees `hs_restore_pending` cleared (we should clear it on
   any client revive/attach), so treats theirs as the loser and
   destroys their ghost — correct: our user is now active.

So `bounce_revive` and `bounce_attach` both clear
`hs_restore_pending`.

### Cross-version compatibility

Old servers that don't know `BX R` hit `bounce_handle_bt`'s default
case: forward unknown subcommand without local processing.  Old
server's ghost stays and old collision logic still kills one of
them — same as today.  Reconcile only takes effect when both ends
speak the new token.  No regression.

## Implementation slices

1. **Add `hs_restore_pending` field** + set in `bounce_db_restore`
   + clear in `bounce_revive` and `bounce_attach`.
2. **`bounce_destroy_ghost_silent` helper**.
3. **`BX R` send hook** on EOB-completion path.  Walk
   `as_sessions` for restore-pending entries.
4. **`bounce_reconcile_session` handler** + dispatch case 'R' in
   `bounce_handle_bt`.
5. **Forwarding** for non-leaf path (mirror BX E forward shape).
6. **Test**: shutdown both servers with a held session, restart
   with leaf restored slightly later than testnet, verify only one
   ghost survives and aliases re-bind correctly.

## Out of scope

- **Cross-version interop**: documented above, not actively
  pursued.  If old-version peers persist on the network, manual
  cleanup remains.
- **Lazy ghost restoration** (don't restore at all until
  reconnect): a different design.  Pros: no collision possible.
  Cons: network sees user as gone during hold window — channel
  membership continuity lost.  Reconcile-on-burst keeps continuity
  while resolving conflicts, so we go with that.
- **Origin-server-only restore** (only the sessid-prefix-matching
  server restores ghost, others only metadata): considered, but
  fragile when origin is offline at burst time.  Reconcile keeps
  both ends self-sufficient.
