/**
 * The schema gap: the models a held app cannot run without. Pure over a fake
 * warehouse; no dbt, BigQuery or Mongo.
 */
import { describe, expect, it, vi } from "vitest";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { BigQueryDriverCore } from "../databases/drivers/bigquery/driver-core";
import { parseDbtCommand } from "../dbt/commands";
import {
  changedNodeNames,
  compileGraphCommand,
  findSchemaGap,
  gapGraphFromManifest,
  relationKey,
  selectsStar,
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
        kind: "model",
        parents: [],
        relation: rel(m.name),
        compiledSql: `select id from ${m.name}`,
        ...m,
      } as GapModel,
    ]),
  );
}

/**
 * prod: table to columns (absent table = missing relation).
 * compiled: model to the columns its SQL returns (absent = the SQL names a
 * missing table or column).
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
      changed: new Set(["fct_plan_daily"]),
    });
    expect(gap).toEqual({
      models: [],
      reasons: {},
      newColumns: {},
      unfixable: {},
      unknownReads: [],
    });
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

  it("treats SQL that names a missing column as a gap, and walks to its gap parent", async () => {
    // fct selects a column its prod parent lacks: BigQuery says so.
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

  it("skips a model the manifest lacks, and reports it", async () => {
    const gap = await findSchemaGap({
      graph: graphOf([]),
      reads: ["ghost"],
      warehouse: warehouse({}, {}),
    });
    expect(gap.models).toEqual([]);
    expect(gap.unknownReads).toEqual(["ghost"]);
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

  it("finds a model named with capitals from a lowercased binding table", async () => {
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "Fct_Mixed" }]),
      reads: ["fct_mixed"],
      warehouse: warehouse({}, {}),
    });
    expect(gap.models).toEqual(["Fct_Mixed"]);
    expect(gap.unknownReads).toEqual([]);
  });

  it("walks through an ephemeral parent to the model above it", async () => {
    const graph = graphOf([
      { name: "fct_x", parents: ["eph_x"] },
      { name: "eph_x", parents: ["stg_x"], relation: null },
      { name: "stg_x" },
    ]);
    const gap = await findSchemaGap({
      graph,
      reads: ["fct_x"],
      warehouse: warehouse({ fct_x: ["id"] }, { fct_x: ["id", "new_col"] }),
    });
    // fct_x has the gap; stg_x (missing) sits above the ephemeral.
    expect(gap.models).toEqual(["fct_x", "stg_x"]);
  });

  describe("pass-through (`select *`)", () => {
    const graph = (viaStar: boolean) =>
      graphOf([
        {
          name: "fct_loop",
          parents: ["int_loop"],
          compiledSql: viaStar
            ? "select * from fct_loop"
            : "select id from fct_loop",
        },
        { name: "int_loop" },
      ]);
    // int_loop got closed_at in this push; fct_loop's dry run, against prod's
    // old int_loop, still returns only id.
    const wh = () =>
      warehouse(
        { fct_loop: ["id"], int_loop: ["id"] },
        { fct_loop: ["id"], int_loop: ["id", "closed_at"] },
      );

    it("builds a changed parent and the `select *` model above it", async () => {
      const gap = await findSchemaGap({
        graph: graph(true),
        reads: ["fct_loop"],
        warehouse: wh(),
        changed: new Set(["int_loop"]),
      });
      expect(gap.models).toEqual(["fct_loop", "int_loop"]);
      expect(gap.reasons).toEqual({
        fct_loop: "pass-through",
        int_loop: "new-columns",
      });
    });

    it("builds neither when the read model lists its columns", async () => {
      const gap = await findSchemaGap({
        graph: graph(false),
        reads: ["fct_loop"],
        warehouse: wh(),
        changed: new Set(["int_loop"]),
      });
      expect(gap.models).toEqual([]);
    });

    it("ignores an unchanged parent", async () => {
      const gap = await findSchemaGap({
        graph: graph(true),
        reads: ["fct_loop"],
        warehouse: wh(),
      });
      expect(gap.models).toEqual([]);
    });

    it("recognises the star forms and not count(*) or multiplication", () => {
      expect(selectsStar("select * from t")).toBe(true);
      expect(selectsStar("SELECT\n  DISTINCT *\nfrom t")).toBe(true);
      expect(selectsStar("select a, * except (b) from t")).toBe(true);
      expect(selectsStar("select t.* from t")).toBe(true);
      expect(selectsStar("select count(*) as n, a * b from t")).toBe(false);
      expect(selectsStar(undefined)).toBe(false);
    });
  });

  describe("seeds and snapshots", () => {
    it("builds a changed seed that a `select *` model passes through", async () => {
      const graph = graphOf([
        {
          name: "fct_a",
          parents: ["seed_a"],
          compiledSql: "select * from fct_a",
        },
        { name: "seed_a", kind: "seed", compiledSql: undefined },
      ]);
      const gap = await findSchemaGap({
        graph,
        reads: ["fct_a"],
        warehouse: warehouse(
          { fct_a: ["id"], seed_a: ["id"] },
          { fct_a: ["id"] },
        ),
        changed: new Set(["seed_a"]),
      });
      expect(gap.models).toEqual(["fct_a", "seed_a"]);
      expect(gap.reasons.seed_a).toBe("changed-source");
    });

    it("builds a missing snapshot and leaves an unchanged one", async () => {
      const graph = graphOf([
        { name: "fct_a", parents: ["snap_a", "snap_b"] },
        { name: "snap_a", kind: "snapshot", compiledSql: undefined },
        { name: "snap_b", kind: "snapshot", compiledSql: undefined },
      ]);
      const gap = await findSchemaGap({
        graph,
        reads: ["fct_a"],
        warehouse: warehouse(
          { fct_a: ["id"], snap_b: ["id"] },
          { fct_a: ["id", "x"] },
        ),
      });
      expect(gap.models).toEqual(["fct_a", "snap_a"]);
      expect(gap.reasons.snap_a).toBe("missing");
    });
  });

  describe("incremental models", () => {
    const run = (onSchemaChange?: string, prod = { m: ["id"] }) =>
      findSchemaGap({
        graph: graphOf([
          {
            name: "m",
            materialized: "incremental",
            ...(onSchemaChange ? { onSchemaChange } : {}),
          },
        ]),
        reads: ["m"],
        warehouse: warehouse(prod, { m: ["id", "new_col"] }),
      });

    it("does not hold on a new column the default on_schema_change ignores", async () => {
      const gap = await run();
      expect(gap.models).toEqual([]);
      expect(gap.unfixable.m).toMatch(/on_schema_change=ignore/);
    });

    it("does not hold on on_schema_change=fail", async () => {
      const gap = await run("fail");
      expect(gap.models).toEqual([]);
      expect(gap.unfixable.m).toMatch(/on_schema_change=fail/);
    });

    it.each(["append_new_columns", "sync_all_columns"])(
      "builds with on_schema_change=%s",
      async mode => {
        expect((await run(mode)).models).toEqual(["m"]);
      },
    );

    it("builds a missing incremental table: the first run creates it", async () => {
      expect((await run(undefined, {} as never)).models).toEqual(["m"]);
    });
  });

  it("keeps the case of dataset and table names", async () => {
    const graph = new Map([
      [
        "m",
        {
          name: "m",
          kind: "model",
          parents: [],
          relation: { project: "P", dataset: "Prod", table: "M_Tab" },
          compiledSql: "select id from m",
        } as GapModel,
      ],
    ]);
    const seen: string[] = [];
    const wh: WarehouseLookup = {
      async prodColumns(relations) {
        seen.push(
          ...relations.map(r => `${r.project}.${r.dataset}.${r.table}`),
        );
        return new Map([["P.Prod.M_Tab", new Set(["id"])]]);
      },
      async queryColumns() {
        return ["id"];
      },
    };
    const gap = await findSchemaGap({ graph, reads: ["m"], warehouse: wh });
    expect(seen).toEqual(["P.Prod.M_Tab"]);
    expect(gap.models).toEqual([]);
  });
});

/** A small compiled manifest as `dbt compile` writes it. */
const COMPILED_MANIFEST = {
  metadata: { project_name: "acme" },
  nodes: {
    "model.acme.fct_loop": {
      name: "fct_loop",
      resource_type: "model",
      original_file_path: "models/marts/fct_loop.sql",
      relation_name: "`proj-1`.`Prod`.`fct_loop`",
      config: { materialized: "table" },
      compiled_code: "select * from `proj-1`.`Prod`.`int_loop`",
      depends_on: { nodes: ["model.acme.int_loop"] },
    },
    "model.acme.int_loop": {
      name: "int_loop",
      resource_type: "model",
      original_file_path: "models/int/int_loop.sql",
      relation_name: "`proj-1`.`Prod`.`int_loop`",
      config: {
        materialized: "incremental",
        on_schema_change: "append_new_columns",
      },
      compiled_code: "select id, closed_at from int_eph",
      depends_on: { nodes: ["model.acme.int_eph", "seed.acme.countries"] },
    },
    "model.acme.int_eph": {
      name: "int_eph",
      resource_type: "model",
      original_file_path: "models/int/int_eph.sql",
      relation_name: null,
      config: { materialized: "ephemeral" },
      compiled_code: "select 1 as id, 2 as closed_at",
      depends_on: { nodes: ["source.acme.raw.loops"] },
    },
    "seed.acme.countries": {
      name: "countries",
      resource_type: "seed",
      original_file_path: "seeds/countries.csv",
      relation_name: "`proj-1`.`Prod`.`countries`",
    },
    "test.acme.not_null_fct_loop_id": {
      name: "not_null_fct_loop_id",
      resource_type: "test",
      depends_on: { nodes: ["model.acme.fct_loop"] },
    },
  },
  sources: {
    "source.acme.raw.loops": {
      name: "loops",
      source_name: "raw",
      resource_type: "source",
      relation_name: "`proj-1`.`raw`.`loops`",
    },
  },
  parent_map: {
    "model.acme.fct_loop": ["model.acme.int_loop"],
    "model.acme.int_loop": ["model.acme.int_eph", "seed.acme.countries"],
    "model.acme.int_eph": ["source.acme.raw.loops"],
  },
};

