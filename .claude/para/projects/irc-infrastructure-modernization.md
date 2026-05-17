# IRC Infrastructure Modernization Plan

## Overview

This document outlines a comprehensive modernization strategy for the Nefarious IRCd and X3 services ecosystem. The goal is to add REST APIs, observability, fleet management capabilities, and enhanced integration between components while maintaining backward compatibility and operational stability.

## Goals

1. **Observability**: Add health checks and metrics endpoints for monitoring and alerting
2. **Fleet Management**: Enable centralized management of multiple IRC server deployments
3. **X3 Integration**: Expose X3 services functionality via REST API
4. **Shared Infrastructure**: Create reusable HTTP library for both components
5. **SASL Enhancement**: Support token lifecycle management with Keycloak integration

---

## Phase 1: Core HTTP Infrastructure

### 1.1 libirchttp Shared Library

Create a shared library abstracting HTTP server functionality that works with both Nefarious (custom event loop) and X3 (different event model).

**Features:**
- Embedded HTTP/1.1 server (no external dependencies beyond libcurl)
- Route registration with handler callbacks
- JSON request/response helpers
- Authentication middleware (API keys, bearer tokens)
- Rate limiting
- TLS support via OpenSSL (already a dependency)

**Event Loop Abstraction:**
```c
struct irchttp_loop_ops {
    int (*add_fd)(void *ctx, int fd, int events, void (*cb)(int fd, int events, void *data), void *data);
    int (*del_fd)(void *ctx, int fd);
    int (*add_timer)(void *ctx, unsigned int ms, void (*cb)(void *data), void *data);
};
```

### 1.2 Nefarious Integration

Add HTTP listener to Nefarious using ioset for event handling:
- Port configuration in `features {}` block
- Bind to localhost by default (security)
- Optional TLS with configurable cert/key paths

### 1.3 X3 Integration

X3 already has libcurl for Keycloak - extend for HTTP server:
- Integrate with X3's event loop
- Share TLS configuration with existing Keycloak client

---

## Phase 2: Health and Metrics Endpoints

### 2.1 Nefarious Endpoints

**GET /health**
```json
{
  "status": "healthy",
  "uptime_seconds": 86400,
  "server_name": "testnet.fractalrealities.net",
  "version": "2.0.0",
  "checks": {
    "event_loop": "ok",
    "memory": "ok",
    "connections": "ok"
  }
}
```

**GET /metrics** (Prometheus format)
```
# HELP irc_connections_total Total connections since startup
# TYPE irc_connections_total counter
irc_connections_total 12345

# HELP irc_connections_current Current active connections
# TYPE irc_connections_current gauge
irc_connections_current 42

# HELP irc_channels_total Total registered channels
# TYPE irc_channels_total gauge
irc_channels_total 156

# HELP irc_messages_total Messages processed
# TYPE irc_messages_total counter
irc_messages_total{type="privmsg"} 98765
irc_messages_total{type="notice"} 4321

# HELP irc_server_links Current server links
# TYPE irc_server_links gauge
irc_server_links 3
```

### 2.2 X3 Endpoints

**GET /health**
```json
{
  "status": "healthy",
  "uptime_seconds": 86400,
  "services": {
    "authserv": "connected",
    "chanserv": "connected",
    "opserv": "connected"
  },
  "backends": {
    "keycloak": "connected",
    "lmdb": "ok"
  }
}
```

**GET /metrics**
```
# HELP x3_accounts_total Registered accounts
# TYPE x3_accounts_total gauge
x3_accounts_total 1234

# HELP x3_channels_total Registered channels
# TYPE x3_channels_total gauge
x3_channels_total 89

# HELP x3_auth_attempts_total Authentication attempts
# TYPE x3_auth_attempts_total counter
x3_auth_attempts_total{result="success"} 5678
x3_auth_attempts_total{result="failure"} 123

# HELP x3_keycloak_requests_total Keycloak API requests
# TYPE x3_keycloak_requests_total counter
x3_keycloak_requests_total{endpoint="token"} 100
x3_keycloak_requests_total{endpoint="users"} 500

# HELP x3_keycloak_latency_seconds Keycloak request latency
# TYPE x3_keycloak_latency_seconds histogram
x3_keycloak_latency_seconds_bucket{le="0.1"} 400
x3_keycloak_latency_seconds_bucket{le="0.5"} 480
x3_keycloak_latency_seconds_bucket{le="1.0"} 495
x3_keycloak_latency_seconds_bucket{le="+Inf"} 500
```

