/**
 * The editor's first save of a console (a draft's "Save as…", or a save
 * under a brand-new id) onto a path a laptop push already holds, synced or
 * not: the commit is a compare-and-swap ("path must be absent") and the
 * route answers 409 — the pushed file is never overwritten. Real route,
 * real bare repo, mongodb-memory-server; auth and membership are stubbed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Hono } from "hono";

const USER = new Types.ObjectId().toString();

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: USER, email: "u@example.com" });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async () => true,
    getMember: async () => ({ role: "member" }),
  },
}));
vi.mock("../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));

import { ConsoleFolder, SavedConsole } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { serializeConsoleFile } from "../apps/console-files";
import { ConsoleManager } from "../utils/console-manager";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { consoleRoutes } from "./consoles";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let app: Hono;
const WS = new Types.ObjectId().toString();
const LAPTOP = serializeConsoleFile({
  name: "report",
  language: "sql",
  code: "SELECT 'laptop work'",
});

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consoles-first-save-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = new Hono();
  app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await SavedConsole.deleteMany({});
  await ConsoleFolder.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
  // Adopt (first write), then a laptop push that no sync has taken in.
  await new ConsoleManager().saveConsole(
    "seed",
    "SELECT 0\n",
    WS,
    USER,
    undefined,
    undefined,
    undefined,
    { access: "workspace", language: "sql" },
  );
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes: { "consoles/report.sql": LAPTOP } },
    { message: "laptop", author: { name: "Laptop", email: "l@example.com" } },
  );
});

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`, rel))
      .contents;
  } catch {
    return null;
  }
}

async function put(id: string, body: unknown) {
  const res = await app.request(`/api/workspaces/${WS}/consoles/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

describe("first save onto a pushed, unsynced file", () => {
  it("a brand-new console (no row) is refused with 409; the file is untouched", async () => {
    const r = await put(new Types.ObjectId().toString(), {
      content: "SELECT 'mine'",
      path: "report",
      isSaved: true,
      access: "workspace",
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("A console named 'report' already exists");
    expect(await fileAt("consoles/report.sql")).toBe(LAPTOP);
  });

  it("a draft's first save (the editor's normal Save as…) is refused with 409; the file is untouched", async () => {
    const draft = await SavedConsole.create({
      workspaceId: new Types.ObjectId(WS),
      name: "Untitled",
      code: "SELECT 'mine'",
      language: "sql",
      isSaved: false,
      access: "private",
      isPrivate: true,
      owner_id: USER,
      createdBy: USER,
    });
    const r = await put(draft._id.toString(), {
      content: "SELECT 'mine'",
      path: "report",
      isSaved: true,
      access: "workspace",
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("A console named 'report' already exists");
    expect(await fileAt("consoles/report.sql")).toBe(LAPTOP);
    expect((await SavedConsole.findById(draft._id))?.isSaved).toBe(false);
    // A free name saves as before.
    const ok = await put(draft._id.toString(), {
      content: "SELECT 'mine'",
      path: "mine",
      isSaved: true,
      access: "workspace",
    });
    expect(ok.status).toBe(200);
    expect(await fileAt("consoles/mine.sql")).toContain("SELECT 'mine'");
  });
});

describe("a name that differs only in letter case is taken (one file on macOS / Windows)", () => {
  it("a brand-new console and a draft's first save are refused next to 'report' as 'Report'", async () => {
    const fresh = await put(new Types.ObjectId().toString(), {
      content: "SELECT 'mine'",
      path: "Report",
      isSaved: true,
      access: "workspace",
    });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error).toContain("already exists");
    const draft = await SavedConsole.create({
      workspaceId: new Types.ObjectId(WS),
      name: "Untitled",
      code: "SELECT 'mine'",
      language: "sql",
      isSaved: false,
      access: "private",
      isPrivate: true,
      owner_id: USER,
      createdBy: USER,
    });
    const r = await put(draft._id.toString(), {
      content: "SELECT 'mine'",
      path: "REPORT",
      isSaved: true,
      access: "workspace",
    });
    expect(r.status).toBe(409);
    expect(await fileAt("consoles/Report.sql")).toBeNull();
    expect(await fileAt("consoles/REPORT.sql")).toBeNull();
    expect(await fileAt("consoles/report.sql")).toBe(LAPTOP);
  });
});
