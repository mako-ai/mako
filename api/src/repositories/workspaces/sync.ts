/**
 * Resync engine for the 10-table Phase 1B `workspaces_core` + `github_installations` domain.
 *
 * ONE primitive powers dual-write secondaries, Inngest sync-retry replay, and
 * verifier `--repair`: "make the secondary store's rows equal the primary's".
 *
 *   resyncToPg(table, scope)    Mongo is authoritative -> upsert/delete in Postgres
 *   resyncToMongo(table, scope) Postgres is authoritative -> upsert/delete in Mongo
 *
 * Decision #3 user-ID coherence:
 *   - `resyncToPg` batch-resolves Mongo user IDs against PG `users` (`id` / `legacy_id`).
 *     Nullable audit columns (`created_by`, `invited_by`, `workspace_user_handles.user_id`)
 *     map unresolvable/synthetic values (e.g. `"system"`, `"test"`, deleted users) to `NULL`.
 *     `NOT NULL` grant-bearing columns (`workspace_members`, `mcp_oauth_codes`,
 *     `mcp_oauth_tokens`, `acp_plan_grants`) require a resolved PG user UUID (failing
 *     so Inngest `pg-sync-retry` retries after `auth` catches up).
 *   - `resyncToMongo` batch-maps PG `users.id` UUIDs back to `users.legacy_id ?? users.id`
 *     so a Stage 4 -> Stage 2 rollback preserves exact legacy user IDs in Mongo.
 *
 * Stale-overwrite guards:
 *   - Postgres `workspaces` upserts apply only when `workspaces.updated_at <= excluded.updated_at`.
 *   - Mongo `workspaces` resyncs write via raw collection (`timestamps: false`) with
 *     `updatedAt <= record.updatedAt` and preserve `apiKeys[]` (keys sync via targeted ops).
 *   - Rows deleted from Postgres record tombstones in `migration_tombstones` so an in-flight
 *     backfill cannot resurrect them.
 */
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { Types } from "mongoose";
import { AcpPlanGrant } from "../../database/acp-plan-grant-schema";
import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "../../database/mcp-oauth-schema";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import { isUuidString } from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
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
import { recordMigrationTombstone } from "../../migration/router";
import {
  acpGrantRecordToMongoDoc,
  acpGrantRecordToPgRow,
  apiKeyRecordToMongoSubdoc,
  apiKeyRecordToPgRow,
  fallbackApiKeyId,
  githubInstallationRecordToMongoDoc,
  githubInstallationRecordToPgRow,
  handleRecordToMongoDoc,
  handleRecordToPgRow,
  inviteRecordToMongoDoc,
  inviteRecordToPgRow,
  mcpClientRecordToMongoDoc,
  mcpClientRecordToPgRow,
  mcpCodeRecordToMongoDoc,
  mcpCodeRecordToPgRow,
  mcpTokenRecordToMongoDoc,
  mcpTokenRecordToPgRow,
  memberRecordToMongoDoc,
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
  toPgUuid,
  toWire,
  workspaceRecordToMongoSet,
  workspaceRecordToMongoUnset,
  workspaceRecordToPgRow,
  type MongoAcpGrantLike,
  type MongoApiKeyLike,
  type MongoGitHubInstallationLike,
  type MongoHandleLike,
  type MongoInviteLike,
  type MongoMcpClientLike,
  type MongoMcpCodeLike,
  type MongoMcpTokenLike,
  type MongoMemberLike,
  type MongoUserIdMapper,
  type MongoWorkspaceLike,
  type NullableUserUuidMapper,
  type RequiredUserUuidMapper,
} from "./mapper";
import type { WorkspacesTableName } from "./types";

export interface ResyncScope {
  /** Wire ids (24-hex) or natural keys (`clientId` for `mcp_oauth_clients`). */
  entityIds?: readonly string[];
  /** Resync every row of `table` belonging to this workspace (wire id). */
  workspaceId?: string;
}

export interface ResyncResult {
  table: WorkspacesTableName;
  upserted: number;
  deleted: number;
}

export interface ResyncDeps {
  getDb?: () => MakoPgDb;
  /** Record tombstones for rows deleted from Postgres (default true). */
  tombstones?: boolean;
}

function oid(id: string): Types.ObjectId {
  return new Types.ObjectId(toWire(id));
}

function uniq(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(Boolean))];
}

// ── User ID resolution helpers (Decision #3) ─────────────────────────────

/**
 * Batch-resolve Mongo/wire user IDs (15-char Lucia IDs, legacy UUIDv4s, or UUIDv7s)
 * to canonical Postgres `users.id` UUIDs.
 */
