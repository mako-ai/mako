/**
 * Graceful rename of DBT JOBS — the scenario matrix (mako-ai/mako#1037).
 *
 * Every entry point (the UI's REST route, `rename_object` as the agent
 * holds it, `rename_object` over MCP with and without the warehouse-write
 * grant, a laptop `git mv` pushed and synced as the git endpoint would) ×
 * every operation, against the real services: a bare repo, a memory Mongo,
 * the objects and dbt routes, real git.
 *
 * After every cell the job's identity is checked as the scheduler sees it:
 * same id (so the `/x/<project>/job/<id>` URL), the run history (DbtRun
 * rows keyed by the id), the scheduler's claim (`scheduledRun`), the
 * schedule; NO row swept and NO second job running the same commands.
 * Roles (dbt jobs are admin/owner to change, readable by every member),
 * links and cross-workspace isolation follow. Hostile names, partial
 * failures, races, cycles and scale: dbt-job-rename-hostile.scenarios.test.ts.
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

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
});

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
const mirror = vi.hoisted(() => ({ main: null as string | null }));
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
  };
});
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(async () => undefined),
    createFunction: vi.fn(() => ({})),
  },
}));
const published = vi.hoisted(() => [] as Array<{ type: string }>);
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn((_ws: string, event: { type: string }) => {
    published.push(event);
  }),
}));
const auth = vi.hoisted(() => ({
  authType: "session" as "session" | "apiKey" | "mcpOAuth",
  user: undefined as { id: string } | undefined,
}));
const members = vi.hoisted(() => new Map<string, string>());
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", auth.authType);
    if (auth.user) c.set("user", auth.user);
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
  isMcpOAuthAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "mcpOAuth",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async (ws: string, userId: string) =>
      members.has(`${ws}:${String(userId)}`),
    ),
    getMember: vi.fn(async (ws: string, userId: string) => {
      const role = members.get(`${ws}:${String(userId)}`);
      return role ? { role } : null;
    }),
    hasRole: vi.fn(async (ws: string, userId: string, roles: string[]) =>
      roles.includes(members.get(`${ws}:${String(userId)}`) ?? ""),
    ),
  },
}));

import { Hono } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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
  derivedJobId,
  jobToFile,
  loadLiveJobById,
  loadLiveJobs,
  resetJobFreshenOnMissThrottle,
  syncDbtConfigFromRepo,
} from "../../dbt/dbt-config.service";
import {
  jobFilePath,
  jobRenameTarget,
  parseJobFile,
} from "../../dbt/dbt-config-files";
import { objectRoutes } from "../../routes/objects";
import { dbtRoutes } from "../../routes/dbt.routes";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { buildMakoMcpServer } from "../../mcp/mako-mcp-server";
import { StatelessMcpTransport } from "../../mcp/stateless-transport";
import type { WorkspaceApiKeyScope } from "../../auth/api-key-scopes";
import { resolveDbtJobRef } from "../dbt-job-rename";
import type { RenameResult } from "../types";
import {
  Laptop,
  commitCountOf,
  fileAtMain,
  headOf,
  pathsAtMain,
  pathsTouchedBy,
  tmpRootFor,
} from "./scenario-rig";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: string;
let project: IDbtProject;

const OWNER = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();
const EDITOR = new Types.ObjectId().toString();
const VIEWER = new Types.ObjectId().toString();
const STRANGER = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();

/** A scheduled prod job; `tag` picks what it builds (so its target). */
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

