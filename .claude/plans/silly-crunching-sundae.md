# IRC Infrastructure Modernization Plan

## Executive Summary

This proposal outlines a strategic modernization of the Afternet IRC infrastructure, transforming it from a manually-operated legacy system into a cloud-native, self-healing platform. The investment delivers measurable operational improvements while positioning Afternet for sustainable growth.

### The Business Case

**Current State Challenges:**
- Server outages detected only after user complaints (average 15-45 minute detection delay)
- Capacity planning based on guesswork; no visibility into actual resource utilization
- Manual intervention required for all scaling operations
- Account management fragmented between IRC and identity systems
- Operational knowledge concentrated in few individuals (bus factor risk)

**Target State Benefits:**

| Benefit | Impact |
|---------|--------|
| Automated outage detection | 15-45 min → < 2 min detection time |
| Proactive capacity management | Prevent 80%+ of capacity-related outages |
| Self-healing infrastructure | Automatic traffic drain from degraded servers |
| Elastic scaling | Add/remove capacity based on actual demand |
| Full-stack visibility | IRC + Services + Identity + Database in one dashboard |
| Unified identity management | Single source of truth, reduced admin overhead |
| Reduced operational burden | Fewer pages, less manual intervention |

### Strategic Value

1. **Operational Excellence** - Industry-standard monitoring eliminates reactive firefighting
2. **Cost Optimization** - Right-size infrastructure to actual demand instead of over-provisioning
3. **Risk Reduction** - Automated responses prevent small issues from becoming outages
4. **Modern Platform** - Foundation for web-based administration and third-party integrations

### Investment Summary

This modernization builds on **existing infrastructure investments**:
- X3's async HTTP client and webhook system (already implemented)
- Nefarious's WebSocket HTTP parsing (already implemented)
- Keycloak identity platform (already deployed)
- Proven P10 server-to-server protocol (battle-tested)

The incremental effort adds REST APIs to expose internal state, enabling orchestration without architectural rewrites.

### What Success Looks Like

**After Implementation:**
- Single Grafana dashboard shows IRC servers, X3, Keycloak cluster, and PostgreSQL health
- PagerDuty alerts operators *before* users notice problems—at any layer
- A failing IRC server automatically drains traffic to healthy nodes
- Keycloak node failure is transparent; cluster continues serving auth
- Database replication lag triggers alerts before it impacts authentication
- New IRC capacity spins up automatically during high-traffic events
- Administrators manage accounts and channels from a web browser
- User account lifecycle flows automatically from Keycloak to IRC

### Risk Mitigation

| Risk | Current | After Modernization |
|------|---------|---------------------|
| Undetected server degradation | Manual monitoring, user complaints | Automatic detection + alerting |
| Capacity exhaustion | Guesswork, over-provisioning | Metrics-driven auto-scaling |
| Single points of failure | Manual failover | Automated traffic redistribution |
| Key person dependency | Tribal knowledge | Self-documenting APIs + dashboards |
| Identity sync issues | Manual account management | Automated Keycloak ↔ IRC sync |
| Keycloak outage | Auth fails, no visibility | Clustered HA, proactive alerting |
| Database issues | Silent until cascade failure | Connection pool, replication, query monitoring |

### Implementation Milestones

| Phase | Deliverable | Business Value |
|-------|-------------|----------------|
| 1 | X3 Keycloak webhook handlers | Automated user lifecycle, security compliance |
| 2 | X3 REST API (read-only) | Web admin foundation, bot integration ready |
| 3 | X3 REST API (full CRUD) | Complete web administration capability |
| 4 | Shared HTTP library | Reduced maintenance, code reuse |
| 5 | Nefarious health/metrics | Full fleet observability, auto-scaling ready |
| 6-7 | Library integration | Unified codebase, simplified operations |
| 8 | Web Admin UI | Browser-based IRC administration |

### Competitive Context

Modern communication platforms (Discord, Slack, Teams) offer:
- Real-time dashboards and analytics
- API-first administration
- Single sign-on with enterprise identity providers
- Self-service user management

**This modernization brings IRC to feature parity** with contemporary platforms while preserving IRC's unique advantages: open protocol, federation capability, and 30+ years of stability.

Networks that don't modernize face:
- Increasing operational burden as infrastructure ages
- Difficulty recruiting operators familiar with legacy tooling
- Competitive disadvantage against platforms with better admin UX

---

## Part I: The Observability Layer

> *"You can't manage what you can't measure."* — Peter Drucker

### 1.1 Why Observability Matters

Every modern platform—from cloud providers to streaming services—treats observability as table stakes. IRC predates this paradigm, but the operational challenges are identical:

| Without Observability | With Observability |
|-----------------------|--------------------|
| Learn about problems from angry users | Detect problems before users notice |
| Guess at capacity needs | Data-driven scaling decisions |
| Firefight during outages | Prevent outages proactively |
| Manual health checks | Automated monitoring + alerting |

**The Technical Approach:**
Every Nefarious instance exposes HTTP endpoints that external systems can query. This enables integration with industry-standard tools (Prometheus, Grafana, PagerDuty, Kubernetes) without modifying the IRC protocol itself.

### 1.2 Nefarious Health Endpoints

Each Nefarious server exposes its own REST API. In a multi-server network, each instance is monitored independently—there is no single point of aggregation within the IRC layer.

#### Health Check (`GET /health`)

The health endpoint answers a simple question: should this server receive traffic?

```json
{
  "status": "healthy",
  "server_name": "hub.afternet.org",
  "server_numeric": "AB",
  "uptime_seconds": 86400,
  "memory_percent": 0.45,
  "fd_percent": 0.12,
  "client_percent": 0.67
}
```

**Response Codes:**
- `200 OK` - Server is healthy, accept new connections
- `503 Service Unavailable` - Server is degraded or unhealthy, drain traffic

**Status Determination:**

