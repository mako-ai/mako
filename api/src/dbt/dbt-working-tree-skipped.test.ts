/**
 * A file the run loader cannot hand to dbt (too large, or binary) is never
 * dropped silently: a file dbt reads fails the run with its name, size and
 * reason; any other file becomes a warning on the run.
 */
import { describe, expect, it } from "vitest";
import {
  DbtTreeFilesSkippedError,
  MAX_FILE_BYTES,
  classifySkippedFiles,
  dbtReadsPath,
  dbtResourcePaths,
  describeSkippedFile,
} from "./dbt-working-tree.service";

const PROJECT = { path: "dbt_project.yml", content: "name: a\n" };

describe("dbtResourcePaths", () => {
  it("uses dbt's defaults when dbt_project.yml sets nothing", () => {
    expect(dbtResourcePaths("name: a\n").sort()).toEqual([
      "analyses",
      "macros",
      "models",
      "seeds",
      "snapshots",
      "tests",
    ]);
  });

  it("reads custom paths and drops ./ and trailing slashes", () => {
    const paths = dbtResourcePaths(
      'name: a\nseed-paths: ["./data/"]\nmodel-paths: ["transform"]\ndocs-paths: ["docs"]\n',
    );
    expect(paths).toContain("data");
    expect(paths).toContain("transform");
    expect(paths).toContain("docs");
    expect(paths).not.toContain("seeds");
    expect(paths).not.toContain("models");
  });

  it("falls back to the defaults on unparseable YAML", () => {
    expect(dbtResourcePaths("name: [\n")).toContain("seeds");
  });
});

describe("dbtReadsPath", () => {
  const roots = dbtResourcePaths(undefined);
  it("covers resource folders and root YAML", () => {
    expect(dbtReadsPath("seeds/big.csv", roots)).toBe(true);
    expect(dbtReadsPath("models/a/b.sql", roots)).toBe(true);
    expect(dbtReadsPath("packages.yml", roots)).toBe(true);
    expect(dbtReadsPath("selectors.yaml", roots)).toBe(true);
  });
  it("leaves out files dbt never opens", () => {
    expect(dbtReadsPath("assets/logo.png", roots)).toBe(false);
    expect(dbtReadsPath("scripts/load.py", roots)).toBe(false);
    expect(dbtReadsPath("README.md", roots)).toBe(false);
    expect(dbtReadsPath("seedsextra/x.csv", roots)).toBe(false);
  });

  it("leaves out files under a resource folder that dbt never opens", () => {
    expect(dbtReadsPath("models/.DS_Store", roots)).toBe(false);
    expect(dbtReadsPath("models/marts/diagram.png", roots)).toBe(false);
    expect(dbtReadsPath("seeds/raw.parquet", roots)).toBe(false);
    expect(dbtReadsPath("seeds/data.xlsx", roots)).toBe(false);
    expect(dbtReadsPath("models/marts/x.py", roots)).toBe(true);
    expect(dbtReadsPath("models/marts/_docs.md", roots)).toBe(true);
  });
});

describe("classifySkippedFiles", () => {
  it("returns no warnings when nothing was skipped", () => {
    expect(classifySkippedFiles([PROJECT], [])).toEqual({
      files: [PROJECT],
      warnings: [],
    });
  });

  it("fails on a too-large seed, naming file, size and reason", () => {
    const run = () =>
      classifySkippedFiles(
        [PROJECT],
        [{ path: "seeds/listings.csv", bytes: 8_400_000, reason: "too_large" }],
        1_000_000,
      );
    expect(run).toThrow(DbtTreeFilesSkippedError);
    expect(run).toThrow(
      "dbt/seeds/listings.csv (8.0 MB) is over the 976.6 KB per-file limit",
    );
  });

  it("fails on a binary model and lists every needed file", () => {
    try {
      classifySkippedFiles(
        [PROJECT],
        [
          { path: "seeds/utf16.csv", bytes: 2048, reason: "binary" },
          { path: "assets/logo.png", bytes: 900, reason: "binary" },
          { path: "macros/blob.sql", bytes: 10, reason: "binary" },
        ],
      );
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DbtTreeFilesSkippedError);
      const skipped = error as DbtTreeFilesSkippedError;
      expect(skipped.files.map(f => f.path)).toEqual([
        "macros/blob.sql",
        "seeds/utf16.csv",
      ]);
      expect(skipped.message).toMatch(/^2 dbt files could not be loaded/);
      expect(skipped.message).toContain(
        "dbt/seeds/utf16.csv (2.0 KB) is binary (it contains NUL bytes)",
      );
      expect(skipped.message).not.toContain("logo.png");
    }
  });

  it("warns, without failing, for files dbt does not read", () => {
    const result = classifySkippedFiles(
      [PROJECT],
      [{ path: "assets/logo.png", bytes: 900, reason: "binary" }],
    );
    expect(result.files).toEqual([PROJECT]);
    expect(result.warnings).toEqual([
      "Skipped dbt/assets/logo.png (900 B) is binary (it contains NUL bytes) and dbt reads text only. dbt does not read this path, so the run went on without it.",
    ]);
  });

  it("follows the seed-paths the project sets", () => {
    const project = {
      path: "dbt_project.yml",
      content: 'name: a\nseed-paths: ["data"]\n',
    };
    expect(() =>
      classifySkippedFiles(
        [project],
        [{ path: "data/big.csv", bytes: 5, reason: "too_large" }],
      ),
    ).toThrow(DbtTreeFilesSkippedError);
    expect(
      classifySkippedFiles(
        [project],
        [{ path: "seeds/old.csv", bytes: 5, reason: "too_large" }],
      ).warnings,
    ).toHaveLength(1);
  });
});

describe("MAX_FILE_BYTES", () => {
  it("is GitHub's 100 MB per-file limit, well above an 8 MB seed", () => {
    expect(MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
    expect(
      describeSkippedFile({
        path: "seeds/x.csv",
        bytes: 1,
        reason: "too_large",
      }),
    ).toContain("100.0 MB per-file limit");
  });
});
