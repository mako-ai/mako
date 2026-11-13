/**
 * The ontology registry: the workspace's business terms and entities, and
 * the dbt model each one is canonically answered by.
 *
 * It is one YAML file in the workspace repo (`dbt/ontology/terms.yml`).
 * This module is the pure half: parsing that file and resolving a phrase
 * ("paying customers", "monthly recurring revenue") to an entry. A workspace
 * without the file, or with a file that does not parse, has an empty
 * registry and a status that says why; nothing here throws.
 */
import { loadYaml } from "../../utils/yaml";

/** Where the registry lives in the workspace repo. */
export const ONTOLOGY_REGISTRY_PATH = "dbt/ontology/terms.yml";
/**
 * A generated companion file: the foreign keys of the raw CRM tables, for
 * joins the registry does not declare between entities yet.
 */
export const ONTOLOGY_RAW_RELATIONSHIPS_PATH =
  "dbt/ontology/generated/crm_relationships.yml";
/** The schema a bare table name in that file belongs to. */
export const RAW_RELATIONSHIPS_SCHEMA = "crm_public";

export interface RegistryForbiddenPattern {
  regex: string;
  message?: string;
  paths?: string[];
}

export interface RegistryKnownVariant {
  model: string;
  difference?: string;
}

export interface RegistryTerm {
  kind: "term";
  name: string;
  label?: string;
  definition?: string;
  owner?: string;
  /** `governed` or `draft`, as written. */
  status?: string;
  canonical?: { model: string; column?: string };
  grain?: string;
  synonyms: string[];
  forbiddenPatterns: RegistryForbiddenPattern[];
  knownVariants: RegistryKnownVariant[];
}

/** A key that identifies the same entity in another system. */
export interface RegistryIdentity {
  system: string;
  column: string;
  /** The model that holds the column; absent means the canonical model. */
  resolver?: string;
}

export interface RegistryEntity {
  kind: "entity";
  name: string;
  label?: string;
  definition?: string;
  owner?: string;
  /** `governed` or `draft`, as written. */
  status?: string;
  /** One column, or a list of columns for a composite key. */
  canonical?: { model: string; primaryKey?: string | string[] };
  grain?: string;
  sources: string[];
  identities: RegistryIdentity[];
  synonyms: string[];
  knownVariants: RegistryKnownVariant[];
  /** On a draft entity: what blocks `governed`. */
  openPoint?: string;
}

export type RelationshipCardinality =
  "many_to_one" | "one_to_many" | "one_to_one" | "many_to_many";

export const RELATIONSHIP_CARDINALITIES: readonly RelationshipCardinality[] = [
  "many_to_one",
  "one_to_many",
  "one_to_one",
  "many_to_many",
];

export interface JoinColumnPair {
  fromColumn: string;
  toColumn: string;
}

/** How two entities join: columns on their canonical models. */
export interface RegistryRelationship {
  name: string;
  /** Entity names. `from` holds the foreign key. */
  from: string;
  to: string;
  cardinality: RelationshipCardinality;
  join: JoinColumnPair[];
  /** `governed` or `draft`, as written. */
  status?: string;
  /** `declared`, `hasura_fk` or `mined`, as written. */
  source?: string;
  evidence?: string;
  openPoint?: string;
  /**
   * True for `traversal: explicit`: a role link (closer, manager, creator,
   * assignee). It joins its own two ends and is never a step on the way
   * between two other entities.
   */
  explicit?: boolean;
}

/** One alternative of a curated path: relationship names, in order. */
export interface RegistryPathStep {
  name?: string;
  via: string[];
  note?: string;
}

/**
 * A curated multi-hop join between two entities. Its `steps` are ordered
 * alternatives (a coalesce ladder): the first whose keys are filled wins.
 */
export interface RegistryPath {
  name: string;
  from: string;
  to: string;
  /** `governed` or `draft`, as written. */
  status?: string;
  description?: string;
  steps: RegistryPathStep[];
  caveats: string[];
}

