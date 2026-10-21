/**
 * A dev build of an app that is not on main yet. What these pin:
 *
 *   - a new folder (slug) or a new manifest id gets a draft-only project,
 *     keyed by the id the index will give it once pushed;
 *   - anything that could name a REAL app is refused (the route then answers
 *     its old 404): an index hit, an ambiguous slug, a project row, an id in
 *     use in another workspace;
 *   - the project is private to the caller, and who may build is the
 *     workspace role (viewers read, members build, non-members nothing);
 *   - a dev build against it is always a draft: no committed read, no
 *     materialize, and a viewer is refused with a message that fits.
 *
 * Pure: the index and row lookups are injected.
 */
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { derivedAppId } from "./app-paths";
import { bindingFromSource, type AppBinding } from "./bindings.service";
import {
  unregisteredDraftAccess,
  unregisteredDraftIdentity,
  unregisteredDraftProject,
  type UnregisteredDraftDeps,
} from "./unregistered-draft-app";
import {
  DevBuildError,
  planDevBuild,
  type DevBuildDeps,
} from "./binding-dev-build";
import { canReadResource, canWriteResource } from "../utils/resource-acl";

const WS = new Types.ObjectId().toString();
const nothingKnown = (): UnregisteredDraftDeps => ({
  indexKnows: vi.fn(async () => false),
  taken: vi.fn(async () => false),
});

describe("unregisteredDraftIdentity", () => {
  it("derives the id the index will give the pushed folder", () => {
    expect(unregisteredDraftIdentity(WS, "new-sales-cash-forecast")).toEqual({
      appId: derivedAppId(WS, "new-sales-cash-forecast").toString(),
      path: "apps/new-sales-cash-forecast",
      slug: "new-sales-cash-forecast",
    });
    // A nested path keys like the index keys it (appKeyOf drops `apps/`).
    expect(unregisteredDraftIdentity(WS, "apps/sales/forecast")).toMatchObject({
      appId: derivedAppId(WS, "sales/forecast").toString(),
      slug: "forecast",
    });
  });

  it("keeps a manifest id as the identity", () => {
    const id = new Types.ObjectId().toString();
    expect(unregisteredDraftIdentity(WS, id.toUpperCase())?.appId).toBe(id);
  });

  it("refuses what no app can be called", () => {
    for (const ref of ["", "  ", "../etc", "other/place/x", "apps/../x"]) {
      expect(unregisteredDraftIdentity(WS, ref)).toBeNull();
    }
  });
});

describe("unregisteredDraftProject", () => {
  it("is a private, caller-owned project for a ref nothing knows", async () => {
    const project = await unregisteredDraftProject(
      WS,
      "new-sales-cash-forecast",
      "u1",
      nothingKnown(),
    );
    expect(project).toMatchObject({
      slug: "new-sales-cash-forecast",
      path: "apps/new-sales-cash-forecast",
      access: "private",
      owner_id: "u1",
    });
    expect(project?._id.toString()).toBe(
      derivedAppId(WS, "new-sales-cash-forecast").toString(),
    );
    expect(project?.workspaceId.toString()).toBe(WS);
    // The usual ACL: its owner only, admins included out.
    if (!project) throw new Error("no draft project");
    expect(canWriteResource(project, "u1", "member")).toBe(true);
    expect(canReadResource(project, "u2", "admin")).toBe(false);
  });

  it("refuses a ref the index knows, or an id or name already taken", async () => {
    const known = {
      ...nothingKnown(),
      indexKnows: vi.fn(async () => true),
    };
    expect(await unregisteredDraftProject(WS, "sales", "u1", known)).toBeNull();
    const taken = { ...nothingKnown(), taken: vi.fn(async () => true) };
    const id = new Types.ObjectId().toString();
    expect(await unregisteredDraftProject(WS, id, "u1", taken)).toBeNull();
    expect(taken.taken).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ appId: id }),
    );
    expect(
      await unregisteredDraftProject(
        "not-a-workspace",
        "x",
        "u1",
        nothingKnown(),
      ),
    ).toBeNull();
  });
});

describe("unregisteredDraftAccess", () => {
  it("follows the workspace role", () => {
    expect(unregisteredDraftAccess("u1", "member")).toBe("write");
    expect(unregisteredDraftAccess("u1", "admin")).toBe("write");
    expect(unregisteredDraftAccess("u1", "viewer")).toBe("read");
    expect(unregisteredDraftAccess("u1", undefined)).toBe("none");
    // A workspace API key is the workspace's.
    expect(unregisteredDraftAccess(undefined, undefined)).toBe("write");
  });
});

describe("planDevBuild for an app not on main yet", () => {
  const CONN = new Types.ObjectId().toString();
  const SOURCE = `-- connection: ${CONN}\nselect 1 as n`;
  const connection = { type: "bigquery" } as unknown as IDatabaseConnection;

  async function draftProject() {
    const p = await unregisteredDraftProject(WS, "fresh", "u1", nothingKnown());
    if (!p) throw new Error("no draft project");
    return p;
  }

  function deps(): DevBuildDeps {
    return {
      resolveDraft: vi.fn(async (_p, name, source) => ({
        binding: bindingFromSource(name, source) as AppBinding,
        connection,
      })),
      // Even if some view of the repo had the file, it must not be read.
      committedBinding: vi.fn(
        async () => bindingFromSource("leads", SOURCE) as AppBinding,
      ),
      render: vi.fn(async (_p, binding) => ({ code: binding.code })),
      artifactExists: vi.fn(async () => true),
      materialize: vi.fn(async () => {
        throw new Error("must not materialize");
      }),
      build: vi.fn(async () => ({
        filePath: "/tmp/draft.parquet",
        rowCount: 1,
        byteSize: 10,
      })),
      drafts: {
        lookup: vi.fn(async () => ({ kind: "miss" as const })),
        built: vi.fn(async () => "apps/drafts/p/h.parquet"),
        failed: vi.fn(async () => 60_000),
        forget: vi.fn(async () => undefined),
      },
    };
  }

  it("builds the sent text as a draft, never as a committed artifact", async () => {
    const d = deps();
    const project = await draftProject();
    const plan = await planDevBuild(
      {
        project,
        name: "leads",
        actorId: "u1",
        userId: "u1",
        canWrite: true,
        source: SOURCE,
        unregistered: true,
      },
      d,
    );
    expect(plan.kind).toBe("build");
    if (plan.kind !== "build") return;
    expect(await plan.run()).toMatchObject({
      kind: "draft",
      artifactKey: "apps/drafts/p/h.parquet",
      rowCount: 1,
    });
    expect(d.committedBinding).not.toHaveBeenCalled();
    expect(d.materialize).not.toHaveBeenCalled();
    expect(d.drafts.built).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project._id.toString() }),
    );
  });

  it("refuses a viewer with a message about the workspace role", async () => {
    const error = await planDevBuild(
      {
        project: await draftProject(),
        name: "leads",
        actorId: "u1",
        userId: "u1",
        canWrite: false,
        source: SOURCE,
        unregistered: true,
      },
      deps(),
    ).catch(e => e);
    expect(error).toBeInstanceOf(DevBuildError);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/not on main yet/);
  });
});
