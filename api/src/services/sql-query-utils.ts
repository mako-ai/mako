/**
 * Pure utility helpers for analysing and transforming SQL query strings.
 *
 * These functions are intentionally free of external dependencies so that they
 * can be unit-tested in isolation without pulling in database drivers,
 * Mongoose, or any other heavyweight module.
 */

/**
 * Scan a SQL string and return the position of the first top-level match of
 * the given keyword regex, or -1 if none found.  "Top-level" means the match
 * is NOT inside parenthesized sub-expressions (subqueries, function calls),
 * single-quoted string literals, double-quoted SQL identifiers, line comments
 * (`-- …`), or block comments ({@literal /* … * /}).
 *
 * @param query          The SQL query string to scan.
 * @param anchoredPattern A case-insensitive regex anchored with `^` that will
 *                        be tested against the remainder of the string at each
 *                        candidate position (e.g. `/^WHERE\b/i`).
 */
export function findTopLevelKeyword(
  query: string,
  anchoredPattern: RegExp,
): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  const len = query.length;

  for (let i = 0; i < len; i++) {
    const ch = query[i];

    // Handle single-quoted SQL strings ('' is the escape for a literal quote)
    if (ch === "'" && !inDoubleQuote) {
      if (inSingleQuote) {
        if (i + 1 < len && query[i + 1] === "'") {
          i++; // skip escaped ''
        } else {
          inSingleQuote = false;
        }
      } else {
        inSingleQuote = true;
      }
      continue;
    }

    if (inSingleQuote) continue;

    // Handle double-quoted SQL identifiers ("" is the escape for a literal
    // double-quote inside an identifier, e.g. "col""name")
    if (ch === '"') {
      if (inDoubleQuote) {
        if (i + 1 < len && query[i + 1] === '"') {
          i++; // skip escaped ""
        } else {
          inDoubleQuote = false;
        }
      } else {
        inDoubleQuote = true;
      }
      continue;
    }

    if (inDoubleQuote) continue;

    // Handle line comments: -- through end of line
    if (ch === "-" && i + 1 < len && query[i + 1] === "-") {
      const newlinePos = query.indexOf("\n", i + 2);
      if (newlinePos === -1) {
        // Comment extends to end of string; no more tokens to find
        return -1;
      }
      i = newlinePos; // loop increment will advance past the newline
      continue;
    }

    // Handle block comments: /* ... */
    if (ch === "/" && i + 1 < len && query[i + 1] === "*") {
      const closePos = query.indexOf("*/", i + 2);
      if (closePos === -1) {
        // Unclosed block comment extends to end of string
        return -1;
      }
      i = closePos + 1; // position on the '/', loop increment moves past it
      continue;
    }

    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    // Only consider keywords at the outermost level
    if (depth > 0) continue;

    // Word-boundary check: the previous character must not be a word character
    if (i > 0 && /\w/.test(query[i - 1])) continue;

    // Test the anchored pattern against the remainder of the string
    if (anchoredPattern.test(query.slice(i))) {
      return i;
    }
  }

  return -1;
}

/**
 * Insert a WHERE/AND condition BEFORE any top-level ORDER BY / GROUP BY /
 * HAVING / LIMIT clauses.  Keywords inside parenthesized subqueries,
 * single-quoted string literals, double-quoted SQL identifiers, line comments
 * (`-- …`), and block comments
 * ({@literal /* … * /}) are correctly ignored so that a query like
 *
 *   SELECT * FROM (SELECT * FROM t ORDER BY id LIMIT 100) sub
 *
 * receives the WHERE clause on the *outer* query rather than inside the
 * subquery.
 */
export function appendWhereCondition(query: string, condition: string): string {
  const clausePattern = /^(ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT)\b/i;
  const wherePattern = /^WHERE\b/i;

  const firstClausePos = findTopLevelKeyword(query, clausePattern);

  if (firstClausePos === -1) {
    // If the query ends with a line comment (-- …), appending directly would
    // place the new clause inside the comment where the SQL engine ignores it.
    // Insert a newline separator in that case so the clause starts on its own line.
    const trimmed = query.trimEnd();
    const endsWithLineComment = /--[^\n]*$/.test(trimmed);
    const separator = endsWithLineComment ? "\n" : " ";

    if (findTopLevelKeyword(trimmed, wherePattern) !== -1) {
      return `${trimmed}${separator}AND ${condition}`;
    }
    return `${trimmed}${separator}WHERE ${condition}`;
  }

  const rawBefore = query.slice(0, firstClausePos);
  const afterClause = query.slice(firstClausePos);

  // Trim trailing whitespace, but if the trimmed text ends with a line
  // comment (-- …) we must keep the newline so the inserted clause doesn't
  // land inside the comment.
  const beforeClause = rawBefore.trimEnd();
  const endsWithLineComment = /--[^\n]*$/.test(beforeClause);
  const separator = endsWithLineComment ? "\n" : " ";

  if (findTopLevelKeyword(beforeClause, wherePattern) !== -1) {
    return `${beforeClause}${separator}AND ${condition} ${afterClause}`;
  }
  return `${beforeClause}${separator}WHERE ${condition} ${afterClause}`;
}

/**
 * Safely append a SQL clause (e.g. `ORDER BY id`, `LIMIT 100`) to a query
 * string.  If the query ends with a line comment (`-- …`), a newline is
 * inserted so the appended clause does not land inside the comment.
 */
export function appendSqlClause(query: string, clause: string): string {
  const trimmed = query.trimEnd();
  const endsWithLineComment = /--[^\n]*$/.test(trimmed);
  const separator = endsWithLineComment ? "\n" : " ";
  return `${trimmed}${separator}${clause}`;
}
