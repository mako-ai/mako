/**
 * Mako MCP is read-only against workspace data by design: apps are read-only
 * data products, so there is deliberately no `query:write` scope. Anyone who
 * needs database writes should use their own database tooling.
 */
export const WORKSPACE_API_KEY_SCOPES = ["mcp", "query:read"] as const;

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
  if (!Array.isArray(value)) return [];
  // Unknown stored scopes (e.g. a since-removed scope) are dropped rather
  // than failing the whole key closed.
  return [
    ...new Set(
      value.filter(
        (scope): scope is WorkspaceApiKeyScope =>
          typeof scope === "string" && WORKSPACE_API_KEY_SCOPE_SET.has(scope),
      ),
    ),
  ];
}

export function hasWorkspaceApiKeyScope(
  scopes: readonly WorkspaceApiKeyScope[],
  scope: WorkspaceApiKeyScope,
): boolean {
  return scopes.includes(scope);
}

/**
 * "write" only exists for internal callers (the in-product agent and legacy
 * unscoped REST keys); no grantable scope maps to it.
 */
export type QueryAccess = "none" | "read" | "write";

export function queryAccessFromScopes(
  scopes: readonly WorkspaceApiKeyScope[],
): QueryAccess {
  if (hasWorkspaceApiKeyScope(scopes, "query:read")) return "read";
  return "none";
}

/** Legacy unscoped keys retain their pre-existing REST query capability. */
export function restQueryAccessFromStoredScopes(value: unknown): QueryAccess {
  if (value === undefined) return "write";
  return queryAccessFromScopes(resolveWorkspaceApiKeyScopes(value));
}
