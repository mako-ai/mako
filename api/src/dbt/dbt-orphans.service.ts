// Owner: WP5 (warehouse introspection).
//
// Relations a deleted model left behind: everything in the schemas the last
// manifest writes to, minus what that manifest owns. Listing only. The set
// has known false positives (another tool writing into the same schema, a CI
// or branch build, a run that failed after adding a model, an old manifest),
// so every orphan carries a confidence and the reasons behind it.
import { Types } from "mongoose";
import { DbtRun } from "../database/workspace-schema";
import type { DatabaseDriver, WarehouseRelation } from "../databases/driver";
import { databaseRegistry } from "../databases/registry";
import {
  resolveDbtWarehouseTarget,
  type DbtWarehouseTarget,
  type WarehouseIntrospection,
} from "../services/warehouse-job-history.service";

/** Why an orphan may not be one. Empty = nothing argues against it. */
export type DbtOrphanReason =
  /** Written after the manifest was built: another tool or a newer build. */
  | "written_after_manifest"
  /** Last written while a CI, branch or laptop build ran in this environment. */
  | "written_during_branch_build"
  /** Last written while a run that then failed ran in this environment. */
  | "written_during_failed_run"
  /** The manifest is older than the threshold: models may have been added. */
  | "stale_manifest"
  /** A dbt work table (`__dbt_tmp`, `__dbt_backup`): a run may be in flight. */
  | "dbt_temporary_relation"
  /** Lives in a `dbt_test__audit` schema: a stored test failure. */
  | "test_audit_schema"
  /** An external table: dbt models never create one. */
  | "external_table"
  /** The project still holds this model, disabled. */
  | "disabled_node"
  /** The warehouse gave no last-write time, so the checks above did not run. */
  | "no_last_modified";

export interface DbtOrphanRelation extends WarehouseRelation {
  /**
   * high: no known false-positive class applies. medium: one check could not
   * run or the model is only disabled. low: a class applies, verify by hand.
   */
  confidence: "high" | "medium" | "low";
  reasons: DbtOrphanReason[];
}

export interface DbtOrphansReport {
  environment: string;
  /** Run whose manifest defined the expected set, and that manifest's age. */
  manifestRunId?: string;
  manifestGeneratedAt?: string;
  manifestAgeHours?: number;
  /** True when the manifest is older than `DBT_ORPHANS_STALE_HOURS`. */
  stale: boolean;
  warnings: string[];
  /** `database.schema` (or `schema`) of every schema listed. */
  schemasScanned: string[];
  /** Schemas the manifest writes to that the warehouse does not have. */
  schemasMissing: string[];
  expectedCount: number;
  relationsScanned: number;
  /** Relations matched to something that is not a model, and left out. */
  skipped: { sources: number; testFailureTables: number };
  /** Relations in the scanned schemas that no model, seed or snapshot owns. */
  orphans: DbtOrphanRelation[];
  /** True when more orphans exist than `orphans` holds. */
  truncated: boolean;
}

/** A manifest older than this is reported stale: 7 days. */
export const DBT_ORPHANS_STALE_HOURS = 7 * 24;
const MAX_SCHEMAS = 50;
const MAX_ORPHANS = 1000;
const MAX_OTHER_RUNS = 200;

interface ManifestNode {
  resource_type?: string;
  database?: string | null;
  schema?: string | null;
  alias?: string | null;
  name?: string | null;
  identifier?: string | null;
  config?: { materialized?: string | null } | null;
}

/** The parts of dbt's manifest.json this service reads. */
export interface DbtManifestLike {
  metadata?: { generated_at?: string };
  nodes?: Record<string, ManifestNode>;
  sources?: Record<string, ManifestNode>;
  disabled?: Record<string, ManifestNode[] | ManifestNode>;
}

/** A run of the environment that did not produce the manifest in use. */
export interface DbtOtherRun {
  kind: "branch" | "failed";
  startedAt: Date;
  completedAt: Date;
}

export interface LoadedDbtManifest {
  manifest: DbtManifestLike;
  runId?: string;
  /** CI, branch, laptop and failed runs of the environment, any age. */
  otherRuns: DbtOtherRun[];
}

