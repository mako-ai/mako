import { describe, expect, it } from "vitest";
import {
  DBT_QUERY_COMMENT_MACRO,
  DBT_QUERY_COMMENT_MACRO_PATH,
  DBT_QUERY_COMMENT_PROJECT_CONFIG,
  dbtRunLabelEnv,
} from "./dbt-run-labels";
import { filterDbtExtraEnv } from "./runner.service";
import { buildStarterScaffold, DBT_PROJECT_FILE } from "./scaffold";

/** BigQuery's rule for a label value that is present. */
const LABEL_VALUE = /^[a-z0-9_-]{1,63}$/;

describe("dbtRunLabelEnv", () => {
  it("returns the four values, bare and under DBT_ENV_CUSTOM_ENV_", () => {
    expect(
      dbtRunLabelEnv({
        runId: "6650f0c2a1b2c3d4e5f60718",
        trigger: "schedule",
        jobId: "6650f0c2a1b2c3d4e5f60700",
        jobSlug: "nightly-build",
      }),
    ).toEqual({
      MAKO_DBT_JOB: "6650f0c2a1b2c3d4e5f60700",
      MAKO_DBT_JOB_SLUG: "nightly-build",
      MAKO_DBT_RUN: "6650f0c2a1b2c3d4e5f60718",
      MAKO_TRIGGER: "schedule",
      DBT_ENV_CUSTOM_ENV_MAKO_DBT_JOB: "6650f0c2a1b2c3d4e5f60700",
      DBT_ENV_CUSTOM_ENV_MAKO_DBT_JOB_SLUG: "nightly-build",
      DBT_ENV_CUSTOM_ENV_MAKO_DBT_RUN: "6650f0c2a1b2c3d4e5f60718",
      DBT_ENV_CUSTOM_ENV_MAKO_TRIGGER: "schedule",
    });
  });

  // Review A2/B6: a slug is unique inside one project only. Two projects (or
  // two workspaces) on one warehouse project must never share a job label.
  it("labels two jobs that share a slug with two different values", () => {
    const first = dbtRunLabelEnv({
      runId: "r1",
      trigger: "schedule",
      jobId: "6650f0c2a1b2c3d4e5f60700",
      jobSlug: "nightly",
    });
    const second = dbtRunLabelEnv({
      runId: "r2",
      trigger: "schedule",
      jobId: "6650f0c2a1b2c3d4e5f60711",
      jobSlug: "nightly",
    });
    expect(first.MAKO_DBT_JOB).not.toBe(second.MAKO_DBT_JOB);
    expect(first.MAKO_DBT_JOB).toBe("6650f0c2a1b2c3d4e5f60700");
    expect(second.MAKO_DBT_JOB).toBe("6650f0c2a1b2c3d4e5f60711");
    // The slug is carried beside the id, for reading only.
    expect(first.MAKO_DBT_JOB_SLUG).toBe("nightly");
    expect(second.MAKO_DBT_JOB_SLUG).toBe("nightly");
  });

  it("omits the job for a run without one", () => {
    const env = dbtRunLabelEnv({ runId: "r1", trigger: "manual" });
    expect(env).toEqual({
      MAKO_DBT_RUN: "r1",
      MAKO_TRIGGER: "manual",
      DBT_ENV_CUSTOM_ENV_MAKO_DBT_RUN: "r1",
      DBT_ENV_CUSTOM_ENV_MAKO_TRIGGER: "manual",
    });
    expect(env).not.toHaveProperty("MAKO_DBT_JOB");
    expect(env).not.toHaveProperty("MAKO_DBT_JOB_SLUG");
  });

  it("never sends a slug without the job id it names", () => {
    const env = dbtRunLabelEnv({
      runId: "r1",
      trigger: "agent",
      jobSlug: "nightly",
    });
    expect(env).not.toHaveProperty("MAKO_DBT_JOB");
    expect(env).not.toHaveProperty("MAKO_DBT_JOB_SLUG");
  });

  it("leaves the slug out when it is missing or sanitizes to nothing", () => {
    expect(
      dbtRunLabelEnv({ runId: "r1", trigger: "agent", jobId: "JOB42" }),
    ).toMatchObject({ MAKO_DBT_JOB: "job42" });
    const blank = dbtRunLabelEnv({
      runId: "r1",
      trigger: "agent",
      jobId: "job42",
      jobSlug: "   ",
    });
    expect(blank.MAKO_DBT_JOB).toBe("job42");
    expect(blank).not.toHaveProperty("MAKO_DBT_JOB_SLUG");
  });

  it("lowercases and replaces characters outside [a-z0-9_-]", () => {
    const env = dbtRunLabelEnv({
      runId: "Run/42.B",
      trigger: "manual",
      jobId: "j1",
      jobSlug: "Nightly Build (EU) v2!",
    });
    expect(env.MAKO_DBT_JOB_SLUG).toBe("nightly_build__eu__v2_");
    expect(env.MAKO_DBT_RUN).toBe("run_42_b");
  });

  it("trims surrounding whitespace before sanitizing, as dbt does", () => {
    expect(
      dbtRunLabelEnv({
        runId: "r1",
        trigger: "manual",
        jobId: "j1",
        jobSlug: "  nightly \n",
      }).MAKO_DBT_JOB_SLUG,
    ).toBe("nightly");
  });

  it("replaces unicode and emoji, never emitting an invalid character", () => {
    const env = dbtRunLabelEnv({
      runId: "r1",
      trigger: "manual",
      jobId: "j1",
      jobSlug: "Übersicht-日次-🚀",
    });
    expect(env.MAKO_DBT_JOB_SLUG).toMatch(LABEL_VALUE);
    expect(env.MAKO_DBT_JOB_SLUG.startsWith("_bersicht-__-")).toBe(true);
    expect(
      dbtRunLabelEnv({
        runId: "r1",
        trigger: "manual",
        jobId: "j1",
        jobSlug: "日本語",
      }).MAKO_DBT_JOB_SLUG,
    ).toBe("___");
  });

  it("truncates to 63 characters", () => {
    const env = dbtRunLabelEnv({
      runId: "r".repeat(200),
      trigger: "schedule",
      jobId: "j1",
      jobSlug: `${"a".repeat(62)}bcdefgh`,
    });
    expect(env.MAKO_DBT_JOB_SLUG).toBe(`${"a".repeat(62)}b`);
    expect(env.MAKO_DBT_JOB_SLUG).toHaveLength(63);
    expect(env.MAKO_DBT_RUN).toHaveLength(63);
    expect(env.DBT_ENV_CUSTOM_ENV_MAKO_DBT_RUN).toHaveLength(63);
  });

  it("leaves out a value that is empty, never sending an empty variable", () => {
    const env = dbtRunLabelEnv({
      runId: "",
      trigger: "manual",
      jobId: "",
      jobSlug: "",
    });
    expect(env).toEqual({
      MAKO_TRIGGER: "manual",
      DBT_ENV_CUSTOM_ENV_MAKO_TRIGGER: "manual",
    });
  });

  it("covers every trigger with a valid label value", () => {
    for (const trigger of ["schedule", "manual", "agent", "ci"] as const) {
      const env = dbtRunLabelEnv({ runId: "r1", trigger });
      expect(env.MAKO_TRIGGER).toBe(trigger);
    }
  });

  it("produces only valid label values for hostile input", () => {
    const env = dbtRunLabelEnv({
      runId: "r1\n*/ drop table x; --",
      trigger: "manual",
      jobId: "j1`; drop",
      jobSlug: '"}{{ env_var("SECRET") }}',
    });
    for (const value of Object.values(env)) expect(value).toMatch(LABEL_VALUE);
  });

  it("returns only names the runner lets through to the dbt child", () => {
    const env = dbtRunLabelEnv({
      runId: "r1",
      trigger: "schedule",
      jobId: "j1",
      jobSlug: "nightly",
    });
    expect(filterDbtExtraEnv(env)).toEqual(env);
  });
});

