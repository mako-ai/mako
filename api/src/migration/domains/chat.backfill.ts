/**
 * Phase 3 (Part 2 — normalized `chat` domain) migration handlers:
 *   - FK-ordered resumable MongoDB -> Postgres backfill:
 *       1. `chats` (+ `chat_messages`, `chat_message_parts`, `chat_message_part_metadata`,
 *          `chat_usage_entries`; synthesizes legacy pre-`parts` Mongo docs cleanly)
 *       2. `chat_attachments` (validates parent `chats` row exists — quarantines orphan
 *          attachments whose `chatId` no longer exists — and back-links
 *          `chat_message_parts.attachment_id`)
 *   - Chunked parity verifier + `--repair` healer with body/prompt redaction.
 *   - Inngest dead-letter sync-retry replay handlers (`pg` and `mongo`).
 */
import { eq, inArray, or } from "drizzle-orm";
import { Types } from "mongoose";
import { Chat, ChatAttachment } from "../../database/models/chats";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  parseEntityId,
  uuidToObjectId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import { chatAttachments, chats } from "../../database/pg/schema/chat";
import { workspaces } from "../../database/pg/schema/workspaces";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import {
  CHAT_DOMAIN,
  CHAT_SHADOW_OPTIONS,
  MongoChatRepository,
  PgChatRepository,
  canonicalizeChatForCompare,
  mongoChatAttachmentToRecord,
  mongoChatToRecord,
  pgChatAttachmentToRecord,
  type ChatAttachmentRecord,
  type ChatRecord,
  type MongoChatAttachmentLike,
  type MongoChatLike,
} from "../../repositories/chat";
import { sanitizePgJsonValue } from "../../utils/message-sanitizer";
import {
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import {
  groupContiguous,
  prefetchExistingKeySet,
  prefetchPgUserUuidMap,
} from "../bulk-helpers";
import { recordMigrationTombstone } from "../router";
import type { SyncRetryEventData } from "../types";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

export type ChatMigratedTableName = "chats" | "chat_attachments";

interface ChatStageMeta {
  stage: number;
  table: ChatMigratedTableName;
  collection: string;
}

const CHAT_STAGES: readonly ChatStageMeta[] = [
  { stage: 1, table: "chats", collection: "chats" },
  { stage: 2, table: "chat_attachments", collection: "chatattachments" },
] as const;

type ChatBackfillDoc =
  | {
      table: "chats";
      record: ChatRecord;
      resolvedCreatedByUuid?: string | null;
    }
  | {
      table: "chat_attachments";
      record: ChatAttachmentRecord;
      resolvedCreatedByUuid?: string | null;
    };

function encodeCompositeCursor(
  stage: number,
  table: ChatMigratedTableName,
  mongoId: string,
): string {
  return `${stage}:${table}:${mongoId}`;
}

function decodeCompositeCursor(
  cursor: string | null,
): { stage: number; table: ChatMigratedTableName; mongoId: string } | null {
  if (!cursor) return null;
  const match = /^([1-2]):([a-z_]+):([0-9a-fA-F]{24})$/.exec(cursor);
  if (!match) return null;
  return {
    stage: Number(match[1]),
    table: match[2] as ChatMigratedTableName,
    mongoId: match[3].toLowerCase(),
  };
}

function encodeVerifierKey(
  table: ChatMigratedTableName,
  pgUuid: string,
): string {
  return `${table}:${pgUuid}`;
}

function decodeVerifierKey(
  key: string,
): { table: ChatMigratedTableName; pgUuid: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return {
    table: key.slice(0, idx) as ChatMigratedTableName,
    pgUuid: key.slice(idx + 1).toLowerCase(),
  };
}

function workspaceOidFilter(workspaceId: string | null): Types.ObjectId | null {
  if (!workspaceId) return null;
  const parsed = parseEntityId(workspaceId);
  if (!parsed?.oid) return null;
  return new Types.ObjectId(parsed.oid);
}

async function resolveUserUuid(
  db: MakoPgDb,
  userId: string | null,
): Promise<string | null> {
  if (!userId || userId === "system") return null;
  const whereClause = isUuidString(userId)
    ? or(eq(users.id, userId.toLowerCase()), eq(users.legacyId, userId))
    : eq(users.legacyId, userId);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(whereClause)
    .limit(1);
  return rows[0] ? rows[0].id.toLowerCase() : null;
}

async function resolveUserUuidsBatch(
  db: MakoPgDb,
  userIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter((u): u is string => Boolean(u)))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const uuidCandidates = unique.filter(isUuidString).map(u => u.toLowerCase());
  const whereClause =
    uuidCandidates.length > 0
      ? or(inArray(users.id, uuidCandidates), inArray(users.legacyId, unique))
      : inArray(users.legacyId, unique);
  const rows = await db
    .select({ id: users.id, legacyId: users.legacyId })
    .from(users)
    .where(whereClause);
  for (const row of rows) {
    const pgId = row.id.toLowerCase();
    out.set(pgId, pgId);
    if (row.legacyId) out.set(row.legacyId, pgId);
  }
  return out;
}

