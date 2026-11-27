/**
 * Bidirectional mappers for normalized Chat persistence:
 *   - Lossless unpack of ALL AI SDK v7 & Local ACP part types into typed
 *     `chat_message_parts` rows + 1:1 sparse `chat_message_part_metadata` rows.
 *   - Exact distinction between SQL `NULL` (omitted `output` / `input`) and
 *     explicit JSON `'null'::jsonb` (`{ output: null }`).
 *   - Legacy pre-`parts` Mongo doc synthesis (`reasoning[]`, `toolCalls[]`, `content`).
 *   - Lossless repack from normalized PG rows back into `ChatRecord` (and full
 *     Mongo documents for Stage 4 PG->Mongo reverse-sync).
 */
import { createHash } from "node:crypto";
import type { Types } from "mongoose";
import {
  isObjectIdHex,
  objectIdToUuid,
  optionalToWireId,
  toWireId,
} from "../../database/pg/id-codec";
import {
  CHAT_TOOL_STATES,
  type ChatActiveAgent,
  type ChatAttachmentRow,
  type ChatMessagePartMetadataRow,
  type ChatMessagePartRow,
  type ChatMessageRole,
  type ChatMessageRow,
  type ChatPartType,
  type ChatRow,
  type ChatSource,
  type ChatToolState,
  type ChatUsageEntryRow,
} from "../../database/pg/schema/chat";
import { jsonbOrdered } from "../../services/agent-chat/exact-history";
import type {
  ChatAttachmentRecord,
  ChatLocalAcp,
  ChatRecord,
  ChatTurnCheckpoint,
  ChatUsageEntryRecord,
  ChatUsageSummary,
  StoredChatMessage,
  StoredChatPart,
  StoredChatToolCallLegacy,
} from "./types";

const VALID_TOOL_STATES = new Set<string>(CHAT_TOOL_STATES);

/** Matches `/api/workspaces/<24hex>/chat-images/<24hex>` proxy URLs. */
const CHAT_IMAGE_PROXY_URL_RE =
  /\/api\/workspaces\/([0-9a-f]{24})\/chat-images\/([0-9a-f]{24})(?:$|[?#])/i;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function idToString(value: Types.ObjectId | string): string {
  return typeof value === "string" ? value : value.toHexString();
}

function toDateOrNow(value: Date | string | undefined | null): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function toNullableDate(value: Date | string | undefined | null): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parse the 24-hex attachment ID from a `/api/workspaces/:ws/chat-images/:id`
 * URL and convert it to its bijective Postgres UUIDv8 (or `null` for external/data URLs).
 */
export function parseChatImageAttachmentUuid(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const match = CHAT_IMAGE_PROXY_URL_RE.exec(url);
  if (!match) return null;
  const attachmentHex = match[2];
  return isObjectIdHex(attachmentHex) ? objectIdToUuid(attachmentHex) : null;
}

// ── Normalized PG Part Unpack / Repack ───────────────────────────────────────

export interface UnpackedPartForPg {
  orderIndex: number;
  partType: ChatPartType;
  rawType: string | null;
  textValue: string | null;
  fileUrl: string | null;
  fileMediaType: string | null;
  fileFilename: string | null;
  /** Candidate attachment UUID parsed from `/chat-images/:id`; verified against `chat_attachments` before insert. */
  candidateAttachmentUuid: string | null;
  isDynamicTool: boolean | null;
  toolCallId: string | null;
  toolName: string | null;
  toolState: ChatToolState | null;
  hasToolInput: boolean;
  toolInput: unknown;
  hasToolOutput: boolean;
  toolOutput: unknown;
  toolErrorText: string | null;
  hasToolRawInput: boolean;
  toolRawInput: unknown;
  toolApproval: Record<string, unknown> | null;
  toolProviderExecuted: boolean | null;
  toolPreliminary: boolean | null;
  toolTitle: string | null;
  hasToolMetadata: boolean;
  toolMetadata: unknown;
  extraPayload: Record<string, unknown> | null;
  metadata: {
    providerMetadata?: unknown;
    callProviderMetadata?: unknown;
    resultProviderMetadata?: unknown;
  } | null;
}

export interface HydratedPartRow {
  part: ChatMessagePartRow;
  hasToolInput: boolean;
  hasToolOutput: boolean;
  hasToolRawInput: boolean;
  hasToolMetadata: boolean;
  metadata: ChatMessagePartMetadataRow | null;
}

function collectExtraKeys(
  part: Record<string, unknown>,
  consumed: ReadonlySet<string>,
): Record<string, unknown> | null {
  const extra: Record<string, unknown> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(part)) {
    if (consumed.has(k) || k === "_id" || v === undefined) continue;
    extra[k] = v;
    hasAny = true;
  }
  return hasAny ? extra : null;
}