async function newProject(): Promise<IDbtProject> {
  return DbtProject.create({
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
}

/** A synced job with run history and a scheduler claim keyed by its id. */
async function seedJob(slug: string, name: string, tag = slug) {
  await push({ [jobFilePath(slug)]: jobYaml(name, tag) });
  await syncDbtConfigFromRepo(WS);
  const row = await DbtJob.findOne({ projectId: project._id, slug });
  expect(row, `seeded ${slug}`).not.toBeNull();
  for (let i = 0; i < 2; i++) {
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
  }
  await DbtJob.updateOne(
    { _id: row!._id },
    {
      $set: {
        "scheduledRun.runCount": 7,
        "scheduledRun.consecutiveFailures": 1,
      },
    },
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
    failures: row!.scheduledRun?.consecutiveFailures,
    nextAt: Boolean(row!.scheduledRun?.nextAt),
    runs: await DbtRun.countDocuments({ jobId: row!._id }),
  };
}
type JobState = Awaited<ReturnType<typeof jobState>>;

async function expectSameJob(before: JobState): Promise<JobState> {
  const after = await jobState(before.id);
  expect(after.id).toBe(before.id);
  expect(after.runs).toBe(before.runs);
  expect(after.runCount).toBe(before.runCount);
  expect(after.failures).toBe(before.failures);
  return after;
}

/** No second job building the same thing; the seeded jobs all still exist. */
async function expectNoSweepNoDuplicate(ids: string[] = []): Promise<void> {
  const rows = await DbtJob.find({ projectId: project._id });
  const targets = rows.map(row => jobRenameTarget(jobToFile(row)));
  expect(new Set(targets).size, `targets ${targets.join(" | ")}`).toBe(
    targets.length,
  );
  for (const id of ids) {
    expect(await DbtJob.exists({ _id: id }), `job ${id} swept`).not.toBeNull();
  }
}

async function resolves(ref: string): Promise<string | null> {
  return (await resolveDbtJobRef({ workspaceId: WS }, ref))?.id ?? null;
}

const jobUrl = (id: string) => `/x/${project._id}/job/${id}`;

// ---- entry points ---------------------------------------------------------

type Entry = "rest" | "tool" | "mcp";

interface Outcome {
  ok: boolean;
  status: number;
  result?: RenameResult;
  error?: string;
}

const app = new Hono();
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);
app.route("/api/workspaces/:workspaceId/dbt", dbtRoutes);

async function rest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  userId: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  auth.authType = "session";
  auth.user = userId ? { id: userId } : undefined;
  const res = await app.request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function mcpCall(
  args: Record<string, unknown>,
  context: {
    userId?: string;
    memberRole?: string;
    scopes?: WorkspaceApiKeyScope[];
  },
): Promise<{ isError: boolean; text: string }> {
  const server = buildMakoMcpServer({
    workspaceId: WS,
    userId: context.userId,
    memberRole: context.memberRole,
    scopes: context.scopes ?? ["mcp", "query:read", "warehouse:write"],
  });
  const transport = new StatelessMcpTransport();
  await server.connect(transport);
  try {
    const [response] = (await transport.handle(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "rename_object", arguments: args },
        },
      ] as unknown as JSONRPCMessage[],
      60_000,
    )) as unknown as Array<{
      result?: { isError?: boolean; content: Array<{ text: string }> };
      error?: { message: string };
    }>;
    if (response.error) return { isError: true, text: response.error.message };
    return {
      isError: Boolean(response.result?.isError),
      text: response.result?.content?.[0]?.text ?? "",
    };
  } finally {
    await server.close();
  }
}

