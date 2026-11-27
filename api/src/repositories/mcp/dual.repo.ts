/**
 * 5-stage workspace-scoped dual-run `McpRepository` powered by `MigrationRouter` (`domain = "mcp"`).
 *
 * Key invariants:
 *   - All 4 encrypted fields are copied opaque and redacted in `MCP_SHADOW_OPTIONS`.
 *   - `mcp_oauth_flows` is 10m ephemeral (never backfilled): in Stage 4 (`dual_write_pg_read`),
 *     `findOAuthFlowByState` and `findOAuthFlowById` fall back from PG to Mongo so in-flight
 *     OAuth browser redirects started immediately before cutover never fail.
 *   - Deletes in Stages 2–3 record tombstones in `migration_tombstones` (`mcp_servers`,
 *     `mcp_connection_configs`, `mcp_tool_grants`) so in-flight backfill cannot resurrect them.
 *   - Stage 4 PG->Mongo reverse sync maps PG UUIDs back cleanly so instant Stage 4->2 rollback
 *     loses zero data.
 */
import { eq, inArray, or } from "drizzle-orm";
import {
  getPgDb,
  hasPostgresConfig,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  isUuidString,
  newDualId,
  parseEntityId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  isMigrationForceMongoOnly,
  migrationRouter,
  recordMigrationTombstone,
  type MigrationRouter,
} from "../../migration/router";
import type { ShadowCompareOptions } from "../../migration/types";
import {
  canonicalizeMcpConfigForCompare,
  canonicalizeMcpGrantForCompare,
  canonicalizeMcpServerForCompare,
  normalizeConfigUserId,
} from "./mapper";
import { MongoMcpRepository } from "./mongo.repo";
import { PgMcpRepository } from "./pg.repo";
import type {
  CreateMcpServerInput,
  McpConnectionConfigRecord,
  McpOAuthFlowRecord,
  McpRepository,
  McpServerRecord,
  McpToolGrantRecord,
  UpdateMcpServerPatch,
  UpsertMcpCredentialsInput,
  UpsertMcpOAuthFlowInput,
  UpsertMcpOAuthTokensInput,
  UpsertMcpToolGrantInput,
} from "./types";

export const MCP_DOMAIN = "mcp" as const;

/** Redact all 4 encrypted MCP credential/OAuth blobs in shadow-compare logs. */
export const MCP_SHADOW_OPTIONS: ShadowCompareOptions = {
  redactKeys: [
    "oauth",
    "clientInformation",
    "oauthClientInformationEncrypted",
    "oauth_client_information_encrypted",
    "headers",
    "headersEncrypted",
    "headers_encrypted",
    "oauthTokens",
    "oauthTokensEncrypted",
    "oauth_tokens_encrypted",
    "codeVerifier",
    "codeVerifierEncrypted",
    "code_verifier_encrypted",
  ],
};

export interface DualMcpRepositoryDeps {
  mongo?: MongoMcpRepository;
  pg?: PgMcpRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
  hasPg?: () => boolean;
  isForceMongoOnly?: () => boolean;
}

export class DualMcpRepository implements McpRepository {
  readonly mongo: MongoMcpRepository;
  readonly pg: PgMcpRepository;
  private readonly router: MigrationRouter;
  private readonly getDb: () => MakoPgDb;
  private readonly hasPg: () => boolean;
  private readonly isForceMongoOnly: () => boolean;

  constructor(deps: DualMcpRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoMcpRepository();
    this.pg = deps.pg ?? new PgMcpRepository({ getDb: deps.getDb });
    this.router = deps.router ?? migrationRouter;
    this.getDb = deps.getDb ?? getPgDb;
    this.hasPg = deps.hasPg ?? hasPostgresConfig;
    this.isForceMongoOnly = deps.isForceMongoOnly ?? isMigrationForceMongoOnly;
  }

  private async isMongoPrimaryDualWrite(
    workspaceId?: string,
  ): Promise<boolean> {
    const mode = (await this.router.getState(MCP_DOMAIN, workspaceId)).mode;
    return (
      mode === "dual_write_mongo_read" || mode === "dual_write_shadow_compare"
    );
  }

  private async recordTombstone(
    tableName: string,
    wireId: string,
  ): Promise<void> {
    const uuid = parseEntityId(wireId)?.uuid;
    if (!uuid) return;
    await recordMigrationTombstone(tableName, uuid, this.getDb());
  }