/** One relationship of a walk, and whether it is walked as declared. */
export interface WalkedRelationship {
  relationship: RegistryRelationship;
  /** True when the walk goes from the relationship's `from` to its `to`. */
  forward: boolean;
}

/**
 * Walk relationship names from an entity, hop by hop. Each relationship
 * must have the entity reached so far as one of its two ends. Returns the
 * walk and where it ends, or the reason it breaks.
 */
export function walkRelationships(
  relationships: readonly RegistryRelationship[],
  start: string,
  via: readonly string[],
): { hops: WalkedRelationship[]; end: string } | { problem: string } {
  const byName = new Map(
    relationships.map(relationship => [
      relationship.name.toLowerCase(),
      relationship,
    ]),
  );
  let at = start.toLowerCase();
  const hops: WalkedRelationship[] = [];
  for (const name of via) {
    const relationship = byName.get(name.toLowerCase());
    if (!relationship)
      return { problem: `names an unknown relationship \`${name}\`` };
    const from = relationship.from.toLowerCase();
    const to = relationship.to.toLowerCase();
    if (from === at) {
      hops.push({ relationship, forward: true });
      at = to;
    } else if (to === at) {
      hops.push({ relationship, forward: false });
      at = from;
    } else {
      return {
        problem: `does not chain: \`${name}\` joins \`${relationship.from}\` and \`${relationship.to}\`, not \`${at}\``,
      };
    }
  }
  return { hops, end: at };
}

/** A foreign key between two raw tables (the generated file). */
export interface RawRelationship {
  name?: string;
  /** `schema.table`, lowercased. */
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  cardinality: RelationshipCardinality;
  /** `fk` or `manual`, as written. */
  kind?: string;
  /** False when the warehouse does not hold both tables. */
  inWarehouse?: boolean;
  /** True when the referenced columns were inferred, not read from a constraint. */
  inferred?: boolean;
}

export type RegistryEntry = RegistryTerm | RegistryEntity;

/**
 * - `ok`: the file parsed (entries may still have been skipped: `problems`).
 * - `absent`: the workspace has no registry file (or no repo).
 * - `malformed`: the file is not valid YAML or not the expected shape.
 * - `unavailable`: the repo could not be read just now.
 */
export type RegistryStatus = "ok" | "absent" | "malformed" | "unavailable";

export interface OntologyRegistry {
  status: RegistryStatus;
  version?: number;
  terms: RegistryTerm[];
  entities: RegistryEntity[];
  /** How entities join. Empty when the file declares none. */
  relationships: RegistryRelationship[];
  /** Curated multi-hop joins. Empty when the file declares none. */
  paths: RegistryPath[];
  /** Raw-table foreign keys from the generated file. Empty when absent. */
  rawRelationships: RawRelationship[];
  /** What was skipped or wrong, for the agent to relay. */
  problems: string[];
}

export function emptyRegistry(
  status: RegistryStatus,
  problems: string[] = [],
): OntologyRegistry {
  return {
    status,
    terms: [],
    entities: [],
    relationships: [],
    paths: [],
    rawRelationships: [],
    problems,
  };
}

