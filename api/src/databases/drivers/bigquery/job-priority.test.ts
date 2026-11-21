/**
 * Sync writes run at BigQuery BATCH priority, reads stay INTERACTIVE
 * (services/bigquery-job-priority.ts).
 *
 * Pins, through the real engine with a fake REST client:
 * - CDC MERGEs, hard deletes, truncates, soft-delete purges and
 *   DestinationWriter writes start a jobs.insert with priority BATCH;
 * - app bindings, consoles and agents start a jobs.query (INTERACTIVE);
 * - BQ_SYNC_WRITE_PRIORITY=INTERACTIVE puts sync writes back on jobs.query;
 * - a BATCH job queued in PENDING longer than its run budget still succeeds,
 *   and one queued past BQ_BATCH_PENDING_MAX_WAIT_MS is cancelled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const purgeMocks = vi.hoisted(() => ({
  flow: null as Record<string, unknown> | null,
  destination: null as Record<string, unknown> | null,
}));

vi.mock("../../../database/workspace-schema", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../../database/workspace-schema")>();
  return {
    ...actual,
    Flow: {
      findOne: () => ({ lean: async () => purgeMocks.flow }),
    },
    DatabaseConnection: {
      ...actual.DatabaseConnection,
      findOne: async () => purgeMocks.destination,
    },
  };
});

import { bigQueryEngine, batchJobInsertBody } from "./engine";
import { BigQueryDatabaseDriver } from "./driver";
import { databaseRegistry } from "../../registry";
import { DestinationWriter } from "../../../services/destination-writer.service";
import { BigQueryDestinationAdapter } from "../../../sync-cdc/adapters/bigquery";
import type { BigQueryTarget } from "../../../sync-cdc/adapters/bigquery-target";
import { purgeSoftDeletesAfterBackfill } from "../../../sync-cdc/backfill/completion";
import { withQueryLabels } from "../../../services/bigquery-labels";
import {
  asSyncWrite,
  resolveBigQueryJobPriority,
  syncWritePriority,
  withBigQueryJobPriority,
} from "../../../services/bigquery-job-priority";
import {
  FAKE_BIGQUERY_SERVICE_ACCOUNT,
  makeFakeConnection,
} from "../../test-support";
import type { IDatabaseConnection } from "../../../database/workspace-schema";

interface Call {
  method: "post" | "get";
  url: string;
  body?: Record<string, unknown>;
}

/** How the fake answers jobs.get: one state per call, the last repeats. */
let jobStates: string[] = [];
let calls: Call[] = [];

const fakeClient = {
  post: async (url: string, body: Record<string, unknown>) => {
    calls.push({ method: "post", url, body });
    if (url.endsWith("/jobs")) {
      return {
        data: {
          jobReference: { jobId: "batch_job", location: "EU" },
          status: { state: "PENDING" },
        },
      };
    }
    if (url.endsWith("/cancel")) return { data: {} };
    return {
      data: {
        jobComplete: true,
        jobReference: { jobId: "interactive_job", location: "EU" },
        numDmlAffectedRows: "1",
      },
    };
  },
  get: async (url: string) => {
    calls.push({ method: "get", url });
    if (/\/jobs\/[^/]+$/.test(url)) {
      const state =
        jobStates.length > 1 ? jobStates.shift() : (jobStates[0] ?? "DONE");
      return { data: { status: { state } } };
    }
    return { data: { jobComplete: true, numDmlAffectedRows: "1" } };
  },
};

const engine = bigQueryEngine as unknown as {
  getHttpClient: (...args: unknown[]) => Promise<unknown>;
};
const originalGetHttpClient = engine.getHttpClient;

const database = makeFakeConnection("bigquery", {
  project_id: "proj",
  service_account_json: FAKE_BIGQUERY_SERVICE_ACCOUNT,
  location: "EU",
}) as IDatabaseConnection & { workspaceId: string };
(database as { workspaceId: string }).workspaceId = "665f00000000000000000001";

