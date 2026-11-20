/**
 * The schema gap: which dbt models a held app cannot run without.
 *
 * Deploy-on-push (dbt-before-deploy.ts) builds in prod only these nodes:
 *  - a model the held apps read whose prod relation is missing, or whose
 *    compiled columns include a column the prod table lacks;
 *  - a parent, seed or snapshot upstream of such a model with a gap of its
 *    own. The walk up stops at the first parent without one, and walks
 *    through ephemeral parents (they have no table to build);
 *  - a changed ancestor with a gap, and the `select *` models between it and
 *    a read model (their own dry run cannot see a column prod's parent lacks);
 *  - a changed seed or snapshot upstream of a read model (its columns cannot
 *    be read without building it).
 * Every other dbt change waits for its next scheduled job.
 *
 * Columns come from the pushed commit's compiled manifest: `dbt compile`
 * writes each model's `compiled_code`, and a BigQuery dry run of that SQL
 * returns the columns it would produce (nothing runs, nothing bills). Prod's
 * columns come from INFORMATION_SCHEMA.COLUMNS through the driver's own
 * `buildColumnListQuery`. Both sides are compared by TOP-LEVEL column name:
 * the dry run lists STRUCT leaves as `participants.email`, the table lists
 * `participants`.
 *
 * A dry run that fails counts as a gap only when BigQuery says a table or
 * column is missing (the usual cause: a parent lacks a column the model
 * selects). Any other failure throws, and the caller falls back (see
 * `detectSchemaGap`).
 *
 * Not detected: a new field INSIDE an existing STRUCT column. The compare is
 * by top-level name, so `participants.phone` added next to `participants`
 * looks like no change. That model waits for its scheduled job.
 *
 * An incremental model whose `on_schema_change` is `ignore` (the default) or
 * `fail` cannot get a new column from a build, so the app is not held on it:
 * it is reported in `unfixable`.
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
import { DBT_ROOT } from "../dbt/dbt-working-tree.service";
import {
  buildManifestIndex,
  type RawManifest,
} from "../dbt/ontology/manifest-index";
import { loggers } from "../logging";
import { databaseConnectionService } from "../services/database-connection.service";
import { withQueryLabels } from "../services/bigquery-labels";

const logger = loggers.api("apps-dbt-schema-gap");

/** A node's prod relation: BigQuery `project.dataset.table`, case kept. */
export interface GapRelation {
  project: string;
  dataset: string;
  table: string;
}

export type GapKind = "model" | "seed" | "snapshot";

export interface GapModel {
  name: string;
  kind: GapKind;
  /** Names of the parent models, seeds and snapshots (sources left out). */
  parents: string[];
  /** Null for an ephemeral model: it has no table. */
  relation: GapRelation | null;
  /** The compiled SQL; undefined when the manifest has none for it. */
  compiledSql?: string;
  /** Path inside the dbt project (`models/marts/x.sql`). */
  path?: string;
  materialized?: string;
  /** The `on_schema_change` config of an incremental model. */
  onSchemaChange?: string;
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
  /**
   * The TOP-LEVEL column names the SQL would return, or null when BigQuery
   * says a table or column it names is missing. Throws on any other failure.
   */
  queryColumns(sql: string): Promise<string[] | null>;
}

export type GapReason =
  /** The prod relation does not exist. */
  | "missing"
  /** The compiled columns include one the prod table lacks. */
  | "new-columns"
  /** The SQL names a table or column prod lacks (a parent has a gap). */
  | "unverified"
  /** A changed seed or snapshot: its columns cannot be read unbuilt. */
  | "changed-source"
  /** A `select *` model between a gap model and a read model. */
  | "pass-through";

export interface SchemaGap {
  /** Nodes to build, sorted. */
  models: string[];
  reasons: Record<string, GapReason>;
  /** New columns per model, for the log (empty for a missing relation). */
  newColumns: Record<string, string[]>;
  /** Models with a gap that a build cannot fix, with why. Not built. */
  unfixable: Record<string, string>;
  /** Reads the manifest does not hold (a name case or an unbuilt model). */
  unknownReads: string[];
}