/** Seams for the offline tests; production uses `defaultDbtOrphansDeps`. */
export interface DbtOrphansDeps {
  resolveTarget(params: {
    workspaceId: string;
    projectId: string;
    environment?: string;
  }): Promise<DbtWarehouseTarget>;
  /** Null when the environment has no stored manifest yet. */
  loadManifest(params: {
    workspaceId: string;
    projectId: string;
    target: DbtWarehouseTarget;
  }): Promise<LoadedDbtManifest | null>;
  getDriver(type: string): DatabaseDriver | undefined;
  now(): Date;
}

const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();

function relationKey(
  database: string | null | undefined,
  schema: string | null | undefined,
  name: string | null | undefined,
): string {
  return `${lower(database)}|${lower(schema)}|${lower(name)}`;
}

function resourceType(id: string, node: ManifestNode): string {
  return node.resource_type ?? id.split(".")[0];
}

export class RelationSet {
  private keys = new Set<string>();

  add(node: ManifestNode, name: string | null | undefined): void {
    if (!node.schema || !name) return;
    this.keys.add(relationKey(node.database, node.schema, name));
  }

  /** A node without a database matches the relation in any database. */
  has(relation: WarehouseRelation): boolean {
    return (
      this.keys.has(
        relationKey(relation.database, relation.schema, relation.name),
      ) || this.keys.has(relationKey(undefined, relation.schema, relation.name))
    );
  }

  get size(): number {
    return this.keys.size;
  }
}

export interface DbtExpectedRelations {
  /** Models (not ephemeral), seeds and snapshots. */
  expected: RelationSet;
  sources: RelationSet;
  /** Tests that store failures write a table named after the test. */
  tests: RelationSet;
  disabled: RelationSet;
  /** Distinct schemas of `expected`, in manifest order. */
  schemas: Array<{ database?: string; schema: string }>;
}

const OWNING_TYPES = new Set(["model", "seed", "snapshot"]);

/** What the manifest says the warehouse should hold. */
export function dbtExpectedRelations(
  manifest: DbtManifestLike,
): DbtExpectedRelations {
  const expected = new RelationSet();
  const sources = new RelationSet();
  const tests = new RelationSet();
  const disabled = new RelationSet();
  const schemas = new Map<string, { database?: string; schema: string }>();

  for (const [id, node] of Object.entries(manifest.nodes ?? {})) {
    const type = resourceType(id, node);
    if (type === "test") {
      tests.add(node, node.alias ?? node.name);
      continue;
    }
    if (!OWNING_TYPES.has(type)) continue;
    // An ephemeral model is inlined into its readers: it has no relation.
    if (node.config?.materialized === "ephemeral") continue;
    if (!node.schema) continue;
    expected.add(node, node.alias ?? node.name);
    const schemaKey = `${lower(node.database)}|${lower(node.schema)}`;
    if (!schemas.has(schemaKey)) {
      schemas.set(schemaKey, {
        database: node.database ?? undefined,
        schema: node.schema,
      });
    }
  }
  for (const source of Object.values(manifest.sources ?? {})) {
    sources.add(source, source.identifier ?? source.name);
  }
  for (const [id, entry] of Object.entries(manifest.disabled ?? {})) {
    for (const node of Array.isArray(entry) ? entry : [entry]) {
      if (!OWNING_TYPES.has(resourceType(id, node))) continue;
      disabled.add(node, node.alias ?? node.name);
    }
  }
  return { expected, sources, tests, disabled, schemas: [...schemas.values()] };
}

const DBT_TEMPORARY = /__dbt_(tmp|backup|new_data)/i;
const TEST_AUDIT_SCHEMA = /dbt_test__audit$/i;
/** Reasons that only lower confidence to medium. */
const MEDIUM_REASONS = new Set<DbtOrphanReason>([
  "disabled_node",
  "no_last_modified",
]);
const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * The relations no model, seed or snapshot owns, each with the reasons it
 * may be a false positive. Pure: no warehouse, no database.
 */
