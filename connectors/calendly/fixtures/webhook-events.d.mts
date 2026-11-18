// Types for webhook-events.mjs, for the API tests that import it.

export const TEST_SIGNING_KEY: string;
export const DELIVERY_TIMESTAMP: number;

export function webhookScheduledEvent(
  row: Record<string, any>,
): Record<string, any>;
export function webhookEventType(row: Record<string, any>): Record<string, any>;
export function storedEvent(body: Record<string, any>): Record<string, any>;

export function buildWebhookEvents(): Array<{
  eventId: string;
  eventType: string;
  rawPayload: any;
}>;

export function buildDeliveries(body: unknown): Array<{
  name: string;
  payload: string;
  headers: Record<string, string>;
  secret?: string;
}>;
