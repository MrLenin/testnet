# Bouncer session server notice mask across servers (2026-10-21)

Status: SHIPPED 2026-10-21 -- upgrade 512812e + ce56879, hardening be4a437 + 323433f (both remotes); bed ircd.202610212254, bed-deploy 9074e3b. Audited by bouncer-analyst; see "As built". Builds on branch `fix/session-snomask` (nefarious worktree
`scratchpad/nef-sno` of session abbfdfe7, off `ircv3.2-upgrade` 578e7b9), which already fixes
the alias 008 reply (s_user.c set_user_mode) and the held/revived mask (hs_snomask saved at hold,
restored at revive, persisted in DB v11, used by the oper grant). User rule (2026-10-21): wherever
the bouncer gives a manually opered user +o back, their own mask comes back with it.

## What is broken (bed-reproduced)

A remote alias of an opered session gets +o (P10 carries it) but never +s or the mask:

1. `bounce_sync_session_umodes` sends `BX K <cli_yxx(_t)> <mask>` -- the 3-char client half
   of the numeric. `bounce_alias_snomask` resolves it with `bx_find_user_strict`, which never
   matches, so the BX K is deferred and re-broadcast everywhere.
2. The BX C receiver (`bounce_alias_create`, primary local) answers with
   `sendcmdto_serv_butone(&me, ..., cptr, "K ...")` -- every link EXCEPT `cptr`, the direction of
   the alias's server. In a tree it never arrives. It also reads `cli_snomask(primary)`, which is
   0 for a held ghost (close_connection zeroed it).
