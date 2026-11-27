/**
 * Store-agnostic DTOs and repository contract for the Phase 1B
 * `workspaces_core` + `github_installations` domain (10 tables, Decision #3).
 *
 * Every ObjectId-backed record exposes BOTH `id` and `_id` (canonical lowercase
 * 24-hex wire id via `toWireId`) so existing callers doing `workspace._id.toString()`,
 * `String(workspace._id)`, `new Types.ObjectId(workspace._id)`, or
 * `c.json({ id: workspace._id })` keep working unchanged.
 *
 * Optional Mongo fields stay optional properties (absent ⇔ Mongo `undefined` ⇔
 * Postgres NULL); they are never coalesced to `[]` or `false`.
 *
 * User reference fields:
 *   - Nullable audit columns (`workspaces.created_by`, `workspace_api_keys.created_by`,
 *     `workspace_invites.invited_by`, `workspace_user_handles.user_id`,
 *     `github_installations.created_by`) map Postgres NULL ↔ `""` in DTOs.
 *   - Grant-bearing columns (`workspace_members.user_id`, `mcp_oauth_codes.user_id`,
 *     `mcp_oauth_tokens.user_id`, `acp_plan_grants.user_id`) are non-null `uuid`
 *     FKs in Postgres referencing `users(id) ON DELETE CASCADE`.
 */
import type { WorkspaceApiKeyScope } from "../../auth/api-key-scopes";
import type {
  AcpPlanGrantStatus,
  BillingPlan,
  BillingTier,
  GitHubAccountType,
  GitHubRepoSelection,
  SubscriptionStatus,
  WorkspaceInviteRole,
  WorkspaceMemberRole,
} from "../../database/pg/schema/workspaces";

export type {
  AcpPlanGrantStatus,
  BillingPlan,
  BillingTier,
  GitHubAccountType,
  GitHubRepoSelection,
  SubscriptionStatus,
  WorkspaceApiKeyScope,
  WorkspaceInviteRole,
  WorkspaceMemberRole,
};

/** The migration domain name used with `MigrationRouter`. */
export const WORKSPACES_DOMAIN = "workspaces_core" as const;

/** All 10 Postgres tables owned by Phase 1B (`workspaces_core` + `github_installations`). */
export const WORKSPACES_TABLES = [
  "workspaces",
  "workspace_api_keys",
  "workspace_members",
  "workspace_invites",
  "workspace_user_handles",
  "mcp_oauth_clients",
  "mcp_oauth_codes",
  "mcp_oauth_tokens",
  "acp_plan_grants",
  "github_installations",
] as const;
export type WorkspacesTableName = (typeof WORKSPACES_TABLES)[number];

/**
 * Standard `retryPayload` target carried by `workspaces_core` dual-writes.
 * Sync-retry replays by RE-READING the authoritative primary row(s) and
 * upserting (or deleting, when absent) in the secondary store — so payloads
 * carry ONLY entity/workspace identifiers, never secrets or bearer tokens.
 */
export interface WorkspacesRetryTarget extends Record<string, unknown> {
  table: WorkspacesTableName;
  /** Wire ids (24-hex) or natural keys (`clientId` for `mcp_oauth_clients`). */
  entityIds: string[];
  /** Optional: resync every row of `table` belonging to this workspace (wire id). */
  workspaceId?: string;
}

// ── 1. workspaces ────────────────────────────────────────────────────────

export interface WorkspaceAutoJoin {
  domains: string[];
  role: "member" | "viewer";
}

export interface WorkspaceSettings {
  maxDatabases: number;
  maxMembers: number;
  billingTier: BillingTier;
  disabledModelIds: string[];
  autoJoin?: WorkspaceAutoJoin;
  /** Absent = default (enabled); `false` disables in-app link previews. */
  linkPreviews?: boolean;
}

export interface WorkspaceBilling {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  usageQuotaUsd: number;
  /** `null` = unlimited. */
  hardLimitUsd: number | null;
  plan: BillingPlan;
  lastReportedOverageCents: number;
  pendingReportedOverageCents: number | null;
  pendingMeterEventIdempotencyKey: string | null;
}

export interface WorkspaceRepoBinding {
  provider: "github";
  installationId?: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  subdirectory: string;
  linkedBy?: string;
  linkedAt?: Date;
}

export interface WorkflowSlot {
  sha?: string;
  tree?: string;
  names?: string[];
  running?: { sha?: string };
  failed?: { sha?: string; error?: string };
}

