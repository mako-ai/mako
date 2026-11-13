/**
 * Giving up on a BigQuery query must also STOP it.
 *
 * When the poll loop hits its ceiling the HTTP request ends, but the job does
 * not: it runs to completion, scans what it was going to scan, and bills for
 * a result nobody will read. On 2026-09-01 one app's two bindings abandoned 41
 * such jobs in 48 minutes. So the timeout path cancels, and — because it is
 * already a failing path — a failed cancel must never replace the timeout the
 * caller needs to hear about.
 */
import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import {
  FAKE_BIGQUERY_SERVICE_ACCOUNT,
  makeFakeConnection,
} from "../databases/test-support/fake-connection";
import { databaseConnectionService } from "./database-connection.service";

type CancelInput = {
  client: AxiosInstance;
  projectId: string;
  jobId: string;
  location?: string;
  executionId?: string;
};

// The method is private by design — nothing outside the class should be
// cancelling jobs — but its behaviour is the whole point of the change.
const cancel = (input: CancelInput): Promise<boolean> =>
  (
    databaseConnectionService as unknown as {
      cancelAbandonedBigQueryJob(i: CancelInput): Promise<boolean>;
    }
  ).cancelAbandonedBigQueryJob(input);

async function main(): Promise<void> {
  const posts: Array<{ url: string; params: unknown }> = [];
  const okClient = {
    post: async (
      url: string,
      _body: unknown,
      config?: { params?: unknown },
    ) => {
      posts.push({ url, params: config?.params });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  // It calls BigQuery's own jobs.cancel, with the location — a job in
  // europe-west6 is not addressable without it, so omitting it would "succeed"
  // at cancelling nothing.
  assert.equal(
    await cancel({
      client: okClient,
      projectId: "warehouse-prod",
      jobId: "job_abc123",
      location: "europe-west6",
    }),
    true,
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/projects/warehouse-prod/jobs/job_abc123/cancel");
  assert.deepEqual(posts[0].params, { location: "europe-west6" });

  // A job with no location is still cancellable; the param is simply absent.
  posts.length = 0;
  await cancel({ client: okClient, projectId: "p", jobId: "j" });
  assert.deepEqual(posts[0].params, {});

  // The path this runs on is ALREADY failing. A cancel that throws must be
  // swallowed and reported as "not cancelled", never rethrown over the timeout.
  const angryClient = {
    post: async () => {
      throw new Error("403 Forbidden: bigquery.jobs.update denied");
    },
  } as unknown as AxiosInstance;
  assert.equal(
    await cancel({ client: angryClient, projectId: "p", jobId: "j" }),
    false,
    "a failed cancel must resolve false, not reject",
  );

  await testAbortCancelsTheStartedJob();
  await testDatasetLocation();

  console.log("bigquery-abandoned-job: all assertions passed");
}

type FakeClient = {
  posts: Array<{ url: string; params?: unknown }>;
  gets: Array<{ url: string; params?: unknown; signal?: unknown }>;
};

/** Swap the service's BigQuery HTTP client for one that records calls. */
function stubBigQueryClient(handlers: {
  post?: (url: string) => unknown;
  get?: (url: string) => unknown;
}): FakeClient & { restore: () => void } {
  const calls: FakeClient = { posts: [], gets: [] };
  const client = {
    post: async (
      url: string,
      _body: unknown,
      config?: { params?: unknown },
    ) => {
      calls.posts.push({ url, params: config?.params });
      return { data: handlers.post?.(url) ?? {} };
    },
    get: async (
      url: string,
      config?: { params?: unknown; signal?: unknown },
    ) => {
      calls.gets.push({ url, params: config?.params, signal: config?.signal });
      return { data: handlers.get?.(url) ?? {} };
    },
  } as unknown as AxiosInstance;
  const service = databaseConnectionService as unknown as {
    getBigQueryHttpClient(...args: unknown[]): Promise<AxiosInstance>;
  };
  const original = service.getBigQueryHttpClient;
  service.getBigQueryHttpClient = async () => client;
  return {
    ...calls,
    restore: () => {
      service.getBigQueryHttpClient = original;
    },
  };
}

const connection = makeFakeConnection("bigquery", {
  project_id: "fake-project",
  service_account_json: FAKE_BIGQUERY_SERVICE_ACCOUNT,
});

/**
 * A caller that goes away (a stopped chat turn, a timed-out MCP call) aborts
 * its signal. The poll loop then stops, and so must the job: BigQuery would
 * otherwise run it to the end and bill a result nobody reads.
 */
async function testAbortCancelsTheStartedJob(): Promise<void> {
  const previousInterval = process.env.BIGQUERY_QUERY_POLL_INTERVAL_MS;
  process.env.BIGQUERY_QUERY_POLL_INTERVAL_MS = "100";
  const controller = new AbortController();
  const stub = stubBigQueryClient({
    post: url =>
      url.endsWith("/queries")
        ? {
            jobComplete: false,
            jobReference: { jobId: "job_running", location: "EU" },
          }
        : {},
    // Still running on every poll.
    get: () => ({ jobComplete: false }),
  });
  try {
    setTimeout(() => controller.abort(), 150);
    const result = await databaseConnectionService.executeQuery(
      connection,
      "SELECT 1",
      { readOnly: true, signal: controller.signal },
    );
    assert.deepEqual(result, { success: false, error: "Query cancelled" });
    // The job that was started is cancelled, in its own location.
    const cancels = stub.posts.filter(post => post.url.endsWith("/cancel"));
    assert.equal(cancels.length, 1);
    assert.equal(
      cancels[0].url,
      "/projects/fake-project/jobs/job_running/cancel",
    );
    assert.deepEqual(cancels[0].params, { location: "EU" });

    // Aborted before any job exists: nothing to cancel, nothing started.
    stub.posts.length = 0;
    const early = new AbortController();
    early.abort();
    const never = await databaseConnectionService.executeQuery(
      connection,
      "SELECT 1",
      { readOnly: true, signal: early.signal },
    );
    assert.deepEqual(never, { success: false, error: "Query cancelled" });
    assert.equal(stub.posts.length, 0);
  } finally {
    stub.restore();
    if (previousInterval === undefined) {
      delete process.env.BIGQUERY_QUERY_POLL_INTERVAL_MS;
    } else {
      process.env.BIGQUERY_QUERY_POLL_INTERVAL_MS = previousInterval;
    }
  }
}

/**
 * Job history is read in the region of the dataset in question. That region
 * comes from `datasets.get`, a global read: it needs no region to find one.
 */
async function testDatasetLocation(): Promise<void> {
  const controller = new AbortController();
  const stub = stubBigQueryClient({ get: () => ({ location: "EU" }) });
  try {
    assert.equal(
      await databaseConnectionService.getBigQueryDatasetLocation(
        connection,
        "analytics",
        { signal: controller.signal },
      ),
      "EU",
    );
    assert.equal(stub.gets[0].url, "/projects/fake-project/datasets/analytics");
    assert.deepEqual(stub.gets[0].params, { fields: "location" });
    assert.equal(stub.gets[0].signal, controller.signal);

    // A dataset of another, domain-scoped project: both parts are encoded.
    await databaseConnectionService.getBigQueryDatasetLocation(
      connection,
      "marts",
      { projectId: "example.com:other-project" },
    );
    assert.equal(
      stub.gets[1].url,
      "/projects/example.com%3Aother-project/datasets/marts",
    );
  } finally {
    stub.restore();
  }

  // A dataset that does not exist is null; any other failure throws.
  const service = databaseConnectionService as unknown as {
    getBigQueryHttpClient(...args: unknown[]): Promise<AxiosInstance>;
  };
  const original = service.getBigQueryHttpClient;
  const failing = (status: number) =>
    ({
      get: async () => {
        throw Object.assign(new Error(`HTTP ${status}`), {
          response: { status, data: { error: { message: "refused" } } },
        });
      },
    }) as unknown as AxiosInstance;
  try {
    service.getBigQueryHttpClient = async () => failing(404);
    assert.equal(
      await databaseConnectionService.getBigQueryDatasetLocation(
        connection,
        "gone",
      ),
      null,
    );
    service.getBigQueryHttpClient = async () => failing(403);
    await assert.rejects(
      databaseConnectionService.getBigQueryDatasetLocation(
        connection,
        "analytics",
      ),
    );
  } finally {
    service.getBigQueryHttpClient = original;
  }
}

void main();
