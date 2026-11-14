/**
 * Test-only rig for the console rename / delete / trash suites: a real bare
 * repo under a temp APPS_GIT_ROOT, mongodb-memory-server for the index, two
 * members with personal folders, and a way to hold one operation at a
 * named point while another runs to completion.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  ConsoleFolder,
  SavedConsole,
  WorkspaceUserHandle,
  type ISavedConsole,
} from "../database/workspace-schema";
import { ConsoleManager } from "../utils/console-manager";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import { parseConsoleRepoPath } from "./console-files";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import { invalidateOwnerDirectory } from "./user-handles.service";
import {
  adoptWorkspaceConsoles,
  consoleCommitHooks,
  loadLiveConsoles,
  syncConsolesIndexFromRepo,
} from "./workspace-consoles.service";

export const WS = new Types.ObjectId().toString();
export const ALICE = new Types.ObjectId().toString();
export const BOB = new Types.ObjectId().toString();
export const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
export const manager = new ConsoleManager();

let mongo: MongoMemoryServer;
let tmpRoot: string;

export async function startRig(): Promise<void> {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "console-rig-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}

export async function stopRig(): Promise<void> {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

/** A fresh adopted workspace repo; alice and bob have personal folders. */
export async function resetRig(): Promise<void> {
  consoleCommitHooks.afterRead = undefined;
  consoleCommitHooks.afterCommit = undefined;
  consoleCommitHooks.afterSyncRead = undefined;
  await SavedConsole.deleteMany({});
  await ConsoleFolder.deleteMany({});
  await WorkspaceUserHandle.deleteMany({});
  await WorkspaceUserHandle.create([
    { workspaceId: new Types.ObjectId(WS), userId: ALICE, handle: "alice" },
    { workspaceId: new Types.ObjectId(WS), userId: BOB, handle: "bob" },
  ]);
  invalidateOwnerDirectory();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
  await adoptWorkspaceConsoles(WS, { replayHistory: false });
}

/** A saved console (workspace-visible unless `access` says otherwise). */
export async function save(
  name: string,
  code = "SELECT 1",
  options: { access?: "workspace" | "private"; by?: string } = {},
): Promise<ISavedConsole> {
  return manager.saveConsole(
    name,
    code,
    WS,
    options.by ?? ALICE,
    undefined,
    undefined,
    undefined,
    { access: options.access ?? "workspace", language: "sql" },
  );
}

/** Every console file on main (README and chart sidecars left out). */
export async function consoleFiles(): Promise<string[]> {
  const head = await resolveCommit(repoDirFor(WS), MAIN);
  if (!head) return [];
  return (await listTree(repoDirFor(WS), head))
    .map(e => e.path)
    .filter(p => parseConsoleRepoPath(p))
    .sort();
}

export async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), MAIN, rel)).contents;
  } catch {
    return null;
  }
}

/** A push from a laptop: commit straight onto the bare repo's main. */
export async function push(
  writes: Record<string, string>,
  deletes: string[] = [],
): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message: "laptop", author: { name: "Lap", email: "lap@example.com" } },
  );
}

export const sync = () => syncConsolesIndexFromRepo(WS);

export async function row(id: unknown): Promise<ISavedConsole | null> {
  return SavedConsole.findById(String(id));
}

/** `row`, for a console that must exist. */
export async function found(id: unknown): Promise<ISavedConsole> {
  const hit = await row(id);
  if (!hit) throw new Error(`No console ${String(id)}`);
  return hit;
}

/** The ids the explorer lists (files at main joined with the index). */
export async function listedIds(): Promise<string[]> {
  return (await loadLiveConsoles(WS)).map(c => c.id.toString());
}

/**
 * Hold the next operation that reaches `point` until `release()`:
 * `reached` resolves when it is there. One use; later operations pass.
 */
export function holdAt(point: "afterRead" | "afterCommit" | "afterSyncRead"): {
  reached: Promise<void>;
  release: () => void;
} {
  let arrived!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => (arrived = resolve));
  const gate = new Promise<void>(resolve => (release = resolve));
  consoleCommitHooks[point] = async () => {
    consoleCommitHooks[point] = undefined;
    arrived();
    await gate;
  };
  return { reached, release };
}