export interface WorkspaceWorkflows {
  /** Opaque AES `iv:ciphertext` (never decrypted by the repository). */
  hatchetToken?: string;
  live?: WorkflowSlot;
  active?: string[];
  /** name -> opaque AES `iv:ciphertext` secret. */
  webhooks?: Record<string, string>;
  lastNeededAt?: Date;
}

export interface WorkspaceRecord {
  /** Canonical lowercase 24-hex wire id. */
  id: string;
  /** Alias of `id` for callers written against Mongoose documents. */
  _id: string;
  name: string;
  slug: string;
  /** Creator user id, or `""` when Postgres `created_by` is NULL (system/deleted). */
  createdBy: string;
  settings: WorkspaceSettings;
  billing: WorkspaceBilling;
  /** Legacy `appsRepo` is normalized into this array; absent = no repo binding. */
  workspaceRepos?: WorkspaceRepoBinding[];
  /** Absent when the workspace has never had any workflow state. */
  workflows?: WorkspaceWorkflows;
  createdAt: Date;
  updatedAt: Date;
}

// ── 2. workspace_api_keys ────────────────────────────────────────────────

export interface WorkspaceApiKeyRecord {
  /** 24-hex wire id of the `apiKeys[]` subdocument (stable across stores). */
  id: string;
  _id: string;
  workspaceId: string;
  name: string;
  keyHash: string;
  prefix: string;
  /** Absent = legacy unrestricted key. NEVER coalesce to `[]`. */
  scopes?: WorkspaceApiKeyScope[];
  /** Creator user id, or `""` when Postgres `created_by` is NULL. */
  createdBy: string;
  agentRun?: boolean;
  recordWrites?: boolean;
  createdAt: Date;
  lastUsedAt?: Date;
}

// ── 3. workspace_members ─────────────────────────────────────────────────

export interface WorkspaceMemberRecord {
  id: string;
  _id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: Date;
  isDefaultMembership?: boolean;
}

/** Member joined with its user (replaces `.populate("userId", "email")`). */
export interface WorkspaceMemberWithUser extends WorkspaceMemberRecord {
  user: { id: string; email: string } | null;
}

// ── 4. workspace_invites ─────────────────────────────────────────────────

export interface WorkspaceInviteRecord {
  id: string;
  _id: string;
  workspaceId: string;
  email: string;
  token: string;
  role: WorkspaceInviteRole;
  /** Inviter user id, or `""` when Postgres `invited_by` is NULL. */
  invitedBy: string;
  expiresAt: Date;
  acceptedAt?: Date;
  /** Mongo has no timestamps on invites: derived from the ObjectId timestamp. */
  createdAt: Date;
}

/** Invite joined with its workspace name and inviter email (replaces `.populate`). */
export interface WorkspaceInviteWithRefs extends WorkspaceInviteRecord {
  workspace: { id: string; name: string } | null;
  inviter: { id: string; email: string } | null;
}

// ── 5. workspace_user_handles ────────────────────────────────────────────

