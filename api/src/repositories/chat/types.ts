/**
 * Repository types for Phase 3 (Part 2) normalized `chat` domain:
 *   - `chats`
 *   - `chat_messages`
 *   - `chat_attachments`
 *   - `chat_message_parts`
 *   - `chat_message_part_metadata`
 *   - `chat_usage_entries`
 *
 * External/wire IDs (`id`, `workspaceId`, `appId`, `pinnedConsoleId`, attachment `id`)
 * use canonical 24-hex Mongo ObjectIds via bijective UUIDv8 (`toWireId`).
 */
import type {
  ChatActiveAgent,
  ChatLocalAcpJson,
  ChatMessageRole,
  ChatSource,
} from "../../database/pg/schema/chat";

export type {
  ChatActiveAgent,
  ChatMessageRole,
  ChatSource,
} from "../../database/pg/schema/chat";

export type ChatLocalAcp = ChatLocalAcpJson;

export interface ChatTurnCheckpoint {
  message: unknown;
  at: Date;
  streamId: string;
}

export interface StoredChatToolCallLegacy {
  toolCallId?: string;
  toolName: string;
  timestamp?: Date;
  status?: "started" | "completed";
  input?: unknown;
  result?: unknown;
}

/**
 * Lossless stored UIMessage part representation covering all AI SDK v7 and
 * Local ACP part kinds (`text`, `reasoning`, `file`, `tool-*`, `dynamic-tool`,
 * `step-start`, `source-url`, `source-document`, and custom `data-*` / ACP parts).
 */
export interface StoredChatPart {
  type: string;
  text?: string;
  reasoning?: string;
  providerMetadata?: unknown;
  url?: string;
  mediaType?: string;
  filename?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  approval?: unknown;
  errorText?: string;
  rawInput?: unknown;
  providerExecuted?: boolean;
  preliminary?: boolean;
  callProviderMetadata?: unknown;
  resultProviderMetadata?: unknown;
  toolMetadata?: unknown;
  title?: string;
  [key: string]: unknown;
}

export interface StoredChatMessage {
  id?: string;
  role: ChatMessageRole;
  parts: StoredChatPart[];
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  // Legacy compatibility projections kept for existing API consumers.
  content?: string;
  reasoning?: string[];
  toolCalls?: StoredChatToolCallLegacy[];
}

export interface ChatUsageEntryRecord {
  entryIndex: number;
  messageIndex: number;
  model?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  timestamp: Date;
}

export interface ChatUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  history: ChatUsageEntryRecord[];
}

