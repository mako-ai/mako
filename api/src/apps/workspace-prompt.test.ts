/**
 * PROMPT.md in the workspace repo (apps.md §21): a bare repo on disk, and the
 * workspace's repo binding in PGlite (test-support/pg-test.ts).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { setupPgTestDb, type PgTestDb } from "../test-support/pg-test";
import {
  DEFAULT_BRANCH,
  initRepo,
  log as repoLog,
  repoDirFor,
} from "./repository.service";
import {
  PROMPT_PATH,
  SELF_DIRECTIVE_PATH,
  commitWorkspacePrompt,
  commitWorkspaceSelfDirective,
  readWorkspacePromptFile,
  readWorkspaceSelfDirectiveFile,
} from "./workspace-prompt";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "./bind-test-workspace-repo";

let pgh: PgTestDb;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  pgh = await setupPgTestDb();
});

afterAll(async () => {
  await pgh.close();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

beforeEach(async () => {
  await pgh.reset();
  await fs.rm(path.join(tmpRoot, "repos"), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await bindTestWorkspaceRepo(WS);
});

describe("workspace prompt in git", () => {
  it("reads null with no repo or no file; round-trips a commit", async () => {
    await unbindTestWorkspaceRepo(WS);
    expect(await readWorkspacePromptFile(WS)).toBeNull();
    await bindTestWorkspaceRepo(WS);
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    expect(await readWorkspacePromptFile(WS)).toBeNull();

    const result = await commitWorkspacePrompt(WS, "# RevOps context\n");
    expect(result.unchanged).toBe(false);
    expect(await readWorkspacePromptFile(WS)).toBe("# RevOps context\n");
    const [head] = await repoLog(repoDirFor(WS), MAIN, 1);
    expect(head.subject).toBe(`prompt: update ${PROMPT_PATH}`);
  });

  it("an identical save is a no-op; empty content deletes the file", async () => {
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    await commitWorkspacePrompt(WS, "same\n");
    const again = await commitWorkspacePrompt(WS, "same\n");
    expect(again.unchanged).toBe(true);

    await commitWorkspacePrompt(WS, "   ");
    expect(await readWorkspacePromptFile(WS)).toBeNull();
    const [head] = await repoLog(repoDirFor(WS), MAIN, 1);
    expect(head.subject).toBe(`prompt: clear ${PROMPT_PATH}`);
  });

  it("a trailing newline is normalized on", async () => {
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    await commitWorkspacePrompt(WS, "no newline");
    expect(await readWorkspacePromptFile(WS)).toBe("no newline\n");
  });

  it("self-directive lives in SELF_DIRECTIVE.md, not PROMPT.md", async () => {
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    await commitWorkspaceSelfDirective(WS, "Never drop prod\n");
    expect(await readWorkspaceSelfDirectiveFile(WS)).toBe("Never drop prod\n");
    expect(await readWorkspacePromptFile(WS)).toBeNull();
    const [head] = await repoLog(repoDirFor(WS), MAIN, 1);
    expect(head.subject).toBe(`self-directive: update ${SELF_DIRECTIVE_PATH}`);
  });

  it("does not serve leftover PROMPT.md when no GitHub repo is bound", async () => {
    await initRepo(repoDirFor(WS), { "PROMPT.md": "loop2-local-git\n" });
    expect(await readWorkspacePromptFile(WS)).toBe("loop2-local-git\n");
    await unbindTestWorkspaceRepo(WS);
    expect(await readWorkspacePromptFile(WS)).toBeNull();
  });
});
