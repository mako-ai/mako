// Types for webhook-events.mjs.
export const TEST_SHARED_KEY: string;
export const TEST_SECRET: string;
export const RECEIVED_AT: string;
export const WEBHOOK_OMITS: string[];
export function buildWebhookDeliveries(): Array<Record<string, any>>;
export function webhookFillRequests(): string[];
export function webhookReadRequests(): string[];
export function sign(body: string, key?: string): string;