| Condition | Status |
|-----------|--------|
| All metrics nominal | `healthy` |
| Any threshold exceeded but functional | `degraded` |
| Critical threshold or internal error | `unhealthy` |

**Configurable Thresholds:**
```
features {
  "REST_HEALTH_MEMORY_WARN" = "0.85";    # 85% → degraded
  "REST_HEALTH_MEMORY_CRIT" = "0.95";    # 95% → unhealthy
  "REST_HEALTH_FD_WARN" = "0.90";
  "REST_HEALTH_FD_CRIT" = "0.98";
  "REST_HEALTH_CLIENTS_WARN" = "0.90";
  "REST_HEALTH_CLIENTS_CRIT" = "0.98";
};
```

#### Readiness Check (`GET /health/ready`)

Distinct from liveness, readiness indicates whether the server should receive new IRC client connections:

```json
{
  "ready": true,
  "servers_connected": 3,
  "services_linked": true,
  "burst_complete": true,
  "warmup_elapsed": true
}
```

A server might be alive (responding to health checks) but not ready (still bursting after restart).

**Readiness Conditions:**
- `burst_complete` - Server has finished syncing state from network
- `services_linked` - X3 is connected and responding
- `warmup_elapsed` - Configurable delay after startup (default 30s)

#### Metrics (`GET /metrics`)

Prometheus-format metrics for time-series analysis and alerting:

```
# HELP ircd_clients_current Current number of connected clients
# TYPE ircd_clients_current gauge
ircd_clients_current 1247

# HELP ircd_clients_max Maximum client capacity
# TYPE ircd_clients_max gauge
ircd_clients_max 4096

# HELP ircd_connections_total Total connections since start
# TYPE ircd_connections_total counter
ircd_connections_total{type="client"} 89432
ircd_connections_total{type="server"} 47

# HELP ircd_bytes_total Bytes transferred
# TYPE ircd_bytes_total counter
ircd_bytes_total{direction="sent",type="client"} 1847293847
ircd_bytes_total{direction="recv",type="client"} 293847192
ircd_bytes_total{direction="sent",type="server"} 9283749182
ircd_bytes_total{direction="recv",type="server"} 8374918273

# System resources
ircd_memory_rss_bytes 134217728
ircd_memory_virtual_bytes 268435456
ircd_cpu_user_seconds_total 3847.23
ircd_cpu_system_seconds_total 1293.47
ircd_open_fds 1892
ircd_max_fds 16384

# Capacity indicators
ircd_sendq_bytes 2847293
ircd_recvq_bytes 183749

# Event loop health
ircd_event_loop_lag_seconds 0.002
ircd_dns_pending 12
ircd_auth_pending 3
```

### 1.3 Network Topology Endpoints

These require authentication as they reveal network structure:

#### Server List (`GET /servers`)
```json
[
  {
    "name": "hub.afternet.org",
    "numeric": "AB",
    "hop_count": 0,
    "users": 1247,
    "opers": 3,
    "linked_since": "2024-01-15T08:30:00Z",
    "flags": ["hub", "services"]
  },
  {
    "name": "leaf1.afternet.org",
    "numeric": "AC",
    "hop_count": 1,
    "users": 892,
    "opers": 1,
    "linked_since": "2024-01-15T08:31:00Z",
    "flags": []
  }
]
```

#### Listener Status (`GET /listeners`)
```json
[
  {
    "port": 6667,
    "address": "0.0.0.0",
    "ssl": false,
    "websocket": false,
    "connections": 423,
    "max_connections": 1024,
    "active": true
  },
  {
    "port": 6697,
    "address": "0.0.0.0",
    "ssl": true,
    "websocket": false,
    "connections": 824,
    "max_connections": 2048,
    "active": true
  }
]
```

### 1.4 Authentication Model

Health endpoints must work without authentication for load balancers and orchestrators. Sensitive endpoints require API keys.

| Endpoint | Authentication | Rationale |
|----------|---------------|-----------|
| `/health` | None | Load balancers need zero-config health checks |
| `/health/ready` | None | Orchestrator readiness probes |
| `/metrics` | Optional API key | Prevent unauthorized metrics scraping |
| `/servers` | API key required | Reveals network topology |
| `/listeners` | API key required | Reveals infrastructure details |

**Configuration:**
```
features {
  "REST_API_KEY" = "your-secret-key-here";
  "REST_METRICS_REQUIRE_AUTH" = "FALSE";  # Optional
  "REST_RATE_LIMIT" = "10";               # Requests per second per IP
  "REST_ALLOWED_IPS" = "10.0.0.0/8,192.168.0.0/16";  # Optional whitelist
};
```

---

## Part II: Fleet Management

> *Why care about fleet management?* Large IRC networks have always scaled horizontally—adding more servers as user counts grow. What's changed is the expectation: users now expect 99.9%+ uptime, instant failover, and zero-touch operations. Manual server management doesn't scale.

### 2.1 Full-Stack Monitoring Architecture

Production IRC infrastructure has three critical tiers, each requiring observability:

| Tier | Components | Failure Impact |
|------|------------|----------------|
| **IRC** | Nefarious servers | Users can't connect/chat |
| **Services** | X3 | No nick/channel management, no SASL |
| **Identity** | Keycloak cluster + PostgreSQL | Authentication completely fails |

The identity tier is often overlooked but is the most critical—if Keycloak or its database fails, **no new users can authenticate**. This plan treats all three tiers as first-class citizens.

