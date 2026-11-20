/**
 * Close, as a call_connection profile: data only, no connector folder.
 *
 * Stored `type: close` connections keep working through the proxy without
 * api/src/connectors/close. This file holds everything the proxy needs: the
 * call profile (base URL, basic auth with the api_key as username, the
 * x-http-method-override rule, what counts as a read, the rate gate), the
 * three named read operations, and the config schema that marks `api_key` as
 * a secret, so a stored config decrypts and re-encrypts exactly as before.
 *
 * Registering it does not make `close` a connector: there is no
 * getConnectorFor, no flow, no entity and no registry listing for it.
 *
 * Nothing imported is used while this module loads (callable.ts and
 * operations.ts import profiles/, which import them back): the operations
 * are built on first use.
 */
import {
  connectionGateKey,
  text,
  type CallableConnection,
  type RequestShape,
} from "../callable";
import {
  OPERATION_DEFAULT_LIMIT,
  OPERATION_MAX_LIMIT,
  idParam,
  limitParam,
  optional,
  param,
  required,
  skipParam,
  type ConnectionOperation,
} from "../operations";
import type { CallableProfile } from ".";

/** The base URL Close is called at. */
const CLOSE_BASE_URL = "https://api.close.com/api/v1";

/** A POST the caller asked Close to read as a GET. */
function closeReadsAsGet(request: RequestShape): boolean {
  return request.method === "POST" && request.methodOverride === "GET";
}

export const closeCallable: CallableConnection = {
  type: "close",
  baseUrl: () => CLOSE_BASE_URL,
  baseUrlFields: [],
  // Close: the API key as the basic-auth username, no password.
  credential: config => ({
    type: "basic",
    username: text(config.api_key),
    password: "",
  }),
  reads(request) {
    // Only a POST can be a read here: Close reads a POST as a GET when told
    // so (the connector lists leads that way), and its search API only
    // searches. Any other method writes, whatever its headers say.
    if (request.method !== "POST") return false;
    if (closeReadsAsGet(request)) return true;
    return /^\/data\/search\/?$/.test(request.path);
  },
  // The caller's override is never forwarded; this is the one Mako sends.
  methodOverrides: ["GET"],
  extraHeaders: (request): Record<string, string> =>
    closeReadsAsGet(request) ? { "x-http-method-override": "GET" } : {},
  rateGate(connection) {
    // The connector's own gate: keyed by the key, at least 500 ms apart.
    return {
      key: text(connection.config?.api_key) || connectionGateKey(connection),
      minDelayMs: Math.max(
        500,
        Number(connection.settings?.rate_limit_delay_ms) || 200,
      ),
    };
  },
};

const CLOSE_LEAD_FIELDS =
  "id,display_name,status_label,contacts,date_created,date_updated,url";

function buildCloseOperations(): ConnectionOperation[] {
  const LIMIT = param(
    "limit",
    `Records per page (default ${OPERATION_DEFAULT_LIMIT}, max ${OPERATION_MAX_LIMIT}).`,
  );
  return [
    {
      name: "search_leads",
      description:
        'Search leads with Close\'s search syntax: a name, an email, a phone, or a query like `email_address:"a@b.com"` or `name:"Dupont"`.',
      params: [
        param("query", "Close search text or query.", true),
        LIMIT,
        param("skip", "Records to skip, for the next page."),
        param(
          "fields",
          `Comma-separated fields (default ${CLOSE_LEAD_FIELDS}).`,
        ),
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
      description:
        "One lead with its contacts, opportunities and custom fields.",
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
}

let operations: ConnectionOperation[] | null = null;

export const closeProfile: CallableProfile = {
  type: "close",
  callable: closeCallable,
  operations: () => (operations ??= buildCloseOperations()),
  // The removed connector's getConfigSchema(): same field, same flags.
  configSchema: {
    fields: [
      {
        name: "api_key",
        label: "API Key",
        type: "password",
        required: true,
        helperText: "Close API Key (generate in Close settings)",
      },
    ],
  },
};
