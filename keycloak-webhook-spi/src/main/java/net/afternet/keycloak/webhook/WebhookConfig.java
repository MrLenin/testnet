package net.afternet.keycloak.webhook;

/**
 * Configuration holder for webhook settings.
 *
 * <p>Immutable configuration object created by the factory and shared
 * across all provider instances.</p>
 */
public class WebhookConfig {

    private final String webhookUrl;
    private final String webhookSecret;
    private final int retryCount;
    private final boolean sendAllEvents;

    public WebhookConfig(String webhookUrl, String webhookSecret, int retryCount, boolean sendAllEvents) {
        this.webhookUrl = webhookUrl;
        this.webhookSecret = webhookSecret;
        this.retryCount = retryCount;
        this.sendAllEvents = sendAllEvents;
    }

    /**
     * Get the target webhook URL.
     *
     * @return the webhook URL, or null if not configured
     */
    public String getWebhookUrl() {
        return webhookUrl;
    }

    /**
     * Get the shared secret for authentication.
     *
     * <p>This is sent as the X-Webhook-Secret header to match X3's expectations.</p>
     *
     * @return the webhook secret, or null if not configured
     */
    public String getWebhookSecret() {
        return webhookSecret;
    }

    /**
     * Get the number of retry attempts for failed webhooks.
     *
     * @return the retry count (default: 3)
     */
    public int getRetryCount() {
        return retryCount;
    }

    /**
     * Check if all events should be sent.
     *
     * <p>If false (default), only X3-relevant events are sent (GROUP_MEMBERSHIP,
     * CREDENTIAL, USER, etc.). If true, all events are forwarded.</p>
     *
     * @return true if all events should be sent
     */
    public boolean isSendAllEvents() {
        return sendAllEvents;
    }
}
