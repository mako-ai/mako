/**
 * Renaming a DBT JOB, end to end: real git (a bare workspace repo, a laptop
 * clone, a `file://` mirror, a second instance's clone) and real Mongo.
 *
 * The invariant: the job is the SAME job. Same id (its URL), schedule and
 * scheduler claim, failure counters and run history; never a delete plus a
 * create.
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
const hooks = vi.hoisted(() => ({
  afterFreshen: null as null | (() => Promise<void>),
  beforeCommit: null as null | (() => Promise<void>),
  queuedPushes: 0,
  realtime: [] as string[],
}));
const once = (key: "afterFreshen" | "beforeCommit") => {
  const fn = hooks[key];
  hooks[key] = null;
  return fn ? fn() : Promise.resolve();
};
vi.mock("../../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/cloud-repo.service")>();
  return {
    ...actual,
    // Held, never run: a test lands the push itself (`mirrorPushNow`).
    queueMirrorPush: () => {
      hooks.queuedPushes++;
    },
    freshenBeforeMainWrite: async (workspaceId: string) => {
      await actual.freshenBeforeMainWrite(workspaceId);
      await once("afterFreshen");
    },
  };
});
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      await once("beforeCommit");
      return actual.commitBlobsOnBranch(...args);
    },
  };
});
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn((_ws: string, event: { type: string }) => {
    hooks.realtime.push(event.type);
  }),
}));

import {
  DbtJob,
  DbtProject,
  DbtRun,
  RetiredObjectId,
  type IDbtProject,
} from "../../database/workspace-schema";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../../apps/repository.service";
import {
  commitDbtJobFile,
  deleteDbtJobFile,
  listJobDefinitionsAtMain,
  loadLiveJobs,
  removeDbtJobRow,
  syncDbtConfigFromRepo,
} from "../../dbt/dbt-config.service";
import { renameObject, resolveObjectRef } from "../registry";
import { SlugFileConflictError } from "../slug-file-rename";
import { RenameError } from "../types";
import {
  Laptop,
  commitCountOf,
  fileAtMain,
  pathsAtMain,
  pathsTouchedBy,
  seedMirror,
  tmpRootFor,
} from "./scenario-rig";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let remotesRoot: string;
let WS: string;
let project: IDbtProject;
const NEXT_AT = new Date("2026-12-01T06:00:00.000Z");
const admin = () => ({ workspaceId: WS, userId: "admin1", role: "admin" });

function jobYaml(name: string, select: string, extra?: string): string {
  return [
    `name: ${name}`,
    ...(extra ? [extra] : []),
    "environment: prod",
    "commands:",
    `  - build --select ${select}`,
    "schedule:",
    "  cron: 0 6 * * *",
    "  timezone: Europe/Zurich",
    "enabled: true",
    "",
  ].join("\n");
}

async function push(writes: Record<string, string>, deletes: string[] = []) {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message: "laptop push" },
  );
}

/** A synced job with a life behind it: a scheduler claim, counters, a run. */
async function seedJob(slug: string, contents = jobYaml(slug, slug)) {
  await push({ [`dbt/jobs/${slug}.yml`]: contents });
  await syncDbtConfigFromRepo(WS);
  const row = await DbtJob.findOne({ projectId: project._id, slug });
  expect(row, `seeded ${slug}`).not.toBeNull();
  await DbtJob.updateOne(
    { _id: row!._id },
    {
      $set: {
        scheduledRun: {
          nextAt: NEXT_AT,
          lastStatus: "error",
          runCount: 7,
          consecutiveFailures: 2,
        },
      },
    },
  );
  await DbtRun.create({
    workspaceId: project.workspaceId,
    projectId: project._id,
    jobId: row!._id,
    environment: "prod",
    commands: ["build"],
    status: "success",
    trigger: "schedule",
    triggeredBy: "scheduler",
  });
  hooks.realtime.length = 0;
  return (await DbtJob.findById(row!._id))!;
}

