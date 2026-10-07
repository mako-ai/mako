/**
 * Graceful rename of FLOWS — the "impossible" scenarios (mako-ai/mako#1037).
 *
 * Hostile names (titles and slugs, through the UI route and the service the
 * agent and MCP reach), partial failures between the commit and the row,
 * races (two renames, a save, a laptop push, a delete, a running sync, two
 * instances), cycles and chains, and scale with measured times. Same rig and
 * the same invariants as flow-rename.scenarios.test.ts: the stream keeps its
 * id, checkpoints, history, webhook URL and secret; never a teardown, never
 * a second stream into one destination.
 */
import path from "node:path";
import fs from "node:fs/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
});

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
const mirror = vi.hoisted(() => ({
  main: null as string | null,
  pushFails: false,
}));
// A hook on the freshen that precedes every main commit: a test lands a
// competing change in the window between a writer reading and committing.
const freshenHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("../../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/cloud-repo.service")>();
  return {
    ...actual,
    assertTreeAtMirrorMain: async (workspaceId: string, sha: string) => {
      if (mirror.main === null) {
        return actual.assertTreeAtMirrorMain(workspaceId, sha);
      }
      if (sha !== mirror.main) {
        throw new actual.TreeNotVerifiedError(
          `read at ${sha.slice(0, 8)}, mirror main is ${mirror.main.slice(0, 8)}`,
        );
      }
    },
    freshenBeforeMainWrite: async (workspaceId: string) => {
      await actual.freshenBeforeMainWrite(workspaceId);
      const fn = freshenHook.fn;
      freshenHook.fn = null;
      if (fn) await fn();
    },
    mirrorPushNow: async (workspaceId: string) => {
      if (mirror.pushFails) throw new Error("mirror push rejected");
      return actual.mirrorPushNow(workspaceId);
    },
  };
});
// The git commit itself can be made to fail once (`commitHook.fail`).
const commitHook = vi.hoisted(() => ({ fail: false }));
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      if (commitHook.fail) {
        commitHook.fail = false;
        throw new Error("git commit failed (disk full)");
      }
      return actual.commitBlobsOnBranch(...args);
    },
  };
});
const reconcileHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("../../sync-cdc/flow-reconcile", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../sync-cdc/flow-reconcile")>();
  return {
    ...actual,
    reconcileFlowsFromRepo: async (
      input: Parameters<typeof actual.reconcileFlowsFromRepo>[0],
    ) => {
      const fn = reconcileHook.fn;
      reconcileHook.fn = null;
      if (fn) await fn();
      return actual.reconcileFlowsFromRepo(input);
    },
  };
});
const inngestSent = vi.hoisted(() => [] as Array<{ name: string }>);
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(async (event: { name: string }) => {
      inngestSent.push(event);
    }),
    createFunction: vi.fn(() => ({})),
  },
}));
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  user: undefined as { id: string } | undefined,
}));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    if (auth.user) c.set("user", auth.user);
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "owner" })),
    hasRole: vi.fn(async () => true),
  },
}));

import { Hono } from "hono";
import {
  CdcEntityState,
  Flow,
  FlowExecution,
  WebhookEvent,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  ensureFlowDerivedCache,
  loadLiveFlowById,
  loadLiveFlows,
  resetFreshenOnMissThrottle,
  resolveLiveFlowRow,
  syncFlowsFromRepo,
} from "../../services/flow-sync.service";
import {
  flowRenameTarget,
  flowToFile,
  parseFlowFile,
} from "../../services/flow-config-files";
import { commitFlowFile } from "../../services/flow-config.service";
import { objectRoutes } from "../../routes/objects";
import { flowRoutes } from "../../routes/flows";
import { renameObject } from "../registry";
import { resolveFlowRef } from "../flow-rename";
import { RenameError } from "../types";
import {
  HOSTILE_SLUGS,
  HOSTILE_TITLES,
  Laptop,
  ODD_BUT_VALID_SLUGS,
  becomeStaleInstance,
  commitCountOf,
  fastImportHistory,
  fileAtMain,
  headOf,
  pathsAtMain,
  recordTiming,
  resetMainTo,
  timed,
  tmpRootFor,
} from "./scenario-rig";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: string;
const OWNER = new Types.ObjectId().toString();
const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();

