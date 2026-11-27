/**
 * Phase 3 (Part 2 — normalized `chat` domain) platform Postgres Drizzle schema.
 *
 * Covers the 6 normalized chat tables (`0008_phase3_chat.sql`):
 *   - `chats`                      (header, stream pointer, ACP binding, usage rollups)
 *   - `chat_messages`              (ordered message headers; NO `parts jsonb` column)
 *   - `chat_attachments`           (bijective UUIDv8 PK preserving `/chat-images/:id`)
 *   - `chat_message_parts`         (one row per UIMessage part, typed columns + CHECKs)
 *   - `chat_message_part_metadata` (1:1 sparse provider metadata / thinking signatures)
 *   - `chat_usage_entries`         (unpacked per-segment usage history keyed by `entry_index`)
 *
 * Chat streams remain on Redis `resumable-stream` permanently (Decision #8 — NO
 * `chat_stream_events` / `stream_event` table in Postgres).
 */
import { desc, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { workspaces } from "./workspaces";

export const CHAT_SOURCES = ["chat", "app", "workflow"] as const;
export type ChatSource = (typeof CHAT_SOURCES)[number];

export const CHAT_ACTIVE_AGENTS = ["mongo", "bigquery", "triage"] as const;
export type ChatActiveAgent = (typeof CHAT_ACTIVE_AGENTS)[number];

export const CHAT_MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

export const CHAT_PART_TYPES = [
  "text",
  "reasoning",
  "file",
  "tool",
  "step-start",
  "source-url",
  "source-document",
  "other",
] as const;
export type ChatPartType = (typeof CHAT_PART_TYPES)[number];

export const CHAT_TOOL_STATES = [
  "input-streaming",
  "input-available",
  "output-streaming",
  "output-available",
  "output-error",
  "output-denied",
  "approval-requested",
  "approval-responded",
  "error",
] as const;
export type ChatToolState = (typeof CHAT_TOOL_STATES)[number];

export interface ChatTurnCheckpointJson {
  message: unknown;
  at: string;
  streamId: string;
}

export interface ChatLocalAcpJson {
  providerId: string;
  sessionId: string;
  modelId: string;
}

export const chats = pgTable(
  "chats",
  {
    /** Bijective ObjectId <-> RFC 9562 UUIDv8. */
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Nullable UUIDv7 FK: NULL for `"system"` chats and deleted users. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default("New Chat"),
    titleGenerated: boolean("title_generated").notNull().default(false),
    source: text("source").$type<ChatSource>().notNull().default("chat"),
    /** Bijective appId (soft ref: app may live only in git). */
    appId: uuid("app_id"),
    threadId: text("thread_id"),
    activeAgent: text("active_agent").$type<ChatActiveAgent>(),
    /** Bijective SavedConsole._id (soft ref). */
    pinnedConsoleId: uuid("pinned_console_id"),
    activeStreamId: text("active_stream_id"),
    activeStreamAliveAt: timestamp("active_stream_alive_at", {
      withTimezone: true,
    }),
    turnCheckpoint: jsonb("turn_checkpoint").$type<ChatTurnCheckpointJson>(),
    localAcp: jsonb("local_acp").$type<ChatLocalAcpJson>(),
    systemPrompt: text("system_prompt"),
    workspacePrompt: text("workspace_prompt"),
    usagePromptTokens: bigint("usage_prompt_tokens", { mode: "number" })
      .notNull()
      .default(0),
    usageCompletionTokens: bigint("usage_completion_tokens", { mode: "number" })
      .notNull()
      .default(0),
    usageTotalTokens: bigint("usage_total_tokens", { mode: "number" })
      .notNull()
      .default(0),
    usageCacheReadTokens: bigint("usage_cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    usageCacheWriteTokens: bigint("usage_cache_write_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    usageReasoningTokens: bigint("usage_reasoning_tokens", { mode: "number" })
      .notNull()
      .default(0),
    usageCostUsd: numeric("usage_cost_usd", { precision: 14, scale: 8 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("idx_chats_user_list")
      .on(
        table.workspaceId,
        table.createdBy,
        desc(table.updatedAt),
        desc(table.id),
      )
      .where(sql`${table.source} = 'chat' AND ${table.createdBy} IS NOT NULL`),
    index("idx_chats_app_list")
      .on(
        table.workspaceId,
        table.appId,
        table.createdBy,
        desc(table.updatedAt),
        desc(table.id),
      )
      .where(sql`${table.source} = 'app' AND ${table.appId} IS NOT NULL`),
    uniqueIndex("idx_chats_thread_id")
      .on(table.threadId)
      .where(sql`${table.threadId} IS NOT NULL`),
    index("idx_chats_active_stream")
      .on(table.activeStreamId)
      .where(sql`${table.activeStreamId} IS NOT NULL`),
    check(
      "chats_source_check",
      sql`${table.source} IN ('chat', 'app', 'workflow')`,
    ),
    check(
      "chats_active_agent_check",
      sql`${table.activeAgent} IS NULL OR ${table.activeAgent} IN ('mongo', 'bigquery', 'triage')`,
    ),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    clientMessageId: text("client_message_id"),
    role: text("role").$type<ChatMessageRole>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    unique("chat_messages_chat_ordinal_unique").on(table.chatId, table.ordinal),
    index("idx_chat_messages_chat_client_id")
      .on(table.chatId, table.clientMessageId)
      .where(sql`${table.clientMessageId} IS NOT NULL`),
    check("chat_messages_ordinal_check", sql`${table.ordinal} >= 0`),
    check(
      "chat_messages_role_check",
      sql`${table.role} IN ('user', 'assistant', 'system')`,
    ),
  ],
);

export const chatAttachments = pgTable(
  "chat_attachments",
  {
    /** Bijective ObjectId <-> RFC 9562 UUIDv8 (preserves `/chat-images/:id`). */
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    storageKey: text("storage_key").notNull(),
    mediaType: text("media_type").notNull(),
    filename: text("filename"),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    unique("chat_attachments_dedup_unique").on(
      table.workspaceId,
      table.chatId,
      table.sha256,
    ),
    index("idx_chat_attachments_chat").on(table.chatId),
    index("idx_chat_attachments_ws").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
    check("chat_attachments_size_check", sql`${table.size} >= 0`),
  ],
);

export const chatMessageParts = pgTable(
  "chat_message_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    partType: text("part_type").$type<ChatPartType>().notNull(),
    rawType: text("raw_type"),
    textValue: text("text_value"),
    fileUrl: text("file_url"),
    fileMediaType: text("file_media_type"),
    fileFilename: text("file_filename"),
    attachmentId: uuid("attachment_id").references(() => chatAttachments.id, {
      onDelete: "set null",
    }),
    isDynamicTool: boolean("is_dynamic_tool"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    toolState: text("tool_state").$type<ChatToolState>(),
    toolInput: jsonb("tool_input"),
    toolOutput: jsonb("tool_output"),
    toolErrorText: text("tool_error_text"),
    toolRawInput: jsonb("tool_raw_input"),
    toolApproval: jsonb("tool_approval").$type<Record<string, unknown>>(),
    toolProviderExecuted: boolean("tool_provider_executed"),
    toolPreliminary: boolean("tool_preliminary"),
    toolTitle: text("tool_title"),
    toolMetadata: jsonb("tool_metadata"),
    extraPayload: jsonb("extra_payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    unique("chat_message_parts_msg_order_unique").on(
      table.messageId,
      table.orderIndex,
    ),
    index("idx_chat_parts_chat_msg_order").on(
      table.chatId,
      table.messageId,
      table.orderIndex,
    ),
    index("idx_chat_parts_chat_tool")
      .on(table.chatId, table.toolName)
      .where(sql`${table.partType} = 'tool'`),
    index("idx_chat_parts_tool_call_id")
      .on(table.toolCallId)
      .where(sql`${table.toolCallId} IS NOT NULL`),
    index("idx_chat_parts_attachment")
      .on(table.attachmentId)
      .where(sql`${table.attachmentId} IS NOT NULL`),
    check(
      "chat_message_parts_order_index_check",
      sql`${table.orderIndex} >= 0`,
    ),
    check(
      "chat_message_parts_part_type_check",
      sql`${table.partType} IN ('text', 'reasoning', 'file', 'tool', 'step-start', 'source-url', 'source-document', 'other')`,
    ),
    check(
      "chat_message_parts_tool_state_check",
      sql`${table.toolState} IS NULL OR ${table.toolState} IN ('input-streaming', 'input-available', 'output-streaming', 'output-available', 'output-error', 'output-denied', 'approval-requested', 'approval-responded', 'error')`,
    ),
    check(
      "chat_message_parts_tool_approval_check",
      sql`${table.toolApproval} IS NULL OR jsonb_typeof(${table.toolApproval}) = 'object'`,
    ),
    check(
      "chat_message_parts_type_fields_check",
      sql`(
        (${table.partType} IN ('text', 'reasoning') AND ${table.textValue} IS NOT NULL AND ${table.toolCallId} IS NULL AND ${table.fileUrl} IS NULL)
        OR (${table.partType} = 'file' AND ${table.fileUrl} IS NOT NULL AND ${table.fileMediaType} IS NOT NULL AND ${table.toolCallId} IS NULL)
        OR (${table.partType} = 'tool' AND ${table.toolCallId} IS NOT NULL AND ${table.toolName} IS NOT NULL AND ${table.toolState} IS NOT NULL AND ${table.isDynamicTool} IS NOT NULL)
        OR (${table.partType} = 'step-start' AND ${table.toolCallId} IS NULL AND ${table.fileUrl} IS NULL)
        OR (${table.partType} IN ('source-url', 'source-document') AND ${table.extraPayload} IS NOT NULL)
        OR (${table.partType} = 'other' AND ${table.rawType} IS NOT NULL AND ${table.extraPayload} IS NOT NULL)
      )`,
    ),
  ],
);

export const chatMessagePartMetadata = pgTable(
  "chat_message_part_metadata",
  {
    partId: uuid("part_id")
      .primaryKey()
      .references(() => chatMessageParts.id, { onDelete: "cascade" }),
    providerMetadata: jsonb("provider_metadata"),
    callProviderMetadata: jsonb("call_provider_metadata"),
    resultProviderMetadata: jsonb("result_provider_metadata"),
  },
  table => [
    check(
      "chat_part_metadata_non_empty",
      sql`${table.providerMetadata} IS NOT NULL OR ${table.callProviderMetadata} IS NOT NULL OR ${table.resultProviderMetadata} IS NOT NULL`,
    ),
  ],
);

export const chatUsageEntries = pgTable(
  "chat_usage_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    entryIndex: integer("entry_index").notNull(),
    assistantMessageIndex: integer("assistant_message_index").notNull(),
    model: text("model"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 })
      .notNull()
      .default("0"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    unique("chat_usage_entries_chat_idx_unique").on(
      table.chatId,
      table.entryIndex,
    ),
    check(
      "chat_usage_entries_entry_index_check",
      sql`${table.entryIndex} >= 0`,
    ),
  ],
);

export type ChatRow = typeof chats.$inferSelect;
export type NewChatRow = typeof chats.$inferInsert;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessageRow = typeof chatMessages.$inferInsert;
export type ChatAttachmentRow = typeof chatAttachments.$inferSelect;
export type NewChatAttachmentRow = typeof chatAttachments.$inferInsert;
export type ChatMessagePartRow = typeof chatMessageParts.$inferSelect;
export type NewChatMessagePartRow = typeof chatMessageParts.$inferInsert;
export type ChatMessagePartMetadataRow =
  typeof chatMessagePartMetadata.$inferSelect;
export type NewChatMessagePartMetadataRow =
  typeof chatMessagePartMetadata.$inferInsert;
export type ChatUsageEntryRow = typeof chatUsageEntries.$inferSelect;
export type NewChatUsageEntryRow = typeof chatUsageEntries.$inferInsert;
