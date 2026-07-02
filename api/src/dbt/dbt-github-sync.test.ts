import { describe, expect, it } from "vitest";
import { isImportable, normalizeSubdir } from "./dbt-paths";

describe("normalizeSubdir", () => {
  it("strips leading/trailing slashes and passes through empty", () => {
    expect(normalizeSubdir()).toBe("");
    expect(normalizeSubdir("")).toBe("");
    expect(normalizeSubdir("/dbt/")).toBe("dbt");
    expect(normalizeSubdir("nested/dir")).toBe("nested/dir");
  });
});

describe("isImportable", () => {
  it("imports dbt text files (sql/yml/csv/md/etc.) and .gitkeep", () => {
    for (const p of [
      "models/staging/stg.sql",
      "dbt_project.yml",
      "models/schema.yaml",
      "seeds/data.csv",
      "README.md",
      "macros/util.sql",
      "models/.gitkeep",
      "analyses/x.sql",
    ]) {
      expect(isImportable(p)).toBe(true);
    }
  });

  it("skips generated/vendored dirs and binary/unknown extensions", () => {
    for (const p of [
      "target/manifest.json",
      "dbt_packages/dbt_utils/x.sql",
      "logs/dbt.log",
      ".git/config",
      "models/diagram.png",
      "Makefile",
    ]) {
      expect(isImportable(p)).toBe(false);
    }
  });

  it("never imports a committed profiles.yml (Mako renders its own)", () => {
    expect(isImportable("profiles.yml")).toBe(false);
    expect(isImportable("nested/profiles.yml")).toBe(false);
  });
});
