/**
 * Loads the semantic catalog (metrics) of each dbt project in a workspace,
 * from the `semantic_manifest.json` the runner stores with every run.
 *
 * Which manifest: the one written by the build that produced the project's
 * last successful PRODUCTION manifest (`lastProdManifestKey`), so metrics
 * compile against prod relations. A project whose prod build predates the
 * semantic manifest (or that has never built prod) falls back to its latest
 * run that stored one, and the result says so: that SQL names the relations
 * of whatever environment that run built.
 *
 * A caller can name a dbt environment instead (a personal dev one): the
 * catalog then comes from that environment's latest run, so a metric written
 * on a branch can be listed, compiled and queried before it is merged.
 *
 * A manifest is parsed once per version, like the manifest index
 * (ontology/manifest-index.service.ts).
 */
import { parseEntityId } from "../../database/pg/id-codec";
import { dbtRepo } from "../../repositories/dbt";
import { loggers } from "../../logging";
import { getArtifactStore } from "../../services/artifact-store.service";
import {
  buildSemanticCatalog,
  type RawSemanticManifest,
  type SemanticCatalog,
} from "./semantic-manifest";

const logger = loggers.api("dbt-semantic");

export interface SemanticProject {
  projectId: string;
  projectName: string;
  /**
   * `prod`: the last production build. `latest-run`: no prod build stored a
   * semantic manifest. `environment`: the latest run of the environment the
   * caller named.
   */
  source: "prod" | "latest-run" | "environment";
  /** Artifact-store key of the semantic manifest the catalog was built from. */
  semanticManifestKey: string;
  /** The environment whose relations the manifest names. */
  environmentName: string;
  /** That environment's warehouse connection, when it still exists. */
  connectionId?: string;
  /**
   * That environment's read-only connection, when it names one. Metric
   * queries prefer it: `connectionId` is the credential dbt builds with,
   * so it can write.
   */
  readConnectionId?: string;
  catalog: SemanticCatalog;
}

interface CacheEntry {
  key: string;
  catalog: Promise<SemanticCatalog | null>;
}

/**
 * `${workspaceId}:${projectId}:${environment ?? ""}` → the catalog of that
 * project's manifest.
 */
const cache = new Map<string, CacheEntry>();

/** Forget every cached catalog (tests). */
export function clearSemanticCatalogCache(): void {
  cache.clear();
}