```
                         ┌─────────────────────────────────────────┐
                         │           Monitoring Stack              │
                         │  ┌───────────┐  ┌───────────────┐       │
                         │  │Prometheus │  │ Alert Manager │       │
                         │  └─────┬─────┘  └───────┬───────┘       │
                         │        │                │               │
                         │  ┌─────┴────────────────┴─────┐         │
                         │  │    Grafana Dashboards      │         │
                         │  │  (IRC + Identity + DB)     │         │
                         │  └─────────────┬──────────────┘         │
                         │                │                        │
                         │  ┌─────────────┴──────────────┐         │
                         │  │      Auto-Scaler           │         │
                         │  └─────────────┬──────────────┘         │
                         └────────────────┼────────────────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                 │                                 │
        ▼                                 ▼                                 ▼
 ┌──────────────┐                  ┌──────────────┐                  ┌──────────────┐
 │ IRC TIER     │                  │ SERVICES     │                  │ IDENTITY     │
 ├──────────────┤                  ├──────────────┤                  ├──────────────┤
 │ nefarious1   │                  │     X3       │                  │  Keycloak    │
 │ nefarious2   │◄────── P10 ─────►│  (services)  │◄──── HTTP ──────►│  Cluster     │
 │ nefarious3   │                  │              │                  │  (2+ nodes)  │
 │ ...          │                  │ :8081/health │                  │              │
 │              │                  │ :8081/metrics│                  │ :8080/health │
 │ :8080/health │                  └──────────────┘                  │ :8080/metrics│
 │ :8080/metrics│                                                    └──────┬───────┘
 └──────────────┘                                                           │
                                                                            ▼
                                                               ┌────────────────────────┐
                                                               │   PostgreSQL Cluster   │
                                                               │   (Primary + Replica)  │
                                                               │                        │
                                                               │  :5432 (connections)   │
                                                               │  :9187 (pg_exporter)   │
                                                               └────────────────────────┘
```

### 2.2 Identity Tier: Keycloak Clustering

For production deployments, Keycloak runs as a cluster with shared PostgreSQL storage. This eliminates single points of failure in the authentication path.

#### Keycloak Cluster Architecture

```
                    ┌─────────────────────────────┐
                    │      Load Balancer          │
                    │   (HAProxy / nginx / k8s)   │
                    │                             │
                    │   sticky sessions or        │
                    │   shared infinispan cache   │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
              ▼                    ▼                    ▼
       ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
       │ Keycloak 1  │      │ Keycloak 2  │      │ Keycloak 3  │
       │             │◄────►│             │◄────►│             │
       │ :8080       │      │ :8080       │      │ :8080       │
       │ :9000/health│      │ :9000/health│      │ :9000/health│
       └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
              │    Infinispan      │   cluster          │
              │    (session sync)  │                    │
              └────────────────────┼────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   PostgreSQL (shared state)  │
                    │   - User accounts            │
                    │   - Realm configuration      │
                    │   - Client credentials       │
                    └──────────────────────────────┘
```

#### Keycloak Metrics (Built-in)

Keycloak 17+ exposes Prometheus metrics natively at `/metrics`:

```
# Authentication metrics
keycloak_logins_total{realm="afternet",provider="keycloak",result="success"} 89234
keycloak_logins_total{realm="afternet",provider="keycloak",result="failure"} 1247
keycloak_login_duration_seconds_bucket{realm="afternet",le="0.1"} 78234

# Session metrics
keycloak_active_sessions{realm="afternet"} 4523
keycloak_active_client_sessions{realm="afternet",client="x3"} 1892

# Cluster health
keycloak_infinispan_cluster_size 3
keycloak_infinispan_cache_hits_total{cache="sessions"} 892341
keycloak_infinispan_cache_misses_total{cache="sessions"} 1234

# JVM metrics (critical for capacity planning)
jvm_memory_used_bytes{area="heap"} 536870912
jvm_gc_pause_seconds_sum 12.34
jvm_threads_current 150
```

### 2.3 Database Tier Monitoring

The database backing Keycloak is the foundation of the identity system. Database issues cascade to authentication failures, making it critical to monitor proactively.

