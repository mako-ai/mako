/**
 * Calendly reads, one async generator per kind, each a port of the
 * in-process fetcher in `api/src/connectors/calendly/fetchers.ts`:
 *
 * - `readOrganization`: the token's organization, one request.
 * - `readList`: the `page_token` lists. State `{ cursor }`, as in-process
 *   `metadata.cursor`. One batch per page, so the SDK's page budget is the
 *   in-process `maxIterations`.
 * - `readInvitees`: invitees nested under scheduled events, walked by
 *   start-time keyset. State is the in-process metadata (`eventsMinStart`,
 *   `eventsBoundaryUris`, `eventsDone`, `pendingEvents`).
 *
 * In-process counts one iteration per events page and one per event in a
 * wave of up to 8 concurrent events, and finishes a wave even past its
 * budget. Here a wave yields its records with the state after the wave,
 * then one empty batch per further event, all with that same state. The
 * SDK stops at the same count, after the whole wave, at the same position.
 */
import {
  CALENDLY_MAX_PAGE_LIMIT,
  CalendlyHttpError,
  calendlyPageCount,
  calendlyRelativePath,
  fetchCalendlyPage,
  flattenMembership,
  withId,
  type CalendlyClient,
  type CalendlyListResponse,
} from "./client.ts";

/** Events whose invitees are read at once in a wave, as in-process. */
export const INVITEES_CONCURRENCY = 8;

type Row = Record<string, unknown>;

export interface ReadBatch {
  records: Row[];
  state: Record<string, unknown>;
  hasMore: boolean;
}

export interface ReadDeps {
  api: CalendlyClient;
  /** `__page_size`, or undefined: Calendly then pages by 100. */
  pageSize: unknown;
  /** Between pages: `__rate_limit_delay_ms`, 200 ms by default. */
  pause: () => Promise<void>;
  currentUser: () => Promise<{ user_uri: string; organization_uri: string }>;
  log: (message: string) => void;
}

export type ListEntity =
  "users" | "groups" | "event_types" | "scheduled_events" | "contacts";

const LIST_PATH: Record<ListEntity, string> = {
  users: "/organization_memberships",
  groups: "/groups",
  event_types: "/event_types",
  scheduled_events: "/scheduled_events",
  contacts: "/contacts",
};

const LIST_NEEDS_ORG: Record<ListEntity, boolean> = {
  users: true,
  groups: true,
  event_types: true,
  scheduled_events: true,
  contacts: false,
};

/** No updated-since filter at Calendly: `since` is applied here. */
const CLIENT_FILTERED = new Set<ListEntity>([
  "groups",
  "event_types",
  "contacts",
  "users",
]);

/**
 * Rows whose `field` is at or after `since`. Undated rows are DROPPED, as
 * in-process `filterRecordsSince` does: keeping them would turn every
 * incremental poll into a full re-pull of undated rows.
 */
export function filterRecordsSince(
  records: Row[],
  since: Date,
  field: string,
): Row[] {
  const sinceMs = since.getTime();
  return records.filter(record => {
    const value = record[field];
    const ts = typeof value === "string" ? new Date(value).getTime() : NaN;
    return Number.isFinite(ts) ? ts >= sinceMs : false;
  });
}

/** The token's organization. In-process reads it once and never resumes. */
export async function* readOrganization(
  deps: ReadDeps,
): AsyncGenerator<ReadBatch> {
  const { organization_uri } = await deps.currentUser();
  const response = (await deps.api.get(
    calendlyRelativePath(deps.api.baseUrl, organization_uri),
  )) as { resource?: Row } | undefined;
  const resource = response?.resource;
  yield {
    records: resource ? [withId(resource)] : [],
    state: {},
    hasMore: false,
  };
}

