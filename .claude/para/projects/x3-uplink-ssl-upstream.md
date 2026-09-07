# X3 uplink SSL — upstream PR (PARKED, low priority)

2026-08-01, user: X3 upstream has no uplink SSL; the MrLenin fork added it.
User is open to a separate PR upstreaming the fork's uplink-SSL support to
evilnet/x3, but it is NOT high priority — do not start without an explicit
go.

Context: surfaced during the docker template pass (PR #58). The testnet
`.env` `X3_UPLINK_SSL` / `X3_UPLINK_SSL_VERIFY` vars belong to the fork
feature — they are NOT dead config and must not be deleted; the upstream
template deliberately carries no ssl keys until the C support lands there.

Scope when picked up: identify the fork commits adding uplink SSL (ioset/
proto-common/conf), rebase onto evilnet/master, add the docker template
keys (%X3_UPLINK_SSL%, %X3_UPLINK_SSL_VERIFY%) in the same PR so config and
code land together.
