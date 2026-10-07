/**
 * The shared rig of the console scenario suites (`*.scenarios.test.ts`
 * beside this file): a real bare repo per workspace under a temp
 * APPS_GIT_ROOT, mongodb-memory-server for the index, and the REAL console
 * and objects routes mounted on a Hono app. Auth and membership are the
 * only stubs — each suite mocks `unified-auth.middleware` and
 * `workspace.service` from the hoisted `who` it hands to `createConsoleRig`,
 * so the acting user (and their workspace role, or no membership at all)
 * can be switched per request.
 *
 * The three entry points of a rename are all here: the UI/REST routes
 * (`api()`), the agent's `rename_object` (`renameObject` from the registry,
 * what the tool calls) and a laptop push (`laptop()`: one commit on the
 * bare repo's main, then the index sync the push hook runs).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Hono } from "hono";
import {
  ConsoleFolder,
  SavedConsole,
  type ISavedConsole,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import {
  adoptWorkspaceConsoles,
  consoleHistory,
  syncConsolesIndexFromRepo,
} from "../../apps/workspace-consoles.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../../apps/bind-test-workspace-repo";
import { ConsoleManager } from "../../utils/console-manager";
import { consoleRoutes } from "../consoles";
import { objectRoutes } from "../objects";

export const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

/** Who is calling: a user id and their workspace role (null = not a member). */
export interface Who {
  id: string;
  role: string | null;
}

export type Role = "owner" | "admin" | "member" | "viewer";

export interface Actor {
  id: string;
  role: Role | null;
}

