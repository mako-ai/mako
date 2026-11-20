/**
 * Claap webhooks, connector side: the SDK's `webhooks` definition.
 *
 * Claap does not sign deliveries. It sends the webhook's secret itself in
 * `X-Claap-Webhook-Secret`, which Mako's API compares with the flow's
 * secret in constant time (`scheme: "shared-secret"`). The secret never
 * reaches the box. The event id is the body's `eventId`, its type
 * `event.type`.
 *
 * `claapWebhookRecords` extracts the change records of a delivery. The
 * handler then enriches them (transcripts) and applies the fill rule:
 *
 * - Fill: a webhook recording carries every column a backfill writes except,
 *   now and then, `source`. An upsert that lacks one of
 *   `CLAAP_WEBHOOK_FILL_FIELDS` gets one
 *   `GET /v1/recordings/{id}?returnAiFields=true`, the read a backfill
 *   makes. Only absent keys are filled; the webhook's own values win. A
 *   column the detail omits too is NULL, as a backfill stores it. `crmInfo`
 *   and `deal` are left out of the trigger: no Claap read returns them
 *   (0 of 60,944 backfilled RealAdvisor rows hold one), so asking would
 *   spend one call of the daily quota per event for nothing.
 * - 404: the record is dropped; an event left with nothing is `skipped`.
 *   A Ready recording still without `aiFields` fails the event for a retry,
 *   so stored AI output is never nulled.
 * - Transcripts: when the flow syncs `recording_transcripts`, every upserted
 *   recording's transcripts are downloaded now (the links expire after 24
 *   hours), one record per language next to the recording.
 * - Past the batch's time budget, an event that still needs a read is
 *   `deferred`. Any other read failure is `extract_failed`.
 */
import type {
  WebhookEvent,
  WebhookOutcome,
  WebhookVerification,
} from "@makoai/connector-sdk";
import { type ClaapClient } from "./client.ts";
import { DETAIL_MIN_INTERVAL_MS, fetchRecordingDetail } from "./recordings.ts";
import { RECORDING_FIELDS } from "./schema.ts";
import {
  CLAAP_TRANSCRIPTS_ENTITY,
  fetchClaapRecordingTranscripts,
  type TranscriptDeps,
} from "./transcripts.ts";

export const CLAAP_WEBHOOK_EVENTS = ["recording_added", "recording_updated"];

/** The shared-secret check on `X-Claap-Webhook-Secret`, as data. */
export const CLAAP_WEBHOOK_VERIFICATION: WebhookVerification = {
  scheme: "shared-secret",
  secretHeader: "x-claap-webhook-secret",
};

const MAPPINGS: Record<string, { entity: string; operation: "upsert" }> = {
  recording_added: { entity: "recordings", operation: "upsert" },
  recording_updated: { entity: "recordings", operation: "upsert" },
};

export function claapWebhookEventMapping(eventType: string) {
  return MAPPINGS[eventType] ?? null;
}

export interface WebhookChangeRecord {
  entity: string;
  recordId: string;
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
  sourceTs: string;
  changeId: string;
}

function firstDate(candidates: unknown[]): Date | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date =
      candidate instanceof Date ? candidate : new Date(String(candidate));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** The base connector's record time. */
function baseTimestamp(payload: Record<string, unknown>): Date {
  return (
    firstDate([
      payload.date_updated,
      payload.updated_at,
      payload.updatedAt,
      payload.date_modified,
      payload.date_created,
      payload.created_at,
      payload.createdAt,
      payload.timestamp,
      payload._syncedAt,
    ]) ?? new Date()
  );
}

/** Claap's `resolveRecordingTimestamp`. */
function recordingTimestamp(payload: Record<string, unknown>): Date {
  return (
    firstDate([
      payload.updatedAt,
      payload.date_updated,
      payload.createdAt,
      payload.date_created,
      payload.timestamp,
    ]) ?? new Date()
  );
}

/** The recording an event carries, keyed by its id (`extractClaapWebhookData`). */
function recordingOf(
  event: unknown,
): { id: string; data: Record<string, unknown> } | null {
  const body = event as {
    event?: { recording?: Record<string, unknown> };
    recording?: Record<string, unknown>;
  };
  const recording = body?.event?.recording ?? body?.recording;
  const id =
    typeof recording?.id === "string"
      ? recording.id
      : typeof (recording as { _id?: unknown })?._id === "string"
        ? (recording as { _id: string })._id
        : undefined;
  if (!recording || !id) return null;
  return { id, data: { ...recording, id } };
}

/** The change records of one delivery: the recording, then its transcripts. */
export function claapWebhookRecords(
  rawPayload: unknown,
  eventType?: string,
): WebhookChangeRecord[] {
  const event = rawPayload as Record<string, any> | null;
  const resolved =
    eventType || event?.type || event?.event_type || event?.action;
  if (!resolved) return [];
  const mapping = claapWebhookEventMapping(resolved);
  if (!mapping) return [];
  const extracted = recordingOf(rawPayload);
  if (!extracted) return [];
  const changeId =
    event?.id ||
    event?.event_id ||
    event?.eventId ||
    event?.event?.id ||
    `${resolved}:${extracted.id}:${baseTimestamp(extracted.data).toISOString()}`;
  return [
    {
      entity: mapping.entity,
      recordId: extracted.id,
      operation: mapping.operation,
      payload: extracted.data,
      sourceTs: recordingTimestamp(extracted.data).toISOString(),
      changeId,
    },
  ];
}

