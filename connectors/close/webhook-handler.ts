/**
 * Close webhooks as the SDK's `webhooks` definition: how Mako verifies a
 * delivery (as data), and the batch handler a box runs.
 *
 * Mako's API verifies every delivery with the flow's signing key before it
 * stores it, and hands a box batches of stored events. The key never reaches
 * the box, so this file holds no verification code: `verifyCloseWebhook` in
 * `webhooks.ts` stays as the reference the declaration below must match.
 *
 * The handler starts from `handleWebhookBatch` (the in-process mapping,
 * parity-tested), then fills what a Close payload leaves out, by the same
 * rule as the in-process connector (`fillCloseWebhookPartialRecords` in
 * `api/src/connectors/close/webhooks.ts`, PR 1314):
 *
 * - A Close event payload is the object's own row without its expansions
 *   (`CLOSE_WEBHOOK_FILL_FIELDS`). Written as is, those columns go NULL.
 * - An upsert that lacks any fill field gets one
 *   `GET /<object>/<id>/?_fields=<missing>`. Only absent keys are filled;
 *   the webhook's own values win. A field the object omits too is NULL, as
 *   a backfill stores it.
 * - 404 (deleted or merged since): the record is dropped. Its delete event
 *   follows. An event left with no record is `skipped`.
 * - Budget spent: the event is `deferred`. Mako parks it for the retry cron
 *   without counting the attempt.
 * - Any other failure, after the client's retries: `extract_failed`. Mako
 *   retries it up to its usual 5 attempts.
 *
 * A partial record is never answered unfilled.
 */
import type {
  Context,
  WebhookDefinition,
  WebhookEvent,
  WebhookOutcome,
  WebhookVerification,
} from "@makoai/connector-sdk";
import { type CloseClient, CloseHttpError } from "./client.ts";
import {
  closeSupportedWebhookEvents,
  handleWebhookBatch,
  type WebhookChangeRecord,
} from "./webhooks.ts";

/**
 * `verifyCloseWebhook` as data: HMAC-SHA256 under the hex-decoded key, over
 * the `close-sig-timestamp` header followed by the raw body, hex in
 * `close-sig-hash`. The API test runs both on the same deliveries.
 */
export const CLOSE_WEBHOOK_VERIFICATION: WebhookVerification = {
  scheme: "hmac-sha256",
  secretEncoding: "hex",
  signedPayload: ["header:close-sig-timestamp", "body"],
  signatureHeader: "close-sig-hash",
  signatureEncoding: "hex",
  // Not in the in-process check: a delivery more than 5 minutes from now is
  // refused, so a captured one cannot be replayed.
  timestampHeader: "close-sig-timestamp",
  toleranceSeconds: 300,
};

/** A Close object id: a prefix, `_`, then letters and digits. */
const CLOSE_ID = /^[a-z]+_[A-Za-z0-9]{1,64}$/;

/**
 * Columns a Close webhook leaves out of an object's payload, per entity,
 * and the REST object to read them from. The same table as the in-process
 * `CLOSE_WEBHOOK_FILL_FIELDS`; the API test holds the two equal.
 */
export const CLOSE_WEBHOOK_FILL_FIELDS: Readonly<
  Record<string, { path: string; fields: readonly string[] }>
> = {
  leads: {
    path: "/lead/",
    fields: [
      "contacts",
      "opportunities",
      "tasks",
      "html_url",
      "integration_links",
      "primary_email",
      "primary_phone",
    ],
  },
  contacts: {
    path: "/contact/",
    fields: ["display_name", "integration_links"],
  },
  opportunities: {
    path: "/opportunity/",
    fields: [
      "status_display_name",
      "pipeline_name",
      "stall_status",
      "integration_links",
    ],
  },
  "activities:Email": {
    path: "/activity/email/",
    fields: ["body_html_quoted", "body_text_quoted"],
  },
  "activities:EmailThread": {
    path: "/activity/emailthread/",
    fields: ["latest_emails"],
  },
};

/** Gate pause after each fill read, as the in-process fill client. */
export const CLOSE_WEBHOOK_FILL_MIN_DELAY_MS = 100;

/**
 * Read time one batch may spend on fills. Mako ends a batch's box command at
 * 60 s; past this budget the remaining events are `deferred`, so a large
 * batch answers in time instead of timing out whole.
 */
export const CLOSE_WEBHOOK_FILL_BUDGET_MS = 40_000;

export interface CloseWebhookDeps {
  /** A client on the connection's key, with the fill pause. */
  api: CloseClient;
  log: (message: string) => void;
  budgetMs?: number;
  now?: () => number;
}

