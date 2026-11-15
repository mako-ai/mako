/**
 * Leads, contacts, opportunities and activities through Close's Search API.
 *
 * The Search API ignores `_skip` and its cursor is capped (~10k rows) and
 * unstable under DESC sort, so the walk is a sequence of small ASC date
 * windows on `date_created` (full backfill, oldest → now) or `date_updated`
 * (incremental, from `since`), paged with the native cursor inside each
 * window. Empty stretches are skipped with a binary search.
 *
 * Custom fields are requested as explicit `custom.cf_*` selectors, split so
 * no request exceeds Close's undocumented selector ceiling; the rest of a
 * page's custom fields are fetched by id (see fetchSupplementalCustomFields).
 */
import axios, { AxiosInstance } from "axios";
import type { FetchState, ResumableFetchOptions } from "../base/BaseConnector";
import { DAY_MS, addDaysIso } from "../base/incremental";
import { loggers } from "../../logging";
import {
  closeActivitySearchFields,
  closeCustomFieldSelectors,
  splitCloseSearchFieldSelection,
  type CloseCustomField,
  type CloseSearchFieldSelectionPlan,
} from "./schema";
import { formatCloseApiErrorResponse } from "./client";
import { closeSearchBaseFields, closeSearchObjectType } from "./entities";
import { normalizeCloseSearchBatch } from "./records";
import type { CloseSearchContext } from "./fetch-context";

const logger = loggers.connector("close");

/**
 * How many `custom.cf_*` selectors one Search API request may name.
 *
 * Close returns HTTP 400 when `_fields` grows past an undocumented ceiling:
 * ~80 total selectors are known to work, ~140 are known to fail. 60 custom
 * selectors plus the ~30 base fields stays under the known-good mark; the
 * rest of the custom fields are fetched for the same page with follow-up
 * by-id requests. If Close still rejects a request the batch is halved
 * (down to the minimum) and the page is retried, so a tighter ceiling
 * degrades into more requests rather than a failed sync.
 */
export const CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH = 60;
const CLOSE_SEARCH_MIN_CUSTOM_SELECTOR_BATCH = 5;

const SEARCH_PAGE_SIZE = 200;

// Forward-scanning ASC date windows avoid the non-deterministic row drops
// that occur with DESC sort + cursor resets.  Close's Search API cursor is
// unstable under DESC sort: resetting the cursor mid-window can silently
// skip records.  Small ASC windows (7 days) stay well under the ~10k cursor
// limit and produce deterministic, gap-free results.
const WINDOW_DAYS = 7;

type WindowField = "date_created" | "date_updated";

type SearchRow = Record<string, unknown> & { id?: unknown };

function isCloseSearchCursorError(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 400 &&
    Boolean(error.response?.data?.["field-errors"]?.cursor)
  );
}

function isHttp400(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 400;
}

const objectTypeQuery = (objectType: string) => ({
  negate: false,
  type: "object_type",
  object_type: objectType,
});

/** `[start, end)` on a date field; `end` omitted for an open range. */
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

