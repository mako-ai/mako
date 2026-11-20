/**
 * Domain auto-join: a signed-in person whose email domain a workspace lists
 * becomes a member on first contact — with the access role the workspace
 * chose and nothing else — so someone who clicks an app link and signs in
 * is simply in, without an invitation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../database/schema";
import { Workspace, WorkspaceMember } from "../database/workspace-schema";
import {
  ensureAutoJoin,
  findAutoJoinOffers,
  normalizeAutoJoin,
} from "./auto-join.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Workspace.deleteMany({});
  await WorkspaceMember.deleteMany({});
  await Workspace.create({
    _id: WS,
    name: "Acme",
    slug: "acme",
    createdBy: "u-owner",
    settings: { autoJoin: { domains: ["acme.com"], role: "viewer" } },
    billing: {},
  });
});

describe("ensureAutoJoin", () => {
  it("makes a matching-domain stranger a member with the workspace's access role", async () => {
    const member = await ensureAutoJoin(WS.toString(), {
      id: "u-sam",
      email: "Sam@Acme.com",
    });
    expect(member).toMatchObject({ userId: "u-sam", role: "viewer" });
    expect(await WorkspaceMember.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("is idempotent and never touches an existing membership", async () => {
    await WorkspaceMember.create({
      workspaceId: WS,
      userId: "u-lead",
      role: "admin",
    });
    const member = await ensureAutoJoin(WS.toString(), {
      id: "u-lead",
      email: "lead@acme.com",
    });
    expect(member?.role).toBe("admin");
    await ensureAutoJoin(WS.toString(), { id: "u-sam", email: "sam@acme.com" });
    await ensureAutoJoin(WS.toString(), { id: "u-sam", email: "sam@acme.com" });
    expect(await WorkspaceMember.countDocuments({ workspaceId: WS })).toBe(2);
  });

  it("refuses other domains, sub-domains, and a workspace with no auto-join", async () => {
    expect(
      await ensureAutoJoin(WS.toString(), { id: "u-x", email: "x@gmail.com" }),
    ).toBeNull();
    expect(
      await ensureAutoJoin(WS.toString(), {
        id: "u-y",
        email: "y@evil.acme.com",
      }),
    ).toBeNull();
    await Workspace.updateOne(
      { _id: WS },
      { $unset: { "settings.autoJoin": 1 } },
    );
    expect(
      await ensureAutoJoin(WS.toString(), { id: "u-z", email: "z@acme.com" }),
    ).toBeNull();
    expect(await WorkspaceMember.countDocuments({ workspaceId: WS })).toBe(0);
  });

  it("never grants more than member, whatever the stored role says", async () => {
    await Workspace.updateOne(
      { _id: WS },
      { $set: { "settings.autoJoin.role": "admin" } },
      { strict: false },
    );
    const member = await ensureAutoJoin(WS.toString(), {
      id: "u-sam",
      email: "sam@acme.com",
    });
    expect(member?.role).toBe("viewer");
  });
});

describe("findAutoJoinOffers", () => {
  beforeEach(async () => {
    await User.deleteMany({});
    await User.create([
      { _id: "u-owner", email: "owner@acme.com", emailVerified: true },
      { _id: "u-outsider", email: "boss@gmail.com", emailVerified: true },
      { _id: "u-unverified", email: "fake@acme.com", emailVerified: false },
    ]);
    await WorkspaceMember.create({
      workspaceId: WS,
      userId: "u-owner",
      role: "owner",
    });
  });

  it("offers a workspace that auto-joins the domain and is run from it", async () => {
    expect(
      await findAutoJoinOffers({ id: "u-sam", email: "sam@acme.com" }),
    ).toEqual([
      {
        workspaceId: WS.toString(),
        workspaceName: "Acme",
        domain: "acme.com",
        role: "viewer",
      },
    ]);
  });

  it("drops workspaces already joined, other domains, and look-alikes run from elsewhere", async () => {
    const LOOKALIKE = new Types.ObjectId();
    await Workspace.create({
      _id: LOOKALIKE,
      name: "Acme",
      slug: "acme-1",
      createdBy: "u-outsider",
      settings: { autoJoin: { domains: ["acme.com"], role: "member" } },
      billing: {},
    });
    await WorkspaceMember.create([
      { workspaceId: LOOKALIKE, userId: "u-outsider", role: "owner" },
      { workspaceId: LOOKALIKE, userId: "u-unverified", role: "admin" },
    ]);
    expect(
      (await findAutoJoinOffers({ id: "u-sam", email: "sam@acme.com" })).map(
        o => o.workspaceId,
      ),
    ).toEqual([WS.toString()]);

    await ensureAutoJoin(WS.toString(), { id: "u-sam", email: "sam@acme.com" });
    expect(
      await findAutoJoinOffers({ id: "u-sam", email: "sam@acme.com" }),
    ).toEqual([]);
    expect(
      await findAutoJoinOffers({ id: "u-x", email: "x@evil.acme.com" }),
    ).toEqual([]);
  });
});

describe("normalizeAutoJoin", () => {
  it("lowercases and dedupes domains, rejects junk, and drops the block when no domain is left", () => {
    expect(
      normalizeAutoJoin({
        domains: [" Acme.com", "acme.com", "@acme.ch", "", "not a domain"],
        role: "member",
      }),
    ).toEqual({ domains: ["acme.com", "acme.ch"], role: "member" });
    expect(normalizeAutoJoin({ domains: ["acme.com"], role: "owner" })).toEqual(
      { domains: ["acme.com"], role: "viewer" },
    );
    expect(
      normalizeAutoJoin({ domains: ["", "x"], role: "viewer" }),
    ).toBeNull();
    expect(normalizeAutoJoin(null)).toBeNull();
  });
});
