/**
 * Review of PR #1190: readCommittedBinding on real git, real Mongo.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { readCommittedBinding } from "./bindings.service";
import {
  appRootFor,
  createProject,
  ensureWorktree,
  writeFile,
} from "./worktree.service";
import { initRepo, repoDirFor } from "./repository.service";
import { seededTemplateFiles } from "./workspace-template";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import { startTestGitServer, type TestGitServer } from "./test-git-server";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "review1190-bind-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  delete process.env.MAKO_CLOUD_GITHUB_ORG;
  delete process.env.MAKO_CLOUD_GITHUB_APP_ID;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);
afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const USER = "user-1";
const head = () =>
  execFileSync("git", ["-C", repoDirFor(WS), "rev-parse", "refs/heads/main"], {
    encoding: "utf8",
  }).trim();

beforeEach(async () => {
  await mongoose.connection.collection("app_projects").deleteMany({});
  await mongoose.connection.collection("app_worktrees").deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(path.join(tmpRoot, "sessions"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), seededTemplateFiles());
  await bindTestWorkspaceRepo(WS);
});

async function appWith(name: string, source: string) {
  const project = await createProject({
    workspaceId: WS,
    title: "App",
    userId: USER,
  });
  const handle = await ensureWorktree(project, USER);
  await writeFile(handle, `bindings/${name}.sql`, source);
  return project;
}

describe("readCommittedBinding", () => {
  it("HELD: traversal names return null", async () => {
    const project = await appWith("revenue", "-- connection: c\nSELECT 1\n");
    for (const name of [
      "../revenue",
      "..%2frevenue",
      "revenue/../../x",
      "../../../../etc/passwd",
      "..",
      "-x",
      "revenue.sql",
      "a b",
      "revenue\n",
    ]) {
      const got = await readCommittedBinding(
        project,
        name,
        undefined as never,
        undefined,
      );
      if (name === "revenue\n") {
        // JS `$` without /m does not match before a trailing newline.
        expect(got).toBeNull();
      } else {
        expect(got).toBeNull();
      }
    }
  });

  it("HELD: `at` reads that commit, not main", async () => {
    const project = await createProject({
      workspaceId: WS,
      title: "App",
      userId: USER,
    });
    const clone = path.join(tmpRoot, `clone-${Date.now()}`);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", clone, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      }).trim();
    execFileSync("git", ["clone", "-q", "-b", "main", repoDirFor(WS), clone]);
    const file = path.join(clone, appRootFor(project), "bindings/revenue.sql");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const commit = async (sql: string) => {
      await fs.writeFile(file, `-- connection: c\n${sql}\n`);
      git("add", ".");
      git("commit", "-q", "-m", sql);
      git("push", "-q", "origin", "main");
      return git("rev-parse", "HEAD");
    };
    const first = await commit("SELECT 1");
    const second = await commit("SELECT 2");
    expect(first).not.toBe(second);
    const atFirst = await readCommittedBinding(
      project,
      "revenue",
      undefined as never,
      first,
    );
    const atSecond = await readCommittedBinding(
      project,
      "revenue",
      undefined as never,
      second,
    );
    const atMain = await readCommittedBinding(
      project,
      "revenue",
      undefined as never,
    );
    expect(atFirst?.code).toContain("SELECT 1");
    expect(atSecond?.code).toContain("SELECT 2");
    expect(atMain?.code).toContain("SELECT 2");
  });

  it("HELD: a commit from which the file is absent reads null", async () => {
    const project = await appWith("revenue", "-- connection: c\nSELECT 1\n");
    const got = await readCommittedBinding(
      project,
      "nosuch",
      undefined as never,
      head(),
    );
    expect(got).toBeNull();
  });

  it("DEFECT: a commit this instance cannot get must throw, not read as binding-gone", async () => {
    const project = await appWith("revenue", "-- connection: c\nSELECT 1\n");
    await expect(
      readCommittedBinding(
        project,
        "revenue",
        undefined as never,
        "d".repeat(40),
      ),
    ).rejects.toThrow();
  });
});
