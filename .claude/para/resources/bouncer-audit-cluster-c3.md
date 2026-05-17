# Step 4 — Cluster C3 audit (BX C in-place conversion / pending-BX deferral / m_join skip-duplicate-JOIN)

Read against the design intent, wire-protocol, and state-machine docs. **No fix proposals** — findings only. Specific code references for verifiability.

BX J's resolution is already covered in design dialog (ride-along on BX C, preserving single-msgid invariant). This audit covers the other three pieces of cluster C3.

## 1. BX C in-place conversion path — the hot bug surface from 2026-05-04 reproduction

**Location:** `bouncer_session.c:4949–4982`.

### What it does

When `BX C <primary> <alias>` arrives and the alias numeric corresponds to a local client that's not already an alias, the code converts that client into an alias *in place*:

```c
if (alias) {
    if (IsBouncerAlias(alias)) goto forward;  /* already alias, skip */
    /* Existing non-alias client — convert in place. */
    hRemClient(alias);                        /* remove from nick hash */
    /* Copy identity from primary: nick, username, host, realhost, info,
     * account, acc_create, alias_primary pointer, IP, cloakip, cloakhost,
     * fakehost. */
    SetBouncerAlias(alias);
    if (IsHiddenHost(primary)) SetHiddenHost(alias);
    cli_lastnick(alias) = cli_lastnick(primary);
    bounce_copy_umodes(primary, alias);
    goto track_alias;
}
```

### Findings

**C1 — No BX P emitted to legacy peers + new primary's N is relayed unsuppressed.** This is the bug surface from the 2026-05-04 reproduction. When the existing client being converted is a held ghost, that ghost was previously bursted to legacy peers via N (per design intent §"Legacy peer's view of a HELD session"). After in-place conversion, the client is now an alias on bouncer-aware servers, but legacy peers still see it as a regular user with the held ghost's numeric. The new primary's N (e.g., `ACAAA` from leaf) gets relayed unsuppressed to legacy upstream, which sees it as an independent client with the same nick, same user@host, equal TS as its existing held-ghost view → KILLs both.

The semantically correct fix is **BX P, not Q**: the user is the same logical client, only the network-facing numeric changed. BX P (`<old_numeric> <new_numeric> <sessid> <nick>`) is exactly the wire signal for "renumber this client" — legacy stock BX handler does in-place numeric swap, no QUIT scrollback. Q would generate visible "QUIT" channel events for an event that's purely internal session-state cleanup.