export async function fetchCloseViaSearchApi(
  ctx: CloseSearchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { entity, onBatch, onProgress, state, since } = options;
  const api = ctx.api();
  const rateLimitDelay = Math.max(
    500,
    options.rateLimitDelay || ctx.rateLimitDelay(),
  );
  const maxIterations = options.maxIterations || 10;

  let recordCount = state?.totalProcessed || 0;
  let iterations = 0;

  // Incremental polls window on `date_updated` starting at `since`.
  // Full backfills keep the historical `date_created` walk (oldest → now).
  const windowField: WindowField = since ? "date_updated" : "date_created";

  // Date-window cursor: "before" boundary for descending pagination.
  // Close's Search API ignores _skip — we use native cursor tokens for
  // page-to-page navigation and date-based windowing to avoid the 10k limit.
  const dateWindowCursor: string | null = state?.metadata?.cursor ?? null;

  const objectType = closeSearchObjectType(entity);

  const fieldsMap = closeSearchBaseFields();
  // Activity subtypes request exactly the columns their schema declares,
  // so backfill, incremental polls and the warehouse table share one
  // definition (see closeActivitySearchFields).
  const activityFields = closeActivitySearchFields(entity);
  if (activityFields) {
    fieldsMap[objectType] = activityFields;
  }

  // Objects with custom fields (leads, contacts, opportunities, custom
  // activities): enumerate every custom field as an explicit
  // `custom.cf_<id>` selector so values come back as flat keys (matching the
  // schema's `custom_cf_*` columns and the shape webhooks deliver) instead
  // of the deprecated aggregate `custom` blob. The selection is split so no
  // single request exceeds the per-request selector budget; see
  // CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH. The custom-field lookup is cached
  // per connector instance.
  let searchCustomFields = await ctx.customFields.forSearch(objectType);
  const planFieldSelection = (): CloseSearchFieldSelectionPlan | null =>
    searchCustomFields
      ? splitCloseSearchFieldSelection(
          fieldsMap[objectType] || [],
          searchCustomFields,
          ctx.selectorBudget(),
        )
      : null;

  let windowStart: string | null =
    state?.metadata?.windowStart ?? dateWindowCursor ?? null;
  let windowEnd: string | null = state?.metadata?.windowEnd ?? null;
  let pageCursor: string | null = state?.metadata?.pageCursor ?? null;
  let lastSeenWindowValue: string | null =
    state?.metadata?.lastSeenWindowValue ??
    state?.metadata?.lastSeenDateCreated ??
    null;

  if (!state && onProgress) {
    try {
      const countQueries: unknown[] = [objectTypeQuery(objectType)];
      if (since) {
        countQueries.push(
          dateRangeQuery(objectType, windowField, since.toISOString()),
        );
      } else {
        countQueries.push({ negate: false, type: "match_all" });
      }
      const countResp = await api.post("/data/search/", {
        query: {
          negate: false,
          type: "and",
          queries: countQueries,
        },
        include_counts: true,
        results_limit: 0,
      });
      const total = countResp.data?.count?.total;
      if (typeof total === "number") {
        onProgress(0, total);
      }
    } catch {
      onProgress(0, undefined);
    }
  }

  // Resolve the date range on first invocation
  if (!windowStart) {
    if (since) {
      windowStart = since.toISOString();
    } else {
      const oldestResp = await api.post("/data/search/", {
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
      const oldestRow = oldestResp.data?.data?.[0];
      if (!oldestRow) {
        return {
          totalProcessed: recordCount,
          hasMore: false,
          iterationsInChunk: 0,
        };
      }
      windowStart = new Date(oldestRow.date_created).toISOString();
    }
  }

  // Upper bound: far-future sentinel so the last window captures everything
  const upperBound = new Date(Date.now() + DAY_MS).toISOString();

  if (!windowEnd) {
    windowEnd = addDaysIso(windowStart, WINDOW_DAYS);
  }

  // Invariant: windowStart and windowEnd are both set by this point.
  // Either we returned early in the oldestResp handler, or both have been
  // assigned above. Narrow for TypeScript to avoid non-null assertions below.
  if (windowStart === null || windowEnd === null) {
    return {
      totalProcessed: recordCount,
      hasMore: false,
      iterationsInChunk: 0,
    };
  }

  const doneState = (): FetchState => ({
    totalProcessed: recordCount,
    hasMore: false,
    iterationsInChunk: iterations,
    metadata: {
      windowStart,
      windowEnd,
      pageCursor: null,
      lastSeenWindowValue,
      windowField,
    },
  });

  while (iterations < maxIterations) {
    if (new Date(windowStart).getTime() >= new Date(upperBound).getTime()) {
      return doneState();
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
            dateRangeQuery(objectType, windowField, windowStart, windowEnd),
          ],
        },
        _limit: SEARCH_PAGE_SIZE,
        sort: [
          ascSort(objectType, windowField),
          ascSort(objectType, secondarySortField),
        ],
      };

      const fieldPlan = planFieldSelection();
      if (fieldPlan) {
        body._fields = { [objectType]: fieldPlan.primary };
      } else if (fieldsMap[objectType]) {
        body._fields = { [objectType]: fieldsMap[objectType] };
      }
      if (pageCursor) {
        body.cursor = pageCursor;
      }

      const response = await api.post("/data/search/", body);
      let data: SearchRow[] = response.data.data || [];
      pageCursor = response.data.cursor || null;

      if (fieldPlan && fieldPlan.supplemental.length > 0 && data.length > 0) {
        data = await fetchSupplementalCustomFields(
          ctx,
          api,
          objectType,
          data,
          fieldPlan.supplemental,
        );
      }

      if (data.length > 0) {
        const records = normalizeCloseSearchBatch(entity, data);
        await onBatch(records);
        recordCount += records.length;
        if (onProgress) onProgress(recordCount, undefined);

        const lastRow = data[data.length - 1];
        const lastValue = lastRow?.[windowField];
        if (typeof lastValue === "string" && lastValue.length > 0) {
          lastSeenWindowValue = new Date(lastValue).toISOString();
        }
      }

      if (data.length === 0 || !pageCursor) {
        // Window exhausted — advance to the next window
        windowStart = windowEnd;
        windowEnd = addDaysIso(windowStart, WINDOW_DAYS);
        pageCursor = null;

        if (data.length === 0) {
          // Empty window — binary-search forward to skip large gaps
          // efficiently instead of probing one 7-day window at a time.
          const nextStart = await findNextNonEmptyWindow(
            api,
            objectType,
            windowStart,
            upperBound,
            WINDOW_DAYS,
            windowField,
          );
          if (!nextStart) {
            // No more data until upperBound — done
            return doneState();
          }
          windowStart = nextStart;
          windowEnd = addDaysIso(windowStart, WINDOW_DAYS);
          continue;
        }
      }

      iterations++;
      await ctx.sleep(rateLimitDelay);
    } catch (error) {
      if (isCloseSearchCursorError(error)) {
        // Cursor expired / limit reached inside a window.
        // Advance windowStart to the last successfully fetched window
        // value so we don't re-emit rows already sent via onBatch.
        // If we haven't fetched anything yet in this window, halve the span.
        if (lastSeenWindowValue) {
          const normalizedLastSeenWindowValue = new Date(
            lastSeenWindowValue,
          ).toISOString();
          ctx.log(
            "info",
            "Close cursor limit reached, advancing past fetched rows",
            {
              entity,
              recordsFetched: recordCount,
              windowStart,
              windowEnd,
              advancingTo: normalizedLastSeenWindowValue,
              windowField,
            },
          );
          windowStart = normalizedLastSeenWindowValue;
          lastSeenWindowValue = null;
        } else {
          ctx.log("info", "Close cursor limit reached, halving date window", {
            entity,
            recordsFetched: recordCount,
            windowStart,
            windowEnd,
          });
          const currentSpan =
            new Date(windowEnd).getTime() - new Date(windowStart).getTime();
          const halfSpan = Math.max(currentSpan / 2, DAY_MS);
          windowEnd = new Date(
            new Date(windowStart).getTime() + halfSpan,
          ).toISOString();
        }
        pageCursor = null;
      } else if (searchCustomFields && isHttp400(error)) {
        // Close rejected the field selection. Two causes, checked in order:
        // the custom-field schema changed under us (a selector now names a
        // deleted field) — re-plan with the fresh schema; or the list is
        // simply too long — retry with a smaller per-request budget. The
        // cursor is unchanged either way, so the same page is retried.
        const refreshed = await ctx.customFields.refreshForSearch(objectType);
        if (
          customFieldSelectionChanged(
            ctx,
            entity,
            searchCustomFields,
            refreshed,
            error,
          )
        ) {
          searchCustomFields = refreshed;
          continue;
        }
        if (shrinkCustomSelectorBatch(ctx, error, entity, searchCustomFields)) {
          continue;
        }
        throw error;
      } else {
        throw error;
      }
    }
  }

  return {
    totalProcessed: recordCount,
    hasMore: true,
    iterationsInChunk: iterations,
    metadata: {
      windowStart,
      windowEnd,
      pageCursor,
      lastSeenWindowValue,
      windowField,
    },
  };
}

