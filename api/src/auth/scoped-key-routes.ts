/**
 * Where a SCOPED workspace API key may go besides `/api/mcp`.
 *
 * Scoped keys (`mcp`, `query:read`, …) are MCP-only by construction so a
 * key handed to an agent can never be replayed against REST mutation routes
 * (AUTH_README, "MCP credentials are MCP-only"). A laptop checkout needs one
 * exception: `@makoai/app-sdk/vite` streams an app's materialized binding
 * parquet during a local `vite dev`, and parquet does not travel well inside
 * a JSON-RPC tool result. So a key carrying `query:read` may additionally
 * call the binding READ routes below — each executes the binding's query
 * read-only (or not at all), exactly what `query:read` already grants over
 * MCP. Nothing else is opened; the list is the policy.
 */
import {
  hasWorkspaceApiKeyScope,
  type WorkspaceApiKeyScope,
} from "./api-key-scopes";

const BINDING_ROUTES: ReadonlyArray<{
  method: string;
  pattern: RegExp;
  scope: WorkspaceApiKeyScope;
}> = [
  {
    method: "GET",
    pattern: /^\/api\/workspaces\/[^/]+\/apps\/[^/]+\/bindings\/?$/,
    scope: "query:read",
  },
  {
    method: "GET",
    pattern:
      /^\/api\/workspaces\/[^/]+\/apps\/[^/]+\/bindings\/[^/]+\/artifact\/?$/,
    scope: "query:read",
  },
  {
    method: "POST",
    pattern:
      /^\/api\/workspaces\/[^/]+\/apps\/[^/]+\/bindings\/[^/]+\/materialize\/?$/,
    scope: "query:read",
  },
];

export function isMcpEndpoint(path: string): boolean {
  return /^\/api\/mcp\/?$/.test(path);
}

/**
 * True when a scoped key with `scopes` may call `method path`. `/api/mcp`
 * is always allowed (the scope check for it lives in the MCP route itself).
 */
export function scopedKeyMayAccess(
  method: string,
  path: string,
  scopes: readonly WorkspaceApiKeyScope[],
): boolean {
  if (isMcpEndpoint(path)) return true;
  const verb = method.toUpperCase();
  return BINDING_ROUTES.some(
    route =>
      route.method === verb &&
      route.pattern.test(path) &&
      hasWorkspaceApiKeyScope(scopes, route.scope),
  );
}