describe("DBT_QUERY_COMMENT_MACRO", () => {
  it("reads the four env vars with an empty default", () => {
    for (const name of [
      "MAKO_DBT_JOB",
      "MAKO_DBT_JOB_SLUG",
      "MAKO_DBT_RUN",
      "MAKO_TRIGGER",
    ]) {
      expect(DBT_QUERY_COMMENT_MACRO).toContain(`env_var("${name}", "")`);
    }
  });

  it("emits the mako_* fields and keeps dbt's default fields", () => {
    for (const field of [
      "mako_dbt_job",
      "mako_dbt_job_slug",
      "mako_dbt_run",
      "mako_trigger",
      "mako_source",
      '"app": "dbt"',
      "dbt_version",
      "profile_name",
      "target_name",
      "node_id=node.unique_id",
    ]) {
      expect(DBT_QUERY_COMMENT_MACRO).toContain(field);
    }
    expect(DBT_QUERY_COMMENT_MACRO).toContain("return(tojson(comment_dict))");
  });

  it("is one balanced macro named like the project config calls it", () => {
    expect(
      DBT_QUERY_COMMENT_MACRO.startsWith(
        "{% macro mako_query_comment(node) %}",
      ),
    ).toBe(true);
    expect(DBT_QUERY_COMMENT_MACRO.trimEnd().endsWith("{% endmacro %}")).toBe(
      true,
    );
    expect(DBT_QUERY_COMMENT_MACRO.match(/\{%-? macro /g)).toHaveLength(1);
    expect(DBT_QUERY_COMMENT_PROJECT_CONFIG).toContain(
      'comment: "{{ mako_query_comment(node) }}"',
    );
    expect(DBT_QUERY_COMMENT_PROJECT_CONFIG).toContain("job-label: true");
    // dbt refuses a query comment that contains the SQL comment terminator.
    expect(DBT_QUERY_COMMENT_MACRO).not.toContain("*/");
  });
});

describe("starter scaffold", () => {
  const scaffold = buildStarterScaffold("Sales Analytics");
  const byPath = new Map(scaffold.map(file => [file.path, file.content]));

  it("ships the macro file in new projects", () => {
    expect(DBT_QUERY_COMMENT_MACRO_PATH).toBe("macros/mako_query_comment.sql");
    expect(byPath.get(DBT_QUERY_COMMENT_MACRO_PATH)).toBe(
      DBT_QUERY_COMMENT_MACRO,
    );
  });

  it("wires the macro in dbt_project.yml with job-label on", () => {
    const project = byPath.get(DBT_PROJECT_FILE) ?? "";
    expect(project).toContain(DBT_QUERY_COMMENT_PROJECT_CONFIG);
    expect(project.match(/^query-comment:/gm)).toHaveLength(1);
    expect(project).toContain('name: "sales_analytics"');
    expect(project).toContain('macro-paths: ["macros"]');
    expect(project.endsWith("\n")).toBe(true);
  });

  it("keeps every file path unique", () => {
    expect(byPath.size).toBe(scaffold.length);
  });
});
