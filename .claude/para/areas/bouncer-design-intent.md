# Bouncer Design Intent

External referent for the design audit. Captured from user 2026-05-04, **in their words, not derived from current code**. This is the fixed point we measure the implementation against.

## Core purpose

Multiplex a single IRC user across multiple simultaneous client connections.

Traditional bouncers do this as middleware: the bouncer software keeps one client connection to an IRC server, presents itself as a server to user clients, and clients all share that single upstream connection. Bouncer stays online → upstream connection persists → clients come and go freely.

**Our bouncer is the same idea, except the IRC server itself is the bouncer — no middleman.**

## The constraint that shapes everything: P10 / ircu / nefarious

The host protocol was not designed with multi-connection users in mind:

- Every client has a NICK, announced network-wide, tied to a numeric.
- No two clients can share a NICK.
- Clients can change their NICK to any unused NICK.
- When two servers link and have clients with the same NICK, one or both clients are killed.

This is the rock the bouncer design has to fit around.

## Wire protocol scope by peer type

Two distinct contracts:

- **Legacy (non-IRCv3-aware) peers** — speak **BX P only**, nothing else of the bouncer protocol. They see bouncer sessions as ordinary clients on the wire; BX P is the one mechanism we use to express "the connection answering for this nick has changed numeric."
- **IRCv3-aware peers** — speak a richer set of bouncer-protocol commands covering session lifecycle management and additional P10-level coordination.

The legacy contract is the tight one. The IRCv3-aware contract is intentionally fuller, but still subject to the question "is each subcommand justified by clear design need, or did it grow reactively?" — that's part of step 2's audit.

## Primary / alias model

Because the host protocol allows only one nick-holder per nick:

- **Primary** — one client connection that is the face of the session. Announced network-wide as the NICK holder. Looks to legacy peers like a regular user.
- **Alias** — additional connections. They have a numeric, but are never announced via the traditional NICK token.

**Exactly one primary per session, network-wide.** "Can't have two faces for a single session — where do you route and when?" Two faces is a contradiction in the model, not just a bug.

### Nick lockstep invariant

At connection-registration time, an alias may register with any nick. By registration end (and at all times after), **the alias's nick is kept in lockstep with the primary's nick.** They are, for all intents and purposes, the same session — desync introduces bugs.

To make this less painful at registration time, NICK rejection during registration was relaxed so that nicks held by other connections of the same account don't bounce the new connection. Different-account collisions still apply.

## Session anchoring

- **Account-anchored, hard.** No bouncer for unauthenticated users. Not impossible to support, but no will to cater to that case.
- **Current convention: one session per account.** This is *contextual, not policy or technical.* The design must not preclude multiple sessions per account in the future.
- **Future direction (out of scope for client-facing now, but must not be ruled out architecturally):**
  - clients can submit a session ID at connection time to attach to a specific session
  - clients can query existing sessions before registration ends
  - one account can hold multiple distinct sessions

The implication for the audit: any code that *assumes* "one session per account" — in data structures, lookups, or protocol semantics — is a design liability even if it's working today.

## Architectural inversion — important historical context

> *From user 2026-05-04:* "When you first designed the bouncer session system, you did not actually understand the concept so well (at all?). You designed a bouncer system/protocol that allowed for multiple sessions, but not one that allowed multiple clients to connect to them. Everything after was built on top of that framework, except allowing multiple connections to a session. Then we oper-gated the commands around creating actual sessions and steered most code to assuming a single session per account."

**The original design got the model exactly backwards.** A bouncer's core purpose is multiplexing many connections onto one logical session (multi-connection per session). The original implementation instead supported many sessions per account with one connection each — the dimensions were inverted.

What this means for the codebase as it stands:

