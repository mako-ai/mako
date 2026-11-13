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

export interface RegistryEntity {
  kind: "entity";
  name: string;
  label?: string;
  definition?: string;
  owner?: string;
  canonical?: { model: string; primaryKey?: string };
  sources: string[];
  synonyms: string[];
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
  /** What was skipped or wrong, for the agent to relay. */
  problems: string[];
}

export function emptyRegistry(
  status: RegistryStatus,
  problems: string[] = [],
): OntologyRegistry {
  return { status, terms: [], entities: [], problems };
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

function parseCanonical(
  value: unknown,
): { model: string; column?: string; primaryKey?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const model = str(value.model);
  if (!model) return undefined;
  const column = str(value.column);
  const primaryKey = str(value.primary_key);
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
  const variants = Array.isArray(raw.known_variants) ? raw.known_variants : [];
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
    knownVariants: variants.flatMap(item => {
      if (!isRecord(item)) return [];
      const model = str(item.model);
      if (!model) return [];
      return [
        {
          model,
          ...(str(item.difference) ? { difference: str(item.difference) } : {}),
        },
      ];
    }),
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
    canonical: canonical
      ? {
          model: canonical.model,
          ...(canonical.primaryKey ? { primaryKey: canonical.primaryKey } : {}),
        }
      : undefined,
    sources: strList(raw.sources),
    synonyms: strList(raw.synonyms),
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
): OntologyRegistry {
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
  const seen = new Set<string>();
  const readList = (
    key: "terms" | "entities",
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
  const version = typeof doc.version === "number" ? doc.version : undefined;
  return {
    status: "ok",
    ...(version !== undefined ? { version } : {}),
    terms,
    entities,
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
    primaryKey?: string;
  }>;
  /** Terms that list the model as a known variant of their canonical one. */
  variantOf: Array<{
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
