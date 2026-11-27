/**
 * MCP OAuth grants: sliding refresh expiry, revocation, scope rules and
 * member removal. Runs on PGlite through the workspaces repo.
 */
import { createHash } from "node:crypto";
import { count, eq, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mcpOAuthTokens } from "../database/pg/schema";
import { workspaceRepo } from "../repositories/workspaces";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
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

const DAY = 24 * 60 * 60 * 1000;

let pgh: PgTestDb;
/** Wire id of the workspace every grant belongs to. */
let WS: string;
/** Postgres id of the seeded user "user" (grants report the UUID). */
let USER_UUID: string;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  pgh = await setupPgTestDb();
});
beforeEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await pgh.reset();
  USER_UUID = (await ensureTestUser(pgh.db, { id: "user" })).id;
  WS = (await ensureTestWorkspace(pgh.db)).id;
});
afterAll(async () => {
  vi.useRealTimers();
  await pgh.close();
});

async function tokenWhere(where: SQL) {
  const [row] = await pgh.db.select().from(mcpOAuthTokens).where(where);
  return row;
}
const tokenOf = (clientId: string) =>
  tokenWhere(eq(mcpOAuthTokens.clientId, clientId));
const tokenByRefresh = (refreshToken: string) =>
  tokenWhere(eq(mcpOAuthTokens.refreshTokenHash, hash(refreshToken)));
const patchToken = (
  where: SQL,
  patch: Partial<typeof mcpOAuthTokens.$inferInsert>,
) => pgh.db.update(mcpOAuthTokens).set(patch).where(where);

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
    workspaceId: WS,
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
    const original = await tokenOf(grant.clientId);
    const firstExpiry = original?.refreshExpiresAt?.getTime() ?? 0;
    expect(firstExpiry).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(firstExpiry).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect(grant.expiresInSeconds).toBe(8 * 60 * 60);

    // Used again after 29 days: still renewable, and the window slides.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 29 * DAY));
    expect(await validateMcpAccessToken(grant.accessToken)).toBeNull();
    expect(await listMcpConnections(WS)).toHaveLength(1);
    const renewed = await refreshAccessToken({
      clientId: grant.clientId,
      refreshToken: grant.refreshToken,
    });
    expect(await validateMcpAccessToken(renewed.accessToken)).toMatchObject({
      userId: USER_UUID,
      workspaceId: WS,
    });
    const stored = await tokenOf(grant.clientId);
    expect(stored?.refreshExpiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 29 * DAY,
    );
    expect(stored?.id).toEqual(original?.id);
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
        workspaceId: WS,
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
    expect(await listMcpConnections(WS)).toHaveLength(0);
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
  expect(await listMcpConnections(WS)).toHaveLength(0);
});

it("MCP_REFRESH_TOKEN_IDLE_DAYS=0 restores never-expiring grants", async () => {
  process.env.MCP_REFRESH_TOKEN_IDLE_DAYS = "0";
  try {
    const grant = await authorize();
    expect((await tokenOf(grant.clientId))?.refreshExpiresAt).toBeNull();
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
  const other = await ensureTestWorkspace(pgh.db);
  await patchToken(eq(mcpOAuthTokens.clientId, b.clientId), {
    workspaceId: other.uuid,
  });
  expect(
    await revokeMcpGrantsForMember({
      workspaceId: WS,
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
    .spyOn(workspaceRepo, "rotateMcpRefreshToken")
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
  const [{ n }] = await pgh.db.select({ n: count() }).from(mcpOAuthTokens);
  expect(n).toBe(1);
});

it("persistent grants stay live while expired ones and ACP grants keep their dates", async () => {
  const active = await authorize();
  const expired = await authorize();
  const acp = await mintMcpAccessTokenForUser({
    userId: "user",
    workspaceId: WS,
  });
  const past = new Date(Date.now() - 86_400_000);
  // The state the 2026-09 persistent-grant migration left behind.
  await patchToken(eq(mcpOAuthTokens.clientId, active.clientId), {
    refreshExpiresAt: null,
  });
  await patchToken(eq(mcpOAuthTokens.clientId, expired.clientId), {
    refreshExpiresAt: past,
  });
  expect((await tokenOf(active.clientId))?.refreshExpiresAt).toBeNull();
  expect(await validateMcpAccessToken(active.accessToken)).not.toBeNull();
  expect((await tokenOf(expired.clientId))?.refreshExpiresAt).toEqual(past);
  expect((await tokenOf(ACP_MCP_CLIENT_ID))?.refreshExpiresAt).toBeInstanceOf(
    Date,
  );
  expect(
    (await listMcpConnections(WS)).map(connection => connection.clientId),
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
});

it("refreshing a legacy never-expiring grant gives it the sliding expiry", async () => {
  const grant = await authorize();
  await patchToken(
    eq(mcpOAuthTokens.refreshTokenHash, hash(grant.refreshToken)),
    {
      refreshExpiresAt: null,
    },
  );
  const renewed = await refreshAccessToken({
    clientId: grant.clientId,
    refreshToken: grant.refreshToken,
  });
  expect(
    (await tokenByRefresh(renewed.refreshToken))?.refreshExpiresAt?.getTime(),
  ).toBeGreaterThan(Date.now() + 29 * DAY);
});

it("refresh never widens a grant beyond what was consented", async () => {
  const grant = await authorize();
  // A grant consented before `workflows:run` and `connections:write` existed.
  await patchToken(
    eq(mcpOAuthTokens.refreshTokenHash, hash(grant.refreshToken)),
    {
      scopes: ["mcp", "query:read", "warehouse:write"],
    },
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
  await patchToken(
    eq(mcpOAuthTokens.refreshTokenHash, hash(grant.refreshToken)),
    {
      scopes: ["mcp", "workflows:runtime"],
    },
  );
  const renewed = await refreshAccessToken({
    clientId: grant.clientId,
    refreshToken: grant.refreshToken,
  });
  expect(renewed.scopes).not.toContain("workflows:runtime");
});

it("workspaceService.removeMember revokes the member's MCP grants and API keys", async () => {
  const { workspaceService } = await import("../services/workspace.service");
  await ensureTestMember(pgh.db, { workspaceId: WS, userId: "user" });
  await ensureTestUser(pgh.db, { id: "owner" });
  for (const [name, createdBy] of [
    ["mine", "user"],
    ["theirs", "owner"],
  ] as const) {
    await workspaceRepo.createApiKey({
      workspaceId: WS,
      name,
      keyHash: `h-${name}`,
      prefix: `p-${name}`,
      createdBy,
    });
  }
  const grant = await authorize();

  expect(await workspaceService.removeMember(WS, "user")).toBe(true);
  expect(await validateMcpAccessToken(grant.accessToken)).toBeNull();
  expect((await workspaceRepo.listApiKeys(WS)).map(k => k.name)).toEqual([
    "theirs",
  ]);
});
