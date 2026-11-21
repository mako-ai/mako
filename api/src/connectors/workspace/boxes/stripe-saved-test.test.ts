import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SourceConnection } from "../../../database/workspace-schema";
import {
  getRequestContext,
  requestContextStorage,
} from "../../../logging/context";
import { sourceConnectionVerificationRoutes } from "../../../routes/source-connections/verification";
import { getArtifactStore } from "../../../services/artifact-store.service";
import { syncConnectorRegistry } from "../../../sync/connector-registry";
import { StripeConnector } from "../../stripe/connector";
import { SandboxedConnector } from "../SandboxedConnector";
import { withVersion } from "../registry/publish";
import { clearRegistryCatalogCache } from "../registry/registry.service";
import {
  emptyCatalog,
  registryBundleKey,
  writeCatalog,
  writeRegistryArtifacts,
} from "../registry/store";

const { state, resetState } = vi.hoisted(() => {
  const initialState = () => ({
    pinned: false,
    pinOverride: null as { version?: string; sha256?: string } | null,
    ownership: true,
    reloads: 0,
    decrypts: 0,
    specRuns: 0,
    verified: [] as string[],
    checks: [] as Array<{
      id: string;
      workspace: string;
      type: string;
      digest: string;
      actor?: string;
    }>,
    nativeChecks: 0,
    workspaceLookups: 0,
    rowOverride: {} as Record<string, unknown>,
  });
  const state = initialState();
  return { state, resetState: () => Object.assign(state, initialState()) };
});

const workspaceId = "64abc123123456789abcdef0";
const connectionId = "64def123123456789abcdef0";
const bundle = "export default 1;\n";
const bytes = Buffer.from(bundle);
const digest = createHash("sha256").update(bytes).digest("hex");
const hash = "a".repeat(64);
const saved = {
  _id: new ObjectId(connectionId),
  workspaceId: new ObjectId(workspaceId),
  type: "stripe",
  name: "Synthetic Stripe connection",
  config: { api_key: "cipher:synthetic" },
  isActive: true,
  settings: {},
};

vi.mock("../registry/stripe-release", async original => ({
  ...(await original<typeof import("../registry/stripe-release")>()),
  stripeTestReleasePin: () =>
    state.pinOverride ??
    (state.pinned ? { version: "1.0.0", sha256: digest } : {}),
}));

vi.mock("./scheduler", () => ({
  getBoxScheduler: () => ({
    withLease: async (
      _request: unknown,
      callback: (lease: unknown) => Promise<unknown>,
    ) =>
      callback({
        ctx: { sessionKey: "connector-sync:synthetic" },
        fresh: true,
        markFailed: vi.fn(),
        markUnhealthy: vi.fn(),
      }),
  }),
}));

vi.mock("../resolver", async original => ({
  ...(await original<typeof import("../resolver")>()),
  ensureConnectorRuntime: async () => "synthetic-runtime",
  loadConnectorDefinition: async () => {
    state.workspaceLookups++;
    throw new Error("Saved Stripe Test must not load a workspace connector");
  },
}));

vi.mock("../sync-box", async original => {
  const actual = await original<typeof import("../sync-box")>();
  return {
    ...actual,
    installConnectorBundle: async ({
      expectedSha256,
      load,
    }: Parameters<typeof actual.installConnectorBundle>[0]) => {
      expect(expectedSha256).toBe(digest);
      state.verified.push(Buffer.from(await load()).toString());
      return { dir: "/synthetic", entry: "bundle.mjs" };
    },
    runConnectorCommand: async (
      input: Parameters<typeof actual.runConnectorCommand>[0],
    ) => {
      expect(input.command).toBe("spec");
      expect(input).not.toHaveProperty("config");
      state.specRuns++;
      return {
        exitCode: 0,
        timedOut: false,
        stderr: "",
        malformed: [],
        messages: [
          {
            type: "SPEC",
            spec: {
              connectionSpecification: {
                properties: {
                  api_key: { type: "string", airbyte_secret: true },
                },
              },
              mako: { entities: { customers: {} } },
            },
          },
        ],
      };
    },
  };
});

vi.mock("../../../services/crypto.service", async original => ({
  ...(await original<typeof import("../../../services/crypto.service")>()),
  decryptEncrypted: () => {
    state.decrypts++;
    return "synthetic-secret";
  },
}));

