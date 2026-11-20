/**
 * The schema gap: the models a held app cannot run without. Pure over a fake
 * warehouse; no dbt, BigQuery or Mongo.
 */
import { describe, expect, it, vi } from "vitest";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { BigQueryDriverCore } from "../databases/drivers/bigquery/driver-core";
import { parseDbtCommand } from "../dbt/commands";
import {
  compileGraphCommand,
  findSchemaGap,
  gapGraphFromManifest,
  relationKey,
  warehouseLookupFor,
  type GapGraph,
  type GapModel,
  type WarehouseLookup,
} from "./dbt-schema-gap";

const rel = (table: string) => ({ project: "p", dataset: "prod", table });

function graphOf(
  models: Array<Partial<GapModel> & { name: string }>,
): GapGraph {
  return new Map(
    models.map(m => [
      m.name,
      {
        parents: [],
        relation: rel(m.name),
        compiledSql: `select * from ${m.name}`,
        ...m,
      } as GapModel,
    ]),
  );
}

/**
 * prod: table to columns (absent table = missing relation).
 * compiled: model to the columns its SQL returns (absent = dry run fails).
 */
function warehouse(
  prod: Record<string, string[]>,
  compiled: Record<string, string[]>,
): WarehouseLookup & { prodCalls: string[][] } {
  const prodCalls: string[][] = [];
  return {
    prodCalls,
    async prodColumns(relations) {
      prodCalls.push(relations.map(r => r.table));
      const out = new Map<string, Set<string>>();
      for (const r of relations) {
        if (prod[r.table]) {
          out.set(
            relationKey(r),
            new Set(prod[r.table].map(c => c.toLowerCase())),
          );
        }
      }
      return out;
    },
    async queryColumns(sql) {
      const model = /from (\w+)/.exec(sql)?.[1] ?? "";
      return compiled[model] ?? null;
    },
  };
}

