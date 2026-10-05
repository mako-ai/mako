/**
 * Flow operations over MCP: state, Run History, and the pipeline buttons.
 *
 * READS — `inspect_flow` reports backfill/stream state, per-entity progress
 * and the last error; `list_flow_runs` reports executions newest first (the
 * WORKER_TIMEOUT an agent previously had to ask the in-app chat for); both
 * address a flow by id or by file slug, and scrub the source connection's
 * credential values out of every run-derived message.
 *
 * WRITES — `flow_backfill` / `flow_stream` call the SAME `cdcBackfillService`
 * method as the REST route behind each UI button. That is asserted by driving
 * the real route and the tool against one mocked service and comparing the
 * calls. Both refuse a caller whose LIVE role is below admin, and the tools
 * are hidden from a credential without `sources:write`.
 *
 * Real Mongo for flows, entity state and executions; the git overlay
 * (`flow-sync.service`), the backfill service, auth and the role lookup are
 * mocked.
 */
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const SENTINEL = "sk_live_SENTINEL_flow_never_echo_42";

const state = vi.hoisted(() => ({
  role: "admin" as string | null,
  live: [] as Array<{
    def: { slug: string; path: string };
    row: unknown;
    id: unknown;
  }>,
  workspaceId: "",
  failRedactOnce: false,
}));

// Lets a test make run-text scrubbing throw once, AFTER the credentials were
// loaded, to see the failure path reuse that list rather than load again.
vi.mock("../../connectors/probe.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../connectors/probe.service")>();
  return {
    ...actual,
    redactSecrets: vi.fn((text: string, secrets: readonly string[]) => {
      if (state.failRedactOnce) {
        state.failRedactOnce = false;
        throw new Error("scrubber exploded");
      }
      return actual.redactSecrets(text, secrets);
    }),
  };
});

vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "user-1" });
    await next();
  },
}));

vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    hasRole: vi.fn(
      async (_ws: string, _user: string, roles: string[]) =>
        state.role !== null && roles.includes(state.role),
    ),
    getMember: vi.fn(async () => (state.role ? { role: state.role } : null)),
  },
}));

vi.mock("../../services/flow-sync.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../services/flow-sync.service")>();
  return {
    ...actual,
    loadLiveFlows: vi.fn(async () => state.live),
    loadLiveFlowById: vi.fn(
      async (_ws: string, id: string) =>
        state.live.find(item => String(item.id) === id) ?? null,
    ),
    resolveLiveFlowRow: vi.fn(async (_ws: string, id: string) => {
      const live = state.live.find(item => String(item.id) === id);
      if (!live) return { ok: false, status: 404, error: "Flow not found" };
      if (!live.row) {
        return { ok: false, status: 409, error: "exists only in git so far" };
      }
      return { ok: true, live, row: live.row };
    }),
    liveFlowToPlain: vi.fn(
      (live: {
        row: { toObject: () => object } | null;
        id: unknown;
        def: { slug: string };
      }) => ({
        ...(live.row ? live.row.toObject() : { name: live.def.slug }),
        _id: live.id,
        slug: live.def.slug,
      }),
    ),
  };
});

vi.mock("../../sync-cdc/backfill", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../sync-cdc/backfill")>();
  return {
    ...actual,
    cdcBackfillService: {
      startBackfill: vi.fn(async () => ({
        runId: "run-1",
        reusedRunId: false,
      })),
      pauseBackfill: vi.fn(async () => ({ paused: true })),
      resumeBackfill: vi.fn(async () => ({ resumed: true })),
      cancelBackfill: vi.fn(async () => ({ cancelled: true })),
      pauseStream: vi.fn(async () => ({ paused: true })),
      resumeStream: vi.fn(async () => ({ started: true })),
    },
  };
});

vi.mock("../../sync/database-data-source-manager", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("../../sync/database-data-source-manager")
    >();
  return {
    ...actual,
    sourceConnectionManager: {
      getSourceConnection: vi.fn(async () => ({
        id: "src",
        name: "openai",
        type: "ws:openai-ads",
        workspaceId: state.workspaceId,
        // Non-secret values deliberately equal to an entity name and to
        // part of the flow's slug: scrubbing must not touch those.
        connection: {
          api_key: SENTINEL,
          account: "campaigns",
          region: "openai-ads",
          // A secret holding a JSON blob: errors echo the token inside it.
          headers: JSON.stringify({
            Authorization: "Bearer tok_HEADER_bearer_1234567890",
          }),
          // NON-secret fields carrying credentials: a key in a URL, a token
          // inside a params JSON string.
          base_url:
            "https://api.example.com/v1?api_key=sk_live_BASEURL_123456&v=2",
          params: JSON.stringify({ token: "tok_PARAMS_abcdef12", page: 1 }),
        },
      })),
    },
  };
});