/** The bytes of a stored artifact, or null when the store has none. */
export async function readArtifactBuffer(key: string): Promise<Buffer | null> {
  const stream = await getArtifactStore().openReadStream(key);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function buildCatalog(key: string): Promise<SemanticCatalog | null> {
  const buffer = await readArtifactBuffer(key);
  if (!buffer) return null;
  return buildSemanticCatalog(
    JSON.parse(buffer.toString("utf8")) as RawSemanticManifest,
  );
}

type ProjectFields = {
  _id: string;
  workspaceId: string;
  name: string;
  lastProdManifestKey?: string;
  environments: Array<{
    name: string;
    connectionId?: string;
    readConnectionId?: string;
  }>;
};

/**
 * The semantic manifest to describe a project by, and the environment that
 * built it. Every lookup names the workspace, so it walks the
 * `{workspaceId, projectId, createdAt}` index.
 */
async function semanticKeysFor(
  project: ProjectFields,
  environment?: string,
): Promise<{
  key: string;
  source: SemanticProject["source"];
  environmentName: string;
} | null> {
  if (environment) {
    const run = await dbtRepo.findLatestArtifactRun({
      workspaceId: project.workspaceId,
      projectId: project._id,
      environment,
      hasSemanticManifest: true,
    });
    const key = run?.artifactKeys?.semanticManifest;
    return key
      ? { key, source: "environment", environmentName: environment }
      : null;
  }
  if (project.lastProdManifestKey) {
    const owner = await dbtRepo.findLatestArtifactRun({
      workspaceId: project.workspaceId,
      projectId: project._id,
      manifestKey: project.lastProdManifestKey,
    });
    if (owner?.artifactKeys?.semanticManifest) {
      return {
        key: owner.artifactKeys.semanticManifest,
        source: "prod",
        environmentName: owner.environment,
      };
    }
  }
  const latest = await dbtRepo.findLatestArtifactRun({
    workspaceId: project.workspaceId,
    projectId: project._id,
    hasSemanticManifest: true,
  });
  const key = latest?.artifactKeys?.semanticManifest;
  if (!key || !latest) return null;
  return { key, source: "latest-run", environmentName: latest.environment };
}

/**
 * The semantic catalog of every dbt project in the workspace that has one
 * (optionally one project, optionally as one dbt environment last built it).
 * Never throws: a project whose manifest is missing or unreadable is left
 * out and logged. A project with a manifest but no metrics IS returned, with
 * an empty catalog.
 */
export async function loadSemanticProjects(
  workspaceId: string,
  options: { projectId?: string; environment?: string } = {},
): Promise<SemanticProject[]> {
  if (!parseEntityId(workspaceId)) return [];
  if (options.projectId && !parseEntityId(options.projectId)) {
    return [];
  }
  const projects = await dbtRepo.listProjectsByWorkspace(workspaceId, {
    projectId: options.projectId,
  });

  const out: SemanticProject[] = [];
  for (const project of projects) {
    try {
      const keys = await semanticKeysFor(project, options.environment);
      if (!keys) continue;
      const cacheKey = `${workspaceId}:${project._id.toString()}:${options.environment ?? ""}`;
      let entry = cache.get(cacheKey);
      if (!entry || entry.key !== keys.key) {
        entry = { key: keys.key, catalog: buildCatalog(keys.key) };
        cache.set(cacheKey, entry);
        // A failed read must not be remembered as the answer.
        const built = entry;
        built.catalog.catch(() => {
          if (cache.get(cacheKey) === built) cache.delete(cacheKey);
        });
      }
      const catalog = await entry.catalog;
      if (!catalog) {
        if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
        continue;
      }
      const environment = project.environments.find(
        env => env.name === keys.environmentName,
      );
      out.push({
        projectId: project._id.toString(),
        projectName: project.name,
        source: keys.source,
        semanticManifestKey: keys.key,
        environmentName: keys.environmentName,
        ...(environment?.connectionId
          ? { connectionId: environment.connectionId.toString() }
          : {}),
        ...(environment?.readConnectionId
          ? { readConnectionId: environment.readConnectionId.toString() }
          : {}),
        catalog,
      });
    } catch (error) {
      logger.warn("dbt semantic manifest unreadable; project left out", {
        workspaceId,
        projectId: project._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/** Why `loadSemanticProjects` found nothing for what the caller named. */
export type NoSemanticProjects =
  | { reason: "unknown-project"; projects: Array<{ id: string; name: string }> }
  | { reason: "unknown-environment"; environments: string[] }
  | { reason: "no-manifest" };

/**
 * Tells a name that does not exist from one that exists and has no parsed
 * run yet: a wrong projectId, a dbt environment no project has, or a real
 * project/environment whose runs stored no semantic manifest.
 */
export async function explainNoSemanticProjects(
  workspaceId: string,
  options: { projectId?: string; environment?: string } = {},
): Promise<NoSemanticProjects> {
  if (!parseEntityId(workspaceId)) return { reason: "no-manifest" };
  const projects = await dbtRepo.listProjectsByWorkspace(workspaceId, {
    sort: "nameAsc",
  });
  const named = options.projectId
    ? projects.filter(project => project._id.toString() === options.projectId)
    : projects;
  if (options.projectId && named.length === 0) {
    return {
      reason: "unknown-project",
      projects: projects.map(project => ({
        id: project._id.toString(),
        name: project.name,
      })),
    };
  }
  if (options.environment) {
    const environments = [
      ...new Set(
        named.flatMap(project => project.environments.map(env => env.name)),
      ),
    ].sort();
    if (!environments.includes(options.environment)) {
      return { reason: "unknown-environment", environments };
    }
  }
  return { reason: "no-manifest" };
}
