# SHUN detectability — investigated, WONTFIX (maintainer decision)

Decided 2026-07-30. **Do not build stealth machinery for SHUN.** This doc exists so the
investigation below is not re-derived from scratch; it was nearly scoped into a multi-day
implementation before the question was put to the maintainer.

## The maintainer's ruling

Rubin, 2026-07-30, on the leak being raised:

> yah shun is a hax
> its probably not worth the time to make it good
> if they know to check for a shun, shun is already not going to work. its meant to just
> discourage people who dont know

**SHUN's threat model is deterrence against users who do not know to check.** It is not, and was
never intended to be, undetectable by someone who looks. Any future proposal premised on "a shunned
user shouldn't be able to tell" is arguing against the feature's stated purpose — take it to Rubin
before writing code.

## What was found (accurate as of `ircv3.2-hardening`)

SHUN is enforced at the parser, not in any command's handler:

```c
/* parse.c:1575-1580 */
if (IsRegistered(cptr) && *(cli_user(cptr)->username) && *(cli_user(cptr)->host))
  if (IsTempShun(cptr) || shun_lookup(cptr, 0))
    isshun = 1;
/* parse.c:1606 */
if (isshun && !(mptr->flags & MFLG_NOSHUN))
  return 0;                      /* handler never runs */
```

The exempt set is **deliberate and coherent**, not an oversight — "you stay connected, you may
change nick, and you may leave, but you are inert":

| Exempt (`MFLG_NOSHUN`) | Dropped |
|---|---|
| PART, QUIT, PING, PONG, NICK, USER, PASS, AUTHENTICATE, **CAP** (added 2026-07-30, see below) | JOIN, TOPIC, MODE, AWAY, WHO, WHOIS, NAMES, LIST, OPER, PRIVMSG, NOTICE, TAGMSG, BATCH |

### The leaks, in order of how fast they betray the shun

1. **JOIN — instant, and predates every IRCv3 feature.** A client learns it joined by the server
   echoing the JOIN plus sending NAMES. Shunned, `/join #chan` opens no window. Detectable by
   *every* client ever written, including raw telnet. SHUN has never been stealthy against anyone
   who tried to join a channel.
2. **echo-message — one round trip.** All emit sites (`ircd_relay.c:538, 695, 1316, 1360, 1521,
   1535`; `m_privmsg.c:158`; `m_tagmsg.c:273/320/335`; `m_batch.c:1065/1385`) are downstream of the
   parse gate, and there is no `shun_lookup` anywhere in `ircd_relay.c` / `m_privmsg.c` /
   `m_notice.c` / `m_tagmsg.c`. A cap-negotiating client expects every PRIVMSG back; silence is an
   unambiguous oracle from a single message to any target.
3. **labeled-response — same gate.** `ircd_relay.c:1329/1369` are also downstream, so a labeled
   PRIVMSG gets neither a labeled reply nor an ACK. Arguably a spec violation (labeled-response
   requires an answer to every labeled command) and a second oracle. Not a stale-label risk though:
   `parse.c:1411-1412` resets `cli_label` / `cli_label_responded` per parsed line.
4. **chathistory — slow.** An echoed message would carry a msgid stored nowhere; a later
   CHATHISTORY on the target omits it. Only reachable by deliberate probing.

### Why the fix was rejected

The considered fix was to give the messaging commands `MFLG_NOSHUN` and move the shun decision into
the relay, so the sender still receives their echo (preserving the illusion) while delivery is
suppressed. That is ~11 emit sites needing a shun-aware branch, where **getting it wrong leaks the
message to real users rather than leaking the shun**. It would also still leave leak #1 (JOIN)
wide open — closing that needs local-only fake channel state that must stay consistent across
NAMES/WHO/MODE and never reach S2S, which is weeks of work.

Per the ruling: not worth it. The leaks are known and accepted.

## What WAS fixed — CAP (`parse.c`, MSG_CAP entry)

One finding survives the ruling because it is **not** a stealth question. `MSG_CAP` carried flags
`0` — no `MFLG_NOSHUN` — so post-registration CAP was dropped for shunned clients. The fork sends
`CAP NEW` / `CAP DEL` to cap-notify clients (`m_cap.c` `cap_notify_flush`, ~:126-155), so the server
*initiates*, then discards the `CAP REQ` its own notification invited, leaving the client waiting on
an ACK/NAK that never arrives.

That is the server wedging a client, not a user detecting a shun. CAP negotiates capabilities for
the client's own connection: it reaches no other user, reveals no one else's state, and carries
nothing worth silencing. Given `MFLG_NOSHUN` to match PART/QUIT/NICK/AUTHENTICATE.

## Cross-refs

`doc/readme.shun` is command syntax only and states no intent — do not look there for the threat
model; it is recorded here instead. Related: [[feedback_ircv3_vs_core_legacy_split]] (echo-message
and labeled-response are fork-exclusive; SHUN is core upstream, so fork-side changes were the only
ones on the table anyway).
