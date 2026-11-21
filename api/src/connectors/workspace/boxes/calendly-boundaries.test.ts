import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  loads: 0,
  resolutions: 0,
  verifiedBytes: [] as string[],
  specCommands: 0,
  legacyRequests: [] as string[],
  dispatches: [] as Array<{ command: string; digest: string; id: string }>,
}));
const workspaceId = "507f1f77bcf86cd799439011";
const connectionId = "507f1f77bcf86cd799439012";
const bundle = Buffer.from("export default 1;\n");
const digest = createHash("sha256").update(bundle).digest("hex");
const hash = "a".repeat(64);
const saved = {
  _id: new ObjectId(connectionId),
  workspaceId: new ObjectId(workspaceId),
  type: "calendly",
  name: "Synthetic",
  config: { access_token: "synthetic-secret" },
  isActive: true,
  settings: {},
};

vi.mock("../registry/stripe-release", async importOriginal => {
  const original =
    await importOriginal<typeof import("../registry/stripe-release")>();
  return {
    ...original,
    resolveTrustedRelease: (
      ...args: Parameters<typeof original.resolveTrustedRelease>
    ) => {
      state.resolutions++;
      return original.resolveTrustedRelease(...args);
    },
  };
});
vi.mock("./scheduler", () => ({
  getBoxScheduler: () => ({
    withLease: async (
      _request: unknown,
      run: (lease: unknown) => Promise<unknown>,
    ) =>
      run({
        ctx: {},
        fresh: true,
        markFailed: vi.fn(),
        markUnhealthy: vi.fn(),
      }),
  }),
}));
vi.mock("../resolver", async importOriginal => ({
  ...(await importOriginal<typeof import("../resolver")>()),
  ensureConnectorRuntime: async () => "synthetic-runtime",
}));
vi.mock("../sync-box", async importOriginal => ({
  ...(await importOriginal<typeof import("../sync-box")>()),
  installConnectorBundle: async (input: {
    expectedSha256: string;
    load: () => Promise<Uint8Array>;
  }) => {
    expect(input.expectedSha256).toBe(digest);
    const bytes = await input.load();
    state.verifiedBytes.push(Buffer.from(bytes).toString());
    return { dir: "/synthetic", entry: "bundle.mjs" };
  },
  runConnectorCommand: async (input: { command: string; config?: unknown }) => {
    expect(input.command).toBe("spec");
    expect(input).not.toHaveProperty("config");
    expect(JSON.stringify(input)).not.toContain("synthetic-secret");
    state.specCommands++;
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
              properties: { access_token: { type: "string", secret: true } },
            },
            mako: { entities: { events: {}, scheduled_events: {} } },
          },
        },
      ],
    };
  },
}));
vi.mock("../../calendly/client", async importOriginal => ({
  ...(await importOriginal<typeof import("../../calendly/client")>()),
  createCalendlyClient: (_base: string, token: string) => {
    expect(token).toBe("synthetic-secret");
    return {
      get: async (url: string) => {
        state.legacyRequests.push(url);
        if (url === "/users/me") {
          return {
            data: {
              resource: {
                uri: "https://api.calendly.com/users/u",
                current_organization:
                  "https://api.calendly.com/organizations/o",
              },
            },
          };
        }
        if (url === "/scheduled_events") {
          return {
            data: {
              collection: [
                { uri: "https://api.calendly.com/scheduled_events/e" },
              ],
              pagination: {},
            },
          };
        }
        throw new Error(`Unexpected synthetic Calendly request ${url}`);
      },
    };
  },
}));
vi.mock("../../../services/database-connection.service", () => ({
  databaseConnectionService: {
    getMainConnection: async () => ({
      db: {
        collection: () => ({
          findOne: async () => {
            if (CALENDLY_RELEASE_PIN.version !== undefined) {
              expect(state.verifiedBytes).toHaveLength(state.specCommands);
              expect(state.verifiedBytes.at(-1)).toBe("export default 1;\n");
            }
            state.loads++;
            return { ...saved, config: { ...saved.config } };
          },
        }),
      },
    }),
  },
}));
import { SourceConnection } from "../../../database/workspace-schema";
import { sourceConnectionVerificationRoutes } from "../../../routes/source-connections/verification";
import { SandboxedConnector } from "../SandboxedConnector";
import { buildMakoMcpToolset } from "../../../mcp/mako-mcp-server";
import { getArtifactStore } from "../../../services/artifact-store.service";
import {
  emptyCatalog,
  registryBundleKey,
  writeCatalog,
  writeRegistryArtifacts,
} from "../registry/store";
import { withVersion } from "../registry/publish";
import { clearRegistryCatalogCache } from "../registry/registry.service";
import { isOrphanConnectorType } from "../../source-connection-create.service";
import { syncConnectorRegistry } from "../../../sync/connector-registry";
import { requestContextStorage } from "../../../logging/context";
import { CalendlyConnector } from "../../calendly/connector";
import { CALENDLY_RELEASE_PIN } from "../registry/calendly-binding";

