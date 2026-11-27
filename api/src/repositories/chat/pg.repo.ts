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
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
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
  type ChatMessagePartMetadataRow,
  type ChatMessagePartRow,
  type ChatMessageRow,
  type ChatRow,
} from "../../database/pg/schema/chat";
import {
  sanitizePgJsonValue,
  sanitizePgString,
} from "../../utils/message-sanitizer";
import {
  buildExcludedSet,
  chunkRows,
  chunkValues,
  dedupByKey,
  pickNewerByUpdatedAt,
} from "../../migration/bulk-helpers";
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

function parseUuidOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return parseEntityId(raw)?.uuid ?? null;
}

function sanitizeNullableString(raw: string | null | undefined): string | null {
  return raw == null ? null : sanitizePgString(raw);
}

/** Encode a nullable jsonb parameter preserving explicit JSON `null` (`'null'::jsonb`) vs SQL `NULL`. */
function toPgJsonbValue(hasValue: boolean, value: unknown) {
  if (!hasValue) return null;
  if (value === null) return sql`'null'::jsonb`;
  return sanitizePgJsonValue(value);
}

/**
 * Drizzle's built-in `PgJsonb.mapFromDriverValue` calls `JSON.parse(value)`
 * whenever `typeof value === "string"`, which double-parses JSONB string scalars
 * whose text happens to be valid JSON (e.g. MCP tool outputs such as
 * `'{"results":...}'`, `'123'`, `'true'`, `'null'`). Projecting the four
 * arbitrary-JSON tool columns via `::text` bypasses `PgJsonb.mapFromDriverValue`,
 * distinguishes SQL `NULL` (omitted) from JSON `'null'::jsonb`, avoids sending
 * large payloads twice over the wire, and decodes identically on both
 * `postgres.js` and `pglite`.
 */
const {
  toolInput: _omittedToolInput,
  toolOutput: _omittedToolOutput,
  toolRawInput: _omittedToolRawInput,
  toolMetadata: _omittedToolMetadata,
  ...chatMessagePartBaseColumns
} = getTableColumns(chatMessageParts);

const HYDRATED_PART_SELECT = {
  part: chatMessagePartBaseColumns,
  toolInputText: sql<string | null>`${chatMessageParts.toolInput}::text`,
  toolOutputText: sql<string | null>`${chatMessageParts.toolOutput}::text`,
  toolRawInputText: sql<string | null>`${chatMessageParts.toolRawInput}::text`,
  toolMetadataText: sql<string | null>`${chatMessageParts.toolMetadata}::text`,
  metadata: chatMessagePartMetadata,
};

type HydratedPartSelectRow = {
  part: Omit<
    ChatMessagePartRow,
    "toolInput" | "toolOutput" | "toolRawInput" | "toolMetadata"
  >;
  toolInputText: string | null;
  toolOutputText: string | null;
  toolRawInputText: string | null;
  toolMetadataText: string | null;
  metadata: ChatMessagePartMetadataRow | null;
};

function decodeExactPgJsonbText(rawText: string | null): unknown {
  return rawText === null ? null : (JSON.parse(rawText) as unknown);
}