  /** Map a PG user UUID back to its Mongo `_id` (`legacy_id`) for Stage 4 reverse sync. */
  private async resolveMongoUserIdForReverseSync(
    userId: string | null,
  ): Promise<string | null> {
    if (
      !userId ||
      !isUuidString(userId) ||
      !this.hasPg() ||
      this.isForceMongoOnly()
    ) {
      return userId;
    }
    const db = this.getDb();
    const where = or(
      eq(users.id, userId.toLowerCase()),
      eq(users.legacyId, userId),
    );
    const rows = await db
      .select({ id: users.id, legacyId: users.legacyId })
      .from(users)
      .where(where)
      .limit(1);
    return rows[0]?.legacyId ?? userId;
  }

  private async isPgPrimaryMode(workspaceId?: string): Promise<boolean> {
    const mode = (await this.router.getState(MCP_DOMAIN, workspaceId)).mode;
    return mode === "dual_write_pg_read" || mode === "pg_only";
  }

  /**
   * Populate `userMap` (`legacyId -> uuid` and `uuid -> uuid`) off the request
   * critical path — called ONLY inside the background shadow-read branch so
   * unsampled reads incur ZERO extra Postgres queries.
   */
  private async populateShadowUserMap(
    userMap: Map<string, string>,
    rawIds: Iterable<string | null | undefined>,
  ): Promise<void> {
    if (!this.hasPg() || this.isForceMongoOnly()) return;
    const uuids: string[] = [];
    const legacyIds: string[] = [];
    for (const raw of rawIds) {
      if (!raw || raw === "system") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (isUuidString(trimmed)) {
        uuids.push(trimmed.toLowerCase());
      } else {
        legacyIds.push(trimmed);
      }
    }
    if (uuids.length === 0 && legacyIds.length === 0) return;

    const predicates = [];
    if (uuids.length > 0) predicates.push(inArray(users.id, uuids));
    if (legacyIds.length > 0) {
      predicates.push(inArray(users.legacyId, legacyIds));
    }
    const where = predicates.length === 1 ? predicates[0] : or(...predicates);
    if (!where) return;

    const rows = await this.getDb()
      .select({ id: users.id, legacyId: users.legacyId })
      .from(users)
      .where(where);
    for (const row of rows) {
      const canonical = row.id.toLowerCase();
      userMap.set(row.id, canonical);
      userMap.set(canonical, canonical);
      if (row.legacyId) {
        userMap.set(row.legacyId, canonical);
      }
    }
  }

  // ── Servers ──────────────────────────────────────────────────────────────

  async listServersByWorkspace(
    workspaceId: string,
  ): Promise<McpServerRecord[]> {
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: MCP_DOMAIN,
        operation: "listServersByWorkspace",
        workspaceId,
      },
      {
        mongo: async () => {
          const rows = await this.mongo.listServersByWorkspace(workspaceId);
          for (const r of rows) {
            if (r.createdBy) collectedUserIds.add(r.createdBy);
          }
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        pg: async () => {
          const rows = await this.pg.listServersByWorkspace(workspaceId);
          for (const r of rows) {
            if (r.createdBy) collectedUserIds.add(r.createdBy);
          }
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        canonicalize: list =>
          list.map(r => canonicalizeMcpServerForCompare(r, resolveShadowUser)),
        shadowOptions: MCP_SHADOW_OPTIONS,
      },
    );
  }

  async listActiveConnectedServers(
    workspaceId: string,
  ): Promise<McpServerRecord[]> {
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: MCP_DOMAIN,
        operation: "listActiveConnectedServers",
        workspaceId,
      },
      {
        mongo: async () => {
          const rows = await this.mongo.listActiveConnectedServers(workspaceId);
          for (const r of rows) {
            if (r.createdBy) collectedUserIds.add(r.createdBy);
          }
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        pg: async () => {
          const rows = await this.pg.listActiveConnectedServers(workspaceId);
          for (const r of rows) {
            if (r.createdBy) collectedUserIds.add(r.createdBy);
          }
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        canonicalize: list =>
          list.map(r => canonicalizeMcpServerForCompare(r, resolveShadowUser)),
        shadowOptions: MCP_SHADOW_OPTIONS,
      },
    );
  }