export interface ChatRecord {
  id: string;
  workspaceId: string;
  /** `null` for `"system"` chats and deleted users. */
  createdBy: string | null;
  title: string;
  titleGenerated: boolean;
  source: ChatSource;
  appId: string | null;
  threadId: string | null;
  activeAgent: ChatActiveAgent | null;
  pinnedConsoleId: string | null;
  activeStreamId: string | null;
  activeStreamAliveAt: Date | null;
  turnCheckpoint: ChatTurnCheckpoint | null;
  localAcp: ChatLocalAcp | null;
  systemPrompt: string | null;
  workspacePrompt: string | null;
  messages: StoredChatMessage[];
  usage: ChatUsageSummary;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatListEntry {
  _id: string;
  title: string;
  createdAt?: Date;
  updatedAt?: Date;
  activeStreamId?: string | null;
  usage?: { totalTokens?: number; costUsd?: number };
}

export interface AppChatListEntry {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  streaming: boolean;
}

export interface ChatAttachmentRecord {
  id: string;
  workspaceId: string;
  chatId: string;
  createdBy: string | null;
  storageKey: string;
  mediaType: string;
  filename: string | null;
  size: number;
  sha256: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateChatInput {
  id?: string;
  workspaceId: string;
  createdBy: string | null;
  title?: string;
  titleGenerated?: boolean;
  source?: ChatSource;
  appId?: string | null;
  threadId?: string | null;
  activeAgent?: ChatActiveAgent | null;
  pinnedConsoleId?: string | null;
  systemPrompt?: string | null;
  workspacePrompt?: string | null;
  messages?: StoredChatMessage[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ChatUsageIncrementInput {
  assistantMessageIndex: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  model?: string;
}

export interface SaveChatMessagesInput {
  chatId: string;
  workspaceId: string;
  userId: string | null;
  messages: StoredChatMessage[];
  /**
   * Optional stripped fallback messages used ONLY on MongoDB 16MB BSON-limit retry
   * (Postgres never hits a 16MB document cap and always persists full `messages`).
   */
  mongoBsonRetryMessages?: StoredChatMessage[];
  usage?: ChatUsageIncrementInput;
  /**
   * - `undefined`: clear `localAcp` (default cloud save behavior).
   * - `null`: explicitly clear `localAcp`.
   * - object: bind `localAcp` atomically with the save.
   */
  localAcp?: ChatLocalAcp | null;
  /** Optional deterministic threadId generated on insert. */
  threadIdOnInsert?: string;
  now?: Date;
}

export interface UpdateChatThreadPatch {
  messages?: StoredChatMessage[];
  threadId?: string;
  activeAgent?: ChatActiveAgent;
  pinnedConsoleId?: string | null;
  systemPrompt?: string | null;
  workspacePrompt?: string | null;
  updatedAt?: Date;
}

export interface CreateChatAttachmentInput {
  id?: string;
  workspaceId: string;
  chatId: string;
  createdBy: string | null;
  storageKey: string;
  mediaType: string;
  filename?: string | null;
  size: number;
  sha256: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ChatRepository {
  // ── Chat lifecycle & reads ───────────────────────────────────────────────
  create(input: CreateChatInput): Promise<ChatRecord>;
  findById(chatId: string, workspaceId?: string): Promise<ChatRecord | null>;
  findOwnedById(
    workspaceId: string,
    chatId: string,
    userId: string,
  ): Promise<ChatRecord | null>;
  findOwnershipMeta(
    workspaceId: string,
    chatId: string,
  ): Promise<{ createdBy: string | null; titleGenerated: boolean } | null>;
  listUserChats(input: {
    workspaceId: string;
    userId: string;
    limit: number;
    after?: { updatedAt: number | null; id: string } | null;
  }): Promise<{ chats: ChatListEntry[]; nextCursor: string | null }>;
  listAppChats(
    workspaceId: string,
    appId: string,
    userId: string,
    limit?: number,
  ): Promise<AppChatListEntry[]>;

  // ── Mutations ────────────────────────────────────────────────────────────
  saveMessages(input: SaveChatMessagesInput): Promise<ChatRecord | null>;
  updateThreadFields(
    chatId: string,
    workspaceId: string | undefined,
    patch: UpdateChatThreadPatch,
  ): Promise<ChatRecord | null>;
  updateLocalAcp(
    workspaceId: string,
    chatId: string,
    userId: string,
    localAcp: ChatLocalAcp | null,
  ): Promise<boolean>;
  updateTitle(
    workspaceId: string,
    chatId: string,
    userId: string,
    title: string,
    now?: Date,
  ): Promise<boolean>;
  setGeneratedTitleIfUnset(
    workspaceId: string,
    chatId: string,
    title: string,
  ): Promise<boolean>;
  deleteOwned(
    workspaceId: string,
    chatId: string,
    userId: string,
  ): Promise<{ deleted: boolean; deletedAttachmentKeys: string[] }>;

  // ── Streaming & checkpointing (metadata pointers only; streams on Redis) ─
  getStreamState(
    chatId: string,
    workspaceId?: string,
  ): Promise<{
    workspaceId: string;
    activeStreamId: string | null;
    activeStreamAliveAt: Date | null;
  } | null>;
  setActiveStream(
    workspaceId: string,
    chatId: string,
    streamId: string,
    now?: Date,
  ): Promise<void>;
  clearActiveStreamIfMatch(
    workspaceId: string,
    chatId: string,
    streamId: string,
  ): Promise<void>;
  clearActiveStream(workspaceId: string, chatId: string): Promise<void>;
  saveTurnCheckpoint(
    workspaceId: string | undefined,
    chatId: string,
    streamId: string,
    message: StoredChatMessage,
    now?: Date,
  ): Promise<void>;

  // ── Attachments ──────────────────────────────────────────────────────────
  findAttachmentByHash(
    workspaceId: string,
    chatId: string,
    sha256: string,
  ): Promise<ChatAttachmentRecord | null>;
  createAttachmentIdempotent(
    input: CreateChatAttachmentInput,
  ): Promise<ChatAttachmentRecord>;
  findAttachmentById(
    workspaceId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null>;
  findAttachmentForUser(
    workspaceId: string,
    attachmentId: string,
    userId: string,
  ): Promise<ChatAttachmentRecord | null>;
}
