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
function tokenMatch(q: string, words: string[]): number {
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
  options: { limit?: number } = {},
): AppSearchHit[] {
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
  return hits.slice(0, options.limit ?? 10);
}