/** Case-sensitive: BigQuery dataset and table names are. */
export function relationKey(relation: GapRelation): string {
  return `${relation.project}.${relation.dataset}.${relation.table}`;
}

/** `` `p`.`d`.`t` `` as dbt wrote it → its parts, case kept. */
function parseRelationName(
  relationName: string | undefined,
): GapRelation | null {
  if (!relationName) return null;
  const parts = relationName.replace(/[`"[\]]/g, "").split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return null;
  return { project: parts[0], dataset: parts[1], table: parts[2] };
}

const KINDS = new Set<string>(["model", "seed", "snapshot"]);

/**
 * The gap graph of a compiled manifest. Reuses the manifest index for names,
 * paths, relations and lineage; the compiled SQL and `on_schema_change` come
 * from the raw nodes.
 */
export function gapGraphFromManifest(manifest: RawManifest): GapGraph {
  const index = buildManifestIndex(manifest);
  const raws = new Map<
    string,
    {
      compiled_code?: string;
      compiled_sql?: string;
      config?: { on_schema_change?: string };
    }
  >();
  for (const [id, raw] of Object.entries(manifest.nodes ?? {})) {
    raws.set(id, raw as never);
  }
  const buildable = new Set(
    index.nodes.filter(n => KINDS.has(n.resourceType)).map(n => n.name),
  );
  const graph = new Map<string, GapModel>();
  for (const node of index.nodes) {
    if (!KINDS.has(node.resourceType)) continue;
    const raw = raws.get(node.id);
    const sql = raw?.compiled_code ?? raw?.compiled_sql;
    const ephemeral = node.materialized === "ephemeral";
    graph.set(node.name, {
      name: node.name,
      kind: node.resourceType as GapKind,
      parents: node.parents.filter(name => buildable.has(name)),
      relation: ephemeral ? null : parseRelationName(node.relationName),
      ...(sql ? { compiledSql: sql } : {}),
      ...(node.path ? { path: node.path } : {}),
      ...(node.materialized ? { materialized: node.materialized } : {}),
      ...(raw?.config?.on_schema_change
        ? { onSchemaChange: raw.config.on_schema_change }
        : {}),
    });
  }
  return graph;
}

/** Nodes whose file the push changed (repo paths start with `dbt/`). */
export function changedNodeNames(
  graph: GapGraph,
  changedPaths: readonly string[],
): Set<string> {
  const changed = new Set(changedPaths);
  const out = new Set<string>();
  for (const node of graph.values()) {
    if (node.path && changed.has(`${DBT_ROOT}/${node.path}`)) {
      out.add(node.name);
    }
  }
  return out;
}

/**
 * `select *`, `select distinct *`, `, *` and `alias.*`: a model that passes
 * its parent's columns through, so its own dry run cannot see a column the
 * parent only gets in the next build. `count(*)` and `a * b` do not match.
 */
const SELECT_STAR = /(?:\bselect\s+(?:distinct\s+)?|,\s*|[\w`"\]]\.)\*/i;

export function selectsStar(sql: string | undefined): boolean {
  return !!sql && SELECT_STAR.test(sql);
}

/** Can a build add a column to this node's prod table? */
export function buildCanAddColumns(node: GapModel): boolean {
  if (node.materialized !== "incremental") return true;
  return (
    node.onSchemaChange === "append_new_columns" ||
    node.onSchemaChange === "sync_all_columns"
  );
}

function whyUnfixable(node: GapModel): string {
  return `incremental with on_schema_change=${node.onSchemaChange ?? "ignore"}: a build cannot add the column`;
}

/**
 * The nodes the held apps cannot run without. `reads` are the models their
 * bindings read; `changed` are the nodes whose file the push changed.
 */
export async function findSchemaGap(input: {
  graph: GapGraph;
  reads: readonly string[];
  warehouse: WarehouseLookup;
  changed?: ReadonlySet<string>;
}): Promise<SchemaGap> {
  const { graph, warehouse } = input;
  const changed = input.changed ?? new Set<string>();

  const lowerNames = new Map<string, string>();
  for (const name of graph.keys()) {
    if (!lowerNames.has(name.toLowerCase())) {
      lowerNames.set(name.toLowerCase(), name);
    }
  }
  const reads: string[] = [];
  const unknownReads: string[] = [];
  for (const read of new Set(input.reads)) {
    const name = graph.has(read) ? read : lowerNames.get(read.toLowerCase());
    if (name) reads.push(name);
    else unknownReads.push(read);
  }

  // Every node a read model depends on, itself included.
  const scope = new Set<string>();
  const queue = [...reads];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (scope.has(name)) continue;
    scope.add(name);
    queue.push(...(graph.get(name)?.parents ?? []));
  }

  const prod = new Map<string, Set<string>>();
  const looked = new Set<string>();
  const reasons: Record<string, GapReason> = {};
  const newColumns: Record<string, string[]> = {};
  const unfixable: Record<string, string> = {};
  const assessed = new Map<string, boolean>();
  const included = new Set<string>();
  const seen = new Set<string>();

  /** Fetch prod columns for nodes not looked up yet, one query per dataset. */
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

  /** Does this node, by itself, lack something in prod? Memoised. */
  const assess = async (name: string): Promise<boolean> => {
    const known = assessed.get(name);
    if (known !== undefined) return known;
    const node = graph.get(name);
    const done = (gap: boolean) => {
      assessed.set(name, gap);
      return gap;
    };
    // Not in the manifest, or ephemeral: nothing a build can fix.
    if (!node?.relation) return done(false);
    await loadProd([name]);
    const existing = prod.get(relationKey(node.relation));
    if (!existing) {
      reasons[name] = "missing";
      return done(true);
    }
    if (node.kind !== "model") {
      // A seed's or snapshot's columns are not in the manifest SQL: a
      // changed one is built, an unchanged one is left alone.
      if (!changed.has(name)) return done(false);
      reasons[name] = "changed-source";
      return done(true);
    }
    const columns = node.compiledSql
      ? await warehouse.queryColumns(node.compiledSql)
      : null;
    let reason: GapReason | null = null;
    if (!columns) {
      reason = "unverified";
    } else {
      const added = [
        ...new Set(
          columns.map(c => c.toLowerCase()).filter(c => !existing.has(c)),
        ),
      ].sort();
      if (added.length > 0) {
        reason = "new-columns";
        newColumns[name] = added;
      }
    }
    if (!reason) return done(false);
    if (!buildCanAddColumns(node)) {
      unfixable[name] = whyUnfixable(node);
      return done(false);
    }
    reasons[name] = reason;
    return done(true);
  };

  // Walk up from a node, only while the gap holds. An ephemeral parent has
  // no table of its own: the walk goes through it to its parents.
  const walk = async (names: readonly string[]): Promise<void> => {
    const todo = names.filter(name => !seen.has(name));
    for (const name of todo) seen.add(name);
    await loadProd(todo);
    for (const name of todo) {
      const node = graph.get(name);
      if (!node) continue;
      if (!node.relation) {
        await walk(node.parents);
        continue;
      }
      if (!(await assess(name))) continue;
      included.add(name);
      await walk(node.parents);
    }
  };

  // 1. The read models, and what they need above them.
  await walk(reads);
  // 2. Changed ancestors with a gap of their own. A read model that passes
  //    their columns through (`select *`) cannot show the gap in its own dry
  //    run: prod's parent lacks the column until the next build. They join
  //    the build only when such a model sits between them and a read model.
  const relationParents = (name: string, acc = new Set<string>()) => {
    for (const parent of graph.get(name)?.parents ?? []) {
      const node = graph.get(parent);
      if (!node) continue;
      if (!node.relation) relationParents(parent, acc);
      else acc.add(parent);
    }
    return acc;
  };
  const candidates = new Set<string>();
  for (const name of [...scope].sort()) {
    if (included.has(name) || !changed.has(name)) continue;
    if (!graph.get(name)?.relation) continue;
    if (await assess(name)) candidates.add(name);
  }
  const promote = async (name: string): Promise<void> => {
    candidates.delete(name);
    included.add(name);
    for (const parent of graph.get(name)?.parents ?? []) {
      if (candidates.has(parent)) await promote(parent);
      else await walk([parent]);
    }
  };

  // 3. Bottom-up: a model with an included or candidate parent that passes
  //    its columns through (or whose own check finds a gap) joins the build,
  //    and takes its candidate parents with it.
  let grew = true;
  while (grew && candidates.size > 0) {
    grew = false;
    for (const name of [...scope].sort()) {
      const node = graph.get(name);
      if (included.has(name) || !node?.relation || node.kind !== "model") {
        continue;
      }
      const above = [...relationParents(name)].filter(
        p => included.has(p) || candidates.has(p),
      );
      if (above.length === 0) continue;
      if (!selectsStar(node.compiledSql) && !(await assess(name))) continue;
      if (!buildCanAddColumns(node)) {
        unfixable[name] = whyUnfixable(node);
        continue;
      }
      reasons[name] ??= "pass-through";
      included.add(name);
      for (const parent of above) {
        if (candidates.has(parent)) await promote(parent);
      }
      grew = true;
    }
  }

  const models = [...included].sort();
  return {
    models,
    reasons: Object.fromEntries(models.map(m => [m, reasons[m]])) as Record<
      string,
      GapReason
    >,
    newColumns,
    unfixable,
    unknownReads,
  };
}

/** A name dbt's selector and our command tokenizer both take as is. */
export const SAFE_NODE_NAME = /^[A-Za-z0-9_]+$/;

/** Names a selector can carry; the rest are logged, never dropped silently. */
export function selectableNames(names: readonly string[]): string[] {
  const unsafe = names.filter(name => !SAFE_NODE_NAME.test(name));
  if (unsafe.length > 0) {
    logger.warn("dbt names left out of a selector: unsupported characters", {
      names: unsafe,
    });
  }
  return [...new Set(names)].filter(name => SAFE_NODE_NAME.test(name)).sort();
}

/**
 * `compile --select +m1 +m2`: every read model with all of its ancestors, so
 * the manifest carries the compiled SQL the parent walk needs.
 */
export function compileGraphCommand(reads: readonly string[]): string {
  return `compile --select ${selectableNames(reads)
    .map(model => `+${model}`)
    .join(" ")}`;
}

/** The pushed commit does not compile: nothing can be checked or built. */
export class DbtCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbtCompileError";
  }
}

