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
 *
 * A shortest path is not always the join one means. Three guards:
 *
 * - A curated path of the registry (`paths`) wins over any search. What a
 *   search finds is then listed apart, as reference.
 * - A role link (`traversal: explicit`: closer, manager, creator) joins
 *   its own two ends and is never a step between two other entities.
 * - A searched path that enters an entity through `many_to_one` and leaves
 *   it through `one_to_many` relates its ends only through that shared
 *   entity. It is marked suspect and ranks below every path that is not.
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
  walkRelationships,
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
  /** A role link: joins its own two ends, never a step between two others. */
  explicit: boolean;
  notes: string[];
}

/** An edge walked in one direction. */
interface Walked {
  edge: Edge;
  /** True when walked from `a` to `b`. */
  forward: boolean;
}

function invert(cardinality: RelationshipCardinality): RelationshipCardinality {
  if (cardinality === "many_to_one") return "one_to_many";
  if (cardinality === "one_to_many") return "many_to_one";
  return cardinality;
}

const leftOf = (walk: Walked) => (walk.forward ? walk.edge.a : walk.edge.b);
const rightOf = (walk: Walked) => (walk.forward ? walk.edge.b : walk.edge.a);
const cardinalityOf = (walk: Walked) =>
  walk.forward ? walk.edge.cardinality : invert(walk.edge.cardinality);

function entityEdge(relationship: RegistryRelationship): Edge {
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
    explicit: relationship.explicit === true,
    notes: relationship.openPoint
      ? [`Open point: ${relationship.openPoint}`]
      : [],
  };
}

function entityEdges(registry: OntologyRegistry): Edge[] {
  return registry.relationships.map(entityEdge);
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
      explicit: false,
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

/** Node → the walks that leave it. */
type Adjacency = Map<string, Walked[]>;

function adjacencyOf(edges: Edge[]): Adjacency {
  const adjacency: Adjacency = new Map();
  const add = (node: string, walk: Walked) => {
    const list = adjacency.get(node);
    if (list) list.push(walk);
    else adjacency.set(node, [walk]);
  };
  for (const edge of edges) {
    add(edge.a, { edge, forward: true });
    if (edge.a !== edge.b) add(edge.b, { edge, forward: false });
  }
  return adjacency;
}

/**
 * Every shortest walk from `from` to `to`, at most `maxHops` long (breadth
 * first, so a cycle is never walked twice).
 *
 * With `avoidFanTrap`, a walk never leaves a node through `one_to_many`
 * after entering it through `many_to_one`: the search state is the node
 * plus how it was entered, so the shortest walk that respects the rule is
 * found even when a shorter one breaks it.
 *
 * `walks` holds the first `MAX_RANKED_SEQUENCES`; `total` counts them all.
 */
function shortestWalks(
  adjacency: Adjacency,
  from: string,
  to: string,
  maxHops: number,
  avoidFanTrap = false,
): { walks: Walked[][]; total: number; hops: number } | null {
  if (from === to) {
    // The same node: a relationship of an entity with itself, one hop.
    const loops = (adjacency.get(from) ?? []).filter(
      walk => rightOf(walk) === from,
    );
    return loops.length > 0
      ? { walks: loops.map(walk => [walk]), total: loops.length, hops: 1 }
      : null;
  }
  const stateOf = (node: string, viaManyToOne: boolean) =>
    avoidFanTrap ? `${node}\u0000${viaManyToOne ? 1 : 0}` : node;
  const nodeOf = (state: string) => state.split("\u0000")[0];
  const start = stateOf(from, false);
  const distance = new Map<string, number>([[start, 0]]);
  const parents = new Map<string, Array<{ state: string; walk: Walked }>>();
  let frontier = [start];
  let reached: string[] = [];
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const state of frontier) {
      const node = nodeOf(state);
      const trapped = avoidFanTrap && state.endsWith("\u00001");
      for (const walk of adjacency.get(node) ?? []) {
        const neighbour = rightOf(walk);
        if (neighbour === node) continue;
        const cardinality = cardinalityOf(walk);
        if (trapped && cardinality === "one_to_many") continue;
        const target = stateOf(neighbour, cardinality === "many_to_one");
        const known = distance.get(target);
        if (known === undefined) {
          distance.set(target, hop);
          parents.set(target, [{ state, walk }]);
          next.push(target);
        } else if (known === hop) {
          parents.get(target)?.push({ state, walk });
        }
      }
    }
    reached = next.filter(state => nodeOf(state) === to);
    if (reached.length > 0) break;
    frontier = next;
  }
  if (reached.length === 0) return null;
  const walks: Walked[][] = [];
  let total = 0;
  const collect = (state: string, tail: Walked[]) => {
    if (state === start) {
      total++;
      if (walks.length < MAX_RANKED_SEQUENCES) walks.push(tail);
      return;
    }
    for (const parent of parents.get(state) ?? []) {
      // Counting stops being useful long before it stops being possible.
      if (total >= MAX_RANKED_SEQUENCES * 20) return;
      collect(parent.state, [parent.walk, ...tail]);
    }
  };
  for (const state of [...new Set(reached)].sort()) collect(state, []);
  return { walks, total, hops: distance.get(reached[0]) ?? 0 };
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
  /** Set on a step of a curated path of the registry. */
  curated?: true;
  /** The curated path's name. */
  path?: string;
  /** The alternative's name and its place in the ladder (1 = tried first). */
  step?: string;
  order?: number;
  note?: string;
  hops: number;
  /** True when every hop is a governed relationship. */
  governed: boolean;
  /** True when a hop multiplies rows. */
  fanOut: boolean;
  /**
   * Set on a searched path that relates the two ends only through a shared
   * third entity (it enters it many_to_one and leaves it one_to_many).
   */
  suspect?: true;
  warning?: string;
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
  /** The curated path of the registry that `paths` comes from, when one does. */
  curated?: {
    name: string;
    status?: string;
    description?: string;
    /** `reversed` when the path is declared from `to` to `from`. */
    direction: "declared" | "reversed";
    caveats: string[];
    use: string;
  };
  paths: JoinPath[];
  /** Shortest paths found, when more than the ones listed. */
  pathsTotal?: number;
  /** With a curated path: what a search would have found. Reference only. */
  alternatives?: JoinPath[];
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

