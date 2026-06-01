---
name: x3-services
description: X3 services (AuthServ/ChanServ/OpServ) reference — the service bots, their access-level scales (olevel / channel access), and the common commands testnet sessions invoke. Use when writing tests that exercise X3 commands, debugging service-bot interactions, or reading code that crosses the IRCd↔services boundary.
---

# X3 Services Skill

X3 is the testnet's services daemon, speaking P10 to Nefarious. It exposes three public service bots (plus optional modules) and is administered by an olevel-gated OpServ.

## Service bots

- **AuthServ** — account registration, authentication, password / email management. Account-name prefix `*` distinguishes from nicks.
- **ChanServ** (a.k.a. **X3**) — channel registration, access lists, settings, modes.
- **OpServ** (a.k.a. **O3**) — network operator commands. Gated by **olevel**; needs an oper line + olevel ≥ the threshold for the specific command.
- Optional modules: MemoServ (`mod-memoserv`), HelpServ (`mod-helpserv`), Snoop (`mod-snoop`), SockCheck (`mod-sockcheck`), Blacklist (`mod-blacklist`).

## Communication pattern

```
Client → Service:  PRIVMSG <Service> :<command>
Service → Client:  NOTICE  <nick>    :<response>
```

Names are interpreted as nicks by default; prefix with `*` to mean an account name (e.g. `*alice` is the account "alice", `alice` is the nick "alice" currently in use).

## Access-level scales

### OpServ olevels

| Range | Role |
|---|---|
| 0–99 | (no oper access) |
| 100–199 | Helper |
| 200–399 | Oper |
| 400–599 | Admin |
| 600–899 | Network Admin |
| 900–999 | Support |
| 1000 | Root (full O3 access) |

### ChanServ channel access

| Range | Role |
|---|---|
| 1–99 | Peon / Voice |
| 100–199 | HalfOp |
| 200–299 | Op |
| 300–399 | Manager |
| 400–499 | Co-Owner |
| 500+ | Owner |

## Common commands

```text
# AuthServ
PRIVMSG AuthServ :REGISTER <account> <password> <email>
PRIVMSG AuthServ :AUTH <account> <password>
PRIVMSG AuthServ :COOKIE <account> <cookie>            # activate a registration

# ChanServ
PRIVMSG ChanServ :REGISTER #channel
PRIVMSG ChanServ :ADDUSER  #channel *account 200       # account-name prefix

# OpServ (requires olevel)
PRIVMSG O3 :ACCESS                                     # report your olevel
PRIVMSG O3 :GLINE *!*@host 1h reason                   # network ban
PRIVMSG O3 :REHASH                                     # reload services config
```

## Account activation in the testnet

The testnet's `x3.conf` has email verification enabled (`email_enabled=1` in `data/x3.conf`). On a fresh start the `x3-admin-init` container short-circuits this by temporarily disabling the feature, registering the admin account, then re-enabling it. First oper to register on a fresh database gets olevel 1000 — the `x3-admin-init` container races for that slot to claim it for `X3_ADMIN=testadmin` (password `X3_ADMIN_PASS=testadmin123`, defaults).

Manual activation when needed:
```bash
docker logs x3 | grep -i cookie   # find the cookie X3 emitted
# then in IRC:
PRIVMSG AuthServ :COOKIE <account> <cookie>
```

## Test-helper alignment

For test code, `tests/src/helpers/x3-client.ts` exports two factories:

- `createX3Client()` — regular non-privileged client (covers AuthServ/ChanServ flows for normal users).
- `createOperClient()` — pre-authenticated as `X3_ADMIN` with olevel 1000, for tests that exercise OpServ.

See the `test-writing` skill for full helper patterns, retries, and tag handling.