/**
 * True when a re-read of the custom-field schema yields a different set of
 * selectors than the one a rejected request was built from — i.e. the
 * schema changed mid-run. Logs what changed so the sync log explains the
 * retry.
 */
function customFieldSelectionChanged(
  ctx: CloseSearchContext,
  entity: string,
  previous: readonly CloseCustomField[],
  refreshed: readonly CloseCustomField[],
  error: unknown,
): boolean {
  const before = closeCustomFieldSelectors(previous);
  const after = new Set(closeCustomFieldSelectors(refreshed));
  const beforeSet = new Set(before);
  const removed = before.filter(selector => !after.has(selector));
  const added = [...after].filter(selector => !beforeSet.has(selector));
  if (removed.length === 0 && added.length === 0) return false;

  const details = {
    entity,
    removed,
    added,
    responseBody: formatCloseApiErrorResponse(error),
  };
  ctx.log(
    "warn",
    "Close custom-field schema changed during the run, re-planning the field selection",
    details,
  );
  logger.warn("Close custom-field schema changed mid-run", details);
  return true;
}

/**
 * Decide whether an HTTP 400 from the Search API should be treated as
 * "too many `_fields` selectors" and, if so, halve the per-request budget.
 * Returns true when the caller should retry with the smaller budget.
 *
 * Close does not document the ceiling, and the error text is not stable
 * enough to match on, so any 400 that is not the known cursor error, on a
 * request that carried custom selectors, shrinks the budget — until the
 * minimum is reached, at which point the error propagates.
 */
