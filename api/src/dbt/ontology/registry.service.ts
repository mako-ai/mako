/**
 * Reads the ontology registry (`dbt/ontology/terms.yml`) from the main
 * branch of the workspace repo, through the same git layer the apps index
 * uses. Parsed once per commit of main.
 *
 * Never throws. No repo, no main or no file is an `absent` registry; a file
 * that does not parse is `malformed`; a git failure is `unavailable`. Every
 * caller gets an empty registry with a status it can relay.
 */
import { freshenForServe } from "../../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  readBlobsBatch,
  resolveCommit,
} from "../../apps/repository.service";
import { boundRepoDirIfExists } from "../../apps/workspace-repo-required";
import { loggers } from "../../logging";
import {
  ONTOLOGY_REGISTRY_PATH,
  emptyRegistry,
  parseOntologyRegistry,
  type OntologyRegistry,
} from "./registry";

const logger = loggers.api("dbt-ontology");

const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

/** workspaceId → the registry at one commit of main. */
const cache = new Map<string, { sha: string; registry: OntologyRegistry }>();

/** Forget every cached registry (tests). */
export function clearOntologyRegistryCache(): void {
  cache.clear();
}

export async function loadOntologyRegistry(
  workspaceId: string,
): Promise<OntologyRegistry> {
  try {
    const repoDir = await boundRepoDirIfExists(workspaceId);
    if (repoDir == null) return emptyRegistry("absent");
    // Throttled; a mirror that cannot be reached serves what the clone has.
    await freshenForServe(workspaceId).catch(() => undefined);
    const sha = await resolveCommit(repoDir, MAIN);
    if (!sha) return emptyRegistry("absent");
    const cached = cache.get(workspaceId);
    if (cached?.sha === sha) return cached.registry;
    const blobs = await readBlobsBatch(repoDir, sha, [ONTOLOGY_REGISTRY_PATH]);
    const blob = blobs.get(ONTOLOGY_REGISTRY_PATH);
    const registry = parseOntologyRegistry(blob ? blob.toString("utf8") : null);
    cache.set(workspaceId, { sha, registry });
    return registry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Ontology registry unreadable", {
      workspaceId,
      error: message,
    });
    return emptyRegistry("unavailable", [message.split("\n")[0]]);
  }
}
