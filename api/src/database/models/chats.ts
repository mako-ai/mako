import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Message part types for AI SDK v6 compatibility
 * Stores parts in chronological order to preserve the original message structure
 */
export interface IMessagePart {
  type: string; // "text", "reasoning", "tool-{toolName}", "dynamic-tool"
  text?: string; // For text and reasoning parts
  reasoning?: string; // Alternative field for reasoning content
  // Provider metadata for reasoning parts. Anthropic extended thinking returns a
  // per-block `signature` (lives at providerMetadata.anthropic.signature). The
  // signature MUST round-trip byte-for-byte: on a tool-use continuation Anthropic
  // rejects the turn ("thinking ... blocks in the latest assistant message cannot
  // be modified") if a replayed thinking block lacks/alters its original
  // signature. Persisting it keeps reloaded chats continuable.
  providerMetadata?: unknown;
  toolCallId?: string; // For tool parts
  toolName?: string; // For tool parts
  input?: unknown; // Tool input/arguments (named 'input' for AI SDK v6 compat, was 'args')
  output?: unknown; // Tool result (named 'output' for AI SDK v6 compat, was 'result')
  state?: string; // Tool state: "input-streaming", "input-available", "output-streaming", "output-available", "error"
  approval?: { id?: string; approved?: boolean }; // AI SDK MCP approval lifecycle
  errorText?: string;
  rawInput?: unknown;
  providerExecuted?: boolean;
  preliminary?: boolean;
  callProviderMetadata?: unknown;
  resultProviderMetadata?: unknown;
  toolMetadata?: unknown;
  title?: string;
  // File parts (AI SDK FileUIPart). Without these fields, persisted attachments
  // are reduced to `{ type: "file", _id }` and break `convertToModelMessages`
  // with "The messages do not match the ModelMessage[] schema."
  url?: string; // Data URL or remote URL of the attachment
  mediaType?: string; // MIME type, e.g. "image/png"
  filename?: string; // Optional original file name
}

/**
 * Usage history entry for tracking token consumption per turn
 * Useful for metered billing and cost analysis
 */
export interface IUsageHistoryEntry {
  messageIndex: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  model?: string;
  timestamp: Date;
}

/**
 * Chat usage tracking for token consumption
 */
export interface IChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  history?: IUsageHistoryEntry[];
}

/**
 * Chat model interface
 */
export interface IChat extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  title: string;
  threadId?: string; // Custom thread ID for conversation continuity
  messages: Array<{
    id?: string; // Message ID from AI SDK (for message identification)
    role: "user" | "assistant";
    parts?: IMessagePart[]; // NEW: Raw parts array (source of truth for chronological order)
    // Legacy fields - kept for backward compatibility with existing chats
    content?: string;
    reasoning?: string[]; // Array of reasoning/thinking blocks
    toolCalls?: Array<{
      toolCallId?: string;
      toolName: string;
      timestamp?: Date;
      status?: "started" | "completed";
      input?: unknown;
      result?: unknown;
    }>;
  }>;
  activeAgent?: "mongo" | "bigquery" | "triage"; // Pinned specialist for this thread
  pinnedConsoleId?: string; // Console ID that this chat session is bound to
  /**
   * "Chat with app": the published app (AppProject id) this chat is about.
   * Set at creation; such a chat only ever runs the closed app_chat agent
   * and lives in the app's chat history, not the workspace's.
   */
  appId?: string;
  createdBy: string;
  titleGenerated: boolean;
  /** Set on a run of Mako's agent from a workflow step: kept, not listed. */
  source?: "workflow";
  // Resume pointer for in-flight turns: the resumable-stream ID clients can
  // reattach to via GET /api/agent/chat/:chatId/stream. Null when idle.
  activeStreamId?: string | null;
  activeStreamAliveAt?: Date | null;
  /**
   * Mid-turn checkpoint (§13.27): the in-progress assistant message,
   * persisted every few seconds while a turn streams. Cleared by the final
   * save; consumed at load time when the turn died without finishing
   * (process crash, instance recycle) so the user keeps what was generated.
   */
  turnCheckpoint?: {
    message: unknown;
    at: Date;
    streamId: string;
  } | null;
  /**
   * Local Agent ACP binding for chats that run Claude Code / Codex on the
   * user's machine. Lets History reopen + continue the same ACP session while
   * the Local Agent process is still alive. Absent for cloud (gateway) chats.
   */
  localAcp?: {
    providerId: string;
    sessionId: string;
    modelId: string;
  };
  systemPrompt?: string; // System prompt used for this conversation
  workspacePrompt?: string; // Workspace custom prompt appended to system prompt
  usage?: IChatUsage; // Token usage tracking for billing
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Chat Schema
 */
