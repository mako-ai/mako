/**
 * Defer-to-prod for `{{ dbt_schema }}` in a developer's dbt environment —
 * what `dbt --defer` does for refs, applied to app data bindings.
 *
 * A personal environment (`dbt_<you>`) holds only the models its owner
 * rebuilt. Rendering EVERY `{{ dbt_schema }}` to it made a binding that reads
 * ten models fail on the nine that were never built there (or silently read a
 * stale copy), so developers created views onto prod by hand. Instead, each
 * `{{ dbt_schema }}.<relation>` reference renders to the dev schema when that
 * relation exists there, and to the prod-like schema otherwise.
 *
 * Existence is asked of the warehouse through the binding's own connection,
 * once per build. BigQuery only for now (`INFORMATION_SCHEMA.TABLES` of the
 * dev dataset, tables and views alike); any other engine — or a listing that
 * fails for a reason other than "no such dataset" — keeps the previous
 * behaviour: everything renders to the dev schema.
 */
import { DBT_SCHEMA_TOKEN_RE } from "@mako/schemas";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";
import { loggers } from "../logging";

const logger = loggers.api("dbt-defer");

/** One `{{ dbt_schema }}` occurrence and what surrounds it. */
export interface DbtSchemaReference {
  /** The project/database qualifying it (`realadvisor-prod.{{ … }}`), if any. */
  project?: string;
  /** The relation it qualifies (`{{ … }}.dim_sales`), if any. */
  relation?: string;
}

