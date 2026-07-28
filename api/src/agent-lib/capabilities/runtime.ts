import type { ToolSet } from "ai";
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

/**
 * Wrap grant-gated tools so the grant is enforced when the tool EXECUTES,
 * not by hiding the tool from the provider.
 *
 * Grant-gated tools must keep their schemas in the provider working set:
 * removing them desyncs the system-prompt tool inventory ("active, schemas
 * provided") from the tools actually sent to the provider, and models then
 * map the intended call onto a similarly named tool that IS available
 * (observed: dbt_run_model / dbt_run_job / dbt_commit_and_push calls landing
 * on dbt_list_pull_requests). Failing the call with an actionable message
 * keeps the schema visible and gives the model a recovery path: submit a
 * plan requesting the missing grant.
 *
 * `liveGrants` is read per call, so a plan approved earlier in the derived
 * mode state is honored without rebuilding the tool set.
 */
export function enforceCapabilityGrantsAtExecution(
  tools: ToolSet,
  liveGrants: () => ReadonlySet<CapabilityGrant>,
): ToolSet {
  const wrapped: ToolSet = { ...tools };
  for (const [name, toolDef] of Object.entries(tools)) {
    const requiredGrant = AGENT_CAPABILITY_BY_NAME.get(name)?.requiredGrant;
    const execute = toolDef.execute;
    if (!requiredGrant || typeof execute !== "function") continue;
    wrapped[name] = {
      ...toolDef,
      execute: (input: never, options: never) => {
        if (!liveGrants().has(requiredGrant)) {
          return {
            success: false,
            error:
              `${name} requires an approved "${requiredGrant}" task grant. ` +
              "Call submit_plan with requiredCapabilities including " +
              `"${requiredGrant}", wait for the user to approve the plan, ` +
              "then retry.",
          };
        }
        return execute(input, options);
      },
    } as typeof toolDef;
  }
  return wrapped;
}
