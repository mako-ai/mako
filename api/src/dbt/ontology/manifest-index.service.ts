/**
 * Loads the manifest index of each dbt project in a workspace, from the
 * artifacts the runner already stores (the same store the lineage route
 * reads), and keeps it in memory.
 *
 * Which manifest: the project's last successful PRODUCTION manifest
 * (`lastProdManifestKey`, what `--defer` resolves against). A project that
 * has never built prod falls back to its latest run with a manifest, and the
 * result says so. Column types come from the catalog.json of that same run,
 * when it stored one (`dbt docs generate`).
 *
 * A manifest is parsed once per version: the cache holds one index per
 * project, keyed by the artifact keys it was built from, so a new prod build
 * replaces the entry and nothing accumulates.
 */
import { Types } from "mongoose";
import { DbtProject, DbtRun } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { getArtifactStore } from "../../services/artifact-store.service";
import {
  buildManifestIndex,
  type ManifestIndex,
  type RawCatalog,
  type RawManifest,
} from "./manifest-index";

const logger = loggers.api("dbt-ontology");

export interface ProjectManifestIndex {
  projectId: string;
  projectName: string;
  /** `prod`: the last production build. `latest-run`: no prod build yet. */
  source: "prod" | "latest-run";
  index: ManifestIndex;
}

interface CacheEntry {
  manifestKey: string;
  catalogKey: string | null;
  index: Promise<ManifestIndex | null>;
}

/** `${workspaceId}:${projectId}` → the index of that project's manifest. */
const cache = new Map<string, CacheEntry>();

/** Forget every cached index (tests). */
export function clearManifestIndexCache(): void {
  cache.clear();
}

async function readJsonArtifact<T>(key: string): Promise<T | null> {
  const stream = await getArtifactStore().openReadStream(key);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function buildIndex(
  manifestKey: string,
  catalogKey: string | null,
): Promise<ManifestIndex | null> {
  const manifest = await readJsonArtifact<RawManifest>(manifestKey);
  if (!manifest) return null;
  // A catalog is a bonus (column types): never the reason a lookup fails.
  const catalog = catalogKey
    ? await readJsonArtifact<RawCatalog>(catalogKey).catch(error => {
        logger.warn("dbt catalog unreadable; column types omitted", {
          catalogKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
    : null;
  return buildManifestIndex(manifest, catalog);
}

/**
 * The manifest (and catalog, when there is one) to describe a project by.
 * Only the catalog of the run that wrote the manifest is used: another
 * run's (a dev build, a working tree) could list columns prod does not
 * have. Every lookup names the workspace, so it walks the
 * `{workspaceId, projectId, createdAt}` index.
 */
async function artifactKeysFor(project: {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  lastProdManifestKey?: string;
}): Promise<{
  manifestKey: string;
  catalogKey: string | null;
  source: ProjectManifestIndex["source"];
} | null> {
  let manifestKey = project.lastProdManifestKey;
  let source: ProjectManifestIndex["source"] = "prod";
  let catalogKey: string | null;
  if (manifestKey) {
    const owner = await DbtRun.findOne({
      workspaceId: project.workspaceId,
      projectId: project._id,
      "artifactKeys.manifest": manifestKey,
    })
      .select("artifactKeys")
      .sort({ createdAt: -1 })
      .lean();
    catalogKey = owner?.artifactKeys?.catalog ?? null;
  } else {
    const latest = await DbtRun.findOne({
      workspaceId: project.workspaceId,
      projectId: project._id,
      "artifactKeys.manifest": { $exists: true, $ne: null },
    })
      .select("artifactKeys")
      .sort({ createdAt: -1 })
      .lean();
    manifestKey = latest?.artifactKeys?.manifest;
    if (!manifestKey) return null;
    source = "latest-run";
    catalogKey = latest?.artifactKeys?.catalog ?? null;
  }
  return { manifestKey, catalogKey, source };
}

/**
 * The manifest index of every dbt project in the workspace that has one
 * (optionally one project). Never throws: a project whose manifest is
 * missing or unreadable is left out and logged.
 */
export async function loadManifestIndexes(
  workspaceId: string,
  options: { projectId?: string } = {},
): Promise<ProjectManifestIndex[]> {
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
    .select("_id workspaceId name lastProdManifestKey")
    .sort({ updatedAt: -1 })
    .lean();

  const out: ProjectManifestIndex[] = [];
  for (const project of projects) {
    try {
      const keys = await artifactKeysFor(project);
      if (!keys) continue;
      const cacheKey = `${workspaceId}:${project._id.toString()}`;
      let entry = cache.get(cacheKey);
      if (
        !entry ||
        entry.manifestKey !== keys.manifestKey ||
        entry.catalogKey !== keys.catalogKey
      ) {
        entry = {
          manifestKey: keys.manifestKey,
          catalogKey: keys.catalogKey,
          index: buildIndex(keys.manifestKey, keys.catalogKey),
        };
        cache.set(cacheKey, entry);
        // A failed read must not be remembered as the answer.
        const built = entry;
        built.index.catch(() => {
          if (cache.get(cacheKey) === built) cache.delete(cacheKey);
        });
      }
      const index = await entry.index;
      if (!index) {
        if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
        continue;
      }
      out.push({
        projectId: project._id.toString(),
        projectName: project.name,
        source: keys.source,
        index,
      });
    } catch (error) {
      logger.warn("dbt manifest unreadable; project left out", {
        workspaceId,
        projectId: project._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
