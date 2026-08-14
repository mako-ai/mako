/**
 * React Apps — shared schema
 *
 * An "app" is a user/AI-authored React project that runs inside the Mako
 * workspace (Lovable / v0 style), but with first-class access to the
 * workspace's database connections via data bindings.
 *
 * The canonical app model is a virtual filesystem (`files`) plus an npm
 * dependency manifest (`dependencies`) plus a set of `dataBindings` that map a
 * named binding to a workspace query. The runtime executes the binding through
 * Mako's scoped execute API — the generated app never sees DB credentials.
 *
 * This schema is the single source of truth shared by the API (validation +
 * Mongoose model) and the app (store + agent tools), so the two can never
 * drift.
 */

import { z } from "zod";

/** A single file in the app's virtual filesystem. */
export const AppFileSchema = z.object({
  /** POSIX-style path relative to the project root, e.g. `src/App.tsx`. */
  path: z
    .string()
    .min(1)
    .describe("POSIX path relative to the project root, e.g. src/App.tsx"),
  /** UTF-8 file contents. */
  contents: z.string().describe("UTF-8 file contents"),
});
export type AppFile = z.infer<typeof AppFileSchema>;

export const AppDataBindingLanguageSchema = z.enum([
  "sql",
  "javascript",
  "mongodb",
]);
export type AppDataBindingLanguage = z.infer<
  typeof AppDataBindingLanguageSchema
>;

/**
 * How a binding's data reaches the app:
 * - `live`: the query runs server-side on every read through Mako's execute API.
 * - `parquet`: the query is materialized server-side into a Parquet artifact
 *   (stored on filesystem/GCS/S3, same pipeline as dashboards) and loaded into
 *   DuckDB-WASM in the browser, where the app can run analytical SQL over it.
 */
export const AppBindingMaterializationSchema = z.enum(["live", "parquet"]);
export type AppBindingMaterialization = z.infer<
  typeof AppBindingMaterializationSchema
>;

export const AppBindingMaterializationScheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string().nullable(),
  timezone: z.string().optional(),
  dataFreshnessTtlMs: z.number().nullable().optional(),
});
export type AppBindingMaterializationSchedule = z.infer<
  typeof AppBindingMaterializationScheduleSchema
>;

export const AppBindingParquetStatusSchema = z.enum([
  "missing",
  "queued",
  "building",
  "ready",
  "error",
]);

/** A single materialization run, recorded for history. */
export const AppBindingMaterializationRunSchema = z.object({
  at: z.string().describe("ISO timestamp the run finished"),
  status: z.enum(["ready", "error"]),
  rowCount: z.number().optional(),
  byteSize: z.number().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});
export type AppBindingMaterializationRun = z.infer<
  typeof AppBindingMaterializationRunSchema
>;

/**
 * A per-dbt-environment materialized artifact (dev/staging preview builds).
 *
 * The root cache fields hold the PROD artifact — the only one published apps,
 * public shares, and scheduled refreshes ever read. These entries hold
 * preview-scoped artifacts an editor built for a non-prod dbt environment, so
 * a dbt-linked parquet binding can be previewed at full fidelity instead of
 * falling back to a row-capped live query. Keyed by dbt environment name.
 * `parquetUrl` is hydrated on read (a proxied API path), never persisted.
 */
export const AppBindingEnvironmentArtifactSchema = z.object({
  status: AppBindingParquetStatusSchema.nullish(),
  /** Heartbeat for the current build (stale detection), per environment. */
  statusAt: z.string().nullish(),
  artifactKey: z.string().optional(),
  definitionHash: z.string().optional(),
  artifactRevision: z.string().optional(),
  error: z.string().nullish(),
  rowCount: z.number().optional(),
  byteSize: z.number().optional(),
  builtAt: z.string().optional(),
  /** Provenance: the warehouse schema this artifact was materialized from. */
  sourceSchema: z.string().optional(),
  parquetUrl: z.string().optional(),
  history: z.array(AppBindingMaterializationRunSchema).optional(),
});
export type AppBindingEnvironmentArtifact = z.infer<
  typeof AppBindingEnvironmentArtifactSchema
>;

/**
 * Materialized-artifact cache metadata for a binding. Mirrors the dashboard
 * data source `cache` shape so the same artifact store + serve pipeline applies.
 * `parquetUrl` is hydrated on read (a proxied API path), never persisted.
 */
