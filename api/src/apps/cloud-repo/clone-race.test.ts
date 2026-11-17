/**
 * Concurrent restores of one workspace repo on one instance.
 *
 * Prod, 2026-11-17 10:52 (rollout of #1315): the boot warm's clone ran past
 * runGit's 30 s timeout, so every request awaiting it got a 500, and the
 * next clone found the killed clone's `.cloning-1` temp dir still there.
 * What must hold: any number of concurrent restores end with 0 errors and
 * one valid mirror, one `git clone` per flight, no temp dir left behind.
 *
 * Real git against file:// remotes; Mongo and GitHub auth are mocked.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  binding: null as null | { owner: string; repo: string },
  clones: 0,
  failNextClones: 0,
  /** When set, every clone waits on it before running. */
  gate: null as null | Promise<void>,
}));

vi.mock("../../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => state.binding),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
  findWorkspaceIdsByRepoBinding: vi.fn(async () => []),
}));

vi.mock("../../database/workspace-schema", () => ({
  Workspace: { updateOne: vi.fn(async () => ({})) },
}));

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));

vi.mock("../git", async importOriginal => {
  const actual = await importOriginal<typeof import("../git")>();
  return {
    ...actual,
    runGit: async (args: string[], options?: unknown) => {
      if (args.includes("clone")) {
        state.clones++;
        if (state.gate) await state.gate;
        if (state.failNextClones > 0) {
          state.failNextClones--;
          // What a timeout kill looks like: no stderr, Node's own message.
          throw new actual.GitError(
            `git clone failed: Command failed: git ${args.join(" ")}`,
            args,
            null,
            "",
          );
        }
      }
      return actual.runGit(
        args,
        options as Parameters<typeof actual.runGit>[1],
      );
    },
  };
});

import {
  DEFAULT_BRANCH,
  initRepo,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../repository.service";
import { cloneMirrorInto, ensureLocalRepo, remoteUrl } from "./target";
import { cloneInFlight } from "./clone-state";
import { warmWorkspaceRepos } from "./warm-boot";

let tmpRoot: string;
let remotesRoot: string;
let seq = 0;
let workspaceId: string;
let remoteHead: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clone-race-test-"));
  remotesRoot = path.join(tmpRoot, "remotes");
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotesRoot}`;
});

beforeEach(async () => {
  seq += 1;
  workspaceId = (800000000000 + seq).toString().padStart(24, "0");
  const repo = `ws-${seq}`;
  const remoteDir = path.join(remotesRoot, "acme", `${repo}.git`);
  await fs.mkdir(path.dirname(remoteDir), { recursive: true });
  await initRepo(remoteDir, {
    "apps/site/mako.json": "{}",
    "dbt/dbt_project.yml": "name: race",
  });
  remoteHead = (await resolveCommit(
    remoteDir,
    `refs/heads/${DEFAULT_BRANCH}`,
  )) as string;
  state.binding = { owner: "acme", repo };
  state.clones = 0;
  state.failNextClones = 0;
  state.gate = null;
});

/** Settle every promise; return the rejections. */
async function errorsOf(promises: Promise<unknown>[]): Promise<unknown[]> {
  const results = await Promise.allSettled(promises);
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map(r => r.reason);
}

/** The repo slot is one valid mirror at the remote's head, nothing beside it. */
async function expectOneValidMirror(): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  expect(await repoExists(repoDir)).toBe(true);
  expect(await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`)).toBe(
    remoteHead,
  );
  const siblings = (await fs.readdir(path.dirname(repoDir))).filter(name =>
    name.startsWith(path.basename(repoDir)),
  );
  expect(siblings).toEqual([path.basename(repoDir)]);
  expect(cloneInFlight.has(workspaceId)).toBe(false);
}

describe("concurrent restores of one repo", () => {
  it("20 concurrent ensureLocalRepo calls: 0 errors, 1 clone, 1 valid mirror", async () => {
    const errors = await errorsOf(
      Array.from({ length: 20 }, () => ensureLocalRepo(workspaceId)),
    );
    expect(errors).toEqual([]);
    expect(state.clones).toBe(1);
    await expectOneValidMirror();
  });

  it("8 concurrent clones that bypass the lock: 0 errors, 1 valid mirror", async () => {
    const { owner, repo } = state.binding ?? { owner: "", repo: "" };
    const errors = await errorsOf(
      Array.from({ length: 8 }, () =>
        cloneMirrorInto(
          workspaceId,
          remoteUrl(owner, repo),
          undefined,
          `${owner}/${repo}`,
        ),
      ),
    );
    expect(errors).toEqual([]);
    expect(state.clones).toBe(8);
    await expectOneValidMirror();
  });

  it("requests arriving during the boot warm await its clone", async () => {
    let release!: () => void;
    state.gate = new Promise(resolve => (release = resolve));
    const warm = warmWorkspaceRepos([workspaceId]);
    // Hold the warm's clone open until every request has landed on it.
    await vi.waitFor(() => expect(state.clones).toBe(1));
    expect(cloneInFlight.has(workspaceId)).toBe(true);
    const requests = Array.from({ length: 8 }, () =>
      ensureLocalRepo(workspaceId),
    );
    release();
    const errors = await errorsOf([
      warm.then(result => expect(result).toEqual({ warmed: 1, failed: 0 })),
      ...requests,
    ]);
    expect(errors).toEqual([]);
    expect(state.clones).toBe(1);
    await expectOneValidMirror();
  });

  it("a clone killed on timeout is retried; its awaiting requests succeed", async () => {
    state.failNextClones = 1;
    const errors = await errorsOf(
      Array.from({ length: 8 }, () => ensureLocalRepo(workspaceId)),
    );
    expect(errors).toEqual([]);
    expect(state.clones).toBe(2);
    await expectOneValidMirror();
  });

  it("ignores a leftover `.cloning-1` from a killed clone", async () => {
    // Prod runs as pid 1; locally the old name was `.cloning-<pid>`.
    for (const pid of new Set([1, process.pid])) {
      const leftover = `${repoDirFor(workspaceId)}.cloning-${pid}`;
      await fs.mkdir(path.join(leftover, "objects"), { recursive: true });
      await fs.writeFile(path.join(leftover, "HEAD"), "junk");
    }
    const errors = await errorsOf(
      Array.from({ length: 4 }, () => ensureLocalRepo(workspaceId)),
    );
    expect(errors).toEqual([]);
    const repoDir = repoDirFor(workspaceId);
    expect(await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`)).toBe(
      remoteHead,
    );
  });

  it("fails after 2 attempts, and the next request clones again", async () => {
    state.failNextClones = 2;
    const errors = await errorsOf([
      ensureLocalRepo(workspaceId),
      ensureLocalRepo(workspaceId),
    ]);
    expect(errors).toHaveLength(2);
    expect(state.clones).toBe(2);
    expect(cloneInFlight.has(workspaceId)).toBe(false);

    await ensureLocalRepo(workspaceId);
    expect(state.clones).toBe(3);
    await expectOneValidMirror();
  });
});
