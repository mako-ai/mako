/**
 * Named read operations on a source connection: "search Close leads", "run
 * a HogQL query", "get a Stripe customer", without knowing the vendor's API.
 *
 * Code, not stored. An operation only builds an ordinary request (method,
 * path, query, body) from a few parameters. That request then goes through
 * the proxy like any other (connections/proxy.service.ts): the path must stay
 * under the base URL, the call profile decides whether it reads
 * (connections/callable.ts), and the connection's live-read settings decide
 * who may send it. So an operation adds no right; it is a shortcut to a read
 * the raw request could already make.
 *
 * Every operation here reads. A write operation does not belong in this
 * list: agents only read through connections.
 */
import type { ISourceConnection } from "../database/workspace-schema";
import { ConnectionRequestError, type ForwardInput } from "./forward";

type Config = ISourceConnection["config"];
type Params = Record<string, unknown>;

export interface OperationParam {
  name: string;
  required: boolean;
  description: string;
}

export interface ConnectionOperation {
  name: string;
  description: string;
  params: OperationParam[];
  /** The request it sends. Throws ConnectionRequestError for a bad param. */
  build(params: Params, config: Config): ForwardInput;
}

/** Default and maximum page size an operation asks a service for. */
export const OPERATION_DEFAULT_LIMIT = 20;
export const OPERATION_MAX_LIMIT = 100;

function param(name: string, description: string, required = false) {
  return { name, description, required };
}

/** A required non-empty string parameter. */
function required(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectionRequestError(
      `Pass params.${name}, a non-empty string.`,
    );
  }
  return value.trim();
}

/** An optional string parameter. */
function optional(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ConnectionRequestError(`params.${name} must be a string.`);
  }
  return value.trim();
}

/** An id that goes into a path: one segment, nothing a server could split. */
function idParam(params: Params, name: string): string {
  const value = required(params, name);
  if (!/^[A-Za-z0-9_.:@-]+$/.test(value) || /^\.+$/.test(value)) {
    throw new ConnectionRequestError(
      `params.${name} must be a plain id (letters, digits, _ . : @ -).`,
    );
  }
  return encodeURIComponent(value);
}

/** `params.limit`, bounded: default OPERATION_DEFAULT_LIMIT, at most OPERATION_MAX_LIMIT. */
export function limitParam(params: Params): number {
  const raw = params.limit;
  if (raw === undefined || raw === null) return OPERATION_DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConnectionRequestError(
      "params.limit must be a positive integer.",
    );
  }
  return Math.min(value, OPERATION_MAX_LIMIT);
}

/** `params.skip`: a non-negative integer, default 0. */
function skipParam(params: Params): number {
  const value = Number(params.skip ?? 0);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConnectionRequestError(
      "params.skip must be a non-negative integer.",
    );
  }
  return value;
}

const LIMIT = param(
  "limit",
  `Records per page (default ${OPERATION_DEFAULT_LIMIT}, max ${OPERATION_MAX_LIMIT}).`,
);

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

const CLOSE_LEAD_FIELDS =
  "id,display_name,status_label,contacts,date_created,date_updated,url";

