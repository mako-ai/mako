import { describe, expect, it } from "vitest";
import { resolveProdLikeEnvName } from "./dbt-env";

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