1. **The "session" concept in the code is closer to "named persistent identity slot" than "multiplexed connection bundle."** Each session was originally a 1:1 wrapper around a single connection.
2. **The multi-connection-per-session axis was retrofitted on top via "aliases."** Aliases are not an optional feature — they are *the actual bouncer mechanism*, grafted onto a framework that wasn't built for them.
3. **The primary/alias distinction is itself a band-aid.** In the original "session = one connection" model, the session ID identified the connection directly; "primary" exists because once we admitted multiple connections per session, we needed to designate which one is the network-facing nick-holder.
4. **The "one session per account" convention masks the original error rather than correcting it.** Multi-session creation commands were oper-gated and code paths were steered toward single-session assumptions, but the *underlying framework* still treats sessions as the primary identity unit rather than connections-within-a-session.

**Implication for the audit:** when reading code, distinguish:
- *Inherited inverted-model machinery* — registry / lookup / protocol commands that treat the session as the unit and the connection as derivative.
- *Aliases-as-retrofit* — code that adds the "many connections per session" axis on top of (1).
- *Convention-enforcement* — single-session-per-account guards bolted on (2) to suppress the original framework's intended behavior.

These three layers are likely tangled in `bouncer_session.c`, and the tangling itself is probably a major source of the cluster-B churn.

## Session lifecycle

Two states:

- **HELD** — session appears on the server as a user with a nick, but no currently connected clients.
- **ACTIVE** — session has one or more currently connected clients (local or remote).

Transitions:

- Last client disconnects (clean QUIT or socket close) → HOLDING.
- A client connects to a HELD session → ACTIVE.
- Primary disconnects (clean) with at least one alias remaining → an alias takes its place via **BX P** (numeric swap, original primary silently killed by the *internal* bouncer mechanism — note this is not the same as a network KILL command).
- HELD session reaches expiry → session ends.
- Explicit teardown via BOUNCER RESET / ORESET → session ends.
- **Network KILL of any session connection (primary OR alias) → entire session ends.** All other connections of the session are also terminated; aliases do not "get a pass" by virtue of being on a different server. KILL is an oper assertion that this user should not be on the network — applies to the whole session.

> "Ideally a bouncer session should never 'quit' on its own — it needs to be either explicitly torn down, killed, expire, etc."

> *From user 2026-05-04 on KILL semantics:* "KILL on the primary should just kill the whole session. Your aliases shouldn't get a pass, and the consequences should be equal to anyone else."

This makes KILL distinct from clean disconnect: clean disconnect of the primary triggers BX P alias-promotion (session continues); KILL of the primary terminates the entire session including all aliases.

## Hold expiry

Dynamic, not a fixed timeout:

- Configurable **floor** and **ceiling** for hold duration.
- Hold time **grows with use** within those bounds — per-connection event, per-hour/day connected.
- Time can be configured to **"run quicker"** past a threshold (i.e., the held session ages out faster once it exceeds some idle bound).

So a heavily-used account gets a longer hold; an idle account expires sooner.

## Legacy peer's view of a HELD session

A HELD session is **visible to legacy peers as a normal connected user** — it has a nick, a numeric, normal routing. The "held" nature is internal to bouncer-aware servers.

Possible refinement: a tweaked `/WHOIS` line annotating that the user is in HELD state. Otherwise the legacy view is unchanged from a regular client.

This is what makes the BX-P-only legacy contract sufficient: legacy peers don't need to know about "held" because to them the user just *is there*. When the session actually ends (expiry / teardown / kill), legacy sees a normal QUIT or KILL.

## Servers hold sessions; they don't own them

> *From user 2026-05-04:* "Stop tying session ids to servers. Servers don't really 'own' a session, the session is a network-wide construct. Servers own nicks. A server merely holds a session."

This is the single most load-bearing distinction in the bouncer design. P10 has a clear ownership model for clients: a client's numeric is `YYXXX` where `YY` is the home server, and that server is authoritative for the client (announcing it, removing it on QUIT, keeping it in the nick hash). **Sessions don't fit that model.** A session is a network-wide construct whose connections happen to live on whichever servers the user happens to be connected through; no one server is authoritative for it.

What this means concretely:

1. **Session IDs must not encode server identity.** The current scheme (`<server-prefix>-<seq>`, e.g. `Bj-2`, `AC-3`) bakes ownership into the identity, which guarantees that two servers generating sessions during a partition mint *different* sessids for what is logically the same session — directly causing the cross-sessid split-brain case the cluster B code falls back on. A session ID should be a global identifier — UUID, deterministic hash, or any scheme that doesn't bind to a server numeric.