/** The priority each started job ran at: jobs.insert says, jobs.query is INTERACTIVE. */
function startedPriorities(): string[] {
  return calls
    .filter(
      c =>
        c.method === "post" &&
        (c.url.endsWith("/jobs") || c.url.endsWith("/queries")),
    )
    .map(c =>
      c.url.endsWith("/jobs")
        ? String(
            (
              (c.body?.configuration as Record<string, unknown>)
                ?.query as Record<string, unknown>
            )?.priority,
          )
        : "INTERACTIVE",
    );
}

beforeEach(() => {
  calls = [];
  jobStates = ["RUNNING"];
  engine.getHttpClient = async () => fakeClient;
  vi.stubEnv("BIGQUERY_QUERY_POLL_INTERVAL_MS", "100");
});

afterEach(() => {
  engine.getHttpClient = originalGetHttpClient;
  vi.unstubAllEnvs();
});

describe("priority resolution", () => {
  it("sync writes default to BATCH; the env rolls them back", () => {
    expect(syncWritePriority()).toBe("BATCH");
    vi.stubEnv("BQ_SYNC_WRITE_PRIORITY", "interactive");
    expect(syncWritePriority()).toBe("INTERACTIVE");
    vi.stubEnv("BQ_SYNC_WRITE_PRIORITY", "nonsense");
    expect(syncWritePriority()).toBe("BATCH");
  });

  it("an explicit option beats the context, the context beats INTERACTIVE", () => {
    expect(resolveBigQueryJobPriority()).toBe("INTERACTIVE");
    withBigQueryJobPriority("BATCH", () => {
      expect(resolveBigQueryJobPriority()).toBe("BATCH");
      expect(resolveBigQueryJobPriority("INTERACTIVE")).toBe("INTERACTIVE");
    });
  });

  it("builds a jobs.insert body with labels, location and caps in place", () => {
    expect(
      batchJobInsertBody("proj", {
        query: "MERGE x",
        location: "EU",
        labels: { mako_source: "cdc" },
        maximumBytesBilled: "100",
        jobTimeoutMs: "5000",
      }),
    ).toEqual({
      jobReference: { projectId: "proj", location: "EU" },
      configuration: {
        query: {
          query: "MERGE x",
          useLegacySql: false,
          priority: "BATCH",
          maximumBytesBilled: "100",
        },
        labels: { mako_source: "cdc" },
        jobTimeoutMs: "5000",
      },
    });
  });
});

describe("read paths stay INTERACTIVE", () => {
  it("app bindings, consoles and agents start a jobs.query", async () => {
    for (const source of ["app_binding", "console", "agent", "notebook"]) {
      const result = await withQueryLabels({ mako_source: source }, () =>
        bigQueryEngine.executeQuery(database, "SELECT 1"),
      );
      expect(result.success).toBe(true);
    }
    expect(startedPriorities()).toEqual([
      "INTERACTIVE",
      "INTERACTIVE",
      "INTERACTIVE",
      "INTERACTIVE",
    ]);
    expect(calls.some(c => c.url.endsWith("/jobs"))).toBe(false);
  });
});

