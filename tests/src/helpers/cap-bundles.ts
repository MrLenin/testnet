/**
 * IRCv3 Capability Bundles
 *
 * Many capabilities have dependencies or work best together.
 * These bundles ensure tests request all required capabilities.
 */

/**
 * Capability bundles for common use cases.
 * Each bundle includes the primary capability and its dependencies.
 */
export const CAP_BUNDLES = {
  /** For testing echo-message - needs tags and server-time for full validation */
  messaging: ['message-tags', 'server-time', 'echo-message'],

  /** For testing labeled-response - needs batch for labeled responses */
  batching: ['batch', 'labeled-response', 'message-tags'],

  /** For testing chathistory - needs batch for history delivery */
  chathistory: ['draft/chathistory', 'batch', 'server-time', 'message-tags'],

  /** For testing account features - away, account, extended-join work together */
  accounts: ['away-notify', 'account-notify', 'extended-join'],

  /** For testing SASL authentication */
  sasl: ['sasl'],

  /** For testing channel metadata */
  metadata: ['draft/metadata-2', 'message-tags'],

  /** For testing multiline messages */
  multiline: ['draft/multiline', 'batch', 'message-tags'],

  /** For testing webpush notifications */
  webpush: ['draft/webpush'],

  /** For testing event playback with chathistory */
  eventPlayback: ['draft/event-playback', 'draft/chathistory', 'batch', 'server-time', 'message-tags'],

  /** Common base capabilities for most tests */
  base: ['message-tags', 'server-time', 'multi-prefix'],
} as const;

export type CapBundle = keyof typeof CAP_BUNDLES;

/**
 * Get capabilities for a bundle, optionally adding extra caps.
 */
export function getCaps(bundle: CapBundle, ...extra: string[]): string[] {
  return [...CAP_BUNDLES[bundle], ...extra];
}

/**
 * Get multiple bundles merged together.
 */
export function getMergedCaps(...bundles: CapBundle[]): string[] {
  const caps = new Set<string>();
  for (const bundle of bundles) {
    for (const cap of CAP_BUNDLES[bundle]) {
      caps.add(cap);
    }
  }
  return [...caps];
}
