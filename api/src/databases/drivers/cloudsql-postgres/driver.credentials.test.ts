/**
 * A Cloud SQL connection signs in with the tenant's own service account.
 * Without one it is refused before any Google client or connector exists, so
 * Mako's Application Default Credentials (its Cloud Run service account) are
 * never used for a tenant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectorCtor = vi.hoisted(() => vi.fn());
vi.mock("@google-cloud/cloud-sql-connector", () => ({
  Connector: class {
    constructor(opts: unknown) {
      connectorCtor(opts);
    }
    close() {}
  },
  AuthTypes: { IAM: "IAM", PASSWORD: "PASSWORD" },
  IpAddressTypes: { PUBLIC: "PUBLIC", PRIVATE: "PRIVATE", PSC: "PSC" },
}));

import { GoogleAuth, JWT } from "google-auth-library";
import { CloudSQLPostgresDatabaseDriver } from "./driver";

const key = {
  type: "service_account",
  project_id: "tenant-proj",
  client_email: "tenant@tenant-proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
};

function db(connection: Record<string, unknown>): any {
  return {
    _id: { toString: () => "c1" },
    type: "cloudsql-postgres",
    connection: {
      instanceConnectionName: "mako-prod:europe-west1:mako-db",
      authType: "IAM",
      ...connection,
    },
  };
}

describe("cloudsql-postgres tenant credentials", () => {
  const adc = vi.spyOn(GoogleAuth.prototype, "getClient");
  const token = vi.spyOn(JWT.prototype, "getAccessToken");

  beforeEach(() => {
    connectorCtor.mockClear();
    adc.mockReset().mockRejectedValue(new Error("ADC must not be used"));
    token.mockReset().mockResolvedValue({ token: "t" } as never);
  });

  it.each([
    ["no key", undefined],
    ["empty key", ""],
    [
      "not a service account",
      JSON.stringify({ ...key, type: "authorized_user" }),
    ],
  ])("refuses %s without touching ADC or the connector", async (_n, sa) => {
    const driver = new CloudSQLPostgresDatabaseDriver();
    await expect(
      (driver as any)._getConnector(db({ service_account_json: sa })),
    ).rejects.toThrow(/service.account|credential type/i);
    expect(adc).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(connectorCtor).not.toHaveBeenCalled();
  });

  it("refuses the connection test and pool creation too", async () => {
    const driver = new CloudSQLPostgresDatabaseDriver();
    const bad = db({ service_account_json: undefined });
    const result = await (driver as any).testConnection(bad);
    expect(result.success).toBe(false);
    await expect(driver.getConnection(bad)).rejects.toThrow(
      /service.account|credential type/i,
    );
    expect(adc).not.toHaveBeenCalled();
    expect(connectorCtor).not.toHaveBeenCalled();
  });

  it("uses only the tenant's service account", async () => {
    const driver = new CloudSQLPostgresDatabaseDriver();
    await (driver as any)._getConnector(
      db({ service_account_json: JSON.stringify(key) }),
    );
    expect(adc).not.toHaveBeenCalled();
    expect(token).toHaveBeenCalledTimes(1);
    expect(connectorCtor).toHaveBeenCalledTimes(1);
    const auth = connectorCtor.mock.calls[0][0].auth as JWT;
    expect(auth).toBeInstanceOf(JWT);
    expect(auth.email).toBe(key.client_email);
  });
});
