/**
 * "Chat with app" access: exactly the people who can open the live link, on
 * a published app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAppProject } from "../database/workspace-schema";

const resolveProjectRef = vi.fn();
const getMember = vi.fn();
const resolveAppRef = vi.fn();

vi.mock("./worktree.service", () => ({
  resolveProjectRef: (...args: unknown[]) => resolveProjectRef(...args),
  globFiles: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: { getMember: (...args: unknown[]) => getMember(...args) },
}));
vi.mock("./app-index.service", () => ({
  resolveAppRef: (...args: unknown[]) => resolveAppRef(...args),
}));
vi.mock("./deployment.service", () => ({ artifactStoreForRead: vi.fn() }));
vi.mock("./bindings.service", () => ({
  bindingArtifactKey: vi.fn(),
  readBindingsTolerant: vi.fn(),
}));

const {
  authorizeAppChat,
  isAppChatParquetDirectGcs,
  loadAppChatData,
  queryableTables,
} = await import("./app-chat.service");
const { artifactStoreForRead } = await import("./deployment.service");
const { bindingArtifactKey, readBindingsTolerant } =
  await import("./bindings.service");
const { liveViewerRedirect } = await import("./live-viewer-redirect");

const WS = "64b000000000000000000001";

function app(overrides: Partial<IAppProject> = {}): IAppProject {
  return {
    _id: { toString: () => "64b0000000000000000000aa" },
    workspaceId: { toString: () => WS },
    slug: "sales",
    title: "Sales",
    access: "workspace",
    workspaceRole: "viewer",
    owner_id: "owner",
    sharedWith: [],
    publishedSha: "abc123",
    chatEnabled: true,
    ...overrides,
  } as unknown as IAppProject;
}

describe("authorizeAppChat", () => {
  beforeEach(() => {
    resolveProjectRef.mockReset();
    getMember.mockReset();
    resolveAppRef.mockReset().mockResolvedValue({ title: "Sales report" });
  });

  it("lets a workspace member who can read the app chat with it", async () => {
    resolveProjectRef.mockResolvedValue(app());
    getMember.mockResolvedValue({ role: "viewer" });
    const result = await authorizeAppChat(WS, "sales", "u1");
    expect(result).toMatchObject({ ok: true, title: "Sales report" });
  });

  it("hides a private app from someone it is not shared with", async () => {
    resolveProjectRef.mockResolvedValue(app({ access: "private" }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("allows a private app's explicit collaborator", async () => {
    resolveProjectRef.mockResolvedValue(
      app({
        access: "private",
        sharedWith: [
          { userId: "u1", role: "viewer", addedAt: new Date() },
        ] as IAppProject["sharedWith"],
      }),
    );
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: true,
    });
  });

  it("refuses an unpublished app", async () => {
    resolveProjectRef.mockResolvedValue(app({ publishedSha: undefined }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("is off until the owner turns it on", async () => {
    resolveProjectRef.mockResolvedValue(app({ chatEnabled: undefined }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("refuses when the app's chat is turned off", async () => {
    resolveProjectRef.mockResolvedValue(app({ chatEnabled: false }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 403,
      error: "Chat is turned off for this app",
    });
  });

  it("404s an unknown app and 400s a missing id", async () => {
    resolveProjectRef.mockResolvedValue(null);
    expect(await authorizeAppChat(WS, "nope", "u1")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await authorizeAppChat(WS, "", "u1")).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("liveViewerRedirect", () => {
  const base = {
    fetchDest: "document",
    fetchMode: "navigate",
    workspaceId: WS,
    ref: "sales",
    path: `/api/workspaces/${WS}/apps/sales/live/`,
    url: `https://mako.test/api/workspaces/${WS}/apps/sales/live/?rep=Chich`,
  };

  it("sends a browser opening the link to the viewer page, query kept", () => {
    expect(liveViewerRedirect(base)).toBe(`/view/${WS}/sales?rep=Chich`);
    expect(
      liveViewerRedirect({
        ...base,
        path: `/api/workspaces/${WS}/apps/sales/live`,
        url: `https://mako.test/api/workspaces/${WS}/apps/sales/live`,
      }),
    ).toBe(`/view/${WS}/sales`);
  });

  it("serves the bundle's own requests, embeds and API clients", () => {
    expect(
      liveViewerRedirect({
        ...base,
        path: `/api/workspaces/${WS}/apps/sales/live/assets/index.js`,
      }),
    ).toBeNull();
    expect(liveViewerRedirect({ ...base, fetchDest: "iframe" })).toBeNull();
    expect(
      liveViewerRedirect({
        ...base,
        fetchDest: undefined,
        fetchMode: undefined,
      }),
    ).toBeNull();
  });

  it("honours ?raw=1", () => {
    expect(
      liveViewerRedirect({ ...base, url: `${base.url}&raw=1` }),
    ).toBeNull();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("loadAppChatData parquet mode", () => {
  const originalFlag = process.env.APP_CHAT_PARQUET_DIRECT_GCS;
  const originalHmacId = process.env.GCS_HMAC_KEY_ID;
  const originalHmacSecret = process.env.GCS_HMAC_SECRET;
  const originalCacheDir = process.env.APPS_CHAT_CACHE_DIR;

  function parquetBinding() {
    return {
      name: "orders",
      connectionId: "conn-1",
      materialization: "parquet" as const,
      code: "SELECT 1",
      sql: "SELECT 1",
    };
  }

  beforeEach(() => {
    delete process.env.APP_CHAT_PARQUET_DIRECT_GCS;
    delete process.env.GCS_HMAC_KEY_ID;
    delete process.env.GCS_HMAC_SECRET;
    process.env.APPS_CHAT_CACHE_DIR = `/tmp/mako-app-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    vi.mocked(bindingArtifactKey).mockReturnValue(
      "apps/bindings/conn-1/hash.parquet",
    );
    vi.mocked(readBindingsTolerant).mockResolvedValue({
      bindings: [parquetBinding()],
      skipped: [],
    });
  });

  afterEach(() => {
    restoreEnv("APP_CHAT_PARQUET_DIRECT_GCS", originalFlag);
    restoreEnv("GCS_HMAC_KEY_ID", originalHmacId);
    restoreEnv("GCS_HMAC_SECRET", originalHmacSecret);
    restoreEnv("APPS_CHAT_CACHE_DIR", originalCacheDir);
  });

  it("defaults the direct-GCS flag off", () => {
    expect(isAppChatParquetDirectGcs()).toBe(false);
  });

  it("copies from the artifact store when the flag is off", async () => {
    const { Readable } = await import("node:stream");
    const openReadStream = vi.fn(async () =>
      Readable.from([Buffer.from("PAR1")]),
    );
    const getSignedUrl = vi.fn();
    vi.mocked(artifactStoreForRead).mockResolvedValue({
      type: "gcs",
      getSize: async () => 4,
      getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
      openReadStream,
      getSignedUrl,
      exists: async () => true,
      put: async () => undefined,
      putBuffer: async () => undefined,
      delete: async () => undefined,
    });
    const data = await loadAppChatData(app());
    expect(data.parquetMode).toBe("copy");
    expect(data.cold).toBe(true);
    expect(openReadStream).toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(queryableTables(data)[0]?.file).toMatch(/\.parquet$/);
  });

  it("reads a signed https URL when the flag is on and the store is GCS", async () => {
    process.env.APP_CHAT_PARQUET_DIRECT_GCS = "1";
    expect(isAppChatParquetDirectGcs()).toBe(true);
    const openReadStream = vi.fn();
    const getSignedUrl = vi.fn(
      async () => "https://storage.example/obj.parquet?sig=1",
    );
    vi.mocked(artifactStoreForRead).mockResolvedValue({
      type: "gcs",
      getSize: async () => 1024,
      getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
      openReadStream,
      getSignedUrl,
      exists: async () => true,
      put: async () => undefined,
      putBuffer: async () => undefined,
      delete: async () => undefined,
      gcsObjectUri: (key: string) => `gs://artifacts/${key}`,
    });
    const data = await loadAppChatData(app());
    expect(data.parquetMode).toBe("direct");
    expect(data.gcsAuth).toBeUndefined();
    expect(openReadStream).not.toHaveBeenCalled();
    expect(getSignedUrl).toHaveBeenCalled();
    expect(queryableTables(data)[0]?.file).toBe(
      "https://storage.example/obj.parquet?sig=1",
    );
  });

  it("falls back to gs:// plus HMAC when signing fails", async () => {
    process.env.APP_CHAT_PARQUET_DIRECT_GCS = "1";
    process.env.GCS_HMAC_KEY_ID = "GOOG1ID";
    process.env.GCS_HMAC_SECRET = "hmac-secret";
    const getOauthAccessToken = vi.fn();
    vi.mocked(artifactStoreForRead).mockResolvedValue({
      type: "gcs",
      getSize: async () => 1024,
      getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
      openReadStream: vi.fn(),
      getSignedUrl: async () => {
        throw new Error("no signBlob");
      },
      exists: async () => true,
      put: async () => undefined,
      putBuffer: async () => undefined,
      delete: async () => undefined,
      gcsObjectUri: (key: string) => `gs://artifacts/${key}`,
      getOauthAccessToken,
    });
    const data = await loadAppChatData(app());
    expect(data.parquetMode).toBe("direct");
    expect(data.gcsAuth).toEqual({
      kind: "hmac",
      keyId: "GOOG1ID",
      secret: "hmac-secret",
    });
    expect(getOauthAccessToken).not.toHaveBeenCalled();
    expect(queryableTables(data)[0]?.file).toBe(
      "gs://artifacts/apps/bindings/conn-1/hash.parquet",
    );
  });

  it("mints an OAuth bearer token when HMAC keys are unset", async () => {
    process.env.APP_CHAT_PARQUET_DIRECT_GCS = "1";
    const getOauthAccessToken = vi.fn(async () => "ya29.token");
    vi.mocked(artifactStoreForRead).mockResolvedValue({
      type: "gcs",
      getSize: async () => 1024,
      getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
      openReadStream: vi.fn(),
      getSignedUrl: async () => null,
      exists: async () => true,
      put: async () => undefined,
      putBuffer: async () => undefined,
      delete: async () => undefined,
      gcsObjectUri: (key: string) => `gs://artifacts/${key}`,
      getOauthAccessToken,
    });
    const data = await loadAppChatData(app());
    expect(data.parquetMode).toBe("direct");
    expect(data.gcsAuth).toEqual({ kind: "bearer", token: "ya29.token" });
    expect(getOauthAccessToken).toHaveBeenCalled();
  });

  it("marks gs:// bindings unavailable when auth cannot be minted", async () => {
    process.env.APP_CHAT_PARQUET_DIRECT_GCS = "1";
    vi.mocked(artifactStoreForRead).mockResolvedValue({
      type: "gcs",
      getSize: async () => 1024,
      getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
      openReadStream: vi.fn(),
      getSignedUrl: async () => null,
      exists: async () => true,
      put: async () => undefined,
      putBuffer: async () => undefined,
      delete: async () => undefined,
      gcsObjectUri: (key: string) => `gs://artifacts/${key}`,
      getOauthAccessToken: async () => null,
    });
    const data = await loadAppChatData(app());
    expect(data.parquetMode).toBe("copy");
    expect(data.gcsAuth).toBeUndefined();
    expect(data.bindings[0]?.file).toBeNull();
    expect(data.bindings[0]?.unavailable).toMatch(/HMAC|OAuth/i);
    expect(queryableTables(data)).toEqual([]);
  });

  it("falls back to copy when some bindings are GCS and others are not", async () => {
    process.env.APP_CHAT_PARQUET_DIRECT_GCS = "1";
    const { Readable } = await import("node:stream");
    vi.mocked(readBindingsTolerant).mockResolvedValue({
      bindings: [
        parquetBinding(),
        {
          name: "regions",
          connectionId: "conn-2",
          materialization: "parquet" as const,
          code: "SELECT 2",
          sql: "SELECT 2",
        },
      ],
      skipped: [],
    });
    vi.mocked(bindingArtifactKey).mockImplementation(
      (binding: { connectionId?: string }) =>
        binding.connectionId === "conn-1"
          ? "apps/bindings/gcs.parquet"
          : "apps/bindings/fs.parquet",
    );
    vi.mocked(artifactStoreForRead).mockImplementation(async (key: string) => {
      if (key.includes("/gcs.parquet")) {
        return {
          type: "gcs" as const,
          getSize: async () => 1024,
          getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
          openReadStream: async () => Readable.from([Buffer.from("PAR1")]),
          getSignedUrl: async () => "https://storage.example/gcs.parquet?sig=1",
          exists: async () => true,
          put: async () => undefined,
          putBuffer: async () => undefined,
          delete: async () => undefined,
          gcsObjectUri: () => "gs://artifacts/apps/bindings/gcs.parquet",
        };
      }
      return {
        type: "filesystem" as const,
        getSize: async () => 4,
        getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
        openReadStream: async () => Readable.from([Buffer.from("PAR1")]),
        getSignedUrl: async () => null,
        exists: async () => true,
        put: async () => undefined,
        putBuffer: async () => undefined,
        delete: async () => undefined,
      };
    });
    const data = await loadAppChatData(app());
    expect(data.parquetMode).toBe("copy");
    expect(data.gcsAuth).toBeUndefined();
    expect(queryableTables(data)).toHaveLength(2);
    expect(queryableTables(data).every(t => t.file.endsWith(".parquet"))).toBe(
      true,
    );
    expect(queryableTables(data).some(t => t.file.startsWith("https://"))).toBe(
      false,
    );
  });

  it("keeps copy mode when the flag is on but the store is not GCS", async () => {
    process.env.APP_CHAT_PARQUET_DIRECT_GCS = "1";
    const { Readable } = await import("node:stream");
    const openReadStream = vi.fn(async () =>
      Readable.from([Buffer.from("PAR1")]),
    );
    vi.mocked(artifactStoreForRead).mockResolvedValue({
      type: "filesystem",
      getSize: async () => 4,
      getLastModified: async () => new Date("2026-01-01T00:00:00Z"),
      openReadStream,
      getSignedUrl: async () => null,
      exists: async () => true,
      put: async () => undefined,
      putBuffer: async () => undefined,
      delete: async () => undefined,
    });
    const data = await loadAppChatData(app());
    expect(data.parquetMode).toBe("copy");
    expect(openReadStream).toHaveBeenCalled();
  });
});
