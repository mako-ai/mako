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
 * parity-tested) and fixes the one thing a payload cannot be trusted with:
 * Close's `lead.*` events carry the lead without its nested `contacts`,
 * `opportunities` and `tasks`. Written as is, the row would overwrite those
 * columns, and `contact_ids` rebuilt from them, with NULL. So every lead
 * upsert is re-fetched by id through the Search API, with the same field
 * selection a read uses, and the row Close returns replaces the payload. A
 * lead Close no longer returns (merged away, deleted since) writes nothing;
 * the event's own `lead.deleted` or the daily resync settles it.
 */
import type {
  Context,
  WebhookDefinition,
  WebhookEvent,
  WebhookOutcome,
  WebhookVerification,
} from "@makoai/connector-sdk";
import { CLOSE_SEARCH_BASE_FIELDS, closeSearchObjectType } from "./catalog.ts";
import { type CloseClient, CloseHttpError, isHttp400 } from "./client.ts";
import type { CloseCustomFieldCache } from "./custom-fields.ts";
import { normalizeCloseSearchBatch } from "./records.ts";
import {
  closeActivitySearchFields,
  splitCloseSearchFieldSelection,
} from "./schema.ts";
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
};

/** Entities whose webhook payload is partial, so the row is re-fetched. */
export const CLOSE_REFETCH_ENTITIES: ReadonlySet<string> = new Set(["leads"]);

/** Ids per by-id Search request. Close pages Search at 200 rows. */
export const CLOSE_REFETCH_IDS_PER_REQUEST = 100;
const MIN_SELECTOR_BUDGET = 5;

type Row = Record<string, unknown> & { id?: unknown };

export interface CloseWebhookDeps {
  api: CloseClient;
  customFields: CloseCustomFieldCache;
  /** Shared with reads in the same process: only ever shrinks. */
  selectorBudget: { size: number };
  log: (message: string) => void;
}

const idQuery = (objectType: string, ids: string[]) => ({
  negate: false,
  type: "and",
  queries: [
    { negate: false, type: "object_type", object_type: objectType },
    {
      negate: false,
      type: "or",
      queries: ids.map(id => ({ negate: false, type: "id", value: id })),
    },
  ],
});

/**
 * Rows of `entity` by id, in the shape a read stores: the read's base fields
 * plus every custom field, split across requests as a read splits them.
 */
export async function fetchCloseRowsById(
  deps: CloseWebhookDeps,
  entity: string,
  ids: string[],
): Promise<Map<string, Row>> {
  const objectType = closeSearchObjectType(entity);
  const baseFields =
    closeActivitySearchFields(entity) ??
    CLOSE_SEARCH_BASE_FIELDS[objectType] ??
    [];
  const rows = new Map<string, Row>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += CLOSE_REFETCH_IDS_PER_REQUEST) {
    const chunk = unique.slice(i, i + CLOSE_REFETCH_IDS_PER_REQUEST);
    for (const row of await fetchChunk(
      deps,
      entity,
      objectType,
      baseFields,
      chunk,
    )) {
      if (typeof row.id === "string") rows.set(row.id, row);
    }
  }
  return rows;
}

async function fetchChunk(
  deps: CloseWebhookDeps,
  entity: string,
  objectType: string,
  baseFields: string[],
  ids: string[],
): Promise<Row[]> {
  let custom = await deps.customFields.forSearch(objectType);
  for (;;) {
    const plan = splitCloseSearchFieldSelection(
      baseFields,
      custom ?? [],
      deps.selectorBudget.size,
    );
    try {
      const response = await deps.api.post("/data/search/", {
        query: idQuery(objectType, ids),
        _limit: ids.length,
        _fields: { [objectType]: plan.primary },
      });
      const data = ((response?.data || []) as Row[]).filter(
        row => row && typeof row.id === "string",
      );
      const byId = new Map(data.map(row => [row.id as string, row]));
      for (const fields of plan.supplemental) {
        if (byId.size === 0) break;
        const extra = await deps.api.post("/data/search/", {
          query: idQuery(objectType, [...byId.keys()]),
          _limit: byId.size,
          _fields: { [objectType]: fields },
        });
        for (const row of (extra?.data || []) as Row[]) {
          const target =
            row && typeof row.id === "string" ? byId.get(row.id) : undefined;
          if (!target) continue;
          for (const [key, value] of Object.entries(row)) {
            if (key === "id" || key === "__object_type") continue;
            target[key] = value;
          }
        }
      }
      return normalizeCloseSearchBatch(entity, data) as Row[];
    } catch (error) {
      // A refused selection: the schema may have changed, or the account
      // is past Close's selector ceiling. Re-read it and halve the budget,
      // as a read does, down to the floor.
      if (!isHttp400(error) || !custom?.length) throw error;
      if (deps.selectorBudget.size <= MIN_SELECTOR_BUDGET) throw error;
      deps.selectorBudget.size = Math.max(
        MIN_SELECTOR_BUDGET,
        Math.floor(deps.selectorBudget.size / 2),
      );
      deps.log(
        `Close rejected the field selection on a ${entity} re-fetch; ${deps.selectorBudget.size} custom selectors per request`,
      );
      custom = await deps.customFields.refreshForSearch(objectType);
    }
  }
}

