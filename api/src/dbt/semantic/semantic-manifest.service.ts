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
 * A manifest is parsed once per version, like the manifest index
 * (ontology/manifest-index.service.ts).
 */
import { Types } from "mongoose";
import { DbtProject, DbtRun } from "../../database/workspace-schema";
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
  /** `prod`: the last production build. `latest-run`: see the file header. */
  source: "prod" | "latest-run";
  /** Artifact-store key of the semantic manifest the catalog was built from. */
  semanticManifestKey: string;
  /** The environment whose relations the manifest names. */
  environmentName: string;
  /** That environment's warehouse connection, when it still exists. */
  connectionId?: string;
  catalog: SemanticCatalog;
}

interface CacheEntry {
  key: string;
  catalog: Promise<SemanticCatalog | null>;
}

/** `${workspaceId}:${projectId}` → the catalog of that project's manifest. */
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
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  lastProdManifestKey?: string;
  environments: Array<{ name: string; connectionId?: Types.ObjectId }>;
};

/**
 * The semantic manifest to describe a project by, and the environment that
 * built it. Every lookup names the workspace, so it walks the
 * `{workspaceId, projectId, createdAt}` index.
 */
async function semanticKeysFor(project: ProjectFields): Promise<{
  key: string;
  source: SemanticProject["source"];
  environmentName: string;
} | null> {
  if (project.lastProdManifestKey) {
    const owner = await DbtRun.findOne({
      workspaceId: project.workspaceId,
      projectId: project._id,
      "artifactKeys.manifest": project.lastProdManifestKey,
    })
      .select("artifactKeys environment")
      .sort({ createdAt: -1 })
      .lean();
    if (owner?.artifactKeys?.semanticManifest) {
      return {
        key: owner.artifactKeys.semanticManifest,
        source: "prod",
        environmentName: owner.environment,
      };
    }
  }
  const latest = await DbtRun.findOne({
    workspaceId: project.workspaceId,
    projectId: project._id,
    "artifactKeys.semanticManifest": { $exists: true, $ne: null },
  })
    .select("artifactKeys environment")
    .sort({ createdAt: -1 })
    .lean();
  const key = latest?.artifactKeys?.semanticManifest;
  if (!key || !latest) return null;
  return { key, source: "latest-run", environmentName: latest.environment };
}

/**
 * The semantic catalog of every dbt project in the workspace that has one
 * (optionally one project). Never throws: a project whose manifest is
 * missing or unreadable is left out and logged. A project with a manifest
 * but no metrics IS returned, with an empty catalog.
 */
export async function loadSemanticProjects(
  workspaceId: string,
  options: { projectId?: string } = {},
): Promise<SemanticProject[]> {
  if (!Types.ObjectId.isValid(workspaceId)) return [];
  if (options.projectId && !Types.ObjectId.isValid(options.projectId)) {
    return [];
  }
  const projects = await DbtProject.find({
    workspaceId: new Types.ObjectId(workspaceId),
    ...(options.projectId
      ? { _id: new Types.ObjectId(options.projectId) }
      : {}),
  })
    .select("_id workspaceId name lastProdManifestKey environments")
    .sort({ updatedAt: -1 })
    .lean<ProjectFields[]>();

  const out: SemanticProject[] = [];
  for (const project of projects) {
    try {
      const keys = await semanticKeysFor(project);
      if (!keys) continue;
      const cacheKey = `${workspaceId}:${project._id.toString()}`;
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
