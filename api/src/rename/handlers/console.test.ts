/**
 * `rename_object` kind `console`, through the registry, against real git
 * and Mongo: what a ref resolves to, what `title` and `slug` do, and that
 * the refusals are the relocation service's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConsoleFolder, SavedConsole } from "../../database/workspace-schema";
import {
  ALICE,
  BOB,
  WS,
  consoleFiles,
  fileAt,
  manager,
  push,
  resetRig,
  save,
  startRig,
  stopRig,
} from "../../apps/console-test-rig";
import { renameObject, resolveObjectRef } from "../registry";

beforeAll(startRig);
afterAll(stopRig);
beforeEach(resetRig);

const alice = { workspaceId: WS, userId: ALICE, role: "member" };
const bob = { workspaceId: WS, userId: BOB, role: "member" };
const rename = (
  ctx: typeof alice,
  ref: string,
  to: { title?: string; slug?: string },
) => renameObject(ctx, "console", { ref, ...to });

describe("resolve", () => {
  it("finds a console by id, repo path, folder path or a name only one console has", async () => {
    const team = await manager.createFolder(
      "Team",
      WS,
      ALICE,
      undefined,
      false,
      "workspace",
    );
    const report = await save("report");
    await manager.moveConsole(
      report._id.toString(),
      WS,
      team._id.toString(),
      undefined,
      ALICE,
    );
    const id = report._id.toString();
    for (const ref of [
      id,
      "consoles/Team/report.sql",
      "Team/report",
      "report",
    ]) {
      const hit = await resolveObjectRef(alice, "console", ref);
      expect(hit, ref).toMatchObject({
        kind: "console",
        id,
        via: "current",
        current: {
          title: "report",
          path: "consoles/Team/report.sql",
          url: `/c/${id}`,
        },
      });
    }
    // A second "report" makes the bare name ambiguous; a folder in the ref
    // must be that folder.
    await save("report");
    expect(await resolveObjectRef(alice, "console", "report")).toMatchObject({
      current: { path: "consoles/report.sql" },
    });
    expect(await resolveObjectRef(alice, "console", "Other/report")).toBeNull();
    await push({ "consoles/Sub/report.sql": "SELECT 3\n" });
    expect(
      (await resolveObjectRef(alice, "console", "Sub/report"))?.current.path,
    ).toBe("consoles/Sub/report.sql");
  });

  it("does not find another member's private console, nor one in the trash", async () => {
    const secret = await save("secret", "SELECT 1", { access: "private" });
    const id = secret._id.toString();
    expect(await resolveObjectRef(bob, "console", id)).toBeNull();
    expect(await resolveObjectRef(bob, "console", "secret")).toBeNull();
    await expect(rename(bob, id, { title: "mine" })).rejects.toMatchObject({
      status: 404,
    });
    await manager.softDeleteConsole(id, WS, ALICE);
    expect(await resolveObjectRef(alice, "console", id)).toBeNull();
    await expect(rename(alice, id, { title: "back" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("rename", () => {
  it("`title` renames in place: same id, one commit, the name as saved", async () => {
    const id = (await save("a", "SELECT 1"))._id.toString();
    const result = await rename(alice, id, { title: "Q1: revenue / EU" });
    expect(result).toMatchObject({
      kind: "console",
      id,
      before: { title: "a", path: "consoles/a.sql" },
      after: {
        title: "Q1 - revenue - EU",
        path: "consoles/Q1 - revenue - EU.sql",
        url: `/c/${id}`,
      },
      aliasesAdded: [],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.warnings.join(" ")).toMatch(/Saved as “Q1 - revenue - EU”/);
    expect(await consoleFiles()).toEqual(["consoles/Q1 - revenue - EU.sql"]);

    // The name it has, typed either way, is nothing to do.
    for (const title of ["Q1 - revenue - EU", "Q1: revenue / EU"]) {
      const again = await rename(alice, id, { title });
      expect(again.commit).toBeUndefined();
      expect(again.warnings.join(" ")).toMatch(/Nothing to change/);
    }
  });

  it("`slug` moves it: a folder path, or a repo path that also says who sees it", async () => {
    const id = (await save("a", "SELECT 1"))._id.toString();
    const moved = await rename(alice, id, { slug: "Team/report" });
    expect(moved.after).toMatchObject({
      title: "report",
      path: "consoles/Team/report.sql",
    });
    expect(await ConsoleFolder.countDocuments({ name: "Team" })).toBe(1);

    const priv = await rename(alice, id, {
      slug: "users/alice/consoles/report",
    });
    expect(priv.after.path).toBe("users/alice/consoles/report.sql");
    expect((await SavedConsole.findById(id))?.access).toBe("private");
    expect(await fileAt("users/alice/consoles/report.sql")).toBe("SELECT 1\n");

    const back = await rename(alice, id, {
      slug: "consoles/report.sql",
      title: "report",
    });
    expect(back.after.path).toBe("consoles/report.sql");
  });

  it("refuses with the service's own reasons", async () => {
    const id = (await save("a"))._id.toString();
    await save("taken");
    const refusals: Array<[{ title?: string; slug?: string }, number, RegExp]> =
      [
        [{ title: "Taken" }, 409, /already exists/],
        [{ title: "con" }, 400, /reserved/],
        [{ title: ".." }, 400, /not a name/],
        [{ slug: "consoles/a.js" }, 400, /language/],
        [{ slug: "users/nobody" }, 400, /full path/],
        [{ slug: "users/bob/consoles/a" }, 403, /owner's folder/],
        [{ slug: "Team/b", title: "c" }, 400, /disagree/],
      ];
    for (const [to, status, message] of refusals) {
      await expect(
        rename(alice, id, to),
        JSON.stringify(to),
      ).rejects.toMatchObject({
        name: "RenameError",
        status,
        message: expect.stringMatching(message),
      });
    }
    // Refused before anything was created for it.
    expect(await ConsoleFolder.countDocuments({})).toBe(0);
    expect(await consoleFiles()).toEqual([
      "consoles/a.sql",
      "consoles/taken.sql",
    ]);
  });

  it("someone who can only read it cannot rename it; an editor cannot change who sees it", async () => {
    const mine = await save("mine", "SELECT 1", { access: "private" });
    const id = mine._id.toString();
    await SavedConsole.updateOne(
      { _id: id },
      { $set: { sharedWith: [{ userId: BOB, role: "viewer" }] } },
    );
    await expect(rename(bob, id, { title: "x" })).rejects.toMatchObject({
      status: 403,
    });
    await SavedConsole.updateOne(
      { _id: id },
      { $set: { sharedWith: [{ userId: BOB, role: "editor" }] } },
    );
    expect((await rename(bob, id, { title: "ours" })).after.title).toBe("ours");
    await expect(
      rename(bob, id, { slug: "consoles/ours" }),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/owner or a workspace admin/),
    });
    expect(await consoleFiles()).toEqual(["users/alice/consoles/ours.sql"]);
  });
});
