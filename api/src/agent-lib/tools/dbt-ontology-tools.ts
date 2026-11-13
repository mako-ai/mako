/**
 * Ontology lookups for agents: "does a model for this already exist, what
 * does this term mean, who reads this model" — asked BEFORE writing SQL.
 *
 *   find_models     — search the last production manifest
 *   describe_model  — one model/source/seed in full
 *   lookup_term     — a business term or entity from the registry
 *   model_readers   — the apps and binding files that read a model or table
 *
 * All four read metadata only: the manifest the dbt runner already stores,
 * the registry file in the workspace repo (`dbt/ontology/terms.yml` on
 * main) and the apps index. None touches the warehouse. They are part of
 * `createDbtServerTools`, so the in-product agent and the MCP server get
 * them through the same capability registry as every other dbt tool.
 *
 * Results are compact by construction: long text is cut and marked, lists
 * are capped and say how many there were.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import {
  describeModelSchema,
  findJoinPathSchema,
  findModelsSchema,
  lookupTermSchema,
  modelReadersSchema,
} from "@mako/agent-tools";
import { AppProject } from "../../database/workspace-schema";
import { canSeeIndexedApp } from "../../apps/app-authorization";
import { loadAppsIndex } from "../../apps/app-index.service";
import { workspaceService } from "../../services/workspace.service";
import { loggers } from "../../logging";
import {
  capList,
  resolveNodes,
  searchNodes,
  truncateText,
  type IndexedNode,
  type ModelSearchHit,
} from "../../dbt/ontology/manifest-index";
import {
  loadManifestIndexes,
  type ProjectManifestIndex,
} from "../../dbt/ontology/manifest-index.service";
import {
  bindingReadsOf,
  readerCountsByNode,
  readersOfNode,
  readersOfRelation,
  type AppBindingReads,
  type ModelReader,
} from "../../dbt/ontology/model-readers";
import {
  ONTOLOGY_REGISTRY_PATH,
  matchRegistry,
  registryRolesByModel,
  registryStatusMessage,
  scoreRegistry,
  type ModelRegistryRoles,
  type OntologyRegistry,
  type RegistryEntity,
  type RegistryEntry,
} from "../../dbt/ontology/registry";
import { loadOntologyRegistry } from "../../dbt/ontology/registry.service";
import {
  findJoinPath,
  relationshipsOfEntity,
} from "../../dbt/ontology/join-path";

const logger = loggers.api("dbt-ontology-tools");

const DEFAULT_FIND_LIMIT = 10;
/** Characters of a description in a search hit / a full record. */
const HIT_DESCRIPTION_CHARS = 240;
const MODEL_DESCRIPTION_CHARS = 1500;
const COLUMN_DESCRIPTION_CHARS = 300;
const DEFINITION_CHARS = 1200;
const MAX_COLUMNS = 200;
const MAX_LINEAGE = 50;
const MAX_READERS = 50;
/** Readers listed inside describe_model; model_readers lists MAX_READERS. */
const MAX_DESCRIBE_READERS = 15;
const MAX_BINDINGS_PER_READER = 5;
const MAX_EXPOSURES = 10;
const MAX_META_CHARS = 1500;
const MAX_TERM_MATCHES = 5;
/** Relationships listed per entity; find_join_path walks them all. */
const MAX_ENTITY_RELATIONSHIPS = 12;
const NO_MANIFEST =
  "No dbt manifest is stored for this workspace yet: a dbt run has to finish first. Use read_dbt_project_tree and read_dbt_file to read the project's files.";

function toolError(error: unknown, fallback: string) {
  return {
    success: false as const,
    error: error instanceof Error ? error.message : fallback,
  };
}

function registryNote(registry: OntologyRegistry) {
  const message = registryStatusMessage(registry);
  return {
    ...(message ? { registry: { status: registry.status, message } } : {}),
    ...(registry.status === "ok" && registry.problems.length > 0
      ? {
          registry: {
            status: "ok" as const,
            problems: registry.problems.slice(0, 5),
          },
        }
      : {}),
  };
}