import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  FlowExecution,
  SourceConnection,
  type IFlow,
} from "../../database/workspace-schema";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { flowRoutes } from "../../routes/flows";
import { buildMakoMcpToolset } from "../../mcp/mako-mcp-server";
import {
  MCP_BRIDGE_POLICY,
  assertBridgePolicyCovers,
  assertBridgePolicyNotStale,
  mcpDestructiveHint,
  mcpReadOnlyHint,
} from "../../mcp/bridge-policy";
import { collectLiveAgentToolNames } from "../../mcp/bridge-inventory";
import {
  AGENT_CAPABILITY_BY_NAME,
  READ_ONLY_TOOL_NAMES,
} from "@mako/agent-tools";
import type { WorkspaceApiKeyScope } from "../../auth/api-key-scopes";
import {
  RUN_TEXT_WITHHELD,
  createFlowRunTools,
  makeRunTextScrubber,
  normalizeFlowRef,
} from "./flow-run-tools";
import {
  liveFlowToPlain,
  loadLiveFlows,
} from "../../services/flow-sync.service";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import {
  connectionCredentialValues,
  credentialFragments,
} from "../../utils/connection-secrets";
import { loggers } from "../../logging";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let mongo: MongoMemoryServer;
let WS: string;
let FLOW: IFlow;
let SOURCE: Types.ObjectId;

type Executable = {
  execute: (input: unknown) => Promise<Record<string, unknown>>;
};
const tools = () =>
  createFlowRunTools(WS, "user-1") as unknown as Record<string, Executable>;

