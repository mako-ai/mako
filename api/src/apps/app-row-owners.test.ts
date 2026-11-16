/**
 * The app-row owner backfill (app-row-owners.ts) and the gated owner stamp
 * (project-rows.ts rowOwnerActor), on real git and an in-memory Mongo.
 *
 * Claims under test: each derivation rule names the right person or nobody;
 * a system actor never becomes an owner; an existing owner is never
 * overwritten; applying twice changes nothing the second time; and the
 * 15-character ids real users have only own rows once the flag is on.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  applyOwnerProposals,
  findOwnerlessRows,
  folderCreatorFromGit,
  formatOwnerReport,
  proposeOwner,
  type OwnerlessRow,
  type WorkspaceOwnerSources,
} from "./app-row-owners";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import {
  ROW_OWNER_PERSON_IDS_FLAG,
  ensureProjectRow,
  rowOwnerActor,
} from "./worktree/project-rows";
import { parseBackfillArgs } from "../scripts/backfill-app-row-owners";

// Real Mako ids: 15 characters (auth.service.ts generateId).
const ALICE = "a1b2c3d4e5f6a7b";
const BOB = "k9x8w7v6u5t4s3r";
const SYSTEM_ACTORS = ["publish", "api-key", "scheduler", "app-chat", ""];

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-row-owners-"));
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env[ROW_OWNER_PERSON_IDS_FLAG];
});

// ---------------------------------------------------------------------------
// A real repo with known authors
// ---------------------------------------------------------------------------

async function makeRepo(): Promise<{
  dir: string;
  commit: (email: string, files: Record<string, string>, msg?: string) => void;
  move: (email: string, from: string, to: string) => void;
}> {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "repo-"));
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
  git(["init", "-q", "-b", "main"]);
  const as = (email: string) => ({
    GIT_AUTHOR_NAME: email.split("@")[0] ?? email,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "Mako",
    GIT_COMMITTER_EMAIL: "mako@mako.ai",
  });
  return {
    dir,
    commit(email, files, msg = "change") {
      for (const [file, body] of Object.entries(files)) {
        const full = path.join(dir, file);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
      }
      git(["add", "-A"]);
      git(["commit", "-q", "-m", msg], as(email));
    },
    move(email, from, to) {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git(["mv", from, to]);
      git(["commit", "-q", "-m", `move ${from}`], as(email));
    },
  };
}

const manifest = (title: string) =>
  JSON.stringify({ title, created: title }, null, 2);

function sources(
  overrides: Partial<WorkspaceOwnerSources> = {},
): WorkspaceOwnerSources {
  const users = new Map([
    ["alice@example.com", ALICE],
    ["bob@example.com", BOB],
  ]);
  return {
    ownerOfHandle: handle => (handle === "alice" ? ALICE : null),
    folderCreator: async () => ({ email: "alice@example.com" }),
    userIdForEmail: async email => users.get(email),
    isMember: id => id === ALICE || id === BOB,
    ...overrides,
  };
}

const row = (p: string, access: OwnerlessRow["access"] = "workspace") => ({
  appId: new Types.ObjectId().toString(),
  workspaceId: new Types.ObjectId().toString(),
  path: p,
  access,
});

// ---------------------------------------------------------------------------
// Rule a: users/<handle>/apps
// ---------------------------------------------------------------------------

describe("rule a: personal tree", () => {
  it("names the person the handle mapping names", async () => {
    const p = await proposeOwner(
      row("users/alice/apps/kpis", "private"),
      sources(),
    );
    expect(p).toMatchObject({ rule: "personal-handle", ownerId: ALICE });
  });

  it("wins over the folder's commit author", async () => {
    const p = await proposeOwner(
      row("users/alice/apps/kpis", "private"),
      sources({ folderCreator: async () => ({ email: "bob@example.com" }) }),
    );
    expect(p.ownerId).toBe(ALICE);
  });

  it("leaves a handle nobody holds ownerless", async () => {
    const p = await proposeOwner(
      row("users/ghost/apps/kpis", "private"),
      sources(),
    );
    expect(p).toMatchObject({ rule: "none", reason: "handle is nobody's" });
    expect(p.ownerId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule b: the author of the commit that created the folder
// ---------------------------------------------------------------------------

describe("rule b: folder author on real git", () => {
  it("finds the creating author across edits and a move", async () => {
    const repo = await makeRepo();
    repo.commit("alice@example.com", {
      "apps/sales/mako.json": manifest("Sales"),
    });
    repo.commit("bob@example.com", {
      "apps/sales/mako.json": manifest("Sales v2"),
      "apps/sales/index.tsx": "export {}",
    });
    repo.move("bob@example.com", "apps/sales", "apps/team/sales");
    expect(await folderCreatorFromGit(repo.dir, "apps/team/sales")).toEqual({
      email: "alice@example.com",
    });
  });

  it("names nobody for a sweep commit that created many apps", async () => {
    const repo = await makeRepo();
    const files: Record<string, string> = {};
    for (const n of ["a", "b", "c", "d"]) {
      files[`apps/${n}/mako.json`] = manifest(n);
    }
    repo.commit("alice@example.com", files, "import");
    expect(await folderCreatorFromGit(repo.dir, "apps/a")).toEqual({
      missing: "created in a sweep commit (4 apps)",
    });
  });

  it("names nobody for a folder main never had", async () => {
    const repo = await makeRepo();
    repo.commit("alice@example.com", { "apps/x/mako.json": manifest("x") });
    expect(await folderCreatorFromGit(repo.dir, "apps/gone")).toEqual({
      missing: "no creating commit on main",
    });
  });

  it("maps the author to a member", async () => {
    const p = await proposeOwner(row("apps/sales"), sources());
    expect(p).toMatchObject({ rule: "folder-author", ownerId: ALICE });
  });

  it("leaves the row ownerless when the author is not a Mako user", async () => {
    const p = await proposeOwner(
      row("apps/sales"),
      sources({
        folderCreator: async () => ({ email: "x@users.noreply.github.com" }),
      }),
    );
    expect(p).toMatchObject({
      rule: "none",
      reason: "creating author is not a Mako user",
    });
  });

  it("leaves the row ownerless when the author left the workspace", async () => {
    const p = await proposeOwner(
      row("apps/sales"),
      sources({ isMember: () => false }),
    );
    expect(p).toMatchObject({
      rule: "none",
      reason: "creating author left workspace",
    });
  });

  it("does not decide who owns a private row in the workspace tree", async () => {
    const p = await proposeOwner(row("apps/sales", "private"), sources());
    expect(p).toMatchObject({
      rule: "none",
      reason: "private row in workspace tree",
    });
  });
});

// ---------------------------------------------------------------------------
// System actors never own
// ---------------------------------------------------------------------------

describe("system actors never become owners", () => {
  it.each(SYSTEM_ACTORS)("%j through rule a or b", async actor => {
    const a = await proposeOwner(
      row("users/alice/apps/kpis", "private"),
      sources({ ownerOfHandle: () => actor || null }),
    );
    expect(a.ownerId).toBeUndefined();
    const b = await proposeOwner(
      row("apps/sales"),
      sources({
        userIdForEmail: async () => actor || undefined,
        isMember: () => true,
      }),
    );
    expect(b.ownerId).toBeUndefined();
  });

  it.each(SYSTEM_ACTORS)(
    "%j through the owner stamp, flag on or off",
    actor => {
      expect(rowOwnerActor(actor)).toBeUndefined();
      process.env[ROW_OWNER_PERSON_IDS_FLAG] = "1";
      expect(rowOwnerActor(actor)).toBeUndefined();
    },
  );

  it("a proposal naming a system actor is never written", async () => {
    const doc = await AppProject.create({
      workspaceId: new Types.ObjectId(),
      title: "t",
      path: "apps/sys",
      access: "workspace",
    });
    const changed = await applyOwnerProposals([
      {
        appId: doc._id.toString(),
        workspaceId: doc.workspaceId.toString(),
        path: "apps/sys",
        access: "workspace",
        rule: "folder-author",
        ownerId: "publish",
      },
    ]);
    expect(changed).toBe(0);
    expect((await AppProject.findById(doc._id))?.owner_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Apply: only ownerless rows, idempotent
// ---------------------------------------------------------------------------

describe("apply", () => {
  it("sets ownerless rows once, never overwrites an owner", async () => {
    const ws = new Types.ObjectId();
    const ownerless = await AppProject.create({
      workspaceId: ws,
      title: "Sales",
      path: "apps/sales",
      access: "workspace",
      createdBy: "",
    });
    const owned = await AppProject.create({
      workspaceId: ws,
      title: "Ops",
      path: "apps/ops",
      access: "workspace",
      owner_id: BOB,
      createdBy: BOB,
    });
    const createdByOnly = await AppProject.create({
      workspaceId: ws,
      title: "Old",
      path: "apps/old",
      access: "workspace",
      createdBy: BOB,
    });

    const found = await findOwnerlessRows(ws.toString());
    expect(found.map(r => r.appId)).toEqual([ownerless._id.toString()]);

    const proposals = await Promise.all(
      found.map(r => proposeOwner(r, sources())),
    );
    // A stale or hand-written proposal aimed at owned rows must not land.
    const hostile = [owned, createdByOnly].map(d => ({
      appId: d._id.toString(),
      workspaceId: ws.toString(),
      path: d.path ?? "",
      access: "workspace" as const,
      rule: "folder-author" as const,
      ownerId: ALICE,
    }));

    expect(await applyOwnerProposals([...proposals, ...hostile])).toBe(1);
    expect(await applyOwnerProposals([...proposals, ...hostile])).toBe(0);

    const after = await AppProject.findById(ownerless._id).lean();
    expect(after).toMatchObject({ owner_id: ALICE, createdBy: ALICE });
    expect((await AppProject.findById(owned._id))?.owner_id).toBe(BOB);
    const old = await AppProject.findById(createdByOnly._id).lean();
    expect(old?.owner_id).toBeUndefined();
    expect(old?.createdBy).toBe(BOB);
    expect(await findOwnerlessRows(ws.toString())).toEqual([]);
  });

  it("prints counts and prefixes, never emails or full ids", async () => {
    const report = formatOwnerReport([
      { ...row("apps/sales"), rule: "folder-author", ownerId: ALICE },
      { ...row("apps/x"), rule: "none", reason: "no creating commit on main" },
    ]);
    expect(report).toContain("b folder-author:   1");
    expect(report).toContain("c none:            1");
    expect(report).toContain(`${ALICE.slice(0, 6)}…`);
    expect(report).not.toContain(ALICE);
    expect(report).not.toContain("@");
  });

  it("dry run is the default", () => {
    expect(parseBackfillArgs([]).apply).toBe(false);
    expect(parseBackfillArgs(["--apply"]).apply).toBe(true);
    expect(() => parseBackfillArgs(["--force"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The owner stamp, gated
// ---------------------------------------------------------------------------

describe("ensureProjectRow owner stamp", () => {
  const folderOnly = (slug: string): IAppProject =>
    ({
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(),
      title: slug,
      slug,
      path: `apps/${slug}`,
      access: "workspace",
      createdBy: "",
    }) as IAppProject;

  it("flag off: a 15-character id does not own, as before", async () => {
    const created = await ensureProjectRow(folderOnly("off"), ALICE);
    expect(created.owner_id ?? undefined).toBeUndefined();
  });

  it("flag on: a real user's id owns the row it creates", async () => {
    process.env[ROW_OWNER_PERSON_IDS_FLAG] = "1";
    const created = await ensureProjectRow(folderOnly("on"), ALICE);
    expect(created.owner_id).toBe(ALICE);
    expect(created.createdBy).toBe(ALICE);
  });

  it("flag on: an existing owner is kept against the next person", async () => {
    process.env[ROW_OWNER_PERSON_IDS_FLAG] = "1";
    const project = folderOnly("kept");
    await ensureProjectRow(project, ALICE);
    expect((await ensureProjectRow(project, BOB)).owner_id).toBe(ALICE);
  });
});
