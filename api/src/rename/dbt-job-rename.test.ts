/**
 * The dbt job rename service, through its handler: resolution by id, slug
 * and old slug; one commit moving the file and writing the alias; the row
 * keeps its id (and so its URL, run history and scheduler claim); the job
 * PATCH route's permission rule.
 *
 * Same rig as dbt-config.service.test.ts.
 */
import fs from "node:fs/promises";
import os from "node:os";
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

// See flow-rename.test.ts: a hook on the freshen that precedes every main
// commit, to land a competing change in the race window.
const freshenHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../apps/cloud-repo.service")>();
  return {
    ...actual,
    freshenBeforeMainWrite: async (workspaceId: string) => {
      await actual.freshenBeforeMainWrite(workspaceId);
      const fn = freshenHook.fn;
      freshenHook.fn = null;
      if (fn) await fn();
    },
  };
});
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { DbtJob, DbtProject } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  log as gitLog,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { jobFilePath, parseJobFile } from "../dbt/dbt-config-files";
import {
  commitDbtJobFile,
  reserveJobSlug,
  syncDbtConfigFromRepo,
} from "../dbt/dbt-config.service";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { dbtJobRenameHandler } from "./handlers/dbt-job";
import { pickJobByRef } from "./dbt-job-rename";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-job-rename-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([DbtProject.deleteMany({}), DbtJob.deleteMany({})]);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS.toString()), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS.toString());
});

async function seedProject() {
  return DbtProject.create({
    workspaceId: WS,
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
    createdBy: "u1",
  });
}

async function seedJob(project: { _id: Types.ObjectId }, name: string) {
  const job = await DbtJob.create({
    workspaceId: WS,
    projectId: project._id,
    slug: await reserveJobSlug(project._id, name),
    name,
    environment: "prod",
    commands: ["build --select realadvisor"],
    schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
    enabled: true,
    createdBy: "u1",
  });
  await commitDbtJobFile(project as never, job);
  return job;
}

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS.toString()), MAIN, rel)).contents;
  } catch {
    return null;
  }
}

async function commitCount(): Promise<number> {
  return (await gitLog(repoDirFor(WS.toString()), DEFAULT_BRANCH, 100)).length;
}

const apiKey = () => ({ workspaceId: WS.toString() });
const asUser = (role: string) => ({
  workspaceId: WS.toString(),
  userId: "u1",
  role,
});

describe("the lookup rule (pure)", () => {
  it("id → slug → an alias exactly one row claims", () => {
    const a = {
      _id: new Types.ObjectId(),
      slug: "a",
      aliases: ["old"],
      name: "A",
    };
    const b = {
      _id: new Types.ObjectId(),
      slug: "b",
      aliases: ["old"],
      name: "B",
    };
    expect(pickJobByRef([a, b], b._id.toString())?.row).toBe(b);
    expect(pickJobByRef([a, b], "a")).toEqual({ row: a, via: "current" });
    expect(pickJobByRef([a, b], "old")).toBeNull();
    expect(pickJobByRef([a], "old")).toEqual({ row: a, via: "alias" });
  });
});

