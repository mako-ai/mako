/**
 * Calendly backfill: the organization, the token-paginated lists, and
 * invitees (nested under scheduled events, walked by start-time keyset).
 */
import axios from "axios";
import type { FetchState, ResumableFetchOptions } from "../base/BaseConnector";
import { filterRecordsSince } from "../base/incremental";
import { paginateByCursor } from "../base/pagination";
import { loggers } from "../../logging";
import {
  CALENDLY_MAX_PAGE_LIMIT,
  calendlyPageCount,
  calendlyRelativePath,
  fetchCalendlyPage,
  flattenMembership,
  formatCalendlyApiError,
  withId,
  type CalendlyContext,
  type CalendlyListResponse,
} from "./client";

const logger = loggers.connector("calendly");

// Number of scheduled_events whose invitees we fetch concurrently per wave.
// Kept small so executeWithRetry's 429 backoff stays effective.
const INVITEES_CONCURRENCY = 8;

export type CalendlySimpleEntity =
  "users" | "groups" | "event_types" | "scheduled_events" | "contacts";

const SIMPLE_ENTITY_PATH: Record<CalendlySimpleEntity, string> = {
  users: "/organization_memberships",
  groups: "/groups",
  event_types: "/event_types",
  scheduled_events: "/scheduled_events",
  contacts: "/contacts",
};

const SIMPLE_ENTITY_NEEDS_ORG: Record<CalendlySimpleEntity, boolean> = {
  users: true,
  groups: true,
  event_types: true,
  scheduled_events: true,
  contacts: false,
};

/** Entities with no updated-since filter: `since` is applied client-side. */
const CLIENT_FILTERED_ENTITIES = new Set<CalendlySimpleEntity>([
  "groups",
  "event_types",
  "contacts",
  "users",
]);

export async function fetchCalendlyOrganizationsChunk(
  ctx: CalendlyContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { state } = options;
  if (state && state.totalProcessed > 0) {
    return {
      totalProcessed: state.totalProcessed,
      hasMore: false,
      iterationsInChunk: 0,
    };
  }

  const { organization_uri } = await ctx.currentUser();
  const api = ctx.api();
  const response = await ctx.execute(() =>
    api.get(calendlyRelativePath(ctx, organization_uri)),
  );
  const resource = (response.data as { resource?: Record<string, unknown> })
    ?.resource;
  if (!resource) {
    return { totalProcessed: 0, hasMore: false, iterationsInChunk: 1 };
  }

  await options.onBatch([withId(resource)]);
  options.onProgress?.(1, 1);

  return { totalProcessed: 1, hasMore: false, iterationsInChunk: 1 };
}

export async function fetchCalendlySimpleChunk(
  ctx: CalendlyContext,
  options: ResumableFetchOptions,
  entity: CalendlySimpleEntity,
): Promise<FetchState> {
  const { onBatch, onProgress, since, state, batchSize } = options;

  const path = SIMPLE_ENTITY_PATH[entity];
  const organization = SIMPLE_ENTITY_NEEDS_ORG[entity]
    ? (await ctx.currentUser()).organization_uri
    : undefined;

  const result = await paginateByCursor<Record<string, unknown>>({
    startCursor: (state?.metadata?.cursor as string | undefined) ?? undefined,
    startCount: state?.totalProcessed ?? 0,
    maxIterations: options.maxIterations ?? 10,
    fetchPage: async cursor => {
      const params: Record<string, string | number | undefined> = {
        count: calendlyPageCount(ctx, batchSize),
        page_token: cursor,
        organization,
      };

      if (entity === "scheduled_events") {
        // Calendly only supports sorting scheduled_events by start_time.
        params.sort = "start_time:asc";
        if (since instanceof Date) {
          params.min_start_time = since.toISOString();
        }
      } else if (entity === "event_types") {
        // Calendly only reliably supports sorting event_types by name.
        params.sort = "name:asc";
      }

      const page = await fetchCalendlyPage(ctx, path, params);

      let records = page.collection.map(item =>
        withId(item as Record<string, unknown>),
      );
      if (entity === "users") {
        records = records.map(item => flattenMembership(item));
      }
      if (since instanceof Date && CLIENT_FILTERED_ENTITIES.has(entity)) {
        records = filterRecordsSince(records, since, "updated_at");
      }

      return { records, next: page.pagination.next_page_token };
    },
    onBatch,
    onProgress: onProgress && (n => onProgress(n, undefined)),
    pause: () => ctx.sleep(options.rateLimitDelay ?? ctx.rateLimitDelay()),
  });

  return {
    totalProcessed: result.totalProcessed,
    hasMore: result.hasMore,
    iterationsInChunk: result.iterations,
    metadata: { cursor: result.cursor },
  };
}