async function fetchStageBackfillItems(
  meta: ChatStageMeta,
  afterId: string | null,
  limit: number,
  workspaceId: string | null,
  composite: boolean,
): Promise<Array<BackfillItem<ChatBackfillDoc>>> {
  if (limit <= 0) return [];
  const filter: Record<string, unknown> = {};
  if (afterId && isObjectIdHex(afterId)) {
    filter._id = { $gt: new Types.ObjectId(afterId) };
  }
  const wsOid = workspaceOidFilter(workspaceId);
  if (wsOid) {
    filter.workspaceId = wsOid;
  }

  const makeCursor = (oid: string) =>
    composite ? encodeCompositeCursor(meta.stage, meta.table, oid) : oid;

  switch (meta.table) {
    case "chats": {
      const docs = await Chat.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoChatLike[]>();
      return docs.map(doc => {
        const record = mongoChatToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: objectIdToUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "chats",
          collectionName: meta.collection,
          doc: { table: "chats", record },
        };
      });
    }

    case "chat_attachments": {
      const docs = await ChatAttachment.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoChatAttachmentLike[]>();
      return docs.map(doc => {
        const record = mongoChatAttachmentToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: objectIdToUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "chat_attachments",
          collectionName: meta.collection,
          doc: { table: "chat_attachments", record },
        };
      });
    }
  }
}

interface ChatBatchValidationContext {
  chatUuids: Set<string>;
  workspaceUuids: Set<string>;
  userMap: Map<string, string>;
  prepared: boolean;
}

function createChatBatchValidationContext(): ChatBatchValidationContext {
  return {
    chatUuids: new Set<string>(),
    workspaceUuids: new Set<string>(),
    userMap: new Map<string, string>(),
    prepared: false,
  };
}

function clearChatBatchValidationContext(
  ctx: ChatBatchValidationContext,
): void {
  ctx.chatUuids.clear();
  ctx.workspaceUuids.clear();
  ctx.userMap.clear();
  ctx.prepared = false;
}

async function prepareChatBatch(
  items: ReadonlyArray<BackfillItem<ChatBackfillDoc>>,
  db: MakoPgDb,
  ctx: ChatBatchValidationContext,
): Promise<void> {
  const wsUuids: string[] = [];
  const parentChatUuids: string[] = [];
  const rawUserIds: Array<string | null | undefined> = [];

  for (const { doc } of items) {
    const wsUuid = parseEntityId(doc.record.workspaceId)?.uuid;
    if (wsUuid) wsUuids.push(wsUuid);
    rawUserIds.push(doc.record.createdBy);
    if (doc.table === "chat_attachments") {
      const chatUuid = parseEntityId(doc.record.chatId)?.uuid;
      if (chatUuid) parentChatUuids.push(chatUuid);
    }
  }

  const [foundWs, foundChats, resolvedUsers] = await Promise.all([
    prefetchExistingKeySet(db, workspaces, workspaces.id, wsUuids),
    prefetchExistingKeySet(db, chats, chats.id, parentChatUuids),
    prefetchPgUserUuidMap(db, rawUserIds),
  ]);

  for (const id of foundWs) ctx.workspaceUuids.add(id);
  for (const id of foundChats) ctx.chatUuids.add(id);
  for (const [k, v] of resolvedUsers) ctx.userMap.set(k, v);
  ctx.prepared = true;
}

