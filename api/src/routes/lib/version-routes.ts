/**
 * Version-history routes shared by snapshot-versioned resource kinds
 * (dashboards via EntityVersion, notebooks via the notebook store). Each
 * kind used to hand-roll the same three handlers — list / get / restore —
 * with its own load-and-gate boilerplate and error envelope.
 *
 * The registrar owns the route shape and the handler shell (resource-op);
 * a `VersionBackend` owns loading, ACL gating, and version semantics, and
 * returns the exact payload its kind's frontend already expects (`versions`
 * + `total` and `version` for dashboards, `data` for notebooks) — response
 * envelopes and path-parameter names are deliberately contract-stable, so
 * each kind names its version path segment via `refParam`.
 *
 * Consoles are deliberately NOT registered here: their history is git
 * commits (`/{id}/git/file-versions`, apps.md §16), a different surface.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";

import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  jsonBody,
  pathParam,
  queryParam,
  type AuthEnv,
} from "../../openapi/core";
import {
  createOpRunner,
  type ResourceOpContext,
  type ResourceOpResult,
} from "./resource-op";

export interface VersionBackend {
  /** Read-gated. Payload shape is the kind's historical list envelope. */
  list(
    ctx: ResourceOpContext,
    input: { id: string; limit?: number; offset?: number },
  ): Promise<ResourceOpResult>;
  /** Read-gated. `ref` is the raw path segment (numeric or store id). */
  get(
    ctx: ResourceOpContext,
    input: { id: string; ref: string },
  ): Promise<ResourceOpResult>;
  /** Write-gated. */
  restore(
    ctx: ResourceOpContext,
    input: { id: string; ref: string; body: Record<string, unknown> },
  ): Promise<ResourceOpResult>;
}

export interface VersionRoutesConfig {
  /** OpenAPI tag, e.g. "Dashboards". */
  tag: string;
  /** Prefix for OpenAPI schema names, e.g. "Dashboard". */
  schemaPrefix: string;
  /**
   * Name of the version path parameter — "version" (dashboards) or
   * "versionId" (notebooks). Part of the public contract; keep stable.
   */
  refParam: string;
  backend: VersionBackend;
  /** Per-route middleware for routers that don't mount auth router-level. */
  middleware?: readonly MiddlewareHandler[];
  actor?: "user-required" | "allow-system";
  /** Declare limit/offset list-query params in the contract (dashboards). */
  listQuery?: boolean;
  onError?: (c: Context, error: unknown) => Response | undefined;
}

function intOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function registerVersionRoutes(
  router: OpenAPIHono<AuthEnv>,
  config: VersionRoutesConfig,
): void {
  const { tag, schemaPrefix, refParam, backend, middleware } = config;

  const run = createOpRunner({
    tag,
    actor: config.actor,
    onError: config.onError,
  });

  const routeBase = {
    tags: [tag],
    security: AUTH_SECURITY,
    ...(middleware ? { middleware: [...middleware] } : {}),
    responses: { ...OPEN_RESPONSES },
  };

  const idParams = z.object({
    workspaceId: pathParam("workspaceId"),
    id: pathParam("id"),
  });
  const refParams = z.object({
    workspaceId: pathParam("workspaceId"),
    id: pathParam("id"),
    [refParam]: pathParam(refParam),
  });

  // GET /{id}/versions — list (newest first)
  router.openapi(
    createRoute({
      method: "get",
      path: "/{id}/versions",
      summary: "GET /{id}/versions",
      ...routeBase,
      request: {
        params: idParams,
        ...(config.listQuery
          ? {
              query: z.object({
                limit: queryParam("limit"),
                offset: queryParam("offset"),
              }),
            }
          : {}),
      },
    }),
    async c =>
      run(c, ctx =>
        backend.list(ctx, {
          id: c.req.param("id") ?? "",
          limit: intOrUndefined(c.req.query("limit")),
          offset: intOrUndefined(c.req.query("offset")),
        }),
      ),
  );

  // GET /{id}/versions/{ref} — one version
  router.openapi(
    createRoute({
      method: "get",
      path: `/{id}/versions/{${refParam}}`,
      summary: `GET /{id}/versions/{${refParam}}`,
      ...routeBase,
      request: { params: refParams },
    }),
    async c =>
      run(c, ctx =>
        backend.get(ctx, {
          id: c.req.param("id") ?? "",
          ref: c.req.param(refParam) ?? "",
        }),
      ),
  );

  // POST /{id}/versions/{ref}/restore
  router.openapi(
    createRoute({
      method: "post",
      path: `/{id}/versions/{${refParam}}/restore`,
      summary: `POST /{id}/versions/{${refParam}}/restore`,
      ...routeBase,
      request: {
        params: refParams,
        body: jsonBody(
          z
            .object({
              comment: z.string().optional(),
              clientId: z.string().optional(),
            })
            .openapi(`Restore${schemaPrefix}VersionRequest`),
          true,
        ),
      },
    }),
    async c => {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<
        string,
        unknown
      >;
      return run(c, ctx =>
        backend.restore(ctx, {
          id: c.req.param("id") ?? "",
          ref: c.req.param(refParam) ?? "",
          body,
        }),
      );
    },
  );
}