describe("findSchemaGap", () => {
  it("builds a model whose prod relation is missing", async () => {
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "fct_new" }]),
      reads: ["fct_new"],
      warehouse: warehouse({}, { fct_new: ["id"] }),
    });
    expect(gap.models).toEqual(["fct_new"]);
    expect(gap.reasons).toEqual({ fct_new: "missing" });
  });

  it("builds a model whose compiled columns include one prod lacks", async () => {
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "fct_loop" }]),
      reads: ["fct_loop"],
      warehouse: warehouse(
        { fct_loop: ["id", "amount"] },
        { fct_loop: ["id", "amount", "Closed_At"] },
      ),
    });
    expect(gap.models).toEqual(["fct_loop"]);
    expect(gap.reasons).toEqual({ fct_loop: "new-columns" });
    expect(gap.newColumns).toEqual({ fct_loop: ["closed_at"] });
  });

  it("builds nothing for a logic-only change", async () => {
    // Same columns (any case, any order): the 19 Nov table.
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "fct_plan_daily" }]),
      reads: ["fct_plan_daily"],
      warehouse: warehouse(
        { fct_plan_daily: ["day", "Plan_Id"] },
        { fct_plan_daily: ["PLAN_ID", "day"] },
      ),
    });
    expect(gap).toEqual({ models: [], reasons: {}, newColumns: {} });
  });

  it("ignores a column prod has and the model dropped", async () => {
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "fct_a" }]),
      reads: ["fct_a"],
      warehouse: warehouse({ fct_a: ["id", "old"] }, { fct_a: ["id"] }),
    });
    expect(gap.models).toEqual([]);
  });

  it("includes a parent that lacks the column too, and stops above it", async () => {
    const graph = graphOf([
      { name: "fct_loop", parents: ["int_loop"] },
      { name: "int_loop", parents: ["stg_loop"] },
      { name: "stg_loop" },
    ]);
    const wh = warehouse(
      {
        fct_loop: ["id"],
        int_loop: ["id"],
        stg_loop: ["id", "closed_at"],
      },
      {
        fct_loop: ["id", "closed_at"],
        int_loop: ["id", "closed_at"],
        stg_loop: ["id", "closed_at"],
      },
    );
    const gap = await findSchemaGap({
      graph,
      reads: ["fct_loop"],
      warehouse: wh,
    });
    // stg_loop already has the column in prod: the walk stops at int_loop.
    expect(gap.models).toEqual(["fct_loop", "int_loop"]);
  });

  it("leaves a parent out when prod already has the column", async () => {
    const graph = graphOf([
      { name: "fct_loop", parents: ["int_loop"] },
      { name: "int_loop" },
    ]);
    const gap = await findSchemaGap({
      graph,
      reads: ["fct_loop"],
      warehouse: warehouse(
        { fct_loop: ["id"], int_loop: ["id", "closed_at"] },
        { fct_loop: ["id", "closed_at"], int_loop: ["id", "closed_at"] },
      ),
    });
    expect(gap.models).toEqual(["fct_loop"]);
  });

  it("builds a missing parent chain, however long", async () => {
    const graph = graphOf([
      { name: "fct_x", parents: ["int_x"] },
      { name: "int_x", parents: ["stg_x"] },
      { name: "stg_x" },
    ]);
    const gap = await findSchemaGap({
      graph,
      reads: ["fct_x"],
      warehouse: warehouse({}, {}),
    });
    expect(gap.models).toEqual(["fct_x", "int_x", "stg_x"]);
  });

  it("treats SQL that cannot be dry-run as a gap, and walks to its gap parent", async () => {
    // fct selects a column its prod parent lacks: its dry run errors.
    const graph = graphOf([
      { name: "fct_loop", parents: ["int_loop"] },
      { name: "int_loop" },
    ]);
    const gap = await findSchemaGap({
      graph,
      reads: ["fct_loop"],
      warehouse: warehouse(
        { fct_loop: ["id"], int_loop: ["id"] },
        { int_loop: ["id", "closed_at"] },
      ),
    });
    expect(gap.models).toEqual(["fct_loop", "int_loop"]);
    expect(gap.reasons).toEqual({
      fct_loop: "unverified",
      int_loop: "new-columns",
    });
  });

  it("treats a model with no compiled SQL as unverified", async () => {
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "fct_a", compiledSql: undefined }]),
      reads: ["fct_a"],
      warehouse: warehouse({ fct_a: ["id"] }, {}),
    });
    expect(gap.reasons).toEqual({ fct_a: "unverified" });
  });

  it("skips a model the manifest lacks or that has no relation", async () => {
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "eph", relation: null }]),
      reads: ["eph", "ghost"],
      warehouse: warehouse({}, {}),
    });
    expect(gap.models).toEqual([]);
  });

  it("looks each relation up once and builds each model once", async () => {
    const graph = graphOf([
      { name: "a", parents: ["shared"] },
      { name: "b", parents: ["shared"] },
      { name: "shared" },
    ]);
    const wh = warehouse({}, {});
    const gap = await findSchemaGap({
      graph,
      reads: ["a", "b", "a"],
      warehouse: wh,
    });
    expect(gap.models).toEqual(["a", "b", "shared"]);
    expect(wh.prodCalls.flat().sort()).toEqual(["a", "b", "shared"]);
  });
});

