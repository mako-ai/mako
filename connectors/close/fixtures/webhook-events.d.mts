// Types for webhook-events.mjs, for the API test that imports it.

export const TEST_SIGNING_KEY: string;

export function buildWebhookEvents(
  events: string[],
): Array<{ eventId: string; eventType: string; rawPayload: any }>;

export function buildDeliveries(event: unknown): Array<{
  name: string;
  payload: string;
  headers: Record<string, string>;
  secret?: string;
}>;