/**
 * Compile the held apps' models (and their ancestors) at the pushed commit
 * in the prod-like environment. The compile runs in the shared ad-hoc dbt
 * directory of the project, so it queues behind other shared compiles.
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
    throw new DbtCompileError(`dbt compile failed (exit ${result.exitCode})`);
  }
  const buffer = result.raw.artifacts.manifest;
  if (!buffer) throw new DbtCompileError("dbt compile wrote no manifest");
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
) => Promise<{
  success: boolean;
  columns?: Array<{ name: string }>;
  error?: string;
}>;

const defaultQuerySchema: QuerySchema = (connection, sql) =>
  databaseConnectionService.getBigQueryQuerySchema(connection, sql);

/** BigQuery's wording when a table or column the SQL names is not there. */
const MISSING_NAME =
  /unrecognized name|not found inside|not found: (?:table|dataset|view)|(?:table|view|dataset) \S+ was not found|does not exist|no such (?:table|column)/i;

/**
 * "Not found: Table x was not found in location EU" is also what BigQuery
 * says when the job runs in the wrong location. That is a connection
 * problem, not a missing table, so it never counts as a gap.
 */
const WRONG_LOCATION = /not found in location/i;

/**
 * The warehouse answers for a BigQuery connection. Prod columns: one
 * `INFORMATION_SCHEMA.COLUMNS` query per dataset, from the driver's
 * `buildColumnListQuery`.
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
      if (!result.success || !result.columns) {
        const error = result.error ?? "";
        if (!WRONG_LOCATION.test(error) && MISSING_NAME.test(error)) {
          return null;
        }
        throw new Error(result.error || "dry run failed");
      }
      // The dry run flattens a STRUCT to leaves (`participants.email`);
      // INFORMATION_SCHEMA.COLUMNS lists `participants`.
      return [...new Set(result.columns.map(c => c.name.split(".")[0]))];
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

export type GapOutcome =
  /** The check ran: build these nodes (maybe none). */
  | { kind: "gap"; gap: SchemaGap }
  /**
   * The warehouse side of the check failed. Build the changed read models
   * directly and hold, as the reviewer asked: no `+`, no children.
   */
  | { kind: "fallback"; models: string[]; error: string }
  /** No BigQuery connection to ask: keep today's `full` build. */
  | { kind: "full" };