describe("gapGraphFromManifest", () => {
  const graph = gapGraphFromManifest(COMPILED_MANIFEST as never);

  it("holds models and seeds, not tests or sources", () => {
    expect([...graph.keys()].sort()).toEqual([
      "countries",
      "fct_loop",
      "int_eph",
      "int_loop",
    ]);
    expect(graph.get("countries")?.kind).toBe("seed");
  });

  it("reads relations with their case, parents, paths and config", () => {
    expect(graph.get("fct_loop")).toEqual({
      name: "fct_loop",
      kind: "model",
      parents: ["int_loop"],
      relation: { project: "proj-1", dataset: "Prod", table: "fct_loop" },
      compiledSql: "select * from `proj-1`.`Prod`.`int_loop`",
      path: "models/marts/fct_loop.sql",
      materialized: "table",
    });
    expect(graph.get("int_loop")?.parents).toEqual(["countries", "int_eph"]);
    expect(graph.get("int_loop")?.onSchemaChange).toBe("append_new_columns");
    expect(graph.get("int_eph")?.relation).toBeNull();
  });

  it("maps changed repo paths to nodes", () => {
    expect(
      changedNodeNames(graph, [
        "dbt/models/int/int_loop.sql",
        "dbt/seeds/countries.csv",
        "dbt/macros/m.sql",
        "models/marts/fct_loop.sql",
      ]),
    ).toEqual(new Set(["int_loop", "countries"]));
  });

  it("plans a build from a small compiled manifest", async () => {
    // Prod has fct_loop and int_loop without closed_at; the push added it to
    // int_loop (changed) and fct_loop passes it through with `select *`.
    const prod: Record<string, string[]> = {
      fct_loop: ["id"],
      int_loop: ["id"],
      countries: ["code"],
    };
    const wh: WarehouseLookup = {
      async prodColumns(relations) {
        return new Map(
          relations
            .filter(r => prod[r.table])
            .map(r => [relationKey(r), new Set(prod[r.table])]),
        );
      },
      async queryColumns(sql) {
        return sql.includes("int_eph") ? ["id", "closed_at"] : ["id"];
      },
    };
    const gap = await findSchemaGap({
      graph,
      reads: ["fct_loop"],
      warehouse: wh,
      changed: changedNodeNames(graph, ["dbt/models/int/int_loop.sql"]),
    });
    expect(gap.models).toEqual(["fct_loop", "int_loop"]);
    expect(gap.reasons).toEqual({
      fct_loop: "pass-through",
      int_loop: "new-columns",
    });
    expect(gap.newColumns).toEqual({ int_loop: ["closed_at"] });
  });
});