export async function resolvePgUserUuidMap(
  db: MakoPgDb,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = uniq(userIds);
  const out = new Map<string, string>();
  if (unique.length === 0) {
    return out;
  }
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
    if (row.legacyId) {
      out.set(row.legacyId, pgId);
    }
  }
  return out;
}

/**
 * Batch-resolve Postgres `users.id` UUIDs back to Mongo `_id` (`legacyId ?? id`)
 * for Stage 4 PG -> Mongo reverse-sync.
 */
export async function resolveMongoUserIdMap(
  db: MakoPgDb,
  pgUserUuids: readonly string[],
): Promise<Map<string, string>> {
  const unique = uniq(pgUserUuids)
    .filter(isUuidString)
    .map(u => u.toLowerCase());
  const out = new Map<string, string>();
  if (unique.length === 0) {
    return out;
  }
  const rows = await db
    .select({ id: users.id, legacyId: users.legacyId })
    .from(users)
    .where(inArray(users.id, unique));
  for (const row of rows) {
    const pgId = row.id.toLowerCase();
    out.set(pgId, row.legacyId ?? pgId);
  }
  return out;
}

function makeNullableUuidMapper(
  map: Map<string, string>,
): NullableUserUuidMapper {
  return userId => {
    if (!userId) {
      return null;
    }
    return map.get(userId) ?? map.get(userId.toLowerCase()) ?? null;
  };
}

function makeRequiredUuidMapper(
  map: Map<string, string>,
): RequiredUserUuidMapper {
  return userId => {
    const resolved = map.get(userId) ?? map.get(userId.toLowerCase());
    if (resolved) {
      return resolved;
    }
    throw new Error(
      `Cannot sync row to Postgres: user ${JSON.stringify(userId)} not found in Postgres users table`,
    );
  };
}

function makeMongoUserMapper(map: Map<string, string>): MongoUserIdMapper {
  return userId => {
    if (!userId) {
      return "";
    }
    return map.get(userId.toLowerCase()) ?? map.get(userId) ?? userId;
  };
}

// ── Mongo readers (authoritative side for resyncToPg) ────────────────────

async function readMongoWorkspaces(
  scope: ResyncScope,
): Promise<MongoWorkspaceLike[]> {
  const ids = uniq([
    ...(scope.entityIds ?? []),
    ...(scope.workspaceId ? [scope.workspaceId] : []),
  ]);
  if (ids.length === 0) {
    return [];
  }
  return Workspace.find({ _id: { $in: ids.map(oid) } }).lean<
    MongoWorkspaceLike[]
  >();
}

interface MongoApiKeyWithWs {
  workspaceId: string;
  key: MongoApiKeyLike;
}

async function readMongoApiKeys(
  scope: ResyncScope,
): Promise<MongoApiKeyWithWs[]> {
  const filter: Record<string, unknown> = {};
  const keyIds = uniq(scope.entityIds);
  if (scope.workspaceId) {
    filter._id = oid(scope.workspaceId);
  }
  if (keyIds.length > 0 && !scope.workspaceId) {
    filter["apiKeys._id"] = { $in: keyIds.map(oid) };
  }
  if (!scope.workspaceId && keyIds.length === 0) {
    return [];
  }
  const docs = await Workspace.find(filter)
    .select("_id apiKeys")
    .lean<Array<{ _id: Types.ObjectId; apiKeys?: MongoApiKeyLike[] }>>();
  const wanted = new Set(keyIds.map(toWire));
  const out: MongoApiKeyWithWs[] = [];
  for (const doc of docs) {
    const wsWire = toWire(doc._id);
    for (const key of doc.apiKeys ?? []) {
      const keyWire =
        key._id != null
          ? toWire(key._id)
          : fallbackApiKeyId(wsWire, key.keyHash ?? "");
      if (wanted.size > 0 && !wanted.has(keyWire)) {
        continue;
      }
      out.push({ workspaceId: wsWire, key });
    }
  }
  return out;
}

function idsOrWorkspaceFilter(
  scope: ResyncScope,
  workspaceIdIsString: boolean,
): Record<string, unknown> | null {
  const ids = uniq(scope.entityIds);
  if (ids.length > 0) {
    return { _id: { $in: ids.map(oid) } };
  }
  if (scope.workspaceId) {
    return {
      workspaceId: workspaceIdIsString
        ? toWire(scope.workspaceId)
        : oid(scope.workspaceId),
    };
  }
  return null;
}

// ── resyncToPg ───────────────────────────────────────────────────────────

/**
 * Make Postgres match Mongo for the scoped rows of `table`.
 * Rows present in Mongo are upserted; scoped rows absent from Mongo are deleted
 * from Postgres (with tombstones). Parent `workspaces` and `mcp_oauth_clients`
 * rows are ensured first when a child row references them.
 */