function manifestNote(project: ProjectManifestIndex) {
  return {
    project: project.projectName,
    projectId: project.projectId,
    source: project.source,
    ...(project.index.generatedAt
      ? { generatedAt: project.index.generatedAt }
      : {}),
    ...(project.source === "latest-run"
      ? {
          note: "No production build yet: this is the project's latest run, which may be a dev build.",
        }
      : {}),
  };
}

function rolesOf(
  roles: Map<string, ModelRegistryRoles>,
  node: IndexedNode,
): ModelRegistryRoles | undefined {
  // The registry names models; a source is named `<source>.<table>` there
  // only when the registry says so.
  return roles.get(node.name.toLowerCase());
}

function variantWarnings(roles: ModelRegistryRoles | undefined): string[] {
  return (roles?.variantOf ?? []).map(variant => {
    const canonical = variant.canonicalModel
      ? ` The canonical model is \`${variant.canonicalModel}\`${
          variant.canonicalColumn
            ? ` (column \`${variant.canonicalColumn}\`)`
            : ""
        }: read that one unless the difference is what you need.`
      : "";
    const difference = variant.difference
      ? ` Difference: ${truncateText(variant.difference, 300)}`
      : "";
    return `This model is a known variant of the ${variant.kind ?? "term"} \`${variant.term}\`.${canonical}${difference}`;
  });
}

function compactMeta(meta: Record<string, unknown>) {
  if (Object.keys(meta).length === 0) return {};
  const json = JSON.stringify(meta);
  if (json.length <= MAX_META_CHARS) return { meta };
  return {
    metaKeys: Object.keys(meta).slice(0, 40),
    metaTruncated: true,
  };
}

function readerSummary(reader: ModelReader) {
  // One app can read a model from dozens of bindings: name the first few
  // and count the rest, so 40 readers stay a few kilobytes.
  const bindings = capList(reader.bindings, MAX_BINDINGS_PER_READER);
  return {
    app: reader.appId,
    title: reader.title,
    path: reader.path,
    bindings: bindings.items,
    ...(bindings.truncated ? { bindingCount: bindings.total } : {}),
  };
}

/** How an entity joins and what identifies it elsewhere. */
function entityGraph(entity: RegistryEntity, registry: OntologyRegistry) {
  const relationships = capList(
    relationshipsOfEntity(registry, entity.name),
    MAX_ENTITY_RELATIONSHIPS,
  );
  return {
    ...(entity.identities.length
      ? { identities: entity.identities.slice(0, 12) }
      : {}),
    ...(relationships.total
      ? {
          relationships: relationships.items,
          ...(relationships.truncated
            ? { relationshipsTotal: relationships.total }
            : {}),
        }
      : {}),
  };
}

function entrySummary(entry: RegistryEntry, registry: OntologyRegistry) {
  const common = {
    kind: entry.kind,
    name: entry.name,
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.definition
      ? { definition: truncateText(entry.definition, DEFINITION_CHARS) }
      : {}),
    ...(entry.owner ? { owner: entry.owner } : {}),
    ...(entry.synonyms.length ? { synonyms: entry.synonyms.slice(0, 20) } : {}),
  };
  if (entry.kind === "entity") {
    return {
      ...common,
      ...(entry.canonical
        ? {
            canonical: {
              model: entry.canonical.model,
              ...(entry.canonical.primaryKey
                ? { primaryKey: entry.canonical.primaryKey }
                : {}),
            },
          }
        : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.grain ? { grain: entry.grain } : {}),
      ...(entry.sources.length ? { sources: entry.sources.slice(0, 20) } : {}),
      ...entityGraph(entry, registry),
      ...(entry.knownVariants.length
        ? {
            knownVariants: entry.knownVariants.slice(0, 20).map(variant => ({
              model: variant.model,
              ...(variant.difference
                ? { difference: truncateText(variant.difference, 300) }
                : {}),
            })),
          }
        : {}),
      ...(entry.openPoint
        ? { openPoint: truncateText(entry.openPoint, 400) }
        : {}),
    };
  }
  const variants = capList(entry.knownVariants, 20);
  const patterns = capList(entry.forbiddenPatterns, 10);
  return {
    ...common,
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.canonical
      ? {
          canonical: {
            model: entry.canonical.model,
            ...(entry.canonical.column
              ? { column: entry.canonical.column }
              : {}),
          },
        }
      : {}),
    ...(entry.grain ? { grain: entry.grain } : {}),
    ...(variants.total
      ? {
          knownVariants: variants.items.map(variant => ({
            model: variant.model,
            ...(variant.difference
              ? { difference: truncateText(variant.difference, 300) }
              : {}),
          })),
          ...(variants.truncated ? { knownVariantsTotal: variants.total } : {}),
        }
      : {}),
    ...(patterns.total
      ? {
          forbiddenPatterns: patterns.items.map(pattern => ({
            regex: pattern.regex,
            ...(pattern.message
              ? { message: truncateText(pattern.message, 300) }
              : {}),
            ...(pattern.paths ? { paths: pattern.paths.slice(0, 10) } : {}),
          })),
          ...(patterns.truncated
            ? { forbiddenPatternsTotal: patterns.total }
            : {}),
        }
      : {}),
  };
}

