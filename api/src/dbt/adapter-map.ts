/**
 * Connection type → dbt adapter mapping + profiles.yml target renderers.
 *
 * Each renderer takes the DECRYPTED connection (Mongoose getters already
 * applied via .toObject({ getters: true })) and emits a profile target where
 * secrets are referenced as {{ env_var('DBT_SECRET_...') }}. The actual
 * secret values are only ever passed via the child-process env — credentials
 * are never written to disk.
 */

import { dump as yamlDump } from "js-yaml";
import type {
  IDatabaseConnection,
  IDbtEnvironment,
} from "../database/workspace-schema";

export interface RenderedProfile {
  /** profiles.yml text to write into the runner temp dir. */
  profilesYml: string;
  /** Secret env vars to pass to the dbt child process. */
  secretEnv: Record<string, string>;
  /** dbt adapter package, e.g. "dbt-postgres". */
  adapterPackage: string;
}

export const DBT_PROFILE_NAME = "mako";

interface AdapterEntry {
  adapterPackage: string;
  renderTarget: (
    connection: IDatabaseConnection,
    env: Pick<IDbtEnvironment, "targetSchema" | "threads">,
    secretEnv: Record<string, string>,
  ) => Record<string, unknown>;
}

function secretRef(
  secretEnv: Record<string, string>,
  name: string,
  value: string,
): string {
  const envName = `DBT_SECRET_${name.toUpperCase()}`;
  secretEnv[envName] = value;
  return `{{ env_var('${envName}') }}`;
}

const postgresLike =
  (defaultPort: number) =>
  (
    connection: IDatabaseConnection,
    env: Pick<IDbtEnvironment, "targetSchema" | "threads">,
    secretEnv: Record<string, string>,
  ): Record<string, unknown> => {
    const c = connection.connection;
    return {
      type: connection.type === "redshift" ? "redshift" : "postgres",
      host: c.host ?? "localhost",
      port: c.port ?? defaultPort,
      user: c.username ?? "",
      password: secretRef(secretEnv, "password", c.password ?? ""),
      dbname: c.database ?? "",
      schema: env.targetSchema,
      threads: env.threads,
      ...(c.ssl ? { sslmode: "require" } : {}),
    };
  };

const ADAPTERS: Record<string, AdapterEntry> = {
  postgresql: {
    adapterPackage: "dbt-postgres",
    renderTarget: postgresLike(5432),
  },
  "cloudsql-postgres": {
    adapterPackage: "dbt-postgres",
    renderTarget: postgresLike(5432),
  },
  redshift: {
    adapterPackage: "dbt-redshift",
    renderTarget: postgresLike(5439),
  },
  bigquery: {
    adapterPackage: "dbt-bigquery",
    renderTarget: (connection, env, secretEnv) => {
      const c = connection.connection;
      const serviceAccountJson = c.service_account_json ?? "";
      let projectId = "";
      try {
        projectId =
          (JSON.parse(serviceAccountJson) as { project_id?: string })
            .project_id ?? "";
      } catch {
        // keyfile missing/invalid — dbt will surface a clear error
      }
      return {
        type: "bigquery",
        method: "service-account-json",
        project: projectId,
        dataset: env.targetSchema,
        threads: env.threads,
        keyfile_json: secretRef(
          secretEnv,
          "bq_keyfile_json",
          serviceAccountJson,
        ),
      };
    },
  },
  clickhouse: {
    adapterPackage: "dbt-clickhouse",
    renderTarget: (connection, env, secretEnv) => {
      const c = connection.connection;
      return {
        type: "clickhouse",
        host: c.host ?? "localhost",
        port: c.port ?? 8443,
        user: c.username ?? "default",
        password: secretRef(secretEnv, "password", c.password ?? ""),
        schema: env.targetSchema,
        threads: env.threads,
        secure: c.ssl !== false,
      };
    },
  },
  mysql: {
    adapterPackage: "dbt-mysql",
    renderTarget: (connection, env, secretEnv) => {
      const c = connection.connection;
      return {
        type: "mysql",
        server: c.host ?? "localhost",
        port: c.port ?? 3306,
        username: c.username ?? "",
        password: secretRef(secretEnv, "password", c.password ?? ""),
        // dbt-mysql has no schema/database split — the target schema is the
        // database dbt builds into.
        schema: env.targetSchema,
        database: env.targetSchema,
        threads: env.threads,
      };
    },
  },
  mssql: {
    adapterPackage: "dbt-sqlserver",
    renderTarget: (connection, env, secretEnv) => {
      const c = connection.connection;
      return {
        type: "sqlserver",
        driver: "ODBC Driver 18 for SQL Server",
        server: c.host ?? "localhost",
        port: c.port ?? 1433,
        user: c.username ?? "",
        password: secretRef(secretEnv, "password", c.password ?? ""),
        database: c.database ?? "",
        schema: env.targetSchema,
        threads: env.threads,
        trust_cert: true,
      };
    },
  },
};

/** Connection types that can be used as dbt targets. */
export const DBT_COMPATIBLE_CONNECTION_TYPES = Object.keys(ADAPTERS);

export function isDbtCompatibleConnectionType(type: string): boolean {
  return type in ADAPTERS;
}

export function getDbtAdapterPackage(type: string): string | undefined {
  return ADAPTERS[type]?.adapterPackage;
}

/**
 * Render profiles.yml + secret env for a project environment. The caller is
 * responsible for fetching + decrypting the connection within the workspace.
 */
export function renderDbtProfile(
  connection: IDatabaseConnection,
  environment: IDbtEnvironment,
): RenderedProfile {
  const adapter = ADAPTERS[connection.type];
  if (!adapter) {
    throw new Error(
      `Connection type "${connection.type}" is not dbt-compatible. ` +
        `Supported: ${DBT_COMPATIBLE_CONNECTION_TYPES.join(", ")}`,
    );
  }

  const secretEnv: Record<string, string> = {};
  const target = adapter.renderTarget(connection, environment, secretEnv);

  const profile = {
    [DBT_PROFILE_NAME]: {
      target: environment.name,
      outputs: {
        [environment.name]: target,
      },
    },
  };

  return {
    // js-yaml quotes the {{ env_var(...) }} strings, which dbt parses fine.
    profilesYml: yamlDump(profile, { lineWidth: 200 }),
    secretEnv,
    adapterPackage: adapter.adapterPackage,
  };
}
