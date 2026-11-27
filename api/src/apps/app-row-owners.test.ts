/**
 * The app-row owner backfill (app-row-owners.ts) and the gated owner stamp
 * (project-rows.ts rowOwnerActor), on real git and an PGlite.
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
import { Types } from "mongoose";
import { legacyUserIdToUuidv7 } from "../database/pg/id-codec";
import { appsMetadataRepo } from "../repositories/apps-metadata";
import {
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";

import {
  applyOwnerProposals,
  findOwnerlessRows,
  folderCreatorFromGit,
  scaffoldEvidenceFromGit,
  formatOwnerReport,
  proposeOwner,
  type OwnerlessRow,
  type WorkspaceOwnerSources,
} from "./app-row-owners";
import type { IAppProject } from "../database/workspace-schema";
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

let pg: PgTestDb;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-row-owners-"));
  pg = await setupPgTestDb();
  await ensureTestUser(pg.db, { id: ALICE });
  await ensureTestUser(pg.db, { id: BOB });
}, 120_000);

afterAll(async () => {
  await pg?.close();
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
  commit: (
    email: string,
    files: Record<string, string>,
    msg?: string,
    at?: string,
  ) => void;
  move: (email: string, from: string, to: string) => void;
  remove: (email: string, folder: string) => void;
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
    commit(email, files, msg = "change", at) {
      for (const [file, body] of Object.entries(files)) {
        const full = path.join(dir, file);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, body);
      }
      git(["add", "-A"]);
      git(
        ["commit", "-q", "-m", msg],
        at
          ? { ...as(email), GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
          : as(email),
      );
    },
    move(email, from, to) {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git(["mv", from, to]);
      git(["commit", "-q", "-m", `move ${from}`], as(email));
    },
    remove(email, folder) {
      git(["rm", "-q", "-r", folder]);
      git(["commit", "-q", "-m", `remove ${folder}`], as(email));
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
    scaffoldEvidence: async () => ({ missing: "not a scaffold" }),
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

  it("names nobody for a path deleted and recreated", async () => {
    const repo = await makeRepo();
    repo.commit("alice@example.com", {
      "apps/dashboard/mako.json": manifest("A"),
    });
    repo.remove("alice@example.com", "apps/dashboard");
    repo.commit("bob@example.com", {
      "apps/dashboard/mako.json": manifest("B"),
    });
    expect(await folderCreatorFromGit(repo.dir, "apps/dashboard")).toEqual({
      missing: "folder created more than once on main (2 adds)",
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
// Rule d: an app Mako's scaffold commit created
// ---------------------------------------------------------------------------

describe("rule d: the Mako-Requested-By trailer, read first", () => {
  it("reads the requester off the creating commit", async () => {
    const repo = await makeRepo();
    repo.commit(
      "bot@mako.ai",
      { "apps/req/mako.json": manifest("req") },
      `Create app "req" (apps/req)\n\nMako-Requested-By: ${ALICE}`,
    );
    repo.commit("bob@example.com", { "apps/req/a.ts": "1" });
    expect(await folderCreatorFromGit(repo.dir, "apps/req")).toEqual({
      email: "bot@mako.ai",
      requestedBy: ALICE,
    });
  });

  const viaTrailer = (requestedBy: string, email = "bob@example.com") =>
    proposeOwner(
      row("apps/req"),
      sources({
        folderCreator: async () => ({ email, requestedBy }),
        // Heuristic evidence that would name someone else: never consulted.
        scaffoldEvidence: async () => ({ builderEmails: ["bob@example.com"] }),
      }),
    );

  it("wins over the commit author and the builder heuristic", async () => {
    expect(await viaTrailer(ALICE)).toMatchObject({
      rule: "scaffold-builder",
      ownerId: ALICE,
    });
    expect(await viaTrailer(ALICE, "bot@mako.ai")).toMatchObject({
      rule: "scaffold-builder",
      ownerId: ALICE,
    });
  });

  it("names no one for a requester who left or a system actor", async () => {
    expect(
      await proposeOwner(
        row("apps/req"),
        sources({
          folderCreator: async () => ({
            email: "bot@mako.ai",
            requestedBy: ALICE,
          }),
          isMember: () => false,
        }),
      ),
    ).toMatchObject({ rule: "none", reason: "requester left workspace" });
    expect(await viaTrailer("publish")).toMatchObject({
      rule: "none",
      reason: "requester is not a person",
    });
  });
});

describe("rule d: scaffold builder on real git", () => {
  const T0 = "2026-10-12T12:00:00Z";
  const at = (minutes: number) =>
    new Date(Date.parse(T0) + minutes * 60_000).toISOString();
  const scaffold = (repo: Awaited<ReturnType<typeof makeRepo>>, p: string) =>
    repo.commit(
      "bot@mako.ai",
      { [`${p}/mako.json`]: manifest(p) },
      `Create app "${p}" (${p})`,
      T0,
    );

  it("names the one person who built it after the scaffold", async () => {
    const repo = await makeRepo();
    scaffold(repo, "apps/territory");
    repo.commit(
      "session@mako.ai",
      { "apps/territory/a.ts": "1" },
      "wip",
      at(5),
    );
    repo.commit(
      "alice@example.com",
      { "apps/territory/b.ts": "1" },
      "x",
      at(11),
    );
    repo.commit(
      "alice@example.com",
      { "apps/territory/c.ts": "1" },
      "y",
      at(90),
    );
    // Outside the window: someone else's later edit does not count.
    repo.commit(
      "bob@example.com",
      { "apps/territory/d.ts": "1" },
      "z",
      at(2000),
    );
    const evidence = await scaffoldEvidenceFromGit(repo.dir, "apps/territory");
    expect(evidence).toEqual({
      builderEmails: [
        "alice@example.com",
        "alice@example.com",
        "session@mako.ai",
      ],
    });
    const p = await proposeOwner(
      row("apps/territory"),
      sources({
        folderCreator: async () => ({ email: "bot@mako.ai" }),
        scaffoldEvidence: async () => evidence,
      }),
    );
    expect(p).toMatchObject({ rule: "scaffold-builder", ownerId: ALICE });
  });

  it("follows the folder from its scaffolded path", async () => {
    const repo = await makeRepo();
    scaffold(repo, "apps/geneve-3");
    repo.commit("alice@example.com", { "apps/geneve-3/a.ts": "1" }, "x", at(3));
    repo.move("bob@example.com", "apps/geneve-3", "apps/geneve");
    expect(await scaffoldEvidenceFromGit(repo.dir, "apps/geneve")).toEqual({
      builderEmails: ["alice@example.com"],
    });
  });

  it("names the person whose personal tree it was scaffolded into", async () => {
    const repo = await makeRepo();
    scaffold(repo, `users/${ALICE}/apps/cohorts`);
    repo.move("bob@example.com", `users/${ALICE}/apps/cohorts`, "apps/cohorts");
    const evidence = await scaffoldEvidenceFromGit(repo.dir, "apps/cohorts");
    expect(evidence).toEqual({ personalSegment: ALICE, builderEmails: [] });
    const p = await proposeOwner(
      row("apps/cohorts"),
      sources({
        folderCreator: async () => ({ email: "bot@mako.ai" }),
        scaffoldEvidence: async () => evidence,
      }),
    );
    expect(p).toMatchObject({ rule: "scaffold-builder", ownerId: ALICE });
  });

  it("is not a scaffold when a person created the folder", async () => {
    const repo = await makeRepo();
    repo.commit("alice@example.com", { "apps/x/mako.json": manifest("x") });
    expect(await scaffoldEvidenceFromGit(repo.dir, "apps/x")).toEqual({
      missing: "creating commit is not a Mako scaffold",
    });
  });

  const viaScaffold = (builderEmails: string[]) =>
    proposeOwner(
      row("apps/s"),
      sources({
        folderCreator: async () => ({ email: "bot@mako.ai" }),
        scaffoldEvidence: async () => ({ builderEmails }),
      }),
    );

  it("names no one when two people built it", async () => {
    expect(
      await viaScaffold(["alice@example.com", "bob@example.com"]),
    ).toMatchObject({
      rule: "none",
      reason: "2 people committed after scaffold",
    });
  });

  it("names no one when an unknown author also built it", async () => {
    expect(
      await viaScaffold(["alice@example.com", "x@gmail.com"]),
    ).toMatchObject({ rule: "none", reason: "unknown author after scaffold" });
  });

  it("names no one when only Mako's own identities committed", async () => {
    expect(
      await viaScaffold(["bot@mako.ai", "session@mako.ai", "agent@mako.ai"]),
    ).toMatchObject({
      rule: "none",
      reason: "nobody committed after scaffold",
    });
  });

  it("names no one who left the workspace", async () => {
    const p = await proposeOwner(
      row("apps/s"),
      sources({
        folderCreator: async () => ({ email: "bot@mako.ai" }),
        scaffoldEvidence: async () => ({ builderEmails: ["bob@example.com"] }),
        isMember: id => id === ALICE,
      }),
    );
    expect(p).toMatchObject({
      rule: "none",
      reason: "scaffold builder left workspace",
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
    const d = await proposeOwner(
      row("apps/sales"),
      sources({
        folderCreator: async () => ({ email: "bot@mako.ai" }),
        scaffoldEvidence: async () => ({
          personalSegment: actor || "publish",
          builderEmails: [],
        }),
        ownerOfHandle: () => actor || null,
        isMember: () => true,
      }),
    );
    expect(d.ownerId).toBeUndefined();
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
    const workspace = await ensureTestWorkspace(pg.db);
    const doc = await appsMetadataRepo.createProject({
      workspaceId: workspace.id,
      title: "t",
      path: "apps/sys",
      access: "workspace",
    });
    const changed = await applyOwnerProposals([
      {
        appId: doc.id,
        workspaceId: doc.workspaceId,
        path: "apps/sys",
        access: "workspace",
        rule: "folder-author",
        ownerId: "publish",
      },
    ]);
    expect(changed).toBe(0);
    expect(
      (await appsMetadataRepo.findProjectById(doc.id))?.owner_id,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Apply: only ownerless rows, idempotent
// ---------------------------------------------------------------------------

describe("apply", () => {
  it("sets ownerless rows once, never overwrites an owner", async () => {
    const { id: ws } = await ensureTestWorkspace(pg.db);
    const ownerless = await appsMetadataRepo.createProject({
      workspaceId: ws,
      title: "Sales",
      path: "apps/sales",
      access: "workspace",
      createdBy: "",
    });
    const owned = await appsMetadataRepo.createProject({
      workspaceId: ws,
      title: "Ops",
      path: "apps/ops",
      access: "workspace",
      owner_id: BOB,
      createdBy: BOB,
    });
    const createdByOnly = await appsMetadataRepo.createProject({
      workspaceId: ws,
      title: "Old",
      path: "apps/old",
      access: "workspace",
      createdBy: BOB,
    });

    const found = await findOwnerlessRows(ws);
    expect(found.map(r => r.appId)).toEqual([ownerless.id]);

    const proposals = await Promise.all(
      found.map(r => proposeOwner(r, sources())),
    );
    // A stale or hand-written proposal aimed at owned rows must not land.
    const hostile = [owned, createdByOnly].map(d => ({
      appId: d.id,
      workspaceId: ws,
      path: d.path ?? "",
      access: "workspace" as const,
      rule: "folder-author" as const,
      ownerId: ALICE,
    }));

    expect(await applyOwnerProposals([...proposals, ...hostile])).toBe(1);
    expect(await applyOwnerProposals([...proposals, ...hostile])).toBe(0);

    const after = await appsMetadataRepo.findProjectById(ownerless.id);
    expect(after).toMatchObject({
      owner_id: legacyUserIdToUuidv7(ALICE),
      createdBy: legacyUserIdToUuidv7(ALICE),
    });
    expect((await appsMetadataRepo.findProjectById(owned.id))?.owner_id).toBe(
      legacyUserIdToUuidv7(BOB),
    );
    const old = await appsMetadataRepo.findProjectById(createdByOnly.id);
    expect(old?.owner_id).toBeUndefined();
    expect(old?.createdBy).toBe(legacyUserIdToUuidv7(BOB));
    expect(await findOwnerlessRows(ws)).toEqual([]);
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
  const folderOnly = async (slug: string): Promise<IAppProject> => {
    const workspace = await ensureTestWorkspace(pg.db);
    return {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(workspace.id),
      title: slug,
      slug,
      path: `apps/${slug}`,
      access: "workspace",
      createdBy: "",
    } as IAppProject;
  };

  it("flag off: a 15-character id does not own, as before", async () => {
    const created = await ensureProjectRow(await folderOnly("off"), ALICE);
    expect(created.owner_id ?? undefined).toBeUndefined();
  });

  it("flag on: a real user's id owns the row it creates", async () => {
    process.env[ROW_OWNER_PERSON_IDS_FLAG] = "1";
    const created = await ensureProjectRow(await folderOnly("on"), ALICE);
    expect(created.owner_id).toBe(legacyUserIdToUuidv7(ALICE));
    expect(created.createdBy).toBe(legacyUserIdToUuidv7(ALICE));
  });

  it("flag on: an existing ownerless row is not claimed by a real user", async () => {
    process.env[ROW_OWNER_PERSON_IDS_FLAG] = "1";
    const project = await folderOnly("leftover");
    // The push-deploy worker made the row before any person acted.
    expect((await ensureProjectRow(project, "publish")).owner_id).toBeFalsy();
    const touched = await ensureProjectRow(project, ALICE);
    expect(touched.owner_id ?? undefined).toBeUndefined();
    expect(touched.createdBy).toBe("");
  });

  it("an existing ownerless row is still claimed by a 24-hex id, as before", async () => {
    process.env[ROW_OWNER_PERSON_IDS_FLAG] = "1";
    const project = await folderOnly("legacy");
    await ensureProjectRow(project, "publish");
    const legacy = new Types.ObjectId().toString();
    await ensureTestUser(pg.db, { id: legacy });
    expect((await ensureProjectRow(project, legacy)).owner_id).toBe(
      legacyUserIdToUuidv7(legacy),
    );
  });

  it("flag on: an existing owner is kept against the next person", async () => {
    process.env[ROW_OWNER_PERSON_IDS_FLAG] = "1";
    const project = await folderOnly("kept");
    await ensureProjectRow(project, ALICE);
    expect((await ensureProjectRow(project, BOB)).owner_id).toBe(
      legacyUserIdToUuidv7(ALICE),
    );
  });
});