3. The BX K receiver sets the mask but never +s (`FLAG_SERVNOTICE`), and accepts only aliases.
4. Wipes from remote sources: `bounce_sync_session_umodes(source)` runs with a REMOTE source when
   a server MODE for a remote primary arrives (s_user.c, the IsServer branch) and at the end of
   every set_user_mode whose target is a remote primary. Its APPLY_TO does
   `set_snomask(local_alias, cli_snomask(source))` and `bounce_copy_umodes` copies
   `FLAG_SERVNOTICE`. A remote Client's `cli_snomask` is its uplink link's Connection field and its
   `FLAG_SERVNOTICE` is never set (P10 does not carry +s): every umode change of a remote primary
   zeroes the local aliases' mask and clears their +s, and sends BX K with that garbage onward
   (the `BX K AAD 0` seen in the leaf's log).
5. An alias whose primary is remote cannot set or read its own mask: set_user_mode applies the
   snomask only `if (MyConnect(acptr))`, acptr being the remote primary; `MODE <nick>` reports
   `cli_snomask(acptr)`, the uplink's field.

## Design

**D1 Authority.** A connection's mask and +s are known only to the server that holds it: live
(`MyConnect && !IsBouncerHold`): its own mask and flag; local held ghost: `session->hs_snomask`
(+`hs_snomask_known`). A remote Client's `cli_snomask`/`FLAG_SERVNOTICE` are never read as a
user's state.
- `bounce_copy_umodes(from, to)`: copy `FLAG_SERVNOTICE` only when `MyConnect(from)`.
- `bounce_sync_session_umodes(source)`: the snomask half (local `set_snomask`, remote BX K, the
  hs_snomask tracking) runs only for a local source: live mask, or `hs_snomask` for a held ghost
  when known; otherwise skipped. The flag half is unchanged apart from D1's copy rule.

**D2 BX K.** Wire form unchanged: `BX K <member YYXXX> <mask decimal>`, but the numeric is always
the full one and the target may be any session member (primary or alias).
- Sent toward the target (`sendcmdto_one(&me, CMD_BOUNCER_TRANSFER, target, ...)`), only when the
  next hop `IsIRCv3Aware`.
- Receiver, target found:
  - local live member of a session: `+s` iff mask non-zero (none when `HIS_SNOTICES_OPER_ONLY`
    and not an oper), `set_snomask(target, mask, SNO_SET)` (clamps to SNO_USER for non-opers);
    update `session->hs_snomask`/`_known` + mark dirty; tell the client: `:nick MODE nick +s`/`-s`
    when the flag changed, `008` when the mask changed and is non-zero.
  - local held ghost: update `session->hs_snomask`/`_known` only (the revive applies it).
  - remote: forward toward it (`sendcmdto_one`), first arrival only (not on drain replay).
- Receiver, target unknown: keep today's defer-for-BX-C + broadcast forward (burst race; also
  what an old fork peer's short numerics hit, as today).

**D3 Emitters.**
- `bounce_sync_session_umodes` (local source): each remote member gets
  `BX K <cli_yxx(server)+cli_yxx(client)>` toward it.
- BX C receiver with a local primary: after the alias Client exists, before the forward and before
  the session-move promote, `BX K <alias YYXXX> <mask>` toward the alias, mask = live, or
  `hs_snomask` for a held ghost; only when non-zero. Burst re-sends BX C, so re-links take the
  same path.

**D4 set_user_mode for a local alias of a remote primary** (`snoc` = the local connection the
mask belongs to: acptr when `MyConnect(acptr)`, else sptr when sptr is a local alias of acptr):
- tmpmask starts from `cli_snomask(snoc)`; the `-o` strips use snoc too.
- After the existing `if (MyConnect(acptr))` block, an `else if (snoc)` block applies the mask to
  snoc (`SendServNotice(acptr)` decides on/off, as for a local target) and replies 008 to sptr.
- At the end: `bounce_sync_session_umodes(acptr)` as today (flags; snomask skipped by D1), then
  `bounce_sync_session_umodes(sptr)` so the alias's mask reaches the primary's server and the
  other members by BX K.
- `MODE <nick>` (the query): the `s` letter and the 008 come from snoc's own state.

**D5** The IsServer MODE branch for a remote primary with local aliases needs no change beyond D1.

## Not in scope / still open
- Register row: live umode changes are not announced to the other connections of a session (local
  sync stays silent; D2 announces only what arrives by BX K).
- Old fork peers: their short-numeric BX K and wrong-direction BX C reply keep failing as today;
  their receivers accept full-numeric BX K for aliases (mask, no +s) and defer it for primaries.

## Tests (`tests/src/ircv3/bouncer-snomask.test.ts`, hub 6667 + leaf 6668)
held oper reconnecting on the leaf; live primary + leaf alias: alias told +s/008 and `MODE <me>`
reports the mask; leaf alias changes it: hub primary told, both report it; hub primary's unrelated
umode change leaves the alias's mask; hub `-s` reaches the alias; the alias receives an oper-KILL
server notice (SNO_OPERKILL in the mask) -- delivery end to end.

## As built (after the bouncer-analyst audit, 2026-10-21)

Audit confirmed defects 1-5 and the session-move order (K leaves before BX P/BS T on the same link),
corrected two facts (opsarray is keyed by mask alone, +s gates SendServNotice and the hold save; `AD` in
the leaf log was hub2, an old CRDT-image peer -- the bed is mixed-version), and changed the design:

- **Forwarding:** a 3-char numeric is dropped (old peers; it resolves nowhere); a found remote target is
  forwarded toward it whatever this server knows of its session, never back over `cptr` (a broadcasting
  old relay would loop it); the unknown-target broadcast goes `_v3` only (upstream relays every BX).
- **Mask-only second sync:** `bounce_sync_session_snomask()` is split out of `bounce_sync_session_umodes`;
  set_user_mode calls it for the alias (a full sync would copy the alias's FLAG_SSL onto the session).
- **Echo:** the alias's own +s is copied onto the primary's replica before `setflags`, so `MODE -s`
  echoes.
- **Remote -o:** from a remote source the local members are re-clamped (`bounce_reclamp_snomask`: oper-only
  bits go, +s stays, as set_user_mode's -o); `bounce_clear_oper_locally` does the same.
  HIS_SNOTICES_OPER_ONLY keeps a non-oper from taking +s, not from keeping it (first cut zeroed it).
- **Crossing updates (user's choice point, decided here as a design default, open to revisit):** a
  Lamport stamp per session (`hs_snomask_ts` + `hs_snomask_origin`, not persisted) taken at every local
  change; `BX K <member> <mask> <ts>`; a receiver keeps the later stamp, the lower server numeric on a
  tie. Old receivers read only parv[3]. Test: masks set at once on hub and leaf converge.
- **Grant default branch** records `hs_snomask` (restored pre-v11 ghosts answer BX C with it); a held
  ghost stays out of the opsarray (the grant sets flags, the revive the mask); the revive applies the
  session's mask whenever known (a newer BX K while held wins); `bounce_setup_local_alias` takes the mask
  via `bounce_member_snomask` (no IsOper gate, no remote-field read).

Tests (bed, hub+leaf on v3): 11/11 non-restart cases pass, each red on the build before its fix.

Not done: a v10 record restored on the hub followed by a session move (needs a pre-v11 record + restart);
/OPER on the leaf alias with DIFFERENT O:line masks on the two servers (bed O:lines are the same; the
convergence test covers the crossing mechanism).
