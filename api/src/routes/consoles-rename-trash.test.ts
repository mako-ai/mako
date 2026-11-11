/**
 * The console routes a rename, a move, a delete and an Undo go through,
 * over HTTP against real git and Mongo: what each answers when it is
 * refused (a name no file can have, a place that is taken, a change of
 * who sees it that is not the caller's, a console in the trash) and what
 * it says it did (the name as saved, what a folder delete trashed).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";

const auth = vi.hoisted(() => ({
  userId: "",
  roles: {} as Record<string, string>,
}));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: auth.userId });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    getMember: vi.fn(async (_ws: string, userId: string) => ({
      role: auth.roles[userId] ?? "member",
    })),
    hasRole: vi.fn(async (_ws: string, userId: string, roles: string[]) =>
      roles.includes(auth.roles[userId] ?? "member"),
    ),
  },
}));

import { consoleRoutes } from "./consoles";
import { ConsoleFolder, SavedConsole } from "../database/workspace-schema";
import {
  ALICE,
  BOB,
  WS,
  consoleFiles,
  fileAt,
  holdAt,
  listedIds,
  manager,
  push,
  resetRig,
  row,
  save,
  startRig,
  stopRig,
  sync,
} from "../apps/console-test-rig";
import { Types } from "mongoose";

const app = new Hono();
app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);

async function call(
  method: string,
  path: string,
  body?: unknown,
  as: string = ALICE,
): Promise<{ status: number; json: Record<string, any> }> {
  auth.userId = as;
  const res = await app.request(`/api/workspaces/${WS}/consoles${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, any>,
  };
}

beforeAll(startRig);
afterAll(stopRig);
beforeEach(async () => {
  auth.roles = {};
  await resetRig();
});

describe("PATCH /{id}/rename and /{id}/move", () => {
  it("answers with the name as saved, and refuses with the reason", async () => {
    const id = (await save("a"))._id.toString();
    await save("taken");

    const renamed = await call("PATCH", `/${id}/rename`, {
      name: "Q1: revenue",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.data).toMatchObject({
      id,
      name: "Q1 - revenue",
      path: "Q1 - revenue",
      folderId: null,
      access: "workspace",
    });

    const clash = await call("PATCH", `/${id}/rename`, { name: "Taken" });
    expect(clash.status).toBe(409);
    expect(clash.json.error).toMatch(/already exists/);
    const bad = await call("PATCH", `/${id}/rename`, { name: "con" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/reserved/);
    expect(await consoleFiles()).toEqual([
      "consoles/Q1 - revenue.sql",
      "consoles/taken.sql",
    ]);
  });

  it("moves and renames in one request; a change of who sees it is the owner's or an admin's", async () => {
    const folder = await call("POST", "/folders", {
      name: "Team: A",
      access: "workspace",
    });
    expect(folder.status).toBe(201);
    expect(folder.json.data.name).toBe("Team - A");
    const folderId = folder.json.data.id as string;

    const mine = await save("mine", "SELECT 1", { access: "private" });
    const id = mine._id.toString();
    await SavedConsole.updateOne(
      { _id: id },
      { $set: { sharedWith: [{ userId: BOB, role: "editor" }] } },
    );
    const refused = await call("PATCH", `/${id}/move`, { folderId }, BOB);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/owner or a workspace admin/);

    const moved = await call("PATCH", `/${id}/move`, {
      folderId,
      name: "ours",
    });
    expect(moved.status).toBe(200);
    expect(moved.json.data).toMatchObject({
      name: "ours",
      path: "Team - A/ours",
      folderId,
      access: "workspace",
    });
    expect(await consoleFiles()).toEqual([
      "users/alice/consoles/Team - A/ours.sql",
    ]);
  });
});

describe("DELETE, then Undo", () => {
  it("a console goes to the trash and comes back; one in the trash is not renamed", async () => {
    const id = (await save("a"))._id.toString();
    expect((await call("DELETE", `/${id}`)).status).toBe(200);
    expect(await consoleFiles()).toEqual([]);
    expect((await call("PATCH", `/${id}/rename`, { name: "b" })).status).toBe(
      404,
    );
    expect((await call("DELETE", `/${id}`)).status).toBe(404);

    // Only whoever could delete it may take it out of the trash.
    expect((await call("PATCH", `/${id}/restore`, {}, BOB)).status).toBe(403);
    await save("A", "SELECT 'taken'");
    const restored = await call("PATCH", `/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.json.data).toMatchObject({ id, name: "a (2)" });
    expect((await call("PATCH", `/${id}/restore`)).status).toBe(404);
  });

  it("a folder's consoles go to the trash; the answer is what its Undo puts back", async () => {
    const folderId = (
      await call("POST", "/folders", { name: "Team", access: "workspace" })
    ).json.data.id as string;
    const mine = await save("mine");
    const theirs = await save("theirs", "SELECT 2", { by: BOB });
    await manager.moveConsole(
      mine._id.toString(),
      WS,
      folderId,
      undefined,
      ALICE,
    );
    await manager.moveConsole(
      theirs._id.toString(),
      WS,
      folderId,
      undefined,
      BOB,
    );

    const refused = await call("DELETE", `/folders/${folderId}`);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/other members/);
    expect((await consoleFiles()).length).toBe(2);

    auth.roles[ALICE] = "admin";
    const deleted = await call("DELETE", `/folders/${folderId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.json.data.folders).toEqual([
      { id: folderId, name: "Team", parentId: null, access: "workspace" },
    ]);
    expect(
      (deleted.json.data.consoles as Array<{ name: string }>)
        .map(c => c.name)
        .sort(),
    ).toEqual(["mine", "theirs"]);
    expect(await consoleFiles()).toEqual([]);
    expect((await row(theirs._id))?.is_deleted).toBe(true);

    // Undo: the folder again, each console restored into it.
    const again = (
      await call("POST", "/folders", { name: "Team", access: "workspace" })
    ).json.data.id as string;
    const back = await call("PATCH", `/${mine._id.toString()}/restore`, {
      folderId: again,
    });
    expect(back.json.data).toMatchObject({
      name: "mine",
      path: "Team/mine",
      folderId: again,
    });
    expect(await consoleFiles()).toEqual(["consoles/Team/mine.sql"]);
  });
});

/** `POST /consoles`: a new console under a fresh id, as Save / Save a Copy does. */
const create = (path: string, content = "SELECT 'new'", as: string = ALICE) =>
  call(
    "POST",
    "",
    { id: new Types.ObjectId().toString(), path, content, access: "workspace" },
    as,
  );

