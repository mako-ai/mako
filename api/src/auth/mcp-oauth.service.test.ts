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
  createAuthorizationCode,
  exchangeAuthorizationCode,
  listMcpConnections,
  mintMcpAccessTokenForUser,
  refreshAccessToken,
  registerOAuthClient,
  revokeMcpConnection,
  validateMcpAccessToken,
} from "./mcp-oauth.service";
import { up } from "../migrations/2026-09-06-230000_persistent_mcp_oauth_grants";

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
  "%s stays renewable after years of inactivity and remains revocable",
  async clientName => {
    const grant = await authorize(clientName);
    const original = await McpOAuthToken.findOne({
      clientId: grant.clientId,
    }).lean();
    expect(original?.refreshExpiresAt).toBeUndefined();
    expect(grant.expiresInSeconds).toBe(8 * 60 * 60);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    expect(await validateMcpAccessToken(grant.accessToken)).toBeNull();
    expect(await listMcpConnections("workspace")).toHaveLength(1);
    const renewed = await refreshAccessToken({
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
    });
    expect(await validateMcpAccessToken(renewed.accessToken)).toMatchObject({
      userId: "user",
      workspaceId: "workspace",
      scopes: ["mcp", "query:read"],
    });
    const stored = await McpOAuthToken.findOne({
      clientId: grant.clientId,
    }).lean();
    expect(stored?.refreshExpiresAt).toBeUndefined();
    expect(stored?._id).toEqual(original?._id);
    expect(stored?.createdAt).toEqual(original?.createdAt);
    await expect(
      refreshAccessToken({
        clientId: grant.clientId,
        refreshToken: grant.refreshToken,
      }),
    ).rejects.toThrow("invalid_grant");
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

it("refreshing a live legacy grant upgrades it without requiring migration first", async () => {
  const grant = await authorize();
  await McpOAuthToken.updateOne(
    { refreshTokenHash: hash(grant.refreshToken) },
    { $set: { refreshExpiresAt: new Date(Date.now() + 86_400_000) } },
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
    )?.refreshExpiresAt,
  ).toBeUndefined();
});