function toHydratedPartRow(row: HydratedPartSelectRow): HydratedPartRow {
  const hasToolInput = row.toolInputText !== null;
  const hasToolOutput = row.toolOutputText !== null;
  const hasToolRawInput = row.toolRawInputText !== null;
  const hasToolMetadata = row.toolMetadataText !== null;
  return {
    part: {
      ...row.part,
      toolInput: decodeExactPgJsonbText(row.toolInputText),
      toolOutput: decodeExactPgJsonbText(row.toolOutputText),
      toolRawInput: decodeExactPgJsonbText(row.toolRawInputText),
      toolMetadata: decodeExactPgJsonbText(row.toolMetadataText),
    },
    hasToolInput,
    hasToolOutput,
    hasToolRawInput,
    hasToolMetadata,
    metadata: row.metadata ?? null,
  };
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
      .select(HYDRATED_PART_SELECT)
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
      const entry = toHydratedPartRow(row);
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
    const cleanIncoming = incomingMessages.map(msg => sanitizePgJsonValue(msg));
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

      const commonLen = Math.min(existingHydrated.length, cleanIncoming.length);
      while (changedFrom < commonLen) {
        if (
          existingRows[changedFrom].ordinal !== changedFrom ||
          computeMessageFingerprint(existingHydrated[changedFrom]) !==
            computeMessageFingerprint(cleanIncoming[changedFrom])
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

    if (changedFrom >= cleanIncoming.length) {
      return;
    }

    const tailMessages = cleanIncoming.slice(changedFrom);
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
          title: sanitizePgString(input.title ?? "New Chat"),
          titleGenerated: input.titleGenerated ?? false,
          source,
          appId: appUuid,
          threadId: sanitizeNullableString(input.threadId),
          activeAgent: input.activeAgent ?? null,
          pinnedConsoleId: pinnedConsoleUuid,
          systemPrompt: sanitizeNullableString(input.systemPrompt),
          workspacePrompt: sanitizeNullableString(input.workspacePrompt),
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

  async ensureExists(
    input: EnsureChatExistsInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const chatUuid = parseUuidOrNull(input.id);
    const wsUuid = parseUuidOrNull(input.workspaceId);
    if (!chatUuid || !wsUuid) return;
    const createdByUuid = await this.resolveUserUuid(input.createdBy, db);
    const now = input.now ?? new Date();
    const cleanLocalAcp = input.localAcp
      ? sanitizePgJsonValue(input.localAcp)
      : null;

    await db
      .insert(chats)
      .values({
        id: chatUuid,
        workspaceId: wsUuid,
        createdBy: createdByUuid,
        title: "New Chat",
        titleGenerated: false,
        source: "chat",
        threadId: sanitizePgString(input.threadId ?? randomUUID()),
        localAcp: cleanLocalAcp,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: chats.id });
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

  /**
   * Batch-load & hydrate multiple chats in 4 `IN (...)` queries (eliminates N+1
   * hydration in offline parity verification).
   */
  async findByIds(
    chatIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<Map<string, ChatRecord>> {
    const validUuids = [
      ...new Set(
        chatIds
          .map(parseUuidOrNull)
          .filter((u): u is string => u !== null)
          .map(u => u.toLowerCase()),
      ),
    ];
    const out = new Map<string, ChatRecord>();
    if (validUuids.length === 0) return out;

    for (const chunk of chunkValues(validUuids, 1000)) {
      const [chatRows, messageRows, joinedParts, usageRows] = await Promise.all(
        [
          db.select().from(chats).where(inArray(chats.id, chunk)),
          db
            .select()
            .from(chatMessages)
            .where(inArray(chatMessages.chatId, chunk))
            .orderBy(asc(chatMessages.ordinal)),
          db
            .select(HYDRATED_PART_SELECT)
            .from(chatMessageParts)
            .leftJoin(
              chatMessagePartMetadata,
              eq(chatMessagePartMetadata.partId, chatMessageParts.id),
            )
            .where(inArray(chatMessageParts.chatId, chunk))
            .orderBy(
              asc(chatMessageParts.messageId),
              asc(chatMessageParts.orderIndex),
            ),
          db
            .select()
            .from(chatUsageEntries)
            .where(inArray(chatUsageEntries.chatId, chunk))
            .orderBy(asc(chatUsageEntries.entryIndex)),
        ],
      );

      const msgsByChat = new Map<string, ChatMessageRow[]>();
      for (const m of messageRows) {
        const key = m.chatId.toLowerCase();
        const list = msgsByChat.get(key);
        if (list) list.push(m);
        else msgsByChat.set(key, [m]);
      }

      const partsByChat = new Map<string, Map<string, HydratedPartRow[]>>();
      for (const row of joinedParts) {
        const chatKey = row.part.chatId.toLowerCase();
        let byMsg = partsByChat.get(chatKey);
        if (!byMsg) {
          byMsg = new Map();
          partsByChat.set(chatKey, byMsg);
        }
        const entry = toHydratedPartRow(row);
        const list = byMsg.get(row.part.messageId);
        if (list) list.push(entry);
        else byMsg.set(row.part.messageId, [entry]);
      }

      const usageByChat = new Map<string, typeof usageRows>();
      for (const u of usageRows) {
        const key = u.chatId.toLowerCase();
        const list = usageByChat.get(key);
        if (list) list.push(u);
        else usageByChat.set(key, [u]);
      }

      for (const chatRow of chatRows) {
        const chatKey = chatRow.id.toLowerCase();
        out.set(
          chatKey,
          hydratePgChatRecord({
            chat: chatRow,
            messages: msgsByChat.get(chatKey) ?? [],
            partsByMessageId: partsByChat.get(chatKey) ?? new Map(),
            usageEntries: usageByChat.get(chatKey) ?? [],
          }),
        );
      }
    }
    return out;
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
    actorUserId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ChatOwnershipMeta | null> {
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
    const createdBy = rows[0].createdBy
      ? rows[0].createdBy.toLowerCase()
      : null;
    if (actorUserId === undefined) {
      return {
        createdBy,
        titleGenerated: rows[0].titleGenerated,
      };
    }
    const actorUuid = await this.resolveUserUuid(actorUserId, db);
    return {
      createdBy,
      titleGenerated: rows[0].titleGenerated,
      isOwnedByActor: Boolean(
        createdBy && actorUuid && createdBy === actorUuid,
      ),
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
    const nextLocalAcp = input.localAcp
      ? sanitizePgJsonValue(input.localAcp)
      : null;

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
          threadId: sanitizePgString(input.threadIdOnInsert ?? randomUUID()),
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
          model: sanitizeNullableString(usage.model),
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
          message: sanitizePgJsonValue(record.turnCheckpoint.message),
          at: record.turnCheckpoint.at.toISOString(),
          streamId: sanitizePgString(record.turnCheckpoint.streamId),
        }
      : null;
    const cleanTitle = sanitizePgString(record.title);
    const cleanThreadId = sanitizeNullableString(record.threadId);
    const cleanActiveStreamId = sanitizeNullableString(record.activeStreamId);
    const cleanLocalAcp = record.localAcp
      ? sanitizePgJsonValue(record.localAcp)
      : null;
    const cleanSystemPrompt = sanitizeNullableString(record.systemPrompt);
    const cleanWorkspacePrompt = sanitizeNullableString(record.workspacePrompt);

    return db.transaction(async tx => {
      const inserted = await tx
        .insert(chats)
        .values({
          id: chatUuid,
          workspaceId: wsUuid,
          createdBy: createdByUuid,
          title: cleanTitle,
          titleGenerated: record.titleGenerated,
          source: record.source,
          appId: appUuid,
          threadId: cleanThreadId,
          activeAgent: record.activeAgent,
          pinnedConsoleId: pinnedConsoleUuid,
          activeStreamId: cleanActiveStreamId,
          activeStreamAliveAt: record.activeStreamAliveAt,
          turnCheckpoint: checkpointJson,
          localAcp: cleanLocalAcp,
          systemPrompt: cleanSystemPrompt,
          workspacePrompt: cleanWorkspacePrompt,
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
            title: cleanTitle,
            titleGenerated: record.titleGenerated,
            source: record.source,
            appId: appUuid,
            threadId: cleanThreadId,
            activeAgent: record.activeAgent,
            pinnedConsoleId: pinnedConsoleUuid,
            activeStreamId: cleanActiveStreamId,
            activeStreamAliveAt: record.activeStreamAliveAt,
            turnCheckpoint: checkpointJson,
            localAcp: cleanLocalAcp,
            systemPrompt: cleanSystemPrompt,
            workspacePrompt: cleanWorkspacePrompt,
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
              model: sanitizeNullableString(h.model),
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

  /**
   * Vectorized full-chat backfill upsert guarded by `updated_at`.
   * Preserves byte-exact prefix fingerprinting, message/part/metadata/usage
   * layout, and stale-write guards while executing O(1) bulk statements per
   * chunk instead of per-chat round-trips.
   */
  async upsertFullChatsBatchWithGuard(
    entries: ReadonlyArray<{
      record: ChatRecord;
      createdByUuid: string | null;
    }>,
    db: MakoPgDb = this.getDb(),
  ): Promise<number> {
    if (entries.length === 0) return 0;

    interface PreparedChatEntry {
      chatUuid: string;
      record: ChatRecord;
      createdByUuid: string | null;
      updatedAt: Date;
      chatRow: typeof chats.$inferInsert;
    }

    const preparedRaw: PreparedChatEntry[] = [];
    for (const { record, createdByUuid } of entries) {
      const chatUuid = parseUuidOrNull(record.id);
      const wsUuid = parseUuidOrNull(record.workspaceId);
      if (!chatUuid || !wsUuid) continue;
      const appUuid = parseUuidOrNull(record.appId);
      const pinnedConsoleUuid = parseUuidOrNull(record.pinnedConsoleId);
      const checkpointJson = record.turnCheckpoint
        ? {
            message: sanitizePgJsonValue(record.turnCheckpoint.message),
            at: record.turnCheckpoint.at.toISOString(),
            streamId: sanitizePgString(record.turnCheckpoint.streamId),
          }
        : null;
      preparedRaw.push({
        chatUuid: chatUuid.toLowerCase(),
        record,
        createdByUuid,
        updatedAt: record.updatedAt,
        chatRow: {
          id: chatUuid.toLowerCase(),
          workspaceId: wsUuid,
          createdBy: createdByUuid,
          title: sanitizePgString(record.title),
          titleGenerated: record.titleGenerated,
          source: record.source,
          appId: appUuid,
          threadId: sanitizeNullableString(record.threadId),
          activeAgent: record.activeAgent,
          pinnedConsoleId: pinnedConsoleUuid,
          activeStreamId: sanitizeNullableString(record.activeStreamId),
          activeStreamAliveAt: record.activeStreamAliveAt,
          turnCheckpoint: checkpointJson,
          localAcp: record.localAcp
            ? sanitizePgJsonValue(record.localAcp)
            : null,
          systemPrompt: sanitizeNullableString(record.systemPrompt),
          workspacePrompt: sanitizeNullableString(record.workspacePrompt),
          usagePromptTokens: record.usage.promptTokens,
          usageCompletionTokens: record.usage.completionTokens,
          usageTotalTokens: record.usage.totalTokens,
          usageCacheReadTokens: record.usage.cacheReadTokens,
          usageCacheWriteTokens: record.usage.cacheWriteTokens,
          usageReasoningTokens: record.usage.reasoningTokens,
          usageCostUsd: String(record.usage.costUsd),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    const deduped = dedupByKey(
      preparedRaw,
      e => e.chatUuid,
      pickNewerByUpdatedAt,
    );
    if (deduped.length === 0) return 0;

    const chatSetCols = buildExcludedSet(chats, [
      "id",
      "workspaceId",
      "createdAt",
    ]);
    let totalUpserted = 0;

    for (const chunk of chunkRows(deduped, 25, 100)) {
      // 1. Bulk upsert chat headers with stale-write guard.
      const inserted = await db
        .insert(chats)
        .values(chunk.map(e => e.chatRow))
        .onConflictDoUpdate({
          target: chats.id,
          set: chatSetCols,
          setWhere: sql`${chats.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${chats.updatedAt}`,
        })
        .returning({ id: chats.id });

      if (inserted.length === 0) continue;

      const writtenIds = new Set(inserted.map(r => r.id.toLowerCase()));
      const writtenEntries = chunk.filter(e => writtenIds.has(e.chatUuid));
      totalUpserted += writtenEntries.length;

      const writtenChatUuids = writtenEntries.map(e => e.chatUuid);

      // 2. Batch-fetch existing messages across all written chats in this chunk.
      const existingMsgs = await db
        .select()
        .from(chatMessages)
        .where(inArray(chatMessages.chatId, writtenChatUuids))
        .orderBy(asc(chatMessages.ordinal));

      const existingMsgsByChat = new Map<string, ChatMessageRow[]>();
      for (const m of existingMsgs) {
        const key = m.chatId.toLowerCase();
        const list = existingMsgsByChat.get(key);
        if (list) list.push(m);
        else existingMsgsByChat.set(key, [m]);
      }

      // Only load existing parts when at least one chat already had messages (live overlap / re-run).
      const existingPartsByChat = new Map<
        string,
        Map<string, HydratedPartRow[]>
      >();
      if (existingMsgsByChat.size > 0) {
        const chatIdsWithMsgs = [...existingMsgsByChat.keys()];
        const joined = await db
          .select(HYDRATED_PART_SELECT)
          .from(chatMessageParts)
          .leftJoin(
            chatMessagePartMetadata,
            eq(chatMessagePartMetadata.partId, chatMessageParts.id),
          )
          .where(inArray(chatMessageParts.chatId, chatIdsWithMsgs))
          .orderBy(
            asc(chatMessageParts.messageId),
            asc(chatMessageParts.orderIndex),
          );

        for (const row of joined) {
          const chatKey = row.part.chatId.toLowerCase();
          let byMsg = existingPartsByChat.get(chatKey);
          if (!byMsg) {
            byMsg = new Map();
            existingPartsByChat.set(chatKey, byMsg);
          }
          const entry = toHydratedPartRow(row);
          const list = byMsg.get(row.part.messageId);
          if (list) list.push(entry);
          else byMsg.set(row.part.messageId, [entry]);
        }
      }

      // Compute diff-aware prefix per chat & collect deletes + tail message inserts.
      const deleteConditions: Array<ReturnType<typeof and>> = [];
      const pendingMessages: Array<{
        chatUuid: string;
        ordinal: number;
        msg: StoredChatMessage;
        now: Date;
      }> = [];

      for (const entry of writtenEntries) {
        const cleanIncoming = entry.record.messages.map(msg =>
          sanitizePgJsonValue(msg),
        );
        const existingRows = existingMsgsByChat.get(entry.chatUuid) ?? [];
        let changedFrom = 0;

        if (existingRows.length > 0) {
          const existingHydrated = hydratePgChatRecord({
            chat: {
              id: entry.chatUuid,
              workspaceId: entry.chatUuid,
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
              createdAt: entry.updatedAt,
              updatedAt: entry.updatedAt,
            },
            messages: existingRows,
            partsByMessageId:
              existingPartsByChat.get(entry.chatUuid) ?? new Map(),
            usageEntries: [],
          }).messages;

          const commonLen = Math.min(
            existingHydrated.length,
            cleanIncoming.length,
          );
          while (changedFrom < commonLen) {
            if (
              existingRows[changedFrom].ordinal !== changedFrom ||
              computeMessageFingerprint(existingHydrated[changedFrom]) !==
                computeMessageFingerprint(cleanIncoming[changedFrom])
            ) {
              break;
            }
            changedFrom += 1;
          }

          if (changedFrom < existingRows.length) {
            deleteConditions.push(
              and(
                eq(chatMessages.chatId, entry.chatUuid),
                sql`${chatMessages.ordinal} >= ${changedFrom}`,
              ),
            );
          }
        }

        for (let ord = changedFrom; ord < cleanIncoming.length; ord++) {
          pendingMessages.push({
            chatUuid: entry.chatUuid,
            ordinal: ord,
            msg: cleanIncoming[ord],
            now: entry.updatedAt,
          });
        }
      }

      if (deleteConditions.length > 0) {
        const whereDelete =
          deleteConditions.length === 1
            ? deleteConditions[0]
            : or(...deleteConditions);
        if (whereDelete) {
          await db.delete(chatMessages).where(whereDelete);
        }
      }

      // 3. Bulk-insert all tail chat_messages across the chunk.
      if (pendingMessages.length > 0) {
        const messageIdByChatOrdinal = new Map<string, string>();
        for (const msgChunk of chunkRows(pendingMessages, 6, 300)) {
          const insertedMsgs = await db
            .insert(chatMessages)
            .values(
              msgChunk.map(m => ({
                chatId: m.chatUuid,
                ordinal: m.ordinal,
                clientMessageId: m.msg.id ?? null,
                role: m.msg.role,
                metadata: m.msg.metadata ?? null,
                createdAt: m.msg.createdAt ?? m.now,
              })),
            )
            .returning({
              id: chatMessages.id,
              chatId: chatMessages.chatId,
              ordinal: chatMessages.ordinal,
            });
          for (const row of insertedMsgs) {
            messageIdByChatOrdinal.set(
              `${row.chatId.toLowerCase()}:${row.ordinal}`,
              row.id,
            );
          }
        }

        // 4. Unpack all parts across inserted tail messages.
        const pendingParts: Array<{
          chatUuid: string;
          messageId: string;
          now: Date;
          unpacked: UnpackedPartForPg;
        }> = [];
        const candidateAttachmentUuids = new Set<string>();

        for (const m of pendingMessages) {
          const messageId = messageIdByChatOrdinal.get(
            `${m.chatUuid}:${m.ordinal}`,
          );
          if (!messageId) continue;
          const parts = Array.isArray(m.msg.parts) ? m.msg.parts : [];
          for (let orderIndex = 0; orderIndex < parts.length; orderIndex++) {
            const unpacked = unpackPartForPg(parts[orderIndex], orderIndex);
            if (unpacked.candidateAttachmentUuid) {
              candidateAttachmentUuids.add(unpacked.candidateAttachmentUuid);
            }
            pendingParts.push({
              chatUuid: m.chatUuid,
              messageId,
              now: m.now,
              unpacked,
            });
          }
        }

        if (pendingParts.length > 0) {
          const validChatAttachments = new Set<string>();
          if (candidateAttachmentUuids.size > 0) {
            for (const attChunk of chunkValues([...candidateAttachmentUuids])) {
              const attRows = await db
                .select({
                  id: chatAttachments.id,
                  chatId: chatAttachments.chatId,
                })
                .from(chatAttachments)
                .where(inArray(chatAttachments.id, attChunk));
              for (const r of attRows) {
                validChatAttachments.add(
                  `${r.chatId.toLowerCase()}:${r.id.toLowerCase()}`,
                );
              }
            }
          }

          const pendingMetadata: Array<{
            partId: string;
            providerMetadata: unknown;
            callProviderMetadata: unknown;
            resultProviderMetadata: unknown;
          }> = [];

          for (const partChunk of chunkRows(pendingParts, 25, 100)) {
            const insertedParts = await db
              .insert(chatMessageParts)
              .values(
                partChunk.map(({ chatUuid, messageId, now, unpacked }) => ({
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
                    validChatAttachments.has(
                      `${chatUuid}:${unpacked.candidateAttachmentUuid}`,
                    )
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
            for (const { messageId, unpacked } of partChunk) {
              if (!unpacked.metadata) continue;
              const partId = partIdByKey.get(
                `${messageId}:${unpacked.orderIndex}`,
              );
              if (!partId) continue;
              pendingMetadata.push({
                partId,
                providerMetadata: unpacked.metadata.providerMetadata ?? null,
                callProviderMetadata:
                  unpacked.metadata.callProviderMetadata ?? null,
                resultProviderMetadata:
                  unpacked.metadata.resultProviderMetadata ?? null,
              });
            }
          }

          for (const metaChunk of chunkRows(pendingMetadata, 4, 250)) {
            await db.insert(chatMessagePartMetadata).values(metaChunk);
          }
        }
      }

      // 5. Bulk-upsert chat_usage_entries across all written chats in this chunk.
      const pendingUsage: Array<typeof chatUsageEntries.$inferInsert> = [];
      for (const entry of writtenEntries) {
        for (let idx = 0; idx < entry.record.usage.history.length; idx++) {
          const h = entry.record.usage.history[idx];
          pendingUsage.push({
            chatId: entry.chatUuid,
            entryIndex: h.entryIndex ?? idx,
            assistantMessageIndex: h.messageIndex,
            model: sanitizeNullableString(h.model),
            promptTokens: h.promptTokens,
            completionTokens: h.completionTokens,
            totalTokens: h.totalTokens,
            cacheReadTokens: h.cacheReadTokens,
            cacheWriteTokens: h.cacheWriteTokens,
            reasoningTokens: h.reasoningTokens,
            costUsd: String(h.costUsd),
            recordedAt: h.timestamp,
          });
        }
      }
      if (pendingUsage.length > 0) {
        const dedupedUsage = dedupByKey(
          pendingUsage,
          u => `${u.chatId}:${u.entryIndex}`,
        );
        for (const usageChunk of chunkRows(dedupedUsage, 12, 300)) {
          await db
            .insert(chatUsageEntries)
            .values(usageChunk)
            .onConflictDoUpdate({
              target: [chatUsageEntries.chatId, chatUsageEntries.entryIndex],
              set: {
                assistantMessageIndex: sql`EXCLUDED."assistant_message_index"`,
                model: sql`EXCLUDED."model"`,
                promptTokens: sql`EXCLUDED."prompt_tokens"`,
                completionTokens: sql`EXCLUDED."completion_tokens"`,
                totalTokens: sql`EXCLUDED."total_tokens"`,
                cacheReadTokens: sql`EXCLUDED."cache_read_tokens"`,
                cacheWriteTokens: sql`EXCLUDED."cache_write_tokens"`,
                reasoningTokens: sql`EXCLUDED."reasoning_tokens"`,
                costUsd: sql`EXCLUDED."cost_usd"`,
                recordedAt: sql`EXCLUDED."recorded_at"`,
              },
            });
        }
      }
    }

    return totalUpserted;
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
    if (patch.threadId !== undefined) {
      setValues.threadId = sanitizePgString(patch.threadId);
    }
    if (patch.activeAgent !== undefined) {
      setValues.activeAgent = patch.activeAgent;
    }
    if (patch.pinnedConsoleId !== undefined) {
      setValues.pinnedConsoleId = parseUuidOrNull(patch.pinnedConsoleId);
    }
    if (patch.systemPrompt !== undefined) {
      setValues.systemPrompt = sanitizeNullableString(patch.systemPrompt);
    }
    if (patch.workspacePrompt !== undefined) {
      setValues.workspacePrompt = sanitizeNullableString(patch.workspacePrompt);
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
    const cleanLocalAcp = localAcp ? sanitizePgJsonValue(localAcp) : null;
    const rows = await db
      .update(chats)
      .set({ localAcp: cleanLocalAcp })
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
      .set({ title: sanitizePgString(title), updatedAt: now })
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
      .set({ title: sanitizePgString(title), titleGenerated: true })
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
          message: sanitizePgJsonValue(message),
          at: now.toISOString(),
          streamId: sanitizePgString(streamId),
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
        storageKey: sanitizePgString(input.storageKey),
        mediaType: sanitizePgString(input.mediaType),
        filename: sanitizeNullableString(input.filename),
        size: input.size,
        sha256: sanitizePgString(input.sha256),
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
        storageKey: sanitizePgString(record.storageKey),
        mediaType: sanitizePgString(record.mediaType),
        filename: sanitizeNullableString(record.filename),
        size: record.size,
        sha256: sanitizePgString(record.sha256),
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

  /**
   * Vectorized backfill upsert for `chat_attachments` + bulk back-linking of
   * `chat_message_parts.attachment_id` whose `file_url` references `/chat-images/<wireId>`.
   */
  async upsertAttachmentsBatchWithBacklink(
    entries: ReadonlyArray<{
      record: ChatAttachmentRecord;
      createdByUuid: string | null;
    }>,
    db: MakoPgDb = this.getDb(),
  ): Promise<number> {
    if (entries.length === 0) return 0;

    interface PreparedAttachment {
      idUuid: string;
      wsUuid: string;
      chatUuid: string;
      wireId: string;
      sha256: string;
      row: typeof chatAttachments.$inferInsert;
    }

    const preparedRaw: PreparedAttachment[] = [];
    for (const { record, createdByUuid } of entries) {
      const idUuid = parseUuidOrNull(record.id)?.toLowerCase();
      const wsUuid = parseUuidOrNull(record.workspaceId)?.toLowerCase();
      const chatUuid = parseUuidOrNull(record.chatId)?.toLowerCase();
      if (!idUuid || !wsUuid || !chatUuid) continue;
      const cleanSha = sanitizePgString(record.sha256);
      preparedRaw.push({
        idUuid,
        wsUuid,
        chatUuid,
        wireId: parseEntityId(record.id)?.oid ?? record.id,
        sha256: cleanSha,
        row: {
          id: idUuid,
          workspaceId: wsUuid,
          chatId: chatUuid,
          createdBy: createdByUuid,
          storageKey: sanitizePgString(record.storageKey),
          mediaType: sanitizePgString(record.mediaType),
          filename: sanitizeNullableString(record.filename),
          size: record.size,
          sha256: cleanSha,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    const deduped = dedupByKey(
      dedupByKey(
        preparedRaw,
        e => e.idUuid,
        existing => existing,
      ),
      e => `${e.wsUuid}\0${e.chatUuid}\0${e.sha256}`,
      existing => existing,
    );
    if (deduped.length === 0) return 0;

    let insertedCount = 0;
    const insertedIds = new Set<string>();
    for (const sub of chunkRows(deduped, 11, 300)) {
      const inserted = await db
        .insert(chatAttachments)
        .values(sub.map(e => e.row))
        .onConflictDoNothing()
        .returning({ id: chatAttachments.id });
      insertedCount += inserted.length;
      for (const r of inserted) insertedIds.add(r.id.toLowerCase());
    }

    // Resolve actual attachment UUIDs for any conflicted rows so back-links
    // never point at a non-existent UUID.
    const conflicted = deduped.filter(e => !insertedIds.has(e.idUuid));
    const existingById = new Map<string, string>();
    const existingByHash = new Map<string, string>();
    if (conflicted.length > 0) {
      const conflictChatIds = [...new Set(conflicted.map(e => e.chatUuid))];
      for (const chatChunk of chunkValues(conflictChatIds)) {
        const existing = await db
          .select({
            id: chatAttachments.id,
            workspaceId: chatAttachments.workspaceId,
            chatId: chatAttachments.chatId,
            sha256: chatAttachments.sha256,
          })
          .from(chatAttachments)
          .where(inArray(chatAttachments.chatId, chatChunk));
        for (const r of existing) {
          const id = r.id.toLowerCase();
          existingById.set(id, id);
          existingByHash.set(
            `${r.workspaceId.toLowerCase()}\0${r.chatId.toLowerCase()}\0${r.sha256}`,
            id,
          );
        }
      }
    }

    // Group target attachment UUIDs by chatId for bulk back-linking.
    const targetsByChat = new Map<
      string,
      Array<{ suffix: string; targetUuid: string }>
    >();
    for (const e of deduped) {
      const targetUuid = insertedIds.has(e.idUuid)
        ? e.idUuid
        : (existingById.get(e.idUuid) ??
          existingByHash.get(`${e.wsUuid}\0${e.chatUuid}\0${e.sha256}`) ??
          null);
      if (!targetUuid) continue;
      const suffix = `/chat-images/${e.wireId}`;
      const list = targetsByChat.get(e.chatUuid);
      if (list) list.push({ suffix, targetUuid });
      else targetsByChat.set(e.chatUuid, [{ suffix, targetUuid }]);
    }

    if (targetsByChat.size > 0) {
      const chatIdsToScan = [...targetsByChat.keys()];
      const partUpdates: Array<{ partId: string; attachmentId: string }> = [];
      for (const chatChunk of chunkValues(chatIdsToScan)) {
        const unlinkedParts = await db
          .select({
            id: chatMessageParts.id,
            chatId: chatMessageParts.chatId,
            fileUrl: chatMessageParts.fileUrl,
          })
          .from(chatMessageParts)
          .where(
            and(
              inArray(chatMessageParts.chatId, chatChunk),
              eq(chatMessageParts.partType, "file"),
              sql`${chatMessageParts.attachmentId} IS NULL`,
              sql`${chatMessageParts.fileUrl} IS NOT NULL`,
            ),
          );

        for (const part of unlinkedParts) {
          const url = part.fileUrl;
          if (!url) continue;
          const candidates = targetsByChat.get(part.chatId.toLowerCase());
          if (!candidates) continue;
          for (const { suffix, targetUuid } of candidates) {
            const idx = url.indexOf(suffix);
            if (idx === -1) continue;
            const after = url[idx + suffix.length];
            if (after === undefined || after === "?" || after === "#") {
              partUpdates.push({ partId: part.id, attachmentId: targetUuid });
              break;
            }
          }
        }
      }

      for (const updChunk of chunkRows(partUpdates, 2, 300)) {
        const valuesSql = sql.join(
          updChunk.map(u => sql`(${u.partId}::uuid, ${u.attachmentId}::uuid)`),
          sql`, `,
        );
        await db.execute(sql`
          UPDATE "chat_message_parts" AS t
          SET "attachment_id" = v."attachment_id"
          FROM (VALUES ${valuesSql}) AS v("id", "attachment_id")
          WHERE t."id" = v."id" AND t."attachment_id" IS NULL
        `);
      }
    }

    return insertedCount;
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
    const ordinalByMessageId = new Map(messages.map(m => [m.id, m.ordinal]));
    parts.sort((a, b) => {
      const ordDiff =
        (ordinalByMessageId.get(a.messageId) ?? Number.MAX_SAFE_INTEGER) -
        (ordinalByMessageId.get(b.messageId) ?? Number.MAX_SAFE_INTEGER);
      return ordDiff !== 0 ? ordDiff : a.orderIndex - b.orderIndex;
    });
    return { messages, parts };
  }
}
