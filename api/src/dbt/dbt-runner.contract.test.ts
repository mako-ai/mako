/**
 * dbt RUNNER (subprocess) contract test — compile → run → results.
 *
 * Complements dbt-engine.contract.test.ts (which pins the resident-engine
 * programmatic API) by exercising the production subprocess path: runDbt
 * materializes a project + profiles.yml to a temp dir, spawns a REAL dbt-core
 * + dbt-duckdb via `uvx`, and we assert the run_results.json → stepResults
 * mapping that powers the Results tab.
 *
 * Heavy (downloads dbt via `uv`); gated behind RUN_DBT_ENGINE_CONTRACT and
 * meant for a dedicated CI job. Run locally with:
 *   RUN_DBT_ENGINE_CONTRACT=1 pnpm --filter api exec vitest run dbt-runner.contract
 */
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import { parseDbtCommand } from "./commands";
import { parseStepResults, runDbt } from "./runner.service";
import type { RenderedProfile } from "./adapter-map";

const ENABLED = process.env.RUN_DBT_ENGINE_CONTRACT === "1";

describe.skipIf(!ENABLED)(
  "dbt runner contract (real dbt-core + duckdb)",
  () => {
    it("materializes, compiles + runs a model, and parses run_results", async () => {
      const dbPath = join(
        tmpdir(),
        `dbt-runner-contract-${randomUUID()}.duckdb`,
      );
      const profile: RenderedProfile = {
        adapterPackage: "dbt-duckdb",
        secretEnv: {},
        keyfiles: [],
        profilesYml: [
          "mako:",
          "  target: dev",
          "  outputs:",
          "    dev:",
          "      type: duckdb",
          `      path: ${dbPath}`,
          "      threads: 1",
          "",
        ].join("\n"),
      };

      const files = [
        {
          path: "dbt_project.yml",
          content: [
            "name: probe",
            "profile: mako",
            'version: "1.0"',
            "config-version: 2",
            'model-paths: ["models"]',
            "",
          ].join("\n"),
        },
        {
          path: "models/contract_model.sql",
          content: "select 1 as id, 2 as val\n",
        },
      ];

      const result = await runDbt({
        files,
        profile,
        dbtVersion: "1.9.10",
        commands: [
          parseDbtCommand("compile --select contract_model"),
          parseDbtCommand("run --select contract_model"),
        ],
      });

      expect(result.success).toBe(true);
      expect(result.commandResults).toHaveLength(2);

      const [compile, run] = result.commandResults;
      expect(compile.exitCode).toBe(0);
      expect(run.exitCode).toBe(0);

      const steps = parseStepResults(run.runResults);
      expect(steps).toContainEqual(
        expect.objectContaining({
          name: "contract_model",
          resourceType: "model",
          status: "success",
        }),
      );
      // The run_results.json artifact is collected for download/inspection.
      expect(result.artifacts.runResults).toBeInstanceOf(Buffer);
    }, 300_000);
  },
);
