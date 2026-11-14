/**
 * Shared rig for the app scenario suites (./*.scenarios.test.ts): real bare
 * repos under a temp APPS_GIT_ROOT, the local sandbox provider, and
 * mongodb-memory-server — the same world as app-rename.test.ts, factored
 * out so every scenario file builds it the same way.
 *
 * Not a test file: it is imported by them.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  AppWorktree,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../bind-test-workspace-repo";
import { invalidateAppsIndexCache } from "../app-index.service";

export const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

/** A manifest like the scaffold writes (description and all). */
export function manifest(title: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      title,
      description: `${title}: a dashboard with enough words in it that git's rename detection pairs it when one line changes.`,
      entry: "src/main.tsx",
      bindings: [],
    },
    null,
    2,
  )}\n`;
}

export interface ScenarioEnv {
  tmpRoot: string;
  stop(): Promise<void>;
}

/** Temp roots, local sandbox, and an in-memory Mongo for one test file. */
export async function startScenarioEnv(prefix: string): Promise<ScenarioEnv> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  return {
    tmpRoot,
    async stop() {
      await mongoose.disconnect();
      await mongo.stop();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** A fresh repo and empty app state for `workspaceId`. */
export async function resetWorkspace(
  env: ScenarioEnv,
  workspaceId: string,
  files: Record<string, string>,
): Promise<void> {
  await AppIndexEntry.deleteMany({ workspaceId });
  await AppIndexHead.deleteMany({ workspaceId });
  await AppProject.deleteMany({ workspaceId });
  await unbindTestWorkspaceRepo(workspaceId);
  invalidateAppsIndexCache();
  // A sandbox session cloned from the previous repo would push a history
  // the new one does not share: every test starts with no sessions.
  await AppWorktree.deleteMany({ workspaceId });
  await fs.rm(path.join(env.tmpRoot, "sessions"), {
    recursive: true,
    force: true,
  });
  await fs.rm(repoDirFor(workspaceId), { recursive: true, force: true });
  await initRepo(repoDirFor(workspaceId), files);
  await bindTestWorkspaceRepo(workspaceId);
}

export async function fileAt(
  workspaceId: string,
  rel: string,
  ref = MAIN,
): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(workspaceId), ref, rel)).contents;
  } catch {
    return null;
  }
}

export async function headOf(workspaceId: string): Promise<string> {
  const sha = await resolveCommit(repoDirFor(workspaceId), MAIN);
  if (!sha) throw new Error("main is missing");
  return sha;
}

/** A commit straight onto main, as another writer would land it. */
export async function externalCommit(
  workspaceId: string,
  writes: Record<string, string>,
  modes: Record<string, "100755" | "120000"> = {},
): Promise<string> {
  const result = await commitBlobsOnBranch(
    repoDirFor(workspaceId),
    DEFAULT_BRANCH,
    { writes, modes },
    {
      message: "external edit",
      author: { name: "Laptop", email: "laptop@example.com" },
    },
  );
  invalidateAppsIndexCache(workspaceId);
  return result.commitOid;
}