/** Columns whose absence sends a recording to the detail read. */
export const CLAAP_WEBHOOK_FILL_FIELDS: readonly string[] = Object.keys(
  RECORDING_FIELDS,
).filter(field => !["id", "crmInfo", "deal"].includes(field));

/** Read time one batch may spend; Mako ends a batch at 60 s. */
export const CLAAP_WEBHOOK_BUDGET_MS = 40_000;

const CLAAP_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface ClaapWebhookDeps {
  api: ClaapClient;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  transcripts: TranscriptDeps;
  budgetMs?: number;
  now?: () => number;
}

type Filled =
  | { kind: "record"; record: WebhookChangeRecord }
  | { kind: "gone" }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: string };

async function fillRecording(
  deps: ClaapWebhookDeps,
  record: WebhookChangeRecord,
  budgetSpent: () => boolean,
): Promise<Filled> {
  const payload = record.payload;
  const missing = CLAAP_WEBHOOK_FILL_FIELDS.filter(f => !(f in payload));
  if (missing.length === 0) return { kind: "record", record };
  if (!CLAAP_ID.test(record.recordId)) {
    return {
      kind: "failed",
      reason: `Not a Claap id: ${JSON.stringify(record.recordId).slice(0, 80)}`,
    };
  }
  if (budgetSpent()) {
    return {
      kind: "deferred",
      reason: `Claap read budget for this batch is spent; recording ${record.recordId} waits for a retry`,
    };
  }
  const detail = await fetchRecordingDetail(deps.api, record.recordId);
  await deps.sleep(DETAIL_MIN_INTERVAL_MS);
  if (detail.notFound) {
    deps.log(`Claap recording ${record.recordId} is gone; skipping its upsert`);
    return { kind: "gone" };
  }
  if (detail.missingAiFields) {
    return {
      kind: "failed",
      reason: `Claap recording ${record.recordId} is Ready without aiFields; retrying later`,
    };
  }
  if (!detail.recording) {
    return {
      kind: "failed",
      reason: `Could not read Claap recording ${record.recordId}: ${detail.error ?? "unknown error"}`,
    };
  }
  const filled: Record<string, unknown> = { ...payload };
  for (const field of missing) {
    filled[field] = field in detail.recording ? detail.recording[field] : null;
  }
  return { kind: "record", record: { ...record, payload: filled } };
}

/** A batch in, one outcome per event out, in order. */
export async function handleClaapWebhookBatch(
  deps: ClaapWebhookDeps,
  events: WebhookEvent[],
  options: { enabledEntities?: string[] } = {},
): Promise<WebhookOutcome[]> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? CLAAP_WEBHOOK_BUDGET_MS;
  const startedAt = now();
  const budgetSpent = () => now() - startedAt >= budgetMs;
  // Without the list (an older API), download: Mako drops what it does not sync.
  const withTranscripts =
    options.enabledEntities === undefined ||
    options.enabledEntities.includes(CLAAP_TRANSCRIPTS_ENTITY);

  const out: WebhookOutcome[] = [];
  for (const { eventId, eventType, rawPayload } of events) {
    if (!claapWebhookEventMapping(eventType)) {
      out.push({ eventId, outcome: "unmapped" });
      continue;
    }
    const extracted = claapWebhookRecords(rawPayload, eventType);
    if (extracted.length === 0) {
      out.push({ eventId, outcome: "extract_failed" });
      continue;
    }

    const records: WebhookChangeRecord[] = [];
    let gone = 0;
    let stop: WebhookOutcome | null = null;
    for (const record of extracted) {
      const filled = await fillRecording(deps, record, budgetSpent);
      if (filled.kind === "record") records.push(filled.record);
      else if (filled.kind === "gone") gone++;
      else {
        stop = {
          eventId,
          outcome: filled.kind === "deferred" ? "deferred" : "extract_failed",
          reason: filled.reason,
        };
        break;
      }
    }
    if (stop) {
      out.push(stop);
      continue;
    }
    if (records.length === 0) {
      out.push({
        eventId,
        outcome: "skipped",
        reason: `Claap no longer has ${gone} recording(s) of this event (404)`,
      });
      continue;
    }

    if (withTranscripts) {
      const hasLinks = records.some(r => Array.isArray(r.payload.transcripts));
      if (hasLinks && budgetSpent()) {
        out.push({
          eventId,
          outcome: "deferred",
          reason:
            "Claap read budget for this batch is spent; transcripts wait for a retry",
        });
        continue;
      }
      const withRows = [...records];
      try {
        for (const record of records) {
          const rows = await fetchClaapRecordingTranscripts(
            deps.transcripts,
            record.payload,
          );
          for (const row of rows) {
            withRows.push({
              entity: CLAAP_TRANSCRIPTS_ENTITY,
              recordId: String(row.id),
              operation: "upsert",
              payload: row,
              sourceTs: new Date(String(row.fetchedAt)).toISOString(),
              changeId: `${record.changeId || record.recordId}:${CLAAP_TRANSCRIPTS_ENTITY}:${row.id}`,
            });
          }
        }
        records.splice(0, records.length, ...withRows);
      } catch (error) {
        // A failed enrichment applies the recordings alone.
        deps.log(
          `Claap transcript enrichment failed; applying recordings only: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    out.push({ eventId, outcome: "records", records });
  }
  return out;
}