The complete fix at the conversion site: emit `BX P` toward legacy peers AND suppress relay of the matching `N` for the new primary to those same peers (BX P already accomplished the introduction). IRCv3-aware peers still receive the N (for the new primary's Client struct) and BX C (for the alias relationship). Caveat: BX P doesn't carry user/host/IP; if those changed, legacy upstream retains the held ghost's stale metadata. Acceptable cost for the common reconnect-from-same-IP case.

**C2 — `IsBouncerHold` flag not cleared.** The pre-conversion held ghost has `FLAG_BOUNCER_HOLD` set. The conversion calls `SetBouncerAlias` but doesn't clear `FLAG_BOUNCER_HOLD`. Result: a client with both flags set, which is semantically nonsensical (alias and held-ghost are mutually exclusive states under design intent — alias is a live connection, held ghost is no live connection). Relies on `IsBouncerAlias` being checked first elsewhere to mask the issue. **Latent bug surface for any code path that checks `IsBouncerHold` independently.**

**C3 — Persistence record orphaned.** The pre-conversion held ghost has a persisted DB record (`bsr_*` fields). After conversion, the persisted record is stale: it describes a held-ghost identity for a session that's now ACTIVE with a remote primary. Aliases aren't persisted (per design intent + audit cluster B). The current code doesn't delete or update the persisted record on conversion. **Stale on-disk state that will mislead future restoration.**

**C4 — `track_alias` shared with fresh-allocate path.** The `goto track_alias` label is shared between in-place-conversion and the fresh-allocate path below it (line 4986+). The fresh-allocate path applies `alias_modes` (BX C parameter) via `user_apply_umode_str`. The in-place path uses `bounce_copy_umodes(primary, alias)` *before* `goto track_alias`, then track_alias also applies `alias_modes`. So in-place gets *both* the primary's umodes copied AND the BX C-supplied modes applied on top. May or may not be intentional; design intent doesn't specify. Worth verifying interaction is correct.

**C5 — Mar 2 design didn't specify in-place conversion.** Per Mar 2 alias-numerics gist, alias creation is a fresh-allocate operation: `make_client`, `make_user`, `SetRemoteNumNick`, etc. The in-place conversion path is post-design accretion, presumably added because of burst ordering ("BX C arrives for a client that was introduced via N token"). The use case it solves is: same server has bursted a held ghost (as N) and then receives BX C indicating that ghost is actually an alias of a remote primary. **This is exactly the persistence reconciliation gap surfaced in cluster B**: the held ghost was treated as an independent identity at burst time, then BX C arrives with the truth. Under deterministic-dedup-with-rich-persistence, the ghost would be recognized at restoration time as belonging to the same session as the (eventual) remote primary, and the in-place conversion path wouldn't be needed.

## 2. Pending-BX deferral machinery

**Location:** `bouncer_session.c:5520–5694` (struct + helpers); call sites in BX K, BX U, BX E, BX M handlers.

### What it does

When a BX subcommand (E, K, M, U) targets an alias numeric that's not yet known locally (`findNUser` returns NULL), the message is deep-copied into a `PendingBxEntry`, stored in a fixed-size array (`pending_bx[MAXCONNECTIONS]`), and replayed when the corresponding `BX C` later creates the alias. Mechanics:

- 30-second TTL (`BX_PENDING_TTL`). Expired entries freed on next defer-attempt.
- FIFO eviction when array full (oldest entry dropped).
- Replay drained per-alias-numeric in insertion order (oldest-matching first, repeatedly), so multi-frame BX M batches replay correctly.
- `bx_drain_in_progress` flag prevents recursive deferral during replay.
- Server numerics (`cptr_yxx`, `sptr_yxx`) re-resolved at replay time via `FindNServer` to handle SQUIT during the deferral window.

### Findings

**P1 — Defensive engineering for a burst-order workaround.** The mechanism is well-implemented (TTL, eviction, recursion guard, SQUIT-safe replay). What it's solving, though, is a structural burst-order mismatch: BX subcommands targeting an alias arrive before the alias's BX C. Under deterministic local computation with enriched persistence (per cluster B's structural recommendation), each side would know its expected alias roster from persisted state and the burst-order mismatch wouldn't matter. **Implementation quality: good. Existence justified by current architecture; eliminable under persistence redesign.**

**P2 — Cross-cuts every BX subcommand handler.** Each handler that takes an alias numeric (BX E, K, M, U) has to know about `defer_bx_for_alias` and integrate it into the failure path. Adds bookkeeping load to every new BX subcommand. **Architectural smell**: mechanism that affects every subcommand suggests the underlying problem (burst order) shouldn't be solved at the per-subcommand level.

**P3 — Silent drop on TTL expiry.** Expired entries are freed without notifying anything. If a BX C never arrives within 30s, the deferred subcommand is silently lost. Probably fine in practice (network problems would surface other ways), but worth noting per the silent-defer feedback memo. Comment at line 5562 logs the expiry at DEBUG_INFO level — *not* silent at log level, but silent operationally.

**P4 — `bx_drain_in_progress` is process-global, not per-link.** If two link-establish events are happening concurrently and one drains while another tries to defer, the second link's defer attempt is refused. Single-process IRCd is single-threaded, so this is probably safe in practice (drains complete synchronously), but the global is a footgun if anyone ever introduces multi-step async drain.

## 3. m_join skip-duplicate-JOIN (`f3fb834`)

**Location:** `m_join.c:354–364`. Eleven lines.

### What it does

When `m_join` is called with an alias as `sptr`, the alias source is captured into `alias_source` and `sptr` is rewritten to the primary. The fix adds a pre-check: if `alias_source` is set and the alias is already a member of the channel being joined, skip the JOIN silently (continue to next channel in the list).

Without this short-circuit, `do_join`'s `find_member_link` check would only see the rewritten primary in the channel, miss the alias's own `CHFL_ALIAS` membership, and produce a duplicate JOIN echo on top of the one already sent by `bounce_send_channel_state` during alias attach.

### Findings

**J1 — Server-side accommodation of HexChat behavior.** Already discussed in dialog. The HexChat auto-rejoin race generates a JOIN for a channel the alias is already in via auto-attach. Standard ircu behavior would be to no-op or echo; this code suppresses the echo entirely. User has now patched the HexChat fork to handle the scenario client-side, removing the need for this server-side accommodation.

**J2 — Suppress-vs-NAMES-re-emit alternative.** The chosen behavior (silent skip) breaks any client that uses JOIN-already-in-channel as a NAMES-refresh idiom. The alternative (re-emit NAMES on duplicate JOIN) would handle both HexChat's case (correct userlist) and the refresh idiom. Not actionable given user's intent to revert.

**J3 — Slated for revert.** Per design intent dialog 2026-05-04. Tracking in `bouncer-wire-protocol.md` § "Real-gap-driven scope creep (BX J)" → "Deferred action."

## Cross-cluster observations

The C3 cluster's three pieces share a structural shape: **each is a workaround for a burst-order mismatch or a client/server interaction edge case, not a designed-in protocol behavior**.

- BX C in-place conversion: workaround for burst-order delivery of held ghost vs. remote primary's BX C.
- Pending-BX deferral: workaround for burst-order delivery of BX subcommand vs. its target's BX C.
- m_join skip-duplicate: workaround for client-side auto-rejoin race against server-side auto-attach.

Under the persistence redesign (deterministic local computation from enriched persisted state, per cluster B audit), the first two cases become smaller or vanish entirely. The third case is independently resolvable client-side (already done in user's HexChat fork).

## What context the persistence redesign would need (from this read)

Adding to the cluster B list:

9. **At-restoration knowledge of alias roster.** If a server restores its persisted record for a session and the persisted record carries "this session has aliases on servers X and Y," the server can pre-create alias placeholders or expect them in burst — eliminating the in-place conversion path entirely. The held ghost would be recognized at restore as a particular session-identity slot, not an independent client.
10. **Per-alias caps stored alongside roster.** The pending-BX deferral exists partly because BX U caps= arrives per-alias and may precede or follow the alias's BX C. If caps are persisted with the alias roster and exchanged once at link-establish (rather than streamed via individual BX U), the deferral can shrink considerably.

## Summary assessment

Cluster C3's machinery is real engineering responding to real problems — burst ordering races and client-server interaction edges. The implementations are mostly competent (pending-BX deferral has good engineering hygiene). What's flawed is the architectural choice to solve burst-order races at the per-subcommand level rather than at the persistence layer.

Combined with cluster B, the picture is consistent: **the bouncer system needs richer per-server local state from persistence so that burst exchanges become roster announcements rather than coordination protocols.** The wire surface that survives the persistence redesign is small; most of clusters B and C3 are workarounds for the absence of that local knowledge.

**Specific actionable items from cluster C3 (independent of the bigger redesign):**
- **C1 (no Q on in-place conversion)** is a fix-now-or-document-as-known-quirk decision. The reproduction tonight surfaced it; the audit identified it concretely. User can decide whether to patch the in-place path or accept it as part of the "to-be-eliminated by persistence redesign" surface.
- **C2 (IsBouncerHold not cleared on conversion)** is a small bug. Even if the surrounding mechanism is going away, the flag-state inconsistency is concrete and worth a one-line fix.
- **C3 (persistence record orphaned on conversion)** is concrete data integrity issue. Same as C2 — small fix possible, or accept under the bigger redesign.
- **f3fb834 revert** — already noted, awaiting user direction.