export interface WorkspaceUserHandleRecord {
  id: string;
  _id: string;
  workspaceId: string;
  /** Owner user id, or `""` when Postgres `user_id` is NULL (reserved handle for deleted user). */
  userId: string;
  handle: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── 6–9. mcp_oauth_* / acp_plan_grants ───────────────────────────────────

export interface McpOAuthClientRecord {
  id: string;
  _id: string;
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: Date;
}

export interface McpOAuthCodeRecord {
  id: string;
  _id: string;
  codeHash: string;
  clientId: string;
  userId: string;
  /** 24-hex wire id. */
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: Date;
  usedAt?: Date;
}

export interface McpOAuthTokenRecord {
  id: string;
  _id: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  userId: string;
  /** 24-hex wire id. */
  workspaceId: string;
  agentSessionId?: string;
  scopes: string[];
  accessExpiresAt: Date;
  /** Absent = non-expiring grant. */
  refreshExpiresAt?: Date;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface McpConnectionSummary {
  clientId: string;
  clientName?: string;
  userId: string;
  connectedAt: Date;
  lastUsedAt?: Date;
  accessExpiresAt: Date;
}

export interface AcpPlanGrantRecord {
  id: string;
  _id: string;
  /** 24-hex wire id. */
  workspaceId: string;
  userId: string;
  agentSessionId: string;
  planDigest: string;
  grants: string[];
  status: AcpPlanGrantStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ── 10. github_installations ─────────────────────────────────────────────

export interface GitHubInstallationRecord {
  id: string;
  _id: string;
  workspaceId: string;
  installationId: number;
  accountLogin: string;
  accountType: GitHubAccountType;
  repositorySelection: GitHubRepoSelection;
  /** Creator user id, or `""` when Postgres `created_by` is NULL. */
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Operation inputs ─────────────────────────────────────────────────────

export interface CreateWorkspaceWithOwnerInput {
  workspaceId?: string;
  memberId?: string;
  name: string;
  slug: string;
  userId: string;
  isDefaultMembership?: boolean;
  settings?: Partial<WorkspaceSettings>;
}

export interface UpdateWorkspacePatch {
  name?: string;
  settings?: {
    maxDatabases?: number;
    maxMembers?: number;
    billingTier?: BillingTier;
    disabledModelIds?: string[];
    autoJoin?: WorkspaceAutoJoin | null;
    linkPreviews?: boolean | null;
  };
}

export interface UpdateBillingPatch {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: SubscriptionStatus | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  usageQuotaUsd?: number;
  hardLimitUsd?: number | null;
  plan?: BillingPlan;
  lastReportedOverageCents?: number;
  pendingReportedOverageCents?: number | null;
  pendingMeterEventIdempotencyKey?: string | null;
  /** Optionally keep `settings.billingTier` in sync in the same write. */
  settingsBillingTier?: BillingTier;
}

export interface CreateApiKeyInput {
  id?: string;
  workspaceId: string;
  name: string;
  keyHash: string;
  prefix: string;
  scopes?: WorkspaceApiKeyScope[];
  createdBy: string;
  agentRun?: boolean;
  recordWrites?: boolean;
  createdAt?: Date;
}

export interface AddMemberInput {
  id?: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt?: Date;
  isDefaultMembership?: boolean;
}

export interface CreateInviteInput {
  id?: string;
  workspaceId: string;
  email: string;
  token: string;
  role: WorkspaceInviteRole;
  invitedBy: string;
  expiresAt: Date;
}

export interface CreateMcpClientInput {
  id?: string;
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt?: Date;
}

export interface CreateMcpCodeInput {
  id?: string;
  codeHash: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: Date;
}

export interface CreateMcpTokenInput {
  id?: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  agentSessionId?: string;
  scopes: string[];
  accessExpiresAt: Date;
  refreshExpiresAt?: Date;
  createdAt?: Date;
}

export interface RotateMcpRefreshTokenInput {
  currentRefreshTokenHash: string;
  clientId: string;
  newAccessTokenHash: string;
  newRefreshTokenHash: string;
  newAccessExpiresAt: Date;
  /** Pass `null` to clear `refreshExpiresAt` (idle TTL disabled); Date to slide forward. */
  newRefreshExpiresAt: Date | null;
  stripScopes: readonly string[];
  now?: Date;
}

export interface UpsertAcpGrantInput {
  id?: string;
  workspaceId: string;
  userId: string;
  agentSessionId: string;
  planDigest: string;
  grants: string[];
  expiresAt: Date;
}

export interface UpsertGitHubInstallationInput {
  id?: string;
  workspaceId: string;
  installationId: number;
  accountLogin: string;
  accountType: GitHubAccountType;
  repositorySelection: GitHubRepoSelection;
  createdBy: string;
}

export class WorkspaceSlugConflictError extends Error {
  readonly code = "WORKSPACE_SLUG_CONFLICT" as const;
  constructor(slug: string, options?: { cause?: unknown }) {
    super(`Workspace slug already exists: ${slug}`, options);
    this.name = "WorkspaceSlugConflictError";
  }
}

export interface WorkspaceRepository {
  // ── 1. Workspaces ────────────────────────────────────────────────────
  findById(workspaceId: string): Promise<WorkspaceRecord | null>;
  findByIds(workspaceIds: readonly string[]): Promise<WorkspaceRecord[]>;
  findBySlug(slug: string): Promise<WorkspaceRecord | null>;
  findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<WorkspaceRecord | null>;
  listPaidActiveBilling(): Promise<WorkspaceRecord[]>;
  listIdsWithDeployedWorkflows(): Promise<string[]>;
  listWithHatchetToken(workspaceId?: string): Promise<WorkspaceRecord[]>;
  findOtherWorkspaceWithHatchetToken(
    excludeWorkspaceId: string,
  ): Promise<{ id: string; slug: string } | null>;
  findWorkspaceIdsByRepoBinding(owner: string, repo: string): Promise<string[]>;

  createWorkspaceWithOwner(
    input: CreateWorkspaceWithOwnerInput,
  ): Promise<{ workspace: WorkspaceRecord; member: WorkspaceMemberRecord }>;
  getOrCreateDefaultWorkspaceAttempt(input: {
    userId: string;
    name: string;
    slug: string;
  }): Promise<{
    workspace: WorkspaceRecord;
    member: WorkspaceMemberRecord;
    created: boolean;
  }>;
  deleteWorkspaceCascade(workspaceId: string): Promise<boolean>;