describe("compileGraphCommand", () => {
  it("compiles each read model with its ancestors, in a form the parser accepts", () => {
    const command = compileGraphCommand([
      "fct_b",
      "fct_a",
      "fct_b",
      "Bad;Name",
      "Fct_Upper",
    ]);
    expect(command).toBe("compile --select +Fct_Upper +fct_a +fct_b");
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

  it("throws on any other query error", async () => {
    const runQuery = vi.fn(async () => ({ success: false, error: "denied" }));
    const lookup = warehouseLookupFor(connection, { runQuery, driver });
    await expect(lookup.prodColumns([rel("a")])).rejects.toThrow("denied");
  });

  it("returns a dry run's column names", async () => {
    const querySchema = vi
      .fn()
      .mockResolvedValue({ success: true, columns: [{ name: "id" }] });
    const lookup = warehouseLookupFor(connection, { querySchema, driver });
    expect(await lookup.queryColumns("select 1")).toEqual(["id"]);
  });

  it.each([
    "Unrecognized name: closed_at at [3:5]",
    "Name closed_at not found inside t at [2:3]",
    "Not found: Table proj:prod.int_loop",
  ])("returns null when BigQuery says a name is missing: %s", async error => {
    const querySchema = vi.fn().mockResolvedValue({ success: false, error });
    const lookup = warehouseLookupFor(connection, { querySchema, driver });
    expect(await lookup.queryColumns("select bad")).toBeNull();
  });

  it("does not call a wrong-location error a missing table", async () => {
    const querySchema = vi.fn().mockResolvedValue({
      success: false,
      error: "Not found: Table proj:prod.t was not found in location EU",
    });
    const lookup = warehouseLookupFor(connection, { querySchema, driver });
    await expect(lookup.queryColumns("select 1")).rejects.toThrow(
      /in location/,
    );
  });

  it("throws on a dry-run failure that names no missing table or column", async () => {
    const querySchema = vi.fn().mockResolvedValue({
      success: false,
      error:
        "Access Denied: Project p: User does not have bigquery.jobs.create",
    });
    const lookup = warehouseLookupFor(connection, { querySchema, driver });
    await expect(lookup.queryColumns("select 1")).rejects.toThrow(
      /Access Denied/,
    );
  });

  it("compares STRUCT and ARRAY<STRUCT> columns by their top-level name", async () => {
    // The dry run flattens RECORD fields to leaves: `participants.email`.
    const querySchema = vi.fn().mockResolvedValue({
      success: true,
      columns: [
        { name: "id" },
        { name: "participants.email" },
        { name: "participants.name" },
        { name: "address.geo.lat" },
        { name: "address.geo.lng" },
        { name: "tags" },
      ],
    });
    // INFORMATION_SCHEMA.COLUMNS lists the top-level columns only.
    const runQuery = vi.fn(async () => ({
      success: true,
      data: ["id", "participants", "address", "tags"].map(column_name => ({
        table_name: "fct_loop",
        column_name,
      })),
    }));
    const lookup = warehouseLookupFor(connection, {
      querySchema,
      runQuery,
      driver,
    });
    expect(await lookup.queryColumns("select 1")).toEqual([
      "id",
      "participants",
      "address",
      "tags",
    ]);

    const gap = await findSchemaGap({
      graph: graphOf([{ name: "fct_loop" }]),
      reads: ["fct_loop"],
      warehouse: lookup,
    });
    expect(gap.models).toEqual([]);
  });

  it("still sees a new column next to a STRUCT", async () => {
    const querySchema = vi.fn().mockResolvedValue({
      success: true,
      columns: [{ name: "participants.email" }, { name: "closed_at" }],
    });
    const runQuery = vi.fn(async () => ({
      success: true,
      data: [{ table_name: "fct_loop", column_name: "participants" }],
    }));
    const gap = await findSchemaGap({
      graph: graphOf([{ name: "fct_loop" }]),
      reads: ["fct_loop"],
      warehouse: warehouseLookupFor(connection, {
        querySchema,
        runQuery,
        driver,
      }),
    });
    expect(gap.newColumns).toEqual({ fct_loop: ["closed_at"] });
  });

  it("refuses an engine other than BigQuery", () => {
    expect(() =>
      warehouseLookupFor({
        type: "postgresql",
      } as unknown as IDatabaseConnection),
    ).toThrow(/BigQuery/);
  });
});