> *Note: Examples use PostgreSQL (Keycloak's recommended database), but the monitoring patterns apply to MySQL/MariaDB deployments as well.*

#### PostgreSQL Metrics (via postgres_exporter)

```
# Connection pool health
pg_stat_activity_count{datname="keycloak",state="active"} 45
pg_stat_activity_count{datname="keycloak",state="idle"} 55
pg_settings_max_connections 200

# Query performance
pg_stat_statements_seconds_total{queryid="12345"} 123.45
pg_stat_user_tables_seq_scan{relname="user_entity"} 1234
pg_stat_user_tables_idx_scan{relname="user_entity"} 89234

# Replication lag (critical for HA)
pg_replication_lag_seconds 0.002

# Storage
pg_database_size_bytes{datname="keycloak"} 2147483648
pg_stat_user_tables_n_dead_tup{relname="user_entity"} 12345

# Transaction throughput
pg_stat_database_xact_commit{datname="keycloak"} 892341
pg_stat_database_xact_rollback{datname="keycloak"} 123
```

#### Database High Availability

Different databases have different HA approaches:

| Database | HA Solution | Notes |
|----------|-------------|-------|
| **PostgreSQL** | Patroni + Consul/etcd | Standard approach; PostgreSQL lacks built-in HA |
| **MySQL/MariaDB** | Group Replication, Galera | Built-in multi-master options |
| **CockroachDB** | Built-in | Distributed by design |

For PostgreSQL deployments, Patroni with a distributed consensus backend (Consul, etcd, or ZooKeeper) is the established approach. The examples below use Patroni + Consul.

```
                    ┌─────────────────────────────┐
                    │       PgBouncer             │
                    │   (connection pooling)      │
                    │   Consul-aware routing      │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │         Consul Cluster       │
                    │   (existing infrastructure)  │
                    │                              │
                    │   - Service discovery        │
                    │   - Leader election          │
                    │   - Health checks            │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
              ▼                    ▼                    ▼
       ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
       │ PostgreSQL  │      │ PostgreSQL  │      │ PostgreSQL  │
       │ + Patroni   │◄────►│ + Patroni   │◄────►│ + Patroni   │
       │  (leader)   │      │ (replica)   │      │ (replica)   │
       │ :5432/:9187 │      │ :5432/:9187 │      │ :5432/:9187 │
       │ :8008/api   │      │ :8008/api   │      │ :8008/api   │
       └─────────────┘      └─────────────┘      └─────────────┘
```

**Architecture:**
- Patroni handles leader election via Consul's distributed consensus
- Automatic failover typically completes in < 30 seconds
- PgBouncer routes connections via Consul DNS (`primary.postgresql.service.consul`)
- REST API on :8008 exposes cluster state and Prometheus metrics
- Using existing Consul cluster (shared with PowerDNS, Kea, etc.) keeps operational complexity flat

**Patroni Metrics (via REST API or prometheus endpoint):**
```
# Cluster state
patroni_cluster_size 3
patroni_master 1
patroni_replica 2
patroni_sync_standby 1

# Replication health
patroni_xlog_location{role="master"} 0/12345678
patroni_xlog_received_location{role="replica"} 0/12345670
patroni_replication_lag_bytes 8
```

**Consul Service Registration:**
```json
{
  "service": {
    "name": "postgresql",
    "tags": ["primary", "patroni"],
    "port": 5432,
    "check": {
      "http": "http://localhost:8008/health",
      "interval": "10s"
    }
  }
}
```

**PgBouncer with Consul DNS:**
```ini
[databases]
keycloak = host=primary.postgresql.service.consul port=5432 dbname=keycloak
```

### 2.4 Full-Stack Alerting Rules

```yaml
groups:
- name: identity-infrastructure
  rules:
  # Keycloak cluster health
  - alert: KeycloakNodeDown
    expr: up{job="keycloak"} == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Keycloak node {{ $labels.instance }} is down"

  - alert: KeycloakClusterDegraded
    expr: keycloak_infinispan_cluster_size < 3
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Keycloak cluster has only {{ $value }} nodes"

  - alert: KeycloakAuthLatencyHigh
    expr: histogram_quantile(0.99, keycloak_login_duration_seconds_bucket) > 2
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Keycloak p99 auth latency is {{ $value }}s"

  - alert: KeycloakHeapPressure
    expr: jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"} > 0.85
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Keycloak heap usage at {{ $value | humanizePercentage }}"

- name: database-infrastructure
  rules:
  # PostgreSQL health
  - alert: PostgreSQLDown
    expr: pg_up == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "PostgreSQL {{ $labels.instance }} is down"

  - alert: PostgreSQLReplicationLag
    expr: pg_replication_lag_seconds > 30
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "PostgreSQL replication lag is {{ $value }}s"

  - alert: PostgreSQLConnectionsHigh
    expr: pg_stat_activity_count / pg_settings_max_connections > 0.80
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "PostgreSQL at {{ $value | humanizePercentage }} connection capacity"

  - alert: PostgreSQLDeadTuples
    expr: pg_stat_user_tables_n_dead_tup > 100000
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Table {{ $labels.relname }} needs VACUUM ({{ $value }} dead tuples)"

  - alert: PostgreSQLSlowQueries
    expr: rate(pg_stat_statements_seconds_total[5m]) > 1
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Slow queries detected on PostgreSQL"

  # Patroni cluster health
  - alert: PatroniNoLeader
    expr: sum(patroni_master) == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Patroni cluster has no leader"

  - alert: PatroniClusterDegraded
    expr: patroni_cluster_size < 2
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Patroni cluster has only {{ $value }} nodes"

  - alert: PatroniFailoverRecent
    expr: changes(patroni_master[10m]) > 0
    labels:
      severity: info
    annotations:
      summary: "Patroni failover occurred in the last 10 minutes"
```

### 2.5 IRC Auto-Scaling Strategies

The health and metrics endpoints enable intelligent scaling decisions:

#### Horizontal Scaling (Add/Remove Servers)

**Scale Up Triggers:**
```yaml
# When average client capacity exceeds 70% across fleet
- alert: IRCFleetHighCapacity
  expr: avg(ircd_clients_current / ircd_clients_max) > 0.70
  for: 10m
  annotations:
    action: "Spin up new leaf server"

# When any server is degraded for extended period
- alert: IRCServerDegraded
  expr: ircd_health_status == 1  # 1 = degraded
  for: 15m
  annotations:
    action: "Investigate or replace server"
```

**Scale Down Triggers:**
```yaml
# When fleet is under-utilized
- alert: IRCFleetLowCapacity
  expr: avg(ircd_clients_current / ircd_clients_max) < 0.20
  for: 1h
  annotations:
    action: "Consider removing a leaf server"
```

#### Vertical Scaling (Resource Allocation)

```yaml
# Memory pressure building
- alert: IRCServerMemoryPressure
  expr: ircd_memory_rss_bytes / ircd_memory_limit_bytes > 0.80
  for: 5m
  annotations:
    action: "Increase container memory limit"

# File descriptor exhaustion approaching
- alert: IRCServerFDPressure
  expr: ircd_open_fds / ircd_max_fds > 0.85
  for: 5m
  annotations:
    action: "Increase ulimit or scale horizontally"
```

### 2.3 Load Balancer Integration

Health endpoints integrate with load balancers to route client connections:

**HAProxy Configuration:**
```haproxy
backend irc_servers
    mode tcp
    balance leastconn
    option httpchk GET /health/ready
    http-check expect status 200

    server hub1 hub.afternet.org:6697 check port 8080 inter 5s fall 3 rise 2
    server leaf1 leaf1.afternet.org:6697 check port 8080 inter 5s fall 3 rise 2
    server leaf2 leaf2.afternet.org:6697 check port 8080 inter 5s fall 3 rise 2
```

**Kubernetes Service:**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: irc-client
spec:
  type: LoadBalancer
  selector:
    app: nefarious
  ports:
  - port: 6697
    targetPort: 6697
---
# Headless service for Prometheus discovery
apiVersion: v1
kind: Service
metadata:
  name: irc-metrics
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
spec:
  clusterIP: None
  selector:
    app: nefarious
  ports:
  - port: 8080
    targetPort: 8080
```

### 2.4 Graceful Degradation

When a server becomes degraded, the system responds progressively:

1. **Detection** - Health check returns `degraded` status
2. **Traffic Shift** - Load balancer reduces new connection routing
3. **Alerting** - Operators notified of degradation
4. **Recovery** - If condition clears, server returns to full rotation
5. **Escalation** - If degradation persists, consider replacement

**Drain Procedure:**
```bash
# Mark server for maintenance (returns 503)
curl -X POST http://server:8080/admin/drain -H "X-API-Key: $KEY"

# Wait for connections to naturally close
while [ $(curl -s http://server:8080/metrics | grep ircd_clients_current | awk '{print $2}') -gt 0 ]; do
  sleep 30
done

# Proceed with maintenance
```

---

## Part III: X3 Services Integration

> *The operational reality:* Most IRC administration happens through X3 services—registering accounts, managing channels, handling abuse. Today, this requires IRC access and memorizing service commands. A REST API unlocks web-based administration, mobile management apps, and bot integrations.

### 3.1 Building on Existing Investment

X3 already has significant HTTP infrastructure from the Keycloak optimization work—this isn't starting from zero:

| Component | Status | Location |
|-----------|--------|----------|
| Async curl_multi + ioset | ✅ Complete | `keycloak.c` |
| HTTP webhook listener | ✅ Complete | `keycloak_webhook.c` |
| JWT local validation | ✅ Complete | `keycloak.c` |
| LMDB caching layer | ✅ Complete | `x3_lmdb.c` |
| Positive auth cache | ✅ Complete | `nickserv.c` |

The foundation exists—we're extending the webhook listener into a full REST API.

### 3.2 X3 REST API

X3's REST API serves a different purpose than Nefarious's: it exposes IRC services data for web administration and bot integration.

#### Health & Metrics

X3 needs its own observability:

```json
GET /health
{
  "status": "healthy",
  "uptime_seconds": 172800,
  "memory_percent": 0.35,
  "ircd_connected": true,
  "keycloak_reachable": true,
  "lmdb_healthy": true
}
```

```
GET /metrics
# X3-specific metrics
x3_accounts_total 15234
x3_channels_total 892
x3_sasl_auth_total{mechanism="PLAIN",result="success"} 89234
x3_sasl_auth_total{mechanism="PLAIN",result="failure"} 1247
x3_sasl_auth_total{mechanism="EXTERNAL",result="success"} 2341
x3_keycloak_requests_total{endpoint="token",status="success"} 78234
x3_keycloak_requests_total{endpoint="introspect",status="success"} 12893
x3_keycloak_cache_hits_total{cache="authsuccess"} 67234
x3_keycloak_cache_misses_total{cache="authsuccess"} 11000
x3_keycloak_pending_requests 3
x3_lmdb_size_bytes 134217728
x3_event_loop_lag_seconds 0.001
```

#### Account Management

```
GET    /api/v1/accounts                    # List accounts (paginated)
GET    /api/v1/accounts/:account           # Account details
PUT    /api/v1/accounts/:account           # Update metadata
DELETE /api/v1/accounts/:account           # Delete (cascade)
```

#### Channel Management

```
GET    /api/v1/channels                    # List channels
GET    /api/v1/channels/:channel           # Channel details
PUT    /api/v1/channels/:channel           # Update settings
DELETE /api/v1/channels/:channel           # Drop channel

GET    /api/v1/channels/:channel/access             # List access
PUT    /api/v1/channels/:channel/access/:account    # Set access
DELETE /api/v1/channels/:channel/access/:account    # Remove access

GET    /api/v1/channels/:channel/bans      # List bans
POST   /api/v1/channels/:channel/bans      # Add ban
DELETE /api/v1/channels/:channel/bans/:id  # Remove ban
```

#### Network Operations (Oper Only)

```
GET    /api/v1/glines                      # List G-lines
POST   /api/v1/glines                      # Add G-line
DELETE /api/v1/glines/:mask                # Remove G-line
```

### 3.3 Authentication & Authorization

X3 REST API uses Keycloak tokens (the same system that handles SASL OAUTHBEARER):

```
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

**Authorization Levels:**

| opserv_level | Permissions |
|--------------|-------------|
| 0 (user) | Read/write own account, own channels |
| 200+ (oper) | Read all accounts/channels |
| 400+ (admin) | Full read/write access |
| 600+ (netadmin) | G-line management |

### 3.4 Webhook Handlers (Remaining Work)

Three webhook handlers need completion:

#### USER-DELETE (Critical)

When a user is deleted in Keycloak, cascade to X3:

```c
void handle_user_delete(json_t *event) {
    const char *username = get_username_from_event(event);
    struct handle_info *hi = get_handle_info(username);
    if (!hi) return;

    // Transfer or drop owned channels
    for (struct userData *ud = hi->channels; ud; ud = ud->u_next) {
        if (ud->access >= UL_OWNER) {
            struct chanData *cData = ud->channel;
            struct userData *successor = find_highest_access(cData, hi);
            if (successor && successor->access >= UL_COOWNER) {
                // Transfer ownership
                successor->access = UL_OWNER;
                log_module(CS_LOG, LOG_INFO, "Transferred %s to %s",
                          cData->channel->name, successor->handle->handle);
            } else {
                // No suitable successor, drop channel
                unregister_channel(cData, "Owner account deleted");
            }
        }
    }

    // Delete account
    nickserv_unregister(NULL, hi);

    // Clear all caches
    invalidate_all_user_caches(username);
}
```

#### SESSION-DELETE (Force Disconnect)

When Keycloak revokes a session, disconnect the user from IRC:

```c
void handle_session_delete(json_t *event) {
    const char *username = get_username_from_event(event);

    // Revoke X3 session tokens
    x3_lmdb_session_revoke_all(username);

    // Find and kill connected users
    struct handle_info *hi = get_handle_info(username);
    if (hi) {
        for (struct nick_info *ni = hi->nicks; ni; ni = ni->next) {
            struct userNode *user = GetUserH(ni->nick);
            if (user) {
                irc_kill(nickserv, user, "Session revoked by administrator");
            }
        }
    }
}
```

---

## Part IV: Shared Infrastructure

> *Technical debt prevention:* Rather than implementing HTTP twice (once in Nefarious, once in X3), we extract the proven code into a shared library. This reduces maintenance burden, ensures consistent behavior, and makes future enhancements benefit both projects.

### 4.1 libirchttp Library

Both Nefarious and X3 need HTTP client capabilities. Rather than duplicate code, we extract X3's proven async HTTP client into a shared library.

**The Business Case for Shared Code:**
- Single codebase to maintain instead of two
- Bug fixes and improvements apply to both projects
- Consistent HTTP behavior across the platform
- Easier onboarding for new contributors

**What's NOT Shared:**
- HTTP server code (each service has its own)
- Business logic (Keycloak JSON parsing stays in X3)

#### Repository Structure

```
github.com/evilnet/libirchttp/
├── CMakeLists.txt
├── include/irchttp/
│   ├── irchttp.h           # Convenience header
│   ├── client.h            # Async HTTP client
│   ├── request.h           # Request builder
│   ├── response.h          # Response handling
│   └── event_loop.h        # Event loop abstraction
├── src/
│   ├── client.c            # curl_multi integration
│   ├── handle_pool.c       # Connection pooling
│   ├── event_loop.c        # Common code
│   ├── event_loop_x3.c     # X3 ioset adapter
│   └── event_loop_nef.c    # Nefarious ircd_events adapter
└── tests/
```

#### Event Loop Abstraction

The key challenge: X3 uses `ioset`, Nefarious uses `ircd_events`. The abstraction provides a common interface:

```c
struct irchttp_event_loop {
    // Socket operations
    int (*add_socket)(int fd, int events, irchttp_socket_cb cb, void *data);
    void (*update_socket)(int fd, int events);
    void (*remove_socket)(int fd);

    // Timer operations
    void *(*add_timer)(long timeout_ms, irchttp_timer_cb cb, void *data);
    void (*cancel_timer)(void *handle);
};

// Factory functions for each backend
struct irchttp_event_loop *irchttp_event_loop_x3(void);
struct irchttp_event_loop *irchttp_event_loop_nefarious(void);
```

#### Client API

```c
// Create client with event loop backend
struct irchttp_client *client = irchttp_client_new(loop);

// Build request
struct irchttp_request *req = irchttp_request_new("POST", url);
irchttp_request_add_header(req, "Content-Type", "application/json");
irchttp_request_set_body(req, json_body, strlen(json_body));
irchttp_request_set_timeout(req, 30000);  // 30 seconds

// Execute async
irchttp_client_perform_async(client, req, my_callback, userdata);
```

---

## Part V: Implementation Roadmap

### Phase 1: X3 Webhook Completion

**Goal:** Complete Keycloak user lifecycle integration

**Work:**
1. USER-DELETE handler with channel ownership cascade
2. SESSION-DELETE handler with IRC KILL
3. USER-CREATE handler (optional pre-creation)

**Files:**
- `x3/src/keycloak_webhook.c` - Add handlers
- `x3/src/nickserv.c` - Add helper functions
- `x3/src/chanserv.c` - Expose ownership transfer

**Verification:**
```bash
# Delete user in Keycloak, verify X3 cascade
curl -X DELETE http://keycloak:8080/admin/realms/afternet/users/$USER_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Verify account gone
docker exec x3 x3 -c "PRIVMSG AuthServ :ACCOUNTINFO testuser"
```

### Phase 2: X3 REST API Foundation

**Goal:** HTTP router and read-only endpoints

**Work:**
1. Path-based router in webhook listener
2. JWT authentication middleware
3. GET endpoints for accounts, channels, glines

**Files:**
- `x3/src/keycloak_webhook.c` - Router
- `x3/src/x3_rest_api.c` - New file
- `x3/src/x3_rest_api.h` - New file

### Phase 3: X3 REST API Write Operations

**Goal:** Full CRUD with authorization

**Work:**
1. PUT/DELETE for accounts and channels
2. Access list management
3. G-line management
4. Audit logging

### Phase 4: libirchttp Core

**Goal:** Standalone HTTP client library

**Work:**
1. Create repository with CMake
2. Extract curl_multi code from X3
3. Implement X3 ioset adapter
4. Unit tests

### Phase 5: Nefarious REST API

**Goal:** Health checks and metrics for orchestration

**Work:**
1. `LISTEN_REST` flag in listener system
2. HTTP parser (reuse from websocket.c)
3. Health/metrics/topology endpoints
4. API key authentication

**Files:**
- `nefarious/include/listener.h` - LISTEN_REST flag
- `nefarious/ircd/listener.c` - REST connection handling
- `nefarious/ircd/ircd_rest.c` - New file
- `nefarious/include/ircd_rest.h` - New file

**Configuration:**
```
Port {
  port = 8080;
  rest;
  bind = "0.0.0.0";
};

features {
  "REST_API_KEY" = "change-me-in-production";
  "REST_HEALTH_MEMORY_WARN" = "0.85";
  "REST_HEALTH_MEMORY_CRIT" = "0.95";
};
```

### Phase 6: X3 libirchttp Migration

**Goal:** X3 uses shared library

**Work:**
1. Replace curl_multi code with libirchttp
2. Verify all Keycloak operations work
3. Run SASL test suite

### Phase 7: Nefarious libirchttp Integration

**Goal:** Nefarious can make outbound HTTP requests

**Work:**
1. Implement ircd_events adapter
2. Enable webhook notifications (optional)

### Phase 8: Web Admin UI (Future)

**Goal:** Browser-based IRC administration

**Work:**
1. React application with Keycloak OIDC
2. Account/channel management
3. Operator tools

---

## Part VI: Deployment Guide

### Container Configuration

#### Nefarious Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nefarious-hub
spec:
  replicas: 1  # Hubs are typically single instance
  template:
    spec:
      containers:
      - name: nefarious
        image: evilnet/nefarious:latest
        ports:
        - name: irc
          containerPort: 6667
        - name: irc-ssl
          containerPort: 6697
        - name: rest
          containerPort: 8080
        livenessProbe:
          httpGet:
            path: /health
            port: rest
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: rest
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
```

#### X3 Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: x3-services
spec:
  replicas: 1  # Only one X3 per network
  template:
    spec:
      containers:
      - name: x3
        image: evilnet/x3:latest
        ports:
        - name: rest
          containerPort: 8081
        livenessProbe:
          httpGet:
            path: /health
            port: rest
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: rest
          initialDelaySeconds: 5
          periodSeconds: 5
        env:
        - name: KEYCLOAK_URL
          value: "http://keycloak:8080"
        volumeMounts:
        - name: lmdb-data
          mountPath: /var/lib/x3
      volumes:
      - name: lmdb-data
        persistentVolumeClaim:
          claimName: x3-lmdb
```

#### Keycloak Cluster Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keycloak
spec:
  replicas: 3  # Minimum for HA
  template:
    spec:
      containers:
      - name: keycloak
        image: quay.io/keycloak/keycloak:latest
        args: ["start", "--optimized"]
        env:
        - name: KC_DB
          value: "postgres"
        - name: KC_DB_URL
          value: "jdbc:postgresql://postgresql:5432/keycloak"
        - name: KC_DB_USERNAME
          valueFrom:
            secretKeyRef:
              name: keycloak-db
              key: username
        - name: KC_DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: keycloak-db
              key: password
        - name: KC_CACHE
          value: "ispn"  # Infinispan for cluster cache
        - name: KC_CACHE_STACK
          value: "kubernetes"
        - name: KC_HEALTH_ENABLED
          value: "true"
        - name: KC_METRICS_ENABLED
          value: "true"
        ports:
        - name: http
          containerPort: 8080
        - name: management
          containerPort: 9000
        livenessProbe:
          httpGet:
            path: /health/live
            port: management
          initialDelaySeconds: 60
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: management
          initialDelaySeconds: 30
          periodSeconds: 5
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
```

#### PostgreSQL with Patroni + Consul

Patroni configuration for automatic failover using existing Consul cluster:

```yaml
# patroni.yml - deployed to each PostgreSQL node
scope: keycloak-cluster
name: postgresql-1  # unique per node

consul:
  host: consul.service.consul:8500
  register_service: true

restapi:
  listen: 0.0.0.0:8008
  connect_address: ${NODE_IP}:8008

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    postgresql:
      use_pg_rewind: true
      parameters:
        shared_preload_libraries: "pg_stat_statements"
        max_connections: 200
        shared_buffers: "256MB"
        wal_level: "replica"
        hot_standby: "on"
        max_wal_senders: 5
        max_replication_slots: 5
  initdb:
    - encoding: UTF8
    - data-checksums

postgresql:
  listen: 0.0.0.0:5432
  connect_address: ${NODE_IP}:5432
  data_dir: /var/lib/postgresql/data
  authentication:
    superuser:
      username: postgres
      password: ${POSTGRES_PASSWORD}
    replication:
      username: replicator
      password: ${REPLICATION_PASSWORD}
```

**Docker Compose (for testnet/development):**
```yaml
services:
  postgresql-1:
    image: postgres:15
    environment:
      PATRONI_SCOPE: keycloak-cluster
      PATRONI_NAME: postgresql-1
      PATRONI_CONSUL_HOST: consul:8500
    volumes:
      - pg1_data:/var/lib/postgresql/data
      - ./patroni.yml:/etc/patroni.yml
    command: patroni /etc/patroni.yml

  postgresql-2:
    image: postgres:15
    environment:
      PATRONI_SCOPE: keycloak-cluster
      PATRONI_NAME: postgresql-2
      PATRONI_CONSUL_HOST: consul:8500
    volumes:
      - pg2_data:/var/lib/postgresql/data
      - ./patroni.yml:/etc/patroni.yml
    command: patroni /etc/patroni.yml

  pgbouncer:
    image: pgbouncer/pgbouncer:latest
    environment:
      DATABASE_URL: "postgresql://postgres:password@primary.postgresql.service.consul:5432/keycloak"
    ports:
      - "6432:6432"
```

**Prometheus scrape for Patroni:**
```yaml
  - job_name: 'patroni'
    consul_sd_configs:
      - server: 'consul:8500'
        services: ['postgresql']
    relabel_configs:
      - source_labels: [__meta_consul_service]
        target_label: service
    metrics_path: /metrics
    # Patroni exposes metrics on :8008/metrics
    relabel_configs:
      - source_labels: [__address__]
        regex: '(.+):5432'
        replacement: '${1}:8008'
        target_label: __address__
```

### Prometheus Configuration

```yaml
scrape_configs:
  - job_name: 'nefarious'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: nefarious
        action: keep
      - source_labels: [__meta_kubernetes_pod_container_port_name]
        regex: rest
        action: keep
    metrics_path: /metrics

  - job_name: 'x3'
    static_configs:
      - targets: ['x3-services:8081']
    metrics_path: /metrics

  - job_name: 'keycloak'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: keycloak
        action: keep
    metrics_path: /metrics
    scheme: http
    tls_config:
      insecure_skip_verify: true

  - job_name: 'postgresql'
    static_configs:
      - targets: ['postgresql:9187']
    metrics_path: /metrics
```

### Full-Stack Alerting Rules

See Section 2.4 for complete alerting rules. Summary of critical alerts:

```yaml
groups:
- name: irc-infrastructure
  rules:
  # IRC Tier
  - alert: IRCServerUnhealthy
    expr: ircd_health_status == 2
    for: 1m
    labels: { severity: critical }

  - alert: IRCServerDegraded
    expr: ircd_health_status == 1
    for: 10m
    labels: { severity: warning }

  - alert: IRCHighClientLoad
    expr: ircd_clients_current / ircd_clients_max > 0.85
    for: 5m
    labels: { severity: warning }

- name: identity-infrastructure
  rules:
  # Keycloak Tier
  - alert: KeycloakNodeDown
    expr: up{job="keycloak"} == 0
    for: 1m
    labels: { severity: critical }

  - alert: KeycloakClusterDegraded
    expr: keycloak_infinispan_cluster_size < 3
    for: 5m
    labels: { severity: warning }

  - alert: KeycloakHeapPressure
    expr: jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"} > 0.85
    for: 10m
    labels: { severity: warning }

- name: database-infrastructure
  rules:
  # PostgreSQL Tier
  - alert: PostgreSQLDown
    expr: pg_up == 0
    for: 1m
    labels: { severity: critical }

  - alert: PostgreSQLReplicationLag
    expr: pg_replication_lag_seconds > 30
    for: 5m
    labels: { severity: critical }

  - alert: PostgreSQLConnectionsHigh
    expr: pg_stat_activity_count / pg_settings_max_connections > 0.80
    for: 5m
    labels: { severity: warning }
```

---

## Part VII: Verification

### Smoke Tests

```bash
# Nefarious health check
curl -s http://localhost:8080/health | jq .

# Nefarious readiness
curl -s http://localhost:8080/health/ready | jq .

# Nefarious metrics
curl -s http://localhost:8080/metrics | head -50

# X3 health check
curl -s http://localhost:8081/health | jq .

# X3 REST API (requires token)
TOKEN=$(curl -s -X POST "http://keycloak:8080/realms/afternet/protocol/openid-connect/token" \
  -d "client_id=x3-admin" -d "grant_type=password" \
  -d "username=admin" -d "password=admin" | jq -r .access_token)

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8081/api/v1/accounts | jq .
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8081/api/v1/channels | jq .
```

### Integration Tests

```bash
# Run SASL test suite (verifies Keycloak integration)
cd tests && IRC_HOST=localhost npm test -- src/ircv3/sasl.test.ts

# Test webhook cascade
# 1. Create user in Keycloak
# 2. Auth via SASL
# 3. Register channel
# 4. Delete user in Keycloak
# 5. Verify channel transferred or dropped
```

---

## Part VIII: Success Criteria

### Operational KPIs (Business Value)

| Metric | Current | Target | Impact |
|--------|---------|--------|--------|
| Mean Time to Detection (MTTD) | 15-45 min | < 2 min | Users notified of issues before they complain |
| Mean Time to Recovery (MTTR) | 30-60 min | < 5 min | Automated traffic drain + recovery |
| Capacity-related outages | Multiple per year | Near zero | Proactive scaling prevents exhaustion |
| Manual scaling interventions | All | < 20% | Auto-scaling handles most capacity changes |
| Account sync errors | Unknown | 0 | Keycloak is single source of truth |
| Admin tasks requiring IRC | 100% | < 30% | Web UI handles common operations |

### Technical KPIs (Performance)

| Metric | Target | Why It Matters |
|--------|--------|----------------|
| Health check latency | < 10ms | Load balancers poll frequently |
| Metrics scrape latency | < 50ms | Prometheus 15-second intervals |
| REST API latency (p99) | < 500ms | Web UI responsiveness |
| Webhook processing | < 1 sec | User lifecycle must feel instant |
| SASL auth (cache hit) | < 1ms | Login experience |
| Data consistency | 100% | No orphaned accounts/channels |

---

## Appendix A: Critical Files

### Nefarious
- `include/listener.h` - Add LISTEN_REST flag
- `ircd/listener.c` - REST connection handling
- `ircd/websocket.c` - HTTP parsing reference
- `include/ircd_events.h` - Event loop API
- `ircd/s_stats.c` - Statistics sources

### X3
- `src/keycloak_webhook.c` - HTTP server, router
- `src/keycloak.c` - curl_multi to extract
- `src/nickserv.c` - Account management
- `src/chanserv.c` - Channel management
- `src/x3_lmdb.c` - Data storage

### libirchttp
- `src/client.c` - curl_multi async client
- `src/handle_pool.c` - Connection pooling
- `src/event_loop_x3.c` - X3 ioset adapter
- `src/event_loop_nef.c` - Nefarious ircd_events adapter

---

## Appendix B: Related Documentation

- [X3 Keycloak Optimization Plan](x3-keycloak-optimization.md) - Async HTTP and caching infrastructure
- [P10 Protocol Reference](../../P10_PROTOCOL_REFERENCE.md) - Server-to-server communication
- [Feature Flags Config](../../FEATURE_FLAGS_CONFIG.md) - Nefarious configuration options

---

## Recommendation

This modernization delivers measurable operational improvements with minimal disruption. The phased approach allows incremental validation—each phase delivers standalone value while building toward the complete vision.

**Why Now:**
- The foundation is already built (X3 async HTTP, Keycloak integration)
- Operational challenges will only grow with scale
- Modern tooling expectations are table stakes for attracting operators
- Technical debt compounds—addressing it now costs less than later

**Next Steps:**
1. Approve plan scope and priorities
2. Begin Phase 1 (X3 webhook handlers) immediately
3. Review progress at each phase milestone

The choice isn't whether to modernize—it's whether to do it proactively or reactively after the next major incident.
