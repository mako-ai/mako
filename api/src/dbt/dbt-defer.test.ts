import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DbtProject,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import { resolveDbtBoundCode } from "./dbt-environments.service";
import {
  dbtSchemaReferences,
  devRelationListerFor,
  latestDevModification,
  relationKey,
  renderDbtSchemaWithDefer,
} from "./dbt-defer";

const BINDING = [
  "select m.*, t.team",
  "from `realadvisor-prod.{{ dbt_schema }}.dim_sales_team_membership` m",
  "join `realadvisor-prod`.`{{dbt_schema}}`.`dim_team` t using (team_id)",
  "join {{ dbt_schema }}.fct_deals d using (team_id)",
].join("\n");

const bigquery = { type: "bigquery" } as unknown as IDatabaseConnection;

describe("dbtSchemaReferences", () => {
  it("finds each token with the project before it and the relation after it", () => {
    expect(dbtSchemaReferences(BINDING)).toEqual([
      { project: "realadvisor-prod", relation: "dim_sales_team_membership" },
      { project: "realadvisor-prod", relation: "dim_team" },
      { project: undefined, relation: "fct_deals" },
    ]);
  });
});

describe("references a listing cannot answer for", () => {
  it("keeps metadata views and wildcard tables on the dev schema", () => {
    const code = [
      "select * from `p.{{ dbt_schema }}.INFORMATION_SCHEMA.TABLES`",
      "union all select * from `p.{{ dbt_schema }}.__TABLES__`",
      "union all select * from `p.{{ dbt_schema }}.events_*`",
      "union all select * from `p.{{ dbt_schema }}.information_schema.columns`",
    ].join("\n");
    expect(dbtSchemaReferences(code).map(r => r.relation)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // Even with an empty dev listing (which defers everything it can), none
    // of these silently switch to prod.
    const { code: out, deferred } = renderDbtSchemaWithDefer(code, {
      devSchema: "dbt_joan",
      prodSchema: "dbt_prod",
      devRelations: new Set(),
    });
    expect(out).not.toContain("dbt_prod");
    expect(deferred).toEqual([]);
  });

  it("still defers a table whose name merely contains those words", () => {
    const { code } = renderDbtSchemaWithDefer(
      "select * from {{ dbt_schema }}.events_2026 join {{ dbt_schema }}.stg__x using (id)",
      {
        devSchema: "dbt_joan",
        prodSchema: "dbt_prod",
        devRelations: new Set(),
      },
    );
    expect(code).toBe(
      "select * from dbt_prod.events_2026 join dbt_prod.stg__x using (id)",
    );
  });
});

describe("renderDbtSchemaWithDefer", () => {
  it("renders relations built in dev to dev and the rest to prod", () => {
    const devRelations = new Set([
      relationKey({ project: "realadvisor-prod", relation: "dim_team" }),
    ]);
    const { code, deferred } = renderDbtSchemaWithDefer(BINDING, {
      devSchema: "dbt_joan",
      prodSchema: "dbt_prod",
      devRelations,
    });
    expect(code).toContain(
      "`realadvisor-prod.dbt_prod.dim_sales_team_membership`",
    );
    expect(code).toContain("`realadvisor-prod`.`dbt_joan`.`dim_team`");
    expect(code).toContain("join dbt_prod.fct_deals");
    expect(deferred).toEqual(["dim_sales_team_membership", "fct_deals"]);
  });

  it("matches relation names case-insensitively", () => {
    const { code } = renderDbtSchemaWithDefer(
      "select * from {{ dbt_schema }}.Dim_X",
      {
        devSchema: "dbt_joan",
        prodSchema: "dbt_prod",
        devRelations: new Set([relationKey({ relation: "dim_x" })]),
      },
    );
    expect(code).toBe("select * from dbt_joan.Dim_X");
  });

  it("renders everything to dev when existence is unknown", () => {
    const { code, deferred } = renderDbtSchemaWithDefer(BINDING, {
      devSchema: "dbt_joan",
      prodSchema: "dbt_prod",
      devRelations: null,
    });
    expect(code).not.toContain("dbt_prod");
    expect(deferred).toEqual([]);
  });
});

describe("latestDevModification", () => {
  it("is the newest write among referenced relations built in dev", async () => {
    const lister = devRelationListerFor(bigquery, async () => ({
      success: true,
      data: [
        { table_name: "dim_team", last_modified_time: "1759000000000" },
        { table_name: "fct_deals", last_modified_time: 1759000500000 },
        { table_name: "unrelated", last_modified_time: 1759999999999 },
        { table_name: "a_view", last_modified_time: null },
      ],
    }));
    const refs = [
      { relation: "dim_team" },
      { relation: "fct_deals" },
      { relation: "not_built" },
    ];
    const listing = await lister("dbt_joan", refs);
    expect(latestDevModification(listing, refs)).toBe(1759000500000);
    expect(latestDevModification(listing, [{ relation: "a_view" }])).toBeNull();
    expect(latestDevModification(null, refs)).toBeNull();
  });
});

describe("devRelationListerFor", () => {
  it("asks BigQuery once per qualifying project, tables and views alike", async () => {
    const runQuery = vi.fn(async (_c: IDatabaseConnection, sql: string) =>
      sql.includes("`realadvisor-prod.dbt_joan`")
        ? { success: true, data: [{ table_name: "dim_team" }] }
        : { success: true, data: [{ table_name: "fct_deals" }] },
    );
    const found = await devRelationListerFor(bigquery, runQuery)(
      "dbt_joan",
      dbtSchemaReferences(BINDING),
    );
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runQuery.mock.calls.map(c => c[1])).toEqual([
      "SELECT t.table_name, s.last_modified_time FROM `realadvisor-prod.dbt_joan`.INFORMATION_SCHEMA.TABLES t LEFT JOIN `realadvisor-prod.dbt_joan.__TABLES__` s ON s.table_id = t.table_name",
      "SELECT t.table_name, s.last_modified_time FROM `dbt_joan`.INFORMATION_SCHEMA.TABLES t LEFT JOIN `dbt_joan.__TABLES__` s ON s.table_id = t.table_name",
    ]);
    expect(found).toEqual(
      new Map([
        [
          relationKey({ project: "realadvisor-prod", relation: "dim_team" }),
          null,
        ],
        [relationKey({ relation: "fct_deals" }), null],
      ]),
    );
  });

  it("treats a missing dev dataset as empty (everything defers)", async () => {
    const found = await devRelationListerFor(bigquery, async () => ({
      success: false,
      error: "Not found: Dataset realadvisor-prod:dbt_joan was not found",
    }))("dbt_joan", [{ project: "realadvisor-prod", relation: "x" }]);
    expect(found).toEqual(new Map());
  });

  it("returns unknown on other failures, other engines and unsafe names", async () => {
    const failing = devRelationListerFor(bigquery, async () => ({
      success: false,
      error: "Access Denied",
    }));
    expect(await failing("dbt_joan", [{ relation: "x" }])).toBeNull();

    const runQuery = vi.fn();
    const postgres = { type: "postgresql" } as unknown as IDatabaseConnection;
    expect(
      await devRelationListerFor(postgres, runQuery)("dbt_joan", [
        { relation: "x" },
      ]),
    ).toBeNull();
    expect(
      await devRelationListerFor(bigquery, runQuery)("dbt`; drop", [
        { relation: "x" },
      ]),
    ).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
  });
});

