/**
 * Close entities read from plain list endpoints with `_limit`/`_skip`
 * pagination: users, groups, lookup tables, custom fields, and the legacy
 * list walk `fetchEntity` uses for leads/contacts/opportunities.
 */
import type {
  FetchOptions,
  FetchState,
  ResumableFetchOptions,
} from "../base/BaseConnector";
import { paginateByOffset } from "../base/pagination";
import { isoDay } from "../base/incremental";
import { loggers } from "../../logging";
import { CLOSE_CUSTOM_FIELD_ENDPOINTS, closeEntityEndpoint } from "./entities";
import { normalizeCloseLeadBatch } from "./records";
import type { CloseFetchContext } from "./fetch-context";

const logger = loggers.connector("close");

const DEFAULT_MAX_ITERATIONS = 10;

type ListPage = { data?: unknown[]; has_more?: boolean };

function pageOf(body: ListPage) {
  return { records: body.data || [], hasMore: body.has_more || false };
}

/** Users: `/user/` takes no `_order_by` and no `since` filter. */
export async function fetchCloseUsersChunk(
  ctx: CloseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, state } = options;
  const api = ctx.api();
  const batchSize = options.batchSize || ctx.batchSize();
  const rateLimitDelay = options.rateLimitDelay || ctx.rateLimitDelay();

  let totalCount: number | undefined = state?.metadata?.totalCount;
  if (!state && onProgress) {
    try {
      const countResponse = await api.get("/user/", {
        params: { _limit: 0 },
      });
      totalCount = countResponse.data.total_results;
      onProgress(0, totalCount);
    } catch (error) {
      logger.warn("Could not fetch total count for users", { error });
    }
  }

  const result = await paginateByOffset({
    pageSize: batchSize,
    startOffset: state?.offset || 0,
    startCount: state?.totalProcessed || 0,
    maxIterations: options.maxIterations || DEFAULT_MAX_ITERATIONS,
    fetchPage: async offset => {
      const response = await api.get("/user/", {
        // Note: /user/ endpoint doesn't support _order_by parameter
        params: { _limit: batchSize, _skip: offset },
      });
      return pageOf(response.data);
    },
    onBatch,
    onProgress: onProgress && (n => onProgress(n, totalCount)),
    pause: () => ctx.sleep(rateLimitDelay),
  });

  return {
    offset: result.offset,
    totalProcessed: result.totalProcessed,
    hasMore: result.hasMore,
    iterationsInChunk: result.iterations,
    metadata: { totalCount },
  };
}

/**
 * A lookup list (statuses, types, groups) with no filters. A resumed chunk
 * whose previous one finished has nothing left to do.
 */
export async function fetchCloseLookupChunk(
  ctx: CloseFetchContext,
  options: ResumableFetchOptions,
  endpoint: string,
  extraParams: Record<string, string> = {},
): Promise<FetchState> {
  const { onBatch, onProgress, state } = options;

  if (state && !state.hasMore) {
    return {
      totalProcessed: state.totalProcessed,
      hasMore: false,
      iterationsInChunk: 0,
    };
  }

  const api = ctx.api();
  const batchSize = options.batchSize || ctx.batchSize();
  const rateLimitDelay = options.rateLimitDelay || ctx.rateLimitDelay();

  const result = await paginateByOffset({
    pageSize: batchSize,
    startOffset: state?.offset || 0,
    startCount: state?.totalProcessed || 0,
    maxIterations: options.maxIterations || DEFAULT_MAX_ITERATIONS,
    fetchPage: async offset => {
      const response = await api.get(endpoint, {
        params: { _limit: batchSize, _skip: offset, ...extraParams },
      });
      return pageOf(response.data);
    },
    onBatch,
    onProgress: onProgress && (n => onProgress(n, undefined)),
    pause: () => ctx.sleep(rateLimitDelay),
  });

  return {
    offset: result.offset,
    totalProcessed: result.totalProcessed,
    hasMore: result.hasMore,
    iterationsInChunk: result.iterations,
  };
}

/**
 * Fetch user groups (functional teams). Unlike the simple lookup endpoints,
 * the `/group/` list endpoint only returns `name`/`members` when those
 * fields are explicitly requested via `_fields`, so groups always send the
 * selector.
 */
export function fetchCloseGroupsChunk(
  ctx: CloseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  return fetchCloseLookupChunk(ctx, options, "/group/", {
    // `/group/` omits name/members unless explicitly requested.
    _fields: "id,name,members,organization_id",
  });
}

/** One page of the legacy lead list (POST tunnelled as GET). */
async function requestLeadsPage(
  ctx: CloseFetchContext,
  leadFields: () => Promise<string>,
  options: { limit: number; offset: number; since?: Date; orderBy: string },
) {
  const api = ctx.api();
  const fields = await leadFields();
  const params: Record<string, unknown> = {
    _limit: options.limit,
    _skip: options.offset,
    _order_by: options.orderBy,
    _fields: fields,
  };

  if (options.since) {
    params.query = `date_updated>="${isoDay(options.since)}"`;
  }

  return api.post(
    "/lead/",
    { _params: params },
    {
      headers: {
        "x-http-method-override": "GET",
      },
    },
  );
}