/**
 * The nodes a held app cannot run without, for one push. Throws
 * `DbtCompileError` when the pushed commit does not compile: the caller then
 * deploys at once. A failing warehouse query falls back to building the
 * changed read models. A non-BigQuery warehouse, or an environment without a
 * connection, returns `full`.
 */
export async function detectSchemaGap(input: {
  workspaceId: string;
  projectId: string;
  environment: string;
  connectionId?: Types.ObjectId | string;
  sha: string;
  reads: readonly string[];
  /** Repo paths the push changed. */
  changedPaths: readonly string[];
  /** Called once the project has compiled. */
  onCompiled?: () => Promise<void>;
}): Promise<GapOutcome> {
  const connection = input.connectionId
    ? await loadEnvironmentConnection(input.workspaceId, input.connectionId)
    : null;
  if (!connection || connection.type !== "bigquery") return { kind: "full" };

  const graph = await compileGapGraph(input);
  await input.onCompiled?.();
  const changed = changedNodeNames(graph, input.changedPaths);
  try {
    const gap = await findSchemaGap({
      graph,
      reads: input.reads,
      warehouse: warehouseLookupFor(connection),
      changed,
    });
    logger.info("Schema gap checked", {
      workspaceId: input.workspaceId,
      sha: input.sha,
      reads: input.reads.length,
      gap: gap.models,
      reasons: gap.reasons,
      newColumns: gap.newColumns,
    });
    if (gap.unfixable && Object.keys(gap.unfixable).length > 0) {
      logger.warn("A build cannot close this schema gap; app not held on it", {
        workspaceId: input.workspaceId,
        sha: input.sha,
        unfixable: gap.unfixable,
      });
    }
    if (gap.unknownReads.length > 0) {
      logger.warn("Models an app reads are not in the compiled manifest", {
        workspaceId: input.workspaceId,
        sha: input.sha,
        reads: gap.unknownReads,
      });
    }
    return { kind: "gap", gap };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = new Map<string, string>();
    for (const name of graph.keys()) lower.set(name.toLowerCase(), name);
    const models = [
      ...new Set(
        input.reads
          .map(read => lower.get(read.toLowerCase()))
          .filter((name): name is string => !!name && changed.has(name)),
      ),
    ]
      // A build that cannot add the column is no reason to hold the app.
      .filter(name => {
        const node = graph.get(name);
        if (!node || buildCanAddColumns(node)) return true;
        logger.warn("A build cannot close this schema gap; app not held", {
          workspaceId: input.workspaceId,
          sha: input.sha,
          model: name,
          why: whyUnfixable(node),
        });
        return false;
      })
      .sort();
    logger.warn("Schema gap check failed; building the changed read models", {
      workspaceId: input.workspaceId,
      sha: input.sha,
      models,
      error: message,
    });
    return { kind: "fallback", models, error: message };
  }
}