---

## Phase 3: Fleet Management API

### 3.1 Nefarious Fleet Endpoints

**GET /api/v1/server**
```json
{
  "name": "testnet.fractalrealities.net",
  "numeric": "AA",
  "description": "Testnet Hub",
  "version": "2.0.0",
  "start_time": "2025-01-01T00:00:00Z",
  "features": ["CAP_chathistory", "CAP_metadata", "CAP_multiline"]
}
```

**GET /api/v1/links**
```json
{
  "links": [
    {
      "server": "leaf.fractalrealities.net",
      "numeric": "AB",
      "hops": 1,
      "lag_ms": 5,
      "users": 100,
      "connected_since": "2025-01-01T00:00:00Z"
    }
  ]
}
```

**POST /api/v1/rehash**
```json
{
  "result": "success",
  "config_loaded": "2025-01-14T12:00:00Z"
}
```

**POST /api/v1/squit** (with appropriate auth)
```json
{
  "server": "leaf.fractalrealities.net",
  "reason": "Maintenance"
}
```

### 3.2 Authentication

API key authentication for fleet management endpoints:
```
Authorization: Bearer <api-key>
```

Keys configured in ircd.conf with optional IP restrictions and permission scopes.

---

## Phase 4: X3 REST API

### 4.1 Account Management

**GET /api/v1/accounts/{account}**
```json
{
  "account": "testuser",
  "email": "test@example.com",
  "registered": "2025-01-01T00:00:00Z",
  "last_seen": "2025-01-14T10:00:00Z",
  "flags": ["AUTHED"],
  "channels": [
    {"channel": "#test", "access": 500}
  ]
}
```

**POST /api/v1/accounts** (create account)
```json
{
  "account": "newuser",
  "password": "secure123",
  "email": "new@example.com"
}
```

**DELETE /api/v1/accounts/{account}** (with admin auth)

### 4.2 Channel Management

**GET /api/v1/channels/{channel}**
```json
{
  "channel": "#test",
  "registered": "2025-01-01T00:00:00Z",
  "owner": "testuser",
  "topic": "Test channel",
  "flags": ["AUTOOP"],
  "users": [
    {"account": "testuser", "access": 500},
    {"account": "helper", "access": 200}
  ]
}
```

**POST /api/v1/channels/{channel}/users**
```json
{
  "account": "newhelper",
  "access": 200
}
```

### 4.3 Keycloak Integration Status

**GET /api/v1/keycloak/status**
```json
{
  "connected": true,
  "realm": "irc",
  "last_token_refresh": "2025-01-14T11:55:00Z",
  "pending_sync_operations": 0,
  "cache_stats": {
    "jwks_age_seconds": 1800,
    "user_cache_size": 150,
    "auth_failure_cache_size": 5
  }
}
```

---

## Phase 5: SASL Re-authentication Support

### 5.1 Background

With deep X3/Keycloak integration, accounts may need to handle token lifecycle events:

- **Token Expiry**: OAUTHBEARER tokens have limited lifetime
- **Token Revocation**: Admin revokes access in Keycloak
- **Forced Re-auth**: Security policy requires periodic re-authentication
- **Session Binding**: Associate IRC session with Keycloak session

### 5.2 Current State

Nefarious IRCd already supports SASL re-authentication (AUTHENTICATE after initial auth). However:
- X3's AUTH command rejects re-auth when `user->handle_info` is already set
- No mechanism to notify client that re-auth is needed
- No session binding between IRC and Keycloak

### 5.3 Proposed Enhancements

**5.3.1 X3 SASL Re-auth Support**

Modify X3 to accept SASL re-authentication:
- If `handle_info` matches, update token/session info
- If `handle_info` differs, either reject or allow account switch (configurable)
- Log re-auth events for audit trail

**5.3.2 Token Expiry Notification**

When Keycloak token approaches expiry or is revoked:
```
NOTICE <nick> :*** Your session token expires in 5 minutes. Please re-authenticate.
```