function buildPartMetadata(fields: {
  providerMetadata?: unknown;
  callProviderMetadata?: unknown;
  resultProviderMetadata?: unknown;
}): UnpackedPartForPg["metadata"] {
  const out: NonNullable<UnpackedPartForPg["metadata"]> = {};
  let hasAny = false;
  if (
    fields.providerMetadata !== undefined &&
    fields.providerMetadata !== null
  ) {
    out.providerMetadata = fields.providerMetadata;
    hasAny = true;
  }
  if (
    fields.callProviderMetadata !== undefined &&
    fields.callProviderMetadata !== null
  ) {
    out.callProviderMetadata = fields.callProviderMetadata;
    hasAny = true;
  }
  if (
    fields.resultProviderMetadata !== undefined &&
    fields.resultProviderMetadata !== null
  ) {
    out.resultProviderMetadata = fields.resultProviderMetadata;
    hasAny = true;
  }
  return hasAny ? out : null;
}

function emptyUnpackedBase(orderIndex: number): UnpackedPartForPg {
  return {
    orderIndex,
    partType: "other",
    rawType: null,
    textValue: null,
    fileUrl: null,
    fileMediaType: null,
    fileFilename: null,
    candidateAttachmentUuid: null,
    isDynamicTool: null,
    toolCallId: null,
    toolName: null,
    toolState: null,
    hasToolInput: false,
    toolInput: undefined,
    hasToolOutput: false,
    toolOutput: undefined,
    toolErrorText: null,
    hasToolRawInput: false,
    toolRawInput: undefined,
    toolApproval: null,
    toolProviderExecuted: null,
    toolPreliminary: null,
    toolTitle: null,
    hasToolMetadata: false,
    toolMetadata: undefined,
    extraPayload: null,
    metadata: null,
  };
}

/**
 * Unpack one `StoredChatPart` into a typed `chat_message_parts` row + optional
 * 1:1 `chat_message_part_metadata` row. Every part kind is guaranteed to satisfy
 * `chat_message_parts_type_fields_check` and round-trip losslessly.
 */
