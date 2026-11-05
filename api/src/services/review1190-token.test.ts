/**
 * Review of PR #1190: token renewal covers pages. Does it cover the job poll,
 * and is a page requested with a live token when the renewal margin holds?
 */
import { describe, expect, it, vi } from "vitest";
import { databaseConnectionService } from "./database-connection.service";

type Internals = {
  getBigQueryHttpClient: (...args: unknown[]) => Promise<unknown>;
  getBigQueryPollIntervalMs: () => number;
  executeBigQueryStreamingQuery: (
    database: unknown,
    query: string,
    options: unknown,
  ) => Promise<{ success: boolean; totalRows: number; error?: string }>;
};

const schema = { fields: [{ name: "n", type: "INTEGER" }] };
const http401 = () =>
  Object.assign(new Error("401"), {
    response: {
      status: 401,
      data: { error: { message: "invalid authentication credentials" } },
    },
  });

describe("BigQuery token renewal in the poll loop", () => {
  it("DEFECT: a token that expires while the job is still running must not fail the build", async () => {
    const service = databaseConnectionService as unknown as Internals;
    vi.spyOn(service, "getBigQueryPollIntervalMs").mockReturnValue(1);
    const held = {
      post: vi.fn(async () => ({
        data: { jobComplete: false, jobReference: { jobId: "job" } },
      })),
      get: vi.fn(async () => {
        throw http401();
      }),
    };
    const renewed = {
      post: held.post,
      get: vi.fn(async () => ({
        data: {
          jobComplete: true,
          jobReference: { jobId: "job" },
          schema,
          rows: [{ f: [{ v: "1" }] }],
        },
      })),
    };
    vi.spyOn(service, "getBigQueryHttpClient")
      .mockResolvedValueOnce(held)
      .mockResolvedValue(renewed);

    const result = await service.executeBigQueryStreamingQuery(
      {
        type: "bigquery",
        connection: {
          project_id: "p",
          service_account_json: { client_email: "a@b", private_key: "k" },
        },
      },
      "SELECT 1",
      { batchSize: 1, onBatch: vi.fn(async () => undefined) },
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });
});