describe("sync write paths run at BATCH", () => {
  function cdcAdapter(): BigQueryDestinationAdapter {
    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: "conn-1",
      workspaceId: "665f00000000000000000001",
      tableDestination: {
        connectionId: "conn-1",
        schema: "ds",
        tableName: "users",
      },
    });
    const target = {
      bq: {},
      projectId: "proj",
      dataset: "ds",
      destination: database,
      datasetLocation: "EU",
    } as unknown as BigQueryTarget;
    (
      adapter as unknown as { resolveBqClient: () => Promise<BigQueryTarget> }
    ).resolveBqClient = async () => target;
    return adapter;
  }

  const layout = {
    tableName: "users",
    keyColumns: ["id"],
    deleteMode: "hard",
  } as never;

  it("CDC hard deletes and truncates start a BATCH jobs.insert", async () => {
    const adapter = cdcAdapter();
    await adapter.applyEvents({
      events: [
        {
          recordId: "r1",
          operation: "delete",
          ingestSeq: 1,
          sourceTs: new Date().toISOString(),
          payload: {},
        },
      ] as never,
      layout,
      flow: { _id: "f1", deleteMode: "hard" } as never,
    });
    await adapter.truncateLiveTable(layout);
    expect(startedPriorities()).toEqual(["BATCH", "BATCH"]);
    const insert = calls.find(c => c.url === "/projects/proj/jobs");
    expect(insert?.body?.configuration).toMatchObject({
      query: { priority: "BATCH" },
    });
    expect(insert?.body?.jobReference).toEqual({
      projectId: "proj",
      location: "EU",
    });
  });

  it("BQ_SYNC_WRITE_PRIORITY=INTERACTIVE puts CDC writes back on jobs.query", async () => {
    vi.stubEnv("BQ_SYNC_WRITE_PRIORITY", "INTERACTIVE");
    await cdcAdapter().truncateLiveTable(layout);
    expect(startedPriorities()).toEqual(["INTERACTIVE"]);
  });

  it("DestinationWriter writes run at BATCH; the env restores INTERACTIVE", async () => {
    const writer = new DestinationWriter({
      workspaceId: "665f00000000000000000001",
      tableDestination: {
        connectionId: "conn-1",
        tableName: "users",
        schema: "ds",
      } as never,
    });
    writer._injectForTest(new BigQueryDatabaseDriver(), database);
    await writer.deleteByKeys({ id: 1 });
    expect(startedPriorities()).toEqual(["BATCH"]);

    calls = [];
    vi.stubEnv("BQ_SYNC_WRITE_PRIORITY", "INTERACTIVE");
    await writer.deleteByKeys({ id: 1 });
    expect(startedPriorities()).toEqual(["INTERACTIVE"]);
  });

  it("the soft-delete purge after a backfill runs at BATCH", async () => {
    purgeMocks.flow = {
      _id: "665f000000000000000000aa",
      workspaceId: "665f00000000000000000001",
      deleteMode: "hard",
      tableDestination: { connectionId: "conn-1", schema: "ds" },
      entityFilter: ["users"],
    };
    purgeMocks.destination = database as unknown as Record<string, unknown>;
    databaseRegistry.getOrRegister(
      "bigquery",
      () => new BigQueryDatabaseDriver(),
    );
    await purgeSoftDeletesAfterBackfill({
      workspaceId: "665f00000000000000000001",
      flowId: "665f000000000000000000aa",
    });
    const priorities = startedPriorities();
    expect(priorities.length).toBeGreaterThan(0);
    expect(new Set(priorities)).toEqual(new Set(["BATCH"]));
  });

  it("asSyncWrite reaches driver helpers that take no options", async () => {
    await asSyncWrite(() =>
      bigQueryEngine.executeQuery(database, "DELETE FROM t WHERE TRUE"),
    );
    expect(startedPriorities()).toEqual(["BATCH"]);
  });
});

