/**
 * Free-text app search, the pure half: what a binding query reads, and how
 * well an app matches a query. Used by the `search_apps` agent tool so an
 * agent asked to "build a dashboard of leads by canton" finds the app that
 * already does it before scaffolding a near-copy. No git, no Mongo here.
 */

/** The tables a binding's SQL reads, lowercased, unquoted, CTEs excluded. */
export function extractTables(sql: string): string[] {
  const text = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // `EXTRACT(year FROM d)`, `SUBSTRING(s FROM 2)`, `TRIM(x FROM s)`: a
    // FROM inside these calls reads no table.
    .replace(
      /\b(?:extract|substring|trim|position|overlay)\s*\([^()]*\)/gi,
      " ",
    );
  const ctes = new Set<string>();
  for (const m of text.matchAll(
    /(?:\bwith|,)\s+(?:recursive\s+)?([A-Za-z_][\w]*)\s+as\s*\(/gi,
  )) {
    ctes.add(m[1].toLowerCase());
  }
  const ident = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$-]*)`;
  const re = new RegExp(
    String.raw`\b(?:from|join)\s+(${ident}(?:\s*\.\s*${ident}){0,2})`,
    "gi",
  );
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const name = m[1]
      .replace(/\s+/g, "")
      .replace(/[\x60"[\]]/g, "")
      .toLowerCase();
    if (!name || ctes.has(name)) continue;
    // `FROM (SELECT …)`, `FROM unnest(…)`, `EXTRACT(x FROM y)` are not tables.
    if (/^(select|unnest|lateral|generate_series)$/.test(name)) continue;
    out.add(name);
  }
  return [...out].sort();
}

export interface SearchableApp {
  appId: string;
  path: string;
  title: string;
  description?: string;
  /** Owner's handle, for a personal app or a known creator. */
  owner?: string;
  tables: string[];
  /** Popularity (app-usage score), when usage is known. */
  usageScore?: number;
}

export interface AppSearchHit extends SearchableApp {
  score: number;
  matchedOn: string[];
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "apps",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "with",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/** Field weights: a title hit says more than a hit in some table name. */
const FIELDS: Array<{
  name: string;
  weight: number;
  text: (app: SearchableApp) => string;
}> = [
  { name: "title", weight: 5, text: a => a.title },
  { name: "description", weight: 2, text: a => a.description ?? "" },
  { name: "path", weight: 2, text: a => a.path },
  { name: "tables", weight: 3, text: a => a.tables.join(" ") },
  { name: "owner", weight: 1, text: a => a.owner ?? "" },
];

/** A query token matches a field token exactly, or as a prefix of 3+ chars. */
export function tokenMatch(q: string, words: readonly string[]): number {
  let best = 0;
  for (const w of words) {
    if (w === q) return 1;
    // `lead` finds `leads`; `leadership` does not find `lead` unless the
    // shorter word is itself substantial.
    const prefix = w.startsWith(q) || (q.startsWith(w) && w.length >= 4);
    if (q.length >= 3 && prefix) {
      best = Math.max(best, 0.6);
    }
  }
  return best;
}

/**
 * Rank apps for a query. Every query token contributes its best field
 * match; apps matching more of the query rank above apps matching one word
 * many times, and usage only breaks ties between comparable matches.
 */
export function rankApps(
  apps: SearchableApp[],
  query: string,
  options: {
    limit?: number;
    /** Semantic signals (app-search.service); absent: lexical alone. */
    related?: RelatedSignals | null;
  } = {},
): AppSearchHit[] {
  const limit = options.limit ?? 10;
  const lexical = lexicalHits(apps, query);
  if (!options.related || options.related.similarity.size === 0) {
    return lexical.slice(0, limit);
  }
  return blendRelated(lexical, apps, query, options.related, { limit });
}

/** What semantic search knows about each app, for one query. */
export interface RelatedSignals {
  /** appId → cosine similarity of the app's document to the query. */
  similarity: ReadonlyMap<string, number>;
  /**
   * appId → the words of the app's search document (README, UI labels):
   * what the index's fields do not hold.
   */
  terms?: ReadonlyMap<string, readonly string[]>;
}

/**
 * When an app is "related" to a query. Calibrated on the RealAdvisor
 * workspace (116 apps, text-embedding-3-small over app-embedding-doc's
 * documents). Cosines there are compressed and shift per query: the median
 * app sits at 0.14 for "zebra" and 0.32 for "investor deck". So the bar is
 * relative — RELATED_MIN_Z standard deviations above the workspace's mean
 * for this query — with an absolute floor that nonsense queries never reach
 * (their best app scores ~0.22; weak associations sit at 0.25–0.26).
 */
export const RELATED_MIN_SIMILARITY = 0.27;
export const RELATED_MIN_Z = 1.8;
/** Below this many apps the spread says nothing: an absolute bar only. */
export const RELATED_MIN_POPULATION = 20;
export const RELATED_SMALL_WORKSPACE_SIMILARITY = 0.35;
/** Semantic-only results shown at most, after every lexical hit. */
export const RELATED_MAX = 12;
/** The match reason a semantic-only hit carries. */
export const RELATED_MATCH = "related";

/** The similarity an app needs to be related, given every app's score. */
export function relatedThreshold(sims: number[]): number {
  if (sims.length < RELATED_MIN_POPULATION) {
    return RELATED_SMALL_WORKSPACE_SIMILARITY;
  }
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const sd = Math.sqrt(
    sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length,
  );
  return Math.max(RELATED_MIN_SIMILARITY, mean + RELATED_MIN_Z * sd);
}

/**
 * Lexical hits first, in their order (semantic similarity breaks exact
 * ties), then the apps the index's words missed, closest first, at most
 * RELATED_MAX, marked `related`:
 *
 * - similar enough on meaning alone (relatedThreshold), or
 * - every query word is in the app's document (a README, a UI label: the
 *   "Acquisition channel" filter of a sales dashboard) and the app is at
 *   least as similar as the workspace's average app.
 *
 * Their score is the similarity, so it never outranks a word match.
 */
export function blendRelated(
  lexical: AppSearchHit[],
  apps: SearchableApp[],
  query: string,
  related: RelatedSignals,
  options: { limit: number; maxRelated?: number },
): AppSearchHit[] {
  const { similarity, terms } = related;
  const sim = (id: string) => similarity.get(id) ?? 0;
  const words = [...lexical].sort(
    (a, b) =>
      b.score - a.score ||
      sim(b.appId) - sim(a.appId) ||
      a.path.localeCompare(b.path),
  );
  const scored = apps.filter(a => similarity.has(a.appId));
  const all = scored.map(a => sim(a.appId));
  const threshold = relatedThreshold(all);
  const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 1;
  const tokens = [...new Set(tokenize(query))];
  const inDocument = (id: string) => {
    const t = terms?.get(id);
    return !!t && tokens.length > 0 && tokens.every(q => tokenMatch(q, t) > 0);
  };
  const found = new Set(words.map(h => h.appId));
  const extra: AppSearchHit[] = scored
    .filter(a => {
      if (found.has(a.appId)) return false;
      const s = sim(a.appId);
      return s >= threshold || (s >= mean && inDocument(a.appId));
    })
    .sort((a, b) => sim(b.appId) - sim(a.appId) || a.path.localeCompare(b.path))
    .slice(0, options.maxRelated ?? RELATED_MAX)
    .map(a => ({
      ...a,
      score: Math.round(sim(a.appId) * 100) / 100,
      matchedOn: [RELATED_MATCH],
    }));
  return [...words, ...extra].slice(0, options.limit);
}

/** Every app the query's words match, best first (no limit). */
function lexicalHits(apps: SearchableApp[], query: string): AppSearchHit[] {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const hits: AppSearchHit[] = [];
  for (const app of apps) {
    const fieldWords = FIELDS.map(f => ({
      ...f,
      words: tokenize(f.text(app)),
    }));
    let score = 0;
    let matched = 0;
    const matchedOn = new Set<string>();
    for (const q of tokens) {
      let best = 0;
      for (const f of fieldWords) {
        const m = tokenMatch(q, f.words) * f.weight;
        if (m > 0) matchedOn.add(f.name);
        best = Math.max(best, m);
      }
      if (best > 0) matched++;
      score += best;
    }
    if (matched === 0) continue;
    // Coverage: a query is a description of the app; matching all of it
    // matters more than matching one word hard.
    score *= matched / tokens.length;
    if (phrase.length > 3 && app.title.toLowerCase().includes(phrase)) {
      score += 5;
    }
    if (app.usageScore && app.usageScore > 0) {
      score += Math.log1p(app.usageScore) * 0.5;
    }
    hits.push({
      ...app,
      score: Math.round(score * 100) / 100,
      matchedOn: [...matchedOn],
    });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits;
}
