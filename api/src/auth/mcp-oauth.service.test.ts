import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "../database/mcp-oauth-schema";
import {
  ACP_MCP_CLIENT_ID,
  MCP_OAUTH_SCOPES,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  listMcpConnections,
  mintMcpAccessTokenForUser,
  refreshAccessToken,
  registerOAuthClient,
  revokeMcpConnection,
  revokeMcpGrantsForMember,
  validateMcpAccessToken,
} from "./mcp-oauth.service";
import { up } from "../migrations/2026-09-06-230000_persistent_mcp_oauth_grants";
import { up as upIdleExpiry } from "../migrations/2026-11-14-120000_mcp_oauth_refresh_idle_expiry";

const DAY = 24 * 60 * 60 * 1000;

let mongo: MongoMemoryServer;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    instance: { args: ["--setParameter", "ttlMonitorEnabled=false"] },
  });
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    McpOAuthClient.init(),
    McpOAuthCode.init(),
    McpOAuthToken.init(),
  ]);
});
beforeEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all([
    McpOAuthClient.deleteMany({}),
    McpOAuthCode.deleteMany({}),
    McpOAuthToken.deleteMany({}),
  ]);
});
afterAll(async () => {
  vi.useRealTimers();
  await mongoose.disconnect();
  await mongo.stop();
});

async function authorize(clientName = "Mako CLI") {
  const redirectUri = "http://127.0.0.1/callback";
  const { clientId } = await registerOAuthClient({
    clientName,
    redirectUris: [redirectUri],
  });
  const verifier = "a".repeat(43);
  const code = await createAuthorizationCode({
    clientId,
    userId: "user",
    workspaceId: "workspace",
    redirectUri,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    scopes: ["mcp", "query:read"],
  });
  const tokens = await exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    codeVerifier: verifier,
  });
  return { clientId, ...tokens };
}

it.each(["Mako CLI", "External MCP client"])(
  "%s: the refresh token slides while used, lapses when idle, and is revocable",
  async clientName => {
    const grant = await authorize(clientName);
    const original = await McpOAuthToken.findOne({
      clientId: grant.clientId,
    }).lean();
    const firstExpiry = original?.refreshExpiresAt?.getTime() ?? 0;
    expect(firstExpiry).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(firstExpiry).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect(grant.expiresInSeconds).toBe(8 * 60 * 60);

    // Used again after 29 days: still renewable, and the window slides.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 29 * DAY));
    expect(await validateMcpAccessToken(grant.accessToken)).toBeNull();
    expect(await listMcpConnections("workspace")).toHaveLength(1);
    const renewed = await refreshAccessToken({
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
    });
    expect(await validateMcpAccessToken(renewed.accessToken)).toMatchObject({
      userId: "user",
      workspaceId: "workspace",
    });
    const stored = await McpOAuthToken.findOne({
      clientId: grant.clientId,
    }).lean();
    expect(stored?.refreshExpiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 29 * DAY,
    );
    expect(stored?._id).toEqual(original?._id);
    expect(stored?.createdAt).toEqual(original?.createdAt);
    // The consumed token is dead.
    await expect(
      refreshAccessToken({
        clientId: grant.clientId,
        refreshToken: grant.refreshToken,
      }),
    ).rejects.toThrow("invalid_grant");

    // Revocable at any time.
    expect(
      await revokeMcpConnection({
        workspaceId: "workspace",
        clientId: grant.clientId,
        userId: "user",
      }),
    ).toBe(1);
    expect(await validateMcpAccessToken(renewed.accessToken)).toBeNull();
    await expect(
      refreshAccessToken({
        clientId: grant.clientId,
        refreshToken: renewed.refreshToken,
      }),
    ).rejects.toThrow("invalid_grant");
    expect(await listMcpConnections("workspace")).toHaveLength(0);
  },
);

it("a refresh token left idle past the window cannot be used", async () => {
  const grant = await authorize();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 31 * DAY));
  await expect(
    refreshAccessToken({
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
    }),
  ).rejects.toThrow("invalid_grant");
  expect(await listMcpConnections("workspace")).toHaveLength(0);
});

it("MCP_REFRESH_TOKEN_IDLE_DAYS=0 restores never-expiring grants", async () => {
  process.env.MCP_REFRESH_TOKEN_IDLE_DAYS = "0";
  try {
    const grant = await authorize();
    expect(
      (await McpOAuthToken.findOne({ clientId: grant.clientId }).lean())
        ?.refreshExpiresAt,
    ).toBeUndefined();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    await expect(
      refreshAccessToken({
        clientId: grant.clientId,
        refreshToken: grant.refreshToken,
      }),
    ).resolves.toHaveProperty("accessToken");
  } finally {
    delete process.env.MCP_REFRESH_TOKEN_IDLE_DAYS;
  }
});