/** One line an agent can act on when the registry is not `ok`. */
export function registryStatusMessage(
  registry: OntologyRegistry,
): string | undefined {
  switch (registry.status) {
    case "ok":
      return undefined;
    case "absent":
      return `This workspace has no ontology registry (${ONTOLOGY_REGISTRY_PATH} on main). Terms and canonical models are unknown: use find_models.`;
    case "malformed":
      return `${ONTOLOGY_REGISTRY_PATH} could not be parsed: ${registry.problems[0] ?? "invalid YAML"}. The registry is treated as empty.`;
    case "unavailable":
      return `The ontology registry could not be read right now: ${registry.problems[0] ?? "repo unavailable"}. The registry is treated as empty.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function strList(value: unknown): string[] {
  if (typeof value === "string") return str(value) ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((v): v is string => v !== undefined);
}

function parseCanonical(value: unknown):
  | {
      model: string;
      column?: string;
      primaryKey?: string | string[];
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const model = str(value.model);
  if (!model) return undefined;
  const column = str(value.column);
  // One column stays a string; a composite key stays a list.
  const keyList = Array.isArray(value.primary_key)
    ? strList(value.primary_key)
    : [];
  const primaryKey =
    keyList.length > 1 ? keyList : (keyList[0] ?? str(value.primary_key));
  return {
    model,
    ...(column ? { column } : {}),
    ...(primaryKey ? { primaryKey } : {}),
  };
}

function parseTerm(raw: Record<string, unknown>, name: string): RegistryTerm {
  const canonical = parseCanonical(raw.canonical);
  const forbidden = Array.isArray(raw.forbidden_patterns)
    ? raw.forbidden_patterns
    : [];

  return {
    kind: "term",
    name,
    label: str(raw.label),
    definition: str(raw.definition),
    owner: str(raw.owner),
    status: str(raw.status),
    canonical: canonical
      ? {
          model: canonical.model,
          ...(canonical.column ? { column: canonical.column } : {}),
        }
      : undefined,
    grain: str(raw.grain),
    synonyms: strList(raw.synonyms),
    forbiddenPatterns: forbidden.flatMap(item => {
      if (!isRecord(item)) return [];
      const regex = str(item.regex);
      if (!regex) return [];
      const paths = strList(item.paths);
      return [
        {
          regex,
          ...(str(item.message) ? { message: str(item.message) } : {}),
          ...(paths.length ? { paths } : {}),
        },
      ];
    }),
    knownVariants: parseKnownVariants(raw.known_variants),
  };
}

function parseKnownVariants(value: unknown): RegistryKnownVariant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const model = str(item.model);
    if (!model) return [];
    const difference = str(item.difference);
    return [{ model, ...(difference ? { difference } : {}) }];
  });
}

function parseIdentities(value: unknown): RegistryIdentity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const system = str(item.system);
    const column = str(item.column);
    if (!system || !column) return [];
    const resolver = str(item.resolver);
    return [{ system, column, ...(resolver ? { resolver } : {}) }];
  });
}

function parseCardinality(value: unknown): RelationshipCardinality | undefined {
  const text = str(value)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  return RELATIONSHIP_CARDINALITIES.find(known => known === text);
}

/**
 * One declared relationship, or why it cannot be used. A relationship needs
 * a name, two entities, a known cardinality and at least one column pair.
 */
function parseRelationship(
  raw: Record<string, unknown>,
  name: string,
): RegistryRelationship | string {
  const from = str(raw.from);
  const to = str(raw.to);
  if (!from || !to) return "needs `from` and `to`";
  const cardinality = parseCardinality(raw.cardinality);
  if (!cardinality) {
    return `has an unknown cardinality \`${str(raw.cardinality) ?? ""}\``;
  }
  const join = (Array.isArray(raw.join) ? raw.join : []).flatMap(pair => {
    if (!isRecord(pair)) return [];
    const fromColumn = str(pair.from_column);
    const toColumn = str(pair.to_column);
    return fromColumn && toColumn ? [{ fromColumn, toColumn }] : [];
  });
  if (join.length === 0) return "has no `join` column pair";
  return {
    name,
    from,
    to,
    cardinality,
    join,
    ...(str(raw.status) ? { status: str(raw.status) } : {}),
    ...(str(raw.source) ? { source: str(raw.source) } : {}),
    ...(str(raw.evidence) ? { evidence: str(raw.evidence) } : {}),
    ...(str(raw.open_point) ? { openPoint: str(raw.open_point) } : {}),
    ...(str(raw.traversal)?.toLowerCase() === "explicit"
      ? { explicit: true }
      : {}),
  };
}

