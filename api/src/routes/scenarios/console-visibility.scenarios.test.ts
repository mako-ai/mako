/**
 * Console visibility scenarios: WHO SEES a console — its own access and
 * its folder chain — changes only by its owner or a workspace admin, on
 * every route that can move it, re-scope it or share it; and nobody reads
 * a console (its content, its history, its results, its name) they could
 * not open.
 *
 * Three consoles of one owner, each shared with an EDITOR (role editor):
 *   P  — private, in the owner's root;
 *   W  — workspace-visible;
 *   PW — private, filed in a WORKSPACE folder (visible by inheritance).
 *
 * Every visibility-changing request is tried by everyone who must be
 * refused (the shared editor, a plain member, a workspace viewer, a
 * non-member, and an admin who cannot see it) — each must leave the
 * console exactly where it was, with no commit — then by the one who may,
 * whose request must take effect.
 */
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const who = vi.hoisted(() => ({
  id: "",
  role: "member" as string | null,
  members: [] as Array<{ userId: string }>,
  /** Every query the (mocked) warehouse was asked to run. */
  queries: [] as unknown[],
}));
// The console's query results are what an export streams: a marker row,
// so a leak is visible (no real warehouse in this rig).
vi.mock("../../services/database-connection.service", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("../../services/database-connection.service")
    >();
  const result = async (_db: unknown, query: unknown) => {
    who.queries.push(query);
    return {
      success: true,
      data: [{ marker: "SECRET-RESULT" }],
      rowCount: 1,
    };
  };
  return {
    ...actual,
    databaseConnectionService: new Proxy(actual.databaseConnectionService, {
      get(target, prop, receiver) {
        if (prop === "executeQuery" || prop === "executePreviewQuery") {
          return result;
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});

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
    getMembers: async () => who.members,
    hasRole: async (_ws: string, _user: string, roles: string[]) =>
      who.role !== null && roles.includes(who.role),
  },
}));
vi.mock("../../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));

import {
  ConsoleFolder,
  DatabaseConnection,
  SavedConsole,
  type ISavedConsole,
} from "../../database/workspace-schema";
import { syncConsolesIndexFromRepo } from "../../apps/workspace-consoles.service";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import { RenameError } from "../../rename/types";
import { createConsoleRig, type Actor } from "./console-scenario-rig";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const rig = createConsoleRig(who, "console-visibility-scenarios");
const { owner, admin, editor, member, viewer, outsider } = rig.people;
who.members = Object.values(rig.people)
  .filter(p => p.role !== null)
  .map(p => ({ userId: p.id }));

type Target = "P" | "W" | "PW";

interface World {
  P: ISavedConsole;
  W: ISavedConsole;
  PW: ISavedConsole;
  /** A workspace folder owned by the EDITOR, holding PW. */
  team: string;
  /** The owner's own private folder. */
  mine: string;
}

const SECRET = (t: Target) => `SELECT 'SECRET-${t}' AS marker\n`;

async function world(): Promise<World> {
  const team = (
    await rig.manager.createFolder(
      "Team",
      rig.ws,
      editor.id,
      undefined,
      false,
      "workspace",
    )
  )._id.toString();
  const mine = (
    await rig.manager.createFolder(
      "Mine",
      rig.ws,
      owner.id,
      undefined,
      false,
      "private",
    )
  )._id.toString();
  const P = await rig.save("p", owner, {
    access: "private",
    code: SECRET("P"),
  });
  const W = await rig.save("w", owner, {
    access: "workspace",
    code: SECRET("W"),
  });
  const PW = await rig.save("pw", owner, {
    access: "private",
    code: SECRET("PW"),
    folderId: team,
  });
  const warehouse = await DatabaseConnection.create({
    workspaceId: new Types.ObjectId(rig.ws),
    name: "warehouse",
    type: "postgresql",
    connection: { host: "db.local", database: "app" },
    createdBy: owner.id,
  });
  for (const c of [P, W, PW]) {
    await rig.shareWith(c._id, editor.id, "editor");
    await SavedConsole.updateOne(
      { _id: c._id },
      { $set: { connectionId: warehouse._id } },
    );
  }
  return {
    P: (await rig.row(P._id))!,
    W: (await rig.row(W._id))!,
    PW: (await rig.row(PW._id))!,
    team,
    mine,
  };
}

/** Who sees it, as every reader decides it. */
async function visibility(id: Types.ObjectId | string) {
  const row = (await rig.row(id))!;
  return {
    access: row.access,
    effective: await rig.manager.effectiveVisibility(row),
    folderId: row.folderId?.toString() ?? null,
    path: row.path,
    file: row.path ? await rig.fileAt(row.path) : null,
    shares: (row.sharedWith ?? []).map(s => `${s.userId}:${s.role}`).sort(),
    memberReads: await rig.manager.canReadWithInheritance(row, member.id),
    deleted: row.is_deleted ?? false,
  };
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    const r = (await p) as { status?: number; kind?: string };
    // A route answer, or a rename result (no status: it succeeded).
    return typeof r?.status === "number" ? r.status : 200;
  } catch (error) {
    if (error instanceof RenameError) return error.status;
    throw error;
  }
}