export function findDbtOrphans(input: {
  manifest: DbtManifestLike;
  relations: WarehouseRelation[];
  otherRuns?: DbtOtherRun[];
  now: Date;
  staleAfterHours?: number;
}): {
  orphans: DbtOrphanRelation[];
  expectedCount: number;
  skipped: { sources: number; testFailureTables: number };
  manifestGeneratedAt?: Date;
  manifestAgeHours?: number;
  stale: boolean;
} {
  const sets = dbtExpectedRelations(input.manifest);
  const generatedRaw = input.manifest.metadata?.generated_at;
  const generatedMs = generatedRaw ? Date.parse(generatedRaw) : NaN;
  const generatedAt = Number.isFinite(generatedMs)
    ? new Date(generatedMs)
    : undefined;
  const ageHours = generatedAt
    ? (input.now.getTime() - generatedAt.getTime()) / 3_600_000
    : undefined;
  // A manifest with no date cannot be shown to be fresh.
  const stale =
    ageHours === undefined ||
    ageHours > (input.staleAfterHours ?? DBT_ORPHANS_STALE_HOURS);

  const skipped = { sources: 0, testFailureTables: 0 };
  const orphans: DbtOrphanRelation[] = [];
  for (const relation of input.relations) {
    if (sets.expected.has(relation)) continue;
    if (sets.sources.has(relation)) {
      skipped.sources++;
      continue;
    }
    if (sets.tests.has(relation)) {
      skipped.testFailureTables++;
      continue;
    }

    const reasons: DbtOrphanReason[] = [];
    const modified = relation.lastModified?.getTime();
    if (modified === undefined) {
      reasons.push("no_last_modified");
    } else {
      const during = (kind: DbtOtherRun["kind"]) =>
        (input.otherRuns ?? []).some(
          run =>
            run.kind === kind &&
            modified >= run.startedAt.getTime() &&
            modified <= run.completedAt.getTime(),
        );
      if (during("branch")) reasons.push("written_during_branch_build");
      if (during("failed")) reasons.push("written_during_failed_run");
      if (generatedAt && modified > generatedAt.getTime()) {
        reasons.push("written_after_manifest");
      }
    }
    if (stale) reasons.push("stale_manifest");
    if (DBT_TEMPORARY.test(relation.name)) {
      reasons.push("dbt_temporary_relation");
    }
    if (TEST_AUDIT_SCHEMA.test(relation.schema)) {
      reasons.push("test_audit_schema");
    }
    if (relation.type === "external") reasons.push("external_table");
    if (sets.disabled.has(relation)) reasons.push("disabled_node");

    const confidence =
      reasons.length === 0
        ? "high"
        : reasons.every(reason => MEDIUM_REASONS.has(reason))
          ? "medium"
          : "low";
    orphans.push({ ...relation, confidence, reasons });
  }

  orphans.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
      a.schema.localeCompare(b.schema) ||
      a.name.localeCompare(b.name),
  );
  return {
    orphans,
    expectedCount: sets.expected.size,
    skipped,
    manifestGeneratedAt: generatedAt,
    manifestAgeHours:
      ageHours === undefined ? undefined : Math.round(ageHours * 10) / 10,
    stale,
  };
}

async function readManifest(key: string): Promise<DbtManifestLike | null> {
  const { getArtifactStore } =
    await import("../services/artifact-store.service");
  const stream = await getArtifactStore().openReadStream(key);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as DbtManifestLike;
}

/**
 * The manifest that says what the environment should hold. Production: the
 * promoted manifest of committed main (`lastProdManifestKey`). Any other
 * environment: its newest successful run, CI and laptop builds left out.
 */
