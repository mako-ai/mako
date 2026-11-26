/**
 * MongoDB (Mongoose) implementation of `AuthRepository`.
 */
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import {
  generateUuidv7,
  isUuidv7,
  legacyUserIdToUuidv7,
} from "../../database/pg/id-codec";
import {
  DesktopAuthCode,
  EmailVerification,
  OAuthAccount,
  Session,
  User,
  UserAttribution,
} from "../../database/schema";
import {
  coerceDate,
  deriveUserUuidv7,
  mongoAttributionToRecord,
  mongoDesktopAuthCodeToRecord,
  mongoEmailVerificationToRecord,
  mongoOAuthAccountToRecord,
  mongoSessionToRecord,
  mongoUserToRecord,
  normalizeEmailKey,
  normalizeOnboarding,
  normalizeWorkspaceWireId,
  oauthIdToMongoHex,
  sanitizeTouchPayload,
  type MongoAttributionLike,
  type MongoDesktopAuthCodeLike,
  type MongoEmailVerificationLike,
  type MongoOAuthAccountLike,
  type MongoSessionLike,
  type MongoUserLike,
} from "./mapper";
import type {
  AuthRepository,
  CreateDesktopAuthCodeInput,
  CreateEmailVerificationInput,
  CreateOAuthAccountInput,
  CreateSessionInput,
  CreateUserInput,
  DesktopAuthCodeRecord,
  EmailVerificationRecord,
  EmailVerificationType,
  OAuthAccountRecord,
  OAuthProviderName,
  SessionRecord,
  UpdateUserInput,
  UpsertAttributionOnceInput,
  UserAttributionRecord,
  UserRecord,
} from "./types";

export class MongoAuthRepository implements AuthRepository {
  // ── Users ───────────────────────────────────────────────────────────────

  async findUserById(idOrLegacyId: string): Promise<UserRecord | null> {
    if (!idOrLegacyId) return null;
    const doc = await User.findById(idOrLegacyId).lean<MongoUserLike | null>();
    return doc ? mongoUserToRecord(doc) : null;
  }

