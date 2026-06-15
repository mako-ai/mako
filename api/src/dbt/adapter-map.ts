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

/**
 * A credential file the runner must materialize before invoking dbt. The
 * content is written to `<runDir>/<filename>` with 0600 perms and its absolute
 * path is exported as `envVar`, which the profile references via env_var().
 * Used for adapters (BigQuery) whose secrets are a file/dict, not a scalar.
 */
export interface ProfileKeyfile {
  /** Env var that will hold the absolute path to the written file. */
  envVar: string;
  /** Relative filename within the runner's ephemeral project dir. */
  filename: string;
  /** File content (never logged). */
  content: string;
}

export interface RenderedProfile {
  /** profiles.yml text to write into the runner temp dir. */
  profilesYml: string;
  /** Secret env vars to pass to the dbt child process. */
  secretEnv: Record<string, string>;
  /** dbt adapter package, e.g. "dbt-postgres". */
  adapterPackage: string;
  /** Credential files the runner writes to disk (0600) before running dbt. */
  keyfiles: ProfileKeyfile[];
}

export const DBT_PROFILE_NAME = "mako";

interface AdapterEntry {
  adapterPackage: string;
  renderTarget: (
    connection: IDatabaseConnection,
    env: Pick<IDbtEnvironment, "targetSchema" | "threads">,
    secretEnv: Record<string, string>,
    keyfiles: ProfileKeyfile[],
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
    renderTarget: (connection, env, _secretEnv, keyfiles) => {
      const c = connection.connection as Record<string, unknown>;
      // Credentials may be stored as a JSON string or an already-parsed object
      // (the BigQuery query driver accepts both — mirror that here).
      const rawSa = c.service_account_json;
      let keyfileContent = "";
      let saProjectId: string | undefined;
      if (typeof rawSa === "string") {
        keyfileContent = rawSa;
        try {
          saProjectId = (JSON.parse(rawSa) as { project_id?: string })
            .project_id;
        } catch {
          // invalid/missing keyfile — dbt surfaces a clear error at startup
        }
      } else if (rawSa && typeof rawSa === "object") {
        keyfileContent = JSON.stringify(rawSa);
        saProjectId = (rawSa as { project_id?: string }).project_id;
      }

      // Prefer the connection's configured project (what the query driver uses
      // via getProjectId), falling back to the service account's own project.
      const project =
        (typeof c.project_id === "string" && c.project_id) || saProjectId || "";
      const location =
        typeof c.location === "string" && c.location ? c.location : undefined;

      // dbt-bigquery's `service-account-json`/`keyfile_json` wants a parsed
      // dict, which can't be supplied via env_var without mangling the private
      // key's newlines. Write the keyfile to a 0600 temp file and reference its
      // path with `method: service-account` + `keyfile` instead.
      const KEYFILE_ENV = "DBT_BQ_KEYFILE";
      keyfiles.push({
        envVar: KEYFILE_ENV,
        filename: ".dbt-bq-keyfile.json",
        content: keyfileContent,
      });

      return {
        type: "bigquery",
        method: "service-account",
        project,
        dataset: env.targetSchema,
        threads: env.threads,
        keyfile: `{{ env_var('${KEYFILE_ENV}') }}`,
        ...(location ? { location } : {}),
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
  const keyfiles: ProfileKeyfile[] = [];
  const target = adapter.renderTarget(
    connection,
    environment,
    secretEnv,
    keyfiles,
  );

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
    keyfiles,
  };
}