interface Attempt {
  name: string;
  targets: Target[];
  run: (w: World, t: Target, as: Actor) => Promise<number>;
}

const slugAcross = (w: World, t: Target) =>
  t === "P"
    ? "consoles/p.sql"
    : t === "W"
      ? `users/${owner.id}/consoles/w.sql`
      : "Elsewhere/pw";

const ATTEMPTS: Attempt[] = [
  {
    name: "rename_object with a slug across scopes",
    targets: ["P", "W", "PW"],
    run: (w, t, as) =>
      status(
        renameObject(rig.ctx(as), "console", {
          ref: w[t]._id.toString(),
          slug: slugAcross(w, t),
        }),
      ),
  },
  {
    name: "POST /objects/console/rename with a slug across scopes",
    targets: ["P", "W", "PW"],
    run: (w, t, as) =>
      status(
        rig.api("POST", "/objects/console/rename", as, {
          ref: w[t]._id.toString(),
          slug: slugAcross(w, t),
        }),
      ),
  },
  {
    name: "PATCH /:id/move with an access",
    targets: ["P", "W"],
    run: (w, t, as) =>
      status(
        rig.api("PATCH", `/consoles/${w[t]._id}/move`, as, {
          access: t === "P" ? "workspace" : "private",
        }),
      ),
  },
  {
    name: "PATCH /:id/move into / out of a workspace folder",
    targets: ["P", "PW"],
    run: (w, t, as) =>
      status(
        rig.api("PATCH", `/consoles/${w[t]._id}/move`, as, {
          folderId: t === "P" ? w.team : null,
        }),
      ),
  },
  {
    name: "PUT explicit save with a path and an access",
    targets: ["P", "W", "PW"],
    run: (w, t, as) =>
      status(
        rig.api("PUT", `/consoles/${w[t]._id}`, as, {
          content: SECRET(t),
          isSaved: true,
          path: t === "PW" ? "Team/pw" : w[t].name,
          access: t === "P" ? "workspace" : "private",
        }),
      ),
  },
  {
    name: "PUT explicit save without a path, with an access",
    targets: ["P", "W", "PW"],
    run: (w, t, as) =>
      status(
        rig.api("PUT", `/consoles/${w[t]._id}`, as, {
          content: SECRET(t),
          isSaved: true,
          access: t === "P" ? "workspace" : "private",
        }),
      ),
  },
  {
    name: "POST / naming the console's id, with an access",
    targets: ["P", "W"],
    run: (w, t, as) =>
      status(
        rig.api("POST", "/consoles", as, {
          id: w[t]._id.toString(),
          path: w[t].name,
          content: SECRET(t),
          access: t === "P" ? "workspace" : "private",
        }),
      ),
  },
  {
    name: "PATCH /:id/sharing (general access)",
    targets: ["P", "W", "PW"],
    run: (w, t, as) =>
      status(
        rig.api("PATCH", `/consoles/${w[t]._id}/sharing`, as, {
          access: t === "P" ? "workspace" : "private",
        }),
      ),
  },
  {
    name: "POST /:id/collaborators (share with one more member)",
    targets: ["P"],
    run: (w, _t, as) =>
      status(
        rig.api("POST", `/consoles/${w.P._id}/collaborators`, as, {
          userId: member.id,
          role: "viewer",
        }),
      ),
  },
];