async function renameVia(
  entry: Entry,
  request: { ref: string; title?: string; slug?: string },
  as: string = OWNER,
  scopes?: WorkspaceApiKeyScope[],
): Promise<Outcome> {
  if (entry === "rest") {
    const { status, json } = await rest(
      "POST",
      `/api/workspaces/${WS}/objects/dbt_job/rename`,
      as,
      request,
    );
    return {
      ok: status === 200,
      status,
      result: json.result as RenameResult | undefined,
      error: json.error as string | undefined,
    };
  }
  if (entry === "tool") {
    const tool = createRenameTools(WS, as).rename_object;
    const out = (await tool.execute!(
      { kind: "dbt_job", ...request },
      { toolCallId: "t", messages: [] },
    )) as { success: boolean; error?: string } & Partial<RenameResult>;
    return out.success
      ? { ok: true, status: 200, result: out as unknown as RenameResult }
      : { ok: false, status: 0, error: out.error };
  }
  const out = await mcpCall(
    { kind: "dbt_job", ...request },
    { userId: as, memberRole: members.get(`${WS}:${as}`), scopes },
  );
  if (out.isError) return { ok: false, status: 0, error: out.text };
  const parsed = JSON.parse(out.text) as { success: boolean; error?: string };
  return parsed.success
    ? { ok: true, status: 200, result: parsed as unknown as RenameResult }
    : { ok: false, status: 0, error: parsed.error };
}

// ---- rig ------------------------------------------------------------------

beforeAll(async () => {
  tmpRoot = await tmpRootFor("dbt-job-rename-scenarios");
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

async function freshWorkspace(): Promise<void> {
  WS = new Types.ObjectId().toString();
  members.set(`${WS}:${OWNER}`, "owner");
  members.set(`${WS}:${ADMIN}`, "admin");
  members.set(`${WS}:${EDITOR}`, "member");
  members.set(`${WS}:${VIEWER}`, "viewer");
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
  project = await newProject();
}

beforeEach(async () => {
  published.length = 0;
  mirror.main = null;
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_GITHUB_REMOTE_BASE;
  resetJobFreshenOnMissThrottle();
  members.clear();
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtJob.deleteMany({}),
    DbtRun.deleteMany({}),
  ]);
  await freshWorkspace();
});

// ---- the matrix: service entry points ------------------------------------