describe("resolveDbtBoundCode with a dev environment (real Mongo)", () => {
  let mongo: MongoMemoryServer;
  const WS = new Types.ObjectId();
  const CONN = new Types.ObjectId();
  let projectId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    const project = await DbtProject.create({
      workspaceId: WS,
      name: "Analytics",
      dbtVersion: "1.9",
      environments: [
        { name: "prod", connectionId: CONN, targetSchema: "dbt_prod" },
        {
          name: "joan",
          connectionId: CONN,
          targetSchema: "dbt_joan",
          ownerUserId: "u-joan",
        },
      ],
      defaultEnvironment: "prod",
      createdBy: "u-joan",
    });
    projectId = project._id.toString();
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const code =
    "select * from {{ dbt_schema }}.built_here join {{ dbt_schema }}.only_in_prod using (id)";

  it("defers relations the environment lacks to the prod-like schema", async () => {
    const listDevRelations = vi.fn(
      async () => new Map([[relationKey({ relation: "built_here" }), null]]),
    );
    const out = await resolveDbtBoundCode({
      workspaceId: WS,
      dbtProjectId: projectId,
      code,
      environment: { name: "joan", userId: "u-joan", listDevRelations },
    });
    expect(out).toBe(
      "select * from dbt_joan.built_here join dbt_prod.only_in_prod using (id)",
    );
    expect(listDevRelations).toHaveBeenCalledWith("dbt_joan", [
      { project: undefined, relation: "built_here" },
      { project: undefined, relation: "only_in_prod" },
    ]);
  });

  it("without a lister (opt-out) renders every reference to the environment", async () => {
    const out = await resolveDbtBoundCode({
      workspaceId: WS,
      dbtProjectId: projectId,
      code,
      environment: { name: "joan", userId: "u-joan" },
    });
    expect(out).not.toContain("dbt_prod");
  });

  it("published builds (no environment) still render to prod", async () => {
    const out = await resolveDbtBoundCode({
      workspaceId: WS,
      dbtProjectId: projectId,
      code,
    });
    expect(out).toBe(
      "select * from dbt_prod.built_here join dbt_prod.only_in_prod using (id)",
    );
  });
});
