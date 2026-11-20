/**
 * A published token is re-authorized on every use, against real Mongo. One case
 * per way access can end while the token itself is still valid: member
 * removed (also owner / sharedWith), app made private, republish, share
 * disabled or rotated, password added. Plus the cold-cache single flight.
 */
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AppProject,
  WorkspaceMember,
  type IAppProject,
} from "../database/workspace-schema";
import {
  clearPublishedGrantAccessCache,
  publishedGrantAllowed,
} from "./published-grant-access";
import { mintPublishedGrant, shareFingerprint } from "./preview.service";

const SHA = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
const NEW_SHA = "0123456789abcdef0123456789abcdef01234567";
const VIEWER = { id: "viewer-1", email: "viewer@example.com" };

let mongo: MongoMemoryServer;
let project: IAppProject;
let workspaceId: Types.ObjectId;

const viewerGrant = (sha = SHA) =>
  mintPublishedGrant({
    workspaceId: workspaceId.toString(),
    projectId: project._id.toString(),
    sha,
    viewer: VIEWER,
  });
const shareGrant = (token: string, passwordHash?: string) =>
  mintPublishedGrant({
    workspaceId: workspaceId.toString(),
    projectId: project._id.toString(),
    sha: SHA,
    share: shareFingerprint(token, passwordHash),
  });
const allowed = (grant: ReturnType<typeof viewerGrant>) => {
  clearPublishedGrantAccessCache();
  return publishedGrantAllowed(grant);
};
const member = () =>
  WorkspaceMember.create({ workspaceId, userId: VIEWER.id, role: "member" });

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "published-grant-access-test-secret");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await AppProject.deleteMany({});
  await WorkspaceMember.deleteMany({});
  workspaceId = new Types.ObjectId();
  project = await AppProject.create({
    workspaceId,
    title: "App",
    slug: "app",
    access: "workspace",
    owner_id: "owner",
    createdBy: "owner",
    publishedSha: SHA,
    publicShare: { enabled: true, token: "share-token" },
  });
});

describe("viewer tokens", () => {
  it("allow a current member", async () => {
    await member();
    expect(await allowed(viewerGrant())).toBe(true);
  });

  it("stop when the member is removed", async () => {
    await member();
    const grant = viewerGrant();
    expect(await allowed(grant)).toBe(true);
    await WorkspaceMember.deleteMany({});
    expect(await allowed(grant)).toBe(false);
  });

  it("stop for a removed member who owns the app", async () => {
    await AppProject.updateOne({ _id: project._id }, { owner_id: VIEWER.id });
    expect(await allowed(viewerGrant())).toBe(false);
  });

  it("stop for a removed member named in sharedWith", async () => {
    await AppProject.updateOne(
      { _id: project._id },
      { sharedWith: [{ userId: VIEWER.id, role: "viewer" }] },
    );
    expect(await allowed(viewerGrant())).toBe(false);
  });

  it("stop when the app is made private", async () => {
    await member();
    const grant = viewerGrant();
    expect(await allowed(grant)).toBe(true);
    await AppProject.updateOne({ _id: project._id }, { access: "private" });
    expect(await allowed(grant)).toBe(false);
  });

  it("stop on republish and on unpublish", async () => {
    await member();
    const grant = viewerGrant();
    await AppProject.updateOne({ _id: project._id }, { publishedSha: NEW_SHA });
    expect(await allowed(grant)).toBe(false);
    expect(await allowed(viewerGrant(NEW_SHA))).toBe(true);
    await AppProject.updateOne(
      { _id: project._id },
      { $unset: { publishedSha: 1 } },
    );
    expect(await allowed(viewerGrant(NEW_SHA))).toBe(false);
  });
});

describe("share tokens", () => {
  it("allow the current share", async () => {
    expect(await allowed(shareGrant("share-token"))).toBe(true);
  });

  it("stop when the share is disabled or rotated", async () => {
    const grant = shareGrant("share-token");
    await AppProject.updateOne(
      { _id: project._id },
      { "publicShare.enabled": false },
    );
    expect(await allowed(grant)).toBe(false);
    await AppProject.updateOne(
      { _id: project._id },
      { "publicShare.enabled": true, "publicShare.token": "rotated" },
    );
    expect(await allowed(grant)).toBe(false);
  });

  it("stop when a password is added, and follow the new password", async () => {
    const before = shareGrant("share-token");
    await AppProject.updateOne(
      { _id: project._id },
      { "publicShare.passwordHash": "hash-1" },
    );
    expect(await allowed(before)).toBe(false);
    expect(await allowed(shareGrant("share-token", "hash-1"))).toBe(true);
    await AppProject.updateOne(
      { _id: project._id },
      { "publicShare.passwordHash": "hash-2" },
    );
    expect(await allowed(shareGrant("share-token", "hash-1"))).toBe(false);
  });

  it("stop on republish", async () => {
    const grant = shareGrant("share-token");
    await AppProject.updateOne({ _id: project._id }, { publishedSha: NEW_SHA });
    expect(await allowed(grant)).toBe(false);
  });
});

describe("cold cache", () => {
  it("runs one check for parallel requests", async () => {
    await member();
    const grant = viewerGrant();
    clearPublishedGrantAccessCache();
    const find = vi.spyOn(AppProject, "findById");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => publishedGrantAllowed(grant)),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(find).toHaveBeenCalledTimes(1);
    find.mockRestore();
  });
});
