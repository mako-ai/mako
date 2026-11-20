/**
 * PostHog, as a call_connection profile: data only, no connector folder.
 * The request side moved here unchanged from callable.ts; the schema is the
 * connector's getConfigSchema().
 */
import {
  safeJson,
  text,
  trimSlash,
  type CallableConnection,
  type Config,
} from "../callable";
import { ConnectionRequestError } from "../forward";
import {
  OPERATION_DEFAULT_LIMIT,
  OPERATION_MAX_LIMIT,
  limitParam,
  param,
  required,
  type ConnectionOperation,
} from "../operations";
import type { CallableProfile } from ".";

/** The PostHog default the built-in connector uses (connectors/posthog). */
const POSTHOG_BASE_URL = "https://app.posthog.com";

/**
 * Query kinds the query API runs that only read. HogQL itself has no write
 * statement; a kind not listed (a new one) is a write until it is added.
 */
const POSTHOG_READ_QUERY_KINDS = new Set([
  "HogQLQuery",
  "HogQLMetadata",
  "EventsQuery",
  "ActorsQuery",
  "TrendsQuery",
  "FunnelsQuery",
  "RetentionQuery",
  "PathsQuery",
  "StickinessQuery",
  "LifecycleQuery",
]);

/**
 * The only fields a query request may carry. Not `refresh`: an agent reads
 * PostHog's cached result and cannot force a recompute on every call.
 */
const POSTHOG_QUERY_BODY_KEYS = new Set(["query", "client_query_id", "name"]);

/**
 * The resource a path names in the project the connection is configured for
 * (`/api/projects/<id>/<resource>/…` or `/api/environments/<id>/…`), as
 * `{ resource, rest }`; null for another project, the project root itself,
 * or a path outside a project. A personal API key may reach other projects
 * and organizations; the connection reads one.
 */
function posthogResource(
  path: string,
  config: Config,
): { resource: string; rest: string[] } | null {
  // Stored as a string or a number (the field asks for a numeric id).
  const project = String(config.project_id ?? "").trim();
  if (!project) return null;
  const match =
    /^\/api\/(?:projects|environments)\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!match || match[1] !== project) return null;
  return {
    resource: match[2],
    rest: (match[3] ?? "").split("/").filter(Boolean),
  };
}

/**
 * Whether a GET of a project path only returns analytics data: persons,
 * events, insights, cohorts, query results, and feature flags as the flag
 * list or one flag. Everything else is refused: the project root (it holds
 * the project's secret token and its integration settings), local
 * evaluation and remote config (signed with that token), destinations,
 * integrations, and any resource not listed.
 */
function isPosthogDataRead(path: string, config: Config): boolean {
  const target = posthogResource(path, config);
  if (!target) return false;
  const { resource, rest } = target;
  switch (resource) {
    case "persons":
    case "events":
    case "insights":
    case "cohorts":
    case "query":
      return true;
    case "feature_flags":
      return rest.length === 0 || (rest.length === 1 && /^\d+$/.test(rest[0]));
    default:
      return false;
  }
}

/**
 * A query API body that only reads: the standard fields only, and a `query`
 * of a kind that reads (POSTHOG_READ_QUERY_KINDS). A string body counts only
 * as compact JSON, as for GraphQL (isGraphqlReadBody).
 */
export function isPosthogQueryBody(body: unknown): boolean {
  const parsed = typeof body === "string" ? safeJson(body) : body;
  if (typeof body === "string" && JSON.stringify(parsed) !== body.trim()) {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  if (!Object.keys(parsed).every(key => POSTHOG_QUERY_BODY_KEYS.has(key))) {
    return false;
  }
  const query = (parsed as { query?: unknown }).query;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    return false;
  }
  const kind = (query as { kind?: unknown }).kind;
  return typeof kind === "string" && POSTHOG_READ_QUERY_KINDS.has(kind);
}

/**
 * PostHog: the API key the sync uses, sent as the connector sends it. Only
 * analytics data in the connection's project reads: a GET of an allowed
 * resource (isPosthogDataRead), or a POST of a query that reads to its query
 * API. Everything else, the project root and every other GET included, is a
 * write, so an agent never reaches it.
 */