it("removing a member revokes every grant they hold in that workspace only", async () => {
  const a = await authorize("Client A");
  const b = await authorize("Client B");
  // The same user's grant in another workspace survives.
  await McpOAuthToken.updateOne(
    { clientId: b.clientId },
    { $set: { workspaceId: "other-workspace" } },
  );
  expect(
    await revokeMcpGrantsForMember({
      workspaceId: "workspace",
      userId: "user",
    }),
  ).toBe(1);
  expect(await validateMcpAccessToken(a.accessToken)).toBeNull();
  await expect(
    refreshAccessToken({ clientId: a.clientId, refreshToken: a.refreshToken }),
  ).rejects.toThrow("invalid_grant");
  expect(await validateMcpAccessToken(b.accessToken)).not.toBeNull();
});

it("a wrong client or failed rotation leaves the original grant usable", async () => {
  const grant = await authorize();
  await expect(
    refreshAccessToken({ clientId: "wrong", refreshToken: grant.refreshToken }),
  ).rejects.toThrow("invalid_grant");
  expect(await validateMcpAccessToken(grant.accessToken)).not.toBeNull();
  const write = vi
    .spyOn(McpOAuthToken, "findOneAndUpdate")
    .mockRejectedValueOnce(new Error("database unavailable"));
  await expect(
    refreshAccessToken({
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
    }),
  ).rejects.toThrow("database unavailable");
  write.mockRestore();
  expect(await validateMcpAccessToken(grant.accessToken)).not.toBeNull();
  await expect(
    refreshAccessToken({
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
    }),
  ).resolves.toHaveProperty("accessToken");
});

it("only one concurrent caller may consume a refresh token", async () => {
  const grant = await authorize();
  const attempts = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      refreshAccessToken({
        clientId: grant.clientId,
        refreshToken: grant.refreshToken,
      }),
    ),
  );
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(attempts.filter(result => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(await McpOAuthToken.countDocuments()).toBe(1);
});

it("migration preserves live logins without reviving expired grants or extending ACP", async () => {
  const active = await authorize();
  const expired = await authorize();
  const acp = await mintMcpAccessTokenForUser({
    userId: "user",
    workspaceId: "workspace",
  });
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  await McpOAuthToken.updateOne(
    { clientId: active.clientId },
    { $set: { refreshExpiresAt: future } },
  );
  await McpOAuthToken.updateOne(
    { clientId: expired.clientId },
    { $set: { refreshExpiresAt: past } },
  );
  const db = mongoose.connection.db;
  if (!db) throw new Error("Test database missing");
  await up(db);
  await up(db);
  expect(
    (await McpOAuthToken.findOne({ clientId: active.clientId }).lean())
      ?.refreshExpiresAt,
  ).toBeUndefined();
  expect(await validateMcpAccessToken(active.accessToken)).not.toBeNull();
  expect(
    (await McpOAuthToken.findOne({ clientId: expired.clientId }).lean())
      ?.refreshExpiresAt,
  ).toEqual(past);
  expect(
    (await McpOAuthToken.findOne({ clientId: ACP_MCP_CLIENT_ID }).lean())
      ?.refreshExpiresAt,
  ).toBeInstanceOf(Date);
  expect(
    (await listMcpConnections("workspace")).map(
      connection => connection.clientId,
    ),
  ).not.toContain(expired.clientId);
  await expect(
    refreshAccessToken({
      clientId: expired.clientId,
      refreshToken: expired.refreshToken,
    }),
  ).rejects.toThrow("invalid_grant");
  await expect(
    refreshAccessToken({
      clientId: ACP_MCP_CLIENT_ID,
      refreshToken: acp.refreshToken,
    }),
  ).rejects.toThrow("session-minted");
  // The existing TTL index ignores persistent grants because they have no date.
  expect(
    (await McpOAuthToken.collection.indexes()).find(
      index => index.key.refreshExpiresAt === 1,
    )?.expireAfterSeconds,
  ).toBe(0);
});