export type Body = {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  console?: Record<string, unknown>;
  commits?: Array<{ oid: string; subject: string; path?: string }>;
  versions?: { before: string | null; after: string | null };
  result?: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface Snapshot {
  rows: unknown[];
  folders: unknown[];
  files: string[];
}

export interface ConsoleRig {
  readonly ws: string;
  /** A second workspace: same names, never interferes. */
  readonly ws2: string;
  readonly manager: ConsoleManager;
  /** The cast: an owner of consoles, an admin, editors, members, viewers. */
  readonly people: {
    owner: Actor;
    admin: Actor;
    editor: Actor;
    member: Actor;
    viewer: Actor;
    outsider: Actor;
  };
  api(
    method: string,
    url: string,
    as: Actor,
    body?: unknown,
    ws?: string,
  ): Promise<{ status: number; body: Body }>;
  /** `rename_object`'s context for an actor (what the tool builds). */
  ctx(
    as: Actor | null,
    ws?: string,
  ): { workspaceId: string; userId?: string; role?: string };
  save(
    name: string,
    owner: Actor,
    opts?: {
      access?: "private" | "workspace";
      code?: string;
      folderId?: string;
      ws?: string;
    },
  ): Promise<ISavedConsole>;
  shareWith(
    id: Types.ObjectId | string,
    userId: string,
    role?: "editor" | "viewer",
  ): Promise<void>;
  row(id: Types.ObjectId | string): Promise<ISavedConsole | null>;
  /** One commit on main as a laptop push would land it, then the push sync. */
  laptop(
    mutation: { writes?: Record<string, string>; deletes?: string[] },
    opts?: { message?: string; pusher?: string; ws?: string; sync?: boolean },
  ): Promise<string>;
  /** Mark the workspace adopted (a laptop file is synced, not skipped). */
  adopt(ws?: string): Promise<void>;
  treePaths(ws?: string): Promise<string[]>;
  consolePaths(ws?: string): Promise<string[]>;
  fileAt(rel: string, ws?: string): Promise<string | null>;
  commitCount(ws?: string): Promise<number>;
  headSubject(ws?: string): Promise<string | undefined>;
  history(id: Types.ObjectId | string): Promise<string[]>;
  /**
   * Everything a rename may NOT touch, as one comparable value: every row
   * (except `except`) with its name/path/folder/access/blob/shares, every
   * folder record, and every file at main with its blob.
   */
  snapshot(except?: Array<Types.ObjectId | string>): Promise<Snapshot>;
}

export function createConsoleRig(who: Who, prefix: string): ConsoleRig {
  let mongo: MongoMemoryServer;
  let tmpRoot: string;
  let app: Hono;
  const ws = new Types.ObjectId().toString();
  const ws2 = new Types.ObjectId().toString();
  const manager = new ConsoleManager();
  const person = (role: Role | null): Actor => ({
    id: new Types.ObjectId().toString(),
    role,
  });
  const people = {
    owner: person("member"),
    admin: person("admin"),
    editor: person("member"),
    member: person("member"),
    viewer: person("viewer"),
    outsider: person(null),
  };

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
    process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
    process.env.APPS_SANDBOX_PROVIDER = "local";
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    app = new Hono();
    app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);
    app.route("/api/workspaces/:workspaceId/objects", objectRoutes);
  }, 120_000);

  afterAll(async () => {
    await unbindTestWorkspaceRepo(ws).catch(() => undefined);
    await unbindTestWorkspaceRepo(ws2).catch(() => undefined);
    await mongoose.disconnect();
    await mongo.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await SavedConsole.deleteMany({});
    await ConsoleFolder.deleteMany({});
    await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
    for (const id of [ws, ws2]) {
      await initRepo(repoDirFor(id), { "README.md": "x\n" });
      await bindTestWorkspaceRepo(id);
    }
  });

  const api: ConsoleRig["api"] = async (method, url, as, body, onWs) => {
    who.id = as.id;
    who.role = as.role;
    const res = await app.request(
      `/api/workspaces/${onWs ?? ws}${url}`,
      method === "GET"
        ? { method }
        : {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
          },
    );
    const text = await res.text();
    let parsed: Body;
    try {
      parsed = JSON.parse(text) as Body;
    } catch {
      parsed = { error: text };
    }
    return { status: res.status, body: parsed };
  };

  const treePaths = async (onWs = ws) => {
    const head = await resolveCommit(repoDirFor(onWs), MAIN);
    if (!head) return [];
    return (await listTree(repoDirFor(onWs), head)).map(e => e.path).sort();
  };

  return {
    ws,
    ws2,
    manager,
    people,
    api,
    ctx: (as, onWs = ws) =>
      as
        ? { workspaceId: onWs, userId: as.id, role: as.role ?? undefined }
        : { workspaceId: onWs },
    save: (name, owner, opts = {}) =>
      manager.saveConsole(
        name,
        opts.code ?? `SELECT '${name}'\n`,
        opts.ws ?? ws,
        owner.id,
        undefined,
        undefined,
        undefined,
        {
          access: opts.access ?? "workspace",
          language: "sql",
          folderId: opts.folderId,
        },
      ),
    shareWith: async (id, userId, role = "editor") => {
      await SavedConsole.updateOne(
        { _id: id },
        { $push: { sharedWith: { userId, role } } },
      );
    },
    row: id => SavedConsole.findById(id),
    laptop: async (mutation, opts = {}) => {
      const onWs = opts.ws ?? ws;
      const result = await commitBlobsOnBranch(
        repoDirFor(onWs),
        DEFAULT_BRANCH,
        mutation,
        {
          message: opts.message ?? "laptop push",
          author: { name: "Laptop", email: "laptop@example.com" },
        },
      );
      if (opts.sync !== false) {
        await syncConsolesIndexFromRepo(onWs, opts.pusher);
      }
      return result.commitOid;
    },
    adopt: async (onWs = ws) => {
      await adoptWorkspaceConsoles(onWs, { replayHistory: false });
    },
    treePaths,
    consolePaths: async (onWs = ws) =>
      (await treePaths(onWs)).filter(
        p =>
          (p.startsWith("consoles/") || /^users\/[^/]+\/consoles\//.test(p)) &&
          !p.endsWith("README.md"),
      ),
    fileAt: async (rel, onWs = ws) => {
      try {
        const blob = await readBlob(repoDirFor(onWs), MAIN, rel);
        return blob.isBinary ? null : blob.contents;
      } catch {
        return null;
      }
    },
    commitCount: async (onWs = ws) =>
      (await log(repoDirFor(onWs), MAIN, 1000)).length,
    headSubject: async (onWs = ws) =>
      (await log(repoDirFor(onWs), MAIN, 1))[0]?.subject,
    history: async id => {
      const row = await SavedConsole.findById(id);
      if (!row) return [];
      return (await consoleHistory(row, 200)).map(c => c.oid);
    },
    snapshot: async (except = []) => {
      const skip = new Set(except.map(String));
      const rows = (await SavedConsole.find({}).lean())
        .filter(r => !skip.has(String(r._id)))
        .map(r => ({
          id: String(r._id),
          ws: String(r.workspaceId),
          name: r.name,
          path: r.path ?? null,
          folderId: r.folderId ? String(r.folderId) : null,
          access: r.access ?? null,
          isPrivate: r.isPrivate ?? null,
          owner: r.owner_id ?? null,
          blob: r.sourceBlobSha ?? null,
          code: r.code,
          saved: r.isSaved ?? null,
          deleted: r.is_deleted ?? false,
          shares: (r.sharedWith ?? []).map(s => `${s.userId}:${s.role}`),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const folders = (await ConsoleFolder.find({}).lean())
        .map(f => ({
          id: String(f._id),
          name: f.name,
          parent: f.parentId ? String(f.parentId) : null,
          access: f.access ?? null,
          owner: f.ownerId ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const files: string[] = [];
      for (const onWs of [ws, ws2]) {
        const head = await resolveCommit(repoDirFor(onWs), MAIN);
        if (!head) continue;
        for (const e of await listTree(repoDirFor(onWs), head)) {
          files.push(`${onWs}:${e.path}:${e.oid}`);
        }
      }
      const exceptPaths = new Set(
        (await SavedConsole.find({ _id: { $in: [...skip] } }).lean()).map(
          r => r.path,
        ),
      );
      return {
        rows,
        folders,
        files: files
          .filter(f => {
            const rel = f.split(":")[1] ?? "";
            const base = rel.replace(/\.(sql|js|mongodb\.js)$/, "");
            return (
              !exceptPaths.has(rel) &&
              ![...exceptPaths].some(
                p => p && `${base}.chart.json` === rel && p.startsWith(base),
              )
            );
          })
          .sort(),
      };
    },
  };
}
