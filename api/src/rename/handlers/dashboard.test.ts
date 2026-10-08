/**
 * The dashboard rename handler: Mongo-only (mongodb-memory-server), no git.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Dashboard } from "../../database/workspace-schema";
import { renameObject, resolveObjectRef } from "../registry";
import { dashboardDiffBase } from "../../services/dashboard-diff-base";
import { computeSnapshotDiff } from "../../services/version-comment.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const OWNER = new Types.ObjectId().toString();
const VIEWER = new Types.ObjectId().toString();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Dashboard.deleteMany({});
});

async function seed(
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const doc = await Dashboard.create({
    workspaceId: new Types.ObjectId(WS),
    title,
    createdBy: OWNER,
    owner_id: OWNER,
    access: "workspace",
    ...extra,
  });
  return doc._id.toString();
}

const owner = { workspaceId: WS, userId: OWNER, role: "member" };
const viewer = { workspaceId: WS, userId: VIEWER, role: "viewer" };
const apiKey = { workspaceId: WS };

describe("dashboard rename", () => {
  it("resolves by id and by a unique title, never by an ambiguous one", async () => {
    const id = await seed("Revenue");
    await seed("Twice");
    await seed("Twice");
    expect(await resolveObjectRef(owner, "dashboard", id)).toMatchObject({
      kind: "dashboard",
      id,
      via: "current",
      current: { title: "Revenue", url: `/d/${id}` },
    });
    expect((await resolveObjectRef(owner, "dashboard", "Revenue"))?.id).toBe(
      id,
    );
    expect(await resolveObjectRef(owner, "dashboard", "Twice")).toBeNull();
    expect(
      await resolveObjectRef(
        owner,
        "dashboard",
        new Types.ObjectId().toString(),
      ),
    ).toBeNull();
  });

  it("renames the title AND the published copy's title, bumps the version, keeps the id", async () => {
    const id = await seed("Old", {
      version: 4,
      published: { title: "Old", widgets: [] },
      publishedVersion: 4,
    });
    const result = await renameObject(owner, "dashboard", {
      ref: id,
      title: "New",
    });
    expect(result).toMatchObject({
      kind: "dashboard",
      id,
      before: { title: "Old", url: `/d/${id}` },
      after: { title: "New", url: `/d/${id}` },
      aliasesAdded: [],
      warnings: [],
    });
    const doc = await Dashboard.findById(id);
    expect(doc?.title).toBe("New");
    expect(doc?.version).toBe(5);
    expect((doc?.published as { title?: string })?.title).toBe("New");
    // Renaming is not publishing: the published version pointer is untouched.
    expect(doc?.publishedVersion).toBe(4);
  });

  it("a never-published dashboard has no published copy to patch", async () => {
    const id = await seed("Draft only");
    await renameObject(apiKey, "dashboard", { ref: id, title: "Still draft" });
    const doc = await Dashboard.findById(id);
    expect(doc?.title).toBe("Still draft");
    expect(doc?.published).toBeUndefined();
  });

  it("refuses a viewer, a slug, an empty title, and someone else's edit lock", async () => {
    const id = await seed("Guarded");
    await expect(
      renameObject(viewer, "dashboard", { ref: id, title: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      renameObject(owner, "dashboard", { ref: id, slug: "guarded" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameObject(owner, "dashboard", { ref: id, title: " " }),
    ).rejects.toMatchObject({ status: 400 });
    await Dashboard.updateOne(
      { _id: id },
      {
        $set: {
          editLock: {
            userId: VIEWER,
            userName: "Vera",
            acquiredAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    );
    await expect(
      renameObject(owner, "dashboard", { ref: id, title: "x" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await Dashboard.findById(id))?.title).toBe("Guarded");
  });

  it("a save's diff does not list a rename that is already saved", async () => {
    // The latest version still carries the old title: a rename writes the
    // title without a version.
    const id = await seed("Dash Beta");
    const saved = {
      title: "Dash Beta",
      layout: { columns: 12, rowHeight: 80 },
    };
    await renameObject(owner, "dashboard", { ref: id, title: "Dash Gamma" });
    const live = await Dashboard.findById(id, { title: 1 }).lean();

    // The editor's pending definition: the new title, one real edit.
    const pending = {
      title: "Dash Gamma",
      layout: { columns: 12, rowHeight: 90 },
    };
    const diff = computeSnapshotDiff(dashboardDiffBase(saved, live), pending);
    expect(diff).toContain('"rowHeight": 90');
    expect(diff).not.toContain("Dash Beta");
    expect(diff).not.toMatch(/^[-+].*"title"/m);

    // A title edited in the editor (not renamed) is still a change.
    const retitled = computeSnapshotDiff(dashboardDiffBase(saved, live), {
      ...pending,
      title: "Dash Delta",
    });
    expect(retitled).toMatch(/^-.*"title": "Dash Gamma"/m);
    expect(retitled).toMatch(/^\+.*"title": "Dash Delta"/m);

    // Never saved: nothing to diff against.
    expect(dashboardDiffBase(null, live)).toBeNull();
  });
});
