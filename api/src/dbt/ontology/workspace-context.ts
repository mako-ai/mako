/**
 * The workspace context pack: what an agent needs to start a business
 * question, in at most 6k chars. It lists the name of every governed and
 * draft registry term and entity, every semantic-layer metric (by type) and
 * the 30 dbt models the most apps read, with no descriptions: the agent sees
 * every name at once and asks lookup_term, list_metrics or describe_model for
 * the definitions.
 *
 * Built from the same sources as lookup_term, list_metrics and find_models
 * (the registry on main, the stored semantic manifest, the last production
 * manifest and the apps index), so the pack never says something those
 * tools would contradict. Served by the get_workspace_context tool and the
 * MCP resource `mako://context`.
 */
import { canSeeIndexedApp } from "../../apps/app-authorization";
import { loadAppsIndex } from "../../apps/app-index.service";
import { loggers } from "../../logging";
import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../../repositories/apps-metadata";
import { workspaceService } from "../../services/workspace.service";
import {
  loadSemanticProjects,
  type SemanticProject,
} from "../semantic/semantic-manifest.service";
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

/**
 * The whole pack's character cap. A workspace of RealAdvisor's size (117
 * metrics, 156 terms and entities, 30 models) lists every name in under 6k
 * chars; the cap leaves room to grow before a cut. Past it, groups are cut
 * by priority and each cut says how many names it left out and which tool
 * lists them.
 */
export const WORKSPACE_CONTEXT_MAX_CHARS = 6_500;
const MAX_MODELS = 30;
/** Room kept for each later group's "N left out" line when a cut starts. */
const CUT_LINE_RESERVE = 90;

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
      appsMetadataRepo.listProjectsByWorkspace(workspaceId),
      userId
        ? workspaceService.getMember(workspaceId, userId)
        : Promise.resolve(null),
    ]);
    const stateById = new Map(
      docs.map(doc => [doc.id, toAppProjectCompat(doc)]),
    );
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
    /** Names the budget left out (0 when every name is listed). */
    leftOut: number;
  };
}

/** A registry entry without a status is a draft, as join-path.ts reads it. */
function statusOf(entry: RegistryEntry): string {
  return entry.status ?? "draft";
}

/**
 * One comma-separated list of names in the pack: a status group of terms or
 * entities, a metric type or the most-read models.
 */
interface NameGroup {
  /** "Governed terms": the line reads "Governed terms (52): a, b, c". */
  label: string;
  names: string[];
  /** The tool that lists every name of the group. */
  tool: string;
  /** Lower is kept first when the budget is short. */
  priority: number;
}

/**
 * A name as one list item: whitespace (a YAML block's newline included)
 * collapses to one space, and a name holding a comma or a quote is quoted,
 * so the comma-separated list never splits it or starts a new line.
 */
