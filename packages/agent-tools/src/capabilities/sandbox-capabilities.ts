/**
 * The workspace shell (api sandbox-tools.ts): the caller's own sandbox at
 * the root of the workspace repo. Every tool needs the member role, as a
 * write to an app or a workflow does. Changing the box (a command, a file
 * write) needs BOTH grants:
 * - `git-write` (the `git:write` scope): the box holds a git token, so a
 *   command can commit and push. Listing hides the tools without it.
 * - `workflows-run` (the `workflows:run` scope): a command runs code with
 *   the caller's rights in the box a sandbox workflow run uses.
 * In the in-app chat both also ask the user before each call (the tools'
 * `needsApproval`); over MCP the client's own tool approval does.
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

/** The second grant the shell needs, on every call. */
const ALWAYS_WORKFLOWS_RUN = {
  grant: "workflows-run",
  behavior: "running code in your sandbox",
  appliesTo: () => true,
} as const;

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
    requiredGrant: "git-write",
    inputConditionalGrants: [ALWAYS_WORKFLOWS_RUN],
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    // Replaces a file in the checkout: destructive like the shell, so MCP
    // clients ask before each call, as its description says.
    name: "sandbox_write_file",
    risk: "destructive",
    minimumWorkspaceRole: "member",
    requiredGrant: "git-write",
    inputConditionalGrants: [ALWAYS_WORKFLOWS_RUN],
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
];
