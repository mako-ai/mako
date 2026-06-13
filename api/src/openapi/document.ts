import { registerApiRoutes } from "../routes/register-routes";
import { OPENAPI_INFO, createRouter, registerSecuritySchemes } from "./core";

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

  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: OPENAPI_INFO,
    servers: [{ url: baseUrl, description: "Configured API base URL" }],
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  });
}

let cached: ReturnType<typeof buildOpenApiDocument> | null = null;

/** Returns the OpenAPI document, building it once per process and caching it. */
export function getOpenApiDocument() {
  if (!cached) {
    cached = buildOpenApiDocument();
  }
  return cached;
}
