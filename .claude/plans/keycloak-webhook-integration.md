# Keycloak Webhook Integration Plan

## Overview

X3 has a webhook listener (`keycloak_webhook.c`) that receives real-time events from Keycloak to invalidate caches and trigger channel syncs. However, Keycloak doesn't natively send webhooks - we need an extension.

## Current State

### X3 Webhook Handler (Already Implemented)
- **File**: `x3/src/keycloak_webhook.c`
- **Compiled when**: `WITH_KEYCLOAK` + `WITH_LMDB` (both enabled)
- **Listens on**: Configurable port (default: disabled, port=0)
- **Auth**: `X-Webhook-Secret` header matching configured secret

### Events X3 Handles

| resourceType | operationType | X3 Action |
|--------------|---------------|-----------|
| `USER` | `DELETE` | Clear all user caches (fingerprints, sessions) |
| `USER` | `UPDATE` | Check for x3_opserv_level, x3_metadata changes |
| `CREDENTIAL` | `DELETE` | Delete fingerprint from LMDB (if x509 type) |
| `CREDENTIAL` | `CREATE` | Pre-warm fingerprint cache (if x509 type) |
| `CREDENTIAL` | `UPDATE` | Invalidate SCRAM caches (if password type) |
| `USER_SESSION` | `DELETE` | Revoke X3 sessions for user |
| `GROUP_MEMBERSHIP` | `CREATE/DELETE` | Queue immediate channel sync |
| `GROUP` | `UPDATE` | Queue high-priority channel sync |

### Expected JSON Format
```json
{
  "id": "event-uuid",
  "time": 1234567890000,
  "realmId": "realm-uuid",
  "authDetails": { "userId": "...", "username": "..." },
  "resourceType": "USER" | "CREDENTIAL" | "GROUP_MEMBERSHIP" | "GROUP",
  "operationType": "CREATE" | "UPDATE" | "DELETE" | "ACTION",
  "resourcePath": "users/user-uuid/credentials/cred-id",
  "representation": "{...}"
}
```

---

## Problem: Keycloak Has No Native Webhook Support

Keycloak does not send webhooks out of the box. Options:

### Option A: p2-inc/keycloak-events Extension

**Repository**: https://github.com/p2-inc/keycloak-events

**Pros**:
- Well-maintained (v0.48, July 2025)
- Supports both Admin Events and User Events
- Documented JSON format matches X3 expectations
- HMAC signing support (`X-Keycloak-Signature` header)
- Exponential backoff retry on failures
- Easy configuration via Admin UI

**Cons**:
- "Only supports most recent Keycloak version" - need to verify 26.4.7 compatibility
- Adds JAR dependency to Keycloak container

**Event Format**:
```json
{
  "type": "admin.GROUP_MEMBERSHIP-CREATE",
  "operationType": "CREATE",
  "resourceType": "GROUP_MEMBERSHIP",
  "resourcePath": "users/user-uuid/groups/group-uuid",
  "representation": "{...}",
  ...
}
```

**Configuration**:
```bash
# Environment variables for catch-all webhook
WEBHOOK_URI=http://x3:9080/keycloak-webhook
WEBHOOK_SECRET=shared-secret-here
```

Or via Admin UI: Realm Settings > Events > Event Listeners > `ext-event-webhook`

---

### Option B: vymalo/keycloak-webhook Extension

**Repository**: https://github.com/vymalo/keycloak-webhook

**Pros**:
- Multi-transport (HTTP, AMQP, Syslog)
- Explicitly supports Keycloak 26.4.0 (v0.10.0-rc.1)
- Modular architecture

**Cons**:
- Sparse documentation on event format
- Focused on User Events (login, registration, logout)
- **Admin Events (GROUP_MEMBERSHIP, credentials) not documented**
- Uses Basic Auth, not HMAC

**Verdict**: Not suitable for our needs - GROUP_MEMBERSHIP is critical.

---

### Option C: Admin Events API Polling (Fallback)

**Endpoint**: `GET /admin/realms/{realm}/admin-events`

**Pros**:
- No extension needed
- Built into Keycloak