  updateWorkspace(
    workspaceId: string,
    patch: UpdateWorkspacePatch,
  ): Promise<WorkspaceRecord | null>;
  setAutoJoin(
    workspaceId: string,
    autoJoin: WorkspaceAutoJoin | null,
  ): Promise<void>;
  setLinkPreviews(workspaceId: string, enabled: boolean): Promise<void>;
  setDisabledModelIds(
    workspaceId: string,
    disabledModelIds: string[],
  ): Promise<WorkspaceRecord | null>;
  unsetLegacyCustomPrompt(
    workspaceId: string,
    options?: { includeSelfDirective?: boolean },
  ): Promise<void>;

  // Billing
  updateBilling(
    workspaceId: string,
    patch: UpdateBillingPatch,
  ): Promise<WorkspaceRecord | null>;
  claimStripeCustomerIdIfUnset(
    workspaceId: string,
    stripeCustomerId: string,
  ): Promise<boolean>;
  markStripeCustomerPastDue(stripeCustomerId: string): Promise<string | null>;
  claimPendingOverage(
    workspaceId: string,
    expectedLastCents: number,
    targetCents: number,
    idempotencyKey: string,
  ): Promise<boolean>;
  commitPendingOverage(
    workspaceId: string,
    targetCents: number,
    idempotencyKey: string,
  ): Promise<boolean>;

  // Workspace repos
  setWorkspaceRepos(
    workspaceId: string,
    repos: WorkspaceRepoBinding[] | null,
  ): Promise<WorkspaceRecord | null>;
  upsertTestWorkspaceWithRepo(
    workspaceId: string,
    repo: WorkspaceRepoBinding,
  ): Promise<void>;

  // Workflows
  setWorkflowHatchetToken(
    workspaceId: string,
    encryptedToken: string | null,
  ): Promise<void>;
  setWorkflowLiveTarget(
    workspaceId: string,
    target: { sha: string; tree: string; names: string[] } | null,
  ): Promise<void>;
  reportWorkflowLiveStatus(
    workspaceId: string,
    sha: string,
    error?: string,
  ): Promise<boolean>;
  setWorkflowTrigger(
    workspaceId: string,
    name: string,
    change: { active?: boolean; encryptedWebhookSecret?: string | null },
  ): Promise<void>;
  touchWorkflowLastNeededAt(workspaceId: string, at?: Date): Promise<void>;

  // ── 2. Workspace API keys ────────────────────────────────────────────
  findApiKeyByHash(keyHash: string): Promise<{
    workspace: WorkspaceRecord;
    apiKey: WorkspaceApiKeyRecord;
  } | null>;
  listApiKeys(workspaceId: string): Promise<WorkspaceApiKeyRecord[]>;
  createApiKey(input: CreateApiKeyInput): Promise<WorkspaceApiKeyRecord>;
  replaceApiKeyByName(input: CreateApiKeyInput): Promise<WorkspaceApiKeyRecord>;
  updateApiKeyScopesByName(
    workspaceId: string,
    name: string,
    scopes: WorkspaceApiKeyScope[],
  ): Promise<boolean>;
  deleteApiKey(workspaceId: string, keyId: string): Promise<boolean>;
  deleteApiKeysByName(workspaceId: string, name: string): Promise<number>;
  deleteApiKeysByCreator(
    workspaceId: string,
    createdBy: string,
  ): Promise<number>;
  pruneExpiredApiKeysByNamePrefix(
    workspaceId: string,
    namePrefix: string,
    createdBefore: Date,
  ): Promise<number>;
  touchApiKeyLastUsed(
    workspaceId: string,
    keyId: string,
    now?: Date,
    minIntervalMs?: number,
  ): Promise<void>;

  // ── 3. Workspace members ─────────────────────────────────────────────
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null>;
  findWorkspacesForUser(
    userId: string,
  ): Promise<Array<{ workspace: WorkspaceRecord; role: WorkspaceMemberRole }>>;
  listMembers(
    workspaceId: string,
    roles?: readonly WorkspaceMemberRole[],
  ): Promise<WorkspaceMemberRecord[]>;
  listMembersWithUsers(workspaceId: string): Promise<WorkspaceMemberWithUser[]>;
  findMatchingMemberUserIds(
    workspaceId: string,
    userIds: readonly string[],
    role?: WorkspaceMemberRole,
  ): Promise<string[]>;
  addMember(input: AddMemberInput): Promise<WorkspaceMemberWithUser>;
  addMemberIfNotExists(
    input: AddMemberInput,
  ): Promise<{ member: WorkspaceMemberRecord; inserted: boolean }>;
  updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberWithUser | null>;
  removeMember(workspaceId: string, userId: string): Promise<boolean>;