/**
 * One curated path, or why it cannot be used. Each step must name known
 * relationships that chain from the path's `from` entity to its `to`. A
 * step that does not is dropped and reported; a path with no usable step
 * is dropped.
 */
function parsePath(
  raw: Record<string, unknown>,
  name: string,
  relationships: readonly RegistryRelationship[],
  entityNames: ReadonlySet<string>,
): { path?: RegistryPath; problems: string[] } {
  const from = str(raw.from);
  const to = str(raw.to);
  if (!from || !to) {
    return {
      problems: [`path \`${name}\` needs \`from\` and \`to\`; it was skipped.`],
    };
  }
  const unknown = [from, to].find(
    entity => !entityNames.has(entity.toLowerCase()),
  );
  if (unknown) {
    return {
      problems: [
        `path \`${name}\` names an unknown entity \`${unknown}\`; it was skipped.`,
      ],
    };
  }
  const problems: string[] = [];
  const steps: RegistryPathStep[] = [];
  (Array.isArray(raw.steps) ? raw.steps : []).forEach((item, i) => {
    const stepName = isRecord(item) ? str(item.name) : undefined;
    const label = `path \`${name}\` step ${stepName ? `\`${stepName}\`` : i + 1}`;
    const via = isRecord(item) ? strList(item.via) : [];
    if (via.length === 0) {
      problems.push(`${label} has no \`via\` relationships; it was skipped.`);
      return;
    }
    const walk = walkRelationships(relationships, from, via);
    if ("problem" in walk) {
      problems.push(`${label} ${walk.problem}; it was skipped.`);
      return;
    }
    if (walk.end !== to.toLowerCase()) {
      problems.push(
        `${label} ends at \`${walk.end}\`, not at \`${to}\`; it was skipped.`,
      );
      return;
    }
    const note = isRecord(item) ? str(item.note) : undefined;
    steps.push({
      ...(stepName ? { name: stepName } : {}),
      via,
      ...(note ? { note } : {}),
    });
  });
  if (steps.length === 0) {
    problems.push(`path \`${name}\` has no usable step; it was skipped.`);
    return { problems };
  }
  return {
    path: {
      name,
      from,
      to,
      ...(str(raw.status) ? { status: str(raw.status) } : {}),
      ...(str(raw.description) ? { description: str(raw.description) } : {}),
      steps,
      caveats: strList(raw.caveats),
    },
    problems,
  };
}