const CLOSE: ConnectionOperation[] = [
  {
    name: "search_leads",
    description:
      'Search leads with Close\'s search syntax: a name, an email, a phone, or a query like `email_address:"a@b.com"` or `name:"Dupont"`.',
    params: [
      param("query", "Close search text or query.", true),
      LIMIT,
      param("skip", "Records to skip, for the next page."),
      param("fields", `Comma-separated fields (default ${CLOSE_LEAD_FIELDS}).`),
    ],
    build: params => ({
      method: "GET",
      path: "/lead/",
      query: {
        query: required(params, "query"),
        _limit: limitParam(params),
        _skip: skipParam(params),
        _fields: optional(params, "fields") ?? CLOSE_LEAD_FIELDS,
      },
    }),
  },
  {
    name: "get_lead",
    description: "One lead with its contacts, opportunities and custom fields.",
    params: [param("id", "Lead id (lead_…).", true)],
    build: params => ({
      method: "GET",
      path: `/lead/${idParam(params, "id")}/`,
    }),
  },
  {
    name: "list_opportunities",
    description:
      "Opportunities, filtered by lead and status type, most recently updated first.",
    params: [
      param("lead_id", "Only this lead's opportunities."),
      param("status_type", "active, won or lost."),
      param("updated_since", "ISO date: only those updated since."),
      LIMIT,
      param("skip", "Records to skip, for the next page."),
    ],
    build: params => {
      const lead = optional(params, "lead_id");
      const status = optional(params, "status_type");
      const since = optional(params, "updated_since");
      return {
        method: "GET",
        path: "/opportunity/",
        query: {
          ...(lead ? { lead_id: lead } : {}),
          ...(status ? { status_type: status } : {}),
          ...(since ? { date_updated__gte: since } : {}),
          _order_by: "-date_updated",
          _limit: limitParam(params),
          _skip: skipParam(params),
        },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// PostHog
// ---------------------------------------------------------------------------

function posthogProject(config: Config): string {
  const project = String(config.project_id ?? "").trim();
  if (!project) {
    throw new ConnectionRequestError("This connection has no project_id.");
  }
  return encodeURIComponent(project);
}

const POSTHOG: ConnectionOperation[] = [
  {
    name: "hogql",
    description:
      "Run a HogQL (SQL) query on the project's events, persons and sessions, e.g. `select count() from events where timestamp > now() - interval 1 day`. Add a LIMIT: PostHog caps a result at 100 rows unless the query sets one.",
    params: [param("query", "A HogQL SELECT.", true)],
    build: (params, config) => ({
      method: "POST",
      path: `/api/projects/${posthogProject(config)}/query/`,
      body: { query: { kind: "HogQLQuery", query: required(params, "query") } },
    }),
  },
  {
    name: "search_persons",
    description: "Persons whose email, name or distinct id matches.",
    params: [param("search", "Email, name or distinct id.", true), LIMIT],
    build: (params, config) => ({
      method: "GET",
      path: `/api/projects/${posthogProject(config)}/persons/`,
      query: { search: required(params, "search"), limit: limitParam(params) },
    }),
  },
];

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const STRIPE: ConnectionOperation[] = [
  {
    name: "search_customers",
    description:
      "Search customers with Stripe's search syntax, e.g. `email:'a@b.com'` or `name~'Dupont'`.",
    params: [param("query", "Stripe search query.", true), LIMIT],
    build: params => ({
      method: "GET",
      path: "/v1/customers/search",
      query: { query: required(params, "query"), limit: limitParam(params) },
    }),
  },
  {
    name: "get_customer",
    description: "One customer.",
    params: [param("id", "Customer id (cus_…).", true)],
    build: params => ({
      method: "GET",
      path: `/v1/customers/${idParam(params, "id")}`,
    }),
  },
  {
    name: "list_subscriptions",
    description: "A customer's subscriptions, every status.",
    params: [param("customer", "Customer id (cus_…).", true), LIMIT],
    build: params => ({
      method: "GET",
      path: "/v1/subscriptions",
      query: {
        customer: required(params, "customer"),
        status: "all",
        limit: limitParam(params),
      },
    }),
  },
  {
    name: "list_invoices",
    description: "A customer's invoices, newest first.",
    params: [param("customer", "Customer id (cus_…).", true), LIMIT],
    build: params => ({
      method: "GET",
      path: "/v1/invoices",
      query: {
        customer: required(params, "customer"),
        limit: limitParam(params),
      },
    }),
  },
];

const OPERATIONS: Record<string, ConnectionOperation[]> = {
  close: CLOSE,
  posthog: POSTHOG,
  stripe: STRIPE,
};

/** The named operations of a connection type (none for most). */
export function operationsFor(type: string): ConnectionOperation[] {
  return OPERATIONS[type] ?? [];
}

/** The operations of `type` as an agent sees them: name, description, params. */
export function describeOperations(type: string) {
  return operationsFor(type).map(({ name, description, params }) => ({
    name,
    description,
    params,
  }));
}

/**
 * The request operation `name` of a `type` connection sends, or a refusal
 * naming the operations that exist.
 */
export function operationRequest(
  type: string,
  config: Config,
  name: string,
  params: Params = {},
): ForwardInput {
  const operations = operationsFor(type);
  const operation = operations.find(op => op.name === name);
  if (!operation) {
    throw new ConnectionRequestError(
      operations.length
        ? `A ${type} connection has no operation ${name}. Its operations: ${operations.map(op => op.name).join(", ")}.`
        : `A ${type} connection has no named operations; send a request with method and path instead.`,
    );
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new ConnectionRequestError("params must be an object.");
  }
  return operation.build(params, config ?? {});
}
