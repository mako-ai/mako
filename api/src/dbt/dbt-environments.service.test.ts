import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { containsDbtSchemaToken, resolveDbtSchemaToken } from "@mako/schemas";
import {
  DbtProtectedEnvironmentError,
  assertAdhocDbtRunAllowed,
  findPersonalEnvironment,
  resolveEnvironmentNameForUser,
  resolveProdLikeEnvironmentName,
  sanitizePersonalSlug,
} from "./dbt-environments.service";
import { parseDbtCommand } from "./commands";

function env(name: string, ownerUserId?: string) {
  return {
    name,
    connectionId: new Types.ObjectId(),
    targetSchema: `dbt_${name}`,
    threads: 4,
    ownerUserId,
  };
}

describe("resolveProdLikeEnvironmentName", () => {
  it("prefers an environment literally named 'prod'", () => {
    expect(
      resolveProdLikeEnvironmentName({
        environments: [env("dev"), env("prod")],
        defaultEnvironment: "dev",
      }),
    ).toBe("prod");
  });

  it("falls back to the project default when no 'prod' exists", () => {
    expect(
      resolveProdLikeEnvironmentName({
        environments: [env("main"), env("staging")],
        defaultEnvironment: "main",
      }),
    ).toBe("main");
  });

  it("an explicit prodEnvironment setting beats the convention", () => {
    expect(
      resolveProdLikeEnvironmentName({
        environments: [env("dev"), env("prod"), env("release")],
        defaultEnvironment: "dev",
        prodEnvironment: "release",
      }),
    ).toBe("release");
  });

  it("ignores a stale prodEnvironment pointing at a removed env", () => {
    expect(
      resolveProdLikeEnvironmentName({
        environments: [env("dev"), env("prod")],
        defaultEnvironment: "dev",
        prodEnvironment: "release",
      }),
    ).toBe("prod");
  });
});

describe("findPersonalEnvironment / resolveEnvironmentNameForUser", () => {
  const project = {
    environments: [env("dev"), env("prod"), env("jonas", "user-1")],
    defaultEnvironment: "dev",
  };

  it("finds the caller's personal environment", () => {
    expect(findPersonalEnvironment(project, "user-1")?.name).toBe("jonas");
    expect(findPersonalEnvironment(project, "user-2")).toBeUndefined();
    expect(findPersonalEnvironment(project, undefined)).toBeUndefined();
  });

  it("explicit request always wins", () => {
    expect(resolveEnvironmentNameForUser(project, "user-1", "prod")).toBe(
      "prod",
    );
  });

  it("defaults to the personal environment when provisioned", () => {
    expect(resolveEnvironmentNameForUser(project, "user-1")).toBe("jonas");
  });

  it("defaults to the project default for users without one", () => {
    expect(resolveEnvironmentNameForUser(project, "user-2")).toBe("dev");
    expect(resolveEnvironmentNameForUser(project, undefined)).toBe("dev");
  });
});

describe("sanitizePersonalSlug", () => {
  it("uses the email local part, lowercased, [a-z0-9_] only", () => {
    expect(sanitizePersonalSlug("Jonas.Smith+dev@example.com")).toBe(
      "jonas_smith_dev",
    );
  });

  it("trims leading/trailing separators and bounds the length", () => {
    expect(sanitizePersonalSlug("--weird--")).toBe("weird");
    expect(sanitizePersonalSlug("x".repeat(100)).length).toBeLessThanOrEqual(
      40,
    );
  });

  it("falls back to 'user' when nothing survives", () => {
    expect(sanitizePersonalSlug("@@@")).toBe("user");
  });
});

describe("assertAdhocDbtRunAllowed", () => {
  const repoProject = {
    environments: [env("dev"), env("prod")],
    defaultEnvironment: "dev",
    repo: { branch: "main" },
  };
  const commands = (...cmds: string[]) => cmds.map(parseDbtCommand);

  it("refuses warehouse writes into the prod-like environment", () => {
    for (const cmd of [
      "build --select stg_orders",
      "run --select stg_orders",
      "seed",
      "snapshot",
      "test --select stg_orders --store-failures",
    ]) {
      expect(() =>
        assertAdhocDbtRunAllowed(repoProject, "prod", commands(cmd)),
      ).toThrow(DbtProtectedEnvironmentError);
    }
  });

  it("names the protected environment and tracked branch in the error", () => {
    expect(() =>
      assertAdhocDbtRunAllowed(
        repoProject,
        "prod",
        commands("build --select stg_orders --full-refresh"),
      ),
    ).toThrow(/"prod".*"main"/s);
  });

  it("allows warehouse writes into non-prod environments", () => {
    expect(() =>
      assertAdhocDbtRunAllowed(
        repoProject,
        "dev",
        commands("build --select stg_orders --full-refresh"),
      ),
    ).not.toThrow();
  });

  it("allows read-only commands against the prod-like environment", () => {
    expect(() =>
      assertAdhocDbtRunAllowed(
        repoProject,
        "prod",
        commands("parse", "compile --select stg_orders", "docs generate"),
      ),
    ).not.toThrow();
  });

  it("uses the project default as prod-like when no 'prod' env exists", () => {
    const project = {
      environments: [env("main_env"), env("staging")],
      defaultEnvironment: "main_env",
      repo: { branch: "main" },
    };
    expect(() =>
      assertAdhocDbtRunAllowed(project, "main_env", commands("build")),
    ).toThrow(DbtProtectedEnvironmentError);
    expect(() =>
      assertAdhocDbtRunAllowed(project, "staging", commands("build")),
    ).not.toThrow();
  });

  it("exempts projects without a repo binding (no committed tree to bypass)", () => {
    const blankProject = {
      environments: [env("dev"), env("prod")],
      defaultEnvironment: "dev",
    };
    expect(() =>
      assertAdhocDbtRunAllowed(blankProject, "prod", commands("build")),
    ).not.toThrow();
  });

  it("follows an explicit prodEnvironment setting", () => {
    const project = {
      environments: [env("dev"), env("prod"), env("release")],
      defaultEnvironment: "dev",
      prodEnvironment: "release",
      repo: { branch: "main" },
    };
    expect(() =>
      assertAdhocDbtRunAllowed(project, "release", commands("build")),
    ).toThrow(DbtProtectedEnvironmentError);
    // The env named "prod" is no longer the protected target.
    expect(() =>
      assertAdhocDbtRunAllowed(project, "prod", commands("build")),
    ).not.toThrow();
  });
});

describe("dbt_schema token helpers (@mako/schemas)", () => {
  it("detects the token with flexible whitespace", () => {
    expect(containsDbtSchemaToken("select * from {{ dbt_schema }}.t")).toBe(
      true,
    );
    expect(containsDbtSchemaToken("select * from {{dbt_schema}}.t")).toBe(
      true,
    );
    expect(containsDbtSchemaToken("select * from dbt_prod.t")).toBe(false);
  });

  it("is not stateful across calls (global regex lastIndex reset)", () => {
    const sql = "select * from {{ dbt_schema }}.t";
    expect(containsDbtSchemaToken(sql)).toBe(true);
    expect(containsDbtSchemaToken(sql)).toBe(true);
  });

  it("substitutes every occurrence", () => {
    expect(
      resolveDbtSchemaToken(
        "select * from {{ dbt_schema }}.a join {{dbt_schema}}.b using (id)",
        "dbt_jonas",
      ),
    ).toBe("select * from dbt_jonas.a join dbt_jonas.b using (id)");
  });
});