/** Who may change the visibility of each console (the rule's "yes"). */
const MAY: Record<Target, Actor[]> = {
  // An admin does not see a private console that is not shared with them.
  P: [owner],
  W: [owner, admin],
  // Private by its own access: admins' writes follow the row (not shared).
  PW: [owner],
};

const EVERYONE = [owner, admin, editor, member, viewer, outsider];
const label = (a: Actor) =>
  Object.entries(rig.people).find(([, p]) => p === a)?.[0] ?? a.id;

describe.each(ATTEMPTS)("$name", attempt => {
  it.each(attempt.targets)(
    "on %s: refused for everyone but its owner / an admin who sees it, then applied",
    async t => {
      const w = await world();
      const id = w[t]._id;
      const before = await visibility(id);
      const commits = await rig.commitCount();
      for (const as of EVERYONE.filter(a => !MAY[t].includes(a))) {
        const code = await attempt.run(w, t, as);
        expect([403, 404], `${label(as)} → ${code}`).toContain(code);
        expect(await visibility(id), label(as)).toEqual(before);
        expect(await rig.commitCount(), label(as)).toBe(commits);
      }
      const allowed = MAY[t][MAY[t].length - 1];
      const code = await attempt.run(w, t, allowed);
      expect([200, 201], `${label(allowed)} → ${code}`).toContain(code);
      const after = await visibility(id);
      expect(
        after.effective !== before.effective ||
          after.memberReads !== before.memberReads,
        `${label(allowed)} changed nothing: ${JSON.stringify(after)}`,
      ).toBe(true);
      // The file follows the row: a private console's file is under its
      // owner's private root, a workspace one under consoles/.
      expect(after.path?.startsWith(`users/${owner.id}/consoles/`)).toBe(
        after.access === "private",
      );
      // Moved as committed (front matter and all), never rewritten.
      expect(after.file).toContain(SECRET(t));
    },
  );
});

describe("things that are not a visibility change stay so for everyone", () => {
  it("a draft autosave never re-scopes a saved console, whoever sends an access", async () => {
    const w = await world();
    for (const t of ["P", "W", "PW"] as Target[]) {
      const before = await visibility(w[t]._id);
      for (const as of [owner, editor]) {
        const r = await rig.api("PUT", `/consoles/${w[t]._id}`, as, {
          content: SECRET(t),
          access: t === "P" ? "workspace" : "private",
        });
        expect(r.status).toBe(200);
        expect(await visibility(w[t]._id)).toEqual(before);
      }
    }
  });

  it("a shared editor renames in place — never moves a private console", async () => {
    const w = await world();
    const r = await rig.api("PATCH", `/consoles/${w.P._id}/rename`, editor, {
      name: "renamed by editor",
    });
    expect(r.status).toBe(200);
    const v = await visibility(w.P._id);
    expect(v.path).toBe(`users/${owner.id}/consoles/renamed by editor.sql`);
    expect(v.effective).toBe("private");
    expect(v.memberReads).toBe(false);
    // …and inside its workspace folder, PW stays there.
    const r2 = await rig.api("PATCH", `/consoles/${w.PW._id}/rename`, editor, {
      name: "pw renamed",
    });
    expect(r2.status).toBe(200);
    const v2 = await visibility(w.PW._id);
    expect(v2.folderId).toBe(w.team);
    expect(v2.effective).toBe("workspace");
    // A `Folder/name` rename files it in a folder of the visibility it HAS:
    // PW (seen by the workspace through Team) lands in a workspace folder.
    const r3 = await rig.api("PATCH", `/consoles/${w.PW._id}/rename`, editor, {
      name: "Elsewhere/pw",
    });
    expect(r3.status).toBe(200);
    const v3 = await visibility(w.PW._id);
    expect(v3.effective).toBe("workspace");
    expect(v3.memberReads).toBe(true);
    expect(v3.path).toBe(`users/${owner.id}/consoles/Elsewhere/pw.sql`);
    // …and a laptop edit of it after that keeps it there.
    await rig.laptop({
      writes: { [v3.path!]: `${SECRET("PW")}-- edited\n` },
    });
    expect((await visibility(w.PW._id)).effective).toBe("workspace");
  });

  it("restoring a trashed console from the trash brings it back as it was seen", async () => {
    const w = await world();
    const before = await visibility(w.PW._id);
    expect(
      (await rig.api("DELETE", `/consoles/${w.PW._id}`, owner)).status,
    ).toBe(200);
    // The shared editor may restore it (a write) — exactly where it was.
    const r = await rig.api("PATCH", `/consoles/${w.PW._id}/restore`, editor);
    expect(r.status).toBe(200);
    expect(await visibility(w.PW._id)).toEqual(before);
  });

  it("a duplicate is its copier's private console; the original is untouched", async () => {
    const w = await world();
    const before = await visibility(w.W._id);
    const r = await rig.api("POST", `/consoles/${w.W._id}/duplicate`, member);
    expect(r.status).toBe(201);
    expect(await visibility(w.W._id)).toEqual(before);
    const copy = (await rig.row((r.body.data as { id: string }).id))!;
    expect(copy.access).toBe("private");
    expect(await rig.manager.canReadWithInheritance(copy, owner.id)).toBe(
      false,
    );
  });
});

