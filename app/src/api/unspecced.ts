/**
 * Calls to API routes the OpenAPI spec does not describe yet.
 *
 * Some backend routes are plain Hono handlers (not `createRoute`), so they are
 * absent from `schema.d.ts` and the typed `api` client rejects their paths at
 * compile time. This module is the one sanctioned way to reach them: it goes
 * through the SAME openapi-fetch client instance as `api` — the same
 * `credentials: "include"`, `x-workspace-id` injection and `401` → verified
 * `/login` redirect — and throws the same `ApiError` as `unwrapBody`. Only the
 * path, body and response types are unchecked (callers name the response
 * type they expect).
 *
 * Paths are full paths, like the spec's (`/api/workspaces/<id>/dbt/...`).
 * When a route gains a `createRoute` definition, move its callers to `api`.
 */
import type { Client } from "openapi-fetch";

import { api } from "./client";
import { unwrapBody, type ApiResult } from "./result";

type Query = Record<string, string | number | boolean | undefined>;

interface UnspeccedOperation {
  parameters: { query?: Query };
  requestBody?: { content: { "application/json": unknown } };
  responses: {
    200: { content: { "application/json": unknown } };
    default: { content: { "application/json": unknown } };
  };
}

type UnspeccedPaths = Record<
  `/api/${string}`,
  {
    get: UnspeccedOperation;
    put: UnspeccedOperation;
    post: UnspeccedOperation;
    delete: UnspeccedOperation;
    patch: UnspeccedOperation;
  }
>;

export type UnspeccedMethod = "GET" | "PUT" | "POST" | "DELETE" | "PATCH";
export type UnspeccedPath = `/api/${string}`;

const client = api as unknown as Client<UnspeccedPaths>;

export interface UnspeccedRequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

function send(
  method: UnspeccedMethod,
  path: UnspeccedPath,
  { query, body, signal }: UnspeccedRequestOptions = {},
): Promise<ApiResult> {
  return client.request(
    method.toLowerCase() as Lowercase<UnspeccedMethod>,
    path,
    {
      ...(query ? { params: { query } } : {}),
      // openapi-fetch only sets `Content-Type: application/json` when a body is
      // present, so a body-less POST never trips the server's JSON validator.
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    },
  );
}

async function call<T>(
  method: UnspeccedMethod,
  path: UnspeccedPath,
  options?: UnspeccedRequestOptions,
): Promise<T> {
  // An empty 2xx body resolves to `{}`, as the old client did.
  return (unwrapBody(await send(method, path, options)) ?? {}) as T;
}

export const unspecced = {
  /** The raw `{ data, error, response }` result, for callers that branch on
   * the status themselves (see `bodyWithStatus`). Never throws on HTTP error. */
  request: send,
  get: <T>(path: UnspeccedPath, query?: Query, signal?: AbortSignal) =>
    call<T>("GET", path, { query, signal }),
  post: <T>(path: UnspeccedPath, body?: unknown, signal?: AbortSignal) =>
    call<T>("POST", path, { body, signal }),
  put: <T>(path: UnspeccedPath, body?: unknown, signal?: AbortSignal) =>
    call<T>("PUT", path, { body, signal }),
  patch: <T>(path: UnspeccedPath, body?: unknown, signal?: AbortSignal) =>
    call<T>("PATCH", path, { body, signal }),
  delete: <T>(path: UnspeccedPath, signal?: AbortSignal) =>
    call<T>("DELETE", path, { signal }),
};
