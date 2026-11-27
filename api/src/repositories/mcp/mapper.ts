/**
 * Bidirectional mappers between MongoDB `mcp_*` documents, Postgres Drizzle rows,
 * and canonical `Mcp*Record` types.
 *
 * Security invariants:
 *   - All 4 encrypted fields (`oauthClientInformationEncrypted`, `headersEncrypted`,
 *     `oauthTokensEncrypted`, `codeVerifierEncrypted`) are copied verbatim as opaque
 *     ciphertext — NEVER decrypted or re-encrypted here.
 *   - `userId: ""` (Mongo sentinel for workspace-shared credentials) maps bidirectionally
 *     to `userId: null` (Postgres `NULL` with `UNIQUE NULLS NOT DISTINCT`).
 */
import type { Types } from "mongoose";
import { toWireId } from "../../database/pg/id-codec";
import type {
  McpConnectionConfigRow,
  McpOAuthFlowRow,
  McpServerRow,
  McpToolGrantRow,
  NewMcpConnectionConfigRow,
  NewMcpOAuthFlowRow,
  NewMcpServerRow,
  NewMcpToolGrantRow,
} from "../../database/pg/schema/mcp";
import type {
  IMcpCachedTool,
  McpAuthPerformer,
  McpAuthType,
  McpConnectionConfigRecord,
  McpGrantDecision,
  McpOAuthFlowRecord,
  McpServerRecord,
  McpServerStatus,
  McpToolGrantRecord,
  McpToolRestriction,
  McpTransportType,
  McpWriteScope,
} from "./types";

export interface MongoMcpServerLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  name: string;
  description?: string | null;
  connectorType?: string;
  transport?: { type?: McpTransportType; url?: string };
  authType?: McpAuthType;
  authPerformer?: McpAuthPerformer;
  writeScope?: McpWriteScope;
  toolPolicy?: {
    defaultRestriction?: McpToolRestriction;
    restrictions?: Record<string, McpToolRestriction>;
  };
  cachedTools?: IMcpCachedTool[];
  oauth?: { clientInformation?: string | null } | null;
  status?: McpServerStatus;
  lastError?: string | null;
  lastConnectedAt?: Date | string | null;
  createdBy?: string | null;
  isActive?: boolean;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface MongoMcpConnectionConfigLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  serverId: Types.ObjectId | string;
  userId?: string | null;
  headers?: Record<string, string> | null;
  oauthTokens?: string | null;
  oauthExpiresAt?: number | Date | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface MongoMcpOAuthFlowLike {
  _id: Types.ObjectId | string;
  state: string;
  workspaceId: Types.ObjectId | string;
  serverId: Types.ObjectId | string;
  configUserId?: string | null;
  startedByUserId: string;
  codeVerifier?: string | null;
  createdAt?: Date | string;
}

export interface MongoMcpToolGrantLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  serverId: Types.ObjectId | string;
  userId: string;
  toolName: string;
  decision: McpGrantDecision;
  lastUsedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

function idToString(value: Types.ObjectId | string): string {
  return typeof value === "string" ? value : value.toHexString();
}

function toDateOrNow(value: Date | string | undefined | null): Date {
  if (value instanceof Date) return value;
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

export function normalizeConfigUserId(
  userId: string | null | undefined,
): string | null {
  if (userId == null) return null;
  const trimmed = userId.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function sanitizeCachedTools(
  tools: IMcpCachedTool[] | undefined | null,
): IMcpCachedTool[] {
  if (!Array.isArray(tools)) return [];
  return tools.map(t => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
  }));
}

function sanitizePlainRecord<T extends string>(
  input: Record<string, T> | undefined | null,
): Record<string, T> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return { ...input };
}

// ── Mongo -> Record ──────────────────────────────────────────────────────────

export function mongoMcpServerToRecord(
  doc: MongoMcpServerLike,
): McpServerRecord {
  const createdAt = toDateOrNow(doc.createdAt);
  const updatedAt = toDateOrNow(doc.updatedAt ?? createdAt);
  const rawCreatedBy =
    typeof doc.createdBy === "string" ? doc.createdBy.trim() : null;
  const createdBy =
    !rawCreatedBy || rawCreatedBy === "system" ? null : rawCreatedBy;

  return {
    id: idToString(doc._id),
    workspaceId: idToString(doc.workspaceId),
    name: doc.name,
    description: doc.description ?? null,
    connectorType: doc.connectorType ?? "custom",
    transport: {
      type: doc.transport?.type ?? "http",
      url: doc.transport?.url ?? "",
    },
    authType: doc.authType ?? "api_key",
    authPerformer: doc.authPerformer ?? "workspace",
    writeScope: doc.writeScope ?? "read",
    toolPolicy: {
      defaultRestriction: doc.toolPolicy?.defaultRestriction ?? "always",
      restrictions: sanitizePlainRecord(doc.toolPolicy?.restrictions),
    },
    cachedTools: sanitizeCachedTools(doc.cachedTools),
    oauthClientInformationEncrypted: doc.oauth?.clientInformation ?? null,
    status: doc.status ?? "created",
    lastError: doc.lastError ?? null,
    lastConnectedAt: toNullableDate(doc.lastConnectedAt),
    createdBy,
    isActive: doc.isActive ?? true,
    createdAt,
    updatedAt,
  };
}