type PendingEvent = { uri: string; total?: number; start_time?: string };

export async function fetchCalendlyInviteesChunk(
  ctx: CalendlyContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, since, state } = options;
  const maxIterations = options.maxIterations ?? 10;

  // Keyset pagination over /scheduled_events by start_time, instead of the
  // opaque page_token. Calendly re-anchors next_page_token on every call, so a
  // token parked while we drain a page's invitees becomes invalid by the time
  // we redeem it. min_start_time + sort=start_time:asc is stable and
  // resume-safe.
  let eventsMinStart =
    (state?.metadata?.eventsMinStart as string | undefined) ??
    (since instanceof Date ? since.toISOString() : undefined);
  // URIs of events at exactly eventsMinStart already queued. min_start_time is
  // inclusive, so these reappear on the next page and must be skipped.
  let eventsBoundaryUris =
    (state?.metadata?.eventsBoundaryUris as string[] | undefined) ?? [];
  let eventsDone =
    (state?.metadata?.eventsDone as boolean | undefined) ?? false;
  // Normalize pendingEvents: current shape is { uri, total, start_time }, but
  // legacy in-flight checkpoints stored a plain string[] or { uri, total }.
  // Accept all so a backfill mid-flight across a deploy doesn't break.
  let pendingEvents: PendingEvent[] = (
    (state?.metadata?.pendingEvents as (string | PendingEvent)[] | undefined) ??
    []
  ).map(ev => (typeof ev === "string" ? { uri: ev } : ev));
  // Legacy state may have an in-progress event; requeue it (full re-drain).
  const legacyEventUri = state?.metadata?.currentEventUri as string | undefined;
  if (legacyEventUri) {
    pendingEvents = [{ uri: legacyEventUri }, ...pendingEvents];
  }
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;

  const { organization_uri } = await ctx.currentUser();
  const api = ctx.api();

  const fetchInviteesPage = async (
    eventUri: string,
    cursor: string | undefined,
  ): Promise<CalendlyListResponse> => {
    const path = `${calendlyRelativePath(ctx, eventUri)}/invitees`;
    const params: Record<string, string | number> = {
      count: calendlyPageCount(ctx, options.batchSize),
    };
    if (cursor) params.page_token = cursor;
    const response = await ctx.execute(() => api.get(path, { params }));
    const data = response.data as Partial<CalendlyListResponse>;
    return {
      collection: Array.isArray(data.collection) ? data.collection : [],
      pagination: data.pagination ?? {},
    };
  };

  const loadMoreEvents = async (): Promise<void> => {
    const params: Record<string, string | number | undefined> = {
      count: CALENDLY_MAX_PAGE_LIMIT,
      organization: organization_uri,
      // Calendly only supports sorting scheduled_events by start_time.
      sort: "start_time:asc",
    };
    if (eventsMinStart) {
      params.min_start_time = eventsMinStart;
    }
    const page = await fetchCalendlyPage(ctx, "/scheduled_events", params);
    const base = ctx.baseUrl();
    const pageEvents: PendingEvent[] = [];
    for (const item of page.collection) {
      const uri =
        typeof (item as { uri?: unknown }).uri === "string"
          ? (item as { uri: string }).uri
          : "";
      if (!uri) continue;
      if (!uri.startsWith(`${base}/`)) {
        logger.warn("Dropping scheduled_event with foreign URI", {
          base,
        });
        continue;
      }
      const counter = (item as { invitees_counter?: { total?: unknown } })
        .invitees_counter;
      const total =
        typeof counter?.total === "number" ? counter.total : undefined;
      const startTime =
        typeof (item as { start_time?: unknown }).start_time === "string"
          ? (item as { start_time: string }).start_time
          : undefined;
      pageEvents.push({ uri, total, start_time: startTime });
    }

    // Skip boundary events already queued from the previous page (inclusive
    // min_start_time re-returns them).
    const boundary = new Set(eventsBoundaryUris);
    const fresh = pageEvents.filter(ev => !boundary.has(ev.uri));
    pendingEvents = [...pendingEvents, ...fresh];

    // Last page (short read) means the listing is exhausted.
    if (page.collection.length < CALENDLY_MAX_PAGE_LIMIT) {
      eventsDone = true;
      return;
    }

    // Advance the keyset to the max start_time on this page.
    let maxStart: string | undefined;
    for (const ev of pageEvents) {
      if (ev.start_time && (!maxStart || ev.start_time > maxStart)) {
        maxStart = ev.start_time;
      }
    }
    if (!maxStart) {
      // Cannot key off start_time (shouldn't happen for real events). Stop
      // rather than risk an infinite loop.
      eventsDone = true;
      return;
    }
    if (maxStart !== eventsMinStart) {
      eventsMinStart = maxStart;
      eventsBoundaryUris = pageEvents
        .filter(ev => ev.start_time === maxStart)
        .map(ev => ev.uri);
    } else {
      // Whole page shares the boundary start_time (>100 events at the same
      // instant). Nudge +1ms to guarantee forward progress; same-ms overflow
      // beyond a page is negligible for real calendars.
      eventsMinStart = new Date(new Date(maxStart).getTime() + 1).toISOString();
      eventsBoundaryUris = [];
    }
  };

  // Fetch every invitee page for a single event (most events are 1 page).
  // A single event that Calendly rejects (e.g. deleted/canceled event ->
  // 400/404) must not kill the whole concurrent wave / backfill: skip it and
  // log. Anything else (auth, 429-exhausted, 5xx) still propagates.
  const drainInvitees = async (
    eventUri: string,
  ): Promise<Record<string, unknown>[]> => {
    const records: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      let page: CalendlyListResponse;
      try {
        page = await fetchInviteesPage(eventUri, cursor);
      } catch (error) {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : undefined;
        if (status === 400 || status === 404) {
          logger.warn("Skipping invitees for unreadable scheduled_event", {
            event: calendlyRelativePath(ctx, eventUri),
            detail: formatCalendlyApiError(error),
          });
          return records;
        }
        throw error;
      }
      for (const item of page.collection) {
        records.push(withId(item as Record<string, unknown>));
      }
      cursor = page.pagination.next_page_token ?? undefined;
    } while (cursor);
    return records;
  };

  const finished = (): FetchState => ({
    totalProcessed: recordCount,
    hasMore: false,
    iterationsInChunk: iterations,
    metadata: {
      eventsMinStart: null,
      eventsBoundaryUris: [],
      eventsDone: true,
      pendingEvents: [],
    },
  });

  while (iterations < maxIterations) {
    if (pendingEvents.length === 0) {
      if (eventsDone) {
        return finished();
      }
      await loadMoreEvents();
      iterations++;
      if (pendingEvents.length === 0 && eventsDone) {
        return finished();
      }
      continue;
    }

    // Take a wave, skipping events known to have zero invitees (no API call).
    const wave: string[] = [];
    while (wave.length < INVITEES_CONCURRENCY && pendingEvents.length > 0) {
      const ev = pendingEvents.shift() as PendingEvent;
      if (ev.total === 0) continue;
      wave.push(ev.uri);
    }
    if (wave.length === 0) continue;

    const results = await Promise.all(wave.map(uri => drainInvitees(uri)));
    iterations += wave.length;

    const records = results.flat();
    if (records.length > 0) {
      await onBatch(records);
      recordCount += records.length;
      onProgress?.(recordCount, undefined);
    }
  }

  const exhausted = pendingEvents.length === 0 && eventsDone;

  return {
    totalProcessed: recordCount,
    hasMore: !exhausted,
    iterationsInChunk: iterations,
    metadata: exhausted
      ? {
          eventsMinStart: null,
          eventsBoundaryUris: [],
          eventsDone: true,
          pendingEvents: [],
        }
      : {
          eventsMinStart: eventsMinStart ?? null,
          eventsBoundaryUris,
          eventsDone,
          pendingEvents,
        },
  };
}
