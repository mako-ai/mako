/**
 * Workspaces core & GitHub installations repository entry point (Neon Postgres `pg_only`).
 */
import { PgWorkspaceRepository } from "./pg.repo";
import type { WorkspaceRepository } from "./types";

export * from "./types";
export * from "./mapper";
export { PgWorkspaceRepository } from "./pg.repo";

const defaultWorkspaceRepo: WorkspaceRepository = new PgWorkspaceRepository();
let activeWorkspaceRepo: WorkspaceRepository = defaultWorkspaceRepo;

export function getWorkspaceRepoInstance(): WorkspaceRepository {
  return activeWorkspaceRepo;
}

export function setWorkspaceRepoForTests(repo: WorkspaceRepository): void {
  activeWorkspaceRepo = repo;
}

export function resetWorkspaceRepoForTests(): void {
  activeWorkspaceRepo = defaultWorkspaceRepo;
}

/**
 * Delegating proxy singleton so callers importing `workspaceRepo` directly
 * automatically observe `setWorkspaceRepoForTests()` / `resetWorkspaceRepoForTests()`.
 */
export const workspaceRepo: WorkspaceRepository = {
  // 1. Workspaces
  findById: workspaceId => activeWorkspaceRepo.findById(workspaceId),
  findByIds: workspaceIds => activeWorkspaceRepo.findByIds(workspaceIds),
  findBySlug: slug => activeWorkspaceRepo.findBySlug(slug),
  findByStripeCustomerId: stripeCustomerId =>
    activeWorkspaceRepo.findByStripeCustomerId(stripeCustomerId),
  listPaidActiveBilling: () => activeWorkspaceRepo.listPaidActiveBilling(),
  listIdsWithDeployedWorkflows: () =>
    activeWorkspaceRepo.listIdsWithDeployedWorkflows(),
  listWithHatchetToken: workspaceId =>
    activeWorkspaceRepo.listWithHatchetToken(workspaceId),
  findOtherWorkspaceWithHatchetToken: excludeWorkspaceId =>
    activeWorkspaceRepo.findOtherWorkspaceWithHatchetToken(excludeWorkspaceId),
  findWorkspaceIdsByRepoBinding: (owner, repo) =>
    activeWorkspaceRepo.findWorkspaceIdsByRepoBinding(owner, repo),

  createWorkspaceWithOwner: input =>
    activeWorkspaceRepo.createWorkspaceWithOwner(input),
  getOrCreateDefaultWorkspaceAttempt: input =>
    activeWorkspaceRepo.getOrCreateDefaultWorkspaceAttempt(input),
  deleteWorkspaceCascade: workspaceId =>
    activeWorkspaceRepo.deleteWorkspaceCascade(workspaceId),

  updateWorkspace: (workspaceId, patch) =>
    activeWorkspaceRepo.updateWorkspace(workspaceId, patch),
  setAutoJoin: (workspaceId, autoJoin) =>
    activeWorkspaceRepo.setAutoJoin(workspaceId, autoJoin),
  setLinkPreviews: (workspaceId, enabled) =>
    activeWorkspaceRepo.setLinkPreviews(workspaceId, enabled),
  setDisabledModelIds: (workspaceId, disabledModelIds) =>
    activeWorkspaceRepo.setDisabledModelIds(workspaceId, disabledModelIds),
  unsetLegacyCustomPrompt: (workspaceId, options) =>
    activeWorkspaceRepo.unsetLegacyCustomPrompt(workspaceId, options),

  updateBilling: (workspaceId, patch) =>
    activeWorkspaceRepo.updateBilling(workspaceId, patch),
  claimStripeCustomerIdIfUnset: (workspaceId, stripeCustomerId) =>
    activeWorkspaceRepo.claimStripeCustomerIdIfUnset(
      workspaceId,
      stripeCustomerId,
    ),
  markStripeCustomerPastDue: stripeCustomerId =>
    activeWorkspaceRepo.markStripeCustomerPastDue(stripeCustomerId),
  claimPendingOverage: (
    workspaceId,
    expectedLastCents,
    targetCents,
    idempotencyKey,
  ) =>
    activeWorkspaceRepo.claimPendingOverage(
      workspaceId,
      expectedLastCents,
      targetCents,
      idempotencyKey,
    ),
  commitPendingOverage: (workspaceId, targetCents, idempotencyKey) =>
    activeWorkspaceRepo.commitPendingOverage(
      workspaceId,
      targetCents,
      idempotencyKey,
    ),

  setWorkspaceRepos: (workspaceId, repos) =>
    activeWorkspaceRepo.setWorkspaceRepos(workspaceId, repos),
  upsertTestWorkspaceWithRepo: (workspaceId, repo) =>
    activeWorkspaceRepo.upsertTestWorkspaceWithRepo(workspaceId, repo),

  setWorkflowHatchetToken: (workspaceId, encryptedToken) =>
    activeWorkspaceRepo.setWorkflowHatchetToken(workspaceId, encryptedToken),
  setWorkflowLiveTarget: (workspaceId, target) =>
    activeWorkspaceRepo.setWorkflowLiveTarget(workspaceId, target),
  reportWorkflowLiveStatus: (workspaceId, sha, error) =>
    activeWorkspaceRepo.reportWorkflowLiveStatus(workspaceId, sha, error),
  setWorkflowTrigger: (workspaceId, name, change) =>
    activeWorkspaceRepo.setWorkflowTrigger(workspaceId, name, change),
  touchWorkflowLastNeededAt: (workspaceId, at) =>
    activeWorkspaceRepo.touchWorkflowLastNeededAt(workspaceId, at),

  // 2. Workspace API keys
  findApiKeyByHash: keyHash => activeWorkspaceRepo.findApiKeyByHash(keyHash),
  listApiKeys: workspaceId => activeWorkspaceRepo.listApiKeys(workspaceId),
  createApiKey: input => activeWorkspaceRepo.createApiKey(input),
  replaceApiKeyByName: input => activeWorkspaceRepo.replaceApiKeyByName(input),
  updateApiKeyScopesByName: (workspaceId, name, scopes) =>
    activeWorkspaceRepo.updateApiKeyScopesByName(workspaceId, name, scopes),
  deleteApiKey: (workspaceId, keyId) =>
    activeWorkspaceRepo.deleteApiKey(workspaceId, keyId),
  deleteApiKeysByName: (workspaceId, name) =>
    activeWorkspaceRepo.deleteApiKeysByName(workspaceId, name),
  deleteApiKeysByCreator: (workspaceId, createdBy) =>
    activeWorkspaceRepo.deleteApiKeysByCreator(workspaceId, createdBy),
  pruneExpiredApiKeysByNamePrefix: (workspaceId, namePrefix, createdBefore) =>
    activeWorkspaceRepo.pruneExpiredApiKeysByNamePrefix(
      workspaceId,
      namePrefix,
      createdBefore,
    ),
  touchApiKeyLastUsed: (workspaceId, keyId, now, minIntervalMs) =>
    activeWorkspaceRepo.touchApiKeyLastUsed(
      workspaceId,
      keyId,
      now,
      minIntervalMs,
    ),

  // 3. Workspace members
  findMember: (workspaceId, userId) =>
    activeWorkspaceRepo.findMember(workspaceId, userId),
  findWorkspacesForUser: userId =>
    activeWorkspaceRepo.findWorkspacesForUser(userId),
  listMembers: (workspaceId, roles) =>
    activeWorkspaceRepo.listMembers(workspaceId, roles),
  listMembersWithUsers: workspaceId =>
    activeWorkspaceRepo.listMembersWithUsers(workspaceId),
  findMatchingMemberUserIds: (workspaceId, userIds, role) =>
    activeWorkspaceRepo.findMatchingMemberUserIds(workspaceId, userIds, role),
  addMember: input => activeWorkspaceRepo.addMember(input),
  addMemberIfNotExists: input =>
    activeWorkspaceRepo.addMemberIfNotExists(input),
  updateMemberRole: (workspaceId, userId, role) =>
    activeWorkspaceRepo.updateMemberRole(workspaceId, userId, role),
  removeMember: (workspaceId, userId) =>
    activeWorkspaceRepo.removeMember(workspaceId, userId),

  // 4. Workspace invites
  findPendingInviteByWorkspaceAndEmail: (workspaceId, email) =>
    activeWorkspaceRepo.findPendingInviteByWorkspaceAndEmail(
      workspaceId,
      email,
    ),
  createInvite: input => activeWorkspaceRepo.createInvite(input),
  refreshInvite: (inviteId, patch) =>
    activeWorkspaceRepo.refreshInvite(inviteId, patch),
  findPendingInviteByToken: token =>
    activeWorkspaceRepo.findPendingInviteByToken(token),
  listPendingInvitesForWorkspace: (workspaceId, now) =>
    activeWorkspaceRepo.listPendingInvitesForWorkspace(workspaceId, now),
  listPendingInvitesForEmail: (email, now) =>
    activeWorkspaceRepo.listPendingInvitesForEmail(email, now),
  cancelInvite: (workspaceId, inviteId) =>
    activeWorkspaceRepo.cancelInvite(workspaceId, inviteId),
  acceptInviteTransaction: (token, userId, now) =>
    activeWorkspaceRepo.acceptInviteTransaction(token, userId, now),

  // 5. Workspace user handles
  listHandles: workspaceId => activeWorkspaceRepo.listHandles(workspaceId),
  insertHandlesBestEffort: (workspaceId, rows) =>
    activeWorkspaceRepo.insertHandlesBestEffort(workspaceId, rows),

  // 6. MCP OAuth clients
  findMcpClient: clientId => activeWorkspaceRepo.findMcpClient(clientId),
  createMcpClient: input => activeWorkspaceRepo.createMcpClient(input),
  ensureMcpClient: input => activeWorkspaceRepo.ensureMcpClient(input),

  // 7. MCP OAuth codes
  createMcpCode: input => activeWorkspaceRepo.createMcpCode(input),
  redeemMcpCodeOnce: (codeHash, now) =>
    activeWorkspaceRepo.redeemMcpCodeOnce(codeHash, now),

  // 8. MCP OAuth tokens
  createMcpToken: input => activeWorkspaceRepo.createMcpToken(input),
  findValidMcpTokenByAccessHash: (accessTokenHash, now) =>
    activeWorkspaceRepo.findValidMcpTokenByAccessHash(accessTokenHash, now),
  hasActiveMcpAgentSession: input =>
    activeWorkspaceRepo.hasActiveMcpAgentSession(input),
  rotateMcpRefreshToken: input =>
    activeWorkspaceRepo.rotateMcpRefreshToken(input),
  touchMcpTokenLastUsed: (tokenId, now, minIntervalMs) =>
    activeWorkspaceRepo.touchMcpTokenLastUsed(tokenId, now, minIntervalMs),
  listMcpConnections: (workspaceId, now) =>
    activeWorkspaceRepo.listMcpConnections(workspaceId, now),
  revokeMcpGrantsForMember: input =>
    activeWorkspaceRepo.revokeMcpGrantsForMember(input),
  revokeMcpConnection: input => activeWorkspaceRepo.revokeMcpConnection(input),

  // 9. ACP plan grants
  upsertAcpGrant: input => activeWorkspaceRepo.upsertAcpGrant(input),
  revokeAcpGrant: input => activeWorkspaceRepo.revokeAcpGrant(input),
  findActiveAcpGrant: input => activeWorkspaceRepo.findActiveAcpGrant(input),

  // 10. GitHub installations
  listGitHubInstallations: workspaceId =>
    activeWorkspaceRepo.listGitHubInstallations(workspaceId),
  findGitHubInstallation: (workspaceId, installationId) =>
    activeWorkspaceRepo.findGitHubInstallation(workspaceId, installationId),
  upsertGitHubInstallation: input =>
    activeWorkspaceRepo.upsertGitHubInstallation(input),
  deleteGitHubInstallation: (workspaceId, installationId) =>
    activeWorkspaceRepo.deleteGitHubInstallation(workspaceId, installationId),
  deleteGitHubInstallationsByInstallationId: installationId =>
    activeWorkspaceRepo.deleteGitHubInstallationsByInstallationId(
      installationId,
    ),
  pruneStaleGitHubInstallations: (
    workspaceId,
    accountLogin,
    keepInstallationId,
  ) =>
    activeWorkspaceRepo.pruneStaleGitHubInstallations(
      workspaceId,
      accountLogin,
      keepInstallationId,
    ),
};
