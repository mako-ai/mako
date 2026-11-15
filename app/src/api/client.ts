/**
 * Spec-typed API client.
 *
 * Built on `openapi-fetch` over the types generated from the backend OpenAPI
 * document (`schema.d.ts`, produced by `pnpm generate:api-types`). Every call
 * is checked against the spec: invalid paths, missing path params, wrong
 * request bodies, and misread responses become compile-time errors.
 *
 * Every request:
 *   - sends the session cookie (`credentials: "include"`)
 *   - injects the active workspace id as `x-workspace-id`
 *   - redirects to `/login` on `401` (outside auth pages)
 *
 * This is the one way the app calls its JSON API (stores only — see
 * .cursor/rules/18-frontend-state.mdc). Paths are the full spec paths (e.g.
 * `/api/workspaces/{workspaceId}/consoles`); routes the spec does not describe
 * yet go through `unspecced` (same client instance and middleware).
 */
import createClient, { type Client, type Middleware } from "openapi-fetch";

import { handleUnauthorized } from "../lib/auth-redirect";
import type { paths } from "./schema";
import { getBootWorkspaceId } from "../lib/active-workspace";

/**
 * Where the `x-workspace-id` header comes from. The workspace store
 * (`store/workspaceStore.ts`, the one owner of this tab's active workspace)
 * registers itself here on load; the transport never imports app state. Until
 * then — and in tests that use the client alone — it is the boot hint.
 */
let activeWorkspaceId: () => string | null = getBootWorkspaceId;

export function setWorkspaceIdSource(source: () => string | null): void {
  activeWorkspaceId = source;
}

/** Injects the workspace header and handles `401`. */
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
