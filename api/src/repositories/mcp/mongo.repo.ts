/**
 * MongoDB (Mongoose) implementation of `McpRepository`.
 */
import { Types } from "mongoose";
import {
  MCP_SERVER_WIDE_GRANT_TOOL,
  McpConnectionConfig,
  McpOAuthFlow,
  McpServer,
  McpToolGrant,
} from "../../database/models/mcp";
import { parseEntityId } from "../../database/pg/id-codec";
import {
  mongoMcpConnectionConfigToRecord,
  mongoMcpOAuthFlowToRecord,
  mongoMcpServerToRecord,
  mongoMcpToolGrantToRecord,
  normalizeConfigUserId,
  type MongoMcpConnectionConfigLike,
  type MongoMcpOAuthFlowLike,
  type MongoMcpServerLike,
  type MongoMcpToolGrantLike,
} from "./mapper";
import {
  isDuplicateServerNameError,
  MCP_OAUTH_FLOW_TTL_MS,
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

function toObjectId(id: string | null | undefined): Types.ObjectId | null {
  if (!id) return null;
  const oid = parseEntityId(id)?.oid;
  return oid ? new Types.ObjectId(oid) : null;
}

function toInsertObjectId(id: string | undefined): Types.ObjectId {
  return id ? (toObjectId(id) ?? new Types.ObjectId()) : new Types.ObjectId();
}

export class MongoMcpRepository implements McpRepository {
  // ── Servers ──────────────────────────────────────────────────────────────

  async listServersByWorkspace(
    workspaceId: string,
  ): Promise<McpServerRecord[]> {
    const wsOid = toObjectId(workspaceId);
    if (!wsOid) return [];
    const docs = await McpServer.find({ workspaceId: wsOid })
      .sort({ createdAt: 1, _id: 1 })
      .lean<MongoMcpServerLike[]>();
    return docs.map(mongoMcpServerToRecord);
  }

  async listActiveConnectedServers(
    workspaceId: string,
  ): Promise<McpServerRecord[]> {
    const wsOid = toObjectId(workspaceId);
    if (!wsOid) return [];
    const docs = await McpServer.find({
      workspaceId: wsOid,
      isActive: true,
      status: "connected",
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean<MongoMcpServerLike[]>();
    return docs.map(mongoMcpServerToRecord);
  }

  async findServerById(
    serverId: string,
    workspaceId?: string,
  ): Promise<McpServerRecord | null> {
    const idOid = toObjectId(serverId);
    if (!idOid) return null;
    const filter: Record<string, unknown> = { _id: idOid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectId(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = await McpServer.findOne(
      filter,
    ).lean<MongoMcpServerLike | null>();
    return doc ? mongoMcpServerToRecord(doc) : null;
  }

  async createServer(input: CreateMcpServerInput): Promise<McpServerRecord> {
    const wsOid = toObjectId(input.workspaceId);
    if (!wsOid) {
      throw new Error(
        `Invalid workspaceId: ${JSON.stringify(input.workspaceId)}`,
      );
    }
    const _id = toInsertObjectId(input.id);
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;
    const docData: Record<string, unknown> = {
      _id,
      workspaceId: wsOid,
      name: input.name,
      ...(input.description != null ? { description: input.description } : {}),
      connectorType: input.connectorType,
      transport: input.transport,
      authType: input.authType,
      authPerformer: input.authPerformer,
      writeScope: input.writeScope,
      toolPolicy: input.toolPolicy ?? {
        defaultRestriction: "always",
        restrictions: {},
      },
      cachedTools: input.cachedTools ?? [],
      ...(input.oauthClientInformationEncrypted != null
        ? {
            oauth: { clientInformation: input.oauthClientInformationEncrypted },
          }
        : {}),
      status: input.status ?? "created",
      ...(input.lastError != null ? { lastError: input.lastError } : {}),
      ...(input.lastConnectedAt != null
        ? { lastConnectedAt: input.lastConnectedAt }
        : {}),
      createdBy: input.createdBy ?? "system",
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt,
    };

    try {
      const created = new McpServer(docData);
      await created.save({ timestamps: false });
      return mongoMcpServerToRecord(
        created.toObject() as unknown as MongoMcpServerLike,
      );
    } catch (error) {
      if (isDuplicateServerNameError(error)) {
        throw new McpDuplicateServerNameError(input.name);
      }
      throw error;
    }
  }

  /** Idempotent full-record upsert used by Stage 4 PG->Mongo reverse sync & sync-retry. */
  async upsertFullServer(record: McpServerRecord): Promise<void> {
    const idOid = toObjectId(record.id);
    const wsOid = toObjectId(record.workspaceId);
    if (!idOid || !wsOid) return;

    const $set: Record<string, unknown> = {
      workspaceId: wsOid,
      name: record.name,
      connectorType: record.connectorType,
      transport: record.transport,
      authType: record.authType,
      authPerformer: record.authPerformer,
      writeScope: record.writeScope,
      toolPolicy: record.toolPolicy,
      cachedTools: record.cachedTools,
      status: record.status,
      createdBy: record.createdBy ?? "system",
      isActive: record.isActive,
      updatedAt: record.updatedAt,
    };
    const $unset: Record<string, string> = {};

    if (record.description !== null) $set.description = record.description;
    else $unset.description = "";
    if (record.oauthClientInformationEncrypted !== null) {
      $set.oauth = {
        clientInformation: record.oauthClientInformationEncrypted,
      };
    } else {
      $unset.oauth = "";
    }
    if (record.lastError !== null) $set.lastError = record.lastError;
    else $unset.lastError = "";
    if (record.lastConnectedAt !== null) {
      $set.lastConnectedAt = record.lastConnectedAt;
    } else {
      $unset.lastConnectedAt = "";
    }

    const update: Record<string, unknown> = {
      $set,
      $setOnInsert: { createdAt: record.createdAt },
    };
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    await McpServer.updateOne({ _id: idOid }, update, {
      upsert: true,
      timestamps: false,
    });
  }

  async updateServer(
    workspaceId: string,
    serverId: string,
    patch: UpdateMcpServerPatch,
  ): Promise<McpServerRecord | null> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(serverId);
    if (!wsOid || !idOid) return null;

    const $set: Record<string, unknown> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };
    const $unset: Record<string, string> = {};

    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.description !== undefined) {
      if (patch.description === null) $unset.description = "";
      else $set.description = patch.description;
    }
    if (patch.transport !== undefined) $set.transport = patch.transport;
    if (patch.writeScope !== undefined) $set.writeScope = patch.writeScope;
    if (patch.isActive !== undefined) $set.isActive = patch.isActive;
    if (patch.toolPolicy !== undefined) {
      if (patch.toolPolicy.defaultRestriction !== undefined) {
        $set["toolPolicy.defaultRestriction"] =
          patch.toolPolicy.defaultRestriction;
      }
      if (patch.toolPolicy.restrictions !== undefined) {
        $set["toolPolicy.restrictions"] = patch.toolPolicy.restrictions;
      }
    }
    if (patch.cachedTools !== undefined) $set.cachedTools = patch.cachedTools;
    if (patch.oauthClientInformationEncrypted !== undefined) {
      if (patch.oauthClientInformationEncrypted === null) {
        $unset["oauth.clientInformation"] = "";
      } else {
        $set["oauth.clientInformation"] = patch.oauthClientInformationEncrypted;
      }
    }
    if (patch.status !== undefined) $set.status = patch.status;
    if (patch.lastError !== undefined) {
      if (patch.lastError === null) $unset.lastError = "";
      else $set.lastError = patch.lastError;
    }
    if (patch.lastConnectedAt !== undefined) {
      if (patch.lastConnectedAt === null) $unset.lastConnectedAt = "";
      else $set.lastConnectedAt = patch.lastConnectedAt;
    }

    const update: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    try {
      const updated = await McpServer.findOneAndUpdate(
        { _id: idOid, workspaceId: wsOid },
        update,
        { returnDocument: "after", timestamps: false },
      ).lean<MongoMcpServerLike | null>();
      return updated ? mongoMcpServerToRecord(updated) : null;
    } catch (error) {
      if (isDuplicateServerNameError(error)) {
        throw new McpDuplicateServerNameError(patch.name);
      }
      throw error;
    }
  }

  async deleteServerCascade(
    workspaceId: string,
    serverId: string,
  ): Promise<boolean> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(serverId);
    if (!wsOid || !idOid) return false;

    const existing = await McpServer.findOne({
      _id: idOid,
      workspaceId: wsOid,
    })
      .select("_id")
      .lean();
    if (!existing) return false;

    await Promise.all([
      McpConnectionConfig.deleteMany({ serverId: idOid }),
      McpOAuthFlow.deleteMany({ serverId: idOid }),
      McpToolGrant.deleteMany({ serverId: idOid }),
      McpServer.deleteOne({ _id: idOid, workspaceId: wsOid }),
    ]);
    return true;
  }

  // ── Connection configs ───────────────────────────────────────────────────

  async listConnectionConfigsByServerIds(
    workspaceId: string,
    serverIds: readonly string[],
  ): Promise<McpConnectionConfigRecord[]> {
    const wsOid = toObjectId(workspaceId);
    if (!wsOid || serverIds.length === 0) return [];
    const serverOids = serverIds
      .map(toObjectId)
      .filter((o): o is Types.ObjectId => o !== null);
    if (serverOids.length === 0) return [];
    const docs = await McpConnectionConfig.find({
      workspaceId: wsOid,
      serverId: { $in: serverOids },
    })
      .sort({ _id: 1 })
      .lean<MongoMcpConnectionConfigLike[]>();
    return docs.map(mongoMcpConnectionConfigToRecord);
  }

  async findConnectionConfig(
    workspaceId: string,
    serverId: string,
    userId: string | null,
  ): Promise<McpConnectionConfigRecord | null> {
    const wsOid = toObjectId(workspaceId);
    const serverOid = toObjectId(serverId);
    if (!wsOid || !serverOid) return null;
    const mongoUserId = normalizeConfigUserId(userId) ?? "";
    const doc = await McpConnectionConfig.findOne({
      workspaceId: wsOid,
      serverId: serverOid,
      userId: mongoUserId,
    }).lean<MongoMcpConnectionConfigLike | null>();
    return doc ? mongoMcpConnectionConfigToRecord(doc) : null;
  }

  async upsertConnectionCredentials(
    input: UpsertMcpCredentialsInput,
  ): Promise<McpConnectionConfigRecord> {
    const wsOid = toObjectId(input.workspaceId);
    const serverOid = toObjectId(input.serverId);
    if (!wsOid || !serverOid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const mongoUserId = normalizeConfigUserId(input.userId) ?? "";
    const now = input.now ?? new Date();
    const idOid = toInsertObjectId(input.id);

    const doc = await McpConnectionConfig.findOneAndUpdate(
      { serverId: serverOid, userId: mongoUserId },
      {
        $set: {
          workspaceId: wsOid,
          headers: input.headersEncrypted,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: idOid,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after", timestamps: false },
    ).lean<MongoMcpConnectionConfigLike>();
    return mongoMcpConnectionConfigToRecord(doc);
  }

  async upsertConnectionOAuthTokens(
    input: UpsertMcpOAuthTokensInput,
  ): Promise<McpConnectionConfigRecord> {
    const wsOid = toObjectId(input.workspaceId);
    const serverOid = toObjectId(input.serverId);
    if (!wsOid || !serverOid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const mongoUserId = normalizeConfigUserId(input.userId) ?? "";
    const now = input.now ?? new Date();
    const idOid = toInsertObjectId(input.id);

    const $set: Record<string, unknown> = {
      workspaceId: wsOid,
      oauthTokens: input.oauthTokensEncrypted,
      updatedAt: now,
    };
    const $unset: Record<string, string> = {};
    if (input.oauthExpiresAt != null) {
      $set.oauthExpiresAt = input.oauthExpiresAt;
    } else {
      $unset.oauthExpiresAt = "";
    }

    const update: Record<string, unknown> = {
      $set,
      $setOnInsert: { _id: idOid, headers: {}, createdAt: now },
    };
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    const doc = await McpConnectionConfig.findOneAndUpdate(
      { serverId: serverOid, userId: mongoUserId },
      update,
      { upsert: true, returnDocument: "after", timestamps: false },
    ).lean<MongoMcpConnectionConfigLike>();
    return mongoMcpConnectionConfigToRecord(doc);
  }

  async upsertFullConnectionConfig(
    record: McpConnectionConfigRecord,
  ): Promise<void> {
    const idOid = toObjectId(record.id);
    const wsOid = toObjectId(record.workspaceId);
    const serverOid = toObjectId(record.serverId);
    if (!idOid || !wsOid || !serverOid) return;
    const mongoUserId = normalizeConfigUserId(record.userId) ?? "";

    const $set: Record<string, unknown> = {
      workspaceId: wsOid,
      headers: record.headersEncrypted,
      updatedAt: record.updatedAt,
    };
    const $unset: Record<string, string> = {};
    if (record.oauthTokensEncrypted !== null) {
      $set.oauthTokens = record.oauthTokensEncrypted;
    } else {
      $unset.oauthTokens = "";
    }
    if (record.oauthExpiresAt !== null) {
      $set.oauthExpiresAt = record.oauthExpiresAt;
    } else {
      $unset.oauthExpiresAt = "";
    }

    const update: Record<string, unknown> = {
      $set,
      $setOnInsert: { _id: idOid, createdAt: record.createdAt },
    };
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    await McpConnectionConfig.updateOne(
      { serverId: serverOid, userId: mongoUserId },
      update,
      { upsert: true, timestamps: false },
    );
  }

  async clearServerOAuthTokens(
    workspaceId: string,
    serverId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const wsOid = toObjectId(workspaceId);
    const serverOid = toObjectId(serverId);
    if (!wsOid || !serverOid) return;
    await McpConnectionConfig.updateMany(
      { workspaceId: wsOid, serverId: serverOid },
      {
        $set: { updatedAt: now },
        $unset: { oauthTokens: "", oauthExpiresAt: "" },
      },
      { timestamps: false },
    );
  }

  // ── OAuth flows ──────────────────────────────────────────────────────────

  async upsertOAuthFlow(
    input: UpsertMcpOAuthFlowInput,
  ): Promise<McpOAuthFlowRecord> {
    const wsOid = toObjectId(input.workspaceId);
    const serverOid = toObjectId(input.serverId);
    if (!wsOid || !serverOid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const idOid = toInsertObjectId(input.id);
    const mongoConfigUserId = normalizeConfigUserId(input.configUserId) ?? "";
    const createdAt = input.createdAt ?? new Date();

    const $set: Record<string, unknown> = {
      workspaceId: wsOid,
      serverId: serverOid,
      configUserId: mongoConfigUserId,
    };
    if (input.codeVerifierEncrypted !== null) {
      $set.codeVerifier = input.codeVerifierEncrypted;
    }

    const doc = await McpOAuthFlow.findOneAndUpdate(
      { state: input.state },
      {
        $set,
        $setOnInsert: {
          _id: idOid,
          startedByUserId: input.startedByUserId,
          createdAt,
        },
      },
      { upsert: true, returnDocument: "after" },
    ).lean<MongoMcpOAuthFlowLike>();
    return mongoMcpOAuthFlowToRecord(doc);
  }

  async findOAuthFlowByState(
    state: string,
    now: Date = new Date(),
  ): Promise<McpOAuthFlowRecord | null> {
    const cutoff = new Date(now.getTime() - MCP_OAUTH_FLOW_TTL_MS);
    const doc = await McpOAuthFlow.findOne({
      state,
      createdAt: { $gt: cutoff },
    }).lean<MongoMcpOAuthFlowLike | null>();
    return doc ? mongoMcpOAuthFlowToRecord(doc) : null;
  }

  async findOAuthFlowById(
    flowId: string,
    workspaceId?: string,
    now: Date = new Date(),
  ): Promise<McpOAuthFlowRecord | null> {
    const idOid = toObjectId(flowId);
    if (!idOid) return null;
    const cutoff = new Date(now.getTime() - MCP_OAUTH_FLOW_TTL_MS);
    const filter: Record<string, unknown> = {
      _id: idOid,
      createdAt: { $gt: cutoff },
    };
    if (workspaceId !== undefined) {
      const wsOid = toObjectId(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = await McpOAuthFlow.findOne(
      filter,
    ).lean<MongoMcpOAuthFlowLike | null>();
    return doc ? mongoMcpOAuthFlowToRecord(doc) : null;
  }

  async deleteOAuthFlowById(
    flowId: string,
    workspaceId?: string,
  ): Promise<boolean> {
    const idOid = toObjectId(flowId);
    if (!idOid) return false;
    const filter: Record<string, unknown> = { _id: idOid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectId(workspaceId);
      if (!wsOid) return false;
      filter.workspaceId = wsOid;
    }
    const res = await McpOAuthFlow.deleteOne(filter);
    return res.deletedCount > 0;
  }

  // ── Tool grants ──────────────────────────────────────────────────────────

  async listToolGrantsForUser(
    workspaceId: string,
    serverId: string,
    userId: string,
  ): Promise<McpToolGrantRecord[]> {
    const wsOid = toObjectId(workspaceId);
    const serverOid = toObjectId(serverId);
    if (!wsOid || !serverOid) return [];
    const docs = await McpToolGrant.find({
      workspaceId: wsOid,
      serverId: serverOid,
      userId,
    })
      .sort({ _id: 1 })
      .lean<MongoMcpToolGrantLike[]>();
    return docs.map(mongoMcpToolGrantToRecord);
  }

  async findToolGrantsForResolution(params: {
    serverId: string;
    userId: string;
    toolName: string;
    workspaceId?: string;
  }): Promise<McpToolGrantRecord[]> {
    const serverOid = toObjectId(params.serverId);
    if (!serverOid || !params.userId) return [];
    const filter: Record<string, unknown> = {
      serverId: serverOid,
      userId: params.userId,
      toolName: { $in: [params.toolName, MCP_SERVER_WIDE_GRANT_TOOL] },
    };
    if (params.workspaceId !== undefined) {
      const wsOid = toObjectId(params.workspaceId);
      if (!wsOid) return [];
      filter.workspaceId = wsOid;
    }
    const docs = await McpToolGrant.find(filter)
      .sort({ _id: 1 })
      .lean<MongoMcpToolGrantLike[]>();
    return docs.map(mongoMcpToolGrantToRecord);
  }

  async upsertToolGrant(
    input: UpsertMcpToolGrantInput,
  ): Promise<McpToolGrantRecord> {
    const wsOid = toObjectId(input.workspaceId);
    const serverOid = toObjectId(input.serverId);
    if (!wsOid || !serverOid) {
      throw new Error("Invalid workspaceId or serverId");
    }
    const now = input.now ?? new Date();
    const idOid = toInsertObjectId(input.id);

    const doc = await McpToolGrant.findOneAndUpdate(
      { serverId: serverOid, userId: input.userId, toolName: input.toolName },
      {
        $set: {
          workspaceId: wsOid,
          decision: input.decision,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: idOid,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after", timestamps: false },
    ).lean<MongoMcpToolGrantLike>();
    return mongoMcpToolGrantToRecord(doc);
  }

  async upsertFullToolGrant(record: McpToolGrantRecord): Promise<void> {
    const idOid = toObjectId(record.id);
    const wsOid = toObjectId(record.workspaceId);
    const serverOid = toObjectId(record.serverId);
    if (!idOid || !wsOid || !serverOid) return;

    const $set: Record<string, unknown> = {
      workspaceId: wsOid,
      decision: record.decision,
      updatedAt: record.updatedAt,
    };
    if (record.lastUsedAt !== null) {
      $set.lastUsedAt = record.lastUsedAt;
    }

    await McpToolGrant.updateOne(
      { serverId: serverOid, userId: record.userId, toolName: record.toolName },
      {
        $set,
        $setOnInsert: { _id: idOid, createdAt: record.createdAt },
      },
      { upsert: true, timestamps: false },
    );
  }

  async touchToolGrantLastUsed(params: {
    workspaceId: string;
    serverId: string;
    userId: string;
    toolName: string;
    at?: Date;
  }): Promise<void> {
    const serverOid = toObjectId(params.serverId);
    if (!serverOid) return;
    await McpToolGrant.updateOne(
      {
        serverId: serverOid,
        userId: params.userId,
        toolName: params.toolName,
      },
      { $set: { lastUsedAt: params.at ?? new Date() } },
      { timestamps: false },
    );
  }

  async deleteToolGrantById(
    workspaceId: string,
    serverId: string,
    grantId: string,
    userId: string,
  ): Promise<boolean> {
    const wsOid = toObjectId(workspaceId);
    const serverOid = toObjectId(serverId);
    const grantOid = toObjectId(grantId);
    if (!wsOid || !serverOid || !grantOid) return false;
    const res = await McpToolGrant.deleteOne({
      _id: grantOid,
      workspaceId: wsOid,
      serverId: serverOid,
      userId,
    });
    return res.deletedCount > 0;
  }
}
