# Bouncer: same-account session merge on link discovery

## Problem

When two BX-aware servers each hold a primary for the same account, with
different nicks, the existing convergence paths don't merge them.  Both
sides end up holding parallel primaries; legacy peers see only the first
one due to account-keyed legacy_face suppression; the second user is
silently invisible to legacy.

## How we got here (the trigger this round)

1. ibutsu on testnet, nick was changed to "ibutsu_" (cross-server, via
   leaf's alias)
2. testnet SIGSEGV'd mid-rename (set_nick_name's MyUser block deref'd
   cli_user(cptr) where cptr was the server link, not the user — fixed in
   [project_set_nick_name_cptr_sptr_alias_crash](../../.claude/projects/-home-ibutsu-testnet/memory/project_set_nick_name_cptr_sptr_alias_crash.md))
3. testnet restarted; MDBX-restored session record reflected pre-rename
   state (nick "ibutsu") because the rename hadn't committed to the
   persisted record before the crash
4. leaf still locally held its post-rename state (nick "ibutsu_")
5. On link-up: leaf bursts ACAAA as plain N for "ibutsu_" account=ibutsu;
   testnet has local BjAAA "ibutsu" account=ibutsu
6. SeekClient("ibutsu_") on testnet returns NULL → no nick collision →
   D.2 at-N-time split-merge in m_nick doesn't fire
7. Both end up as primaries of session AZ4o (BS C cross-sessid converged
   the sessid but not the clients)
8. server_finish_burst to legacy upstream: BjAAA "ibutsu" emitted first,
   records legacy_face (account=ibutsu, peer=upstream); ACAAA "ibutsu_"
   second-iterated, face lookup hits, **suppressed silently**

The crash + restart was the proximate cause this round; in general,
*any* split-or-relink where each side holds a primary for the same
account is the same shape of bug.

## Why the existing convergence paths miss this