describe("resolve + rename", () => {
  it("renames in one commit, keeps the id, resolves the old slug; schedule and runs untouched", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly build");
    await DbtJob.updateOne(
      { _id: job._id },
      {
        $set: { "scheduledRun.runCount": 3, "scheduledRun.nextAt": new Date() },
      },
    );
    const commitsBefore = await commitCount();

    const result = await dbtJobRenameHandler.rename(apiKey(), {
      ref: job._id.toString(),
      title: "Nightly",
      slug: "nightly",
    });
    expect(result).toMatchObject({
      kind: "dbt_job",
      id: job._id.toString(),
      before: { slug: "nightly-build", title: "Nightly build" },
      after: {
        slug: "nightly",
        title: "Nightly",
        url: `/x/${project._id}/job/${job._id}`,
      },
      aliasesAdded: ["nightly-build"],
      warnings: [],
    });
    expect(await commitCount()).toBe(commitsBefore + 1);
    expect(await fileAt(jobFilePath("nightly-build"))).toBeNull();
    const file = parseJobFile((await fileAt(jobFilePath("nightly"))) ?? "");
    expect(file).toMatchObject({ name: "Nightly", aliases: ["nightly-build"] });

    const after = await DbtJob.findById(job._id);
    expect(after).toMatchObject({
      slug: "nightly",
      name: "Nightly",
      aliases: ["nightly-build"],
    });
    expect(after?.scheduledRun?.runCount).toBe(3);
    expect(after?.scheduledRun?.nextAt).toBeTruthy();
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);

    const old = await dbtJobRenameHandler.resolve(apiKey(), "nightly-build");
    expect(old).toMatchObject({ id: job._id.toString(), via: "alias" });
    expect((await dbtJobRenameHandler.resolve(apiKey(), "nightly"))?.via).toBe(
      "current",
    );
    expect(await dbtJobRenameHandler.resolve(apiKey(), "nope")).toBeNull();

    // Level with the file: the push-sync after the mirror push is a no-op.
    await syncDbtConfigFromRepo(WS.toString());
    expect((await DbtJob.findById(job._id))?.slug).toBe("nightly");
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("enforces the job PATCH rule: admin/owner only for a user; a workspace key may", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Guarded");
    for (const role of ["viewer", "member", undefined]) {
      await expect(
        dbtJobRenameHandler.rename(asUser(role as string), {
          ref: job._id.toString(),
          title: "Nope",
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
    const ok = await dbtJobRenameHandler.rename(asUser("admin"), {
      ref: "guarded",
      title: "Guarded (admin)",
    });
    expect(ok.after.title).toBe("Guarded (admin)");
    expect((await DbtJob.findById(job._id))?.name).toBe("Guarded (admin)");
  });

  it("refuses taken, aliased and invalid slugs, and an unparseable file", async () => {
    const project = await seedProject();
    const a = await seedJob(project, "A");
    await seedJob(project, "B");
    await dbtJobRenameHandler.rename(apiKey(), { ref: "a", slug: "a-new" });
    await dbtJobRenameHandler.rename(apiKey(), { ref: "b", slug: "b-new" });
    // Renaming BACK to its own old name is allowed (and keeps that name out
    // of its aliases); another job's current slug or old name is not.
    await dbtJobRenameHandler.rename(apiKey(), { ref: "a-new", slug: "a" });
    expect(await DbtJob.findById(a._id)).toMatchObject({
      slug: "a",
      aliases: ["a-new"],
    });
    await dbtJobRenameHandler.rename(apiKey(), { ref: "a", slug: "a-new" });
    for (const [slug, status] of [
      ["b-new", 409],
      ["b", 409], // an old name of b-new
      ["Bad Slug", 400],
    ] as const) {
      await expect(
        dbtJobRenameHandler.rename(apiKey(), { ref: "a-new", slug }),
      ).rejects.toMatchObject({ status });
    }
    expect((await DbtJob.findById(a._id))?.slug).toBe("a-new");

    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath("a-new")]: "name: [broken" } },
      { message: "break it" },
    );
    await expect(
      dbtJobRenameHandler.rename(apiKey(), { ref: "a-new", slug: "a-newer" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fileAt(jobFilePath("a-new"))).toBe("name: [broken");
    expect(await fileAt(jobFilePath("a-newer"))).toBeNull();
    // Seven commits through the freshen/CAS path: comfortably inside 30 s
    // alone, not when the machine runs three suites at once.
  }, 90_000);
});

describe("round 2: a save racing a rename; files edited in place", () => {
  it("[r2-2] a job save overlapping a rename fails (slug re-read, then the file CAS) — never two scheduled jobs", async () => {
    const { runGit } = await import("../apps/git");
    const ls = async () =>
      (
        await runGit([
          "-C",
          repoDirFor(WS.toString()),
          "ls-tree",
          "--name-only",
          "-r",
          DEFAULT_BRANCH,
          "dbt/jobs/",
        ])
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
    const project = await seedProject();
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath("nightly")]:
            "name: Nightly\nenvironment: prod\ncommands:\n  - build --select x\n",
        },
      },
      { message: "push" },
    );
    await syncDbtConfigFromRepo(WS.toString());

    const inFlight = await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    });
    inFlight!.commands = ["build --select y"];
    freshenHook.fn = async () => {
      await dbtJobRenameHandler.rename(apiKey(), {
        ref: "nightly",
        slug: "nightly-2",
      });
    };
    await expect(commitDbtJobFile(project, inFlight!, "u1")).rejects.toThrow(
      /renamed to "nightly-2"/,
    );
    expect(await ls()).toEqual([jobFilePath("nightly-2")]);

    const again = await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly-2",
    });
    again!.commands = ["build --select z"];
    freshenHook.fn = async () => {
      freshenHook.fn = async () => {
        await dbtJobRenameHandler.rename(apiKey(), {
          ref: "nightly-2",
          slug: "nightly-3",
        });
      };
    };
    await expect(commitDbtJobFile(project, again!, "u1")).rejects.toThrow(
      /changed in the workspace repo/,
    );
    expect(await ls()).toEqual([jobFilePath("nightly-3")]);
    freshenHook.fn = null;
    await syncDbtConfigFromRepo(WS.toString());
    const rows = await DbtJob.find({ projectId: project._id });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [inFlight!._id.toString(), "nightly-3"],
    ]);
  });

  it("[r2-4] twelve commands and a comment survive a rename untouched", async () => {
    const project = await seedProject();
    const jobYaml =
      "# nightly prod build\nname: N\nenvironment: prod\ncommands:\n" +
      Array.from({ length: 12 }, (_, i) => `  - build --select m${i}`).join(
        "\n",
      ) +
      "\n";
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath("n")]: jobYaml } },
      { message: "push" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    await dbtJobRenameHandler.rename(apiKey(), {
      ref: "n",
      title: "Nightly",
      slug: "nightly",
    });
    expect(await fileAt(jobFilePath("nightly"))).toBe(
      jobYaml.replace("name: N\n", "name: Nightly\naliases:\n  - n\n"),
    );
    expect(
      (await DbtJob.findOne({ projectId: project._id, slug: "nightly" }))?.name,
    ).toBe("Nightly");
  });
});