export function unpackPartForPg(
  rawPart: StoredChatPart,
  orderIndex: number,
): UnpackedPartForPg {
  const p = rawPart as Record<string, unknown>;
  const rawType =
    typeof p.type === "string" && p.type.length > 0 ? p.type : "unknown";
  const base = emptyUnpackedBase(orderIndex);

  if (rawType === "text") {
    const consumed = new Set(["type", "text", "providerMetadata"]);
    return {
      ...base,
      partType: "text",
      textValue: typeof p.text === "string" ? p.text : "",
      extraPayload: collectExtraKeys(p, consumed),
      metadata: buildPartMetadata({ providerMetadata: p.providerMetadata }),
    };
  }

  if (rawType === "reasoning") {
    const consumed = new Set(["type", "reasoning", "text", "providerMetadata"]);
    const textValue =
      typeof p.reasoning === "string"
        ? p.reasoning
        : typeof p.text === "string"
          ? p.text
          : "";
    return {
      ...base,
      partType: "reasoning",
      textValue,
      extraPayload: collectExtraKeys(p, consumed),
      metadata: buildPartMetadata({ providerMetadata: p.providerMetadata }),
    };
  }

  if (rawType === "file") {
    if (typeof p.url === "string" && typeof p.mediaType === "string") {
      const consumed = new Set([
        "type",
        "url",
        "mediaType",
        "filename",
        "providerMetadata",
      ]);
      return {
        ...base,
        partType: "file",
        fileUrl: p.url,
        fileMediaType: p.mediaType,
        fileFilename: typeof p.filename === "string" ? p.filename : null,
        candidateAttachmentUuid: parseChatImageAttachmentUuid(p.url),
        extraPayload: collectExtraKeys(p, consumed),
        metadata: buildPartMetadata({ providerMetadata: p.providerMetadata }),
      };
    }
    // Malformed legacy file part (missing url or mediaType): store safely as 'other'.
    const consumed = new Set(["providerMetadata"]);
    const payload = collectExtraKeys(p, consumed) ?? { type: "file" };
    return {
      ...base,
      partType: "other",
      rawType: "file",
      extraPayload: payload,
      metadata: buildPartMetadata({ providerMetadata: p.providerMetadata }),
    };
  }

  if (rawType === "dynamic-tool" || rawType.startsWith("tool-")) {
    const isDynamic = rawType === "dynamic-tool";
    const derivedName = isDynamic
      ? typeof p.toolName === "string"
        ? p.toolName
        : ""
      : rawType.slice("tool-".length) ||
        (typeof p.toolName === "string" ? p.toolName : "");
    const rawState =
      typeof p.state === "string" && p.state.length > 0
        ? p.state
        : "output-available";

    if (derivedName.length > 0 && VALID_TOOL_STATES.has(rawState)) {
      const hasInput = hasOwn(p, "input") && p.input !== undefined;
      const hasOutput = hasOwn(p, "output") && p.output !== undefined;
      const hasRawInput = hasOwn(p, "rawInput") && p.rawInput !== undefined;
      const hasToolMetadata =
        hasOwn(p, "toolMetadata") && p.toolMetadata !== undefined;
      const approvalIsObj = isPlainObject(p.approval);
      const consumed = new Set([
        "type",
        "toolCallId",
        "toolName",
        "state",
        "input",
        "output",
        "errorText",
        "rawInput",
        "providerExecuted",
        "preliminary",
        "title",
        "toolMetadata",
        "providerMetadata",
        "callProviderMetadata",
        "resultProviderMetadata",
        ...(approvalIsObj || p.approval == null ? ["approval"] : []),
      ]);

      return {
        ...base,
        partType: "tool",
        isDynamicTool: isDynamic,
        toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : "",
        toolName: derivedName,
        toolState: rawState as ChatToolState,
        hasToolInput: hasInput,
        toolInput: hasInput ? p.input : undefined,
        hasToolOutput: hasOutput,
        toolOutput: hasOutput ? p.output : undefined,
        toolErrorText: typeof p.errorText === "string" ? p.errorText : null,
        hasToolRawInput: hasRawInput,
        toolRawInput: hasRawInput ? p.rawInput : undefined,
        toolApproval: approvalIsObj
          ? (p.approval as Record<string, unknown>)
          : null,
        toolProviderExecuted:
          typeof p.providerExecuted === "boolean" ? p.providerExecuted : null,
        toolPreliminary:
          typeof p.preliminary === "boolean" ? p.preliminary : null,
        toolTitle: typeof p.title === "string" ? p.title : null,
        hasToolMetadata,
        toolMetadata: hasToolMetadata ? p.toolMetadata : undefined,
        extraPayload: collectExtraKeys(p, consumed),
        metadata: buildPartMetadata({
          providerMetadata: p.providerMetadata,
          callProviderMetadata: p.callProviderMetadata,
          resultProviderMetadata: p.resultProviderMetadata,
        }),
      };
    }
  }

  if (rawType === "step-start") {
    const consumed = new Set(["type", "providerMetadata"]);
    return {
      ...base,
      partType: "step-start",
      extraPayload: collectExtraKeys(p, consumed),
      metadata: buildPartMetadata({ providerMetadata: p.providerMetadata }),
    };
  }

  if (rawType === "source-url" || rawType === "source-document") {
    const consumed = new Set(["providerMetadata"]);
    const payload = collectExtraKeys(p, consumed) ?? { type: rawType };
    return {
      ...base,
      partType: rawType,
      extraPayload: payload,
      metadata: buildPartMetadata({ providerMetadata: p.providerMetadata }),
    };
  }

  // Catch-all for `data-*`, Local ACP custom parts, and future AI SDK part kinds.
  const consumed = new Set(["providerMetadata"]);
  const payload = collectExtraKeys(p, consumed) ?? { type: rawType };
  return {
    ...base,
    partType: "other",
    rawType,
    extraPayload: payload,
    metadata: buildPartMetadata({ providerMetadata: p.providerMetadata }),
  };
}

/**
 * Reconstruct the exact `StoredChatPart` from a `chat_message_parts` row
 * joined with its optional `chat_message_part_metadata` row.
 */
