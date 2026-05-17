# Bouncer Session State Transition Funnel

The audit (`.claude/plans/bouncer-audit-*.md`, design intent, persistence
redesign) called for a single owner of session state transitions.  The
phased work that followed (sessid scheme, persistence, BX R/F/J
retirement, D.2 tiebreaker, frontier introducer) implemented the named
deliverables but did **not** unify the entry points.  Every path that
modifies a session continues to mutate `session->hs_client`,
`hs_aliases[]`, and `hs_state` directly, and they disagree on what the
state means after they run.  That's the structural source of the
recurring "both sides became aliases" / "primary doesn't know about its
alias" / "session points at destroyed Client" failures.

This file is the audit + funnel design + conversion plan.  Not the
named-Phase-implementation tail; this is the rewrite the redesign
documents pointed at and never landed.

## Invariant the funnel must enforce

For any `BouncerSession *S`:

  - **Exactly one canonical primary.**  Either `S->hs_client` points to
    a non-NULL Client `P` with `IsUser(P) && !IsBouncerAlias(P)`, OR
    `S->hs_state == BOUNCE_HOLDING` and `S->hs_client` is a Client with
    `IsBouncerHold(P)` (the held ghost), OR `S` is mid-transition and
    `S->hs_client == NULL` for the duration of one funnel call.
  - **No alias has `IsBouncerPrimary` set.**  Every member of
    `S->hs_aliases[]` resolves to a Client `A` with `IsBouncerAlias(A)`
    AND `cli_alias_primary(A) == S->hs_client` (or NULL during
    transition).
  - **Deterministic primary selection.**  When multiple candidates
    contend (revive race, split-brain, post-promote), the funnel picks
    via D.2 (older `cli_firsttime` wins, lex on numeric on tie) — the
    same rule on every server, so each side reaches the same answer.
  - **Single wire signal per transition.**  The funnel emits the
    canonical wire (BX C / BX P / BX X / Q-to-legacy / N-to-frontier)
    for the kind of transition that ran, no per-call-site emit.
  - **Persistence reflects post-transition state.**  Funnel calls
    `bounce_db_put()` after applying, so MDBX never holds a state that
    didn't pass the invariant check.

## Funnel API

```c
enum bounce_transition_kind {
    BST_REVIVE,            /* held ghost -> live primary (this server) */
    BST_ATTACH_LOCAL_ALIAS,/* attach a fresh local connection as alias of existing primary */
    BST_DEMOTE_TO_ALIAS,   /* live local primary -> alias of remote primary */
    BST_REBIND_TO_REMOTE,  /* held ghost -> remote-alias replica (peer's primary takes over) */
    BST_PROMOTE_ALIAS,     /* local alias -> primary (on local primary exit) */
    BST_RECEIVE_REMOTE_PRIMARY, /* peer's BS A says peer holds primary; replicate locally */
    BST_DESTROY,           /* end-of-session (kill, hold-expiry, BX X) */
};

struct bounce_transition_params {
    struct Client *new_primary;     /* for REVIVE/PROMOTE/REBIND/RECEIVE: the Client to install */
    struct Client *demoted_alias;   /* for DEMOTE/REBIND: the Client to flip to alias */
    struct Client *peer_primary;    /* for DEMOTE/REBIND: the remote primary we're aliasing toward */
    const char *reason;             /* for DESTROY: free-text */
};

/* Apply a transition.  Asserts the invariant before and after.
 * Returns 0 on success, negative on rejection.  Emits wire signals
 * per kind.  Persists if FEAT_BOUNCER_PERSIST. */
int bounce_session_transition(struct BouncerSession *session,
                              enum bounce_transition_kind kind,
                              struct bounce_transition_params *params);
```

## Audit: existing mutation sites

### `session->hs_client = ...` writes (bouncer_session.c)