export async function resyncToPg(
  table: WorkspacesTableName,
  scope: ResyncScope,
  deps: ResyncDeps = {},
): Promise<ResyncResult> {
  const db = (deps.getDb ?? getPgDb)();
  const withTombstones = deps.tombstones ?? true;
  const tombstone = async (ids: string[]) => {
    if (!withTombstones) {
      return;
    }
    for (const id of ids) {
      await recordMigrationTombstone(table, id, db);
    }
  };

  switch (table) {
    case "workspaces": {
      const docs = await readMongoWorkspaces(scope);
      const records = docs.map(mongoWorkspaceToRecord);
      const userMap = await resolvePgUserUuidMap(
        db,
        records.map(r => r.createdBy),
      );
      const mapNullable = makeNullableUuidMapper(userMap);

      for (const record of records) {
        const row = workspaceRecordToPgRow(record, mapNullable);
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
      }
      const present = new Set(records.map(r => r.id));
      const missing = uniq([
        ...(scope.entityIds ?? []),
        ...(scope.workspaceId ? [scope.workspaceId] : []),
      ])
        .map(toWire)
        .filter(id => !present.has(id));
      if (missing.length > 0) {
        const missingPg = missing.map(toPgUuid);
        await db.delete(workspaces).where(inArray(workspaces.id, missingPg));
        await tombstone(missingPg);
      }
      return { table, upserted: records.length, deleted: missing.length };
    }

    case "workspace_api_keys": {
      const found = await readMongoApiKeys(scope);
      const records = found.map(f => mongoApiKeyToRecord(f.workspaceId, f.key));
      for (const wsId of uniq(records.map(r => r.workspaceId))) {
        await ensurePgWorkspace(db, wsId);
      }
      const userMap = await resolvePgUserUuidMap(
        db,
        records.map(r => r.createdBy),
      );
      const mapNullable = makeNullableUuidMapper(userMap);

      for (const record of records) {
        const row = apiKeyRecordToPgRow(record, mapNullable);
        const { id: _id, ...rest } = row;
        void _id;
        await db.insert(workspaceApiKeys).values(row).onConflictDoUpdate({
          target: workspaceApiKeys.id,
          set: rest,
        });
      }
      const presentPg = records.map(r => toPgUuid(r.id));
      const scopedIds = uniq(scope.entityIds);
      let deleted: string[] = [];
      let toTombstone: string[] = [];
      if (scopedIds.length > 0) {
        const missing = scopedIds
          .map(toPgUuid)
          .filter(id => !presentPg.includes(id));
        if (missing.length > 0) {
          deleted = (
            await db
              .delete(workspaceApiKeys)
              .where(inArray(workspaceApiKeys.id, missing))
              .returning({ id: workspaceApiKeys.id })
          ).map(r => r.id);
          // Tombstone ALL missing entity IDs (even those not yet backfilled into PG)
          // so an in-flight backfill cannot resurrect a revoked API key.
          toTombstone = missing;
        }
      } else if (scope.workspaceId) {
        const wsUuid = toPgUuid(scope.workspaceId);
        const where = presentPg.length
          ? and(
              eq(workspaceApiKeys.workspaceId, wsUuid),
              notInArray(workspaceApiKeys.id, presentPg),
            )
          : eq(workspaceApiKeys.workspaceId, wsUuid);
        deleted = (
          await db
            .delete(workspaceApiKeys)
            .where(where)
            .returning({ id: workspaceApiKeys.id })
        ).map(r => r.id);
        toTombstone = deleted;
      }
      await tombstone(toTombstone);
      return { table, upserted: records.length, deleted: deleted.length };
    }

    case "workspace_members":
      return resyncSimpleToPg(db, table, scope, tombstone, {
        read: async f =>
          (await WorkspaceMember.find(f).lean<MongoMemberLike[]>()).map(
            mongoMemberToRecord,
          ),
        filter: idsOrWorkspaceFilter(scope, false),
        upsertBatch: async records => {
          const userMap = await resolvePgUserUuidMap(
            db,
            records.map(r => r.userId),
          );
          const mapRequired = makeRequiredUuidMapper(userMap);
          for (const wsId of uniq(records.map(r => r.workspaceId))) {
            await ensurePgWorkspace(db, wsId);
          }
          for (const r of records) {
            const row = memberRecordToPgRow(r, mapRequired, new Date());
            const { id: _id, ...rest } = row;
            void _id;
            await db.insert(workspaceMembers).values(row).onConflictDoUpdate({
              target: workspaceMembers.id,
              set: rest,
            });
          }
        },
        pgTable: workspaceMembers,
      });

    case "workspace_invites":
      return resyncSimpleToPg(db, table, scope, tombstone, {
        read: async f =>
          (await WorkspaceInvite.find(f).lean<MongoInviteLike[]>()).map(
            mongoInviteToRecord,
          ),
        filter: idsOrWorkspaceFilter(scope, false),
        upsertBatch: async records => {
          const userMap = await resolvePgUserUuidMap(
            db,
            records.map(r => r.invitedBy),
          );
          const mapNullable = makeNullableUuidMapper(userMap);
          for (const wsId of uniq(records.map(r => r.workspaceId))) {
            await ensurePgWorkspace(db, wsId);
          }
          for (const r of records) {
            const row = inviteRecordToPgRow(r, mapNullable, new Date());
            const { id: _id, ...rest } = row;
            void _id;
            await db.insert(workspaceInvites).values(row).onConflictDoUpdate({
              target: workspaceInvites.id,
              set: rest,
            });
          }
        },
        pgTable: workspaceInvites,
      });

    case "workspace_user_handles":
      return resyncSimpleToPg(db, table, scope, tombstone, {
        read: async f =>
          (await WorkspaceUserHandle.find(f).lean<MongoHandleLike[]>()).map(
            mongoHandleToRecord,
          ),
        filter: idsOrWorkspaceFilter(scope, false),
        upsertBatch: async records => {
          const userMap = await resolvePgUserUuidMap(
            db,
            records.map(r => r.userId),
          );
          const mapNullable = makeNullableUuidMapper(userMap);
          for (const wsId of uniq(records.map(r => r.workspaceId))) {
            await ensurePgWorkspace(db, wsId);
          }
          for (const r of records) {
            const row = handleRecordToPgRow(r, mapNullable);
            const { id: _id, ...rest } = row;
            void _id;
            await db
              .insert(workspaceUserHandles)
              .values(row)
              .onConflictDoUpdate({
                target: workspaceUserHandles.id,
                set: rest,
              });
          }
        },
        pgTable: workspaceUserHandles,
      });

    case "mcp_oauth_clients": {
      const clientIds = uniq(scope.entityIds);
      if (clientIds.length === 0) {
        return { table, upserted: 0, deleted: 0 };
      }
      const records = (
        await McpOAuthClient.find({ clientId: { $in: clientIds } }).lean<
          MongoMcpClientLike[]
        >()
      ).map(mongoMcpClientToRecord);
      for (const r of records) {
        const row = mcpClientRecordToPgRow(r);
        await db
          .insert(mcpOAuthClients)
          .values(row)
          .onConflictDoUpdate({
            target: mcpOAuthClients.clientId,
            set: { clientName: row.clientName, redirectUris: row.redirectUris },
          });
      }
      const present = new Set(records.map(r => r.clientId));
      const missing = clientIds.filter(c => !present.has(c));
      let deletedIds: string[] = [];
      if (missing.length > 0) {
        deletedIds = (
          await db
            .delete(mcpOAuthClients)
            .where(inArray(mcpOAuthClients.clientId, missing))
            .returning({ id: mcpOAuthClients.id })
        ).map(r => r.id);
        await tombstone(deletedIds);
      }
      return { table, upserted: records.length, deleted: deletedIds.length };
    }

    case "mcp_oauth_codes":
      return resyncSimpleToPg(db, table, scope, tombstone, {
        read: async f =>
          (await McpOAuthCode.find(f).lean<MongoMcpCodeLike[]>()).map(
            mongoMcpCodeToRecord,
          ),
        filter: idsOrWorkspaceFilter(scope, true),
        upsertBatch: async records => {
          const userMap = await resolvePgUserUuidMap(
            db,
            records.map(r => r.userId),
          );
          const mapRequired = makeRequiredUuidMapper(userMap);
          for (const wsId of uniq(records.map(r => r.workspaceId))) {
            await ensurePgWorkspace(db, wsId);
          }
          for (const clientId of uniq(records.map(r => r.clientId))) {
            await ensurePgMcpClient(db, clientId);
          }
          for (const r of records) {
            const row = mcpCodeRecordToPgRow(r, mapRequired);
            const { id: _id, ...rest } = row;
            void _id;
            await db.insert(mcpOAuthCodes).values(row).onConflictDoUpdate({
              target: mcpOAuthCodes.id,
              set: rest,
            });
          }
        },
        pgTable: mcpOAuthCodes,
      });

    case "mcp_oauth_tokens":
      return resyncSimpleToPg(db, table, scope, tombstone, {
        read: async f =>
          (await McpOAuthToken.find(f).lean<MongoMcpTokenLike[]>()).map(
            mongoMcpTokenToRecord,
          ),
        filter: idsOrWorkspaceFilter(scope, true),
        upsertBatch: async records => {
          const userMap = await resolvePgUserUuidMap(
            db,
            records.map(r => r.userId),
          );
          const mapRequired = makeRequiredUuidMapper(userMap);
          for (const wsId of uniq(records.map(r => r.workspaceId))) {
            await ensurePgWorkspace(db, wsId);
          }
          for (const clientId of uniq(records.map(r => r.clientId))) {
            await ensurePgMcpClient(db, clientId);
          }
          for (const r of records) {
            const row = mcpTokenRecordToPgRow(r, mapRequired, new Date());
            const { id: _id, ...rest } = row;
            void _id;
            await db.insert(mcpOAuthTokens).values(row).onConflictDoUpdate({
              target: mcpOAuthTokens.id,
              set: rest,
            });
          }
        },
        pgTable: mcpOAuthTokens,
      });

    case "acp_plan_grants":
      return resyncSimpleToPg(db, table, scope, tombstone, {
        read: async f =>
          (await AcpPlanGrant.find(f).lean<MongoAcpGrantLike[]>()).map(
            mongoAcpGrantToRecord,
          ),
        filter: idsOrWorkspaceFilter(scope, true),
        upsertBatch: async records => {
          const userMap = await resolvePgUserUuidMap(
            db,
            records.map(r => r.userId),
          );
          const mapRequired = makeRequiredUuidMapper(userMap);
          for (const wsId of uniq(records.map(r => r.workspaceId))) {
            await ensurePgWorkspace(db, wsId);
          }
          for (const r of records) {
            const row = acpGrantRecordToPgRow(r, mapRequired);
            const { id: _id, ...rest } = row;
            void _id;
            await db.insert(acpPlanGrants).values(row).onConflictDoUpdate({
              target: acpPlanGrants.id,
              set: rest,
            });
          }
        },
        pgTable: acpPlanGrants,
      });

    case "github_installations":
      return resyncSimpleToPg(db, table, scope, tombstone, {
        read: async f =>
          (
            await GitHubInstallation.find(f).lean<
              MongoGitHubInstallationLike[]
            >()
          ).map(mongoGitHubInstallationToRecord),
        filter: idsOrWorkspaceFilter(scope, false),
        upsertBatch: async records => {
          const userMap = await resolvePgUserUuidMap(
            db,
            records.map(r => r.createdBy),
          );
          const mapNullable = makeNullableUuidMapper(userMap);
          for (const wsId of uniq(records.map(r => r.workspaceId))) {
            await ensurePgWorkspace(db, wsId);
          }
          for (const r of records) {
            const row = githubInstallationRecordToPgRow(r, mapNullable);
            const { id: _id, ...rest } = row;
            void _id;
            await db
              .insert(githubInstallations)
              .values(row)
              .onConflictDoUpdate({
                target: githubInstallations.id,
                set: rest,
              });
          }
        },
        pgTable: githubInstallations,
      });
  }
}