Or use IRCv3 standard-replies:
```
FAIL * TOKEN_EXPIRING :Your authentication token expires soon
```

**5.3.3 Forced Disconnect on Revocation**

If Keycloak token is revoked and re-auth fails/times out:
```
ERROR :Closing link: (user@host) [Authentication token revoked]
```

**5.3.4 Configuration Options**

```
"nickserv" {
    "sasl_reauth_enabled" "1";           // Allow SASL re-authentication
    "sasl_reauth_account_switch" "0";    // Reject if different account
    "token_expiry_warning_mins" "5";     // Warn N minutes before expiry
    "token_expiry_grace_mins" "10";      // Grace period after expiry
    "revocation_check_interval" "60";    // Check revocation every N seconds
};
```

### 5.4 Implementation Notes

The Keycloak integration already tracks tokens internally. Key changes needed:

1. **Periodic token validation**: Background check if tokens are still valid
2. **Re-auth state machine**: Handle SASL AUTHENTICATE when already authed
3. **Graceful degradation**: If Keycloak unreachable, extend grace period
4. **Audit logging**: Track re-auth events, revocations, forced disconnects

---

## Phase 6: WebSocket Enhancements

### 6.1 REST over WebSocket

For web clients, allow REST API calls over existing WebSocket connection:
```json
{"type": "api", "method": "GET", "path": "/api/v1/channels/#test"}
```

Response:
```json
{"type": "api_response", "status": 200, "body": {...}}
```

### 6.2 Real-time Events

Push events to connected WebSocket clients:
```json
{"type": "event", "event": "channel_update", "channel": "#test", "data": {...}}
```

---

## Phase 7: Deployment and Operations

### 7.1 Docker Integration

Add health check to docker-compose.yml:
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8081/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

### 7.2 Prometheus/Grafana

Sample Grafana dashboard covering:
- Connection rates and current connections
- Message throughput by type
- Authentication success/failure rates
- Keycloak latency percentiles
- Server link status

### 7.3 Alerting Rules

```yaml
groups:
  - name: irc
    rules:
      - alert: IRCServerDown
        expr: up{job="nefarious"} == 0
        for: 1m
        labels:
          severity: critical

      - alert: KeycloakLatencyHigh
        expr: histogram_quantile(0.99, x3_keycloak_latency_seconds_bucket) > 5
        for: 5m
        labels:
          severity: warning

      - alert: AuthFailureSpike
        expr: rate(x3_auth_attempts_total{result="failure"}[5m]) > 10
        for: 2m
        labels:
          severity: warning
```

---

## Phase 8: Security Considerations

### 8.1 API Authentication

- API keys stored hashed (like oper passwords)
- Optional IP whitelist per key
- Scope-based permissions (read-only, admin, fleet-management)
- Rate limiting per key

### 8.2 Network Security

- HTTP endpoints bind localhost by default
- Explicit configuration required for external access
- TLS required for non-localhost bindings
- Separate ports for internal vs external APIs

### 8.3 Audit Logging

All API calls logged with:
- Timestamp
- Source IP
- API key identifier (not the key itself)
- Endpoint and method
- Response status
- Request duration

---

## Implementation Roadmap

| Phase | Description | Dependencies | Estimated Effort |
|-------|-------------|--------------|------------------|
| 1 | libirchttp shared library | None | High |
| 2 | Health and metrics endpoints | Phase 1 | Medium |
| 3 | Fleet management API | Phase 1, 2 | Medium |
| 4 | X3 REST API | Phase 1 | High |
| 5 | SASL re-auth support | Keycloak integration | Medium |
| 6 | WebSocket enhancements | Phase 1, 4 | Medium |
| 7 | Deployment tooling | Phase 2 | Low |
| 8 | Security hardening | All phases | Medium |

---

## References

- [IRCv3 Specifications](https://ircv3.net/)
- [Prometheus Metrics Format](https://prometheus.io/docs/concepts/data_model/)
- [Keycloak Admin REST API](https://www.keycloak.org/docs-api/latest/rest-api/)
- [RFC 7628 - SASL OAUTHBEARER](https://tools.ietf.org/html/rfc7628)
