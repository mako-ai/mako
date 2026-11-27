/**
 * Phase 1B (`workspaces_core` + `github_installations`) migration handlers:
 *   - FK-ordered resumable MongoDB -> Postgres backfill (`workspaces_core` + 10 per-table sub-domains)
 *   - Chunked parity verifier + `--repair` healer (`workspaces_core` + 10 per-table sub-domains)
 *   - Bidirectional Inngest sync-retry replay handlers (`pg` and `mongo`)
 *   - Postgres batched TTL reaper rules (`workspace_invites`, `mcp_oauth_codes`,
 *     `mcp_oauth_tokens`, `acp_plan_grants`)
 *
 * FK backfill order:
 *   1. `workspaces`
 *   2. `workspace_api_keys`     (unpacked from `workspaces.apiKeys[]`; FK -> workspaces)
 *   3. `workspace_members`      (FK -> workspaces, users)
 *   4. `workspace_invites`      (FK -> workspaces, users SET NULL)
 *   5. `workspace_user_handles` (FK -> workspaces, users SET NULL)
 *   6. `github_installations`   (FK -> workspaces, users SET NULL)
 *   7. `mcp_oauth_clients`      (independent)
 *   8. `mcp_oauth_codes`        (FK -> workspaces, mcp_oauth_clients, users)
 *   9. `mcp_oauth_tokens`       (FK -> workspaces, mcp_oauth_clients, users)
 *  10. `acp_plan_grants`        (FK -> workspaces, users)
 */
import { eq, inArray, sql } from "drizzle-orm";
import { Types } from "mongoose";
import { AcpPlanGrant } from "../../database/acp-plan-grant-schema";
import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "../../database/mcp-oauth-schema";
import type { MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  toWireId,
} from "../../database/pg/id-codec";
import {
  acpPlanGrants,
  githubInstallations,
  mcpOAuthClients,
  mcpOAuthCodes,
  mcpOAuthTokens,
  workspaceApiKeys,
  workspaceInvites,
  workspaceMembers,
  workspaceUserHandles,
  workspaces,
} from "../../database/pg/schema/workspaces";
import {
  GitHubInstallation,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceUserHandle,
} from "../../database/workspace-schema";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import {
  WORKSPACES_DOMAIN,
  WORKSPACES_SHADOW_OPTIONS,
  acpGrantRecordToPgRow,
  apiKeyRecordToPgRow,
  fallbackApiKeyId,
  githubInstallationRecordToPgRow,
  handleRecordToPgRow,
  inviteRecordToPgRow,
  mcpClientRecordToPgRow,
  mcpCodeRecordToPgRow,
  mcpTokenRecordToPgRow,
  memberRecordToPgRow,
  mongoAcpGrantToRecord,
  mongoApiKeyToRecord,
  mongoGitHubInstallationToRecord,
  mongoHandleToRecord,
  mongoInviteToRecord,
  mongoMcpClientToRecord,
  mongoMcpCodeToRecord,
  mongoMcpTokenToRecord,
  mongoMemberToRecord,
  mongoWorkspaceToRecord,
  pgAcpGrantToRecord,
  pgApiKeyToRecord,
  pgGitHubInstallationToRecord,
  pgHandleToRecord,
  pgInviteToRecord,
  pgMcpClientToRecord,
  pgMcpCodeToRecord,
  pgMcpTokenToRecord,
  pgMemberToRecord,
  pgWorkspaceToRecord,
  replayWorkspacesRetry,
  resolvePgUserUuidMap,
  resyncToPg,
  toPgUuid,
  toWire,
  workspaceRecordToPgRow,
  type AcpPlanGrantRecord,
  type GitHubInstallationRecord,
  type McpOAuthClientRecord,
  type McpOAuthCodeRecord,
  type McpOAuthTokenRecord,
  type MongoAcpGrantLike,
  type MongoApiKeyLike,
  type MongoGitHubInstallationLike,
  type MongoHandleLike,
  type MongoInviteLike,
  type MongoMcpClientLike,
  type MongoMcpCodeLike,
  type MongoMcpTokenLike,
  type MongoMemberLike,
  type MongoWorkspaceLike,
  type WorkspaceApiKeyRecord,
  type WorkspaceInviteRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
  type WorkspaceUserHandleRecord,
  type WorkspacesTableName,
} from "../../repositories/workspaces";
import {
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import { registerTtlRule } from "../ttl-reaper";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

interface WorkspacesStageMeta {
  stage: number;
  table: WorkspacesTableName;
  collection: string;
}

export const WORKSPACES_STAGES: readonly WorkspacesStageMeta[] = [
  { stage: 1, table: "workspaces", collection: "workspaces" },
  { stage: 2, table: "workspace_api_keys", collection: "workspaces" },
  { stage: 3, table: "workspace_members", collection: "workspacemembers" },
  { stage: 4, table: "workspace_invites", collection: "workspaceinvites" },
  {
    stage: 5,
    table: "workspace_user_handles",
    collection: "workspace_user_handles",
  },
  {
    stage: 6,
    table: "github_installations",
    collection: "github_installations",
  },
  { stage: 7, table: "mcp_oauth_clients", collection: "mcpoauthclients" },
  { stage: 8, table: "mcp_oauth_codes", collection: "mcpoauthcodes" },
  { stage: 9, table: "mcp_oauth_tokens", collection: "mcpoauthtokens" },
  { stage: 10, table: "acp_plan_grants", collection: "acpplangrants" },
] as const;

const STAGE_ORDER_BY_TABLE = new Map<WorkspacesTableName, number>(
  WORKSPACES_STAGES.map(s => [s.table, s.stage]),
);

type WorkspacesBackfillDoc =
  | {
      table: "workspaces";
      record?: WorkspaceRecord;
      parseError?: string;
      resolvedCreatedBy?: string | null;
    }
  | {
      table: "workspace_api_keys";
      record?: WorkspaceApiKeyRecord;
      parseError?: string;
      resolvedCreatedBy?: string | null;
    }
  | {
      table: "workspace_members";
      record?: WorkspaceMemberRecord;
      parseError?: string;
      resolvedUserUuid?: string;
    }
  | {
      table: "workspace_invites";
      record?: WorkspaceInviteRecord;
      parseError?: string;
      resolvedInvitedBy?: string | null;
    }
  | {
      table: "workspace_user_handles";
      record?: WorkspaceUserHandleRecord;
      parseError?: string;
      resolvedUserUuid?: string | null;
    }
  | {
      table: "github_installations";
      record?: GitHubInstallationRecord;
      parseError?: string;
      resolvedCreatedBy?: string | null;
    }
  | {
      table: "mcp_oauth_clients";
      record?: McpOAuthClientRecord;
      parseError?: string;
    }
  | {
      table: "mcp_oauth_codes";
      record?: McpOAuthCodeRecord;
      parseError?: string;
      resolvedUserUuid?: string;
    }
  | {
      table: "mcp_oauth_tokens";
      record?: McpOAuthTokenRecord;
      parseError?: string;
      resolvedUserUuid?: string;
    }
  | {
      table: "acp_plan_grants";
      record?: AcpPlanGrantRecord;
      parseError?: string;
      resolvedUserUuid?: string;
    };

function encodeCompositeCursor(
  stage: number,
  table: WorkspacesTableName,
  subCursor: string,
): string {
  return `${stage}:${table}:${subCursor}`;
}

function decodeCompositeCursor(
  cursor: string | null,
): { stage: number; table: WorkspacesTableName; subCursor: string } | null {
  if (!cursor) {
    return null;
  }
  const match = /^(10|[1-9]):([a-z_]+):(.*)$/.exec(cursor);
  if (!match) {
    return null;
  }
  return {
    stage: Number(match[1]),
    table: match[2] as WorkspacesTableName,
    subCursor: match[3],
  };
}

function encodeVerifierKey(
  table: WorkspacesTableName,
  pgEntityId: string,
): string {
  return `${table}:${pgEntityId}`;
}

function decodeVerifierKey(
  key: string,
): { table: WorkspacesTableName; pgEntityId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) {
    return null;
  }
  const table = key.slice(0, idx) as WorkspacesTableName;
  if (!STAGE_ORDER_BY_TABLE.has(table)) {
    return null;
  }
  return { table, pgEntityId: key.slice(idx + 1) };
}