describe.each(["rest", "tool", "mcp"] as const)("entry point: %s", entry => {
  it("title only: name: rewritten in place, one commit, one file; same job", async () => {
    const row = await seedJob("nightly", "Nightly");
    const before = await jobState(row._id);
    const commits = await commitCountOf(WS);
    const out = await renameVia(entry, {
      ref: "nightly",
      title: "Nightly build",
    });
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({
      id: before.id,
      aliasesAdded: [],
      after: {
        title: "Nightly build",
        slug: "nightly",
        url: jobUrl(before.id),
      },
    });
    expect(await commitCountOf(WS)).toBe(commits + 1);
    expect(await pathsTouchedBy(WS, await headOf(WS))).toEqual([
      "dbt/jobs/nightly.yml",
    ]);
    expect(await fileAtMain(WS, "dbt/jobs/nightly.yml")).toBe(
      jobYaml("Nightly", "nightly").replace(
        "name: Nightly",
        "name: Nightly build",
      ),
    );
    expect(await expectSameJob(before)).toMatchObject({
      slug: "nightly",
      name: "Nightly build",
      cron: "0 6 * * *",
      enabled: true,
      nextAt: true,
    });
    expect(published.some(e => e.type === "dbt.job.updated")).toBe(true);
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(before);
    await expectNoSweepNoDuplicate([before.id]);
  });

  it("slug only: one commit moves the file and records the alias; the old slug resolves", async () => {
    const row = await seedJob("nightly", "Nightly");
    await seedJob("hourly", "Hourly");
    const before = await jobState(row._id);
    const commits = await commitCountOf(WS);
    const out = await renameVia(entry, {
      ref: "nightly",
      slug: "nightly-prod",
    });
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({
      id: before.id,
      aliasesAdded: ["nightly"],
      after: { slug: "nightly-prod", url: jobUrl(before.id) },
    });
    expect(await commitCountOf(WS)).toBe(commits + 1);
    expect(await pathsTouchedBy(WS, await headOf(WS))).toEqual([
      "dbt/jobs/nightly-prod.yml",
      "dbt/jobs/nightly.yml",
    ]);
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual([
      "dbt/jobs/hourly.yml",
      "dbt/jobs/nightly-prod.yml",
    ]);
    expect(
      parseJobFile((await fileAtMain(WS, "dbt/jobs/nightly-prod.yml")) ?? "")
        ?.aliases,
    ).toEqual(["nightly"]);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "nightly-prod",
      aliases: ["nightly"],
      nextAt: true,
    });
    for (const ref of ["nightly", "nightly-prod", before.id]) {
      expect(await resolves(ref), ref).toBe(before.id);
    }
    expect((await loadLiveJobById(project, before.id))?.def.slug).toBe(
      "nightly-prod",
    );
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(before);
    await expectNoSweepNoDuplicate([before.id]);
  });

  it("title + slug, rename back, twice quickly — one commit each, every old name resolves", async () => {
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const commits = await commitCountOf(WS);
    expect(
      (await renameVia(entry, { ref: "a", title: "B", slug: "b" })).ok,
    ).toBe(true);
    expect((await renameVia(entry, { ref: "b", slug: "c" })).ok).toBe(true);
    expect((await renameVia(entry, { ref: "c", slug: "a" })).ok).toBe(true);
    expect(await commitCountOf(WS)).toBe(commits + 3);
    const after = await expectSameJob(before);
    expect(after).toMatchObject({ slug: "a", name: "B" });
    expect([...after.aliases].sort()).toEqual(["b", "c"]);
    for (const ref of ["a", "b", "c"]) {
      expect(await resolves(ref), ref).toBe(before.id);
    }
    await syncDbtConfigFromRepo(WS);
    await expectSameJob(before);
    await expectNoSweepNoDuplicate([before.id]);
  });

  it("onto another job's live slug or old name: refused, nothing changes", async () => {
    const a = await seedJob("a", "A");
    const b = await seedJob("b", "B");
    expect((await renameVia(entry, { ref: "b", slug: "b-new" })).ok).toBe(true);
    const beforeA = await jobState(a._id);
    const commits = await commitCountOf(WS);
    for (const slug of ["b-new", "b"]) {
      const out = await renameVia(entry, { ref: "a", slug });
      expect(out.ok, `onto ${slug}`).toBe(false);
      if (entry === "rest") expect(out.status).toBe(409);
      expect(out.error).toMatch(
        slug === "b" ? /old name of job "B"/ : /already the file name/,
      );
    }
    expect(await commitCountOf(WS)).toBe(commits);
    expect(await expectSameJob(beforeA)).toMatchObject({ slug: "a" });
    expect(await resolves("b")).toBe(String(b._id));
    await expectNoSweepNoDuplicate([beforeA.id, String(b._id)]);
  });

  it("no-op and never-synced: success with no commit; a job not synced yet is a 409 with the reason", async () => {
    const row = await seedJob("nightly", "Nightly");
    const commits = await commitCountOf(WS);
    const noop = await renameVia(entry, {
      ref: ` ${String(row._id)} `,
      title: " Nightly ",
      slug: "nightly",
    });
    expect(noop.ok).toBe(true);
    expect(noop.result?.commit).toBeUndefined();
    await push({ [jobFilePath("git-only")]: jobYaml("Git only", "git-only") });
    const gitOnly = await renameVia(entry, { ref: "git-only", slug: "x" });
    expect(gitOnly.ok).toBe(false);
    if (entry === "rest") expect(gitOnly.status).toBe(409);
    expect(gitOnly.error).toMatch(/not synced yet/);
    expect(await commitCountOf(WS)).toBe(commits + 1);
    // …and its derived id (the one the list hands out) resolves to it.
    const listed = (await loadLiveJobs(project)).find(
      l => l.def.slug === "git-only",
    );
    expect(await resolves(String(listed!.id))).toBe(String(listed!.id));
  });
});

// ---- the matrix: laptop pushes --------------------------------------------