export const AppBindingCacheSchema = z.object({
  parquetArtifactKey: z.string().optional(),
  definitionHash: z.string().optional(),
  artifactRevision: z.string().optional(),
  parquetBuildStatus: AppBindingParquetStatusSchema.nullish(),
  /**
   * Heartbeat for the current build. Refreshed periodically while a build is
   * queued/running so stuck "building" statuses can be detected and recovered.
   */
  parquetBuildStatusAt: z.string().nullish(),
  parquetLastError: z.string().nullish(),
  rowCount: z.number().optional(),
  byteSize: z.number().optional(),
  lastRefreshedAt: z.string().optional(),
  parquetBuiltAt: z.string().optional(),
  parquetUrl: z.string().optional(),
  /** Most-recent materialization runs (newest first, bounded). */
  history: z.array(AppBindingMaterializationRunSchema).optional(),
  /**
   * Preview-scoped artifacts keyed by dbt environment name. Never read by
   * published apps or public shares — those always use the root (prod) fields.
   */
  environments: z
    .record(z.string(), AppBindingEnvironmentArtifactSchema)
    .optional(),
});
export type AppBindingCache = z.infer<typeof AppBindingCacheSchema>;

/**
 * A named data binding. The generated app reads bindings by `name` through the
 * injected `@mako/app-sdk` runtime. For `live` bindings the query runs
 * server-side, scoped to the workspace; for `parquet` bindings the data is
 * materialized to Parquet and queried client-side via DuckDB-WASM.
 */
export const AppDataBindingSchema = z.object({
  id: z.string().describe("Stable binding id"),
  name: z
    .string()
    .min(1)
    .describe("Binding name referenced from app code, e.g. `revenue`"),
  /**
   * Optional link to a dbt project. When set, the `{{ dbt_schema }}` token in
   * `code` resolves to a dbt environment's target schema at execution time:
   * the prod-like environment by default (published apps, parquet
   * materialization, public shares), or the editor's per-user preview
   * override in the draft preview. Keeps binding SQL environment-agnostic —
   * never hardcode `dbt_prod.` when linking a binding to dbt.
   */
  dbtProjectId: z
    .string()
    .optional()
    .describe(
      "dbt project id this binding reads from; enables the {{ dbt_schema }} token in code",
    ),
  connectionId: z
    .string()
    .describe("Workspace DatabaseConnection id to execute the query against"),
  language: AppDataBindingLanguageSchema.default("sql"),
  code: z.string().describe("Query text/code to execute"),
  databaseId: z.string().optional().describe("Optional sub-database id"),
  databaseName: z.string().optional().describe("Optional database name"),
  materialization: AppBindingMaterializationSchema.default("live"),
  materializationSchedule: AppBindingMaterializationScheduleSchema.optional(),
  cache: AppBindingCacheSchema.optional(),
});
export type AppDataBinding = z.infer<typeof AppDataBindingSchema>;

/** Where the app preview is executed. */
export const AppRuntimeSchema = z.enum(["cdn", "webcontainer"]);
export type AppRuntime = z.infer<typeof AppRuntimeSchema>;

/** The editable body of an app. */
export const AppDefinitionSchema = z.object({
  title: z.string().min(1).describe("App title"),
  description: z.string().optional().describe("Brief description"),
  /** Scaffold template id this app was created from. */
  template: z.string().default("react-ts"),
  /**
   * Runtime that renders the preview. `cdn` runs React + ESM dependencies in a
   * sandboxed iframe (no build step); `webcontainer` runs a real Vite/npm
   * toolchain in-browser (full shadcn/Tailwind/build support).
   */
  runtime: AppRuntimeSchema.default("cdn"),
  /** Entry component file rendered into the preview root. */
  entrypoint: z.string().default("src/App.tsx"),
  files: z.array(AppFileSchema).default([]),
  /** npm package name -> semver range. */
  dependencies: z.record(z.string(), z.string()).default({}),
  dataBindings: z.array(AppDataBindingSchema).default([]),
});
export type AppDefinition = z.infer<typeof AppDefinitionSchema>;

/**
 * `{{ dbt_schema }}` token in dbt-linked binding queries. Whitespace inside
 * the braces is flexible (`{{dbt_schema}}`, `{{ dbt_schema }}`); resolution
 * substitutes the target schema of the binding's dbt environment.
 */
export const DBT_SCHEMA_TOKEN_RE = /\{\{\s*dbt_schema\s*\}\}/g;

/** True when `code` references the `{{ dbt_schema }}` token. */
export function containsDbtSchemaToken(code: string): boolean {
  DBT_SCHEMA_TOKEN_RE.lastIndex = 0;
  return DBT_SCHEMA_TOKEN_RE.test(code);
}

/**
 * Substitute every `{{ dbt_schema }}` occurrence with `schema`. Pure string
 * templating — callers decide which environment's schema applies (prod for
 * published/materialized/public paths, the preview override for drafts).
 */
export function resolveDbtSchemaToken(code: string, schema: string): string {
  return code.replace(DBT_SCHEMA_TOKEN_RE, schema);
}

/** Normalize a files array: trim paths, drop empties, de-dupe by path (last wins). */
export function normalizeAppFiles(files: AppFile[]): AppFile[] {
  const byPath = new Map<string, AppFile>();
  for (const file of files) {
    const path = file.path.replace(/^\.?\/+/, "").trim();
    if (!path) continue;
    byPath.set(path, { path, contents: file.contents ?? "" });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