type PgTableWithIdAndWorkspace =
  | typeof workspaceMembers
  | typeof workspaceInvites
  | typeof workspaceUserHandles
  | typeof mcpOAuthCodes
  | typeof mcpOAuthTokens
  | typeof acpPlanGrants
  | typeof githubInstallations;

async function resyncSimpleToPg<R extends { id: string }>(
  db: MakoPgDb,
  table: WorkspacesTableName,
  scope: ResyncScope,
  tombstone: (ids: string[]) => Promise<void>,
  ops: {
    read: (filter: Record<string, unknown>) => Promise<R[]>;
    filter: Record<string, unknown> | null;
    upsertBatch: (records: R[]) => Promise<void>;
    pgTable: PgTableWithIdAndWorkspace;
  },
): Promise<ResyncResult> {
  if (!ops.filter) {
    return { table, upserted: 0, deleted: 0 };
  }
  const records = await ops.read(ops.filter);
  if (records.length > 0) {
    await ops.upsertBatch(records);
  }
  const presentPg = records.map(r => toPgUuid(r.id));
  const ids = uniq(scope.entityIds);
  let where;
  let explicitMissing: string[] | null = null;
  if (ids.length > 0) {
    const missing = ids.map(toPgUuid).filter(id => !presentPg.includes(id));
    if (missing.length === 0) {
      return { table, upserted: records.length, deleted: 0 };
    }
    explicitMissing = missing;
    where = inArray(ops.pgTable.id, missing);
  } else if (scope.workspaceId) {
    const wsUuid = toPgUuid(scope.workspaceId);
    where = presentPg.length
      ? and(
          eq(ops.pgTable.workspaceId, wsUuid),
          notInArray(ops.pgTable.id, presentPg),
        )
      : eq(ops.pgTable.workspaceId, wsUuid);
  } else {
    return { table, upserted: records.length, deleted: 0 };
  }
  const deleted = (
    await db.delete(ops.pgTable).where(where).returning({ id: ops.pgTable.id })
  ).map(r => r.id);
  // When explicit entityIds were targeted, tombstone ALL missing IDs even if PG
  // did not yet have them so an in-flight backfill cannot resurrect deleted rows.
  await tombstone(explicitMissing ?? deleted);
  return { table, upserted: records.length, deleted: deleted.length };
}