/** Everything a rename must leave exactly as it was. */
async function job(id: Types.ObjectId | string) {
  const row = await DbtJob.findById(id).lean();
  expect(row, `job ${String(id)} still exists`).not.toBeNull();
  return {
    id: String(row!._id),
    schedule: row!.schedule,
    enabled: row!.enabled,
    scheduledRun: row!.scheduledRun,
    runs: await DbtRun.countDocuments({ jobId: row!._id }),
  };
}

async function expectUntouched(before: Awaited<ReturnType<typeof job>>) {
  expect(await job(before.id)).toEqual(before);
  expect(before.scheduledRun).toMatchObject({ runCount: 7, nextAt: NEXT_AT });
  const commands = (await DbtJob.find({ projectId: project._id }).lean()).map(
    row => row.commands.join(";"),
  );
  expect(new Set(commands).size, `no duplicate job: ${commands}`).toBe(
    commands.length,
  );
}

const slugOf = async (id: Types.ObjectId | string) =>
  (await DbtJob.findById(id).lean())?.slug;
const resolves = async (ref: string) =>
  (await resolveObjectRef(admin(), "dbt_job", ref))?.id ?? null;
const rename = (
  request: { ref: string; title?: string; slug?: string },
  ctx: { workspaceId: string; userId?: string; role?: string } = admin(),
) => renameObject(ctx, "dbt_job", request);
const refused = async (run: Promise<unknown>) => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RenameError);
  return (error as RenameError).status;
};

