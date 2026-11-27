/**
 * 5-stage workspace-scoped dual-run `ChatRepository` powered by `MigrationRouter` (`domain = "chat"`).
 *
 * Key invariants:
 *   - Default rollout mode is `mongo_only` (zero Postgres calls when unconfigured).
 *   - Stage 2–3 deletes record tombstones in `migration_tombstones` (`chats` &
 *     `chat_attachments`) so in-flight backfill cannot resurrect deleted chats.
 *   - Stage 4 (`dual_write_pg_read`) writes to PG primary first, then reverse-syncs
 *     a full repacked Mongo document (preserving `mongoBsonRetryMessages` strictly on
 *     the Mongo secondary path) so instant Stage 4->2 rollback loses zero data.
 *   - Redacts message bodies, parts, prompts, and checkpoints in shadow-compare logs.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import {
  getPgDb,
  hasPostgresConfig,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  isUuidString,
  newDualId,
  parseEntityId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  isMigrationForceMongoOnly,
  migrationRouter,
  recordMigrationTombstone,
  type MigrationRouter,
} from "../../migration/router";
import type { ShadowCompareOptions } from "../../migration/types";
import { canonicalizeChatForCompare } from "./mapper";
import { MongoChatRepository } from "./mongo.repo";
import { PgChatRepository } from "./pg.repo";
import type {
  AppChatListEntry,
  ChatAttachmentRecord,
  ChatListEntry,
  ChatLocalAcp,
  ChatOwnershipMeta,
  ChatRecord,
  ChatRepository,
  CreateChatAttachmentInput,
  CreateChatInput,
  EnsureChatExistsInput,
  SaveChatMessagesInput,
  StoredChatMessage,
  UpdateChatThreadPatch,
} from "./types";

export const CHAT_DOMAIN = "chat" as const;

export const CHAT_SHADOW_OPTIONS: ShadowCompareOptions = {
  redactKeys: [
    "messages",
    "parts",
    "content",
    "reasoning",
    "turnCheckpoint",
    "turn_checkpoint",
    "systemPrompt",
    "system_prompt",
    "workspacePrompt",
    "workspace_prompt",
  ],
};

export interface DualChatRepositoryDeps {
  mongo?: MongoChatRepository;
  pg?: PgChatRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
  hasPg?: () => boolean;
  isForceMongoOnly?: () => boolean;
}

export class DualChatRepository implements ChatRepository {
  readonly mongo: MongoChatRepository;
  readonly pg: PgChatRepository;
  private readonly router: MigrationRouter;
  private readonly getDb: () => MakoPgDb;
  private readonly hasPg: () => boolean;
  private readonly isForceMongoOnly: () => boolean;

  constructor(deps: DualChatRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoChatRepository();
    this.pg = deps.pg ?? new PgChatRepository({ getDb: deps.getDb });
    this.router = deps.router ?? migrationRouter;
    this.getDb = deps.getDb ?? getPgDb;
    this.hasPg = deps.hasPg ?? hasPostgresConfig;
    this.isForceMongoOnly = deps.isForceMongoOnly ?? isMigrationForceMongoOnly;
  }

  private async isMongoPrimaryDualWrite(
    workspaceId?: string,
  ): Promise<boolean> {
    const mode = (await this.router.getState(CHAT_DOMAIN, workspaceId)).mode;
    return (
      mode === "dual_write_mongo_read" || mode === "dual_write_shadow_compare"
    );
  }

  private async isPgPrimaryMode(workspaceId?: string): Promise<boolean> {
    const mode = (await this.router.getState(CHAT_DOMAIN, workspaceId)).mode;
    return mode === "dual_write_pg_read" || mode === "pg_only";
  }

  private async recordTombstone(
    tableName: string,
    wireId: string,
  ): Promise<void> {
    const uuid = parseEntityId(wireId)?.uuid;
    if (!uuid) return;
    await recordMigrationTombstone(tableName, uuid, this.getDb());
  }

  /** Map a PG user UUID back to its Mongo `_id` (`legacy_id`) for Stage 4 reverse sync. */
  private async resolveMongoUserIdForReverseSync(
    userId: string | null,
  ): Promise<string | null> {
    if (
      !userId ||
      !isUuidString(userId) ||
      !this.hasPg() ||
      this.isForceMongoOnly()
    ) {
      return userId;
    }
    const db = this.getDb();
    const rows = await db
      .select({ legacyId: users.legacyId })
      .from(users)
      .where(or(eq(users.id, userId.toLowerCase()), eq(users.legacyId, userId)))
      .limit(1);
    return rows[0]?.legacyId ?? userId;
  }

  /**
   * Populate `userMap` (`legacyId -> uuid` and `uuid -> uuid`) off the request
   * critical path — called ONLY inside the background shadow-read branch so
   * unsampled reads incur ZERO extra Postgres queries.
   */
  private async populateShadowUserMap(
    userMap: Map<string, string>,
    rawIds: Iterable<string | null | undefined>,
  ): Promise<void> {
    if (!this.hasPg() || this.isForceMongoOnly()) return;
    const uuids: string[] = [];
    const legacyIds: string[] = [];
    for (const raw of rawIds) {
      if (!raw || raw === "system") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (isUuidString(trimmed)) {
        uuids.push(trimmed.toLowerCase());
      } else {
        legacyIds.push(trimmed);
      }
    }
    if (uuids.length === 0 && legacyIds.length === 0) return;

    const predicates = [];
    if (uuids.length > 0) predicates.push(inArray(users.id, uuids));
    if (legacyIds.length > 0) {
      predicates.push(inArray(users.legacyId, legacyIds));
    }
    const where = predicates.length === 1 ? predicates[0] : or(...predicates);
    if (!where) return;

    const rows = await this.getDb()
      .select({ id: users.id, legacyId: users.legacyId })
      .from(users)
      .where(where);
    for (const row of rows) {
      const canonical = row.id.toLowerCase();
      userMap.set(row.id, canonical);
      userMap.set(canonical, canonical);
      if (row.legacyId) {
        userMap.set(row.legacyId, canonical);
      }
    }
  }

  // ── Chat lifecycle & reads ───────────────────────────────────────────────

  async create(input: CreateChatInput): Promise<ChatRecord> {
    const id = input.id ?? newDualId().oid;
    const now = input.createdAt ?? new Date();
    const withId: CreateChatInput = {
      ...input,
      id,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };
    let primaryRecord: ChatRecord | null = null;

    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "create",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          entity: "chats",
          workspaceId: input.workspaceId,
          chatId: id,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoCreator = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.createdBy,
            );
            await this.mongo.upsertFullRecord({
              ...primaryRecord,
              createdBy: mongoCreator,
            });
            return primaryRecord;
          }
          primaryRecord = await this.mongo.create(withId);
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            const createdByUuid = await this.pg.resolveUserUuid(
              primaryRecord.createdBy,
            );
            await this.pg.upsertFullChatWithGuard(primaryRecord, createdByUuid);
            return primaryRecord;
          }
          primaryRecord = await this.pg.create(withId);
          return primaryRecord;
        },
      },
    );
  }

  async ensureExists(input: EnsureChatExistsInput): Promise<void> {
    const now = input.now ?? new Date();
    const threadId = input.threadId ?? randomUUID();
    const pgPrimary = await this.isPgPrimaryMode(input.workspaceId);
    const normalized: EnsureChatExistsInput = {
      ...input,
      threadId,
      now,
    };

    await this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "ensureExists",
        workspaceId: input.workspaceId,
        entityId: input.id,
        retryPayload: {
          entity: "chats",
          workspaceId: input.workspaceId,
          chatId: input.id,
        },
      },
      {
        mongo: async () => {
          const mongoCreator = pgPrimary
            ? await this.resolveMongoUserIdForReverseSync(normalized.createdBy)
            : normalized.createdBy;
          await this.mongo.ensureExists({
            ...normalized,
            createdBy: mongoCreator,
          });
        },
        pg: () => this.pg.ensureExists(normalized),
      },
    );
  }

  async findById(
    chatId: string,
    workspaceId?: string,
  ): Promise<ChatRecord | null> {
    if (workspaceId !== undefined) {
      const shadowUserMap = new Map<string, string>();
      const collectedUserIds = new Set<string>();
      let mongoRan = false;
      let pgRan = false;
      const resolveShadowUser = (id: string | null): string | null =>
        id
          ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
          : null;

      return this.router.executeRead(
        {
          domain: CHAT_DOMAIN,
          operation: "findById",
          workspaceId,
          entityId: chatId,
        },
        {
          mongo: async () => {
            const res = await this.mongo.findById(chatId, workspaceId);
            if (res?.createdBy) collectedUserIds.add(res.createdBy);
            mongoRan = true;
            if (pgRan) {
              await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
            }
            return res;
          },
          pg: async () => {
            const res = await this.pg.findById(chatId, workspaceId);
            if (res?.createdBy) collectedUserIds.add(res.createdBy);
            pgRan = true;
            if (mongoRan) {
              await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
            }
            return res;
          },
          canonicalize: r => canonicalizeChatForCompare(r, resolveShadowUser),
          shadowOptions: CHAT_SHADOW_OPTIONS,
        },
      );
    }

    const globalState = await this.router.getState(CHAT_DOMAIN);
    if (globalState.mode === "pg_only") {
      return this.pg.findById(chatId);
    }
    if (globalState.mode === "dual_write_pg_read") {
      const fromPg = await this.pg.findById(chatId);
      if (fromPg) return fromPg;
      return this.mongo.findById(chatId);
    }
    const fromMongo = await this.mongo.findById(chatId);
    if (fromMongo) {
      const wsState = await this.router.getState(
        CHAT_DOMAIN,
        fromMongo.workspaceId,
      );
      if (wsState.mode === "dual_write_pg_read" || wsState.mode === "pg_only") {
        return this.pg.findById(chatId, fromMongo.workspaceId);
      }
      return fromMongo;
    }
    if (!this.isForceMongoOnly() && this.hasPg()) {
      return this.pg.findById(chatId);
    }
    return null;
  }

  async findOwnedById(
    workspaceId: string,
    chatId: string,
    userId: string,
  ): Promise<ChatRecord | null> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>([userId]);
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: CHAT_DOMAIN,
        operation: "findOwnedById",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          const res = await this.mongo.findOwnedById(
            workspaceId,
            chatId,
            mongoUser,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        pg: async () => {
          const res = await this.pg.findOwnedById(workspaceId, chatId, userId);
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        canonicalize: r => canonicalizeChatForCompare(r, resolveShadowUser),
        shadowOptions: CHAT_SHADOW_OPTIONS,
      },
    );
  }

  async findOwnershipMeta(
    workspaceId: string,
    chatId: string,
    actorUserId?: string,
  ): Promise<ChatOwnershipMeta | null> {
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    if (actorUserId) collectedUserIds.add(actorUserId);
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: CHAT_DOMAIN,
        operation: "findOwnershipMeta",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: async () => {
          const res = await this.mongo.findOwnershipMeta(
            workspaceId,
            chatId,
            actorUserId,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          let resolved = res;
          if (
            res &&
            actorUserId !== undefined &&
            !res.isOwnedByActor &&
            isUuidString(actorUserId) &&
            this.hasPg() &&
            !this.isForceMongoOnly()
          ) {
            const mongoActor =
              await this.resolveMongoUserIdForReverseSync(actorUserId);
            if (mongoActor && res.createdBy === mongoActor) {
              resolved = { ...res, isOwnedByActor: true };
            }
          }
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return resolved;
        },
        pg: async () => {
          const res = await this.pg.findOwnershipMeta(
            workspaceId,
            chatId,
            actorUserId,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        canonicalize: r =>
          r ? { ...r, createdBy: resolveShadowUser(r.createdBy) } : null,
        shadowOptions: CHAT_SHADOW_OPTIONS,
      },
    );
  }

  async listUserChats(input: {
    workspaceId: string;
    userId: string;
    limit: number;
    after?: { updatedAt: number | null; id: string } | null;
  }): Promise<{ chats: ChatListEntry[]; nextCursor: string | null }> {
    const pgPrimary = await this.isPgPrimaryMode(input.workspaceId);
    return this.router.executeRead(
      {
        domain: CHAT_DOMAIN,
        operation: "listUserChats",
        workspaceId: input.workspaceId,
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(input.userId)) ??
              input.userId)
            : input.userId;
          return this.mongo.listUserChats({ ...input, userId: mongoUser });
        },
        pg: () => this.pg.listUserChats(input),
        canonicalize: page => ({
          nextCursor: page.nextCursor,
          chats: page.chats.map(c => ({
            ...c,
            usage:
              c.usage &&
              ((c.usage.totalTokens ?? 0) > 0 || (c.usage.costUsd ?? 0) > 0)
                ? {
                    totalTokens: c.usage.totalTokens ?? 0,
                    costUsd: c.usage.costUsd ?? 0,
                  }
                : null,
          })),
        }),
        shadowOptions: CHAT_SHADOW_OPTIONS,
      },
    );
  }

  async listAppChats(
    workspaceId: string,
    appId: string,
    userId: string,
    limit = 50,
  ): Promise<AppChatListEntry[]> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    return this.router.executeRead(
      {
        domain: CHAT_DOMAIN,
        operation: "listAppChats",
        workspaceId,
        entityId: appId,
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          return this.mongo.listAppChats(workspaceId, appId, mongoUser, limit);
        },
        pg: () => this.pg.listAppChats(workspaceId, appId, userId, limit),
        shadowOptions: CHAT_SHADOW_OPTIONS,
      },
    );
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  async saveMessages(input: SaveChatMessagesInput): Promise<ChatRecord | null> {
    const now = input.now ?? new Date();
    const threadIdOnInsert = input.threadIdOnInsert ?? randomUUID();
    const normalizedInput: SaveChatMessagesInput = {
      ...input,
      now,
      threadIdOnInsert,
    };
    let primaryRecord: ChatRecord | null = null;

    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "saveMessages",
        workspaceId: input.workspaceId,
        entityId: input.chatId,
        retryPayload: {
          entity: "chats",
          workspaceId: input.workspaceId,
          chatId: input.chatId,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            // Stage 4 PG->Mongo full-doc repack reverse-sync for zero-data-loss rollback.
            const mongoCreator = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.createdBy,
            );
            await this.mongo.upsertFullRecord(
              { ...primaryRecord, createdBy: mongoCreator },
              input.mongoBsonRetryMessages,
            );
            return primaryRecord;
          }
          primaryRecord = await this.mongo.saveMessages(normalizedInput);
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            // Stage 2–3 Mongo->PG secondary write: sync full chat state + normalized parts.
            const createdByUuid = await this.pg.resolveUserUuid(
              primaryRecord.createdBy,
            );
            await this.pg.upsertFullChatWithGuard(primaryRecord, createdByUuid);
            return primaryRecord;
          }
          // Stage 4–5 PG primary write (never strips tool outputs; no 16MB BSON limit).
          primaryRecord = await this.pg.saveMessages(normalizedInput);
          return primaryRecord;
        },
      },
    );
  }

  async updateThreadFields(
    chatId: string,
    workspaceId: string | undefined,
    patch: UpdateChatThreadPatch,
  ): Promise<ChatRecord | null> {
    const now = patch.updatedAt ?? new Date();
    const patchWithTime: UpdateChatThreadPatch = { ...patch, updatedAt: now };
    let primaryRecord: ChatRecord | null = null;

    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "updateThreadFields",
        workspaceId,
        entityId: chatId,
        retryPayload: {
          entity: "chats",
          workspaceId,
          chatId,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoCreator = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.createdBy,
            );
            await this.mongo.upsertFullRecord({
              ...primaryRecord,
              createdBy: mongoCreator,
            });
            return primaryRecord;
          }
          primaryRecord = await this.mongo.updateThreadFields(
            chatId,
            workspaceId,
            patchWithTime,
          );
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            const createdByUuid = await this.pg.resolveUserUuid(
              primaryRecord.createdBy,
            );
            await this.pg.upsertFullChatWithGuard(primaryRecord, createdByUuid);
            return primaryRecord;
          }
          primaryRecord = await this.pg.updateThreadFields(
            chatId,
            workspaceId,
            patchWithTime,
          );
          return primaryRecord;
        },
      },
    );
  }

  async updateLocalAcp(
    workspaceId: string,
    chatId: string,
    userId: string,
    localAcp: ChatLocalAcp | null,
  ): Promise<boolean> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "updateLocalAcp",
        workspaceId,
        entityId: chatId,
        retryPayload: { entity: "chats", workspaceId, chatId },
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          return this.mongo.updateLocalAcp(
            workspaceId,
            chatId,
            mongoUser,
            localAcp,
          );
        },
        pg: () => this.pg.updateLocalAcp(workspaceId, chatId, userId, localAcp),
      },
    );
  }

  async updateTitle(
    workspaceId: string,
    chatId: string,
    userId: string,
    title: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "updateTitle",
        workspaceId,
        entityId: chatId,
        retryPayload: { entity: "chats", workspaceId, chatId },
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          return this.mongo.updateTitle(
            workspaceId,
            chatId,
            mongoUser,
            title,
            now,
          );
        },
        pg: () => this.pg.updateTitle(workspaceId, chatId, userId, title, now),
      },
    );
  }

  async setGeneratedTitleIfUnset(
    workspaceId: string,
    chatId: string,
    title: string,
  ): Promise<boolean> {
    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "setGeneratedTitleIfUnset",
        workspaceId,
        entityId: chatId,
        retryPayload: { entity: "chats", workspaceId, chatId },
      },
      {
        mongo: () =>
          this.mongo.setGeneratedTitleIfUnset(workspaceId, chatId, title),
        pg: () => this.pg.setGeneratedTitleIfUnset(workspaceId, chatId, title),
      },
    );
  }

  async deleteOwned(
    workspaceId: string,
    chatId: string,
    userId: string,
  ): Promise<{ deleted: boolean; deletedAttachmentKeys: string[] }> {
    const recordTombstones = await this.isMongoPrimaryDualWrite(workspaceId);
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    let primaryDeleted = false;

    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "deleteOwned",
        workspaceId,
        entityId: chatId,
        retryPayload: {
          entity: "chats",
          action: "delete",
          workspaceId,
          chatId,
          userId,
        },
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          const res = await this.mongo.deleteOwned(
            workspaceId,
            chatId,
            mongoUser,
          );
          if (!pgPrimary) {
            primaryDeleted = res.deleted;
          }
          return res;
        },
        pg: async () => {
          const res = await this.pg.deleteOwned(workspaceId, chatId, userId);
          if (recordTombstones && primaryDeleted) {
            await this.recordTombstone("chats", chatId);
          }
          return res;
        },
      },
    );
  }

  // ── Streaming & checkpointing ────────────────────────────────────────────

  async getStreamState(
    chatId: string,
    workspaceId?: string,
  ): Promise<{
    workspaceId: string;
    activeStreamId: string | null;
    activeStreamAliveAt: Date | null;
  } | null> {
    if (workspaceId !== undefined) {
      return this.router.executeRead(
        {
          domain: CHAT_DOMAIN,
          operation: "getStreamState",
          workspaceId,
          entityId: chatId,
        },
        {
          mongo: () => this.mongo.getStreamState(chatId, workspaceId),
          pg: () => this.pg.getStreamState(chatId, workspaceId),
          shadowOptions: CHAT_SHADOW_OPTIONS,
        },
      );
    }

    const globalState = await this.router.getState(CHAT_DOMAIN);
    if (globalState.mode === "pg_only") {
      return this.pg.getStreamState(chatId);
    }
    if (globalState.mode === "dual_write_pg_read") {
      const fromPg = await this.pg.getStreamState(chatId);
      if (fromPg) return fromPg;
      return this.mongo.getStreamState(chatId);
    }
    const fromMongo = await this.mongo.getStreamState(chatId);
    if (fromMongo) {
      const wsState = await this.router.getState(
        CHAT_DOMAIN,
        fromMongo.workspaceId,
      );
      if (wsState.mode === "dual_write_pg_read" || wsState.mode === "pg_only") {
        return this.pg.getStreamState(chatId, fromMongo.workspaceId);
      }
      return fromMongo;
    }
    if (!this.isForceMongoOnly() && this.hasPg()) {
      return this.pg.getStreamState(chatId);
    }
    return null;
  }

  async setActiveStream(
    workspaceId: string,
    chatId: string,
    streamId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "setActiveStream",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: () =>
          this.mongo.setActiveStream(workspaceId, chatId, streamId, now),
        pg: () => this.pg.setActiveStream(workspaceId, chatId, streamId, now),
      },
    );
  }

  async clearActiveStreamIfMatch(
    workspaceId: string,
    chatId: string,
    streamId: string,
  ): Promise<void> {
    await this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "clearActiveStreamIfMatch",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: () =>
          this.mongo.clearActiveStreamIfMatch(workspaceId, chatId, streamId),
        pg: () =>
          this.pg.clearActiveStreamIfMatch(workspaceId, chatId, streamId),
      },
    );
  }

  async clearActiveStream(workspaceId: string, chatId: string): Promise<void> {
    await this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "clearActiveStream",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: () => this.mongo.clearActiveStream(workspaceId, chatId),
        pg: () => this.pg.clearActiveStream(workspaceId, chatId),
      },
    );
  }

  async saveTurnCheckpoint(
    workspaceId: string | undefined,
    chatId: string,
    streamId: string,
    message: StoredChatMessage,
    now: Date = new Date(),
  ): Promise<void> {
    await this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "saveTurnCheckpoint",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: () =>
          this.mongo.saveTurnCheckpoint(
            workspaceId,
            chatId,
            streamId,
            message,
            now,
          ),
        pg: () =>
          this.pg.saveTurnCheckpoint(
            workspaceId,
            chatId,
            streamId,
            message,
            now,
          ),
      },
    );
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  async findAttachmentByHash(
    workspaceId: string,
    chatId: string,
    sha256: string,
  ): Promise<ChatAttachmentRecord | null> {
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: CHAT_DOMAIN,
        operation: "findAttachmentByHash",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: async () => {
          const res = await this.mongo.findAttachmentByHash(
            workspaceId,
            chatId,
            sha256,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        pg: async () => {
          const res = await this.pg.findAttachmentByHash(
            workspaceId,
            chatId,
            sha256,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        canonicalize: r =>
          r ? { ...r, createdBy: resolveShadowUser(r.createdBy) } : null,
        shadowOptions: CHAT_SHADOW_OPTIONS,
      },
    );
  }

  async createAttachmentIdempotent(
    input: CreateChatAttachmentInput,
  ): Promise<ChatAttachmentRecord> {
    const id = input.id ?? newDualId().oid;
    const now = input.createdAt ?? new Date();
    const withId: CreateChatAttachmentInput = {
      ...input,
      id,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };
    let primaryRecord: ChatAttachmentRecord | null = null;

    return this.router.executeWrite(
      {
        domain: CHAT_DOMAIN,
        operation: "createAttachmentIdempotent",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          entity: "chat_attachments",
          workspaceId: input.workspaceId,
          chatId: input.chatId,
          sha256: input.sha256,
          attachmentId: id,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoCreator = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.createdBy,
            );
            return this.mongo.createAttachmentIdempotent({
              id: primaryRecord.id,
              workspaceId: primaryRecord.workspaceId,
              chatId: primaryRecord.chatId,
              createdBy: mongoCreator,
              storageKey: primaryRecord.storageKey,
              mediaType: primaryRecord.mediaType,
              filename: primaryRecord.filename,
              size: primaryRecord.size,
              sha256: primaryRecord.sha256,
              createdAt: primaryRecord.createdAt,
              updatedAt: primaryRecord.updatedAt,
            });
          }
          primaryRecord = await this.mongo.createAttachmentIdempotent(withId);
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            return this.pg.createAttachmentIdempotent({
              id: primaryRecord.id,
              workspaceId: primaryRecord.workspaceId,
              chatId: primaryRecord.chatId,
              createdBy: primaryRecord.createdBy,
              storageKey: primaryRecord.storageKey,
              mediaType: primaryRecord.mediaType,
              filename: primaryRecord.filename,
              size: primaryRecord.size,
              sha256: primaryRecord.sha256,
              createdAt: primaryRecord.createdAt,
              updatedAt: primaryRecord.updatedAt,
            });
          }
          primaryRecord = await this.pg.createAttachmentIdempotent(withId);
          return primaryRecord;
        },
      },
    );
  }

  async findAttachmentById(
    workspaceId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: CHAT_DOMAIN,
        operation: "findAttachmentById",
        workspaceId,
        entityId: attachmentId,
      },
      {
        mongo: async () => {
          const res = await this.mongo.findAttachmentById(
            workspaceId,
            attachmentId,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        pg: async () => {
          const res = await this.pg.findAttachmentById(
            workspaceId,
            attachmentId,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        canonicalize: r =>
          r ? { ...r, createdBy: resolveShadowUser(r.createdBy) } : null,
        shadowOptions: CHAT_SHADOW_OPTIONS,
      },
    );
  }

  async findAttachmentForUser(
    workspaceId: string,
    attachmentId: string,
    userId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>([userId]);
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: CHAT_DOMAIN,
        operation: "findAttachmentForUser",
        workspaceId,
        entityId: attachmentId,
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          const res = await this.mongo.findAttachmentForUser(
            workspaceId,
            attachmentId,
            mongoUser,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        pg: async () => {
          const res = await this.pg.findAttachmentForUser(
            workspaceId,
            attachmentId,
            userId,
          );
          if (res?.createdBy) collectedUserIds.add(res.createdBy);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        canonicalize: r =>
          r ? { ...r, createdBy: resolveShadowUser(r.createdBy) } : null,
        shadowOptions: CHAT_SHADOW_OPTIONS,
      },
    );
  }
}