describe("entry point: laptop git mv + push", () => {
  async function laptop(): Promise<Laptop> {
    return Laptop.clone(WS, path.join(tmpRoot, "laptops"));
  }
  async function pushAndSync(l: Laptop): Promise<void> {
    const pushed = await l.push();
    expect(pushed.stderr).toBe("");
    await syncDbtConfigFromRepo(WS);
  }

  it("slug only, title only, both: re-keyed in place, the old slug recorded", async () => {
    const row = await seedJob("nightly", "Nightly");
    const before = await jobState(row._id);
    const l = await laptop();
    await l.mv("dbt/jobs/nightly.yml", "dbt/jobs/nightly-prod.yml");
    await l.commit("git mv");
    await pushAndSync(l);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "nightly-prod",
      aliases: ["nightly"],
    });
    await l.write(
      "dbt/jobs/nightly-prod.yml",
      (await l.read("dbt/jobs/nightly-prod.yml")).replace(
        "name: Nightly",
        "name: Nightly (prod)",
      ),
    );
    await l.commit("retitle");
    await pushAndSync(l);
    expect(await expectSameJob(before)).toMatchObject({
      name: "Nightly (prod)",
    });
    await l.mv("dbt/jobs/nightly-prod.yml", "dbt/jobs/prod.yml");
    await l.write(
      "dbt/jobs/prod.yml",
      (await l.read("dbt/jobs/prod.yml")).replace(
        "name: Nightly (prod)",
        "name: Prod",
      ),
    );
    await l.commit("both");
    await pushAndSync(l);
    const after = await expectSameJob(before);
    expect(after).toMatchObject({ slug: "prod", name: "Prod" });
    expect([...after.aliases].sort()).toEqual(["nightly", "nightly-prod"]);
    await expectNoSweepNoDuplicate([before.id]);
  });

  it("rename + edit in one commit (name, cron, timezone): the same job — schedule re-registered, history kept", async () => {
    const row = await seedJob("nightly", "Nightly");
    const before = await jobState(row._id);
    const l = await laptop();
    await l.mv("dbt/jobs/nightly.yml", "dbt/jobs/morning.yml");
    await l.write(
      "dbt/jobs/morning.yml",
      (await l.read("dbt/jobs/morning.yml"))
        .replace("name: Nightly", "name: Morning")
        .replace("cron: 0 6 * * *", "cron: 30 7 * * 1-5")
        .replace("timezone: Europe/Zurich", "timezone: UTC"),
    );
    await l.commit("move + reschedule");
    await pushAndSync(l);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "morning",
      name: "Morning",
      cron: "30 7 * * 1-5",
      aliases: ["nightly"],
      nextAt: true,
    });
    await expectNoSweepNoDuplicate([before.id]);
  });

  it("rename + a change of what it builds: with `aliases:` the same job; without, a new job (the old one removed, its history kept on its id)", async () => {
    await seedJob("keeper", "Keeper");
    const a = await seedJob("a", "A");
    const beforeA = await jobState(a._id);
    const l = await laptop();
    await l.mv("dbt/jobs/a.yml", "dbt/jobs/a2.yml");
    await l.write(
      "dbt/jobs/a2.yml",
      (await l.read("dbt/jobs/a2.yml"))
        .replace("tag:a", "tag:a-v2")
        .replace("name: A", "name: A v2\naliases: [a]"),
    );
    await l.commit("move + new commands, with the old name");
    await pushAndSync(l);
    expect(await expectSameJob(beforeA)).toMatchObject({ slug: "a2" });
    const b = await seedJob("b", "B");
    const oldB = String(b._id);
    await l.pull();
    await l.mv("dbt/jobs/b.yml", "dbt/jobs/b2.yml");
    await l.write(
      "dbt/jobs/b2.yml",
      (await l.read("dbt/jobs/b2.yml")).replace("tag:b", "tag:b-v2"),
    );
    await l.commit("move + new commands, no old name");
    await pushAndSync(l);
    const b2 = await DbtJob.findOne({ projectId: project._id, slug: "b2" });
    expect(String(b2!._id)).not.toBe(oldB);
    expect(await DbtJob.findById(oldB)).toBeNull();
    expect(await DbtRun.countDocuments({ jobId: oldB })).toBe(2);
    await expectNoSweepNoDuplicate([beforeA.id, String(b2!._id)]);
  });

  it("twice before one push, and back: one job throughout", async () => {
    const row = await seedJob("a", "A");
    const before = await jobState(row._id);
    const l = await laptop();
    await l.mv("dbt/jobs/a.yml", "dbt/jobs/b.yml");
    await l.commit("a → b");
    await l.mv("dbt/jobs/b.yml", "dbt/jobs/c.yml");
    await l.commit("b → c");
    await pushAndSync(l);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "c",
      aliases: ["a"],
    });
    await l.mv("dbt/jobs/c.yml", "dbt/jobs/a.yml");
    await l.commit("back");
    await pushAndSync(l);
    expect(await expectSameJob(before)).toMatchObject({
      slug: "a",
      aliases: ["c"],
    });
    await expectNoSweepNoDuplicate([before.id]);
  });

  it("onto a live name: git refuses; onto another job's OLD name: the mover takes it (current wins)", async () => {
    const x = await seedJob("x", "X");
    const a = await seedJob("a", "A");
    const l0 = await laptop();
    await expect(l0.mv("dbt/jobs/a.yml", "dbt/jobs/x.yml")).rejects.toThrow(
      /destination exists/,
    );
    expect((await renameVia("rest", { ref: "x", slug: "x2" })).ok).toBe(true);
    await syncDbtConfigFromRepo(WS);
    const beforeA = await jobState(a._id);
    const l = await laptop();
    await l.mv("dbt/jobs/a.yml", "dbt/jobs/x.yml");
    await l.commit("a takes x");
    await pushAndSync(l);
    expect(await expectSameJob(beforeA)).toMatchObject({
      slug: "x",
      aliases: ["a"],
    });
    expect(await resolves("x")).toBe(beforeA.id);
    expect((await jobState(x._id)).aliases).not.toContain("x");
    expect((await renameVia("rest", { ref: "x", slug: "a2" })).ok).toBe(true);
    await syncDbtConfigFromRepo(WS);
    expect(await resolves("x")).toBe(beforeA.id);
    await expectNoSweepNoDuplicate([beforeA.id, String(x._id)]);
  });

  it("move into a sub-folder: the job is parked (switched off, reason recorded), never deleted; back where jobs live it resumes", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("nightly", "Nightly");
    const before = await jobState(row._id);
    expect(before.nextAt).toBe(true);
    const l = await laptop();
    await l.mv("dbt/jobs/nightly.yml", "dbt/jobs/archive/nightly.yml");
    await l.commit("archive");
    await pushAndSync(l);
    const parked = await expectSameJob(before);
    expect(parked).toMatchObject({
      slug: "nightly",
      enabled: false,
      nextAt: false,
    });
    expect((await DbtJob.findById(row._id))?.definitionInvalid?.reason).toMatch(
      /dbt\/jobs\/archive\/nightly\.yml/,
    );
    await l.mv("dbt/jobs/archive/nightly.yml", "dbt/jobs/nightly.yml");
    await l.commit("restore");
    await pushAndSync(l);
    const back = await expectSameJob(before);
    expect(back).toMatchObject({
      slug: "nightly",
      enabled: true,
      nextAt: true,
    });
    expect(
      (await DbtJob.findById(row._id))?.definitionInvalid?.reason,
    ).toBeUndefined();
    await expectNoSweepNoDuplicate([before.id]);
  });

  it("copy with aliases: the copy is a new job inheriting no alias", async () => {
    await push({
      [jobFilePath("orig")]: jobYaml("Orig", "orig", "aliases: [legacy]"),
    });
    await syncDbtConfigFromRepo(WS);
    const orig = await DbtJob.findOne({ projectId: project._id, slug: "orig" });
    const l = await laptop();
    await l.write(
      "dbt/jobs/orig-copy.yml",
      (await l.read("dbt/jobs/orig.yml"))
        .replace("name: Orig", "name: Orig copy")
        .replace("tag:orig", "tag:orig-copy"),
    );
    await l.commit("copy");
    await pushAndSync(l);
    const copy = await DbtJob.findOne({
      projectId: project._id,
      slug: "orig-copy",
    });
    expect(String(copy!._id)).not.toBe(String(orig!._id));
    expect(copy!.aliases ?? []).toEqual([]);
    expect(await resolves("legacy")).toBe(String(orig!._id));
    await expectNoSweepNoDuplicate([String(orig!._id)]);
  });

  it("delete, then recreate at the old name: a new job with its own id — the old run history is not inherited", async () => {
    await seedJob("keeper", "Keeper");
    const row = await seedJob("nightly", "Nightly");
    const oldId = String(row._id);
    expect(oldId).toBe(String(derivedJobId(WS, "nightly")));
    await push({}, [jobFilePath("nightly")]);
    await syncDbtConfigFromRepo(WS);
    expect(await DbtJob.findById(oldId)).toBeNull();
    // History stays with the deleted job's id (runs keep their history).
    expect(await DbtRun.countDocuments({ jobId: oldId })).toBe(2);
    await push({ [jobFilePath("nightly")]: jobYaml("Reborn", "reborn") });
    await syncDbtConfigFromRepo(WS);
    const reborn = await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    });
    expect(reborn).not.toBeNull();
    expect(String(reborn!._id)).not.toBe(oldId);
    expect(await DbtRun.countDocuments({ jobId: reborn!._id })).toBe(0);
    expect(await resolves("nightly")).toBe(String(reborn!._id));
    expect(await resolves(oldId)).toBeNull();
    expect(await loadLiveJobById(project, oldId)).toBeNull();
  });
});

