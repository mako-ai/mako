// Types for webhook-events.mjs, for the API tests that import it.

/** A test RSA key pair standing in for Wise's signing key. Per run. */
export const TEST_WEBHOOK_KEYS: { publicKey: string; privateKey: string };

export interface StoredWebhookEvent {
  eventId: string;
  eventType: string;
  rawPayload: any;
  receivedAt?: string;
  [key: string]: unknown;
}

export function buildWebhookEvents(): StoredWebhookEvent[];

/** One event per type, as Mako stores a verified delivery of it. */
export function storedEvent(
  body: Record<string, any>,
  deliveryId?: string,
): StoredWebhookEvent;

export function buildDeliveries(body?: Record<string, any>): Array<{
  name: string;
  payload: string;
  headers: Record<string, string>;
  secret?: string;
}>;