describe("gapGraphFromManifest", () => {
  it("reads relations, model parents and compiled SQL from a compiled manifest", () => {
    const graph = gapGraphFromManifest({
      nodes: {
        "model.x.fct": {
          name: "fct",
          resource_type: "model",
          relation_name: "`proj`.`prod`.`fct`",
          compiled_code: "select 1 as id",
          depends_on: { nodes: ["model.x.int", "seed.x.s"] },
        },
        "model.x.int": {
          name: "int",
          resource_type: "model",
          relation_name: "`proj`.`prod`.`int_alias`",
          compiled_sql: "select 1 as id",
        },
        "seed.x.s": { name: "s", resource_type: "seed" },
        "test.x.t": { name: "t", resource_type: "test" },
      },
      parent_map: { "model.x.fct": ["model.x.int", "seed.x.s"] },
    } as never);
    expect([...graph.keys()].sort()).toEqual(["fct", "int"]);
    expect(graph.get("fct")).toEqual({
      name: "fct",
      parents: ["int"],
      relation: { project: "proj", dataset: "prod", table: "fct" },
      compiledSql: "select 1 as id",
    });
    expect(graph.get("int")?.relation?.table).toBe("int_alias");
    expect(graph.get("int")?.compiledSql).toBe("select 1 as id");
  });

  it("gives a model without a relation a null relation", () => {
    const graph = gapGraphFromManifest({
      nodes: { "model.x.e": { name: "e", resource_type: "model" } },
    } as never);
    expect(graph.get("e")?.relation).toBeNull();
  });
});

describe("compileGraphCommand", () => {
  it("compiles each read model with its ancestors, in a form the parser accepts", () => {
    const command = compileGraphCommand([
      "fct_b",
      "fct_a",
      "fct_b",
      "Bad;Name",
    ]);
    expect(command).toBe("compile --select +fct_a +fct_b");
    expect(parseDbtCommand(command).subcommand).toBe("compile");
  });
});

describe("warehouseLookupFor", () => {
  const connection = { type: "bigquery" } as unknown as IDatabaseConnection;
  const driver = new BigQueryDriverCore();

  it("lists prod columns with one query per dataset", async () => {
    const runQuery = vi.fn(async (_c: IDatabaseConnection, sql: string) => ({
      success: true,
      data: sql.includes("`prod`")
        ? [
            { table_name: "a", column_name: "Id" },
            { table_name: "a", column_name: "x" },
          ]
        : [{ table_name: "c", column_name: "id" }],
    }));
    const lookup = warehouseLookupFor(connection, { runQuery, driver });
    const out = await lookup.prodColumns([
      { project: "p", dataset: "prod", table: "a" },
      { project: "p", dataset: "prod", table: "b" },
      { project: "p", dataset: "other", table: "c" },
    ]);
    expect(runQuery).toHaveBeenCalledTimes(2);
    const sql = runQuery.mock.calls.map(c => c[1]).join("\n");
    expect(sql).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(out.get("p.prod.a")).toEqual(new Set(["id", "x"]));
    expect(out.has("p.prod.b")).toBe(false);
    expect(out.get("p.other.c")).toEqual(new Set(["id"]));
  });

  it("treats a dataset prod never created as missing relations", async () => {
    const runQuery = vi.fn(async () => ({
      success: false,
      error: "Not found: Dataset p:prod",
    }));
    const lookup = warehouseLookupFor(connection, { runQuery, driver });
    const out = await lookup.prodColumns([rel("a")]);
    expect(out.size).toBe(0);
  });

  it("throws on any other query error, so the push deploys at once", async () => {
    const runQuery = vi.fn(async () => ({ success: false, error: "denied" }));
    const lookup = warehouseLookupFor(connection, { runQuery, driver });
    await expect(lookup.prodColumns([rel("a")])).rejects.toThrow("denied");
  });

  it("returns a dry run's column names, or null when it fails", async () => {
    const querySchema = vi
      .fn()
      .mockResolvedValueOnce({ success: true, columns: [{ name: "id" }] })
      .mockResolvedValueOnce({ success: false });
    const lookup = warehouseLookupFor(connection, { querySchema, driver });
    expect(await lookup.queryColumns("select 1")).toEqual(["id"]);
    expect(await lookup.queryColumns("select bad")).toBeNull();
  });

  it("refuses an engine other than BigQuery", () => {
    expect(() =>
      warehouseLookupFor({
        type: "postgresql",
      } as unknown as IDatabaseConnection),
    ).toThrow(/BigQuery/);
  });
});