function rawIdFilter(afterId: string | null): Record<string, unknown> {
  if (!afterId) {
    return {};
  }
  if (isObjectIdHex(afterId)) {
    return { _id: { $gt: new Types.ObjectId(afterId) } };
  }
  return {
    $or: [{ _id: { $gt: afterId } }, { _id: { $type: "objectId" } }],
  };
}

function safeEntityIdFromRaw(rawId: unknown): {
  rawStr: string;
  pgUuid: string;
} {
  const rawStr = String(rawId ?? "");
  return {
    rawStr,
    pgUuid: isObjectIdHex(rawStr) ? objectIdToUuid(rawStr) : rawStr,
  };
}

async function fetchStageBackfillItems(
  meta: WorkspacesStageMeta,
  afterCursor: string | null,
  limit: number,
  composite: boolean,
): Promise<Array<BackfillItem<WorkspacesBackfillDoc>>> {
  if (limit <= 0) {
    return [];
  }
  const makeCursor = (sub: string) =>
    composite ? encodeCompositeCursor(meta.stage, meta.table, sub) : sub;

  switch (meta.table) {
    case "workspaces": {
      const docs = (await Workspace.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoWorkspaceLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoWorkspaceToRecord(doc);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "workspaces",
            collectionName: meta.collection,
            doc: { table: "workspaces", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "workspaces",
            collectionName: meta.collection,
            doc: {
              table: "workspaces",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "workspace_api_keys": {
      let afterWsId: string | null = null;
      let afterKeyId: string | null = null;
      if (afterCursor) {
        const parts = afterCursor.split(":");
        afterWsId = parts[0] || null;
        afterKeyId = parts[1] || null;
      }
      const wsFilter: Record<string, unknown> = {
        "apiKeys.0": { $exists: true },
      };
      if (afterWsId && isObjectIdHex(afterWsId)) {
        wsFilter._id = { $gte: new Types.ObjectId(afterWsId) };
      }

      const items: Array<BackfillItem<WorkspacesBackfillDoc>> = [];
      let batchStartWs: Types.ObjectId | null =
        afterWsId && isObjectIdHex(afterWsId)
          ? new Types.ObjectId(afterWsId)
          : null;
      let inclusiveStart = true;

      while (items.length < limit) {
        const queryFilter: Record<string, unknown> = {
          "apiKeys.0": { $exists: true },
        };
        if (batchStartWs) {
          queryFilter._id = inclusiveStart
            ? { $gte: batchStartWs }
            : { $gt: batchStartWs };
        }
        const docs = (await Workspace.collection
          .find(queryFilter, { projection: { _id: 1, apiKeys: 1 } })
          .sort({ _id: 1 })
          .limit(Math.max(25, limit))
          .toArray()) as unknown as Array<{
          _id: unknown;
          apiKeys?: MongoApiKeyLike[];
        }>;

        if (docs.length === 0) {
          break;
        }

        for (const doc of docs) {
          const wsStr = String(doc._id ?? "");
          if (!isObjectIdHex(wsStr)) {
            continue;
          }
          const wsWire = wsStr.toLowerCase();
          const sortedKeys = [...(doc.apiKeys ?? [])]
            .map(k => ({
              key: k,
              wireId:
                k._id != null && isObjectIdHex(String(k._id))
                  ? String(k._id).toLowerCase()
                  : fallbackApiKeyId(wsWire, k.keyHash ?? ""),
            }))
            .sort((a, b) => a.wireId.localeCompare(b.wireId));

          for (const entry of sortedKeys) {
            if (
              afterWsId &&
              wsWire === afterWsId &&
              afterKeyId &&
              entry.wireId <= afterKeyId
            ) {
              continue;
            }
            const subCursor = `${wsWire}:${entry.wireId}`;
            try {
              const record = mongoApiKeyToRecord(wsWire, entry.key);
              items.push({
                cursor: makeCursor(subCursor),
                entityId: toPgUuid(record.id),
                targetTable: "workspace_api_keys",
                collectionName: meta.collection,
                doc: { table: "workspace_api_keys", record },
              });
            } catch (err) {
              items.push({
                cursor: makeCursor(subCursor),
                entityId: entry.wireId,
                targetTable: "workspace_api_keys",
                collectionName: meta.collection,
                doc: {
                  table: "workspace_api_keys",
                  parseError: err instanceof Error ? err.message : String(err),
                },
              });
            }
            if (items.length >= limit) {
              break;
            }
          }
          if (items.length >= limit) {
            break;
          }
        }

        const lastDoc = docs[docs.length - 1];
        const lastIdStr = String(lastDoc?._id ?? "");
        if (!isObjectIdHex(lastIdStr)) {
          break;
        }
        batchStartWs = new Types.ObjectId(lastIdStr);
        inclusiveStart = false;
      }

      return items;
    }

    case "workspace_members": {
      const docs = (await WorkspaceMember.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoMemberLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoMemberToRecord(doc);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "workspace_members",
            collectionName: meta.collection,
            doc: { table: "workspace_members", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "workspace_members",
            collectionName: meta.collection,
            doc: {
              table: "workspace_members",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "workspace_invites": {
      const docs = (await WorkspaceInvite.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoInviteLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoInviteToRecord(doc);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "workspace_invites",
            collectionName: meta.collection,
            doc: { table: "workspace_invites", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "workspace_invites",
            collectionName: meta.collection,
            doc: {
              table: "workspace_invites",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "workspace_user_handles": {
      const docs = (await WorkspaceUserHandle.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoHandleLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoHandleToRecord(doc);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "workspace_user_handles",
            collectionName: meta.collection,
            doc: { table: "workspace_user_handles", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "workspace_user_handles",
            collectionName: meta.collection,
            doc: {
              table: "workspace_user_handles",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "github_installations": {
      const docs = (await GitHubInstallation.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoGitHubInstallationLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoGitHubInstallationToRecord(doc);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "github_installations",
            collectionName: meta.collection,
            doc: { table: "github_installations", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "github_installations",
            collectionName: meta.collection,
            doc: {
              table: "github_installations",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "mcp_oauth_clients": {
      const docs = (await McpOAuthClient.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoMcpClientLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoMcpClientToRecord(doc);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "mcp_oauth_clients",
            collectionName: meta.collection,
            doc: { table: "mcp_oauth_clients", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "mcp_oauth_clients",
            collectionName: meta.collection,
            doc: {
              table: "mcp_oauth_clients",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "mcp_oauth_codes": {
      const docs = (await McpOAuthCode.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoMcpCodeLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoMcpCodeToRecord(doc);
          toPgUuid(record.workspaceId);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "mcp_oauth_codes",
            collectionName: meta.collection,
            doc: { table: "mcp_oauth_codes", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "mcp_oauth_codes",
            collectionName: meta.collection,
            doc: {
              table: "mcp_oauth_codes",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "mcp_oauth_tokens": {
      const docs = (await McpOAuthToken.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoMcpTokenLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoMcpTokenToRecord(doc);
          toPgUuid(record.workspaceId);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "mcp_oauth_tokens",
            collectionName: meta.collection,
            doc: { table: "mcp_oauth_tokens", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "mcp_oauth_tokens",
            collectionName: meta.collection,
            doc: {
              table: "mcp_oauth_tokens",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }

    case "acp_plan_grants": {
      const docs = (await AcpPlanGrant.collection
        .find(rawIdFilter(afterCursor))
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoAcpGrantLike[];
      return docs.map(doc => {
        const { rawStr, pgUuid } = safeEntityIdFromRaw(doc._id);
        try {
          const record = mongoAcpGrantToRecord(doc);
          toPgUuid(record.workspaceId);
          return {
            cursor: makeCursor(record.id),
            entityId: toPgUuid(record.id),
            targetTable: "acp_plan_grants",
            collectionName: meta.collection,
            doc: { table: "acp_plan_grants", record },
          };
        } catch (err) {
          return {
            cursor: makeCursor(rawStr),
            entityId: pgUuid,
            targetTable: "acp_plan_grants",
            collectionName: meta.collection,
            doc: {
              table: "acp_plan_grants",
              parseError: err instanceof Error ? err.message : String(err),
            },
          };
        }
      });
    }
  }
}

interface ValidationBatchCache {
  knownWorkspaceUuids: Set<string>;
  knownClientIds: Set<string>;
  userMap: Map<string, string>;
  checkedWorkspaces: Set<string>;
  checkedClients: Set<string>;
  checkedUsers: Set<string>;
}

function createBatchCache(): ValidationBatchCache {
  return {
    knownWorkspaceUuids: new Set(),
    knownClientIds: new Set(),
    userMap: new Map(),
    checkedWorkspaces: new Set(),
    checkedClients: new Set(),
    checkedUsers: new Set(),
  };
}

async function hasPgWorkspace(
  db: MakoPgDb,
  workspaceWireId: string,
  cache: ValidationBatchCache,
): Promise<boolean> {
  const uuid = toPgUuid(workspaceWireId);
  if (cache.knownWorkspaceUuids.has(uuid)) {
    return true;
  }
  if (cache.checkedWorkspaces.has(uuid)) {
    return false;
  }
  cache.checkedWorkspaces.add(uuid);
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, uuid))
    .limit(1);
  if (rows[0]) {
    cache.knownWorkspaceUuids.add(uuid);
    return true;
  }
  return false;
}

async function hasPgMcpClient(
  db: MakoPgDb,
  clientId: string,
  cache: ValidationBatchCache,
): Promise<boolean> {
  if (!clientId) {
    return false;
  }
  if (cache.knownClientIds.has(clientId)) {
    return true;
  }
  if (cache.checkedClients.has(clientId)) {
    return false;
  }
  cache.checkedClients.add(clientId);
  const rows = await db
    .select({ id: mcpOAuthClients.id })
    .from(mcpOAuthClients)
    .where(eq(mcpOAuthClients.clientId, clientId))
    .limit(1);
  if (rows[0]) {
    cache.knownClientIds.add(clientId);
    return true;
  }
  return false;
}

async function resolveCachedPgUserUuid(
  db: MakoPgDb,
  userId: string,
  cache: ValidationBatchCache,
): Promise<string | null> {
  if (!userId) {
    return null;
  }
  const existing =
    cache.userMap.get(userId) ?? cache.userMap.get(userId.toLowerCase());
  if (existing) {
    return existing;
  }
  if (cache.checkedUsers.has(userId)) {
    return null;
  }
  cache.checkedUsers.add(userId);
  const resolved = await resolvePgUserUuidMap(db, [userId]);
  for (const [k, v] of resolved) {
    cache.userMap.set(k, v);
  }
  return (
    cache.userMap.get(userId) ?? cache.userMap.get(userId.toLowerCase()) ?? null
  );
}

async function validateWorkspacesBackfillItem(
  item: BackfillItem<WorkspacesBackfillDoc>,
  db: MakoPgDb,
  cache: ValidationBatchCache,
): Promise<BackfillValidationResult> {
  const { doc } = item;
  if (doc.parseError || !doc.record) {
    return {
      ok: false,
      reason: `invalid_${doc.table}_document`,
      sanitizedPayload: {
        table: doc.table,
        entityId: item.entityId,
        error: doc.parseError ?? "missing record",
      },
    };
  }

  switch (doc.table) {
    case "workspaces": {
      if (!doc.record.slug) {
        return {
          ok: false,
          reason: "invalid_workspace_missing_slug",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      doc.resolvedCreatedBy = await resolveCachedPgUserUuid(
        db,
        doc.record.createdBy,
        cache,
      );
      cache.knownWorkspaceUuids.add(toPgUuid(doc.record.id));
      return { ok: true };
    }

    case "workspace_api_keys": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      if (!doc.record.keyHash) {
        return {
          ok: false,
          reason: "invalid_api_key_missing_hash",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      doc.resolvedCreatedBy = await resolveCachedPgUserUuid(
        db,
        doc.record.createdBy,
        cache,
      );
      return { ok: true };
    }

    case "workspace_members": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      const userUuid = await resolveCachedPgUserUuid(
        db,
        doc.record.userId,
        cache,
      );
      if (!userUuid) {
        return {
          ok: false,
          reason: "orphaned_user_missing",
          sanitizedPayload: {
            table: doc.table,
            id: doc.record.id,
            userId: doc.record.userId,
          },
        };
      }
      doc.resolvedUserUuid = userUuid;
      return { ok: true };
    }

    case "workspace_invites": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      if (!doc.record.email || !doc.record.token) {
        return {
          ok: false,
          reason: "invalid_invite_missing_fields",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      doc.resolvedInvitedBy = await resolveCachedPgUserUuid(
        db,
        doc.record.invitedBy,
        cache,
      );
      return { ok: true };
    }

    case "workspace_user_handles": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      if (!doc.record.handle) {
        return {
          ok: false,
          reason: "invalid_handle_missing_value",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      doc.resolvedUserUuid = await resolveCachedPgUserUuid(
        db,
        doc.record.userId,
        cache,
      );
      return { ok: true };
    }

    case "github_installations": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      if (
        !Number.isInteger(doc.record.installationId) ||
        doc.record.installationId <= 0
      ) {
        return {
          ok: false,
          reason: "invalid_github_installation_id",
          sanitizedPayload: {
            id: doc.record.id,
            installationId: doc.record.installationId,
          },
        };
      }
      doc.resolvedCreatedBy = await resolveCachedPgUserUuid(
        db,
        doc.record.createdBy,
        cache,
      );
      return { ok: true };
    }

    case "mcp_oauth_clients": {
      if (!doc.record.clientId) {
        return {
          ok: false,
          reason: "invalid_mcp_client_missing_client_id",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      cache.knownClientIds.add(doc.record.clientId);
      return { ok: true };
    }

    case "mcp_oauth_codes": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      if (!(await hasPgMcpClient(db, doc.record.clientId, cache))) {
        return {
          ok: false,
          reason: "orphaned_mcp_client_missing",
          sanitizedPayload: {
            table: doc.table,
            id: doc.record.id,
            clientId: doc.record.clientId,
          },
        };
      }
      const userUuid = await resolveCachedPgUserUuid(
        db,
        doc.record.userId,
        cache,
      );
      if (!userUuid) {
        return {
          ok: false,
          reason: "orphaned_user_missing",
          sanitizedPayload: {
            table: doc.table,
            id: doc.record.id,
            userId: doc.record.userId,
          },
        };
      }
      doc.resolvedUserUuid = userUuid;
      return { ok: true };
    }

    case "mcp_oauth_tokens": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      if (!(await hasPgMcpClient(db, doc.record.clientId, cache))) {
        return {
          ok: false,
          reason: "orphaned_mcp_client_missing",
          sanitizedPayload: {
            table: doc.table,
            id: doc.record.id,
            clientId: doc.record.clientId,
          },
        };
      }
      const userUuid = await resolveCachedPgUserUuid(
        db,
        doc.record.userId,
        cache,
      );
      if (!userUuid) {
        return {
          ok: false,
          reason: "orphaned_user_missing",
          sanitizedPayload: {
            table: doc.table,
            id: doc.record.id,
            userId: doc.record.userId,
          },
        };
      }
      doc.resolvedUserUuid = userUuid;
      return { ok: true };
    }

    case "acp_plan_grants": {
      if (!(await hasPgWorkspace(db, doc.record.workspaceId, cache))) {
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
      const userUuid = await resolveCachedPgUserUuid(
        db,
        doc.record.userId,
        cache,
      );
      if (!userUuid) {
        return {
          ok: false,
          reason: "orphaned_user_missing",
          sanitizedPayload: {
            table: doc.table,
            id: doc.record.id,
            userId: doc.record.userId,
          },
        };
      }
      doc.resolvedUserUuid = userUuid;
      return { ok: true };
    }
  }
}

async function upsertWorkspacesBackfillItems(
  items: Array<BackfillItem<WorkspacesBackfillDoc>>,
  db: MakoPgDb,
): Promise<number> {
  let upserted = 0;
  for (const item of items) {
    const { doc } = item;
    if (!doc.record) {
      continue;
    }

    switch (doc.table) {
      case "workspaces": {
        const row = workspaceRecordToPgRow(
          doc.record,
          () => doc.resolvedCreatedBy ?? null,
        );
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(workspaces)
          .values(row)
          .onConflictDoUpdate({
            target: workspaces.id,
            set: rest,
            setWhere: sql`${workspaces.updatedAt} <= excluded.updated_at`,
          });
        upserted += 1;
        break;
      }

      case "workspace_api_keys": {
        const row = apiKeyRecordToPgRow(
          doc.record,
          () => doc.resolvedCreatedBy ?? null,
        );
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(workspaceApiKeys)
          .values(row)
          .onConflictDoUpdate({
            target: workspaceApiKeys.id,
            set: {
              ...rest,
              lastUsedAt: sql`GREATEST(${workspaceApiKeys.lastUsedAt}, excluded.last_used_at)`,
            },
            setWhere: sql`${workspaceApiKeys.lastUsedAt} IS NULL OR (excluded.last_used_at IS NOT NULL AND ${workspaceApiKeys.lastUsedAt} <= excluded.last_used_at)`,
          });
        upserted += 1;
        break;
      }

      case "workspace_members": {
        if (!doc.resolvedUserUuid) {
          break;
        }
        const userUuid = doc.resolvedUserUuid;
        const row = memberRecordToPgRow(doc.record, () => userUuid);
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(workspaceMembers)
          .values(row)
          .onConflictDoUpdate({
            target: workspaceMembers.id,
            set: rest,
            setWhere: sql`${workspaceMembers.updatedAt} <= excluded.updated_at`,
          });
        upserted += 1;
        break;
      }

      case "workspace_invites": {
        const row = inviteRecordToPgRow(
          doc.record,
          () => doc.resolvedInvitedBy ?? null,
        );
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(workspaceInvites)
          .values(row)
          .onConflictDoUpdate({
            target: workspaceInvites.id,
            set: {
              ...rest,
              acceptedAt: sql`COALESCE(${workspaceInvites.acceptedAt}, excluded.accepted_at)`,
            },
            setWhere: sql`${workspaceInvites.acceptedAt} IS NULL AND ${workspaceInvites.updatedAt} <= excluded.updated_at AND ${workspaceInvites.expiresAt} <= excluded.expires_at`,
          });
        upserted += 1;
        break;
      }

      case "workspace_user_handles": {
        const row = handleRecordToPgRow(
          doc.record,
          () => doc.resolvedUserUuid ?? null,
        );
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(workspaceUserHandles)
          .values(row)
          .onConflictDoUpdate({
            target: workspaceUserHandles.id,
            set: rest,
            setWhere: sql`${workspaceUserHandles.updatedAt} <= excluded.updated_at`,
          });
        upserted += 1;
        break;
      }

      case "github_installations": {
        const row = githubInstallationRecordToPgRow(
          doc.record,
          () => doc.resolvedCreatedBy ?? null,
        );
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(githubInstallations)
          .values(row)
          .onConflictDoUpdate({
            target: githubInstallations.id,
            set: rest,
            setWhere: sql`${githubInstallations.updatedAt} <= excluded.updated_at`,
          });
        upserted += 1;
        break;
      }

      case "mcp_oauth_clients": {
        const row = mcpClientRecordToPgRow(doc.record);
        await db.insert(mcpOAuthClients).values(row).onConflictDoNothing({
          target: mcpOAuthClients.clientId,
        });
        upserted += 1;
        break;
      }

      case "mcp_oauth_codes": {
        if (!doc.resolvedUserUuid) {
          break;
        }
        const userUuid = doc.resolvedUserUuid;
        const row = mcpCodeRecordToPgRow(doc.record, () => userUuid);
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(mcpOAuthCodes)
          .values(row)
          .onConflictDoUpdate({
            target: mcpOAuthCodes.id,
            set: {
              ...rest,
              usedAt: sql`COALESCE(${mcpOAuthCodes.usedAt}, excluded.used_at)`,
            },
            setWhere: sql`${mcpOAuthCodes.usedAt} IS NULL`,
          });
        upserted += 1;
        break;
      }

      case "mcp_oauth_tokens": {
        if (!doc.resolvedUserUuid) {
          break;
        }
        const userUuid = doc.resolvedUserUuid;
        const row = mcpTokenRecordToPgRow(doc.record, () => userUuid);
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(mcpOAuthTokens)
          .values(row)
          .onConflictDoUpdate({
            target: mcpOAuthTokens.id,
            set: {
              ...rest,
              lastUsedAt: sql`GREATEST(${mcpOAuthTokens.lastUsedAt}, excluded.last_used_at)`,
            },
            setWhere: sql`${mcpOAuthTokens.updatedAt} <= excluded.updated_at AND ${mcpOAuthTokens.accessExpiresAt} <= excluded.access_expires_at AND (${mcpOAuthTokens.lastUsedAt} IS NULL OR (excluded.last_used_at IS NOT NULL AND ${mcpOAuthTokens.lastUsedAt} <= excluded.last_used_at))`,
          });
        upserted += 1;
        break;
      }

      case "acp_plan_grants": {
        if (!doc.resolvedUserUuid) {
          break;
        }
        const userUuid = doc.resolvedUserUuid;
        const row = acpGrantRecordToPgRow(doc.record, () => userUuid);
        const { id: _id, ...rest } = row;
        void _id;
        await db
          .insert(acpPlanGrants)
          .values(row)
          .onConflictDoUpdate({
            target: acpPlanGrants.id,
            set: rest,
            setWhere: sql`${acpPlanGrants.updatedAt} <= excluded.updated_at AND (${acpPlanGrants.status} <> 'revoked' OR excluded.status = 'revoked' OR ${acpPlanGrants.updatedAt} < excluded.updated_at)`,
          });
        upserted += 1;
        break;
      }
    }
  }
  return upserted;
}

export function createWorkspacesBackfillHandler(): BackfillDomainHandler<WorkspacesBackfillDoc> {
  let batchCache = createBatchCache();

  return {
    domain: WORKSPACES_DOMAIN,
    collectionName: "workspaces",
    targetTable: "workspaces",
    async fetchBatch({ afterCursor, limit }) {
      batchCache = createBatchCache();
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<WorkspacesBackfillDoc>> = [];

      for (const meta of WORKSPACES_STAGES) {
        if (meta.stage < startStage) {
          continue;
        }
        const remaining = limit - items.length;
        if (remaining <= 0) {
          break;
        }
        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.subCursor : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          true,
        );
        items.push(...batch);
      }

      return items;
    },
    validate(item, db) {
      return validateWorkspacesBackfillItem(item, db, batchCache);
    },
    upsertBatch(items, db) {
      return upsertWorkspacesBackfillItems(items, db);
    },
  };
}

export function createWorkspacesTableBackfillHandler(
  meta: WorkspacesStageMeta,
): BackfillDomainHandler<WorkspacesBackfillDoc> {
  let batchCache = createBatchCache();

  return {
    domain: `${WORKSPACES_DOMAIN}:${meta.table}`,
    collectionName: meta.collection,
    targetTable: meta.table,
    async fetchBatch({ afterCursor, limit }) {
      batchCache = createBatchCache();
      return fetchStageBackfillItems(meta, afterCursor, limit, false);
    },
    validate(item, db) {
      return validateWorkspacesBackfillItem(item, db, batchCache);
    },
    upsertBatch(items, db) {
      return upsertWorkspacesBackfillItems(items, db);
    },
  };
}

// ── Parity verifier (+ --repair) ─────────────────────────────────────────

function collectBatchUserIds(
  items: Array<BackfillItem<WorkspacesBackfillDoc>>,
): string[] {
  const out: string[] = [];
  for (const { doc } of items) {
    if (!doc.record) {
      continue;
    }
    switch (doc.table) {
      case "workspaces":
      case "workspace_api_keys":
      case "github_installations":
        if (doc.record.createdBy) {
          out.push(doc.record.createdBy);
        }
        break;
      case "workspace_invites":
        if (doc.record.invitedBy) {
          out.push(doc.record.invitedBy);
        }
        break;
      case "workspace_members":
      case "workspace_user_handles":
      case "mcp_oauth_codes":
      case "mcp_oauth_tokens":
      case "acp_plan_grants":
        if (doc.record.userId) {
          out.push(doc.record.userId);
        }
        break;
      case "mcp_oauth_clients":
        break;
    }
  }
  return out;
}

function buildVerifierRecord(
  item: BackfillItem<WorkspacesBackfillDoc>,
  userMap: Map<string, string>,
  composite: boolean,
): VerifierMongoRecord {
  const { doc } = item;
  const pgEntityId = item.entityId.toLowerCase();
  const mapNullable = (u: string) =>
    u ? (userMap.get(u) ?? userMap.get(u.toLowerCase()) ?? "") : "";
  const mapRequired = (u: string) =>
    u
      ? (userMap.get(u) ?? userMap.get(u.toLowerCase()) ?? u.toLowerCase())
      : "";

  let record: unknown = null;
  if (doc.record) {
    switch (doc.table) {
      case "workspaces":
        record = {
          ...doc.record,
          createdBy: mapNullable(doc.record.createdBy),
        };
        break;
      case "workspace_api_keys":
        record = {
          ...doc.record,
          createdBy: mapNullable(doc.record.createdBy),
        };
        break;
      case "workspace_members":
        record = { ...doc.record, userId: mapRequired(doc.record.userId) };
        break;
      case "workspace_invites":
        record = {
          ...doc.record,
          invitedBy: mapNullable(doc.record.invitedBy),
        };
        break;
      case "workspace_user_handles":
        record = { ...doc.record, userId: mapNullable(doc.record.userId) };
        break;
      case "github_installations":
        record = {
          ...doc.record,
          createdBy: mapNullable(doc.record.createdBy),
        };
        break;
      case "mcp_oauth_clients":
        record = doc.record;
        break;
      case "mcp_oauth_codes":
        record = { ...doc.record, userId: mapRequired(doc.record.userId) };
        break;
      case "mcp_oauth_tokens":
        record = { ...doc.record, userId: mapRequired(doc.record.userId) };
        break;
      case "acp_plan_grants":
        record = { ...doc.record, userId: mapRequired(doc.record.userId) };
        break;
    }
  }

  return {
    cursor: item.cursor,
    entityId: composite ? encodeVerifierKey(doc.table, pgEntityId) : pgEntityId,
    targetTable: doc.table,
    tombstoneId: pgEntityId,
    record,
  };
}

async function fetchPgRecordsForTable(
  table: WorkspacesTableName,
  ids: string[],
  db: MakoPgDb,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const uuidIds = ids.filter(isUuidString).map(id => id.toLowerCase());
  if (uuidIds.length === 0) {
    return out;
  }

  switch (table) {
    case "workspaces": {
      const rows = await db
        .select()
        .from(workspaces)
        .where(inArray(workspaces.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgWorkspaceToRecord(r));
      }
      return out;
    }
    case "workspace_api_keys": {
      const rows = await db
        .select()
        .from(workspaceApiKeys)
        .where(inArray(workspaceApiKeys.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgApiKeyToRecord(r));
      }
      return out;
    }
    case "workspace_members": {
      const rows = await db
        .select()
        .from(workspaceMembers)
        .where(inArray(workspaceMembers.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgMemberToRecord(r));
      }
      return out;
    }
    case "workspace_invites": {
      const rows = await db
        .select()
        .from(workspaceInvites)
        .where(inArray(workspaceInvites.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgInviteToRecord(r));
      }
      return out;
    }
    case "workspace_user_handles": {
      const rows = await db
        .select()
        .from(workspaceUserHandles)
        .where(inArray(workspaceUserHandles.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgHandleToRecord(r));
      }
      return out;
    }
    case "github_installations": {
      const rows = await db
        .select()
        .from(githubInstallations)
        .where(inArray(githubInstallations.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgGitHubInstallationToRecord(r));
      }
      return out;
    }
    case "mcp_oauth_clients": {
      const rows = await db
        .select()
        .from(mcpOAuthClients)
        .where(inArray(mcpOAuthClients.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgMcpClientToRecord(r));
      }
      return out;
    }
    case "mcp_oauth_codes": {
      const rows = await db
        .select()
        .from(mcpOAuthCodes)
        .where(inArray(mcpOAuthCodes.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgMcpCodeToRecord(r));
      }
      return out;
    }
    case "mcp_oauth_tokens": {
      const rows = await db
        .select()
        .from(mcpOAuthTokens)
        .where(inArray(mcpOAuthTokens.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgMcpTokenToRecord(r));
      }
      return out;
    }
    case "acp_plan_grants": {
      const rows = await db
        .select()
        .from(acpPlanGrants)
        .where(inArray(acpPlanGrants.id, uuidIds));
      for (const r of rows) {
        out.set(r.id.toLowerCase(), pgAcpGrantToRecord(r));
      }
      return out;
    }
  }
}

async function listAllPgIdsForTable(
  table: WorkspacesTableName,
  db: MakoPgDb,
): Promise<string[]> {
  switch (table) {
    case "workspaces":
      return (await db.select({ id: workspaces.id }).from(workspaces)).map(r =>
        r.id.toLowerCase(),
      );
    case "workspace_api_keys":
      return (
        await db.select({ id: workspaceApiKeys.id }).from(workspaceApiKeys)
      ).map(r => r.id.toLowerCase());
    case "workspace_members":
      return (
        await db.select({ id: workspaceMembers.id }).from(workspaceMembers)
      ).map(r => r.id.toLowerCase());
    case "workspace_invites":
      return (
        await db.select({ id: workspaceInvites.id }).from(workspaceInvites)
      ).map(r => r.id.toLowerCase());
    case "workspace_user_handles":
      return (
        await db
          .select({ id: workspaceUserHandles.id })
          .from(workspaceUserHandles)
      ).map(r => r.id.toLowerCase());
    case "github_installations":
      return (
        await db
          .select({ id: githubInstallations.id })
          .from(githubInstallations)
      ).map(r => r.id.toLowerCase());
    case "mcp_oauth_clients":
      return (
        await db.select({ id: mcpOAuthClients.id }).from(mcpOAuthClients)
      ).map(r => r.id.toLowerCase());
    case "mcp_oauth_codes":
      return (
        await db.select({ id: mcpOAuthCodes.id }).from(mcpOAuthCodes)
      ).map(r => r.id.toLowerCase());
    case "mcp_oauth_tokens":
      return (
        await db.select({ id: mcpOAuthTokens.id }).from(mcpOAuthTokens)
      ).map(r => r.id.toLowerCase());
    case "acp_plan_grants":
      return (
        await db.select({ id: acpPlanGrants.id }).from(acpPlanGrants)
      ).map(r => r.id.toLowerCase());
  }
}

async function repairSingleRecord(
  table: WorkspacesTableName,
  pgEntityId: string,
  db: MakoPgDb,
): Promise<boolean> {
  if (!isUuidString(pgEntityId)) {
    return false;
  }
  const wireId = toWireId(pgEntityId);
  if (table === "mcp_oauth_clients") {
    const doc = isObjectIdHex(wireId)
      ? await McpOAuthClient.findById(
          new Types.ObjectId(wireId),
        ).lean<MongoMcpClientLike | null>()
      : null;
    if (!doc?.clientId) {
      const deleted = await db
        .delete(mcpOAuthClients)
        .where(eq(mcpOAuthClients.id, pgEntityId.toLowerCase()))
        .returning({ id: mcpOAuthClients.id });
      return deleted.length > 0;
    }
    const res = await resyncToPg(
      "mcp_oauth_clients",
      { entityIds: [doc.clientId] },
      { getDb: () => db, tombstones: false },
    );
    return res.upserted > 0 || res.deleted > 0;
  }
  if (!isObjectIdHex(wireId)) {
    return false;
  }
  if (table === "workspaces") {
    // Unconditional overwrite for --repair (bypasses stale-timestamp guard when repairing drift).
    const doc = await Workspace.findById(
      new Types.ObjectId(wireId),
    ).lean<MongoWorkspaceLike | null>();
    if (!doc) {
      const deleted = await db
        .delete(workspaces)
        .where(eq(workspaces.id, pgEntityId.toLowerCase()))
        .returning({ id: workspaces.id });
      return deleted.length > 0;
    }
    const record = mongoWorkspaceToRecord(doc);
    const userMap = await resolvePgUserUuidMap(db, [record.createdBy]);
    const row = workspaceRecordToPgRow(record, u =>
      u ? (userMap.get(u) ?? userMap.get(u.toLowerCase()) ?? null) : null,
    );
    const { id: _id, ...rest } = row;
    void _id;
    await db
      .insert(workspaces)
      .values(row)
      .onConflictDoUpdate({ target: workspaces.id, set: rest });
    return true;
  }
  const res = await resyncToPg(
    table,
    { entityIds: [toWire(wireId)] },
    { getDb: () => db, tombstones: false },
  );
  return res.upserted > 0 || res.deleted > 0;
}

export function createWorkspacesVerifierHandler(): VerifierDomainHandler {
  return {
    domain: WORKSPACES_DOMAIN,
    targetTable: "workspaces",
    compareOptions: WORKSPACES_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, db }) {
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<WorkspacesBackfillDoc>> = [];

      for (const meta of WORKSPACES_STAGES) {
        if (meta.stage < startStage) {
          continue;
        }
        const remaining = limit - items.length;
        if (remaining <= 0) {
          break;
        }
        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.subCursor : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          true,
        );
        items.push(...batch);
      }

      // Use the injected `db` (never `getPgDb()`) so `pg:verify` works with POSTGRES_DIRECT_URL or test PGlite.
      const userMap = await resolvePgUserUuidMap(
        db,
        collectBatchUserIds(items),
      );
      return items.map(item => buildVerifierRecord(item, userMap, true));
    },
    async fetchPgByIds(entityIds, db) {
      const byTable = new Map<WorkspacesTableName, string[]>();
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) {
          continue;
        }
        const list = byTable.get(decoded.table);
        if (list) {
          list.push(decoded.pgEntityId);
        } else {
          byTable.set(decoded.table, [decoded.pgEntityId]);
        }
      }

      const out = new Map<string, unknown>();
      await Promise.all(
        [...byTable.entries()].map(async ([table, ids]) => {
          const tableMap = await fetchPgRecordsForTable(table, ids, db);
          for (const [id, rec] of tableMap) {
            out.set(encodeVerifierKey(table, id), rec);
          }
        }),
      );
      return out;
    },
    async findExtraPgIds({ seenEntityIds, db }) {
      const extras: string[] = [];
      for (const meta of WORKSPACES_STAGES) {
        const ids = await listAllPgIdsForTable(meta.table, db);
        for (const id of ids) {
          const key = encodeVerifierKey(meta.table, id);
          if (!seenEntityIds.has(key)) {
            extras.push(key);
          }
        }
      }
      return extras;
    },
    async repair({ entityIds, db }) {
      const parsed = entityIds
        .map(decodeVerifierKey)
        .filter((v): v is NonNullable<typeof v> => v !== null);
      parsed.sort(
        (a, b) =>
          (STAGE_ORDER_BY_TABLE.get(a.table) ?? 99) -
          (STAGE_ORDER_BY_TABLE.get(b.table) ?? 99),
      );
      let repaired = 0;
      for (const entry of parsed) {
        if (await repairSingleRecord(entry.table, entry.pgEntityId, db)) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

export function createWorkspacesTableVerifierHandler(
  meta: WorkspacesStageMeta,
): VerifierDomainHandler {
  return {
    domain: `${WORKSPACES_DOMAIN}:${meta.table}`,
    targetTable: meta.table,
    compareOptions: WORKSPACES_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, db }) {
      const items = await fetchStageBackfillItems(
        meta,
        afterCursor,
        limit,
        false,
      );
      const userMap = await resolvePgUserUuidMap(
        db,
        collectBatchUserIds(items),
      );
      return items.map(item => buildVerifierRecord(item, userMap, false));
    },
    fetchPgByIds(entityIds, db) {
      return fetchPgRecordsForTable(meta.table, entityIds, db);
    },
    async findExtraPgIds({ seenEntityIds, db }) {
      const ids = await listAllPgIdsForTable(meta.table, db);
      return ids.filter(id => !seenEntityIds.has(id));
    },
    async repair({ entityIds, db }) {
      let repaired = 0;
      for (const id of entityIds) {
        if (await repairSingleRecord(meta.table, id, db)) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

/**
 * Register all Phase 1B (`workspaces_core` + `github_installations`) backfill
 * handlers, parity verifiers, bidirectional Inngest sync-retry handlers, and
 * Postgres TTL reaper rules. Idempotent.
 */
export function registerWorkspacesMigrationDomain(): void {
  registerBackfillDomain(createWorkspacesBackfillHandler());
  registerVerifierDomain(createWorkspacesVerifierHandler());

  for (const meta of WORKSPACES_STAGES) {
    registerBackfillDomain(createWorkspacesTableBackfillHandler(meta));
    registerVerifierDomain(createWorkspacesTableVerifierHandler(meta));
  }

  registerSyncRetryHandler("pg", WORKSPACES_DOMAIN, data =>
    replayWorkspacesRetry(data),
  );
  registerSyncRetryHandler("mongo", WORKSPACES_DOMAIN, data =>
    replayWorkspacesRetry(data),
  );

  // Postgres TTL reaper rules matching Mongo TTL indexes:
  // `mcp_oauth_tokens.refresh_expires_at` skips NULL (non-expiring grants).
  registerTtlRule({
    tableName: "workspace_invites",
    timestampColumn: "expires_at",
  });
  registerTtlRule({
    tableName: "mcp_oauth_codes",
    timestampColumn: "expires_at",
  });
  registerTtlRule({
    tableName: "mcp_oauth_tokens",
    timestampColumn: "refresh_expires_at",
  });
  registerTtlRule({
    tableName: "acp_plan_grants",
    timestampColumn: "expires_at",
  });
}
