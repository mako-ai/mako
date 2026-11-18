/**
 * Leads, contacts, opportunities and activities through Close's Search API,
 * a port of `api/src/connectors/close/search.ts`.
 *
 * The walk is a sequence of 7-day ASC windows on `date_created` (full read,
 * oldest to now) or `date_updated` (incremental, from `since`), paged with
 * Close's cursor inside each window. Empty stretches are skipped with a
 * binary search. Custom fields are requested as `custom.cf_*` selectors,
 * split so no request exceeds the selector budget, and the rest of a page's
 * custom fields are fetched by id.
 *
 * Read state is the in-process `FetchState.metadata`: `windowStart`,
 * `windowEnd`, `pageCursor`, `lastSeenWindowValue` and `windowField`.
 *
 * One batch is yielded exactly where the in-process loop counts an
 * iteration, so a chunk of N iterations ends on the same page on both sides.
 * Empty windows and recoveries from a cursor error count no iteration and
 * yield nothing, as in-process.
 *
 * Page size. A page is 200 rows, or `__page_size` when the caller sets one
 * (capped at 200). A page whose records serialize to more than
 * `SEARCH_PAGE_BYTE_BUDGET` is dropped and read again at half the size,
 * from the same cursor, down to `MIN_SEARCH_PAGE_SIZE`. Close's search
 * cursor is an offset (`{"skip": n}`, signed), independent of `_limit`, so
 * the smaller page starts on the same row and its cursor ends where it
 * ends: no row is skipped or read twice. The smaller size is carried in
 * the state as `pageSize`, so the next chunk does not read the oversized
 * page again. A shrink counts no iteration and yields nothing. A full page
 * that serializes to at most half the budget doubles the next page, back
 * up to the full size, so a few large rows slow only their own stretch.
 */
import type { ReadBatch } from "@makoai/connector-sdk";
import {
  type CloseClient,
  CloseHttpError,
  isCloseSearchCursorError,
  isHttp400,
} from "./client.ts";
import { CLOSE_SEARCH_BASE_FIELDS, closeSearchObjectType } from "./catalog.ts";
import type { CloseCustomFieldCache } from "./custom-fields.ts";
import { normalizeCloseSearchBatch } from "./records.ts";
import {
  type CloseCustomField,
  type CloseSearchFieldSelectionPlan,
  closeActivitySearchFields,
  closeCustomFieldSelectors,
  splitCloseSearchFieldSelection,
} from "./schema.ts";

export const CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH = 60;
const MIN_CUSTOM_SELECTOR_BATCH = 5;
export const SEARCH_PAGE_SIZE = 200;
/** The smallest page a shrink goes to. A page this small is kept as is. */
export const MIN_SEARCH_PAGE_SIZE = 10;
/**
 * Bytes one page's records may serialize to. Mako caps a chunk's protocol
 * output at 32 MiB (`MAX_CONNECTOR_PROTOCOL_BYTES`) and ends a chunk after
 * the page that crosses half of it (`CHUNK_BYTE_BUDGET`, 16 MiB). A page
 * must therefore fit in the other 16 MiB with its RECORD envelopes and logs:
 * 8 MiB leaves half of that as margin.
 */
export const SEARCH_PAGE_BYTE_BUDGET = 8 * 1024 * 1024;
export const WINDOW_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

type WindowField = "date_created" | "date_updated";
type SearchRow = Record<string, unknown> & { id?: unknown };

export interface SearchState {
  windowStart?: string | null;
  windowEnd?: string | null;
  pageCursor?: string | null;
  lastSeenWindowValue?: string | null;
  /** Older in-process states. */
  lastSeenDateCreated?: string | null;
  cursor?: string | null;
  windowField?: WindowField;
  /** Rows per page after a shrink; absent while the page is full size. */
  pageSize?: number | null;
}

export interface SearchContext {
  api: CloseClient;
  customFields: CloseCustomFieldCache;
  log: (message: string) => void;
  /** `max(500, rate_limit_delay_ms)`, slept after every counted page. */
  pause: () => Promise<void>;
  /** Per-process selector budget; only ever shrinks. */
  selectorBudget: { size: number };
  /** Rows per page: 200, or `__page_size` capped at 200. */
  pageSize?: number;
  /** Bytes one page's records may serialize to; see SEARCH_PAGE_BYTE_BUDGET. */
  pageByteBudget?: number;
}

/** The page size for `__page_size`: 200 unless set lower. */
export function searchPageSize(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0
    ? Math.min(n, SEARCH_PAGE_SIZE)
    : SEARCH_PAGE_SIZE;
}

/** UTF-8 bytes of the records as JSON, as the runner writes them. */
const serializedBytes = (records: unknown[]): number =>
  new TextEncoder().encode(JSON.stringify(records)).length;

