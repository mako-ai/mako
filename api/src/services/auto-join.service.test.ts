/**
 * Domain auto-join: a signed-in person whose email domain a workspace lists
 * becomes a member on first contact — with the access role, job role and
 * country the workspace chose — so a rep who clicks the app link, signs in
 * with Google, and lands on their own view, without an invitation.
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
    name: "RealAdvisor",
    slug: "realadvisor",
    createdBy: "u-owner",
    settings: {
      autoJoin: {
        domains: ["realadvisor.com"],
        role: "viewer",
        jobRole: "bdr",
        country: "FR",
      },
    },
    billing: {},
  });
});

describe("ensureAutoJoin", () => {
  it("makes a matching-domain stranger a member with the workspace's defaults", async () => {
    const member = await ensureAutoJoin(WS.toString(), {
      id: "u-sam",
      email: "Sam@RealAdvisor.com",
    });
    expect(member).toMatchObject({
      userId: "u-sam",
      role: "viewer",
      jobRole: "bdr",
      country: "FR",
    });
    expect(await WorkspaceMember.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("is idempotent and never touches an existing membership", async () => {
    await WorkspaceMember.create({
      workspaceId: WS,
      userId: "u-lead",
      role: "admin",
      jobRole: "team_leader",
    });
    const member = await ensureAutoJoin(WS.toString(), {
      id: "u-lead",
      email: "lead@realadvisor.com",
    });
    expect(member?.role).toBe("admin");
    expect(member?.jobRole).toBe("team_leader");
    await ensureAutoJoin(WS.toString(), {
      id: "u-sam",
      email: "sam@realadvisor.com",
    });
    await ensureAutoJoin(WS.toString(), {
      id: "u-sam",
      email: "sam@realadvisor.com",
    });
    expect(await WorkspaceMember.countDocuments({ workspaceId: WS })).toBe(2);
  });

  it("refuses other domains, sub-domains, and a workspace with no auto-join", async () => {
    expect(
      await ensureAutoJoin(WS.toString(), { id: "u-x", email: "x@gmail.com" }),
    ).toBeNull();
    expect(
      await ensureAutoJoin(WS.toString(), {
        id: "u-y",
        email: "y@evil.realadvisor.com",
      }),
    ).toBeNull();
    await Workspace.updateOne(
      { _id: WS },
      { $unset: { "settings.autoJoin": 1 } },
    );
    expect(
      await ensureAutoJoin(WS.toString(), {
        id: "u-z",
        email: "z@realadvisor.com",
      }),
    ).toBeNull();
    expect(await WorkspaceMember.countDocuments({ workspaceId: WS })).toBe(0);
  });
});

describe("normalizeAutoJoin", () => {
  it("lowercases and dedupes domains, rejects junk, and drops the block when no domain is left", () => {
    expect(
      normalizeAutoJoin({
        domains: [
          " RealAdvisor.com",
          "realadvisor.com",
          "@ra.ch",
          "",
          "not a domain",
        ],
        role: "viewer",
        jobRole: "bdr",
        country: "fr",
      }),
    ).toEqual({
      domains: ["realadvisor.com", "ra.ch"],
      role: "viewer",
      jobRole: "bdr",
      country: "FR",
    });
    expect(
      normalizeAutoJoin({ domains: ["", "x"], role: "viewer" }),
    ).toBeNull();
    expect(normalizeAutoJoin(null)).toBeNull();
  });
});