  async findServerById(
    serverId: string,
    workspaceId?: string,
  ): Promise<McpServerRecord | null> {
    if (workspaceId !== undefined) {
      const shadowUserMap = new Map<string, string>();
      const collectedUserIds = new Set<string>();
      let mongoRan = false;
      let pgRan = false;
      const resolveShadowUser = (id: string | null): string | null =>
        id
          ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
          : null;

      return this.router.executeRead(
        {
          domain: MCP_DOMAIN,
          operation: "findServerById",
          workspaceId,
          entityId: serverId,
        },
        {
          mongo: async () => {
            const res = await this.mongo.findServerById(serverId, workspaceId);
            if (res?.createdBy) collectedUserIds.add(res.createdBy);
            mongoRan = true;
            if (pgRan) {
              await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
            }
            return res;
          },
          pg: async () => {
            const res = await this.pg.findServerById(serverId, workspaceId);
            if (res?.createdBy) collectedUserIds.add(res.createdBy);
            pgRan = true;
            if (mongoRan) {
              await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
            }
            return res;
          },
          canonicalize: r =>
            canonicalizeMcpServerForCompare(r, resolveShadowUser),
          shadowOptions: MCP_SHADOW_OPTIONS,
        },
      );
    }

    const globalState = await this.router.getState(MCP_DOMAIN);
    if (globalState.mode === "pg_only") {
      return this.pg.findServerById(serverId);
    }
    if (globalState.mode === "dual_write_pg_read") {
      const fromPg = await this.pg.findServerById(serverId);
      if (fromPg) return fromPg;
      return this.mongo.findServerById(serverId);
    }
    const fromMongo = await this.mongo.findServerById(serverId);
    if (fromMongo) {
      const wsState = await this.router.getState(
        MCP_DOMAIN,
        fromMongo.workspaceId,
      );
      if (wsState.mode === "dual_write_pg_read" || wsState.mode === "pg_only") {
        return this.pg.findServerById(serverId, fromMongo.workspaceId);
      }
      return fromMongo;
    }
    if (!this.isForceMongoOnly() && this.hasPg()) {
      return this.pg.findServerById(serverId);
    }
    return null;
  }

