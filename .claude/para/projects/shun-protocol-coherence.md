# SHUN protocol coherence — spec

Scoped 2026-07-30. **Status: BLOCKED on a product decision (see below). Do not implement yet.**

Not a stealth feature. This spec deliberately does *not* try to make SHUN undetectable — that was
investigated and ruled WONTFIX by the maintainer ([[shun-detectability-wontfix]]). It addresses a
different problem that the same investigation surfaced: SHUN breaks IRCv3 clients, and the server
lies about capabilities it advertised.

## The problem, in one statement

```c
/* parse.c:1613 */
if (isshun && !(mptr->flags & MFLG_NOSHUN))
  return 0;                     /* no response of any kind */
```

Every symptom in this area traces to that bare `return 0`. A shunned client's command produces
*nothing* — no error, no ACK, no numeric. Consequences, in descending order of how much they matter:

1. **labeled-response clients degrade.** A labeled command gets neither a labeled reply nor an ACK.
   **Severity qualifier (2026-07-30):** the labeled-response spec itself warns clients that a
   response may never arrive (even without a label, or at all), so a compliant client must
   timeout-and-recover rather than hang. This is therefore *not* the hard client-breaking bug it
   was first assessed as — it is a per-command timeout stall inflicted on every command for the
   life of the shun, against clients doing exactly what the spec told them to. Degraded UX at
   scale, not a wedge. Non-compliant clients that do hang exist, but the spec is not on their side.
2. **The server violates its echo-message contract.** It advertises the capability, then silently
   does not echo. Unlike labeled-response, echo-message carries no tolerance language — the echo is
   unconditional once negotiated. This is now the strongest plank, and it is protocol hygiene, not
   breakage.
3. **Detectability.** Silence is a reliable oracle. Explicitly *not* the justification here — see
   the WONTFIX — but it improves as a side effect.

The same non-normative section then cuts the other way. It documents the **pending-message
pattern**: clients display sent messages immediately in a pending state and finalize them on the
labeled echo, and it states the invariant this rests on verbatim — *"Both methods assume that the
server will acknowledge all successful messages, or return a labeled error response."* Today's shun
breaks exactly that invariant, with a user-visible result: in a pending-pattern client, every
message a shunned user sends **sticks in the pending state or gets marked failed, on screen,
automatically**. The oracle is not something a suspicious user probes for; the client's own UI
draws it.

Net severity, honestly stated: no client *hangs* (the tolerance language covers recovery), but
modern labeled-echo clients render the shun visibly today with no probing — which is both worse UX
than intended and worse *stealth* than the silence was assumed to buy. The case to the maintainer
is protocol coherence plus that concrete artifact, not "clients break."

**The governing insight: the oracle is silence, not refusal.** Any deterministic response closes it.
The response does not need to be convincing, or even friendly — it needs to exist. That is what makes
this cheap, and it is what collapses the design from "shun-aware branches at ~11 relay emit sites"
(the version that was correctly priced as not worth it) down to one site.

## BLOCKING DECISION — this changes what SHUN *is*

An explicit `FAIL` is both machine-readable and human-readable; clients display standard-replies. So
a shunned user stops merely failing to notice a missing echo and instead gets told, in words, that
something was refused. **That is strictly louder than today's silence.**

There is no middle position:

- **Honest restriction** (what this spec describes) — coherent protocol, explicit refusals, no broken
  clients. Effectively a network-wide `+m` or quiet-ban. A legitimate and arguably better feature,
  but it is not a stealth tool, and once the refusal is announced the entire detectability question
  is moot — at that point you would simply say "you are shunned" and skip the indirection.
- **Preserved illusion** — keep echoing, tell nobody. Requires the relay surgery already declined.

Rubin's ruling was against *making SHUN good at stealth*. This spec proposes something he has not
been asked about: making SHUN honest. **Get that sign-off before implementing.** If the answer is
"SHUN should stay silent," the labeled-response fix still survives in its silent form — a bare
`@label=<x> ACK`, which for a non-echo client is indistinguishable from success (see the response
table) — and the rest of this spec is dropped.

## The core technical constraint: capabilities differ by usage model

The obvious design — withdraw the capabilities whose contract is about to be violated — is only safe
for some of them. A client that negotiated a capability at registration and does not process
`CAP DEL` keeps its original expectations forever. What that costs depends entirely on *how* the
client uses the capability:

| Capability | Usage model | Withdrawal from a client that won't see the DEL |
|---|---|---|
| `draft/chathistory` | **pull** — user-initiated command | **Safe.** Nothing is automatic; `FAIL` the command and the client surfaces the error. |
| `labeled-response` | **client-initiated** — client attaches `label=` to its own commands | **Useless.** It keeps labeling. The label must be answered regardless, so withdrawal is optional polish, never the mechanism. |
| `echo-message` | **passive expectation** — no command to reject | **Actively harmful.** Clients that suppress local echo render only on the server's echo, so the user's own messages stop appearing in their own window. Strictly worse than the oracle it would close. |

**Rule: never withdraw `echo-message` blind.** Withdraw only from clients that demonstrably process
`CAP DEL`. For everyone else, leave the capability alone and accept the oracle.

Note there is no capability-tier gating which capabilities a client may request — IRCv3 has no
3.1/3.2 separation; `CAP LS 302` is a CAP protocol version, not a feature tier. A client that opens
with bare `CAP LS` can request `echo-message` exactly as readily as a 302 client, so the
"won't see the DEL" population cannot be assumed small.

## Design: make the drop site answer

At `parse.c:1613` everything needed is already in scope — `cptr`, the parsed `mptr`, and the label
(populated at `parse.c:1507-1510`, before the gate, and reset per line at `:1418-1419`).

