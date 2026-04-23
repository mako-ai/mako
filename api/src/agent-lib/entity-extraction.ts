/**
 * Entity extraction for the skills system.
 *
 * Used on both sides of retrieval:
 *   - Write path: when a skill is authored, extract entities from
 *     `loadWhen + body` and union with author-declared entities.
 *   - Read path: on each turn, extract entities from the user query +
 *     short recent context, intersect with skill.entities arrays to
 *     find candidate skills (before semantic re-ranking).
 *
 * Deterministic by design. Keeps tokens that look like identifiers or
 * domain nouns: snake_case / dotted identifiers (e.g. `public.leads`,
 * `customer_email`), camelCase runs, and alphanumeric words >= 3 chars.
 * Lowercases everything and filters common English stopwords.
 *
 * LLM-based extraction is a future upgrade; keeping this path cheap and
 * synchronous lets us run it every turn without latency or cost.
 */

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "any",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "man",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "its",
  "that",
  "this",
  "with",
  "from",
  "they",
  "will",
  "would",
  "there",
  "been",
  "have",
  "were",
  "said",
  "each",
  "which",
  "their",
  "some",
  "when",
  "what",
  "where",
  "about",
  "just",
  "into",
  "over",
  "than",
  "then",
  "them",
  "these",
  "those",
  "your",
  "yours",
  "mine",
  "ours",
  "why",
  "yes",
  "use",
  "using",
  "used",
  "make",
  "made",
  "want",
  "does",
  "doing",
  "done",
  "very",
  "also",
  "only",
  "much",
  "many",
  "most",
  "such",
  "should",
  "could",
  "may",
  "might",
  "must",
  "shall",
  "able",
  "need",
  "want",
  "like",
  "more",
  "less",
  "few",
  "still",
  "between",
  "because",
  "before",
  "after",
  "while",
  "both",
  "either",
  "neither",
  "since",
  "until",
]);

// Drop purely numeric tokens — they're rarely useful as entities
// (dates, row counts, etc.) and would create noise on overlap.
function isPurelyNumeric(token: string): boolean {
  return /^\d+$/.test(token);
}

function splitCamelCase(token: string): string[] {
  // Split camelCase and PascalCase into pieces but keep the original too.
  const pieces = token
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean);
  if (pieces.length > 1) return [token, ...pieces];
  return [token];
}

/**
 * Extract a set of normalized entity tokens from arbitrary text.
 *
 * - Splits on non-identifier characters but preserves `.` and `_` as
 *   part of identifiers (so `public.leads` and `customer_email` stay
 *   intact, while also contributing split pieces `public`, `leads`).
 * - Lowercases, dedupes, drops stopwords and tokens < 3 chars.
 */
export function extractEntities(text: string): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  // Phase 1: grab compound identifiers like `public.leads` or `a.b.c`.
  const compound = text.match(
    /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g,
  );
  if (compound) {
    for (const c of compound) {
      const norm = c.toLowerCase();
      if (!seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
      for (const piece of c.split(".")) {
        const p = piece.toLowerCase();
        if (p.length >= 3 && !STOPWORDS.has(p) && !seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
  }

  // Phase 2: tokenize everything else on non-identifier boundaries.
  const tokens = text.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  for (const raw of tokens) {
    for (const piece of splitCamelCase(raw)) {
      const p = piece.toLowerCase();
      if (p.length < 3) continue;
      if (STOPWORDS.has(p)) continue;
      if (isPurelyNumeric(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }

  return out;
}

/**
 * Overlap count between two entity sets (unordered).
 * Used to rank candidate skills against the current user query.
 */
export function entityOverlap(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let count = 0;
  for (const t of a) {
    if (setB.has(t)) count += 1;
  }
  return count;
}
