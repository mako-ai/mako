/**
 * Domain auto-join: a signed-in person whose email domain a workspace lists
 * becomes a member on first contact — with the access role the workspace
 * chose and nothing else — so someone who clicks an app link and signs in
 * is simply in, without an invitation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Workspace, WorkspaceMember } from "../database/workspace-schema";
import { ensureAutoJoin, normalizeAutoJoin } from "./auto-join.service";

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
