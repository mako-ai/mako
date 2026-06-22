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

import type { paths } from "./schema";

let isRedirectingToLogin = false;

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
    if (response.status === 401 && typeof window !== "undefined") {
      try {
        localStorage.removeItem("activeWorkspaceId");
      } catch {
        // ignore storage failures
      }
      const path = window.location.pathname;
      const isAuthPage = path === "/login" || path === "/register";
      if (!isAuthPage && !isRedirectingToLogin) {
        isRedirectingToLogin = true;
        window.location.href = "/login";
      }
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