**Cons**:
- Polling adds latency (seconds vs milliseconds)
- Requires tracking "last seen" event
- Database growth if events not pruned
- More complex implementation in X3

**Configuration** (Keycloak Admin UI):
1. Realm Settings > Events > Admin Events Settings
2. Enable "Save Events"
3. Enable "Include Representation"

**Polling approach**:
```bash
GET /admin/realms/testnet/admin-events?dateFrom=2025-01-07T00:00:00Z&resourceTypes=GROUP_MEMBERSHIP,USER,CREDENTIAL
```

---

### Option D: Custom SPI (Maximum Control) ⭐ SELECTED

Write a Java EventListenerProvider SPI that POSTs to X3.

**Pros**:
- Full control over format - match X3's expected JSON exactly
- No third-party dependency
- Reusable beyond X3 (user provisioning, audit, analytics)
- Clean separation of concerns

**Cons**:
- Requires Java development (~200 lines)
- Build/deploy complexity (Maven, JAR deployment)
- Maintenance burden (but minimal once stable)

**Development Effort**: 2-3 days for production-ready implementation

**Best Starting Point**: [jessylenne/keycloak-event-listener-http](https://github.com/jessylenne/keycloak-event-listener-http) - minimal example

See [Detailed Custom SPI Implementation](#custom-spi-implementation-details) section below

---

## Recommendation

### Selected: Option D (Custom SPI)

Chosen for:
1. **Reusability** - Can be used beyond X3 for other integrations
2. **Exact format control** - Match X3's expected JSON without adaptation
3. **No third-party dependency** - Full ownership and control
4. **Learning opportunity** - Understand Keycloak's extension model

### Fallback: Option A (p2-inc/keycloak-events)

If custom SPI proves too complex or time-consuming:
- Quick 1-hour setup
- May require X3 header adaptation (`X-Keycloak-Signature` vs `X-Webhook-Secret`)

### Emergency Fallback: Option C (Polling)

If webhooks prove unreliable:
- Already partially documented in `keycloak-sync-rework.md` as Option B
- X3 would poll `/admin/realms/{realm}/admin-events` periodically

---

## Implementation Plan

### Phase 1: Verify Compatibility

1. Check p2-inc/keycloak-events pom.xml for Keycloak 26.4.7 support
2. If incompatible, check for 26.x branch or consider building from source

### Phase 2: X3 Configuration

Add to `data/x3.conf` in nickserv section:
```
"keycloak_webhook_port" "9080";
"keycloak_webhook_secret" "x3-webhook-secret-changeme";
```

No docker-compose port mapping needed - X3 and Keycloak are on same Docker network.

### Phase 3: Keycloak Extension Deployment

**Option 3A: Download pre-built JAR**
```dockerfile
# In Keycloak section of docker-compose or custom Keycloak Dockerfile
RUN curl -L -o /opt/keycloak/providers/keycloak-events.jar \
    https://github.com/p2-inc/keycloak-events/releases/download/v0.48/keycloak-events-0.48.jar
```

**Option 3B: Custom Keycloak image**
```dockerfile
FROM quay.io/keycloak/keycloak:26.4.7
COPY --from=download keycloak-events.jar /opt/keycloak/providers/
```

### Phase 4: Keycloak Configuration

**Option 4A: Environment variables** (simpler, catch-all)
```yaml
environment:
  - WEBHOOK_URI=http://x3:9080/keycloak-webhook
  - WEBHOOK_SECRET=x3-webhook-secret-changeme
```

**Option 4B: Admin UI configuration** (more granular)
1. Realm Settings > Events > Event Listeners
2. Add `ext-event-webhook`
3. Configure target URI and event types

**Required Admin Events**:
- `GROUP_MEMBERSHIP-*` (user added/removed from groups)
- `USER-DELETE` (user deleted)
- `USER-UPDATE` (user attributes changed)
- `GROUP-UPDATE` (group attributes changed)

**Required User Events**:
- `UPDATE_CREDENTIAL` / `REMOVE_CREDENTIAL` (password/cert changes)

### Phase 5: Header Compatibility Check

X3 expects `X-Webhook-Secret` header, p2-inc sends `X-Keycloak-Signature` with HMAC.

**Options**:
1. Modify X3 to accept `X-Keycloak-Signature` (preferred - more secure)
2. Check if p2-inc supports custom header name
3. Use plain shared secret without HMAC (less secure)

### Phase 6: Testing

1. Start containers with new config
2. Trigger events via Keycloak Admin UI (add user to group, change password)
3. Check X3 logs for webhook receipt
4. Verify cache invalidation works

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| p2-inc incompatible with KC 26.4.7 | Build from source or use polling fallback |
| Webhook delivery failures | p2-inc has exponential backoff; X3 should handle gracefully |
| Secret mismatch/auth failures | Extensive logging in X3 webhook handler |
| High event volume | X3 handler is async; batching already in keycloak-sync-rework |

---

## Files to Modify

| File | Change |
|------|--------|
| `data/x3.conf` | Add webhook_port and webhook_secret |
| `docker-compose.yml` | Add keycloak-events JAR download or custom image |
| `scripts/setup-keycloak.sh` | Configure event listener (optional, can use env vars) |
| `x3/src/keycloak_webhook.c` | Accept X-Keycloak-Signature header (optional) |

---

## Success Criteria

1. X3 receives webhook when user is added/removed from Keycloak group
2. X3 receives webhook when password/credential changes
3. X3 queues channel sync on GROUP_MEMBERSHIP events
4. X3 invalidates SCRAM cache on password changes
5. Webhook auth works (secret validation)

---

## Open Questions

1. **p2-inc Keycloak 26.4.7 compatibility** - Need to verify
2. **HMAC vs plain secret** - Should X3 validate HMAC signature?
3. **Event types granularity** - Use catch-all or specific event filters?
4. **Retry behavior** - What happens if X3 is temporarily down?

---

## Custom SPI Implementation Details

### Architecture Overview

```
┌─────────────┐     Admin/User      ┌─────────────────────────┐
│  Keycloak   │ ────Events────────► │ WebhookEventListener    │
│   Server    │                     │ (EventListenerProvider) │
└─────────────┘                     └───────────┬─────────────┘
                                                │
                                                │ HTTP POST
                                                ▼
                                    ┌─────────────────────────┐
                                    │ Configured Webhook URLs │
                                    │ (X3, audit system, etc) │
                                    └─────────────────────────┘
```

### Required Java Files

#### 1. EventListenerProvider (handles events)

```java
public class WebhookEventListenerProvider implements EventListenerProvider {

    @Override
    public void onEvent(Event event) {
        // User events: LOGIN, LOGOUT, REGISTER, UPDATE_CREDENTIAL, etc.
        // Called for authentication/user-initiated actions
    }

    @Override
    public void onEvent(AdminEvent event, boolean includeRepresentation) {
        // Admin events: GROUP_MEMBERSHIP, USER, CREDENTIAL, GROUP changes
        // Called for admin console/API operations
        // includeRepresentation = true means event.representation has JSON payload
    }

    @Override
    public void close() {
        // Cleanup (close HTTP client, etc.)
    }
}
```

#### 2. EventListenerProviderFactory (creates providers)

```java
public class WebhookEventListenerProviderFactory implements EventListenerProviderFactory {

    public static final String PROVIDER_ID = "webhook-events";

    @Override
    public EventListenerProvider create(KeycloakSession session) {
        return new WebhookEventListenerProvider(session, config);
    }

    @Override
    public void init(Config.Scope config) {
        // Read configuration from keycloak.conf or environment
        // WEBHOOK_URL, WEBHOOK_SECRET, etc.
    }

    @Override
    public String getId() {
        return PROVIDER_ID;
    }
}
```

#### 3. SPI Registration (META-INF/services)

File: `META-INF/services/org.keycloak.events.EventListenerProviderFactory`
```
com.example.webhook.WebhookEventListenerProviderFactory
```

### Event Types

#### User Events (Event class)
| Type | When Triggered |
|------|----------------|
| `LOGIN` | User authenticates |
| `LOGOUT` | User logs out |
| `REGISTER` | New user registration |
| `UPDATE_CREDENTIAL` | Password change |
| `REMOVE_CREDENTIAL` | Credential deleted |
| `UPDATE_PROFILE` | Profile attributes changed |

#### Admin Events (AdminEvent class)
| resourceType | operationType | Trigger |
|--------------|---------------|---------|
| `USER` | `CREATE/UPDATE/DELETE` | User CRUD via admin |
| `CREDENTIAL` | `CREATE/UPDATE/DELETE` | Credential managed by admin |
| `GROUP_MEMBERSHIP` | `CREATE/DELETE` | User added/removed from group |
| `GROUP` | `CREATE/UPDATE/DELETE` | Group CRUD |
| `REALM_ROLE_MAPPING` | `CREATE/DELETE` | Role assigned/removed |

### JSON Format for X3

Match X3's expected format in `keycloak_webhook.c`:

```java
private String formatForX3(AdminEvent event) {
    JsonObject json = new JsonObject();
    json.addProperty("id", event.getId());
    json.addProperty("time", event.getTime());
    json.addProperty("realmId", event.getRealmId());
    json.addProperty("resourceType", event.getResourceType().name());
    json.addProperty("operationType", event.getOperationType().name());
    json.addProperty("resourcePath", event.getResourcePath());

    if (event.getRepresentation() != null) {
        json.addProperty("representation", event.getRepresentation());
    }

    // authDetails for audit trail
    if (event.getAuthDetails() != null) {
        JsonObject auth = new JsonObject();
        auth.addProperty("userId", event.getAuthDetails().getUserId());
        auth.addProperty("username", event.getAuthDetails().getUsername());
        json.add("authDetails", auth);
    }

    return json.toString();
}
```

### HTTP Client Implementation

```java
private void sendWebhook(String payload) {
    HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();

    HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(webhookUrl))
        .header("Content-Type", "application/json")
        .header("X-Webhook-Secret", webhookSecret)
        .POST(HttpRequest.BodyPublishers.ofString(payload))
        .build();

    try {
        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() >= 400) {
            LOG.warnf("Webhook failed: %d %s", response.statusCode(), response.body());
            // Queue for retry if needed
        }
    } catch (Exception e) {
        LOG.error("Webhook delivery failed", e);
        // Queue for retry
    }
}
```

### Configuration Options

#### Via keycloak.conf
```properties
spi-events-listener-webhook-events-url=http://x3:9080/keycloak-webhook
spi-events-listener-webhook-events-secret=x3-webhook-secret-changeme
spi-events-listener-webhook-events-retry-count=3
spi-events-listener-webhook-events-retry-delay=1000
```

#### Via Environment Variables
```bash
KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL=http://x3:9080/keycloak-webhook
KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_SECRET=x3-webhook-secret-changeme
```

### Build Configuration (pom.xml)

```xml
<project>
    <groupId>net.afternet</groupId>
    <artifactId>keycloak-webhook-spi</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

    <properties>
        <keycloak.version>26.0.0</keycloak.version>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.keycloak</groupId>
            <artifactId>keycloak-server-spi</artifactId>
            <version>${keycloak.version}</version>
            <scope>provided</scope>
        </dependency>
        <dependency>
            <groupId>org.keycloak</groupId>
            <artifactId>keycloak-server-spi-private</artifactId>
            <version>${keycloak.version}</version>
            <scope>provided</scope>
        </dependency>
        <dependency>
            <groupId>org.keycloak</groupId>
            <artifactId>keycloak-services</artifactId>
            <version>${keycloak.version}</version>
            <scope>provided</scope>
        </dependency>
        <dependency>
            <groupId>com.google.code.gson</groupId>
            <artifactId>gson</artifactId>
            <version>2.10.1</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-shade-plugin</artifactId>
                <version>3.5.1</version>
                <executions>
                    <execution>
                        <phase>package</phase>
                        <goals><goal>shade</goal></goals>
                        <configuration>
                            <artifactSet>
                                <includes>
                                    <include>com.google.code.gson:gson</include>
                                </includes>
                            </artifactSet>
                        </configuration>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>
</project>
```

### Deployment Steps

1. **Build the JAR**
   ```bash
   cd keycloak-webhook-spi
   mvn clean package
   ```

2. **Copy to Keycloak providers**
   ```bash
   cp target/keycloak-webhook-spi-1.0.0.jar /opt/keycloak/providers/
   ```

3. **Rebuild Keycloak** (required for new providers)
   ```bash
   /opt/keycloak/bin/kc.sh build
   ```

4. **Enable the event listener** (Admin UI or CLI)
   - Realm Settings > Events > Event Listeners
   - Add `webhook-events`

### Docker Integration

#### Option 1: Custom Keycloak Image
```dockerfile
FROM quay.io/keycloak/keycloak:26.0.0

COPY keycloak-webhook-spi-1.0.0.jar /opt/keycloak/providers/

RUN /opt/keycloak/bin/kc.sh build
```

#### Option 2: Volume Mount + Init Container
```yaml
services:
  keycloak-spi-init:
    image: maven:3.9-eclipse-temurin-17
    volumes:
      - ./keycloak-webhook-spi:/build
      - keycloak_providers:/providers
    command: >
      sh -c "cd /build && mvn -q package &&
             cp target/*.jar /providers/"

  keycloak:
    depends_on:
      keycloak-spi-init:
        condition: service_completed_successfully
    volumes:
      - keycloak_providers:/opt/keycloak/providers
```

### Event Filtering

Only send relevant events to X3:

```java
private static final Set<ResourceType> X3_RESOURCE_TYPES = Set.of(
    ResourceType.USER,
    ResourceType.GROUP,
    ResourceType.GROUP_MEMBERSHIP,
    ResourceType.REALM_ROLE_MAPPING
);

private static final Set<EventType> X3_USER_EVENTS = Set.of(
    EventType.UPDATE_CREDENTIAL,
    EventType.REMOVE_CREDENTIAL
);

@Override
public void onEvent(AdminEvent event, boolean includeRepresentation) {
    if (X3_RESOURCE_TYPES.contains(event.getResourceType())) {
        sendWebhook(formatForX3(event));
    }
}

@Override
public void onEvent(Event event) {
    if (X3_USER_EVENTS.contains(event.getType())) {
        sendWebhook(formatUserEventForX3(event));
    }
}
```

### Retry Logic

Simple exponential backoff:

```java
private void sendWithRetry(String payload, int maxRetries) {
    int delay = 1000; // Start with 1 second

    for (int attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            sendWebhook(payload);
            return; // Success
        } catch (Exception e) {
            if (attempt == maxRetries) {
                LOG.errorf("Webhook failed after %d attempts: %s", maxRetries, e.getMessage());
                return;
            }
            try {
                Thread.sleep(delay);
                delay *= 2; // Exponential backoff
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }
}
```

### Broader Use Cases

The same SPI can support multiple webhook targets:

| Target | Events | Purpose |
|--------|--------|---------|
| X3 | GROUP_MEMBERSHIP, CREDENTIAL | IRC channel sync, auth cache |
| Audit SIEM | All | Security monitoring |
| HR System | USER CREATE/DELETE | Employee provisioning |
| Slack/Discord | LOGIN failures | Security alerts |
| Analytics | All | Usage metrics |

Configuration for multiple targets:
```properties
spi-events-listener-webhook-events-targets=[
  {"url":"http://x3:9080/keycloak-webhook","secret":"x3-secret","events":["GROUP_MEMBERSHIP","CREDENTIAL"]},
  {"url":"http://audit:8080/events","secret":"audit-secret","events":["*"]}
]
```

---

## References

- [p2-inc/keycloak-events](https://github.com/p2-inc/keycloak-events)
- [Phase Two Webhooks Documentation](https://phasetwo.io/docs/audit-logs/webhooks/)
- [Keycloak Admin Events API](https://www.keycloak.org/docs-api/latest/rest-api/index.html)
- [keycloak-sync-rework.md](keycloak-sync-rework.md) - Phase 4b (Webhooks)
- [jessylenne/keycloak-event-listener-http](https://github.com/jessylenne/keycloak-event-listener-http) - Minimal SPI example
- [Keycloak SPI Documentation](https://www.keycloak.org/docs/latest/server_development/#_providers)
- [EventListenerProvider Javadoc](https://www.keycloak.org/docs-api/latest/javadocs/org/keycloak/events/EventListenerProvider.html)