vi.mock("../../../services/database-connection.service", () => ({
  databaseConnectionService: {
    getMainConnection: async () => ({
      db: {
        collection: () => ({
          findOne: async (query: unknown) => {
            if (state.pinned) {
              expect(query).toEqual({
                _id: saved._id,
                workspaceId: saved.workspaceId,
                type: saved.type,
              });
              expect(state.verified).toEqual([bundle]);
              expect(state.specRuns).toBe(1);
            }
            state.reloads++;
            return { ...saved, ...state.rowOverride };
          },
        }),
      },
    }),
  },
}));

const app = new Hono();
app.route(
  "/workspaces/:workspaceId/connections",
  sourceConnectionVerificationRoutes,
);

function callTest(workspace = workspaceId, connection = connectionId) {
  return app.request(
    `/workspaces/${workspace}/connections/${connection}/test`,
    {
      method: "POST",
    },
  );
}

let artifactDir: string;

beforeAll(async () => {
  artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "stripe-saved-test-"));
  vi.stubEnv("DASHBOARD_ARTIFACT_DIR", artifactDir);
  vi.stubEnv("DASHBOARD_ARTIFACT_STORE", "filesystem");
  vi.stubEnv("CONNECTOR_REGISTRY_BUCKET", "");
  vi.stubEnv("DATABASE_URL", "mongodb://127.0.0.1/synthetic");
  await writeRegistryArtifacts({
    slug: "stripe",
    hash,
    bundle: bytes,
    source: {
      slug: "stripe",
      version: "1.0.0",
      hash,
      entry: "connector.ts",
      files: {},
    },
  });
  await writeCatalog(
    withVersion(emptyCatalog(), {
      slug: "stripe",
      name: "stripe",
      versions: [
        {
          version: "1.0.0",
          hash,
          sha256: digest,
          bytes: bytes.length,
          sdkVersion: "0.1.0",
          entry: "connector.ts",
          entities: ["customers"],
          authType: "api_key",
          publishedAt: "2026-11-16T00:00:00.000Z",
        },
      ],
    }),
  );
  clearRegistryCatalogCache();
});

