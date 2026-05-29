# Service Debugging Skill

When debugging issues in the testnet environment, always check logs from ALL three services: X3, Nefarious, and Keycloak. Issues often span multiple services.

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
