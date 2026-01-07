package net.afternet.keycloak.webhook;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import org.jboss.logging.Logger;
import org.keycloak.events.Event;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventType;
import org.keycloak.events.admin.AdminEvent;
import org.keycloak.events.admin.ResourceType;
import org.keycloak.models.KeycloakSession;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Keycloak Event Listener that sends events to configured webhook endpoints.
 *
 * <p>This provider handles both User Events (authentication-related) and
 * Admin Events (management operations) and forwards them as JSON to
 * configurable HTTP endpoints.</p>
 *
 * <p>Configuration is done via environment variables or keycloak.conf:</p>
 * <ul>
 *   <li>KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL - Target webhook URL</li>
 *   <li>KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_SECRET - Shared secret for X-Webhook-Secret header</li>
 *   <li>KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_RETRY_COUNT - Number of retries (default: 3)</li>
 * </ul>
 */
public class WebhookEventListenerProvider implements EventListenerProvider {

    private static final Logger LOG = Logger.getLogger(WebhookEventListenerProvider.class);

    private final KeycloakSession session;
    private final WebhookConfig config;
    private final HttpClient httpClient;
    private final Gson gson;

    // Resource types relevant to X3 IRC services
    private static final Set<ResourceType> X3_RESOURCE_TYPES = Set.of(
        ResourceType.USER,
        ResourceType.GROUP,
        ResourceType.GROUP_MEMBERSHIP,
        ResourceType.REALM_ROLE_MAPPING
    );

    // User events relevant to X3 (credential changes affect SASL/SCRAM caches)
    private static final Set<EventType> X3_USER_EVENTS = Set.of(
        EventType.UPDATE_CREDENTIAL,
        EventType.REMOVE_CREDENTIAL,
        EventType.UPDATE_PASSWORD,
        EventType.RESET_PASSWORD
    );

    public WebhookEventListenerProvider(KeycloakSession session, WebhookConfig config) {
        this.session = session;
        this.config = config;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
        this.gson = new GsonBuilder()
            .setPrettyPrinting()
            .create();
    }

    /**
     * Handle User Events (authentication, credential changes, etc.)
     */
    @Override
    public void onEvent(Event event) {
        if (config.getWebhookUrl() == null || config.getWebhookUrl().isEmpty()) {
            return;
        }

        // Filter to only X3-relevant events unless configured to send all
        if (!config.isSendAllEvents() && !X3_USER_EVENTS.contains(event.getType())) {
            LOG.debugf("Skipping user event type: %s", event.getType());
            return;
        }

        String payload = formatUserEvent(event);
        LOG.infof("Sending user event webhook: type=%s, userId=%s",
            event.getType(), event.getUserId());

        sendWebhookAsync(payload);
    }

    /**
     * Handle Admin Events (user management, group membership, etc.)
     */
    @Override
    public void onEvent(AdminEvent event, boolean includeRepresentation) {
        if (config.getWebhookUrl() == null || config.getWebhookUrl().isEmpty()) {
            return;
        }

        // Filter to only X3-relevant resource types unless configured to send all
        if (!config.isSendAllEvents() && !X3_RESOURCE_TYPES.contains(event.getResourceType())) {
            LOG.debugf("Skipping admin event resource type: %s", event.getResourceType());
            return;
        }

        String payload = formatAdminEvent(event);
        LOG.infof("Sending admin event webhook: resourceType=%s, operationType=%s, path=%s",
            event.getResourceType(), event.getOperationType(), event.getResourcePath());

        sendWebhookAsync(payload);
    }

    /**
     * Format a User Event as JSON matching X3's expected format.
     */
    private String formatUserEvent(Event event) {
        JsonObject json = new JsonObject();
        json.addProperty("id", event.getId());
        json.addProperty("time", event.getTime());
        json.addProperty("realmId", event.getRealmId());
        json.addProperty("type", event.getType().name());
        json.addProperty("userId", event.getUserId());
        json.addProperty("clientId", event.getClientId());
        json.addProperty("ipAddress", event.getIpAddress());
        json.addProperty("sessionId", event.getSessionId());

        // For X3 compatibility, map to resourceType/operationType format
        json.addProperty("resourceType", mapEventTypeToResourceType(event.getType()));
        json.addProperty("operationType", mapEventTypeToOperationType(event.getType()));

        // Include event details if present
        if (event.getDetails() != null && !event.getDetails().isEmpty()) {
            JsonObject details = new JsonObject();
            event.getDetails().forEach(details::addProperty);
            json.add("details", details);
        }

        return gson.toJson(json);
    }