function qualifyRawTable(table: string): string {
  const clean = table.replace(/[`"\s]/g, "").toLowerCase();
  return clean.includes(".") ? clean : `${RAW_RELATIONSHIPS_SCHEMA}.${clean}`;
}

/**
 * The generated raw-relationships file: a bare list of records, or a
 * mapping with a `relationships` list. A bare table name is a table of
 * `crm_public`. A record without both tables, a known cardinality and
 * matching column lists is skipped and counted.
 */
export function parseRawRelationships(text: string | null | undefined): {
  relationships: RawRelationship[];
  problems: string[];
} {
  if (text === null || text === undefined) {
    return { relationships: [], problems: [] };
  }
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch (error) {
    return {
      relationships: [],
      problems: [
        `${ONTOLOGY_RAW_RELATIONSHIPS_PATH} could not be parsed: ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }`,
      ],
    };
  }
  const list = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc.relationships)
      ? doc.relationships
      : null;
  if (list === null) {
    return {
      relationships: [],
      problems:
        doc === null || doc === undefined
          ? []
          : [
              `${ONTOLOGY_RAW_RELATIONSHIPS_PATH} must be a list, or a mapping with a \`relationships\` list; it was ignored.`,
            ],
    };
  }
  const relationships: RawRelationship[] = [];
  let skipped = 0;
  for (const raw of list) {
    const fromTable = isRecord(raw) ? str(raw.from_table) : undefined;
    const toTable = isRecord(raw) ? str(raw.to_table) : undefined;
    const cardinality = isRecord(raw)
      ? parseCardinality(raw.cardinality)
      : undefined;
    const fromColumns = isRecord(raw) ? strList(raw.from_columns) : [];
    const toColumns = isRecord(raw) ? strList(raw.to_columns) : [];
    if (
      !isRecord(raw) ||
      !fromTable ||
      !toTable ||
      !cardinality ||
      fromColumns.length === 0 ||
      fromColumns.length !== toColumns.length
    ) {
      skipped++;
      continue;
    }
    const name = str(raw.name) ?? str(raw.hasura_name);
    relationships.push({
      ...(name ? { name } : {}),
      fromTable: qualifyRawTable(fromTable),
      fromColumns,
      toTable: qualifyRawTable(toTable),
      toColumns,
      cardinality,
      ...(str(raw.kind) ? { kind: str(raw.kind) } : {}),
      ...(typeof raw.in_bigquery === "boolean"
        ? { inWarehouse: raw.in_bigquery }
        : {}),
      ...(raw.inferred === true ? { inferred: true } : {}),
    });
  }
  return {
    relationships,
    problems:
      skipped > 0
        ? [
            `${ONTOLOGY_RAW_RELATIONSHIPS_PATH}: ${skipped} of ${list.length} records were skipped (tables, cardinality or columns missing).`,
          ]
        : [],
  };
}

function parseEntity(
  raw: Record<string, unknown>,
  name: string,
): RegistryEntity {
  const canonical = parseCanonical(raw.canonical);
  return {
    kind: "entity",
    name,
    label: str(raw.label),
    definition: str(raw.definition),
    owner: str(raw.owner),
    status: str(raw.status),
    canonical: canonical
      ? {
          model: canonical.model,
          ...(canonical.primaryKey ? { primaryKey: canonical.primaryKey } : {}),
        }
      : undefined,
    grain: str(raw.grain),
    sources: strList(raw.sources),
    identities: parseIdentities(raw.identities),
    synonyms: strList(raw.synonyms),
    knownVariants: parseKnownVariants(raw.known_variants),
    openPoint: str(raw.open_point),
  };
}

/**
 * Parse the registry file. `null` (no file) is an `absent` registry; text
 * that is not YAML, or whose top level is not a mapping, is `malformed`. An
 * entry without a `name` is skipped and reported, so one bad entry never
 * hides the rest.
 */
export function parseOntologyRegistry(
  text: string | null | undefined,
  /** The generated raw-relationships file, when the repo has one. */
  rawRelationshipsText?: string | null,
): OntologyRegistry {
  const registry = parseRegistryFile(text);
  if (registry.status !== "ok") return registry;
  const raw = parseRawRelationships(rawRelationshipsText);
  return {
    ...registry,
    rawRelationships: raw.relationships,
    problems: [...registry.problems, ...raw.problems],
  };
}

