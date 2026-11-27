/**
 * Phase 3 (Part 1 — `mcp` domain) migration handlers:
 *   - FK-ordered resumable MongoDB -> Postgres backfill:
 *       1. `mcp_servers`
 *       2. `mcp_connection_configs` (FK -> mcp_servers, nullable user_id)
 *       3. `mcp_tool_grants`        (FK -> mcp_servers, user_id NOT NULL)
 *     (`mcp_oauth_flows` is 10m ephemeral and intentionally SKIPPED from backfill/verifier;
 *      Stage 4 uses PG->Mongo read-fallback and hourly TTL reaping.)
 *   - Chunked parity verifier + `--repair` healer with secret redaction on all 4 encrypted fields.
 *   - Inngest dead-letter sync-retry replay handlers (`pg` and `mongo`).
 *   - Hourly Postgres batched TTL reaper rule for `mcp_oauth_flows` (10m).
 */
import { eq, inArray, or, sql } from "drizzle-orm";
import { Types } from "mongoose";
import {
  McpConnectionConfig,
  McpServer,
  McpToolGrant,
} from "../../database/models/mcp";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  parseEntityId,
  uuidToObjectId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  mcpConnectionConfigs,
  mcpServers,
  mcpToolGrants,
} from "../../database/pg/schema/mcp";
import { workspaces } from "../../database/pg/schema/workspaces";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import {
  MCP_DOMAIN,
  MCP_OAUTH_FLOW_TTL_MS,
  MCP_SHADOW_OPTIONS,
  MongoMcpRepository,
  PgMcpRepository,
  mcpConnectionConfigRecordToPgInsert,
  mcpServerRecordToPgInsert,
  mcpToolGrantRecordToPgInsert,
  mongoMcpConnectionConfigToRecord,
  mongoMcpServerToRecord,
  mongoMcpToolGrantToRecord,
  normalizeConfigUserId,
  pgMcpConnectionConfigToRecord,
  pgMcpServerToRecord,
  pgMcpToolGrantToRecord,
  type McpConnectionConfigRecord,
  type McpServerRecord,
  type McpToolGrantRecord,
  type MongoMcpConnectionConfigLike,
  type MongoMcpServerLike,
  type MongoMcpToolGrantLike,
} from "../../repositories/mcp";
import {
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import {
  buildExcludedSet,
  chunkRows,
  dedupByKey,
  groupContiguous,
  pickNewerByUpdatedAt,
  prefetchExistingKeySet,
  prefetchPgUserUuidMap,
} from "../bulk-helpers";
import { recordMigrationTombstone } from "../router";
import { registerTtlRule } from "../ttl-reaper";
import type { SyncRetryEventData } from "../types";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

export type McpMigratedTableName =
  "mcp_servers" | "mcp_connection_configs" | "mcp_tool_grants";

interface McpStageMeta {
  stage: number;
  table: McpMigratedTableName;
  collection: string;
}

const MCP_STAGES: readonly McpStageMeta[] = [
  { stage: 1, table: "mcp_servers", collection: "mcp_servers" },
  {
    stage: 2,
    table: "mcp_connection_configs",
    collection: "mcp_connection_configs",
  },
  { stage: 3, table: "mcp_tool_grants", collection: "mcp_tool_grants" },
] as const;

type McpBackfillDoc =
  | {
      table: "mcp_servers";
      record: McpServerRecord;
      resolvedCreatedByUuid?: string | null;
    }
  | {
      table: "mcp_connection_configs";
      record: McpConnectionConfigRecord;
      resolvedUserUuid?: string | null;
    }
  | {
      table: "mcp_tool_grants";
      record: McpToolGrantRecord;
      resolvedUserUuid?: string;
    };

function encodeCompositeCursor(
  stage: number,
  table: McpMigratedTableName,
  mongoId: string,
): string {
  return `${stage}:${table}:${mongoId}`;
}

function decodeCompositeCursor(
  cursor: string | null,
): { stage: number; table: McpMigratedTableName; mongoId: string } | null {
  if (!cursor) return null;
  const match = /^([1-3]):([a-z_]+):([0-9a-fA-F]{24})$/.exec(cursor);
  if (!match) return null;
  return {
    stage: Number(match[1]),
    table: match[2] as McpMigratedTableName,
    mongoId: match[3].toLowerCase(),
  };
}

function encodeVerifierKey(
  table: McpMigratedTableName,
  pgUuid: string,
): string {
  return `${table}:${pgUuid}`;
}

function decodeVerifierKey(
  key: string,
): { table: McpMigratedTableName; pgUuid: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return {
    table: key.slice(0, idx) as McpMigratedTableName,
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
  meta: McpStageMeta,
  afterId: string | null,
  limit: number,
  workspaceId: string | null,
  composite: boolean,
): Promise<Array<BackfillItem<McpBackfillDoc>>> {
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
    case "mcp_servers": {
      const docs = await McpServer.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoMcpServerLike[]>();
      return docs.map(doc => {
        const record = mongoMcpServerToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: objectIdToUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "mcp_servers",
          collectionName: meta.collection,
          doc: { table: "mcp_servers", record },
        };
      });
    }

    case "mcp_connection_configs": {
      const docs = await McpConnectionConfig.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoMcpConnectionConfigLike[]>();
      return docs.map(doc => {
        const record = mongoMcpConnectionConfigToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: objectIdToUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "mcp_connection_configs",
          collectionName: meta.collection,
          doc: { table: "mcp_connection_configs", record },
        };
      });
    }

    case "mcp_tool_grants": {
      const docs = await McpToolGrant.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoMcpToolGrantLike[]>();
      return docs.map(doc => {
        const record = mongoMcpToolGrantToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: objectIdToUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "mcp_tool_grants",
          collectionName: meta.collection,
          doc: { table: "mcp_tool_grants", record },
        };
      });
    }
  }
}