// ---- roles ----------------------------------------------------------------

describe("roles", () => {
  it("UI route: owner and admin may rename a job; editor and viewer get 403; a non-member gets 403", async () => {
    const row = await seedJob("nightly", "Nightly");
    for (const [who, status] of [
      [OWNER, 200],
      [ADMIN, 200],
      [EDITOR, 403],
      [VIEWER, 403],
      [STRANGER, 403],
    ] as const) {
      const out = await renameVia(
        "rest",
        { ref: String(row._id), title: `N ${who.slice(-4)}` },
        who,
      );
      expect(out.status, who).toBe(status);
    }
    expect((await DbtJob.findById(row._id))?.name).toBe(`N ${ADMIN.slice(-4)}`);
  });

  it("agent tool: the caller's live role decides (member/viewer refused)", async () => {
    const row = await seedJob("nightly", "Nightly");
    for (const who of [EDITOR, VIEWER]) {
      const out = await renameVia("tool", { ref: "nightly", title: "X" }, who);
      expect(out.ok, who).toBe(false);
      expect(out.error).toMatch(/admin|owner|read-only|not allowed/i);
    }
    expect((await DbtJob.findById(row._id))?.name).toBe("Nightly");
  });

  it("MCP: a key with only `mcp query:read` is refused for dbt jobs (warehouse-write); with warehouse:write an admin's key may; a member's may not", async () => {
    const row = await seedJob("nightly", "Nightly");
    const readOnly = await mcpCall(
      { kind: "dbt_job", ref: "nightly", title: "X" },
      { userId: ADMIN, memberRole: "admin", scopes: ["mcp", "query:read"] },
    );
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toMatch(/warehouse-write/);
    const member = await renameVia(
      "mcp",
      { ref: "nightly", title: "X" },
      EDITOR,
    );
    expect(member.ok).toBe(false);
    const admin = await renameVia(
      "mcp",
      { ref: "nightly", slug: "nightly-2" },
      ADMIN,
    );
    expect(admin.error).toBeUndefined();
    expect(await jobState(row._id)).toMatchObject({
      slug: "nightly-2",
      name: "Nightly",
    });
  });

  it("resolve: every member reads it (viewer included); a non-member gets 403; never another workspace's job", async () => {
    const row = await seedJob("nightly", "Nightly");
    await renameVia("rest", { ref: "nightly", slug: "nightly-2" });
    const url = (ref: string, ws = WS) =>
      `/api/workspaces/${ws}/objects/resolve?kind=dbt_job&ref=${encodeURIComponent(ref)}`;
    for (const who of [OWNER, VIEWER, EDITOR]) {
      const res = await rest("GET", url("nightly"), who);
      expect(res.status, who).toBe(200);
      expect(res.json.resolved).toMatchObject({
        id: String(row._id),
        via: "alias",
        current: { slug: "nightly-2", url: jobUrl(String(row._id)) },
      });
    }
    expect((await rest("GET", url("nightly"), STRANGER)).status).toBe(403);
    const mine = WS;
    const myProject = project;
    await freshWorkspace();
    for (const ref of [String(row._id), "nightly", "nightly-2"]) {
      expect((await rest("GET", url(ref), OWNER)).status, ref).toBe(404);
    }
    WS = mine;
    project = myProject;
  });
});

