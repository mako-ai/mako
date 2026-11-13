/**
 * How two entities join: the shortest declared path between them in the
 * ontology registry, hop by hop, with the columns and the cardinality of
 * each hop. Pure: no I/O.
 *
 * Two graphs, searched in this order:
 *
 * 1. Entities and the `relationships` the registry declares between their
 *    canonical models. Governed relationships are tried alone first; a
 *    draft one is used only when it is the sole way, or a shorter one.
 * 2. Raw tables and the foreign keys of the generated file
 *    (`generated/crm_relationships.yml`), when an end is a raw table or no
 *    entity path exists.
 *
 * A hop that goes from the "one" side to the "many" side multiplies rows.
 * It is reported with a fan-out warning, never hidden.
 */
import {
  RAW_RELATIONSHIPS_SCHEMA,
  phraseSimilarity,
  phraseWords,
  REGISTRY_MATCH_THRESHOLD,
  type JoinColumnPair,
  type OntologyRegistry,
  type RawRelationship,
  type RegistryEntity,
  type RegistryRelationship,
  type RelationshipCardinality,
} from "./registry";

export const DEFAULT_MAX_HOPS = 4;
export const MAX_MAX_HOPS = 6;
/** Paths returned at most; the result says how many there were. */
export const MAX_PATHS = 3;
/** Shortest sequences ranked before the best `MAX_PATHS` are kept. */
const MAX_RANKED_SEQUENCES = 60;
const MAX_NEAREST = 8;

// ---------------------------------------------------------------------------
// Ends
// ---------------------------------------------------------------------------

export type JoinEndpoint =
  | {
      kind: "entity";
      entity: RegistryEntity;
      /** How the text named it. */
      matchedOn: "name" | "label" | "synonym" | "model";
    }
  | { kind: "table"; table: string }
  | { kind: "unknown"; closest: string[] };