describe("folders: who sees what is in them", () => {
  it("renaming the workspace folder holding PW moves its file, never its visibility", async () => {
    const w = await world();
    const before = await visibility(w.PW._id);
    const r = await rig.api(
      "PATCH",
      `/consoles/folders/${w.team}/rename`,
      editor,
      {
        name: "Team 2",
      },
    );
    expect(r.status).toBe(200);
    const after = await visibility(w.PW._id);
    expect(after.path).toBe(`users/${owner.id}/consoles/Team 2/pw.sql`);
    expect({ ...after, path: before.path }).toEqual(before);
  });

  it("a laptop edit of PW keeps it in its workspace folder (the sync never re-homes it)", async () => {
    const w = await world();
    const before = await visibility(w.PW._id);
    await rig.laptop({
      writes: { [w.PW.path!]: `${SECRET("PW")}-- edited on a laptop\n` },
    });
    const after = await visibility(w.PW._id);
    expect(after.folderId).toBe(before.folderId);
    expect(after.effective).toBe("workspace");
    expect(after.memberReads).toBe(true);
  });

  it("a shared editor (the folder's owner) cannot make the folder private under the owner's console", async () => {
    const w = await world();
    const before = await visibility(w.PW._id);
    for (const body of [{ access: "private" }]) {
      const r = await rig.api(
        "PATCH",
        `/consoles/folders/${w.team}/move`,
        editor,
        body,
      );
      expect([403, 409], JSON.stringify(r.body)).toContain(r.status);
      expect(await visibility(w.PW._id)).toEqual(before);
    }
    // Dragging it under a private folder of the editor's narrows nothing it
    // holds: a workspace folder stays workspace inside a private one.
    const box = await rig.manager.createFolder(
      "EdBox",
      rig.ws,
      editor.id,
      undefined,
      false,
      "private",
    );
    const drag = await rig.api(
      "PATCH",
      `/consoles/folders/${w.team}/move`,
      editor,
      { parentId: box._id.toString() },
    );
    if (drag.status === 200) {
      expect((await visibility(w.PW._id)).effective).toBe("workspace");
    }
    // A workspace admin may make it private.
    const asAdmin = await rig.api(
      "PATCH",
      `/consoles/folders/${w.team}/move`,
      admin,
      { parentId: null, access: "private" },
    );
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(200);
    expect((await visibility(w.PW._id)).effective).toBe("private");
  });

  it("a folder of the editor's that holds the owner's private console is never published by the editor", async () => {
    const w = await world();
    const box = await rig.manager.createFolder(
      "EdBox",
      rig.ws,
      editor.id,
      undefined,
      false,
      "private",
    );
    // A row filed there before the rule existed (the API no longer allows it).
    await SavedConsole.updateOne(
      { _id: w.P._id },
      { $set: { folderId: box._id } },
    );
    const before = await visibility(w.P._id);
    for (const body of [
      { access: "workspace" },
      { parentId: w.team },
      { parentId: w.team, access: "private" },
    ]) {
      const r = await rig.api(
        "PATCH",
        `/consoles/folders/${box._id}/move`,
        editor,
        body,
      );
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(await visibility(w.P._id)).toEqual(before);
    }
    // Nobody else can even write the editor's private folder.
    for (const as of [owner, member, viewer, admin]) {
      const r = await rig.api(
        "PATCH",
        `/consoles/folders/${box._id}/move`,
        as,
        { access: "workspace" },
      );
      expect([403, 404]).toContain(r.status);
      expect(await visibility(w.P._id)).toEqual(before);
    }
  });
});