interface McpBatchValidationContext {
  serverUuids: Set<string>;
  workspaceUuids: Set<string>;
  userMap: Map<string, string>;
  prepared: boolean;
}

function createMcpBatchValidationContext(): McpBatchValidationContext {
  return {
    serverUuids: new Set<string>(),
    workspaceUuids: new Set<string>(),
    userMap: new Map<string, string>(),
    prepared: false,
  };
}

function clearMcpBatchValidationContext(ctx: McpBatchValidationContext): void {
  ctx.serverUuids.clear();
  ctx.workspaceUuids.clear();
  ctx.userMap.clear();
  ctx.prepared = false;
}

async function prepareMcpBatch(
  items: ReadonlyArray<BackfillItem<McpBackfillDoc>>,
  db: MakoPgDb,
  ctx: McpBatchValidationContext,
): Promise<void> {
  const wsUuids: string[] = [];
  const serverUuids: string[] = [];
  const rawUserIds: Array<string | null | undefined> = [];

  for (const { doc } of items) {
    const wsUuid = parseEntityId(doc.record.workspaceId)?.uuid;
    if (wsUuid) wsUuids.push(wsUuid);
    if (doc.table === "mcp_servers") {
      rawUserIds.push(doc.record.createdBy);
    } else {
      const serverUuid = parseEntityId(doc.record.serverId)?.uuid;
      if (serverUuid) serverUuids.push(serverUuid);
      rawUserIds.push(doc.record.userId);
    }
  }

  const [foundWs, foundServers, resolvedUsers] = await Promise.all([
    prefetchExistingKeySet(db, workspaces, workspaces.id, wsUuids),
    prefetchExistingKeySet(db, mcpServers, mcpServers.id, serverUuids),
    prefetchPgUserUuidMap(db, rawUserIds),
  ]);

  for (const id of foundWs) ctx.workspaceUuids.add(id);
  for (const id of foundServers) ctx.serverUuids.add(id);
  for (const [k, v] of resolvedUsers) ctx.userMap.set(k, v);
  ctx.prepared = true;
}

