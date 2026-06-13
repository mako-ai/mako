import { OpenAPIHono, z } from "@hono/zod-openapi";

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

/** Creates an `OpenAPIHono` router whose validation errors use the API envelope. */
export function createRouter(): OpenAPIHono {
  return new OpenAPIHono({
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

/** Security requirement: session cookie OR workspace API key. */
export const AUTH_SECURITY = [{ cookieAuth: [] }, { bearerAuth: [] }];

/** Registers the shared security schemes on an `OpenAPIHono` registry. */
export function registerSecuritySchemes(app: OpenAPIHono): void {
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