2. **There is no "session origin" in any meaningful sense.** Today's `hs_origin` field, and the `is_local_session(hs_origin == cli_yxx(&me))` discriminator, presuppose ownership. Under "servers hold, don't own," both `hs_origin` and `is_local_session` are conceptual errors. Whatever a server needs to know about peers' relationship to a session is "do I see live connections for this session locally? does my peer? what's our shared truth about its connections?" — never "who owns it."

3. **Reconciliation isn't arbitration.** The "session-vs-session contest with demote-loser" semantics in cluster B is a direct consequence of treating sessions as ownable: if two servers each "own" a copy of the same session, you need a winner. Under "neither owns," reconciliation is roster-merge — both sides hold the same session, their connection rosters union, and no party defers to the other.

4. **Holding ≠ authoritative.** When a server has a HELD ghost for a session, it's *holding* the session (because the session has no live connections anywhere right now and this server happened to be the last to release a connection — or it's restoring a persisted record). It is not the session's *home*. Another server can hold the same session simultaneously without conflict.

5. **The legacy peer view is unchanged.** Legacy peers see clients (primary or held ghost) via the standard P10 nick→numeric model, where the YY *is* the home server for that client. That's correct: clients are P10-owned. The session, which legacy doesn't know about, is the construct that floats above the per-client P10 ownership.

This principle resolves design-intent ambiguity in several places already captured above:

- **Split-brain reconciliation** (§"Split-brain reconciliation — the central design operation"): "two sides of the same session" is well-defined under "servers hold, don't own" — same session ID, by whatever global-identity scheme, on multiple servers means one session with rosters on each. Convergence-via-roster-union follows directly.
- **Persistence redesign** (§"Direction for the persistence redesign"): the persisted record carries information *about* a session, not ownership *of* one. Restoration on boot doesn't claim ownership; it just reasserts "I hold this session, here's what I last knew."
- **Cross-server primary movement** (§"Cross-server topology"): primary moves between servers via BX P because the primary's nick has a P10 home server (which changes), but the session itself doesn't move — it's already everywhere.

## Cross-server topology

A single session can have its primary on one server and aliases on other servers.

- **At most one primary**, network-wide, per session — but it can live anywhere.
- **Aliases can be anywhere** — same server as primary, or different servers.
- The primary can move between servers (e.g., when the primary disconnects and an alias on a different server takes over via BX P).

Implication: routing logic must always be able to answer "where is the primary right now?" — that's the foundation for delivery.

## Split-brain reconciliation — the central design operation

The unifying model across present and future:

- **Session identity is `(account, sessid)`** — sessid is the discriminator that says "this is *which* session of this account."
- **Two sides of the *same* session identity** on a split-brained re-link should **converge**: their connection rosters should union, all connections (primary + aliases) become connections of the one resulting session, and from the user's perspective nothing observable happens.
- **Two sides of *different* session identities** for the same account are distinct sessions and should stay distinct. They coexist; there is no merge.

In the current single-session-per-account convention, the second case can't arise (every session for a given account is by convention the same session), so the operation collapses to "any two sides for the same account → converge their connection rosters."

In the future multi-session-per-account world, the same primitive still applies: same (account, sessid) → converge; different (account, sessid) → coexist.

> "The sessions should stay distinct assuming they are intended to be distinct. A merge would only happen for the same reason they would now: they're ostensibly supposed to be the same session."

So the right primitive at all times is **same-session convergence via connection-roster-union**, never winner-picking across distinct identities.

## Persistence — under-designed by user admission

> *From user 2026-05-04:* "Persisted sessions kinda got rushed in, they were an oversight in the original design process. They worked well, but have been nothing but a headache in the multi-server era generating lots of reconciliation gotchas."

This reframes a large fraction of cluster B. The persistence feature was added without the design rigor of the alias model — it works in single-server use, but multi-server reconciliation around persisted state is *natively* messy because the design didn't think it through up front.

