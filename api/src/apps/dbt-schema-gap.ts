/**
 * The schema gap: which dbt models a held app cannot run without.
 *
 * Deploy-on-push (dbt-before-deploy.ts) builds in prod only these models:
 *  - a model the held apps read whose prod relation is missing, or whose
 *    compiled columns include a column the prod table lacks;
 *  - a parent of such a model that has the same kind of gap itself. The walk
 *    up stops at the first parent without a gap.
 * Every other dbt change waits for its next scheduled job.
 *
 * Columns come from the pushed commit's compiled manifest: `dbt compile`
 * writes each model's `compiled_code`, and a BigQuery dry run of that SQL
 * returns the columns it would produce (nothing runs, nothing bills). Prod's
 * columns come from INFORMATION_SCHEMA.COLUMNS through the driver's own
 * `buildColumnListQuery`. A model whose SQL cannot be dry-run is a gap too:
 * the usual cause is a parent that lacks a column the model selects.
 *
 * `findSchemaGap` is pure over a `WarehouseLookup`; `compileGapGraph` and
 * `warehouseLookupFor` are the I/O around it.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import type { DatabaseDriver } from "../databases/driver";
import { databaseRegistry } from "../databases/registry";
import { runAdhocDbtCommand } from "../dbt/dbt-project.service";
import {
  buildManifestIndex,
  type RawManifest,
} from "../dbt/ontology/manifest-index";
import { loggers } from "../logging";
import { databaseConnectionService } from "../services/database-connection.service";
import { withQueryLabels } from "../services/bigquery-labels";

const logger = loggers.api("apps-dbt-schema-gap");

/** A model's prod relation: BigQuery `project.dataset.table`. */
export interface GapRelation {
  project: string;
  dataset: string;
  table: string;
}

export interface GapModel {
  name: string;
  /** Names of the parent models (seeds, snapshots and sources left out). */
  parents: string[];
  /** Null for a model with no relation (ephemeral). */
  relation: GapRelation | null;
  /** The compiled SQL; undefined when the manifest has none for it. */
  compiledSql?: string;
}

export type GapGraph = ReadonlyMap<string, GapModel>;

/** What the warehouse answers; injected so the walk is testable offline. */
export interface WarehouseLookup {
  /**
   * The columns of each relation in prod, lowercased, keyed by
   * `relationKey`. A relation that does not exist has no entry.
   */
  prodColumns(
    relations: readonly GapRelation[],
  ): Promise<Map<string, Set<string>>>;
  /** The columns the SQL would return, or null when its dry run fails. */
  queryColumns(sql: string): Promise<string[] | null>;
}

export type GapReason =
  /** The prod relation does not exist. */
  | "missing"
  /** The compiled columns include one the prod table lacks. */
  | "new-columns"
  /** The compiled SQL cannot be dry-run (a parent lacks a column it reads). */
  | "unverified";

export interface SchemaGap {
  /** Models to build, sorted: the gap models and their gap parents. */
  models: string[];
  reasons: Record<string, GapReason>;
  /** New columns per model, for the log (empty for a missing relation). */
  newColumns: Record<string, string[]>;
}

export function relationKey(relation: GapRelation): string {
  return `${relation.project}.${relation.dataset}.${relation.table}`.toLowerCase();
}

/**
 * The gap graph of a compiled manifest. Reuses the manifest index for names,
 * relations and lineage; only the compiled SQL is read from the raw nodes.
 */
export function gapGraphFromManifest(manifest: RawManifest): GapGraph {
  const index = buildManifestIndex(manifest);
  const compiled = new Map<string, string>();
  for (const [id, raw] of Object.entries(manifest.nodes ?? {})) {
    const node = raw as { compiled_code?: string; compiled_sql?: string };
    const sql = node.compiled_code ?? node.compiled_sql;
    if (sql) compiled.set(id, sql);
  }
  const graph = new Map<string, GapModel>();
  const modelNames = new Set(
    index.nodes.filter(n => n.resourceType === "model").map(n => n.name),
  );
  const isModel = (name: string) => modelNames.has(name);
  for (const node of index.nodes) {
    if (node.resourceType !== "model") continue;
    const parts = node.relationKey?.split(".") ?? [];
    const sql = compiled.get(node.id);
    graph.set(node.name, {
      name: node.name,
      parents: node.parents.filter(isModel),
      relation:
        parts.length === 3
          ? { project: parts[0], dataset: parts[1], table: parts[2] }
          : null,
      ...(sql ? { compiledSql: sql } : {}),
    });
  }
  return graph;
}