export function listItem(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return /[,"]/.test(clean) ? JSON.stringify(clean) : clean;
}

function groupLine(group: NameGroup, shown: number): string {
  const names = group.names.slice(0, shown).map(listItem).join(", ");
  const left = group.names.length - shown;
  if (left === 0) return `${group.label} (${group.names.length}): ${names}`;
  const listed = shown > 0 ? `${names} … ` : "";
  return `${group.label} (${group.names.length}): ${listed}${left} more: ${group.tool}`;
}

/** How many of the group's names fit in `budget` chars, line included. */
function namesThatFit(group: NameGroup, budget: number): number {
  // The full line drops the "… N more: tool" suffix, so it can be shorter
  // than a partial one: try it first.
  if (groupLine(group, group.names.length).length + 1 <= budget) {
    return group.names.length;
  }
  let shown = 0;
  while (
    shown < group.names.length &&
    groupLine(group, shown + 1).length + 1 <= budget
  ) {
    shown++;
  }
  return shown;
}

/**
 * The line of every group, in `budget` chars: all names when they fit,
 * else groups are filled by priority and the rest say what they left out.
 */
function fitGroups(
  groups: NameGroup[],
  budget: number,
  /** Chars the "N names did not fit" notice takes when a cut happens. */
  cutNoticeChars: number,
): { lines: Map<NameGroup, string>; leftOut: number } {
  const lines = new Map<NameGroup, string>();
  const full = groups.map(group => groupLine(group, group.names.length));
  const fullChars = full.reduce((sum, line) => sum + line.length + 1, 0);
  if (fullChars <= budget) {
    groups.forEach((group, i) => lines.set(group, full[i]));
    return { lines, leftOut: 0 };
  }
  let remaining = budget - cutNoticeChars;
  let leftOut = 0;
  const byPriority = [...groups].sort((a, b) => a.priority - b.priority);
  byPriority.forEach((group, i) => {
    const reserve = (byPriority.length - i - 1) * CUT_LINE_RESERVE;
    const shown = namesThatFit(group, remaining - reserve);
    const line = groupLine(group, shown);
    lines.set(group, line);
    remaining -= line.length + 1;
    leftOut += group.names.length - shown;
  });
  return { lines, leftOut };
}

function cutNotice(leftOut: number): string {
  return `${leftOut} names did not fit: each cut line names the tool that lists them.`;
}

const METRIC_TYPE_ORDER = ["simple", "ratio", "derived", "cumulative"];

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The pack's text, from loaded sources. Pure, for tests. */
export function renderWorkspaceContext(
  input: WorkspaceContextInput,
  options: { maxChars?: number } = {},
): WorkspaceContextPack {
  const { registry, apps } = input;
  const maxChars = options.maxChars ?? WORKSPACE_CONTEXT_MAX_CHARS;
  const semanticProjects = input.semanticProjects ?? [];
  const manifests = input.manifests ?? [];

  // Terms and entities: governed, then draft; entities before terms.
  const termGroups: NameGroup[] = [];
  const registryMessage = registryStatusMessage(registry);
  if (!registryMessage) {
    const statuses = [
      { status: "governed", priority: 0 },
      { status: "draft", priority: 3 },
    ];
    for (const { status, priority } of statuses) {
      for (const kind of ["entity", "term"] as const) {
        const names = [...registry.entities, ...registry.terms]
          .filter(entry => entry.kind === kind && statusOf(entry) === status)
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b));
        if (names.length === 0) continue;
        termGroups.push({
          label: `${capitalised(status)} ${kind === "entity" ? "entities" : "terms"}`,
          names,
          tool: "lookup_term",
          // Entities first within a status: they name the joins.
          priority: priority + (kind === "entity" ? 0 : 0.5),
        });
      }
    }
  }

  // Metrics, by type: a ratio or a derived metric is never summed.
  const metricsByType = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const project of semanticProjects) {
    for (const metric of project.catalog.metrics) {
      if (seen.has(metric.name)) continue;
      seen.add(metric.name);
      const type = metric.type ?? "other";
      const names = metricsByType.get(type) ?? [];
      names.push(metric.name);
      metricsByType.set(type, names);
    }
  }
  const metricGroups: NameGroup[] = [...metricsByType.entries()]
    .sort(
      ([a], [b]) =>
        (METRIC_TYPE_ORDER.indexOf(a) + 1 || 99) -
          (METRIC_TYPE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
    )
    .map(([type, names]) => ({
      label: capitalised(type),
      names: names.sort((a, b) => a.localeCompare(b)),
      tool: "list_metrics",
      priority: 1,
    }));

  // The models the most apps read.
  const modelRows: Array<{ name: string; readers: number }> = [];
  if (apps) {
    for (const project of manifests) {
      const counts = readerCountsByNode(project.index, apps);
      for (const node of project.index.nodes) {
        if (node.resourceType !== "model") continue;
        const readers = counts.get(node.id) ?? 0;
        if (readers > 0) modelRows.push({ name: node.name, readers });
      }
    }
  }
  modelRows.sort(
    (a, b) => b.readers - a.readers || a.name.localeCompare(b.name),
  );
  const topModels = modelRows.slice(0, MAX_MODELS);
  const modelGroups: NameGroup[] =
    input.manifests !== null &&
    manifests.length > 0 &&
    apps &&
    topModels.length > 0
      ? [
          {
            label: "Models",
            names: topModels.map(row => row.name),
            tool: "find_models",
            priority: 2,
          },
        ]
      : [];

  // Everything but the name lists, to know the room the lists get.
  const metricsMessage =
    input.semanticProjects === null
      ? "The metrics could not be read right now: use list_metrics."
      : metricGroups.length === 0
        ? "No metric is defined yet."
        : null;
  const termsMessage =
    registryMessage ??
    (termGroups.length === 0 ? "No governed or draft term." : null);
  const modelsMessage =
    input.manifests === null
      ? "The dbt manifest could not be read right now: use find_models."
      : manifests.length === 0
        ? "No dbt manifest is stored yet."
        : !apps
          ? "The apps index is unavailable: use find_models."
          : topModels.length === 0
            ? "No app reads a dbt model yet."
            : null;

  const render = (lines: Map<NameGroup, string>, leftOut: number) => {
    const section = (
      heading: string,
      message: string | null,
      groups: NameGroup[],
    ) => [
      "",
      heading,
      ...(message ? [message] : groups.map(group => lines.get(group) ?? "")),
    ];
    return [
      "# Workspace context",
      "Every name, no definitions: lookup_term, list_metrics and describe_model give them. A metric goes to query_metric (rows) or compile_metric (SQL).",
      ...(leftOut > 0 ? [cutNotice(leftOut)] : []),
      ...section("## Terms and entities", termsMessage, termGroups),
      ...section("## Metrics, by type", metricsMessage, metricGroups),
      ...section(
        "## dbt models the most apps read, most first",
        modelsMessage,
        modelGroups,
      ),
    ].join("\n");
  };

  const groups = [
    ...(termsMessage ? [] : termGroups),
    ...(metricsMessage ? [] : metricGroups),
    ...(modelsMessage ? [] : modelGroups),
  ];
  // The text around the lists; each empty group line already holds its "\n".
  const fixedChars = render(new Map(), 0).length - groups.length;
  const { lines, leftOut } = fitGroups(
    groups,
    Math.max(0, maxChars - fixedChars),
    cutNotice(9_999).length + 1,
  );

  return {
    text: render(lines, leftOut),
    counts: {
      terms: registry.terms.length,
      entities: registry.entities.length,
      metrics: seen.size,
      models: topModels.length,
      leftOut,
    },
  };
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