async function resolveChatBatchUserUuid(
  db: MakoPgDb,
  userId: string | null,
  ctx: ChatBatchValidationContext,
): Promise<string | null> {
  if (!userId || userId === "system") return null;
  const cached =
    ctx.userMap.get(userId) ?? ctx.userMap.get(userId.toLowerCase());
  if (cached) return cached;
  if (ctx.prepared) return null;
  const resolved = await resolveUserUuid(db, userId);
  if (resolved) {
    ctx.userMap.set(userId, resolved);
    ctx.userMap.set(resolved, resolved);
  }
  return resolved;
}

async function validateChatBackfillItem(
  item: BackfillItem<ChatBackfillDoc>,
  db: MakoPgDb,
  ctx: ChatBatchValidationContext,
): Promise<BackfillValidationResult> {
  const { doc } = item;
  const wsUuid = parseEntityId(doc.record.workspaceId)?.uuid;
  if (!wsUuid) {
    return {
      ok: false,
      reason: "invalid_workspace_id",
      sanitizedPayload: { table: doc.table, id: doc.record.id },
    };
  }
  if (!ctx.workspaceUuids.has(wsUuid)) {
    if (ctx.prepared) {
      return {
        ok: false,
        reason: "orphaned_workspace_missing",
        sanitizedPayload: {
          table: doc.table,
          id: doc.record.id,
          workspaceId: doc.record.workspaceId,
        },
      };
    }
    const wsRows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, wsUuid))
      .limit(1);
    if (!wsRows[0]) {
      return {
        ok: false,
        reason: "orphaned_workspace_missing",
        sanitizedPayload: {
          table: doc.table,
          id: doc.record.id,
          workspaceId: doc.record.workspaceId,
        },
      };
    }
    ctx.workspaceUuids.add(wsUuid);
  }

  switch (doc.table) {
    case "chats": {
      doc.resolvedCreatedByUuid = await resolveChatBatchUserUuid(
        db,
        doc.record.createdBy,
        ctx,
      );
      ctx.chatUuids.add(objectIdToUuid(doc.record.id));
      return { ok: true };
    }

    case "chat_attachments": {
      const chatUuid = parseEntityId(doc.record.chatId)?.uuid;
      if (!chatUuid) {
        return {
          ok: false,
          reason: "invalid_attachment_chat_id",
          sanitizedPayload: {
            table: "chat_attachments",
            id: doc.record.id,
            chatId: doc.record.chatId,
          },
        };
      }
      if (!ctx.chatUuids.has(chatUuid)) {
        if (ctx.prepared) {
          return {
            ok: false,
            reason: "orphaned_chat_missing",
            sanitizedPayload: {
              table: "chat_attachments",
              id: doc.record.id,
              chatId: doc.record.chatId,
              storageKey: doc.record.storageKey,
            },
          };
        }
        const parentRows = await db
          .select({ id: chats.id })
          .from(chats)
          .where(eq(chats.id, chatUuid))
          .limit(1);
        if (!parentRows[0]) {
          return {
            ok: false,
            reason: "orphaned_chat_missing",
            sanitizedPayload: {
              table: "chat_attachments",
              id: doc.record.id,
              chatId: doc.record.chatId,
              storageKey: doc.record.storageKey,
            },
          };
        }
        ctx.chatUuids.add(chatUuid);
      }
      doc.resolvedCreatedByUuid = await resolveChatBatchUserUuid(
        db,
        doc.record.createdBy,
        ctx,
      );
      return { ok: true };
    }
  }
}

async function upsertChatBackfillItems(
  items: Array<BackfillItem<ChatBackfillDoc>>,
  db: MakoPgDb,
  pgRepo: PgChatRepository,
): Promise<number> {
  let upserted = 0;

  for (const group of groupContiguous(items, item => item.doc.table)) {
    switch (group.key) {
      case "chats":
        upserted += await pgRepo.upsertFullChatsBatchWithGuard(
          group.items.map(item => {
            const d = item.doc as Extract<ChatBackfillDoc, { table: "chats" }>;
            return {
              record: d.record,
              createdByUuid: d.resolvedCreatedByUuid ?? null,
            };
          }),
          db,
        );
        break;
      case "chat_attachments":
        upserted += await pgRepo.upsertAttachmentsBatchWithBacklink(
          group.items.map(item => {
            const d = item.doc as Extract<
              ChatBackfillDoc,
              { table: "chat_attachments" }
            >;
            return {
              record: d.record,
              createdByUuid: d.resolvedCreatedByUuid ?? null,
            };
          }),
          db,
        );
        break;
    }
  }
  return upserted;
}

