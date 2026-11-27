/**
 * Postgres (Neon / Drizzle) implementation of `ChatRepository`.
 *
 * Key invariants:
 *   - Normalized 6-table storage (`chats`, `chat_messages`, `chat_attachments`,
 *     `chat_message_parts`, `chat_message_part_metadata`, `chat_usage_entries`).
 *     NO `chat_messages.parts jsonb` column and NO Postgres `chat_stream_events` table.
 *   - Preserves exact distinction between SQL `NULL` (omitted `output`/`input`)
 *     and explicit JSON `'null'::jsonb` via `sql`'null'::jsonb`` on write and
 *     `IS NOT NULL` boolean projections on read.
 *   - Diff-aware prefix preservation on `saveMessages` leaves unchanged prefix
 *     messages & their `chat_message_parts.id` untouched, cascade-deleting only
 *     from the first changed ordinal onward.
 *   - Atomic `FOR UPDATE` row lock on `chats` guarantees collision-free
 *     `chat_usage_entries.entry_index` allocation across concurrent segments.
 *   - Aura's transactional `deleteOwned`: verifies ownership, reads `storage_key`s,
 *     and deletes `chats` (cascading all children) inside ONE transaction so a
 *     rolled-back/unauthorized delete never returns blob keys to purge.
 *   - Exact keyset pagination `(updated_at DESC, id DESC)` parity with UUIDv8 ordering.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { extractRows, getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isUuidString,
  newDualId,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  chatAttachments,
  chatMessagePartMetadata,
  chatMessageParts,
  chatMessages,
  chats,
  chatUsageEntries,
  type ChatMessageRow,
  type ChatRow,
} from "../../database/pg/schema/chat";
import { encodeChatListCursor } from "./cursor";
import {
  computeMessageFingerprint,
  hydratePgChatRecord,
  pgChatAttachmentToRecord,
  unpackPartForPg,
  type HydratedPartRow,
  type UnpackedPartForPg,
} from "./mapper";
import type {
  AppChatListEntry,
  ChatAttachmentRecord,
  ChatListEntry,
  ChatLocalAcp,
  ChatRecord,
  ChatRepository,
  CreateChatAttachmentInput,
  CreateChatInput,
  SaveChatMessagesInput,
  StoredChatMessage,
  UpdateChatThreadPatch,
} from "./types";

function parseUuidOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return parseEntityId(raw)?.uuid ?? null;
}

/** Encode a nullable jsonb parameter preserving explicit JSON `null` (`'null'::jsonb`) vs SQL `NULL`. */
function toPgJsonbValue(hasValue: boolean, value: unknown) {
  if (!hasValue) return null;
  if (value === null) return sql`'null'::jsonb`;
  return value;
}

type PgTx = Parameters<Parameters<MakoPgDb["transaction"]>[0]>[0];
type PgQueryable = MakoPgDb | PgTx;