| Path | What it does | Why it misses |
|------|--------------|---------------|
| BS C cross-sessid convergence ([bouncer_session.c:3385+](../../nefarious/ircd/bouncer_session.c#L3385)) | Renames local sessid to peer's if peer's is lex-lower | Only touches the BouncerSession struct; doesn't look at hs_client on either side, doesn't initiate any Client demote |
| D.2 at-N-time split-merge ([m_nick.c:553+](../../nefarious/ircd/m_nick.c#L553)) | Same-account two-primary deterministic demote | Only fires inside the collision branch of m_nick (post-SeekClient hit). Two primaries with **different** nicks never collide → never reaches D.2 |
| Same-account override ([m_nick.c:785+](../../nefarious/ircd/m_nick.c#L785)) | Flips differ=1 (older-wins) for legacy-peer same-account collisions | Same — gated on collision path |

The gap: nicks differ → no SeekClient hit → m_nick's collision branch
never enters → no merge is even attempted.

## Fix shape

Add merge logic at the BS C cross-sessid convergence site (or in a
sibling block at the same point in the BS C handler).  When peer's BS C
carries `(account=A, sessid=S')`, we have local session
`(account=A, sessid=S, hs_client=local_C)`, and peer's burst either
already introduced or is about to introduce a Client `peer_C` for the
same account on its side:

1. Compute the deterministic tiebreaker for which primary slot one
   client takes.  Use **older lastnick wins** — same rule the existing
   same-account-override at m_nick.c:785 uses for legacy-peer cases.
   Tie: lex-on-numeric (same as D.2's existing tiebreaker).

2. If local primary wins the slot: nothing local-side to demote.  Peer
   will reach the symmetric verdict and demote on its side via the same
   logic firing there (deterministic — same inputs both sides).

3. If local primary loses the slot: demote it via
   `bounce_session_transition(BST_DEMOTE_TO_ALIAS)`, with
   `peer_primary = peer_C`.  Same path D.2 uses on collision.
   - Local Client's nick becomes peer's nick (alias-inherits-primary)
   - Local Client gets IsBouncerAlias flag
   - Channels mirror to alias via CHFL_ALIAS
   - BX C emitted so peers know about the new alias

4. After merge, only one of the two is `!IsBouncerAlias`, so the
   legacy_face suppression at server_finish_burst is no longer hiding
   the second client — it correctly emits the single N for the surviving
   primary.

## Resolving peer_C

In BS C the message carries account, sessid, and channel list, but
**not directly** the primary's numeric.  Need to determine peer_C:

- BS C from a peer who holds a HOLDING ghost: peer_C is the ghost
  (already introduced via N earlier in burst, or by a BX C in the same
  burst, depending on origin server's view)
- BS C from a peer with an ACTIVE primary: peer_C is the primary the
  peer introduced via N in the burst

Approach: look up by `(account, source server's downlink)` after the
burst's N's have arrived.  The BS C convergence runs after burst-emit's
N loop for a server-to-server link, but the **inbound** order isn't
guaranteed.  Two options:

- **A.** Defer the merge: stash a "merge-needed" marker on the local
  session when BS C arrives with a colliding-account-different-sessid;
  re-check at burst-end (EB) when all peer N's are in the hash.
- **B.** Eager: search the client list for `cli_account == account &&
  cli_from == sptr` (the peer that sent BS C) at BS C time.  Race risk
  if peer's N hasn't been processed yet.

Prefer **A**: deterministic, no race.  Bouncer code already has a
"settle after burst" mechanism via the burst gate; we can hook into
that to run a post-burst reconcile sweep that finds these cases and
merges them.

## What "same session" means (gating the merge)

The merge fires only when **both** clients are bouncer-bound to the
same logical session.  Two same-account clients where at least one is
NOT bouncer-bound are a legitimate independent-presence state and must
NOT be merged.

A client is bouncer-bound when:
- It came in on a bouncer-class port (CRFLAG_BOUNCER), or
- Its account metadata `bouncer/hold` is set non-zero (or default-hold
  is enabled and no explicit opt-out), AND
- It has a `cli_session_id` matching a `BouncerSession` whose
  `hs_client` or `hs_aliases[]` includes it

Detection rule for the merge: pick clients with non-NULL
`bounce_get_session(client)` that resolves to the **same** session
struct (sessid-equal post-cross-sessid-convergence).  Don't merge based
on account alone.

## Parallel fix: tighten legacy_face suppression scope

The legacy_face suppression at [s_serv.c:369-370](../../nefarious/ircd/s_serv.c#L369-L370)
currently uses `bounce_account_legacy_face_for(account, peer)` which
walks **all** sessions for the account and matches any face.  Two
bugs fall out:

1. **Account-keyed conflation**: if account "ibutsu" has a bouncer
   session AND a non-bouncer account-bearing client, the non-bouncer
   client gets suppressed even though it's independent — face was
   recorded for the bouncer client.
2. **Multi-session-per-account future-incompatibility**: when
   `(account, sessid)` keying arrives, this account-walk has to change
   anyway.

Tighten the check: lookup the iterated client's own session; if it
has no session (non-bouncer), don't suppress.  If it has a session,
check **that session's** face record only.  Replace the call site:

```c
/* Before — account-keyed, conflates non-bouncer same-account */
if (bounce_account_legacy_face_for(cli_account(acptr), cli_yxx(cptr)))
  continue;

/* After — session-keyed, only suppresses bouncer-bound co-session */
{
  struct BouncerSession *bs = bounce_get_session(acptr);
  if (bs && bounce_session_legacy_face_for(bs, cli_yxx(cptr)))
    continue;
}
```

After this:
- Bouncer-bound BjAAA emitted first, face recorded on session AZ4o
- Bouncer-bound co-session ACAAA iterated, finds face on AZ4o → suppressed (correct — they're the same session, only one face wanted)
- Non-bouncer same-account client iterated, `bs == NULL` → not suppressed → its own N goes out (correct — it's a separate presence)

This fix is required regardless of the merge work.  Even after merge
lands, the legacy_face check should be session-keyed; the merge just
ensures that within a single session there's never more than one
`!IsBouncerAlias` client to begin with.

## Non-goals (this fix)

- Multi-session-per-account semantics ([project_bouncer_multi_session_neutral](../../.claude/projects/-home-ibutsu-testnet/memory/project_bouncer_multi_session_neutral.md)).
  Within a single session, the merge collapses two primaries into one
  session (primary + alias).  Two different sessions for the same
  account (including bouncer + non-bouncer mix) are left independent.
  When multi-session-per-account arrives, the same merge rule applies
  per-session; nothing changes here.

- Repairing MDBX rename persistence so this doesn't happen post-crash.
  Worth doing separately as a preventive measure, but the reactive
  merge fix handles arbitrary post-split rejoin too, not just the
  post-crash variant.

- Two unrelated chat presences on the same account where at least one
  is non-bouncer.  Those legitimately stay as independent users.  The
  legacy_face suppression fix above ensures both reach legacy peers.

## Open questions

1. Should the merge fire for **legacy** peers too (BS C from legacy is
   impossible — they don't speak BX — but the N-introduction of two
   primaries from a legacy peer's relayed burst could leave the same
   shape behind)?  Probably yes; treat the post-burst reconcile sweep
   as triggered by EB arrival regardless of peer flavor.

2. What about more than two primaries?  If three servers each hold a
   primary for the same account, the reconcile should pick one and
   demote the other two.  Same older-wins rule iterated.

3. Aliases of the demoted-side already linked: when we demote local
   primary to alias, what happens to clients that were already aliases
   of that primary?  They should now be aliases of the new primary
   (transitively re-linked).  Need to walk hs_aliases[] and re-point.

## Implementation outline

- Add `bounce_post_burst_reconcile(struct Client *peer)` called from
  the EB receive path on the peer's link (or at burst-gate-release for
  legacy peers)
- Walk local sessions; for each session, collect all clients whose
  `bounce_get_session(c) == this_session` AND `!IsBouncerAlias(c)`.
  Non-bouncer same-account clients are filtered out by the session
  check.  If the resulting set has >1, run the older-lastnick
  tiebreaker, demote the non-primary-slot clients via
  `bounce_session_transition(BST_DEMOTE_TO_ALIAS)`
- BST_DEMOTE_TO_ALIAS already handles the channel/BX C emit/etc. —
  reuse it
- Test path: contrived scenario where two servers link with each
  holding an account-bearing primary; expect one to flip to alias
  after EB, exactly one face on legacy peer

## Risks

- Demoting a local primary causes a NICK rename for the user (alias
  inherits primary nick).  Users will see a NICK event.  Documented
  consequence of the one-session-per-account model.
- Channel state mirroring: alias gets CHFL_ALIAS membership.  Need to
  verify scrollback / chathistory routes correctly through the new
  primary, not the demoted side.
- BX C emit for the new alias needs ordering against peer's own
  symmetric demote — both sides will emit BX C for their respective
  demoted clients.  Each side's BX C should be idempotent on receipt.
  Existing BX C handler tolerates idempotent re-creation; verify.

## Status

- 2026-05-14: plan written, awaiting approval before implementation
- 2026-05-14: approved (`do both, in whichever order you prefer`) — implemented
  - legacy_face suppression tightened to session-keyed at [s_serv.c:368-388](../../nefarious/ircd/s_serv.c#L368-L388) (uses `bounce_session_legacy_face_for` on the iterated client's own session; non-bouncer same-account clients are correctly not suppressed)
  - `bounce_post_burst_reconcile()` added at [bouncer_session.c:1310](../../nefarious/ircd/bouncer_session.c#L1310); declared in [bouncer_session.h:483](../../nefarious/include/bouncer_session.h#L483)
  - wired into ms_end_of_burst at [m_endburst.c:163](../../nefarious/ircd/m_endburst.c#L163) (runs after `bounce_prune_stale_aliases` so we operate on the post-burst stable state)
- Awaiting rebuild + repro to verify behavior
