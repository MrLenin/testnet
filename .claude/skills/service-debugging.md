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

## Rebuilding After Code Changes

Docker may cache build layers. After fixing C code:

```bash
# Force full rebuild (no cache)
docker compose build --no-cache x3

# Restart
docker compose up -d x3
```

## Verify Fix Applied

```bash
# Check local changes exist
cd /home/ibutsu/testnet/x3 && git diff src/nickserv.c | head -30
```

## Service Recovery

```bash
# Restart single service
docker compose restart x3

# Full restart
docker compose down && docker compose up -d
```
