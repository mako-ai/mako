/**
 * Postgres (Neon / Drizzle) implementation of `McpRepository`.
 *
 * Key invariants:
 *   - Bijective UUIDv8 PKs/FKs (`parseEntityId` / `newDualId` / `toWireId`).
 *   - `mcp_connection_configs.user_id` & `mcp_oauth_flows.config_user_id` use SQL `NULL`
 *     for workspace-shared credentials (`UNIQUE NULLS NOT DISTINCT (server_id, user_id)`).
 *   - `mcp_oauth_flows` reads enforce the mandatory 10-minute SQL TTL guard
 *     (`created_at > $cutoff`) in addition to the hourly `migration-pg-ttl-reaper`.
 *   - All 4 encrypted columns are written/read verbatim as opaque ciphertext.
 */
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isUuidString,
  newDualId,
  parseEntityId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  mcpConnectionConfigs,
  mcpOauthFlows,
  mcpServers,
  mcpToolGrants,
} from "../../database/pg/schema/mcp";
import {
  mcpConnectionConfigRecordToPgInsert,
  mcpOAuthFlowRecordToPgInsert,
  mcpServerRecordToPgInsert,
  mcpToolGrantRecordToPgInsert,
  normalizeConfigUserId,
  pgMcpConnectionConfigToRecord,
  pgMcpOAuthFlowToRecord,
  pgMcpServerToRecord,
  pgMcpToolGrantToRecord,
} from "./mapper";
import {
  isDuplicateServerNameError,
  MCP_OAUTH_FLOW_TTL_MS,
  MCP_SERVER_WIDE_GRANT_TOOL,
  McpDuplicateServerNameError,
  type CreateMcpServerInput,
  type McpConnectionConfigRecord,
  type McpOAuthFlowRecord,
  type McpRepository,
  type McpServerRecord,
  type McpToolGrantRecord,
  type UpdateMcpServerPatch,
  type UpsertMcpCredentialsInput,
  type UpsertMcpOAuthFlowInput,
  type UpsertMcpOAuthTokensInput,
  type UpsertMcpToolGrantInput,
} from "./types";

function parseUuidOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return parseEntityId(raw)?.uuid ?? null;
}

