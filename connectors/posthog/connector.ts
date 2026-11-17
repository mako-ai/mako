/**
 * PostHog on @makoai/connector-sdk: `spec`, `check`, `discover` and `read`.
 *
 * A port of the in-process connector in `api/src/connectors/posthog/`, with
 * its 5 built-in REST entities, the same schemas, offsets, pagination and
 * `since` handling. Nothing runs it in production yet. `fixtures/parity.mjs`
 * runs both against the same recorded PostHog responses and compares them
 * entity by entity.
 *
 * Read state mirrors the in-process `FetchState`, so a chunk boundary means
 * the same thing on both sides:
 * - list entities (surveys, feature flags, experiments, annotations):
 *   `{ offset }`, the in-process `FetchState.offset`;
 * - `survey_responses`: `{ surveyOffset, responseOffset, currentSurveyId,
 *   surveysDone }`, the in-process `FetchState.metadata`. Surveys are walked
 *   one at a time, then each survey's responses page by page.
 * - `mako.since` (ISO 8601) is the incremental anchor. Mako owns the `mako`
 *   key; the connector copies it forward and never moves it.
 *
 * SOURCE TIMESTAMPS: no entity declares a `cursorField`. A boxed row's
 * `_mako_source_ts` then resolves exactly as in-process (update fields,
 * then creation fields, else "now"). A cursor would change it: responses
 * would carry `submitted_at` instead of the sync time, and every destination
 * merge keeps a row only when its `_mako_source_ts` is not older than the
 * stored one. Rows written in-process with the sync time would then never
 * update again after a switch.
 *
 * Not ported: HogQL query entities. In-process, a flow's `queries` list adds
 * one entity per query. The SDK declares entities statically, so a folder
 * cannot grow an entity per flow yet. RealAdvisor's one PostHog flow has no
 * queries.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type {
  Context,
  EntityDefinition,
  EntitySchema,
} from "@makoai/connector-sdk";
import {
  CHECK_TIMEOUT_MS,
  PosthogClient,
  type Params,
  type PosthogClientConfig,
} from "./client.ts";
import { posthogJsonSchema, posthogShorthandSchema } from "./schema.ts";

/** The in-process defaults for `sync_batch_size` and `rate_limit_delay_ms`. */
const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 200;

interface PosthogConfig extends PosthogClientConfig {
  /**
   * Rows per page. Not in the credential form: `SandboxedConnector` sets it
   * from the batch size the engine knows, as the in-process connector reads
   * `options.batchSize`. A `__` key is set by Mako, never by a user.
   */
  __page_size?: number;
  /** Delay between requests, from `settings.rate_limit_delay_ms`. */
  __rate_limit_delay_ms?: number;
}

type JsonRecord = Record<string, unknown>;

interface PaginatedList {
  results: JsonRecord[];
  count?: number;
  next?: string | null;
  has_more?: boolean;
}

function pageSize(config: PosthogConfig): number {
  const value = Number(config.__page_size);
  return Number.isInteger(value) && value >= 1 ? value : PAGE_SIZE;
}

function rateLimitDelay(config: PosthogConfig): number {
  const value = Number(config.__rate_limit_delay_ms);
  return Number.isFinite(value) && value > 0 ? value : RATE_LIMIT_DELAY_MS;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function client(ctx: Context<PosthogConfig>): PosthogClient {
  if (!ctx.config.project_id) throw new Error("PostHog project_id is required");
  if (!ctx.config.api_key) throw new Error("PostHog api_key is required");
  return new PosthogClient(ctx.config, message => ctx.log(message));
}

function parseSince(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`state.mako.since is not a date: ${value}`);
  }
  return date;
}

/** The anchor, copied forward unchanged so every chunk carries it. */
function makoKey(anchor: string | undefined): { mako?: { since: string } } {
  return anchor ? { mako: { since: anchor } } : {};
}

/**
 * Keep records whose ISO `field` is at or after `since`; drop undated ones.
 * The in-process `filterRecordsSince`, line for line.
 */
function filterRecordsSince(
  records: JsonRecord[],
  since: Date,
  field: string,
): JsonRecord[] {
  const sinceMs = since.getTime();
  return records.filter(record => {
    const value = record[field];
    const time = typeof value === "string" ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time >= sinceMs : false;
  });
}