function cleanName(text: string): string {
  return text.replace(/[`"[\]\s]/g, "").toLowerCase();
}

function qualifyTable(text: string): string {
  const clean = cleanName(text);
  return clean.includes(".") ? clean : `${RAW_RELATIONSHIPS_SCHEMA}.${clean}`;
}

function sameWords(a: string, b: string): boolean {
  return phraseWords(a).join(" ") === phraseWords(b).join(" ");
}

/**
 * What a `from` / `to` text names: an entity (by name or canonical model,
 * then, for a bare word, by label or synonym), else a raw table of the
 * generated file, else nothing, with the closest entity names. `modelNameOf` maps a warehouse relation to
 * its dbt model name when a manifest is at hand.
 */
export function resolveJoinEndpoint(
  registry: OntologyRegistry,
  text: string,
  modelNameOf?: (text: string) => string | undefined,
): JoinEndpoint {
  const byName = registry.entities.find(entity => sameWords(entity.name, text));
  if (byName) return { kind: "entity", entity: byName, matchedOn: "name" };

  const models = new Set(
    [cleanName(text), modelNameOf?.(text)?.toLowerCase()].filter(
      (name): name is string => !!name,
    ),
  );
  const byModel = registry.entities.find(
    entity =>
      entity.canonical && models.has(entity.canonical.model.toLowerCase()),
  );
  if (byModel) return { kind: "entity", entity: byModel, matchedOn: "model" };

  const table = qualifyTable(text);
  const isRawTable = registry.rawRelationships.some(
    relationship =>
      relationship.fromTable === table || relationship.toTable === table,
  );
  // A qualified name (`crm_public.users`) is a relation, never a phrase:
  // it is that raw table or nothing. Only a bare word is tried as a label
  // or a synonym.
  if (text.includes(".")) {
    return isRawTable
      ? { kind: "table", table }
      : { kind: "unknown", closest: closestEntities(registry, text) };
  }

  let best:
    | { entity: RegistryEntity; score: number; matchedOn: "label" | "synonym" }
    | undefined;
  for (const entity of registry.entities) {
    const names = [
      ...(entity.label
        ? [{ matchedOn: "label" as const, text: entity.label }]
        : []),
      ...entity.synonyms.map(synonym => ({
        matchedOn: "synonym" as const,
        text: synonym,
      })),
    ];
    for (const candidate of names) {
      const score = phraseSimilarity(text, candidate.text);
      if (!best || score > best.score) {
        best = { entity, score, matchedOn: candidate.matchedOn };
      }
    }
  }
  if (best && best.score >= REGISTRY_MATCH_THRESHOLD) {
    return { kind: "entity", entity: best.entity, matchedOn: best.matchedOn };
  }

  if (isRawTable) return { kind: "table", table };

  return { kind: "unknown", closest: closestEntities(registry, text) };
}

/** The entity names closest to a text, best first. */
export function closestEntities(
  registry: OntologyRegistry,
  text: string,
  max = 5,
): string[] {
  return registry.entities
    .map(entity => ({
      name: entity.name,
      score: Math.max(
        phraseSimilarity(text, entity.name),
        ...(entity.label ? [phraseSimilarity(text, entity.label)] : []),
        ...entity.synonyms.map(synonym => phraseSimilarity(text, synonym)),
        ...(entity.canonical
          ? [phraseSimilarity(text, entity.canonical.model)]
          : []),
      ),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map(entry => entry.name);
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/** One way across between two nodes, as declared (`a` holds the foreign key). */
interface Edge {
  name?: string;
  a: string;
  b: string;
  /** Cardinality read from `a` to `b`. */
  cardinality: RelationshipCardinality;
  join: JoinColumnPair[];
  /** `governed` / `draft` for an entity edge, `raw` for a foreign key. */
  status: string;
  source?: string;
  preferred: boolean;
  notes: string[];
}

function invert(cardinality: RelationshipCardinality): RelationshipCardinality {
  if (cardinality === "many_to_one") return "one_to_many";
  if (cardinality === "one_to_many") return "many_to_one";
  return cardinality;
}

function entityEdges(registry: OntologyRegistry): Edge[] {
  return registry.relationships.map((relationship: RegistryRelationship) => {
    const governed = relationship.status?.toLowerCase() === "governed";
    return {
      name: relationship.name,
      a: relationship.from.toLowerCase(),
      b: relationship.to.toLowerCase(),
      cardinality: relationship.cardinality,
      join: relationship.join,
      status: relationship.status ?? "draft",
      ...(relationship.source ? { source: relationship.source } : {}),
      preferred: governed,
      notes: relationship.openPoint
        ? [`Open point: ${relationship.openPoint}`]
        : [],
    };
  });
}

function rawEdges(registry: OntologyRegistry): Edge[] {
  // The generated file lists a foreign key from both tables (an object and
  // an array relationship): keep one edge per key, the one written from the
  // table that holds the key.
  const byKey = new Map<string, Edge>();
  for (const raw of registry.rawRelationships as RawRelationship[]) {
    const forward = `${raw.fromTable}(${raw.fromColumns.join(",")})`;
    const backward = `${raw.toTable}(${raw.toColumns.join(",")})`;
    const key = [forward, backward].sort().join("=");
    const known = byKey.get(key);
    if (
      known &&
      !(
        known.cardinality === "one_to_many" && raw.cardinality === "many_to_one"
      )
    ) {
      continue;
    }
    byKey.set(key, {
      ...(raw.name ? { name: raw.name } : {}),
      a: raw.fromTable,
      b: raw.toTable,
      cardinality: raw.cardinality,
      join: raw.fromColumns.map((fromColumn, i) => ({
        fromColumn,
        toColumn: raw.toColumns[i],
      })),
      status: "raw",
      ...(raw.kind ? { source: raw.kind } : {}),
      preferred: raw.inWarehouse !== false,
      notes: [
        ...(raw.inWarehouse === false
          ? ["The warehouse does not hold both tables."]
          : []),
        ...(raw.inferred
          ? [
              "The referenced columns are inferred from the primary key, not read from a constraint.",
            ]
          : []),
      ],
    });
  }
  return [...byKey.values()];
}

type Adjacency = Map<string, Map<string, Edge[]>>;

function adjacencyOf(edges: Edge[], allow: (edge: Edge) => boolean): Adjacency {
  const adjacency: Adjacency = new Map();
  const link = (from: string, to: string, edge: Edge) => {
    let neighbours = adjacency.get(from);
    if (!neighbours) adjacency.set(from, (neighbours = new Map()));
    const list = neighbours.get(to);
    if (list) list.push(edge);
    else neighbours.set(to, [edge]);
  };
  for (const edge of edges) {
    if (!allow(edge)) continue;
    link(edge.a, edge.b, edge);
    if (edge.a !== edge.b) link(edge.b, edge.a, edge);
  }
  return adjacency;
}

/**
 * Every shortest node sequence from `from` to `to`, at most `maxHops` long
 * (breadth first, so a cycle is never walked twice). `total` counts them
 * all; `sequences` holds the first `MAX_RANKED_SEQUENCES`.
 */
function shortestSequences(
  adjacency: Adjacency,
  from: string,
  to: string,
  maxHops: number,
): { sequences: string[][]; total: number; hops: number } | null {
  if (from === to) {
    // The same node: a relationship of an entity with itself, one hop.
    return adjacency.get(from)?.has(from)
      ? { sequences: [[from, from]], total: 1, hops: 1 }
      : null;
  }
  const distance = new Map<string, number>([[from, 0]]);
  const parents = new Map<string, string[]>();
  let frontier = [from];
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node)?.keys() ?? []) {
        if (neighbour === node) continue;
        const known = distance.get(neighbour);
        if (known === undefined) {
          distance.set(neighbour, hop);
          parents.set(neighbour, [node]);
          next.push(neighbour);
        } else if (known === hop) {
          parents.get(neighbour)?.push(node);
        }
      }
    }
    if (distance.has(to)) break;
    frontier = next;
  }
  const hops = distance.get(to);
  if (hops === undefined) return null;
  const sequences: string[][] = [];
  let total = 0;
  const walk = (node: string, tail: string[]) => {
    if (node === from) {
      total++;
      if (sequences.length < MAX_RANKED_SEQUENCES) {
        sequences.push([from, ...tail]);
      }
      return;
    }
    for (const parent of [...(parents.get(node) ?? [])].sort()) {
      walk(parent, [node, ...tail]);
    }
  };
  walk(to, []);
  return { sequences, total, hops };
}

/** Hops between two nodes with no limit, to say "raise maxHops". */
function unboundedHops(
  adjacency: Adjacency,
  from: string,
  to: string,
): number | null {
  return (
    shortestSequences(adjacency, from, to, Number.MAX_SAFE_INTEGER)?.hops ??
    null
  );
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface JoinSide {
  /** The entity, on an entity-level hop. */
  entity?: string;
  /** Its canonical model, or the raw table. */
  model: string;
}

export interface JoinHop {
  relationship?: string;
  from: JoinSide;
  to: JoinSide;
  /** Column pairs in the direction of the hop. */
  join: JoinColumnPair[];
  /** The join condition, written out. */
  on: string;
  /** Read in the direction of the hop: `from` rows to `to` rows. */
  cardinality: RelationshipCardinality;
  /** `governed`, `draft`, or `raw` for a foreign key between raw tables. */
  status: string;
  source?: string;
  /** Set when the hop multiplies the rows of `from`. */
  fanOut?: string;
  notes?: string[];
  /** Other declared ways across the same two nodes. */
  alternatives?: Array<{
    relationship?: string;
    join: JoinColumnPair[];
    status: string;
  }>;
}

export interface JoinPath {
  hops: number;
  /** True when every hop is a governed relationship. */
  governed: boolean;
  /** True when a hop multiplies rows. */
  fanOut: boolean;
  steps: JoinHop[];
}

export interface JoinEndSummary {
  input: string;
  kind: "entity" | "table" | "unknown";
  entity?: string;
  model?: string;
  primaryKey?: string | string[];
  status?: string;
  matchedOn?: string;
  table?: string;
  /** For a raw table: the entities built from it. */
  entities?: string[];
  closest?: string[];
}

export interface JoinPathResult {
  from: JoinEndSummary;
  to: JoinEndSummary;
  /** Which graph answered. */
  level: "entity" | "raw" | "none";
  paths: JoinPath[];
  /** Shortest paths found, when more than the ones listed. */
  pathsTotal?: number;
  message?: string;
  /** With no path: what each end does join to, directly. */
  nearest?: { from: string[]; to: string[] };
}

function summarize(
  registry: OntologyRegistry,
  input: string,
  end: JoinEndpoint,
): JoinEndSummary {
  if (end.kind === "entity") {
    const { entity } = end;
    return {
      input,
      kind: "entity",
      entity: entity.name,
      ...(entity.canonical
        ? {
            model: entity.canonical.model,
            ...(entity.canonical.primaryKey
              ? { primaryKey: entity.canonical.primaryKey }
              : {}),
          }
        : {}),
      ...(entity.status ? { status: entity.status } : {}),
      matchedOn: end.matchedOn,
    };
  }
  if (end.kind === "table") {
    // The entities built from this table join on their canonical models.
    const builtFrom = registry.entities
      .filter(entity =>
        [entity.canonical?.model ?? "", ...entity.sources]
          .map(cleanName)
          .includes(end.table),
      )
      .map(entity => entity.name);
    return {
      input,
      kind: "table",
      table: end.table,
      ...(builtFrom.length ? { entities: builtFrom } : {}),
    };
  }
  return { input, kind: "unknown", closest: end.closest };
}

function fanOutWarning(
  cardinality: RelationshipCardinality,
  from: string,
  to: string,
): string | undefined {
  if (cardinality === "one_to_many") {
    return `One ${from} row matches many ${to} rows. Measures of ${from} repeat after this join: aggregate ${to} to the ${from} grain first, or count distinct.`;
  }
  if (cardinality === "many_to_many") {
    return `Many ${from} rows match many ${to} rows. Both sides repeat after this join: aggregate one side to the join key first.`;
  }
  return undefined;
}

function buildPath(
  sequence: string[],
  adjacency: Adjacency,
  side: (node: string) => JoinSide,
): JoinPath {
  const steps: JoinHop[] = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const left = sequence[i];
    const right = sequence[i + 1];
    const edges = [...(adjacency.get(left)?.get(right) ?? [])].sort(
      (x, y) =>
        Number(y.preferred) - Number(x.preferred) ||
        (x.name ?? "").localeCompare(y.name ?? ""),
    );
    const oriented = (edge: Edge) => {
      // A self relationship is walked as declared.
      const forward = edge.a === left;
      return {
        cardinality: forward ? edge.cardinality : invert(edge.cardinality),
        join: forward
          ? edge.join
          : edge.join.map(pair => ({
              fromColumn: pair.toColumn,
              toColumn: pair.fromColumn,
            })),
      };
    };
    const [edge, ...others] = edges;
    const { cardinality, join } = oriented(edge);
    const from = side(left);
    const to = side(right);
    const fanOut = fanOutWarning(
      cardinality,
      from.entity ?? from.model,
      to.entity ?? to.model,
    );
    steps.push({
      ...(edge.name ? { relationship: edge.name } : {}),
      from,
      to,
      join,
      on: join
        .map(
          pair =>
            `${from.model}.${pair.fromColumn} = ${to.model}.${pair.toColumn}`,
        )
        .join(" and "),
      cardinality,
      status: edge.status,
      ...(edge.source ? { source: edge.source } : {}),
      ...(fanOut ? { fanOut } : {}),
      ...(edge.notes.length ? { notes: edge.notes } : {}),
      ...(others.length
        ? {
            alternatives: others.map(other => ({
              ...(other.name ? { relationship: other.name } : {}),
              join: oriented(other).join,
              status: other.status,
            })),
          }
        : {}),
    });
  }
  return {
    hops: steps.length,
    governed: steps.every(step => step.status.toLowerCase() === "governed"),
    fanOut: steps.some(step => step.fanOut !== undefined),
    steps,
  };
}

interface Search {
  paths: JoinPath[];
  total: number;
  /** Hops of a path longer than `maxHops`, when that is why none was found. */
  beyond: number | null;
}

/**
 * The shortest paths, best first: more preferred (governed) hops, then
 * fewer fan-out hops. When the shortest way needs a non-preferred hop and
 * an all-preferred way is one hop longer, that one is listed after it; a
 * longer detour is not a better join and is left out.
 */
function search(
  edges: Edge[],
  from: string,
  to: string,
  maxHops: number,
  side: (node: string) => JoinSide,
): Search {
  const all = adjacencyOf(edges, () => true);
  const loose = shortestSequences(all, from, to, maxHops);
  if (!loose) {
    return { paths: [], total: 0, beyond: unboundedHops(all, from, to) };
  }
  // How many hops of a sequence have a preferred relationship to walk.
  const preferredHops = new Map<JoinPath, number>();
  const keyOf = new Map<JoinPath, string>();
  const build = (sequence: string[], adjacency: Adjacency) => {
    const path = buildPath(sequence, adjacency, side);
    preferredHops.set(
      path,
      sequence
        .slice(0, -1)
        .filter((node, i) =>
          (adjacency.get(node)?.get(sequence[i + 1]) ?? []).some(
            edge => edge.preferred,
          ),
        ).length,
    );
    keyOf.set(path, sequence.join(">"));
    return path;
  };
  const fanOuts = (path: JoinPath) =>
    path.steps.filter(step => step.fanOut !== undefined).length;
  const paths = loose.sequences
    .map(sequence => build(sequence, all))
    .sort(
      (a, b) =>
        (preferredHops.get(b) ?? 0) - (preferredHops.get(a) ?? 0) ||
        fanOuts(a) - fanOuts(b) ||
        (keyOf.get(a) ?? "").localeCompare(keyOf.get(b) ?? ""),
    );
  let total = loose.total;
  const best = paths[0];
  if ((preferredHops.get(best) ?? 0) < best.hops) {
    const preferred = adjacencyOf(edges, edge => edge.preferred);
    const strict = shortestSequences(
      preferred,
      from,
      to,
      Math.min(maxHops, loose.hops + 1),
    );
    if (strict && strict.hops > loose.hops) {
      total += strict.total;
      paths.splice(
        1,
        0,
        ...strict.sequences.slice(0, 1).map(seq => build(seq, preferred)),
      );
    }
  }
  return { paths: paths.slice(0, MAX_PATHS), total, beyond: null };
}

function beyondMessage(maxHops: number, hops: number): string {
  return hops <= MAX_MAX_HOPS
    ? `No declared path within ${maxHops} hops. A path of ${hops} hops exists: pass maxHops: ${hops}.`
    : `No declared path within ${maxHops} hops. The shortest one has ${hops} hops, past the limit of ${MAX_MAX_HOPS}: a join that long is not one to write. Declare a direct relationship in the registry.`;
}

/** The raw tables an entity is built from, among those the file knows. */
function rawTablesOf(entity: RegistryEntity, tables: Set<string>): string[] {
  const candidates = [
    ...(entity.canonical ? [entity.canonical.model] : []),
    ...entity.sources,
  ].map(cleanName);
  return [...new Set(candidates)].filter(table => tables.has(table));
}

/**
 * The shortest declared join path between two ends. `maxHops` bounds the
 * search (default 4, at most 6). Never throws: an end nothing names, or two
 * ends nothing connects, is a result with `paths: []` and a message.
 */
export function findJoinPath(
  registry: OntologyRegistry,
  fromText: string,
  toText: string,
  options: {
    maxHops?: number;
    modelNameOf?: (text: string) => string | undefined;
  } = {},
): JoinPathResult {
  const maxHops = Math.max(
    1,
    Math.min(options.maxHops ?? DEFAULT_MAX_HOPS, MAX_MAX_HOPS),
  );
  const fromEnd = resolveJoinEndpoint(registry, fromText, options.modelNameOf);
  const toEnd = resolveJoinEndpoint(registry, toText, options.modelNameOf);
  const base = {
    from: summarize(registry, fromText, fromEnd),
    to: summarize(registry, toText, toEnd),
  };
  const none = (message: string, nearest?: JoinPathResult["nearest"]) => ({
    ...base,
    level: "none" as const,
    paths: [],
    message,
    ...(nearest ? { nearest } : {}),
  });

  if (fromEnd.kind === "unknown" || toEnd.kind === "unknown") {
    const unknown = [
      ...(fromEnd.kind === "unknown" ? [fromText] : []),
      ...(toEnd.kind === "unknown" ? [toText] : []),
    ];
    return none(
      registry.entities.length === 0 && registry.rawRelationships.length === 0
        ? "The registry declares no entities and no relationships, so no join path is known."
        : `${unknown.map(text => `"${text}"`).join(" and ")} ${unknown.length > 1 ? "are" : "is"} not an entity, a canonical model or a raw table the registry knows. \`closest\` lists the nearest entity names.`,
    );
  }

  const entities = new Map(
    registry.entities.map(entity => [entity.name.toLowerCase(), entity]),
  );
  const eEdges = entityEdges(registry);
  const entitySide = (node: string): JoinSide => {
    const entity = entities.get(node);
    return {
      entity: entity?.name ?? node,
      model: entity?.canonical?.model ?? node,
    };
  };
  const neighbours = (node: string, edges: Edge[]) =>
    [
      ...new Set(
        edges.flatMap(edge =>
          edge.a === node ? [edge.b] : edge.b === node ? [edge.a] : [],
        ),
      ),
    ]
      .filter(other => other !== node)
      .sort()
      .slice(0, MAX_NEAREST);

  let beyond: number | null = null;
  if (fromEnd.kind === "entity" && toEnd.kind === "entity") {
    const found = search(
      eEdges,
      fromEnd.entity.name.toLowerCase(),
      toEnd.entity.name.toLowerCase(),
      maxHops,
      entitySide,
    );
    if (found.paths.length > 0) {
      return {
        ...base,
        level: "entity",
        paths: found.paths,
        ...(found.total > found.paths.length
          ? { pathsTotal: found.total }
          : {}),
      };
    }
    // A declared entity path that is only too long is the answer: a
    // shorter raw-table path must not stand in for it.
    if (found.beyond !== null) {
      return none(beyondMessage(maxHops, found.beyond), {
        from: neighbours(fromEnd.entity.name.toLowerCase(), eEdges),
        to: neighbours(toEnd.entity.name.toLowerCase(), eEdges),
      });
    }
  }

  // Raw tables: an end given as a table, or entities nothing declares a
  // path between.
  const rEdges = rawEdges(registry);
  const tables = new Set(rEdges.flatMap(edge => [edge.a, edge.b]));
  const tablesOf = (end: JoinEndpoint) =>
    end.kind === "table"
      ? [end.table]
      : end.kind === "entity"
        ? rawTablesOf(end.entity, tables)
        : [];
  let best: Search | null = null;
  for (const fromTable of tablesOf(fromEnd)) {
    for (const toTable of tablesOf(toEnd)) {
      const found = search(rEdges, fromTable, toTable, maxHops, node => ({
        model: node,
      }));
      if (found.paths.length === 0) {
        if (
          found.beyond !== null &&
          (beyond === null || found.beyond < beyond)
        ) {
          beyond = found.beyond;
        }
        continue;
      }
      if (!best || found.paths[0].hops < best.paths[0].hops) best = found;
    }
  }
  if (best) {
    return {
      ...base,
      level: "raw",
      paths: best.paths,
      ...(best.total > best.paths.length ? { pathsTotal: best.total } : {}),
      message:
        fromEnd.kind === "entity" || toEnd.kind === "entity"
          ? "No entity relationship is declared for this pair. This path joins raw tables on foreign keys; an entity end is replaced by the raw table it is built from, so check that its canonical model carries these columns."
          : "This path joins raw tables on foreign keys. Entities that cover these tables join on their canonical models instead.",
    };
  }

  const nearestOf = (end: JoinEndpoint) =>
    end.kind === "entity"
      ? neighbours(end.entity.name.toLowerCase(), eEdges)
      : end.kind === "table"
        ? neighbours(end.table, rEdges)
        : [];
  return none(
    beyond !== null
      ? beyondMessage(maxHops, beyond)
      : "No declared path connects these two. `nearest` lists what each one joins to directly. Declare the relationship in the registry before writing the join.",
    { from: nearestOf(fromEnd), to: nearestOf(toEnd) },
  );
}

