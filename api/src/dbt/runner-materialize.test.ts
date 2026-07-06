/**
 * materializeDbtProject / pruneStaleRunArtifacts — warm-dir safety.
 *
 * Regression tests for the "No dbt_project.yml found at expected path
 * <warm-dir>/dbt_project.yml" incident: a broken (empty) snapshot must never
 * reconcile a previously-good warm directory away, and per-run result
 * artifacts must not leak across runs in a reused warm dir.
 */
import { access, mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  materializeDbtProject,
  pruneStaleRunArtifacts,
} from "./runner.service";
import type { RenderedProfile } from "./adapter-map";

const profile: RenderedProfile = {
  adapterPackage: "dbt-duckdb",
  secretEnv: {},
  keyfiles: [],
  profilesYml: "mako:\n  target: dev\n",
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("materializeDbtProject — dbt_project.yml guard", () => {
  it("materializes a valid snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mako-dbt-materialize-"));
    const { changed } = await materializeDbtProject(dir, {
      files: [
        { path: "dbt_project.yml", content: "name: probe" },
        { path: "models/a.sql", content: "select 1" },
      ],
      profile,
      reconcile: true,
    });
    expect(changed).toBe(true);
    expect(await readFile(join(dir, "dbt_project.yml"), "utf8")).toBe(
      "name: probe",
    );
    expect(await readFile(join(dir, "models", "a.sql"), "utf8")).toBe(
      "select 1",
    );
  });

  it("refuses a snapshot without dbt_project.yml and leaves the warm dir intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mako-dbt-materialize-"));
    await materializeDbtProject(dir, {
      files: [
        { path: "dbt_project.yml", content: "name: probe" },
        { path: "models/a.sql", content: "select 1" },
      ],
      profile,
      reconcile: true,
    });

    // A broken snapshot (e.g. a branch whose base tree is missing) must throw
    // BEFORE writing or reconciling anything.
    await expect(
      materializeDbtProject(dir, {
        files: [{ path: "models/b.sql", content: "select 2" }],
        profile,
        reconcile: true,
      }),
    ).rejects.toThrow(/dbt_project\.yml/);

    // The previously-good tree was not reconciled away.
    expect(await readFile(join(dir, "dbt_project.yml"), "utf8")).toBe(
      "name: probe",
    );
    expect(await readFile(join(dir, "models", "a.sql"), "utf8")).toBe(
      "select 1",
    );
    expect(await exists(join(dir, "models", "b.sql"))).toBe(false);
  });
});

describe("pruneStaleRunArtifacts", () => {
  it("removes per-run result artifacts but keeps the parse cache and manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mako-dbt-prune-"));
    await mkdir(join(dir, "target"), { recursive: true });
    const all = [
      "run_results.json",
      "sources.json",
      "catalog.json",
      "partial_parse.msgpack",
      "manifest.json",
    ];
    for (const name of all) {
      await writeFile(join(dir, "target", name), "stale");
    }

    await pruneStaleRunArtifacts(dir);

    expect(await exists(join(dir, "target", "run_results.json"))).toBe(false);
    expect(await exists(join(dir, "target", "sources.json"))).toBe(false);
    expect(await exists(join(dir, "target", "catalog.json"))).toBe(false);
    expect(await exists(join(dir, "target", "partial_parse.msgpack"))).toBe(
      true,
    );
    expect(await exists(join(dir, "target", "manifest.json"))).toBe(true);
  });

  it("is a no-op on a dir without target/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mako-dbt-prune-"));
    await expect(pruneStaleRunArtifacts(dir)).resolves.toBeUndefined();
  });
});