async function fetchListPage(
  api: PosthogClient,
  path: string,
  params: Params,
): Promise<PaginatedList> {
  const data = await api.get<PaginatedList | null>(
    api.projectPath(`${path}/`),
    params,
  );
  return {
    results: Array.isArray(data?.results) ? data.results : [],
    count: data?.count,
    next: data?.next ?? null,
    has_more: data?.has_more,
  };
}

/** Same layout as in-process: rows are upserted in place. */
const createdLayout = {
  partitionField: "created_at",
  partitionGranularity: "day" as const,
  clusterFields: ["_dataSourceId", "id"],
};

/**
 * A plain limit/offset list. None of these endpoints filter by update time,
 * so `since` keeps rows created at or after it (created-anchor); edits wait
 * for the periodic full reconcile, as in-process.
 */
function listEntity(
  path: string,
  label: string,
  description: string,
): EntityDefinition<PosthogConfig> {
  return {
    label,
    description,
    primaryKey: ["id"],
    // No `cursorField`, on purpose: see SOURCE TIMESTAMPS above.
    incremental: "created-anchor",
    layout: createdLayout,
    schema: posthogShorthandSchema(path),
    // The whole JSON Schema, so `id` is required and `nullable: false`
    // fields carry no "null". The SDK passes an object schema through.
    discoverSchema: () => posthogJsonSchema(path) as unknown as EntitySchema,
    async *read(ctx, rawState) {
      const state = rawState as { offset?: unknown; mako?: { since?: string } };
      const api = client(ctx);
      const anchor = state.mako?.since;
      const since = parseSince(anchor);
      const limit = pageSize(ctx.config);
      let offset = typeof state.offset === "number" ? state.offset : 0;
      let first = true;

      while (true) {
        if (!first) await sleep(rateLimitDelay(ctx.config));
        first = false;

        const page = await fetchListPage(api, path, { limit, offset });
        const records = since
          ? filterRecordsSince(page.results, since, "created_at")
          : page.results;
        const hasMore = Boolean(page.next) || page.results.length === limit;
        if (hasMore) offset += limit;
        yield { records, state: { offset, ...makoKey(anchor) }, hasMore };
        if (!hasMore) return;
      }
    },
  };
}

interface ResponsesState {
  surveyOffset?: unknown;
  responseOffset?: unknown;
  currentSurveyId?: unknown;
  surveysDone?: unknown;
  mako?: { since?: string };
}

/** A response row as in-process: `id` is the uuid, `survey_id` is added. */
function normalizeSurveyResponse(surveyId: string, row: JsonRecord) {
  const uuid =
    typeof row.uuid === "string"
      ? row.uuid
      : typeof row.id === "string"
        ? row.id
        : undefined;
  return {
    ...row,
    id: uuid ?? `${surveyId}:${String(row.submitted_at ?? "")}`,
    uuid: uuid ?? null,
    survey_id: surveyId,
  };
}

/**
 * Every survey's responses. One request per batch, as the in-process loop
 * counts one iteration per request: a survey lookup (`limit=1`) is a batch
 * with no records. The responses API filters by `since` itself (native).
 */