/**
 * The models the held apps cannot run without. `reads` are the models their
 * bindings read; the rest of the graph is walked from there, upward only,
 * and only through models with a gap.
 */
export async function findSchemaGap(input: {
  graph: GapGraph;
  reads: readonly string[];
  warehouse: WarehouseLookup;
}): Promise<SchemaGap> {
  const { graph, reads, warehouse } = input;
  const prod = new Map<string, Set<string>>();
  const looked = new Set<string>();
  const reasons: Record<string, GapReason> = {};
  const newColumns: Record<string, string[]> = {};
  const assessed = new Map<string, boolean>();

  /** Fetch prod columns for models not looked up yet, one query per dataset. */
  const loadProd = async (names: readonly string[]) => {
    const relations: GapRelation[] = [];
    for (const name of names) {
      const relation = graph.get(name)?.relation;
      if (!relation || looked.has(relationKey(relation))) continue;
      looked.add(relationKey(relation));
      relations.push(relation);
    }
    if (relations.length === 0) return;
    for (const [key, columns] of await warehouse.prodColumns(relations)) {
      prod.set(key, columns);
    }
  };

  /** Does this model, by itself, lack something in prod? Memoised. */
  const assess = async (name: string): Promise<boolean> => {
    const known = assessed.get(name);
    if (known !== undefined) return known;
    const node = graph.get(name);
    // Not in the manifest, or without a relation: nothing a build can fix.
    if (!node?.relation) {
      assessed.set(name, false);
      return false;
    }
    const existing = prod.get(relationKey(node.relation));
    if (!existing) {
      reasons[name] = "missing";
      assessed.set(name, true);
      return true;
    }
    const columns = node.compiledSql
      ? await warehouse.queryColumns(node.compiledSql)
      : null;
    if (!columns) {
      reasons[name] = "unverified";
      assessed.set(name, true);
      return true;
    }
    const added = [
      ...new Set(
        columns.map(c => c.toLowerCase()).filter(c => !existing.has(c)),
      ),
    ];
    if (added.length > 0) {
      reasons[name] = "new-columns";
      newColumns[name] = added.sort();
    }
    assessed.set(name, added.length > 0);
    return added.length > 0;
  };

  const included = new Set<string>();
  const walk = async (names: readonly string[]) => {
    await loadProd(names);
    for (const name of names) {
      if (included.has(name)) continue;
      if (!(await assess(name))) continue;
      included.add(name);
      // Walk up only while the gap holds: a parent is examined, and joins
      // the build only when it has a gap of its own.
      const parents = graph.get(name)?.parents ?? [];
      await walk(parents.filter(p => !included.has(p)));
    }
  };
  await walk([...new Set(reads)]);

  const models = [...included].sort();
  return {
    models,
    reasons: Object.fromEntries(models.map(m => [m, reasons[m]])) as Record<
      string,
      GapReason
    >,
    newColumns,
  };
}

/** A name dbt's selector and our command tokenizer both take as is. */
const SAFE_MODEL_NAME = /^[a-z0-9_]+$/;

/**
 * `compile --select +m1 +m2`: every read model with all of its ancestors, so
 * the manifest carries the compiled SQL the parent walk needs.
 */
export function compileGraphCommand(reads: readonly string[]): string {
  const selectors = [...new Set(reads)]
    .filter(model => SAFE_MODEL_NAME.test(model))
    .sort()
    .map(model => `+${model}`);
  return `compile --select ${selectors.join(" ")}`;
}

/**
 * Compile the held apps' models (and their ancestors) at the pushed commit
 * in the prod-like environment. Throws when dbt fails: the caller then
 * deploys at once, as it does for any plan it cannot make.
 */
export async function compileGapGraph(input: {
  workspaceId: string;
  projectId: string;
  environment: string;
  sha: string;
  reads: readonly string[];
}): Promise<GapGraph> {
  const result = await runAdhocDbtCommand({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    environmentName: input.environment,
    commit: input.sha,
    command: compileGraphCommand(input.reads),
    timeoutMs: 10 * 60 * 1000,
  });
  if (!result.success) {
    throw new Error(`dbt compile failed (exit ${result.exitCode})`);
  }
  const buffer = result.raw.artifacts.manifest;
  if (!buffer) throw new Error("dbt compile wrote no manifest");
  return gapGraphFromManifest(
    JSON.parse(buffer.toString("utf8")) as RawManifest,
  );
}

