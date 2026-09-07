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
import {
  completePendingProfile,
  ensureAutoJoin,
  normalizeAutoJoin,
  pendingProfileHtml,
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

describe("pending profile — the general case: no default job role", () => {
  const notifications: string[] = [];
  const hooks = {
    slack: async (text: string) => {
      notifications.push("slack:" + text);
    },
    email: async (to: string, subject: string) => {
      notifications.push(`email:${to}:${subject}`);
    },
  };
  beforeEach(async () => {
    notifications.length = 0;
    await Workspace.updateOne(
      { _id: WS },
      {
        $set: {
          "settings.autoJoin": {
            domains: ["realadvisor.com"],
            role: "viewer",
            slackWebhookUrlEncrypted: "enc",
          },
        },
      },
    );
  });

  it("joins as pending, and tells the admins' Slack channel who needs a role", async () => {
    const member = await ensureAutoJoin(
      WS.toString(),
      { id: "u-new", email: "new.rep@realadvisor.com" },
      { returnTo: "/api/workspaces/x/apps/fr-sales-dashboard/live/", hooks },
    );
    expect(member).toMatchObject({ role: "viewer", profilePending: true });
    expect(member?.jobRole).toBeUndefined();
    expect(member?.pendingReturnTo).toBe(
      "/api/workspaces/x/apps/fr-sales-dashboard/live/",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatch(/^slack:.*new\.rep@realadvisor\.com/);
    expect(notifications[0]).toMatch(/settings\/members/);
    // A second contact does not nag the channel again.
    await ensureAutoJoin(
      WS.toString(),
      { id: "u-new", email: "new.rep@realadvisor.com" },
      { hooks },
    );
    expect(notifications).toHaveLength(1);
  });

  it("a default job role skips the queue entirely", async () => {
    await Workspace.updateOne(
      { _id: WS },
      { $set: { "settings.autoJoin.jobRole": "bdr" } },
    );
    const member = await ensureAutoJoin(
      WS.toString(),
      { id: "u-sam", email: "sam@realadvisor.com" },
      { hooks },
    );
    expect(member?.profilePending).toBeFalsy();
    expect(member?.jobRole).toBe("bdr");
    expect(notifications).toHaveLength(0);
  });

  it("completing the profile clears the wait, emails the person, and closes the loop on Slack", async () => {
    await ensureAutoJoin(
      WS.toString(),
      { id: "u-new", email: "new.rep@realadvisor.com" },
      { returnTo: "/apps/fr-sales-dashboard", hooks },
    );
    notifications.length = 0;
    const done = await completePendingProfile(
      WS.toString(),
      "u-new",
      {
        email: "new.rep@realadvisor.com",
        jobRole: "bdr",
        country: "FR",
        actor: "theo@realadvisor.com",
      },
      hooks,
    );
    expect(done).toBe(true);
    const member = await WorkspaceMember.findOne({
      workspaceId: WS,
      userId: "u-new",
    });
    expect(member?.profilePending).toBeFalsy();
    expect(member?.pendingReturnTo).toBeUndefined();
    expect(
      notifications.some(n => n.startsWith("email:new.rep@realadvisor.com:")),
    ).toBe(true);
    expect(
      notifications.some(n => n.startsWith("slack:") && /BDR/i.test(n)),
    ).toBe(true);
    // Not pending any more: a second completion is a no-op.
    expect(
      await completePendingProfile(
        WS.toString(),
        "u-new",
        { email: "new.rep@realadvisor.com", jobRole: "bdr" },
        hooks,
      ),
    ).toBe(false);
  });

  it("renders a waiting page that reloads itself", () => {
    const html = pendingProfileHtml({
      email: "new.rep@realadvisor.com",
      workspaceName: "RealAdvisor",
    });
    expect(html).toMatch(/administrat/i);
    expect(html).toMatch(/http-equiv="refresh"/);
  });
});
