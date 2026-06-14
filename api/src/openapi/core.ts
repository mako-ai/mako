import { OpenAPIHono, z } from "@hono/zod-openapi";

import type { ValidatedSession, ValidatedUser } from "../auth/session";

/**
 * Context variables populated by the auth + workspace middleware chain. Typing
 * routers with this Env means `c.get("user")` / `c.get("workspace")` etc. are
 * typed inside every handler without per-handler annotations.
 */
export interface AuthVariables {
  user?: ValidatedUser;
  session?: ValidatedSession;
  // `workspace`, `apiKey` are Mongoose documents; kept loose (matches the
  // existing AuthenticatedContext, which types these as `any`).

  workspace?: any;

  apiKey?: any;
  memberRole?: string;
  authType?: "session" | "apiKey";
  workspaceId?: string;
}

export type AuthEnv = { Variables: AuthVariables };

/**
 * Shared building blocks for documenting the REST API with `@hono/zod-openapi`.
 *
 * Every route module creates its router via {@link createRouter} (an
 * `OpenAPIHono` with a consistent validation-error hook) and declares its
 * endpoints with `createRoute` + Zod schemas. The OpenAPI document is then
 * produced natively from those declarations — there is no hand-maintained
 * metadata or route introspection.
 *
 * The helpers below are intentionally generic so the Zod schemas flow through
 * to `OpenAPIHono.openapi(...)`, which type-checks each handler's responses
 * against the declared schemas. Declare response status codes as literal keys
 * (e.g. `400: errorJson(...)`) so that inference knows which statuses a handler
 * may return.
 */

/** Standard error envelope returned across the API (`{ success: false, error }`). */
export const ErrorSchema = z
  .object({
    success: z.boolean().optional(),
    error: z.string().openapi({ example: "Human-readable error message" }),
  })
  .openapi("Error");

/**
 * Loosely-typed error envelope for the permissive {@link OPEN_RESPONSES} set.
 * Every field is optional so that wrapping an existing handler (whose success
 * return shares the inferred status union) never fails type inference, while
 * still documenting the `{ success, error }` shape with a named component —
 * a strict improvement over an open `{}` body.
 */
export const ErrorEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    error: z.string().optional().openapi({ example: "Error message" }),
  })
  .openapi("ErrorEnvelope");

/** Creates an `OpenAPIHono` router whose validation errors use the API envelope. */
export function createRouter(): OpenAPIHono<AuthEnv> {
  return new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message =
          result.error.issues[0]?.message ?? "Invalid request payload";
        return c.json({ success: false, error: message }, 400);
      }
      return undefined;
    },
  });
}

/** Wraps a schema as an `application/json` response with a description. */
export function jsonContent<T extends z.ZodType>(
  schema: T,
  description: string,
) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

/** Standard JSON error response using the shared {@link ErrorSchema}. */
export function errorJson(description: string) {
  return jsonContent(ErrorSchema, description);
}

/** A `{ success: true, data }` envelope schema for the given data schema. */
export function successEnvelope<T extends z.ZodType>(dataSchema: T) {
  return z.object({ success: z.literal(true), data: dataSchema });
}

/** `{ success: true, message }` — for write endpoints that return an ack. */
export const MessageResponseSchema = z
  .object({ success: z.literal(true), message: z.string() })
  .openapi("MessageResponse");

/** A `200` JSON response wrapping `data` in the success envelope. */
export function dataResponse<T extends z.ZodType>(
  dataSchema: T,
  description = "Successful response",
) {
  return jsonContent(successEnvelope(dataSchema), description);
}

/** Declares a required path parameter as a string. */
export function pathParam(name: string) {
  return z.string().openapi({ param: { name, in: "path" } });
}

/** Declares an optional query parameter as a string. */
export function queryParam(name: string) {
  return z
    .string()
    .optional()
    .openapi({ param: { name, in: "query" } });
}

/** A JSON request body for the given schema (required unless `optional`). */
export function jsonBody<T extends z.ZodType>(schema: T, optional = false) {
  return {
    required: !optional,
    content: { "application/json": { schema } },
  };
}

/**
 * Generic success response (`200`) with an open JSON body. Used when wrapping an
 * existing handler whose payload is dynamic or not worth modelling field-by-field;
 * the route contract, params/query validation, and status codes are still typed.
 */
export const okJson = jsonContent(z.any(), "Successful response");

/** Generic `201 Created` response with an open JSON body. */
export const createdJson = jsonContent(z.any(), "Created");

/** `204 No Content` response. */
export const noContentResponse = { description: "No content" };

/**
 * The standard error responses every endpoint may return, keyed by literal
 * status code so `OpenAPIHono.openapi(...)` allows handlers to return any of
 * them. Spread into a route's `responses` alongside its success response(s).
 */
export const STD_ERRORS = {
  400: errorJson("Invalid request"),
  401: errorJson("Authentication required"),
  403: errorJson("Forbidden"),
  404: errorJson("Not found"),
  409: errorJson("Conflict"),
  500: errorJson("Internal server error"),
};

/** Convenience: `{ 200: okJson, ...STD_ERRORS }`. */
export const STD_RESPONSES = { 200: okJson, ...STD_ERRORS };

/**
 * Permissive response set (open JSON body for every common status) used when
 * wrapping an existing handler whose return shapes/statuses are dynamic. This
 * documents the route, validates request params/query/body, and keeps the
 * handler body untouched (preserving runtime behaviour). Error bodies follow
 * the shared `{ success: false, error }` envelope at runtime; richer per-field
 * response typing is applied module-by-module (see connectors/database-schemas).
 */
const err = (description: string) =>
  jsonContent(ErrorEnvelopeSchema, description);

export const OPEN_RESPONSES = {
  200: jsonContent(z.any(), "Successful response"),
  201: jsonContent(z.any(), "Created"),
  202: jsonContent(z.any(), "Accepted"),
  204: { description: "No content" },
  206: jsonContent(z.any(), "Partial content"),
  400: err("Invalid request"),
  401: err("Authentication required"),
  402: err("Payment required"),
  403: err("Forbidden"),
  404: err("Not found"),
  409: err("Conflict"),
  410: err("Gone"),
  416: err("Range not satisfiable"),
  422: err("Unprocessable entity"),
  429: err("Too many requests"),
  500: err("Internal server error"),
  502: err("Bad gateway"),
  503: err("Service unavailable"),
};

/** Security requirement: session cookie OR workspace API key. */
export const AUTH_SECURITY: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
];

/** Registers the shared security schemes on an `OpenAPIHono` registry. */
export function registerSecuritySchemes(app: OpenAPIHono<AuthEnv>): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "auth_session",
    description:
      "Session cookie set by `POST /api/auth/login`. Used by browser clients.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "Workspace API key. Send as `Authorization: Bearer revops_<key>`. " +
      "Used by programmatic clients and agents.",
  });
}

/** Top-level metadata for the generated document. */
export const OPENAPI_INFO = {
  title: "Mako REST API",
  version: "1.0.0",
  description:
    "The Mako REST API. All endpoints are prefixed with `/api`.\n\n" +
    "**Authentication.** Most endpoints accept either a session cookie " +
    "(`auth_session`, set by `POST /api/auth/login`) or a workspace API key " +
    "passed as `Authorization: Bearer revops_<key>`. Endpoints under " +
    "`/api/connectors`, `/api/databases`, `/api/share`, and `/api/webhooks` " +
    "are intentionally public.\n\n" +
    "This document is generated directly from the Zod route definitions, so " +
    "it always reflects the validation and types the API enforces.",
} as const;
