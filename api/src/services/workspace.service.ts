import { randomUUID } from "crypto";
import { revokeMcpGrantsForMember } from "../auth/mcp-oauth.service";
import { loggers } from "../logging";
import { authRepo } from "../repositories/auth";
import {
  WorkspaceSlugConflictError,
  workspaceRepo,
  type UpdateWorkspacePatch,
  type WorkspaceAutoJoin,
  type WorkspaceInviteRecord,
  type WorkspaceInviteWithRefs,
  type WorkspaceMemberRecord,
  type WorkspaceMemberRole,
  type WorkspaceMemberWithUser,
  type WorkspaceRecord,
} from "../repositories/workspaces";
import {
  normalizeEmail,
  validateAndNormalizeEmail,
} from "../utils/email.utils";
import { emailService } from "./email.service";

const logger = loggers.workspace();

export class WorkspaceService {
  /**
   * Create a new workspace
   */
  async createWorkspace(
    userId: string,
    name: string,
    slug?: string,
  ): Promise<WorkspaceRecord> {
    if (!slug) {
      slug = this.generateSlug(name);
    }

    let uniqueSlug = slug;
    let counter = 1;
    while (await workspaceRepo.findBySlug(uniqueSlug)) {
      uniqueSlug = `${slug}-${counter}`;
      counter++;
    }

    const { workspace } = await workspaceRepo.createWorkspaceWithOwner({
      name,
      slug: uniqueSlug,
      userId,
      settings: {
        maxDatabases: 5,
        maxMembers: 10,
        billingTier: "free",
      },
    });

    await authRepo.setActiveWorkspaceForUser(userId, workspace.id);
    return workspace;
  }

  /**
   * Get all workspaces for a user
   */
  async getWorkspacesForUser(userId: string): Promise<
    Array<{
      workspace: WorkspaceRecord;
      role: WorkspaceMemberRole;
    }>
  > {
    return workspaceRepo.findWorkspacesForUser(userId);
  }

  /**
   * Get a workspace by ID
   */
  async getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null> {
    return workspaceRepo.findById(workspaceId);
  }

  /**
   * Get workspace member
   */
  async getMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null> {
    return workspaceRepo.findMember(workspaceId, userId);
  }

  /**
   * The user ids of the workspace's owners
   */
  async getOwnerIds(workspaceId: string): Promise<string[]> {
    const owners = await workspaceRepo.listMembers(workspaceId, ["owner"]);
    return owners.map(o => o.userId);
  }

  /**
   * Whether the user is an owner or admin of the workspace
   */
  async isAdmin(workspaceId: string, userId: string): Promise<boolean> {
    const member = await this.getMember(workspaceId, userId);
    return member?.role === "owner" || member?.role === "admin";
  }

  /**
   * Check if user has access to workspace
   */
  async hasAccess(workspaceId: string, userId: string): Promise<boolean> {
    const member = await this.getMember(workspaceId, userId);
    return member !== null;
  }

  /**
   * Check if user has specific role in workspace
   */
  async hasRole(
    workspaceId: string,
    userId: string,
    roles: string[],
  ): Promise<boolean> {
    const member = await this.getMember(workspaceId, userId);
    return member !== null && roles.includes(member.role);
  }

  /**
   * Update workspace
   */
  async updateWorkspace(
    workspaceId: string,
    updates: UpdateWorkspacePatch,
  ): Promise<WorkspaceRecord | null> {
    return workspaceRepo.updateWorkspace(workspaceId, updates);
  }

  /** Domain auto-join settings; null turns it off. */
  async setAutoJoin(
    workspaceId: string,
    autoJoin: WorkspaceAutoJoin | null,
  ): Promise<void> {
    await workspaceRepo.setAutoJoin(workspaceId, autoJoin);
  }

