/**
 * PandaDoc webhooks, connector side: the SDK's `webhooks` definition.
 *
 * Mako's API verifies every delivery before it stores it, from the scheme
 * declared below as data. The shared key never reaches the box. The scheme
 * is the in-process `verifyWebhook`: HMAC-SHA256 of the raw body under the
 * shared key, hex, in the `signature` query parameter, or else a
 * `signature` header.
 *
 * A delivery is an array of `{ event, data }` items with no event id. Mako
 * keys it on a SHA-1 of the raw body, as the in-process check does, and
 * reads its type from the first item (`eventTypePath`).
 *
 * `pandaDocWebhookRecords` is the in-process `extractWebhookCdcRecords`,
 * parity-tested. The handler then fills what a payload leaves out:
 *
 * - A document payload has no `date_completed`, `date_sent`, `total`,
 *   `approvers` or `date_status_changed`, and sometimes no `pricing`.
 *   Written as is, those columns go NULL, where a backfill stores the
 *   document's details. So an upsert that lacks any schema column gets one
 *   `GET /public/v1/documents/{id}/details` (templates:
 *   `/public/v1/templates/{id}/details`). Only absent keys are filled; the
 *   webhook's own values win. A column the details omit too is NULL, as a
 *   backfill stores it.
 * - 404 (deleted since): the record is dropped. An event left with no
 *   record is `skipped`.
 * - Past the fill budget: `deferred`. Mako retries without counting it.
 * - Any other failure, after the client's retries: `extract_failed`.
 *
 * A partial record is never answered unfilled.
 */
import crypto from "node:crypto";
import type {
  WebhookEvent,
  WebhookOutcome,
  WebhookVerification,
} from "@makoai/connector-sdk";
import { type PandaDocClient, PandaDocHttpError } from "./client.ts";
import { DOCUMENT_FIELDS, TEMPLATE_FIELDS } from "./schema.ts";

export const DOCUMENT_TRIGGERS = [
  "document_state_changed",
  "document_updated",
  "document_creation_failed",
  "document_completed_pdf_ready",
  "document_section_added",
  "recipient_completed",
  "quote_updated",
  "document_deleted",
] as const;

export const TEMPLATE_TRIGGERS = [
  "template_created",
  "template_updated",
  "template_deleted",
] as const;

export const PANDADOC_WEBHOOK_EVENTS: string[] = [
  ...DOCUMENT_TRIGGERS,
  ...TEMPLATE_TRIGGERS,
];

/** The in-process `verifyWebhook`, as data. The API test runs both. */
export const PANDADOC_WEBHOOK_VERIFICATION: WebhookVerification = {
  scheme: "hmac-sha256",
  secretEncoding: "utf8",
  signedPayload: ["body"],
  signatureQuery: "signature",
  signatureHeader: "signature",
  signatureEncoding: "hex",
};

export type WebhookOperation = "upsert" | "delete";

export interface WebhookChangeRecord {
  entity: string;
  recordId: string;
  operation: WebhookOperation;
  payload: Record<string, unknown>;
  sourceTs: string;
  changeId: string;
}

export function pandaDocWebhookEventMapping(
  eventType: string,
): { entity: string; operation: WebhookOperation } | null {
  if ((DOCUMENT_TRIGGERS as readonly string[]).includes(eventType)) {
    return {
      entity: "documents",
      operation: eventType === "document_deleted" ? "delete" : "upsert",
    };
  }
  if ((TEMPLATE_TRIGGERS as readonly string[]).includes(eventType)) {
    return {
      entity: "templates",
      operation: eventType === "template_deleted" ? "delete" : "upsert",
    };
  }
  return null;
}

type Item = { event?: string; data?: Record<string, unknown> };

/**
 * The raw provider array, the in-process stored shape (`{ events: [...] }`)
 * or a single item, as `toWebhookItems` reads them.
 */
export function webhookItems(event: unknown): Item[] {
  if (Array.isArray(event)) return event as Item[];
  if (event && typeof event === "object") {
    const wrapped = (event as { events?: unknown }).events;
    if (Array.isArray(wrapped)) return wrapped as Item[];
    if ("data" in (event as Record<string, unknown>)) return [event as Item];
  }
  return [];
}

