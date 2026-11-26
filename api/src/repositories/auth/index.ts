/**
 * Auth domain repository entry point.
 *
 * Exports the singleton `authRepo` (backed by `DualAuthRepository`, defaulting to
 * `mongo_only` until `migration_domain_state` advances `auth`) plus test override
 * hooks and concrete repository classes.
 */
import { DualAuthRepository } from "./dual.repo";
import type { AuthRepository } from "./types";

export * from "./types";
export * from "./mapper";
export { MongoAuthRepository } from "./mongo.repo";
export { PgAuthRepository } from "./pg.repo";
export {
  AUTH_SHADOW_OPTIONS,
  DualAuthRepository,
  type DualAuthRepositoryDeps,
} from "./dual.repo";

const defaultAuthRepo: AuthRepository = new DualAuthRepository();
let activeAuthRepo: AuthRepository = defaultAuthRepo;

export function getAuthRepo(): AuthRepository {
  return activeAuthRepo;
}

export function setAuthRepoForTests(repo: AuthRepository): void {
  activeAuthRepo = repo;
}

export function resetAuthRepoForTests(): void {
  activeAuthRepo = defaultAuthRepo;
}

/**
 * Delegating proxy singleton so callers importing `authRepo` directly automatically
 * observe `setAuthRepoForTests()` / `resetAuthRepoForTests()` overrides.
 */
export const authRepo: AuthRepository = {
  findUserById: idOrLegacyId => activeAuthRepo.findUserById(idOrLegacyId),
  findUsersByIds: ids => activeAuthRepo.findUsersByIds(ids),
  findUserByEmail: email => activeAuthRepo.findUserByEmail(email),
  findUsersByEmails: emails => activeAuthRepo.findUsersByEmails(emails),
  createUser: input => activeAuthRepo.createUser(input),
  updateUser: (idOrLegacyId, patch) =>
    activeAuthRepo.updateUser(idOrLegacyId, patch),

  resolveUserUuid: idOrLegacyId => activeAuthRepo.resolveUserUuid(idOrLegacyId),
  getUserLegacyIdMap: () => activeAuthRepo.getUserLegacyIdMap(),

  upsertAttributionOnce: input => activeAuthRepo.upsertAttributionOnce(input),
  findAttributionByUserId: userId =>
    activeAuthRepo.findAttributionByUserId(userId),

  findOAuthAccountByProvider: (provider, providerUserId) =>
    activeAuthRepo.findOAuthAccountByProvider(provider, providerUserId),
  findOAuthAccountsByUserId: userId =>
    activeAuthRepo.findOAuthAccountsByUserId(userId),
  findOAuthAccountsByUserIds: userIds =>
    activeAuthRepo.findOAuthAccountsByUserIds(userIds),
  createOAuthAccount: input => activeAuthRepo.createOAuthAccount(input),

  createSession: input => activeAuthRepo.createSession(input),
  findSessionById: sessionId => activeAuthRepo.findSessionById(sessionId),
  updateSessionExpiry: (sessionId, expiresAt, userId) =>
    activeAuthRepo.updateSessionExpiry(sessionId, expiresAt, userId),
  updateSessionActiveWorkspace: (sessionId, activeWorkspaceId, userId) =>
    activeAuthRepo.updateSessionActiveWorkspace(
      sessionId,
      activeWorkspaceId,
      userId,
    ),
  setActiveWorkspaceForUser: (userId, activeWorkspaceId) =>
    activeAuthRepo.setActiveWorkspaceForUser(userId, activeWorkspaceId),
  deleteSession: (sessionId, userId) =>
    activeAuthRepo.deleteSession(sessionId, userId),
  deleteUserSessions: userId => activeAuthRepo.deleteUserSessions(userId),
  deleteExpiredSessions: now => activeAuthRepo.deleteExpiredSessions(now),

  createEmailVerification: input =>
    activeAuthRepo.createEmailVerification(input),
  findValidEmailVerification: (email, code, type, now) =>
    activeAuthRepo.findValidEmailVerification(email, code, type, now),
  deleteEmailVerificationById: id =>
    activeAuthRepo.deleteEmailVerificationById(id),
  deleteEmailVerificationsByEmailAndType: (email, type) =>
    activeAuthRepo.deleteEmailVerificationsByEmailAndType(email, type),

  createDesktopAuthCode: input => activeAuthRepo.createDesktopAuthCode(input),
  redeemAndDeleteDesktopAuthCode: codeHash =>
    activeAuthRepo.redeemAndDeleteDesktopAuthCode(codeHash),
};
