import { Types } from "mongoose";
import {
  Workspace,
  WorkspaceMember,
  WorkspaceInvite,
  IWorkspace,
  IWorkspaceMember,
  IWorkspaceInvite,
} from "../database/workspace-schema";
import { Session, User } from "../database/schema";
import { v4 as uuidv4 } from "uuid";
import { emailService } from "./email.service";

export class WorkspaceService {
  /**
   * Create a new workspace
   */
  async createWorkspace(
    userId: string,
    name: string,
    slug?: string,
  ): Promise<IWorkspace> {
    // Generate unique slug if not provided
    if (!slug) {
      slug = this.generateSlug(name);
    }

    // Ensure slug is unique
    let uniqueSlug = slug;
    let counter = 1;
    while (await Workspace.findOne({ slug: uniqueSlug })) {
      uniqueSlug = `${slug}-${counter}`;
      counter++;
    }

    // Start a session for transaction
    const session = await Workspace.db.startSession();
    await session.startTransaction();

    try {
      // Create workspace
      const workspace = new Workspace({
        name,
        slug: uniqueSlug,
        createdBy: userId,
        settings: {
          maxDatabases: 5,
          maxMembers: 10,
          billingTier: "free",
        },
      });
      await workspace.save({ session });

      // Add creator as owner
      const member = new WorkspaceMember({
        workspaceId: workspace._id,
        userId: userId,
        role: "owner",
        joinedAt: new Date(),
      });
      await member.save({ session });

      // Update user's active workspace in session
      await Session.updateMany(
        { userId },
        { activeWorkspaceId: workspace._id.toString() },
        { session },
      );

      await session.commitTransaction();
      return workspace;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get all workspaces for a user
   */
  async getWorkspacesForUser(userId: string): Promise<
    Array<{
      workspace: IWorkspace;
      role: string;
    }>
  > {
    const members = await WorkspaceMember.aggregate([
      { $match: { userId: userId } },
      {
        $lookup: {
          from: "workspaces",
          localField: "workspaceId",
          foreignField: "_id",
          as: "workspace",
        },
      },
      { $unwind: "$workspace" },
      {
        $project: {
          workspace: 1,
          role: 1,
        },
      },
    ]);

    return members;
  }

  /**
   * Get a workspace by ID
   */
  async getWorkspaceById(workspaceId: string): Promise<IWorkspace | null> {
    return Workspace.findById(workspaceId);
  }

  /**
   * Get workspace member
   */
  async getMember(
    workspaceId: string,
    userId: string,
  ): Promise<IWorkspaceMember | null> {
    return WorkspaceMember.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: userId,
    });
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
    updates: Partial<IWorkspace>,
  ): Promise<IWorkspace | null> {
    return Workspace.findByIdAndUpdate(workspaceId, updates, { new: true });
  }

  /**
   * Delete workspace
   */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    const session = await Workspace.db.startSession();
    await session.startTransaction();

    try {
      // Delete workspace
      await Workspace.deleteOne(
        { _id: new Types.ObjectId(workspaceId) },
        { session },
      );

      // Delete all members
      await WorkspaceMember.deleteMany(
        { workspaceId: new Types.ObjectId(workspaceId) },
        { session },
      );

      // Delete all invites
      await WorkspaceInvite.deleteMany(
        { workspaceId: new Types.ObjectId(workspaceId) },
        { session },
      );

      // TODO: Delete all workspace data (databases, consoles, etc.)

      await session.commitTransaction();
      return true;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get workspace members
   */
  async getMembers(workspaceId: string): Promise<IWorkspaceMember[]> {
    return WorkspaceMember.find({
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .populate("userId", "email")
      .sort({ joinedAt: 1 });
  }

  /**
   * Add member to workspace
   */
  async addMember(
    workspaceId: string,
    userId: string,
    role: "admin" | "member" | "viewer",
  ): Promise<IWorkspaceMember> {
    const member = new WorkspaceMember({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: userId,
      role,
      joinedAt: new Date(),
    });
    return member.save();
  }

  /**
   * Update member role
   */
  async updateMemberRole(
    workspaceId: string,
    userId: string,
    newRole: string,
  ): Promise<IWorkspaceMember | null> {
    return WorkspaceMember.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        userId: userId,
      },
      { role: newRole },
      { new: true },
    );
  }

  /**
   * Remove member from workspace
   */
  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const result = await WorkspaceMember.deleteOne({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: userId,
    });
    return result.deletedCount > 0;
  }