export const createDbtOntologyTools = (
  workspaceId: string,
  userId?: string,
) => {
  /**
   * The bindings of the apps this actor may see — the same rule as
   * search_apps (apps-tools.ts `visibleApps`), so a private app's existence
   * never leaks through a reader count. Null when the index cannot be read:
   * readers are then reported as unknown, not as zero.
   */
  const visibleAppReads = async (): Promise<AppBindingReads[] | null> => {
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
  };

  const describeNode = (
    project: ProjectManifestIndex,
    node: IndexedNode,
    registry: OntologyRegistry,
    apps: AppBindingReads[] | null,
    manyProjects: boolean,
  ) => {
    const roles = rolesOf(registryRolesByModel(registry), node);
    const columns = capList(node.columns, MAX_COLUMNS);
    const upstream = capList(node.parents, MAX_LINEAGE);
    const downstream = capList(node.children, MAX_LINEAGE);
    const readers = apps
      ? capList(readersOfNode(apps, node), MAX_DESCRIBE_READERS)
      : null;
    const exposures = capList(node.exposures, MAX_EXPOSURES);
    const warnings = variantWarnings(roles);
    const modelName = node.name.toLowerCase();
    // The entities this model is the canonical relation of, with how each
    // joins, and the identities this model resolves for other entities.
    const canonicalEntities = registry.entities.filter(
      entity => entity.canonical?.model.toLowerCase() === modelName,
    );
    const resolverFor = registry.entities.flatMap(entity =>
      entity.identities
        .filter(identity => identity.resolver?.toLowerCase() === modelName)
        .map(identity => ({
          entity: entity.name,
          system: identity.system,
          column: identity.column,
        })),
    );
    return {
      name: node.name,
      resourceType: node.resourceType,
      uniqueId: node.id,
      ...(manyProjects ? { project: project.projectName } : {}),
      layer: node.layer,
      ...(node.path ? { path: node.path } : {}),
      ...(node.description
        ? {
            description: truncateText(
              node.description,
              MODEL_DESCRIPTION_CHARS,
            ),
          }
        : {}),
      ...(node.grain ? { grain: node.grain } : {}),
      ...(node.materialized ? { materialized: node.materialized } : {}),
      ...(node.relationName ? { relation: node.relationName } : {}),
      ...(node.access ? { access: node.access } : {}),
      ...(node.group ? { group: node.group } : {}),
      ...(node.contractEnforced !== undefined
        ? { contract: { enforced: node.contractEnforced } }
        : {}),
      ...(node.tags.length ? { tags: node.tags } : {}),
      ...compactMeta(node.meta),
      columns: columns.items.map(column => ({
        name: column.name,
        ...(column.type ? { type: column.type } : {}),
        ...(column.description
          ? {
              description: truncateText(
                column.description,
                COLUMN_DESCRIPTION_CHARS,
              ),
            }
          : {}),
        ...(column.tests.length ? { tests: column.tests } : {}),
      })),
      columnCount: columns.total,
      ...(columns.truncated ? { columnsTruncated: true } : {}),
      columnTypesFrom: project.index.hasCatalog ? "catalog" : "manifest",
      ...(node.tests.length ? { tests: node.tests } : {}),
      upstream: upstream.items,
      ...(upstream.truncated ? { upstreamTotal: upstream.total } : {}),
      downstream: downstream.items,
      ...(downstream.truncated ? { downstreamTotal: downstream.total } : {}),
      ...(exposures.total
        ? {
            exposures: exposures.items,
            ...(exposures.truncated ? { exposuresTotal: exposures.total } : {}),
          }
        : {}),
      readers: readers
        ? {
            apps: readers.total,
            items: readers.items.map(readerSummary),
            ...(readers.truncated
              ? {
                  truncated: true,
                  note: "model_readers lists every reading app.",
                }
              : {}),
          }
        : { unavailable: true },
      ...(roles?.canonicalFor.length
        ? { canonicalFor: roles.canonicalFor }
        : {}),
      ...(roles?.variantOf.length ? { variantOf: roles.variantOf } : {}),
      ...(canonicalEntities.length
        ? {
            entities: canonicalEntities.map(entity => ({
              name: entity.name,
              ...(entity.status ? { status: entity.status } : {}),
              ...(entity.canonical?.primaryKey
                ? { primaryKey: entity.canonical.primaryKey }
                : {}),
              ...entityGraph(entity, registry),
            })),
          }
        : {}),
      ...(resolverFor.length ? { identityResolverFor: resolverFor } : {}),
      ...(warnings.length ? { warnings } : {}),
      manifest: manifestNote(project),
    };
  };

  return {
    find_models: tool({
      description:
        "Search the dbt models, sources and seeds of the last production build by name, description, column names and descriptions, tags, meta and the term registry's synonyms. Call this BEFORE writing a new dbt model or a binding that aggregates a business metric: when a model already answers the question, read or extend it instead of deriving the number again. Each hit has its layer, grain (when stated), relation name, column count, how many apps read it and the registry term or entity it is canonical for. Canonical models rank first. Follow up with describe_model.",
      inputSchema: findModelsSchema,
      execute: async ({ query, layer, limit, projectId }) => {
        try {
          const [projects, registry, apps] = await Promise.all([
            loadManifestIndexes(workspaceId, { projectId }),
            loadOntologyRegistry(workspaceId),
            visibleAppReads(),
          ]);
          if (projects.length === 0) {
            return {
              success: true as const,
              results: [],
              total: 0,
              message: NO_MANIFEST,
              ...registryNote(registry),
            };
          }
          const roles = registryRolesByModel(registry);
          const termMatches = matchRegistry(registry, query);
          const matchedModels = new Set(
            termMatches
              .map(match => match.entry.canonical?.model.toLowerCase())
              .filter((model): model is string => !!model),
          );
          // A model answers to the names of the terms it is canonical for.
          const wordsByModel = new Map<string, string>();
          for (const entry of [...registry.terms, ...registry.entities]) {
            if (!entry.canonical) continue;
            const key = entry.canonical.model.toLowerCase();
            wordsByModel.set(
              key,
              [
                wordsByModel.get(key) ?? "",
                entry.name,
                entry.label ?? "",
                ...entry.synonyms,
              ].join(" "),
            );
          }
          const manyProjects = projects.length > 1;
          const ranked: Array<{
            project: ProjectManifestIndex;
            hit: ModelSearchHit;
            canonical: boolean;
            readers: number | undefined;
          }> = [];
          for (const project of projects) {
            const counts = apps
              ? readerCountsByNode(project.index, apps)
              : undefined;
            const hits = searchNodes(project.index, query, {
              layer,
              extraWords: node =>
                wordsByModel.get(node.name.toLowerCase()) ?? "",
            });
            const found = new Set(hits.map(hit => hit.node.id));
            // A term the query names loosely (a typo, a plural) still puts
            // its canonical model in the results.
            if (!layer) {
              for (const node of project.index.nodes) {
                if (
                  !found.has(node.id) &&
                  matchedModels.has(node.name.toLowerCase())
                ) {
                  hits.push({ node, score: 0, matchedOn: ["registry"] });
                }
              }
            }
            for (const hit of hits) {
              const isCanonical =
                (rolesOf(roles, hit.node)?.canonicalFor.length ?? 0) > 0 &&
                (matchedModels.has(hit.node.name.toLowerCase()) ||
                  hit.matchedOn.includes("registry"));
              ranked.push({
                project,
                hit,
                canonical: isCanonical,
                readers: counts ? (counts.get(hit.node.id) ?? 0) : undefined,
              });
            }
          }
          ranked.sort(
            (a, b) =>
              Number(b.canonical) - Number(a.canonical) ||
              b.hit.score - a.hit.score ||
              (b.readers ?? 0) - (a.readers ?? 0) ||
              a.hit.node.name.localeCompare(b.hit.node.name),
          );
          const max = limit ?? DEFAULT_FIND_LIMIT;
          const page = ranked.slice(0, max);
          return {
            success: true as const,
            results: page.map(({ project, hit, readers }) => {
              const node = hit.node;
              const nodeRoles = rolesOf(roles, node);
              return {
                name: node.name,
                resourceType: node.resourceType,
                ...(manyProjects ? { project: project.projectName } : {}),
                layer: node.layer,
                ...(node.path ? { path: node.path } : {}),
                ...(node.description
                  ? {
                      description: truncateText(
                        node.description,
                        HIT_DESCRIPTION_CHARS,
                      ),
                    }
                  : {}),
                ...(node.grain ? { grain: node.grain } : {}),
                ...(node.access ? { access: node.access } : {}),
                ...(node.group ? { group: node.group } : {}),
                ...(node.materialized
                  ? { materialized: node.materialized }
                  : {}),
                ...(node.relationName ? { relation: node.relationName } : {}),
                columnCount: node.columns.length,
                matchedOn: hit.matchedOn,
                ...(readers !== undefined ? { readerApps: readers } : {}),
                ...(nodeRoles?.canonicalFor.length
                  ? { canonicalFor: nodeRoles.canonicalFor }
                  : {}),
                ...(nodeRoles?.variantOf.length
                  ? {
                      variantOf: nodeRoles.variantOf.map(variant => ({
                        term: variant.term,
                        ...(variant.canonicalModel
                          ? { canonicalModel: variant.canonicalModel }
                          : {}),
                      })),
                    }
                  : {}),
              };
            }),
            total: ranked.length,
            ...(ranked.length > page.length
              ? {
                  truncated: true,
                  note: `Showing ${page.length} of ${ranked.length} matches. Narrow the query or pass \`layer\`.`,
                }
              : {}),
            ...(termMatches.length
              ? {
                  matchedTerms: termMatches
                    .slice(0, MAX_TERM_MATCHES)
                    .map(match => ({
                      kind: match.entry.kind,
                      name: match.entry.name,
                      ...(match.entry.canonical
                        ? { canonicalModel: match.entry.canonical.model }
                        : {}),
                    })),
                }
              : {}),
            manifests: projects.map(manifestNote),
            ...(apps === null
              ? { readersNote: "App readers are unavailable right now." }
              : {}),
            ...registryNote(registry),
          };
        } catch (error) {
          logger.error("find_models failed", { error });
          return toolError(error, "Failed to search dbt models");
        }
      },
    }),

    describe_model: tool({
      description:
        "Everything the last production build knows about one dbt model, source or seed: description, columns with descriptions, types and tests, meta, tags, group, access, contract, upstream and downstream models, exposures, the apps and binding files that read it, and the registry terms or entities it is canonical for, with each entity's identities and relationships. `warnings` says when the model is a known variant of a term and names the canonical model to read instead. Accepts a model name, `<source>.<table>` or a warehouse relation.",
      inputSchema: describeModelSchema,
      execute: async ({ name, projectId }) => {
        try {
          const [projects, registry, apps] = await Promise.all([
            loadManifestIndexes(workspaceId, { projectId }),
            loadOntologyRegistry(workspaceId),
            visibleAppReads(),
          ]);
          if (projects.length === 0) {
            return {
              success: false as const,
              error: NO_MANIFEST,
              ...registryNote(registry),
            };
          }
          const found = projects.flatMap(project =>
            resolveNodes(project.index, name).map(node => ({ project, node })),
          );
          const manyProjects = projects.length > 1;
          if (found.length === 0) {
            const suggestions = projects
              .flatMap(project => searchNodes(project.index, name))
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map(hit => hit.node.name);
            return {
              success: false as const,
              error: `No dbt model, source or seed named "${name}" in the last build.`,
              ...(suggestions.length ? { suggestions } : {}),
              hint: "Use find_models to search by meaning, or inspect_table for a table dbt does not build.",
            };
          }
          if (found.length > 1) {
            return {
              success: true as const,
              ambiguous: true,
              message: `"${name}" matches ${found.length} nodes. Call describe_model again with one exact name.`,
              matches: found.slice(0, 10).map(({ project, node }) => ({
                name: node.name,
                resourceType: node.resourceType,
                ...(manyProjects ? { project: project.projectName } : {}),
                ...(node.relationName ? { relation: node.relationName } : {}),
              })),
            };
          }
          const [{ project, node }] = found;
          return {
            success: true as const,
            ...describeNode(project, node, registry, apps, manyProjects),
            ...registryNote(registry),
          };
        } catch (error) {
          logger.error("describe_model failed", { error });
          return toolError(error, "Failed to describe dbt model");
        }
      },
    }),

    lookup_term: tool({
      description: `Resolve a business term or entity ("MRR", "paying customers", "account") from the workspace's ontology registry (${ONTOLOGY_REGISTRY_PATH}), by name, label or synonym. Returns the definition, owner, status, the canonical model and column, the grain, known variants and forbidden patterns; for an entity also its primary key, its identities in other systems and its relationships to other entities. Call this BEFORE writing SQL that computes a business metric: when a canonical model exists, read it. With no match it returns the closest registry names and points to find_models.`,
      inputSchema: lookupTermSchema,
      execute: async ({ query }) => {
        try {
          const registry = await loadOntologyRegistry(workspaceId);
          const matches = matchRegistry(registry, query).slice(
            0,
            MAX_TERM_MATCHES,
          );
          if (matches.length > 0) {
            return {
              success: true as const,
              matches: matches.map(match => ({
                ...entrySummary(match.entry, registry),
                matchedOn: match.matchedOn,
                score: Math.round(match.score * 100) / 100,
              })),
              next: "describe_model({ name: <canonical model> }) lists its columns, tests and readers.",
              ...registryNote(registry),
            };
          }
          const scored = scoreRegistry(registry, query).map(m => m.entry.name);
          const rest = [...registry.terms, ...registry.entities]
            .map(entry => entry.name)
            .filter(entryName => !scored.includes(entryName))
            .sort();
          const closest = [...new Set([...scored, ...rest])].slice(0, 5);
          return {
            success: true as const,
            matches: [],
            closest,
            suggestion: `No registry term or entity matches "${query}". Call find_models({ query: "${query}" }) to search models by name, description and columns.`,
            ...registryNote(registry),
          };
        } catch (error) {
          logger.error("lookup_term failed", { error });
          return toolError(error, "Failed to look up the term");
        }
      },
    }),

    model_readers: tool({
      description:
        "The apps and binding files that read a dbt model, seed or source, or a raw warehouse table. Reads are the FROM/JOIN references of app bindings on main, matched to dbt nodes through their warehouse relation: `{{ dbt_schema }}.model`, `project.dataset.table` and `dataset.table` all resolve. Call this before changing or removing a model's columns. Only apps the caller can see are listed; dbt models that depend on the model are in describe_model's `downstream`.",
      inputSchema: modelReadersSchema,
      execute: async ({ name, projectId }) => {
        try {
          const [projects, apps] = await Promise.all([
            loadManifestIndexes(workspaceId, { projectId }),
            visibleAppReads(),
          ]);
          if (apps === null) {
            return {
              success: false as const,
              error:
                "The apps index is unavailable right now, so readers are unknown. Try again.",
            };
          }
          const found = projects.flatMap(project =>
            resolveNodes(project.index, name).map(node => ({ project, node })),
          );
          const manyProjects = projects.length > 1;
          const summarize = (readers: ModelReader[]) => {
            const capped = capList(readers, MAX_READERS);
            return {
              apps: capped.total,
              bindings: readers.reduce((n, r) => n + r.bindings.length, 0),
              readers: capped.items.map(readerSummary),
              ...(capped.truncated ? { truncated: true } : {}),
            };
          };
          if (found.length === 0) {
            const readers = readersOfRelation(apps, name);
            const bare = !name.includes(".");
            return {
              success: true as const,
              name,
              resolvedAs: { kind: "table" as const, relation: name },
              ...summarize(readers),
              // Not "nothing reads it": the stored build does not hold the
              // name, so only what the bindings themselves say is known.
              note:
                `"${name}" is not a dbt node in the last stored build${
                  projects.length === 0
                    ? " (no dbt manifest could be read)"
                    : ""
                }. Readers are bindings that name it as \`{{ dbt_schema }}.${
                  name.split(".").pop() ?? name
                }\`` +
                (bare
                  ? '. For a raw table pass "dataset.table".'
                  : " or as this table.") +
                (readers.length === 0
                  ? " None found: for a model newer than the last build, readers that name its full relation are missed."
                  : ""),
            };
          }
          const nodes = capList(found, 5);
          const results = nodes.items.map(({ project, node }) => ({
            name: node.name,
            resolvedAs: {
              kind: "dbt" as const,
              resourceType: node.resourceType,
              ...(manyProjects ? { project: project.projectName } : {}),
              ...(node.relationName ? { relation: node.relationName } : {}),
            },
            ...summarize(readersOfNode(apps, node)),
            ...(node.children.length
              ? { downstreamModels: node.children.length }
              : {}),
          }));
          if (results.length === 1) {
            return { success: true as const, ...results[0] };
          }
          return {
            success: true as const,
            ambiguous: true,
            message: `"${name}" matches ${nodes.total} nodes; readers are listed for each.`,
            results,
          };
        } catch (error) {
          logger.error("model_readers failed", { error });
          return toolError(error, "Failed to list model readers");
        }
      },
    }),

    find_join_path: tool({
      description: `How two entities join: the shortest declared path between them in the ontology registry (${ONTOLOGY_REGISTRY_PATH}). \`from\` and \`to\` are entity names or synonyms, dbt models or raw tables. Each hop gives the two canonical models (or raw tables), the join columns, the join condition, the cardinality in the direction of the hop, the status and a fan-out warning when the hop multiplies rows. Governed relationships are preferred over draft ones, entity relationships over raw-table foreign keys. Call this BEFORE writing a join between two entities, and join on the columns it returns. With no path it says so and lists what each end joins to directly.`,
      inputSchema: findJoinPathSchema,
      execute: async ({ from, to, maxHops }) => {
        try {
          const [registry, projects] = await Promise.all([
            loadOntologyRegistry(workspaceId),
            loadManifestIndexes(workspaceId),
          ]);
          // A warehouse relation names its dbt model through the manifest.
          const modelNameOf = (text: string) => {
            for (const project of projects) {
              const nodes = resolveNodes(project.index, text);
              if (nodes.length === 1) return nodes[0].name;
            }
            return undefined;
          };
          const result = findJoinPath(registry, from, to, {
            maxHops,
            modelNameOf,
          });
          return {
            success: true as const,
            ...result,
            ...registryNote(registry),
          };
        } catch (error) {
          logger.error("find_join_path failed", { error });
          return toolError(error, "Failed to find a join path");
        }
      },
    }),
  };
};