**Implication for the audit:** the question "does the code match design?" doesn't have a clean answer for persistence-related code paths, because **the design itself has gaps in persistence semantics**. Code in this region is filling design holes, not implementing a specified behavior.

That changes what counts as a "gap" in step 5:
- For non-persistence code: gap = code vs design mismatch (clear).
- For persistence-related code: gap = absence of a coherent design, surfaced as reactive code patterns (BX R verdicts, BX F handshakes, `hs_restore_pending`, equal-TS ghost handling, etc.).

**Practical consequence:** sustainable cleanup of cluster B almost certainly requires *first* nailing down a coherent persistence-and-reconciliation design (separate from this audit), then revisiting code against it. Patching cluster B without that step will keep generating reconciliation gotchas because the foundation isn't load-bearing.

### Direction for the persistence redesign (user 2026-05-04)

> "It probably just needs to persist smarter, provide more context to properly decide a reconciliatory path."

So the redesign isn't a tear-down — it's **enriching what gets persisted** so the reconciliation primitives (deterministic dedup + connection-roster union, per the convergence semantics above) have the context they need to converge correctly without coordination protocol.

What that probably implies needs to be in the persisted record (not exhaustive — direction, not decided):

- **Per-connection activity context.** Last-active timestamp per connection (primary + each alias), not just a session-wide `last_active`. Lets dedup tiebreakers prefer the most-active connection deterministically.
- **Alias roster as of last shutdown.** Which servers held which alias numerics, so on restart a server knows what it should expect to see in peers' bursts (and what's stale).
- **Per-channel last-action context.** When membership changed and whether it was user-initiated. Lets convergence respect user-initiated parts during a split.
- **Origin metadata per state piece.** Which server the state came from / was last touched on. Useful for tiebreaking and for distinguishing fresh-from-restore vs live-state-on-this-server.

The principle is the same as the rest of the bouncer design's good parts: **make the reconciliation operation a function of state both sides have, not a coordination dance.** If the persisted record carries enough context, "merge two sides of the same session" becomes a pure function — both sides compute the same converged result independently. No BX R verdicts, no BX F handshakes, no demote-loser machinery.

This is a separate design effort from the audit; the audit can document what's currently persisted vs what step-5 work would need to add, but the actual persistence-record redesign is its own task.

**Practical answers to the two persistence questions I was asking:**
- *Authoritativeness on restore* — never explicitly decided. The code's `hs_restore_pending` mechanism *behaves like* "persisted state is provisionally authoritative pending peer-burst arbitration," but that's an accretion shape, not a stated policy.
- *Persisted aliases* — `hs_aliases[]` exists on the session record as Mar 2 spec'd, but the question of what restoration of an alias *means* (sockets are dead, only metadata survives) wasn't worked out. The current code's behavior here is whatever the implementation evolved toward, not a designed answer.

These aren't blockers for step 4, but they bound what step 4 can usefully conclude in persistence-related areas — code reading there will surface "this code does X, design says nothing" rather than "code does X, design says Y, mismatch."

### Persistence breaks the design's "natural nick collision" assumption

> *From user 2026-05-04:* "These docs were not yet accounting well for how persisted sessions would behave. The nick collision tended to kill both ghosts since they had the same timestamp."

The Mar 2 alias-numerics gist said stale ghosts on reconnect would be killed by natural P10 nick-collision (older `lastnick` loses). That assumption only holds when the two sides' nicks have *different* timestamps.

**With persisted sessions, both sides restore from the same persisted state and end up with identical timestamps.** P10's nick-collision rule for equal TS is "kill both." So the design's "deterministic via natural collision" mechanism doesn't actually fire correctly for persisted same-account ghosts — instead, both die and the user loses the session entirely.

**Implication:** something in the bouncer-aware protocol must handle the equal-TS persisted-ghost case. This is a real gap in the Mar 2 gist, not just scope creep.