export function createChatBackfillHandler(): BackfillDomainHandler<ChatBackfillDoc> {
  const pgRepo = new PgChatRepository();
  const batchCtx = createChatBatchValidationContext();

  return {
    domain: CHAT_DOMAIN,
    collectionName: "chats",
    targetTable: "chats",
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      clearChatBatchValidationContext(batchCtx);
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<ChatBackfillDoc>> = [];

      for (const meta of CHAT_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;
        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          workspaceId,
          true,
        );
        items.push(...batch);
      }
      return items;
    },
    prepareBatch(items, db) {
      return prepareChatBatch(items, db, batchCtx);
    },
    validate(item, db) {
      return validateChatBackfillItem(item, db, batchCtx);
    },
    upsertBatch(items, db) {
      return upsertChatBackfillItems(items, db, pgRepo);
    },
  };
}

export function createChatTableBackfillHandler(
  meta: ChatStageMeta,
): BackfillDomainHandler<ChatBackfillDoc> {
  const pgRepo = new PgChatRepository();
  const batchCtx = createChatBatchValidationContext();

  return {
    domain: `${CHAT_DOMAIN}:${meta.table}`,
    collectionName: meta.collection,
    targetTable: meta.table,
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      clearChatBatchValidationContext(batchCtx);
      return fetchStageBackfillItems(
        meta,
        afterCursor,
        limit,
        workspaceId,
        false,
      );
    },
    prepareBatch(items, db) {
      return prepareChatBatch(items, db, batchCtx);
    },
    validate(item, db) {
      return validateChatBackfillItem(item, db, batchCtx);
    },
    upsertBatch(items, db) {
      return upsertChatBackfillItems(items, db, pgRepo);
    },
  };
}

// ── Parity verifier (+ --repair) ────────────────────────────────────────────

async function fetchPgRecordsForTable(
  table: ChatMigratedTableName,
  uuids: string[],
  db: MakoPgDb,
  pgRepo: PgChatRepository,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const valid = uuids.filter(isUuidString).map(u => u.toLowerCase());
  if (valid.length === 0) return out;

  switch (table) {
    case "chats": {
      const hydratedMap = await pgRepo.findByIds(valid, db);
      for (const [pgUuid, record] of hydratedMap) {
        out.set(pgUuid, canonicalizeChatForCompare(record));
      }
      return out;
    }

    case "chat_attachments": {
      const rows = await db
        .select()
        .from(chatAttachments)
        .where(inArray(chatAttachments.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgChatAttachmentToRecord(row));
      }
      return out;
    }
  }
}

async function listAllPgIdsForTable(
  table: ChatMigratedTableName,
  workspaceId: string | null,
  db: MakoPgDb,
): Promise<string[]> {
  const wsUuid = workspaceId
    ? (parseEntityId(workspaceId)?.uuid ?? null)
    : null;
  switch (table) {
    case "chats": {
      const rows = wsUuid
        ? await db
            .select({ id: chats.id })
            .from(chats)
            .where(eq(chats.workspaceId, wsUuid))
        : await db.select({ id: chats.id }).from(chats);
      return rows.map(r => r.id.toLowerCase());
    }
    case "chat_attachments": {
      const rows = wsUuid
        ? await db
            .select({ id: chatAttachments.id })
            .from(chatAttachments)
            .where(eq(chatAttachments.workspaceId, wsUuid))
        : await db.select({ id: chatAttachments.id }).from(chatAttachments);
      return rows.map(r => r.id.toLowerCase());
    }
  }
}

function buildVerifierRecord(
  item: BackfillItem<ChatBackfillDoc>,
  userMap: Map<string, string>,
  composite: boolean,
): VerifierMongoRecord {
  const { doc } = item;
  const resolveUser = (id: string | null) =>
    id ? (userMap.get(id) ?? null) : null;

  const record =
    doc.table === "chats"
      ? canonicalizeChatForCompare(doc.record, resolveUser)
      : sanitizePgJsonValue({
          ...doc.record,
          createdBy: resolveUser(doc.record.createdBy),
        });

  return {
    cursor: item.cursor,
    entityId: composite
      ? encodeVerifierKey(doc.table, item.entityId)
      : item.entityId,
    targetTable: doc.table,
    tombstoneId: item.entityId,
    record,
  };
}