const app = new Hono();
app.route(
  "/workspaces/:workspaceId/connections",
  sourceConnectionVerificationRoutes,
);
const callRoute = (
  suffix: string,
  body?: object,
  ids = { workspaceId, connectionId },
) =>
  app.request(
    `/workspaces/${ids.workspaceId}/connections/${ids.connectionId}/${suffix}`,
    {
      method: "POST",
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    },
  );
type Executable = {
  execute: (input: unknown) => Promise<Record<string, unknown>>;
};
const mcpProbe = (entity = "events") =>
  (
    buildMakoMcpToolset({
      workspaceId,
      scopes: ["mcp", "query:read"],
    } as Parameters<typeof buildMakoMcpToolset>[0])
      .probe_connection as unknown as Executable
  ).execute({ connectionId, entity, limit: 1 });

function selectPin(selected: boolean): void {
  CALENDLY_RELEASE_PIN.version = selected ? "1.0.0" : undefined;
  CALENDLY_RELEASE_PIN.sha256 = selected ? digest : undefined;
}

const probeFromDeniedWorkflow = () =>
  requestContextStorage.run(
    {
      requestId: "synthetic",
      method: "POST",
      path: "/",
      startTime: 0,
      workflow: "denied",
    },
    () => callRoute("probe", { entity: "events" }),
  );

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "calendly-registry-"));
  vi.stubEnv("DASHBOARD_ARTIFACT_DIR", dir);
  vi.stubEnv("DASHBOARD_ARTIFACT_STORE", "filesystem");
  vi.stubEnv("CONNECTOR_REGISTRY_BUCKET", "");
  vi.stubEnv("DATABASE_URL", "mongodb://127.0.0.1/synthetic");
  await writeRegistryArtifacts({
    slug: "calendly",
    hash,
    bundle,
    source: {
      slug: "calendly",
      version: "1.0.0",
      hash,
      entry: "connector.ts",
      files: {},
    },
  });
  await writeCatalog(
    withVersion(emptyCatalog(), {
      slug: "calendly",
      name: "calendly",
      versions: [
        {
          version: "1.0.0",
          hash,
          sha256: digest,
          bytes: bundle.length,
          sdkVersion: "0.1.0",
          entry: "connector.ts",
          entities: ["events"],
          authType: "api_key",
          publishedAt: "2026-11-16T00:00:00.000Z",
        },
      ],
    }),
  );
  clearRegistryCatalogCache();
});

afterAll(() => {
  selectPin(false);
  clearRegistryCatalogCache();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await getArtifactStore().putBuffer(
    bundle,
    registryBundleKey("calendly", hash),
    "application/javascript",
  );
  state.loads = 0;
  selectPin(true);
  state.resolutions = 0;
  vi.spyOn(syncConnectorRegistry, "getConfigSchemaForType").mockResolvedValue(
    null,
  );
  state.verifiedBytes = [];
  state.specCommands = 0;
  state.legacyRequests = [];
  state.dispatches = [];
  vi.spyOn(SourceConnection, "findOne").mockReturnValue({
    lean: async () => ({
      _id: new ObjectId(connectionId),
      workspaceId,
      type: "calendly",
      name: "Synthetic",
    }),
  } as never);
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
    state.dispatches.push({
      command: String(command),
      digest: await this.sourceShaForConnectionCheck(),
      id: String(
        (this as unknown as { sourceConnection: { _id: unknown } })
          .sourceConnection._id,
      ),
    });
    const messages =
      command === "check"
        ? [
            {
              type: "CONNECTION_STATUS",
              connectionStatus: { status: "SUCCEEDED", message: "ok" },
            },
          ]
        : command === "read"
          ? [
              {
                type: "RECORD",
                record: {
                  stream: (
                    options as {
                      catalog: { streams: Array<{ stream: { name: string } }> };
                    }
                  ).catalog.streams[0].stream.name,
                  data: { id: "one", secret: "synthetic-secret" },
                },
              },
            ]
          : [{ type: "CATALOG", catalog: { streams: [] } }];
    return {
      exitCode: 0,
      timedOut: false,
      stderr: "",
      malformed: [],
      messages,
    };
  });
});

