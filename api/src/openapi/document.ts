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

const OPEN_RESPONSE_SCAFFOLD_CODES = [
  "200",
  "201",
  "202",
  "204",
  "206",
  "400",
  "401",
  "402",
  "403",
  "404",
  "409",
  "410",
  "416",
  "422",
  "429",
  "500",
  "502",
  "503",
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

function schemaContainsRef(schema: unknown, ref: string): boolean {
  const schemaObject = schema as
    | { $ref?: string; allOf?: unknown[]; anyOf?: unknown[]; oneOf?: unknown[] }
    | undefined;
  if (!schemaObject) return false;
  if (schemaObject.$ref === ref) return true;
  return [
    ...(schemaObject.allOf ?? []),
    ...(schemaObject.anyOf ?? []),
    ...(schemaObject.oneOf ?? []),
  ].some(item => schemaContainsRef(item, ref));
}

function jsonSchema(response: unknown): unknown {
  const responseObject = response as
    | {
        content?: {
          "application/json"?: {
            schema?: unknown;
          };
        };
      }
    | undefined;
  return responseObject?.content?.["application/json"]?.schema;
}

/**
 * `OPEN_RESPONSES` intentionally declares a broad set of concrete statuses so
 * Hono can type-check existing handlers with dynamic status returns. That is an
 * implementation detail; docs should not claim every endpoint returns every
 * scaffold status. Collapse the scaffold to concise status ranges while
 * preserving explicitly-modelled success schemas.
 */
function collapseOpenResponseScaffold(doc: {
  paths?: Record<
    string,
    Record<string, { responses?: Record<string, unknown> }>
  >;
}): void {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      const responses = op?.responses;
      if (!responses) continue;

      const hasFullScaffold = OPEN_RESPONSE_SCAFFOLD_CODES.every(
        code => responses[code],
      );
      if (!hasFullScaffold) continue;

      const isGenericSuccess = schemaContainsRef(
        jsonSchema(responses["200"]),
        "#/components/schemas/GenericJsonResponse",
      );
      const collapsed: Record<string, unknown> = {};
      if (isGenericSuccess) {
        collapsed["2XX"] = responses["200"];
      } else {
        collapsed["200"] = responses["200"];
      }
      collapsed["4XX"] = responses["400"];
      collapsed["5XX"] = responses["500"];

      for (const [code, response] of Object.entries(responses)) {
        if (!OPEN_RESPONSE_SCAFFOLD_CODES.includes(code as any)) {
          collapsed[code] = response;
        }
      }

      op.responses = collapsed;
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
  collapseOpenResponseScaffold(
    doc as Parameters<typeof collapseOpenResponseScaffold>[0],
  );
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
