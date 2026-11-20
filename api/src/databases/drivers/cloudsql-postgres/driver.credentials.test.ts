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
    getOptions() {
      return {};
    }
    close() {}
  },
  AuthTypes: { IAM: "IAM", PASSWORD: "PASSWORD" },
  IpAddressTypes: { PUBLIC: "PUBLIC", PRIVATE: "PRIVATE", PSC: "PSC" },
}));

import { GoogleAuth, JWT } from "google-auth-library";
import { CloudSQLPostgresDatabaseDriver, resolveLoginUser } from "./driver";

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

describe("cloudsql-postgres IAM login user", () => {
  const iamUser = "tenant@tenant-proj.iam";
  const conn = (username?: string) => ({
    username,
    service_account_json: JSON.stringify(key),
  });

  it("derives the user from the key when none is supplied", () => {
    expect(resolveLoginUser(conn(), true)).toBe(iamUser);
    expect(resolveLoginUser(conn("  "), true)).toBe(iamUser);
  });

  it("accepts a username that names the key's own account", () => {
    expect(resolveLoginUser(conn(iamUser), true)).toBe(iamUser);
    expect(resolveLoginUser(conn(key.client_email), true)).toBe(iamUser);
  });

  it("refuses a username that names another account", () => {
    expect(() => resolveLoginUser(conn("postgres"), true)).toThrow(
      /signs in as tenant@tenant-proj\.iam/,
    );
    expect(() => resolveLoginUser(conn("admin@other-proj.iam"), true)).toThrow(
      /signs in as/,
    );
  });

  it("refuses a mismatch in the connection test and pool creation", async () => {
    const tokenCall = vi
      .spyOn(JWT.prototype, "getAccessToken")
      .mockResolvedValue({ token: "t" } as never);
    connectorCtor.mockClear();
    const driver = new CloudSQLPostgresDatabaseDriver();
    const bad = db({
      service_account_json: JSON.stringify(key),
      username: "postgres",
    });
    const result = await driver.testConnection(bad);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/signs in as/);
    await expect(driver.getConnection(bad)).rejects.toThrow(/signs in as/);
    // Refused before the token call and the connector (Admin API) exist.
    expect(tokenCall).not.toHaveBeenCalled();
    expect(connectorCtor).not.toHaveBeenCalled();
  });

  it("leaves password auth unchanged", () => {
    expect(resolveLoginUser(conn("app_user"), false)).toBe("app_user");
    expect(resolveLoginUser(conn(), false)).toBeUndefined();
  });
});