// ---------------------------------------------------------------------------
// One entity's relationships (lookup_term, describe_model)
// ---------------------------------------------------------------------------

export interface EntityRelationship {
  relationship: string;
  /** The entity on the other side. */
  with: string;
  /** Its canonical model. */
  model?: string;
  /** Read from this entity to the other one. */
  cardinality: RelationshipCardinality;
  /** `fromColumn` is on this entity's canonical model. */
  join: JoinColumnPair[];
  status: string;
}

/** Every declared relationship of an entity, seen from that entity. */
export function relationshipsOfEntity(
  registry: OntologyRegistry,
  entityName: string,
): EntityRelationship[] {
  const name = entityName.toLowerCase();
  const models = new Map(
    registry.entities.map(entity => [
      entity.name.toLowerCase(),
      entity.canonical?.model,
    ]),
  );
  const out: EntityRelationship[] = [];
  for (const relationship of registry.relationships) {
    const isFrom = relationship.from.toLowerCase() === name;
    const isTo = relationship.to.toLowerCase() === name;
    if (!isFrom && !isTo) continue;
    const other = isFrom ? relationship.to : relationship.from;
    const model = models.get(other.toLowerCase());
    out.push({
      relationship: relationship.name,
      with: other,
      ...(model ? { model } : {}),
      cardinality: isFrom
        ? relationship.cardinality
        : invert(relationship.cardinality),
      join: isFrom
        ? relationship.join
        : relationship.join.map(pair => ({
            fromColumn: pair.toColumn,
            toColumn: pair.fromColumn,
          })),
      status: relationship.status ?? "draft",
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.status === "governed") - Number(a.status === "governed") ||
      a.with.localeCompare(b.with) ||
      a.relationship.localeCompare(b.relationship),
  );
}
