/**
 * A BigQuery CDC destination signs in with the tenant's own service account.
 * Without one it is refused before a BigQuery client exists, so the client
 * never falls back to Mako's Application Default Credentials.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientCtor = vi.hoisted(() => vi.fn());
vi.mock("@google-cloud/bigquery", () => ({
  BigQuery: class {
    constructor(opts: unknown) {
      clientCtor(opts);
    }
    dataset() {
      return { getMetadata: async () => [{ location: "EU" }] };
    }
  },
}));

import { BigQueryDestinationAdapter } from "./bigquery";

const key = {
  type: "service_account",
  project_id: "tenant-proj",
  client_email: "tenant@tenant-proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
};

function adapter(connection: Record<string, unknown>) {
  const a = new BigQueryDestinationAdapter({
    workspaceId: "w",
    destinationDatabaseId: "d",
    tableDestination: { schema: "ds" },
  } as never);
  (a as any).resolveDestination = async () => ({ connection });
  return a as any;
}

describe("bigquery destination tenant credentials", () => {
  beforeEach(() => clientCtor.mockClear());

  it.each([
    ["no key", undefined],
    ["empty key", ""],
    ["not a service account", { ...key, type: "authorized_user" }],
  ])("refuses %s without creating a client", async (_n, sa) => {
    await expect(
      adapter({ project_id: "p", service_account_json: sa }).resolveBqClient(),
    ).rejects.toThrow(/service account/i);
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it("uses only the tenant's service account", async () => {
    await adapter({
      project_id: "p",
      service_account_json: JSON.stringify(key),
    }).resolveBqClient();
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor.mock.calls[0][0].credentials.client_email).toBe(
      key.client_email,
    );
  });
});
