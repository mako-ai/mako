/**
 * Who an app is talking to (apps.md §28): the platform reports identity,
 * workspace access role and the person's role on the app — and nothing
 * about what they do for a living.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppProject,
  Workspace,
  WorkspaceMember,
  type IAppProject,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import {
  resolveAppViewer,
  resolveAppViewerByEmail,
} from "./app-viewer.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const OWNER = { id: "u-owner", email: "owner@acme.com" };
const ADMIN = { id: "u-admin", email: "admin@acme.com" };
const VIEWER = { id: "u-viewer", email: "Sam@Acme.com" };
const OUTSIDER = { id: "u-out", email: "out@elsewhere.com" };
let sharedApp: IAppProject;
let privateApp: IAppProject;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Workspace.create({
    _id: WS,
    name: "Acme",
    slug: "acme",
    createdBy: OWNER.id,
    settings: {},
    billing: {},
  });
  await WorkspaceMember.create([
    { workspaceId: WS, userId: OWNER.id, role: "owner" },
    { workspaceId: WS, userId: ADMIN.id, role: "admin" },
    { workspaceId: WS, userId: VIEWER.id, role: "viewer" },
  ]);
  await User.create({
    _id: VIEWER.id,
    email: "sam@acme.com",
    emailVerified: true,
  });
  sharedApp = await AppProject.create({
    workspaceId: WS,
    title: "Sales",
    slug: "sales",
    access: "workspace",
    workspaceRole: "editor",
    createdBy: OWNER.id,
    owner_id: OWNER.id,
  });
  privateApp = await AppProject.create({
    workspaceId: WS,
    title: "Secret",
    slug: "secret",
    access: "private",
    createdBy: ADMIN.id,
    owner_id: ADMIN.id,
    sharedWith: [{ userId: VIEWER.id, role: "viewer" }],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("resolveAppViewer", () => {
  it("is null for nobody (anonymous share)", async () => {
    expect(await resolveAppViewer(sharedApp, null)).toBeNull();
    expect(await resolveAppViewer(sharedApp, undefined)).toBeNull();
  });

  it("reports identity, the workspace and the access role, and the app role — nothing else", async () => {
    const viewer = await resolveAppViewer(sharedApp, VIEWER);
    expect(viewer).toEqual({
      id: VIEWER.id,
      email: "sam@acme.com",
      workspace: { id: WS.toString(), name: "Acme", role: "viewer" },
      app: { id: sharedApp._id.toString(), slug: "sales", role: "viewer" },
    });
    expect(Object.keys(viewer!).sort()).toEqual([
      "app",
      "email",
      "id",
      "workspace",
    ]);
  });

  it("derives the app role from the ACL: owner, editor for admins, share entries", async () => {
    expect((await resolveAppViewer(sharedApp, OWNER))!.app.role).toBe("owner");
    expect((await resolveAppViewer(sharedApp, ADMIN))!.app.role).toBe("editor");
    expect((await resolveAppViewer(privateApp, VIEWER))!.app.role).toBe(
      "viewer",
    );
    expect((await resolveAppViewer(privateApp, OWNER))!.app.role).toBeNull();
  });

  it("describes a non-member honestly: known identity, no roles", async () => {
    const viewer = await resolveAppViewer(sharedApp, OUTSIDER);
    expect(viewer!.workspace.role).toBeNull();
    expect(viewer!.app.role).toBeNull();
  });
});

describe("resolveAppViewerByEmail (preview as)", () => {
  it("resolves a member by email, case-insensitively, and null for a stranger", async () => {
    const viewer = await resolveAppViewerByEmail(sharedApp, "SAM@acme.com");
    expect(viewer?.id).toBe(VIEWER.id);
    expect(viewer?.workspace.role).toBe("viewer");
    expect(
      await resolveAppViewerByEmail(sharedApp, "nobody@acme.com"),
    ).toBeNull();
  });
});