/**
 * The shared entity of a fan trap: a node the walk enters through
 * `many_to_one` and leaves through `one_to_many`. Two rows that meet there
 * have that node in common and nothing else (every enquiry of a broker
 * with every account the same broker closed).
 */
function fanTrapOf(walks: Walked[]): string | undefined {
  for (let i = 1; i < walks.length; i++) {
    if (
      cardinalityOf(walks[i - 1]) === "many_to_one" &&
      cardinalityOf(walks[i]) === "one_to_many"
    ) {
      return leftOf(walks[i]);
    }
  }
  return undefined;
}

function buildPath(
  walks: Walked[],
  side: (node: string) => JoinSide,
  /** The other declared ways across one hop's two nodes. */
  othersOf: (walk: Walked) => Walked[] = () => [],
  /** A curated path is the registry's word: never marked suspect. */
  judge = true,
): JoinPath {
  const orient = (walk: Walked) =>
    walk.forward
      ? walk.edge.join
      : walk.edge.join.map(pair => ({
          fromColumn: pair.toColumn,
          toColumn: pair.fromColumn,
        }));
  const steps: JoinHop[] = walks.map(walk => {
    const { edge } = walk;
    const cardinality = cardinalityOf(walk);
    const join = orient(walk);
    const from = side(leftOf(walk));
    const to = side(rightOf(walk));
    const fanOut = fanOutWarning(
      cardinality,
      from.entity ?? from.model,
      to.entity ?? to.model,
    );
    const others = othersOf(walk);
    return {
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
              ...(other.edge.name ? { relationship: other.edge.name } : {}),
              join: orient(other),
              status: other.edge.status,
            })),
          }
        : {}),
    };
  });
  const trap = judge ? fanTrapOf(walks) : undefined;
  const shared = trap ? (side(trap).entity ?? side(trap).model) : undefined;
  const first = steps[0]?.from;
  const last = steps[steps.length - 1]?.to;
  return {
    hops: steps.length,
    governed: steps.every(step => step.status.toLowerCase() === "governed"),
    fanOut: steps.some(step => step.fanOut !== undefined),
    ...(shared && first && last
      ? {
          suspect: true as const,
          warning: `This path relates ${first.entity ?? first.model} and ${last.entity ?? last.model} only through a shared ${shared}: it pairs every ${first.entity ?? first.model} row of a ${shared} with every ${last.entity ?? last.model} row of the same ${shared}. That is rarely the join you mean.`,
        }
      : {}),
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
 * The declared paths between two nodes, best first.
 *
 * - A role link (`explicit`) is used only between its own two ends.
 * - The shortest paths come first, ordered by more preferred (governed)
 *   hops, then fewer fan-out hops.
 * - A path through a fan trap is marked suspect and ranks below every path
 *   that is not. When all the shortest ones are suspect, the shortest path
 *   that avoids the trap is searched for and listed first, however long.
 * - When the best path needs a non-preferred hop and an all-preferred way
 *   is one hop longer, that one is listed after it.
 */
function search(
  edges: Edge[],
  from: string,
  to: string,
  maxHops: number,
  side: (node: string) => JoinSide,
): Search {
  const joinsTheEnds = (edge: Edge) =>
    (edge.a === from && edge.b === to) || (edge.a === to && edge.b === from);
  const usable = edges.filter(edge => !edge.explicit || joinsTheEnds(edge));
  const all = adjacencyOf(usable);
  const loose = shortestWalks(all, from, to, maxHops);
  if (!loose) {
    return {
      paths: [],
      total: 0,
      beyond:
        shortestWalks(all, from, to, Number.MAX_SAFE_INTEGER)?.hops ?? null,
    };
  }
  const keyOf = (walks: Walked[]) =>
    [leftOf(walks[0]), ...walks.map(rightOf)].join(">");
  const preferredCount = (walks: Walked[]) =>
    walks.filter(walk => walk.edge.preferred).length;
  const othersOf = (walk: Walked) =>
    (all.get(leftOf(walk)) ?? [])
      .filter(
        other => rightOf(other) === rightOf(walk) && other.edge !== walk.edge,
      )
      .sort(
        (x, y) =>
          Number(y.edge.preferred) - Number(x.edge.preferred) ||
          (x.edge.name ?? "").localeCompare(y.edge.name ?? ""),
      );
  // Two relationships between one pair are one path with an alternative:
  // keep, per node sequence, the walk with the most preferred hops.
  const ranked = new Map<JoinPath, { key: string; preferred: number }>();
  const pathsOf = (walkList: Walked[][]) => {
    const best = new Map<string, Walked[]>();
    const ordered = [...walkList].sort(
      (x, y) =>
        preferredCount(y) - preferredCount(x) ||
        x
          .map(walk => walk.edge.name ?? "")
          .join(">")
          .localeCompare(y.map(walk => walk.edge.name ?? "").join(">")),
    );
    for (const walks of ordered) {
      if (!best.has(keyOf(walks))) best.set(keyOf(walks), walks);
    }
    return [...best].map(([key, walks]) => {
      const path = buildPath(walks, side, othersOf);
      ranked.set(path, { key, preferred: preferredCount(walks) });
      return path;
    });
  };
  const fanOuts = (path: JoinPath) =>
    path.steps.filter(step => step.fanOut !== undefined).length;
  const byRank = (a: JoinPath, b: JoinPath) =>
    Number(a.suspect ?? false) - Number(b.suspect ?? false) ||
    a.hops - b.hops ||
    (ranked.get(b)?.preferred ?? 0) - (ranked.get(a)?.preferred ?? 0) ||
    fanOuts(a) - fanOuts(b) ||
    (ranked.get(a)?.key ?? "").localeCompare(ranked.get(b)?.key ?? "");

  const paths = pathsOf(loose.walks);
  if (paths.every(path => path.suspect)) {
    const safe = shortestWalks(all, from, to, maxHops, true);
    if (safe) paths.push(...pathsOf(safe.walks));
  }
  paths.sort(byRank);
  const best = paths[0];
  if (!best.suspect && (ranked.get(best)?.preferred ?? 0) < best.hops) {
    const strict = shortestWalks(
      adjacencyOf(usable.filter(edge => edge.preferred)),
      from,
      to,
      Math.min(maxHops, best.hops + 1),
      true,
    );
    if (strict && strict.hops > best.hops) {
      paths.splice(1, 0, ...pathsOf(strict.walks).slice(0, 1));
    }
  }
  return {
    paths: paths.slice(0, MAX_PATHS),
    total: paths.length,
    beyond: null,
  };
}

/**
 * The curated path of the registry between two entities, in either
 * direction, as one path per ladder step. Governed before draft, then file
 * order. Null when the registry curates none for this pair.
 */
function curatedPath(
  registry: OntologyRegistry,
  from: string,
  to: string,
  side: (node: string) => JoinSide,
): { meta: NonNullable<JoinPathResult["curated"]>; paths: JoinPath[] } | null {
  const matches = registry.paths
    .map(path => ({
      path,
      direction:
        path.from.toLowerCase() === from && path.to.toLowerCase() === to
          ? ("declared" as const)
          : path.from.toLowerCase() === to && path.to.toLowerCase() === from
            ? ("reversed" as const)
            : null,
    }))
    .filter(match => match.direction !== null)
    .sort(
      (a, b) =>
        Number(b.path.status?.toLowerCase() === "governed") -
        Number(a.path.status?.toLowerCase() === "governed"),
    );
  for (const { path, direction } of matches) {
    const paths: JoinPath[] = [];
    path.steps.forEach((step, i) => {
      const via = direction === "reversed" ? [...step.via].reverse() : step.via;
      const walk = walkRelationships(registry.relationships, from, via);
      if ("problem" in walk) return;
      const built = buildPath(
        walk.hops.map(hop => ({
          edge: entityEdge(hop.relationship),
          forward: hop.forward,
        })),
        side,
        undefined,
        false,
      );
      paths.push({
        curated: true,
        path: path.name,
        ...(step.name ? { step: step.name } : {}),
        order: i + 1,
        ...(step.note ? { note: step.note } : {}),
        ...built,
      });
    });
    if (paths.length === 0) continue;
    return {
      meta: {
        name: path.name,
        ...(path.status ? { status: path.status } : {}),
        ...(path.description ? { description: path.description } : {}),
        direction: direction ?? "declared",
        caveats: path.caveats,
        use:
          paths.length > 1
            ? `The ${paths.length} paths are ordered alternatives, not a choice: join each one and coalesce the result in this order (the first that finds a row wins).`
            : "Join on these hops, in order.",
      },
      paths,
    };
  }
  return null;
}

/** What to say when searched paths go through a shared third entity. */
function suspectMessage(
  paths: JoinPath[],
  from: string,
  to: string,
): { message?: string } {
  const suspects = paths.filter(path => path.suspect).length;
  if (suspects === 0) return {};
  if (suspects === paths.length) {
    return {
      message: `No trustworthy declared path exists between ${from} and ${to}. ${suspects === 1 ? "The path below is" : `The ${suspects} paths below are`} marked suspect: ${suspects === 1 ? "it relates" : "they relate"} the two only through a shared third entity. Do not write this join from it. Declare a curated path in the registry (\`paths:\`) that says how ${from} reaches ${to}.`,
    };
  }
  return {
    message: `${suspects} of ${paths.length} paths ${suspects === 1 ? "is" : "are"} marked suspect and ${suspects === 1 ? "ranks" : "rank"} last: ${suspects === 1 ? "it relates" : "they relate"} the two only through a shared third entity. Use a path that is not suspect.`,
  };
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
    const fromName = fromEnd.entity.name.toLowerCase();
    const toName = toEnd.entity.name.toLowerCase();
    const found = search(eEdges, fromName, toName, maxHops, entitySide);
    // A curated path is the registry's answer: it wins over any search.
    const curated = curatedPath(registry, fromName, toName, entitySide);
    if (curated) {
      return {
        ...base,
        level: "entity",
        curated: curated.meta,
        paths: curated.paths,
        ...(found.paths.length ? { alternatives: found.paths } : {}),
        message:
          `The registry curates this join as \`${curated.meta.name}\`: use \`paths\`.` +
          (found.paths.length
            ? " `alternatives` lists what a search of the relationships finds: reference only, never a replacement for the curated path."
            : ""),
      };
    }
    if (found.paths.length > 0) {
      return {
        ...base,
        level: "entity",
        paths: found.paths,
        ...(found.total > found.paths.length
          ? { pathsTotal: found.total }
          : {}),
        ...suspectMessage(found.paths, fromEnd.entity.name, toEnd.entity.name),
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
        (fromEnd.kind === "entity" || toEnd.kind === "entity"
          ? "No entity relationship is declared for this pair. This path joins raw tables on foreign keys; an entity end is replaced by the raw table it is built from, so check that its canonical model carries these columns."
          : "This path joins raw tables on foreign keys. Entities that cover these tables join on their canonical models instead.") +
        (suspectMessage(best.paths, fromText, toText).message
          ? ` ${suspectMessage(best.paths, fromText, toText).message}`
          : ""),
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
  /** `explicit` for a role link: joins these two, never a step between others. */
  traversal?: "explicit";
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
      ...(relationship.explicit ? { traversal: "explicit" as const } : {}),
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.status === "governed") - Number(a.status === "governed") ||
      a.with.localeCompare(b.with) ||
      a.relationship.localeCompare(b.relationship),
  );
}