async function repairChatEntity(
  table: ChatMigratedTableName,
  pgUuid: string,
  db: MakoPgDb,
  pgRepo: PgChatRepository,
): Promise<boolean> {
  const oid = uuidToObjectId(pgUuid);
  switch (table) {
    case "chats": {
      const doc = await Chat.findById(oid).lean<MongoChatLike | null>();
      if (!doc) return false;
      const record = mongoChatToRecord(doc);
      const createdByUuid = await resolveUserUuid(db, record.createdBy);
      return pgRepo.upsertFullChatWithGuard(record, createdByUuid, db);
    }
    case "chat_attachments": {
      const doc = await ChatAttachment.findById(
        oid,
      ).lean<MongoChatAttachmentLike | null>();
      if (!doc) return false;
      const record = mongoChatAttachmentToRecord(doc);
      const chatUuid = parseEntityId(record.chatId)?.uuid;
      if (!chatUuid) return false;
      const parentRows = await db
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.id, chatUuid))
        .limit(1);
      if (!parentRows[0]) return false;
      const createdByUuid = await resolveUserUuid(db, record.createdBy);
      return pgRepo.upsertAttachmentWithBacklink(record, createdByUuid, db);
    }
  }
}

export function createChatVerifierHandler(): VerifierDomainHandler {
  const pgRepo = new PgChatRepository();

  return {
    domain: CHAT_DOMAIN,
    targetTable: "chats",
    compareOptions: CHAT_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const rawItems: Array<BackfillItem<ChatBackfillDoc>> = [];

      for (const meta of CHAT_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - rawItems.length;
        if (remaining <= 0) break;
        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          workspaceId,
          true,
        );
        rawItems.push(...batch);
      }

      const userIds = rawItems.map(item => item.doc.record.createdBy);
      const userMap = await resolveUserUuidsBatch(db, userIds);
      return rawItems.map(item => buildVerifierRecord(item, userMap, true));
    },

    async fetchPgByIds(entityIds, db) {
      const byTable = new Map<ChatMigratedTableName, string[]>();
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) continue;
        const list = byTable.get(decoded.table);
        if (list) list.push(decoded.pgUuid);
        else byTable.set(decoded.table, [decoded.pgUuid]);
      }

      const out = new Map<string, unknown>();
      for (const [table, ids] of byTable) {
        const sub = await fetchPgRecordsForTable(table, ids, db, pgRepo);
        for (const [pgUuid, record] of sub) {
          out.set(encodeVerifierKey(table, pgUuid), record);
        }
      }
      return out;
    },

    async findExtraPgIds({ workspaceId, seenEntityIds, db }) {
      const extras: string[] = [];
      for (const meta of CHAT_STAGES) {
        const ids = await listAllPgIdsForTable(meta.table, workspaceId, db);
        for (const id of ids) {
          const key = encodeVerifierKey(meta.table, id);
          if (!seenEntityIds.has(key)) extras.push(key);
        }
      }
      return extras;
    },

    async repair({ entityIds, db }) {
      let repaired = 0;
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) continue;
        if (await repairChatEntity(decoded.table, decoded.pgUuid, db, pgRepo)) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

// ── Inngest sync-retry handlers ─────────────────────────────────────────────

async function resolveMongoUserIdForReverseSync(
  db: MakoPgDb,
  userId: string | null,
): Promise<string | null> {
  if (!userId || !isUuidString(userId)) return userId;
  const rows = await db
    .select({ legacyId: users.legacyId })
    .from(users)
    .where(or(eq(users.id, userId.toLowerCase()), eq(users.legacyId, userId)))
    .limit(1);
  return rows[0]?.legacyId ?? userId;
}

