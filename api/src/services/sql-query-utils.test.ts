import {
  findTopLevelKeyword,
  appendWhereCondition,
  appendSqlClause,
} from "./sql-query-utils";

/* ------------------------------------------------------------------ */
/*  findTopLevelKeyword                                               */
/* ------------------------------------------------------------------ */

describe("findTopLevelKeyword", () => {
  const WHERE = /^WHERE\b/i;
  const ORDER_BY = /^ORDER\s+BY\b/i;

  // --- basic matching ---

  it("returns -1 when the keyword is absent", () => {
    expect(findTopLevelKeyword("SELECT 1", WHERE)).toBe(-1);
  });

  it("finds a top-level WHERE", () => {
    const q = "SELECT * FROM t WHERE id = 1";
    expect(findTopLevelKeyword(q, WHERE)).toBe(q.indexOf("WHERE"));
  });

  it("finds a top-level ORDER BY", () => {
    const q = "SELECT * FROM t ORDER BY id";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(q.indexOf("ORDER"));
  });

  // --- parenthesized subqueries ---

  it("ignores keyword inside parentheses (subquery)", () => {
    const q =
      "SELECT * FROM (SELECT * FROM t WHERE id = 1 ORDER BY id) sub WHERE x = 2";
    expect(findTopLevelKeyword(q, WHERE)).toBe(q.lastIndexOf("WHERE"));
  });

  // --- single-quoted strings ---

  it("ignores keyword inside single-quoted string", () => {
    const q = "SELECT * FROM t WHERE name = 'WHERE ORDER BY'";
    // Only the first (real) WHERE should be found
    expect(findTopLevelKeyword(q, WHERE)).toBe(q.indexOf("WHERE"));
    // ORDER BY is inside a string; should not be found
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(-1);
  });

  it("handles escaped quotes (doubled single quotes)", () => {
    const q = "SELECT * FROM t WHERE name = 'it''s ORDER BY fun'";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(-1);
  });

  // --- double-quoted identifiers ---

  it("ignores keyword inside double-quoted identifier", () => {
    const q = 'SELECT "WHERE" FROM t WHERE id = 1';
    // Only the real WHERE should be found, not the one inside double quotes
    expect(findTopLevelKeyword(q, WHERE)).toBe(q.lastIndexOf("WHERE"));
  });

  it("ignores ORDER BY inside double-quoted identifier", () => {
    const q = 'SELECT "ORDER BY" FROM t ORDER BY id';
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(q.lastIndexOf("ORDER"));
  });

  it("returns -1 when keyword is only inside a double-quoted identifier", () => {
    const q = 'SELECT "ORDER BY" FROM t';
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(-1);
  });

  it("handles escaped double quotes inside identifier (doubled)", () => {
    const q = 'SELECT "col""ORDER" FROM t ORDER BY id';
    // The ORDER inside the identifier is escaped; real ORDER BY is at end
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(q.lastIndexOf("ORDER"));
  });

  it("handles double-quoted identifier containing single quotes text", () => {
    const q = 'SELECT "WHERE\'s" FROM t WHERE id = 1';
    expect(findTopLevelKeyword(q, WHERE)).toBe(q.lastIndexOf("WHERE"));
  });

  // --- line comments (--) ---

  it("ignores keyword inside a line comment", () => {
    const q = "SELECT * FROM t -- WHERE hidden\nWHERE id = 1";
    expect(findTopLevelKeyword(q, WHERE)).toBe(q.lastIndexOf("WHERE"));
  });

  it("returns -1 when keyword is only inside a line comment", () => {
    const q = "SELECT * FROM t -- ORDER BY id";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(-1);
  });

  it("handles line comment at end of query (no trailing newline)", () => {
    const q = "SELECT * FROM t -- ORDER BY id";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(-1);
  });

  it("handles multiple line comments", () => {
    const q = "SELECT * FROM t -- ORDER BY x\n-- WHERE y = 1\nORDER BY id";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(q.lastIndexOf("ORDER"));
    expect(findTopLevelKeyword(q, WHERE)).toBe(-1);
  });

  // --- block comments (/* ... */) ---

  it("ignores keyword inside a block comment", () => {
    const q = "SELECT * FROM t /* WHERE hidden */ WHERE id = 1";
    expect(findTopLevelKeyword(q, WHERE)).toBe(q.lastIndexOf("WHERE"));
  });

  it("returns -1 when keyword is only inside a block comment", () => {
    const q = "SELECT * FROM t /* ORDER BY id */";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(-1);
  });

  it("handles multi-line block comment", () => {
    const q =
      "SELECT * FROM t /* \n ORDER BY id \n WHERE x = 1 \n */ ORDER BY name";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(q.lastIndexOf("ORDER"));
    expect(findTopLevelKeyword(q, WHERE)).toBe(-1);
  });

  it("handles unclosed block comment (keyword unreachable)", () => {
    const q = "SELECT * FROM t /* ORDER BY id";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(-1);
  });

  // --- mixed scenarios ---

  it("handles comment inside parentheses", () => {
    const q =
      "SELECT * FROM (SELECT * FROM t /* ORDER BY id */) sub ORDER BY name";
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(q.lastIndexOf("ORDER"));
  });

  it("handles comment followed by string followed by keyword", () => {
    const q = "SELECT * FROM t /* WHERE */ WHERE name = 'ORDER BY' ORDER BY id";
    expect(findTopLevelKeyword(q, WHERE)).toBe(
      q.indexOf("WHERE", q.indexOf("*/")),
    );
    expect(findTopLevelKeyword(q, ORDER_BY)).toBe(q.lastIndexOf("ORDER"));
  });
});

