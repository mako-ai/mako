import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaces } from "./workspaces";

/**
 * Chat domain (was Mongo `chats`, `chatattachments`, `llmusages`).
 *
 * The conversation history (`messages[]`, AI SDK v6 parts with `Mixed` tool
 * I/O) maps cleanly to a single `messages` JSONB column — mirroring today's
 * full-document `saveChat()` upsert. Attachment bytes stay in object storage;
 * only metadata is stored here.
 */

export interface ChatMessagePart {
  type: string;
  text?: string;
  reasoning?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  parts?: ChatMessagePart[];
  content?: string;
  reasoning?: string[];
  toolCalls?: unknown[];
}

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    threadId: text("thread_id"),
    messages: jsonb("messages").$type<ChatMessage[]>().notNull().default([]),
    activeAgent: text("active_agent").$type<"mongo" | "bigquery" | "triage">(),
    // Soft reference (was an untyped string in Mongo); no FK.
    pinnedConsoleId: uuid("pinned_console_id"),
    activeStreamId: text("active_stream_id"),
    systemPrompt: text("system_prompt"),
    workspacePrompt: text("workspace_prompt"),
    usage: jsonb("usage"),
    titleGenerated: boolean("title_generated").notNull().default(false),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("chats_workspace_idx").on(table.workspaceId),
    uniqueIndex("chats_thread_id_unique").on(table.threadId),
  ],
);

export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").notNull(),
    storageKey: text("storage_key").notNull(),
    mediaType: text("media_type"),
    filename: text("filename"),
    size: bigint("size", { mode: "number" }),
    sha256: text("sha256"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("chat_attachments_workspace_idx").on(table.workspaceId),
    index("chat_attachments_chat_idx").on(table.chatId),
  ],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    chatId: uuid("chat_id"),
    invocationType: text("invocation_type").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheTokens: bigint("cache_tokens", { mode: "number" }),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }),
    totalTokens: bigint("total_tokens", { mode: "number" }),
    costUsd: text("cost_usd"),
    steps: jsonb("steps"),
    agentId: text("agent_id"),
    tags: text("tags").array(),
    durationMs: bigint("duration_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("llm_usage_workspace_idx").on(table.workspaceId),
    index("llm_usage_chat_idx").on(table.chatId),
  ],
);

export type ChatRow = typeof chats.$inferSelect;
export type NewChatRow = typeof chats.$inferInsert;
export type ChatAttachmentRow = typeof chatAttachments.$inferSelect;
export type NewChatAttachmentRow = typeof chatAttachments.$inferInsert;
export type LlmUsageRow = typeof llmUsage.$inferSelect;
export type NewLlmUsageRow = typeof llmUsage.$inferInsert;