**But the convergence intent still holds.** The right response to "two ghosts, same (account, sessid), same TS" is **deterministic dedup as part of session convergence**, not "session-vs-session contest." Specifically:
- Recognize "same (account, sessid) on both sides + same TS + persisted" → these are two replicas of the same logical session.
- Converge to one: pick the survivor by *some* deterministic rule (lowest server numeric, lex on origin, doesn't really matter — the user gets the same result either way).
- The non-survivor goes away **silently** — no KILL, no QUIT, no channel-membership churn. From the user's perspective nothing observable happens.

This recasts cluster B's purpose: **BX R / BX F are responding to a real gap, but with the wrong primitive.** The current code frames the resolution as a winner-picking contest with last-active timestamps and demote-loser-to-alias machinery; the design says it should be a no-contest deterministic dedup that's part of convergence. Different primitive, much smaller surface.

### Convergence semantics (what each axis does)

When two sides of the same session converge:

- **Connection roster** — union. Every primary and alias on either side becomes a connection of the converged session. Connections are physically distinct (each is a unique TCP socket on a specific server) so the union is always well-defined; there is no alias-vs-alias collision possible.

- **Primary identity** — doesn't strictly matter post-shadow. With aliases having real numerics, the only thing that meaningfully needs a "primary" is who holds the network-announced nick and (for legacy peers) who PMs route to. Preferred candidate when there's a choice: oldest and most-active connection (most audit-valuable), or whichever choice produces the least wire-churn/visible effect. Either rule beats "winner-picking."

- **Channel memberships** — union by default. The common cases are well-behaved (memberships match, or one side has none, or one side is a sub/super-set of the other — these all union cleanly). Edges happen during proper netsplits where the user joins or parts during the split.
  - **User-initiated parts during the split should be respected** if feasible — i.e., if A explicitly parted #foo during the split, the converged session should not re-add #foo just because B still had it. Recording this is non-trivial under the standard P10 burst model (which re-asserts membership from each side's own view), so this is **aspirational, not a hard guarantee**. Fallback: user can re-PART after relink.

- **Hold-expiry clock** — follow the **older** session. Accumulated hold-time is something the user has earned by use; convergence shouldn't reset that.

- **Msgids / chathistory** — treat as orthogonal to bouncer convergence. Chathistory storage is per-server and federation handles cross-server replay independently of session-state operations.

> *Editorial note for the audit:* the current implementation's BX R reconcile is built around picking a winner (last-active timestamp + lex tiebreaker, demote-loser-to-alias). That **does not match** the convergence operation described above. The current code is performing a session-vs-session contest when the design calls for a no-contest connection-roster union of two sides of the same session. This is a design-implementation gap to surface explicitly in step 5, and is probably the root explanation for cluster B's churn — every "fix" iterates on the winner-picking mechanism, which can never converge on the intent because the operation itself is wrong.

## How users get a bouncer session

- **Bouncer-class port** — automatic bouncer session by default for any client connecting on this port.
- **Other ports** — bouncer session created via explicit user activation (i.e., user opts in).

## Invariants summary (testable assertions)

Distilled from the above. These are the claims we hold the implementation to in step 4:

1. **One primary per session, network-wide.** Ever.
2. **Aliases have numerics but are never N-broadcast** in the traditional NICK fashion.
3. **Primary and alias nicks are in lockstep** at registration end and at all times after.
4. **Sessions are account-anchored.** No session without an account.
5. **A session does not quit on its own.** Only end paths: expiry, explicit teardown, KILL.
6. **HELD sessions are visible to legacy peers as ordinary users.** No special wire signal needed.
7. **Legacy wire vocabulary is BX P only.** Any other bouncer-protocol command leaking to a legacy peer is a violation.
8. **Split-brain merges invisibly.** Picking a winner is wrong; reconciling-via-demote is wrong.
9. **The protocol must not assume one-session-per-account.** Architecture must allow multiple sessions per account even if not exposed today.
10. **The primary axis is connections-per-session, not sessions-per-account.** A bouncer multiplexes connections onto a session; that is its core purpose, not an add-on. Code that treats sessions as the multiplexed unit and connections as second-class is reflecting the original design inversion, not the corrected intent.
11. **Servers hold sessions; they don't own them.** Sessions are network-wide constructs. A server is authoritative for the *clients* that have YY = its numeric (P10 ownership of nicks/numerics), and a server *holds* a session if it has live connections (or a held ghost) for it — but no server "owns" a session, and session IDs must not encode server identity. Reconciliation is therefore roster-merge across two holders, never arbitration between two owners.
12. **Network KILL of any session connection ends the entire session.** Aliases on other servers do not survive a KILL of the primary (or of any other session connection). KILL is an oper assertion of "off the network"; it applies to the whole session, not just the connection that received the KILL token.

These are the rocks the audit measures against.

## References — pre-flailing design documents

Provided by user 2026-05-04, predate cluster B/C3 churn. These are the external referents for steps 2 and 3.

| date | gist | role |
|------|------|------|
| 2026-01-30 | [bouncer-multi-server.md](https://gist.github.com/MrLenin/5bcab821f10756fe47e9671d113bb1af) | Cross-server exploration. Rejected DNS routing + transparent P10 relay. Landed on BT-based "session follows the human" migration. **Pre-shadow-removal era.** |
| 2026-02-23 | [Multiserver Bouncer Sessions — Production-Ready Plan](https://gist.github.com/MrLenin/968b00f86a4dbcba7baee09ad86b7cf8) | BV (virtual bouncer server) approach. Reserved P10 numeric, session numerics server-independent, cross-server resume via socket transplant. **Pre-shadow-removal era.** |
| 2026-02-23 | [Per-Connection Delivery Fix for Union Caps](https://gist.github.com/MrLenin/f032be816f93eb21953237d952969da1) | Bug-fix design for union-caps routing in shadow era. Sender's connection respects echo-message; all OTHER connections always mirror. **Pre-shadow-removal era.** |
| 2026-02-25 | [Cross-Server Bouncer Sessions — BX-Based Plan](https://gist.github.com/MrLenin/2ee96e2dff914acdf86af7bc461eee0e) | Transitional. BX (membership swap) + BS S/W/N/R/O relay shadow protocol. Activity-triggered BX migration. **Pre-shadow-removal era.** |
| 2026-03-02 | [IRC Bouncer Alias Numerics — Phase 2](https://gist.github.com/MrLenin/f19e7075da9ac566f789ee821211187a) | **Authoritative for current architecture.** Replaces relay shadows with first-class aliases (each has its own numeric). Defines BX C/X/P/N/U and BS L/T. **Post-shadow-removal era — this is what the code is supposed to be.** |

Audit reference notation: when step 2 evaluates a subcommand against design intent, the **2026-03-02 alias-numerics gist** is the canonical reference for the wire protocol surface as designed. Earlier gists are historical context (shadow era) and should not be measured against — that architecture was retired.

Three observations that immediately fall out of reading the Mar 2 gist:

1. **The Mar 2 design lists 5 BX subcommands** (`C`, `X`, `P`, `N`, `U`) **and 2 new BS subcommands** (`L`, `T`). The current code has all of those plus **BX R, BX F, BX J, BX M** which aren't in the Mar 2 design. Those four are candidates for reactive scope creep — to be confirmed in step 2.

2. **The Mar 2 design says netsplit promotion is deterministic**: "Each surviving server independently computes tiebreaker: lowest `ba_server` numeric in `hs_aliases[]`. Winning server broadcasts `BX P`. **Deterministic outcome: No coordination needed; all servers compute same winner.**" The current cluster B code has built extensive coordination machinery (BX R verdicts, BX F handshakes, last-active timestamps, lex tiebreakers, demote-loser-to-alias, deferred-pending-demote retries). This is layered on top of a problem that, per design, doesn't require coordination.

3. **The Mar 2 design says stale ghosts on reconnect are handled by natural P10 nick collision**: "On reconnect: stale ghost has older `lastnick` timestamp → killed by nick collision handler." No reconcile protocol needed. The current code's m_nick split-merge / BX R verdict consultation / silent-drop-instead-of-KILL are again layered on top of a problem the design solves with existing primitives.

These three observations are step-5 gaps surfaced early. They're consistent with the cluster B framing: code iterating on a protocol layer that the original design didn't say was necessary.