function shrinkCustomSelectorBatch(
  ctx: CloseSearchContext,
  error: unknown,
  entity: string,
  customFields: readonly CloseCustomField[] | null,
): boolean {
  if (!isHttp400(error)) return false;
  if (isCloseSearchCursorError(error)) return false;
  if (!customFields || closeCustomFieldSelectors(customFields).length === 0) {
    return false;
  }
  const previous = ctx.selectorBudget();
  if (previous <= CLOSE_SEARCH_MIN_CUSTOM_SELECTOR_BATCH) {
    return false;
  }

  const next = Math.max(
    CLOSE_SEARCH_MIN_CUSTOM_SELECTOR_BATCH,
    Math.floor(previous / 2),
  );
  ctx.setSelectorBudget(next);
  const details = {
    entity,
    previousBatchSize: previous,
    newBatchSize: next,
    responseBody: formatCloseApiErrorResponse(error),
  };
  ctx.log(
    "warn",
    "Close rejected the field selection, retrying with fewer custom selectors per request",
    details,
  );
  logger.warn(
    "Close rejected Search API field selection, shrinking batch",
    details,
  );
  return true;
}

/**
 * Re-fetch one already-paged set of rows by id, one request per selector
 * batch, and merge the returned `custom.cf_*` keys into the rows.
 *
 * This is what lets every custom field be requested explicitly on orgs
 * with more fields than Close accepts in a single `_fields` list: the paged
 * request carries the base fields plus the first batch, and each remaining
 * batch is fetched here for exactly the ids of that page. Row order and
 * the page cursor are untouched.
 */
async function fetchSupplementalCustomFields(
  ctx: CloseSearchContext,
  api: AxiosInstance,
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

  // Work through the batches; a batch that Close rejects is re-split with
  // the (now smaller) budget instead of being dropped.
  let pending: string[][] = supplemental.map(batch => [...batch]);
  while (pending.length > 0) {
    const batch = pending[0];
    try {
      const response = await api.post("/data/search/", {
        query: idQuery,
        _limit: ids.length,
        _fields: { [objectType]: batch },
      });
      const extra: SearchRow[] = response.data?.data || [];
      for (const row of extra) {
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
      // The client already retried (shared policy); a 429 that
      // survives that is surfaced, not treated as a field problem.
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        throw error;
      }
      const remainingFields: CloseCustomField[] = pending
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
          ctx.selectorBudget(),
        );
        // `primary` is `id` + the first batch; the rest are already
        // shaped as supplemental batches.
        pending = plan.supplemental;
        if (plan.primary.length > 1) pending.unshift(plan.primary);
      };

      if (isHttp400(error)) {
        const refreshed = await ctx.customFields.refreshForSearch(objectType);
        const current = new Set(closeCustomFieldSelectors(refreshed));
        const stillValid = remainingFields.filter(field =>
          current.has(`custom.${field.id}`),
        );
        if (
          stillValid.length !== remainingFields.length &&
          customFieldSelectionChanged(
            ctx,
            objectType,
            remainingFields,
            stillValid,
            error,
          )
        ) {
          replan(stillValid);
          continue;
        }
        if (
          shrinkCustomSelectorBatch(ctx, error, objectType, remainingFields)
        ) {
          replan(remainingFields);
          continue;
        }
      }
      throw error;
    }
  }

  return rows;
}

/**
 * Binary-search forward to find the start of the next non-empty date region.
 * Instead of scanning hundreds of 7-day empty windows one-by-one (each
 * costing an API request), this narrows the gap in ~log2(gapDays/windowDays)
 * lightweight `_limit: 1` probes.
 *
 * Returns the ISO timestamp of the start of the first window-aligned region
 * that contains data, or `null` if the entire range up to `upperBound` is
 * empty.
 */
async function findNextNonEmptyWindow(
  api: AxiosInstance,
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

  // First check: is there ANY data in [lo, hi) at all?
  const anyData = await probeSearchRange(
    api,
    objectType,
    new Date(lo).toISOString(),
    new Date(hi).toISOString(),
    windowField,
  );
  if (!anyData) return null;

  // Binary search: invariant — data exists somewhere in [lo, hi)
  while (hi - lo > windowMs) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const hasDataInLeft = await probeSearchRange(
      api,
      objectType,
      new Date(lo).toISOString(),
      new Date(mid).toISOString(),
      windowField,
    );

    if (hasDataInLeft) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return new Date(lo).toISOString();
}

/** Returns true if at least one record exists in [rangeStart, rangeEnd). */
async function probeSearchRange(
  api: AxiosInstance,
  objectType: string,
  rangeStart: string,
  rangeEnd: string,
  windowField: WindowField,
): Promise<boolean> {
  const resp = await api.post("/data/search/", {
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

  return (resp.data?.data?.length ?? 0) > 0;
}