describe("deleting a folder", () => {
  it("never deletes another member's console: refused with nothing changed", async () => {
    const w = await world();
    const before = {
      PW: await visibility(w.PW._id),
      files: await rig.consolePaths(),
    };
    const commits = await rig.commitCount();
    // The editor owns the workspace folder "Team" — which holds the
    // owner's private PW (seen by the workspace through it).
    const r = await rig.api("DELETE", `/consoles/folders/${w.team}`, editor);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await visibility(w.PW._id)).toEqual(before.PW);
    expect(await rig.consolePaths()).toEqual(before.files);
    expect(await rig.commitCount()).toBe(commits);
    expect(await ConsoleFolder.findById(w.team)).not.toBeNull();
  });

  it("deleting one's own folder puts its consoles in the trash — restorable, never gone", async () => {
    const box = await rig.manager.createFolder(
      "Scratch",
      rig.ws,
      owner.id,
      undefined,
      false,
      "workspace",
    );
    const a = await rig.save("a", owner, {
      folderId: box._id.toString(),
      code: "SELECT 'keep me'\n",
    });
    await rig.shareWith(a._id, editor.id, "editor");
    const commits = await rig.commitCount();
    const r = await rig.api("DELETE", `/consoles/folders/${box._id}`, owner);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await rig.commitCount()).toBe(commits + 1);
    expect(await rig.fileAt("consoles/Scratch/a.sql")).toBeNull();
    const trashed = (await rig.row(a._id))!;
    expect(trashed.is_deleted).toBe(true);
    expect(trashed.sharedWith?.length).toBe(1);
    // Restored: back (at its scope's root — the folder is gone), its
    // content and its history before the delete intact.
    const restore = await rig.api("PATCH", `/consoles/${a._id}/restore`, owner);
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    const back = (await rig.row(a._id))!;
    expect(back.is_deleted).toBeFalsy();
    expect(back.path).toBe("consoles/a.sql");
    expect(await rig.fileAt("consoles/a.sql")).toBe("SELECT 'keep me'\n");
    expect((await rig.history(a._id)).length).toBeGreaterThanOrEqual(3);
  });

  it("a workspace admin may delete a folder holding others' consoles — into the trash", async () => {
    const w = await world();
    const r = await rig.api("DELETE", `/consoles/folders/${w.team}`, admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pw = (await rig.row(w.PW._id))!;
    expect(pw.is_deleted).toBe(true);
    expect(
      (await rig.api("PATCH", `/consoles/${w.PW._id}/restore`, owner)).status,
    ).toBe(200);
  });
});