const app = new Hono();
app.route("/api/workspaces/:workspaceId/flows", flowRoutes);
function post(path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/flows/${FLOW._id}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

function toolsetFor(
  scopes: WorkspaceApiKeyScope[],
  memberRole = "admin",
): Record<string, unknown> {
  return buildMakoMcpToolset({
    workspaceId: WS,
    userId: "user-1",
    memberRole,
    scopes,
  });
}

const READS = ["list_flows", "inspect_flow", "list_flow_runs"];
const DEST_PASSWORD = "Hunter2DestinationPw";
const DB_SOURCE_PASSWORD = "PgSourcePassw0rdXYZ";

/** No 8-character run of `secret` may survive, not even a prefix. */
function expectNoFragment(text: string, secret: string) {
  for (let i = 0; i + 8 <= secret.length; i += 1) {
    expect(text).not.toContain(secret.slice(i, i + 8));
  }
}
const WRITES = ["flow_backfill", "flow_stream"];

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Flow.deleteMany({}),
    FlowExecution.deleteMany({}),
    CdcEntityState.deleteMany({}),
    SourceConnection.deleteMany({}),
    DatabaseConnection.deleteMany({}),
  ]);
  vi.clearAllMocks();
  // The source connector's form schema: only api_key is a secret.
  vi.spyOn(syncConnectorRegistry, "getConfigSchemaForType").mockResolvedValue({
    fields: [
      { name: "api_key", type: "password" },
      { name: "account", type: "string" },
      { name: "region", type: "string" },
      { name: "headers", type: "textarea", encrypted: true },
      { name: "base_url", type: "string" },
      { name: "params", type: "textarea" },
    ],
  });
  WS = new Types.ObjectId().toString();
  state.workspaceId = WS;
  state.role = "admin";
  SOURCE = new Types.ObjectId();
  await SourceConnection.create({
    _id: SOURCE,
    workspaceId: new Types.ObjectId(WS),
    name: "openai",
    type: "ws:openai-ads",
    config: { api_key: "ciphertext-not-read-here" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
    createdBy: "u1",
  });
  // The destination (a password inside a connection string) and a database
  // source: their credentials must be scrubbed from run output too.
  const destination = await DatabaseConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name: "warehouse",
    type: "mongodb",
    connection: {
      connectionString: `mongodb://reporter:${DEST_PASSWORD}@db.example:27017/app`,
    },
    createdBy: "u1",
  });
  const databaseSource = await DatabaseConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name: "pg",
    type: "postgresql",
    connection: { host: "pg.example", password: DB_SOURCE_PASSWORD },
    createdBy: "u1",
  });
  FLOW = await Flow.create({
    workspaceId: new Types.ObjectId(WS),
    type: "webhook",
    name: "OpenAI ads → BigQuery",
    slug: "openai-ads-bigquery-write",
    sourceType: "connector",
    dataSourceId: SOURCE,
    destinationDatabaseId: destination._id,
    databaseSource: { connectionId: databaseSource._id },
    syncMode: "incremental",
    syncEngine: "cdc",
    streamState: "active",
    backfillSchedule: { enabled: true, cron: "0 3 * * *", timezone: "UTC" },
    backfillState: {
      status: "error",
      runId: "run-0",
      startedAt: new Date("2026-10-04T03:00:00Z"),
      consecutiveFailures: 3,
    },
    entityFilter: ["campaigns", "ad_groups"],
    lastError: `The connector timed out on campaigns for openai-ads (key ${SENTINEL})`,
    lastSuccessAt: new Date("2026-10-01T03:10:00Z"),
    createdBy: "u1",
    runCount: 4,
  });
  state.live = [
    {
      def: {
        slug: "openai-ads-bigquery-write",
        path: "flows/openai-ads-bigquery-write.yml",
      },
      row: FLOW,
      id: FLOW._id,
    },
  ];
  await CdcEntityState.create({
    workspaceId: new Types.ObjectId(WS),
    flowId: FLOW._id,
    entity: "campaigns",
    mode: "steady",
    backfillStartedAt: new Date("2026-10-04T03:00:00Z"),
    backfillCompletedAt: new Date("2026-10-04T03:05:00Z"),
    lastIngestSeq: 10,
    lastMaterializedSeq: 10,
    backlogCount: 0,
    lifetimeEventsProcessed: 120,
    lifetimeRowsApplied: 118,
    mergeIntervalSeconds: 60,
    consecutiveFailures: 0,
  });
  // Raw insert, as the flow runner writes them: `stats` is not on the
  // mongoose schema (the runner sets it through the driver), so create()
  // would silently drop it.
  await FlowExecution.collection.insertMany([
    {
      flowId: FLOW._id,
      workspaceId: new Types.ObjectId(WS),
      startedAt: new Date("2026-10-03T03:00:00Z"),
      completedAt: new Date("2026-10-03T03:12:00Z"),
      status: "completed",
      success: true,
      duration: 720_000,
      logs: [],
      stats: { recordsProcessed: 118, entityStats: { campaigns: 118 } },
    },
    {
      flowId: FLOW._id,
      workspaceId: new Types.ObjectId(WS),
      startedAt: new Date("2026-10-04T03:00:00Z"),
      completedAt: new Date("2026-10-04T03:10:00Z"),
      status: "abandoned",
      success: false,
      error: {
        message: "Flow execution abandoned due to worker crash or timeout",
        code: "WORKER_TIMEOUT",
        stack: "Error: at secret/internal/path.ts:1",
      },
      logs: [
        { timestamp: new Date(), level: "info", message: "started" },
        {
          timestamp: new Date(),
          level: "error",
          message: `The connector timed out calling /v1?key=${SENTINEL}`,
        },
      ],
      stats: {
        recordsProcessed: 0,
        entityStats: { campaigns: 0 },
        entityStatus: { campaigns: "syncing" },
      },
    },
    {
      // Another workspace's execution of a same-id flow never shows up.
      flowId: FLOW._id,
      workspaceId: new Types.ObjectId(),
      startedAt: new Date("2026-10-05T03:00:00Z"),
      status: "failed",
      success: false,
      logs: [],
    },
  ]);
});

describe("addressing", () => {
  it("normalizes a file path to its slug", () => {
    expect(normalizeFlowRef("flows/stripe-bq.yml")).toBe("stripe-bq");
    expect(normalizeFlowRef(" stripe-bq.yaml ")).toBe("stripe-bq");
    expect(normalizeFlowRef("64b7f0c2a1b2c3d4e5f60718")).toBe(
      "64b7f0c2a1b2c3d4e5f60718",
    );
  });
});