afterAll(async () => {
  clearRegistryCatalogCache();
  vi.unstubAllEnvs();
  await fs.rm(artifactDir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetState();
  await getArtifactStore().putBuffer(
    bytes,
    registryBundleKey("stripe", hash),
    "application/javascript",
  );
  vi.spyOn(SourceConnection, "findOne").mockImplementation((query: unknown) => {
    const filter = query as { _id: unknown; workspaceId: string };
    expect(new ObjectId(String(filter._id))).toEqual(saved._id);
    expect(new ObjectId(filter.workspaceId)).toEqual(saved.workspaceId);
    return {
      lean: async () =>
        state.ownership ? { _id: saved._id, type: saved.type } : null,
    } as never;
  });
  syncConnectorRegistry.register({
    type: "stripe",
    connectorClass: StripeConnector,
    metadata: {
      name: "Stripe",
      version: "1",
      description: "Synthetic",
      supportedEntities: [],
    },
  });
  vi.spyOn(
    StripeConnector.prototype as unknown as { getStripeClient: () => unknown },
    "getStripeClient",
  ).mockImplementation(() => ({
    accounts: {
      retrieve: async () => {
        state.nativeChecks++;
        return {};
      },
    },
  }));
  vi.spyOn(
    SandboxedConnector.prototype as unknown as {
      run: (...args: unknown[]) => Promise<unknown>;
    },
    "run",
  ).mockImplementation(async function (
    this: SandboxedConnector,
    command: unknown,
    options: unknown,
  ) {
    expect(command).toBe("check");
    expect(options).toMatchObject({
      config: {
        api_key: "synthetic-secret",
        __connection_id: connectionId,
        __workspace_id: workspaceId,
      },
    });
    const source = (
      this as unknown as {
        sourceConnection: {
          _id: unknown;
          workspaceId: unknown;
          type: string;
        };
      }
    ).sourceConnection;
    state.checks.push({
      id: String(source._id),
      workspace: String(source.workspaceId),
      type: source.type,
      digest: await this.sourceShaForConnectionCheck(),
      actor: getRequestContext()?.workflow,
    });
    return {
      exitCode: 0,
      timedOut: false,
      stderr: "",
      malformed: [],
      messages: [
        {
          type: "CONNECTION_STATUS",
          connectionStatus: { status: "SUCCEEDED", message: "ok" },
        },
      ],
    };
  });
});

afterEach(() => vi.restoreAllMocks());

describe("saved Stripe Test with a synthetic registry", () => {
  it("keeps the native route for no pin", async () => {
    const result = await callTest();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data: { success: true } });
    expect(state.nativeChecks).toBe(1);
    expect(state.reloads).toBe(1);
    expect(state.decrypts).toBe(1);
    expect(state.verified).toEqual([]);
    expect(state.specRuns).toBe(0);
    expect(state.checks).toEqual([]);
  });

  it.each([
    ["canonical", workspaceId, connectionId],
    ["uppercase", workspaceId.toUpperCase(), connectionId.toUpperCase()],
  ])(
    "preserves stored identity and actor with %s path IDs",
    async (_format, workspace, connection) => {
      state.pinned = true;
      const before = JSON.stringify(saved);
      const result = await requestContextStorage.run(
        {
          requestId: "r",
          method: "POST",
          path: "/",
          startTime: 0,
          workflow: "synthetic-actor",
        },
        () => callTest(workspace, connection),
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ data: { success: true } });
      expect(state.verified).toEqual([bundle]);
      expect(state.specRuns).toBe(1);
      expect(state.reloads).toBe(1);
      expect(state.decrypts).toBe(1);
      expect(state.checks).toEqual([
        {
          id: connectionId,
          workspace: workspaceId,
          type: "stripe",
          digest,
          actor: "synthetic-actor",
        },
      ]);
      expect(JSON.stringify(saved)).toBe(before);
      expect(state.nativeChecks).toBe(0);
      expect(state.workspaceLookups).toBe(0);
    },
  );

  it.each([
    ["partial pin", { version: "1.0.0" }],
    ["wrong digest", { version: "1.0.0", sha256: "b".repeat(64) }],
    ["missing release", { version: "2.0.0", sha256: digest }],
  ])("rejects a %s before credential access", async (_label, pin) => {
    state.pinOverride = pin;
    expect((await callTest()).status).toBeGreaterThanOrEqual(400);
    expect(state.reloads).toBe(0);
    expect(state.decrypts).toBe(0);
    expect(state.specRuns).toBe(0);
    expect(state.checks).toEqual([]);
    expect(state.nativeChecks).toBe(0);
    expect(state.workspaceLookups).toBe(0);
  });

  it("rejects bad bytes before reload, decrypt, spec or check", async () => {
    state.pinned = true;
    await getArtifactStore().putBuffer(
      Buffer.from("tampered"),
      registryBundleKey("stripe", hash),
      "application/javascript",
    );
    const result = await callTest();
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await result.json())).toContain(
      "does not match its recorded sha256",
    );
    expect(state.verified).toEqual([]);
    expect(state.reloads).toBe(0);
    expect(state.decrypts).toBe(0);
    expect(state.specRuns).toBe(0);
    expect(state.checks).toEqual([]);
    expect(state.nativeChecks).toBe(0);
  });

  it("refuses missing ownership before metadata or credential access", async () => {
    state.pinned = true;
    state.ownership = false;
    expect((await callTest()).status).toBe(404);
    expect(state.verified).toEqual([]);
    expect(state.reloads).toBe(0);
    expect(state.decrypts).toBe(0);
    expect(state.specRuns).toBe(0);
    expect(state.checks).toEqual([]);
  });

  it.each([
    ["id", { _id: new ObjectId() }],
    ["workspace", { workspaceId: new ObjectId() }],
    ["type", { type: "calendly" }],
  ])("refuses changed %s before decrypting", async (_label, override) => {
    state.pinned = true;
    state.rowOverride = override;
    expect((await callTest()).status).toBe(404);
    expect(state.verified).toEqual([bundle]);
    expect(state.specRuns).toBe(1);
    expect(state.reloads).toBe(1);
    expect(state.decrypts).toBe(0);
    expect(state.checks).toEqual([]);
  });
});