/** A `page_token` list, one page per batch. */
export async function* readList(
  deps: ReadDeps,
  entity: ListEntity,
  state: Record<string, unknown>,
  since: Date | undefined,
): AsyncGenerator<ReadBatch> {
  const path = LIST_PATH[entity];
  const organization = LIST_NEEDS_ORG[entity]
    ? (await deps.currentUser()).organization_uri
    : undefined;
  let cursor =
    typeof state.cursor === "string" && state.cursor ? state.cursor : undefined;

  for (;;) {
    const params: Record<string, string | number | undefined> = {
      count: calendlyPageCount(deps.pageSize, 100),
      page_token: cursor,
      organization,
    };
    if (entity === "scheduled_events") {
      // Calendly only supports sorting scheduled_events by start_time.
      params.sort = "start_time:asc";
      if (since) params.min_start_time = since.toISOString();
    } else if (entity === "event_types") {
      // Calendly only reliably supports sorting event_types by name.
      params.sort = "name:asc";
    }

    const page = await fetchCalendlyPage(deps.api, path, params);
    let records = page.collection.map(item => withId(item as Row));
    if (entity === "users") records = records.map(flattenMembership);
    if (since && CLIENT_FILTERED.has(entity)) {
      records = filterRecordsSince(records, since, "updated_at");
    }

    const next = page.pagination.next_page_token || undefined;
    if (!next) {
      yield { records, state: { cursor: null }, hasMore: false };
      return;
    }
    cursor = next;
    yield { records, state: { cursor }, hasMore: true };
    await deps.pause();
  }
}

type PendingEvent = { uri: string; total?: number; start_time?: string };

const FINISHED = () => ({
  eventsMinStart: null,
  eventsBoundaryUris: [],
  eventsDone: true,
  pendingEvents: [],
});

/**
 * Invitees of every scheduled event. Keyset pagination over
 * `/scheduled_events` by start time instead of Calendly's `page_token`,
 * which Calendly re-anchors on every call: a token parked while a page's
 * invitees drain is invalid by the time it is redeemed.
 */