/**
 * Offset walk over an entity's list endpoint, filtered on `date_updated`
 * when `since` is set. Leads go through the lead list (custom fields
 * selected explicitly) and are normalized.
 */
export async function fetchCloseListChunk(
  ctx: CloseFetchContext,
  entity: string,
  options: ResumableFetchOptions,
  leadFields: () => Promise<string>,
): Promise<FetchState> {
  const { onBatch, onProgress, since, state } = options;
  const api = ctx.api();
  const batchSize = options.batchSize || ctx.batchSize();
  const rateLimitDelay = options.rateLimitDelay || ctx.rateLimitDelay();

  let totalCount: number | undefined = state?.metadata?.totalCount;
  if (!state && onProgress) {
    totalCount = await fetchCloseTotalCount(ctx, entity, since);
    if (totalCount !== undefined) {
      onProgress(0, totalCount);
    }
  }

  const result = await paginateByOffset({
    pageSize: batchSize,
    startOffset: state?.offset || 0,
    startCount: state?.totalProcessed || 0,
    maxIterations: options.maxIterations || DEFAULT_MAX_ITERATIONS,
    fetchPage: async offset => {
      if (entity === "leads") {
        const response = await requestLeadsPage(ctx, leadFields, {
          limit: batchSize,
          offset,
          since,
          orderBy: since ? "-date_updated" : "id",
        });
        const page = pageOf(response.data);
        return { ...page, records: normalizeCloseLeadBatch(page.records) };
      }

      const params: Record<string, unknown> = {
        _limit: batchSize,
        _skip: offset,
        _order_by: "id", // Consistent ordering for pagination stability
      };
      const endpoint = closeEntityEndpoint(entity);
      if (since) {
        params.date_updated__gte = isoDay(since);
        params._order_by = "-date_updated";
      }
      const response = await api.get(endpoint, { params });
      return pageOf(response.data);
    },
    onBatch,
    onProgress: onProgress && (n => onProgress(n, totalCount)),
    pause: () => ctx.sleep(rateLimitDelay),
  });

  return {
    offset: result.offset,
    totalProcessed: result.totalProcessed,
    hasMore: result.hasMore,
    iterationsInChunk: result.iterations,
    metadata: { totalCount },
  };
}

/** Every custom field of every type, each tagged with its type. */
export async function fetchAllCloseCustomFields(
  ctx: CloseFetchContext,
  options: FetchOptions,
): Promise<void> {
  const { onBatch, onProgress } = options;
  const api = ctx.api();

  let totalFields = 0;
  let processedFields = 0;

  // First, get total count
  if (onProgress) {
    for (const { endpoint } of CLOSE_CUSTOM_FIELD_ENDPOINTS) {
      try {
        const response = await api.get(endpoint, { params: { _limit: 0 } });
        totalFields += response.data.total_results || 0;
      } catch (error) {
        // Skip if endpoint doesn't exist or errors
        logger.warn("Could not fetch count from endpoint", {
          endpoint,
          error,
        });
      }
    }
    onProgress(0, totalFields);
  }

  for (const { endpoint, type } of CLOSE_CUSTOM_FIELD_ENDPOINTS) {
    try {
      const response = await api.get(endpoint);
      const fields: Record<string, unknown>[] = response.data.data || [];

      const fieldsWithType = fields.map(field => ({
        ...field,
        custom_field_type: type,
      }));

      if (fieldsWithType.length > 0) {
        await onBatch(fieldsWithType);
        processedFields += fieldsWithType.length;

        if (onProgress) {
          onProgress(processedFields, totalFields);
        }
      }
    } catch (error) {
      // Log but continue with other endpoints
      logger.warn("Error fetching from endpoint", { endpoint, error });
    }
  }
}

const COUNTED_ENDPOINTS: Record<string, string> = {
  leads: "/lead/",
  opportunities: "/opportunity/",
  contacts: "/contact/",
};

export async function fetchCloseTotalCount(
  ctx: CloseFetchContext,
  entity: string,
  since?: Date,
): Promise<number | undefined> {
  try {
    const api = ctx.api();

    if (entity === "custom_fields") {
      let totalCount = 0;
      for (const { endpoint } of CLOSE_CUSTOM_FIELD_ENDPOINTS) {
        try {
          const response = await api.get(endpoint, { params: { _limit: 0 } });
          totalCount += response.data.total_results || 0;
        } catch (error) {
          // Skip if endpoint doesn't exist
          logger.warn("Could not fetch count from endpoint", {
            endpoint,
            error,
          });
        }
      }
      return totalCount > 0 ? totalCount : undefined;
    }

    const endpoint = COUNTED_ENDPOINTS[entity];
    if (!endpoint) return undefined;

    const params: Record<string, unknown> = {
      _limit: 0,
      _fields: "id",
    };
    if (since) {
      params.date_updated__gte = isoDay(since);
    }
    const response = await api.get(endpoint, { params });

    // Close API returns total_results in the response
    return response.data.total_results || undefined;
  } catch (error) {
    logger.warn("Could not fetch total count for entity", { entity, error });
    return undefined;
  }
}