  /**
   * Delete workspace
   */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    await workspaceRepo.deleteWorkspaceCascade(workspaceId);
    return true;
  }

  /**
   * Get workspace members
   */
  async getMembers(workspaceId: string): Promise<WorkspaceMemberWithUser[]> {
    return workspaceRepo.listMembersWithUsers(workspaceId);
  }

  /**
   * Add member to workspace
   */
  async addMember(
    workspaceId: string,
    userId: string,
    role: "admin" | "member" | "viewer",
  ): Promise<WorkspaceMemberWithUser> {
    return workspaceRepo.addMember({
      workspaceId,
      userId,
      role,
      joinedAt: new Date(),
    });
  }

  /**
   * Update member role
   */
  async updateMemberRole(
    workspaceId: string,
    userId: string,
    newRole: string,
  ): Promise<WorkspaceMemberWithUser | null> {
    return workspaceRepo.updateMemberRole(
      workspaceId,
      userId,
      newRole as WorkspaceMemberRole,
    );
  }

  /**
   * Remove member from workspace
   */
  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const removed = await workspaceRepo.removeMember(workspaceId, userId);
    // Credentials the user minted for THIS workspace outlive the membership
    // otherwise: an MCP OAuth grant keeps refreshing access tokens bound to
    // the workspace, and a workspace API key keeps acting as its creator.
    // Revoke both (idempotent, so it also cleans up after a partial removal).
    const [mcpGrants, apiKeysRevoked] = await Promise.all([
      revokeMcpGrantsForMember({ workspaceId, userId }),
      workspaceRepo.deleteApiKeysByCreator(workspaceId, userId),
    ]);
    if (mcpGrants > 0 || apiKeysRevoked > 0) {
      logger.info("Revoked removed member's workspace credentials", {
        workspaceId,
        userId,
        mcpGrants,
        apiKeysRevoked: apiKeysRevoked > 0,
      });
    }
    return removed;
  }

  /**
   * Create workspace invite
   */
  async createInvite(
    workspaceId: string,
    email: string,
    role: "admin" | "member" | "viewer",
    invitedBy: string,
  ): Promise<WorkspaceInviteRecord> {
    const normalizedEmail = validateAndNormalizeEmail(email);

    // The settings UI renders members and pending invites as one list, so an
    // invite for someone who is already a member shows the person twice.
    const existingUser = await authRepo.findUserByEmail(normalizedEmail);
    if (existingUser) {
      const existingMember = await workspaceRepo.findMember(
        workspaceId,
        existingUser.id,
      );
      if (existingMember) {
        throw new Error(
          `${normalizedEmail} is already a member of this workspace`,
        );
      }
    }

    // Re-inviting the same email refreshes the outstanding invite (new
    // expiry, email re-sent) instead of stacking a second row.
    const existingInvite =
      await workspaceRepo.findPendingInviteByWorkspaceAndEmail(
        workspaceId,
        normalizedEmail,
      );
    if (existingInvite) {
      const refreshed =
        (await workspaceRepo.refreshInvite(existingInvite.id, {
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          invitedBy,
        })) ?? existingInvite;
      await this.sendInviteEmail(workspaceId, invitedBy, refreshed);
      return refreshed;
    }

    const invite = await workspaceRepo.createInvite({
      workspaceId,
      email: normalizedEmail,
      token: randomUUID().replace(/-/g, ""),
      role,
      invitedBy,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    await this.sendInviteEmail(workspaceId, invitedBy, invite);

    return invite;
  }

  /**
   * Send (or re-send) the invitation email. Failure is logged, never thrown —
   * the invite row is already saved and the token link still works.
   */
  private async sendInviteEmail(
    workspaceId: string,
    invitedBy: string,
    invite: WorkspaceInviteRecord,
  ): Promise<void> {
    let workspaceName = "Unknown Workspace";
    try {
      const [workspace, inviter] = await Promise.all([
        workspaceRepo.findById(workspaceId),
        authRepo.findUserById(invitedBy),
      ]);

      workspaceName = workspace?.name || "Unknown Workspace";
      const inviterName = inviter?.email || "Someone";
      const inviteUrl = `${process.env.CLIENT_URL}/invite/${invite.token}`;

      await emailService.sendInvitationEmail(
        invite.email,
        workspaceName,
        inviterName,
        inviteUrl,
      );
    } catch (error) {
      logger.error("Failed to send invitation email", {
        email: invite.email,
        workspaceName,
        error,
      });
      // Don't fail the invite creation if email fails
    }
  }

  /**
   * Get invite by token
   */
  async getInviteByToken(
    token: string,
  ): Promise<WorkspaceInviteWithRefs | null> {
    return workspaceRepo.findPendingInviteByToken(token);
  }

  /**
   * Accept invite
   */
  async acceptInvite(token: string, userId: string): Promise<WorkspaceRecord> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { workspace } = await workspaceRepo.acceptInviteTransaction(
          token,
          userId,
        );
        return workspace;
      } catch (error: unknown) {
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        // Retry on Mongo write conflicts (112) or PG serialization failures (40001)
        if ((code === 112 || code === "40001") && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Failed to accept invite after multiple attempts");
  }

  /**
   * Get pending invites for workspace
   */
  async getPendingInvites(
    workspaceId: string,
  ): Promise<WorkspaceInviteWithRefs[]> {
    const [invites, members] = await Promise.all([
      workspaceRepo.listPendingInvitesForWorkspace(workspaceId),
      this.getMembers(workspaceId),
    ]);

    // Hide invites whose email already belongs to a member: pre-existing
    // duplicate rows (created before createInvite refused them) would
    // otherwise show the person twice in the settings list.
    const memberEmails = new Set(
      members
        .map(m => m.user?.email)
        .filter((e): e is string => typeof e === "string" && e.length > 0)
        .map(e => e.toLowerCase()),
    );
    return invites.filter(i => !memberEmails.has(i.email.toLowerCase()));
  }

  /**
   * Get pending invites for a specific email address
   */
  async getPendingInvitesForEmail(
    email: string,
  ): Promise<WorkspaceInviteWithRefs[]> {
    return workspaceRepo.listPendingInvitesForEmail(normalizeEmail(email));
  }

  /**
   * Cancel invite (scoped to the workspace)
   */
  async cancelInvite(workspaceId: string, inviteId: string): Promise<boolean> {
    return workspaceRepo.cancelInvite(workspaceId, inviteId);
  }

  /**
   * Switch active workspace
   */
  async switchWorkspace(userId: string, workspaceId: string): Promise<boolean> {
    const hasAccess = await this.hasAccess(workspaceId, userId);
    if (!hasAccess) {
      throw new Error("Access denied to workspace");
    }

    await authRepo.setActiveWorkspaceForUser(userId, workspaceId);
    return true;
  }

  /**
   * Get or create default workspace for a user.
   * Uses a unique partial index on `workspace_members.is_default_membership` to
   * prevent duplicate workspace creation from concurrent requests (e.g.,
   * double-clicking email verification link, OAuth callback retries).
   */
  async getOrCreateDefaultWorkspace(
    userId: string,
    defaultName: string,
  ): Promise<{ workspace: WorkspaceRecord; created: boolean }> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const baseSlug = this.generateSlug(defaultName);
        let uniqueSlug = baseSlug;
        let counter = 1;
        while (await workspaceRepo.findBySlug(uniqueSlug)) {
          const randomSuffix = Math.random().toString(36).substring(2, 6);
          uniqueSlug = `${baseSlug}-${randomSuffix}`;
          counter++;
          if (counter > 10) {
            uniqueSlug = `${baseSlug}-${Date.now().toString(36)}`;
            break;
          }
        }

        const result = await workspaceRepo.getOrCreateDefaultWorkspaceAttempt({
          userId,
          name: defaultName,
          slug: uniqueSlug,
        });
        if (result.created) {
          await authRepo.setActiveWorkspaceForUser(userId, result.workspace.id);
        }
        return { workspace: result.workspace, created: result.created };
      } catch (error: unknown) {
        if (
          error instanceof WorkspaceSlugConflictError &&
          attempt < maxRetries - 1
        ) {
          await new Promise(resolve =>
            setTimeout(resolve, 50 * Math.pow(2, attempt)),
          );
          continue;
        }
        throw error;
      }
    }
    throw new Error("Failed to create workspace after multiple attempts");
  }

  /**
   * Generate URL-friendly slug from name
   */
  private generateSlug(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 50);
    return base || "workspace";
  }
}

export const workspaceService = new WorkspaceService();