const surveyResponses: EntityDefinition<PosthogConfig> = {
  label: "Survey Responses",
  description:
    "Individual survey responses across all surveys (answers + metadata)",
  primaryKey: ["id"],
  // No `cursorField`, on purpose: see SOURCE TIMESTAMPS above.
  incremental: "native",
  layout: {
    partitionField: "submitted_at",
    partitionGranularity: "day",
    clusterFields: ["_dataSourceId", "survey_id", "id"],
  },
  schema: posthogShorthandSchema("survey_responses"),
  discoverSchema: () =>
    posthogJsonSchema("survey_responses") as unknown as EntitySchema,
  async *read(ctx, rawState) {
    const state = rawState as ResponsesState;
    const api = client(ctx);
    const anchor = state.mako?.since;
    const since = parseSince(anchor);
    const limit = pageSize(ctx.config);
    const delay = rateLimitDelay(ctx.config);

    let surveyOffset =
      typeof state.surveyOffset === "number" ? state.surveyOffset : 0;
    let responseOffset =
      typeof state.responseOffset === "number" ? state.responseOffset : 0;
    let currentSurveyId =
      typeof state.currentSurveyId === "string"
        ? state.currentSurveyId
        : undefined;
    const surveysDone = state.surveysDone === true;

    const position = () => ({
      surveyOffset,
      responseOffset,
      currentSurveyId: currentSurveyId ?? null,
      surveysDone,
      ...makoKey(anchor),
    });
    const finished = () => ({
      surveyOffset,
      responseOffset: 0,
      currentSurveyId: null,
      surveysDone: true,
      ...makoKey(anchor),
    });

    while (true) {
      if (!currentSurveyId) {
        if (surveysDone) {
          yield { records: [], state: finished(), hasMore: false };
          return;
        }
        const surveys = await fetchListPage(api, "surveys", {
          limit: 1,
          offset: surveyOffset,
        });
        if (surveys.results.length === 0) {
          yield { records: [], state: finished(), hasMore: false };
          return;
        }
        const nextId = surveys.results[0]?.id;
        if (typeof nextId !== "string") {
          surveyOffset += 1;
          yield { records: [], state: position(), hasMore: true };
          continue;
        }
        currentSurveyId = nextId;
        responseOffset = 0;
        // Past this survey already: a crash after its responses resumes on
        // the next one, as in-process.
        surveyOffset += 1;
        yield { records: [], state: position(), hasMore: true };
        await sleep(delay);
      }

      const surveyId: string = currentSurveyId;
      const params: Params = {
        limit,
        offset: responseOffset,
        exclude_archived: false,
      };
      if (since) params.since = since.toISOString();
      const page = await fetchListPage(
        api,
        `surveys/${surveyId}/responses`,
        params,
      );
      const records = page.results.map(row =>
        normalizeSurveyResponse(surveyId, row),
      );
      const pageHasMore =
        typeof page.has_more === "boolean"
          ? page.has_more
          : Boolean(page.next) || page.results.length === limit;
      if (pageHasMore) {
        responseOffset += limit;
      } else {
        currentSurveyId = undefined;
        responseOffset = 0;
      }
      // More may follow even after the last survey: the next lookup finds
      // the list's end, as the in-process loop does.
      yield { records, state: position(), hasMore: true };
      await sleep(delay);
    }
  },
};

export default defineConnector<PosthogConfig>({
  name: "posthog",
  version: "1.0.0",
  title: "PostHog",
  documentationUrl: "https://posthog.com/docs/api",
  config: {
    required: ["project_id", "api_key"],
    properties: {
      api_base_url: {
        type: "string",
        title: "API Base URL",
        description:
          "Base URL for PostHog API (e.g. https://us.posthog.com or https://eu.posthog.com)",
        default: "https://app.posthog.com",
        order: 0,
      },
      project_id: {
        type: "string",
        title: "Project ID",
        description: "PostHog Project ID (numeric)",
        order: 1,
      },
      api_key: {
        type: "string",
        title: "API Key",
        description:
          "Personal API key (recommended) or Project API key depending on Auth Type",
        airbyte_secret: true,
        order: 2,
      },
      auth_type: {
        type: "string",
        title: "Auth Type",
        default: "personal_api_key",
        enum: ["personal_api_key", "project_api_key"],
        order: 3,
      },
    },
  },
  /**
   * The in-process probe: one survey (it checks `survey:read` too), and a
   * trivial HogQL query for a key without survey scope.
   */
  async check(ctx) {
    const api = client(ctx);
    try {
      await api.get(
        api.projectPath("surveys/"),
        { limit: 1 },
        CHECK_TIMEOUT_MS,
      );
    } catch {
      await api.post(api.projectPath("query/"), {
        query: { kind: "HogQLQuery", query: "SELECT 1 LIMIT 1" },
      });
    }
    return true;
  },
  entities: {
    surveys: listEntity(
      "surveys",
      "Surveys",
      "PostHog survey definitions (questions, targeting, status)",
    ),
    survey_responses: surveyResponses,
    feature_flags: listEntity(
      "feature_flags",
      "Feature Flags",
      "PostHog feature flag definitions (key, filters, rollout, status)",
    ),
    experiments: listEntity(
      "experiments",
      "Experiments",
      "PostHog experiments / A-B tests (metrics, linked flags, dates, conclusions)",
    ),
    annotations: listEntity(
      "annotations",
      "Annotations",
      "PostHog annotations (release markers and notes pinned to dates)",
    ),
  },
});
