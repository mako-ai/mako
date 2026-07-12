/**
 * E2B provider — live integration test (self-skips without E2B_API_KEY).
 *
 * Exercises the REAL provider chain end-to-end: worktree materialization on
 * the host, command execution inside a Firecracker microVM, file sync back,
 * WIP-ref flush, and commit — proving the executor seam holds for the
 * production substrate, not just the local dev one.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  commitWorktree,
  createProject,
  ensureWorktree,
  execInWorktree,
  listFiles,
  projectHistory,
  readFile,
} from "../worktree.service";

const HAS_KEY = Boolean(process.env.E2B_API_KEY);
const suite = HAS_KEY ? describe : describe.skip;

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const USER = "e2b-user";

beforeAll(async () => {
  if (!HAS_KEY) return;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-v2-e2b-test-"));
  process.env.APPS_V2_ENABLED = "1";
  process.env.APPS_V2_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_V2_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_V2_SANDBOX_PROVIDER = "e2b";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  if (!HAS_KEY) return;
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!HAS_KEY) return;
  await mongoose.connection.collection("app_projects_v2").deleteMany({});
  await mongoose.connection.collection("app_worktrees_v2").deleteMany({});
});

suite("e2b sandbox provider (live)", () => {
  it("runs commands in a microVM, syncs changes back, flushes and commits", async () => {
    const project = await createProject({
      workspaceId: WS,
      title: "E2B Live Test",
      userId: USER,
    });
    const handle = await ensureWorktree(project, USER);

    // 1. The command runs in the sandbox, not on the host.
    const who = await execInWorktree(handle, "uname -a && whoami && pwd && ls");
    expect(who.exitCode).toBe(0);
    expect(who.stdout).toContain("/home/user/app");
    expect(who.stdout).toContain("package.json");

    // 2. File mutations inside the sandbox reach the durable WIP ref.
    const write = await execInWorktree(
      handle,
      'printf "from-e2b\\n" > sandbox-note.txt && git status --short',
    );
    expect(write.exitCode).toBe(0);
    expect(write.flush.flushed).toBe(true);

    const file = await readFile(project, "sandbox-note.txt", USER);
    expect(file.contents).toBe("from-e2b\n");

    // 3. Session reuse: env sentinel written to the sandbox FS outside the
    // synced tree survives into the next command (same sandbox).
    await execInWorktree(handle, "echo warm > /home/user/.mako-warm");
    const warm = await execInWorktree(handle, "cat /home/user/.mako-warm");
    expect(warm.stdout.trim()).toBe("warm");

    // 3b. Pause/resume: explicitly pause the sandbox (same snapshot type
    // as the idle auto-pause) and run again — connect() resumes it and the
    // frozen filesystem (sentinel) is intact.
    const { Sandbox } = await import("e2b");
    const paginator = Sandbox.list({
      apiKey: process.env.E2B_API_KEY,
      query: {
        metadata: { makoAppsV2SessionKey: handle.doc._id.toString() },
      },
      limit: 5,
    });
    const page = paginator.hasNext ? await paginator.nextItems() : [];
    expect(page.length).toBeGreaterThan(0);
    await Sandbox.pause(page[0].sandboxId, {
      apiKey: process.env.E2B_API_KEY,
    });
    const resumed = await execInWorktree(
      handle,
      "cat /home/user/.mako-warm && echo resumed-ok",
    );
    expect(resumed.stdout).toContain("warm");
    expect(resumed.stdout).toContain("resumed-ok");

    // 4. Commit through the broker (never from inside the sandbox).
    const commit = await commitWorktree(handle, "E2B live change");
    expect(commit.committed).toBe(true);
    const history = await projectHistory(project);
    expect(history.map(c => c.subject)).toEqual([
      "E2B live change",
      "Initial scaffold",
    ]);

    const { entries } = await listFiles(project, USER);
    expect(entries.map(e => e.path)).toContain("sandbox-note.txt");
  }, 240_000);
});
