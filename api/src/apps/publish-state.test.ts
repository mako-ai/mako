/**
 * Publish state — what the published chip and app_publish_status report.
 *
 * Real git on disk, no Mongo, no network. Run with
 * `pnpm --filter api run test:apps`.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the pure git half is under test; keep the service graph out.
vi.mock("./cloud-repo.service", () => ({ freshenForServe: vi.fn() }));
vi.mock("./worktree.service", () => ({ appRootFor: vi.fn() }));

import { readPublishState } from "./publish-state";

const exec = promisify(execFile);

let repoDir: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "ada@example.com",
    },
  });
  return stdout.trim();
}

/** Write one file and commit it; returns the new sha. */
async function commit(file: string, subject: string): Promise<string> {
  const abs = path.join(repoDir, file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${subject}\n`);
  await git("add", file);
  await git("commit", "-q", "-m", subject);
  return git("rev-parse", "HEAD");
}

function read(publishedSha: string | null) {
  return readPublishState(repoDir, {
    branch: "main",
    appRoot: "apps/sales",
    publishedSha,
    publishedAt: new Date("2026-09-24T12:00:00Z"),
    lastDeployError: null,
  });
}

beforeEach(async () => {
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "apps-publish-state-"));
  await git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await fs.rm(repoDir, { recursive: true, force: true });
});

describe("readPublishState", () => {
  it("describes the published commit and reads up to date at the tip", async () => {
    const sha = await commit("apps/sales/App.tsx", "feat: seasonality");
    const state = await read(sha);
    expect(state.published).toBe(true);
    expect(state.upToDate).toBe(true);
    expect(state.pendingCommits).toBe(0);
    expect(state.publishedCommit).toMatchObject({
      author: "Ada Lovelace",
      subject: "feat: seasonality",
    });
    // Epoch ms, like the history endpoint the frontend already renders.
    expect(state.publishedCommit?.timestamp).toBeGreaterThan(1e12);
    expect(state.publishedAt?.toISOString()).toBe("2026-09-24T12:00:00.000Z");
  });

  it("counts app commits on main that are not live", async () => {
    const sha = await commit("apps/sales/App.tsx", "v1");
    await commit("apps/sales/App.tsx", "v2");
    await commit("apps/sales/lib.ts", "v3");
    const state = await read(sha);
    expect(state.upToDate).toBe(false);
    expect(state.pendingCommits).toBe(2);
    expect(state.publishedCommit?.subject).toBe("v1");
  });

  it("ignores commits to other apps", async () => {
    const sha = await commit("apps/sales/App.tsx", "v1");
    await commit("apps/other/App.tsx", "other app");
    await commit("README.md", "docs");
    const state = await read(sha);
    expect(state.upToDate).toBe(true);
    expect(state.pendingCommits).toBe(0);
  });

  it("degrades to unknown when the published commit is not in the repo", async () => {
    await commit("apps/sales/App.tsx", "v1");
    const state = await read("f".repeat(40));
    expect(state.published).toBe(true);
    expect(state.upToDate).toBe(false);
    expect(state.publishedCommit).toBeNull();
    expect(state.pendingCommits).toBeNull();
  });

  it("never passes a non-oid published sha to git", async () => {
    await commit("apps/sales/App.tsx", "v1");
    const state = await read("--output=/tmp/x");
    expect(state.published).toBe(false);
    expect(state.publishedSha).toBeNull();
  });

  it("reports an unpublished app", async () => {
    await commit("apps/sales/App.tsx", "v1");
    const state = await read(null);
    expect(state).toMatchObject({
      published: false,
      publishedCommit: null,
      pendingCommits: null,
      upToDate: false,
    });
  });
});
