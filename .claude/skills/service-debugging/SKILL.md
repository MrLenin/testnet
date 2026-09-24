---
name: service-debugging
description: How to debug the testnet runtime (X3, Nefarious, Keycloak) — check logs across all three services since issues often span service boundaries, plus common failure modes. Use when diagnosing testnet service problems (auth failures, link issues, services not responding).
---

# Service Debugging Skill

When debugging issues in the testnet environment, always check logs from ALL three services: X3, Nefarious, and Keycloak. Issues often span multiple services.

## Container Topology (network `irc_net`, 172.29.0.0/24)

| Container | IP | Profile | Server name / role |
|---|---|---|---|
| nefarious | 172.29.0.2 | default | testnet.fractalrealities.net (primary IRCd) |
| x3 | 172.29.0.3 | default | x3.fractalrealities.services |
| nefarious2 | 172.29.0.5 | linked | leaf.fractalrealities.net |
| nefarious3 | 172.29.0.6 | multi | hub2.fractalrealities.net |
| nefarious4 | 172.29.0.7 | multi | leaf2.fractalrealities.net |
| nefarious-upstream | 172.29.0.8 | upstream | unmodified evilnet/nefarious2 master for legacy-vs-fork comparison |
| keycloak | 172.29.0.10 | default | Keycloak IdP (admin UI on host port 8080) |
| keycloak-setup | 172.29.0.11 | default | one-shot realm/client/user provisioning |
| keycloak-db-indexes | 172.29.0.12 | default | one-shot Postgres index install (when `KC_DB=postgres`) |
| pdns-recursor | 172.29.0.20 | default | Consul DNS forwarder — Keycloak resolves `*.service.consul` through this |

**Operational consequence**: `pdns-recursor` is load-bearing. If `KC_DB=postgres` and `KC_DB_URL` uses a `*.service.consul` host (the prod config), Keycloak's JDBC pool times out at startup when pdns-recursor is missing. Bring it up first or use `KC_DB=dev-file` for self-contained local dev (`.env` default).

## Host-Exposed Ports (localhost only)

| Port | Container | Description |
|---|---|---|
| 6667 | nefarious | IRC plaintext |
| 6697 | nefarious | IRC SSL/TLS |
| 4497 | nefarious | IRC SSL (legacy) |
| 8443 | nefarious | WebSocket SSL |
| 9998 | nefarious | Services link (P10) |
| 6668 | nefarious2 | IRC plaintext (linked profile) |
| 6669 | nefarious3 | IRC plaintext (multi profile) |
| 6670 | nefarious4 | IRC plaintext (multi profile) |
| 8080 | keycloak | Keycloak admin UI |

## Connection environment

- Tests use `IRC_HOST=localhost` to connect via the exposed port.
- Containers use `IRC_HOST=nefarious` (the container name) to reach the IRCd on the docker bridge.
- IRC servers won't complete registration until the client responds to `PING` with `PONG` — any handshake script must handle the PING that arrives during connection.

## Quick Service Status

```bash
docker ps -a | grep -E 'x3|nefarious|keycloak'
```

Exit codes: 139=SIGSEGV, 137=SIGKILL/OOM, 134=SIGABRT

## Correlating Logs - All Three Services

ALWAYS check all three services when debugging:

```bash
# Quick overview from all services
for svc in x3 nefarious keycloak; do echo "=== $svc ===" && docker logs $svc --tail 20 2>&1 | tail -10; done
```

### Detailed Service Logs

```bash
# X3 - Services (account auth, channel ops, SASL handling)
docker logs x3 --tail 100 2>&1 | tail -50

# Nefarious - IRCd (connections, P10 protocol, client messages)
docker logs nefarious --tail 100 2>&1 | grep -E 'SASL|x3|Error|QUIT|P10|SSL|Client' | tail -30

# Keycloak - Identity (auth, tokens, users, groups)
docker logs keycloak --tail 100 2>&1 | grep -iE 'error|warn|token|auth|user|invalid' | tail -30
```

## Common Debugging Scenarios

### SASL Authentication Issues
Check all three:
- **X3**: SASL session handling, Keycloak callbacks
- **Nefarious**: SASL message relay, CAP negotiation
- **Keycloak**: Token validation, user lookup

### Account/Channel Operations
- **X3**: AuthServ/ChanServ command handling
- **Nefarious**: P10 protocol messages (AC, B, M tokens)
- **Keycloak**: Group sync, attribute updates

### Connection Issues
- **Nefarious**: Client connect/disconnect, SSL handshake
- **X3**: Service link status
- **Keycloak**: HTTP connectivity from X3

### Keycloak webhook delivery (SPI -> ircd :9090)