/** Upsert the parent workspace from Mongo if Postgres does not have it yet. */
async function ensurePgWorkspace(
  db: MakoPgDb,
  workspaceId: string,
): Promise<void> {
  const uuid = toPgUuid(workspaceId);
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, uuid))
    .limit(1);
  if (existing.length === 0) {
    await resyncToPg(
      "workspaces",
      { entityIds: [workspaceId] },
      { getDb: () => db },
    );
  }
}

async function ensurePgMcpClient(
  db: MakoPgDb,
  clientId: string,
): Promise<void> {
  const existing = await db
    .select({ id: mcpOAuthClients.id })
    .from(mcpOAuthClients)
    .where(eq(mcpOAuthClients.clientId, clientId))
    .limit(1);
  if (existing.length === 0) {
    await resyncToPg(
      "mcp_oauth_clients",
      { entityIds: [clientId] },
      { getDb: () => db },
    );
  }
}

// ── resyncToMongo ────────────────────────────────────────────────────────

/**
 * Make Mongo match Postgres for the scoped rows of `table` (Stage 4 secondary,
 * `mongo-sync-retry`). Writes bypass Mongoose timestamps so `updatedAt` /
 * `createdAt` stay byte-identical to Postgres, and map PG user UUIDs back to
 * `users.legacy_id ?? users.id` so Stage 4 -> Stage 2 rollback preserves legacy IDs.
 */
