import { z } from "zod";
import { AppDefinitionSchema, DashboardDefinitionSchema } from "@mako/schemas";

import type {
  JsonSchema,
  OpenApiParameter,
  OpenApiRequestBody,
  OpenApiResponse,
} from "./types";

/**
 * Author-supplied enrichment for a single operation. Everything is optional —
 * the generator fills in sensible defaults (summary, security, responses) for
 * any field left undefined, so endpoints stay documented even before anyone
 * hand-curates them.
 */
export interface OperationMetadata {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  /** Override the inferred security requirement. Use `[]` to mark public. */
  security?: Array<Record<string, string[]>>;
  /** Extra (non-path) parameters such as query strings. */
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
}

/** Human-friendly tag labels keyed by the resource segment of the path. */
const TAG_LABELS: Record<string, string> = {
  auth: "Authentication",
  workspaces: "Workspaces",
  consoles: "Consoles",
  execute: "Query Execution",
  databases: "Databases",
  realtime: "Realtime",
  chats: "Chats",
  "chat-images": "Chat Images",
  "custom-prompt": "Custom Prompt",
  skills: "Skills",
  connectors: "Connectors",
  flows: "Flows",
  "scheduled-queries": "Scheduled Queries",
  "notification-rules": "Notification Rules",
  usage: "Usage",
  billing: "Billing",
  dashboards: "Dashboards",
  apps: "Apps",
  share: "Public Shares",
  agent: "Agent",
  admin: "Admin",
  webhooks: "Webhooks",
  dev: "Development",
};

/** One-line descriptions for tags, surfaced as section intros in the docs. */
export const TAG_DESCRIPTIONS: Record<string, string> = {
  Authentication: "Account registration, login, sessions, and OAuth flows.",
  Workspaces: "Workspaces, members, invitations, and API keys.",
  Consoles: "Saved SQL/Mongo consoles: CRUD, execution, sharing, schedules.",
  "Query Execution": "Ad-hoc query execution against connected databases.",
  Databases: "Connected databases, schema metadata, and the object tree.",
  Realtime: "Realtime collaboration channels and presence.",
  Chats: "AI chat threads and message history.",
  "Chat Images": "Image attachments for AI chats.",
  "Custom Prompt": "Workspace-level custom agent instructions.",
  Skills: "Reusable agent skills.",
  Connectors: "Available connector types and workspace data-source connectors.",
  Flows: "Data sync flows and webhook-triggered flows.",
  "Scheduled Queries": "Cron-scheduled saved queries.",
  "Notification Rules": "Alerting rules for query results and flows.",
  Usage: "Workspace usage metering.",
  Billing: "Subscriptions, plans, and Stripe billing.",
  Dashboards: "Dashboards, widgets, and materialization.",
  Apps: "Custom data apps.",
  "Public Shares": "Token-gated, read-only public shares (no auth required).",
  Agent: "AI agent: models, chat streaming, and tool execution.",
  Admin: "Super-admin operations.",
  Webhooks: "Inbound webhooks (connectors and Stripe). Signature-verified.",
  Development: "Local development helpers (not available in production).",
};

/**
 * Path prefixes that are intentionally unauthenticated. Operations under these
 * default to no security requirement unless an override says otherwise.
 */
const PUBLIC_PREFIXES = [
  "/api/auth",
  "/api/connectors",
  "/api/databases",
  "/api/share",
  "/api/webhooks",
];

export function isPublicPath(path: string): boolean {
  return PUBLIC_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Derives the section/tag for an operation from its path. */
export function deriveTag(path: string): string {
  const segments = path.split("/").filter(Boolean); // ["api", "workspaces", ...]
  if (segments[0] !== "api") return "Other";
  if (segments.length < 2) return "General";

  let key = segments[1];
  // Workspace-scoped resources live at /api/workspaces/{workspaceId}/<resource>.
  // Only promote the sub-resource to its own tag when it's a known major
  // resource (consoles, dashboards, …); minor workspace sub-resources
  // (members, api-keys, settings, …) and workspace-level routes
  // (/api/workspaces/invites/{token}) roll up under "Workspaces".
  if (
    key === "workspaces" &&
    segments.length >= 4 &&
    segments[2].startsWith("{")
  ) {
    const subResource = segments[3];
    if (TAG_LABELS[subResource]) {
      key = subResource;
    }
  }

  return TAG_LABELS[key] ?? toTitleCase(key);
}

function toTitleCase(segment: string): string {
  return segment
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Converts a Zod schema into a JSON Schema suitable for embedding in an OpenAPI
 * 3.1 document (which uses JSON Schema draft 2020-12). Falls back to a permissive
 * object schema if conversion fails for an exotic schema feature.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    const json = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "any",
    }) as JsonSchema;
    // `$schema` is redundant once embedded under components/content.
    delete json.$schema;
    return json;
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

