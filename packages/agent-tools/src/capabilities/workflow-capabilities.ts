/**
 * Workflow tools. Looking is read-only; starting a run executes the
 * workspace's own code, so it needs the member role and the `workflows-run`
 * grant (the `workflows:run` scope on an API key). Activating a workflow or
 * giving it a webhook changes what starts it, which is an admin's call, like
 * changing its code.
 */
import { ALL_AGENT_SURFACES, type AgentCapabilityDefinition } from "./types";

export type WorkflowCapabilityDefinition = AgentCapabilityDefinition<
  "workflow",
  "workflows"
>;

const define = (
  definition: Omit<WorkflowCapabilityDefinition, "domain" | "pack">,
): WorkflowCapabilityDefinition => ({
  domain: "workflow",
  pack: "workflows",
  ...definition,
});

export const WORKFLOW_CAPABILITIES: readonly WorkflowCapabilityDefinition[] = [
  define({
    name: "workflows_status",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "workflows_run",
    risk: "write",
    minimumWorkspaceRole: "member",
    requiredGrant: "workflows-run",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
  }),
  define({
    name: "workflows_triggers",
    risk: "write",
    minimumWorkspaceRole: "admin",
    requiredGrant: "workflows-run",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "ui-effect",
  }),
];