export async function resyncToMongo(
  table: WorkspacesTableName,
  scope: ResyncScope,
  deps: ResyncDeps = {},
): Promise<ResyncResult> {
  const db = (deps.getDb ?? getPgDb)();
  const ids = uniq(scope.entityIds);

  switch (table) {
    case "workspaces": {
      const wanted = uniq([
        ...ids,
        ...(scope.workspaceId ? [scope.workspaceId] : []),
      ]);
      if (wanted.length === 0) {
        return { table, upserted: 0, deleted: 0 };
      }
      const rows = await db
        .select()
        .from(workspaces)
        .where(inArray(workspaces.id, wanted.map(toPgUuid)));
      const records = rows.map(pgWorkspaceToRecord);
      const userMap = await resolveMongoUserIdMap(
        db,
        records.map(r => r.createdBy),
      );
      const mapMongoUser = makeMongoUserMapper(userMap);

      for (const r of records) {
        const setDoc = workspaceRecordToMongoSet(r, mapMongoUser);
        const unsetDoc = workspaceRecordToMongoUnset(r);
        await Workspace.collection.updateOne(
          {
            _id: oid(r.id),
            $or: [
              { updatedAt: { $exists: false } },
              { updatedAt: { $lte: r.updatedAt } },
            ],
          },
          { $set: setDoc, $unset: unsetDoc },
        );
        // Insert if absent (using $setOnInsert avoids clobbering a newer doc or apiKeys[]).
        await Workspace.collection.updateOne(
          { _id: oid(r.id) },
          { $setOnInsert: { ...setDoc, apiKeys: [] } },
          { upsert: true },
        );
      }
      const present = new Set(records.map(r => r.id));
      const missing = wanted.map(toWire).filter(id => !present.has(id));
      if (missing.length > 0) {
        await Workspace.collection.deleteMany({
          _id: { $in: missing.map(oid) },
        });
      }
      return { table, upserted: records.length, deleted: missing.length };
    }

    case "workspace_api_keys": {
      if (scope.workspaceId) {
        const rows = await db
          .select()
          .from(workspaceApiKeys)
          .where(eq(workspaceApiKeys.workspaceId, toPgUuid(scope.workspaceId)));
        const records = rows.map(pgApiKeyToRecord);
        const userMap = await resolveMongoUserIdMap(
          db,
          records.map(r => r.createdBy),
        );
        const mapMongoUser = makeMongoUserMapper(userMap);
        const subdocs = records
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .map(r => ({
            ...apiKeyRecordToMongoSubdoc(r, mapMongoUser),
            _id: oid(r.id),
          }));
        await Workspace.collection.updateOne(
          { _id: oid(scope.workspaceId) },
          { $set: { apiKeys: subdocs } },
        );
        return { table, upserted: subdocs.length, deleted: 0 };
      }
      if (ids.length === 0) {
        return { table, upserted: 0, deleted: 0 };
      }
      const rows = await db
        .select()
        .from(workspaceApiKeys)
        .where(inArray(workspaceApiKeys.id, ids.map(toPgUuid)));
      const records = rows.map(pgApiKeyToRecord);
      const userMap = await resolveMongoUserIdMap(
        db,
        records.map(r => r.createdBy),
      );
      const mapMongoUser = makeMongoUserMapper(userMap);

      for (const r of records) {
        const subdoc = {
          ...apiKeyRecordToMongoSubdoc(r, mapMongoUser),
          _id: oid(r.id),
        };
        const res = await Workspace.collection.updateOne(
          { _id: oid(r.workspaceId), "apiKeys._id": oid(r.id) },
          { $set: { "apiKeys.$": subdoc } },
        );
        if (res.matchedCount === 0) {
          await Workspace.collection.updateOne({ _id: oid(r.workspaceId) }, {
            $push: { apiKeys: subdoc },
          } as never);
        }
      }
      const present = new Set(records.map(r => r.id));
      const missing = ids.map(toWire).filter(id => !present.has(id));
      if (missing.length > 0) {
        await Workspace.collection.updateMany(
          { "apiKeys._id": { $in: missing.map(oid) } },
          { $pull: { apiKeys: { _id: { $in: missing.map(oid) } } } } as never,
        );
      }
      return { table, upserted: records.length, deleted: missing.length };
    }

    case "workspace_members":
      return resyncSimpleToMongo(db, table, scope, {
        pgRows: async () =>
          (
            await db
              .select()
              .from(workspaceMembers)
              .where(pgScopeWhere(workspaceMembers, scope))
          ).map(pgMemberToRecord),
        extractUserIds: rs => rs.map(r => r.userId),
        collection: WorkspaceMember.collection,
        toDoc: (r, mapUser) => ({
          ...memberRecordToMongoDoc(r, mapUser),
          _id: oid(r.id),
          workspaceId: oid(r.workspaceId),
        }),
        workspaceIdIsString: false,
      });

    case "workspace_invites":
      return resyncSimpleToMongo(db, table, scope, {
        pgRows: async () =>
          (
            await db
              .select()
              .from(workspaceInvites)
              .where(pgScopeWhere(workspaceInvites, scope))
          ).map(pgInviteToRecord),
        extractUserIds: rs => rs.map(r => r.invitedBy),
        collection: WorkspaceInvite.collection,
        toDoc: (r, mapUser) => ({
          ...inviteRecordToMongoDoc(r, mapUser),
          _id: oid(r.id),
          workspaceId: oid(r.workspaceId),
        }),
        workspaceIdIsString: false,
      });

    case "workspace_user_handles":
      return resyncSimpleToMongo(db, table, scope, {
        pgRows: async () =>
          (
            await db
              .select()
              .from(workspaceUserHandles)
              .where(pgScopeWhere(workspaceUserHandles, scope))
          ).map(pgHandleToRecord),
        extractUserIds: rs => rs.map(r => r.userId),
        collection: WorkspaceUserHandle.collection,
        toDoc: (r, mapUser) => ({
          ...handleRecordToMongoDoc(r, mapUser),
          _id: oid(r.id),
          workspaceId: oid(r.workspaceId),
        }),
        workspaceIdIsString: false,
      });

    case "mcp_oauth_clients": {
      if (ids.length === 0) {
        return { table, upserted: 0, deleted: 0 };
      }
      const records = (
        await db
          .select()
          .from(mcpOAuthClients)
          .where(inArray(mcpOAuthClients.clientId, ids))
      ).map(pgMcpClientToRecord);
      for (const r of records) {
        const doc = { ...mcpClientRecordToMongoDoc(r), _id: oid(r.id) };
        await McpOAuthClient.collection.replaceOne(
          { clientId: r.clientId },
          doc,
          { upsert: true },
        );
      }
      const present = new Set(records.map(r => r.clientId));
      const missing = ids.filter(c => !present.has(c));
      if (missing.length > 0) {
        await McpOAuthClient.collection.deleteMany({
          clientId: { $in: missing },
        });
      }
      return { table, upserted: records.length, deleted: missing.length };
    }

    case "mcp_oauth_codes":
      return resyncSimpleToMongo(db, table, scope, {
        pgRows: async () =>
          (
            await db
              .select()
              .from(mcpOAuthCodes)
              .where(pgScopeWhere(mcpOAuthCodes, scope))
          ).map(pgMcpCodeToRecord),
        extractUserIds: rs => rs.map(r => r.userId),
        collection: McpOAuthCode.collection,
        toDoc: (r, mapUser) => ({
          ...mcpCodeRecordToMongoDoc(r, mapUser),
          _id: oid(r.id),
        }),
        workspaceIdIsString: true,
      });

    case "mcp_oauth_tokens":
      return resyncSimpleToMongo(db, table, scope, {
        pgRows: async () =>
          (
            await db
              .select()
              .from(mcpOAuthTokens)
              .where(pgScopeWhere(mcpOAuthTokens, scope))
          ).map(pgMcpTokenToRecord),
        extractUserIds: rs => rs.map(r => r.userId),
        collection: McpOAuthToken.collection,
        toDoc: (r, mapUser) => ({
          ...mcpTokenRecordToMongoDoc(r, mapUser),
          _id: oid(r.id),
        }),
        workspaceIdIsString: true,
      });

    case "acp_plan_grants":
      return resyncSimpleToMongo(db, table, scope, {
        pgRows: async () =>
          (
            await db
              .select()
              .from(acpPlanGrants)
              .where(pgScopeWhere(acpPlanGrants, scope))
          ).map(pgAcpGrantToRecord),
        extractUserIds: rs => rs.map(r => r.userId),
        collection: AcpPlanGrant.collection,
        toDoc: (r, mapUser) => ({
          ...acpGrantRecordToMongoDoc(r, mapUser),
          _id: oid(r.id),
        }),
        workspaceIdIsString: true,
      });

    case "github_installations":
      return resyncSimpleToMongo(db, table, scope, {
        pgRows: async () =>
          (
            await db
              .select()
              .from(githubInstallations)
              .where(pgScopeWhere(githubInstallations, scope))
          ).map(pgGitHubInstallationToRecord),
        extractUserIds: rs => rs.map(r => r.createdBy),
        collection: GitHubInstallation.collection,
        toDoc: (r, mapUser) => ({
          ...githubInstallationRecordToMongoDoc(r, mapUser),
          _id: oid(r.id),
          workspaceId: oid(r.workspaceId),
        }),
        workspaceIdIsString: false,
      });
  }
}