async function resolveMcpBatchUserUuid(
  db: MakoPgDb,
  userId: string | null,
  ctx: McpBatchValidationContext,
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

async function validateMcpBackfillItem(
  item: BackfillItem<McpBackfillDoc>,
  db: MakoPgDb,
  ctx: McpBatchValidationContext,
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
    case "mcp_servers": {
      if (!doc.record.name || doc.record.name.length > 100) {
        return {
          ok: false,
          reason: "invalid_server_name",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      doc.resolvedCreatedByUuid = await resolveMcpBatchUserUuid(
        db,
        doc.record.createdBy,
        ctx,
      );
      ctx.serverUuids.add(objectIdToUuid(doc.record.id));
      return { ok: true };
    }

    case "mcp_connection_configs": {
      const serverUuid = parseEntityId(doc.record.serverId)?.uuid;
      if (!serverUuid) {
        return {
          ok: false,
          reason: "invalid_server_id",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      if (!ctx.serverUuids.has(serverUuid)) {
        if (ctx.prepared) {
          return {
            ok: false,
            reason: "orphaned_server_missing",
            sanitizedPayload: {
              table: doc.table,
              id: doc.record.id,
              serverId: doc.record.serverId,
            },
          };
        }
        const sRows = await db
          .select({ id: mcpServers.id })
          .from(mcpServers)
          .where(eq(mcpServers.id, serverUuid))
          .limit(1);
        if (!sRows[0]) {
          return {
            ok: false,
            reason: "orphaned_server_missing",
            sanitizedPayload: {
              table: doc.table,
              id: doc.record.id,
              serverId: doc.record.serverId,
            },
          };
        }
        ctx.serverUuids.add(serverUuid);
      }
      if (doc.record.userId !== null) {
        const userUuid = await resolveMcpBatchUserUuid(
          db,
          doc.record.userId,
          ctx,
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
      } else {
        doc.resolvedUserUuid = null;
      }
      return { ok: true };
    }

    case "mcp_tool_grants": {
      const serverUuid = parseEntityId(doc.record.serverId)?.uuid;
      if (!serverUuid) {
        return {
          ok: false,
          reason: "invalid_server_id",
          sanitizedPayload: { id: doc.record.id },
        };
      }
      if (!ctx.serverUuids.has(serverUuid)) {
        if (ctx.prepared) {
          return {
            ok: false,
            reason: "orphaned_server_missing",
            sanitizedPayload: {
              table: doc.table,
              id: doc.record.id,
              serverId: doc.record.serverId,
            },
          };
        }
        const sRows = await db
          .select({ id: mcpServers.id })
          .from(mcpServers)
          .where(eq(mcpServers.id, serverUuid))
          .limit(1);
        if (!sRows[0]) {
          return {
            ok: false,
            reason: "orphaned_server_missing",
            sanitizedPayload: {
              table: doc.table,
              id: doc.record.id,
              serverId: doc.record.serverId,
            },
          };
        }
        ctx.serverUuids.add(serverUuid);
      }
      const userUuid = await resolveMcpBatchUserUuid(
        db,
        doc.record.userId,
        ctx,
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

async function upsertMcpBackfillItems(
  items: Array<BackfillItem<McpBackfillDoc>>,
  db: MakoPgDb,
): Promise<number> {
  let upserted = 0;

  for (const group of groupContiguous(items, item => item.doc.table)) {
    switch (group.key) {
      case "mcp_servers": {
        const rows = dedupByKey(
          group.items
            .map(item => {
              const d = item.doc as Extract<
                McpBackfillDoc,
                { table: "mcp_servers" }
              >;
              const idUuid = parseEntityId(d.record.id)?.uuid;
              const wsUuid = parseEntityId(d.record.workspaceId)?.uuid;
              if (!idUuid || !wsUuid) return null;
              return mcpServerRecordToPgInsert(d.record, {
                idUuid,
                workspaceUuid: wsUuid,
                createdByUuid: d.resolvedCreatedByUuid ?? null,
              });
            })
            .filter((r): r is typeof mcpServers.$inferInsert => r !== null),
          r => r.id.toLowerCase(),
          pickNewerByUpdatedAt,
        );
        const setCols = buildExcludedSet(mcpServers, [
          "id",
          "workspaceId",
          "createdAt",
        ]);
        for (const sub of chunkRows(rows, 21, 200)) {
          const written = await db
            .insert(mcpServers)
            .values(sub)
            .onConflictDoUpdate({
              target: mcpServers.id,
              set: setCols,
              setWhere: sql`${mcpServers.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${mcpServers.updatedAt}`,
            })
            .returning({ id: mcpServers.id });
          upserted += written.length;
        }
        break;
      }

      case "mcp_connection_configs": {
        const rows = dedupByKey(
          group.items
            .map(item => {
              const d = item.doc as Extract<
                McpBackfillDoc,
                { table: "mcp_connection_configs" }
              >;
              const idUuid = parseEntityId(d.record.id)?.uuid;
              const wsUuid = parseEntityId(d.record.workspaceId)?.uuid;
              const serverUuid = parseEntityId(d.record.serverId)?.uuid;
              if (!idUuid || !wsUuid || !serverUuid) return null;
              return mcpConnectionConfigRecordToPgInsert(d.record, {
                idUuid,
                workspaceUuid: wsUuid,
                serverUuid,
                userUuid: d.resolvedUserUuid ?? null,
              });
            })
            .filter(
              (r): r is typeof mcpConnectionConfigs.$inferInsert => r !== null,
            ),
          r =>
            `${r.serverId.toLowerCase()}\0${r.userId ? r.userId.toLowerCase() : "__NULL__"}`,
          pickNewerByUpdatedAt,
        );
        for (const sub of chunkRows(rows, 9, 250)) {
          const written = await db
            .insert(mcpConnectionConfigs)
            .values(sub)
            .onConflictDoUpdate({
              target: [
                mcpConnectionConfigs.serverId,
                mcpConnectionConfigs.userId,
              ],
              set: {
                headersEncrypted: sql`EXCLUDED."headers_encrypted"`,
                oauthTokensEncrypted: sql`EXCLUDED."oauth_tokens_encrypted"`,
                oauthExpiresAt: sql`EXCLUDED."oauth_expires_at"`,
                updatedAt: sql`EXCLUDED."updated_at"`,
              },
              setWhere: sql`${mcpConnectionConfigs.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${mcpConnectionConfigs.updatedAt}`,
            })
            .returning({ id: mcpConnectionConfigs.id });
          upserted += written.length;
        }
        break;
      }

      case "mcp_tool_grants": {
        const rows = dedupByKey(
          group.items
            .map(item => {
              const d = item.doc as Extract<
                McpBackfillDoc,
                { table: "mcp_tool_grants" }
              >;
              if (!d.resolvedUserUuid) return null;
              const idUuid = parseEntityId(d.record.id)?.uuid;
              const wsUuid = parseEntityId(d.record.workspaceId)?.uuid;
              const serverUuid = parseEntityId(d.record.serverId)?.uuid;
              if (!idUuid || !wsUuid || !serverUuid) return null;
              return mcpToolGrantRecordToPgInsert(d.record, {
                idUuid,
                workspaceUuid: wsUuid,
                serverUuid,
                userUuid: d.resolvedUserUuid,
              });
            })
            .filter((r): r is typeof mcpToolGrants.$inferInsert => r !== null),
          r =>
            `${r.serverId.toLowerCase()}\0${r.userId.toLowerCase()}\0${r.toolName}`,
          pickNewerByUpdatedAt,
        );
        for (const sub of chunkRows(rows, 8, 300)) {
          const written = await db
            .insert(mcpToolGrants)
            .values(sub)
            .onConflictDoUpdate({
              target: [
                mcpToolGrants.serverId,
                mcpToolGrants.userId,
                mcpToolGrants.toolName,
              ],
              set: {
                decision: sql`EXCLUDED."decision"`,
                lastUsedAt: sql`EXCLUDED."last_used_at"`,
                updatedAt: sql`EXCLUDED."updated_at"`,
              },
              setWhere: sql`${mcpToolGrants.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${mcpToolGrants.updatedAt}`,
            })
            .returning({ id: mcpToolGrants.id });
          upserted += written.length;
        }
        break;
      }
    }
  }

  return upserted;
}

export function createMcpBackfillHandler(): BackfillDomainHandler<McpBackfillDoc> {
  const batchCtx = createMcpBatchValidationContext();

  return {
    domain: MCP_DOMAIN,
    collectionName: "mcp_servers",
    targetTable: "mcp_servers",
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      clearMcpBatchValidationContext(batchCtx);
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<McpBackfillDoc>> = [];

      for (const meta of MCP_STAGES) {
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
      return prepareMcpBatch(items, db, batchCtx);
    },
    validate(item, db) {
      return validateMcpBackfillItem(item, db, batchCtx);
    },
    upsertBatch(items, db) {
      return upsertMcpBackfillItems(items, db);
    },
  };
}

export function createMcpTableBackfillHandler(
  meta: McpStageMeta,
): BackfillDomainHandler<McpBackfillDoc> {
  const batchCtx = createMcpBatchValidationContext();

  return {
    domain: `${MCP_DOMAIN}:${meta.table}`,
    collectionName: meta.collection,
    targetTable: meta.table,
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      clearMcpBatchValidationContext(batchCtx);
      return fetchStageBackfillItems(
        meta,
        afterCursor,
        limit,
        workspaceId,
        false,
      );
    },
    prepareBatch(items, db) {
      return prepareMcpBatch(items, db, batchCtx);
    },
    validate(item, db) {
      return validateMcpBackfillItem(item, db, batchCtx);
    },
    upsertBatch(items, db) {
      return upsertMcpBackfillItems(items, db);
    },
  };
}

// ── Parity verifier (+ --repair) ────────────────────────────────────────────

async function fetchPgRecordsForTable(
  table: McpMigratedTableName,
  uuids: string[],
  db: MakoPgDb,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const valid = uuids.filter(isUuidString).map(u => u.toLowerCase());
  if (valid.length === 0) return out;

  switch (table) {
    case "mcp_servers": {
      const rows = await db
        .select()
        .from(mcpServers)
        .where(inArray(mcpServers.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgMcpServerToRecord(row));
      }
      return out;
    }

    case "mcp_connection_configs": {
      const rows = await db
        .select()
        .from(mcpConnectionConfigs)
        .where(inArray(mcpConnectionConfigs.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgMcpConnectionConfigToRecord(row));
      }
      return out;
    }

    case "mcp_tool_grants": {
      const rows = await db
        .select()
        .from(mcpToolGrants)
        .where(inArray(mcpToolGrants.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgMcpToolGrantToRecord(row));
      }
      return out;
    }
  }
}

async function listAllPgIdsForTable(
  table: McpMigratedTableName,
  workspaceId: string | null,
  db: MakoPgDb,
): Promise<string[]> {
  const wsUuid = workspaceId
    ? (parseEntityId(workspaceId)?.uuid ?? null)
    : null;
  switch (table) {
    case "mcp_servers": {
      const rows = wsUuid
        ? await db
            .select({ id: mcpServers.id })
            .from(mcpServers)
            .where(eq(mcpServers.workspaceId, wsUuid))
        : await db.select({ id: mcpServers.id }).from(mcpServers);
      return rows.map(r => r.id.toLowerCase());
    }
    case "mcp_connection_configs": {
      const rows = wsUuid
        ? await db
            .select({ id: mcpConnectionConfigs.id })
            .from(mcpConnectionConfigs)
            .where(eq(mcpConnectionConfigs.workspaceId, wsUuid))
        : await db
            .select({ id: mcpConnectionConfigs.id })
            .from(mcpConnectionConfigs);
      return rows.map(r => r.id.toLowerCase());
    }
    case "mcp_tool_grants": {
      const rows = wsUuid
        ? await db
            .select({ id: mcpToolGrants.id })
            .from(mcpToolGrants)
            .where(eq(mcpToolGrants.workspaceId, wsUuid))
        : await db.select({ id: mcpToolGrants.id }).from(mcpToolGrants);
      return rows.map(r => r.id.toLowerCase());
    }
  }
}

function buildVerifierRecord(
  item: BackfillItem<McpBackfillDoc>,
  userMap: Map<string, string>,
  composite: boolean,
): VerifierMongoRecord {
  const { doc } = item;
  let record: unknown;

  switch (doc.table) {
    case "mcp_servers": {
      const resolvedCreatedBy = doc.record.createdBy
        ? (userMap.get(doc.record.createdBy) ?? null)
        : null;
      record = { ...doc.record, createdBy: resolvedCreatedBy };
      break;
    }
    case "mcp_connection_configs": {
      const resolvedUser = doc.record.userId
        ? (userMap.get(doc.record.userId) ?? doc.record.userId)
        : null;
      record = { ...doc.record, userId: resolvedUser };
      break;
    }
    case "mcp_tool_grants": {
      const resolvedUser = userMap.get(doc.record.userId) ?? doc.record.userId;
      record = { ...doc.record, userId: resolvedUser };
      break;
    }
  }

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

async function repairMcpEntity(
  table: McpMigratedTableName,
  pgUuid: string,
  db: MakoPgDb,
  pgRepo: PgMcpRepository,
): Promise<boolean> {
  const oid = uuidToObjectId(pgUuid);
  switch (table) {
    case "mcp_servers": {
      const doc = await McpServer.findById(
        oid,
      ).lean<MongoMcpServerLike | null>();
      if (!doc) return false;
      const record = mongoMcpServerToRecord(doc);
      const createdByUuid = await resolveUserUuid(db, record.createdBy);
      return pgRepo.upsertServerWithGuard(record, createdByUuid, db);
    }
    case "mcp_connection_configs": {
      const doc = await McpConnectionConfig.findById(
        oid,
      ).lean<MongoMcpConnectionConfigLike | null>();
      if (!doc) return false;
      const record = mongoMcpConnectionConfigToRecord(doc);
      const userUuid =
        record.userId === null
          ? null
          : await resolveUserUuid(db, record.userId);
      if (record.userId !== null && !userUuid) return false;
      return pgRepo.upsertConnectionConfigWithGuard(record, userUuid, db);
    }
    case "mcp_tool_grants": {
      const doc = await McpToolGrant.findById(
        oid,
      ).lean<MongoMcpToolGrantLike | null>();
      if (!doc) return false;
      const record = mongoMcpToolGrantToRecord(doc);
      const userUuid = await resolveUserUuid(db, record.userId);
      if (!userUuid) return false;
      return pgRepo.upsertToolGrantWithGuard(record, userUuid, db);
    }
  }
}

export function createMcpVerifierHandler(): VerifierDomainHandler {
  const pgRepo = new PgMcpRepository();

  return {
    domain: MCP_DOMAIN,
    targetTable: "mcp_servers",
    compareOptions: MCP_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const rawItems: Array<BackfillItem<McpBackfillDoc>> = [];

      for (const meta of MCP_STAGES) {
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

      const userIds: Array<string | null> = [];
      for (const item of rawItems) {
        if (item.doc.table === "mcp_servers") {
          userIds.push(item.doc.record.createdBy);
        } else {
          userIds.push(item.doc.record.userId);
        }
      }
      const userMap = await resolveUserUuidsBatch(db, userIds);
      return rawItems.map(item => buildVerifierRecord(item, userMap, true));
    },

    async fetchPgByIds(entityIds, db) {
      const byTable = new Map<McpMigratedTableName, string[]>();
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) continue;
        const list = byTable.get(decoded.table);
        if (list) list.push(decoded.pgUuid);
        else byTable.set(decoded.table, [decoded.pgUuid]);
      }

      const out = new Map<string, unknown>();
      for (const [table, ids] of byTable) {
        const sub = await fetchPgRecordsForTable(table, ids, db);
        for (const [pgUuid, record] of sub) {
          out.set(encodeVerifierKey(table, pgUuid), record);
        }
      }
      return out;
    },

    async findExtraPgIds({ workspaceId, seenEntityIds, db }) {
      const extras: string[] = [];
      for (const meta of MCP_STAGES) {
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
        if (await repairMcpEntity(decoded.table, decoded.pgUuid, db, pgRepo)) {
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

async function replayMcpWriteToPg(data: SyncRetryEventData): Promise<void> {
  const db = getPgDb();
  const pgRepo = new PgMcpRepository({ getDb: () => db });
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  const entity = payload.entity as McpMigratedTableName | undefined;
  const action = payload.action as string | undefined;

  if (entity === "mcp_servers") {
    const serverId = String(payload.serverId ?? data.entityId);
    const serverOid = parseEntityId(serverId)?.oid;
    const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
    if (action === "delete") {
      if (
        serverOid &&
        (await McpServer.exists({ _id: new Types.ObjectId(serverOid) }))
      ) {
        return;
      }
      await pgRepo.deleteServerCascade(workspaceId, serverId, db);
      const uuid = parseEntityId(serverId)?.uuid;
      if (uuid) {
        await recordMigrationTombstone("mcp_servers", uuid, db);
      }
      return;
    }
    if (!serverOid) return;
    const doc = await McpServer.findById(
      serverOid,
    ).lean<MongoMcpServerLike | null>();
    if (!doc) return;
    const record = mongoMcpServerToRecord(doc);
    const createdByUuid = await resolveUserUuid(db, record.createdBy);
    await pgRepo.upsertServerWithGuard(record, createdByUuid, db);
    return;
  }

  if (entity === "mcp_connection_configs") {
    const serverId = String(payload.serverId ?? data.entityId);
    const serverOid = parseEntityId(serverId)?.oid;
    const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
    if (action === "clear_oauth_tokens") {
      const updatedAt =
        typeof payload.updatedAt === "string"
          ? new Date(payload.updatedAt)
          : undefined;
      await pgRepo.clearServerOAuthTokens(workspaceId, serverId, updatedAt, db);
      return;
    }
    if (!serverOid) return;
    const rawUserId = normalizeConfigUserId(
      payload.userId as string | null | undefined,
    );
    const mongoUserId =
      rawUserId === null
        ? ""
        : ((await resolveMongoUserIdForReverseSync(db, rawUserId)) ??
          rawUserId);
    const doc = await McpConnectionConfig.findOne({
      serverId: new Types.ObjectId(serverOid),
      userId: mongoUserId,
    }).lean<MongoMcpConnectionConfigLike | null>();
    if (!doc) return;
    const record = mongoMcpConnectionConfigToRecord(doc);
    const userUuid =
      record.userId === null ? null : await resolveUserUuid(db, record.userId);
    if (record.userId !== null && !userUuid) return;
    await pgRepo.upsertConnectionConfigWithGuard(record, userUuid, db);
    return;
  }

  if (entity === "mcp_tool_grants") {
    const grantId = String(payload.grantId ?? data.entityId);
    const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
    const serverId = String(payload.serverId ?? "");
    const serverOid = parseEntityId(serverId)?.oid;
    if (action === "delete") {
      const grantOid = parseEntityId(grantId)?.oid;
      if (
        grantOid &&
        (await McpToolGrant.exists({ _id: new Types.ObjectId(grantOid) }))
      ) {
        return;
      }
      const userId = String(payload.userId ?? "");
      await pgRepo.deleteToolGrantById(
        workspaceId,
        serverId,
        grantId,
        userId,
        db,
      );
      const uuid = parseEntityId(grantId)?.uuid;
      if (uuid) {
        await recordMigrationTombstone("mcp_tool_grants", uuid, db);
      }
      return;
    }

    const toolName =
      typeof payload.toolName === "string" ? payload.toolName : null;
    const rawUserId =
      typeof payload.userId === "string" ? payload.userId : null;
    let doc: MongoMcpToolGrantLike | null = null;
    if (toolName && serverOid && rawUserId) {
      const mongoUserId =
        (await resolveMongoUserIdForReverseSync(db, rawUserId)) ?? rawUserId;
      doc = await McpToolGrant.findOne({
        serverId: new Types.ObjectId(serverOid),
        userId: mongoUserId,
        toolName,
      }).lean<MongoMcpToolGrantLike | null>();
    } else {
      const grantOid = parseEntityId(grantId)?.oid;
      if (grantOid) {
        doc = await McpToolGrant.findById(
          grantOid,
        ).lean<MongoMcpToolGrantLike | null>();
      }
    }
    if (!doc) return;
    const record = mongoMcpToolGrantToRecord(doc);
    const userUuid = await resolveUserUuid(db, record.userId);
    if (!userUuid) return;
    await pgRepo.upsertToolGrantWithGuard(record, userUuid, db);
  }
}

async function replayMcpWriteToMongo(data: SyncRetryEventData): Promise<void> {
  const db = getPgDb();
  const pgRepo = new PgMcpRepository({ getDb: () => db });
  const mongoRepo = new MongoMcpRepository();
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  const entity = payload.entity as McpMigratedTableName | undefined;
  const action = payload.action as string | undefined;

  if (entity === "mcp_servers") {
    const serverId = String(payload.serverId ?? data.entityId);
    const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
    if (action === "delete") {
      await mongoRepo.deleteServerCascade(workspaceId, serverId);
      return;
    }
    const pgRecord = await pgRepo.findServerById(
      serverId,
      workspaceId || undefined,
      db,
    );
    if (!pgRecord) return;
    const mongoCreatedBy = await resolveMongoUserIdForReverseSync(
      db,
      pgRecord.createdBy,
    );
    await mongoRepo.upsertFullServer({
      ...pgRecord,
      createdBy: mongoCreatedBy,
    });
    return;
  }

  if (entity === "mcp_connection_configs") {
    const serverId = String(payload.serverId ?? data.entityId);
    const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
    if (action === "clear_oauth_tokens") {
      const updatedAt =
        typeof payload.updatedAt === "string"
          ? new Date(payload.updatedAt)
          : undefined;
      await mongoRepo.clearServerOAuthTokens(workspaceId, serverId, updatedAt);
      return;
    }
    const rawUserId = normalizeConfigUserId(
      payload.userId as string | null | undefined,
    );
    const pgRecord = await pgRepo.findConnectionConfig(
      workspaceId,
      serverId,
      rawUserId,
      db,
    );
    if (!pgRecord) return;
    const mongoUserId = await resolveMongoUserIdForReverseSync(
      db,
      pgRecord.userId,
    );
    await mongoRepo.upsertFullConnectionConfig({
      ...pgRecord,
      userId: mongoUserId,
    });
    return;
  }

  if (entity === "mcp_tool_grants") {
    const grantId = String(payload.grantId ?? data.entityId);
    const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");
    const serverId = String(payload.serverId ?? "");
    const userId = String(payload.userId ?? "");
    if (action === "delete") {
      const mongoUserId =
        (await resolveMongoUserIdForReverseSync(db, userId)) ?? userId;
      await mongoRepo.deleteToolGrantById(
        workspaceId,
        serverId,
        grantId,
        mongoUserId,
      );
      return;
    }
    const grants = await pgRepo.listToolGrantsForUser(
      workspaceId,
      serverId,
      userId,
      db,
    );
    const toolName =
      typeof payload.toolName === "string" ? payload.toolName : null;
    const found = toolName
      ? grants.find(g => g.toolName === toolName)
      : grants.find(g => g.id === grantId);
    if (found) {
      const mongoUserId =
        (await resolveMongoUserIdForReverseSync(db, found.userId)) ??
        found.userId;
      await mongoRepo.upsertFullToolGrant({
        ...found,
        userId: mongoUserId,
      });
    }
  }
}

export function registerMcpMigrationDomain(): void {
  registerBackfillDomain(createMcpBackfillHandler());
  for (const meta of MCP_STAGES) {
    registerBackfillDomain(createMcpTableBackfillHandler(meta));
  }
  registerVerifierDomain(createMcpVerifierHandler());
  registerSyncRetryHandler("pg", MCP_DOMAIN, replayMcpWriteToPg);
  registerSyncRetryHandler("mongo", MCP_DOMAIN, replayMcpWriteToMongo);
  registerTtlRule({
    tableName: "mcp_oauth_flows",
    timestampColumn: "created_at",
    olderThanMs: MCP_OAUTH_FLOW_TTL_MS,
  });
}
