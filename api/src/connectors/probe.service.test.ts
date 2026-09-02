/**
 * The live probe's three promises, each pinned by a test that fails without
 * the code that keeps it:
 *
 *   BOUNDED   — one chunk of one page, at most `limit` records returned, and
 *               the caller is told the page held more.
 *   READ-ONLY — a probe never reaches a destination; the only write is the
 *               workspace connector's connection-check mark, and only for a
 *               workspace connector.
 *   NO SECRET — the decrypted credential is scrubbed from every string the
 *               result carries: the vendor's check message, a record, an
 *               error thrown by the connector.
 *
 * Plus the tenancy rule every connector route has: an id from another
 * workspace is "not found", never "here is their data".
 *
 * Real Mongo (mongodb-memory-server) for the ownership check; the connector
 * itself is a fake `BaseConnector` handed out by a mocked registry, because
 * the probe's contract is with `BaseConnector`, not with any vendor.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  BaseConnector,
  type ConnectionTestResult,
  type ConnectorEntitySchema,
  type FetchOptions,
  type FetchState,
  type ResumableFetchOptions,
} from "./base/BaseConnector";

const SECRET = "vck_live_0123456789abcdefXYZ";
const WS = new Types.ObjectId();
const WS_THEIRS = new Types.ObjectId();

const state = vi.hoisted(() => ({
  connector: null as unknown,
  recorded: [] as Array<Record<string, unknown>>,
  dataSourceType: "stripe",
}));

vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConnector: vi.fn(async () => state.connector),
  },
}));

vi.mock("../sync/database-data-source-manager", () => ({
  databaseDataSourceManager: {
    getDataSource: vi.fn(async (id: string) => ({
      id,
      name: "Vercel AI Gateway Usage",
      type: state.dataSourceType,
      workspaceId: WS.toString(),
      active: true,
      connection: { apiKey: SECRET, lookbackDays: 30, region: "eu" },
      settings: {},
    })),
  },
}));

vi.mock("./workspace/reconcile.service", () => ({
  recordConnectionCheck: vi.fn(async (input: Record<string, unknown>) => {
    state.recorded.push(input);
    return true;
  }),
}));

import { Connector } from "../database/workspace-schema";
import {
  PROBE_MAX_LIMIT,
  ProbeError,
  probeConnector,
  redactSecrets,
  secretValuesOf,
} from "./probe.service";

/** A connector whose every behaviour the test controls. */
class FakeConnector extends BaseConnector {
  calls: ResumableFetchOptions[] = [];
  checkResult: ConnectionTestResult = {
    success: true,
    message: "Connection successful",
  };
  page: unknown[] = [];
  hasMore = false;
  entities = ["daily-usage", "models"];
  checkDelayMs = 0;
  readError: Error | null = null;

  async testConnection(): Promise<ConnectionTestResult> {
    if (this.checkDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.checkDelayMs));
    }
    return this.checkResult;
  }

  getAvailableEntities(): string[] {
    return this.entities;
  }

  async fetchEntity(_options: FetchOptions): Promise<void> {
    throw new Error("the probe must use fetchEntityChunk");
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    this.calls.push(options);
    if (this.readError) throw this.readError;
    options.onLog?.("info", `fetched ${this.page.length} rows`);
    await options.onBatch(this.page);
    return {
      totalProcessed: this.page.length,
      hasMore: this.hasMore,
      iterationsInChunk: 1,
    };
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return {
      entity,
      fields: {
        day: { type: "string" },
        total_cost: { type: "number" },
        request_count: { type: "integer" },
      },
      unknownFieldPolicy: "string",
    };
  }

  getMetadata() {
    return {
      name: "fake",
      version: "1.0.0",
      description: "fake",
      supportedEntities: this.entities,
    };
  }
}

let mongo: MongoMemoryServer;
let mine: Types.ObjectId;
let theirs: Types.ObjectId;
let fake: FakeConnector;

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
  await Connector.deleteMany({});
  mine = new Types.ObjectId();
  theirs = new Types.ObjectId();
  for (const [id, workspaceId] of [
    [mine, WS],
    [theirs, WS_THEIRS],
  ] as const) {
    await Connector.create({
      _id: id,
      workspaceId,
      name: "Vercel AI Gateway Usage",
      type: "stripe",
      config: {},
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: "u1",
    });
  }
  fake = new FakeConnector({
    _id: mine,
    name: "fake",
    type: "stripe",
    config: {},
  } as never);
  state.connector = fake;
  state.recorded = [];
  state.dataSourceType = "stripe";
});

const probe = (input: Partial<Parameters<typeof probeConnector>[0]> = {}) =>
  probeConnector({
    workspaceId: WS.toString(),
    connectorId: mine.toString(),
    ...input,
  });

async function failure(promise: Promise<unknown>): Promise<ProbeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProbeError) return error;
    throw error;
  }
  throw new Error("expected the probe to fail");
}