function flowYaml(name: string, tag: string, extra = ""): string {
  return [
    `name: ${name}`,
    "type: webhook",
    "source:",
    "  type: connector",
    `  connector_id: ${CONNECTOR}`,
    "destination:",
    `  connection_id: ${DEST}`,
    "  table:",
    `    schema: raw_${tag}`,
    "    create_if_not_exists: true",
    "backfill_schedule:",
    "  cron: 0 3 * * *",
    "  timezone: UTC",
    "webhook:",
    "  enabled: true",
    "sync:",
    "  mode: incremental",
    "  write_mode: append_dedup",
    "  engine: cdc",
    "entities:",
    "  layouts:",
    "    - entity: leads",
    "      partitionField: _syncedAt",
    "      partitionGranularity: day",
    "      enabled: true",
    extra,
    "",
  ].join("\n");
}

async function push(
  writes: Record<string, string>,
  deletes: string[] = [],
): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message: "laptop push" },
  );
}

const LAST_RUN = new Date("2026-09-30T03:00:00.000Z");

async function seedFlow(slug: string, name: string, tag = slug) {
  await push({ [`flows/${slug}.yml`]: flowYaml(name, tag) });
  await syncFlowsFromRepo(WS, OWNER);
  const row = await Flow.findOne({ workspaceId: WS, slug });
  expect(row, `seeded ${slug}`).not.toBeNull();
  const flowId = row!._id;
  const workspaceId = new Types.ObjectId(WS);
  await CdcEntityState.create({
    workspaceId,
    flowId,
    entity: "leads",
    mode: "steady",
    lastIngestSeq: 42,
    lastMaterializedSeq: 42,
    backlogCount: 0,
    lifetimeEventsProcessed: 1,
    lifetimeRowsApplied: 1,
    mergeIntervalSeconds: 30,
    consecutiveFailures: 0,
  });
  await FlowExecution.create({
    workspaceId,
    flowId,
    startedAt: new Date(),
    status: "completed",
    success: true,
  });
  await WebhookEvent.create({
    workspaceId,
    flowId,
    eventId: `evt_${slug}`,
    eventType: "lead.created",
    status: "completed",
    rawPayload: { id: 1 },
    applyStatus: "applied",
  });
  await Flow.updateOne(
    { _id: flowId },
    {
      $set: {
        "webhookConfig.secret": "whsec_scenario",
        "backfillSchedule.lastRunAt": LAST_RUN,
      },
    },
  );
  return (await Flow.findById(flowId))!;
}

async function streamState(id: Types.ObjectId | string) {
  const row = await Flow.findById(id).lean();
  expect(row, `flow ${String(id)} still exists`).not.toBeNull();
  const flowId = new Types.ObjectId(String(id));
  return {
    id: String(row!._id),
    slug: row!.slug,
    name: row!.name,
    aliases: row!.aliases ?? [],
    endpoint: row!.webhookConfig?.endpoint,
    secret: row!.webhookConfig?.secret,
    backfillLastRunAt: row!.backfillSchedule?.lastRunAt?.toISOString(),
    runtime: await Promise.all([
      CdcEntityState.countDocuments({ flowId }),
      FlowExecution.countDocuments({ flowId }),
      WebhookEvent.countDocuments({ flowId }),
    ]),
  };
}
type StreamState = Awaited<ReturnType<typeof streamState>>;

function webhookPath(endpoint: string | undefined): string | undefined {
  return endpoint === undefined
    ? undefined
    : new URL(endpoint, "http://host.invalid").pathname;
}

async function expectSameStream(before: StreamState): Promise<StreamState> {
  const after = await streamState(before.id);
  expect(after.id).toBe(before.id);
  expect(after.runtime).toEqual(before.runtime);
  // The inbound identity is the path (/api/webhooks/<ws>/<flow id>); the
  // host is the deployment's, and GET/PUT re-derive it from the request.
  expect(webhookPath(after.endpoint)).toBe(webhookPath(before.endpoint));
  expect(after.secret).toBe(before.secret);
  expect(after.backfillLastRunAt).toBe(before.backfillLastRunAt);
  return after;
}

async function expectNoTeardownNoDuplicate(): Promise<void> {
  expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  const rows = await Flow.find({ workspaceId: WS });
  const targets = rows.map(row => flowRenameTarget(flowToFile(row)));
  expect(new Set(targets).size, `targets ${targets.join(" | ")}`).toBe(
    targets.length,
  );
}

const ctx = () => ({ workspaceId: WS, userId: OWNER, role: "owner" });