type Filled =
  | { kind: "record"; record: WebhookChangeRecord }
  | { kind: "gone" }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: string };

/** One record, filled from its REST object when its payload is partial. */
async function fillRecord(
  deps: CloseWebhookDeps,
  record: WebhookChangeRecord,
  budgetSpent: () => boolean,
): Promise<Filled> {
  const spec = CLOSE_WEBHOOK_FILL_FIELDS[record.entity];
  const payload =
    record.payload && typeof record.payload === "object"
      ? record.payload
      : null;
  if (!spec || record.operation !== "upsert" || !payload) {
    return { kind: "record", record };
  }
  const missing = spec.fields.filter(field => !(field in payload));
  if (missing.length === 0) return { kind: "record", record };
  // The id goes into a URL path: anything but a Close id (`..`, `/`, `?`)
  // is refused before any request.
  if (!CLOSE_ID.test(record.recordId)) {
    return {
      kind: "failed",
      reason: `Not a Close id: ${JSON.stringify(record.recordId).slice(0, 80)}`,
    };
  }
  if (budgetSpent()) {
    return {
      kind: "deferred",
      reason: `Close fill budget for this batch is spent; ${record.entity} ${record.recordId} waits for a retry`,
    };
  }

  let fetched: Record<string, unknown>;
  try {
    fetched =
      ((await deps.api.get(
        `${spec.path}${encodeURIComponent(record.recordId)}/`,
        { _fields: missing.join(",") },
      )) as Record<string, unknown> | null) ?? {};
  } catch (error) {
    if (error instanceof CloseHttpError && error.status === 404) {
      deps.log(
        `Close ${record.entity} ${record.recordId} is gone; skipping its upsert`,
      );
      return { kind: "gone" };
    }
    const status =
      error instanceof CloseHttpError ? ` (HTTP ${error.status})` : "";
    return {
      kind: "failed",
      reason: `Could not read Close ${record.entity} ${record.recordId}${status}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const filled: Record<string, unknown> = { ...payload };
  for (const field of missing) {
    filled[field] = field in fetched ? fetched[field] : null;
  }
  return { kind: "record", record: { ...record, payload: filled } };
}

/**
 * A batch in, one outcome per event out, in order. Records whose payload is
 * whole pass through as the in-process connector extracts them.
 */
export async function handleCloseWebhookBatch(
  deps: CloseWebhookDeps,
  events: WebhookEvent[],
): Promise<WebhookOutcome[]> {
  const outcomes = handleWebhookBatch(
    events.map(({ eventId, eventType, rawPayload }) => ({
      eventId,
      eventType,
      rawPayload,
    })),
  ) as WebhookOutcome[];

  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? CLOSE_WEBHOOK_FILL_BUDGET_MS;
  const startedAt = now();
  const budgetSpent = () => now() - startedAt >= budgetMs;

  const out: WebhookOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.outcome !== "records") {
      out.push(outcome);
      continue;
    }
    const records: WebhookChangeRecord[] = [];
    let gone = 0;
    let stop: WebhookOutcome | null = null;
    for (const record of outcome.records as WebhookChangeRecord[]) {
      const filled = await fillRecord(deps, record, budgetSpent);
      if (filled.kind === "record") records.push(filled.record);
      else if (filled.kind === "gone") gone++;
      else {
        // One record that cannot be filled holds the whole event back:
        // none of it is applied unfilled.
        stop =
          filled.kind === "deferred"
            ? {
                eventId: outcome.eventId,
                outcome: "deferred",
                reason: filled.reason,
              }
            : {
                eventId: outcome.eventId,
                outcome: "extract_failed",
                reason: filled.reason,
              };
        break;
      }
    }
    if (stop) out.push(stop);
    else if (records.length > 0) out.push({ ...outcome, records });
    else {
      out.push({
        eventId: outcome.eventId,
        outcome: "skipped",
        reason: `Close no longer has ${gone} object(s) of this event (404)`,
      });
    }
  }
  return out;
}

/** The SDK's `webhooks` definition, given how this process reaches Close. */
export function closeWebhookDefinition<Config>(
  deps: (ctx: Context<Config>) => CloseWebhookDeps,
): WebhookDefinition<Config> {
  return {
    verification: CLOSE_WEBHOOK_VERIFICATION,
    events: closeSupportedWebhookEvents(),
    handleBatch: (ctx, events) => handleCloseWebhookBatch(deps(ctx), events),
  };
}
