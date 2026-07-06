import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  isImportable,
  normalizeSubdir,
  repoFilesToInserts,
  type FetchedRepoFile,
} from "./dbt-github-sync.service";

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

describe("repoFilesToInserts", () => {
  it("maps fetched files to DbtFile insert docs", () => {
    const workspaceId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const files: FetchedRepoFile[] = [
      { path: "models/a.sql", content: "select 1", blobSha: "sha1" },
      { path: "dbt_project.yml", content: "name: x", blobSha: "sha2" },
    ];
    expect(
      repoFilesToInserts(files, {
        workspaceId,
        projectId,
        branch: "main",
        updatedBy: "u1",
      }),
    ).toEqual([
      {
        workspaceId,
        projectId,
        branch: "main",
        path: "models/a.sql",
        content: "select 1",
        updatedBy: "u1",
        repoBlobSha: "sha1",
      },
      {
        workspaceId,
        projectId,
        branch: "main",
        path: "dbt_project.yml",
        content: "name: x",
        updatedBy: "u1",
        repoBlobSha: "sha2",
      },
    ]);
  });

  it("returns [] for no files", () => {
    expect(
      repoFilesToInserts([], {
        workspaceId: new Types.ObjectId(),
        projectId: new Types.ObjectId(),
        branch: "main",
        updatedBy: "u1",
      }),
    ).toEqual([]);
  });
});
