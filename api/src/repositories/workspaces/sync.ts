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
import { migrationTombstones } from "../../database/pg/schema/control-plane";
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
  isSyntheticUserId,
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
  /**
   * When true (`touchApiKeyLastUsed` / `touchMcpTokenLastUsed`), conflict
   * updates advance only `last_used_at` (via `GREATEST`) so a lagging touch
   * resync can never overwrite newer scopes, names, or rotated token hashes.
   */
  touchOnly?: boolean;
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
  /**
   * Bypass stale-overwrite `setWhere` guards (used ONLY by `pg:verify --repair`
   * when explicitly healing PG drift). Tombstone guards still apply.
   */
  force?: boolean;
}

export interface EntityLockTarget {
  table: WorkspacesTableName;
  entityId: string;
}

/**
 * Acquire transaction-scoped Postgres advisory locks for `(table, entityId)`
 * pairs in deterministic sorted order (single round-trip) so concurrent resync
 * upserts, resync deletes, and backfill batches serialize without deadlocks.
 */
export async function lockWorkspacesEntities(
  tx: MakoPgDb,
  targets: readonly EntityLockTarget[],
): Promise<void> {
  const keys = [
    ...new Set(
      targets
        .filter(t => Boolean(t.entityId))
        .map(t => `${t.table}:${t.entityId.toLowerCase()}`),
    ),
  ].sort();
  if (keys.length === 0) {
    return;
  }
  const keyParams = sql.join(
    keys.map(k => sql`${k}`),
    sql`, `,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM (SELECT unnest(ARRAY[${keyParams}]::text[]) AS k ORDER BY k) AS sorted_keys`,
  );
}

/**
 * Load tombstoned `(table, entityId)` keys inside an already-locked PG
 * transaction, returning keys formatted as `"${table}:${entityId.toLowerCase()}"`.
 */
export async function loadLockedTombstoneKeys(
  tx: MakoPgDb,
  targets: readonly EntityLockTarget[],
): Promise<Set<string>> {
  const byTable = new Map<string, string[]>();
  for (const t of targets) {
    if (!t.entityId) continue;
    const id = t.entityId.toLowerCase();
    const list = byTable.get(t.table);
    if (list) {
      list.push(id);
    } else {
      byTable.set(t.table, [id]);
    }
  }
  const tombstoned = new Set<string>();
  for (const [tbl, ids] of byTable) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) continue;
    const rows = await tx
      .select({ entityId: migrationTombstones.entityId })
      .from(migrationTombstones)
      .where(
        and(
          eq(migrationTombstones.tableName, tbl),
          inArray(migrationTombstones.entityId, uniqueIds),
        ),
      );
    for (const row of rows) {
      tombstoned.add(`${tbl}:${row.entityId.toLowerCase()}`);
    }
  }
  return tombstoned;
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

/**
 * Strict creator mapper for `workspace_api_keys.created_by`:
 * empty or synthetic sentinels (`"system"`, `"test"`) map to NULL, while any
 * real user ID absent from Postgres `users` throws so `MigrationRouter` queues
 * a `pg-sync-retry` instead of writing a broken NULL creator.
 */
function makeApiKeyCreatorUuidMapper(
  map: Map<string, string>,
): NullableUserUuidMapper {
  return userId => {
    if (!userId || isSyntheticUserId(userId)) {
      return null;
    }
    const resolved = map.get(userId) ?? map.get(userId.toLowerCase());
    if (resolved) {
      return resolved;
    }
    throw new Error(
      `Cannot sync workspace_api_keys row to Postgres: creator ${JSON.stringify(userId)} not found in Postgres users table`,
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
  const force = deps.force ?? false;
  const touchOnly = scope.touchOnly ?? false;
  const recordTombstones = async (
    targetDb: MakoPgDb,
    ids: readonly string[],
  ) => {
    if (!withTombstones) {
      return;
    }
    for (const id of ids) {
      await recordMigrationTombstone(table, id, targetDb);
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

      let upserted = 0;
      if (records.length > 0) {
        await db.transaction(async rawTx => {
          const tx = rawTx as unknown as MakoPgDb;
          const lockTargets: EntityLockTarget[] = records.map(r => ({
            table: "workspaces",
            entityId: toPgUuid(r.id),
          }));
          await lockWorkspacesEntities(tx, lockTargets);
          const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);

          for (const record of records) {
            const row = workspaceRecordToPgRow(record, mapNullable);
            if (tombstoned.has(`workspaces:${row.id.toLowerCase()}`)) {
              continue;
            }
            const { id: _id, ...rest } = row;
            void _id;
            const written = await tx
              .insert(workspaces)
              .values(row)
              .onConflictDoUpdate(
                force
                  ? { target: workspaces.id, set: rest }
                  : {
                      target: workspaces.id,
                      set: rest,
                      setWhere: sql`${workspaces.updatedAt} <= excluded.updated_at`,
                    },
              )
              .returning({ id: workspaces.id });
            upserted += written.length;
          }
        });
      }
      const present = new Set(records.map(r => r.id));
      const missing = uniq([
        ...(scope.entityIds ?? []),
        ...(scope.workspaceId ? [scope.workspaceId] : []),
      ])
        .map(toWire)
        .filter(id => !present.has(id));
      let deletedCount = 0;
      if (missing.length > 0) {
        const missingPg = missing.map(toPgUuid);
        await db.transaction(async rawTx => {
          const tx = rawTx as unknown as MakoPgDb;
          await lockWorkspacesEntities(
            tx,
            missingPg.map(id => ({ table: "workspaces", entityId: id })),
          );
          await recordTombstones(tx, missingPg);
          const deletedRows = await tx
            .delete(workspaces)
            .where(inArray(workspaces.id, missingPg))
            .returning({ id: workspaces.id });
          deletedCount = deletedRows.length;
        });
      }
      return { table, upserted, deleted: deletedCount };
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
      const mapCreator = makeApiKeyCreatorUuidMapper(userMap);

      let upserted = 0;
      if (records.length > 0) {
        await db.transaction(async rawTx => {
          const tx = rawTx as unknown as MakoPgDb;
          const lockTargets: EntityLockTarget[] = records.flatMap(r => [
            { table: "workspace_api_keys", entityId: toPgUuid(r.id) },
            { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
          ]);
          await lockWorkspacesEntities(tx, lockTargets);
          const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);

          for (const record of records) {
            const pgId = toPgUuid(record.id).toLowerCase();
            const wsUuid = toPgUuid(record.workspaceId).toLowerCase();
            if (
              tombstoned.has(`workspace_api_keys:${pgId}`) ||
              tombstoned.has(`workspaces:${wsUuid}`)
            ) {
              continue;
            }
            const row = apiKeyRecordToPgRow(record, mapCreator);
            const { id: _id, ...rest } = row;
            void _id;
            const written = await tx
              .insert(workspaceApiKeys)
              .values(row)
              .onConflictDoUpdate(
                force
                  ? { target: workspaceApiKeys.id, set: rest }
                  : touchOnly
                    ? {
                        target: workspaceApiKeys.id,
                        set: {
                          lastUsedAt: sql`GREATEST(${workspaceApiKeys.lastUsedAt}, excluded.last_used_at)`,
                        },
                      }
                    : {
                        target: workspaceApiKeys.id,
                        set: {
                          ...rest,
                          lastUsedAt: sql`GREATEST(${workspaceApiKeys.lastUsedAt}, excluded.last_used_at)`,
                        },
                      },
              )
              .returning({ id: workspaceApiKeys.id });
            upserted += written.length;
          }
        });
      }
      const presentPg = records.map(r => toPgUuid(r.id));
      const scopedIds = uniq(scope.entityIds);
      let deleted: string[] = [];
      if (scopedIds.length > 0) {
        const missing = scopedIds
          .map(toPgUuid)
          .filter(id => !presentPg.includes(id));
        if (missing.length > 0) {
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            await lockWorkspacesEntities(
              tx,
              missing.map(id => ({
                table: "workspace_api_keys",
                entityId: id,
              })),
            );
            // Tombstone ALL missing entity IDs atomically with the delete (even
            // those not yet backfilled into PG) so neither an in-flight backfill
            // nor a concurrent touch resync can resurrect a revoked API key.
            await recordTombstones(tx, missing);
            deleted = (
              await tx
                .delete(workspaceApiKeys)
                .where(inArray(workspaceApiKeys.id, missing))
                .returning({ id: workspaceApiKeys.id })
            ).map(r => r.id);
          });
        }
      } else if (scope.workspaceId) {
        const wsUuid = toPgUuid(scope.workspaceId);
        const where = presentPg.length
          ? and(
              eq(workspaceApiKeys.workspaceId, wsUuid),
              notInArray(workspaceApiKeys.id, presentPg),
            )
          : eq(workspaceApiKeys.workspaceId, wsUuid);
        const candidateIds = (
          await db
            .select({ id: workspaceApiKeys.id })
            .from(workspaceApiKeys)
            .where(where)
        ).map(r => r.id);
        await db.transaction(async rawTx => {
          const tx = rawTx as unknown as MakoPgDb;
          await lockWorkspacesEntities(tx, [
            ...candidateIds.map(id => ({
              table: "workspace_api_keys" as const,
              entityId: id,
            })),
            { table: "workspaces", entityId: wsUuid },
          ]);
          deleted = (
            await tx
              .delete(workspaceApiKeys)
              .where(where)
              .returning({ id: workspaceApiKeys.id })
          ).map(r => r.id);
          await recordTombstones(tx, deleted);
        });
      }
      return { table, upserted, deleted: deleted.length };
    }

    case "workspace_members":
      return resyncSimpleToPg(db, table, scope, recordTombstones, {
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
          let upserted = 0;
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            const lockTargets: EntityLockTarget[] = records.flatMap(r => [
              { table: "workspace_members", entityId: toPgUuid(r.id) },
              { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
            ]);
            await lockWorkspacesEntities(tx, lockTargets);
            const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
            for (const r of records) {
              const pgId = toPgUuid(r.id).toLowerCase();
              const wsUuid = toPgUuid(r.workspaceId).toLowerCase();
              if (
                tombstoned.has(`workspace_members:${pgId}`) ||
                tombstoned.has(`workspaces:${wsUuid}`)
              ) {
                continue;
              }
              const row = memberRecordToPgRow(r, mapRequired, new Date());
              const { id: _id, ...rest } = row;
              void _id;
              const written = await tx
                .insert(workspaceMembers)
                .values(row)
                .onConflictDoUpdate({
                  target: workspaceMembers.id,
                  set: rest,
                })
                .returning({ id: workspaceMembers.id });
              upserted += written.length;
            }
          });
          return upserted;
        },
        pgTable: workspaceMembers,
      });

    case "workspace_invites":
      return resyncSimpleToPg(db, table, scope, recordTombstones, {
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
          let upserted = 0;
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            const lockTargets: EntityLockTarget[] = records.flatMap(r => [
              { table: "workspace_invites", entityId: toPgUuid(r.id) },
              { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
            ]);
            await lockWorkspacesEntities(tx, lockTargets);
            const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
            for (const r of records) {
              const pgId = toPgUuid(r.id).toLowerCase();
              const wsUuid = toPgUuid(r.workspaceId).toLowerCase();
              if (
                tombstoned.has(`workspace_invites:${pgId}`) ||
                tombstoned.has(`workspaces:${wsUuid}`)
              ) {
                continue;
              }
              const row = inviteRecordToPgRow(r, mapNullable, new Date());
              const { id: _id, ...rest } = row;
              void _id;
              const written = await tx
                .insert(workspaceInvites)
                .values(row)
                .onConflictDoUpdate(
                  force
                    ? { target: workspaceInvites.id, set: rest }
                    : {
                        target: workspaceInvites.id,
                        set: {
                          ...rest,
                          acceptedAt: sql`COALESCE(${workspaceInvites.acceptedAt}, excluded.accepted_at)`,
                        },
                        setWhere: sql`${workspaceInvites.acceptedAt} IS NULL AND ${workspaceInvites.expiresAt} <= excluded.expires_at`,
                      },
                )
                .returning({ id: workspaceInvites.id });
              upserted += written.length;
            }
          });
          return upserted;
        },
        pgTable: workspaceInvites,
      });

    case "workspace_user_handles":
      return resyncSimpleToPg(db, table, scope, recordTombstones, {
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
          let upserted = 0;
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            const lockTargets: EntityLockTarget[] = records.flatMap(r => [
              { table: "workspace_user_handles", entityId: toPgUuid(r.id) },
              { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
            ]);
            await lockWorkspacesEntities(tx, lockTargets);
            const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
            for (const r of records) {
              const pgId = toPgUuid(r.id).toLowerCase();
              const wsUuid = toPgUuid(r.workspaceId).toLowerCase();
              if (
                tombstoned.has(`workspace_user_handles:${pgId}`) ||
                tombstoned.has(`workspaces:${wsUuid}`)
              ) {
                continue;
              }
              const row = handleRecordToPgRow(r, mapNullable);
              const { id: _id, ...rest } = row;
              void _id;
              const written = await tx
                .insert(workspaceUserHandles)
                .values(row)
                .onConflictDoUpdate(
                  force
                    ? { target: workspaceUserHandles.id, set: rest }
                    : {
                        target: workspaceUserHandles.id,
                        set: rest,
                        setWhere: sql`${workspaceUserHandles.updatedAt} <= excluded.updated_at`,
                      },
                )
                .returning({ id: workspaceUserHandles.id });
              upserted += written.length;
            }
          });
          return upserted;
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
      let upserted = 0;
      if (records.length > 0) {
        await db.transaction(async rawTx => {
          const tx = rawTx as unknown as MakoPgDb;
          const lockTargets: EntityLockTarget[] = records.map(r => ({
            table: "mcp_oauth_clients",
            entityId: toPgUuid(r.id),
          }));
          await lockWorkspacesEntities(tx, lockTargets);
          const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
          for (const r of records) {
            const row = mcpClientRecordToPgRow(r);
            if (tombstoned.has(`mcp_oauth_clients:${row.id.toLowerCase()}`)) {
              continue;
            }
            const written = await tx
              .insert(mcpOAuthClients)
              .values(row)
              .onConflictDoUpdate({
                target: mcpOAuthClients.clientId,
                set: {
                  clientName: row.clientName,
                  redirectUris: row.redirectUris,
                },
              })
              .returning({ id: mcpOAuthClients.id });
            upserted += written.length;
          }
        });
      }
      const present = new Set(records.map(r => r.clientId));
      const missing = clientIds.filter(c => !present.has(c));
      let deletedIds: string[] = [];
      if (missing.length > 0) {
        const candidateIds = (
          await db
            .select({ id: mcpOAuthClients.id })
            .from(mcpOAuthClients)
            .where(inArray(mcpOAuthClients.clientId, missing))
        ).map(r => r.id);
        await db.transaction(async rawTx => {
          const tx = rawTx as unknown as MakoPgDb;
          await lockWorkspacesEntities(
            tx,
            candidateIds.map(id => ({
              table: "mcp_oauth_clients",
              entityId: id,
            })),
          );
          deletedIds = (
            await tx
              .delete(mcpOAuthClients)
              .where(inArray(mcpOAuthClients.clientId, missing))
              .returning({ id: mcpOAuthClients.id })
          ).map(r => r.id);
          await recordTombstones(tx, deletedIds);
        });
      }
      return { table, upserted, deleted: deletedIds.length };
    }

    case "mcp_oauth_codes":
      return resyncSimpleToPg(db, table, scope, recordTombstones, {
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
          let upserted = 0;
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            const lockTargets: EntityLockTarget[] = records.flatMap(r => [
              { table: "mcp_oauth_codes", entityId: toPgUuid(r.id) },
              { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
            ]);
            await lockWorkspacesEntities(tx, lockTargets);
            const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
            for (const r of records) {
              const pgId = toPgUuid(r.id).toLowerCase();
              const wsUuid = toPgUuid(r.workspaceId).toLowerCase();
              if (
                tombstoned.has(`mcp_oauth_codes:${pgId}`) ||
                tombstoned.has(`workspaces:${wsUuid}`)
              ) {
                continue;
              }
              const row = mcpCodeRecordToPgRow(r, mapRequired);
              const { id: _id, ...rest } = row;
              void _id;
              const written = await tx
                .insert(mcpOAuthCodes)
                .values(row)
                .onConflictDoUpdate(
                  force
                    ? { target: mcpOAuthCodes.id, set: rest }
                    : {
                        target: mcpOAuthCodes.id,
                        set: {
                          ...rest,
                          usedAt: sql`COALESCE(${mcpOAuthCodes.usedAt}, excluded.used_at)`,
                        },
                        setWhere: sql`${mcpOAuthCodes.usedAt} IS NULL`,
                      },
                )
                .returning({ id: mcpOAuthCodes.id });
              upserted += written.length;
            }
          });
          return upserted;
        },
        pgTable: mcpOAuthCodes,
      });

    case "mcp_oauth_tokens":
      return resyncSimpleToPg(db, table, scope, recordTombstones, {
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
          let upserted = 0;
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            const lockTargets: EntityLockTarget[] = records.flatMap(r => [
              { table: "mcp_oauth_tokens", entityId: toPgUuid(r.id) },
              { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
            ]);
            await lockWorkspacesEntities(tx, lockTargets);
            const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
            for (const r of records) {
              const pgId = toPgUuid(r.id).toLowerCase();
              const wsUuid = toPgUuid(r.workspaceId).toLowerCase();
              if (
                tombstoned.has(`mcp_oauth_tokens:${pgId}`) ||
                tombstoned.has(`workspaces:${wsUuid}`)
              ) {
                continue;
              }
              const row = mcpTokenRecordToPgRow(r, mapRequired, new Date());
              const { id: _id, ...rest } = row;
              void _id;
              const written = await tx
                .insert(mcpOAuthTokens)
                .values(row)
                .onConflictDoUpdate(
                  force
                    ? { target: mcpOAuthTokens.id, set: rest }
                    : touchOnly
                      ? {
                          target: mcpOAuthTokens.id,
                          set: {
                            lastUsedAt: sql`GREATEST(${mcpOAuthTokens.lastUsedAt}, excluded.last_used_at)`,
                            updatedAt: sql`GREATEST(${mcpOAuthTokens.updatedAt}, excluded.updated_at)`,
                          },
                        }
                      : {
                          target: mcpOAuthTokens.id,
                          set: {
                            ...rest,
                            lastUsedAt: sql`GREATEST(${mcpOAuthTokens.lastUsedAt}, excluded.last_used_at)`,
                            updatedAt: sql`GREATEST(${mcpOAuthTokens.updatedAt}, excluded.updated_at)`,
                          },
                          setWhere: sql`${mcpOAuthTokens.accessExpiresAt} <= excluded.access_expires_at`,
                        },
                )
                .returning({ id: mcpOAuthTokens.id });
              upserted += written.length;
            }
          });
          return upserted;
        },
        pgTable: mcpOAuthTokens,
      });

    case "acp_plan_grants":
      return resyncSimpleToPg(db, table, scope, recordTombstones, {
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
          let upserted = 0;
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            const lockTargets: EntityLockTarget[] = records.flatMap(r => [
              { table: "acp_plan_grants", entityId: toPgUuid(r.id) },
              { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
            ]);
            await lockWorkspacesEntities(tx, lockTargets);
            const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
            for (const r of records) {
              const pgId = toPgUuid(r.id).toLowerCase();
              const wsUuid = toPgUuid(r.workspaceId).toLowerCase();
              if (
                tombstoned.has(`acp_plan_grants:${pgId}`) ||
                tombstoned.has(`workspaces:${wsUuid}`)
              ) {
                continue;
              }
              const row = acpGrantRecordToPgRow(r, mapRequired);
              const { id: _id, ...rest } = row;
              void _id;
              const written = await tx
                .insert(acpPlanGrants)
                .values(row)
                .onConflictDoUpdate(
                  force
                    ? { target: acpPlanGrants.id, set: rest }
                    : {
                        target: acpPlanGrants.id,
                        set: rest,
                        setWhere: sql`${acpPlanGrants.updatedAt} <= excluded.updated_at AND (${acpPlanGrants.status} <> 'revoked' OR excluded.status = 'revoked' OR ${acpPlanGrants.updatedAt} < excluded.updated_at)`,
                      },
                )
                .returning({ id: acpPlanGrants.id });
              upserted += written.length;
            }
          });
          return upserted;
        },
        pgTable: acpPlanGrants,
      });

    case "github_installations":
      return resyncSimpleToPg(db, table, scope, recordTombstones, {
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
          let upserted = 0;
          await db.transaction(async rawTx => {
            const tx = rawTx as unknown as MakoPgDb;
            const lockTargets: EntityLockTarget[] = records.flatMap(r => [
              { table: "github_installations", entityId: toPgUuid(r.id) },
              { table: "workspaces", entityId: toPgUuid(r.workspaceId) },
            ]);
            await lockWorkspacesEntities(tx, lockTargets);
            const tombstoned = await loadLockedTombstoneKeys(tx, lockTargets);
            for (const r of records) {
              const pgId = toPgUuid(r.id).toLowerCase();
              const wsUuid = toPgUuid(r.workspaceId).toLowerCase();
              if (
                tombstoned.has(`github_installations:${pgId}`) ||
                tombstoned.has(`workspaces:${wsUuid}`)
              ) {
                continue;
              }
              const row = githubInstallationRecordToPgRow(r, mapNullable);
              const { id: _id, ...rest } = row;
              void _id;
              const written = await tx
                .insert(githubInstallations)
                .values(row)
                .onConflictDoUpdate(
                  force
                    ? { target: githubInstallations.id, set: rest }
                    : {
                        target: githubInstallations.id,
                        set: rest,
                        setWhere: sql`${githubInstallations.updatedAt} <= excluded.updated_at`,
                      },
                )
                .returning({ id: githubInstallations.id });
              upserted += written.length;
            }
          });
          return upserted;
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
  recordTombstones: (
    targetDb: MakoPgDb,
    ids: readonly string[],
  ) => Promise<void>,
  ops: {
    read: (filter: Record<string, unknown>) => Promise<R[]>;
    filter: Record<string, unknown> | null;
    upsertBatch: (records: R[]) => Promise<number>;
    pgTable: PgTableWithIdAndWorkspace;
  },
): Promise<ResyncResult> {
  if (!ops.filter) {
    return { table, upserted: 0, deleted: 0 };
  }
  const records = await ops.read(ops.filter);
  const upserted = records.length > 0 ? await ops.upsertBatch(records) : 0;
  const presentPg = records.map(r => toPgUuid(r.id));
  const ids = uniq(scope.entityIds);
  if (ids.length > 0) {
    const missing = ids.map(toPgUuid).filter(id => !presentPg.includes(id));
    if (missing.length === 0) {
      return { table, upserted, deleted: 0 };
    }
    let deletedCount = 0;
    await db.transaction(async rawTx => {
      const tx = rawTx as unknown as MakoPgDb;
      await lockWorkspacesEntities(
        tx,
        missing.map(id => ({ table, entityId: id })),
      );
      // When explicit entityIds were targeted, tombstone ALL missing IDs
      // atomically with the delete (even if PG did not yet have them) so
      // neither an in-flight backfill nor a concurrent resync can resurrect them.
      await recordTombstones(tx, missing);
      const deleted = await tx
        .delete(ops.pgTable)
        .where(inArray(ops.pgTable.id, missing))
        .returning({ id: ops.pgTable.id });
      deletedCount = deleted.length;
    });
    return { table, upserted, deleted: deletedCount };
  }
  if (scope.workspaceId) {
    const wsUuid = toPgUuid(scope.workspaceId);
    const where = presentPg.length
      ? and(
          eq(ops.pgTable.workspaceId, wsUuid),
          notInArray(ops.pgTable.id, presentPg),
        )
      : eq(ops.pgTable.workspaceId, wsUuid);
    const candidateIds = (
      await db.select({ id: ops.pgTable.id }).from(ops.pgTable).where(where)
    ).map(r => r.id);
    let deletedCount = 0;
    await db.transaction(async rawTx => {
      const tx = rawTx as unknown as MakoPgDb;
      await lockWorkspacesEntities(tx, [
        ...candidateIds.map(id => ({ table, entityId: id })),
        { table: "workspaces", entityId: wsUuid },
      ]);
      const deleted = (
        await tx
          .delete(ops.pgTable)
          .where(where)
          .returning({ id: ops.pgTable.id })
      ).map(r => r.id);
      await recordTombstones(tx, deleted);
      deletedCount = deleted.length;
    });
    return { table, upserted, deleted: deletedCount };
  }
  return { table, upserted, deleted: 0 };
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
