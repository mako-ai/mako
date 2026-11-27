/**
 * Store-agnostic DTOs and repository contract for the Phase 1A `auth` domain (Decision #3).
 *
 * Covers:
 *   - users (`id` UUIDv7 PK + `legacyId` text UNIQUE for backfill & reference rewriting)
 *   - user_attributions (`userId` UUID PK/FK)
 *   - oauth_accounts (`id` UUIDv8 PK, `userId` UUID FK)
 *   - sessions (`tokenHash = sha256(rawToken)` PK in Postgres; starts empty on cutover)
 *   - email_verifications (`id` UUIDv4 text PK)
 *   - desktop_auth_codes (`id` SHA-256 base64url text PK, `userId` UUID FK)
 */
import type {
  EmailVerificationType,
  OAuthProviderName,
  OnboardingCompanySize,
  SignupMethod,
} from "../../database/pg/schema/auth";

export type {
  EmailVerificationType,
  OAuthProviderName,
  OnboardingCompanySize,
  SignupMethod,
};

export interface UserOnboarding {
  completedAt?: Date;
  companySize?: OnboardingCompanySize;
  role?: string;
  primaryDatabase?: string;
  dataWarehouse?: string;
}

export interface UserRecord {
  /** Primary user identifier (UUIDv7 in Postgres; legacy ID or UUIDv7 in Mongo). */
  id: string;
  /** Compatibility alias mirroring `id` for callers expecting Mongoose `_id`. */
  _id: string;
  /** Legacy Mongo `_id` (15-char Lucia ID, legacy UUIDv4, or equal to `id` for new UUIDv7 users). */
  legacyId?: string;
  email: string;
  /** Optional legacy display name (used by git commit author attribution). */
  name?: string;
  hashedPassword?: string;
  emailVerified: boolean;
  onboarding?: UserOnboarding;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserAttributionRecord {
  userId: string;
  sid?: string;
  gclid?: string;
  signupMethod: SignupMethod;
  country?: string;
  firstTouch: Record<string, unknown>;
  lastTouch: Record<string, unknown>;
  capturedAt: Date;
}

export interface OAuthAccountRecord {
  /** Wire-compatible 24-hex ObjectId (or native UUID post-migration). */
  id: string;
  userId: string;
  provider: OAuthProviderName;
  providerUserId: string;
  email?: string;
  createdAt: Date;
}

export interface SessionRecord {
  /** Raw cookie session token (held only in the `auth_session` cookie; Postgres stores only `tokenHash`). */
  id: string;
  /** SHA-256 hex digest of `id` when backed by Postgres hashed-token sessions. */
  tokenHash?: string;
  userId: string;
  expiresAt: Date;
  activeWorkspaceId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface EmailVerificationRecord {
  id: string;
  email: string;
  code: string;
  type: EmailVerificationType;
  expiresAt: Date;
  createdAt: Date;
}

export interface DesktopAuthCodeRecord {
  /** SHA-256 base64url hash of the raw desktop auth code. */
  id: string;
  userId: string;
  challenge: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateUserInput {
  id?: string;
  legacyId?: string;
  email: string;
  name?: string;
  hashedPassword?: string;
  emailVerified?: boolean;
  onboarding?: UserOnboarding;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateUserInput {
  emailVerified?: boolean;
  /** Pass `null` to explicitly clear the legacy display name. */
  name?: string | null;
  /** Pass `null` to explicitly clear the password (e.g. OAuth takeover guard). */
  hashedPassword?: string | null;
  onboarding?: UserOnboarding;
  updatedAt?: Date;
}

export interface UpsertAttributionOnceInput {
  userId: string;
  sid?: string;
  gclid?: string;
  signupMethod: SignupMethod;
  country?: string;
  firstTouch: Record<string, unknown>;
  lastTouch: Record<string, unknown>;
  capturedAt?: Date;
}

export interface CreateOAuthAccountInput {
  id?: string;
  userId: string;
  provider: OAuthProviderName;
  providerUserId: string;
  email?: string;
  createdAt?: Date;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  expiresAt: Date;
  activeWorkspaceId?: string;
}

export interface CreateEmailVerificationInput {
  id?: string;
  email: string;
  code: string;
  type: EmailVerificationType;
  expiresAt: Date;
  createdAt?: Date;
}

export interface CreateDesktopAuthCodeInput {
  /** SHA-256 base64url hash of the raw code. */
  id: string;
  userId: string;
  challenge: string;
  expiresAt: Date;
  createdAt?: Date;
}

export interface AuthRepository {
  // Users
  findUserById(idOrLegacyId: string): Promise<UserRecord | null>;
  findUsersByIds(ids: readonly string[]): Promise<UserRecord[]>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUsersByEmails(emails: readonly string[]): Promise<UserRecord[]>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  updateUser(
    idOrLegacyId: string,
    patch: UpdateUserInput,
  ): Promise<UserRecord | null>;

  // User ID resolution helpers for downstream migration domains & reference rewriting
  resolveUserUuid(idOrLegacyId: string): Promise<string | null>;
  getUserLegacyIdMap(): Promise<Map<string, string>>;

  // User attributions (write-once)
  upsertAttributionOnce(input: UpsertAttributionOnceInput): Promise<void>;
  findAttributionByUserId(
    userId: string,
  ): Promise<UserAttributionRecord | null>;

  // OAuth accounts
  findOAuthAccountByProvider(
    provider: OAuthProviderName,
    providerUserId: string,
  ): Promise<OAuthAccountRecord | null>;
  findOAuthAccountsByUserId(userId: string): Promise<OAuthAccountRecord[]>;
  findOAuthAccountsByUserIds(
    userIds: readonly string[],
  ): Promise<OAuthAccountRecord[]>;
  createOAuthAccount(
    input: CreateOAuthAccountInput,
  ): Promise<OAuthAccountRecord>;

  // Sessions (Mongo-only in Stages 1–3; PG hashed-token-only in Stages 4–5)
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findSessionById(sessionId: string): Promise<SessionRecord | null>;
  updateSessionExpiry(
    sessionId: string,
    expiresAt: Date,
    userId?: string,
  ): Promise<void>;
  updateSessionActiveWorkspace(
    sessionId: string,
    activeWorkspaceId: string | null,
    userId?: string,
  ): Promise<void>;
  setActiveWorkspaceForUser(
    userId: string,
    activeWorkspaceId: string | null,
  ): Promise<void>;
  deleteSession(sessionId: string, userId?: string): Promise<void>;
  deleteUserSessions(userId: string): Promise<void>;
  deleteExpiredSessions(now?: Date): Promise<number>;

  // Email verifications
  createEmailVerification(
    input: CreateEmailVerificationInput,
  ): Promise<EmailVerificationRecord>;
  findValidEmailVerification(
    email: string,
    code: string,
    type: EmailVerificationType,
    now?: Date,
  ): Promise<EmailVerificationRecord | null>;
  deleteEmailVerificationById(id: string): Promise<void>;
  deleteEmailVerificationsByEmailAndType(
    email: string,
    type: EmailVerificationType,
  ): Promise<void>;

  // Desktop auth codes (atomic single-use)
  createDesktopAuthCode(
    input: CreateDesktopAuthCodeInput,
  ): Promise<DesktopAuthCodeRecord>;
  redeemAndDeleteDesktopAuthCode(
    codeHash: string,
  ): Promise<DesktopAuthCodeRecord | null>;
}
