/**
 * Workspace client for handling all workspace-related API calls
 */

import { apiClient } from "./api-client";

// Types
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
  isDemo?: boolean;
}

export interface DemoDatabaseResult {
  id: string;
  name: string;
  type: string;
  isDemo: boolean;
  alreadyExists?: boolean;
}

class WorkspaceClient {
  /**
   * Get all workspaces for the current user
   */
  async listWorkspaces(): Promise<Workspace[]> {
    const response = await apiClient.get<{
      success: boolean;
      data: Workspace[];
    }>("/workspaces");
    return response.data;
  }

  /**
   * Get current active workspace
   */
  async getCurrentWorkspace(): Promise<Workspace | null> {
    const response = await apiClient.get<{
      success: boolean;
      data: Workspace | null;
    }>("/workspaces/current");
    return response.data;
  }

  /**
   * Get a specific workspace by ID
   */
  async getWorkspace(id: string): Promise<Workspace> {
    const response = await apiClient.get<{ success: boolean; data: Workspace }>(
      `/workspaces/${id}`,
    );
    return response.data;
  }

  /**
   * Create a new workspace
   */
  async createWorkspace(data: CreateWorkspaceData): Promise<Workspace> {
    const response = await apiClient.post<{
      success: boolean;
      data: Workspace;
    }>("/workspaces", data);
    return response.data;
  }

  /**
   * Update workspace
   */
  async updateWorkspace(
    id: string,
    data: Partial<CreateWorkspaceData>,
  ): Promise<Workspace> {
    const response = await apiClient.put<{ success: boolean; data: Workspace }>(
      `/workspaces/${id}`,
      data,
    );
    return response.data;
  }

  /**
   * Delete workspace
   */
  async deleteWorkspace(id: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}`);
  }

  /**
   * Switch active workspace
   */
  async switchWorkspace(id: string): Promise<void> {
    await apiClient.post(`/workspaces/${id}/switch`);
    // Update local storage
    localStorage.setItem("activeWorkspaceId", id);
  }

  /**
   * Get workspace members
   */
  async getMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const response = await apiClient.get<{
      success: boolean;
      data: WorkspaceMember[];
    }>(`/workspaces/${workspaceId}/members`);
    return response.data;
  }

  /**
   * Add member to workspace
   */
  async addMember(
    workspaceId: string,
    userId: string,
    role: "admin" | "member" | "viewer",
  ): Promise<WorkspaceMember> {
    const response = await apiClient.post<{
      success: boolean;
      data: WorkspaceMember;
    }>(`/workspaces/${workspaceId}/members`, { userId, role });
    return response.data;
  }

  /**
   * Update member role
   */
  async updateMemberRole(
    workspaceId: string,
    userId: string,
    data: UpdateMemberRoleData,
  ): Promise<WorkspaceMember> {
    const response = await apiClient.put<{
      success: boolean;
      data: WorkspaceMember;
    }>(`/workspaces/${workspaceId}/members/${userId}`, data);
    return response.data;
  }

  /**
   * Remove member from workspace
   */
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${workspaceId}/members/${userId}`);
  }

  /**
   * Create workspace invitation
   */
  async createInvite(
    workspaceId: string,
    data: InviteMemberData,
  ): Promise<WorkspaceInvite> {
    const response = await apiClient.post<{
      success: boolean;
      data: WorkspaceInvite;
    }>(`/workspaces/${workspaceId}/invites`, data);
    return response.data;
  }

  /**
   * Get pending invitations
   */
  async getPendingInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
    const response = await apiClient.get<{
      success: boolean;
      data: WorkspaceInvite[];
    }>(`/workspaces/${workspaceId}/invites`);
    return response.data;
  }

  /**
   * Cancel invitation
   */
  async cancelInvite(workspaceId: string, inviteId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${workspaceId}/invites/${inviteId}`);
  }

  /**
   * Get invite details (public endpoint - no auth required)
   */
  async getInviteDetails(token: string): Promise<InviteDetails> {
    const response = await apiClient.get<{
      success: boolean;
      data: InviteDetails;
    }>(`/workspaces/invites/${token}`);
    return response.data;
  }

  /**
   * Accept invitation
   */
  async acceptInvite(token: string): Promise<Workspace> {
    const response = await apiClient.post<{
      success: boolean;
      data: Workspace;
    }>(`/workspaces/invites/${token}/accept`);
    return response.data;
  }

  /**
   * Get databases for workspace
   */
  async getDatabases(workspaceId: string): Promise<WorkspaceDatabase[]> {
    const response = await apiClient.get<{
      success: boolean;
      data: WorkspaceDatabase[];
    }>(`/workspaces/${workspaceId}/databases`);
    return response.data;
  }

  /**
   * Get pending invitations for the current user's email
   */
  async getPendingInvitesForUser(): Promise<PendingInvite[]> {
    const response = await apiClient.get<{
      success: boolean;
      data: PendingInvite[];
    }>("/workspaces/pending-invites");
    return response.data;
  }

  /**
   * Provision demo database for workspace
   * Creates a connection to the shared demo MongoDB database
   */
  async provisionDemoDatabase(
    workspaceId: string,
  ): Promise<DemoDatabaseResult> {
    const response = await apiClient.post<{
      success: boolean;
      data: DemoDatabaseResult;
      message: string;
    }>(`/workspaces/${workspaceId}/databases/demo`);
    return response.data;
  }
}

// Export singleton instance
export const workspaceClient = new WorkspaceClient();
