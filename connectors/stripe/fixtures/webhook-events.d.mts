// Types for webhook-events.mjs, for the API tests that import it.

export const TEST_SIGNING_SECRET: string;
export const SENT_AT: number;
export const LIST_PATH: Record<string, string | RegExp>;

export function entityOfEvent(eventType: string): string | undefined;

export function rowsByEntity(
  interactions?: Map<string, unknown>,
): Record<string, Array<Record<string, any>>>;

export function wholeRows(
  rows?: Record<string, Array<Record<string, any>>>,
): Record<string, Array<Record<string, any>>>;

export function buildWebhookEvents(
  eventTypes: string[],
  rows?: Record<string, Array<Record<string, any>>>,
): Array<{
  eventId: string;
  eventType: string;
  receivedAt: string;
  rawPayload: any;
}>;