  async findUsersByIds(ids: readonly string[]): Promise<UserRecord[]> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return [];
    const docs = await User.find({ _id: { $in: unique } }).lean<
      MongoUserLike[]
    >();
    return docs.map(mongoUserToRecord);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const normalized = normalizeEmailKey(email);
    if (!normalized) return null;
    const doc = await User.findOne({
      email: normalized,
    }).lean<MongoUserLike | null>();
    return doc ? mongoUserToRecord(doc) : null;
  }

  async findUsersByEmails(emails: readonly string[]): Promise<UserRecord[]> {
    const unique = [
      ...new Set(emails.map(normalizeEmailKey).filter(Boolean)),
    ];
    if (unique.length === 0) return [];
    const docs = await User.find({ email: { $in: unique } }).lean<
      MongoUserLike[]
    >();
    return docs.map(mongoUserToRecord);
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = input.createdAt ?? new Date();
    const id =
      input.id ??
      (input.createdAt
        ? generateUuidv7(input.createdAt.getTime())
        : generateUuidv7());
    const updatedAt = input.updatedAt ?? now;
    const onboarding = normalizeOnboarding(input.onboarding);

    const created = await User.create({
      _id: id,
      email: normalizeEmailKey(input.email),
      ...(input.hashedPassword !== undefined
        ? { hashedPassword: input.hashedPassword }
        : {}),
      emailVerified: input.emailVerified ?? false,
      ...(onboarding ? { onboarding } : {}),
      createdAt: now,
      updatedAt,
    });

    if (input.name !== undefined && input.name.length > 0) {
      await User.updateOne(
        { _id: id },
        { $set: { name: input.name } },
        { strict: false, timestamps: false },
      );
      const reloaded = await User.findById(id).lean<MongoUserLike | null>();
      if (reloaded) {
        return mongoUserToRecord(reloaded);
      }
    }

    return mongoUserToRecord(created.toObject() as unknown as MongoUserLike);
  }

  async updateUser(
    idOrLegacyId: string,
    patch: UpdateUserInput,
  ): Promise<UserRecord | null> {
    const $set: Record<string, unknown> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };
    const $unset: Record<string, ""> = {};

    if (patch.emailVerified !== undefined) {
      $set.emailVerified = patch.emailVerified;
    }
    if (patch.name === null) {
      $unset.name = "";
    } else if (patch.name !== undefined) {
      $set.name = patch.name;
    }
    if (patch.hashedPassword === null) {
      $unset.hashedPassword = "";
    } else if (patch.hashedPassword !== undefined) {
      $set.hashedPassword = patch.hashedPassword;
    }
    if (patch.onboarding !== undefined) {
      if (patch.onboarding.completedAt !== undefined) {
        $set["onboarding.completedAt"] = patch.onboarding.completedAt;
      }
      if (patch.onboarding.companySize !== undefined) {
        $set["onboarding.companySize"] = patch.onboarding.companySize;
      }
      if (patch.onboarding.role !== undefined) {
        $set["onboarding.role"] = patch.onboarding.role;
      }
      if (patch.onboarding.primaryDatabase !== undefined) {
        $set["onboarding.primaryDatabase"] = patch.onboarding.primaryDatabase;
      }
      if (patch.onboarding.dataWarehouse !== undefined) {
        $set["onboarding.dataWarehouse"] = patch.onboarding.dataWarehouse;
      }
    }

    const updateDoc: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) {
      updateDoc.$unset = $unset;
    }

    const updated = await User.findByIdAndUpdate(idOrLegacyId, updateDoc, {
      new: true,
      timestamps: false,
      strict: false,
    }).lean<MongoUserLike | null>();
    return updated ? mongoUserToRecord(updated) : null;
  }

  async resolveUserUuid(idOrLegacyId: string): Promise<string | null> {
    if (!idOrLegacyId) return null;
    const doc = await User.findById(idOrLegacyId)
      .select("_id createdAt")
      .lean<{ _id: string; createdAt?: Date | string } | null>();
    if (!doc) return null;
    return deriveUserUuidv7(String(doc._id), coerceDate(doc.createdAt));
  }

  async getUserLegacyIdMap(): Promise<Map<string, string>> {
    const docs = await User.find({})
      .select("_id createdAt")
      .lean<Array<{ _id: string; createdAt?: Date | string }>>();
    const map = new Map<string, string>();
    for (const doc of docs) {
      const legacyId = String(doc._id);
      if (!isUuidv7(legacyId)) {
        map.set(legacyId, legacyUserIdToUuidv7(legacyId, coerceDate(doc.createdAt)));
      }
    }
    return map;
  }

  /** Idempotent full-record upsert used by Stage 4 reverse sync-retry replay. */
  async upsertUserFromRecord(record: UserRecord): Promise<void> {
    const mongoId = record.legacyId ?? record.id;
    const onboarding = normalizeOnboarding(record.onboarding);
    const $set: Record<string, unknown> = {
      email: normalizeEmailKey(record.email),
      emailVerified: record.emailVerified,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    const $unset: Record<string, ""> = {};

    if (record.name !== undefined && record.name.length > 0) {
      $set.name = record.name;
    } else {
      $unset.name = "";
    }
    if (record.hashedPassword !== undefined) {
      $set.hashedPassword = record.hashedPassword;
    } else {
      $unset.hashedPassword = "";
    }
    if (onboarding) {
      $set.onboarding = onboarding;
    } else {
      $unset.onboarding = "";
    }

    const updateDoc: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) {
      updateDoc.$unset = $unset;
    }

    await User.updateOne({ _id: mongoId }, updateDoc, {
      upsert: true,
      timestamps: false,
      strict: false,
    });
  }

  // ── User attributions ───────────────────────────────────────────────────

  async upsertAttributionOnce(input: UpsertAttributionOnceInput): Promise<void> {
    const $setOnInsert: Record<string, unknown> = {
      _id: input.userId,
      signupMethod: input.signupMethod,
      firstTouch: sanitizeTouchPayload(input.firstTouch),
      lastTouch: sanitizeTouchPayload(input.lastTouch),
      capturedAt: input.capturedAt ?? new Date(),
    };
    if (input.sid !== undefined) $setOnInsert.sid = input.sid;
    if (input.gclid !== undefined) $setOnInsert.gclid = input.gclid;
    if (input.country !== undefined) $setOnInsert.country = input.country;

    await UserAttribution.updateOne(
      { _id: input.userId },
      { $setOnInsert },
      { upsert: true },
    );
  }

  async findAttributionByUserId(
    userId: string,
  ): Promise<UserAttributionRecord | null> {
    if (!userId) return null;
    const doc = await UserAttribution.findById(
      userId,
    ).lean<MongoAttributionLike | null>();
    return doc ? mongoAttributionToRecord(doc) : null;
  }

  // ── OAuth accounts ──────────────────────────────────────────────────────

  async findOAuthAccountByProvider(
    provider: OAuthProviderName,
    providerUserId: string,
  ): Promise<OAuthAccountRecord | null> {
    const doc = await OAuthAccount.findOne({
      provider,
      providerUserId,
    }).lean<MongoOAuthAccountLike | null>();
    return doc ? mongoOAuthAccountToRecord(doc) : null;
  }

  async findOAuthAccountsByUserId(
    userId: string,
  ): Promise<OAuthAccountRecord[]> {
    if (!userId) return [];
    const docs = await OAuthAccount.find({ userId }).lean<
      MongoOAuthAccountLike[]
    >();
    return docs.map(mongoOAuthAccountToRecord);
  }

  async findOAuthAccountsByUserIds(
    userIds: readonly string[],
  ): Promise<OAuthAccountRecord[]> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return [];
    const docs = await OAuthAccount.find({
      userId: { $in: unique },
    }).lean<MongoOAuthAccountLike[]>();
    return docs.map(mongoOAuthAccountToRecord);
  }

  async createOAuthAccount(
    input: CreateOAuthAccountInput,
  ): Promise<OAuthAccountRecord> {
    const createdAt = input.createdAt ?? new Date();
    const docPayload: Record<string, unknown> = {
      userId: input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      createdAt,
    };
    if (input.id) {
      docPayload._id = new Types.ObjectId(oauthIdToMongoHex(input.id));
    }
    if (input.email !== undefined) {
      docPayload.email = input.email;
    }

    const created = await OAuthAccount.create(docPayload);
    return mongoOAuthAccountToRecord(
      created.toObject() as unknown as MongoOAuthAccountLike,
    );
  }

  /** Idempotent upsert used by Stage 4 reverse sync-retry replay. */
  async upsertOAuthAccountFromRecord(
    record: OAuthAccountRecord,
    mongoUserId: string = record.userId,
  ): Promise<void> {
    const oid = new Types.ObjectId(oauthIdToMongoHex(record.id));
    const $setOnInsert: Record<string, unknown> = {
      _id: oid,
      userId: mongoUserId,
      provider: record.provider,
      providerUserId: record.providerUserId,
      createdAt: record.createdAt,
    };
    if (record.email !== undefined) {
      $setOnInsert.email = record.email;
    }
    await OAuthAccount.updateOne(
      { provider: record.provider, providerUserId: record.providerUserId },
      { $setOnInsert },
      { upsert: true },
    );
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const activeWorkspaceId = normalizeWorkspaceWireId(input.activeWorkspaceId);
    const created = await Session.create({
      _id: input.id,
      userId: input.userId,
      expiresAt: input.expiresAt,
      ...(activeWorkspaceId !== undefined ? { activeWorkspaceId } : {}),
    });
    return mongoSessionToRecord(
      created.toObject() as unknown as MongoSessionLike,
    );
  }

  async findSessionById(sessionId: string): Promise<SessionRecord | null> {
    if (!sessionId) return null;
    const doc = await Session.findById(sessionId).lean<MongoSessionLike | null>();
    return doc ? mongoSessionToRecord(doc) : null;
  }

  async updateSessionExpiry(sessionId: string, expiresAt: Date): Promise<void> {
    await Session.updateOne({ _id: sessionId }, { $set: { expiresAt } });
  }

  async updateSessionActiveWorkspace(
    sessionId: string,
    activeWorkspaceId: string | null,
  ): Promise<void> {
    const normalized = normalizeWorkspaceWireId(activeWorkspaceId);
    if (normalized === undefined) {
      await Session.updateOne(
        { _id: sessionId },
        { $unset: { activeWorkspaceId: "" } },
      );
      return;
    }
    await Session.updateOne(
      { _id: sessionId },
      { $set: { activeWorkspaceId: normalized } },
    );
  }

  async setActiveWorkspaceForUser(
    userId: string,
    activeWorkspaceId: string | null,
  ): Promise<void> {
    const normalized = normalizeWorkspaceWireId(activeWorkspaceId);
    if (normalized === undefined) {
      await Session.updateMany(
        { userId },
        { $unset: { activeWorkspaceId: "" } },
      );
      return;
    }
    await Session.updateMany(
      { userId },
      { $set: { activeWorkspaceId: normalized } },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await Session.deleteOne({ _id: sessionId });
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await Session.deleteMany({ userId });
  }

  async deleteExpiredSessions(now: Date = new Date()): Promise<number> {
    const result = await Session.deleteMany({ expiresAt: { $lte: now } });
    return result.deletedCount;
  }

  // ── Email verifications ─────────────────────────────────────────────────

  async createEmailVerification(
    input: CreateEmailVerificationInput,
  ): Promise<EmailVerificationRecord> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const created = await EmailVerification.create({
      _id: id,
      email: normalizeEmailKey(input.email),
      code: input.code,
      type: input.type,
      expiresAt: input.expiresAt,
      createdAt,
    });
    return mongoEmailVerificationToRecord(
      created.toObject() as unknown as MongoEmailVerificationLike,
    );
  }

  async findValidEmailVerification(
    email: string,
    code: string,
    type: EmailVerificationType,
    now: Date = new Date(),
  ): Promise<EmailVerificationRecord | null> {
    const doc = await EmailVerification.findOne({
      email: normalizeEmailKey(email),
      code,
      type,
      expiresAt: { $gt: now },
    }).lean<MongoEmailVerificationLike | null>();
    return doc ? mongoEmailVerificationToRecord(doc) : null;
  }

  async deleteEmailVerificationById(id: string): Promise<void> {
    await EmailVerification.deleteOne({ _id: id });
  }

  async deleteEmailVerificationsByEmailAndType(
    email: string,
    type: EmailVerificationType,
  ): Promise<void> {
    await EmailVerification.deleteMany({
      email: normalizeEmailKey(email),
      type,
    });
  }

  /** Idempotent upsert used by Stage 4 reverse sync-retry replay. */
  async upsertEmailVerificationFromRecord(
    record: EmailVerificationRecord,
  ): Promise<void> {
    await EmailVerification.updateOne(
      { _id: record.id },
      {
        $set: {
          email: normalizeEmailKey(record.email),
          code: record.code,
          type: record.type,
          expiresAt: record.expiresAt,
          createdAt: record.createdAt,
        },
      },
      { upsert: true },
    );
  }

  // ── Desktop auth codes ──────────────────────────────────────────────────

  async createDesktopAuthCode(
    input: CreateDesktopAuthCodeInput,
  ): Promise<DesktopAuthCodeRecord> {
    const createdAt = input.createdAt ?? new Date();
    const created = await DesktopAuthCode.create({
      _id: input.id,
      userId: input.userId,
      challenge: input.challenge,
      expiresAt: input.expiresAt,
      createdAt,
    });
    return mongoDesktopAuthCodeToRecord(
      created.toObject() as unknown as MongoDesktopAuthCodeLike,
    );
  }

  async redeemAndDeleteDesktopAuthCode(
    codeHash: string,
  ): Promise<DesktopAuthCodeRecord | null> {
    const doc = await DesktopAuthCode.findOneAndDelete({
      _id: codeHash,
    }).lean<MongoDesktopAuthCodeLike | null>();
    return doc ? mongoDesktopAuthCodeToRecord(doc) : null;
  }

  /** Idempotent upsert used by Stage 4 reverse sync-retry replay. */
  async upsertDesktopAuthCodeFromRecord(
    record: DesktopAuthCodeRecord,
    mongoUserId: string = record.userId,
  ): Promise<void> {
    await DesktopAuthCode.updateOne(
      { _id: record.id },
      {
        $set: {
          userId: mongoUserId,
          challenge: record.challenge,
          expiresAt: record.expiresAt,
          createdAt: record.createdAt,
        },
      },
      { upsert: true },
    );
  }
}
