# Upstream Nefarious Compatibility Investigation

## Date: 2026-02-01

## Purpose

Test whether the modified nefarious (with IRCv3 extensions, libmdbx, metadata, chathistory, bouncer, etc.) can link with stock upstream evilnet/nefarious2 without crashes or desyncs.

## Setup

- **Hub**: Modified nefarious (`testnet.fractalrealities.net`, 172.29.0.2)
- **Upstream leaf**: Stock evilnet/nefarious2 at commit `80bc327` (`upstream.fractalrealities.net`, 172.29.0.8)
- **Link**: SSL on port 4496, P10 protocol
- **Docker profile**: `--profile upstream`

## Results: No Functional Issues

The link establishes and operates correctly. Stock nefarious handles unknown extensions gracefully.

### P10 Token Compatibility

Unknown tokens from the modified server are silently ignored by upstream:

| Token | Description | Upstream Behavior |
|-------|-------------|-------------------|
| `BS` | Bouncer session | `Unknown (BS)` — ignored |
| `MD` | Metadata sync | `Unknown (MD)` — ignored |
| `MK` | MARKREAD | `Unknown (MK)` — ignored |
| `CH` | Chathistory advertisement | `Unknown (CH)` — ignored |

No crashes, no desyncs, no connection drops. P10 is designed to be forward-compatible with unknown tokens.

### User Mode Compatibility

The hub bursts users with custom user modes (e.g., `+b` for bouncer hold). The upstream server sends `501 ERR_UMODEUNKNOWNFLAG` back for modes it doesn't recognize.

**Observed**: `501 BjAAC b :Unknown user MODE flag`

This is **intentional behavior** in nefarious — it alerts that a linked server is out of date. The 501 gets routed back to the user's bouncer shadow session on the hub. Cosmetic only; no functional impact.

**Affected custom user modes**: `+b` (bouncer hold), `+Y` (no storage), `+y` (PM opt-out), `+M` (multiline expand)

### Channel Mode Compatibility

Custom channel extended modes (`+H`, `+P`) are included in BURST channel mode strings. The upstream server would ignore unknown channel modes during burst without error (channel modes are parsed differently from user modes in BURST processing).

### Burst Behavior

Full burst completed successfully:
- All service bots received (O3, Global, AuthServ, ChanServ, HistServ, MemoServ)
- All users with accounts and modes received
- All channels with modes and membership received
- Chathistory channel list (`CH A F`) received and ignored
- End of burst (`EB`/`EA`) exchanged correctly
- PING/PONG operating normally post-burst

### SASL

SASL authentication routes through the hub to X3 services. Users on the upstream server can authenticate via SASL since the `SASL_SERVER` feature points to `x3.services` which is reachable via the hub.

## Conclusion

**Mixed-version linking works.** The modified nefarious can serve as a hub for stock upstream leaf servers with no functional issues. The only visible artifact is 501 errors for unknown user modes during burst, which is by design.

## Configuration Notes

- Upstream Connect block needs `ssl = yes;` for outbound connection to hub
- Hub needs a `LeafServer` class Connect block for the upstream server
- Clone limits (`IPCHECK_CLONE_LIMIT`, X3 `untrusted_max`) should be set high enough for stress testing tools
