/** Frontend domain types for workspaces, members and invites. The API DTOs
 * are a structural subset (the frontend always treats `role` as present and
 * adds `billing`). */
export interface WorkspaceBilling {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus:
    | "active"
    | "past_due"
    | "canceled"
    | "trialing"
    | "incomplete"
    | "incomplete_expired"
    | "unpaid"
    | "paused"
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

/** Domain auto-join: who joins by email domain, and with which access. null = off. */
export interface WorkspaceAutoJoin {
  domains: string[];
  role: "member" | "viewer";
}

export interface WorkspaceDatabase {
  id: string;
  name: string;
  type: "mongodb" | "postgresql" | "mysql" | "sqlite" | "mssql";
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}