/** Standard JSON envelope returned by most error responses. */
export const ERROR_RESPONSE: OpenApiResponse = {
  description: "Error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean", enum: [false] },
          error: {
            type: "string",
            description: "Human-readable error message",
          },
        },
        required: ["error"],
      },
    },
  },
};

const jsonResponse = (description: string): OpenApiResponse => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

/**
 * Curated, hand-authored documentation for high-traffic endpoints. Keyed by
 * `"<METHOD> <path>"` (OpenAPI path form). Anything not listed here is still
 * documented automatically with generated defaults; add entries over time to
 * progressively enrich the reference.
 */
export const OPERATION_METADATA: Record<string, OperationMetadata> = {
  "POST /api/auth/register": {
    summary: "Register a new account",
    description:
      "Creates a user with email + password. Returns the user and triggers an email verification code. Login requires a verified email.",
    security: [],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["email", "password"],
            properties: {
              email: { type: "string", format: "email" },
              password: { type: "string", minLength: 8 },
              name: { type: "string" },
            },
          },
        },
      },
    },
  },
  "POST /api/auth/login": {
    summary: "Log in with email and password",
    description:
      "Authenticates a user and sets the `auth_session` cookie. The email must be verified.",
    security: [],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["email", "password"],
            properties: {
              email: { type: "string", format: "email" },
              password: { type: "string" },
            },
          },
        },
      },
    },
  },
  "GET /api/auth/me": {
    summary: "Get the current authenticated user",
    description: "Returns the user associated with the active session cookie.",
    security: [{ cookieAuth: [] }],
  },
  "POST /api/auth/logout": {
    summary: "Log out",
    description: "Invalidates the current session and clears the cookie.",
    security: [{ cookieAuth: [] }],
  },
  "GET /api/workspaces": {
    summary: "List workspaces",
    description: "Lists all workspaces the authenticated user belongs to.",
  },
  "POST /api/workspaces": {
    summary: "Create a workspace",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", description: "Workspace display name" },
              slug: { type: "string", description: "Optional URL slug" },
            },
          },
        },
      },
    },
  },
  "POST /api/workspaces/{workspaceId}/execute": {
    summary: "Execute an ad-hoc query",
    description:
      "Runs a query against a connected database in the workspace and returns the result set. Supports cursor-based pagination via `pageSize` and `cursor`.",
    parameters: [
      {
        name: "mode",
        in: "query",
        required: false,
        description: "Execution mode (e.g. paginated vs. full).",
        schema: { type: "string" },
      },
      {
        name: "pageSize",
        in: "query",
        required: false,
        schema: { type: "integer" },
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["databaseId", "query"],
            properties: {
              databaseId: { type: "string" },
              query: { type: "string", description: "SQL or Mongo query text" },
            },
          },
        },
      },
    },
  },
  "GET /api/workspaces/{workspaceId}/consoles": {
    summary: "List consoles",
    description: "Lists saved consoles in the workspace.",
  },
  "POST /api/workspaces/{workspaceId}/consoles/{id}/execute": {
    summary: "Execute a saved console",
    description:
      "Runs the query stored in a saved console. Supports cursor pagination via `mode`, `pageSize`, and `cursor` query parameters.",
    parameters: [
      {
        name: "mode",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "pageSize",
        in: "query",
        required: false,
        schema: { type: "integer" },
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ],
  },
  "GET /api/connectors/types": {
    summary: "List connector types",
    description:
      "Returns metadata for every available connector type. Public — no authentication required.",
    security: [],
    responses: {
      "200": {
        description: "Connector type metadata.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                success: { type: "boolean" },
                data: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
    },
  },
  "GET /api/agent/models": {
    summary: "List available AI models",
    description:
      "Returns the catalog of selectable AI models plus the recommended default.",
  },
  "PUT /api/workspaces/{workspaceId}/apps/{id}": {
    summary: "Update an app definition",
    description:
      "Replaces an app's definition. Body is validated against the shared app schema.",
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: zodToJsonSchema(AppDefinitionSchema) },
      },
    },
  },
  "PATCH /api/workspaces/{workspaceId}/dashboards/{id}": {
    summary: "Update a dashboard",
    description:
      "Partially updates a dashboard. Body is validated against the shared dashboard schema.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: zodToJsonSchema(DashboardDefinitionSchema.partial()),
        },
      },
    },
  },
};

/** Default responses applied when an operation has no curated `responses`. */
export function defaultResponses(): Record<string, OpenApiResponse> {
  return {
    "200": jsonResponse("Successful response"),
    "400": { ...ERROR_RESPONSE, description: "Invalid request" },
    "401": { ...ERROR_RESPONSE, description: "Authentication required" },
    "500": { ...ERROR_RESPONSE, description: "Internal server error" },
  };
}
