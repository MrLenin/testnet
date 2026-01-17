# Keycloak Webhook

Real-time cache invalidation for X3 Services via Keycloak webhooks.

## Overview

The Keycloak webhook listener allows X3 to receive real-time notifications when users change their passwords or attributes in Keycloak. This eliminates polling latency and ensures immediate cache consistency.

## Architecture

```
┌──────────────┐
│   Keycloak   │
│ Event System │
└──────┬───────┘
       │ HTTP POST
       ▼
┌──────────────┐
│ X3 Webhook   │
│  Listener    │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Cache Invalidation │
│ - User cache       │
│ - Session tokens   │
│ - SCRAM creds      │
└──────────────┘
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `keycloak_webhook_port` | 0 | HTTP listener port (0 = disabled) |
| `keycloak_webhook_secret` | "" | Shared secret for authentication |
| `keycloak_webhook_bind` | "" | Bind address (empty = all interfaces) |

**x3.conf example**:
```
"nickserv" {
    "keycloak_enable" = "1";
    "keycloak_webhook_port" = "8088";
    "keycloak_webhook_secret" = "your-shared-secret-here";
    "keycloak_webhook_bind" = "127.0.0.1";  // Local only
};
```

## Webhook Protocol

**Endpoint**: `POST /webhook`

**Headers**:
- `X-Webhook-Secret`: Shared secret for authentication
- `Content-Type`: `application/json`

**Payload**:
```json
{
  "type": "UPDATE_PASSWORD",
  "userId": "keycloak-uuid",
  "username": "accountname",
  "realmId": "realm-uuid"
}
```

## Supported Event Types

| Event | Action |
|-------|--------|
| `UPDATE_PASSWORD` | Invalidate user cache, session tokens, SCRAM credentials |
| `UPDATE_PROFILE` | Invalidate user representation cache |
| `UPDATE_EMAIL` | Invalidate user cache |

## Keycloak Configuration

### Event Listener Setup

1. In Keycloak Admin Console, go to **Realm Settings** > **Events**
2. Add an event listener for webhooks
3. Configure the webhook URL: `http://x3-host:8088/webhook`
4. Set the shared secret header

### Example SPI Configuration

For custom Keycloak event listener:

```java
@Override
public void onEvent(Event event) {
    if (event.getType() == EventType.UPDATE_PASSWORD) {
        sendWebhook("UPDATE_PASSWORD", event.getUserId());
    }
}

private void sendWebhook(String type, String userId) {
    // POST to X3 webhook endpoint
}
```

## Security Considerations

1. **Shared Secret**: Always use a strong, random secret
2. **Network Isolation**: Bind to localhost or internal network only
3. **TLS**: Use reverse proxy with TLS in production
4. **Firewall**: Only allow Keycloak server IP

## Monitoring

OpServ `KEYCLOAK` command shows webhook statistics:

```
/msg O3 KEYCLOAK
Webhook: Running on port 8088
  Events received: 1,234
  Invalidations: 1,189
  Auth failures: 2
  Errors: 0
```

## Without Webhook

If webhook is not configured, X3 uses polling-based cache invalidation:

- User cache TTL: Controlled by `keycloak_user_cache_ttl`
- Default: 300 seconds (5 minutes)
- Password changes may not be recognized for up to TTL duration

## Build Requirements

Webhook support is included when Keycloak is enabled:

```bash
./configure --with-keycloak
```

---

*Part of the X3 Services IRCv3.2+ upgrade project.*