function pgScopeWhere(t: PgTableWithIdAndWorkspace, scope: ResyncScope) {
  const ids = uniq(scope.entityIds);
  if (ids.length > 0) {
    return inArray(t.id, ids.map(toPgUuid));
  }
  if (scope.workspaceId) {
    return eq(t.workspaceId, toPgUuid(scope.workspaceId));
  }
  return sql`false`;
}

interface MongoCollectionLike {
  replaceOne(
    filter: Record<string, unknown>,
    doc: Record<string, unknown>,
    options: { upsert: boolean },
  ): Promise<unknown>;
  deleteMany(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount?: number }>;
}

async function resyncSimpleToMongo<
  R extends { id: string; workspaceId: string },
>(
  db: MakoPgDb,
  table: WorkspacesTableName,
  scope: ResyncScope,
  ops: {
    pgRows: () => Promise<R[]>;
    extractUserIds: (records: R[]) => string[];
    collection: unknown;
    toDoc: (record: R, mapUser: MongoUserIdMapper) => Record<string, unknown>;
    workspaceIdIsString: boolean;
  },
): Promise<ResyncResult> {
  const ids = uniq(scope.entityIds);
  if (ids.length === 0 && !scope.workspaceId) {
    return { table, upserted: 0, deleted: 0 };
  }
  const collection = ops.collection as MongoCollectionLike;
  const records = await ops.pgRows();
  const userMap = await resolveMongoUserIdMap(db, ops.extractUserIds(records));
  const mapUser = makeMongoUserMapper(userMap);

  for (const r of records) {
    const doc = ops.toDoc(r, mapUser);
    await collection.replaceOne({ _id: oid(r.id) }, doc, { upsert: true });
  }

  let deleted = 0;
  const presentOids = records.map(r => oid(r.id));
  if (ids.length > 0) {
    const presentSet = new Set(records.map(r => r.id));
    const missing = ids.map(toWire).filter(id => !presentSet.has(id));
    if (missing.length > 0) {
      const res = await collection.deleteMany({
        _id: { $in: missing.map(oid) },
      });
      deleted = res.deletedCount ?? missing.length;
    }
  } else if (scope.workspaceId) {
    const wsFilter = ops.workspaceIdIsString
      ? toWire(scope.workspaceId)
      : oid(scope.workspaceId);
    const deleteFilter: Record<string, unknown> =
      presentOids.length > 0
        ? { workspaceId: wsFilter, _id: { $nin: presentOids } }
        : { workspaceId: wsFilter };
    const res = await collection.deleteMany(deleteFilter);
    deleted = res.deletedCount ?? 0;
  }

  return { table, upserted: records.length, deleted };
}