const addDaysIso = (iso: string, days: number) =>
  new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();

const objectTypeQuery = (objectType: string) => ({
  negate: false,
  type: "object_type",
  object_type: objectType,
});

function dateRangeQuery(
  objectType: string,
  field: WindowField,
  start: string,
  end?: string,
) {
  return {
    type: "field_condition",
    field: {
      type: "regular_field",
      object_type: objectType,
      field_name: field,
    },
    condition: {
      type: "moment_range",
      on_or_after: { type: "fixed_utc", value: start },
      ...(end !== undefined && { before: { type: "fixed_utc", value: end } }),
    },
  };
}

const ascSort = (objectType: string, field: string) => ({
  direction: "asc",
  field: {
    object_type: objectType,
    type: "regular_field",
    field_name: field,
  },
});

export async function* readCloseSearch(
  ctx: SearchContext,
  entity: string,
  state: SearchState,
  since: Date | undefined,
): AsyncGenerator<ReadBatch> {
  const { api } = ctx;
  // A resumed walk keeps the field it started on. The in-process connector
  // recomputes it from `since` on every chunk, and the engine passes `since`
  // to a scheduled poll's first chunk only, so its later chunks switch to
  // `date_created` mid-walk. When `since` comes every chunk (the daily
  // resync, the parity harness) the two agree.
  const windowField: WindowField =
    state.windowField === "date_updated" || state.windowField === "date_created"
      ? state.windowField
      : since
        ? "date_updated"
        : "date_created";
  const objectType = closeSearchObjectType(entity);
  const baseFields =
    closeActivitySearchFields(entity) ??
    CLOSE_SEARCH_BASE_FIELDS[objectType] ??
    [];

  let searchCustomFields = await ctx.customFields.forSearch(objectType);
  const planFieldSelection = (): CloseSearchFieldSelectionPlan | null =>
    searchCustomFields
      ? splitCloseSearchFieldSelection(
          baseFields,
          searchCustomFields,
          ctx.selectorBudget.size,
        )
      : null;

  let windowStart: string | null = state.windowStart ?? state.cursor ?? null;
  let windowEnd: string | null = state.windowEnd ?? null;
  let pageCursor: string | null = state.pageCursor ?? null;
  let lastSeenWindowValue: string | null =
    state.lastSeenWindowValue ?? state.lastSeenDateCreated ?? null;
  const fullPageSize = ctx.pageSize ?? SEARCH_PAGE_SIZE;
  const byteBudget = ctx.pageByteBudget ?? SEARCH_PAGE_BYTE_BUDGET;
  const resumedPageSize = Number(state.pageSize);
  let pageSize =
    Number.isInteger(resumedPageSize) && resumedPageSize > 0
      ? Math.min(resumedPageSize, fullPageSize)
      : fullPageSize;

  if (!windowStart) {
    if (since) {
      windowStart = since.toISOString();
    } else {
      const oldest = await api.post("/data/search/", {
        query: {
          negate: false,
          type: "and",
          queries: [
            objectTypeQuery(objectType),
            { negate: false, type: "match_all" },
          ],
        },
        _limit: 1,
        sort: [ascSort(objectType, "date_created")],
        _fields: { [objectType]: ["id", "date_created"] },
      });
      const oldestRow = oldest?.data?.[0];
      if (!oldestRow) {
        yield { records: [], state: {}, hasMore: false };
        return;
      }
      windowStart = new Date(oldestRow.date_created).toISOString();
    }
  }

  const upperBound = new Date(Date.now() + DAY_MS).toISOString();
  if (!windowEnd) windowEnd = addDaysIso(windowStart, WINDOW_DAYS);

  const position = () => ({
    windowStart,
    windowEnd,
    pageCursor,
    lastSeenWindowValue,
    windowField,
    ...(pageSize < fullPageSize ? { pageSize } : {}),
  });
  const done = (): ReadBatch => ({
    records: [],
    state: { ...position(), pageCursor: null },
    hasMore: false,
  });

  let paused = true;
  while (true) {
    if (!paused) {
      await ctx.pause();
      paused = true;
    }
    if (
      new Date(windowStart as string).getTime() >=
      new Date(upperBound).getTime()
    ) {
      yield done();
      return;
    }

    try {
      const secondarySortField =
        windowField === "date_updated" ? "date_created" : "date_updated";
      const body: Record<string, unknown> = {
        query: {
          negate: false,
          type: "and",
          queries: [
            objectTypeQuery(objectType),
            dateRangeQuery(
              objectType,
              windowField,
              windowStart as string,
              windowEnd as string,
            ),
          ],
        },
        _limit: pageSize,
        sort: [
          ascSort(objectType, windowField),
          ascSort(objectType, secondarySortField),
        ],
      };
      const fieldPlan = planFieldSelection();
      if (fieldPlan) {
        body._fields = { [objectType]: fieldPlan.primary };
      } else if (baseFields.length > 0) {
        body._fields = { [objectType]: baseFields };
      }
      if (pageCursor) body.cursor = pageCursor;

      const response = await api.post("/data/search/", body);
      let data: SearchRow[] = response?.data || [];
      // Moved only once the page is complete: a follow-up that fails must
      // retry this page, not skip it. (In-process moves it first.)
      const nextCursor: string | null = response?.cursor || null;

      if (fieldPlan && fieldPlan.supplemental.length > 0 && data.length > 0) {
        data = await fetchSupplementalCustomFields(
          ctx,
          objectType,
          data,
          fieldPlan.supplemental,
        );
      }

      let records: unknown[] = [];
      if (data.length > 0) {
        records = normalizeCloseSearchBatch(entity, data);
        const bytes = serializedBytes(records);
        if (pageSize > MIN_SEARCH_PAGE_SIZE && bytes > byteBudget) {
          // Drop the page and read it again, smaller, from the same
          // cursor: nothing about the position has moved yet.
          const next = Math.max(
            MIN_SEARCH_PAGE_SIZE,
            Math.floor(pageSize / 2),
          );
          ctx.log(
            `Close page of ${data.length} ${entity} rows is ${bytes} bytes, over the ${byteBudget}-byte page budget; ${pageSize} -> ${next} rows per page`,
          );
          pageSize = next;
          continue;
        }
        // A full page at most half the budget: the next page doubles,
        // back up to the full size. One run of large rows no longer
        // pins the rest of the walk to the smallest page.
        if (
          pageSize < fullPageSize &&
          data.length >= pageSize &&
          bytes * 2 <= byteBudget
        ) {
          pageSize = Math.min(fullPageSize, pageSize * 2);
        }
      }
      pageCursor = nextCursor;

      if (data.length > 0) {
        const lastValue = data[data.length - 1]?.[windowField];
        if (typeof lastValue === "string" && lastValue.length > 0) {
          lastSeenWindowValue = new Date(lastValue).toISOString();
        }
      }

      if (data.length === 0 || !pageCursor) {
        windowStart = windowEnd as string;
        windowEnd = addDaysIso(windowStart, WINDOW_DAYS);
        pageCursor = null;
        if (data.length === 0) {
          const nextStart = await findNextNonEmptyWindow(
            api,
            objectType,
            windowStart,
            upperBound,
            WINDOW_DAYS,
            windowField,
          );
          if (!nextStart) {
            yield done();
            return;
          }
          windowStart = nextStart;
          windowEnd = addDaysIso(windowStart, WINDOW_DAYS);
          continue;
        }
      }

      // The in-process iteration: one counted page.
      paused = false;
      yield { records, state: position(), hasMore: true };
    } catch (error) {
      if (isCloseSearchCursorError(error)) {
        if (lastSeenWindowValue) {
          const advanceTo = new Date(lastSeenWindowValue).toISOString();
          ctx.log(
            `Close cursor limit reached on ${entity}, advancing ${windowField} window to ${advanceTo}`,
          );
          windowStart = advanceTo;
          lastSeenWindowValue = null;
        } else {
          ctx.log(
            `Close cursor limit reached on ${entity}, halving the date window`,
          );
          const span: number =
            new Date(windowEnd as string).getTime() -
            new Date(windowStart as string).getTime();
          windowEnd = new Date(
            new Date(windowStart as string).getTime() +
              Math.max(span / 2, DAY_MS),
          ).toISOString();
        }
        pageCursor = null;
      } else if (searchCustomFields && isHttp400(error)) {
        const refreshed = await ctx.customFields.refreshForSearch(objectType);
        if (selectionChanged(ctx, entity, searchCustomFields, refreshed)) {
          searchCustomFields = refreshed;
          continue;
        }
        if (shrinkSelectorBudget(ctx, entity, searchCustomFields)) continue;
        throw error;
      } else {
        throw error;
      }
    }
  }
}

