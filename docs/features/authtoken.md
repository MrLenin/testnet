# Authentication tokens (`draft/authtoken`) and FILEHOST

Implementation of the IRCv3 `draft/authtoken` work-in-progress specification
(ircv3-specifications PR #602) and the `draft/FILEHOST` ISUPPORT token
(PR #562). Landed 2026-09-10 on the fork (`ircv3.2-hardening` /
`ircv3.2-upgrade`), commit `7fd9ef8` plus `891f2a1`.

## Why

An external service (the file-upload host behind FILEHOST) needs to know who
an IRC user is without ever seeing their IRC password. The user asks the ircd
for a token, hands it to the service, and the service hands the token back to
the ircd over its own IRC connection to learn the claims the network vouches
for. Tokens are random, single-use and short-lived, and bound to one service
so a token for one service is useless at another.

```
user ──TOKEN GENERATE FILEHOST #chan──► ircd ──TOKEN GENERATE FILEHOST :<tok>──► user
user ──POST /upload  Authorization: Bearer <tok>──────────────────────────────► shim
shim ──PASS <secret> / TOKEN VALIDATE FILEHOST :<tok>──► ircd (any server)
ircd ──BATCH draft/authtoken FILEHOST + TOKEN CLAIM account/name/member_of/operator_of/scope──► shim
shim ──201 Created  Location: https://…──► user
```

## Configuration

One `Authtoken` block per service; the block name is the service key
(spec-defined keys are bare, everything else vendor-prefixed like caps):

```
Authtoken "FILEHOST" {
  url = "https://paste.boxlabs.uk/filehost";     # required; what clients POST to
  description = "File upload (paste.boxlabs.uk)"; # shown in SERVICELIST (defaults to the key)
  pass = "fh-validator-secret";                   # validator PASS, at most PASSWDLEN (20) chars
  host = "172.29.0.0/16";                         # validator source mask, repeatable (up to 8)
};
```

At least one of `pass` / `host` is required; when both are given both must
match. A block that fails validation is logged (`LS_CONFIG`) and rejected as a
parse error. Up to 32 services. Rehash diffs the table: a new key or a changed
URL sends `TOKEN NEW <key> <url>` to clients that negotiated `batch` +
`draft/authtoken`, a removed key sends `TOKEN DEL <key>`, drops its tokens and
revokes validator authority; a changed `pass` revokes authority (validators
reconnect). The first service to appear sends `CAP NEW draft/authtoken`, the
last to go `CAP DEL`.

| Feature | Default | Meaning |
|---|---|---|
| `CAP_draft_authtoken` | TRUE | Advertise the cap. It is only listed in `CAP LS` while a service is configured; `TOKEN` itself never needs the cap |
| `AUTHTOKEN_EXPIRE` | 600 | Seconds a token stays valid (spec recommends 10–15 min) |
| `AUTHTOKEN_MAX` | 4096 | Outstanding tokens per server; the oldest go first. One user holds at most 16 |

## Wire

* `TOKEN SERVICELIST` — `BATCH +id draft/authtoken *` of `TOKEN SERVICE <key>
  <url> :<description>` lines, or `NOTE TOKEN NO_SERVICES` when none is
  configured. Sent unasked in the registration burst (after 005, before
  LUSERS) when `batch` + `draft/authtoken` were negotiated, on all three
  welcome paths (register_user, bouncer revive, bouncer alias).
* `TOKEN GENERATE <service> [<scope>]` — registered, account-bearing users
  only. Reply `TOKEN GENERATE <service> :<token>` (48 hex characters from a
  CSPRNG, always one line). Scope: a channel the requester is on (stored with
  its canonical spelling) or an existing nick; else `INVALID_SCOPE`, or
  `NO_PERMISSIONS <scope>` for a channel the requester is not a member of.
* `TOKEN VALIDATE <service> :<token>` — usable before registration. The
  validator must satisfy the service's `pass` (its `PASS`, remembered across
  registration so a shim can keep one long-lived connection) and/or `host`;
  otherwise `FAIL TOKEN NO_PERMISSIONS <service>`. An unknown service answers
  the same way so keys cannot be enumerated without credentials. A token that
  is unknown, expired, already used, bound to another service, or whose
  requester has since disconnected answers `FAIL TOKEN INVALID_TOKEN`; a
  service mismatch does not consume the token.