The labeled-response model (per its spec, confirmed against its own examples): **the label wraps
whatever response the command produces** — a failed PRIVMSG is answered with a *labeled* 401, e.g.
`@label=dc11f13f11 :server 401 * nick :No such nick/channel`. There is no separate "failed to
label" concept. `ACK` exists solely for a processed command that produces **no** response at all.

That gives the two modes different labeled answers, and both are spec-clean:

| Client capability | Response at the drop site |
|---|---|
| labeled-response + standard-replies (honest mode) | **labeled `FAIL`** — the error is the response; the label rides on it |
| labeled-response (silent mode, if that ruling stands) | **bare `@label=<x> ACK`** — the spec's "processed, nothing to say". For a client **without** echo-message this is byte-identical to a *successful* PRIVMSG — success produces no response, and ACK is the labeled stand-in for exactly that — so it reveals nothing. For a client **with** echo-message the outcome is implementation-defined: the label round-trip completes (some clients resolve the pending message as sent — illusion preserved), but a client that renders only the server's echo has nothing to render. Strictly better than silence in every case; a perfect illusion only for the non-echo case. |
| standard-replies, no label | `send_fail(cptr, <command>, <code>, NULL, <description>)` |
| cap-notify (see prerequisites) | withdraw `draft/chathistory`; optionally `labeled-response`. **`echo-message` is never withdrawn** — see below |
| none of the above | a server NOTICE explaining the restriction (frequency per open question 2) |

`echo-message` is deliberately absent from the withdrawal column, not overlooked. Advertising
cap-notify is evidence a client *can* process `CAP DEL`, not proof it handles the withdrawal of this
particular capability correctly, and the failure mode is the user's own messages vanishing from
their window. The asymmetry is intentional: the downside of not withdrawing is an oracle we are not
claiming to close anyway, and the downside of withdrawing wrongly is a broken client.

Layered: the ACK/FAIL is the universal floor that works for every client; withdrawal is an
optimization for clients that will act on it; the NOTICE is the human-readable fallback. **No relay
changes at any layer** — the echo sites gate on the per-client cap (`CapOwnHas(sptr, CAP_ECHOMSG)`),
so nothing there needs to learn about SHUN.

## Prerequisites — already shipped

Both landed 2026-07-30 on `ircv3.2-hardening`, cherry-picked to `crdt-mesh`:

- **`a5bf2d7` — CAP exempted from the shun gate (`MFLG_NOSHUN`).** Without it a shunned client's own
  `CAP LIST`/`CAP REQ` were dropped, so any design depending on capability negotiation would go
  incoherent exactly when it started to matter.
- **`8bc37bc` — cap-notify implied by `CAP LS 302`.** Both notify sites gated on explicit
  negotiation; the spec says 302 implies support. This widens the set that can be safely withdrawn
  from, though per the rule above it does not make blind withdrawal safe.

## Implementation notes

Real gaps found while scoping — none of these exist yet:

- **`send_fail_with_label` does not exist.** `send_warn_with_label` does (`send.h:333`); `send_fail`
  takes no label. In honest mode the FAIL *is* the labeled response, so the variant is required —
  emitting an unlabeled FAIL to a labeled command would itself violate labeled-response.
- **No bare ACK emitter.** Today labels only ride as tags on outgoing messages
  (`ircd_relay.c:1329-1331` appends `;label=%s` to the echo's tagbuf). Silent mode needs a
  standalone `@label=<x> ACK` helper (~10 lines). Honest mode does not use ACK at all.
- **Restoration state.** If withdrawal is implemented, store what was pulled (a per-connection
  `con_shun_withdrawn` mask) so un-shun restores exactly the set the client had negotiated and
  nothing more. Do not recompute from the fixed candidate set.
- **Ordering.** Withdrawal must precede the first dropped command or one message slips through
  un-echoed. For mask-matched shuns, filter at `CAP LS` time instead of withdrawing — the client
  never sees the capability, so there is no transition to observe. Only live TEMPSHUN produces a
  visible DEL.
- **TEMPSHUN gets identical treatment** — the gate condition is
  `IsTempShun(cptr) || shun_lookup(cptr, 0)`, and the response logic keys off the same test.

## Out of scope

- **The JOIN/TOPIC/MODE/WHO/NAMES/LIST silence.** Base protocol, no capability to withdraw, leaking
  since 2013, and closing it needs fabricated local channel state. This spec gets back to parity,
  not to stealth.
- **Making SHUN undetectable.** [[shun-detectability-wontfix]].
- **The virtual-environment / honeypot replacement** — a separate idea explored the same day: drop
  shunned users into a shared shadow channel so they generate each other's ambient traffic. Viable
  primitives already exist (`IsLocalChannel` for S2S suppression, `CHFL_DELAYED` for divergent
  per-viewer membership), but it needs every state view to lie consistently and must never reach the
  CRDT doc on `crdt-mesh`. Not covered here.

## Open questions

1. **The blocking decision above.** Honest restriction or preserved illusion?
2. **NOTICE frequency** — once per session, or per dropped command? Once is quieter and probably
   right; per-command is more useful to a confused human.
3. **Should `FAIL` name the reason?** `SHUNNED` is honest and maximally clear; a generic
   `CANNOT_SEND` leaks less while still un-wedging the client. Falls out of question 1.

## Cross-refs

[[shun-detectability-wontfix]] (the ruling and the full leak inventory),
[[feedback_ircv3_vs_core_legacy_split]] (echo-message / labeled-response / chathistory are
fork-exclusive, so these changes stay on the fork side; SHUN itself is core upstream).