type RunQuery = (
  connection: IDatabaseConnection,
  sql: string,
) => Promise<{ success: boolean; data?: unknown; error?: string }>;

const defaultRunQuery: RunQuery = (connection, sql) =>
  databaseConnectionService.executeQuery(connection, sql, { readOnly: true });

type QuerySchema = (
  connection: IDatabaseConnection,
  sql: string,
) => Promise<{ success: boolean; columns?: Array<{ name: string }> }>;

const defaultQuerySchema: QuerySchema = (connection, sql) =>
  databaseConnectionService.getBigQueryQuerySchema(connection, sql);

/**
 * The warehouse answers for a BigQuery connection. Prod columns: one
 * `INFORMATION_SCHEMA.COLUMNS` query per dataset, from the driver's
 * `buildColumnListQuery`. Any other engine throws: the caller deploys at once.
 */
export function warehouseLookupFor(
  connection: IDatabaseConnection,
  deps: {
    runQuery?: RunQuery;
    querySchema?: QuerySchema;
    driver?: Pick<DatabaseDriver, "buildColumnListQuery">;
  } = {},
): WarehouseLookup {
  if (connection.type !== "bigquery") {
    throw new Error(`schema gap needs BigQuery, not ${connection.type}`);
  }
  const runQuery = deps.runQuery ?? defaultRunQuery;
  const querySchema = deps.querySchema ?? defaultQuerySchema;
  const driver = deps.driver ?? databaseRegistry.getDriver("bigquery");
  return {
    async prodColumns(relations) {
      const byDataset = new Map<string, GapRelation[]>();
      for (const relation of relations) {
        const key = `${relation.project}.${relation.dataset}`;
        byDataset.set(key, [...(byDataset.get(key) ?? []), relation]);
      }
      const out = new Map<string, Set<string>>();
      for (const group of byDataset.values()) {
        const { project, dataset } = group[0];
        const sql = driver?.buildColumnListQuery?.(
          dataset,
          group.map(r => r.table),
          { projectId: project },
        );
        if (!sql) throw new Error("the BigQuery driver cannot list columns");
        const result = await withQueryLabels(
          { mako_source: "other", mako_purpose: "dbt_schema_gap" },
          () => runQuery(connection, sql),
        );
        if (!result.success) {
          // A dataset prod never created: every relation in it is missing.
          if (/not found: dataset/i.test(result.error ?? "")) continue;
          throw new Error(result.error || "column list failed");
        }
        for (const row of (result.data ?? []) as Array<
          Record<string, unknown>
        >) {
          const table = String(row.table_name ?? "");
          const column = String(row.column_name ?? "");
          if (!table || !column) continue;
          const key = relationKey({ project, dataset, table });
          const set = out.get(key) ?? new Set<string>();
          set.add(column.toLowerCase());
          out.set(key, set);
        }
      }
      return out;
    },
    async queryColumns(sql) {
      const result = await withQueryLabels(
        { mako_source: "other", mako_purpose: "dbt_schema_gap" },
        () => querySchema(connection, sql),
      );
      if (!result.success || !result.columns) return null;
      return result.columns.map(c => c.name);
    },
  };
}

/** The decrypted connection of a project environment, or null. */
export async function loadEnvironmentConnection(
  workspaceId: string,
  connectionId: Types.ObjectId | string,
): Promise<IDatabaseConnection | null> {
  const doc = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId.toString()),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  return doc ? (doc.toObject({ getters: true }) as IDatabaseConnection) : null;
}

/**
 * The models a held app cannot run without, for one push. Throws when the
 * check cannot be made (compile fails, warehouse is not BigQuery, a query
 * errors): the caller logs it and deploys at once.
 */
export async function detectSchemaGap(input: {
  workspaceId: string;
  projectId: string;
  environment: string;
  connectionId: Types.ObjectId | string;
  sha: string;
  reads: readonly string[];
}): Promise<SchemaGap> {
  const connection = await loadEnvironmentConnection(
    input.workspaceId,
    input.connectionId,
  );
  if (!connection) throw new Error("environment connection not found");
  const warehouse = warehouseLookupFor(connection);
  const graph = await compileGapGraph(input);
  const gap = await findSchemaGap({ graph, reads: input.reads, warehouse });
  logger.info("Schema gap checked", {
    workspaceId: input.workspaceId,
    sha: input.sha,
    reads: input.reads.length,
    gap: gap.models,
    reasons: gap.reasons,
    newColumns: gap.newColumns,
  });
  return gap;
}
