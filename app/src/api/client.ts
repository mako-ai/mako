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
 *   - for a read, retries a `503` that carries `Retry-After` (see
 *     {@link retryUnavailableReads})
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

/** Retries of one read answered 503 + Retry-After. */
export const UNAVAILABLE_READ_RETRIES = 2;
/** Longest Retry-After honoured; a longer one is left to the caller. */
const MAX_RETRY_AFTER_SECONDS = 5;

/**
 * Wraps `fetch` so a GET answered `503` with `Retry-After` is asked again
 * after that many seconds, up to {@link UNAVAILABLE_READ_RETRIES} times.
 * The API sends that answer for brief, known states: Hatchet restarting,
 * a new instance cloning a workspace repo, a full per-instance pool. A view
 * then shows its data a few seconds late instead of an error. Writes are
 * never retried here.
 */
export function retryUnavailableReads(
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void> = ms =>
    new Promise(resolve => setTimeout(resolve, ms)),
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "GET") return fetchImpl(request);
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(request.clone());
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (
        response.status !== 503 ||
        attempt >= UNAVAILABLE_READ_RETRIES ||
        !Number.isFinite(retryAfter) ||
        retryAfter <= 0 ||
        retryAfter > MAX_RETRY_AFTER_SECONDS ||
        request.signal.aborted
      ) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryAfter * 1000);
    }
  };
}

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
    // Late-bound: tests stub globalThis.fetch after the singleton exists.
    fetch: retryUnavailableReads(
      fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    ),
  });
  client.use(authMiddleware);
  return client;
}

/** Singleton typed client for application/store code. */
export const api = createApiClient();