  // ── 4. Workspace invites ─────────────────────────────────────────────
  findPendingInviteByWorkspaceAndEmail(
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceInviteRecord | null>;
  createInvite(input: CreateInviteInput): Promise<WorkspaceInviteRecord>;
  refreshInvite(
    inviteId: string,
    patch: { expiresAt: Date; invitedBy: string },
  ): Promise<WorkspaceInviteRecord | null>;
  findPendingInviteByToken(
    token: string,
  ): Promise<WorkspaceInviteWithRefs | null>;
  listPendingInvitesForWorkspace(
    workspaceId: string,
    now?: Date,
  ): Promise<WorkspaceInviteWithRefs[]>;
  listPendingInvitesForEmail(
    email: string,
    now?: Date,
  ): Promise<WorkspaceInviteWithRefs[]>;
  cancelInvite(workspaceId: string, inviteId: string): Promise<boolean>;
  acceptInviteTransaction(
    token: string,
    userId: string,
    now?: Date,
  ): Promise<{
    workspace: WorkspaceRecord;
    member: WorkspaceMemberRecord;
    invite: WorkspaceInviteRecord;
  }>;

  // ── 5. Workspace user handles ────────────────────────────────────────
  listHandles(workspaceId: string): Promise<WorkspaceUserHandleRecord[]>;
  insertHandlesBestEffort(
    workspaceId: string,
    rows: ReadonlyArray<{ userId: string; handle: string }>,
  ): Promise<{ inserted: WorkspaceUserHandleRecord[]; hadConflict: boolean }>;

  // ── 6. MCP OAuth clients ─────────────────────────────────────────────
  findMcpClient(clientId: string): Promise<McpOAuthClientRecord | null>;
  createMcpClient(input: CreateMcpClientInput): Promise<McpOAuthClientRecord>;
  ensureMcpClient(input: CreateMcpClientInput): Promise<McpOAuthClientRecord>;

  // ── 7. MCP OAuth codes ───────────────────────────────────────────────
  createMcpCode(input: CreateMcpCodeInput): Promise<McpOAuthCodeRecord>;
  redeemMcpCodeOnce(
    codeHash: string,
    now?: Date,
  ): Promise<McpOAuthCodeRecord | null>;

  // ── 8. MCP OAuth tokens ──────────────────────────────────────────────
  createMcpToken(input: CreateMcpTokenInput): Promise<McpOAuthTokenRecord>;
  findValidMcpTokenByAccessHash(
    accessTokenHash: string,
    now?: Date,
  ): Promise<McpOAuthTokenRecord | null>;
  hasActiveMcpAgentSession(input: {
    workspaceId: string;
    userId: string;
    clientId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean>;
  rotateMcpRefreshToken(
    input: RotateMcpRefreshTokenInput,
  ): Promise<McpOAuthTokenRecord | null>;
  touchMcpTokenLastUsed(
    tokenId: string,
    now?: Date,
    minIntervalMs?: number,
  ): Promise<void>;
  listMcpConnections(
    workspaceId: string,
    now?: Date,
  ): Promise<McpConnectionSummary[]>;
  revokeMcpGrantsForMember(input: {
    workspaceId: string;
    userId: string;
  }): Promise<number>;
  revokeMcpConnection(input: {
    workspaceId: string;
    clientId: string;
    userId: string;
  }): Promise<number>;

  // ── 9. ACP plan grants ───────────────────────────────────────────────
  upsertAcpGrant(input: UpsertAcpGrantInput): Promise<AcpPlanGrantRecord>;
  revokeAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean>;
  findActiveAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<AcpPlanGrantRecord | null>;

  // ── 10. GitHub installations ─────────────────────────────────────────
  listGitHubInstallations(
    workspaceId: string,
  ): Promise<GitHubInstallationRecord[]>;
  findGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<GitHubInstallationRecord | null>;
  upsertGitHubInstallation(
    input: UpsertGitHubInstallationInput,
  ): Promise<GitHubInstallationRecord>;
  deleteGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<boolean>;
  deleteGitHubInstallationsByInstallationId(
    installationId: number,
  ): Promise<number>;
  pruneStaleGitHubInstallations(
    workspaceId: string,
    accountLogin: string,
    keepInstallationId: number,
  ): Promise<number>;
}