export function mongoMcpConnectionConfigToRecord(
  doc: MongoMcpConnectionConfigLike,
): McpConnectionConfigRecord {
  const createdAt = toDateOrNow(doc.createdAt);
  const updatedAt = toDateOrNow(doc.updatedAt ?? createdAt);
  let oauthExpiresAt: number | null = null;
  if (
    typeof doc.oauthExpiresAt === "number" &&
    Number.isFinite(doc.oauthExpiresAt)
  ) {
    oauthExpiresAt = Math.trunc(doc.oauthExpiresAt);
  } else if (doc.oauthExpiresAt instanceof Date) {
    const ms = doc.oauthExpiresAt.getTime();
    if (Number.isFinite(ms)) oauthExpiresAt = ms;
  }

  return {
    id: idToString(doc._id),
    workspaceId: idToString(doc.workspaceId),
    serverId: idToString(doc.serverId),
    userId: normalizeConfigUserId(doc.userId),
    headersEncrypted: sanitizePlainRecord(doc.headers),
    oauthTokensEncrypted: doc.oauthTokens ?? null,
    oauthExpiresAt,
    createdAt,
    updatedAt,
  };
}

export function mongoMcpOAuthFlowToRecord(
  doc: MongoMcpOAuthFlowLike,
): McpOAuthFlowRecord {
  return {
    id: idToString(doc._id),
    state: doc.state,
    workspaceId: idToString(doc.workspaceId),
    serverId: idToString(doc.serverId),
    configUserId: normalizeConfigUserId(doc.configUserId),
    startedByUserId: doc.startedByUserId,
    codeVerifierEncrypted: doc.codeVerifier ?? null,
    createdAt: toDateOrNow(doc.createdAt),
  };
}

export function mongoMcpToolGrantToRecord(
  doc: MongoMcpToolGrantLike,
): McpToolGrantRecord {
  const createdAt = toDateOrNow(doc.createdAt);
  const updatedAt = toDateOrNow(doc.updatedAt ?? createdAt);
  return {
    id: idToString(doc._id),
    workspaceId: idToString(doc.workspaceId),
    serverId: idToString(doc.serverId),
    userId: doc.userId,
    toolName: doc.toolName,
    decision: doc.decision,
    lastUsedAt: toNullableDate(doc.lastUsedAt),
    createdAt,
    updatedAt,
  };
}

// ── PG Row -> Record ─────────────────────────────────────────────────────────

export function pgMcpServerToRecord(row: McpServerRow): McpServerRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    name: row.name,
    description: row.description ?? null,
    connectorType: row.connectorType,
    transport: {
      type: row.transportType,
      url: row.transportUrl,
    },
    authType: row.authType,
    authPerformer: row.authPerformer,
    writeScope: row.writeScope,
    toolPolicy: {
      defaultRestriction: row.toolPolicyDefaultRestriction,
      restrictions: sanitizePlainRecord(row.toolPolicyRestrictions),
    },
    cachedTools: sanitizeCachedTools(row.cachedTools),
    oauthClientInformationEncrypted:
      row.oauthClientInformationEncrypted ?? null,
    status: row.status,
    lastError: row.lastError ?? null,
    lastConnectedAt: row.lastConnectedAt ?? null,
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : null,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function pgMcpConnectionConfigToRecord(
  row: McpConnectionConfigRow,
): McpConnectionConfigRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    serverId: toWireId(row.serverId),
    userId: row.userId ? row.userId.toLowerCase() : null,
    headersEncrypted: sanitizePlainRecord(row.headersEncrypted),
    oauthTokensEncrypted: row.oauthTokensEncrypted ?? null,
    oauthExpiresAt: row.oauthExpiresAt ? row.oauthExpiresAt.getTime() : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function pgMcpOAuthFlowToRecord(
  row: McpOAuthFlowRow,
): McpOAuthFlowRecord {
  return {
    id: toWireId(row.id),
    state: row.state,
    workspaceId: toWireId(row.workspaceId),
    serverId: toWireId(row.serverId),
    configUserId: row.configUserId ? row.configUserId.toLowerCase() : null,
    startedByUserId: row.startedByUserId.toLowerCase(),
    codeVerifierEncrypted: row.codeVerifierEncrypted ?? null,
    createdAt: row.createdAt,
  };
}

