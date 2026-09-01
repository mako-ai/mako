/**
 * Workspace membership tools for the MCP surface.
 *
 * Inviting someone is the only agent action whose blast radius is "every
 * other action, permanently" — an invited admin can invite more admins, read
 * every console, and reach every connection. So the authorization here is
 * deliberately not a single check:
 *
 *   1. The key must carry the `members:write` scope (grant `members-write`),
 *      which is never implicit and never a default.
 *   2. The key's OWNER must still be an owner/admin of this workspace, looked
 *      up live on every call. A key outlives the membership that justified
 *      it: someone who leaves the company has their membership removed, and
 *      their key must stop being able to invite at that moment, not whenever
 *      someone remembers to revoke it.
 *   3. The invited role may not exceed the inviter's own. An admin cannot
 *      mint an owner, so a compromised admin key cannot escalate past the
 *      level it already had.
 *
 * Rule 2 is the one that is easy to leave out, because the scope check
 * already feels like authorization. It is not: scopes say what the key was
 * for, membership says whether the person behind it still belongs here.
 */
import { tool } from "ai";
import { z } from "zod";

import { loggers } from "../../logging";
import { workspaceService } from "../../services/workspace.service";

const logger = loggers.api("member-tools");

/** Workspace roles, ordered least to most privileged. */
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;
type WorkspaceRole = keyof typeof ROLE_RANK;

/** Roles an invitation may confer. Ownership transfer is not an invite. */
const INVITABLE_ROLES = ["viewer", "member", "admin"] as const;
type InvitableRole = (typeof INVITABLE_ROLES)[number];

const ROLE_SUMMARY: Record<InvitableRole, string> = {
  viewer:
    "read-only: can see consoles, dashboards and apps, cannot run arbitrary SQL",
  member: "can create and manage resources, and run queries",
  admin: "can additionally manage workspace settings and members",
};

function rankOf(role: string | undefined): number | null {
  if (!role) return null;
  const rank = ROLE_RANK[role as WorkspaceRole];
  return rank === undefined ? null : rank;
}

export interface InviterAuthorization {
  ok: boolean;
  /** The inviter's live workspace role, when they have one. */
  role?: string;
  /** Caller-facing reason, safe to return as a tool result. */
  reason?: string;
}

/**
 * Resolve whether the acting user may invite, from their LIVE membership.
 *
 * Exported for tests: the interesting cases (no acting user, membership
 * revoked since the key was minted, role too low) are pure decisions that
 * should not need an MCP session to exercise.
 */
export async function authorizeInviter(
  workspaceId: string,
  userId: string | undefined,
): Promise<InviterAuthorization> {
  if (!userId) {
    return {
      ok: false,
      reason:
        "This credential has no acting user, so no workspace role can be resolved. Workspace invitations require a key created by an owner or admin.",
    };
  }
  const member = await workspaceService.getMember(workspaceId, userId);
  if (!member) {
    return {
      ok: false,
      reason:
        "The user who created this API key is no longer a member of this workspace, so it can no longer invite. Have a current owner or admin issue a new key.",
    };
  }
  const rank = rankOf(member.role);
  if (rank === null || rank < ROLE_RANK.admin) {
    return {
      ok: false,
      role: member.role,
      reason: `Inviting requires the owner or admin role; this key's owner is a ${member.role}.`,
    };
  }
  return { ok: true, role: member.role };
}

/**
 * An inviter may confer their own role or anything below it, never above —
 * and must be an owner/admin to confer anything at all.
 *
 * The admin floor is checked HERE as well as in {@link authorizeInviter},
 * deliberately. Either check alone is sufficient today, which is exactly why
 * one of them would eventually be dropped as redundant by someone reading
 * only the other. Both are cheap and both fail closed, so a future caller
 * that reaches this function without the first check still cannot let a
 * member invite anyone.
 */
export function inviteRoleAllowed(
  inviterRole: string | undefined,
  requestedRole: InvitableRole,
): boolean {
  const inviter = rankOf(inviterRole);
  const requested = rankOf(requestedRole);
  if (inviter === null || requested === null) return false;
  if (inviter < ROLE_RANK.admin) return false;
  return requested <= inviter;
}

export function createMemberTools(workspaceId: string, userId?: string) {
  return {
    list_workspace_members: tool({
      description:
        "List the workspace's members and outstanding invitations, with each one's role and status. Requires an API key with the 'members:write' scope whose owner is an owner or admin.",
      inputSchema: z.object({}),
      execute: async () => {
        const auth = await authorizeInviter(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };
        try {
          const [members, invites] = await Promise.all([
            workspaceService.getMembers(workspaceId),
            workspaceService.getPendingInvites(workspaceId),
          ]);
          return {
            members: members.map(m => ({
              userId: String(m.userId),
              role: m.role,
              status: "active" as const,
            })),
            pendingInvites: invites.map(i => ({
              email: i.email,
              role: i.role,
              expiresAt: i.expiresAt,
            })),
            yourRole: auth.role,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("list_workspace_members failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to list members: ${message}` };
        }
      },
    }),

    invite_workspace_member: tool({
      description: [
        "Invite someone to this workspace by email. Sends them an invitation email with a link that expires in 7 days.",
        "",
        "Roles:",
        ...INVITABLE_ROLES.map(role => `- ${role}: ${ROLE_SUMMARY[role]}`),
        "",
        "Requires an API key with the 'members:write' scope whose owner is still an owner or admin of the workspace. You cannot invite someone at a higher role than the key owner's own.",
        "Re-inviting an address that already has an outstanding invitation refreshes it rather than creating a second one; inviting an existing member is refused.",
      ].join("\n"),
      inputSchema: z.object({
        email: z.string().describe("Email address to invite."),
        role: z
          .enum(INVITABLE_ROLES)
          .describe(
            "Role to grant. Choose the least privilege that fits; 'viewer' is read-only.",
          ),
      }),
      execute: async ({
        email,
        role,
      }: {
        email: string;
        role: InvitableRole;
      }) => {
        const auth = await authorizeInviter(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };

        if (!inviteRoleAllowed(auth.role, role)) {
          return {
            error: `Cannot invite at the '${role}' role: this key's owner is a ${auth.role}, and an invitation may not exceed the inviter's own role.`,
          };
        }

        try {
          const invite = await workspaceService.createInvite(
            workspaceId,
            email,
            role,
            userId as string,
          );
          logger.info("Workspace invitation created over MCP", {
            workspaceId,
            invitedBy: userId,
            role,
          });
          return {
            invited: invite.email,
            role: invite.role,
            expiresAt: invite.expiresAt,
            message: `Invitation sent to ${invite.email} as ${invite.role}. It expires ${new Date(invite.expiresAt).toISOString().slice(0, 10)}.`,
          };
        } catch (error) {
          // createInvite refuses existing members and rejects malformed
          // addresses with messages meant to be read; pass them through
          // rather than flattening to "failed".
          const message =
            error instanceof Error ? error.message : "Unknown error";
          return { error: message };
        }
      },
    }),
  };
}