describe("a queued BATCH job does not trip the sync timeout", () => {
  it("waits out PENDING longer than its run budget, then succeeds", async () => {
    // 100 + 200 + 400 + 800 ms of PENDING: 1.5 s, over the 1 s run budget.
    jobStates = ["PENDING", "PENDING", "PENDING", "PENDING", "RUNNING"];
    const result = await bigQueryEngine.executeQuery(database, "MERGE t", {
      priority: "BATCH",
      bigQueryJobMaxWaitMs: 1000,
    });
    expect(result.success).toBe(true);
    expect(calls.some(c => c.url.endsWith("/cancel"))).toBe(false);
    expect(
      calls.filter(c => c.method === "get" && /\/jobs\/batch_job$/.test(c.url))
        .length,
    ).toBe(5);
  });

  it("gives up and cancels after BQ_BATCH_PENDING_MAX_WAIT_MS", async () => {
    vi.stubEnv("BQ_BATCH_PENDING_MAX_WAIT_MS", "1000");
    jobStates = ["PENDING"];
    const result = await bigQueryEngine.executeQuery(database, "MERGE t", {
      priority: "BATCH",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/BATCH query still queued after 1 seconds/);
    expect(result.bigQueryJobOutcomeUnknown).toBe(true);
    expect(calls.some(c => c.url.endsWith("/cancel"))).toBe(true);
  });
});

describe("the BigQuery job completion status on failure", () => {
  it.each(["BATCH", "INTERACTIVE"] as const)(
    "is unknown when the %s submission response is lost",
    async priority => {
      const post = vi.fn().mockRejectedValue(new Error("socket hang up"));
      engine.getHttpClient = async () => ({ ...fakeClient, post });

      const result = await bigQueryEngine.executeQuery(database, "MERGE t", {
        priority,
      });

      expect(post).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("socket hang up"),
        bigQueryJobOutcomeUnknown: true,
      });
    },
  );

  it("distinguishes a 403 submission rejection from a 404 polling failure", async () => {
    engine.getHttpClient = async () => ({
      ...fakeClient,
      post: vi.fn().mockRejectedValue({
        isAxiosError: true,
        response: { status: 403 },
      }),
    });
    const rejected = await bigQueryEngine.executeQuery(database, "MERGE t", {
      priority: "BATCH",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.bigQueryJobOutcomeUnknown).toBeUndefined();

    engine.getHttpClient = async () => ({
      ...fakeClient,
      get: vi.fn().mockRejectedValue({
        isAxiosError: true,
        response: { status: 404 },
      }),
    });
    const unconfirmed = await bigQueryEngine.executeQuery(database, "MERGE t", {
      priority: "BATCH",
    });
    expect(unconfirmed.success).toBe(false);
    expect(unconfirmed.bigQueryJobOutcomeUnknown).toBe(true);
  });

  it("recognizes an observed terminal job even if fetching results fails", async () => {
    jobStates = ["DONE"];
    engine.getHttpClient = async () => ({
      ...fakeClient,
      get: (url: string) =>
        url.includes("/jobs/")
          ? fakeClient.get(url)
          : Promise.reject(new Error("results unavailable")),
    });

    const result = await bigQueryEngine.executeQuery(database, "MERGE t", {
      priority: "BATCH",
    });

    expect(result.success).toBe(false);
    expect(result.bigQueryJobOutcomeUnknown).toBeUndefined();
  });

  it.each(["DONE", "RUNNING"] as const)(
    "checks exact job metadata after a quota error while polling, state %s",
    async state => {
      jobStates = ["RUNNING", state];
      const get = vi.fn((url: string, _options?: unknown) =>
        url.includes("/jobs/")
          ? fakeClient.get(url)
          : Promise.reject({
              isAxiosError: true,
              response: {
                status: 403,
                data: { error: { message: "Exceeded table update quota" } },
              },
            }),
      );
      engine.getHttpClient = async () => ({ ...fakeClient, get });

      const result = await bigQueryEngine.executeQuery(database, "MERGE t", {
        priority: "BATCH",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Exceeded table update quota");
      expect(result.bigQueryJobOutcomeUnknown).toBe(
        state === "DONE" ? undefined : true,
      );
      expect(get).toHaveBeenCalledTimes(3);
      expect(get).toHaveBeenLastCalledWith(
        "/projects/proj/jobs/batch_job",
        expect.objectContaining({ params: { location: "EU" }, timeout: 5000 }),
      );
    },
  );

  it("fails a BATCH submission response with no job ID", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { status: { state: "DONE" } } });
    engine.getHttpClient = async () => ({ ...fakeClient, post });

    const result = await bigQueryEngine.executeQuery(database, "MERGE t", {
      priority: "BATCH",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("BigQuery did not return a job ID");
    expect(post).toHaveBeenCalledTimes(1);
  });
});
