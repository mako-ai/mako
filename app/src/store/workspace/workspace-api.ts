/**
 * Workspace, member and invite API calls, on the spec-typed `api` client:
 * every path, path parameter and request body is checked against the
 * generated OpenAPI types. Responses are mapped to the frontend domain types
 * in `./types`. Only `workspaceStore` calls these — components go through the
 * store's actions.
 */
import { api, unwrap } from "../../api";
import type {
  AutoJoinOffer,
  Workspace,
  WorkspaceMember,
  WorkspaceInvite,
  InviteDetails,
  PendingInvite,
  CreateWorkspaceData,
  InviteMemberData,
  UpdateMemberRoleData,
  WorkspaceAutoJoin,
  WorkspaceDatabase,
} from "./types";

class WorkspaceApi {
  /**
   * Get all workspaces for the current user
   */
  async listWorkspaces(): Promise<Workspace[]> {
    const body = unwrap(await api.GET("/api/workspaces"));
    return (body.data ?? []) as Workspace[];
  }

  /**
   * Get current active workspace
   */
  async getCurrentWorkspace(): Promise<Workspace | null> {
    const body = unwrap(await api.GET("/api/workspaces/current"));
    return (body.data ?? null) as Workspace | null;
  }

  /**
   * Get a specific workspace by ID
   */
  async getWorkspace(id: string): Promise<Workspace> {
    const body = unwrap(
      await api.GET("/api/workspaces/{id}", { params: { path: { id } } }),
    );
    return body.data as Workspace;
  }

  /**
   * Create a new workspace
   */
  async createWorkspace(data: CreateWorkspaceData): Promise<Workspace> {
    const body = unwrap(await api.POST("/api/workspaces", { body: data }));
    return body.data as Workspace;
  }

  /**
   * Update workspace
   */
  async updateWorkspace(
    id: string,
    data: Partial<CreateWorkspaceData>,
  ): Promise<Workspace> {
    const body = unwrap(
      await api.PUT("/api/workspaces/{id}", {
        params: { path: { id } },
        body: data,
      }),
    );
    return body.data as Workspace;
  }

  /**
   * Delete workspace
   */
  async deleteWorkspace(id: string): Promise<void> {
    unwrap(
      await api.DELETE("/api/workspaces/{id}", { params: { path: { id } } }),
    );
  }

  /**
   * Switch active workspace
   */
  async switchWorkspace(id: string): Promise<void> {
    unwrap(
      await api.POST("/api/workspaces/{id}/switch", {
        params: { path: { id } },
      }),
    );
  }

  /**
   * Get workspace members
   */
  async getMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const body = unwrap(
      await api.GET("/api/workspaces/{id}/members", {
        params: { path: { id: workspaceId } },
      }),
    );
    return (body.data ?? []) as WorkspaceMember[];
  }

  /**
   * Add member to workspace
   */
  async addMember(
    workspaceId: string,
    userId: string,
    role: "admin" | "member" | "viewer",
  ): Promise<WorkspaceMember> {
    const body = unwrap(
      await api.POST("/api/workspaces/{id}/members", {
        params: { path: { id: workspaceId } },
        body: { userId, role },
      }),
    );
    return body.data as WorkspaceMember;
  }

  /**
   * Update member role
   */
  async updateMemberRole(
    workspaceId: string,
    userId: string,
    data: UpdateMemberRoleData,
  ): Promise<WorkspaceMember> {
    const body = unwrap(
      await api.PUT("/api/workspaces/{id}/members/{userId}", {
        params: { path: { id: workspaceId, userId } },
        body: data,
      }),
    );
    return body.data as WorkspaceMember;
  }

  /** Domain auto-join settings (owner/admin). */
  async getAutoJoin(workspaceId: string): Promise<WorkspaceAutoJoin | null> {
    const body = unwrap(
      await api.GET("/api/workspaces/{id}/auto-join", {
        params: { path: { id: workspaceId } },
      }),
    );
    return (body.data ?? null) as WorkspaceAutoJoin | null;
  }

  /** An empty domain list turns auto-join off. */
  async setAutoJoin(
    workspaceId: string,
    data: WorkspaceAutoJoin,
  ): Promise<WorkspaceAutoJoin | null> {
    const body = unwrap(
      await api.PUT("/api/workspaces/{id}/auto-join", {
        params: { path: { id: workspaceId } },
        body: data,
      }),
    );
    return (body.data ?? null) as WorkspaceAutoJoin | null;
  }

  /**
   * Remove member from workspace
   */
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    unwrap(
      await api.DELETE("/api/workspaces/{id}/members/{userId}", {
        params: { path: { id: workspaceId, userId } },
      }),
    );
  }

  /**
   * Create workspace invitation
   */
  async createInvite(
    workspaceId: string,
    data: InviteMemberData,
  ): Promise<WorkspaceInvite> {
    const body = unwrap(
      await api.POST("/api/workspaces/{id}/invites", {
        params: { path: { id: workspaceId } },
        body: data,
      }),
    );
    return body.data as WorkspaceInvite;
  }

  /**
   * Get pending invitations
   */
  async getPendingInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
    const body = unwrap(
      await api.GET("/api/workspaces/{id}/invites", {
        params: { path: { id: workspaceId } },
      }),
    );
    return (body.data ?? []) as WorkspaceInvite[];
  }

  /**
   * Cancel invitation
   */
  async cancelInvite(workspaceId: string, inviteId: string): Promise<void> {
    unwrap(
      await api.DELETE("/api/workspaces/{id}/invites/{inviteId}", {
        params: { path: { id: workspaceId, inviteId } },
      }),
    );
  }

  /**
   * Get invite details (public endpoint - no auth required)
   */
  async getInviteDetails(token: string): Promise<InviteDetails> {
    const body = unwrap(
      await api.GET("/api/workspaces/invites/{token}", {
        params: { path: { token } },
      }),
    );
    return body.data as InviteDetails;
  }

  /**
   * Accept invitation
   */
  async acceptInvite(token: string): Promise<Workspace> {
    const body = unwrap(
      await api.POST("/api/workspaces/invites/{token}/accept", {
        params: { path: { token } },
      }),
    );
    return body.data as Workspace;
  }

  /**
   * Get databases for workspace
   */
  async getDatabases(workspaceId: string): Promise<WorkspaceDatabase[]> {
    const body = unwrap(
      await api.GET("/api/workspaces/{workspaceId}/databases", {
        params: { path: { workspaceId } },
      }),
    );
    return (body.data ?? []) as WorkspaceDatabase[];
  }

  /**
   * Get pending invitations for the current user's email
   */
  async getPendingInvitesForUser(): Promise<PendingInvite[]> {
    const body = unwrap(await api.GET("/api/workspaces/pending-invites"));
    return (body.data ?? []) as PendingInvite[];
  }

  /**
   * Workspaces the current user can join by email domain
   */
  async getAutoJoinOffers(): Promise<AutoJoinOffer[]> {
    const body = unwrap(await api.GET("/api/workspaces/auto-join-offers"));
    return (body.data ?? []) as AutoJoinOffer[];
  }

  /**
   * Join a workspace that auto-joins the current user's email domain
   */
  async joinByDomain(workspaceId: string): Promise<Workspace> {
    const body = unwrap(
      await api.POST("/api/workspaces/{id}/join", {
        params: { path: { id: workspaceId } },
      }),
    );
    return body.data as Workspace;
  }
}

export const workspaceApi = new WorkspaceApi();