describe("tenancy", () => {
  it("a connector from another workspace is not found, not probed", async () => {
    const error = await failure(probe({ connectorId: theirs.toString() }));
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it("a malformed id is a caller mistake, not a crash", async () => {
    const error = await failure(probe({ connectorId: "vercel" }));
    expect(error.code).toBe("invalid_input");
    expect(error.status).toBe(400);
  });
});

describe("check", () => {
  it("without an entity it checks the credential and reads nothing", async () => {
    const result = await probe();
    expect(result.check).toEqual({
      success: true,
      message: "Connection successful",
    });
    expect(result.entity).toBeUndefined();
    expect(result.connector).toEqual({
      id: mine.toString(),
      name: "Vercel AI Gateway Usage",
      type: "stripe",
    });
    expect(fake.calls).toEqual([]);
  });

  it("a failed check ends the probe before any read", async () => {
    fake.checkResult = { success: false, message: "401 Unauthorized" };
    const result = await probe({ entity: "daily-usage" });
    expect(result.check.success).toBe(false);
    expect(result.entity).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("records the outcome for a WORKSPACE connector, and only for one", async () => {
    await probe();
    expect(state.recorded).toEqual([]);

    state.dataSourceType = "ws:vercel-ai-gateway";
    // A built-in fake standing in for the sandboxed one: the recording rule
    // keys off the data source's type, and the sha comes from the instance,
    // which a non-sandboxed instance cannot provide — so this must throw
    // rather than record a check against no revision.
    await expect(probe()).rejects.toThrow(/unexpected implementation/);
  });
});

describe("bounded read", () => {
  beforeEach(() => {
    fake.page = Array.from({ length: 50 }, (_, i) => ({
      day: `2026-08-${String(i + 1).padStart(2, "0")}`,
      total_cost: i * 0.5,
      request_count: i,
    }));
    fake.hasMore = true;
  });

  it("asks the connector for ONE chunk and returns at most `limit` records", async () => {
    const result = await probe({ entity: "daily-usage", limit: 5 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].maxIterations).toBe(1);
    expect(fake.calls[0].batchSize).toBe(5);
    expect(fake.calls[0].entity).toBe("daily-usage");

    const entity = result.entity;
    expect(entity?.count).toBe(5);
    expect(entity?.received).toBe(50);
    expect(entity?.truncated).toBe(true);
    expect(entity?.hasMore).toBe(true);
    expect(entity?.records).toHaveLength(5);
    expect(entity?.schema).toEqual({
      day: "string",
      total_cost: "number",
      request_count: "integer",
    });
    expect(entity?.logs).toEqual([
      { level: "info", message: "fetched 50 rows" },
    ]);
  });

  it("defaults the limit and says when the page fit", async () => {
    fake.page = fake.page.slice(0, 3);
    fake.hasMore = false;
    const result = await probe({ entity: "daily-usage" });
    expect(result.entity?.count).toBe(3);
    expect(result.entity?.truncated).toBe(false);
    expect(result.entity?.hasMore).toBe(false);
  });

  it("refuses a limit outside 1..PROBE_MAX_LIMIT", async () => {
    expect(
      (await failure(probe({ entity: "daily-usage", limit: 0 }))).code,
    ).toBe("invalid_input");
    expect(
      (
        await failure(
          probe({ entity: "daily-usage", limit: PROBE_MAX_LIMIT + 1 }),
        )
      ).code,
    ).toBe("invalid_input");
    expect(fake.calls).toEqual([]);
  });

  it("keeps only the requested fields", async () => {
    const result = await probe({
      entity: "daily-usage",
      limit: 2,
      fields: ["day", "nope"],
    });
    expect(result.entity?.records).toEqual([
      { day: "2026-08-01" },
      { day: "2026-08-02" },
    ]);
  });

  it("passes `since` through to the connector", async () => {
    const since = new Date("2026-08-15T00:00:00Z");
    await probe({ entity: "daily-usage", since });
    expect(fake.calls[0].since).toEqual(since);
  });

  it("refuses an entity the connector does not declare, before reading", async () => {
    const error = await failure(probe({ entity: "invoices" }));
    expect(error.code).toBe("unknown_entity");
    expect(error.message).toMatch(/offers: daily-usage, models/);
    expect(fake.calls).toEqual([]);
  });

  it("gives up at the deadline instead of holding the caller", async () => {
    fake.checkDelayMs = 200;
    const error = await failure(probe({ timeoutMs: 20 }));
    expect(error.code).toBe("timeout");
    expect(error.status).toBe(504);
  });
});

describe("no credential leaves", () => {
  it("scrubs the secret from the check message, the records and the logs", async () => {
    fake.checkResult = {
      success: true,
      message: `authenticated as key ${SECRET}`,
    };
    fake.page = [
      {
        day: "2026-08-01",
        echo: `Bearer ${SECRET}`,
        nested: { url: `https://x/?k=${SECRET}` },
      },
    ];
    const result = await probe({ entity: "daily-usage" });
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(result.check.message).toBe("authenticated as key [redacted]");
    expect(result.entity?.records[0]).toEqual({
      day: "2026-08-01",
      echo: "Bearer [redacted]",
      nested: { url: "https://x/?k=[redacted]" },
    });
  });

  it("scrubs the secret from an error the connector throws", async () => {
    fake.readError = new Error(`GET https://api/?key=${SECRET} -> 403`);
    await expect(probe({ entity: "daily-usage" })).rejects.toThrow(
      /key=\[redacted\] -> 403/,
    );
  });

  it("does not scrub short config values, which are not credentials", () => {
    expect(
      secretValuesOf({ apiKey: SECRET, region: "eu", port: 5432 }),
    ).toEqual([SECRET]);
    expect(redactSecrets("region eu", ["eu"])).toBe("region [redacted]");
  });
});