const ChatSchema = new Schema<IChat>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    threadId: {
      type: String,
      unique: true,
      sparse: true, // Allow null values but ensure uniqueness when present
    },
    messages: [
      {
        id: {
          type: String,
          required: false,
        },
        role: {
          type: String,
          enum: ["user", "assistant"],
          required: true,
        },
        // NEW: parts array - source of truth for message structure and chronological order
        parts: [
          {
            type: {
              type: String,
              required: true,
            },
            text: String,
            reasoning: String,
            // Anthropic extended-thinking signature (and any other provider
            // metadata) for reasoning parts. Must persist so a reloaded chat can
            // replay thinking blocks byte-for-byte on a tool-use continuation;
            // otherwise Anthropic rejects the turn with "thinking ... blocks in
            // the latest assistant message cannot be modified".
            providerMetadata: Schema.Types.Mixed,
            toolCallId: String,
            toolName: String,
            input: Schema.Types.Mixed,
            output: Schema.Types.Mixed,
            state: String,
            // AI SDK tool lifecycle fields. Approval metadata is required to
            // continue an MCP tool call after the chat is persisted/reloaded.
            approval: Schema.Types.Mixed,
            errorText: String,
            rawInput: Schema.Types.Mixed,
            providerExecuted: Boolean,
            preliminary: Boolean,
            callProviderMetadata: Schema.Types.Mixed,
            resultProviderMetadata: Schema.Types.Mixed,
            toolMetadata: Schema.Types.Mixed,
            title: String,
            // File parts (AI SDK FileUIPart). Persisting these keeps attachments
            // round-trippable; without them Mongoose strict mode strips the
            // fields and breaks convertToModelMessages on the next turn.
            url: String,
            mediaType: String,
            filename: String,
          },
        ],
        // Legacy fields - kept for backward compatibility with existing chats
        content: {
          type: String,
          required: false,
          default: "",
        },
        reasoning: {
          type: [String],
          required: false,
        },
        toolCalls: [
          {
            toolCallId: {
              type: String,
              required: false,
            },
            toolName: {
              type: String,
              required: true,
            },
            timestamp: {
              type: Date,
              default: Date.now,
            },
            status: {
              type: String,
              enum: ["started", "completed"],
              default: "completed",
            },
            input: {
              type: Schema.Types.Mixed,
            },
            result: {
              type: Schema.Types.Mixed,
            },
          },
        ],
      },
    ],
    activeAgent: {
      type: String,
      enum: ["mongo", "bigquery", "triage"],
      required: false,
    },
    pinnedConsoleId: {
      type: String,
      required: false,
    },
    appId: {
      type: String,
      required: false,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    titleGenerated: {
      type: Boolean,
      default: false,
    },
    source: { type: String, enum: ["workflow"] },
    activeStreamId: {
      type: String,
      default: null,
    },
    activeStreamAliveAt: {
      type: Date,
      default: null,
    },
    turnCheckpoint: {
      type: Schema.Types.Mixed,
      default: null,
    },
    localAcp: {
      providerId: { type: String, required: false },
      sessionId: { type: String, required: false },
      modelId: { type: String, required: false },
    },
    systemPrompt: {
      type: String,
      required: false,
    },
    workspacePrompt: {
      type: String,
      required: false,
    },
    usage: {
      promptTokens: {
        type: Number,
        default: 0,
      },
      completionTokens: {
        type: Number,
        default: 0,
      },
      totalTokens: {
        type: Number,
        default: 0,
      },
      cacheReadTokens: {
        type: Number,
        default: 0,
      },
      cacheWriteTokens: {
        type: Number,
        default: 0,
      },
      reasoningTokens: {
        type: Number,
        default: 0,
      },
      costUsd: {
        type: Number,
        default: 0,
      },
      history: [
        {
          messageIndex: {
            type: Number,
            required: true,
          },
          promptTokens: {
            type: Number,
            required: true,
          },
          completionTokens: {
            type: Number,
            required: true,
          },
          totalTokens: {
            type: Number,
            required: true,
          },
          cacheReadTokens: {
            type: Number,
            default: 0,
          },
          cacheWriteTokens: {
            type: Number,
            default: 0,
          },
          reasoningTokens: {
            type: Number,
            default: 0,
          },
          costUsd: {
            type: Number,
            default: 0,
          },
          model: {
            type: String,
            required: false,
          },
          timestamp: {
            type: Date,
            default: Date.now,
          },
        },
      ],
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
ChatSchema.index({ workspaceId: 1 });
ChatSchema.index({ workspaceId: 1, title: 1 });
// A user's chat list, newest first (services/chat-list.service.ts): the
// keyset sort `(updatedAt desc, _id desc)` is served by the index instead of
// in memory. Also covers `{ workspaceId, createdBy }`.
ChatSchema.index({ workspaceId: 1, createdBy: 1, updatedAt: -1, _id: -1 });
ChatSchema.index(
  { workspaceId: 1, appId: 1, createdBy: 1, updatedAt: -1 },
  { partialFilterExpression: { appId: { $type: "string" } } },
); // An app's chat history, per viewer

export const Chat = mongoose.model<IChat>("Chat", ChatSchema);

/**
 * Chat attachment model interface.
 *
 * Chat image attachments are uploaded to object storage (filesystem / GCS / S3)
 * instead of being inlined as base64 data URLs in the chat document. This keeps
 * chat documents well under the 16 MB BSON limit (the previous behaviour caused
 * silent save failures and "lost" images on reload) and lets the browser fetch
 * each image lazily through an authenticated proxy.
 */
export interface IChatAttachment extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  chatId: string; // Chat _id this attachment belongs to (string ObjectId hex)
  createdBy: string; // User id that owns the attachment (matches Chat.createdBy)
  storageKey: string; // Key within the object store
  mediaType: string; // MIME type, e.g. "image/png"
  filename?: string; // Optional original file name
  size: number; // Byte size of the stored object
  sha256: string; // Content hash, used to deduplicate re-uploads within a chat
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Chat Attachment Schema
 *
 * Stores metadata for chat image attachments whose bytes live in object
 * storage. The proxy route streams these back to the browser, and the agent
 * route resolves them to data URLs when replaying history to the model.
 */
const ChatAttachmentSchema = new Schema<IChatAttachment>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    chatId: {
      type: String,
      required: true,
    },
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
    },
    mediaType: {
      type: String,
      required: true,
    },
    filename: {
      type: String,
      required: false,
    },
    size: {
      type: Number,
      required: true,
    },
    sha256: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Dedupe re-uploads of the same image within a chat (same bytes -> same doc).
ChatAttachmentSchema.index(
  { workspaceId: 1, chatId: 1, sha256: 1 },
  { unique: true },
);

export const ChatAttachment = mongoose.model<IChatAttachment>(
  "ChatAttachment",
  ChatAttachmentSchema,
);
