import { discoverRoutes, type DiscoveredRoute } from "./route-introspection";
import {
  OPERATION_METADATA,
  TAG_DESCRIPTIONS,
  defaultResponses,
  deriveTag,
  isPublicPath,
  type OperationMetadata,
} from "./metadata";
import type {
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiTag,
} from "./types";

const API_VERSION = "1.0.0";

const VERB_BY_METHOD: Record<string, string> = {
  GET: "Get",
  POST: "Create",
  PUT: "Update",
  PATCH: "Update",
  DELETE: "Delete",
};

function prettifySegment(segment: string): string {
  return segment
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Produces a readable default summary like "List Consoles" / "Create Workspace"
 * for endpoints that have no curated summary, so the reference is legible even
 * before anyone hand-documents an endpoint.
 */
function defaultSummary(route: DiscoveredRoute): string {
  const segments = route.path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const isItemOp = last.startsWith("{");
  // The resource is the last non-parameter segment.
  const resourceSegment =
    [...segments].reverse().find(s => !s.startsWith("{")) ?? "resource";
  const resource = prettifySegment(resourceSegment);

  if (route.method === "GET") {
    return isItemOp ? `Get ${resource}` : `List ${resource}`;
  }
  const verb = VERB_BY_METHOD[route.method] ?? route.method;
  return `${verb} ${resource}`;
}

function operationId(route: DiscoveredRoute): string {
  const slug = route.path
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${route.method.toLowerCase()}_${slug}`;
}

function pathParameters(route: DiscoveredRoute): OpenApiParameter[] {
  return route.params.map(name => ({
    name,
    in: "path" as const,
    required: true,
    schema: { type: "string" },
  }));
}

function buildOperation(
  route: DiscoveredRoute,
  meta: OperationMetadata | undefined,
): OpenApiOperation {
  const tags = meta?.tags ?? [deriveTag(route.path)];

  // Security: explicit override wins; otherwise public paths get no requirement
  // and everything else inherits the document-level (cookie OR bearer) default.
  let security = meta?.security;
  if (!security && isPublicPath(route.path)) {
    security = [];
  }

  const parameters: OpenApiParameter[] = [
    ...pathParameters(route),
    ...(meta?.parameters ?? []),
  ];

  return {
    operationId: operationId(route),
    summary: meta?.summary ?? defaultSummary(route),
    description: meta?.description,
    tags,
    deprecated: meta?.deprecated,
    security,
    parameters: parameters.length > 0 ? parameters : undefined,
    requestBody: meta?.requestBody,
    responses: meta?.responses ?? defaultResponses(),
  };
}

function buildTags(usedTags: Set<string>): OpenApiTag[] {
  return [...usedTags]
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({
      name,
      description: TAG_DESCRIPTIONS[name],
    }));
}

/** Builds the full OpenAPI 3.1 document from the live route table. */
export function buildOpenApiDocument(): OpenApiDocument {
  const routes = discoverRoutes();
  const paths: Record<string, OpenApiPathItem> = {};
  const usedTags = new Set<string>();

  for (const route of routes) {
    const meta = OPERATION_METADATA[`${route.method} ${route.path}`];
    const operation = buildOperation(route, meta);
    operation.tags.forEach(tag => usedTags.add(tag));

    const item: OpenApiPathItem = paths[route.path] ?? {};
    const verb = route.method.toLowerCase() as keyof OpenApiPathItem;
    item[verb] = operation;
    paths[route.path] = item;
  }

  const baseUrl = process.env.BASE_URL || "http://localhost:8080";

  return {
    openapi: "3.1.0",
    info: {
      title: "Mako REST API",
      version: API_VERSION,
      description:
        "The Mako REST API. All endpoints are prefixed with `/api`.\n\n" +
        "**Authentication.** Most endpoints accept either a session cookie " +
        "(`auth_session`, set by `POST /api/auth/login`) or a workspace API key " +
        "passed as `Authorization: Bearer revops_<key>`. Endpoints under " +
        "`/api/connectors`, `/api/databases`, `/api/share`, and `/api/webhooks` " +
        "are intentionally public.\n\n" +
        "This document is generated directly from the server's route table, so " +
        "it always reflects the endpoints the API actually serves.",
    },
    servers: [{ url: baseUrl, description: "Configured API base URL" }],
    tags: buildTags(usedTags),
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "auth_session",
          description:
            "Session cookie set by `POST /api/auth/login`. Used by browser clients.",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Workspace API key. Send as `Authorization: Bearer revops_<key>`. " +
            "Used by programmatic clients and agents.",
        },
      },
    },
  };
}

let cached: OpenApiDocument | null = null;

/**
 * Returns the OpenAPI document, building it once and caching the result. The
 * route table is fixed at startup, so a single build per process is sufficient.
 */
export function getOpenApiDocument(): OpenApiDocument {
  if (!cached) {
    cached = buildOpenApiDocument();
  }
  return cached;
}