// ---- links and isolation --------------------------------------------------

describe("links and isolation", () => {
  it("old URL → current; after the old name is reused → the newcomer; ambiguous → nothing", async () => {
    const row = await seedJob("foo", "Foo");
    await renameVia("rest", { ref: "foo", slug: "bar" });
    expect(
      (await resolveDbtJobRef({ workspaceId: WS }, "foo"))?.current.url,
    ).toBe(jobUrl(String(row._id)));
    await push({ [jobFilePath("foo")]: jobYaml("Foo again", "foo-again") });
    await syncDbtConfigFromRepo(WS);
    const newcomer = await DbtJob.findOne({
      projectId: project._id,
      slug: "foo",
    });
    expect(String(newcomer!._id)).not.toBe(String(row._id));
    expect(await resolves("foo")).toBe(String(newcomer!._id));
    expect(await resolves(String(row._id))).toBe(String(row._id));
    // Two files claim one old name and no row holds it: nothing.
    await push({
      [jobFilePath("p")]: jobYaml("P", "p", "aliases: [shared-old]"),
      [jobFilePath("q")]: jobYaml("Q", "q", "aliases: [shared-old]"),
    });
    await syncDbtConfigFromRepo(WS);
    await DbtJob.updateMany(
      { projectId: project._id, slug: { $in: ["p", "q"] } },
      { $unset: { aliases: 1 } },
    );
    expect(await resolves("shared-old")).toBeNull();
    await expectNoSweepNoDuplicate([String(row._id)]);
  });

  it("the same job names in two workspaces never interfere", async () => {
    const wsA = WS;
    const projectA = project;
    const a = await seedJob("shared", "Shared A");
    await freshWorkspace();
    const wsB = WS;
    const projectB = project;
    const b = await seedJob("shared", "Shared B");
    const beforeB = await jobState(b._id);
    WS = wsA;
    project = projectA;
    expect((await renameVia("rest", { ref: "shared", slug: "moved" })).ok).toBe(
      true,
    );
    await syncDbtConfigFromRepo(wsA);
    WS = wsB;
    project = projectB;
    await syncDbtConfigFromRepo(wsB);
    expect(await expectSameJob(beforeB)).toMatchObject({
      slug: "shared",
      aliases: [],
    });
    expect(await resolves("shared")).toBe(String(b._id));
    expect(await resolves("moved")).toBeNull();
    WS = wsA;
    project = projectA;
    expect(await resolves("shared")).toBe(String(a._id));
  });
});
