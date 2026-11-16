/**
 * The workspace shell (api sandbox-tools.ts): the caller's own sandbox at
 * the root of the workspace repo. Every tool needs the member role, as a
 * write to an app or a workflow does. Changing the box (a command, a file
 * write) runs code with the caller's rights in the same box a sandbox
 * workflow run uses, so it needs the grant that run needs: `workflows-run`
 * (the `workflows:run` scope, carried by every OAuth sign-in; a plain API
 * key has it only when minted with it).
 */
import { ALL_AGENT_SURFACES, type AgentCapabilityDefinition } from "./types";

export type SandboxCapabilityDefinition = AgentCapabilityDefinition<
  "sandbox",
  "sandbox"
>;

const define = (
  definition: Omit<SandboxCapabilityDefinition, "domain" | "pack">,
): SandboxCapabilityDefinition => ({
  domain: "sandbox",
  pack: "sandbox",
  ...definition,
});

export const SANDBOX_CAPABILITIES: readonly SandboxCapabilityDefinition[] = [
  define({
    name: "sandbox_status",
    risk: "read",
    minimumWorkspaceRole: "member",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "sandbox_read_file",
    risk: "read",
    minimumWorkspaceRole: "member",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    // Any shell command: it can delete files in the checkout, so MCP
    // clients are told it is destructive and ask before each call.
    name: "sandbox_bash",
    risk: "destructive",
    minimumWorkspaceRole: "member",
    requiredGrant: "workflows-run",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "sandbox_write_file",
    risk: "write",
    minimumWorkspaceRole: "member",
    requiredGrant: "workflows-run",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
];