describe("reads: nothing of a console reaches someone who cannot open it", () => {
  it("content, history, diffs, details, results, collaborators, the tree and resolve — all closed on P", async () => {
    const w = await world();
    const id = w.P._id.toString();
    // One more commit so history has something to show.
    await rig.api("PATCH", `/consoles/${id}/rename`, owner, { name: "p2" });
    const sha = (await rig.api("GET", `/consoles/${id}/history`, owner)).body
      .commits![0].oid;
    const pathNow = (await rig.row(id))!.path!;
    const urls = [
      `/consoles/content?id=${id}`,
      `/consoles/${id}/history`,
      `/consoles/${id}/git/commit?sha=${sha}`,
      `/consoles/${id}/git/file-versions?sha=${sha}`,
      `/consoles/${id}/git/file-versions?sha=${sha}&path=${encodeURIComponent(pathNow)}`,
      `/consoles/${id}/details`,
      `/consoles/${id}/export?format=json`,
      `/consoles/${id}/executions`,
      `/consoles/${id}/collaborators`,
      `/objects/resolve?kind=console&ref=${id}`,
      `/objects/resolve?kind=console&ref=p2`,
      `/objects/resolve?kind=console&ref=${encodeURIComponent(pathNow)}`,
    ];
    for (const as of [member, viewer, admin, outsider]) {
      for (const url of urls) {
        const r = await rig.api("GET", url, as);
        expect([403, 404], `${label(as)} GET ${url} → ${r.status}`).toContain(
          r.status,
        );
        expect(JSON.stringify(r.body), `${label(as)} GET ${url}`).not.toMatch(
          /SECRET-(P|RESULT)/,
        );
      }
      const exec = await rig.api("POST", `/consoles/${id}/execute`, as, {});
      expect([403, 404], `${label(as)} execute`).toContain(exec.status);
      // Nor through another console they can read: W's diff of P's path,
      // W's restore of P's commit.
      const viaW = await rig.api(
        "GET",
        `/consoles/${w.W._id}/git/file-versions?sha=${sha}&path=${encodeURIComponent(pathNow)}`,
        as,
      );
      expect(JSON.stringify(viaW.body)).not.toContain("SECRET-P");
      if (as.role) {
        const list = await rig.api("GET", "/consoles", as);
        expect(JSON.stringify(list.body)).not.toContain(id);
        expect(
          await resolveObjectRef(rig.ctx(as), "console", id),
          label(as),
        ).toBeNull();
      }
    }
    const restore = await rig.api(
      "POST",
      `/consoles/${w.W._id}/restore`,
      owner,
      {
        sha,
      },
    );
    expect(restore.status).toBe(404);
    expect(await rig.fileAt(w.W.path!)).toBe(SECRET("W"));
    // The shared editor reads it.
    const asEditor = await rig.api("GET", `/consoles/${id}/history`, editor);
    expect(asEditor.status).toBe(200);
  });

  it("whoever can open a console reads its history: PW (seen through its workspace folder)", async () => {
    const w = await world();
    const content = await rig.api(
      "GET",
      `/consoles/content?id=${w.PW._id}`,
      member,
    );
    expect(content.status).toBe(200);
    const hist = await rig.api("GET", `/consoles/${w.PW._id}/history`, member);
    expect(hist.status, JSON.stringify(hist.body)).toBe(200);
    const sha = hist.body.commits![0].oid;
    const v = await rig.api(
      "GET",
      `/consoles/${w.PW._id}/git/file-versions?sha=${sha}`,
      member,
    );
    expect(v.status).toBe(200);
    // Reading is not writing: no restore for a reader.
    const r = await rig.api("POST", `/consoles/${w.PW._id}/restore`, member, {
      sha,
    });
    expect([403, 404]).toContain(r.status);
  });

  it("export runs what execute runs: the committed console, never an unsaved draft", async () => {
    const w = await world();
    const draft = await rig.api("PUT", `/consoles/${w.W._id}`, owner, {
      content: "SELECT 'UNSAVED DRAFT'\n",
    });
    expect(draft.status).toBe(200);
    expect((await rig.row(w.W._id))!.code).toContain("UNSAVED DRAFT");
    who.queries.length = 0;
    const exported = await rig.api(
      "GET",
      `/consoles/${w.W._id}/export?format=json`,
      member,
    );
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const executed = await rig.api(
      "POST",
      `/consoles/${w.W._id}/execute`,
      member,
      {},
    );
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(who.queries).toHaveLength(2);
    for (const q of who.queries) {
      expect(String(q)).toContain("SECRET-W");
      expect(String(q)).not.toContain("UNSAVED DRAFT");
    }
  });

  it("a read-only member (workspace viewer role) can read W but never write or re-scope it", async () => {
    const w = await world();
    const before = await visibility(w.W._id);
    expect(
      (await rig.api("GET", `/consoles/${w.W._id}/history`, viewer)).status,
    ).toBe(200);
    for (const [method, url, body] of [
      ["PATCH", `/consoles/${w.W._id}/rename`, { name: "x" }],
      ["PATCH", `/consoles/${w.W._id}/move`, { name: "x" }],
      ["PUT", `/consoles/${w.W._id}`, { content: "x", isSaved: true }],
      ["DELETE", `/consoles/${w.W._id}`, undefined],
    ] as const) {
      const r = await rig.api(method, url, viewer, body);
      expect([403, 404], `${method} ${url}`).toContain(r.status);
    }
    await expect(
      renameObject(rig.ctx(viewer), "console", {
        ref: w.W._id.toString(),
        title: "x",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await visibility(w.W._id)).toEqual(before);
    await syncConsolesIndexFromRepo(rig.ws);
    expect(await visibility(w.W._id)).toEqual(before);
    expect(await ConsoleFolder.countDocuments({})).toBe(2);
  });
});
