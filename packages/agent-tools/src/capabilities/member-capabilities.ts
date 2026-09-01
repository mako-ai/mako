/**
 * Transport-neutral workspace-membership capability metadata.
 *
 * One capability, and it is the most consequential one in the registry:
 * inviting someone widens who can reach the workspace, and therefore who
 * holds every other capability in it. Three properties follow from that and
 * are deliberate rather than incidental:
 *
 *   - `members-write` is never implicit. Every other external-MCP grant is
 *     either implied (artifact-write, schedule-write) or opted into by a
 *     scope; this one is opted into AND re-checked against the caller's live
 *     workspace role at execution, because a key outlives the membership
 *     that justified it.
 *   - external-MCP only. The in-product agent already acts as a signed-in
 *     user who can invite through the UI, where the invitation is visible and
 *     attributable. Putting it in the chat toolset would let a prompt-injected
 *     page ask an agent to add an account — the one action whose blast radius
 *     is "everything else, forever".
 *   - `risk: "write"`, not "destructive": an invitation is revocable and
 *     expires. The danger is escalation, not loss, and the grant is what
 *     addresses escalation.
 */
import {
  type AgentCapabilityDefinition,
  type AgentSurface,
} from "./types";

const EXTERNAL_MCP_ONLY = ["external-mcp"] as const satisfies readonly AgentSurface[];

export type MemberCapabilityPack = "members-admin";

export type MemberCapabilityDefinition = AgentCapabilityDefinition<
  "members",
  MemberCapabilityPack
>;

const define = (
  definition: Omit<MemberCapabilityDefinition, "domain">,
): MemberCapabilityDefinition => ({ domain: "members", ...definition });

export const MEMBER_CAPABILITIES = [
  define({
    name: "list_workspace_members",
    pack: "members-admin",
    risk: "read",
    // Reading the roster is gated with the same grant as writing it. The
    // roster is a list of people's email addresses, which is not the kind of
    // thing a data-analysis key should hand out just because it can query.
    requiredGrant: "members-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "invite_workspace_member",
    pack: "members-admin",
    risk: "write",
    requiredGrant: "members-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
] as const satisfies readonly MemberCapabilityDefinition[];