function parseRegistryFile(text: string | null | undefined): OntologyRegistry {
  if (text === null || text === undefined) return emptyRegistry("absent");
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch (error) {
    return emptyRegistry("malformed", [
      error instanceof Error ? error.message.split("\n")[0] : String(error),
    ]);
  }
  if (doc === null || doc === undefined) {
    return emptyRegistry("ok", ["The file is empty."]);
  }
  if (!isRecord(doc)) {
    return emptyRegistry("malformed", [
      "The top level must be a mapping with `terms` and `entities`.",
    ]);
  }
  const problems: string[] = [];
  const terms: RegistryTerm[] = [];
  const entities: RegistryEntity[] = [];
  const relationships: RegistryRelationship[] = [];
  const seen = new Set<string>();
  const readList = (
    key: "terms" | "entities" | "relationships" | "paths",
    add: (raw: Record<string, unknown>, name: string) => void,
  ) => {
    const list = doc[key];
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) {
      problems.push(`\`${key}\` must be a list; it was ignored.`);
      return;
    }
    list.forEach((raw, i) => {
      const name = isRecord(raw) ? str(raw.name) : undefined;
      if (!isRecord(raw) || !name) {
        problems.push(`${key}[${i}] has no \`name\`; it was skipped.`);
        return;
      }
      const id = `${key}:${name.toLowerCase()}`;
      if (seen.has(id)) {
        problems.push(`${key}[${i}] repeats \`${name}\`; the first one wins.`);
        return;
      }
      seen.add(id);
      add(raw, name);
    });
  };
  readList("terms", (raw, name) => terms.push(parseTerm(raw, name)));
  readList("entities", (raw, name) => entities.push(parseEntity(raw, name)));
  const entityNames = new Set(
    entities.map(entity => entity.name.toLowerCase()),
  );
  readList("relationships", (raw, name) => {
    const parsed = parseRelationship(raw, name);
    if (typeof parsed === "string") {
      problems.push(`relationship \`${name}\` ${parsed}; it was skipped.`);
      return;
    }
    const unknown = [parsed.from, parsed.to].filter(
      entity => !entityNames.has(entity.toLowerCase()),
    );
    if (unknown.length > 0) {
      problems.push(
        `relationship \`${name}\` names an unknown entity \`${unknown[0]}\`; it was skipped.`,
      );
      return;
    }
    if (
      str(raw.traversal) &&
      !["default", "explicit"].includes(str(raw.traversal)?.toLowerCase() ?? "")
    ) {
      problems.push(
        `relationship \`${name}\` has an unknown traversal \`${str(raw.traversal)}\`; it is read as \`default\`.`,
      );
    }
    relationships.push(parsed);
  });
  const paths: RegistryPath[] = [];
  readList("paths", (raw, name) => {
    const parsed = parsePath(raw, name, relationships, entityNames);
    problems.push(...parsed.problems);
    if (parsed.path) paths.push(parsed.path);
  });

  const version = typeof doc.version === "number" ? doc.version : undefined;
  return {
    status: "ok",
    ...(version !== undefined ? { version } : {}),
    terms,
    entities,
    relationships,
    paths,
    rawRelationships: [],
    problems,
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Lowercase words of a phrase, accents and punctuation dropped. */
export function phraseWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** `customers` → `customer`, so a plural still finds the entry. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice over character bigrams: 1 for equal strings, 0 for none. */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [gram, count] of left) {
    shared += Math.min(count, right.get(gram) ?? 0);
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * How well a query phrase names a candidate (an entry's name, label or
 * synonym), 0..1:
 *
 * - 1: the same words.
 * - 0.95: the same words once plurals are dropped ("paying customers").
 * - 0.8: every word of the candidate is in the query ("what is our MRR").
 * - up to 0.75: the query is a strict part of a longer candidate.
 * - otherwise the spelling similarity, so a typo still lands.
 */
export function phraseSimilarity(query: string, candidate: string): number {
  const q = phraseWords(query);
  const c = phraseWords(candidate);
  if (q.length === 0 || c.length === 0) return 0;
  const qText = q.join(" ");
  const cText = c.join(" ");
  if (qText === cText) return 1;
  const qs = q.map(singular);
  const cs = c.map(singular);
  if (qs.join(" ") === cs.join(" ")) return 0.95;
  const qSet = new Set(qs);
  const cSet = new Set(cs);
  if (qSet.size === cSet.size && [...qSet].every(w => cSet.has(w))) return 0.9;
  if ([...cSet].every(w => qSet.has(w))) return 0.8;
  if ([...qSet].every(w => cSet.has(w))) {
    return 0.75 * (qSet.size / cSet.size);
  }
  return dice(qs.join(" "), cs.join(" ")) * 0.9;
}

/** At or above this, a phrase is taken to mean the entry. */
export const REGISTRY_MATCH_THRESHOLD = 0.7;

export interface RegistryMatch {
  entry: RegistryEntry;
  score: number;
  /** Which of the entry's names matched: `name`, `label` or `synonym`. */
  matchedOn: "name" | "label" | "synonym";
  matchedText: string;
}

function entryNames(
  entry: RegistryEntry,
): Array<{ field: RegistryMatch["matchedOn"]; text: string }> {
  return [
    { field: "name" as const, text: entry.name },
    ...(entry.label ? [{ field: "label" as const, text: entry.label }] : []),
    ...entry.synonyms.map(text => ({ field: "synonym" as const, text })),
  ];
}

/** Every registry entry scored against a phrase, best first. */
export function scoreRegistry(
  registry: OntologyRegistry,
  query: string,
): RegistryMatch[] {
  const out: RegistryMatch[] = [];
  for (const entry of [...registry.terms, ...registry.entities]) {
    let best: RegistryMatch | undefined;
    for (const { field, text } of entryNames(entry)) {
      const score = phraseSimilarity(query, text);
      if (!best || score > best.score) {
        best = { entry, score, matchedOn: field, matchedText: text };
      }
    }
    if (best && best.score > 0) out.push(best);
  }
  return out.sort(
    (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
  );
}

/** The entries a phrase names (score at or above the threshold), best first. */
export function matchRegistry(
  registry: OntologyRegistry,
  query: string,
): RegistryMatch[] {
  return scoreRegistry(registry, query).filter(
    match => match.score >= REGISTRY_MATCH_THRESHOLD,
  );
}

/** What the registry says a model is, by model name (lowercased). */
export interface ModelRegistryRoles {
  canonicalFor: Array<{
    kind: "term" | "entity";
    name: string;
    column?: string;
    primaryKey?: string | string[];
  }>;
  /**
   * Terms and entities that list the model as a known variant of their
   * canonical one. `kind` is absent for a term (the first registry schema).
   */
  variantOf: Array<{
    kind?: "entity";
    term: string;
    canonicalModel?: string;
    canonicalColumn?: string;
    difference?: string;
  }>;
}

export function registryRolesByModel(
  registry: OntologyRegistry,
): Map<string, ModelRegistryRoles> {
  const out = new Map<string, ModelRegistryRoles>();
  const rolesOf = (model: string): ModelRegistryRoles => {
    const key = model.toLowerCase();
    let roles = out.get(key);
    if (!roles) out.set(key, (roles = { canonicalFor: [], variantOf: [] }));
    return roles;
  };
  for (const term of registry.terms) {
    if (term.canonical) {
      rolesOf(term.canonical.model).canonicalFor.push({
        kind: "term",
        name: term.name,
        ...(term.canonical.column ? { column: term.canonical.column } : {}),
      });
    }
    for (const variant of term.knownVariants) {
      rolesOf(variant.model).variantOf.push({
        term: term.name,
        ...(term.canonical
          ? {
              canonicalModel: term.canonical.model,
              ...(term.canonical.column
                ? { canonicalColumn: term.canonical.column }
                : {}),
            }
          : {}),
        ...(variant.difference ? { difference: variant.difference } : {}),
      });
    }
  }
  for (const entity of registry.entities) {
    for (const variant of entity.knownVariants) {
      rolesOf(variant.model).variantOf.push({
        kind: "entity",
        term: entity.name,
        ...(entity.canonical ? { canonicalModel: entity.canonical.model } : {}),
        ...(variant.difference ? { difference: variant.difference } : {}),
      });
    }
    if (!entity.canonical) continue;
    rolesOf(entity.canonical.model).canonicalFor.push({
      kind: "entity",
      name: entity.name,
      ...(entity.canonical.primaryKey
        ? { primaryKey: entity.canonical.primaryKey }
        : {}),
    });
  }
  return out;
}
