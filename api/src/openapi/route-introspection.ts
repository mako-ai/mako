import { Hono } from "hono";

import { registerApiRoutes } from "../routes/register-routes";

/** A single documented HTTP operation discovered from the router. */
export interface DiscoveredRoute {
  /** Uppercase HTTP method, e.g. `GET`. */
  method: string;
  /** OpenAPI-style path with `{param}` placeholders, e.g. `/api/workspaces/{workspaceId}`. */
  path: string;
  /** Ordered list of path parameter names, e.g. `["workspaceId"]`. */
  params: string[];
}

/** HTTP methods we surface in the spec. Hono also registers `ALL` for `use()` middleware. */
const DOCUMENTED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

/**
 * Converts a Hono path (`:param`) to an OpenAPI path (`{param}`) and extracts
 * the parameter names in declaration order.
 */
function toOpenApiPath(honoPath: string): { path: string; params: string[] } {
  const params: string[] = [];
  const path = honoPath.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path, params };
}

/**
 * Builds a throwaway Hono app with every REST router mounted and reads its
 * registered routes. This guarantees the documentation enumerates exactly the
 * endpoints the live server serves — adding a route automatically surfaces it.
 *
 * Middleware (`app.use`) is registered by Hono under the `ALL` method with a
 * wildcard path and is filtered out, as are any wildcard catch-alls.
 */
export function discoverRoutes(): DiscoveredRoute[] {
  const probe = new Hono();
  registerApiRoutes(probe);

  const seen = new Set<string>();
  const routes: DiscoveredRoute[] = [];

  for (const route of probe.routes) {
    const method = route.method.toUpperCase();
    if (!DOCUMENTED_METHODS.has(method)) continue;
    if (route.path.includes("*")) continue;

    const { path, params } = toOpenApiPath(route.path);

    // Hono registers one entry per handler in a chain (middleware + handler),
    // so the same method+path can appear multiple times. Dedupe.
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    routes.push({ method, path, params });
  }

  routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );

  return routes;
}