const objectsApp = new Hono();
objectsApp.route("/api/workspaces/:workspaceId/objects", objectRoutes);
const flowsApp = new Hono();
flowsApp.route("/api/workspaces/:workspaceId/flows", flowRoutes);

async function restRename(body: Record<string, unknown>) {
  auth.user = { id: OWNER };
  const res = await objectsApp.request(
    `/api/workspaces/${WS}/objects/flow/rename`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** The service as the agent tool and MCP reach it (registry + handler). */
async function serviceRename(request: {
  ref: string;
  title?: string;
  slug?: string;
}): Promise<{ ok: boolean; status?: number; message?: string }> {
  try {
    await renameObject(ctx(), "flow", request);
    return { ok: true };
  } catch (error) {
    if (error instanceof RenameError) {
      return { ok: false, status: error.status, message: error.message };
    }
    return {
      ok: false,
      status: 500,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

beforeAll(async () => {
  tmpRoot = await tmpRootFor("flow-rename-hostile");
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Flow.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  inngestSent.length = 0;
  mirror.main = null;
  mirror.pushFails = false;
  freshenHook.fn = null;
  reconcileHook.fn = null;
  commitHook.fail = false;
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_GITHUB_REMOTE_BASE;
  resetFreshenOnMissThrottle();
  vi.restoreAllMocks();
  await Promise.all([
    Flow.deleteMany({}),
    CdcEntityState.deleteMany({}),
    FlowExecution.deleteMany({}),
    WebhookEvent.deleteMany({}),
  ]);
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

// ---- hostile names ---------------------------------------------------------

describe("hostile titles", () => {
  it("every hostile title is a clear 400 or a safe normalization — never a 500, never a commit it should not make", async () => {
    const row = await seedFlow("target", "Target");
    const before = await streamState(row._id);
    const failures: string[] = [];
    for (const [label, title, expected] of HOSTILE_TITLES) {
      for (const via of ["rest", "service"] as const) {
        const commits = await commitCountOf(WS);
        const nameBefore = (await Flow.findById(row._id))!.name;
        const out =
          via === "rest"
            ? await restRename({ ref: "target", title })
            : await serviceRename({ ref: "target", title });
        const status =
          "json" in out ? (out as { status: number }).status : out.status;
        const ok = "json" in out ? status === 200 : (out as { ok: boolean }).ok;
        const where = `${via} / ${label}`;
        if (expected === "refused") {
          if (ok) failures.push(`${where}: accepted`);
          else if (status !== 400) {
            failures.push(
              `${where}: status ${status} (${JSON.stringify("json" in out ? (out as { json: unknown }).json : out)})`,
            );
          }
          if ((await commitCountOf(WS)) !== commits) {
            failures.push(`${where}: committed`);
          }
          if ((await Flow.findById(row._id))!.name !== nameBefore) {
            failures.push(`${where}: row name changed`);
          }
        } else {
          if (!ok) {
            failures.push(
              `${where}: refused ${status} ${JSON.stringify("json" in out ? (out as { json: unknown }).json : out)}`,
            );
            continue;
          }
          const stored = (await Flow.findById(row._id))!.name;
          if (stored !== expected) {
            failures.push(`${where}: stored ${JSON.stringify(stored)}`);
          }
          const parsed = parseFlowFile(
            (await fileAtMain(WS, "flows/target.yml")) ?? "",
          );
          if (parsed?.name !== expected) {
            failures.push(
              `${where}: file name ${JSON.stringify(parsed?.name)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // The file is still the one flow file, and the stream is whole.
    expect(await pathsAtMain(WS, "flows")).toEqual(["flows/target.yml"]);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("an NFD title on an NFC-named flow is the same name: a no-op, not an invisible commit", async () => {
    const row = await seedFlow("cafe", "Caf\u00E9 sync");
    const commits = await commitCountOf(WS);
    const out = await serviceRename({ ref: "cafe", title: "Cafe\u0301 sync" });
    expect(out.ok).toBe(true);
    expect(await commitCountOf(WS)).toBe(commits);
    expect((await Flow.findById(row._id))!.name).toBe("Caf\u00E9 sync");
  });
});

describe("hostile titles through the editor's own name field (PUT /flows/:id)", () => {
  it("the same rules as a rename: a clear 400 for what a rename refuses, NFC for what it normalizes — never a 500", async () => {
    const row = await seedFlow("target", "Target");
    const before = await streamState(row._id);
    const failures: string[] = [];
    for (const [label, title, rule] of HOSTILE_TITLES) {
      if (!title.trim()) continue; // the editor ignores an empty name
      // The editor has always cut a long name at 200 characters rather
      // than refusing it: a safe normalization, kept.
      const expected = /^\d+ chars$/.test(label) ? "x".repeat(200) : rule;
      const commits = await commitCountOf(WS);
      auth.user = { id: OWNER };
      const res = await flowsApp.request(
        `/api/workspaces/${WS}/flows/${row._id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: title }),
        },
      );
      const body = (await res.json()) as { error?: string };
      const stored = (await Flow.findById(row._id))!.name;
      if (expected === "refused") {
        if (res.status !== 400) {
          failures.push(`${label}: ${res.status} ${body.error ?? ""}`);
        }
        if ((await commitCountOf(WS)) !== commits) {
          failures.push(`${label}: committed`);
        }
      } else if (res.status !== 200) {
        failures.push(`${label}: refused ${res.status} ${body.error ?? ""}`);
      } else if (stored !== expected) {
        failures.push(`${label}: stored ${JSON.stringify(stored)}`);
      }
    }
    expect(failures).toEqual([]);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });
});

describe("hostile slugs", () => {
  it("every hostile slug is refused with a 400 (never a 500, never a path outside flows/, never a commit)", async () => {
    const row = await seedFlow("target", "Target");
    const before = await streamState(row._id);
    const failures: string[] = [];
    for (const [label, slug] of HOSTILE_SLUGS) {
      for (const via of ["rest", "service"] as const) {
        const commits = await commitCountOf(WS);
        const out =
          via === "rest"
            ? await restRename({ ref: "target", slug })
            : await serviceRename({ ref: "target", slug });
        const status =
          "json" in out ? (out as { status: number }).status : out.status;
        if (status !== 400) {
          failures.push(
            `${via} / ${label}: ${status} ${JSON.stringify("json" in out ? (out as { json: unknown }).json : out)}`,
          );
        }
        if ((await commitCountOf(WS)) !== commits) {
          failures.push(`${via} / ${label}: committed`);
        }
      }
    }
    expect(failures).toEqual([]);
    const allPaths = await pathsAtMain(WS, "");
    expect(allPaths.filter(p => p !== "README.md")).toEqual([
      "flows/target.yml",
    ]);
    expect(await expectSameStream(before)).toMatchObject({ slug: "target" });
    await expectNoTeardownNoDuplicate();
  });

  it("odd but legitimate slugs (folder-root words, 64 chars, near-reserved names) are accepted, inside flows/", async () => {
    const row = await seedFlow("target", "Target");
    const before = await streamState(row._id);
    let current = "target";
    for (const slug of ODD_BUT_VALID_SLUGS) {
      const out = await serviceRename({ ref: current, slug });
      expect(out, slug).toMatchObject({ ok: true });
      current = slug;
      expect(await pathsAtMain(WS, "flows")).toEqual([`flows/${slug}.yml`]);
    }
    const after = await expectSameStream(before);
    expect(after.slug).toBe(current);
    expect(after.aliases).toEqual([
      "target",
      ...ODD_BUT_VALID_SLUGS.slice(0, -1),
    ]);
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("hostile refs never throw from resolve and never resolve to anything", async () => {
    await seedFlow("target", "Target");
    for (const [label, ref] of [
      ...HOSTILE_SLUGS,
      ["10000 chars", "a".repeat(10000)],
    ] as const) {
      const resolved = await resolveFlowRef({ workspaceId: WS }, ref);
      expect(resolved, label).toBeNull();
    }
  });

  it("a file pushed under a Windows-reserved or id-like name is not given that name by a rename, and creation never mints one", async () => {
    const { reserveFlowSlug } = await import(
      "../../services/flow-identity.service"
    );
    for (const name of ["CON", "aux", "Nul", "COM1", "lpt9", "prn"]) {
      const slug = await reserveFlowSlug(WS, name);
      expect(slug, name).not.toBe(name.toLowerCase());
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(await reserveFlowSlug(WS, "0123456789abcdef01234567")).not.toBe(
      "0123456789abcdef01234567",
    );
  });
});

// ---- partial failures ------------------------------------------------------

describe("partial failure between the commit and the row", () => {
  it("git commit succeeds, the Mongo update throws: the caller is told, and the next READ and the next sync converge (same id, no teardown, no duplicate)", async () => {
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const spy = vi.spyOn(Flow, "updateOne").mockImplementationOnce((() => {
      throw new Error("mongo write failed");
    }) as never);
    const out = await serviceRename({ ref: "a", slug: "b" });
    spy.mockRestore();
    // The rename DID happen (the file is the store): the answer says so.
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/mongo write failed/);
    expect(await pathsAtMain(WS, "flows")).toEqual([
      "flows/b.yml",
      "flows/keeper.yml",
    ]);
    // A read before any push sync already finds the flow under its new
    // name, by its own id — no git-only stand-in with another id.
    const listed = await loadLiveFlows(WS);
    expect(listed.map(l => [l.def.slug, String(l.id)])).toContainEqual([
      "b",
      before.id,
    ]);
    expect((await loadLiveFlowById(WS, before.id))?.def.slug).toBe("b");
    expect((await resolveLiveFlowRow(WS, before.id)).ok).toBe(true);
    // The push sync the mirror push triggers settles the rest.
    const result = await syncFlowsFromRepo(WS, OWNER);
    expect(result.created).toBe(0);
    const after = await expectSameStream(before);
    expect(after).toMatchObject({ slug: "b", aliases: ["a"] });
    expect(await resolveFlowRef({ workspaceId: WS }, "a")).toMatchObject({
      id: before.id,
    });
    await expectNoTeardownNoDuplicate();
  });

  it("process crash after the commit, before the row update: the run path (another instance, a restart) re-keys instead of refusing forever", async () => {
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const spy = vi.spyOn(Flow, "updateOne").mockImplementationOnce((() => {
      throw new Error("process killed");
    }) as never);
    await serviceRename({ ref: "a", slug: "b" });
    spy.mockRestore();
    resetFreshenOnMissThrottle();
    // A scheduled run fires on a fresh process: it judges its row.
    const stale = (await Flow.findById(row._id))!;
    expect(stale.slug).toBe("a");
    expect(await ensureFlowDerivedCache(stale)).not.toBe("missing");
    const after = await expectSameStream(before);
    expect(after.slug).toBe("b");
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("the git commit throws: nothing changes (row, file, aliases)", async () => {
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const commits = await commitCountOf(WS);
    commitHook.fail = true;
    const out = await serviceRename({ ref: "a", title: "A2", slug: "b" });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/git commit failed/);
    expect(await commitCountOf(WS)).toBe(commits);
    expect(await pathsAtMain(WS, "flows")).toEqual(["flows/a.yml"]);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "a",
      name: "A",
      aliases: [],
    });
    const fresh = await Flow.findById(row._id).lean();
    expect(fresh?.lastRenameCommit).toBeUndefined();
    await expectNoTeardownNoDuplicate();
  });

  it("the mirror push fails: the rename stands (guarded), another instance on the old mirror main keeps the row, and it settles when the push lands", async () => {
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const pre = await headOf(WS);
    mirror.pushFails = true;
    const out = await serviceRename({ ref: "a", slug: "b" });
    expect(out.ok).toBe(true);
    const renamedAt = await headOf(WS);
    // The mirror still has `pre`; this instance's main is ahead.
    mirror.main = pre;
    await syncFlowsFromRepo(WS, OWNER);
    expect((await Flow.findById(row._id))?.lastRenameCommit).toBe(renamedAt);
    // Another instance: its main IS the mirror's (`pre`).
    await resetMainTo(WS, pre);
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const other = await syncFlowsFromRepo(WS, OWNER);
    expect(other.created).toBe(0);
    expect(other.deferred).toEqual([]);
    expect(await expectSameStream(before)).toMatchObject({ slug: "b" });
    // The push lands.
    await resetMainTo(WS, renamedAt);
    mirror.main = renamedAt;
    await syncFlowsFromRepo(WS, OWNER);
    expect((await Flow.findById(row._id))?.lastRenameCommit).toBeUndefined();
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });
});

// ---- concurrency -----------------------------------------------------------

describe("concurrency", () => {
  it("two renames of the same flow at once: exactly one wins; one file; aliases right; one stream", async () => {
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const outs = await Promise.all([
      serviceRename({ ref: "a", slug: "b" }),
      serviceRename({ ref: "a", slug: "c" }),
    ]);
    expect(outs.filter(o => o.ok)).toHaveLength(1);
    const loser = outs.find(o => !o.ok)!;
    expect(loser.status).toBe(409);
    const winner = outs[0].ok ? "b" : "c";
    expect(await pathsAtMain(WS, "flows")).toEqual([`flows/${winner}.yml`]);
    expect(await expectSameStream(before)).toMatchObject({
      slug: winner,
      aliases: ["a"],
    });
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("two flows renamed onto the same new slug at once: one wins, the other is refused, both streams intact", async () => {
    const x = await seedFlow("x", "X");
    const y = await seedFlow("y", "Y");
    const bx = await streamState(x._id);
    const by = await streamState(y._id);
    const outs = await Promise.all([
      serviceRename({ ref: "x", slug: "n" }),
      serviceRename({ ref: "y", slug: "n" }),
    ]);
    expect(outs.filter(o => o.ok)).toHaveLength(1);
    expect(outs.find(o => !o.ok)?.status).toBe(409);
    const files = await pathsAtMain(WS, "flows");
    expect(files).toHaveLength(2);
    expect(files).toContain("flows/n.yml");
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(bx);
    await expectSameStream(by);
    await expectNoTeardownNoDuplicate();
  });

  it("a rename racing a save: never two files; whichever loses says reload", async () => {
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const inFlight = (await Flow.findById(row._id))!;
    inFlight.backfillSchedule!.cron = "0 6 * * *";
    const [renamed, saved] = await Promise.all([
      serviceRename({ ref: "a", slug: "b" }),
      commitFlowFile(inFlight, OWNER),
    ]);
    // Never both refused; never two files; a loser says "reload".
    expect(renamed.ok || saved.ok).toBe(true);
    const files = await pathsAtMain(WS, "flows");
    expect(files).toHaveLength(1);
    if (!saved.ok) expect(saved.conflict).toBe(true);
    if (!renamed.ok) expect(renamed.status).toBe(409);
    // Both landed (the save first, the rename read after it): the moved
    // file carries the edit.
    if (renamed.ok && saved.ok) {
      expect(await fileAtMain(WS, files[0])).toContain("cron: 0 6 * * *");
    }
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("a laptop push landing inside the rename's window: the rename is refused (CAS), the laptop's edit stands", async () => {
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    freshenHook.fn = async () => {
      freshenHook.fn = async () => {
        await push({
          "flows/a.yml": flowYaml("A", "a").replace(
            "cron: 0 3 * * *",
            "cron: 0 7 * * *",
          ),
        });
      };
    };
    const out = await serviceRename({ ref: "a", slug: "b" });
    expect(out.status).toBe(409);
    expect(out.message).toMatch(/changed while renaming/);
    expect(await pathsAtMain(WS, "flows")).toEqual(["flows/a.yml"]);
    await syncFlowsFromRepo(WS, OWNER);
    const after = await expectSameStream(before);
    expect(after.slug).toBe("a");
    expect((await Flow.findById(row._id))?.backfillSchedule?.cron).toBe(
      "0 7 * * *",
    );
    await expectNoTeardownNoDuplicate();
  });

  it("a rename racing a DELETE (the rename lands while the delete is in flight): the deleted flow never comes back as a new stream", async () => {
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("doomed", "Doomed");
    // The delete route read the row (slug `doomed`); the rename lands in
    // the freshen before the delete's commit.
    freshenHook.fn = async () => {
      await renameObject(ctx(), "flow", { ref: "doomed", slug: "moved" });
    };
    auth.user = { id: OWNER };
    const res = await flowsApp.request(
      `/api/workspaces/${WS}/flows/${row._id}`,
      { method: "DELETE" },
    );
    expect([200, 409]).toContain(res.status);
    await syncFlowsFromRepo(WS, OWNER);
    const slugs = (await Flow.find({ workspaceId: WS })).map(r => r.slug);
    if (res.status === 200) {
      // Deleted means deleted: no file left behind, no flow recreated.
      expect(await pathsAtMain(WS, "flows")).toEqual(["flows/keeper.yml"]);
      expect(slugs).toEqual(["keeper"]);
    } else {
      // Refused: the flow is intact under its new name.
      expect(slugs.sort()).toEqual(["keeper", "moved"]);
      expect(
        String((await Flow.findOne({ workspaceId: WS, slug: "moved" }))?._id),
      ).toBe(String(row._id));
    }
  });

  it("a rename landing while a push sync runs is neither undone nor torn down", async () => {
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("nightly", "Nightly");
    const before = await streamState(row._id);
    await push({ "flows/nightly.yml": flowYaml("Nightly v2", "nightly") });
    reconcileHook.fn = async () => {
      await renameObject(ctx(), "flow", { ref: "nightly", slug: "nightly-2" });
    };
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const result = await syncFlowsFromRepo(WS, OWNER);
    expect(result.deferred).toEqual([]);
    expect(await expectSameStream(before)).toMatchObject({ slug: "nightly-2" });
    delete process.env.APPS_CONNECTED_REPO_PUSH;
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("two instances with different local mains: the stale one keeps the row, serves it, runs it, and converges", async () => {
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const pre = await headOf(WS);
    const out = await serviceRename({ ref: "a", slug: "b" });
    expect(out.ok).toBe(true);
    const renamedAt = await headOf(WS);
    // Instance B: main at the mirror's `pre`, the rename's objects unknown.
    await becomeStaleInstance(WS, pre);
    mirror.main = pre;
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const stale = await syncFlowsFromRepo(WS, OWNER);
    expect(stale.created).toBe(0);
    expect(stale.deferred).toEqual([]);
    expect(await expectSameStream(before)).toMatchObject({ slug: "b" });
    expect((await loadLiveFlowById(WS, before.id))?.row?._id.toString()).toBe(
      before.id,
    );
    expect(
      (await loadLiveFlows(WS)).filter(l => String(l.id) === before.id),
    ).toHaveLength(1);
    // B catches up once the mirror has the rename (here: the same move
    // arriving on B's main as a fetched commit).
    expect(renamedAt).not.toBe(pre);
    await push({ "flows/b.yml": flowYaml("A", "a", "aliases: [a]") }, [
      "flows/a.yml",
    ]);
    mirror.main = await headOf(WS);
    const caughtUp = await syncFlowsFromRepo(WS, OWNER);
    expect(caughtUp.created).toBe(0);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "b",
      aliases: ["a"],
    });
    await expectNoTeardownNoDuplicate();
  });
});

// ---- cycles and chains -----------------------------------------------------

describe("cycles and chains", () => {
  it("a→b→a→b: one stream, the alias list never holds the current slug or a duplicate", async () => {
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    for (const [ref, slug] of [
      ["a", "b"],
      ["b", "a"],
      ["a", "b"],
    ]) {
      expect((await serviceRename({ ref, slug })).ok, `${ref}→${slug}`).toBe(
        true,
      );
    }
    const after = await expectSameStream(before);
    expect(after.slug).toBe("b");
    expect(after.aliases).toEqual(["a"]);
    expect(
      parseFlowFile((await fileAtMain(WS, "flows/b.yml")) ?? "")?.aliases,
    ).toEqual(["a"]);
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
  });

  it("a→b then c→a through the service: refused (a is still b's old name) — an old link never silently changes owner", async () => {
    const x = await seedFlow("a", "A");
    await seedFlow("c", "C");
    expect((await serviceRename({ ref: "a", slug: "b" })).ok).toBe(true);
    const out = await serviceRename({ ref: "c", slug: "a" });
    expect(out.status).toBe(409);
    expect(await resolveFlowRef({ workspaceId: WS }, "a")).toMatchObject({
      id: String(x._id),
      via: "alias",
    });
  });

  it("a long chain (30 renames): every old name resolves to the one flow; the time stays bounded", async () => {
    const row = await seedFlow("n0", "N");
    const before = await streamState(row._id);
    const { ms } = await timed(async () => {
      for (let i = 1; i <= 30; i++) {
        const out = await serviceRename({ ref: `n${i - 1}`, slug: `n${i}` });
        expect(out.ok, `n${i}`).toBe(true);
      }
    });
    recordTiming("flow: 30 chained renames (service, one commit each)", ms);
    const after = await expectSameStream(before);
    expect(after.aliases).toHaveLength(30);
    const resolveAll = await timed(async () => {
      for (let i = 0; i <= 30; i++) {
        expect(
          (await resolveFlowRef({ workspaceId: WS }, `n${i}`))?.id,
          `n${i}`,
        ).toBe(before.id);
      }
    });
    recordTiming("flow: resolve 31 names of a 30-alias chain", resolveAll.ms);
    expect(resolveAll.ms).toBeLessThan(10_000);
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  }, 300_000);

  it("an alias equal to the flow's own current slug is never recorded as one", async () => {
    await push({ "flows/a.yml": flowYaml("A", "a", "aliases: [a, legacy]") });
    await syncFlowsFromRepo(WS, OWNER);
    const row = await Flow.findOne({ workspaceId: WS, slug: "a" });
    expect(row?.aliases).toEqual(["legacy"]);
    expect((await serviceRename({ ref: "a", slug: "b" })).ok).toBe(true);
    const after = await Flow.findById(row!._id);
    expect(after?.aliases?.sort()).toEqual(["a", "legacy"]);
    expect(await resolveFlowRef({ workspaceId: WS }, "a")).toMatchObject({
      id: String(row!._id),
      via: "alias",
    });
  });
});

// ---- scale -----------------------------------------------------------------

describe("scale (measured)", () => {
  it("1,000 flows at main: resolve (current, alias-only-in-a-file, missing), a rename and the push sync after a laptop move stay bounded", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      files[`flows/f${i}.yml`] = flowYaml(`F${i}`, `f${i}`);
    }
    await push(files);
    const firstSync = await timed(() => syncFlowsFromRepo(WS, OWNER));
    recordTiming("flow: first push sync creating 1,000 flows", firstSync.ms);
    expect(firstSync.value.created).toBe(1000);
    const noop = await timed(() => syncFlowsFromRepo(WS, OWNER));
    recordTiming("flow: push sync of 1,000 unchanged flows", noop.ms);

    const current = await timed(() =>
      resolveFlowRef({ workspaceId: WS }, "f500"),
    );
    const missing = await timed(() =>
      resolveFlowRef({ workspaceId: WS }, "no-such-flow"),
    );
    recordTiming("flow: resolve a current slug among 1,000", current.ms);
    recordTiming(
      "flow: resolve a missing slug among 1,000 (reads every file)",
      missing.ms,
    );
    expect(missing.value).toBeNull();
    const renamed = await timed(() =>
      serviceRename({ ref: "f500", slug: "f500-renamed" }),
    );
    recordTiming("flow: rename one of 1,000", renamed.ms);
    expect(renamed.value.ok).toBe(true);
    const alias = await timed(() =>
      resolveFlowRef({ workspaceId: WS }, "f500"),
    );
    recordTiming("flow: resolve an old name among 1,000", alias.ms);
    expect(alias.value?.via).toBe("alias");

    const l = await Laptop.clone(WS, path.join(tmpRoot, "laptops"));
    await l.mv("flows/f7.yml", "flows/f7-moved.yml");
    await l.commit("move one");
    expect((await l.push()).ok).toBe(true);
    const moved = await timed(() => syncFlowsFromRepo(WS, OWNER));
    recordTiming("flow: push sync of a laptop move among 1,000", moved.ms);
    expect(moved.value.created).toBe(0);
    for (const ms of [current.ms, missing.ms, renamed.ms, alias.ms, moved.ms]) {
      expect(ms).toBeLessThan(30_000);
    }
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  }, 600_000);

  it("5,000 commits of history: rename, laptop move, settle and resolve stay bounded", async () => {
    await fastImportHistory(WS, {
      count: 5000,
      files: { "flows/deep.yml": flowYaml("Deep", "deep") },
    });
    await push({ "flows/keeper.yml": flowYaml("Keeper", "keeper") });
    await syncFlowsFromRepo(WS, OWNER);
    const row = await Flow.findOne({ workspaceId: WS, slug: "deep" });
    expect(row).not.toBeNull();
    const renamed = await timed(() =>
      serviceRename({ ref: "deep", slug: "deep-2" }),
    );
    recordTiming("flow: rename with 5,000 commits of history", renamed.ms);
    expect(renamed.value.ok).toBe(true);
    const synced = await timed(() => syncFlowsFromRepo(WS, OWNER));
    recordTiming(
      "flow: push sync (guard settle) with 5,000 commits",
      synced.ms,
    );
    const l = await Laptop.clone(WS, path.join(tmpRoot, "laptops"));
    await l.mv("flows/deep-2.yml", "flows/deep-3.yml");
    await l.commit("move");
    expect((await l.push()).ok).toBe(true);
    const moved = await timed(() => syncFlowsFromRepo(WS, OWNER));
    recordTiming(
      "flow: push sync of a laptop move with 5,000 commits",
      moved.ms,
    );
    expect((await Flow.findById(row!._id))?.slug).toBe("deep-3");
    for (const ms of [renamed.ms, synced.ms, moved.ms]) {
      expect(ms).toBeLessThan(30_000);
    }
  }, 600_000);
});
