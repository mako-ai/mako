/**
 * The doors onto main that run no hook: a branch merge and an app publish.
 * Each test is the attack a review found: a member pushes branch `x` with
 * new code under connectors/ (allowed, `x` is not main), then lands it on
 * main through a door that skipped the role check.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  ensureTestMember,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../../test-support/pg-test";

const mocks = vi.hoisted(() => ({
  promoteToMain: vi.fn(),
  trialMerge: vi.fn(),
  repoDir: "",
  mainSha: "",
}));

vi.mock("../worktree.service", () => ({
  PUBLISH_ACTOR: "publisher",
  checkoutInBox: vi.fn(),
  defaultBranchSha: vi.fn(async () => mocks.mainSha),
  ensureProjectRow: vi.fn(async (project: unknown) => project),
  ensureWorktree: vi.fn(async () => ({
    repoDir: mocks.repoDir,
    doc: { branch: "x" },
  })),
  execInWorktree: vi.fn(),
  promoteToMain: mocks.promoteToMain,
  trialMerge: mocks.trialMerge,
}));
vi.mock("../cloud-repo.service", () => ({
  freshenBeforeMainWrite: vi.fn(async () => undefined),
  mirrorPushNow: vi.fn(async () => undefined),
}));

import { publishApp } from "../app-publish.service";
import { assertMayLandOnMain } from "./main-gate";

const run = promisify(execFile);
const WS = new Types.ObjectId().toString();
let pgh: PgTestDb;
let tmp: string;
let repoDir: string;
let mainSha: string;
let connectorSha: string;
let workflowSha: string;
let appSha: string;

const git = async (...args: string[]) =>
  (await run("git", ["-C", repoDir, ...args])).stdout.trim();

async function commitOn(file: string, base: string): Promise<string> {
  await git("checkout", "-q", "--detach", base);
  await fs.mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
  await fs.writeFile(path.join(repoDir, file), "// new code\n");
  await git("add", "-A");
  await git("commit", "-qm", file);
  return git("rev-parse", "HEAD");
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "main-gate-"));
  repoDir = path.join(tmp, "repo");
  await fs.mkdir(repoDir);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "T");
  await fs.writeFile(path.join(repoDir, "README.md"), "x\n");
  await git("add", "-A");
  await git("commit", "-qm", "seed");
  mainSha = await git("rev-parse", "HEAD");
  connectorSha = await commitOn("connectors/close/connector.ts", mainSha);
  workflowSha = await commitOn("workflows/digest/workflow.ts", mainSha);
  appSha = await commitOn("apps/sales/src/app.ts", mainSha);
  mocks.repoDir = repoDir;
  mocks.mainSha = mainSha;

  pgh = await setupPgTestDb();
  await ensureTestWorkspace(pgh.db, { id: WS });
  await ensureTestMember(pgh.db, {
    workspaceId: WS,
    userId: "member",
    role: "member",
  });
  await ensureTestMember(pgh.db, {
    workspaceId: WS,
    userId: "admin",
    role: "admin",
  });
}, 120_000);

afterAll(async () => {
  await pgh?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const gate = (candidate: string, actorUserId: string | undefined) =>
  assertMayLandOnMain({
    repoDir,
    range: `${mainSha}..${candidate}`,
    workspaceId: WS,
    actorUserId,
  });

describe("assertMayLandOnMain", () => {
  it("refuses a member, and an anonymous caller, landing connectors/ or workflows/", async () => {
    await expect(gate(connectorSha, "member")).rejects.toThrow(
      /Only workspace admins put connector code on main/,
    );
    await expect(gate(connectorSha, undefined)).rejects.toThrow(
      /connector code/,
    );
    await expect(gate(workflowSha, "member")).rejects.toThrow(
      /Only workspace admins put workflows on main/,
    );
  });

  it("lets an admin land them, and anyone land other paths", async () => {
    await gate(connectorSha, "admin");
    await gate(workflowSha, "admin");
    await gate(appSha, "member");
  });
});

describe("app publish", () => {
  const publish = (sha: string, userId: string) => {
    mocks.trialMerge.mockResolvedValue({ ok: true, sha });
    mocks.promoteToMain.mockReset();
    return publishApp(
      { _id: new Types.ObjectId(), workspaceId: new Types.ObjectId(WS) } as any,
      { userId, branch: "x" },
    );
  };

  it("refuses a member publishing a branch that carries connector code, before main moves", async () => {
    const outcome = await publish(connectorSha, "member");
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(mocks.promoteToMain).not.toHaveBeenCalled();
  });

  it("refuses a member publishing a branch that carries workflow code", async () => {
    const outcome = await publish(workflowSha, "member");
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(mocks.promoteToMain).not.toHaveBeenCalled();
  });

  it("promotes an admin's publish of the same branch", async () => {
    mocks.promoteToMain.mockRejectedValueOnce(new Error("stop after promote"));
    await publish(connectorSha, "admin").catch(() => undefined);
    expect(mocks.promoteToMain).toHaveBeenCalled();
  });
});