/* ------------------------------------------------------------------ */
/*  appendWhereCondition                                              */
/* ------------------------------------------------------------------ */

describe("appendWhereCondition", () => {
  const cond = "updated_at > '2024-01-01'";

  it("appends WHERE when no existing WHERE or trailing clause", () => {
    const q = "SELECT * FROM t";
    expect(appendWhereCondition(q, cond)).toBe(`SELECT * FROM t WHERE ${cond}`);
  });

  it("appends AND when WHERE already exists", () => {
    const q = "SELECT * FROM t WHERE id > 10";
    expect(appendWhereCondition(q, cond)).toBe(
      `SELECT * FROM t WHERE id > 10 AND ${cond}`,
    );
  });

  it("inserts WHERE before ORDER BY", () => {
    const q = "SELECT * FROM t ORDER BY id";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(`SELECT * FROM t WHERE ${cond} ORDER BY id`);
  });

  it("inserts AND before ORDER BY when WHERE already exists", () => {
    const q = "SELECT * FROM t WHERE id > 10 ORDER BY id";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(
      `SELECT * FROM t WHERE id > 10 AND ${cond} ORDER BY id`,
    );
  });

  it("does not break when ORDER BY is inside a line comment", () => {
    const q = "SELECT * FROM t -- ORDER BY id\nWHERE x = 1";
    const result = appendWhereCondition(q, cond);
    // Should append AND to the existing WHERE, not insert before the comment
    expect(result).toBe(
      `SELECT * FROM t -- ORDER BY id\nWHERE x = 1 AND ${cond}`,
    );
  });

  it("does not break when ORDER BY is inside a block comment", () => {
    const q = "SELECT * FROM t /* ORDER BY id */ WHERE x = 1";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(
      `SELECT * FROM t /* ORDER BY id */ WHERE x = 1 AND ${cond}`,
    );
  });

  it("inserts WHERE before real ORDER BY, ignoring commented one", () => {
    const q = "SELECT * FROM t /* ORDER BY id */ ORDER BY name";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(
      `SELECT * FROM t /* ORDER BY id */ WHERE ${cond} ORDER BY name`,
    );
  });

  it("handles ORDER BY only in a line comment with real ORDER BY after", () => {
    const q = "SELECT * FROM t -- ORDER BY x\nORDER BY name";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(
      `SELECT * FROM t -- ORDER BY x\nWHERE ${cond} ORDER BY name`,
    );
  });

  it("inserts newline before WHERE when query ends with a line comment (no trailing clause)", () => {
    const q = "SELECT * FROM t -- filter";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(`SELECT * FROM t -- filter\nWHERE ${cond}`);
  });

  it("inserts newline before AND when query ends with a line comment (no trailing clause)", () => {
    const q = "SELECT * FROM t WHERE active = true -- filter";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(
      `SELECT * FROM t WHERE active = true -- filter\nAND ${cond}`,
    );
  });

  it("trims trailing whitespace even with trailing line comment", () => {
    const q = "SELECT * FROM t WHERE active = true -- filter   ";
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(
      `SELECT * FROM t WHERE active = true -- filter\nAND ${cond}`,
    );
  });

  it("does not break when ORDER BY is inside a double-quoted identifier", () => {
    const q = 'SELECT "ORDER BY" FROM t WHERE x = 1';
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(`SELECT "ORDER BY" FROM t WHERE x = 1 AND ${cond}`);
  });

  it("inserts WHERE before real ORDER BY, ignoring double-quoted one", () => {
    const q = 'SELECT "ORDER" FROM t ORDER BY name';
    const result = appendWhereCondition(q, cond);
    expect(result).toBe(`SELECT "ORDER" FROM t WHERE ${cond} ORDER BY name`);
  });
});

/* ------------------------------------------------------------------ */
/*  appendSqlClause                                                   */
/* ------------------------------------------------------------------ */

describe("appendSqlClause", () => {
  it("appends clause with a space when no trailing line comment", () => {
    const q = "SELECT * FROM t WHERE id > 10";
    expect(appendSqlClause(q, "ORDER BY id")).toBe(
      "SELECT * FROM t WHERE id > 10 ORDER BY id",
    );
  });

  it("inserts newline before clause when query ends with a line comment", () => {
    const q = "SELECT * FROM t WHERE active = true -- filter";
    expect(appendSqlClause(q, "ORDER BY id")).toBe(
      "SELECT * FROM t WHERE active = true -- filter\nORDER BY id",
    );
  });

  it("inserts newline before LIMIT when query ends with a line comment", () => {
    const q = "SELECT * FROM t -- comment";
    expect(appendSqlClause(q, "LIMIT 100")).toBe(
      "SELECT * FROM t -- comment\nLIMIT 100",
    );
  });

  it("trims trailing whitespace before appending", () => {
    const q = "SELECT * FROM t   ";
    expect(appendSqlClause(q, "ORDER BY id")).toBe(
      "SELECT * FROM t ORDER BY id",
    );
  });

  it("handles query ending with block comment (no newline needed)", () => {
    const q = "SELECT * FROM t /* comment */";
    expect(appendSqlClause(q, "ORDER BY id")).toBe(
      "SELECT * FROM t /* comment */ ORDER BY id",
    );
  });
});
