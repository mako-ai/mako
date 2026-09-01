import type { CapabilityGrant } from "@mako/agent-tools";

/**
 * Mako MCP is read-only against workspace *data* by design: apps are
 * read-only data products, so there is deliberately no `query:write` scope.
 * Anyone who needs raw database writes should use their own database tooling.
 *
 * `warehouse:write` is narrower than a query-write scope would be: it does
 * not unlock arbitrary DML — it maps to the `warehouse-write` capability
 * grant, whose only external-MCP tools are governed dbt executions
 * (dbt_run_model / dbt_run_job / dbt_cancel_run). `git:write` maps to the
 * `git-write` grant behind the dbt Git mutations (commit, branch, PR).
 *
 * `query:write` is double-gated: the scope alone only yields
 * "write-opt-in" access, which stays read-only against every connection
 * except those a workspace admin explicitly marked `allowAgentWrites` —
 * so raw DML/DDL requires BOTH a deliberately-scoped key AND a
 * deliberately-flagged connection.
 *
 * `members:write` maps to the `members-write` grant behind workspace
 * invitations. It is the one scope that can widen who holds every other
 * scope, so it is gated twice over: the key must carry it AND the key's
 * owner must still be an owner/admin of the workspace at call time, checked
 * on each execution rather than trusted from the key. A key cannot invite
 * above its owner's own role either — see invite_workspace_member.
 *
 * None of the write scopes are granted by default; workspace admins opt a
 * key in explicitly.
 */
export const WORKSPACE_API_KEY_SCOPES = [
  "mcp",
  "query:read",
  "query:write",
  "warehouse:write",
  "git:write",
  "members:write",
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
 * unscoped REST keys); no grantable scope maps to it. "write-opt-in" is the
 * most a scoped key can get (via query:write): read-only everywhere except
 * connections explicitly marked allowAgentWrites, resolved at execution
 * time by the SQL tool layer. Consumers that have not adopted per-connection
 * resolution MUST treat "write-opt-in" exactly like "read" — fail closed.
 */
export type QueryAccess = "none" | "read" | "write-opt-in" | "write";

export function queryAccessFromScopes(
  scopes: readonly WorkspaceApiKeyScope[],
): QueryAccess {
  if (hasWorkspaceApiKeyScope(scopes, "query:write")) return "write-opt-in";
  if (hasWorkspaceApiKeyScope(scopes, "query:read")) return "read";
  return "none";
}

/** Legacy unscoped keys retain their pre-existing REST query capability. */
export function restQueryAccessFromStoredScopes(value: unknown): QueryAccess {
  if (value === undefined) return "write";
  const access = queryAccessFromScopes(resolveWorkspaceApiKeyScopes(value));
  // REST query endpoints have not adopted per-connection allowAgentWrites
  // resolution; until they do, a query:write key is read-only there.
  return access === "write-opt-in" ? "read" : access;
}

/**
 * Capability grants an external MCP credential opts into via scopes.
 * Grants that no scope maps to (artifact-write, schedule-write) are the
 * implicit headless-authoring authority external MCP has always had; the
 * MCP server unions those in itself (see externalMcpCapabilityGrants).
 */
export function capabilityGrantsFromScopes(
  scopes: readonly WorkspaceApiKeyScope[],
): CapabilityGrant[] {
  const grants: CapabilityGrant[] = [];
  if (hasWorkspaceApiKeyScope(scopes, "warehouse:write")) {
    grants.push("warehouse-write");
  }
  if (hasWorkspaceApiKeyScope(scopes, "git:write")) {
    grants.push("git-write");
  }
  if (hasWorkspaceApiKeyScope(scopes, "members:write")) {
    grants.push("members-write");
  }
  return grants;
}