export function repackPartFromPg(hydrated: HydratedPartRow): StoredChatPart {
  const { part: row, metadata: meta } = hydrated;
  const extra = isPlainObject(row.extraPayload) ? row.extraPayload : {};

  switch (row.partType) {
    case "text":
      return {
        ...extra,
        type: "text",
        text: row.textValue ?? "",
        ...(meta?.providerMetadata != null
          ? { providerMetadata: meta.providerMetadata }
          : {}),
      };

    case "reasoning":
      return {
        ...extra,
        type: "reasoning",
        reasoning: row.textValue ?? "",
        ...(meta?.providerMetadata != null
          ? { providerMetadata: meta.providerMetadata }
          : {}),
      };

    case "file":
      return {
        ...extra,
        type: "file",
        url: row.fileUrl ?? "",
        mediaType: row.fileMediaType ?? "",
        ...(row.fileFilename != null ? { filename: row.fileFilename } : {}),
        ...(meta?.providerMetadata != null
          ? { providerMetadata: meta.providerMetadata }
          : {}),
      };

    case "tool": {
      const toolName = row.toolName ?? "";
      const type = row.isDynamicTool ? "dynamic-tool" : `tool-${toolName}`;
      const result: StoredChatPart = {
        ...extra,
        type,
        toolCallId: row.toolCallId ?? "",
        toolName,
        state: row.toolState ?? "output-available",
      };
      if (hydrated.hasToolInput) {
        result.input = row.toolInput;
      }
      if (hydrated.hasToolOutput) {
        result.output = row.toolOutput;
      }
      if (row.toolApproval != null) {
        result.approval = row.toolApproval;
      }
      if (row.toolErrorText != null) {
        result.errorText = row.toolErrorText;
      }
      if (hydrated.hasToolRawInput) {
        result.rawInput = row.toolRawInput;
      }
      if (row.toolProviderExecuted != null) {
        result.providerExecuted = row.toolProviderExecuted;
      }
      if (row.toolPreliminary != null) {
        result.preliminary = row.toolPreliminary;
      }
      if (row.toolTitle != null) {
        result.title = row.toolTitle;
      }
      if (hydrated.hasToolMetadata) {
        result.toolMetadata = row.toolMetadata;
      }
      if (meta?.providerMetadata != null) {
        result.providerMetadata = meta.providerMetadata;
      }
      if (meta?.callProviderMetadata != null) {
        result.callProviderMetadata = meta.callProviderMetadata;
      }
      if (meta?.resultProviderMetadata != null) {
        result.resultProviderMetadata = meta.resultProviderMetadata;
      }
      return result;
    }

    case "step-start":
      return {
        ...extra,
        type: "step-start",
        ...(meta?.providerMetadata != null
          ? { providerMetadata: meta.providerMetadata }
          : {}),
      };

    case "source-url":
    case "source-document":
      return {
        ...extra,
        type: row.partType,
        ...(meta?.providerMetadata != null
          ? { providerMetadata: meta.providerMetadata }
          : {}),
      };

    case "other":
    default:
      return {
        ...extra,
        type:
          row.rawType ??
          (typeof extra.type === "string" ? extra.type : "other"),
        ...(meta?.providerMetadata != null
          ? { providerMetadata: meta.providerMetadata }
          : {}),
      };
  }
}

// ── Legacy compatibility helpers (pre-parts Mongo docs <-> StoredChatMessage) ─

export interface MongoChatMessageLike {
  id?: string;
  role: ChatMessageRole;
  parts?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  createdAt?: Date | string;
  content?: string;
  reasoning?: string[];
  toolCalls?: Array<{
    toolCallId?: string;
    toolName: string;
    timestamp?: Date | string;
    status?: "started" | "completed";
    input?: unknown;
    result?: unknown;
  }>;
}

export interface MongoChatUsageEntryLike {
  messageIndex?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  model?: string;
  timestamp?: Date | string;
  at?: Date | string;
}

export interface MongoChatLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  title?: string;
  titleGenerated?: boolean;
  source?: string;
  appId?: string | null;
  threadId?: string | null;
  activeAgent?: ChatActiveAgent | null;
  pinnedConsoleId?: string | null;
  createdBy?: string | null;
  activeStreamId?: string | null;
  activeStreamAliveAt?: Date | string | null;
  turnCheckpoint?: {
    message: unknown;
    at: Date | string;
    streamId: string;
  } | null;
  localAcp?: {
    providerId?: string;
    sessionId?: string;
    modelId?: string;
  } | null;
  systemPrompt?: string | null;
  workspacePrompt?: string | null;
  messages?: MongoChatMessageLike[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    costUsd?: number;
    history?: MongoChatUsageEntryLike[];
  } | null;
  createdAt?: Date | string;
  updatedAt?: Date | string | null;
}

export interface MongoChatAttachmentLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  chatId: string;
  createdBy?: string | null;
  storageKey: string;
  mediaType: string;
  filename?: string | null;
  size: number;
  sha256: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/**
 * Strip Mongoose `_id` subdocument metadata from a raw Mongo part object
 * while preserving all real part fields verbatim.
 */
function cleanMongoPart(raw: Record<string, unknown>): StoredChatPart {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "_id" || v === undefined) continue;
    out[k] = v;
  }
  if (typeof out.type !== "string") {
    out.type = "unknown";
  }
  return out as StoredChatPart;
}

/**
 * Synthesize canonical `parts[]` from legacy pre-`parts` Mongo messages
 * (`reasoning[]` -> `toolCalls[]` -> `content`).
 */