  async createServer(input: CreateMcpServerInput): Promise<McpServerRecord> {
    const id = input.id ?? newDualId().oid;
    const now = input.createdAt ?? new Date();
    const createWithId: CreateMcpServerInput = {
      ...input,
      id,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };

    let createdRecord: McpServerRecord | null = null;
    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "createServer",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          entity: "mcp_servers",
          workspaceId: input.workspaceId,
          serverId: id,
        },
      },
      {
        mongo: async () => {
          if (createdRecord) {
            const mongoCreatedBy = await this.resolveMongoUserIdForReverseSync(
              createdRecord.createdBy,
            );
            await this.mongo.upsertFullServer({
              ...createdRecord,
              createdBy: mongoCreatedBy,
            });
            return createdRecord;
          }
          createdRecord = await this.mongo.createServer(createWithId);
          return createdRecord;
        },
        pg: async () => {
          if (createdRecord) {
            const createdByUuid = await this.pg.resolveUserUuid(
              createdRecord.createdBy,
            );
            await this.pg.upsertServerWithGuard(createdRecord, createdByUuid);
            return createdRecord;
          }
          createdRecord = await this.pg.createServer(createWithId);
          return createdRecord;
        },
      },
    );
  }

  async updateServer(
    workspaceId: string,
    serverId: string,
    patch: UpdateMcpServerPatch,
  ): Promise<McpServerRecord | null> {
    const updatedAt = patch.updatedAt ?? new Date();
    const patchWithTime: UpdateMcpServerPatch = { ...patch, updatedAt };
    let primaryRecord: McpServerRecord | null = null;

    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "updateServer",
        workspaceId,
        entityId: serverId,
        retryPayload: {
          entity: "mcp_servers",
          workspaceId,
          serverId,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoCreatedBy = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.createdBy,
            );
            await this.mongo.upsertFullServer({
              ...primaryRecord,
              createdBy: mongoCreatedBy,
            });
            return primaryRecord;
          }
          primaryRecord = await this.mongo.updateServer(
            workspaceId,
            serverId,
            patchWithTime,
          );
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            const createdByUuid = await this.pg.resolveUserUuid(
              primaryRecord.createdBy,
            );
            await this.pg.upsertServerWithGuard(primaryRecord, createdByUuid);
            return primaryRecord;
          }
          primaryRecord = await this.pg.updateServer(
            workspaceId,
            serverId,
            patchWithTime,
          );
          return primaryRecord;
        },
      },
    );
  }

  async deleteServerCascade(
    workspaceId: string,
    serverId: string,
  ): Promise<boolean> {
    const recordTombstones = await this.isMongoPrimaryDualWrite(workspaceId);
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    let primaryDeleted = false;
    let childConfigIds: string[] = [];
    let childGrantIds: string[] = [];

    if (recordTombstones) {
      const configs = await this.mongo.listConnectionConfigsByServerIds(
        workspaceId,
        [serverId],
      );
      childConfigIds = configs.map(c => c.id);
      const { McpToolGrant } = await import("../../database/models/mcp");
      const { Types } = await import("mongoose");
      const serverOid = parseEntityId(serverId)?.oid;
      if (serverOid) {
        const grantDocs = await McpToolGrant.find({
          serverId: new Types.ObjectId(serverOid),
        })
          .select("_id")
          .lean<Array<{ _id: { toHexString(): string } }>>();
        childGrantIds = grantDocs.map(g => g._id.toHexString());
      }
    }

    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "deleteServerCascade",
        workspaceId,
        entityId: serverId,
        retryPayload: {
          entity: "mcp_servers",
          action: "delete",
          workspaceId,
          serverId,
        },
      },
      {
        mongo: async () => {
          const deleted = await this.mongo.deleteServerCascade(
            workspaceId,
            serverId,
          );
          if (!pgPrimary) {
            primaryDeleted = deleted;
          }
          return deleted;
        },
        pg: async () => {
          const deleted = await this.pg.deleteServerCascade(
            workspaceId,
            serverId,
          );
          if (recordTombstones && primaryDeleted) {
            await this.recordTombstone("mcp_servers", serverId);
            for (const cid of childConfigIds) {
              await this.recordTombstone("mcp_connection_configs", cid);
            }
            for (const gid of childGrantIds) {
              await this.recordTombstone("mcp_tool_grants", gid);
            }
          }
          return deleted;
        },
      },
    );
  }

  // ── Connection configs ───────────────────────────────────────────────────

  async listConnectionConfigsByServerIds(
    workspaceId: string,
    serverIds: readonly string[],
  ): Promise<McpConnectionConfigRecord[]> {
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: MCP_DOMAIN,
        operation: "listConnectionConfigsByServerIds",
        workspaceId,
      },
      {
        mongo: async () => {
          const rows = await this.mongo.listConnectionConfigsByServerIds(
            workspaceId,
            serverIds,
          );
          for (const r of rows) {
            if (r.userId) collectedUserIds.add(r.userId);
          }
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        pg: async () => {
          const rows = await this.pg.listConnectionConfigsByServerIds(
            workspaceId,
            serverIds,
          );
          for (const r of rows) {
            if (r.userId) collectedUserIds.add(r.userId);
          }
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        canonicalize: list =>
          list.map(r => canonicalizeMcpConfigForCompare(r, resolveShadowUser)),
        shadowOptions: MCP_SHADOW_OPTIONS,
      },
    );
  }

  async listConnectionConfigsForUser(
    workspaceId: string,
    serverIds: readonly string[],
    userId: string | null,
  ): Promise<McpConnectionConfigRecord[]> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    const normalizedUser = normalizeConfigUserId(userId);
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    if (normalizedUser) collectedUserIds.add(normalizedUser);
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: MCP_DOMAIN,
        operation: "listConnectionConfigsForUser",
        workspaceId,
      },
      {
        mongo: async () => {
          const mongoUserIds: string[] = [];
          if (normalizedUser !== null) {
            mongoUserIds.push(normalizedUser);
            if (
              pgPrimary ||
              (isUuidString(normalizedUser) &&
                this.hasPg() &&
                !this.isForceMongoOnly())
            ) {
              const legacy =
                await this.resolveMongoUserIdForReverseSync(normalizedUser);
              if (legacy && legacy !== normalizedUser) {
                mongoUserIds.push(legacy);
              }
            }
          }
          const rows = await this.mongo.listConnectionConfigsForUserIds(
            workspaceId,
            serverIds,
            mongoUserIds,
          );
          for (const r of rows) {
            if (r.userId) collectedUserIds.add(r.userId);
          }
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        pg: async () => {
          const rows = await this.pg.listConnectionConfigsForUser(
            workspaceId,
            serverIds,
            normalizedUser,
          );
          for (const r of rows) {
            if (r.userId) collectedUserIds.add(r.userId);
          }
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        canonicalize: list =>
          list.map(r => canonicalizeMcpConfigForCompare(r, resolveShadowUser)),
        shadowOptions: MCP_SHADOW_OPTIONS,
      },
    );
  }

  async findConnectionConfig(
    workspaceId: string,
    serverId: string,
    userId: string | null,
  ): Promise<McpConnectionConfigRecord | null> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>();
    if (userId) collectedUserIds.add(userId);
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string | null): string | null =>
      id
        ? (shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id)
        : null;

    return this.router.executeRead(
      {
        domain: MCP_DOMAIN,
        operation: "findConnectionConfig",
        workspaceId,
        entityId: serverId,
      },
      {
        mongo: async () => {
          const mongoUserId =
            pgPrimary && userId !== null
              ? await this.resolveMongoUserIdForReverseSync(userId)
              : userId;
          const res = await this.mongo.findConnectionConfig(
            workspaceId,
            serverId,
            mongoUserId,
          );
          if (res?.userId) collectedUserIds.add(res.userId);
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        pg: async () => {
          const res = await this.pg.findConnectionConfig(
            workspaceId,
            serverId,
            userId,
          );
          if (res?.userId) collectedUserIds.add(res.userId);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return res;
        },
        canonicalize: r =>
          canonicalizeMcpConfigForCompare(r, resolveShadowUser),
        shadowOptions: MCP_SHADOW_OPTIONS,
      },
    );
  }

  async upsertConnectionCredentials(
    input: UpsertMcpCredentialsInput,
  ): Promise<McpConnectionConfigRecord> {
    const id = input.id ?? newDualId().oid;
    const now = input.now ?? new Date();
    const withId: UpsertMcpCredentialsInput = { ...input, id, now };
    let primaryRecord: McpConnectionConfigRecord | null = null;

    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "upsertConnectionCredentials",
        workspaceId: input.workspaceId,
        entityId: input.serverId,
        retryPayload: {
          entity: "mcp_connection_configs",
          workspaceId: input.workspaceId,
          serverId: input.serverId,
          userId: input.userId,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoUser = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.userId,
            );
            await this.mongo.upsertFullConnectionConfig({
              ...primaryRecord,
              userId: mongoUser,
            });
            return primaryRecord;
          }
          primaryRecord = await this.mongo.upsertConnectionCredentials(withId);
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            const pgInput: UpsertMcpCredentialsInput = {
              id: primaryRecord.id,
              workspaceId: primaryRecord.workspaceId,
              serverId: primaryRecord.serverId,
              userId: primaryRecord.userId,
              headersEncrypted: primaryRecord.headersEncrypted,
              now: primaryRecord.updatedAt,
            };
            return this.pg.upsertConnectionCredentials(pgInput);
          }
          primaryRecord = await this.pg.upsertConnectionCredentials(withId);
          return primaryRecord;
        },
      },
    );
  }

  async upsertConnectionOAuthTokens(
    input: UpsertMcpOAuthTokensInput,
  ): Promise<McpConnectionConfigRecord> {
    const id = input.id ?? newDualId().oid;
    const now = input.now ?? new Date();
    const withId: UpsertMcpOAuthTokensInput = { ...input, id, now };
    let primaryRecord: McpConnectionConfigRecord | null = null;

    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "upsertConnectionOAuthTokens",
        workspaceId: input.workspaceId,
        entityId: input.serverId,
        retryPayload: {
          entity: "mcp_connection_configs",
          workspaceId: input.workspaceId,
          serverId: input.serverId,
          userId: input.userId,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoUser = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.userId,
            );
            await this.mongo.upsertFullConnectionConfig({
              ...primaryRecord,
              userId: mongoUser,
            });
            return primaryRecord;
          }
          primaryRecord = await this.mongo.upsertConnectionOAuthTokens(withId);
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            return this.pg.upsertConnectionOAuthTokens({
              id: primaryRecord.id,
              workspaceId: primaryRecord.workspaceId,
              serverId: primaryRecord.serverId,
              userId: primaryRecord.userId,
              oauthTokensEncrypted: input.oauthTokensEncrypted,
              oauthExpiresAt: primaryRecord.oauthExpiresAt,
              now: primaryRecord.updatedAt,
            });
          }
          primaryRecord = await this.pg.upsertConnectionOAuthTokens(withId);
          return primaryRecord;
        },
      },
    );
  }

  async clearServerOAuthTokens(
    workspaceId: string,
    serverId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "clearServerOAuthTokens",
        workspaceId,
        entityId: serverId,
        retryPayload: {
          entity: "mcp_connection_configs",
          action: "clear_oauth_tokens",
          workspaceId,
          serverId,
          updatedAt: now.toISOString(),
        },
      },
      {
        mongo: () =>
          this.mongo.clearServerOAuthTokens(workspaceId, serverId, now),
        pg: () => this.pg.clearServerOAuthTokens(workspaceId, serverId, now),
      },
    );
  }

  // ── OAuth flows (skip backfill + Stage 4 10m PG->Mongo read fallback) ────

  async upsertOAuthFlow(
    input: UpsertMcpOAuthFlowInput,
  ): Promise<McpOAuthFlowRecord> {
    const id = input.id ?? newDualId().oid;
    const createdAt = input.createdAt ?? new Date();
    const withId: UpsertMcpOAuthFlowInput = { ...input, id, createdAt };
    let primaryRecord: McpOAuthFlowRecord | null = null;

    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "upsertOAuthFlow",
        workspaceId: input.workspaceId,
        entityId: id,
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoConfigUser = await this.resolveMongoUserIdForReverseSync(
              primaryRecord.configUserId,
            );
            const mongoStarter =
              (await this.resolveMongoUserIdForReverseSync(
                primaryRecord.startedByUserId,
              )) ?? primaryRecord.startedByUserId;
            return this.mongo.upsertOAuthFlow({
              id: primaryRecord.id,
              state: primaryRecord.state,
              workspaceId: primaryRecord.workspaceId,
              serverId: primaryRecord.serverId,
              configUserId: mongoConfigUser,
              startedByUserId: mongoStarter,
              codeVerifierEncrypted: primaryRecord.codeVerifierEncrypted,
              createdAt: primaryRecord.createdAt,
            });
          }
          primaryRecord = await this.mongo.upsertOAuthFlow(withId);
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            return this.pg.upsertOAuthFlow({
              id: primaryRecord.id,
              state: primaryRecord.state,
              workspaceId: primaryRecord.workspaceId,
              serverId: primaryRecord.serverId,
              configUserId: primaryRecord.configUserId,
              startedByUserId: primaryRecord.startedByUserId,
              codeVerifierEncrypted: primaryRecord.codeVerifierEncrypted,
              createdAt: primaryRecord.createdAt,
            });
          }
          primaryRecord = await this.pg.upsertOAuthFlow(withId);
          return primaryRecord;
        },
      },
    );
  }

  async findOAuthFlowByState(
    state: string,
    now: Date = new Date(),
  ): Promise<McpOAuthFlowRecord | null> {
    const globalState = await this.router.getState(MCP_DOMAIN);

    if (globalState.mode === "pg_only") {
      return this.pg.findOAuthFlowByState(state, now);
    }

    if (globalState.mode === "dual_write_pg_read") {
      const fromPg = await this.pg.findOAuthFlowByState(state, now);
      if (fromPg) return fromPg;
      // Mandatory 10m Stage 4 PG -> Mongo fallback for in-flight OAuth flows
      // started before cutover (mcp_oauth_flows is never backfilled).
      return this.mongo.findOAuthFlowByState(state, now);
    }

    const fromMongo = await this.mongo.findOAuthFlowByState(state, now);
    if (fromMongo) {
      const wsState = await this.router.getState(
        MCP_DOMAIN,
        fromMongo.workspaceId,
      );
      if (wsState.mode === "pg_only") {
        return this.pg.findOAuthFlowByState(state, now);
      }
      if (wsState.mode === "dual_write_pg_read") {
        const fromPg = await this.pg.findOAuthFlowByState(state, now);
        return fromPg ?? fromMongo;
      }
      return fromMongo;
    }

    if (!this.isForceMongoOnly() && this.hasPg()) {
      return this.pg.findOAuthFlowByState(state, now);
    }
    return null;
  }

  async findOAuthFlowById(
    flowId: string,
    workspaceId?: string,
    now: Date = new Date(),
  ): Promise<McpOAuthFlowRecord | null> {
    const state = await this.router.getState(MCP_DOMAIN, workspaceId);

    if (state.mode === "pg_only") {
      return this.pg.findOAuthFlowById(flowId, workspaceId, now);
    }

    if (state.mode === "dual_write_pg_read") {
      const fromPg = await this.pg.findOAuthFlowById(flowId, workspaceId, now);
      if (fromPg) return fromPg;
      // 10m Stage 4 PG -> Mongo fallback for in-flight OAuth flows.
      return this.mongo.findOAuthFlowById(flowId, workspaceId, now);
    }

    const fromMongo = await this.mongo.findOAuthFlowById(
      flowId,
      workspaceId,
      now,
    );
    if (fromMongo) return fromMongo;
    if (!workspaceId && !this.isForceMongoOnly() && this.hasPg()) {
      return this.pg.findOAuthFlowById(flowId, undefined, now);
    }
    return null;
  }

  async deleteOAuthFlowById(
    flowId: string,
    workspaceId?: string,
  ): Promise<boolean> {
    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "deleteOAuthFlowById",
        workspaceId,
        entityId: flowId,
      },
      {
        mongo: () => this.mongo.deleteOAuthFlowById(flowId, workspaceId),
        pg: () => this.pg.deleteOAuthFlowById(flowId, workspaceId),
      },
    );
  }

  async isSameUser(
    userIdA: string | null | undefined,
    userIdB: string | null | undefined,
  ): Promise<boolean> {
    const a = normalizeConfigUserId(userIdA);
    const b = normalizeConfigUserId(userIdB);
    if (!a || !b) return false;
    if (a === b) return true;
    if (
      isUuidString(a) &&
      isUuidString(b) &&
      a.toLowerCase() === b.toLowerCase()
    ) {
      return true;
    }
    if (!this.hasPg() || this.isForceMongoOnly()) {
      return false;
    }
    return this.pg.isSameUser(a, b);
  }

  // ── Tool grants ──────────────────────────────────────────────────────────

  async listToolGrantsForUser(
    workspaceId: string,
    serverId: string,
    userId: string,
  ): Promise<McpToolGrantRecord[]> {
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>([userId]);
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string): string =>
      shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id;

    return this.router.executeRead(
      {
        domain: MCP_DOMAIN,
        operation: "listToolGrantsForUser",
        workspaceId,
        entityId: serverId,
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          const rows = await this.mongo.listToolGrantsForUser(
            workspaceId,
            serverId,
            mongoUser,
          );
          for (const r of rows) collectedUserIds.add(r.userId);
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        pg: async () => {
          const rows = await this.pg.listToolGrantsForUser(
            workspaceId,
            serverId,
            userId,
          );
          for (const r of rows) collectedUserIds.add(r.userId);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        canonicalize: list =>
          list.map(r => canonicalizeMcpGrantForCompare(r, resolveShadowUser)),
        shadowOptions: MCP_SHADOW_OPTIONS,
      },
    );
  }

  async findToolGrantsForResolution(params: {
    serverId: string;
    userId: string;
    toolName: string;
    workspaceId?: string;
  }): Promise<McpToolGrantRecord[]> {
    const pgPrimary = await this.isPgPrimaryMode(params.workspaceId);
    const shadowUserMap = new Map<string, string>();
    const collectedUserIds = new Set<string>([params.userId]);
    let mongoRan = false;
    let pgRan = false;
    const resolveShadowUser = (id: string): string =>
      shadowUserMap.get(id) ?? shadowUserMap.get(id.toLowerCase()) ?? id;

    return this.router.executeRead(
      {
        domain: MCP_DOMAIN,
        operation: "findToolGrantsForResolution",
        workspaceId: params.workspaceId,
        entityId: params.serverId,
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(params.userId)) ??
              params.userId)
            : params.userId;
          const rows = await this.mongo.findToolGrantsForResolution({
            ...params,
            userId: mongoUser,
          });
          for (const r of rows) collectedUserIds.add(r.userId);
          mongoRan = true;
          if (pgRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        pg: async () => {
          const rows = await this.pg.findToolGrantsForResolution(params);
          for (const r of rows) collectedUserIds.add(r.userId);
          pgRan = true;
          if (mongoRan) {
            await this.populateShadowUserMap(shadowUserMap, collectedUserIds);
          }
          return rows;
        },
        canonicalize: list =>
          list.map(r => canonicalizeMcpGrantForCompare(r, resolveShadowUser)),
        shadowOptions: MCP_SHADOW_OPTIONS,
      },
    );
  }

  async upsertToolGrant(
    input: UpsertMcpToolGrantInput,
  ): Promise<McpToolGrantRecord> {
    const id = input.id ?? newDualId().oid;
    const now = input.now ?? new Date();
    const withId: UpsertMcpToolGrantInput = { ...input, id, now };
    let primaryRecord: McpToolGrantRecord | null = null;

    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "upsertToolGrant",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          entity: "mcp_tool_grants",
          workspaceId: input.workspaceId,
          serverId: input.serverId,
          userId: input.userId,
          toolName: input.toolName,
        },
      },
      {
        mongo: async () => {
          if (primaryRecord) {
            const mongoUser =
              (await this.resolveMongoUserIdForReverseSync(
                primaryRecord.userId,
              )) ?? primaryRecord.userId;
            await this.mongo.upsertFullToolGrant({
              ...primaryRecord,
              userId: mongoUser,
            });
            return primaryRecord;
          }
          primaryRecord = await this.mongo.upsertToolGrant(withId);
          return primaryRecord;
        },
        pg: async () => {
          if (primaryRecord) {
            return this.pg.upsertToolGrant({
              id: primaryRecord.id,
              workspaceId: primaryRecord.workspaceId,
              serverId: primaryRecord.serverId,
              userId: primaryRecord.userId,
              toolName: primaryRecord.toolName,
              decision: primaryRecord.decision,
              now: primaryRecord.updatedAt,
            });
          }
          primaryRecord = await this.pg.upsertToolGrant(withId);
          return primaryRecord;
        },
      },
    );
  }

  async touchToolGrantLastUsed(params: {
    workspaceId: string;
    serverId: string;
    userId: string;
    toolName: string;
    at?: Date;
  }): Promise<void> {
    const at = params.at ?? new Date();
    const pgPrimary = await this.isPgPrimaryMode(params.workspaceId);
    await this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "touchToolGrantLastUsed",
        workspaceId: params.workspaceId,
        entityId: params.serverId,
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(params.userId)) ??
              params.userId)
            : params.userId;
          await this.mongo.touchToolGrantLastUsed({
            ...params,
            userId: mongoUser,
            at,
          });
        },
        pg: () => this.pg.touchToolGrantLastUsed({ ...params, at }),
      },
    );
  }

  async deleteToolGrantById(
    workspaceId: string,
    serverId: string,
    grantId: string,
    userId: string,
  ): Promise<boolean> {
    const recordTombstones = await this.isMongoPrimaryDualWrite(workspaceId);
    const pgPrimary = await this.isPgPrimaryMode(workspaceId);
    let primaryDeleted = false;

    return this.router.executeWrite(
      {
        domain: MCP_DOMAIN,
        operation: "deleteToolGrantById",
        workspaceId,
        entityId: grantId,
        retryPayload: {
          entity: "mcp_tool_grants",
          action: "delete",
          workspaceId,
          serverId,
          grantId,
          userId,
        },
      },
      {
        mongo: async () => {
          const mongoUser = pgPrimary
            ? ((await this.resolveMongoUserIdForReverseSync(userId)) ?? userId)
            : userId;
          const deleted = await this.mongo.deleteToolGrantById(
            workspaceId,
            serverId,
            grantId,
            mongoUser,
          );
          if (!pgPrimary) {
            primaryDeleted = deleted;
          }
          return deleted;
        },
        pg: async () => {
          const deleted = await this.pg.deleteToolGrantById(
            workspaceId,
            serverId,
            grantId,
            userId,
          );
          if (recordTombstones && primaryDeleted) {
            await this.recordTombstone("mcp_tool_grants", grantId);
          }
          return deleted;
        },
      },
    );
  }
}