/** The base connector's record time: first parseable candidate, else now. */
export function resolveRecordTimestamp(
  payload?: Record<string, unknown>,
): Date {
  const candidates = [
    payload?.date_updated,
    payload?.updated_at,
    payload?.updatedAt,
    payload?.date_modified,
    payload?.date_created,
    payload?.created_at,
    payload?.createdAt,
    payload?.timestamp,
    payload?._syncedAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date =
      candidate instanceof Date ? candidate : new Date(String(candidate));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

/** The in-process `extractWebhookCdcRecords`: one record per mapped item. */
export function pandaDocWebhookRecords(
  rawPayload: unknown,
  eventType?: string,
): WebhookChangeRecord[] {
  const records: WebhookChangeRecord[] = [];
  for (const item of webhookItems(rawPayload)) {
    const trigger = item?.event || eventType;
    const data = item?.data;
    if (!trigger || !data || typeof data !== "object") continue;
    const mapping = pandaDocWebhookEventMapping(trigger);
    if (!mapping) continue;
    const recordId = typeof data.id === "string" ? data.id : "";
    if (!recordId) continue;
    const sourceTs = resolveRecordTimestamp(data).toISOString();
    records.push({
      entity: mapping.entity,
      recordId,
      operation: mapping.operation,
      payload: data,
      sourceTs,
      changeId: `${trigger}:${recordId}:${sourceTs}`,
    });
  }
  return records;
}

/** Columns a payload must carry, and where to read them when it does not. */
export const PANDADOC_WEBHOOK_FILL: Readonly<
  Record<string, { path: (id: string) => string; fields: readonly string[] }>
> = {
  documents: {
    path: id => `/public/v1/documents/${encodeURIComponent(id)}/details`,
    fields: Object.keys(DOCUMENT_FIELDS).filter(f => f !== "id"),
  },
  templates: {
    path: id => `/public/v1/templates/${encodeURIComponent(id)}/details`,
    fields: Object.keys(TEMPLATE_FIELDS).filter(f => f !== "id"),
  },
};

/** Read time one batch may spend on fills; Mako ends a batch at 60 s. */
export const PANDADOC_WEBHOOK_FILL_BUDGET_MS = 40_000;

/** A PandaDoc id: letters, digits, `-` and `_`. Anything else is refused. */
const PANDADOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface PandaDocWebhookDeps {
  api: PandaDocClient;
  /** Pause after each fill read: the connection's rate-limit delay. */
  pauseMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  budgetMs?: number;
  now?: () => number;
}

type Filled =
  | { kind: "record"; record: WebhookChangeRecord }
  | { kind: "gone" }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: string };

async function fillRecord(
  deps: PandaDocWebhookDeps,
  record: WebhookChangeRecord,
  budgetSpent: () => boolean,
): Promise<Filled> {
  const spec = PANDADOC_WEBHOOK_FILL[record.entity];
  const payload = record.payload;
  if (!spec || record.operation !== "upsert") return { kind: "record", record };
  const missing = spec.fields.filter(field => !(field in payload));
  if (missing.length === 0) return { kind: "record", record };
  if (!PANDADOC_ID.test(record.recordId)) {
    return {
      kind: "failed",
      reason: `Not a PandaDoc id: ${JSON.stringify(record.recordId).slice(0, 80)}`,
    };
  }
  if (budgetSpent()) {
    return {
      kind: "deferred",
      reason: `PandaDoc fill budget for this batch is spent; ${record.entity} ${record.recordId} waits for a retry`,
    };
  }

  let fetched: Record<string, unknown>;
  try {
    const body = await deps.api.get<unknown>(spec.path(record.recordId));
    fetched =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch (error) {
    if (error instanceof PandaDocHttpError && error.status === 404) {
      deps.log(
        `PandaDoc ${record.entity} ${record.recordId} is gone; skipping its upsert`,
      );
      return { kind: "gone" };
    }
    return {
      kind: "failed",
      reason: `Could not read PandaDoc ${record.entity} ${record.recordId}: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 500),
    };
  } finally {
    await deps.sleep(deps.pauseMs);
  }

  const filled: Record<string, unknown> = { ...payload };
  for (const field of missing) {
    filled[field] = field in fetched ? fetched[field] : null;
  }
  return { kind: "record", record: { ...record, payload: filled } };
}

/** A batch in, one outcome per event out, in order. */
export async function handlePandaDocWebhookBatch(
  deps: PandaDocWebhookDeps,
  events: WebhookEvent[],
): Promise<WebhookOutcome[]> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? PANDADOC_WEBHOOK_FILL_BUDGET_MS;
  const startedAt = now();
  const budgetSpent = () => now() - startedAt >= budgetMs;

  const out: WebhookOutcome[] = [];
  for (const { eventId, eventType, rawPayload } of events) {
    if (!pandaDocWebhookEventMapping(eventType)) {
      out.push({ eventId, outcome: "unmapped" });
      continue;
    }
    const extracted = pandaDocWebhookRecords(rawPayload, eventType);
    if (extracted.length === 0) {
      out.push({ eventId, outcome: "extract_failed" });
      continue;
    }
    const records: WebhookChangeRecord[] = [];
    let gone = 0;
    let stop: WebhookOutcome | null = null;
    for (const record of extracted) {
      const filled = await fillRecord(deps, record, budgetSpent);
      if (filled.kind === "record") records.push(filled.record);
      else if (filled.kind === "gone") gone++;
      else {
        // One record that cannot be filled holds the whole event back.
        stop = {
          eventId,
          outcome: filled.kind === "deferred" ? "deferred" : "extract_failed",
          reason: filled.reason,
        };
        break;
      }
    }
    if (stop) out.push(stop);
    else if (records.length > 0) {
      out.push({ eventId, outcome: "records", records });
    } else {
      out.push({
        eventId,
        outcome: "skipped",
        reason: `PandaDoc no longer has ${gone} object(s) of this event (404)`,
      });
    }
  }
  return out;
}

/** The SHA-1 event id the in-process check derives from a raw body. */
export function deliveryId(rawBody: string): string {
  return crypto.createHash("sha1").update(rawBody, "utf8").digest("hex");
}