const posthogCallable: CallableConnection = {
  type: "posthog",
  baseUrl: config => trimSlash(text(config.api_base_url) || POSTHOG_BASE_URL),
  baseUrlFields: ["api_base_url"],
  credential: config =>
    text(config.auth_type) === "project_api_key"
      ? {
          type: "api_key_header",
          token: text(config.api_key),
          header: "POSTHOG-API-TOKEN",
        }
      : { type: "bearer", token: text(config.api_key) },
  reads(request, config) {
    if (request.method === "GET" || request.method === "HEAD") {
      return isPosthogDataRead(request.path, config);
    }
    const target = posthogResource(request.path, config);
    return (
      request.method === "POST" &&
      target?.resource === "query" &&
      target.rest.length === 0 &&
      isPosthogQueryBody(request.body)
    );
  },
  onlyReads: () => true,
};

function posthogProject(config: Config): string {
  const project = String(config.project_id ?? "").trim();
  if (!project) {
    throw new ConnectionRequestError("This connection has no project_id.");
  }
  return encodeURIComponent(project);
}

function posthogOperations(): ConnectionOperation[] {
  const LIMIT = param(
    "limit",
    `Records per page (default ${OPERATION_DEFAULT_LIMIT}, max ${OPERATION_MAX_LIMIT}).`,
  );
  return [
    {
      name: "hogql",
      description:
        "Run a HogQL (SQL) query on the project's events, persons and sessions, e.g. `select count() from events where timestamp > now() - interval 1 day`. Add a LIMIT: PostHog caps a result at 100 rows unless the query sets one.",
      params: [param("query", "A HogQL SELECT.", true)],
      build: (params, config) => ({
        method: "POST",
        path: `/api/projects/${posthogProject(config)}/query/`,
        body: {
          query: { kind: "HogQLQuery", query: required(params, "query") },
        },
      }),
    },
    {
      name: "search_persons",
      description: "Persons whose email, name or distinct id matches.",
      params: [param("search", "Email, name or distinct id.", true), LIMIT],
      build: (params, config) => ({
        method: "GET",
        path: `/api/projects/${posthogProject(config)}/persons/`,
        query: {
          search: required(params, "search"),
          limit: limitParam(params),
        },
      }),
    },
  ];
}

export const posthogProfile: CallableProfile = {
  type: "posthog",
  callable: posthogCallable,
  operations: () => posthogOperations(),
  configSchema: {
    fields: [
      {
        name: "api_base_url",
        label: "API Base URL",
        type: "string",
        required: false,
        default: "https://app.posthog.com",
        helperText:
          "Base URL for PostHog API (e.g. https://us.posthog.com or https://eu.posthog.com)",
      },
      {
        name: "project_id",
        label: "Project ID",
        type: "string",
        required: true,
        helperText: "PostHog Project ID (numeric)",
      },
      {
        name: "api_key",
        label: "API Key",
        type: "password",
        required: true,
        helperText:
          "Personal API key (recommended) or Project API key depending on Auth Type",
      },
      {
        name: "auth_type",
        label: "Auth Type",
        type: "select",
        required: false,
        default: "personal_api_key",
        options: [
          { label: "Personal API Key (Bearer)", value: "personal_api_key" },
          {
            label: "Project API Key (POSTHOG-API-TOKEN)",
            value: "project_api_key",
          },
        ],
      },
    ],
    // Queries are configured at the Transfer level, not Connector level
    // This schema tells the UI what query fields to show
    transferQueries: {
      label: "HogQL Queries",
      // Built-in entities (surveys) can sync without any HogQL queries.
      required: false,
      fields: [
        {
          name: "name",
          label: "Entity Name",
          type: "string",
          required: true,
          placeholder: "events_7d",
          helperText: "Name used as entity and collection name",
        },
        {
          name: "query",
          label: "HogQL Query",
          type: "textarea",
          required: true,
          rows: 8,
          placeholder:
            "SELECT event, count() AS cnt FROM events WHERE timestamp > now() - interval 7 day GROUP BY event ORDER BY cnt DESC",
          helperText:
            "Optional placeholders: $limit, $offset, and $since / {{since}}. If limit/offset are omitted, pagination will be appended automatically.",
        },
        {
          name: "batch_size",
          label: "Batch Size",
          type: "number",
          required: false,
          default: 100,
          placeholder: "100",
          helperText: "Number of records per request",
        },
      ],
    },
  },
};
