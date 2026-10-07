/**
 * Console rename scenarios — the matrix of graceful rename (mako-ai/mako
 * #1037) walked for consoles against the real code: every entry point
 * (the explorer's PATCH rename and move, the objects route, the agent's
 * `rename_object`, a laptop `git mv` pushed and synced) × every operation
 * (title, path, both, scope, back, onto names, case, chains, delete +
 * recreate, duplicate, never indexed, no-op) × the identity checks (same
 * id, one commit, history, shares, nothing else touched, no draft
 * committed), plus links and cross-workspace isolation.
 *
 * A console has NO aliases by design: every link carries its id
 * (`/c/<id>`), which a rename never changes; an old name resolves to
 * nothing, or to whatever holds that name now.
 */
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const who = vi.hoisted(() => ({ id: "", role: "member" as string | null }));

vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: who.id, email: "u@example.com" });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async () => who.role !== null,
    getMember: async () => (who.role ? { role: who.role } : null),
    hasRole: async (_ws: string, _user: string, roles: string[]) =>
      who.role !== null && roles.includes(who.role),
  },
}));
vi.mock("../../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));

import { ConsoleFolder, SavedConsole } from "../../database/workspace-schema";
import {
  derivedConsoleId,
  syncConsolesIndexFromRepo,
} from "../../apps/workspace-consoles.service";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import { createServerConsoleTools } from "../../agent-lib/tools/server-console-tools";
import { createConsoleRig, type Actor } from "./console-scenario-rig";

const rig = createConsoleRig(who, "console-rename-scenarios");
const { owner, admin, editor, member } = rig.people;

type Entry = {
  name: string;
  /** Rename in place to `title`. */
  title: (id: string, title: string, as: Actor) => Promise<unknown>;
  /** Move into folder chain `folders` (created on demand where the entry can). */
  move: (id: string, folders: string[], as: Actor) => Promise<unknown>;
  /** Both at once. */
  both: (
    id: string,
    folders: string[],
    title: string,
    as: Actor,
  ) => Promise<unknown>;
};

async function ok(p: Promise<{ status: number; body: unknown }>) {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

/** A workspace folder chain, made by the explorer's "New folder". */
async function folderChain(names: string[], as: Actor): Promise<string> {
  let parentId: string | null = null;
  for (const name of names) {
    const r = await rig.api("POST", "/consoles/folders", as, {
      name,
      parentId,
      access: "workspace",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    parentId = (r.body.data as { id: string }).id;
  }
  return parentId as string;
}

const ENTRIES: Entry[] = [
  {
    name: "PATCH /:id/rename (explorer)",
    title: (id, title, as) =>
      ok(rig.api("PATCH", `/consoles/${id}/rename`, as, { name: title })),
    move: async (id, folders, as) => {
      const row = (await rig.row(id))!;
      return ok(
        rig.api("PATCH", `/consoles/${id}/rename`, as, {
          name: [...folders, row.name].join("/"),
        }),
      );
    },
    both: (id, folders, title, as) =>
      ok(
        rig.api("PATCH", `/consoles/${id}/rename`, as, {
          name: [...folders, title].join("/"),
        }),
      ),
  },
  {
    name: "PATCH /:id/move (explorer's Move to…)",
    title: (id, title, as) =>
      ok(rig.api("PATCH", `/consoles/${id}/move`, as, { name: title })),
    move: async (id, folders, as) =>
      ok(
        rig.api("PATCH", `/consoles/${id}/move`, as, {
          folderId: await folderChain(folders, as),
        }),
      ),
    both: async (id, folders, title, as) =>
      ok(
        rig.api("PATCH", `/consoles/${id}/move`, as, {
          folderId: await folderChain(folders, as),
          name: title,
        }),
      ),
  },
  {
    name: "POST /objects/console/rename (REST)",
    title: (id, title, as) =>
      ok(rig.api("POST", "/objects/console/rename", as, { ref: id, title })),
    move: async (id, folders, as) => {
      const row = (await rig.row(id))!;
      return ok(
        rig.api("POST", "/objects/console/rename", as, {
          ref: id,
          slug: [...folders, row.name].join("/"),
        }),
      );
    },
    both: (id, folders, title, as) =>
      ok(
        rig.api("POST", "/objects/console/rename", as, {
          ref: id,
          slug: [...folders, title].join("/"),
        }),
      ),
  },
  {
    name: "rename_object (agent / MCP)",
    title: (id, title, as) =>
      renameObject(rig.ctx(as), "console", { ref: id, title }),
    move: async (id, folders, as) => {
      const row = (await rig.row(id))!;
      return renameObject(rig.ctx(as), "console", {
        ref: id,
        slug: [...folders, row.name].join("/"),
      });
    },
    both: (id, folders, title, as) =>
      renameObject(rig.ctx(as), "console", {
        ref: id,
        slug: [...folders, title].join("/"),
      }),
  },
];

/** Set up a console with everything attached that a rename must keep. */
async function attached(name: string, folderId?: string) {
  const c = await rig.save(name, owner, {
    folderId,
    code: `SELECT '${name}'\n`,
  });
  await rig.shareWith(c._id, editor.id, "editor");
  await SavedConsole.updateOne(
    { _id: c._id },
    { $set: { executionCount: 7, lastExecutedAt: new Date(0) } },
  );
  return (await rig.row(c._id))!;
}

async function expectIdentityKept(
  before: Awaited<ReturnType<typeof attached>>,
  expected: { path: string; name: string; commitsBefore: number },
) {
  const after = (await rig.row(before._id))!;
  expect(after._id.toString()).toBe(before._id.toString());
  expect(after.path).toBe(expected.path);
  expect(after.name).toBe(expected.name);
  // The same blob: a rename moves the file as it is.
  expect(after.sourceBlobSha).toBe(before.sourceBlobSha);
  expect(await rig.fileAt(expected.path)).toBe(`SELECT '${before.name}'\n`);
  expect(await rig.fileAt(before.path!)).toBeNull();
  // Shares, telemetry, owner and visibility are the row's: untouched.
  expect(after.sharedWith?.map(s => `${s.userId}:${s.role}`)).toEqual([
    `${editor.id}:editor`,
  ]);
  expect(after.executionCount).toBe(7);
  expect(after.owner_id).toBe(owner.id);
  expect(after.access).toBe("workspace");
  // ONE commit, and the history still reaches the console's creation.
  expect(await rig.commitCount()).toBe(expected.commitsBefore + 1);
  const history = await rig.history(before._id);
  expect(history.length).toBeGreaterThanOrEqual(2);
  // Exactly one live row (no duplicate minted by a later sync).
  await syncConsolesIndexFromRepo(rig.ws);
  expect(
    await SavedConsole.countDocuments({
      workspaceId: rig.ws,
      is_deleted: { $ne: true },
    }),
  ).toBe((await rig.consolePaths()).length);
  expect((await rig.row(before._id))!.path).toBe(expected.path);
}

describe.each(ENTRIES)("$name", entry => {
  it("title only: renamed in place, same id, one commit, shares kept, nothing else touched", async () => {
    const other = await rig.save("bystander", owner);
    const c = await attached("alpha");
    const before = await rig.snapshot([c._id]);
    const commits = await rig.commitCount();
    await entry.title(c._id.toString(), "beta", owner);
    await expectIdentityKept(c, {
      path: "consoles/beta.sql",
      name: "beta",
      commitsBefore: commits,
    });
    expect(await rig.snapshot([c._id])).toEqual(before);
    expect((await rig.row(other._id))!.path).toBe("consoles/bystander.sql");
  });

  it("path only: moved into a folder chain, same id, one commit", async () => {
    const c = await attached("alpha");
    const commits = await rig.commitCount();
    const rowsBefore = (await rig.snapshot([c._id])).rows;
    await entry.move(c._id.toString(), ["Sales", "EMEA"], owner);
    await expectIdentityKept(c, {
      path: "consoles/Sales/EMEA/alpha.sql",
      name: "alpha",
      commitsBefore: commits,
    });
    expect((await rig.snapshot([c._id])).rows).toEqual(rowsBefore);
  });

  it("both at once: one commit, same id", async () => {
    const c = await attached("alpha");
    const commits = await rig.commitCount();
    await entry.both(c._id.toString(), ["Ops"], "gamma", owner);
    await expectIdentityKept(c, {
      path: "consoles/Ops/gamma.sql",
      name: "gamma",
      commitsBefore: commits,
    });
  });

  it("back to its previous name (a → b → a): same id, one commit each, whole history", async () => {
    const c = await attached("alpha");
    const commits = await rig.commitCount();
    await entry.title(c._id.toString(), "beta", owner);
    await entry.title(c._id.toString(), "alpha", owner);
    const row = (await rig.row(c._id))!;
    expect(row.path).toBe("consoles/alpha.sql");
    expect(await rig.commitCount()).toBe(commits + 2);
    // create + rename + rename back, all on this console's lineage.
    expect((await rig.history(c._id)).length).toBeGreaterThanOrEqual(3);
    expect(await rig.consolePaths()).toEqual(["consoles/alpha.sql"]);
  });

  it("onto another console's LIVE name: refused, nothing changed", async () => {
    await rig.save("taken", owner);
    const c = await attached("alpha");
    const before = await rig.snapshot();
    const commits = await rig.commitCount();
    await expect(
      entry.title(c._id.toString(), "taken", owner),
    ).rejects.toBeTruthy();
    expect(await rig.snapshot()).toEqual(before);
    expect(await rig.commitCount()).toBe(commits);
  });

  it("onto a case-only variant of another console's name: refused (one name), nothing changed", async () => {
    await rig.save("Report", owner);
    const c = await attached("alpha");
    const before = await rig.snapshot();
    await expect(
      entry.title(c._id.toString(), "report", owner),
    ).rejects.toBeTruthy();
    expect(await rig.snapshot()).toEqual(before);
  });

  it("its own name with a different case: renamed, same id, no leftover", async () => {
    const c = await attached("report");
    const commits = await rig.commitCount();
    await entry.title(c._id.toString(), "Report", owner);
    expect((await rig.row(c._id))!.path).toBe("consoles/Report.sql");
    expect(await rig.consolePaths()).toEqual(["consoles/Report.sql"]);
    expect(await rig.commitCount()).toBe(commits + 1);
  });

  it("no-op: renaming to its current name commits nothing", async () => {
    const c = await attached("alpha");
    const before = await rig.snapshot();
    const commits = await rig.commitCount();
    await entry.title(c._id.toString(), "alpha", owner).catch(() => null);
    expect(await rig.commitCount()).toBe(commits);
    const after = await rig.snapshot();
    expect(after.files).toEqual(before.files);
  });

  it("never commits a draft: the file moves as committed, the draft stays a draft", async () => {
    const c = await attached("alpha");
    const draft = await rig.api("PUT", `/consoles/${c._id}`, owner, {
      content: "SELECT 'UNSAVED DRAFT'\n",
    });
    expect(draft.status).toBe(200);
    await entry.both(c._id.toString(), ["Drafts"], "beta", owner);
    expect(await rig.fileAt("consoles/Drafts/beta.sql")).toBe(
      "SELECT 'alpha'\n",
    );
    expect((await rig.row(c._id))!.code).toBe("SELECT 'UNSAVED DRAFT'\n");
  });
});

describe("names other consoles held", () => {
  it("onto another console's OLD name: allowed; neither history reaches into the other", async () => {
    const a = await rig.save("x", owner, { code: "SELECT 'A'\n" });
    const b = await rig.save("z", owner, { code: "SELECT 'B'\n" });
    await renameObject(rig.ctx(owner), "console", {
      ref: a._id.toString(),
      title: "y",
    });
    const aHistory = await rig.history(a._id);
    await renameObject(rig.ctx(owner), "console", {
      ref: b._id.toString(),
      title: "x",
    });
    expect((await rig.row(b._id))!.path).toBe("consoles/x.sql");
    expect((await rig.row(a._id))!.path).toBe("consoles/y.sql");
    const bHistory = await rig.history(b._id);
    expect(bHistory.filter(oid => aHistory.includes(oid))).toEqual([]);
    expect(await rig.history(a._id)).toEqual(aHistory);
    // The old name resolves to its holder now — never to the console that left it.
    const hit = await resolveObjectRef(rig.ctx(owner), "console", "x");
    expect(hit?.id).toBe(b._id.toString());
    // History routes agree: B's history never lists A's commits.
    const routeHistory = await rig.api(
      "GET",
      `/consoles/${b._id}/history`,
      owner,
    );
    expect(
      routeHistory.body.commits!.filter(c => aHistory.includes(c.oid)),
    ).toEqual([]);
  });

  it("a trashed console's name does not block; its restore comes back beside the new holder", async () => {
    const a = await rig.save("report", owner, { code: "SELECT 'A'\n" });
    const del = await rig.api("DELETE", `/consoles/${a._id}`, owner);
    expect(del.status).toBe(200);
    const b = await rig.save("other", owner, { code: "SELECT 'B'\n" });
    await renameObject(rig.ctx(owner), "console", {
      ref: b._id.toString(),
      title: "report",
    });
    expect((await rig.row(b._id))!.path).toBe("consoles/report.sql");
    // A case-variant of a trashed name does not block either.
    const c = await rig.save("third", owner);
    await expect(
      renameObject(rig.ctx(owner), "console", {
        ref: c._id.toString(),
        title: "REPORT",
      }),
    ).rejects.toMatchObject({ status: 409 }); // the LIVE holder's case variant
    const restore = await rig.api("PATCH", `/consoles/${a._id}/restore`, owner);
    expect(restore.status).toBe(200);
    const restored = (await rig.row(a._id))!;
    expect(restored.path).toBe("consoles/report (2).sql");
    expect(await rig.fileAt("consoles/report.sql")).toBe("SELECT 'B'\n");
    expect(await rig.fileAt("consoles/report (2).sql")).toBe("SELECT 'A'\n");
  });

  it("delete then recreate at the old name: a NEW console; histories disjoint", async () => {
    const a = await rig.save("report", owner, { code: "SELECT 'A'\n" });
    const aHistory = await rig.history(a._id);
    expect((await rig.api("DELETE", `/consoles/${a._id}`, owner)).status).toBe(
      200,
    );
    const b = await rig.save("report", owner, { code: "SELECT 'B'\n" });
    expect(b._id.toString()).not.toBe(a._id.toString());
    const bHistory = await rig.history(b._id);
    expect(bHistory.filter(oid => aHistory.includes(oid))).toEqual([]);
    // A trashed console's history routes are closed (its path is B's now).
    expect(
      (await rig.api("GET", `/consoles/${a._id}/history`, owner)).status,
    ).toBe(404);
  });

  it("a → b → c in quick succession: one console at c, one commit per rename", async () => {
    const c = await rig.save("a", owner);
    const commits = await rig.commitCount();
    await renameObject(rig.ctx(owner), "console", {
      ref: c._id.toString(),
      title: "b",
    });
    await renameObject(rig.ctx(owner), "console", {
      ref: "b",
      title: "c",
    });
    expect((await rig.row(c._id))!.path).toBe("consoles/c.sql");
    expect(await rig.consolePaths()).toEqual(["consoles/c.sql"]);
    expect(await rig.commitCount()).toBe(commits + 2);
  });

  it("chains: a→b while c→a (a's old name taken by c) keeps both identities", async () => {
    const a = await rig.save("a", owner, { code: "SELECT 'A'\n" });
    const c = await rig.save("c", owner, { code: "SELECT 'C'\n" });
    await renameObject(rig.ctx(owner), "console", {
      ref: a._id.toString(),
      title: "b",
    });
    await renameObject(rig.ctx(owner), "console", {
      ref: c._id.toString(),
      title: "a",
    });
    await syncConsolesIndexFromRepo(rig.ws);
    expect((await rig.row(a._id))!.path).toBe("consoles/b.sql");
    expect((await rig.row(c._id))!.path).toBe("consoles/a.sql");
    expect(await rig.fileAt("consoles/a.sql")).toBe("SELECT 'C'\n");
  });
});

describe("trash, reuse and restore: each life's history is its own", () => {
  it("A trashed, B born at A's name, A restored beside it: neither reads the other's commits or file", async () => {
    const a = await rig.save("x", owner, { code: "SELECT 'A-SECRET v1'\n" });
    await rig.api("PUT", `/consoles/${a._id}`, owner, {
      content: "SELECT 'A-SECRET v2'\n",
      isSaved: true,
    });
    const aBefore = await rig.history(a._id);
    expect((await rig.api("DELETE", `/consoles/${a._id}`, owner)).status).toBe(
      200,
    );
    const b = await rig.save("x", owner, { code: "SELECT 'B v1'\n" });
    await rig.api("PUT", `/consoles/${b._id}`, owner, {
      content: "SELECT 'B v2'\n",
      isSaved: true,
    });
    expect(
      (await rig.api("PATCH", `/consoles/${a._id}/restore`, owner)).status,
    ).toBe(200);
    expect((await rig.row(a._id))!.path).toBe("consoles/x (2).sql");
    const aAfter = await rig.history(a._id);
    const bHistory = await rig.history(b._id);
    // A's history is its earlier life plus the restore — never B's.
    for (const oid of aBefore) expect(aAfter).toContain(oid);
    expect(aAfter.filter(oid => bHistory.includes(oid))).toEqual([]);
    expect(bHistory.filter(oid => aAfter.includes(oid))).toEqual([]);
    // B's diffs never show A's text, A's never B's.
    for (const sha of bHistory) {
      const v = await rig.api(
        "GET",
        `/consoles/${a._id}/git/file-versions?sha=${sha}&path=consoles%2Fx.sql`,
        owner,
      );
      expect(JSON.stringify(v.body)).not.toContain("B v");
    }
    for (const sha of aBefore) {
      const v = await rig.api(
        "GET",
        `/consoles/${b._id}/git/file-versions?sha=${sha}&path=consoles%2Fx.sql`,
        owner,
      );
      expect(JSON.stringify(v.body)).not.toContain("A-SECRET");
      // …nor restores it.
      const r = await rig.api("POST", `/consoles/${b._id}/restore`, owner, {
        sha,
      });
      expect(r.status).toBe(404);
    }
    // A restores its own pre-trash version from its earlier life.
    const own = await rig.api("POST", `/consoles/${a._id}/restore`, owner, {
      sha: aBefore[aBefore.length - 1],
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(await rig.fileAt("consoles/x (2).sql")).toBe(
      "SELECT 'A-SECRET v1'\n",
    );
    expect(await rig.fileAt("consoles/x.sql")).toBe("SELECT 'B v2'\n");
  });
});

describe("folder renames and moves", () => {
  it("move every file as committed — no console's draft reaches main; ids, shares kept", async () => {
    const team = await folderChain(["Team"], owner);
    const a = await attached("a", team);
    const b = await rig.save("b", owner, { folderId: team });
    await rig.api("PUT", `/consoles/${a._id}`, owner, {
      content: "SELECT 'DRAFT a'\n",
    });
    const commits = await rig.commitCount();
    const r = await rig.api(
      "PATCH",
      `/consoles/folders/${team}/rename`,
      owner,
      {
        name: "Squad",
      },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await rig.commitCount()).toBe(commits + 1);
    expect(await rig.consolePaths()).toEqual([
      "consoles/Squad/a.sql",
      "consoles/Squad/b.sql",
    ]);
    expect(await rig.fileAt("consoles/Squad/a.sql")).toBe("SELECT 'a'\n");
    expect((await rig.row(a._id))!.code).toBe("SELECT 'DRAFT a'\n");
    expect((await rig.row(a._id))!.sharedWith?.length).toBe(1);
    // …and a move under another folder: one commit, same ids.
    const parent = await folderChain(["Parent"], owner);
    const m = await rig.api("PATCH", `/consoles/folders/${team}/move`, owner, {
      parentId: parent,
    });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(await rig.consolePaths()).toEqual([
      "consoles/Parent/Squad/a.sql",
      "consoles/Parent/Squad/b.sql",
    ]);
    expect((await rig.row(b._id))!.path).toBe("consoles/Parent/Squad/b.sql");
    expect(await rig.fileAt("consoles/Parent/Squad/a.sql")).toBe(
      "SELECT 'a'\n",
    );
    // A folder rename onto a sibling's name in another case is a twin.
    await folderChain(["Other"], owner);
    const twin = await rig.api(
      "PATCH",
      `/consoles/folders/${parent}/rename`,
      owner,
      { name: "other" },
    );
    expect(twin.status).toBe(409);
  });
});

describe("duplicate", () => {
  it("a copy is a new console: its own id, private, no shares, no inherited history", async () => {
    const original = await attached("report");
    const originalHistory = await rig.history(original._id);
    const r = await rig.api(
      "POST",
      `/consoles/${original._id}/duplicate`,
      member,
    );
    expect(r.status).toBe(201);
    const copyId = (r.body.data as { id: string }).id;
    const copy = (await rig.row(copyId))!;
    expect(copyId).not.toBe(original._id.toString());
    expect(copy.access).toBe("private");
    expect(copy.owner_id).toBe(member.id);
    expect(copy.sharedWith ?? []).toEqual([]);
    expect(copy.path).toBe(`users/${member.id}/consoles/report copy.sql`);
    const copyHistory = await rig.history(copyId);
    expect(copyHistory.filter(oid => originalHistory.includes(oid))).toEqual(
      [],
    );
    // Renaming the copy onto the original's name in its own tree is fine;
    // the original is untouched.
    await renameObject(rig.ctx(member), "console", {
      ref: copyId,
      title: "report",
    });
    expect((await rig.row(original._id))!.path).toBe("consoles/report.sql");
    expect((await rig.row(copyId))!.path).toBe(
      `users/${member.id}/consoles/report.sql`,
    );
  });
});

describe("laptop push (git mv [+ edit])", () => {
  it("git mv: same id, history followed, shares kept", async () => {
    const c = await attached("alpha");
    await rig.laptop({
      writes: { "consoles/Moved/beta.sql": "SELECT 'alpha'\n" },
      deletes: ["consoles/alpha.sql"],
    });
    const row = (await rig.row(c._id))!;
    expect(row.path).toBe("consoles/Moved/beta.sql");
    expect(row.name).toBe("beta");
    expect(row.sharedWith?.length).toBe(1);
    expect(row.is_deleted).toBeFalsy();
    expect((await rig.history(c._id)).length).toBeGreaterThanOrEqual(2);
    expect(
      await SavedConsole.countDocuments({ is_deleted: { $ne: true } }),
    ).toBe(1);
  });

  it("git mv + edit in one commit: same id, the edit lands", async () => {
    const code =
      "SELECT a, b, c, d\nFROM some_table\nWHERE x = 1\nAND y = 2\nORDER BY a\n";
    const c = await rig.save("alpha", owner, { code });
    await rig.laptop({
      writes: { "consoles/beta.sql": code.replace("x = 1", "x = 42") },
      deletes: ["consoles/alpha.sql"],
    });
    const row = (await rig.row(c._id))!;
    expect(row.path).toBe("consoles/beta.sql");
    expect(row.code).toContain("x = 42");
    expect(
      await SavedConsole.countDocuments({ is_deleted: { $ne: true } }),
    ).toBe(1);
  });

  it("git mv to its own name in another case: same id", async () => {
    const c = await rig.save("report", owner);
    await rig.laptop({
      writes: { "consoles/Report.sql": "SELECT 'report'\n" },
      deletes: ["consoles/report.sql"],
    });
    expect((await rig.row(c._id))!.path).toBe("consoles/Report.sql");
  });

  it("git mv back and forth across two pushes keeps the id", async () => {
    const c = await rig.save("a", owner);
    await rig.laptop({
      writes: { "consoles/b.sql": "SELECT 'a'\n" },
      deletes: ["consoles/a.sql"],
    });
    await rig.laptop({
      writes: { "consoles/a.sql": "SELECT 'a'\n" },
      deletes: ["consoles/b.sql"],
    });
    expect((await rig.row(c._id))!.path).toBe("consoles/a.sql");
    expect(await SavedConsole.countDocuments({})).toBe(1);
  });

  it("a → b → c in two commits of ONE push: same id at c, shares kept", async () => {
    const c = await attached("a");
    const code = (await rig.fileAt("consoles/a.sql"))!;
    await rig.laptop(
      { writes: { "consoles/b.sql": code }, deletes: ["consoles/a.sql"] },
      { sync: false, message: "mv a b" },
    );
    await rig.laptop(
      { writes: { "consoles/b.sql": `${code}-- edited between the moves\n` } },
      { sync: false, message: "edit b" },
    );
    await rig.laptop(
      {
        writes: {
          "consoles/Moved/c.sql": `${code}-- edited between the moves\n`,
        },
        deletes: ["consoles/b.sql"],
      },
      { message: "mv b c" },
    );
    const row = (await rig.row(c._id))!;
    expect(row.path).toBe("consoles/Moved/c.sql");
    expect(row.is_deleted).toBeFalsy();
    expect(row.sharedWith?.length).toBe(1);
    expect(await SavedConsole.countDocuments({})).toBe(1);
    // Its history runs through both moves to its creation.
    expect((await rig.history(c._id)).length).toBeGreaterThanOrEqual(4);
  });

  it("a renamed console's old name, re-pushed as a new file, is a NEW console", async () => {
    const c = await rig.save("a", owner);
    await renameObject(rig.ctx(owner), "console", {
      ref: c._id.toString(),
      title: "b",
    });
    await rig.laptop({ writes: { "consoles/a.sql": "SELECT 'new a'\n" } });
    const fresh = await SavedConsole.findOne({ path: "consoles/a.sql" });
    expect(fresh).not.toBeNull();
    expect(fresh!._id.toString()).not.toBe(c._id.toString());
    expect((await rig.row(c._id))!.path).toBe("consoles/b.sql");
  });
});

describe("a console that was never indexed (pushed, not synced)", () => {
  it("renames through rename_object by its path, and by the id the tree hands out (PATCH /:id/rename)", async () => {
    await rig.adopt();
    await rig.laptop(
      { writes: { "consoles/fresh.sql": "SELECT 'fresh'\n" } },
      { sync: false },
    );
    const derived = derivedConsoleId(rig.ws, "consoles/fresh.sql").toString();
    // The tree lists it under its derived id; renaming from there works.
    const r = await rig.api("PATCH", `/consoles/${derived}/rename`, admin, {
      name: "fresh-2",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await rig.consolePaths()).toEqual(["consoles/fresh-2.sql"]);
    const row = await SavedConsole.findOne({ path: "consoles/fresh-2.sql" });
    expect(row?._id.toString()).toBe(derived);
    // …and moves from there (PATCH /:id/move by the same id).
    const moved = await rig.api("PATCH", `/consoles/${derived}/move`, admin, {
      name: "fresh-3",
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await rig.consolePaths()).toEqual(["consoles/fresh-3.sql"]);

    await rig.laptop(
      { writes: { "consoles/other.sql": "SELECT 'other'\n" } },
      { sync: false },
    );
    // …and by the id the tree lists it under, for the agent too.
    const otherId = derivedConsoleId(rig.ws, "consoles/other.sql").toString();
    expect(
      (await resolveObjectRef(rig.ctx(admin), "console", otherId))?.current
        .path,
    ).toBe("consoles/other.sql");
    const res = await renameObject(rig.ctx(admin), "console", {
      ref: otherId,
      title: "other-2",
    });
    expect(res.after.path).toBe("consoles/other-2.sql");
    expect(res.id).toBe(
      derivedConsoleId(rig.ws, "consoles/other.sql").toString(),
    );
  });

  it("a draft autosave on it keeps its identity: no private draft row under its id, no second console", async () => {
    await rig.adopt();
    await rig.laptop(
      { writes: { "consoles/pushed.sql": "SELECT 'pushed'\n" } },
      { sync: false },
    );
    const derived = derivedConsoleId(rig.ws, "consoles/pushed.sql").toString();
    const draft = await rig.api("PUT", `/consoles/${derived}`, admin, {
      content: "SELECT 'typing…'\n",
    });
    expect(draft.status).toBe(200);
    await syncConsolesIndexFromRepo(rig.ws);
    // The console in the tree still has the id the tab opened.
    const atPath = await SavedConsole.findOne({ path: "consoles/pushed.sql" });
    expect(atPath?._id.toString()).toBe(derived);
    expect(atPath?.access).toBe("workspace");
    expect(await SavedConsole.countDocuments({})).toBe(1);
    // The file is untouched by a draft.
    expect(await rig.fileAt("consoles/pushed.sql")).toBe("SELECT 'pushed'\n");
  });
});

describe("the agent's modify_console title", () => {
  it("renames through the same service: one commit, the file as committed, the agent's edit stays a draft; a bad title applies nothing", async () => {
    const c = await attached("alpha");
    const tools = createServerConsoleTools({
      workspaceId: rig.ws,
      userId: owner.id,
    });
    const run = (input: Record<string, unknown>) =>
      (
        tools.modify_console as unknown as {
          execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>>;
        }
      ).execute(input, { toolCallId: "t", messages: [] });
    const commits = await rig.commitCount();
    const bad = await run({
      consoleId: c._id.toString(),
      action: "replace",
      content: "SELECT 'agent'\n",
      // No name at all once cleaned: a reserved device name.
      title: "CON",
    });
    expect(bad.success).toBe(false);
    expect(await rig.commitCount()).toBe(commits);
    expect((await rig.row(c._id))!.code).toBe("SELECT 'alpha'\n");
    const ok = await run({
      consoleId: c._id.toString(),
      action: "replace",
      content: "SELECT 'agent'\n",
      title: "beta",
    });
    expect(ok.success, JSON.stringify(ok)).toBe(true);
    await expectIdentityKept(c, {
      path: "consoles/beta.sql",
      name: "beta",
      commitsBefore: commits,
    });
    const row = (await rig.row(c._id))!;
    expect(row.path).toBe("consoles/beta.sql");
    expect(row.code).toBe("SELECT 'agent'\n");
    expect(await rig.fileAt("consoles/beta.sql")).toBe("SELECT 'alpha'\n");
    expect(await rig.commitCount()).toBe(commits + 1);
  });
});

describe("drafts", () => {
  it("a never-saved draft renames in the index only — no commit", async () => {
    const id = new Types.ObjectId().toString();
    const draft = await rig.api("PUT", `/consoles/${id}`, owner, {
      content: "SELECT 'draft'\n",
      title: "Untitled",
    });
    expect(draft.status).toBe(200);
    const commits = await rig.commitCount();
    const res = await renameObject(rig.ctx(owner), "console", {
      ref: id,
      title: "named draft",
    });
    expect(res.warnings.join(" ")).toMatch(/draft/);
    expect(await rig.commitCount()).toBe(commits);
    expect((await rig.row(id))!.name).toBe("named draft");
  });
});

describe("links", () => {
  it("/c/<id> never changes; the old name resolves to nothing, then to its new holder", async () => {
    const c = await rig.save("old", owner);
    const id = c._id.toString();
    const res = await renameObject(rig.ctx(owner), "console", {
      ref: id,
      title: "new",
    });
    expect(res.before.url).toBe(`/c/${id}`);
    expect(res.after.url).toBe(`/c/${id}`);
    const byId = await rig.api(
      "GET",
      `/objects/resolve?kind=console&ref=${id}`,
      owner,
    );
    expect(byId.status).toBe(200);
    expect(byId.body.resolved).toMatchObject({
      id,
      current: { path: "consoles/new.sql", url: `/c/${id}` },
    });
    expect(
      (await rig.api("GET", "/objects/resolve?kind=console&ref=old", owner))
        .status,
    ).toBe(404);
    const reuse = await rig.save("old", owner);
    const hit = await rig.api(
      "GET",
      "/objects/resolve?kind=console&ref=old",
      owner,
    );
    expect(hit.body.resolved).toMatchObject({ id: reuse._id.toString() });
  });

  it("an ambiguous bare name resolves to nothing; a qualified one to its console", async () => {
    const a = await rig.save("dup-a", owner);
    const b = await rig.save("dup-b", owner);
    await renameObject(rig.ctx(owner), "console", {
      ref: a._id.toString(),
      slug: "Team/dup",
    });
    await renameObject(rig.ctx(owner), "console", {
      ref: b._id.toString(),
      slug: "Ops/dup",
    });
    expect(await resolveObjectRef(rig.ctx(owner), "console", "dup")).toBeNull();
    expect(
      (await resolveObjectRef(rig.ctx(owner), "console", "Ops/dup"))?.id,
    ).toBe(b._id.toString());
  });

  it("a console of ANOTHER workspace never resolves, renames or reads here", async () => {
    const foreign = await rig.save("report", owner, { ws: rig.ws2 });
    const fid = foreign._id.toString();
    expect(await resolveObjectRef(rig.ctx(owner), "console", fid)).toBeNull();
    await expect(
      renameObject(rig.ctx(admin), "console", { ref: fid, title: "stolen" }),
    ).rejects.toMatchObject({ status: 404 });
    for (const [method, url, body] of [
      ["PATCH", `/consoles/${fid}/rename`, { name: "stolen" }],
      ["PATCH", `/consoles/${fid}/move`, { name: "stolen" }],
      ["GET", `/consoles/${fid}/history`, undefined],
      ["POST", `/consoles/${fid}/duplicate`, {}],
      ["DELETE", `/consoles/${fid}`, undefined],
    ] as const) {
      const r = await rig.api(method, url, admin, body);
      expect([403, 404], `${method} ${url}`).toContain(r.status);
    }
    expect((await rig.row(fid))!.path).toBe("consoles/report.sql");
    expect(await rig.fileAt("consoles/report.sql", rig.ws2)).toBe(
      "SELECT 'report'\n",
    );
  });

  it("the same names in two workspaces never interfere", async () => {
    const here = await rig.save("report", owner);
    const there = await rig.save("report", owner, { ws: rig.ws2 });
    await renameObject(rig.ctx(owner), "console", {
      ref: "report",
      title: "renamed",
    });
    expect((await rig.row(here._id))!.path).toBe("consoles/renamed.sql");
    expect((await rig.row(there._id))!.path).toBe("consoles/report.sql");
    // And the other workspace's rename onto a name taken HERE is free there.
    await rig.save("x", owner, { ws: rig.ws2 });
    await renameObject(rig.ctx(owner, rig.ws2), "console", {
      ref: "x",
      title: "renamed",
    });
    expect(await rig.consolePaths(rig.ws2)).toEqual([
      "consoles/renamed.sql",
      "consoles/report.sql",
    ]);
    expect(await ConsoleFolder.countDocuments({})).toBe(0);
  });
});