it("refreshing a legacy never-expiring grant gives it the sliding expiry", async () => {
  const grant = await authorize();
  await McpOAuthToken.updateOne(
    { refreshTokenHash: hash(grant.refreshToken) },
    { $unset: { refreshExpiresAt: "" } },
  );
  const renewed = await refreshAccessToken({
    clientId: grant.clientId,
    refreshToken: grant.refreshToken,
  });
  expect(
    (
      await McpOAuthToken.findOne({
        refreshTokenHash: hash(renewed.refreshToken),
      }).lean()
    )?.refreshExpiresAt?.getTime(),
  ).toBeGreaterThan(Date.now() + 29 * DAY);
});

it("the idle-expiry migration dates legacy grants without touching dated or ACP ones", async () => {
  const legacy = await authorize();
  const dated = await authorize();
  await mintMcpAccessTokenForUser({ userId: "user", workspaceId: "workspace" });
  await McpOAuthToken.updateOne(
    { clientId: legacy.clientId },
    { $unset: { refreshExpiresAt: "" } },
  );
  const datedBefore = (
    await McpOAuthToken.findOne({ clientId: dated.clientId }).lean()
  )?.refreshExpiresAt;
  const acpBefore = (
    await McpOAuthToken.findOne({ clientId: ACP_MCP_CLIENT_ID }).lean()
  )?.refreshExpiresAt;
  const db = mongoose.connection.db;
  if (!db) throw new Error("Test database missing");
  await upIdleExpiry(db);
  await upIdleExpiry(db);
  expect(
    (
      await McpOAuthToken.findOne({ clientId: legacy.clientId }).lean()
    )?.refreshExpiresAt?.getTime(),
  ).toBeGreaterThan(Date.now() + 29 * DAY);
  expect(
    (await McpOAuthToken.findOne({ clientId: dated.clientId }).lean())
      ?.refreshExpiresAt,
  ).toEqual(datedBefore);
  expect(
    (await McpOAuthToken.findOne({ clientId: ACP_MCP_CLIENT_ID }).lean())
      ?.refreshExpiresAt,
  ).toEqual(acpBefore);
});

it("refresh never widens a grant beyond what was consented", async () => {
  const grant = await authorize();
  // A grant consented before `workflows:run` and `connections:write` existed.
  await McpOAuthToken.updateOne(
    { refreshTokenHash: hash(grant.refreshToken) },
    { $set: { scopes: ["mcp", "query:read", "warehouse:write"] } },
  );
  const renewed = await refreshAccessToken({
    clientId: grant.clientId,
    refreshToken: grant.refreshToken,
  });
  expect([...renewed.scopes].sort()).toEqual(
    ["mcp", "query:read", "warehouse:write"].sort(),
  );
  const validated = await validateMcpAccessToken(renewed.accessToken);
  expect(validated?.scopes).not.toContain("workflows:run");
  expect(validated?.scopes).not.toContain("connections:write");
  expect(MCP_OAUTH_SCOPES).toContain("workflows:run");
});

it("refresh never adds or keeps internal scopes", async () => {
  const grant = await authorize();
  await McpOAuthToken.updateOne(
    { refreshTokenHash: hash(grant.refreshToken) },
    { $set: { scopes: ["mcp", "workflows:runtime"] } },
  );
  const renewed = await refreshAccessToken({
    clientId: grant.clientId,
    refreshToken: grant.refreshToken,
  });
  expect(renewed.scopes).not.toContain("workflows:runtime");
});

it("workspaceService.removeMember revokes the member's MCP grants and API keys", async () => {
  const { Workspace, WorkspaceMember } =
    await import("../database/workspace-schema");
  const { workspaceService } = await import("../services/workspace.service");
  const workspaceId = new mongoose.Types.ObjectId();
  await Workspace.collection.insertOne({
    _id: workspaceId,
    name: "ws",
    apiKeys: [
      { name: "mine", keyHash: "h1", prefix: "p1", createdBy: "user" },
      { name: "theirs", keyHash: "h2", prefix: "p2", createdBy: "owner" },
    ],
  });
  await WorkspaceMember.collection.insertOne({
    workspaceId,
    userId: "user",
    role: "member",
  });
  const grant = await authorize();
  await McpOAuthToken.updateMany(
    {},
    { $set: { workspaceId: String(workspaceId) } },
  );

  expect(await workspaceService.removeMember(String(workspaceId), "user")).toBe(
    true,
  );
  expect(await validateMcpAccessToken(grant.accessToken)).toBeNull();
  const ws = await Workspace.collection.findOne({ _id: workspaceId });
  expect((ws?.apiKeys as Array<{ name: string }>).map(k => k.name)).toEqual([
    "theirs",
  ]);
});
