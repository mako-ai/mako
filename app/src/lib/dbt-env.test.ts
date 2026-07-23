import { describe, expect, it } from "vitest";
import { resolveProdLikeEnvName, shouldDeferByDefault } from "./dbt-env";

const envs = (...names: string[]) => names.map(name => ({ name }));

describe("resolveProdLikeEnvName", () => {
  it("prefers an explicit prodEnvironment setting", () => {
    expect(
      resolveProdLikeEnvName({
        environments: envs("dev", "prod", "release"),
        defaultEnvironment: "dev",
        prodEnvironment: "release",
      }),
    ).toBe("release");
  });

  it("ignores a stale prodEnvironment and falls back to 'prod'", () => {
    expect(
      resolveProdLikeEnvName({
        environments: envs("dev", "prod"),
        defaultEnvironment: "dev",
        prodEnvironment: "gone",
      }),
    ).toBe("prod");
  });

  it("falls back to the default when no 'prod' env exists", () => {
    expect(
      resolveProdLikeEnvName({
        environments: envs("main", "staging"),
        defaultEnvironment: "main",
      }),
    ).toBe("main");
  });
});

describe("shouldDeferByDefault", () => {
  const project = {
    environments: envs("dev", "prod"),
    defaultEnvironment: "dev",
    lastProdManifestKey: "artifacts/prod-manifest",
  };

  it("defers for non-prod targets when a prod manifest exists", () => {
    expect(shouldDeferByDefault(project, "dev")).toBe(true);
  });

  it("does not defer against the prod-like environment", () => {
    expect(shouldDeferByDefault(project, "prod")).toBe(false);
  });

  it("does not defer when no prod manifest has been stored yet", () => {
    expect(
      shouldDeferByDefault(
        { ...project, lastProdManifestKey: undefined },
        "dev",
      ),
    ).toBe(false);
  });
});