export class PgChatRepository implements ChatRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  /**
   * Resolve a user identifier (UUIDv7 or legacy 15-char Lucia ID / UUIDv4)
   * against `users(id, legacy_id)`. Returns `null` for `"system"`, empty, or unknown users.
   */
  async resolveUserUuid(
    idOrLegacyId: string | null | undefined,
    db: PgQueryable = this.getDb(),
  ): Promise<string | null> {
    if (!idOrLegacyId) return null;
    const trimmed = idOrLegacyId.trim();
    if (!trimmed || trimmed === "system") return null;

    const whereClause = isUuidString(trimmed)
      ? or(eq(users.id, trimmed.toLowerCase()), eq(users.legacyId, trimmed))
      : eq(users.legacyId, trimmed);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(whereClause)
      .limit(1);
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  // ── Internal hydration & diff-aware parts persistence ────────────────────

  private async loadHydratedPartsByMessageId(
    chatUuid: string,
    db: PgQueryable,
  ): Promise<Map<string, HydratedPartRow[]>> {
    const joined = await db
      .select({
        part: chatMessageParts,
        hasToolInput: sql<boolean>`${chatMessageParts.toolInput} IS NOT NULL`,
        hasToolOutput: sql<boolean>`${chatMessageParts.toolOutput} IS NOT NULL`,
        hasToolRawInput: sql<boolean>`${chatMessageParts.toolRawInput} IS NOT NULL`,
        hasToolMetadata: sql<boolean>`${chatMessageParts.toolMetadata} IS NOT NULL`,
        metadata: chatMessagePartMetadata,
      })
      .from(chatMessageParts)
      .leftJoin(
        chatMessagePartMetadata,
        eq(chatMessagePartMetadata.partId, chatMessageParts.id),
      )
      .where(eq(chatMessageParts.chatId, chatUuid))
      .orderBy(
        asc(chatMessageParts.messageId),
        asc(chatMessageParts.orderIndex),
      );

    const byMessage = new Map<string, HydratedPartRow[]>();
    for (const row of joined) {
      const entry: HydratedPartRow = {
        part: row.part,
        hasToolInput: Boolean(row.hasToolInput),
        hasToolOutput: Boolean(row.hasToolOutput),
        hasToolRawInput: Boolean(row.hasToolRawInput),
        hasToolMetadata: Boolean(row.hasToolMetadata),
        metadata: row.metadata ?? null,
      };
      const list = byMessage.get(row.part.messageId);
      if (list) list.push(entry);
      else byMessage.set(row.part.messageId, [entry]);
    }
    return byMessage;
  }

  private async hydrateChat(
    chatRow: ChatRow,
    db: PgQueryable,
  ): Promise<ChatRecord> {
    const [messageRows, partsByMessageId, usageRows] = await Promise.all([
      db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.chatId, chatRow.id))
        .orderBy(asc(chatMessages.ordinal)),
      this.loadHydratedPartsByMessageId(chatRow.id, db),
      db
        .select()
        .from(chatUsageEntries)
        .where(eq(chatUsageEntries.chatId, chatRow.id))
        .orderBy(asc(chatUsageEntries.entryIndex)),
    ]);

    return hydratePgChatRecord({
      chat: chatRow,
      messages: messageRows,
      partsByMessageId,
      usageEntries: usageRows,
    });
  }

  /**
   * Persist `incomingMessages` for `chatUuid` inside an active transaction using
   * diff-aware prefix preservation: unchanged leading messages keep their existing
   * `chat_messages.id` and `chat_message_parts.id` untouched; only ordinals from the
   * first divergence onward are cascade-deleted and batch-inserted.
   */
  private async syncChatMessagesTx(
    tx: PgQueryable,
    chatUuid: string,
    incomingMessages: readonly StoredChatMessage[],
    now: Date,
  ): Promise<void> {
    const existingRows = await tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatUuid))
      .orderBy(asc(chatMessages.ordinal));

    let changedFrom = 0;

    if (existingRows.length > 0) {
      const existingPartsMap = await this.loadHydratedPartsByMessageId(
        chatUuid,
        tx,
      );
      const existingHydrated = hydratePgChatRecord({
        chat: {
          id: chatUuid,
          workspaceId: chatUuid,
          createdBy: null,
          title: "",
          titleGenerated: false,
          source: "chat",
          appId: null,
          threadId: null,
          activeAgent: null,
          pinnedConsoleId: null,
          activeStreamId: null,
          activeStreamAliveAt: null,
          turnCheckpoint: null,
          localAcp: null,
          systemPrompt: null,
          workspacePrompt: null,
          usagePromptTokens: 0,
          usageCompletionTokens: 0,
          usageTotalTokens: 0,
          usageCacheReadTokens: 0,
          usageCacheWriteTokens: 0,
          usageReasoningTokens: 0,
          usageCostUsd: "0",
          createdAt: now,
          updatedAt: now,
        },
        messages: existingRows,
        partsByMessageId: existingPartsMap,
        usageEntries: [],
      }).messages;

      const commonLen = Math.min(
        existingHydrated.length,
        incomingMessages.length,
      );
      while (changedFrom < commonLen) {
        if (
          existingRows[changedFrom].ordinal !== changedFrom ||
          computeMessageFingerprint(existingHydrated[changedFrom]) !==
            computeMessageFingerprint(incomingMessages[changedFrom])
        ) {
          break;
        }
        changedFrom += 1;
      }

      if (changedFrom < existingRows.length) {
        // ON DELETE CASCADE clears child chat_message_parts & chat_message_part_metadata.
        await tx
          .delete(chatMessages)
          .where(
            and(
              eq(chatMessages.chatId, chatUuid),
              sql`${chatMessages.ordinal} >= ${changedFrom}`,
            ),
          );
      }
    }

    if (changedFrom >= incomingMessages.length) {
      return;
    }

    const tailMessages = incomingMessages.slice(changedFrom);
    const insertedMsgs = await tx
      .insert(chatMessages)
      .values(
        tailMessages.map((msg, offset) => ({
          chatId: chatUuid,
          ordinal: changedFrom + offset,
          clientMessageId: msg.id ?? null,
          role: msg.role,
          metadata: msg.metadata ?? null,
          createdAt: msg.createdAt ?? now,
        })),
      )
      .returning({ id: chatMessages.id, ordinal: chatMessages.ordinal });

    const messageIdByOrdinal = new Map<number, string>();
    for (const row of insertedMsgs) {
      messageIdByOrdinal.set(row.ordinal, row.id);
    }

    // Unpack all parts across the inserted tail messages and pre-resolve valid attachment IDs.
    const pendingParts: Array<{
      messageId: string;
      unpacked: UnpackedPartForPg;
    }> = [];
    const candidateAttachmentUuids = new Set<string>();

    for (let offset = 0; offset < tailMessages.length; offset++) {
      const ordinal = changedFrom + offset;
      const messageId = messageIdByOrdinal.get(ordinal);
      if (!messageId) continue;
      const parts = Array.isArray(tailMessages[offset].parts)
        ? tailMessages[offset].parts
        : [];
      for (let orderIndex = 0; orderIndex < parts.length; orderIndex++) {
        const unpacked = unpackPartForPg(parts[orderIndex], orderIndex);
        if (unpacked.candidateAttachmentUuid) {
          candidateAttachmentUuids.add(unpacked.candidateAttachmentUuid);
        }
        pendingParts.push({ messageId, unpacked });
      }
    }

    if (pendingParts.length === 0) {
      return;
    }

    // Only set attachment_id FK for attachments that actually exist in chat_attachments
    // AND belong to this chat (protects backfill ordering, stale/deleted attachment URLs,
    // and prevents cross-chat/cross-workspace attachment linking).
    const existingAttachmentUuids = new Set<string>();
    if (candidateAttachmentUuids.size > 0) {
      const attRows = await tx
        .select({ id: chatAttachments.id })
        .from(chatAttachments)
        .where(
          and(
            eq(chatAttachments.chatId, chatUuid),
            inArray(chatAttachments.id, [...candidateAttachmentUuids]),
          ),
        );
      for (const r of attRows) {
        existingAttachmentUuids.add(r.id.toLowerCase());
      }
    }

    // Batch-insert chat_message_parts in chunks to stay well under PG parameter limits.
    const PART_CHUNK_SIZE = 100;
    const pendingMetadata: Array<{
      partId: string;
      providerMetadata: unknown;
      callProviderMetadata: unknown;
      resultProviderMetadata: unknown;
    }> = [];

    for (let i = 0; i < pendingParts.length; i += PART_CHUNK_SIZE) {
      const slice = pendingParts.slice(i, i + PART_CHUNK_SIZE);
      const insertedParts = await tx
        .insert(chatMessageParts)
        .values(
          slice.map(({ messageId, unpacked }) => ({
            chatId: chatUuid,
            messageId,
            orderIndex: unpacked.orderIndex,
            partType: unpacked.partType,
            rawType: unpacked.rawType,
            textValue: unpacked.textValue,
            fileUrl: unpacked.fileUrl,
            fileMediaType: unpacked.fileMediaType,
            fileFilename: unpacked.fileFilename,
            attachmentId:
              unpacked.candidateAttachmentUuid &&
              existingAttachmentUuids.has(unpacked.candidateAttachmentUuid)
                ? unpacked.candidateAttachmentUuid
                : null,
            isDynamicTool: unpacked.isDynamicTool,
            toolCallId: unpacked.toolCallId,
            toolName: unpacked.toolName,
            toolState: unpacked.toolState,
            toolInput: toPgJsonbValue(
              unpacked.hasToolInput,
              unpacked.toolInput,
            ),
            toolOutput: toPgJsonbValue(
              unpacked.hasToolOutput,
              unpacked.toolOutput,
            ),
            toolErrorText: unpacked.toolErrorText,
            toolRawInput: toPgJsonbValue(
              unpacked.hasToolRawInput,
              unpacked.toolRawInput,
            ),
            toolApproval: unpacked.toolApproval,
            toolProviderExecuted: unpacked.toolProviderExecuted,
            toolPreliminary: unpacked.toolPreliminary,
            toolTitle: unpacked.toolTitle,
            toolMetadata: toPgJsonbValue(
              unpacked.hasToolMetadata,
              unpacked.toolMetadata,
            ),
            extraPayload: unpacked.extraPayload,
            createdAt: now,
          })),
        )
        .returning({
          id: chatMessageParts.id,
          messageId: chatMessageParts.messageId,
          orderIndex: chatMessageParts.orderIndex,
        });

      const partIdByKey = new Map<string, string>();
      for (const p of insertedParts) {
        partIdByKey.set(`${p.messageId}:${p.orderIndex}`, p.id);
      }
      for (const { messageId, unpacked } of slice) {
        if (!unpacked.metadata) continue;
        const partId = partIdByKey.get(`${messageId}:${unpacked.orderIndex}`);
        if (!partId) continue;
        pendingMetadata.push({
          partId,
          providerMetadata: unpacked.metadata.providerMetadata ?? null,
          callProviderMetadata: unpacked.metadata.callProviderMetadata ?? null,
          resultProviderMetadata:
            unpacked.metadata.resultProviderMetadata ?? null,
        });
      }
    }

    if (pendingMetadata.length > 0) {
      const META_CHUNK_SIZE = 200;
      for (let i = 0; i < pendingMetadata.length; i += META_CHUNK_SIZE) {
        await tx
          .insert(chatMessagePartMetadata)
          .values(pendingMetadata.slice(i, i + META_CHUNK_SIZE));
      }
    }
  }

  // ── Chat lifecycle & reads ───────────────────────────────────────────────

  async create(
    input: CreateChatInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatRecord> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    if (!wsUuid) {
      throw new Error(
        `Invalid workspaceId: ${JSON.stringify(input.workspaceId)}`,
      );
    }
    const chatUuid = input.id ? parseUuidOrNull(input.id) : newDualId().uuid;
    if (!chatUuid) {
      throw new Error(`Invalid chat id: ${JSON.stringify(input.id)}`);
    }
    const createdByUuid = await this.resolveUserUuid(input.createdBy, db);
    const appUuid = parseUuidOrNull(input.appId);
    const pinnedConsoleUuid = parseUuidOrNull(input.pinnedConsoleId);
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;
    const source = input.source ?? (input.appId ? "app" : "chat");

    return db.transaction(async tx => {
      const [row] = await tx
        .insert(chats)
        .values({
          id: chatUuid,
          workspaceId: wsUuid,
          createdBy: createdByUuid,
          title: input.title ?? "New Chat",
          titleGenerated: input.titleGenerated ?? false,
          source,
          appId: appUuid,
          threadId: input.threadId ?? null,
          activeAgent: input.activeAgent ?? null,
          pinnedConsoleId: pinnedConsoleUuid,
          systemPrompt: input.systemPrompt ?? null,
          workspacePrompt: input.workspacePrompt ?? null,
          createdAt: now,
          updatedAt,
        })
        .returning();

      if (input.messages && input.messages.length > 0) {
        await this.syncChatMessagesTx(tx, row.id, input.messages, now);
      }
      return this.hydrateChat(row, tx);
    });
  }

  async findById(
    chatId: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatRecord | null> {
    const chatUuid = parseUuidOrNull(chatId);
    if (!chatUuid) return null;
    const conditions = [eq(chats.id, chatUuid)];
    if (workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(workspaceId);
      if (!wsUuid) return null;
      conditions.push(eq(chats.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(chats)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? this.hydrateChat(rows[0], db) : null;
  }

  async findOwnedById(
    workspaceId: string,
    chatId: string,
    userId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatRecord | null> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return null;
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) return null;
    const rows = await db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.id, chatUuid),
          eq(chats.workspaceId, wsUuid),
          eq(chats.createdBy, userUuid),
        ),
      )
      .limit(1);
    return rows[0] ? this.hydrateChat(rows[0], db) : null;
  }

  async findOwnershipMeta(
    workspaceId: string,
    chatId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<{ createdBy: string | null; titleGenerated: boolean } | null> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return null;
    const rows = await db
      .select({
        createdBy: chats.createdBy,
        titleGenerated: chats.titleGenerated,
      })
      .from(chats)
      .where(and(eq(chats.id, chatUuid), eq(chats.workspaceId, wsUuid)))
      .limit(1);
    if (!rows[0]) return null;
    return {
      createdBy: rows[0].createdBy ? rows[0].createdBy.toLowerCase() : null,
      titleGenerated: rows[0].titleGenerated,
    };
  }

  async listUserChats(
    input: {
      workspaceId: string;
      userId: string;
      limit: number;
      after?: { updatedAt: number | null; id: string } | null;
    },
    db: MakoPgDb = this.getDb(),
  ): Promise<{ chats: ChatListEntry[]; nextCursor: string | null }> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    if (!wsUuid) return { chats: [], nextCursor: null };
    const userUuid = await this.resolveUserUuid(input.userId, db);
    if (!userUuid) return { chats: [], nextCursor: null };

    const conditions = [
      eq(chats.workspaceId, wsUuid),
      eq(chats.createdBy, userUuid),
      eq(chats.source, "chat"),
    ];

    if (input.after) {
      const cursorUuid = parseUuidOrNull(input.after.id);
      if (!cursorUuid) return { chats: [], nextCursor: null };
      const cursorDate =
        input.after.updatedAt === null
          ? new Date(0)
          : new Date(input.after.updatedAt);
      const cursorCondition = or(
        lt(chats.updatedAt, cursorDate),
        and(eq(chats.updatedAt, cursorDate), lt(chats.id, cursorUuid)),
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = await db
      .select({
        id: chats.id,
        title: chats.title,
        createdAt: chats.createdAt,
        updatedAt: chats.updatedAt,
        activeStreamId: chats.activeStreamId,
        usageTotalTokens: chats.usageTotalTokens,
        usageCostUsd: chats.usageCostUsd,
      })
      .from(chats)
      .where(and(...conditions))
      .orderBy(desc(chats.updatedAt), desc(chats.id))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > input.limit && last
        ? encodeChatListCursor({
            updatedAt:
              last.updatedAt.getTime() === 0 ? null : last.updatedAt.getTime(),
            id: toWireId(last.id),
          })
        : null;

    return {
      chats: page.map(row => {
        const totalTokens = Number(row.usageTotalTokens);
        const costUsd = Number(row.usageCostUsd);
        const hasUsage = totalTokens > 0 || costUsd > 0;
        return {
          _id: toWireId(row.id),
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt.getTime() === 0 ? undefined : row.updatedAt,
          activeStreamId: row.activeStreamId ?? null,
          ...(hasUsage ? { usage: { totalTokens, costUsd } } : {}),
        };
      }),
      nextCursor,
    };
  }

  async listAppChats(
    workspaceId: string,
    appId: string,
    userId: string,
    limit = 50,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppChatListEntry[]> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const appUuid = parseUuidOrNull(appId);
    if (!wsUuid || !appUuid) return [];
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) return [];

    const rows = await db
      .select({
        id: chats.id,
        title: chats.title,
        createdAt: chats.createdAt,
        updatedAt: chats.updatedAt,
        activeStreamId: chats.activeStreamId,
      })
      .from(chats)
      .where(
        and(
          eq(chats.workspaceId, wsUuid),
          eq(chats.appId, appUuid),
          eq(chats.createdBy, userUuid),
          eq(chats.source, "app"),
        ),
      )
      .orderBy(desc(chats.updatedAt), desc(chats.id))
      .limit(limit);

    return rows.map(row => ({
      id: toWireId(row.id),
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      streaming: Boolean(row.activeStreamId),
    }));
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  async saveMessages(
    input: SaveChatMessagesInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatRecord | null> {
    const chatUuid = parseUuidOrNull(input.chatId);
    const wsUuid = parseUuidOrNull(input.workspaceId);
    if (!chatUuid || !wsUuid) return null;

    const now = input.now ?? new Date();
    const createdByUuid = await this.resolveUserUuid(input.userId, db);
    const usage =
      input.usage && input.usage.totalTokens > 0 ? input.usage : null;
    const nextLocalAcp = input.localAcp ?? null;

    return db.transaction(async tx => {
      // 1. Upsert chat header, clearing turn_checkpoint & updating local_acp / usage rollups.
      await tx
        .insert(chats)
        .values({
          id: chatUuid,
          workspaceId: wsUuid,
          createdBy: createdByUuid,
          title: "New Chat",
          titleGenerated: false,
          source: "chat",
          threadId: input.threadIdOnInsert ?? randomUUID(),
          turnCheckpoint: null,
          localAcp: nextLocalAcp,
          usagePromptTokens: usage ? usage.promptTokens : 0,
          usageCompletionTokens: usage ? usage.completionTokens : 0,
          usageTotalTokens: usage ? usage.totalTokens : 0,
          usageCacheReadTokens: usage ? (usage.cacheReadTokens ?? 0) : 0,
          usageCacheWriteTokens: usage ? (usage.cacheWriteTokens ?? 0) : 0,
          usageReasoningTokens: usage ? (usage.reasoningTokens ?? 0) : 0,
          usageCostUsd: usage ? String(usage.costUsd ?? 0) : "0",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: chats.id,
          set: {
            updatedAt: now,
            turnCheckpoint: null,
            localAcp: nextLocalAcp,
            ...(usage
              ? {
                  usagePromptTokens: sql`${chats.usagePromptTokens} + ${usage.promptTokens}`,
                  usageCompletionTokens: sql`${chats.usageCompletionTokens} + ${usage.completionTokens}`,
                  usageTotalTokens: sql`${chats.usageTotalTokens} + ${usage.totalTokens}`,
                  usageCacheReadTokens: sql`${chats.usageCacheReadTokens} + ${usage.cacheReadTokens ?? 0}`,
                  usageCacheWriteTokens: sql`${chats.usageCacheWriteTokens} + ${usage.cacheWriteTokens ?? 0}`,
                  usageReasoningTokens: sql`${chats.usageReasoningTokens} + ${usage.reasoningTokens ?? 0}`,
                  usageCostUsd: sql`${chats.usageCostUsd} + ${String(usage.costUsd ?? 0)}::numeric`,
                }
              : {}),
          },
        });

      // Explicit FOR UPDATE row lock serializes concurrent multi-segment entry_index allocation.
      await tx.execute(
        sql`SELECT "id" FROM "chats" WHERE "id" = ${chatUuid}::uuid FOR UPDATE`,
      );

      // 2. Diff-aware prefix preservation on chat_messages + chat_message_parts + metadata.
      await this.syncChatMessagesTx(tx, chatUuid, input.messages, now);

      // 3. Atomic entry_index allocation for chat_usage_entries.
      if (usage) {
        const nextIdxRaw = await tx.execute(
          sql`SELECT COALESCE(MAX("entry_index") + 1, 0)::int AS next_idx
                FROM "chat_usage_entries"
               WHERE "chat_id" = ${chatUuid}::uuid`,
        );
        const nextIdxRows = extractRows<{ next_idx: number | string }>(
          nextIdxRaw,
        );
        const entryIndex = Number(nextIdxRows[0]?.next_idx ?? 0);

        await tx.insert(chatUsageEntries).values({
          chatId: chatUuid,
          entryIndex,
          assistantMessageIndex: usage.assistantMessageIndex,
          model: usage.model ?? null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
          costUsd: String(usage.costUsd ?? 0),
          recordedAt: now,
        });
      }

      const [updatedChat] = await tx
        .select()
        .from(chats)
        .where(eq(chats.id, chatUuid))
        .limit(1);
      return updatedChat ? this.hydrateChat(updatedChat, tx) : null;
    });
  }

  /**
   * Idempotent full-chat backfill upsert guarded by `updated_at` so stale
   * backfill batches never overwrite newer live dual-writes.
   */
  async upsertFullChatWithGuard(
    record: ChatRecord,
    createdByUuid: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const chatUuid = parseUuidOrNull(record.id);
    const wsUuid = parseUuidOrNull(record.workspaceId);
    if (!chatUuid || !wsUuid) return false;

    const appUuid = parseUuidOrNull(record.appId);
    const pinnedConsoleUuid = parseUuidOrNull(record.pinnedConsoleId);
    const checkpointJson = record.turnCheckpoint
      ? {
          message: record.turnCheckpoint.message,
          at: record.turnCheckpoint.at.toISOString(),
          streamId: record.turnCheckpoint.streamId,
        }
      : null;

    return db.transaction(async tx => {
      const inserted = await tx
        .insert(chats)
        .values({
          id: chatUuid,
          workspaceId: wsUuid,
          createdBy: createdByUuid,
          title: record.title,
          titleGenerated: record.titleGenerated,
          source: record.source,
          appId: appUuid,
          threadId: record.threadId,
          activeAgent: record.activeAgent,
          pinnedConsoleId: pinnedConsoleUuid,
          activeStreamId: record.activeStreamId,
          activeStreamAliveAt: record.activeStreamAliveAt,
          turnCheckpoint: checkpointJson,
          localAcp: record.localAcp,
          systemPrompt: record.systemPrompt,
          workspacePrompt: record.workspacePrompt,
          usagePromptTokens: record.usage.promptTokens,
          usageCompletionTokens: record.usage.completionTokens,
          usageTotalTokens: record.usage.totalTokens,
          usageCacheReadTokens: record.usage.cacheReadTokens,
          usageCacheWriteTokens: record.usage.cacheWriteTokens,
          usageReasoningTokens: record.usage.reasoningTokens,
          usageCostUsd: String(record.usage.costUsd),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: chats.id,
          set: {
            createdBy: createdByUuid,
            title: record.title,
            titleGenerated: record.titleGenerated,
            source: record.source,
            appId: appUuid,
            threadId: record.threadId,
            activeAgent: record.activeAgent,
            pinnedConsoleId: pinnedConsoleUuid,
            activeStreamId: record.activeStreamId,
            activeStreamAliveAt: record.activeStreamAliveAt,
            turnCheckpoint: checkpointJson,
            localAcp: record.localAcp,
            systemPrompt: record.systemPrompt,
            workspacePrompt: record.workspacePrompt,
            usagePromptTokens: record.usage.promptTokens,
            usageCompletionTokens: record.usage.completionTokens,
            usageTotalTokens: record.usage.totalTokens,
            usageCacheReadTokens: record.usage.cacheReadTokens,
            usageCacheWriteTokens: record.usage.cacheWriteTokens,
            usageReasoningTokens: record.usage.reasoningTokens,
            usageCostUsd: String(record.usage.costUsd),
            updatedAt: record.updatedAt,
          },
          setWhere: sql`${chats.updatedAt} IS NULL OR EXCLUDED.updated_at >= ${chats.updatedAt}`,
        })
        .returning({ id: chats.id });

      if (inserted.length === 0) {
        return false;
      }

      await this.syncChatMessagesTx(
        tx,
        chatUuid,
        record.messages,
        record.updatedAt,
      );

      // Idempotent upsert of chat_usage_entries keyed on (chat_id, entry_index).
      if (record.usage.history.length > 0) {
        await tx
          .insert(chatUsageEntries)
          .values(
            record.usage.history.map((h, idx) => ({
              chatId: chatUuid,
              entryIndex: h.entryIndex ?? idx,
              assistantMessageIndex: h.messageIndex,
              model: h.model ?? null,
              promptTokens: h.promptTokens,
              completionTokens: h.completionTokens,
              totalTokens: h.totalTokens,
              cacheReadTokens: h.cacheReadTokens,
              cacheWriteTokens: h.cacheWriteTokens,
              reasoningTokens: h.reasoningTokens,
              costUsd: String(h.costUsd),
              recordedAt: h.timestamp,
            })),
          )
          .onConflictDoUpdate({
            target: [chatUsageEntries.chatId, chatUsageEntries.entryIndex],
            set: {
              assistantMessageIndex: sql`EXCLUDED.assistant_message_index`,
              model: sql`EXCLUDED.model`,
              promptTokens: sql`EXCLUDED.prompt_tokens`,
              completionTokens: sql`EXCLUDED.completion_tokens`,
              totalTokens: sql`EXCLUDED.total_tokens`,
              cacheReadTokens: sql`EXCLUDED.cache_read_tokens`,
              cacheWriteTokens: sql`EXCLUDED.cache_write_tokens`,
              reasoningTokens: sql`EXCLUDED.reasoning_tokens`,
              costUsd: sql`EXCLUDED.cost_usd`,
              recordedAt: sql`EXCLUDED.recorded_at`,
            },
          });
      }

      return true;
    });
  }

  async updateThreadFields(
    chatId: string,
    workspaceId: string | undefined,
    patch: UpdateChatThreadPatch,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatRecord | null> {
    const chatUuid = parseUuidOrNull(chatId);
    if (!chatUuid) return null;
    const conditions = [eq(chats.id, chatUuid)];
    if (workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(workspaceId);
      if (!wsUuid) return null;
      conditions.push(eq(chats.workspaceId, wsUuid));
    }

    const now = patch.updatedAt ?? new Date();
    const setValues: Record<string, unknown> = { updatedAt: now };
    if (patch.threadId !== undefined) setValues.threadId = patch.threadId;
    if (patch.activeAgent !== undefined) {
      setValues.activeAgent = patch.activeAgent;
    }
    if (patch.pinnedConsoleId !== undefined) {
      setValues.pinnedConsoleId = parseUuidOrNull(patch.pinnedConsoleId);
    }
    if (patch.systemPrompt !== undefined) {
      setValues.systemPrompt = patch.systemPrompt;
    }
    if (patch.workspacePrompt !== undefined) {
      setValues.workspacePrompt = patch.workspacePrompt;
    }

    return db.transaction(async tx => {
      const rows = await tx
        .update(chats)
        .set(setValues)
        .where(and(...conditions))
        .returning();
      if (!rows[0]) return null;

      if (patch.messages !== undefined) {
        await this.syncChatMessagesTx(tx, rows[0].id, patch.messages, now);
      }
      return this.hydrateChat(rows[0], tx);
    });
  }

  async updateLocalAcp(
    workspaceId: string,
    chatId: string,
    userId: string,
    localAcp: ChatLocalAcp | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return false;
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) return false;
    const rows = await db
      .update(chats)
      .set({ localAcp })
      .where(
        and(
          eq(chats.id, chatUuid),
          eq(chats.workspaceId, wsUuid),
          eq(chats.createdBy, userUuid),
        ),
      )
      .returning({ id: chats.id });
    return rows.length > 0;
  }

  async updateTitle(
    workspaceId: string,
    chatId: string,
    userId: string,
    title: string,
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return false;
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) return false;
    const rows = await db
      .update(chats)
      .set({ title, updatedAt: now })
      .where(
        and(
          eq(chats.id, chatUuid),
          eq(chats.workspaceId, wsUuid),
          eq(chats.createdBy, userUuid),
        ),
      )
      .returning({ id: chats.id });
    return rows.length > 0;
  }

  async setGeneratedTitleIfUnset(
    workspaceId: string,
    chatId: string,
    title: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return false;
    const rows = await db
      .update(chats)
      .set({ title, titleGenerated: true })
      .where(
        and(
          eq(chats.id, chatUuid),
          eq(chats.workspaceId, wsUuid),
          eq(chats.titleGenerated, false),
        ),
      )
      .returning({ id: chats.id });
    return rows.length > 0;
  }

  /**
   * Aura `deleteChatWithArtifactsTx` pattern:
   *   Verify ownership, capture `storage_key`s, and DELETE `chats` (cascading
   *   messages, parts, metadata, usage entries, and attachments) inside ONE
   *   transaction. Returns `deletedAttachmentKeys` ONLY after commit so a
   *   failed transaction or wrong-user request NEVER deletes object-store blobs.
   */
  async deleteOwned(
    workspaceId: string,
    chatId: string,
    userId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<{ deleted: boolean; deletedAttachmentKeys: string[] }> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) {
      return { deleted: false, deletedAttachmentKeys: [] };
    }
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) {
      return { deleted: false, deletedAttachmentKeys: [] };
    }

    return db.transaction(async tx => {
      const owned = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(
          and(
            eq(chats.id, chatUuid),
            eq(chats.workspaceId, wsUuid),
            eq(chats.createdBy, userUuid),
          ),
        )
        .limit(1);
      if (!owned[0]) {
        return { deleted: false, deletedAttachmentKeys: [] };
      }

      const attachmentRows = await tx
        .select({ storageKey: chatAttachments.storageKey })
        .from(chatAttachments)
        .where(eq(chatAttachments.chatId, chatUuid));

      const deleted = await tx
        .delete(chats)
        .where(
          and(
            eq(chats.id, chatUuid),
            eq(chats.workspaceId, wsUuid),
            eq(chats.createdBy, userUuid),
          ),
        )
        .returning({ id: chats.id });
      if (!deleted[0]) {
        return { deleted: false, deletedAttachmentKeys: [] };
      }

      return {
        deleted: true,
        deletedAttachmentKeys: attachmentRows.map(r => r.storageKey),
      };
    });
  }

  // ── Streaming & checkpointing ────────────────────────────────────────────

  async getStreamState(
    chatId: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<{
    workspaceId: string;
    activeStreamId: string | null;
    activeStreamAliveAt: Date | null;
  } | null> {
    const chatUuid = parseUuidOrNull(chatId);
    if (!chatUuid) return null;
    const conditions = [eq(chats.id, chatUuid)];
    if (workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(workspaceId);
      if (!wsUuid) return null;
      conditions.push(eq(chats.workspaceId, wsUuid));
    }
    const rows = await db
      .select({
        workspaceId: chats.workspaceId,
        activeStreamId: chats.activeStreamId,
        activeStreamAliveAt: chats.activeStreamAliveAt,
      })
      .from(chats)
      .where(and(...conditions))
      .limit(1);
    if (!rows[0]) return null;
    return {
      workspaceId: toWireId(rows[0].workspaceId),
      activeStreamId: rows[0].activeStreamId ?? null,
      activeStreamAliveAt: rows[0].activeStreamAliveAt ?? null,
    };
  }

  async setActiveStream(
    workspaceId: string,
    chatId: string,
    streamId: string,
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return;
    await db
      .update(chats)
      .set({ activeStreamId: streamId, activeStreamAliveAt: now })
      .where(and(eq(chats.id, chatUuid), eq(chats.workspaceId, wsUuid)));
  }

  async clearActiveStreamIfMatch(
    workspaceId: string,
    chatId: string,
    streamId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return;
    await db
      .update(chats)
      .set({ activeStreamId: null, activeStreamAliveAt: null })
      .where(
        and(
          eq(chats.id, chatUuid),
          eq(chats.workspaceId, wsUuid),
          eq(chats.activeStreamId, streamId),
        ),
      );
  }

  async clearActiveStream(
    workspaceId: string,
    chatId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return;
    await db
      .update(chats)
      .set({ activeStreamId: null, activeStreamAliveAt: null })
      .where(and(eq(chats.id, chatUuid), eq(chats.workspaceId, wsUuid)));
  }

  async saveTurnCheckpoint(
    workspaceId: string | undefined,
    chatId: string,
    streamId: string,
    message: StoredChatMessage,
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const chatUuid = parseUuidOrNull(chatId);
    if (!chatUuid) return;
    const conditions = [
      eq(chats.id, chatUuid),
      eq(chats.activeStreamId, streamId),
    ];
    if (workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(workspaceId);
      if (!wsUuid) return;
      conditions.push(eq(chats.workspaceId, wsUuid));
    }
    await db
      .update(chats)
      .set({
        activeStreamAliveAt: now,
        turnCheckpoint: {
          message,
          at: now.toISOString(),
          streamId,
        },
      })
      .where(and(...conditions));
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  async findAttachmentByHash(
    workspaceId: string,
    chatId: string,
    sha256: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatAttachmentRecord | null> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const chatUuid = parseUuidOrNull(chatId);
    if (!wsUuid || !chatUuid) return null;
    const rows = await db
      .select()
      .from(chatAttachments)
      .where(
        and(
          eq(chatAttachments.workspaceId, wsUuid),
          eq(chatAttachments.chatId, chatUuid),
          eq(chatAttachments.sha256, sha256),
        ),
      )
      .limit(1);
    return rows[0] ? pgChatAttachmentToRecord(rows[0]) : null;
  }

  async createAttachmentIdempotent(
    input: CreateChatAttachmentInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatAttachmentRecord> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    const chatUuid = parseUuidOrNull(input.chatId);
    if (!wsUuid || !chatUuid) {
      throw new Error("Invalid workspaceId or chatId for chat attachment");
    }
    const idUuid = input.id ? parseUuidOrNull(input.id) : newDualId().uuid;
    if (!idUuid) {
      throw new Error(`Invalid attachment id: ${JSON.stringify(input.id)}`);
    }
    const createdByUuid = await this.resolveUserUuid(input.createdBy, db);
    const now = input.createdAt ?? new Date();

    const inserted = await db
      .insert(chatAttachments)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        chatId: chatUuid,
        createdBy: createdByUuid,
        storageKey: input.storageKey,
        mediaType: input.mediaType,
        filename: input.filename ?? null,
        size: input.size,
        sha256: input.sha256,
        createdAt: now,
        updatedAt: input.updatedAt ?? now,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted[0]) {
      return pgChatAttachmentToRecord(inserted[0]);
    }
    const existing =
      (await this.findAttachmentByHash(
        input.workspaceId,
        input.chatId,
        input.sha256,
        db,
      )) ??
      (input.id
        ? await this.findAttachmentById(input.workspaceId, input.id, db)
        : null);
    if (!existing) {
      throw new Error(
        "Failed to create or fetch chat attachment after conflict",
      );
    }
    return existing;
  }

  /**
   * Idempotent backfill upsert for `chat_attachments`, followed by back-linking
   * any already-backfilled `chat_message_parts.attachment_id` whose `file_url`
   * references `/chat-images/<wireId>`.
   */
  async upsertAttachmentWithBacklink(
    record: ChatAttachmentRecord,
    createdByUuid: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = parseUuidOrNull(record.id);
    const wsUuid = parseUuidOrNull(record.workspaceId);
    const chatUuid = parseUuidOrNull(record.chatId);
    if (!idUuid || !wsUuid || !chatUuid) return false;

    const inserted = await db
      .insert(chatAttachments)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        chatId: chatUuid,
        createdBy: createdByUuid,
        storageKey: record.storageKey,
        mediaType: record.mediaType,
        filename: record.filename,
        size: record.size,
        sha256: record.sha256,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoNothing()
      .returning({ id: chatAttachments.id });

    // Resolve the actual target attachment UUID: if `onConflictDoNothing` skipped
    // because an existing row already holds `id` OR `(workspace_id, chat_id, sha256)`
    // under a different id, linking to `idUuid` would violate FK `chat_message_parts.attachment_id`.
    let targetAttachmentUuid = inserted[0]?.id ?? null;
    if (!targetAttachmentUuid) {
      const existing = await db
        .select({ id: chatAttachments.id })
        .from(chatAttachments)
        .where(
          or(
            eq(chatAttachments.id, idUuid),
            and(
              eq(chatAttachments.workspaceId, wsUuid),
              eq(chatAttachments.chatId, chatUuid),
              eq(chatAttachments.sha256, record.sha256),
            ),
          ),
        )
        .limit(1);
      targetAttachmentUuid = existing[0]?.id ?? null;
    }

    // Back-link file parts inserted during `chats` backfill before `chat_attachments` ran.
    if (targetAttachmentUuid) {
      const recordWireId = parseEntityId(record.id)?.oid ?? record.id;
      const wireSuffix = `/chat-images/${recordWireId}`;
      const urlMatch = or(
        sql`${chatMessageParts.fileUrl} LIKE ${`%${wireSuffix}`}`,
        sql`${chatMessageParts.fileUrl} LIKE ${`%${wireSuffix}?%`}`,
        sql`${chatMessageParts.fileUrl} LIKE ${`%${wireSuffix}#%`}`,
      );
      if (urlMatch) {
        await db
          .update(chatMessageParts)
          .set({ attachmentId: targetAttachmentUuid })
          .where(
            and(
              eq(chatMessageParts.chatId, chatUuid),
              eq(chatMessageParts.partType, "file"),
              sql`${chatMessageParts.attachmentId} IS NULL`,
              urlMatch,
            ),
          );
      }
    }

    return inserted.length > 0;
  }

  async findAttachmentById(
    workspaceId: string,
    attachmentId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatAttachmentRecord | null> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const idUuid = parseUuidOrNull(attachmentId);
    if (!wsUuid || !idUuid) return null;
    const rows = await db
      .select()
      .from(chatAttachments)
      .where(
        and(
          eq(chatAttachments.id, idUuid),
          eq(chatAttachments.workspaceId, wsUuid),
        ),
      )
      .limit(1);
    return rows[0] ? pgChatAttachmentToRecord(rows[0]) : null;
  }

  async findAttachmentForUser(
    workspaceId: string,
    attachmentId: string,
    userId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatAttachmentRecord | null> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const idUuid = parseUuidOrNull(attachmentId);
    if (!wsUuid || !idUuid) return null;
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) return null;
    const rows = await db
      .select()
      .from(chatAttachments)
      .where(
        and(
          eq(chatAttachments.id, idUuid),
          eq(chatAttachments.workspaceId, wsUuid),
          eq(chatAttachments.createdBy, userUuid),
        ),
      )
      .limit(1);
    return rows[0] ? pgChatAttachmentToRecord(rows[0]) : null;
  }

  /** Exported for contract tests asserting prefix stability on `saveMessages`. */
  async getMessageAndPartIds(
    chatId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<{
    messages: Array<Pick<ChatMessageRow, "id" | "ordinal" | "clientMessageId">>;
    parts: Array<{ id: string; messageId: string; orderIndex: number }>;
  }> {
    const chatUuid = parseUuidOrNull(chatId);
    if (!chatUuid) return { messages: [], parts: [] };
    const [messages, parts] = await Promise.all([
      db
        .select({
          id: chatMessages.id,
          ordinal: chatMessages.ordinal,
          clientMessageId: chatMessages.clientMessageId,
        })
        .from(chatMessages)
        .where(eq(chatMessages.chatId, chatUuid))
        .orderBy(asc(chatMessages.ordinal)),
      db
        .select({
          id: chatMessageParts.id,
          messageId: chatMessageParts.messageId,
          orderIndex: chatMessageParts.orderIndex,
        })
        .from(chatMessageParts)
        .where(eq(chatMessageParts.chatId, chatUuid))
        .orderBy(
          asc(chatMessageParts.messageId),
          asc(chatMessageParts.orderIndex),
        ),
    ]);
    return { messages, parts };
  }
}