// `project.` / `` `project`.` `` right before the token, quoted or not.
const PROJECT_BEFORE_RE = /([A-Za-z0-9_-]+)[`"]?\.[`"]?$/;
// `.relation` / `` `.`relation` `` right after it, and whether a `*`
// (wildcard table) follows the name.
const RELATION_AFTER_RE = /^[`"]?\.[`"]?([A-Za-z0-9_]+)(\*?)/;

/**
 * The relation a token qualifies — or undefined when it is not one a
 * relation listing can answer for: the dataset's metadata views
 * (`INFORMATION_SCHEMA.…`, `__TABLES__`) and wildcard tables (`events_*`)
 * never appear in INFORMATION_SCHEMA.TABLES, so looking them up would defer
 * them to prod every time. Like a bare token, they stay on the dev schema.
 */
function relationAfter(rest: string): string | undefined {
  const m = RELATION_AFTER_RE.exec(rest);
  if (!m) return undefined;
  const [, name, wildcard] = m;
  if (wildcard) return undefined;
  if (name.toUpperCase() === "INFORMATION_SCHEMA") return undefined;
  if (name.startsWith("__")) return undefined;
  return name;
}

function locatedReferences(
  code: string,
): Array<DbtSchemaReference & { index: number; length: number }> {
  const re = new RegExp(DBT_SCHEMA_TOKEN_RE.source, "g");
  const out: Array<DbtSchemaReference & { index: number; length: number }> = [];
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out.push({
      index: m.index,
      length: m[0].length,
      project: PROJECT_BEFORE_RE.exec(code.slice(0, m.index))?.[1],
      relation: relationAfter(code.slice(m.index + m[0].length)),
    });
  }
  return out;
}

/** Every `{{ dbt_schema }}` in the code, in order, with its qualifiers. */
export function dbtSchemaReferences(code: string): DbtSchemaReference[] {
  return locatedReferences(code).map(({ project, relation }) => ({
    project,
    relation,
  }));
}

/** How a reference is looked up in a relation listing. Case-insensitive. */
export function relationKey(ref: DbtSchemaReference): string {
  return `${(ref.project ?? "").toLowerCase()}|${(ref.relation ?? "").toLowerCase()}`;
}

/**
 * Render each token to the dev schema when its relation exists there, else
 * to prod. `devRelations` null means "unknown" — everything renders to dev
 * (the behaviour before defer). A token with no relation after it cannot be
 * looked up and renders to dev as well.
 */
export function renderDbtSchemaWithDefer(
  code: string,
  params: {
    devSchema: string;
    prodSchema: string;
    devRelations: { has(key: string): boolean } | null;
  },
): { code: string; deferred: string[] } {
  const deferred: string[] = [];
  let out = "";
  let last = 0;
  for (const { index, length, ...ref } of locatedReferences(code)) {
    const toProd =
      params.devRelations !== null &&
      ref.relation !== undefined &&
      !params.devRelations.has(relationKey(ref));
    if (toProd && ref.relation) deferred.push(ref.relation);
    out +=
      code.slice(last, index) + (toProd ? params.prodSchema : params.devSchema);
    last = index + length;
  }
  return { code: out + code.slice(last), deferred };
}

/**
 * The relations that exist in the dev schema (by relationKey), each with when
 * it was last written (epoch ms; null when the warehouse does not say, e.g. a
 * view without storage metadata).
 */
export type DevRelationListing = Map<string, number | null>;

/** Lists which referenced relations exist in the dev schema; null = unknown. */
export type DevRelationLister = (
  devSchema: string,
  refs: DbtSchemaReference[],
) => Promise<DevRelationListing | null>;

/**
 * When the newest dev relation these references read was last written —
 * a freshness signal for anything built from them (the draft cache keys on
 * it, so a `dbt run` into the dev schema is never answered with data built
 * before it). Null when none of them is in the dev schema, or nobody knows.
 */
export function latestDevModification(
  listing: DevRelationListing | null,
  refs: DbtSchemaReference[],
): number | null {
  if (!listing) return null;
  let latest: number | null = null;
  for (const ref of refs) {
    if (!ref.relation) continue;
    const modified = listing.get(relationKey(ref));
    if (
      typeof modified === "number" &&
      (latest === null || modified > latest)
    ) {
      latest = modified;
    }
  }
  return latest;
}

type RunQuery = (
  connection: IDatabaseConnection,
  sql: string,
) => Promise<{ success: boolean; data?: unknown; error?: string }>;

const defaultRunQuery: RunQuery = (connection, sql) =>
  databaseConnectionService.executeQuery(connection, sql, { readOnly: true });

const SAFE_PROJECT = /^[A-Za-z0-9_-]+$/;
const SAFE_DATASET = /^[A-Za-z0-9_]+$/;

/**
 * The lister for a binding's connection: BigQuery asks each qualifying
 * project's `<dev dataset>.INFORMATION_SCHEMA.TABLES` (existence, views
 * included) joined to its `__TABLES__` (last write time) — one query per
 * distinct project, normally one. Other engines: null (no defer).
 */
export function devRelationListerFor(
  connection: IDatabaseConnection,
  runQuery: RunQuery = defaultRunQuery,
): DevRelationLister {
  return async (devSchema, refs) => {
    if (connection.type !== "bigquery") return null;
    if (!SAFE_DATASET.test(devSchema)) return null;
    const projects = [...new Set(refs.map(ref => ref.project ?? ""))];
    if (projects.some(p => p && !SAFE_PROJECT.test(p))) return null;
    const found: DevRelationListing = new Map();
    for (const project of projects) {
      const dataset = project ? `${project}.${devSchema}` : devSchema;
      const result = await runQuery(
        connection,
        `SELECT t.table_name, s.last_modified_time FROM \`${dataset}\`.INFORMATION_SCHEMA.TABLES t ` +
          `LEFT JOIN \`${dataset}.__TABLES__\` s ON s.table_id = t.table_name`,
      );
      if (!result.success) {
        // No dev dataset yet: nothing was built there, all of it defers.
        if (/not found: dataset/i.test(result.error ?? "")) continue;
        logger.warn("dbt defer: cannot list dev relations; not deferring", {
          dataset,
          error: result.error,
        });
        return null;
      }
      const rows = Array.isArray(result.data) ? result.data : [];
      for (const row of rows as Array<{
        table_name?: unknown;
        last_modified_time?: unknown;
      }>) {
        if (typeof row.table_name !== "string") continue;
        const modified = Number(row.last_modified_time);
        found.set(
          relationKey({ project, relation: row.table_name }),
          row.last_modified_time != null && Number.isFinite(modified)
            ? modified
            : null,
        );
      }
    }
    return found;
  };
}
