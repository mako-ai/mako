/**
 * Resident dbt engine CONTRACT test.
 *
 * Pins the dbt-core programmatic-API assumptions the engine depends on against
 * a REAL dbt-core + dbt-duckdb (no warehouse server needed):
 *   1. parse caches a reusable manifest (prepare returns node count)
 *   2. dbtRunner(manifest=...) reuses it: compile returns compiled SQL
 *   3. the same long-lived process handles compile -> show repeatedly
 *
 * Heavy (downloads dbt via `uv`), so it is gated behind RUN_DBT_ENGINE_CONTRACT
 * and meant for a dedicated CI job — run locally with:
 *   RUN_DBT_ENGINE_CONTRACT=1 pnpm --filter api exec vitest run dbt-engine.contract
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  disposeAllEngines,
  engineCompile,
  enginePrepare,
  engineShow,
} from "./dbt-engine.service";

const ENABLED = process.env.RUN_DBT_ENGINE_CONTRACT === "1";

describe.skipIf(!ENABLED)("dbt engine contract (real dbt-core 1.9.10)", () => {
  process.env.DBT_ENGINE_ENABLED = "true";
  process.env.DBT_ENGINE_PYTHON_CMD = JSON.stringify([
    "uv",
    "run",
    "--no-project",
    "--python",
    "3.11",
    "--with",
    "dbt-core==1.9.10",
    "--with",
    "dbt-duckdb==1.9.4",
    "python",
  ]);

  const dir = mkdtempSync(join(tmpdir(), "dbt-engine-contract-"));
  mkdirSync(join(dir, "models"), { recursive: true });
  writeFileSync(
    join(dir, "dbt_project.yml"),
    'name: probe\nprofile: probe\nversion: "1.0"\nconfig-version: 2\nmodel-paths: ["models"]\n',
  );
  writeFileSync(
    join(dir, "profiles.yml"),
    `probe:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: ${dir}/probe.duckdb\n      threads: 1\n`,
  );
  writeFileSync(
    join(dir, "models", "my_model.sql"),
    "select 1 as id, 2 as val\n",
  );

  const ctx = {
    adapterPackage: "dbt-duckdb",
    dbtVersion: "1.9.10",
    connectionEnv: {},
  };
  const session = { key: "contract:probe:dev", projectDir: dir };

  afterAll(() => disposeAllEngines());

  it("parses, reuses the manifest to compile, and shows rows in one process", async () => {
    const prep = await enginePrepare(ctx, session);
    expect(prep.nodes).toBeGreaterThanOrEqual(1);

    const compile = await engineCompile(ctx, session, "my_model");
    expect(compile.ok).toBe(true);
    expect(compile.compiled_sql).toContain("select 1 as id");

    const show = await engineShow(ctx, session, {
      inline: "select 1 as x, 'hi' as y",
      limit: 5,
    });
    expect(show.ok).toBe(true);
    expect(show.columns).toEqual(["x", "y"]);
    expect(show.rows).toEqual([[1, "hi"]]);
  }, 180_000);
});
