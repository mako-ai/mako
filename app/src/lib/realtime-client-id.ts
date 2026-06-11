/**
 * Per-tab realtime client identity.
 *
 * Sent with every console write (`clientId`) and on the realtime SSE
 * connection so a tab can suppress echoes of its own writes. One id per
 * browser tab per page load — intentionally NOT persisted: a refreshed tab
 * is a new replica that should re-sync from the server.
 */
function generateClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const realtimeClientId = generateClientId();
