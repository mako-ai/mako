import { describe, expect, it } from "vitest";
import {
  getDbtAdapterPackage,
  isDbtCompatibleConnectionType,
  renderDbtProfile,
} from "./adapter-map";
import type {
  IDatabaseConnection,
  IDbtEnvironment,
} from "../database/workspace-schema";

function connection(
  type: string,
  overrides: Record<string, unknown> = {},
): IDatabaseConnection {
  return {
    type,
    connection: {
      host: "db.internal",
      port: 5432,
      username: "analytics",
      password: "s3cr3t-do-not-leak",
      database: "warehouse",
      ...overrides,
    },
  } as unknown as IDatabaseConnection;
}

const env: IDbtEnvironment = {
  name: "prod",
  connectionId: "000000000000000000000000",
  targetSchema: "analytics",
  threads: 4,
} as unknown as IDbtEnvironment;

describe("renderDbtProfile secret isolation", () => {
  const secretBearingTypes = [
    "postgresql",
    "cloudsql-postgres",
    "redshift",
    "clickhouse",
    "mysql",
    "mssql",
  ];

  it.each(secretBearingTypes)(
    "%s keeps the password out of profiles.yml and in the env map",
    type => {
      const { profilesYml, secretEnv } = renderDbtProfile(
        connection(type),
        env,
      );
      expect(profilesYml).not.toContain("s3cr3t-do-not-leak");
      expect(profilesYml).toContain("DBT_SECRET_PASSWORD");
      expect(secretEnv.DBT_SECRET_PASSWORD).toBe("s3cr3t-do-not-leak");
    },
  );

  it("bigquery keeps the service-account JSON out of profiles.yml", () => {
    const sa = JSON.stringify({ project_id: "my-proj", private_key: "PK" });
    const { profilesYml, secretEnv } = renderDbtProfile(
      connection("bigquery", { service_account_json: sa }),
      env,
    );
    expect(profilesYml).not.toContain("PK");
    expect(profilesYml).toContain("my-proj");
    expect(secretEnv.DBT_SECRET_BQ_KEYFILE_JSON).toBe(sa);
  });

  it("emits the correct adapter package per type", () => {
    expect(getDbtAdapterPackage("postgresql")).toBe("dbt-postgres");
    expect(getDbtAdapterPackage("redshift")).toBe("dbt-redshift");
    expect(getDbtAdapterPackage("bigquery")).toBe("dbt-bigquery");
    expect(getDbtAdapterPackage("clickhouse")).toBe("dbt-clickhouse");
    expect(getDbtAdapterPackage("mysql")).toBe("dbt-mysql");
    expect(getDbtAdapterPackage("mssql")).toBe("dbt-sqlserver");
  });

  it("rejects non-dbt-compatible connection types", () => {
    expect(isDbtCompatibleConnectionType("mongodb")).toBe(false);
    expect(() => renderDbtProfile(connection("mongodb"), env)).toThrow();
  });
});