describe("reads", () => {
  it("inspect_flow reports state by id and by slug, scrubbed", async () => {
    for (const ref of [
      FLOW._id.toString(),
      "openai-ads-bigquery-write",
      "flows/openai-ads-bigquery-write.yml",
    ]) {
      const result = await tools().inspect_flow.execute({ flowId: ref });
      expect(result.id).toBe(FLOW._id.toString());
      expect(result.slug).toBe("openai-ads-bigquery-write");
      expect(result.streamState).toBe("active");
      expect(result.backfill).toMatchObject({
        status: "error",
        runId: "run-0",
        consecutiveFailures: 3,
      });
      expect(result.source).toEqual({
        type: "connector",
        connectionId: SOURCE.toString(),
      });
      expect(result.backfillSchedule).toMatchObject({ cron: "0 3 * * *" });
      const entities = result.entities as Array<Record<string, unknown>>;
      expect(entities.map(e => [e.entity, e.backfill, e.rowsWritten])).toEqual([
        ["campaigns", "completed", 118],
        ["ad_groups", "not_started", 0],
      ]);
      expect(String(result.lastError)).toContain("The connector timed out");
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    }
    const missing = await tools().inspect_flow.execute({ flowId: "nope" });
    expect(String(missing.error)).toMatch(/list_flows/);
  });

  it("list_flow_runs returns this workspace's executions, newest first, scrubbed", async () => {
    const result = await tools().list_flow_runs.execute({
      flowId: "openai-ads-bigquery-write",
    });
    expect(result.total).toBe(2);
    const runs = result.runs as Array<Record<string, unknown>>;
    expect(runs.map(run => run.status)).toEqual(["abandoned", "completed"]);
    expect(runs[0].error).toEqual({
      message: "Flow execution abandoned due to worker crash or timeout",
      code: "WORKER_TIMEOUT",
    });
    expect(
      String((runs[0].lastErrorLog as { message: string }).message),
    ).toMatch(/connector timed out/);
    expect(runs[1].stats).toMatchObject({
      recordsProcessed: 118,
      perEntity: { campaigns: 118 },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("secret/internal/path.ts"); // no stack

    const limited = await tools().list_flow_runs.execute({
      flowId: FLOW._id.toString(),
      limit: 1,
    });
    expect((limited.runs as unknown[]).length).toBe(1);
  });

  it("list_flows lists slug, path and source connection", async () => {
    const result = await tools().list_flows.execute({});
    const flows = result.flows as Array<Record<string, unknown>>;
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({
      id: FLOW._id.toString(),
      slug: "openai-ads-bigquery-write",
      path: "flows/openai-ads-bigquery-write.yml",
      syncEngine: "cdc",
      streamState: "active",
      backfillStatus: "error",
      source: {
        connectionId: SOURCE.toString(),
        name: "openai",
        connector: "ws:openai-ads",
      },
    });
  });
});

describe("scrubbing run-derived text", () => {
  async function setLastError(lastError: string) {
    await Flow.updateOne({ _id: FLOW._id }, { $set: { lastError } });
    state.live[0].row = await Flow.findById(FLOW._id);
  }

  it("redacts BEFORE clipping: a secret across the 1,000-char cut leaves no fragment", async () => {
    for (const offset of [992, 995, 999, 1000]) {
      const message = "x".repeat(offset) + SENTINEL + " tail";
      await setLastError(message);
      await FlowExecution.collection.insertOne({
        flowId: FLOW._id,
        workspaceId: new Types.ObjectId(WS),
        startedAt: new Date(`2026-10-06T00:00:0${offset % 10}Z`),
        status: "failed",
        success: false,
        error: { message },
        logs: [{ timestamp: new Date(), level: "error", message }],
      });
      const inspected = await tools().inspect_flow.execute({
        flowId: FLOW._id.toString(),
      });
      expectNoFragment(JSON.stringify(inspected), SENTINEL);
      const runs = await tools().list_flow_runs.execute({
        flowId: FLOW._id.toString(),
        limit: 1,
      });
      expectNoFragment(JSON.stringify(runs), SENTINEL);
    }
  });

  it("scrubs only schema-secret values: ids, slugs, entity names and keys stay intact", async () => {
    const result = await tools().inspect_flow.execute({
      flowId: "openai-ads-bigquery-write",
    });
    // `account: "campaigns"` and `region: "openai-ads"` are non-secret
    // config values equal to an entity name and to part of the slug.
    expect(result.slug).toBe("openai-ads-bigquery-write");
    expect(result.path).toBe("flows/openai-ads-bigquery-write.yml");
    const entities = result.entities as Array<Record<string, unknown>>;
    expect(entities.map(e => e.entity)).toEqual(["campaigns", "ad_groups"]);
    expect(result.lastError).toBe(
      "The connector timed out on campaigns for openai-ads (key [redacted])",
    );
    const runs = await tools().list_flow_runs.execute({
      flowId: "openai-ads-bigquery-write",
    });
    expect(runs.slug).toBe("openai-ads-bigquery-write");
    const completed = (runs.runs as Array<Record<string, unknown>>)[1];
    expect(completed.stats).toMatchObject({ perEntity: { campaigns: 118 } });
  });

  it("scrubs the destination's and the database source's credentials, and any URI password", async () => {
    await FlowExecution.collection.insertOne({
      flowId: FLOW._id,
      workspaceId: new Types.ObjectId(WS),
      startedAt: new Date("2026-10-07T00:00:00Z"),
      status: "failed",
      success: false,
      error: {
        message: `MongoServerError: auth failed for mongodb://reporter:${DEST_PASSWORD}@db.example:27017/app`,
      },
      logs: [
        {
          timestamp: new Date(),
          level: "error",
          message: `password authentication failed (${DB_SOURCE_PASSWORD}); retry via mongodb://other:UnknownPw123@x.example`,
        },
      ],
    });
    const result = await tools().list_flow_runs.execute({
      flowId: FLOW._id.toString(),
      limit: 1,
    });
    const text = JSON.stringify(result);
    for (const secret of [DEST_PASSWORD, DB_SOURCE_PASSWORD, "UnknownPw123"]) {
      expect(text).not.toContain(secret);
    }
    // The host is not a credential and stays legible.
    expect(text).toContain("mongodb://reporter:[redacted]@db.example");
    expect(text).toContain("mongodb://other:[redacted]@x.example");
  });

  it("scrubs and clips a control's failure instead of returning it raw", async () => {
    vi.mocked(cdcBackfillService.startBackfill).mockRejectedValueOnce(
      new Error(
        `vendor said ${SENTINEL} via mongodb://reporter:${DEST_PASSWORD}@db.example ` +
          "y".repeat(2_000),
      ),
    );
    const result = await tools().flow_backfill.execute({
      flowId: FLOW._id.toString(),
      action: "start",
    });
    const error = String(result.error);
    expect(error).toContain("vendor said [redacted]");
    expect(error).not.toContain(DEST_PASSWORD);
    expectNoFragment(error, SENTINEL);
    expect(error.length).toBeLessThan(1_100);

    vi.mocked(cdcBackfillService.pauseStream).mockRejectedValueOnce(
      new Error(`stream refused: ${SENTINEL}`),
    );
    const stream = await tools().flow_stream.execute({
      flowId: FLOW._id.toString(),
      action: "pause",
    });
    expect(String(stream.error)).toBe("stream refused: [redacted]");
  });
});

describe("scrubbing, second review", () => {
  async function setLastError(lastError: string | null) {
    await Flow.updateOne(
      { _id: FLOW._id },
      lastError === null
        ? { $unset: { lastError: 1 } }
        : { $set: { lastError } },
    );
    state.live[0].row = await Flow.findById(FLOW._id);
  }

  it("redacts the longest secret first, so one containing another goes whole", () => {
    const scrub = makeRunTextScrubber(["abcd1234", "abcd1234Zq9!x"]);
    expect(scrub("got abcd1234Zq9!x and abcd1234")).toBe(
      "got [redacted] and [redacted]",
    );
  });

  it("scrubs a bearer token held inside a JSON headers secret", async () => {
    await setLastError(
      "401 Unauthorized: token tok_HEADER_bearer_1234567890 rejected",
    );
    const result = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    expect(result.lastError).toBe(
      "401 Unauthorized: token [redacted] rejected",
    );
  });

  it("collects only credential-named leaves of a service-account JSON", () => {
    const values = connectionCredentialValues({
      service_account_json: JSON.stringify({
        type: "service_account",
        project_id: "my-project-prod",
        private_key_id: "0123456789abcdef",
        private_key: "-----BEGIN PRIVATE KEY-----abc",
        client_email: "svc@my-project-prod.iam.gserviceaccount.com",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    });
    const scrub = makeRunTextScrubber(values);
    expect(
      scrub(
        "svc@my-project-prod.iam.gserviceaccount.com in my-project-prod via https://oauth2.googleapis.com/token used -----BEGIN PRIVATE KEY-----abc (0123456789abcdef)",
      ),
    ).toBe(
      "svc@my-project-prod.iam.gserviceaccount.com in my-project-prod via https://oauth2.googleapis.com/token used [redacted] ([redacted])",
    );
  });

  it("redacts the percent-encoded form of a secret", () => {
    const scrub = makeRunTextScrubber(["ab+cd/ef=="]);
    expect(scrub("GET /x?k=ab%2Bcd%2Fef%3D%3D and ab+cd/ef==")).toBe(
      "GET /x?k=[redacted] and [redacted]",
    );
    expect(credentialFragments("ab+cd/ef==")).toContain("ab%2Bcd%2Fef%3D%3D");
  });

  it("scrubs credentials embedded in NON-secret source fields", async () => {
    await setLastError(
      "GET https://api.example.com/v1?api_key=sk_live_BASEURL_123456&v=2 failed; params token tok_PARAMS_abcdef12",
    );
    const result = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    const text = String(result.lastError);
    expect(text).not.toContain("sk_live_BASEURL_123456");
    expect(text).not.toContain("tok_PARAMS_abcdef12");
    expect(text).toContain("https://api.example.com/v1?api_key=[redacted]&v=2");
  });

  it("never withholds a control's refusal; scrubs it with what did load and logs the original", async () => {
    vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockResolvedValue(
      null,
    );
    const flowLogger = loggers.api("flow-run-tools");
    const warn = vi.spyOn(flowLogger, "warn");
    vi.mocked(cdcBackfillService.startBackfill).mockRejectedValueOnce(
      new Error(`A backfill is already running (key ${SENTINEL})`),
    );
    const result = await tools().flow_backfill.execute({
      flowId: FLOW._id.toString(),
      action: "start",
    });
    expect(result.error).toBe("A backfill is already running (key [redacted])");
    const logged = warn.mock.calls.find(([message]) =>
      String(message).startsWith("flow_backfill failed"),
    );
    expect(logged?.[1]).toMatchObject({
      workspaceId: WS,
      flowId: FLOW._id.toString(),
      action: "start",
      userId: "user-1",
      error: "A backfill is already running (key [redacted])",
    });
    // Run text, by contrast, is withheld while the list is incomplete.
    const inspected = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    expect(inspected.lastError).toBe(RUN_TEXT_WITHHELD);
    warn.mockRestore();
  });

  it("the failure path reuses the credential list the call already built", async () => {
    state.failRedactOnce = true;
    const result = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    expect(String(result.error)).toBe(
      "Failed to inspect flow: scrubber exploded",
    );
    expect(sourceConnectionManager.getSourceConnection).toHaveBeenCalledTimes(
      1,
    );
  });

  it("withholds run text when the source schema cannot be loaded (fail closed)", async () => {
    vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockResolvedValue(
      null,
    );
    const inspected = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    expect(inspected.lastError).toBe(RUN_TEXT_WITHHELD);
    expect(JSON.stringify(inspected)).not.toContain("timed out");
    const runs = await tools().list_flow_runs.execute({
      flowId: FLOW._id.toString(),
    });
    const abandoned = (runs.runs as Array<Record<string, unknown>>)[0];
    expect(abandoned.error).toEqual({
      message: RUN_TEXT_WITHHELD,
      code: "WORKER_TIMEOUT",
    });
    expect((abandoned.lastErrorLog as { message: string }).message).toBe(
      RUN_TEXT_WITHHELD,
    );
    // Run state that is not run TEXT is still returned.
    expect(inspected.streamState).toBe("active");
  });

  it("withholds run text when a connection the flow touches is missing", async () => {
    await DatabaseConnection.deleteMany({ name: "warehouse" });
    const inspected = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    expect(inspected.lastError).toBe(RUN_TEXT_WITHHELD);
  });

  it("does not load credentials for a flow with no run text", async () => {
    await setLastError(null);
    await CdcEntityState.updateMany({}, { $unset: { lastFailureError: 1 } });
    const healthy = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    expect(healthy.lastError).toBeNull();
    expect(sourceConnectionManager.getSourceConnection).not.toHaveBeenCalled();
    expect(syncConnectorRegistry.getConfigSchemaForType).not.toHaveBeenCalled();

    // With run text, the list is built once however many texts there are.
    const runs = await tools().list_flow_runs.execute({
      flowId: FLOW._id.toString(),
    });
    expect(runs.total).toBe(2);
    expect(sourceConnectionManager.getSourceConnection).toHaveBeenCalledTimes(
      1,
    );
  });

  it("scrubs, masks and clips the read tools' own failures", async () => {
    vi.mocked(loadLiveFlows).mockRejectedValueOnce(
      new Error(
        "repo read failed via mongodb://svc:RepoPw0rd123@git.example " +
          "z".repeat(3_000),
      ),
    );
    const listed = await tools().list_flows.execute({});
    expect(String(listed.error)).toContain("svc:[redacted]@git.example");
    expect(String(listed.error)).not.toContain("RepoPw0rd123");
    expect(String(listed.error).length).toBeLessThan(1_100);

    vi.mocked(liveFlowToPlain).mockImplementationOnce(() => {
      throw new Error(`overlay failed for key ${SENTINEL}`);
    });
    const inspected = await tools().inspect_flow.execute({
      flowId: FLOW._id.toString(),
    });
    expect(String(inspected.error)).toBe(
      "Failed to inspect flow: overlay failed for key [redacted]",
    );
  });
});

describe("writes call the same service as the UI's routes", () => {
  const cases: Array<{
    tool: "flow_backfill" | "flow_stream";
    action: string;
    route: string;
    method: keyof typeof cdcBackfillService;
    body?: Record<string, unknown>;
  }> = [
    {
      tool: "flow_backfill",
      action: "start",
      route: "/sync-cdc/backfill/start",
      method: "startBackfill",
      body: { entities: ["campaigns"] },
    },
    {
      tool: "flow_backfill",
      action: "pause",
      route: "/sync-cdc/pause",
      method: "pauseBackfill",
    },
    {
      tool: "flow_backfill",
      action: "resume",
      route: "/sync-cdc/resume",
      method: "resumeBackfill",
    },
    {
      tool: "flow_backfill",
      action: "cancel",
      route: "/sync-cdc/backfill/cancel",
      method: "cancelBackfill",
    },
    {
      tool: "flow_stream",
      action: "start",
      route: "/sync-cdc/stream/start",
      method: "resumeStream",
    },
    {
      tool: "flow_stream",
      action: "pause",
      route: "/sync-cdc/stream/pause",
      method: "pauseStream",
    },
  ];

  for (const c of cases) {
    it(`${c.tool} ${c.action} → cdcBackfillService.${String(c.method)}, like POST ${c.route}`, async () => {
      const service = vi.mocked(
        cdcBackfillService[c.method] as unknown as (
          ...args: unknown[]
        ) => unknown,
      );
      const response = await post(c.route, c.body);
      expect(response.status).toBe(200);
      expect(service).toHaveBeenCalledTimes(1);
      const routeCall = service.mock.calls[0];

      service.mockClear();
      const result = await tools()[c.tool].execute({
        flowId: "openai-ads-bigquery-write",
        action: c.action,
        ...(c.body ?? {}),
      });
      expect(result.error).toBeUndefined();
      expect(result.action).toBe(c.action);
      expect(service).toHaveBeenCalledTimes(1);
      expect(service.mock.calls[0]).toEqual(routeCall);
    });
  }

  it("refuses a caller whose live role is below admin, as the route does", async () => {
    state.role = "member";
    const response = await post("/sync-cdc/backfill/start");
    expect(response.status).toBe(403);
    const result = await tools().flow_backfill.execute({
      flowId: FLOW._id.toString(),
      action: "start",
    });
    expect(String(result.error)).toMatch(/owner or admin/);
    const stream = await tools().flow_stream.execute({
      flowId: FLOW._id.toString(),
      action: "pause",
    });
    expect(String(stream.error)).toMatch(/owner or admin/);
    expect(cdcBackfillService.startBackfill).not.toHaveBeenCalled();
    expect(cdcBackfillService.pauseStream).not.toHaveBeenCalled();
  });

  it("refuses a non-CDC flow and a flow that exists only in git", async () => {
    await Flow.updateOne({ _id: FLOW._id }, { $set: { syncEngine: "legacy" } });
    // The mocked overlay serves the in-memory row; hand it the updated one.
    state.live[0].row = await Flow.findById(FLOW._id);
    const legacy = await tools().flow_backfill.execute({
      flowId: FLOW._id.toString(),
      action: "start",
    });
    expect(String(legacy.error)).toMatch(/CDC flows only/);

    state.live[0].row = null;
    const gitOnly = await tools().flow_stream.execute({
      flowId: FLOW._id.toString(),
      action: "start",
    });
    expect(String(gitOnly.error)).toMatch(/only in git/);
    expect(cdcBackfillService.startBackfill).not.toHaveBeenCalled();
    expect(cdcBackfillService.resumeStream).not.toHaveBeenCalled();
  });

  it("entities apply to start only", async () => {
    const result = await tools().flow_backfill.execute({
      flowId: FLOW._id.toString(),
      action: "pause",
      entities: ["campaigns"],
    });
    expect(String(result.error)).toMatch(/start only/);
    expect(cdcBackfillService.pauseBackfill).not.toHaveBeenCalled();
  });
});

describe("gating and classification", () => {
  it("reads need query access; controls need sources:write and admin", () => {
    const base = toolsetFor(["mcp"]);
    for (const name of [...READS, ...WRITES]) {
      expect(base[name]).toBeUndefined();
    }
    const read = toolsetFor(["mcp", "query:read"]);
    for (const name of READS) expect(read[name]).toBeTruthy();
    for (const name of WRITES) expect(read[name]).toBeUndefined();

    const scoped = toolsetFor(["mcp", "query:read", "sources:write"]);
    for (const name of WRITES) expect(scoped[name]).toBeTruthy();

    const member = toolsetFor(["mcp", "query:read", "sources:write"], "member");
    for (const name of WRITES) expect(member[name]).toBeUndefined();
    for (const name of READS) expect(member[name]).toBeTruthy();
  });

  it("is never listed to a Desktop ACP session, where it would be refused", async () => {
    const desktop = buildMakoMcpToolset({
      workspaceId: WS,
      userId: "user-1",
      memberRole: "owner",
      scopes: ["mcp", "query:read", "sources:write"],
      acpDesktop: true,
    }) as Record<string, Executable>;
    for (const name of [...READS, ...WRITES]) {
      expect(desktop[name]).toBeUndefined();
    }
    const report = (await desktop.get_mcp_capabilities.execute({})) as {
      availableTools: string[];
    };
    for (const name of [...READS, ...WRITES]) {
      expect(report.availableTools).not.toContain(name);
    }
    // Still listed on the external surface with the same credential.
    const external = toolsetFor(["mcp", "query:read", "sources:write"]);
    for (const name of [...READS, ...WRITES]) {
      expect(external[name]).toBeTruthy();
    }
  });

  it("takes its bridge entries from the capability registry, not hand-written ones", () => {
    for (const name of READS) {
      expect(MCP_BRIDGE_POLICY[name]).toEqual({
        status: "bridge",
        requiresQueryAccess: true,
        destructiveHint: false,
      });
      expect(AGENT_CAPABILITY_BY_NAME.get(name)?.requiresQueryAccess).toBe(
        true,
      );
    }
    for (const name of WRITES) {
      const capability = AGENT_CAPABILITY_BY_NAME.get(name);
      expect(capability?.requiredGrant).toBe("sources-write");
      expect(capability?.minimumWorkspaceRole).toBe("admin");
      expect(capability?.surfaces).toEqual(["external-mcp"]);
      expect(MCP_BRIDGE_POLICY[name]?.status).toBe("bridge");
    }
    // cancel discards checkpoints: flow_backfill is destructive, the stream
    // control is not.
    expect(AGENT_CAPABILITY_BY_NAME.get("flow_backfill")?.risk).toBe(
      "destructive",
    );
    expect(MCP_BRIDGE_POLICY.flow_backfill).toMatchObject({
      destructiveHint: true,
    });
    expect(mcpDestructiveHint("flow_backfill")).toBe(true);
    expect(mcpDestructiveHint("flow_stream")).toBe(false);
    expect(
      String(
        (createFlowRunTools(WS) as Record<string, { description?: string }>)
          .flow_backfill.description,
      ),
    ).toMatch(/cancel: DESTRUCTIVE .*DISCARD its checkpoints/);
    const policySource = readFileSync(
      join(__dirname, "../../mcp/bridge-policy.ts"),
      "utf8",
    );
    for (const name of [
      ...READS,
      ...WRITES,
      "create_source_connection",
      "update_source_connection",
    ]) {
      expect(policySource).not.toMatch(new RegExp(`^\\s*${name}:`, "m"));
    }
  });

  it("is classified on the bridge, in the inventory, and read-only where it reads", () => {
    const live = collectLiveAgentToolNames();
    assertBridgePolicyCovers(live);
    assertBridgePolicyNotStale(live);
    for (const name of [...READS, ...WRITES]) {
      expect(MCP_BRIDGE_POLICY[name]?.status).toBe("bridge");
      expect(live).toContain(name);
    }
    for (const name of READS) {
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
      expect(mcpReadOnlyHint(name, "none")).toBe(true);
    }
    for (const name of WRITES) {
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});