beforeAll(async () => {
  tmpRoot = await tmpRootFor("dbt-job-rename-scenarios");
  remotesRoot = path.join(tmpRoot, "remotes");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotesRoot}`;
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
  Object.assign(hooks, { afterFreshen: null, beforeCommit: null });
  hooks.queuedPushes = 0;
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "instance-a");
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  await fs.rm(remotesRoot, { recursive: true, force: true });
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtJob.deleteMany({}),
    DbtRun.deleteMany({}),
    RetiredObjectId.deleteMany({}),
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
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_prod",
        threads: 8,
      },
    ],
    defaultEnvironment: "prod",
    createdBy: "u1",
  });
});

describe("renaming through the service", () => {
  it("title + slug: one commit moves the file and lists the old name; the row is re-keyed in place", async () => {
    const annotated = jobYaml("Nightly", "marts").replace(
      "environment: prod",
      "environment: prod # the warehouse",
    );
    const row = await seedJob("nightly", annotated);
    const before = await job(row._id);
    const commits = await commitCountOf(WS);

    const result = await rename({
      ref: "nightly",
      title: "Nightly marts",
      slug: "nightly-marts",
    });

    expect(result).toMatchObject({
      id: before.id,
      aliasesAdded: ["nightly"],
      warnings: [],
      after: {
        title: "Nightly marts",
        slug: "nightly-marts",
        path: "dbt/jobs/nightly-marts.yml",
        url: `/x/${String(project._id)}/job/${before.id}`,
      },
    });
    expect(await commitCountOf(WS)).toBe(commits + 1);
    expect(await pathsTouchedBy(WS, result.commit!)).toEqual([
      "dbt/jobs/nightly-marts.yml",
      "dbt/jobs/nightly.yml",
    ]);
    expect(await fileAtMain(WS, "dbt/jobs/nightly-marts.yml")).toBe(
      annotated.replace(
        "name: Nightly",
        "name: Nightly marts\naliases:\n  - nightly",
      ),
    );
    expect(await DbtJob.findById(before.id).lean()).toMatchObject({
      slug: "nightly-marts",
      name: "Nightly marts",
      aliases: ["nightly"],
    });
    await expectUntouched(before);
    for (const ref of [before.id, "nightly-marts", "nightly"]) {
      expect(await resolves(ref)).toBe(before.id);
    }
    expect(hooks.realtime).toEqual(["dbt.job.updated"]);
    expect(hooks.queuedPushes).toBeGreaterThan(0);
    // A later save keeps the old name in the file (it writes the whole file).
    const edited = (await DbtJob.findById(before.id))!;
    edited.commands = ["build --select marts+"];
    await commitDbtJobFile(project, edited, "admin1");
    expect(await fileAtMain(WS, "dbt/jobs/nightly-marts.yml")).toContain(
      "aliases:\n  - nightly\n",
    );
  });

  it("takes the admin or owner role, the name rules, and a free name", async () => {
    const row = await seedJob("nightly");
    await seedJob("hourly");
    const commits = await commitCountOf(WS);
    const as = (role: string) => ({ workspaceId: WS, userId: "u2", role });
    for (const role of ["member", "viewer"]) {
      expect(
        await refused(rename({ ref: "nightly", title: "X" }, as(role))),
      ).toBe(403);
    }
    const cases: Array<[Record<string, string>, number]> = [
      [{ ref: "nightly", title: "x".repeat(129) }, 400],
      [{ ref: "nightly", slug: "aux" }, 400],
      [{ ref: "nightly", slug: "hourly" }, 409],
      [{ ref: "missing", title: "X" }, 404],
    ];
    for (const [request, status] of cases) {
      expect(
        await refused(rename(request as { ref: string })),
        JSON.stringify(request),
      ).toBe(status);
    }
    expect(await commitCountOf(WS)).toBe(commits);
    // Names YAML would read as a number or a boolean stay strings.
    for (const slug of ["2026", "true", "012"]) {
      await rename({ ref: String(row._id), slug, title: slug });
    }
    expect(await DbtJob.findById(row._id).lean()).toMatchObject({
      slug: "012",
      name: "012",
      aliases: ["nightly", "2026", "true"],
    });
    // A workspace key (no person behind it) may, as on the job routes.
    await rename({ ref: "012", slug: "nightly" }, { workspaceId: WS });
    expect(await slugOf(row._id)).toBe("nightly");
  });

  it("a committed rename whose row update fails: a warning, and a retry is a no-op", async () => {
    const row = await seedJob("nightly");
    const before = await job(row._id);
    const commits = await commitCountOf(WS);
    const failing = vi
      .spyOn(DbtJob, "updateOne")
      .mockRejectedValueOnce(new Error("away"));
    const result = await rename({ ref: "nightly", slug: "night" });
    failing.mockRestore();
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `The rename is committed (${result.commit!.slice(0, 8)})`,
      ),
    ]);
    expect(await slugOf(row._id)).toBe("nightly");
    const retry = await rename({ ref: before.id, slug: "night" });
    expect(retry.commit).toBeUndefined();
    expect(await commitCountOf(WS)).toBe(commits + 1);
    expect(await slugOf(row._id)).toBe("night");
    await expectUntouched(before);
  });
});

describe("a rename made on a laptop and pushed", () => {
  it("`git mv` is re-keyed in place; delete + recreate is another job", async () => {
    const row = await seedJob("nightly");
    const other = await seedJob("hourly");
    const before = await job(row._id);
    const laptop = await Laptop.clone(WS, tmpRoot);
    await laptop.mv("dbt/jobs/nightly.yml", "dbt/jobs/night.yml");
    await laptop.rm("dbt/jobs/hourly.yml");
    await laptop.write(
      "dbt/jobs/every-hour.yml",
      jobYaml("Every hour", "staging").replace("0 6 * * *", "0 * * * *"),
    );
    await laptop.push("mv nightly night; replace hourly");
    await syncDbtConfigFromRepo(WS);

    expect(await slugOf(row._id)).toBe("night");
    expect(await resolves("nightly")).toBe(before.id);
    await expectUntouched(before);
    expect(hooks.realtime).toContain("dbt.job.updated");
    // Not a rename: the old row is gone, the new job has its own id.
    expect(await DbtJob.findById(other._id)).toBeNull();
    const fresh = await DbtJob.findOne({ slug: "every-hour" }).lean();
    expect(String(fresh!._id)).not.toBe(String(other._id));
    expect(fresh!.scheduledRun?.runCount ?? 0).toBe(0);
    // A new file at the deleted job's name is not given the deleted id.
    await push({ "dbt/jobs/hourly.yml": jobYaml("Hourly again", "again") });
    await syncDbtConfigFromRepo(WS);
    const reborn = await DbtJob.findOne({ slug: "hourly" }).lean();
    expect(String(reborn!._id)).not.toBe(String(other._id));
  });
});

describe("another instance, before the mirror has the rename", () => {
  it("a tree that predates the rename deletes nothing and creates nothing", async () => {
    const row = await seedJob("nightly");
    await seedJob("hourly");
    const before = await job(row._id);
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    await seedMirror(WS, remotesRoot);
    await rename({ ref: "nightly", slug: "night" });
    expect(hooks.queuedPushes).toBeGreaterThan(0);

    // Instance B: a clone of the mirror, which does not have the rename.
    process.env.APPS_GIT_ROOT = path.join(tmpRoot, `instance-b-${WS}`);
    await syncDbtConfigFromRepo(WS);
    expect(await pathsAtMain(WS, "dbt/jobs")).toContain("dbt/jobs/nightly.yml");
    expect(await slugOf(row._id)).toBe("night");
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(2);
    await expectUntouched(before);
    const listed = await loadLiveJobs(project);
    expect(listed.map(item => String(item.id))).toContain(before.id);
    expect(listed).toHaveLength(2);
  });
});

describe("races and scale", () => {
  const deleteJob = async (id: Types.ObjectId) => {
    const doomed = (await DbtJob.findById(id))!;
    await deleteDbtJobFile(project, doomed, "admin1");
    await removeDbtJobRow(doomed);
  };

  it("a rename that lands while a delete is in flight: the delete follows it, and the job stays gone", async () => {
    await seedJob("keeper");
    const row = await seedJob("doomed");
    hooks.afterFreshen = async () => {
      await rename({ ref: "doomed", slug: "moved" });
    };
    await deleteJob(row._id);
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual(["dbt/jobs/keeper.yml"]);
    await syncDbtConfigFromRepo(WS);
    expect(
      (await DbtJob.find({ projectId: project._id })).map(r => r.slug),
    ).toEqual(["keeper"]);
  });

  it("a delete or a save that lands while a rename is in flight refuses the rename; a save after a rename is refused too", async () => {
    await seedJob("keeper");
    const doomed = await seedJob("doomed");
    hooks.beforeCommit = () => deleteJob(doomed._id);
    expect(await refused(rename({ ref: "doomed", slug: "moved" }))).toBe(409);
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual(["dbt/jobs/keeper.yml"]);
    await syncDbtConfigFromRepo(WS);
    expect(await DbtJob.findById(doomed._id)).toBeNull();

    const row = await seedJob("nightly");
    const before = await job(row._id);
    const stale = (await DbtJob.findById(row._id))!;
    stale.commands = ["build --select other"];
    await rename({ ref: "nightly", slug: "night" });
    await expect(commitDbtJobFile(project, stale)).rejects.toBeInstanceOf(
      SlugFileConflictError,
    );
    expect(await pathsAtMain(WS, "dbt/jobs")).toEqual([
      "dbt/jobs/keeper.yml",
      "dbt/jobs/night.yml",
    ]);
    await syncDbtConfigFromRepo(WS);
    await expectUntouched(before);
  });

  it("lists every job file, past a thousand", async () => {
    const writes: Record<string, string> = {};
    for (let i = 0; i < 1001; i++) {
      writes[`dbt/jobs/job-${i}.yml`] = jobYaml(`Job ${i}`, `m${i}`);
    }
    await push(writes);
    expect(await listJobDefinitionsAtMain(WS)).toHaveLength(1001);
  });
});