- The SPI reads `KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL` / `_SECRET` at Keycloak start (`.env` + `.env.local`; `.env.local` wins). Since 2026-09-23 both name `http://nefarious:9090/keycloak-webhook` and the ircd's conf secret; `docker exec keycloak sh -c 'echo $KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL'` shows what the running container got. A recreate (`scripts/dc.sh up -d --force-recreate --no-deps keycloak`, ~45 s to healthy) is needed after an env change.
- Keycloak logs every send at INFO (`Sending admin event webhook to N endpoint(s): resourceType=USER, operationType=DELETE, path=users/<uuid>`) and every non-2xx or connection failure at WARN/ERROR (`Webhook to <url> attempt N failed` / `returned error: 4xx`); success itself is DEBUG only. Sends with no failure line = the ircd accepted them.
- On the ircd side, `log_write(LS_SYSTEM, L_INFO, ...)` lines DO reach `docker logs nefarious` (`SYSTEM [INFO]: WEBHOOK: Deauthing session for <nick> (account <a>): Account disabled`, `WEBHOOK: <reason>: id <id> name <name> -- invalidating caches`, the L_WARNING "nothing names the subject of id"); only L_DEBUG lines (`WEBHOOK: Event USER/...`, `nothing to do`) are not shown. So `docker logs nefarious --since 5m | grep WEBHOOK` is the delivery oracle once an event is one the handler acts on.
- `STATS webhook` from an oper is the other oracle (since plan 3, 2026-09-23): listener connections and bytes, events authenticated / processed / invalid / dropped, `Refused: N bad or missing signature, N replayed, N other realm, N plain-secret (transition)`, the last refusal's cause and age (`missing`, `malformed`, `stale`, `mismatch`, `replay`, `realm`), the handler's counters and the last event's age. A refused delivery shows up in Keycloak's WARN line as `returned error: 401` (signature) or `403` (realm), and opers on the `SNO_UNAUTH` mask get `WEBHOOK: request from <ip> rejected: <cause> (N rejections since boot)` once per cause per minute.
- The listener's port (9090) is NOT published on the host: post to the container's IP (`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' nefarious`, 172.29.0.2 today), which is what the test helper's `containerIp` does. A synthetic post needs the plain secret header AND the signature (`t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>`) and `realmName` = `testnet`; the secret is the ircd conf's (`ircd-webhook-secret` since 2026-09-23).
- `STATS webhook` also prints `Without realmName: N` (payloads accepted although they named no realm: a pre-signing SPI; a real event from the bed's SPI leaves it alone) and, when the last listener start failed (busy port, bad `vhost`), a first line `WEBHOOK listener NOT RUNNING (...)`; that failure is also announced to every oper on the general notice mask, and the next `REHASH` retries even with unchanged values.
- A rehash that changes only the secret logs `WEBHOOK: secret changed; listener and counters kept`; a rehash of the bed confs also logs `Webhook: WEBHOOK_PORT/WEBHOOK_SECRET features are deprecated; migrate to a Webhook {} block` (expected, the bed still uses the feature form). Edit `data/ircd*.conf` in place (never `sed -i`: each is a per-file bind mount, a rename-replace detaches the container from it).
- TRAP: `docker logs --since 2026-09-23T20:56:00` reads the timestamp as LOCAL time (EDT), not UTC; use relative windows (`--since 10m`).

## Docker Compose Commands

**Always use the `dc` shell function** instead of raw `docker compose`. It sources
`.env` and `.env.local` overrides automatically:

```bash
dc() {
    set -a
    [ -f .env ] && source .env
    [ -f .env.local ] && source .env.local
    set +a
    docker compose "$@"
}
```

Usage:
```bash
dc build x3              # Rebuild X3 (includes libkc)
dc up -d x3              # Restart X3
dc up -d keycloak        # Restart Keycloak
dc --profile linked up -d  # Start linked topology
dc down                  # Stop all
dc logs -f x3            # Follow X3 logs
```

## Rebuilding After Code Changes

Docker may cache build layers. After fixing C code:

```bash
# Rebuild and restart
dc build x3 && dc up -d x3

# Force full rebuild (no cache) if needed
dc build --no-cache x3
```

## Verify Fix Applied

```bash
# Check local changes exist
cd /home/ibutsu/testnet/x3 && git diff src/nickserv.c | head -30
```

## Known Issues

### Keycloak Webhook SPI: Silent Event Loss After X3 Downtime

**Symptom**: Keycloak stops sending webhook events (e.g., USER DELETE) after X3 has been unavailable for a period. Earlier webhook errors appear in logs, but no new events are dispatched even after X3 recovers.

**Location**: `keycloak-webhook-spi/src/main/java/net/afternet/keycloak/webhook/WebhookEventListenerProvider.java:305-306`

**Root Cause (theory)**: `sendWebhookAsync()` uses `CompletableFuture.runAsync()` which dispatches to the common `ForkJoinPool`. Each failed webhook triggers exponential backoff retries (1s, 2s, 4s... up to 30s cap, 3 retries default), blocking a pool thread for up to ~33s per event. If X3 is down during a burst of events, retry threads saturate the shared pool, causing subsequent `runAsync()` calls to be silently queued or dropped.

**No circuit breaker exists** - each event retries independently with no awareness of prior failures. The event filtering logic (`X3_RESOURCE_TYPES` at line 50-55) correctly includes USER/GROUP/GROUP_MEMBERSHIP/REALM_ROLE_MAPPING, so the issue is dispatch, not filtering.

**Fix direction** (not yet implemented):
- Replace `CompletableFuture.runAsync()` with a dedicated `ExecutorService` (bounded thread pool + bounded queue)
- Add a circuit breaker pattern: after N consecutive failures, pause dispatching and retry periodically
- Consider adding a dead-letter log for events that couldn't be delivered

**Workaround**: Restart Keycloak (`dc restart keycloak`) to reset the thread pool state.

## Service Recovery

```bash
# Restart single service
dc restart x3

# Full restart
dc down && dc up -d
```

## Trap: restarting the ircd containers alone can leave X3 exited

`scripts/dc.sh -l up -d --no-deps nefarious nefarious2` recreates the ircds; X3 retries its uplink a few times, logs "All available uplinks exhausted; giving up." and exits (1). Anything that talks to AuthServ afterwards (the test account pool's REGISTER on startup) waits a timeout per account. After an ircd deploy, `scripts/dc.sh up -d --no-deps x3` and wait for a fresh `W: DH Z x3.services` / EB in `docker logs --since 45s x3` (older lines match too, so limit the window).
