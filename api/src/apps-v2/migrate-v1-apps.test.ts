/**
 * v1→v2 migration, against real git and the real binding parser.
 *
 * The fixture is deliberately awkward: a file that collides with the
 * scaffold, a scheduled SQL binding, a JavaScript binding and a live one
 * (both unmigratable), a binding name no filesystem should be asked to
 * store, and workspace-level access.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { startTestGitServer, type TestGitServer } from "./test-git-server";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;
const WS = new Types.ObjectId().toString();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-migrate-v1-"));
  process.env.APPS_V2_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_V2_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_V2_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  delete process.env.MAKO_CLOUD_GITHUB_ORG;
  delete process.env.MAKO_CLOUD_GITHUB_APP_ID;
  delete process.env.MAKO_CLOUD_GITHUB_APP_PRIVATE_KEY;
  gitServer = await startTestGitServer();
  process.env.APPS_V2_GIT_ORIGIN_URL = gitServer.url;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeV1App() {
  const { MakoApp } = await import("../database/workspace-schema");
  return MakoApp.create({
    workspaceId: new Types.ObjectId(WS),
    title: "Legacy Dashboard",
    description: "A v1 app",
    template: "react",
    runtime: "cdn",
    entrypoint: "App.tsx",
    files: [
      { path: "src/App.tsx", contents: "export default () => <b>v1</b>;\n" },
      { path: "src/lib/data.ts", contents: "export const rows = [];\n" },
    ],
    dependencies: { "date-fns": "^3.0.0", react: "^18.2.0" },
    dataBindings: [
      {
        id: "b1",
        name: "Users by tenant!",
        connectionId: "conn-1",
        language: "sql",
        code: "SELECT tenant, count(*) FROM users GROUP BY 1",
        materialization: "parquet",
        materializationSchedule: { enabled: true, cron: "0 6 * * *" },
      },
      {
        id: "b2",
        name: "computed",
        connectionId: "conn-1",
        language: "javascript",
        code: "return 1;",
        materialization: "parquet",
      },
      {
        id: "b3",
        name: "live-one",
        connectionId: "conn-1",
        language: "sql",
        code: "SELECT 1",
        materialization: "live",
        materializationSchedule: {
          enabled: false,
          cron: null,
          dataFreshnessTtlMs: 30 * 60_000,
        },
      },
      {
        id: "b4",
        name: "mongo agg",
        connectionId: "conn-1",
        language: "mongodb",
        code: "db.users.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])",
        materialization: "parquet",
      },
    ],
    version: 3,
    access: "workspace",
    createdBy: "user-1",
  });
}

describe("v1 → v2 migration", () => {
  it("moves files, converts bindings, carries access — and says what it could not do", async () => {
    const { migrateV1App } = await import("./migrate-v1-apps");
    const { listFiles, readFile } = await import("./worktree.service");
    const { AppProjectV2 } = await import("../database/workspace-schema");
    const { parseBindingFrontMatter } = await import("./bindings.service");
    const app = await makeV1App();

    const result = await migrateV1App(app, "legacy-dashboard");
    expect(result.slug).toBe("legacy-dashboard");
    const project = await AppProjectV2.findById(result.projectId);
    expect(project?.access).toBe("workspace");
    // Unpublished on purpose: nothing has been built.
    expect(project?.publishedSha).toBeFalsy();

    const listed = (await listFiles(project!)).entries.map(e => e.path);
    // The v1 file replaced the scaffold's App.tsx; the chassis is present.
    expect(listed).toContain("src/App.tsx");
    expect(listed).toContain("src/lib/data.ts");
    expect(listed).toContain("vite.config.ts");
    expect(listed).toContain("MIGRATION.md");
    const appTsx = await readFile(project!, "src/App.tsx");
    expect(appTsx.contents).toContain("v1");

    // Dependencies merged, v1 pin preserved.
    const pkg = JSON.parse((await readFile(project!, "package.json")).contents);
    expect(pkg.dependencies["date-fns"]).toBe("^3.0.0");
    expect(pkg.dependencies.react).toBe("^18.2.0");

    // Two SQL bindings migrate: the scheduled one and the live one (now a
    // scheduled refresh). v2 is SQL-only, so the MongoDB and JavaScript
    // bindings are skipped — the MongoDB query is preserved in MIGRATION.md
    // for a manual rewrite.
    const bindingFiles = listed.filter(p => p.startsWith("bindings/")).sort();
    expect(bindingFiles).toHaveLength(2);
    expect(bindingFiles.every(p => p.endsWith(".sql"))).toBe(true);

    const sqlFile = bindingFiles.find(p => !p.includes("live"))!;
    const sql = await readFile(project!, sqlFile);
    const meta = parseBindingFrontMatter(sql.contents);
    expect(meta.connection).toBe("conn-1");
    expect(meta.schedule).toBe("0 6 * * *");
    expect(sql.contents).toContain("GROUP BY 1");

    // The live binding became a scheduled refresh (its TTL → hourly cron).
    const live = result.bindings.liveAsScheduled;
    expect(live.map(l => l.cron)).toContain("0 * * * *");

    // MongoDB and JavaScript are skipped and REPORTED; the Mongo query is
    // preserved in the notes so it can be rewritten as SQL.
    expect(result.bindings.skipped.map(s => s.name).sort()).toEqual([
      "computed",
      "mongo agg",
    ]);
    const notes = await readFile(project!, "MIGRATION.md");
    expect(notes.contents).toContain("computed");
    expect(notes.contents).toContain("mongo agg");
    expect(notes.contents).toContain("aggregate");
  }, 180_000);

  it("is idempotent by overwrite: a second run replaces in place, no duplicates", async () => {
    const { migrateWorkspaceV1Apps } = await import("./migrate-v1-apps");
    const { MakoApp, AppProjectV2 } = await import(
      "../database/workspace-schema"
    );
    const app = await makeV1App();

    const first = await migrateWorkspaceV1Apps({
      workspaceId: WS,
      execute: true,
    });
    const beforeCount = await AppProjectV2.countDocuments({
      workspaceId: new Types.ObjectId(WS),
    });

    // Re-run: every app lands on the SAME deterministic slug and overwrites its
    // previous occupant — no "…-2", and the project count does not grow.
    const again = await migrateWorkspaceV1Apps({
      workspaceId: WS,
      execute: true,
    });
    expect(again.map(r => r.slug).sort()).toEqual(
      first.map(r => r.slug).sort(),
    );
    expect(
      await AppProjectV2.countDocuments({
        workspaceId: new Types.ObjectId(WS),
      }),
    ).toBe(beforeCount);

    // The stamp points at the current (rebuilt) project for this app.
    const mine = again.find(r => r.v1AppId === app._id.toString())!;
    const stamped = await MakoApp.findById(app._id);
    expect(stamped?.migratedToV2ProjectId?.toString()).toBe(mine.projectId);
  }, 180_000);

  it("dry run writes nothing", async () => {
    const { migrateWorkspaceV1Apps } = await import("./migrate-v1-apps");
    const { MakoApp, AppProjectV2 } = await import(
      "../database/workspace-schema"
    );
    const ws2 = new Types.ObjectId().toString();
    const { MakoApp: M } = await import("../database/workspace-schema");
    await M.create({
      workspaceId: new Types.ObjectId(ws2),
      title: "Untouched",
      template: "react",
      runtime: "cdn",
      entrypoint: "App.tsx",
      files: [{ path: "a.ts", contents: "1\n" }],
      dependencies: {},
      dataBindings: [],
      version: 1,
      access: "private",
      createdBy: "user-1",
    });

    const plan = await migrateWorkspaceV1Apps({
      workspaceId: ws2,
      execute: false,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].fileCount).toBe(1);
    expect(
      await AppProjectV2.countDocuments({
        workspaceId: new Types.ObjectId(ws2),
      }),
    ).toBe(0);
    const untouched = await MakoApp.findOne({
      workspaceId: new Types.ObjectId(ws2),
    });
    expect(untouched?.migratedToV2ProjectId).toBeFalsy();
  }, 60_000);
});
