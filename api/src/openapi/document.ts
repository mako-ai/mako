import { registerApiRoutes } from "../routes/register-routes";
import { OPENAPI_INFO, createRouter, registerSecuritySchemes } from "./core";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
] as const;

/**
 * Derives a stable `operationId` from the method + path, e.g.
 * `get_api_workspaces_workspaceId_consoles`. `@hono/zod-openapi` does not
 * synthesize these, so we assign any that are missing — operationIds are what
 * client/SDK codegen keys off of.
 */
function operationId(method: string, path: string): string {
  const slug = path
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${method}_${slug}`;
}

/** Mutates the document in place, filling in any missing operationIds. */
function assignOperationIds(doc: {
  paths?: Record<string, Record<string, { operationId?: string }>>;
}): void {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op && !op.operationId) {
        op.operationId = operationId(method, path);
      }
    }
  }
}

/**
 * Builds a throwaway app with every router mounted and emits the OpenAPI 3.1
 * document natively from the Zod route definitions registered via
 * `OpenAPIHono.openapi(...)`. Routers that have not yet been migrated to
 * `@hono/zod-openapi` simply contribute no paths (they remain fully functional
 * on the live server, just undocumented).
 */
export function buildOpenApiDocument() {
  const app = createRouter();
  registerSecuritySchemes(app);
  registerApiRoutes(app);

  const baseUrl = process.env.BASE_URL || "http://localhost:8080";

  const doc = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: OPENAPI_INFO,
    servers: [{ url: baseUrl, description: "Configured API base URL" }],
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  });

  assignOperationIds(doc as Parameters<typeof assignOperationIds>[0]);
  return doc;
}

let cached: ReturnType<typeof buildOpenApiDocument> | null = null;

/** Returns the OpenAPI document, building it once per process and caching it. */
export function getOpenApiDocument() {
  if (!cached) {
    cached = buildOpenApiDocument();
  }
  return cached;
}
