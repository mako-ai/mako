/**
 * Graceful rename of DBT JOBS — the "impossible" scenarios (mako-ai/mako#1037).
 *
 * Hostile names, partial failures between the commit and the row, races
 * (two renames, a save, a laptop push, a DELETE, the auto-disable after
 * repeated failures, a running sync, two instances), cycles and chains,
 * and scale with measured times. Same invariants as the matrix: the job
 * keeps its id, run history, scheduler claim and schedule; no row is swept
 * and no second job runs the same commands.
 */
import fs from "node:fs/promises";
import path from "node:path";
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

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
const mirror = vi.hoisted(() => ({
  main: null as string | null,
  pushFails: false,
}));
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
// A hook inside the sync's schedule registration: a rename lands while a
// push sync is between reading its tree and sweeping.
const scheduleHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("../../dbt/dbt-run.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../dbt/dbt-run.service")>();
  return {
    ...actual,
    applyJobScheduleChange: async (
      job: Parameters<typeof actual.applyJobScheduleChange>[0],
    ) => {
      const fn = scheduleHook.fn;
      scheduleHook.fn = null;
      if (fn) await fn();
      return actual.applyJobScheduleChange(job);
    },
  };
});
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(async () => undefined),
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
  isMcpOAuthAuth: () => false,
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
  DbtJob,
  DbtProject,
  DbtRun,
  type IDbtProject,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  DbtConfigConflictError,
  commitDbtJobFile,
  jobToFile,
  loadLiveJobById,
  loadLiveJobs,
  reserveJobSlug,
  resetJobFreshenOnMissThrottle,
  resolveLiveJobRow,
  syncDbtConfigFromRepo,
} from "../../dbt/dbt-config.service";
import {
  jobFilePath,
  jobRenameTarget,
  parseJobFile,
} from "../../dbt/dbt-config-files";
import { objectRoutes } from "../../routes/objects";
import { dbtRoutes } from "../../routes/dbt.routes";
import { renameObject } from "../registry";
import { resolveDbtJobRef } from "../dbt-job-rename";
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
let project: IDbtProject;
const OWNER = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();

function jobYaml(name: string, tag: string, extra = ""): string {
  return [
    `name: ${name}`,
    "environment: prod",
    "commands:",
    `  - build --select tag:${tag}`,
    "schedule:",
    "  cron: 0 6 * * *",
    "  timezone: Europe/Zurich",
    "enabled: true",
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

async function seedJob(slug: string, name: string, tag = slug) {
  await push({ [jobFilePath(slug)]: jobYaml(name, tag) });
  await syncDbtConfigFromRepo(WS);
  const row = await DbtJob.findOne({ projectId: project._id, slug });
  expect(row, `seeded ${slug}`).not.toBeNull();
  await DbtRun.create({
    workspaceId: new Types.ObjectId(WS),
    projectId: project._id,
    jobId: row!._id,
    environment: "prod",
    commands: [`build --select tag:${tag}`],
    status: "success",
    trigger: "schedule",
    triggeredBy: "scheduler",
  });
  await DbtJob.updateOne(
    { _id: row!._id },
    { $set: { "scheduledRun.runCount": 7 } },
  );
  return (await DbtJob.findById(row!._id))!;
}

async function jobState(id: Types.ObjectId | string) {
  const row = await DbtJob.findById(id).lean();
  expect(row, `job ${String(id)} still exists`).not.toBeNull();
  return {
    id: String(row!._id),
    slug: row!.slug,
    name: row!.name,
    aliases: row!.aliases ?? [],
    cron: row!.schedule?.cron,
    enabled: row!.enabled,
    runCount: row!.scheduledRun?.runCount,
    runs: await DbtRun.countDocuments({ jobId: row!._id }),
  };
}
type JobState = Awaited<ReturnType<typeof jobState>>;

async function expectSameJob(before: JobState): Promise<JobState> {
  const after = await jobState(before.id);
  expect(after.id).toBe(before.id);
  expect(after.runs).toBe(before.runs);
  expect(after.runCount).toBe(before.runCount);
  return after;
}

async function expectNoDuplicate(): Promise<void> {
  const rows = await DbtJob.find({ projectId: project._id });
  const targets = rows.map(row => jobRenameTarget(jobToFile(row)));
  expect(new Set(targets).size, `targets ${targets.join(" | ")}`).toBe(
    targets.length,
  );
}

const ctx = () => ({ workspaceId: WS, userId: OWNER, role: "owner" });

const app = new Hono();
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);
app.route("/api/workspaces/:workspaceId/dbt", dbtRoutes);

async function restRename(body: Record<string, unknown>) {
  auth.user = { id: OWNER };
  const res = await app.request(
    `/api/workspaces/${WS}/objects/dbt_job/rename`,
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

async function serviceRename(request: {
  ref: string;
  title?: string;
  slug?: string;
}): Promise<{
  ok: boolean;
  status?: number;
  message?: string;
  warnings?: string[];
  commit?: string;
}> {
  try {
    const result = await renameObject(ctx(), "dbt_job", request);
    return { ok: true, warnings: result.warnings, commit: result.commit };
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
  tmpRoot = await tmpRootFor("dbt-job-rename-hostile");
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await DbtJob.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  mirror.main = null;
  mirror.pushFails = false;
  freshenHook.fn = null;
  commitHook.fail = false;
  scheduleHook.fn = null;
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_GITHUB_REMOTE_BASE;
  resetJobFreshenOnMissThrottle();
  vi.restoreAllMocks();
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtJob.deleteMany({}),
    DbtRun.deleteMany({}),
  ]);
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
  project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    dbtVersion: "1.9",
    environments: [
      {
        name: "prod",
        connectionId: CONN,
        targetSchema: "dbt_prod",
        threads: 8,
      },
    ],
    defaultEnvironment: "prod",
    createdBy: OWNER,
  });
});

