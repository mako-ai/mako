import type { ToolSet } from "ai";
import {
  AGENT_CAPABILITY_BY_NAME,
  hasMinimumWorkspaceRole,
  type AgentSurface,
  type CapabilityGrant,
  type MinimumWorkspaceRole,
} from "@mako/agent-tools";

import type { QueryAccess } from "../../auth/api-key-scopes";

export interface AgentCapabilityAuthorizationContext {
  surface: AgentSurface;
  queryAccess: QueryAccess;
  grants: ReadonlySet<CapabilityGrant>;
  /**
   * The caller's live workspace role. Omit ONLY for surface-only listing
   * decisions (the in-product working set keeps role-gated schemas visible
   * and enforces the role at execution, like grants); every execution path
   * must pass it, and a missing membership (`null`) denies.
   */
  memberRole?: string | null;
}

/**
 * The workspace role a call is missing, or null when the capability has no
 * role floor or the role satisfies it. Shared by MCP listing (hide with a
 * reason), MCP execution and the in-product execution wrapper.
 */
export function missingWorkspaceRole(
  name: string,
  role: string | undefined | null,
): { required: MinimumWorkspaceRole } | null {
  const minimum = AGENT_CAPABILITY_BY_NAME.get(name)?.minimumWorkspaceRole;
  if (!minimum) return null;
  return hasMinimumWorkspaceRole(role, minimum) ? null : { required: minimum };
}

export function workspaceRoleDenial(
  name: string,
  required: MinimumWorkspaceRole,
  role: string | undefined | null,
): string {
  return (
    `${name} requires at least the ${required} workspace role` +
    (role ? ` (you are a ${role})` : " (no workspace membership)")
  );
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
  if (context.memberRole !== undefined) {
    const missingRole = missingWorkspaceRole(name, context.memberRole);
    if (missingRole) {
      return {
        allowed: false,
        reason: workspaceRoleDenial(
          name,
          missingRole.required,
          context.memberRole,
        ),
      };
    }
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
 * Grant a call's input requires but the session does not hold, or null when
 * the call is fine. Input-conditional grants let a broader tool carry a
 * gated leg (app_update_data_binding's materializationSchedule keeps
 * app_set_binding_schedule's schedule-write gate) without gating the whole
 * tool. Shared by the execution wrapper below and the MCP call path.
 */
export function missingInputConditionalGrant(
  name: string,
  input: unknown,
  grants: ReadonlySet<CapabilityGrant>,
): { grant: CapabilityGrant; behavior: string } | null {
  const conditional =
    AGENT_CAPABILITY_BY_NAME.get(name)?.inputConditionalGrants;
  if (!conditional) return null;
  for (const entry of conditional) {
    if (!grants.has(entry.grant) && entry.appliesTo(input)) return entry;
  }
  return null;
}

/**
 * Wrap grant-gated tools so the grant is enforced when the tool EXECUTES,
 * not by hiding the tool from the provider.
 *
 * Grant-gated tools must keep their schemas in the provider working set:
 * removing them desyncs the system-prompt tool inventory ("active, schemas
 * provided") from the tools actually sent to the provider, and models then
 * map the intended call onto a similarly named tool that IS available
 * (observed historically with similarly-named dbt tools). Failing the call
 * with an actionable message
 * keeps the schema visible and gives the model a recovery path: submit a
 * plan requesting the missing grant.
 *
 * `liveGrants` is read per call, so a plan approved earlier in the derived
 * mode state is honored without rebuilding the tool set.
 *
 * `liveRole` resolves the caller's current workspace role for capabilities
 * with a `minimumWorkspaceRole` (dbt project/job administration, model
 * authoring). Resolved lazily and only for those tools, so an unprivileged
 * caller is refused by the same registry rule the REST routes and MCP apply
 * — a viewer asking chat to "create a dbt project" no longer succeeds where
 * POST /dbt/projects would 403.
 */
export function enforceCapabilityGrantsAtExecution(
  tools: ToolSet,
  liveGrants: () => ReadonlySet<CapabilityGrant>,
  liveRole?: () => Promise<string | undefined | null>,
): ToolSet {
  const wrapped: ToolSet = { ...tools };
  for (const [name, toolDef] of Object.entries(tools)) {
    const capability = AGENT_CAPABILITY_BY_NAME.get(name);
    const requiredGrant = capability?.requiredGrant;
    const hasConditional =
      (capability?.inputConditionalGrants?.length ?? 0) > 0;
    const roleResolver = capability?.minimumWorkspaceRole
      ? liveRole
      : undefined;
    const execute = toolDef.execute;
    if (
      (!requiredGrant && !hasConditional && !roleResolver) ||
      typeof execute !== "function"
    ) {
      continue;
    }
    wrapped[name] = {
      ...toolDef,
      execute: async (input: never, options: never) => {
        if (roleResolver) {
          const role = await roleResolver();
          const missingRole = missingWorkspaceRole(name, role);
          if (missingRole) {
            return {
              success: false,
              error: workspaceRoleDenial(name, missingRole.required, role),
            };
          }
        }
        if (requiredGrant && !liveGrants().has(requiredGrant)) {
          return {
            success: false,
            error:
              `${name} requires an approved "${requiredGrant}" task grant. ` +
              "Call submit_plan with requiredCapabilities including " +
              `"${requiredGrant}", wait for the user to approve the plan, ` +
              "then retry.",
          };
        }
        const missing = missingInputConditionalGrant(name, input, liveGrants());
        if (missing) {
          return {
            success: false,
            error:
              `${missing.behavior} requires an approved "${missing.grant}" ` +
              "task grant. Call submit_plan with requiredCapabilities " +
              `including "${missing.grant}", wait for the user to approve ` +
              "the plan, then retry — or retry without that field.",
          };
        }
        return execute(input, options);
      },
    } as typeof toolDef;
  }
  return wrapped;
}