async function loadEnvironmentManifest(params: {
  workspaceId: string;
  projectId: string;
  target: DbtWarehouseTarget;
}): Promise<LoadedDbtManifest | null> {
  const scope = {
    workspaceId: new Types.ObjectId(params.workspaceId),
    projectId: new Types.ObjectId(params.projectId),
    environment: params.target.environment,
  };
  const promotedKey = params.target.prodLike
    ? params.target.lastProdManifestKey
    : undefined;
  const run = promotedKey
    ? await DbtRun.findOne({ ...scope, "artifactKeys.manifest": promotedKey })
        .sort({ createdAt: -1 })
        .select("artifactKeys")
        .lean()
    : await DbtRun.findOne({
        ...scope,
        status: "success",
        trigger: { $ne: "ci" },
        localOverlay: { $exists: false },
        "artifactKeys.manifest": { $exists: true },
      })
        .sort({ createdAt: -1 })
        .select("artifactKeys")
        .lean();
  const key = promotedKey ?? run?.artifactKeys?.manifest;
  if (!key) return null;
  const manifest = await readManifest(key);
  if (!manifest) return null;

  const others = await DbtRun.find({
    ...scope,
    ...(run ? { _id: { $ne: run._id } } : {}),
    startedAt: { $exists: true },
    completedAt: { $exists: true },
    $or: [
      { status: "error" },
      { trigger: "ci" },
      { workingTreeUserId: { $exists: true } },
      { localOverlay: { $exists: true } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(MAX_OTHER_RUNS)
    .select("status startedAt completedAt")
    .lean();
  const otherRuns: DbtOtherRun[] = [];
  for (const other of others) {
    if (!other.startedAt || !other.completedAt) continue;
    otherRuns.push({
      kind: other.status === "error" ? "failed" : "branch",
      startedAt: other.startedAt,
      completedAt: other.completedAt,
    });
  }
  return { manifest, runId: run ? String(run._id) : undefined, otherRuns };
}

export const defaultDbtOrphansDeps: DbtOrphansDeps = {
  resolveTarget: resolveDbtWarehouseTarget,
  loadManifest: loadEnvironmentManifest,
  getDriver: type => databaseRegistry.getDriver(type),
  now: () => new Date(),
};

const schemaLabel = (entry: { database?: string; schema: string }) =>
  entry.database ? `${entry.database}.${entry.schema}` : entry.schema;

/**
 * Read-only: relations left behind by deleted models. Nothing is dropped.
 * `supported: false` when the engine cannot list relations or no manifest
 * exists yet. Throws on a failed warehouse query.
 *
 * Blind spot: a schema no model writes to any more is not scanned, so the
 * relations of a schema whose last model was deleted are not listed.
 */
export async function listDbtOrphans(
  params: {
    workspaceId: string;
    projectId: string;
    /** Default: the project's production environment. */
    environment?: string;
  },
  deps: DbtOrphansDeps = defaultDbtOrphansDeps,
): Promise<WarehouseIntrospection<DbtOrphansReport>> {
  const target = await deps.resolveTarget(params);
  const driver = deps.getDriver(target.connection.type);
  if (!driver?.listRelations) {
    return {
      supported: false,
      reason: `Listing relations is not available on ${target.connection.type} connections.`,
    };
  }
  const loaded = await deps.loadManifest({
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    target,
  });
  if (!loaded) {
    return {
      supported: false,
      reason:
        `Environment "${target.environment}" has no stored manifest yet. ` +
        `Run a job in it first.`,
    };
  }

  const { schemas } = dbtExpectedRelations(loaded.manifest);
  const warnings: string[] = [];
  if (schemas.length > MAX_SCHEMAS) {
    warnings.push(
      `The manifest writes to ${schemas.length} schemas. Only the first ${MAX_SCHEMAS} were scanned.`,
    );
  }
  const relations: WarehouseRelation[] = [];
  const schemasScanned: string[] = [];
  const schemasMissing: string[] = [];
  for (const entry of schemas.slice(0, MAX_SCHEMAS)) {
    const listed = await driver.listRelations(
      target.connection,
      entry.schema,
      entry.database ? { projectId: entry.database } : undefined,
    );
    if (listed === null) {
      schemasMissing.push(schemaLabel(entry));
      continue;
    }
    schemasScanned.push(schemaLabel(entry));
    relations.push(...listed);
  }

  const found = findDbtOrphans({
    manifest: loaded.manifest,
    relations,
    otherRuns: loaded.otherRuns,
    now: deps.now(),
  });
  if (found.stale) {
    warnings.push(
      found.manifestAgeHours === undefined
        ? "The manifest carries no build date. Every orphan is low confidence."
        : `The manifest is ${Math.round(found.manifestAgeHours / 24)} days old ` +
            `(threshold ${DBT_ORPHANS_STALE_HOURS / 24} days). Models added since ` +
            `then look like orphans. Every orphan is low confidence. Run a job ` +
            `in "${target.environment}" and list again.`,
    );
  }
  if (!target.prodLike) {
    warnings.push(
      `"${target.environment}" is not the production environment: its ` +
        `manifest comes from its newest successful run, which may be a ` +
        `branch build.`,
    );
  }
  warnings.push(
    "A schema that no model writes to any more is not scanned.",
    "Listing only: nothing was dropped. Check low and medium confidence " +
      "rows by hand before any drop.",
  );

  return {
    supported: true,
    environment: target.environment,
    manifestRunId: loaded.runId,
    manifestGeneratedAt: found.manifestGeneratedAt?.toISOString(),
    manifestAgeHours: found.manifestAgeHours,
    stale: found.stale,
    warnings,
    schemasScanned,
    schemasMissing,
    expectedCount: found.expectedCount,
    relationsScanned: relations.length,
    skipped: found.skipped,
    orphans: found.orphans.slice(0, MAX_ORPHANS),
    truncated: found.orphans.length > MAX_ORPHANS,
  };
}