  /**
   * Create workspace invite
   */
  async createInvite(
    workspaceId: string,
    email: string,
    role: "admin" | "member" | "viewer",
    invitedBy: string,
  ): Promise<IWorkspaceInvite> {
    const invite = new WorkspaceInvite({
      workspaceId: new Types.ObjectId(workspaceId),
      email: email.toLowerCase(),
      token: uuidv4().replace(/-/g, ""),
      role,
      invitedBy: invitedBy,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    await invite.save();

    // Send invitation email
    try {
      const workspace = await Workspace.findById(workspaceId);
      const inviter = await User.findById(invitedBy);

      const workspaceName = workspace?.name || "Unknown Workspace";
      const inviterName = inviter?.email || "Someone";
      const inviteUrl = `${process.env.CLIENT_URL}/invite/${invite.token}`;

      await emailService.sendInvitationEmail(
        email.toLowerCase(),
        workspaceName,
        inviterName,
        inviteUrl,
      );
    } catch (error) {
      console.error("Failed to send invitation email:", error);
      // Don't fail the invite creation if email fails
    }

    return invite;
  }

  /**
   * Get invite by token
   */
  async getInviteByToken(token: string): Promise<IWorkspaceInvite | null> {
    return WorkspaceInvite.findOne({ token, acceptedAt: { $exists: false } })
      .populate("workspaceId", "name")
      .populate("invitedBy", "email");
  }

  /**
   * Accept invite
   */
  async acceptInvite(token: string, userId: string): Promise<IWorkspace> {
    // Retry logic for write conflicts
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this._acceptInviteAttempt(token, userId);
      } catch (error: any) {
        // Retry on write conflicts
        if (error.code === 112 && attempt < maxRetries - 1) {
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Failed to accept invite after multiple attempts");
  }

  /**
   * Single attempt to accept invite
   */
  private async _acceptInviteAttempt(
    token: string,
    userId: string,
  ): Promise<IWorkspace> {
    const invite = await WorkspaceInvite.findOne({
      token,
      acceptedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      throw new Error("Invalid or expired invite");
    }

    // Check if user is already a member
    const existingMember = await WorkspaceMember.findOne({
      workspaceId: invite.workspaceId,
      userId: userId,
    });

    if (existingMember) {
      // User is already a member, just mark invite as accepted
      invite.acceptedAt = new Date();
      await invite.save();

      const workspace = await Workspace.findById(invite.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      return workspace;
    }

    const session = await WorkspaceMember.db.startSession();
    await session.startTransaction();

    try {
      // Mark invite as accepted
      invite.acceptedAt = new Date();
      await invite.save({ session });

      // Add user as member (with session)
      const member = new WorkspaceMember({
        workspaceId: invite.workspaceId,
        userId: userId,
        role: invite.role,
        joinedAt: new Date(),
      });
      await member.save({ session });

      const workspace = await Workspace.findById(invite.workspaceId).session(
        session,
      );
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      await session.commitTransaction();
      return workspace;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get pending invites for workspace
   */
  async getPendingInvites(workspaceId: string): Promise<IWorkspaceInvite[]> {
    return WorkspaceInvite.find({
      workspaceId: new Types.ObjectId(workspaceId),
      acceptedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    })
      .populate("invitedBy", "email")
      .sort({ createdAt: -1 });
  }

  /**
   * Get pending invites for a specific email address
   */
  async getPendingInvitesForEmail(email: string): Promise<IWorkspaceInvite[]> {
    return WorkspaceInvite.find({
      email: email.toLowerCase(),
      acceptedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    })
      .populate("workspaceId", "name")
      .populate("invitedBy", "email")
      .sort({ createdAt: -1 });
  }

  /**
   * Cancel invite
   */
  async cancelInvite(inviteId: string): Promise<boolean> {
    const result = await WorkspaceInvite.deleteOne({
      _id: new Types.ObjectId(inviteId),
    });
    return result.deletedCount > 0;
  }

  /**
   * Switch active workspace
   */
  async switchWorkspace(userId: string, workspaceId: string): Promise<boolean> {
    // Verify user has access to workspace
    const hasAccess = await this.hasAccess(workspaceId, userId);
    if (!hasAccess) {
      throw new Error("Access denied to workspace");
    }

    // Update all user sessions
    const result = await Session.updateMany(
      { userId },
      { activeWorkspaceId: workspaceId },
    );

    return result.modifiedCount > 0;
  }

  /**
   * Generate slug from name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 50);
  }
}

// Export singleton instance
export const workspaceService = new WorkspaceService();
