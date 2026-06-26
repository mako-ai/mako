/**
 * Spec-typed API client.
 *
 * Built on `openapi-fetch` over the types generated from the backend OpenAPI
 * document (`schema.d.ts`, produced by `pnpm generate:api-types`). Every call
 * is checked against the spec: invalid paths, missing path params, wrong
 * request bodies, and misread responses become compile-time errors.
 *
 * Behaviour mirrors the legacy `lib/api-client.ts`:
 *   - sends the session cookie (`credentials: "include"`)
 *   - injects the active workspace id as `x-workspace-id`
 *   - redirects to `/login` on `401` (outside auth pages)
 *
 * Prefer this client for new store code. Paths are the full spec paths
 * (e.g. `/api/workspaces/{workspaceId}/consoles`).
 */
import createClient, { type Client, type Middleware } from "openapi-fetch";

import { handleUnauthorized } from "../lib/auth-redirect";
import type { paths } from "./schema";

function activeWorkspaceId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem("activeWorkspaceId");
}

/** Injects the workspace header and handles `401` like the legacy client. */
const authMiddleware: Middleware = {
  onRequest({ request }) {
    const workspaceId = activeWorkspaceId();
    if (workspaceId && !request.headers.has("x-workspace-id")) {
      request.headers.set("x-workspace-id", workspaceId);
    }
    return request;
  },
  onResponse({ response }) {
    // Verify the session before redirecting so a transient 401 during a
    // deploy doesn't bounce the user to /login (see lib/auth-redirect.ts).
    if (response.status === 401) {
      void handleUnauthorized();
    }
    return response;
  },
};

/**
 * Creates a typed client. Exported mainly so tests can supply their own
 * `baseUrl`/`fetch`; application code should import the {@link api} singleton.
 */
export function createApiClient(
  baseUrl = "",
  fetchImpl?: typeof fetch,
): Client<paths> {
  const client = createClient<paths>({
    baseUrl,
    credentials: "include",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  client.use(authMiddleware);
  return client;
}

/** Singleton typed client for application/store code. */
export const api = createApiClient();