export function pgMcpToolGrantToRecord(
  row: McpToolGrantRow,
): McpToolGrantRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    serverId: toWireId(row.serverId),
    userId: row.userId.toLowerCase(),
    toolName: row.toolName,
    decision: row.decision,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Record -> PG Insert Row ──────────────────────────────────────────────────

export function mcpServerRecordToPgInsert(
  record: McpServerRecord,
  ids: { idUuid: string; workspaceUuid: string; createdByUuid: string | null },
): NewMcpServerRow {
  return {
    id: ids.idUuid,
    workspaceId: ids.workspaceUuid,
    name: record.name,
    description: record.description,
    connectorType: record.connectorType,
    transportType: record.transport.type,
    transportUrl: record.transport.url,
    authType: record.authType,
    authPerformer: record.authPerformer,
    writeScope: record.writeScope,
    toolPolicyDefaultRestriction: record.toolPolicy.defaultRestriction,
    toolPolicyRestrictions: sanitizePlainRecord(record.toolPolicy.restrictions),
    cachedTools: sanitizeCachedTools(record.cachedTools),
    oauthClientInformationEncrypted: record.oauthClientInformationEncrypted,
    status: record.status,
    lastError: record.lastError,
    lastConnectedAt: record.lastConnectedAt,
    createdBy: ids.createdByUuid,
    isActive: record.isActive,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function mcpConnectionConfigRecordToPgInsert(
  record: McpConnectionConfigRecord,
  ids: {
    idUuid: string;
    workspaceUuid: string;
    serverUuid: string;
    userUuid: string | null;
  },
): NewMcpConnectionConfigRow {
  return {
    id: ids.idUuid,
    workspaceId: ids.workspaceUuid,
    serverId: ids.serverUuid,
    userId: ids.userUuid,
    headersEncrypted: sanitizePlainRecord(record.headersEncrypted),
    oauthTokensEncrypted: record.oauthTokensEncrypted,
    oauthExpiresAt:
      record.oauthExpiresAt != null ? new Date(record.oauthExpiresAt) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function mcpOAuthFlowRecordToPgInsert(
  record: McpOAuthFlowRecord,
  ids: {
    idUuid: string;
    workspaceUuid: string;
    serverUuid: string;
    configUserUuid: string | null;
    startedByUserUuid: string;
  },
): NewMcpOAuthFlowRow {
  return {
    id: ids.idUuid,
    state: record.state,
    workspaceId: ids.workspaceUuid,
    serverId: ids.serverUuid,
    configUserId: ids.configUserUuid,
    startedByUserId: ids.startedByUserUuid,
    codeVerifierEncrypted: record.codeVerifierEncrypted,
    createdAt: record.createdAt,
  };
}

export function mcpToolGrantRecordToPgInsert(
  record: McpToolGrantRecord,
  ids: {
    idUuid: string;
    workspaceUuid: string;
    serverUuid: string;
    userUuid: string;
  },
): NewMcpToolGrantRow {
  return {
    id: ids.idUuid,
    workspaceId: ids.workspaceUuid,
    serverId: ids.serverUuid,
    userId: ids.userUuid,
    toolName: record.toolName,
    decision: record.decision,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ── Shadow-compare canonicalizers ────────────────────────────────────────────

export function canonicalizeMcpServerForCompare(
  record: McpServerRecord | null,
  resolveUser?: (id: string | null) => string | null,
): unknown {
  if (!record) return null;
  return {
    ...record,
    createdBy: resolveUser ? resolveUser(record.createdBy) : record.createdBy,
  };
}

export function canonicalizeMcpConfigForCompare(
  record: McpConnectionConfigRecord | null,
  resolveUser?: (id: string | null) => string | null,
): unknown {
  if (!record) return null;
  return {
    ...record,
    userId: resolveUser ? resolveUser(record.userId) : record.userId,
  };
}

export function canonicalizeMcpGrantForCompare(
  record: McpToolGrantRecord | null,
  resolveUser?: (id: string) => string,
): unknown {
  if (!record) return null;
  return {
    ...record,
    userId: resolveUser ? resolveUser(record.userId) : record.userId,
  };
}