// ---- hostile names ---------------------------------------------------------

describe("hostile names", () => {
  it("every hostile title is a clear 400 or a safe normalization (never a 500, never a stray commit)", async () => {
    const row = await seedJob("target", "Target");
    const before = await jobState(row._id);
    const failures: string[] = [];
    for (const [label, title, expected] of HOSTILE_TITLES) {
      for (const via of ["rest", "service"] as const) {
        const commits = await commitCountOf(WS);
        const nameBefore = (await DbtJob.findById(row._id))!.name;
        let status: number;
        let detail: unknown;
        if (via === "rest") {
          const out = await restRename({ ref: "target", title });
          status = out.status;
          detail = out.json;
        } else {
          const out = await serviceRename({ ref: "target", title });
          status = out.ok ? 200 : (out.status ?? 500);
          detail = out;
        }
        const where = `${via} / ${label}`;
        if (expected === "refused") {
          if (status !== 400) {
            failures.push(`${where}: ${status} ${JSON.stringify(detail)}`);
          }
          if ((await commitCountOf(WS)) !== commits) {
            failures.push(`${where}: committed`);
          }
          if ((await DbtJob.findById(row._id))!.name !== nameBefore) {
            failures.push(`${where}: row name changed`);
          }
        } else {
          if (status !== 200) {
            failures.push(
              `${where}: refused ${status} ${JSON.stringify(detail)}`,
            );
            continue;
          }
          const stored = (await DbtJob.findById(row._id))!.name;
          if (stored !== expected) {
            failures.push(`${where}: stored ${JSON.stringify(stored)}`);
          }
          const parsed = parseJobFile(
            (await fileAtMain(WS, jobFilePath("target"))) ?? "",
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
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual(["dbt/jobs/target.yml"]);
    await expectSameJob(before);
    await expectNoDuplicate();
  });

  it("every hostile slug is refused with a 400; odd-but-valid slugs are accepted inside dbt/jobs/", async () => {
    const row = await seedJob("target", "Target");
    const before = await jobState(row._id);
    const failures: string[] = [];
    for (const [label, slug] of HOSTILE_SLUGS) {
      for (const via of ["rest", "service"] as const) {
        const commits = await commitCountOf(WS);
        let status: number;
        if (via === "rest") {
          status = (await restRename({ ref: "target", slug })).status;
        } else {
          const out = await serviceRename({ ref: "target", slug });
          status = out.ok ? 200 : (out.status ?? 500);
        }
        if (status !== 400) failures.push(`${via} / ${label}: ${status}`);
        if ((await commitCountOf(WS)) !== commits) {
          failures.push(`${via} / ${label}: committed`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect((await pathsAtMain(WS, "")).filter(p => p !== "README.md")).toEqual([
      "dbt/jobs/target.yml",
    ]);
    let current = "target";
    for (const slug of ODD_BUT_VALID_SLUGS) {
      expect(await serviceRename({ ref: current, slug }), slug).toMatchObject({
        ok: true,
      });
      current = slug;
      expect(await pathsAtMain(WS, "dbt/jobs")).toEqual([
        `dbt/jobs/${slug}.yml`,
      ]);
    }
    expect((await expectSameJob(before)).slug).toBe(current);
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(before);
    // Hostile refs: never a throw, never a match.
    for (const [label, ref] of [
      ...HOSTILE_SLUGS,
      ["10000 chars", "a".repeat(10000)],
    ] as const) {
      expect(
        await resolveDbtJobRef({ workspaceId: WS }, ref),
        label,
      ).toBeNull();
    }
    // Creation never mints a Windows device name or an id lookalike.
    for (const name of ["CON", "aux", "Nul", "COM1", "lpt9", "prn"]) {
      expect(await reserveJobSlug(project._id, name)).not.toBe(
        name.toLowerCase(),
      );
    }
  }, 300_000);

  it("the job's own name field (PATCH, create, the agent's job tools) follows the same rules — never a 500", async () => {
    const row = await seedJob("target", "Target");
    const before = await jobState(row._id);
    const { createDbtServerTools } = await import(
      "../../agent-lib/tools/dbt-tools"
    );
    const tools = createDbtServerTools(WS, OWNER, { chatId: "scenario" });
    const failures: string[] = [];
    for (const [label, title, expected] of HOSTILE_TITLES) {
      if (!title) continue; // zod refuses an empty name on every path
      const commits = await commitCountOf(WS);
      auth.user = { id: OWNER };
      const patch = await app.request(
        `/api/workspaces/${WS}/dbt/projects/${project._id}/jobs/${row._id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: title }),
        },
      );
      // As the AI SDK and MCP call it: the input schema first.
      const toolInput = {
        projectId: String(project._id),
        jobId: String(row._id),
        name: title,
      };
      const schema = tools.dbt_update_job.inputSchema as unknown as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const tool = schema.safeParse(toolInput).success
        ? ((await tools.dbt_update_job.execute!(toolInput, {
            toolCallId: "t",
            messages: [],
          })) as { success: boolean; error?: string })
        : { success: false, error: "input schema" };
      const create = await app.request(
        `/api/workspaces/${WS}/dbt/projects/${project._id}/jobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: title,
            environment: "prod",
            commands: [`build --select tag:${label.replace(/\W+/g, "-")}`],
          }),
        },
      );
      if (expected === "refused") {
        if (patch.status !== 400) {
          failures.push(`PATCH ${label}: ${patch.status}`);
        }
        if (create.status !== 400) {
          failures.push(`POST ${label}: ${create.status}`);
        }
        if (tool.success) failures.push(`tool ${label}: accepted`);
        if ((await commitCountOf(WS)) !== commits) {
          failures.push(`${label}: committed`);
        }
      } else {
        if (patch.status !== 200) {
          failures.push(`PATCH ${label}: ${patch.status}`);
        }
        if (!tool.success) failures.push(`tool ${label}: ${tool.error}`);
        if (create.status !== 200) {
          failures.push(`POST ${label}: ${create.status}`);
        }
        const stored = (await DbtJob.findById(row._id))!.name;
        if (stored !== expected) {
          failures.push(`${label}: stored ${JSON.stringify(stored)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    await expectSameJob(before);
  }, 300_000);

  it("a name past the cap is refused with ONE 400 message on every path that writes a job name", async () => {
    const row = await seedJob("target", "Target");
    const message = "The name is longer than 128 characters.";
    const { createDbtServerTools } = await import(
      "../../agent-lib/tools/dbt-tools"
    );
    const tools = createDbtServerTools(WS, OWNER, { chatId: "scenario" });
    auth.user = { id: OWNER };
    for (const name of ["x".repeat(129), "x".repeat(1000), "x".repeat(10000)]) {
      if (name.length <= 1000) {
        const viaRest = await restRename({ ref: "target", title: name });
        expect(viaRest.status).toBe(400);
        expect(viaRest.json.error).toBe(message);
      }
      expect(await serviceRename({ ref: "target", title: name })).toMatchObject(
        { ok: false, status: 400, message },
      );
      const patch = await app.request(
        `/api/workspaces/${WS}/dbt/projects/${project._id}/jobs/${row._id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      expect(patch.status).toBe(400);
      expect(((await patch.json()) as { error: string }).error).toBe(message);
      const create = await app.request(
        `/api/workspaces/${WS}/dbt/projects/${project._id}/jobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            environment: "prod",
            commands: ["build --select tag:long"],
          }),
        },
      );
      expect(create.status).toBe(400);
      expect(((await create.json()) as { error: string }).error).toBe(message);
      for (const [toolName, input] of [
        [
          "dbt_update_job",
          { projectId: String(project._id), jobId: String(row._id), name },
        ],
        [
          "dbt_create_job",
          {
            projectId: String(project._id),
            name,
            commands: ["build --select tag:long"],
          },
        ],
      ] as const) {
        const tool = tools[toolName];
        const schema = tool.inputSchema as unknown as {
          safeParse: (v: unknown) => { success: boolean; data?: unknown };
        };
        const parsed = schema.safeParse(input);
        expect(parsed.success, toolName).toBe(true);
        const out = (await tool.execute!(parsed.data as never, {
          toolCallId: "t",
          messages: [],
        })) as { success: boolean; error?: string };
        expect(out, toolName).toEqual({ success: false, error: message });
      }
    }
    expect((await DbtJob.findById(row._id))?.name).toBe("Target");
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("slugs and names YAML would read as numbers, dates, booleans or null round-trip as strings (review on #1037)", async () => {
    const row = await seedJob("start", "Start");
    const before = await jobState(row._id);
    const chain = [
      "2026",
      "2026-10-06",
      "true",
      "no",
      "null",
      "1e3",
      "0x1f",
      "012",
    ];
    let current = "start";
    const old: string[] = [];
    for (const slug of chain) {
      const out = await serviceRename({ ref: current, slug, title: slug });
      expect(out, `${current} → ${slug}`).toMatchObject({ ok: true });
      old.push(current);
      current = slug;
      const text = (await fileAtMain(WS, jobFilePath(slug))) ?? "";
      const parsed = parseJobFile(text);
      expect(parsed, `${slug}: file re-parses`).not.toBeNull();
      expect(parsed?.name).toBe(slug);
      expect(parsed?.aliases).toEqual(old);
      for (const alias of parsed?.aliases ?? []) {
        expect(typeof alias).toBe("string");
      }
      const live = await DbtJob.findById(row._id).lean();
      expect(live?.slug).toBe(slug);
      expect(live?.name).toBe(slug);
      expect(live?.aliases).toEqual(old);
    }
    for (const ref of old) {
      expect((await resolveDbtJobRef({ workspaceId: WS }, ref))?.id, ref).toBe(
        before.id,
      );
    }
    // Names that are not slugs but YAML-typed all the same.
    for (const title of [
      ".5",
      "1e3",
      "0x1F",
      "yes",
      "off",
      "~",
      "2026-10-06T10:00:00Z",
    ]) {
      expect((await serviceRename({ ref: current, title })).ok, title).toBe(
        true,
      );
      expect(
        parseJobFile((await fileAtMain(WS, jobFilePath(current))) ?? "")?.name,
      ).toBe(title);
    }
    // `.5` is no file name at all: refused with the reason, nothing written.
    expect(await serviceRename({ ref: current, slug: ".5" })).toMatchObject({
      ok: false,
      status: 400,
    });
    await syncDbtConfigFromRepo(WS);
    const settled = await expectSameJob(before);
    expect(settled.slug).toBe("012");
    expect(settled.aliases).toEqual(old);
    expect(
      (await DbtJob.findById(row._id).lean())?.definitionInvalid?.reason,
    ).toBeUndefined();
  });

  it("an NFD title on an NFC-named job is a no-op", async () => {
    const row = await seedJob("cafe", "Caf\u00E9 build");
    const commits = await commitCountOf(WS);
    expect(
      (await serviceRename({ ref: "cafe", title: "Cafe\u0301 build" })).ok,
    ).toBe(true);
    expect(await commitCountOf(WS)).toBe(commits);
    expect((await DbtJob.findById(row._id))!.name).toBe("Caf\u00E9 build");
  });
});

// ---- partial failures ------------------------------------------------------

describe("partial failure between the commit and the row", () => {
  it("the row write fails after the commit: the UI route answers 200 with the warning, and an immediate retry is a safe no-op (no second commit, row level)", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("a", "A");
    const spy = vi.spyOn(DbtJob, "updateOne").mockImplementationOnce((() => {
      throw new Error("mongo write failed");
    }) as never);
    const first = await restRename({ ref: "a", slug: "b" });
    spy.mockRestore();
    expect(first.status).toBe(200);
    const result = first.json.result as { warnings: string[]; id: string };
    expect(result.id).toBe(String(row._id));
    expect(result.warnings.join(" ")).toMatch(/Retrying is safe/);
    const commits = await commitCountOf(WS);
    const again = await restRename({ ref: "a", slug: "b" });
    expect(again.status).toBe(200);
    expect(await commitCountOf(WS)).toBe(commits);
    const after = await DbtJob.findById(row._id).lean();
    expect(after?.slug).toBe("b");
    expect(after?.aliases).toEqual(["a"]);
  });

  it("the commit lands and the row update throws: the list, GET and the next sync all converge on the same job", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const spy = vi.spyOn(DbtJob, "updateOne").mockImplementationOnce((() => {
      throw new Error("mongo write failed");
    }) as never);
    const out = await serviceRename({ ref: "a", slug: "b" });
    spy.mockRestore();
    // The rename DID happen (the file is the store): a success that says
    // the record catches up, never a failure inviting a retry.
    expect(out.ok).toBe(true);
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(out.warnings?.join(" ")).toMatch(
      /rename is committed.*catches up on the next read or sync.*Retrying is safe/,
    );
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual([
      "dbt/jobs/b.yml",
      "dbt/jobs/keeper.yml",
    ]);
    // Before any push sync: the job is listed and opened under its new
    // name with its own id — no git-only stand-in, no 404.
    const listed = await loadLiveJobs(project);
    expect(listed.map(l => [l.def.slug, String(l.id)])).toContainEqual([
      "b",
      before.id,
    ]);
    expect((await resolveLiveJobRow(project, before.id)).ok).toBe(true);
    await syncDbtConfigFromRepo(WS);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "b",
      aliases: ["a"],
    });
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(2);
    await expectNoDuplicate();
  });

  it("the git commit throws: nothing changes", async () => {
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const commits = await commitCountOf(WS);
    commitHook.fail = true;
    const out = await serviceRename({ ref: "a", title: "A2", slug: "b" });
    expect(out.ok).toBe(false);
    expect(await commitCountOf(WS)).toBe(commits);
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual(["dbt/jobs/a.yml"]);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "a",
      name: "A",
      aliases: [],
    });
    expect(
      (await DbtJob.findById(row._id).lean())?.lastRenameCommit,
    ).toBeUndefined();
  });

  it("the mirror push fails: the rename stands, guarded; an instance on the old mirror main never sweeps it; it settles when the push lands", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const pre = await headOf(WS);
    mirror.pushFails = true;
    expect((await serviceRename({ ref: "a", slug: "b" })).ok).toBe(true);
    const renamedAt = await headOf(WS);
    mirror.main = pre;
    await resetMainTo(WS, pre);
    await syncDbtConfigFromRepo(WS);
    expect(await expectSameJob(before)).toMatchObject({ slug: "b" });
    await resetMainTo(WS, renamedAt);
    mirror.main = renamedAt;
    await syncDbtConfigFromRepo(WS);
    expect(
      (await DbtJob.findById(row._id).lean())?.lastRenameCommit,
    ).toBeUndefined();
    await expectSameJob(before);
    await expectNoDuplicate();
  });
});

// ---- concurrency -----------------------------------------------------------

describe("concurrency", () => {
  it("two renames of one job at once: exactly one wins, one file", async () => {
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const outs = await Promise.all([
      serviceRename({ ref: "a", slug: "b" }),
      serviceRename({ ref: "a", slug: "c" }),
    ]);
    expect(outs.filter(o => o.ok)).toHaveLength(1);
    expect(outs.find(o => !o.ok)?.status).toBe(409);
    const winner = outs[0].ok ? "b" : "c";
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual([
      `dbt/jobs/${winner}.yml`,
    ]);
    expect(await expectSameJob(before)).toMatchObject({
      slug: winner,
      aliases: ["a"],
    });
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(before);
  });

  it("two jobs renamed onto one new slug at once: one wins", async () => {
    const x = await seedJob("x", "X");
    const y = await seedJob("y", "Y");
    const bx = await jobState(x._id);
    const by = await jobState(y._id);
    const outs = await Promise.all([
      serviceRename({ ref: "x", slug: "n" }),
      serviceRename({ ref: "y", slug: "n" }),
    ]);
    expect(outs.filter(o => o.ok)).toHaveLength(1);
    expect(await pathsAtMain(WS, "dbt/jobs")).toHaveLength(2);
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(bx);
    await expectSameJob(by);
    await expectNoDuplicate();
  });

  it("a rename racing a save: never two scheduled jobs; a loser says reload", async () => {
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const inFlight = (await DbtJob.findById(row._id))!;
    inFlight.schedule = { cron: "0 9 * * *", timezone: "UTC" };
    const [renamed, saved] = await Promise.all([
      serviceRename({ ref: "a", slug: "b" }),
      commitDbtJobFile(project, inFlight, OWNER).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    expect(renamed.ok || saved.ok).toBe(true);
    if (!saved.ok) expect(saved.error).toBeInstanceOf(DbtConfigConflictError);
    if (!renamed.ok) expect(renamed.status).toBe(409);
    expect(await pathsAtMain(WS, "dbt/jobs")).toHaveLength(1);
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(before);
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("a laptop push landing inside the rename's window: refused (CAS), the push's edit stands", async () => {
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    freshenHook.fn = async () => {
      freshenHook.fn = async () => {
        await push({
          [jobFilePath("a")]: jobYaml("A", "a").replace(
            "cron: 0 6 * * *",
            "cron: 0 8 * * *",
          ),
        });
      };
    };
    const out = await serviceRename({ ref: "a", slug: "b" });
    expect(out.status).toBe(409);
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual(["dbt/jobs/a.yml"]);
    await syncDbtConfigFromRepo(WS);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "a",
      cron: "0 8 * * *",
    });
  });

  it("a rename racing a DELETE: the deleted job never comes back on its schedule", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("doomed", "Doomed");
    freshenHook.fn = async () => {
      await renameObject(ctx(), "dbt_job", { ref: "doomed", slug: "moved" });
    };
    auth.user = { id: OWNER };
    const res = await app.request(
      `/api/workspaces/${WS}/dbt/projects/${project._id}/jobs/${row._id}`,
      { method: "DELETE" },
    );
    expect([200, 409]).toContain(res.status);
    await syncDbtConfigFromRepo(WS);
    const slugs = (await DbtJob.find({ projectId: project._id })).map(
      r => r.slug,
    );
    if (res.status === 200) {
      expect(await pathsAtMain(WS, "dbt/jobs")).toEqual([
        "dbt/jobs/keeper.yml",
      ]);
      expect(slugs).toEqual(["keeper"]);
    } else {
      expect(slugs.sort()).toEqual(["keeper", "moved"]);
    }
  });

  it("the auto-disable after repeated failures, holding a row from before a rename: re-read once, the RENAMED file is switched off — no file resurrected; a crash before its row update leaves no drift", async () => {
    const row = await seedJob("flaky", "Flaky");
    const before = await jobState(row._id);
    // dbt-run.ts's auto-disable step, with the row it loaded at run start.
    const stale = (await DbtJob.findById(row._id))!;
    expect((await serviceRename({ ref: "flaky", slug: "flaky-2" })).ok).toBe(
      true,
    );
    stale.enabled = false;
    await expect(
      commitDbtJobFile({ workspaceId: stale.workspaceId }, stale),
    ).rejects.toBeInstanceOf(DbtConfigConflictError);
    const reread = (await DbtJob.findById(row._id))!;
    reread.enabled = false;
    await commitDbtJobFile({ workspaceId: reread.workspaceId }, reread);
    // The process dies here, before dbt-run.ts's own row update: the row
    // must already say what the file says (the shas say "level", so no
    // sync or read would ever re-apply the file).
    expect((await DbtJob.findById(row._id))?.enabled).toBe(false);
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual(["dbt/jobs/flaky-2.yml"]);
    expect(
      parseJobFile((await fileAtMain(WS, jobFilePath("flaky-2"))) ?? "")
        ?.enabled,
    ).toBe(false);
    await syncDbtConfigFromRepo(WS);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "flaky-2",
      enabled: false,
    });
  });

  it("a rename landing while a push sync runs is neither undone nor swept", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("nightly", "Nightly");
    const before = await jobState(row._id);
    await push({
      [jobFilePath("nightly")]: jobYaml("Nightly", "nightly").replace(
        "cron: 0 6 * * *",
        "cron: 0 5 * * *",
      ),
    });
    scheduleHook.fn = async () => {
      await renameObject(ctx(), "dbt_job", {
        ref: "nightly",
        slug: "nightly-2",
      });
    };
    await syncDbtConfigFromRepo(WS);
    expect(await expectSameJob(before)).toMatchObject({ slug: "nightly-2" });
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(before);
    await expectNoDuplicate();
  });

  it("two instances with different local mains: the stale one keeps the job and serves it", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const pre = await headOf(WS);
    expect((await serviceRename({ ref: "a", slug: "b" })).ok).toBe(true);
    await becomeStaleInstance(WS, pre);
    mirror.main = pre;
    await syncDbtConfigFromRepo(WS);
    expect(await expectSameJob(before)).toMatchObject({ slug: "b" });
    expect(
      (await loadLiveJobById(project, before.id))?.row?._id.toString(),
    ).toBe(before.id);
    // The rename arrives (the mirror push landed, B fetched it).
    await push({ [jobFilePath("b")]: jobYaml("A", "a", "aliases: [a]") }, [
      jobFilePath("a"),
    ]);
    mirror.main = await headOf(WS);
    await syncDbtConfigFromRepo(WS);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "b",
      aliases: ["a"],
    });
    await expectNoDuplicate();
  });
});

// ---- cycles and chains -----------------------------------------------------

describe("cycles and chains", () => {
  it("a→b→a→b keeps one alias list without the current slug; a→b then c→a is refused", async () => {
    const row = await seedJob("a", "A");
    await seedJob("c", "C");
    const before = await jobState(row._id);
    for (const [ref, slug] of [
      ["a", "b"],
      ["b", "a"],
      ["a", "b"],
    ]) {
      expect((await serviceRename({ ref, slug })).ok, `${ref}→${slug}`).toBe(
        true,
      );
    }
    expect(await expectSameJob(before)).toMatchObject({
      slug: "b",
      aliases: ["a"],
    });
    expect((await serviceRename({ ref: "c", slug: "a" })).status).toBe(409);
    expect((await resolveDbtJobRef({ workspaceId: WS }, "a"))?.id).toBe(
      before.id,
    );
  });

  it("a 30-rename chain: the newest 24 old names resolve; older ones resolve to nothing, in the row and in the file", async () => {
    const row = await seedJob("n0", "N");
    const before = await jobState(row._id);
    const { ms } = await timed(async () => {
      for (let i = 1; i <= 30; i++) {
        expect(
          (await serviceRename({ ref: `n${i - 1}`, slug: `n${i}` })).ok,
        ).toBe(true);
      }
    });
    recordTiming("dbt job: 30 chained renames", ms);
    const kept = Array.from({ length: 24 }, (_, i) => `n${i + 6}`);
    expect((await expectSameJob(before)).aliases).toEqual(kept);
    expect(
      parseJobFile((await fileAtMain(WS, jobFilePath("n30"))) ?? "")?.aliases,
    ).toEqual(kept);
    const resolved = await timed(async () => {
      for (let i = 0; i <= 30; i++) {
        const r = await resolveDbtJobRef({ workspaceId: WS }, `n${i}`);
        expect(r?.id ?? null, `n${i}`).toBe(i < 6 ? null : before.id);
      }
    });
    recordTiming("dbt job: resolve 31 names of a 30-rename chain", resolved.ms);
    expect(resolved.ms).toBeLessThan(10_000);
    await syncDbtConfigFromRepo(WS);
    expect((await expectSameJob(before)).aliases).toEqual(kept);
    // A dropped name is free for a new job, and then names only that job.
    await push({ [jobFilePath("n0")]: jobYaml("New n0", "new-n0") });
    await syncDbtConfigFromRepo(WS);
    const newcomer = await DbtJob.findOne({
      projectId: project._id,
      slug: "n0",
    });
    expect(String(newcomer!._id)).not.toBe(before.id);
    expect((await resolveDbtJobRef({ workspaceId: WS }, "n0"))?.id).toBe(
      String(newcomer!._id),
    );
  }, 300_000);
});

// ---- scale -----------------------------------------------------------------

describe("scale (measured)", () => {
  it("1,200 jobs and 5,000 commits: sync, list, resolve, rename and a laptop move stay bounded; nothing past 1,000 is dropped", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1200; i++) {
      files[jobFilePath(`j${i}`)] = jobYaml(`J${i}`, `j${i}`);
    }
    await fastImportHistory(WS, { count: 5000, files });
    const first = await timed(() => syncDbtConfigFromRepo(WS));
    recordTiming(
      "dbt job: first push sync creating 1,200 jobs (5,000 commits)",
      first.ms,
    );
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1200);
    const noop = await timed(() => syncDbtConfigFromRepo(WS));
    recordTiming("dbt job: push sync of 1,200 unchanged jobs", noop.ms);
    const list = await timed(() => loadLiveJobs(project));
    recordTiming("dbt job: list 1,200 jobs (GET /jobs)", list.ms);
    expect(list.value).toHaveLength(1200);
    expect(list.ms).toBeLessThan(30_000);
    const missing = await timed(() =>
      resolveDbtJobRef({ workspaceId: WS }, "no-such-job"),
    );
    recordTiming("dbt job: resolve a missing slug among 1,200", missing.ms);
    expect(missing.value).toBeNull();
    const renamed = await timed(() =>
      serviceRename({ ref: "j500", slug: "j500-renamed" }),
    );
    recordTiming("dbt job: rename one of 1,200", renamed.ms);
    expect(renamed.value.ok).toBe(true);
    const alias = await timed(() =>
      resolveDbtJobRef({ workspaceId: WS }, "j500"),
    );
    recordTiming("dbt job: resolve an old name among 1,200", alias.ms);
    expect(alias.value?.via).toBe("alias");
    const l = await Laptop.clone(WS, path.join(tmpRoot, "laptops"));
    await l.mv("dbt/jobs/j7.yml", "dbt/jobs/j7-moved.yml");
    await l.commit("move one");
    expect((await l.push()).ok).toBe(true);
    const moved = await timed(() => syncDbtConfigFromRepo(WS));
    recordTiming("dbt job: push sync of a laptop move among 1,200", moved.ms);
    expect(
      await DbtJob.exists({ projectId: project._id, slug: "j7-moved" }),
    ).not.toBeNull();
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1200);
    for (const ms of [missing.ms, renamed.ms, alias.ms, moved.ms]) {
      expect(ms).toBeLessThan(30_000);
    }
  }, 600_000);
});
