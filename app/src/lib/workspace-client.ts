/**
 * Workspace client for handling all workspace-related API calls.
 *
 * Uses the spec-typed `api` client: every path, path parameter, and request
 * body below is checked against the generated OpenAPI types at compile time.
 * Responses are mapped to the richer frontend domain types declared here (the
 * API DTOs are a structural subset — e.g. the frontend always treats `role`
 * as present and adds `billing`).
 */

import { api } from "../api";

/**
 * Throws on transport/HTTP error, otherwise returns the parsed `{ success, data }`
 * envelope. `data` is exposed as `unknown` so each caller asserts the frontend
 * domain type (the API DTO is a structural subset).
 */
function unwrap(result: {
  data?: unknown;
  error?: unknown;
  response: Response;
}): { data?: unknown } {
  if (result.error || !result.response.ok) {
    const message =
      (result.error as { error?: string } | undefined)?.error ||
      `HTTP error! status: ${result.response.status}`;
    throw new Error(message);
  }
  return (result.data ?? {}) as { data?: unknown };
}

// Types
export interface WorkspaceBilling {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus:
    | "active"
    | "past_due"
    | "canceled"
    | "trialing"
    | "incomplete"
    | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  usageQuotaUsd: number;
  hardLimitUsd: number | null;
  plan: "free" | "pro" | "enterprise";
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  settings: {
    maxDatabases: number;
    maxMembers: number;
    billingTier: "free" | "pro" | "enterprise";
  };
  billing?: WorkspaceBilling;
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: string;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  token?: string;
  invitedBy: string;
  expiresAt: string;
}

export interface InviteDetails {
  workspaceName: string;
  inviterEmail: string;
  inviteeEmail: string;
  role: string;
  expiresAt: string;
}

export interface PendingInvite {
  token: string;
  workspaceName: string;
  inviterEmail: string;
  role: string;
  expiresAt: string;
}

export interface CreateWorkspaceData {
  name: string;
  slug?: string;
}

export interface InviteMemberData {
  email: string;
  role: "admin" | "member" | "viewer";
}

export interface UpdateMemberRoleData {
  role: "admin" | "member" | "viewer";
}

export interface WorkspaceDatabase {
  id: string;
  name: string;
  type: "mongodb" | "postgresql" | "mysql" | "sqlite" | "mssql";
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

class WorkspaceClient {
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
    // Update local storage
    localStorage.setItem("activeWorkspaceId", id);
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
}

// Export singleton instance
export const workspaceClient = new WorkspaceClient();
