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

  console.log("bigquery-abandoned-job: all assertions passed");
}

void main();