export class PgMcpRepository implements McpRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  /**
   * Resolve a user identifier (UUIDv7 or legacy 15-char Lucia ID / UUIDv4)
   * against `users(id, legacy_id)`.
   */
  async resolveUserUuid(
    idOrLegacyId: string | null | undefined,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const normalized = normalizeConfigUserId(idOrLegacyId);
    if (!normalized || normalized === "system") return null;

    const whereClause = isUuidString(normalized)
      ? or(
          eq(users.id, normalized.toLowerCase()),
          eq(users.legacyId, normalized),
        )
      : eq(users.legacyId, normalized);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(whereClause)
      .limit(1);
    if (rows[0]) return rows[0].id.toLowerCase();
    return null;
  }

  private async resolveRequiredUserUuid(
    userId: string,
    db: MakoPgDb,
  ): Promise<string> {
    const resolved = await this.resolveUserUuid(userId, db);
    if (resolved) return resolved;
    if (isUuidString(userId)) return userId.toLowerCase();
    throw new Error(
      `Cannot resolve userId ${JSON.stringify(userId)} to a Postgres user UUID`,
    );
  }

  // ── Servers ──────────────────────────────────────────────────────────────

  async listServersByWorkspace(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpServerRecord[]> {
    const wsUuid = parseUuidOrNull(workspaceId);
    if (!wsUuid) return [];
    const rows = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.workspaceId, wsUuid))
      .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
    return rows.map(pgMcpServerToRecord);
  }

  async listActiveConnectedServers(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpServerRecord[]> {
    const wsUuid = parseUuidOrNull(workspaceId);
    if (!wsUuid) return [];
    const rows = await db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.workspaceId, wsUuid),
          eq(mcpServers.isActive, true),
          eq(mcpServers.status, "connected"),
        ),
      )
      .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
    return rows.map(pgMcpServerToRecord);
  }

  async findServerById(
    serverId: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpServerRecord | null> {
    const serverUuid = parseUuidOrNull(serverId);
    if (!serverUuid) return null;
    const conditions = [eq(mcpServers.id, serverUuid)];
    if (workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(workspaceId);
      if (!wsUuid) return null;
      conditions.push(eq(mcpServers.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(mcpServers)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? pgMcpServerToRecord(rows[0]) : null;
  }

  async createServer(
    input: CreateMcpServerInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpServerRecord> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    if (!wsUuid) {
      throw new Error(
        `Invalid workspaceId: ${JSON.stringify(input.workspaceId)}`,
      );
    }
    const idUuid = input.id ? parseUuidOrNull(input.id) : newDualId().uuid;
    if (!idUuid) {
      throw new Error(`Invalid server id: ${JSON.stringify(input.id)}`);
    }
    const createdByUuid = await this.resolveUserUuid(input.createdBy, db);
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;

    try {
      const [row] = await db
        .insert(mcpServers)
        .values({
          id: idUuid,
          workspaceId: wsUuid,
          name: input.name,
          description: input.description ?? null,
          connectorType: input.connectorType,
          transportType: input.transport.type,
          transportUrl: input.transport.url,
          authType: input.authType,
          authPerformer: input.authPerformer,
          writeScope: input.writeScope,
          toolPolicyDefaultRestriction:
            input.toolPolicy?.defaultRestriction ?? "always",
          toolPolicyRestrictions: input.toolPolicy?.restrictions ?? {},
          cachedTools: input.cachedTools ?? [],
          oauthClientInformationEncrypted:
            input.oauthClientInformationEncrypted ?? null,
          status: input.status ?? "created",
          lastError: input.lastError ?? null,
          lastConnectedAt: input.lastConnectedAt ?? null,
          createdBy: createdByUuid,
          isActive: input.isActive ?? true,
          createdAt: now,
          updatedAt,
        })
        .returning();
      return pgMcpServerToRecord(row);
    } catch (error) {
      if (isDuplicateServerNameError(error)) {
        throw new McpDuplicateServerNameError(input.name);
      }
      throw error;
    }
  }

  async updateServer(
    workspaceId: string,
    serverId: string,
    patch: UpdateMcpServerPatch,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpServerRecord | null> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const serverUuid = parseUuidOrNull(serverId);
    if (!wsUuid || !serverUuid) return null;

    const setValues: Record<string, unknown> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };

    if (patch.name !== undefined) setValues.name = patch.name;
    if (patch.description !== undefined) {
      setValues.description = patch.description;
    }
    if (patch.transport !== undefined) {
      setValues.transportType = patch.transport.type;
      setValues.transportUrl = patch.transport.url;
    }
    if (patch.writeScope !== undefined) setValues.writeScope = patch.writeScope;
    if (patch.isActive !== undefined) setValues.isActive = patch.isActive;
    if (patch.toolPolicy !== undefined) {
      if (patch.toolPolicy.defaultRestriction !== undefined) {
        setValues.toolPolicyDefaultRestriction =
          patch.toolPolicy.defaultRestriction;
      }
      if (patch.toolPolicy.restrictions !== undefined) {
        setValues.toolPolicyRestrictions = patch.toolPolicy.restrictions;
      }
    }
    if (patch.cachedTools !== undefined) {
      setValues.cachedTools = patch.cachedTools;
    }
    if (patch.oauthClientInformationEncrypted !== undefined) {
      setValues.oauthClientInformationEncrypted =
        patch.oauthClientInformationEncrypted;
    }
    if (patch.status !== undefined) setValues.status = patch.status;
    if (patch.lastError !== undefined) setValues.lastError = patch.lastError;
    if (patch.lastConnectedAt !== undefined) {
      setValues.lastConnectedAt = patch.lastConnectedAt;
    }

    try {
      const rows = await db
        .update(mcpServers)
        .set(setValues)
        .where(
          and(
            eq(mcpServers.id, serverUuid),
            eq(mcpServers.workspaceId, wsUuid),
          ),
        )
        .returning();
      return rows[0] ? pgMcpServerToRecord(rows[0]) : null;
    } catch (error) {
      if (isDuplicateServerNameError(error)) {
        throw new McpDuplicateServerNameError(patch.name);
      }
      throw error;
    }
  }

  /** Idempotent backfill/dual-write upsert guarded by `updated_at`. */
  async upsertServerWithGuard(
    record: McpServerRecord,
    createdByUuid: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = parseUuidOrNull(record.id);
    const wsUuid = parseUuidOrNull(record.workspaceId);
    if (!idUuid || !wsUuid) return false;

    const row = mcpServerRecordToPgInsert(record, {
      idUuid,
      workspaceUuid: wsUuid,
      createdByUuid,
    });
    const inserted = await db
      .insert(mcpServers)
      .values(row)
      .onConflictDoUpdate({
        target: mcpServers.id,
        set: {
          name: row.name,
          description: row.description,
          connectorType: row.connectorType,
          transportType: row.transportType,
          transportUrl: row.transportUrl,
          authType: row.authType,
          authPerformer: row.authPerformer,
          writeScope: row.writeScope,
          toolPolicyDefaultRestriction: row.toolPolicyDefaultRestriction,
          toolPolicyRestrictions: row.toolPolicyRestrictions,
          cachedTools: row.cachedTools,
          oauthClientInformationEncrypted: row.oauthClientInformationEncrypted,
          status: row.status,
          lastError: row.lastError,
          lastConnectedAt: row.lastConnectedAt,
          createdBy: row.createdBy,
          isActive: row.isActive,
          updatedAt: row.updatedAt,
        },
        setWhere: sql`${mcpServers.updatedAt} IS NULL OR EXCLUDED.updated_at >= ${mcpServers.updatedAt}`,
      })
      .returning({ id: mcpServers.id });
    return inserted.length > 0;
  }

  async deleteServerCascade(
    workspaceId: string,
    serverId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const serverUuid = parseUuidOrNull(serverId);
    if (!wsUuid || !serverUuid) return false;
    // ON DELETE CASCADE automatically deletes configs, oauth_flows, and tool_grants.
    const rows = await db
      .delete(mcpServers)
      .where(
        and(eq(mcpServers.id, serverUuid), eq(mcpServers.workspaceId, wsUuid)),
      )
      .returning({ id: mcpServers.id });
    return rows.length > 0;
  }

  // ── Connection configs ───────────────────────────────────────────────────

  async listConnectionConfigsByServerIds(
    workspaceId: string,
    serverIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<McpConnectionConfigRecord[]> {
    const wsUuid = parseUuidOrNull(workspaceId);
    if (!wsUuid || serverIds.length === 0) return [];
    const serverUuids = serverIds
      .map(parseUuidOrNull)
      .filter((u): u is string => u !== null);
    if (serverUuids.length === 0) return [];
    const rows = await db
      .select()
      .from(mcpConnectionConfigs)
      .where(
        and(
          eq(mcpConnectionConfigs.workspaceId, wsUuid),
          inArray(mcpConnectionConfigs.serverId, serverUuids),
        ),
      )
      .orderBy(asc(mcpConnectionConfigs.id));
    return rows.map(pgMcpConnectionConfigToRecord);
  }

  async listConnectionConfigsForUser(
    workspaceId: string,
    serverIds: readonly string[],
    userId: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpConnectionConfigRecord[]> {
    const wsUuid = parseUuidOrNull(workspaceId);
    if (!wsUuid || serverIds.length === 0) return [];
    const serverUuids = serverIds
      .map(parseUuidOrNull)
      .filter((u): u is string => u !== null);
    if (serverUuids.length === 0) return [];

    const normalizedUser = normalizeConfigUserId(userId);
    const userUuid =
      normalizedUser === null
        ? null
        : await this.resolveUserUuid(normalizedUser, db);
    const userCondition = userUuid
      ? or(
          isNull(mcpConnectionConfigs.userId),
          eq(mcpConnectionConfigs.userId, userUuid),
        )
      : isNull(mcpConnectionConfigs.userId);

    const rows = await db
      .select()
      .from(mcpConnectionConfigs)
      .where(
        and(
          eq(mcpConnectionConfigs.workspaceId, wsUuid),
          inArray(mcpConnectionConfigs.serverId, serverUuids),
          userCondition,
        ),
      )
      .orderBy(asc(mcpConnectionConfigs.id));
    return rows.map(pgMcpConnectionConfigToRecord);
  }

  async findConnectionConfig(
    workspaceId: string,
    serverId: string,
    userId: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpConnectionConfigRecord | null> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const serverUuid = parseUuidOrNull(serverId);
    if (!wsUuid || !serverUuid) return null;

    const normalizedUser = normalizeConfigUserId(userId);
    let userCondition;
    if (normalizedUser === null) {
      userCondition = isNull(mcpConnectionConfigs.userId);
    } else {
      const userUuid = await this.resolveUserUuid(normalizedUser, db);
      if (!userUuid) return null;
      userCondition = eq(mcpConnectionConfigs.userId, userUuid);
    }

    const rows = await db
      .select()
      .from(mcpConnectionConfigs)
      .where(
        and(
          eq(mcpConnectionConfigs.workspaceId, wsUuid),
          eq(mcpConnectionConfigs.serverId, serverUuid),
          userCondition,
        ),
      )
      .limit(1);
    return rows[0] ? pgMcpConnectionConfigToRecord(rows[0]) : null;
  }

  async upsertConnectionCredentials(
    input: UpsertMcpCredentialsInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpConnectionConfigRecord> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    const serverUuid = parseUuidOrNull(input.serverId);
    if (!wsUuid || !serverUuid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const normalizedUser = normalizeConfigUserId(input.userId);
    const userUuid =
      normalizedUser === null
        ? null
        : await this.resolveRequiredUserUuid(normalizedUser, db);
    const now = input.now ?? new Date();
    const idUuid = input.id ? parseUuidOrNull(input.id) : newDualId().uuid;
    if (!idUuid) {
      throw new Error(`Invalid id: ${JSON.stringify(input.id)}`);
    }

    const [row] = await db
      .insert(mcpConnectionConfigs)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        serverId: serverUuid,
        userId: userUuid,
        headersEncrypted: input.headersEncrypted,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpConnectionConfigs.serverId, mcpConnectionConfigs.userId],
        set: {
          workspaceId: wsUuid,
          headersEncrypted: input.headersEncrypted,
          updatedAt: now,
        },
      })
      .returning();
    return pgMcpConnectionConfigToRecord(row);
  }

  async upsertConnectionOAuthTokens(
    input: UpsertMcpOAuthTokensInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpConnectionConfigRecord> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    const serverUuid = parseUuidOrNull(input.serverId);
    if (!wsUuid || !serverUuid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const normalizedUser = normalizeConfigUserId(input.userId);
    const userUuid =
      normalizedUser === null
        ? null
        : await this.resolveRequiredUserUuid(normalizedUser, db);
    const now = input.now ?? new Date();
    const idUuid = input.id ? parseUuidOrNull(input.id) : newDualId().uuid;
    if (!idUuid) {
      throw new Error(`Invalid id: ${JSON.stringify(input.id)}`);
    }
    const expiresAt =
      input.oauthExpiresAt != null ? new Date(input.oauthExpiresAt) : null;

    const [row] = await db
      .insert(mcpConnectionConfigs)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        serverId: serverUuid,
        userId: userUuid,
        headersEncrypted: {},
        oauthTokensEncrypted: input.oauthTokensEncrypted,
        oauthExpiresAt: expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpConnectionConfigs.serverId, mcpConnectionConfigs.userId],
        set: {
          workspaceId: wsUuid,
          oauthTokensEncrypted: input.oauthTokensEncrypted,
          oauthExpiresAt: expiresAt,
          updatedAt: now,
        },
      })
      .returning();
    return pgMcpConnectionConfigToRecord(row);
  }

  /** Idempotent backfill upsert guarded by `updated_at`. */
  async upsertConnectionConfigWithGuard(
    record: McpConnectionConfigRecord,
    userUuid: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = parseUuidOrNull(record.id);
    const wsUuid = parseUuidOrNull(record.workspaceId);
    const serverUuid = parseUuidOrNull(record.serverId);
    if (!idUuid || !wsUuid || !serverUuid) return false;

    const row = mcpConnectionConfigRecordToPgInsert(record, {
      idUuid,
      workspaceUuid: wsUuid,
      serverUuid,
      userUuid,
    });
    const inserted = await db
      .insert(mcpConnectionConfigs)
      .values(row)
      .onConflictDoUpdate({
        target: [mcpConnectionConfigs.serverId, mcpConnectionConfigs.userId],
        set: {
          headersEncrypted: row.headersEncrypted,
          oauthTokensEncrypted: row.oauthTokensEncrypted,
          oauthExpiresAt: row.oauthExpiresAt,
          updatedAt: row.updatedAt,
        },
        setWhere: sql`${mcpConnectionConfigs.updatedAt} IS NULL OR EXCLUDED.updated_at >= ${mcpConnectionConfigs.updatedAt}`,
      })
      .returning({ id: mcpConnectionConfigs.id });
    return inserted.length > 0;
  }

  async clearServerOAuthTokens(
    workspaceId: string,
    serverId: string,
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const serverUuid = parseUuidOrNull(serverId);
    if (!wsUuid || !serverUuid) return;
    await db
      .update(mcpConnectionConfigs)
      .set({
        oauthTokensEncrypted: null,
        oauthExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(mcpConnectionConfigs.workspaceId, wsUuid),
          eq(mcpConnectionConfigs.serverId, serverUuid),
        ),
      );
  }

  // ── OAuth flows (10-minute read-time SQL guard) ──────────────────────────

  async upsertOAuthFlow(
    input: UpsertMcpOAuthFlowInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpOAuthFlowRecord> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    const serverUuid = parseUuidOrNull(input.serverId);
    if (!wsUuid || !serverUuid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const normalizedConfigUser = normalizeConfigUserId(input.configUserId);
    const configUserUuid =
      normalizedConfigUser === null
        ? null
        : await this.resolveRequiredUserUuid(normalizedConfigUser, db);
    const startedByUserUuid = await this.resolveRequiredUserUuid(
      input.startedByUserId,
      db,
    );
    const idUuid = input.id ? parseUuidOrNull(input.id) : newDualId().uuid;
    if (!idUuid) {
      throw new Error(`Invalid oauth flow id: ${JSON.stringify(input.id)}`);
    }
    const createdAt = input.createdAt ?? new Date();

    const rowData = mcpOAuthFlowRecordToPgInsert(
      {
        id: input.id ?? "",
        state: input.state,
        workspaceId: input.workspaceId,
        serverId: input.serverId,
        configUserId: normalizedConfigUser,
        startedByUserId: input.startedByUserId,
        codeVerifierEncrypted: input.codeVerifierEncrypted,
        createdAt,
      },
      {
        idUuid,
        workspaceUuid: wsUuid,
        serverUuid,
        configUserUuid,
        startedByUserUuid,
      },
    );

    const [row] = await db
      .insert(mcpOauthFlows)
      .values(rowData)
      .onConflictDoUpdate({
        target: mcpOauthFlows.state,
        set: {
          workspaceId: rowData.workspaceId,
          serverId: rowData.serverId,
          configUserId: rowData.configUserId,
          codeVerifierEncrypted: rowData.codeVerifierEncrypted,
        },
      })
      .returning();
    return pgMcpOAuthFlowToRecord(row);
  }

  async findOAuthFlowByState(
    state: string,
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<McpOAuthFlowRecord | null> {
    const cutoff = new Date(now.getTime() - MCP_OAUTH_FLOW_TTL_MS);
    const rows = await db
      .select()
      .from(mcpOauthFlows)
      .where(
        and(
          eq(mcpOauthFlows.state, state),
          gt(mcpOauthFlows.createdAt, cutoff),
        ),
      )
      .limit(1);
    return rows[0] ? pgMcpOAuthFlowToRecord(rows[0]) : null;
  }

  async findOAuthFlowById(
    flowId: string,
    workspaceId?: string,
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<McpOAuthFlowRecord | null> {
    const idUuid = parseUuidOrNull(flowId);
    if (!idUuid) return null;
    const cutoff = new Date(now.getTime() - MCP_OAUTH_FLOW_TTL_MS);
    const conditions = [
      eq(mcpOauthFlows.id, idUuid),
      gt(mcpOauthFlows.createdAt, cutoff),
    ];
    if (workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(workspaceId);
      if (!wsUuid) return null;
      conditions.push(eq(mcpOauthFlows.workspaceId, wsUuid));
    }
    const rows = await db
      .select()
      .from(mcpOauthFlows)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? pgMcpOAuthFlowToRecord(rows[0]) : null;
  }

  async deleteOAuthFlowById(
    flowId: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = parseUuidOrNull(flowId);
    if (!idUuid) return false;
    const conditions = [eq(mcpOauthFlows.id, idUuid)];
    if (workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(workspaceId);
      if (!wsUuid) return false;
      conditions.push(eq(mcpOauthFlows.workspaceId, wsUuid));
    }
    const rows = await db
      .delete(mcpOauthFlows)
      .where(and(...conditions))
      .returning({ id: mcpOauthFlows.id });
    return rows.length > 0;
  }

  async isSameUser(
    userIdA: string | null | undefined,
    userIdB: string | null | undefined,
    db: MakoPgDb = this.getDb(),
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
    const [uuidA, uuidB] = await Promise.all([
      this.resolveUserUuid(a, db),
      this.resolveUserUuid(b, db),
    ]);
    return Boolean(uuidA && uuidB && uuidA === uuidB);
  }

  // ── Tool grants ──────────────────────────────────────────────────────────

  async listToolGrantsForUser(
    workspaceId: string,
    serverId: string,
    userId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpToolGrantRecord[]> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const serverUuid = parseUuidOrNull(serverId);
    if (!wsUuid || !serverUuid) return [];
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) return [];

    const rows = await db
      .select()
      .from(mcpToolGrants)
      .where(
        and(
          eq(mcpToolGrants.workspaceId, wsUuid),
          eq(mcpToolGrants.serverId, serverUuid),
          eq(mcpToolGrants.userId, userUuid),
        ),
      )
      .orderBy(asc(mcpToolGrants.id));
    return rows.map(pgMcpToolGrantToRecord);
  }

  async findToolGrantsForResolution(
    params: {
      serverId: string;
      userId: string;
      toolName: string;
      workspaceId?: string;
    },
    db: MakoPgDb = this.getDb(),
  ): Promise<McpToolGrantRecord[]> {
    const serverUuid = parseUuidOrNull(params.serverId);
    if (!serverUuid || !params.userId) return [];
    const userUuid = await this.resolveUserUuid(params.userId, db);
    if (!userUuid) return [];

    const conditions = [
      eq(mcpToolGrants.serverId, serverUuid),
      eq(mcpToolGrants.userId, userUuid),
      inArray(mcpToolGrants.toolName, [
        params.toolName,
        MCP_SERVER_WIDE_GRANT_TOOL,
      ]),
    ];
    if (params.workspaceId !== undefined) {
      const wsUuid = parseUuidOrNull(params.workspaceId);
      if (!wsUuid) return [];
      conditions.push(eq(mcpToolGrants.workspaceId, wsUuid));
    }

    const rows = await db
      .select()
      .from(mcpToolGrants)
      .where(and(...conditions))
      .orderBy(asc(mcpToolGrants.id));
    return rows.map(pgMcpToolGrantToRecord);
  }

  async upsertToolGrant(
    input: UpsertMcpToolGrantInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<McpToolGrantRecord> {
    const wsUuid = parseUuidOrNull(input.workspaceId);
    const serverUuid = parseUuidOrNull(input.serverId);
    if (!wsUuid || !serverUuid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const userUuid = await this.resolveRequiredUserUuid(input.userId, db);
    const now = input.now ?? new Date();
    const idUuid = input.id ? parseUuidOrNull(input.id) : newDualId().uuid;
    if (!idUuid) {
      throw new Error(`Invalid id: ${JSON.stringify(input.id)}`);
    }

    const [row] = await db
      .insert(mcpToolGrants)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        serverId: serverUuid,
        userId: userUuid,
        toolName: input.toolName,
        decision: input.decision,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          mcpToolGrants.serverId,
          mcpToolGrants.userId,
          mcpToolGrants.toolName,
        ],
        set: {
          workspaceId: wsUuid,
          decision: input.decision,
          updatedAt: now,
        },
      })
      .returning();
    return pgMcpToolGrantToRecord(row);
  }

  async upsertToolGrantWithGuard(
    record: McpToolGrantRecord,
    userUuid: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = parseUuidOrNull(record.id);
    const wsUuid = parseUuidOrNull(record.workspaceId);
    const serverUuid = parseUuidOrNull(record.serverId);
    if (!idUuid || !wsUuid || !serverUuid) return false;

    const row = mcpToolGrantRecordToPgInsert(record, {
      idUuid,
      workspaceUuid: wsUuid,
      serverUuid,
      userUuid,
    });
    const inserted = await db
      .insert(mcpToolGrants)
      .values(row)
      .onConflictDoUpdate({
        target: [
          mcpToolGrants.serverId,
          mcpToolGrants.userId,
          mcpToolGrants.toolName,
        ],
        set: {
          decision: row.decision,
          lastUsedAt: row.lastUsedAt,
          updatedAt: row.updatedAt,
        },
        setWhere: sql`${mcpToolGrants.updatedAt} IS NULL OR EXCLUDED.updated_at >= ${mcpToolGrants.updatedAt}`,
      })
      .returning({ id: mcpToolGrants.id });
    return inserted.length > 0;
  }

  async touchToolGrantLastUsed(
    params: {
      workspaceId: string;
      serverId: string;
      userId: string;
      toolName: string;
      at?: Date;
    },
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = parseUuidOrNull(params.workspaceId);
    const serverUuid = parseUuidOrNull(params.serverId);
    if (!wsUuid || !serverUuid) return;
    const userUuid = await this.resolveUserUuid(params.userId, db);
    if (!userUuid) return;
    await db
      .update(mcpToolGrants)
      .set({ lastUsedAt: params.at ?? new Date() })
      .where(
        and(
          eq(mcpToolGrants.workspaceId, wsUuid),
          eq(mcpToolGrants.serverId, serverUuid),
          eq(mcpToolGrants.userId, userUuid),
          eq(mcpToolGrants.toolName, params.toolName),
        ),
      );
  }

  async deleteToolGrantById(
    workspaceId: string,
    serverId: string,
    grantId: string,
    userId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const wsUuid = parseUuidOrNull(workspaceId);
    const serverUuid = parseUuidOrNull(serverId);
    const grantUuid = parseUuidOrNull(grantId);
    if (!wsUuid || !serverUuid || !grantUuid) return false;
    const userUuid = await this.resolveUserUuid(userId, db);
    if (!userUuid) return false;

    const rows = await db
      .delete(mcpToolGrants)
      .where(
        and(
          eq(mcpToolGrants.id, grantUuid),
          eq(mcpToolGrants.workspaceId, wsUuid),
          eq(mcpToolGrants.serverId, serverUuid),
          eq(mcpToolGrants.userId, userUuid),
        ),
      )
      .returning({ id: mcpToolGrants.id });
    return rows.length > 0;
  }
}