function selectionChanged(
  ctx: SearchContext,
  entity: string,
  previous: readonly CloseCustomField[],
  refreshed: readonly CloseCustomField[],
): boolean {
  const before = closeCustomFieldSelectors(previous);
  const after = new Set(closeCustomFieldSelectors(refreshed));
  const beforeSet = new Set(before);
  const removed = before.filter(selector => !after.has(selector));
  const added = [...after].filter(selector => !beforeSet.has(selector));
  if (removed.length === 0 && added.length === 0) return false;
  ctx.log(
    `Close custom-field schema changed during the run on ${entity}: removed ${removed.join(",") || "none"}, added ${added.join(",") || "none"}`,
  );
  return true;
}

/** Halve the selector budget after a 400; false at the minimum. */
function shrinkSelectorBudget(
  ctx: SearchContext,
  entity: string,
  customFields: readonly CloseCustomField[] | null,
): boolean {
  if (!customFields || closeCustomFieldSelectors(customFields).length === 0) {
    return false;
  }
  const previous = ctx.selectorBudget.size;
  if (previous <= MIN_CUSTOM_SELECTOR_BATCH) return false;
  const next = Math.max(MIN_CUSTOM_SELECTOR_BATCH, Math.floor(previous / 2));
  ctx.selectorBudget.size = next;
  ctx.log(
    `Close rejected the field selection on ${entity}; ${previous} -> ${next} custom selectors per request`,
  );
  return true;
}