* Claims come in `BATCH +id draft/authtoken <service>`: `account` (when
  logged in), `name` (current nick), `member_of`, `operator_of` (op or halfop),
  `scope` (only when one was requested). Long lists are split at 400 bytes with
  a leading-space continuation, as the spec requires; clients concatenate.
  Evaluated at VALIDATE time from live channel state. Channels with `+s` are
  omitted unless they are the token's scope: the validator is a third party.
* Standard replies implemented: `ACCOUNT_REQUIRED`, `INTERNAL_ERROR`,
  `INVALID_SCOPE`, `INVALID_TOKEN`, `NO_PERMISSIONS` (both forms),
  `UNKNOWN_COMMAND`, `UNKNOWN_SERVICE`, `NOTE NO_SERVICES`. `TIMEOUT` does not
  arise: batched VALIDATE is not accepted.
* Client-initiated `draft/authtoken` batches are **not** accepted (the cap
  value carries no `client-batch` token); a client that opens one gets `FAIL
  BATCH UNKNOWN_TYPE draft/authtoken`. Our tokens never need more than one
  line, and the spec makes the batched form a MUST only for over-long tokens.
* Clients without `batch` get the same lines unbatched (spec says batch is a
  prerequisite; this is the practical fallback).

### Replication (P10 `TK`)

Tokens are per-network state so the validator may connect to any server:

```
TK G <token> <service> <yxx> <expires> <scope|*>   minted (yxx = requester numeric)
TK U <token>                                        consumed / evicted
```

Sent to IRCv3-aware peers only (`sendcmdto_serv_butone_v3`); legacy peers
never see it. Not burst on link: a server that joins after a token was minted
cannot validate it (10-minute lifetime, acceptable). Two validators racing on
two servers can both succeed once; each side then broadcasts `U`.

### ISUPPORT

When a service keyed `FILEHOST` exists, `draft/FILEHOST=<url>` is advertised,
and so is `soju.im/FILEHOST=<url>`: goguma keys on the soju spelling. Both
follow rehash through `draft/extended-isupport`.

## Deviations and decisions

* GENERATE requires an account on every service (`FAIL TOKEN
  ACCOUNT_REQUIRED`). The spec leaves this per-service; an upload host needs
  attributable uploads.
* The validator's `PASS` is limited to `PASSWDLEN` (20) characters because
  that is the connection's password buffer; a longer secret is refused at
  config time rather than silently truncated.
* `+s` channels are hidden from `member_of` / `operator_of` unless scoped.

## Not done

* The upload shim itself (FILEHOST on the outside, `TOKEN VALIDATE` on the
  inside, `api.php` / `/img/` on paste.boxlabs.uk behind it) — see
  `.claude/para/projects/filehost-authtoken-plan.md`.
* Client support: Seance PR; goguma only speaks Basic/Bearer with stored
  credentials, and the shim will refuse Basic.
* `role` claims (service-defined roles): nothing defines them yet.

## Tests

`tests/src/ircv3/authtoken.test.ts` (6 cases, bed 6/6 2026-09-10): cap and
burst placement, SERVICELIST, FILEHOST ISUPPORT, the FAIL table, PASS /
host gating, live claims incl. `operator_of`, single use, live re-evaluation
after PART, registered validator, expiry via `SET AUTHTOKEN_EXPIRE`, refused
client batch, and cross-server validation (needs the leaf linked: after a
bed restart the leaf's autoconnect backs off ten minutes; force it with an
oper `CONNECT leaf.fractalrealities.net`).