async function replayChatWriteToPg(data: SyncRetryEventData): Promise<void> {
  const db = getPgDb();
  const pgRepo = new PgChatRepository({ getDb: () => db });
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  const entity = payload.entity as ChatMigratedTableName | undefined;
  const action = payload.action as string | undefined;

  if (entity === "chat_attachments") {
    const attachmentId = String(payload.attachmentId ?? data.entityId);
    const attOid = parseEntityId(attachmentId)?.oid;
    let doc: MongoChatAttachmentLike | null = attOid
      ? await ChatAttachment.findById(
          attOid,
        ).lean<MongoChatAttachmentLike | null>()
      : null;
    if (!doc) {
      const wsOid = parseEntityId(
        String(payload.workspaceId ?? data.workspaceId ?? ""),
      )?.oid;
      const attChatId =
        typeof payload.chatId === "string"
          ? (parseEntityId(payload.chatId)?.oid ?? payload.chatId)
          : null;
      const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : null;
      if (wsOid && attChatId && sha256) {
        doc = await ChatAttachment.findOne({
          workspaceId: new Types.ObjectId(wsOid),
          chatId: attChatId,
          sha256,
        }).lean<MongoChatAttachmentLike | null>();
      }
    }
    if (!doc) return;
    const record = mongoChatAttachmentToRecord(doc);
    const createdByUuid = await resolveUserUuid(db, record.createdBy);
    await pgRepo.upsertAttachmentWithBacklink(record, createdByUuid, db);
    return;
  }

  const chatId = String(payload.chatId ?? data.entityId);
  const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
  if (action === "delete") {
    const userId = String(payload.userId ?? "");
    const chatOid = parseEntityId(chatId)?.oid;
    // Never delete or tombstone in PG if the primary Mongo doc still exists (e.g. wrong-user attempt).
    if (chatOid && (await Chat.exists({ _id: new Types.ObjectId(chatOid) }))) {
      return;
    }
    if (userId) {
      await pgRepo.deleteOwned(workspaceId, chatId, userId, db);
    }
    const uuid = parseEntityId(chatId)?.uuid;
    if (uuid) {
      await recordMigrationTombstone("chats", uuid, db);
    }
    return;
  }

  const chatOid = parseEntityId(chatId)?.oid;
  if (!chatOid) return;
  const doc = await Chat.findById(chatOid).lean<MongoChatLike | null>();
  if (!doc) return;
  const record = mongoChatToRecord(doc);
  const createdByUuid = await resolveUserUuid(db, record.createdBy);
  await pgRepo.upsertFullChatWithGuard(record, createdByUuid, db);
}

async function replayChatWriteToMongo(data: SyncRetryEventData): Promise<void> {
  const db = getPgDb();
  const pgRepo = new PgChatRepository({ getDb: () => db });
  const mongoRepo = new MongoChatRepository();
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  const entity = payload.entity as ChatMigratedTableName | undefined;
  const action = payload.action as string | undefined;

  if (entity === "chat_attachments") {
    const attachmentId = String(payload.attachmentId ?? data.entityId);
    const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
    let pgAttachment = await pgRepo.findAttachmentById(
      workspaceId,
      attachmentId,
      db,
    );
    if (!pgAttachment) {
      const attChatId =
        typeof payload.chatId === "string" ? payload.chatId : null;
      const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : null;
      if (workspaceId && attChatId && sha256) {
        pgAttachment = await pgRepo.findAttachmentByHash(
          workspaceId,
          attChatId,
          sha256,
          db,
        );
      }
    }
    if (!pgAttachment) return;
    const mongoCreatedBy = await resolveMongoUserIdForReverseSync(
      db,
      pgAttachment.createdBy,
    );
    await mongoRepo.createAttachmentIdempotent({
      ...pgAttachment,
      createdBy: mongoCreatedBy,
    });
    return;
  }

  const chatId = String(payload.chatId ?? data.entityId);
  const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
  if (action === "delete") {
    const userId = String(payload.userId ?? "");
    if (userId) {
      const mongoUserId =
        (await resolveMongoUserIdForReverseSync(db, userId)) ?? userId;
      await mongoRepo.deleteOwned(workspaceId, chatId, mongoUserId);
    }
    return;
  }

  const pgRecord = await pgRepo.findById(chatId, workspaceId || undefined, db);
  if (!pgRecord) return;
  const mongoCreatedBy = await resolveMongoUserIdForReverseSync(
    db,
    pgRecord.createdBy,
  );
  await mongoRepo.upsertFullRecord({
    ...pgRecord,
    createdBy: mongoCreatedBy,
  });
}

export function registerChatMigrationDomain(): void {
  registerBackfillDomain(createChatBackfillHandler());
  for (const meta of CHAT_STAGES) {
    registerBackfillDomain(createChatTableBackfillHandler(meta));
  }
  registerVerifierDomain(createChatVerifierHandler());
  registerSyncRetryHandler("pg", CHAT_DOMAIN, replayChatWriteToPg);
  registerSyncRetryHandler("mongo", CHAT_DOMAIN, replayChatWriteToMongo);
}
