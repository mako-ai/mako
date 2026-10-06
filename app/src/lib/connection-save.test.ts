import { describe, it, expect } from "vitest";
import {
  connectionConfigUnchanged,
  interpretCloudSaveResponse,
} from "./connection-save";

describe("interpretCloudSaveResponse", () => {
  it("marks a verified save as saved+verified", () => {
    const outcome = interpretCloudSaveResponse({
      success: true,
      verified: true,
      data: { _id: "abc" },
    });
    expect(outcome).toEqual({
      outcome: "saved",
      verified: true,
      data: { _id: "abc" },
    });
  });

  it("treats a successful but unverified save (Save anyways) as not activated", () => {
    const outcome = interpretCloudSaveResponse({
      success: true,
      verified: false,
      data: { _id: "xyz" },
    });
    expect(outcome.outcome).toBe("saved");
    if (outcome.outcome === "saved") {
      expect(outcome.verified).toBe(false);
    }
  });

  it("defaults verified to false when the API omits it", () => {
    const outcome = interpretCloudSaveResponse({ success: true });
    expect(outcome).toMatchObject({ outcome: "saved", verified: false });
  });

  it("routes a failed pre-save connection test to the test_failed outcome", () => {
    const outcome = interpretCloudSaveResponse({
      success: false,
      code: "connection_test_failed",
      error: "ECONNREFUSED",
    });
    expect(outcome).toEqual({
      outcome: "test_failed",
      error: "ECONNREFUSED",
    });
  });

  it("routes other failures to a plain error outcome", () => {
    const outcome = interpretCloudSaveResponse({
      success: false,
      error: "Workspace database limit reached",
    });
    expect(outcome).toEqual({
      outcome: "error",
      error: "Workspace database limit reached",
    });
  });
});

describe("connectionConfigUnchanged", () => {
  const loaded = {
    type: "postgresql",
    connection: {
      host: "db.internal",
      port: 5999,
      database: "warehouse",
      username: "mako",
      password: "secret",
      ssl: true,
    },
  };

  it("a rename alone leaves the config unchanged (no pre-save test)", () => {
    expect(
      connectionConfigUnchanged(loaded, {
        type: "postgresql",
        connection: { ...loaded.connection },
      }),
    ).toBe(true);
  });

  it("forgives what the form adds by itself: blank fields and a number typed as text", () => {
    expect(
      connectionConfigUnchanged(loaded, {
        type: "postgresql",
        connection: {
          ...loaded.connection,
          port: "5999",
          connectionString: "",
          schema: undefined,
          poolSize: Number.NaN,
          sslCert: null,
        },
      }),
    ).toBe(true);
  });

  it("any real config edit is a change (tested as before)", () => {
    for (const connection of [
      { ...loaded.connection, host: "db2.internal" },
      { ...loaded.connection, port: 5432 },
      { ...loaded.connection, password: "rotated" },
      { ...loaded.connection, ssl: false },
      { ...loaded.connection, database: "" },
      { ...loaded.connection, options: { sslmode: "require" } },
    ]) {
      expect(
        connectionConfigUnchanged(loaded, { type: "postgresql", connection }),
      ).toBe(false);
    }
    expect(
      connectionConfigUnchanged(loaded, {
        type: "mysql",
        connection: { ...loaded.connection },
      }),
    ).toBe(false);
  });

  it("compares nested objects and arrays by value, keys in any order", () => {
    const nested = {
      type: "bigquery",
      connection: {
        credentials: { client_email: "a@b", scopes: ["x", "y"] },
        location: "EU",
      },
    };
    expect(
      connectionConfigUnchanged(nested, {
        type: "bigquery",
        connection: {
          location: "EU",
          credentials: { scopes: ["x", "y"], client_email: "a@b" },
        },
      }),
    ).toBe(true);
    expect(
      connectionConfigUnchanged(nested, {
        type: "bigquery",
        connection: {
          location: "EU",
          credentials: { client_email: "a@b", scopes: ["y", "x"] },
        },
      }),
    ).toBe(false);
  });
});