export function synthesizePartsFromLegacyMongoMessage(
  msg: MongoChatMessageLike,
): StoredChatPart[] {
  if (Array.isArray(msg.parts) && msg.parts.length > 0) {
    return msg.parts.map(cleanMongoPart);
  }
  const parts: StoredChatPart[] = [];
  if (Array.isArray(msg.reasoning)) {
    for (const r of msg.reasoning) {
      if (typeof r === "string") {
        parts.push({ type: "reasoning", reasoning: r });
      }
    }
  }
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (!tc || typeof tc.toolName !== "string" || tc.toolName.length === 0) {
        continue;
      }
      const hasResult = hasOwn(tc, "result") && tc.result !== undefined;
      parts.push({
        type: `tool-${tc.toolName}`,
        toolCallId: tc.toolCallId ?? "",
        toolName: tc.toolName,
        state: "output-available",
        input: tc.input ?? {},
        ...(hasResult ? { output: tc.result } : {}),
      });
    }
  }
  if (
    typeof msg.content === "string" &&
    (msg.content.length > 0 || parts.length === 0)
  ) {
    parts.push({ type: "text", text: msg.content });
  }
  return parts;
}

/**
 * Derive legacy `content`, `reasoning`, and `toolCalls` projections from
 * canonical `parts[]` (matches `convertUIMessageToStoredFormat` in `agent-thread.service.ts`).
 */
