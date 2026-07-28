import {
  AGENT_CAPABILITY_BY_NAME,
  type AgentSurface,
  type CapabilityGrant,
} from "@mako/agent-tools";

import type { QueryAccess } from "../../auth/api-key-scopes";

export interface AgentCapabilityAuthorizationContext {
  surface: AgentSurface;
  queryAccess: QueryAccess;
  grants: ReadonlySet<CapabilityGrant>;
}

export interface AgentCapabilityDecision {
  allowed: boolean;
  reason?: string;
}

export function authorizeAgentCapability(
  name: string,
  context: AgentCapabilityAuthorizationContext,
): AgentCapabilityDecision {
  const capability = AGENT_CAPABILITY_BY_NAME.get(name);
  // The shared registry is being introduced domain-by-domain. Unregistered
  // tools continue through their existing policy until migrated.
  if (!capability) return { allowed: true };

  if (!capability.surfaces.includes(context.surface)) {
    return {
      allowed: false,
      reason: `${name} is not available on the ${context.surface} surface`,
    };
  }
  if (capability.requiresAsyncMcp && context.surface !== "in-chat") {
    return {
      allowed: false,
      reason: `${name} must use the async run lifecycle before MCP exposure`,
    };
  }
  if (capability.requiresQueryAccess && context.queryAccess === "none") {
    return {
      allowed: false,
      reason: `${name} requires query access`,
    };
  }
  if (
    capability.requiredGrant &&
    !context.grants.has(capability.requiredGrant)
  ) {
    return {
      allowed: false,
      reason: `${name} requires an approved ${capability.requiredGrant} task grant`,
    };
  }
  return { allowed: true };
}

export function filterAuthorizedCapabilities<T>(
  tools: Record<string, T>,
  context: AgentCapabilityAuthorizationContext,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) => authorizeAgentCapability(name, context).allowed,
    ),
  );
}