| Line | Caller / context | Current kind |
|------|------------------|--------------|
| 629 | `bounce_alias_untrack` cleanup | (alias removal — no kind, this is fine) |
| 826 | `bounce_auto_resume` ghost-numeric resolve | RECEIVE_REMOTE_PRIMARY |
| 1033 | `bounce_attach` for new session | REVIVE-equivalent (fresh) |
| 1202 | second `bounce_attach` path | REVIVE |
| 1288 | session-create from BS C | (replica creation — no live primary yet) |
| 2115 | BS C handler reconcile-yield path | REBIND_TO_REMOTE |
| 2756 | BS C reconcile drop-stale-ghost | REBIND_TO_REMOTE |
| 2835 | BS C "Create session from remote data" | (replica creation) |
| 2928 | BS A primary-numeric resolve | RECEIVE_REMOTE_PRIMARY |
| 3030 | `bounce_attach` (third path?) | REVIVE |
| 3330 | `bounce_promote_alias` | PROMOTE_ALIAS |
| 3438 | demote-mid-promote cleanup | (intermediate, suspect) |
| 3468 | demote-mid-promote cleanup | (intermediate, suspect) |
| 3936 | `bounce_create_ghost` from MDBX | (restore — pre-funnel state) |
| 4173 | `bounce_revive` | REVIVE |
| 4272 | `bounce_demote_live_primary_to_alias` (NULL pending finish) | DEMOTE_TO_ALIAS |
| 4306 | `bounce_finish_live_primary_demote` (set new primary) | DEMOTE_TO_ALIAS continuation |
| 5141 | nick-change re-resolve | RECEIVE_REMOTE_PRIMARY |
| 7035 | another nick-change site | RECEIVE_REMOTE_PRIMARY |
| 7069 | iteration helper, not mutation? | (verify) |
| 7155 | SQUIT cleanup | DESTROY |

**Note**: at least three of these (lines 4272 + 4306, plus the demote-
mid-promote pair at 3438+3468) split a single transition across two
mutation points with the session in an intermediate inconsistent state
between them.  Funnel must either combine into one atomic call or
explicitly mark the intermediate as "transitioning."

### `hs_aliases[]` write sites

  - `bounce_alias_untrack` (cleanup on alias exit)
  - BX C handler tracking block (line ~5645) — fixed cross-sessid race today
  - Burst replay in `bounce_burst` (line ~2177)
  - Demote (line ~4275) — adds local Client to roster on flip-to-alias

### `hs_state` write sites

  - HOLDING -> ACTIVE transitions (revive, promote)
  - ACTIVE -> HOLDING transitions (primary disconnect with hold)
  - Any state -> DESTROYING (transient before bounce_destroy)

## Conversion priority

Order matters — convert the **most-state-coupled** paths first so each
new caller of the funnel forces invariant compliance, exposing latent
bugs in the still-unconverted paths:

1. **`bounce_revive`** → BST_REVIVE.  Single most-touched transition;
   every reconnect runs through it.
2. **`bounce_demote_live_primary_to_alias` + `bounce_finish_live_primary_demote`**
   → fold into one BST_DEMOTE_TO_ALIAS call.  The split is a known
   mid-transition hazard.
3. **`bounce_setup_local_alias`** → BST_ATTACH_LOCAL_ALIAS.
4. **`bounce_promote_alias`** → BST_PROMOTE_ALIAS.
5. **`bounce_rebind` (held-ghost → remote primary)** → BST_REBIND_TO_REMOTE.
6. **BS A handler `hs_client = primary` writes** → BST_RECEIVE_REMOTE_PRIMARY.
7. **Destroy paths** → BST_DESTROY.

After all conversions: delete the direct-mutation lines, add an
`assert_session_invariant(s)` at the funnel entry/exit.

## What's NOT in scope here

  - The UUID v7 sessid scheme, BS A/BS C cross-sessid rename, BX R/F/J
    retirement, D.2 tiebreaker, frontier introducer — those are done.
  - Verification harness — Phase 6 territory.
  - The legacy-peer mesh problem at the network level — addressed
    separately by the frontier mechanism, not by the funnel.

The funnel is purely about making the in-process state machine
self-consistent so the redesign's stated invariants actually hold at
runtime instead of being approximated by patches at each call site.