describe("Calendly real entrypoints with a synthetic box", () => {
  it("rolls the same saved connection from legacy to pinned and back", async () => {
    const before = JSON.stringify(saved);
    const writes = [
      "updateOne",
      "updateMany",
      "findOneAndUpdate",
      "findByIdAndUpdate",
      "deleteOne",
      "deleteMany",
    ] as const;
    const writeSpies = writes.map(name =>
      vi.spyOn(SourceConnection, name).mockImplementation(() => {
        throw new Error("Synthetic test forbids connection writes");
      }),
    );
    vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockResolvedValue(
      CalendlyConnector.getConfigSchema(),
    );
    syncConnectorRegistry.register({
      type: "calendly",
      connectorClass: CalendlyConnector,
      metadata: {
        name: "Calendly",
        version: "1.0.0",
        description: "Synthetic",
        supportedEntities: ["scheduled_events"],
      },
    });
    const runtimeByCall: string[] = [];
    for (const pinned of [false, true, false]) {
      selectPin(pinned);
      for (const surface of ["test", "http", "mcp"] as const) {
        const legacyBefore = state.legacyRequests.length;
        const boxBefore = state.dispatches.length;
        if (surface === "mcp") {
          const result = await mcpProbe("scheduled_events");
          expect(result).toMatchObject({
            connection: { id: connectionId, connector: "calendly" },
            check: { success: true },
            entity: { count: 1 },
          });
        } else {
          const response = await callRoute(
            surface === "test" ? "test" : "probe",
            surface === "http"
              ? { entity: "scheduled_events", limit: 1 }
              : undefined,
          );
          expect(response.status).toBe(200);
          const result = await response.json();
          if (surface === "test") {
            expect(result).toMatchObject({
              success: true,
              data: { success: true },
            });
          } else {
            expect(result).toMatchObject({
              data: {
                connection: { id: connectionId, connector: "calendly" },
                check: { success: true },
                entity: { count: 1 },
              },
            });
          }
        }
        const legacyCalls = state.legacyRequests.slice(legacyBefore);
        const boxCalls = state.dispatches.slice(boxBefore);
        expect(legacyCalls.length > 0).toBe(!pinned);
        expect(boxCalls.length > 0).toBe(pinned);
        if (pinned) {
          expect(
            boxCalls.every(
              call => call.id === connectionId && call.digest === digest,
            ),
          ).toBe(true);
        }
        runtimeByCall.push(`${surface}:${pinned ? "verified-box" : "legacy"}`);
        expect(JSON.stringify(saved)).toBe(before);
      }
    }
    expect(runtimeByCall).toEqual([
      "test:legacy",
      "http:legacy",
      "mcp:legacy",
      "test:verified-box",
      "http:verified-box",
      "mcp:verified-box",
      "test:legacy",
      "http:legacy",
      "mcp:legacy",
    ]);
    expect(state.loads).toBe(9);
    expect(state.verifiedBytes).toEqual(Array(3).fill("export default 1;\n"));
    expect(state.specCommands).toBe(3);
    for (const spy of writeSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("sends one saved id and digest through Test, HTTP probe and MCP probe", async () => {
    expect(await isOrphanConnectorType("calendly", workspaceId)).toBe(true);
    const test = await callRoute("test");
    expect(test.status).toBe(200);
    const http = await callRoute("probe", { entity: "events", limit: 1 });
    expect(http.status).toBe(200);
    const httpBody = (await http.json()) as {
      data: { connection: { id: string } };
    };
    const mcp = await mcpProbe();
    expect(httpBody.data.connection.id).toBe(connectionId);
    expect((mcp as { connection?: { id?: string } }).connection?.id).toBe(
      connectionId,
    );
    expect(JSON.stringify(httpBody)).not.toContain("synthetic-secret");
    expect(JSON.stringify(mcp)).not.toContain("synthetic-secret");
    expect(
      (mcp as { connection?: { connector?: string } }).connection?.connector,
    ).toBe("calendly");
    expect(state.loads).toBe(3);
    expect(state.verifiedBytes).toEqual(Array(3).fill("export default 1;\n"));
    expect(state.specCommands).toBe(3);
    expect(state.dispatches.map(d => d.command)).toEqual([
      "check",
      "check",
      "read",
      "discover",
      "check",
      "read",
      "discover",
    ]);
    expect(
      state.dispatches.every(d => d.digest === digest && d.id === connectionId),
    ).toBe(true);
  });

  it("refuses both probes when no pin or legacy schema exists", async () => {
    selectPin(false);
    expect(await isOrphanConnectorType("calendly", workspaceId)).toBe(true);
    const http = await callRoute("probe", { entity: "events" });
    expect(http.status).toBeGreaterThanOrEqual(400);
    expect(await mcpProbe()).toHaveProperty("code", "connector_unavailable");
    expect(state.loads).toBe(0);
    expect(state.specCommands).toBe(0);
    expect(state.dispatches).toEqual([]);
  });

  it.each([
    { type: "calendly", pinned: false },
    { type: "retired_fixture", pinned: true },
  ])(
    "returns the ordinary orphan error for $type",
    async ({ type, pinned }) => {
      selectPin(pinned);
      vi.mocked(SourceConnection.findOne).mockReturnValueOnce({
        lean: async () => ({ ...saved, type }),
      } as never);

      const http = await probeFromDeniedWorkflow();
      expect(http.status).toBe(500);
      expect(await http.json()).toHaveProperty("code", "connector_unavailable");
      expect(state.resolutions).toBe(0);
      expect(state.loads).toBe(0);
    },
  );

  it("uses canonical ObjectIds when a pinned request supplies uppercase hex", async () => {
    const ids = {
      workspaceId: workspaceId.toUpperCase(),
      connectionId: connectionId.toUpperCase(),
    };
    const test = await callRoute("test", undefined, ids);
    expect(test.status).toBe(200);
    expect(await test.json()).toMatchObject({ data: { success: true } });
    const http = await callRoute("probe", { entity: "events", limit: 1 }, ids);
    expect(http.status).toBe(200);
    expect(await http.json()).toMatchObject({
      data: {
        connection: { id: connectionId, connector: "calendly" },
        entity: { count: 1 },
      },
    });
    expect(state.loads).toBe(2);
    expect(state.dispatches.length).toBeGreaterThan(0);
    expect(
      state.dispatches.every(d => d.id === connectionId && d.digest === digest),
    ).toBe(true);
  });

  it("checks live-read access and workspace ownership before metadata", async () => {
    const http = await probeFromDeniedWorkflow();
    expect(http.status).toBe(403);
    vi.mocked(SourceConnection.findOne).mockReturnValueOnce({
      lean: async () => null,
    } as never);
    expect((await callRoute("probe", { entity: "events" })).status).toBe(404);
    expect(state.resolutions).toBe(0);
    expect(state.verifiedBytes).toEqual([]);
    expect(state.specCommands).toBe(0);
    expect(state.loads).toBe(0);
  });

  it("rejects a bad artifact before loading the credential at all 3 entrypoints", async () => {
    await getArtifactStore().putBuffer(
      Buffer.from("tampered"),
      registryBundleKey("calendly", hash),
      "application/javascript",
    );
    const test = await callRoute("test");
    expect(test.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await test.json())).toContain(
      "does not match its recorded sha256",
    );
    const http = await callRoute("probe", { entity: "events", limit: 1 });
    expect(http.status).toBe(500);
    expect(await http.json()).toMatchObject({
      code: "connector_unavailable",
      error: expect.stringContaining("Calendly release is unavailable"),
    });
    expect(await mcpProbe()).toMatchObject({
      code: "connector_unavailable",
      error: expect.stringContaining("Calendly release is unavailable"),
    });
    expect(state.loads).toBe(0);
    expect(state.specCommands).toBe(0);
    expect(state.verifiedBytes).toEqual([]);
    expect(state.dispatches).toEqual([]);
  });
});
