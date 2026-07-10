export const WORKSPACE_API_KEY_SCOPES = [
  "mcp",
  "query:read",
  "query:write",
] as const;

export type WorkspaceApiKeyScope = (typeof WORKSPACE_API_KEY_SCOPES)[number];

/** Safe defaults for newly-created MCP keys. */
export const DEFAULT_WORKSPACE_API_KEY_SCOPES: WorkspaceApiKeyScope[] = [
  "mcp",
  "query:read",
];

const WORKSPACE_API_KEY_SCOPE_SET = new Set<string>(WORKSPACE_API_KEY_SCOPES);

export function parseWorkspaceApiKeyScopes(
  value: unknown,
): WorkspaceApiKeyScope[] {
  if (value === undefined) {
    return [...DEFAULT_WORKSPACE_API_KEY_SCOPES];
  }
  if (!Array.isArray(value)) {
    throw new Error("API key scopes must be an array");
  }

  const scopes = value.map(scope => {
    if (typeof scope !== "string" || !WORKSPACE_API_KEY_SCOPE_SET.has(scope)) {
      throw new Error(`Unsupported API key scope: ${String(scope)}`);
    }
    return scope as WorkspaceApiKeyScope;
  });

  return [...new Set(scopes)];
}

export function resolveWorkspaceApiKeyScopes(
  value: unknown,
): WorkspaceApiKeyScope[] {
  // Legacy unscoped keys keep their existing REST behavior but must be rotated
  // before they can access MCP. Otherwise "read-only MCP" could be bypassed by
  // sending the same broad credential to an older REST mutation endpoint.
  if (value === undefined) return [];
  try {
    return parseWorkspaceApiKeyScopes(value);
  } catch {
    return [];
  }
}

export function hasWorkspaceApiKeyScope(
  scopes: readonly WorkspaceApiKeyScope[],
  scope: WorkspaceApiKeyScope,
): boolean {
  if (scope === "query:read") {
    return scopes.includes("query:read") || scopes.includes("query:write");
  }
  return scopes.includes(scope);
}

export type QueryAccess = "none" | "read" | "write";

export function queryAccessFromScopes(
  scopes: readonly WorkspaceApiKeyScope[],
): QueryAccess {
  if (hasWorkspaceApiKeyScope(scopes, "query:write")) return "write";
  if (hasWorkspaceApiKeyScope(scopes, "query:read")) return "read";
  return "none";
}

/** Legacy unscoped keys retain their pre-existing REST query capability. */
export function restQueryAccessFromStoredScopes(value: unknown): QueryAccess {
  if (value === undefined) return "write";
  return queryAccessFromScopes(resolveWorkspaceApiKeyScopes(value));
}