export async function* readInvitees(
  deps: ReadDeps,
  state: Record<string, unknown>,
  since: Date | undefined,
): AsyncGenerator<ReadBatch> {
  const api = deps.api;
  const base = api.baseUrl;
  let eventsMinStart =
    (state.eventsMinStart as string | undefined | null) ??
    (since ? since.toISOString() : undefined);
  // Events at exactly eventsMinStart already queued. min_start_time is
  // inclusive, so they reappear on the next page and are skipped.
  let eventsBoundaryUris =
    (state.eventsBoundaryUris as string[] | undefined) ?? [];
  let eventsDone = (state.eventsDone as boolean | undefined) ?? false;
  // Current shape { uri, total, start_time }; older checkpoints stored a
  // plain string[] or { uri, total }. All are accepted.
  let pendingEvents: PendingEvent[] = (
    (state.pendingEvents as (string | PendingEvent)[] | undefined) ?? []
  ).map(ev => (typeof ev === "string" ? { uri: ev } : ev));
  // A legacy in-progress event is requeued (full re-drain).
  const legacyEventUri = state.currentEventUri as string | undefined;
  if (legacyEventUri)
    pendingEvents = [{ uri: legacyEventUri }, ...pendingEvents];

  const { organization_uri } = await deps.currentUser();

  const exhausted = () => pendingEvents.length === 0 && eventsDone;
  const position = (): Record<string, unknown> =>
    exhausted()
      ? FINISHED()
      : {
          eventsMinStart: eventsMinStart ?? null,
          eventsBoundaryUris,
          eventsDone,
          pendingEvents,
        };
  const snapshot = (records: Row[]): ReadBatch => ({
    records,
    // A copy: the arrays keep changing after the batch is handed over.
    state: JSON.parse(JSON.stringify(position())),
    hasMore: !exhausted(),
  });

  const fetchInviteesPage = async (
    eventUri: string,
    cursor: string | undefined,
  ): Promise<CalendlyListResponse> => {
    const path = `${calendlyRelativePath(base, eventUri)}/invitees`;
    const params: Record<string, string | number> = {
      count: calendlyPageCount(deps.pageSize, 100),
    };
    if (cursor) params.page_token = cursor;
    const data = ((await api.get(path, params)) ??
      {}) as Partial<CalendlyListResponse>;
    return {
      collection: Array.isArray(data.collection) ? data.collection : [],
      pagination: data.pagination ?? {},
    };
  };

  const loadMoreEvents = async (): Promise<void> => {
    const params: Record<string, string | number | undefined> = {
      count: CALENDLY_MAX_PAGE_LIMIT,
      organization: organization_uri,
      sort: "start_time:asc",
    };
    if (eventsMinStart) params.min_start_time = eventsMinStart;
    const page = await fetchCalendlyPage(api, "/scheduled_events", params);
    const pageEvents: PendingEvent[] = [];
    for (const item of page.collection) {
      const uri =
        typeof (item as { uri?: unknown }).uri === "string"
          ? (item as { uri: string }).uri
          : "";
      if (!uri) continue;
      if (!uri.startsWith(`${base}/`)) {
        deps.log("Dropping scheduled_event with foreign URI");
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

    const boundary = new Set(eventsBoundaryUris);
    const fresh = pageEvents.filter(ev => !boundary.has(ev.uri));
    pendingEvents = [...pendingEvents, ...fresh];

    // A short page means the listing is exhausted.
    if (page.collection.length < CALENDLY_MAX_PAGE_LIMIT) {
      eventsDone = true;
      return;
    }

    let maxStart: string | undefined;
    for (const ev of pageEvents) {
      if (ev.start_time && (!maxStart || ev.start_time > maxStart)) {
        maxStart = ev.start_time;
      }
    }
    if (!maxStart) {
      // No start time to key off: stop rather than loop.
      eventsDone = true;
      return;
    }
    if (maxStart !== eventsMinStart) {
      eventsMinStart = maxStart;
      eventsBoundaryUris = pageEvents
        .filter(ev => ev.start_time === maxStart)
        .map(ev => ev.uri);
    } else {
      // A whole page at one instant: nudge 1 ms to make progress.
      eventsMinStart = new Date(new Date(maxStart).getTime() + 1).toISOString();
      eventsBoundaryUris = [];
    }
  };

  // Every invitee page of one event. An event Calendly rejects (deleted or
  // canceled since: 400/404) is skipped and logged; anything else fails.
  const drainInvitees = async (eventUri: string): Promise<Row[]> => {
    const records: Row[] = [];
    let cursor: string | undefined;
    do {
      let page: CalendlyListResponse;
      try {
        page = await fetchInviteesPage(eventUri, cursor);
      } catch (error) {
        const status =
          error instanceof CalendlyHttpError ? error.status : undefined;
        if (status === 400 || status === 404) {
          deps.log(
            `Skipping invitees for unreadable scheduled_event ${calendlyRelativePath(base, eventUri)}: ${(error as Error).message}`,
          );
          return records;
        }
        throw error;
      }
      for (const item of page.collection) records.push(withId(item as Row));
      cursor = page.pagination.next_page_token ?? undefined;
    } while (cursor);
    return records;
  };

  for (;;) {
    if (pendingEvents.length === 0) {
      if (eventsDone) {
        yield snapshot([]);
        return;
      }
      await loadMoreEvents();
      // One iteration in-process.
      const batch = snapshot([]);
      yield batch;
      if (!batch.hasMore) return;
      continue;
    }

    // A wave, skipping events known to have no invitee (no request).
    const wave: string[] = [];
    while (wave.length < INVITEES_CONCURRENCY && pendingEvents.length > 0) {
      const ev = pendingEvents.shift() as PendingEvent;
      if (ev.total === 0) continue;
      wave.push(ev.uri);
    }
    if (wave.length === 0) continue;

    const results = await Promise.all(wave.map(uri => drainInvitees(uri)));
    // `wave.length` iterations in-process: the records, then empty batches
    // at the same position.
    const first = snapshot(results.flat());
    yield first;
    if (!first.hasMore) return;
    for (let i = 1; i < wave.length; i++) yield snapshot([]);
  }
}
