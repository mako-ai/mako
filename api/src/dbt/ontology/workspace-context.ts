/**
 * The workspace context pack: what an agent needs to start a business
 * question, in about 4k chars. It lists the registry's governed and draft
 * terms and entities with their canonical model.column, the semantic layer's
 * metrics with a one-line description, and the dbt models the most apps
 * read.
 *
 * Built from the same sources as lookup_term, list_metrics and find_models
 * (the registry on main, the stored semantic manifest, the last production
 * manifest and the apps index), so the pack never says something those
 * tools would contradict. Served by the get_workspace_context tool and the
 * MCP resource `mako://context`.
 */
import { Types } from "mongoose";
import { canSeeIndexedApp } from "../../apps/app-authorization";
import { loadAppsIndex } from "../../apps/app-index.service";
import { AppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { workspaceService } from "../../services/workspace.service";
import { findMetricByPhrase } from "../semantic/semantic-manifest";
import {
  loadSemanticProjects,
  type SemanticProject,
} from "../semantic/semantic-manifest.service";
import { truncateText } from "./manifest-index";
import {
  loadManifestIndexes,
  type ProjectManifestIndex,
} from "./manifest-index.service";
import {
  bindingReadsOf,
  readerCountsByNode,
  type AppBindingReads,
} from "./model-readers";
import {
  registryStatusMessage,
  type OntologyRegistry,
  type RegistryEntry,
} from "./registry";
import { loadOntologyRegistry } from "./registry.service";

const logger = loggers.api("dbt-ontology");

export const WORKSPACE_CONTEXT_URI = "mako://context";

/** Character budget per section; the whole pack stays near 4k. */
const TERMS_CHARS = 1_700;
const METRICS_CHARS = 1_300;
const MODELS_CHARS = 900;
const MAX_MODELS = 30;
const METRIC_DESCRIPTION_CHARS = 90;

/**
 * The bindings of the apps this actor may see: the app list's rule
 * (canSeeIndexedApp), so a private app never counts as a reader. Null when
 * the apps index cannot be read: readers are then unknown, not zero.
 */
export async function loadVisibleAppReads(
  workspaceId: string,
  userId: string | undefined,
): Promise<AppBindingReads[] | null> {
  try {
    const [snapshot, docs, member] = await Promise.all([
      loadAppsIndex(workspaceId),
      AppProject.find({ workspaceId: new Types.ObjectId(workspaceId) }),
      userId
        ? workspaceService.getMember(workspaceId, userId)
        : Promise.resolve(null),
    ]);
    const stateById = new Map(docs.map(doc => [doc._id.toString(), doc]));
    return snapshot.apps
      .filter(app =>
        canSeeIndexedApp(app, stateById.get(app.appId), userId, member?.role),
      )
      .map(bindingReadsOf);
  } catch (error) {
    logger.warn("Apps index unavailable for model readers", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface WorkspaceContextInput {
  registry: OntologyRegistry;
  /** Null: the semantic manifests could not be read right now. */
  semanticProjects: SemanticProject[] | null;
  /** Null: the dbt manifests could not be read right now. */
  manifests: ProjectManifestIndex[] | null;
  /** Null: the apps index could not be read. */
  apps: AppBindingReads[] | null;
}

export interface WorkspaceContextPack {
  text: string;
  counts: {
    terms: number;
    entities: number;
    metrics: number;
    models: number;
  };
}

/** Lines that fit `budget` chars, plus a "+N more" line when some did not. */
function fitLines(lines: string[], budget: number, more: string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length < lines.length) {
    kept.push(`- … ${lines.length - kept.length} more: ${more}`);
  }
  return kept;
}

/** A registry entry without a status is a draft, as join-path.ts reads it. */
function statusOf(entry: RegistryEntry): string {
  return entry.status ?? "draft";
}

function statusRank(status: string | undefined): number {
  if (status === "governed") return 0;
  if (status === "draft") return 1;
  return 2;
}

function canonicalOf(entry: RegistryEntry): string {
  if (!entry.canonical) return "no canonical model";
  if (entry.kind === "term") {
    return entry.canonical.column
      ? `${entry.canonical.model}.${entry.canonical.column}`
      : entry.canonical.model;
  }
  const key = entry.canonical.primaryKey;
  const keyText = Array.isArray(key) ? key.join(", ") : key;
  return keyText
    ? `${entry.canonical.model} (${keyText})`
    : entry.canonical.model;
}

/** The pack's text, from loaded sources. Pure, for tests. */
export function renderWorkspaceContext(
  input: WorkspaceContextInput,
): WorkspaceContextPack {
  const { registry, apps } = input;
  const semanticProjects = input.semanticProjects ?? [];
  const manifests = input.manifests ?? [];
  const sections: string[] = [
    "# Workspace context",
    "Business numbers start here: a term's metric goes to query_metric (rows) or compile_metric (SQL); otherwise read the canonical model. lookup_term, list_metrics and describe_model give the details.",
  ];

  // Terms and entities, governed first.
  const entries: RegistryEntry[] = [
    ...registry.terms,
    ...registry.entities,
  ].sort(
    (a, b) =>
      statusRank(statusOf(a)) - statusRank(statusOf(b)) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
  const termLines = entries
    .filter(entry => {
      const status = statusOf(entry);
      return status === "governed" || status === "draft";
    })
    .map(entry => {
      const metric = findMetricFor(semanticProjects, entry);
      return `- ${entry.name} [${statusOf(entry)}${entry.kind === "entity" ? ", entity" : ""}] → ${canonicalOf(entry)}${metric ? ` · metric ${metric}` : ""}`;
    });
  sections.push("", "## Terms (governed, then draft)");
  const registryMessage = registryStatusMessage(registry);
  if (registryMessage) sections.push(registryMessage);
  else if (termLines.length === 0) sections.push("No governed or draft term.");
  else sections.push(...fitLines(termLines, TERMS_CHARS, "lookup_term"));

  // Metrics, one line each.
  const metricLines: string[] = [];
  const seen = new Set<string>();
  for (const project of semanticProjects) {
    for (const metric of project.catalog.metrics) {
      if (seen.has(metric.name)) continue;
      seen.add(metric.name);
      const description = truncateText(
        metric.description ?? metric.label,
        METRIC_DESCRIPTION_CHARS,
      );
      metricLines.push(
        `- ${metric.name} (${metric.type})${description ? `: ${description}` : ""}`,
      );
    }
  }
  sections.push("", "## Metrics (semantic layer)");
  sections.push(
    input.semanticProjects === null
      ? "The metrics could not be read right now: use list_metrics."
      : metricLines.length === 0
        ? "No metric is defined yet."
        : fitLines(metricLines, METRICS_CHARS, "list_metrics").join("\n"),
  );

  // The models the most apps read.
  const modelRows: Array<{ name: string; readers: number; layer: string }> = [];
  if (apps) {
    for (const project of manifests) {
      const counts = readerCountsByNode(project.index, apps);
      for (const node of project.index.nodes) {
        if (node.resourceType !== "model") continue;
        const readers = counts.get(node.id) ?? 0;
        if (readers > 0) {
          modelRows.push({ name: node.name, readers, layer: node.layer });
        }
      }
    }
  }
  modelRows.sort(
    (a, b) => b.readers - a.readers || a.name.localeCompare(b.name),
  );
  const topModels = modelRows.slice(0, MAX_MODELS);
  sections.push("", "## Most-read dbt models (apps reading each)");
  if (input.manifests === null) {
    sections.push(
      "The dbt manifest could not be read right now: use find_models.",
    );
  } else if (manifests.length === 0) {
    sections.push("No dbt manifest is stored yet.");
  } else if (!apps) {
    sections.push("The apps index is unavailable: use find_models.");
  } else if (topModels.length === 0) {
    sections.push("No app reads a dbt model yet.");
  } else {
    sections.push(
      ...fitLines(
        topModels.map(row => `- ${row.name} (${row.readers}, ${row.layer})`),
        MODELS_CHARS,
        "find_models",
      ),
    );
  }

  return {
    text: sections.join("\n"),
    counts: {
      terms: registry.terms.length,
      entities: registry.entities.length,
      metrics: seen.size,
      models: topModels.length,
    },
  };
}

function findMetricFor(
  projects: SemanticProject[],
  entry: RegistryEntry,
): string | undefined {
  const phrases = [entry.name, entry.label ?? "", ...entry.synonyms].filter(
    Boolean,
  );
  for (const project of projects) {
    const metric = findMetricByPhrase(project.catalog, phrases);
    if (metric) return metric.name;
  }
  return undefined;
}

/** A rejected load becomes null, so the pack says "could not be read". */
function loadFailed(what: string) {
  return (error: unknown): null => {
    logger.warn(`Workspace context: ${what} could not be read`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  };
}

/** Load the sources and render the pack. Never throws. */
export async function buildWorkspaceContextPack(
  workspaceId: string,
  userId: string | undefined,
): Promise<WorkspaceContextPack> {
  const [registry, semanticProjects, manifests, apps] = await Promise.all([
    loadOntologyRegistry(workspaceId),
    loadSemanticProjects(workspaceId).catch(loadFailed("semantic manifests")),
    loadManifestIndexes(workspaceId).catch(loadFailed("dbt manifests")),
    loadVisibleAppReads(workspaceId, userId),
  ]);
  return renderWorkspaceContext({
    registry,
    semanticProjects,
    manifests,
    apps,
  });
}
