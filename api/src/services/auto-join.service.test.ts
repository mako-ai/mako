/**
 * Domain auto-join: a signed-in person whose email domain a workspace lists
 * becomes a member on first contact — with the access role the workspace
 * chose and nothing else — so someone who clicks an app link and signs in
 * is simply in, without an invitation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { generateObjectIdHex } from "../database/pg/id-codec";
import { workspaces } from "../database/pg/schema";
import { workspaceRepo } from "../repositories/workspaces";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
import { ensureAutoJoin, normalizeAutoJoin } from "./auto-join.service";

let pg: PgTestDb;
const WS = generateObjectIdHex();
let workspaceUuid: string;
let samId: string;

beforeAll(async () => {
  pg = await setupPgTestDb();
});
afterAll(() => pg?.close());
beforeEach(async () => {
  await pg.reset();
  const workspace = await ensureTestWorkspace(pg.db, {
    id: WS,
    name: "Acme",
    slug: "acme",
  });
  workspaceUuid = workspace.uuid;
  samId = (await ensureTestUser(pg.db, { id: "u-sam", email: "sam@acme.com" }))
    .id;
  await workspaceRepo.setAutoJoin(WS, {
    domains: ["acme.com"],
    role: "viewer",
  });
});

describe("ensureAutoJoin", () => {
  it("makes a matching-domain stranger a member with the workspace's access role", async () => {
    const member = await ensureAutoJoin(WS, {
      id: samId,
      email: "Sam@Acme.com",
    });
    expect(member).toMatchObject({ userId: samId, role: "viewer" });
    expect((await workspaceRepo.listMembers(WS)).length).toBe(1);
  });

  it("is idempotent and never touches an existing membership", async () => {
    await ensureTestMember(pg.db, {
      workspaceId: WS,
      userId: "u-lead",
      role: "admin",
    });
    const member = await ensureAutoJoin(WS, {
      id: "u-lead",
      email: "lead@acme.com",
    });
    expect(member?.role).toBe("admin");
    await ensureAutoJoin(WS, { id: samId, email: "sam@acme.com" });
    await ensureAutoJoin(WS, { id: samId, email: "sam@acme.com" });
    expect((await workspaceRepo.listMembers(WS)).length).toBe(2);
  });

  it("refuses other domains, sub-domains, and a workspace with no auto-join", async () => {
    expect(
      await ensureAutoJoin(WS, { id: "u-x", email: "x@gmail.com" }),
    ).toBeNull();
    expect(
      await ensureAutoJoin(WS, {
        id: "u-y",
        email: "y@evil.acme.com",
      }),
    ).toBeNull();
    await workspaceRepo.setAutoJoin(WS, null);
    expect(
      await ensureAutoJoin(WS, { id: "u-z", email: "z@acme.com" }),
    ).toBeNull();
    expect((await workspaceRepo.listMembers(WS)).length).toBe(0);
  });

  it("never grants more than member, whatever the stored role says", async () => {
    // Seed the out-of-contract stored value without normalizing the role.
    await pg.db
      .update(workspaces)
      .set({
        settingsAutoJoin: sql`'{"domains":["acme.com"],"role":"admin"}'::jsonb`,
      })
      .where(eq(workspaces.id, workspaceUuid));
    const member = await ensureAutoJoin(WS, {
      id: samId,
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
