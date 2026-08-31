/**
 * PROMPT.md in the workspace repo (apps.md §21): the same bare-repo +
 * mongodb-memory-server rig the consoles/skills suites use.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DEFAULT_BRANCH,
  initRepo,
  log as repoLog,
  repoDirFor,
} from "./repository.service";
import {
  PROMPT_PATH,
  commitWorkspacePrompt,
  readWorkspacePromptFile,
} from "./workspace-prompt";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
});

describe("workspace prompt in git", () => {
  it("reads null with no repo or no file; round-trips a commit", async () => {
    expect(await readWorkspacePromptFile(WS)).toBeNull();
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
});