export function deriveLegacyFieldsFromParts(parts: readonly StoredChatPart[]): {
  content: string;
  reasoning?: string[];
  toolCalls?: StoredChatToolCallLegacy[];
} {
  const textContent = parts
    .filter(p => p.type === "text" && typeof p.text === "string")
    .map(p => p.text as string)
    .join("");

  const reasoningParts = parts
    .filter(p => p.type === "reasoning")
    .map(p =>
      typeof p.reasoning === "string"
        ? p.reasoning
        : typeof p.text === "string"
          ? p.text
          : "",
    )
    .filter(s => s.length > 0);

  const toolCalls: StoredChatToolCallLegacy[] = [];
  for (const p of parts) {
    if (typeof p.type !== "string") continue;
    if (!p.type.startsWith("tool-") && p.type !== "dynamic-tool") continue;
    const toolName =
      p.type === "dynamic-tool"
        ? typeof p.toolName === "string"
          ? p.toolName
          : ""
        : p.type.slice("tool-".length) ||
          (typeof p.toolName === "string" ? p.toolName : "");
    if (!toolName) continue;
    toolCalls.push({
      toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : "",
      toolName,
      input: p.input ?? {},
      result: p.output ?? null,
    });
  }

  return {
    content: textContent,
    ...(reasoningParts.length > 0 ? { reasoning: reasoningParts } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/**
 * Compute a deterministic fingerprint of one `StoredChatMessage` for diff-aware
 * prefix preservation in `PgChatRepository.saveMessages`.
 */
export function computeMessageFingerprint(msg: StoredChatMessage): string {
  const normalizedParts = (msg.parts ?? []).map((part, idx) => {
    const unpacked = unpackPartForPg(part, idx);
    return {
      partType: unpacked.partType,
      rawType: unpacked.rawType,
      textValue: unpacked.textValue,
      fileUrl: unpacked.fileUrl,
      fileMediaType: unpacked.fileMediaType,
      fileFilename: unpacked.fileFilename,
      isDynamicTool: unpacked.isDynamicTool,
      toolCallId: unpacked.toolCallId,
      toolName: unpacked.toolName,
      toolState: unpacked.toolState,
      hasToolInput: unpacked.hasToolInput,
      toolInput: unpacked.hasToolInput
        ? jsonbOrdered(unpacked.toolInput)
        : null,
      hasToolOutput: unpacked.hasToolOutput,
      toolOutput: unpacked.hasToolOutput
        ? jsonbOrdered(unpacked.toolOutput)
        : null,
      toolErrorText: unpacked.toolErrorText,
      hasToolRawInput: unpacked.hasToolRawInput,
      toolRawInput: unpacked.hasToolRawInput
        ? jsonbOrdered(unpacked.toolRawInput)
        : null,
      toolApproval: unpacked.toolApproval
        ? jsonbOrdered(unpacked.toolApproval)
        : null,
      toolProviderExecuted: unpacked.toolProviderExecuted,
      toolPreliminary: unpacked.toolPreliminary,
      toolTitle: unpacked.toolTitle,
      hasToolMetadata: unpacked.hasToolMetadata,
      toolMetadata: unpacked.hasToolMetadata
        ? jsonbOrdered(unpacked.toolMetadata)
        : null,
      extraPayload: unpacked.extraPayload
        ? jsonbOrdered(unpacked.extraPayload)
        : null,
      metadata: unpacked.metadata ? jsonbOrdered(unpacked.metadata) : null,
    };
  });

  const payload = {
    id: msg.id ?? null,
    role: msg.role,
    metadata: msg.metadata ? jsonbOrdered(msg.metadata) : null,
    parts: normalizedParts,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ── Mongo -> Record ──────────────────────────────────────────────────────────

function inferChatSource(doc: MongoChatLike): ChatSource {
  if (doc.source === "workflow") return "workflow";
  if (
    doc.source === "app" ||
    (typeof doc.appId === "string" && doc.appId.length > 0)
  ) {
    return "app";
  }
  return "chat";
}

function normalizeLocalAcp(
  raw: MongoChatLike["localAcp"],
): ChatLocalAcp | null {
  if (!raw || !raw.providerId || !raw.sessionId || !raw.modelId) return null;
  return {
    providerId: raw.providerId,
    sessionId: raw.sessionId,
    modelId: raw.modelId,
  };
}

function normalizeTurnCheckpoint(
  raw: MongoChatLike["turnCheckpoint"],
): ChatTurnCheckpoint | null {
  if (!raw || typeof raw !== "object" || !raw.streamId) return null;
  return {
    message: raw.message,
    at: toDateOrNow(raw.at),
    streamId: raw.streamId,
  };
}

export function mongoChatToRecord(doc: MongoChatLike): ChatRecord {
  const createdAt = toDateOrNow(doc.createdAt);
  const updatedAt =
    doc.updatedAt == null ? createdAt : toDateOrNow(doc.updatedAt);
  const rawCreatedBy =
    typeof doc.createdBy === "string" ? doc.createdBy.trim() : null;
  const createdBy =
    !rawCreatedBy || rawCreatedBy === "system" ? null : rawCreatedBy;

  const messages: StoredChatMessage[] = (doc.messages ?? []).map(m => {
    const parts = synthesizePartsFromLegacyMongoMessage(m);
    const derived = deriveLegacyFieldsFromParts(parts);
    return {
      ...(m.id !== undefined ? { id: m.id } : {}),
      role: m.role,
      parts,
      ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
      ...(m.createdAt !== undefined
        ? { createdAt: toDateOrNow(m.createdAt) }
        : {}),
      content: derived.content,
      ...(derived.reasoning ? { reasoning: derived.reasoning } : {}),
      ...(derived.toolCalls ? { toolCalls: derived.toolCalls } : {}),
    };
  });

  const rawHistory = Array.isArray(doc.usage?.history) ? doc.usage.history : [];
  const history: ChatUsageEntryRecord[] = rawHistory.map((h, idx) => ({
    entryIndex: idx,
    messageIndex:
      typeof h.messageIndex === "number" && Number.isFinite(h.messageIndex)
        ? Math.trunc(h.messageIndex)
        : 0,
    model: h.model ?? null,
    promptTokens: Number(h.promptTokens ?? 0),
    completionTokens: Number(h.completionTokens ?? 0),
    totalTokens: Number(h.totalTokens ?? 0),
    cacheReadTokens: Number(h.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(h.cacheWriteTokens ?? 0),
    reasoningTokens: Number(h.reasoningTokens ?? 0),
    costUsd: Number(h.costUsd ?? 0),
    timestamp: toDateOrNow(h.timestamp ?? h.at ?? updatedAt),
  }));

  const usage: ChatUsageSummary = {
    promptTokens: Number(doc.usage?.promptTokens ?? 0),
    completionTokens: Number(doc.usage?.completionTokens ?? 0),
    totalTokens: Number(doc.usage?.totalTokens ?? 0),
    cacheReadTokens: Number(doc.usage?.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(doc.usage?.cacheWriteTokens ?? 0),
    reasoningTokens: Number(doc.usage?.reasoningTokens ?? 0),
    costUsd: Number(doc.usage?.costUsd ?? 0),
    history,
  };

  return {
    id: idToString(doc._id),
    workspaceId: idToString(doc.workspaceId),
    createdBy,
    title: doc.title ?? "New Chat",
    titleGenerated: doc.titleGenerated ?? false,
    source: inferChatSource(doc),
    appId: doc.appId ?? null,
    threadId: doc.threadId ?? null,
    activeAgent: doc.activeAgent ?? null,
    pinnedConsoleId: doc.pinnedConsoleId ?? null,
    activeStreamId: doc.activeStreamId ?? null,
    activeStreamAliveAt: toNullableDate(doc.activeStreamAliveAt),
    turnCheckpoint: normalizeTurnCheckpoint(doc.turnCheckpoint),
    localAcp: normalizeLocalAcp(doc.localAcp),
    systemPrompt: doc.systemPrompt ?? null,
    workspacePrompt: doc.workspacePrompt ?? null,
    messages,
    usage,
    createdAt,
    updatedAt,
  };
}

export function mongoChatAttachmentToRecord(
  doc: MongoChatAttachmentLike,
): ChatAttachmentRecord {
  const createdAt = toDateOrNow(doc.createdAt);
  const updatedAt = toDateOrNow(doc.updatedAt ?? createdAt);
  const rawCreatedBy =
    typeof doc.createdBy === "string" ? doc.createdBy.trim() : null;
  const createdBy =
    !rawCreatedBy || rawCreatedBy === "system" ? null : rawCreatedBy;

  return {
    id: idToString(doc._id),
    workspaceId: idToString(doc.workspaceId),
    chatId: doc.chatId,
    createdBy,
    storageKey: doc.storageKey,
    mediaType: doc.mediaType,
    filename: doc.filename ?? null,
    size: Number(doc.size),
    sha256: doc.sha256,
    createdAt,
    updatedAt,
  };
}

// ── PG Rows -> Record ────────────────────────────────────────────────────────

export function hydratePgChatRecord(params: {
  chat: ChatRow;
  messages: ChatMessageRow[];
  partsByMessageId: Map<string, HydratedPartRow[]>;
  usageEntries: ChatUsageEntryRow[];
}): ChatRecord {
  const { chat, messages, partsByMessageId, usageEntries } = params;

  const sortedMessages = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const hydratedMessages: StoredChatMessage[] = sortedMessages.map(m => {
    const rawParts = partsByMessageId.get(m.id) ?? [];
    rawParts.sort((a, b) => a.part.orderIndex - b.part.orderIndex);
    const parts = rawParts.map(repackPartFromPg);
    const derived = deriveLegacyFieldsFromParts(parts);
    return {
      ...(m.clientMessageId != null ? { id: m.clientMessageId } : {}),
      role: m.role,
      parts,
      ...(m.metadata != null ? { metadata: m.metadata } : {}),
      createdAt: m.createdAt,
      content: derived.content,
      ...(derived.reasoning ? { reasoning: derived.reasoning } : {}),
      ...(derived.toolCalls ? { toolCalls: derived.toolCalls } : {}),
    };
  });

  const sortedUsage = [...usageEntries].sort(
    (a, b) => a.entryIndex - b.entryIndex,
  );
  const history: ChatUsageEntryRecord[] = sortedUsage.map(e => ({
    entryIndex: e.entryIndex,
    messageIndex: e.assistantMessageIndex,
    model: e.model ?? null,
    promptTokens: Number(e.promptTokens),
    completionTokens: Number(e.completionTokens),
    totalTokens: Number(e.totalTokens),
    cacheReadTokens: Number(e.cacheReadTokens),
    cacheWriteTokens: Number(e.cacheWriteTokens),
    reasoningTokens: Number(e.reasoningTokens),
    costUsd: Number(e.costUsd),
    timestamp: e.recordedAt,
  }));

  const turnCheckpoint: ChatTurnCheckpoint | null = chat.turnCheckpoint
    ? {
        message: chat.turnCheckpoint.message,
        at: toDateOrNow(chat.turnCheckpoint.at),
        streamId: chat.turnCheckpoint.streamId,
      }
    : null;

  return {
    id: toWireId(chat.id),
    workspaceId: toWireId(chat.workspaceId),
    createdBy: chat.createdBy ? chat.createdBy.toLowerCase() : null,
    title: chat.title,
    titleGenerated: chat.titleGenerated,
    source: chat.source,
    appId: optionalToWireId(chat.appId),
    threadId: chat.threadId ?? null,
    activeAgent: chat.activeAgent ?? null,
    pinnedConsoleId: optionalToWireId(chat.pinnedConsoleId),
    activeStreamId: chat.activeStreamId ?? null,
    activeStreamAliveAt: chat.activeStreamAliveAt ?? null,
    turnCheckpoint,
    localAcp: chat.localAcp ?? null,
    systemPrompt: chat.systemPrompt ?? null,
    workspacePrompt: chat.workspacePrompt ?? null,
    messages: hydratedMessages,
    usage: {
      promptTokens: Number(chat.usagePromptTokens),
      completionTokens: Number(chat.usageCompletionTokens),
      totalTokens: Number(chat.usageTotalTokens),
      cacheReadTokens: Number(chat.usageCacheReadTokens),
      cacheWriteTokens: Number(chat.usageCacheWriteTokens),
      reasoningTokens: Number(chat.usageReasoningTokens),
      costUsd: Number(chat.usageCostUsd),
      history,
    },
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

export function pgChatAttachmentToRecord(
  row: ChatAttachmentRow,
): ChatAttachmentRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    chatId: toWireId(row.chatId),
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : null,
    storageKey: row.storageKey,
    mediaType: row.mediaType,
    filename: row.filename ?? null,
    size: Number(row.size),
    sha256: row.sha256,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Record -> Mongo subdoc / API response helpers ────────────────────────────

export function storedMessageToMongoDoc(
  msg: StoredChatMessage,
): Record<string, unknown> {
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const derived = deriveLegacyFieldsFromParts(parts);
  return {
    ...(msg.id !== undefined ? { id: msg.id } : {}),
    role: msg.role,
    parts,
    ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
    content: msg.content ?? derived.content,
    ...((msg.reasoning ?? derived.reasoning)
      ? { reasoning: msg.reasoning ?? derived.reasoning }
      : {}),
    ...((msg.toolCalls ?? derived.toolCalls)
      ? { toolCalls: msg.toolCalls ?? derived.toolCalls }
      : {}),
  };
}

/**
 * Serialize a `ChatRecord` to the exact HTTP JSON shape expected by
 * `GET /api/workspaces/:workspaceId/chats/:id`.
 */
export function chatRecordToApiResponse(
  record: ChatRecord,
): Record<string, unknown> {
  return {
    _id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    titleGenerated: record.titleGenerated,
    ...(record.source === "workflow" ? { source: "workflow" } : {}),
    ...(record.appId ? { appId: record.appId } : {}),
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.activeAgent ? { activeAgent: record.activeAgent } : {}),
    ...(record.pinnedConsoleId
      ? { pinnedConsoleId: record.pinnedConsoleId }
      : {}),
    createdBy: record.createdBy ?? "system",
    activeStreamId: record.activeStreamId,
    turnCheckpoint: record.turnCheckpoint,
    ...(record.localAcp ? { localAcp: record.localAcp } : {}),
    ...(record.systemPrompt !== null
      ? { systemPrompt: record.systemPrompt }
      : {}),
    ...(record.workspacePrompt !== null
      ? { workspacePrompt: record.workspacePrompt }
      : {}),
    messages: record.messages,
    usage: {
      promptTokens: record.usage.promptTokens,
      completionTokens: record.usage.completionTokens,
      totalTokens: record.usage.totalTokens,
      cacheReadTokens: record.usage.cacheReadTokens,
      cacheWriteTokens: record.usage.cacheWriteTokens,
      reasoningTokens: record.usage.reasoningTokens,
      costUsd: record.usage.costUsd,
      history: record.usage.history.map(h => ({
        messageIndex: h.messageIndex,
        promptTokens: h.promptTokens,
        completionTokens: h.completionTokens,
        totalTokens: h.totalTokens,
        cacheReadTokens: h.cacheReadTokens,
        cacheWriteTokens: h.cacheWriteTokens,
        reasoningTokens: h.reasoningTokens,
        costUsd: h.costUsd,
        ...(h.model != null ? { model: h.model } : {}),
        timestamp: h.timestamp,
      })),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Canonicalize a `ChatRecord` for parity verification / shadow-compare. */
export function canonicalizeChatForCompare(
  record: ChatRecord | null,
  resolveUser?: (id: string | null) => string | null,
): unknown {
  if (!record) return null;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    createdBy: resolveUser ? resolveUser(record.createdBy) : record.createdBy,
    title: record.title,
    titleGenerated: record.titleGenerated,
    source: record.source,
    appId: record.appId,
    threadId: record.threadId,
    activeAgent: record.activeAgent,
    pinnedConsoleId: record.pinnedConsoleId,
    activeStreamId: record.activeStreamId,
    activeStreamAliveAt: record.activeStreamAliveAt,
    turnCheckpoint: record.turnCheckpoint,
    localAcp: record.localAcp,
    systemPrompt: record.systemPrompt,
    workspacePrompt: record.workspacePrompt,
    messages: record.messages.map(m => ({
      id: m.id ?? null,
      role: m.role,
      metadata: m.metadata ?? null,
      parts: m.parts,
    })),
    usage: {
      promptTokens: record.usage.promptTokens,
      completionTokens: record.usage.completionTokens,
      totalTokens: record.usage.totalTokens,
      cacheReadTokens: record.usage.cacheReadTokens,
      cacheWriteTokens: record.usage.cacheWriteTokens,
      reasoningTokens: record.usage.reasoningTokens,
      costUsd: record.usage.costUsd,
      history: record.usage.history.map(h => ({
        entryIndex: h.entryIndex,
        messageIndex: h.messageIndex,
        model: h.model ?? null,
        promptTokens: h.promptTokens,
        completionTokens: h.completionTokens,
        totalTokens: h.totalTokens,
        cacheReadTokens: h.cacheReadTokens,
        cacheWriteTokens: h.cacheWriteTokens,
        reasoningTokens: h.reasoningTokens,
        costUsd: h.costUsd,
      })),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
