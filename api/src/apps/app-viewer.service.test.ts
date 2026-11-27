/**
 * Who an app is talking to (apps.md §28): the platform reports identity,
 * workspace access role and the person's role on the app — and nothing
 * about what they do for a living.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateObjectIdHex,
  legacyUserIdToUuidv7,
} from "../database/pg/id-codec";
import type { IAppProject } from "../database/workspace-schema";
import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../repositories/apps-metadata";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
import {
  resolveAppViewer,
  resolveAppViewerByEmail,
} from "./app-viewer.service";

let pg: PgTestDb;
const WS = generateObjectIdHex();
const OWNER = { id: legacyUserIdToUuidv7("u-owner"), email: "owner@acme.com" };
const ADMIN = { id: legacyUserIdToUuidv7("u-admin"), email: "admin@acme.com" };
const VIEWER = { id: legacyUserIdToUuidv7("u-viewer"), email: "Sam@Acme.com" };
const OUTSIDER = {
  id: legacyUserIdToUuidv7("u-out"),
  email: "out@elsewhere.com",
};
let sharedApp: IAppProject;
let privateApp: IAppProject;

beforeAll(async () => {
  pg = await setupPgTestDb();
  await ensureTestWorkspace(pg.db, { id: WS, name: "Acme", slug: "acme" });
  await ensureTestUser(pg.db, VIEWER);
  await ensureTestMember(pg.db, {
    workspaceId: WS,
    userId: OWNER.id,
    role: "owner",
  });
  await ensureTestMember(pg.db, {
    workspaceId: WS,
    userId: ADMIN.id,
    role: "admin",
  });
  await ensureTestMember(pg.db, {
    workspaceId: WS,
    userId: VIEWER.id,
    role: "viewer",
  });
  sharedApp = toAppProjectCompat(
    await appsMetadataRepo.createProject({
      workspaceId: WS,
      title: "Sales",
      slug: "sales",
      access: "workspace",
      workspaceRole: "editor",
      createdBy: OWNER.id,
      owner_id: OWNER.id,
    }),
  );
  privateApp = toAppProjectCompat(
    await appsMetadataRepo.createProject({
      workspaceId: WS,
      title: "Secret",
      slug: "secret",
      access: "private",
      createdBy: ADMIN.id,
      owner_id: ADMIN.id,
      sharedWith: [{ userId: VIEWER.id, role: "viewer", addedAt: new Date() }],
    }),
  );
});

afterAll(() => pg?.close());

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
      workspace: { id: WS, name: "Acme", role: "viewer" },
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