async function fetchSupplementalCustomFields(
  ctx: SearchContext,
  objectType: string,
  rows: SearchRow[],
  supplemental: string[][],
): Promise<SearchRow[]> {
  const ids = rows
    .map(row => (typeof row?.id === "string" ? row.id : ""))
    .filter(id => id.length > 0);
  if (ids.length === 0) return rows;

  const byId = new Map<string, SearchRow>();
  for (const row of rows) {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  }
  const idQuery = {
    negate: false,
    type: "and",
    queries: [
      objectTypeQuery(objectType),
      {
        negate: false,
        type: "or",
        queries: ids.map(id => ({ negate: false, type: "id", value: id })),
      },
    ],
  };

  let pending: string[][] = supplemental.map(batch => [...batch]);
  while (pending.length > 0) {
    const batch = pending[0];
    try {
      const response = await ctx.api.post("/data/search/", {
        query: idQuery,
        _limit: ids.length,
        _fields: { [objectType]: batch },
      });
      for (const row of (response?.data || []) as SearchRow[]) {
        if (!row || typeof row.id !== "string") continue;
        const target = byId.get(row.id);
        if (!target) continue;
        for (const [key, value] of Object.entries(row)) {
          if (key === "id" || key === "__object_type") continue;
          target[key] = value;
        }
      }
      pending.shift();
    } catch (error) {
      if (error instanceof CloseHttpError && error.status === 429) throw error;
      const remaining: CloseCustomField[] = pending
        .flatMap(b => b.filter(field => field !== "id"))
        .map(selector => ({
          id: selector.replace(/^custom\./, ""),
          name: selector,
          type: "text",
          appliesTo: objectType,
        }));
      const replan = (fields: readonly CloseCustomField[]) => {
        const plan = splitCloseSearchFieldSelection(
          [],
          fields,
          ctx.selectorBudget.size,
        );
        pending = plan.supplemental;
        if (plan.primary.length > 1) pending.unshift(plan.primary);
      };
      if (isHttp400(error)) {
        const refreshed = await ctx.customFields.refreshForSearch(objectType);
        const current = new Set(closeCustomFieldSelectors(refreshed));
        const stillValid = remaining.filter(field =>
          current.has(`custom.${field.id}`),
        );
        if (
          stillValid.length !== remaining.length &&
          selectionChanged(ctx, objectType, remaining, stillValid)
        ) {
          replan(stillValid);
          continue;
        }
        if (shrinkSelectorBudget(ctx, objectType, remaining)) {
          replan(remaining);
          continue;
        }
      }
      throw error;
    }
  }
  return rows;
}

/** Start of the first window-aligned region with data, or null. */
async function findNextNonEmptyWindow(
  api: CloseClient,
  objectType: string,
  gapStart: string,
  upperBound: string,
  windowDays: number,
  windowField: WindowField,
): Promise<string | null> {
  let lo = new Date(gapStart).getTime();
  let hi = new Date(upperBound).getTime();
  const windowMs = windowDays * DAY_MS;
  if (lo >= hi) return null;
  const any = await probeSearchRange(
    api,
    objectType,
    new Date(lo).toISOString(),
    new Date(hi).toISOString(),
    windowField,
  );
  if (!any) return null;
  while (hi - lo > windowMs) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const left = await probeSearchRange(
      api,
      objectType,
      new Date(lo).toISOString(),
      new Date(mid).toISOString(),
      windowField,
    );
    if (left) hi = mid;
    else lo = mid;
  }
  return new Date(lo).toISOString();
}

async function probeSearchRange(
  api: CloseClient,
  objectType: string,
  rangeStart: string,
  rangeEnd: string,
  windowField: WindowField,
): Promise<boolean> {
  const response = await api.post("/data/search/", {
    query: {
      negate: false,
      type: "and",
      queries: [
        objectTypeQuery(objectType),
        dateRangeQuery(objectType, windowField, rangeStart, rangeEnd),
      ],
    },
    _limit: 1,
    _fields: { [objectType]: ["id"] },
  });
  return (response?.data?.length ?? 0) > 0;
}