/** The later of two ISO times; the first when the second does not parse. */
function later(first: string, second: unknown): string {
  if (typeof second !== "string") return first;
  const b = new Date(second);
  if (Number.isNaN(b.getTime())) return first;
  return b.getTime() > new Date(first).getTime() ? b.toISOString() : first;
}

const needsRefetch = (record: WebhookChangeRecord) =>
  record.operation === "upsert" && CLOSE_REFETCH_ENTITIES.has(record.entity);

/**
 * A batch in, one outcome per event out, in order. Payloads that are whole
 * pass through as the in-process connector extracts them; lead upserts are
 * replaced by the row Close returns now.
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

  const wanted = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (outcome.outcome !== "records") continue;
    for (const record of outcome.records as WebhookChangeRecord[]) {
      if (!needsRefetch(record)) continue;
      const ids = wanted.get(record.entity) ?? [];
      ids.push(record.recordId);
      wanted.set(record.entity, ids);
    }
  }
  if (wanted.size === 0) return outcomes;

  const fetched = new Map<string, Map<string, Row>>();
  for (const [entity, ids] of wanted) {
    fetched.set(entity, await fetchCloseRowsById(deps, entity, ids));
  }

  // Search is an index, and it can lag behind a write. A row it does not
  // return is confirmed gone by a direct read (404) before the event is
  // skipped; a row older than the event's own copy is stale. Either way
  // the event fails, and Mako retries it later, rather than writing an old
  // row as new or dropping a lead that exists.
  const gone = new Map<string, boolean>();
  const isGone = async (entity: string, id: string): Promise<boolean> => {
    const key = `${entity} ${id}`;
    if (!gone.has(key)) gone.set(key, await confirmGone(deps, entity, id));
    return gone.get(key) as boolean;
  };

  const out: WebhookOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.outcome !== "records") {
      out.push(outcome);
      continue;
    }
    const missing: string[] = [];
    const lagging: string[] = [];
    const records: WebhookChangeRecord[] = [];
    for (const record of outcome.records as WebhookChangeRecord[]) {
      if (!needsRefetch(record)) {
        records.push(record);
        continue;
      }
      const label = `${record.entity} ${record.recordId}`;
      const row = fetched.get(record.entity)?.get(record.recordId);
      if (!row) {
        if (await isGone(record.entity, record.recordId)) missing.push(label);
        else lagging.push(label);
        continue;
      }
      if (isOlder(row.date_updated, record.payload?.date_updated)) {
        lagging.push(label);
        continue;
      }
      records.push({
        ...record,
        payload: row,
        // The row is as of now: never older than the event.
        sourceTs: later(record.sourceTs, row.date_updated),
      });
    }
    if (lagging.length > 0) {
      out.push({
        eventId: outcome.eventId,
        outcome: "extract_failed",
        reason: `Close search has not caught up with ${lagging.join(", ")}; retry later`,
      });
    } else if (records.length > 0) {
      out.push({ ...outcome, records });
    } else {
      out.push({
        eventId: outcome.eventId,
        outcome: "skipped",
        reason: `Close no longer has ${missing.join(", ")}`,
      });
    }
  }
  return out;
}

/** Whether `a` parses to a time strictly before `b`. False if either does not. */
function isOlder(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  return Number.isFinite(x) && Number.isFinite(y) && x < y;
}

/** Endpoint of one object by id, for the entities that are re-fetched. */
const OBJECT_ENDPOINTS: Record<string, string> = { leads: "/lead/" };

/** True only when Close answers 404 for the object itself. */
async function confirmGone(
  deps: CloseWebhookDeps,
  entity: string,
  id: string,
): Promise<boolean> {
  const endpoint = OBJECT_ENDPOINTS[entity];
  if (!endpoint) return false;
  try {
    await deps.api.get(`${endpoint}${encodeURIComponent(id)}/`, {
      _fields: "id",
    });
    return false;
  } catch (error) {
    if (error instanceof CloseHttpError && error.status === 404) return true;
    return false;
  }
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
