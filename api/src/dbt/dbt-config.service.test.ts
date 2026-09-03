/**
 * dbt orchestration config as files (apps.md §23): write-through, push-sync
 * reconciliation, adoption. Real bare repo + mongodb-memory-server.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { DbtJob, DbtProject } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import {
  DBT_ENVIRONMENTS_PATH,
  jobFilePath,
  parseJobFile,
  serializeJobFile,
} from "./dbt-config-files";
import {
  adoptDbtConfig,
  commitDbtJobFile,
  deleteDbtJobFile,
  loadLiveJobById,
  loadLiveJobs,
  liveJobToPlain,
  reserveJobSlug,
  syncDbtConfigFromRepo,
} from "./dbt-config.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-config-test-"));
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
      { name: "dev", connectionId: CONN, targetSchema: "dbt_dev", threads: 4 },
      {
        name: "prod",
        connectionId: CONN,
        targetSchema: "dbt_prod",
        threads: 8,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "u1",
  });
}

async function seedJob(project: { _id: Types.ObjectId }, name: string) {
  return DbtJob.create({
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
}

async function fileAt(rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS.toString()), MAIN, rel);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

describe("format round-trip", () => {
  it("serialize/parse preserves the definition", () => {
    const file = {
      name: "Nightly build",
      environment: "prod",
      commands: ["build --select realadvisor", "test"],
      schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      deferToProduction: true,
    };
    expect(parseJobFile(serializeJobFile(file))).toEqual(file);
  });

  it("rejects half a schedule and empty commands", () => {
    expect(parseJobFile("name: x\nenvironment: e\ncommands: []\n")).toBeNull();
    expect(
      parseJobFile(
        "name: x\nenvironment: e\ncommands: [build]\nschedule:\n  cron: '* * * * *'\n",
      ),
    ).toBeNull();
  });
});

describe("write-through", () => {
  it("commitDbtJobFile writes dbt/jobs/<slug>.yml and stamps the sha", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly prod build");
    await commitDbtJobFile(project, job);
    const contents = await fileAt(jobFilePath(job.slug!));
    expect(contents).toContain("Nightly prod build");
    expect(contents).toContain("cron: 0 6 * * *");
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.sourceBlobSha).toBeTruthy();

    await deleteDbtJobFile(project, job.slug);
    expect(await fileAt(jobFilePath(job.slug!))).toBeNull();
  });

  it("commitDbtJobFile throws when there is no GitHub repo bound and does not stamp the row", async () => {
    // No binding → 412, even if a leftover local git directory exists.
    await unbindTestWorkspaceRepo(WS.toString());
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await expect(commitDbtJobFile(project, job)).rejects.toMatchObject({
      name: "RepoRequiredError",
      status: 412,
    });
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.sourceBlobSha).toBeFalsy();
  });
});

describe("GET/list from git", () => {
  it("returns empty for unbound leftover git and Mongo", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Mongo only");
    await commitDbtJobFile(project, job);
    await unbindTestWorkspaceRepo(WS.toString());
    expect(await loadLiveJobs(project)).toEqual([]);
  });

  it("includes git-only jobs and omits Mongo-only rows", async () => {
    const project = await seedProject();
    await seedJob(project, "Mongo only");
    const contents = serializeJobFile({
      name: "Git only",
      environment: "prod",
      commands: ["build"],
      schedule: null,
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath("git-only")]: contents } },
      { message: "git-only job" },
    );
    const live = await loadLiveJobs(project);
    expect(live.map(job => job.def.slug)).toEqual(["git-only"]);
    expect(live[0]?.row).toBeNull();
    expect(liveJobToPlain(live[0]!, project)).toMatchObject({
      name: "Git only",
    });
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("resyncs a stale existing row without creating or scheduling", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await commitDbtJobFile(project, job);
    const edited = serializeJobFile({
      name: "Renamed in git",
      environment: "prod",
      commands: ["test"],
      schedule: null,
      enabled: false,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: edited } },
      { message: "edit job" },
    );
    const live = await loadLiveJobs(project);
    expect(liveJobToPlain(live[0]!, project).name).toBe("Renamed in git");
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.commands).toEqual(["test"]);
    expect(fresh?.scheduledRun?.nextAt).toBeUndefined();
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("keeps last-good fields but never presents invalid YAML as live", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await commitDbtJobFile(project, job);
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: "name: [broken" } },
      { message: "break yaml" },
    );
    const live = await loadLiveJobs(project);
    const plain = liveJobToPlain(live[0]!, project);
    expect(plain.definitionInvalid).toBeTruthy();
    expect(plain.name).toBe("Nightly");
    expect((await DbtJob.findById(job._id))?.commands).toEqual([
      "build --select realadvisor",
    ]);
    expect(await loadLiveJobById(project, job._id.toString())).not.toBeNull();
  });
});

describe("sync from repo", () => {
  it("an external job edit updates the row and re-registers the schedule; runtime fields survive", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly prod build");
    await commitDbtJobFile(project, job);
    await DbtJob.updateOne(
      { _id: job._id },
      { $set: { "scheduledRun.consecutiveFailures": 3 } },
    );

    const edited = serializeJobFile({
      name: "Nightly prod build",
      environment: "prod",
      commands: ["build --select realadvisor --full-refresh"],
      schedule: { cron: "30 5 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: edited } },
      { message: "laptop edit" },
    );
    await syncDbtConfigFromRepo(WS.toString());

    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.commands).toEqual([
      "build --select realadvisor --full-refresh",
    ]);
    expect(fresh?.schedule?.cron).toBe("30 5 * * *");
    expect(fresh?.scheduledRun?.nextAt).toBeInstanceOf(Date);
    expect(fresh?.scheduledRun?.consecutiveFailures).toBe(3);
  });

  it("a removed file removes the job; a disallowed command is skipped", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Doomed job");
    await commitDbtJobFile(project, job);
    const evil = serializeJobFile({
      name: "Evil",
      environment: "prod",
      commands: ["run-operation drop_everything"],
      schedule: null,
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: { [jobFilePath("evil")]: evil },
        deletes: [jobFilePath(job.slug!)],
      },
      { message: "laptop mischief" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    expect(await DbtJob.findById(job._id)).toBeNull();
    expect(await DbtJob.findOne({ slug: "evil" })).toBeNull();
  });

  it("environments.yml edits reach the project row", async () => {
    const project = await seedProject();
    await adoptDbtConfig(WS.toString());
    const raw = (await fileAt(DBT_ENVIRONMENTS_PATH))!;
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [DBT_ENVIRONMENTS_PATH]: raw.replace(
            "target_schema: dbt_dev",
            "target_schema: dbt_dev_v2",
          ),
        },
      },
      { message: "laptop env edit" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const fresh = await DbtProject.findById(project._id);
    expect(fresh?.environments.find(e => e.name === "dev")?.targetSchema).toBe(
      "dbt_dev_v2",
    );
  });

  it("invalid job YAML is marked, not overwritten from Mongo", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly prod build");
    await commitDbtJobFile(project, job);
    const before = await DbtJob.findById(job._id);
    const commands = [...(before?.commands ?? [])];
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath(job.slug!)]: "this: is: not: valid: yaml: [",
        },
      },
      { message: "typo" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const after = await DbtJob.findById(job._id);
    expect(after?.definitionInvalid?.reason).toMatch(/unparseable/i);
    expect(after?.enabled).toBe(false);
    expect(after?.commands).toEqual(commands);
  });
});

describe("adoption", () => {
  it("writes files for unstamped jobs + environments once, re-runnable", async () => {
    const project = await seedProject();
    await DbtJob.create({
      workspaceId: WS,
      projectId: project._id,
      name: "Legacy job",
      environment: "dev",
      commands: ["build"],
      enabled: true,
      createdBy: "u1",
    });
    const first = await adoptDbtConfig(WS.toString());
    expect(first).toEqual({ jobs: 1, written: 2 });
    const row = await DbtJob.findOne({ name: "Legacy job" });
    expect(row?.slug).toBe("legacy-job");
    expect(await fileAt(jobFilePath("legacy-job"))).toContain("Legacy job");
    expect(await fileAt(DBT_ENVIRONMENTS_PATH)).toContain("dbt_prod");
    const again = await adoptDbtConfig(WS.toString());
    expect(again.written).toBe(0);
  });
});