describe("a console in the trash holds no name", () => {
  it("delete, create under the same name, then Undo: the new one keeps the name, the old one comes back as “name (2)”", async () => {
    const old = (await save("Alpha one", "SELECT 'old'"))._id.toString();
    expect((await call("DELETE", `/${old}`)).status).toBe(200);

    const created = await create("Alpha one");
    expect(created.status).toBe(201);
    const fresh = created.json.data.id as string;
    expect(fresh).not.toBe(old);
    expect(await consoleFiles()).toEqual(["consoles/Alpha one.sql"]);
    expect(await fileAt("consoles/Alpha one.sql")).toContain("'new'");
    expect((await row(old))?.is_deleted).toBe(true);
    await sync();
    expect(await listedIds()).toEqual([fresh]);

    // A tab still open on the trashed console cannot save into it.
    const saved = await call("PUT", `/${old}`, {
      content: "SELECT 'stale tab'",
      path: "Alpha one",
    });
    expect(saved.status).toBe(404);
    expect(await fileAt("consoles/Alpha one.sql")).toContain("'new'");

    const restored = await call("PATCH", `/${old}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.json.data).toMatchObject({
      id: old,
      name: "Alpha one (2)",
    });
    expect(await fileAt("consoles/Alpha one (2).sql")).toContain("'old'");
    expect((await listedIds()).sort()).toEqual([fresh, old].sort());
  });

  it("a new console is refused next to a live twin, named as it is really called — and not next to a trashed one", async () => {
    const live = (await save("Alpha one", "SELECT 'live'"))._id.toString();

    // The Save dialog's clash answer: the console that is there, by its
    // own name, to overwrite or to pick another name.
    const twin = await create("alpha ONE");
    expect(twin.status).toBe(409);
    expect(twin.json).toMatchObject({
      error: "conflict",
      conflict: { existingId: live, existingName: "Alpha one" },
    });
    // A rename onto it says the same name.
    const other = (await save("beta"))._id.toString();
    const renamed = await call("PATCH", `/${other}/rename`, {
      name: "ALPHA ONE",
    });
    expect(renamed.status).toBe(409);
    expect(renamed.json.error).toBe(
      "A console named “Alpha one” already exists.",
    );
    const moved = await call("PATCH", `/${other}/move`, {
      folderId: null,
      name: "alpha one",
    });
    expect(moved.status).toBe(409);
    expect(moved.json.error).toContain("“Alpha one”");
    expect(await consoleFiles()).toEqual([
      "consoles/Alpha one.sql",
      "consoles/beta.sql",
    ]);

    // In the trash it is no twin of anything: create, rename and copy pass.
    await call("DELETE", `/${live}`);
    expect((await create("alpha ONE")).status).toBe(201);
    expect(await consoleFiles()).toEqual([
      "consoles/alpha ONE.sql",
      "consoles/beta.sql",
    ]);
  });

  it("a new console never lands on a file pushed from a laptop and not indexed yet", async () => {
    await push({ "consoles/pushed.sql": "SELECT 'laptop'\n" });
    const refused = await create("Pushed");
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("A console named “pushed” already exists.");
    expect(await fileAt("consoles/pushed.sql")).toContain("laptop");
  });
});

describe("rename and move against a delete, through the routes", () => {
  it("a console in the trash is not renamed or moved, and nothing is created for it", async () => {
    const id = (await save("a"))._id.toString();
    await call("DELETE", `/${id}`);
    expect((await call("PATCH", `/${id}/rename`, { name: "b" })).status).toBe(
      404,
    );
    expect(
      (await call("PATCH", `/${id}/rename`, { name: "Team/b" })).status,
    ).toBe(404);
    expect(
      (await call("PATCH", `/${id}/move`, { folderId: null, name: "b" }))
        .status,
    ).toBe(404);
    expect(await ConsoleFolder.countDocuments({})).toBe(0);
    expect(await consoleFiles()).toEqual([]);
    expect((await row(id))?.name).toBe("a");
  });

  /** After a DELETE that answered 200: gone, and no rename finds it. */
  async function expectTrashed(id: string): Promise<void> {
    expect(await consoleFiles()).toEqual([]);
    expect((await row(id))?.is_deleted).toBe(true);
    expect(
      (await call("PATCH", `/${id}/rename`, { name: "later" })).status,
    ).toBe(404);
    expect(
      (await call("PATCH", `/${id}/move`, { folderId: null })).status,
    ).toBe(404);
    await sync();
    expect(await listedIds()).toEqual([]);
  }

  it("DELETE held after its read while PATCH /rename completes", async () => {
    const id = (await save("a"))._id.toString();
    const hold = holdAt("afterRead");
    const deleting = call("DELETE", `/${id}`);
    await hold.reached;
    expect((await call("PATCH", `/${id}/rename`, { name: "b" })).status).toBe(
      200,
    );
    hold.release();
    expect((await deleting).status).toBe(200);
    await expectTrashed(id);
  });

  it("PATCH /rename held after its read, then after its commit, while DELETE completes", async () => {
    for (const point of ["afterRead", "afterCommit"] as const) {
      const id = (await save(`a-${point}`))._id.toString();
      const hold = holdAt(point);
      const renaming = call("PATCH", `/${id}/rename`, { name: `b-${point}` });
      await hold.reached;
      expect((await call("DELETE", `/${id}`)).status).toBe(200);
      hold.release();
      expect((await renaming).status, point).toBe(404);
      await expectTrashed(id);
    }
  });

  it("PATCH /move held after its read while DELETE completes", async () => {
    const folderId = (
      await call("POST", "/folders", { name: "Team", access: "workspace" })
    ).json.data.id as string;
    const id = (await save("a"))._id.toString();
    const hold = holdAt("afterRead");
    const moving = call("PATCH", `/${id}/move`, { folderId });
    await hold.reached;
    expect((await call("DELETE", `/${id}`)).status).toBe(200);
    hold.release();
    expect((await moving).status).toBe(404);
    await expectTrashed(id);
  });
});

describe("what a member is told", () => {
  it("says read-only access when that is the reason, and who can delete a folder", async () => {
    const id = (await save("alices"))._id.toString();
    for (const [path, body] of [
      [`/${id}/rename`, { name: "bobs" }],
      [`/${id}/move`, { folderId: null, access: "private" }],
    ] as const) {
      const refused = await call("PATCH", path, body, BOB);
      expect(refused.status).toBe(403);
      expect(refused.json.error).toBe(
        "You have read-only access to this console.",
      );
    }
    const folderId = (
      await call("POST", "/folders", { name: "Mine", access: "private" })
    ).json.data.id as string;
    const denied = await call("DELETE", `/folders/${folderId}`, undefined, BOB);
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe(
      "Only the folder's owner or a workspace admin can delete this folder.",
    );
    expect(await consoleFiles()).toEqual(["consoles/alices.sql"]);
  });
});