    /**
     * Format an Admin Event as JSON matching X3's expected format.
     *
     * <p>X3's keycloak_webhook.c expects:</p>
     * <pre>
     * {
     *   "id": "event-uuid",
     *   "time": 1234567890000,
     *   "realmId": "realm-uuid",
     *   "resourceType": "USER" | "CREDENTIAL" | "GROUP_MEMBERSHIP" | "GROUP",
     *   "operationType": "CREATE" | "UPDATE" | "DELETE" | "ACTION",
     *   "resourcePath": "users/user-uuid/credentials/cred-id",
     *   "representation": "{...}",
     *   "authDetails": { "userId": "...", "username": "..." }
     * }
     * </pre>
     */
    private String formatAdminEvent(AdminEvent event) {
        JsonObject json = new JsonObject();
        json.addProperty("id", event.getId());
        json.addProperty("time", event.getTime());
        json.addProperty("realmId", event.getRealmId());
        json.addProperty("resourceType", event.getResourceType().name());
        json.addProperty("operationType", event.getOperationType().name());
        json.addProperty("resourcePath", event.getResourcePath());

        // Include representation if available (contains the actual entity data)
        if (event.getRepresentation() != null) {
            json.addProperty("representation", event.getRepresentation());
        }

        // Include auth details for audit trail
        if (event.getAuthDetails() != null) {
            JsonObject auth = new JsonObject();
            auth.addProperty("userId", event.getAuthDetails().getUserId());
            auth.addProperty("ipAddress", event.getAuthDetails().getIpAddress());
            auth.addProperty("realmId", event.getAuthDetails().getRealmId());
            auth.addProperty("clientId", event.getAuthDetails().getClientId());
            json.add("authDetails", auth);
        }

        return gson.toJson(json);
    }

    /**
     * Map EventType to resourceType string for X3 compatibility.
     */
    private String mapEventTypeToResourceType(EventType type) {
        return switch (type) {
            case UPDATE_CREDENTIAL, REMOVE_CREDENTIAL, UPDATE_PASSWORD, RESET_PASSWORD -> "CREDENTIAL";
            case LOGIN, LOGOUT, LOGIN_ERROR -> "USER_SESSION";
            case REGISTER, UPDATE_PROFILE -> "USER";
            default -> "USER";
        };
    }

    /**
     * Map EventType to operationType string for X3 compatibility.
     */
    private String mapEventTypeToOperationType(EventType type) {
        return switch (type) {
            case UPDATE_CREDENTIAL, UPDATE_PASSWORD, RESET_PASSWORD, UPDATE_PROFILE -> "UPDATE";
            case REMOVE_CREDENTIAL -> "DELETE";
            case REGISTER -> "CREATE";
            case LOGIN, LOGOUT, LOGIN_ERROR -> "ACTION";
            default -> "ACTION";
        };
    }

    /**
     * Send webhook asynchronously with retry logic.
     */
    private void sendWebhookAsync(String payload) {
        CompletableFuture.runAsync(() -> sendWithRetry(payload, config.getRetryCount()));
    }

    /**
     * Send webhook with exponential backoff retry.
     */
    private void sendWithRetry(String payload, int maxRetries) {
        int delay = 1000; // Start with 1 second

        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                sendWebhook(payload);
                return; // Success
            } catch (Exception e) {
                if (attempt == maxRetries) {
                    LOG.errorf("Webhook failed after %d attempts: %s", maxRetries + 1, e.getMessage());
                    return;
                }
                LOG.warnf("Webhook attempt %d failed, retrying in %dms: %s",
                    attempt + 1, delay, e.getMessage());
                try {
                    Thread.sleep(delay);
                    delay = Math.min(delay * 2, 30000); // Cap at 30 seconds
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    /**
     * Send a single webhook request.
     */
    private void sendWebhook(String payload) throws Exception {
        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
            .uri(URI.create(config.getWebhookUrl()))
            .header("Content-Type", "application/json")
            .timeout(Duration.ofSeconds(10))
            .POST(HttpRequest.BodyPublishers.ofString(payload));

        // Add secret header if configured (matches X3's X-Webhook-Secret expectation)
        if (config.getWebhookSecret() != null && !config.getWebhookSecret().isEmpty()) {
            requestBuilder.header("X-Webhook-Secret", config.getWebhookSecret());
        }

        HttpResponse<String> response = httpClient.send(
            requestBuilder.build(),
            HttpResponse.BodyHandlers.ofString()
        );

        if (response.statusCode() >= 400) {
            throw new RuntimeException(String.format(
                "Webhook returned error: %d %s", response.statusCode(), response.body()));
        }

        LOG.debugf("Webhook delivered successfully: %d", response.statusCode());
    }

    @Override
    public void close() {
        // HttpClient doesn't need explicit cleanup
    }
}
