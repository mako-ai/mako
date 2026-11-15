import { describe, expect, it } from "vitest";
import { consoleEditorLanguage, findUnknownTableRefs } from "./console-utils";

describe("consoleEditorLanguage", () => {
  it("prefers the file extension, then the connection type", () => {
    expect(consoleEditorLanguage("a.sql", "mongodb")).toBe("sql");
    expect(consoleEditorLanguage("a.json", undefined)).toBe("json");
    expect(consoleEditorLanguage("a.ts", "postgres")).toBe("javascript");
    expect(consoleEditorLanguage(undefined, "mongodb")).toBe("javascript");
    expect(consoleEditorLanguage("q", "postgres")).toBe("sql");
  });
});

describe("findUnknownTableRefs", () => {
  const schema = {
    public: { users: [], orders: [] },
    sales: { deals: [] },
  };

  it("accepts known 1-, 2- and 3-part names", () => {
    expect(
      findUnknownTableRefs(
        "select * from users join sales.deals d join `proj.public.orders`",
        schema,
      ),
    ).toEqual([]);
  });

  it("flags unknown tables with their offsets", () => {
    const sql = "SELECT 1 FROM nope JOIN public.missing AS m";
    const refs = findUnknownTableRefs(sql, schema);
    expect(refs.map(r => r.name)).toEqual(["nope", "public.missing"]);
    expect(sql.slice(refs[0].start, refs[0].end)).toBe("nope");
    expect(sql.slice(refs[1].start, refs[1].end)).toBe("public.missing");
  });

  it("skips templated and over-qualified names", () => {
    expect(
      findUnknownTableRefs("from {{t}} join $x join a.b.c.d", schema),
    ).toEqual([]);
  });
});
