/**
 * A BigQuery result stream can outlive the token it started with. Two deploys
 * died on 2026-11-03 with "invalid authentication credentials (HTTP 401)" after
 * 250+ seconds of paging one binding. Each page must ask for the client, since
 * that call is what renews an expiring token.
 */
import { describe, expect, it, vi } from "vitest";
import { databaseConnectionService } from "./database-connection.service";

type Internals = {
  getBigQueryHttpClient: (...args: unknown[]) => Promise<unknown>;
  executeBigQueryStreamingQuery: (
    database: unknown,
    query: string,
    options: unknown,
  ) => Promise<{ success: boolean; totalRows: number; error?: string }>;
};

describe("BigQuery streaming auth", () => {
  it("renews the client between pages, so a token expiring mid-stream does not fail the build", async () => {
    const service = databaseConnectionService as unknown as Internals;
    const schema = { fields: [{ name: "n", type: "INTEGER" }] };
    const page = (n: number, pageToken?: string) => ({
      data: {
        jobComplete: true,
        jobReference: { jobId: "job", location: "EU" },
        schema,
        rows: [{ f: [{ v: String(n) }] }],
        ...(pageToken ? { pageToken } : {}),
      },
    });

    // The token renews once the first page is out: the original client then
    // answers what BigQuery answers an expired token.
    const expired = {
      post: vi.fn(async () => page(1, "p2")),
      get: vi.fn(async () => {
        throw Object.assign(new Error("401"), {
          response: {
            status: 401,
            data: { error: { message: "invalid authentication credentials" } },
          },
        });
      }),
    };
    const renewed = {
      get: vi
        .fn()
        .mockResolvedValueOnce(page(2, "p3"))
        .mockResolvedValueOnce(page(3)),
    };
    const clients = vi
      .spyOn(service, "getBigQueryHttpClient")
      .mockResolvedValueOnce(expired)
      .mockResolvedValue(renewed);

    const onBatch = vi.fn(async () => undefined);
    const result = await service.executeBigQueryStreamingQuery(
      {
        type: "bigquery",
        connection: { project_id: "warehouse", service_account_json: "{}" },
      },
      "select n",
      { batchSize: 1, onBatch },
    );

    expect(result).toEqual({ success: true, totalRows: 3 });
    expect(onBatch).toHaveBeenCalledTimes(3);
    expect(expired.get).not.toHaveBeenCalled();
    expect(renewed.get).toHaveBeenCalledTimes(2);
    // Once to start the job, once per later page.
    expect(clients).toHaveBeenCalledTimes(3);
    clients.mockRestore();
  });
});
