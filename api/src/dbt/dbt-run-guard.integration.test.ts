/**
 * triggerDbtRun protected-environment guard — integration.
 *
 * Real service + real Mongoose models against mongodb-memory-server; only
 * Inngest is mocked. Verifies the ad-hoc/job asymmetry end-to-end:
 *
 *  - ad-hoc (agent/manual, no jobId) warehouse writes into the prod-like
 *    environment of a repo-connected project are refused BEFORE a run doc is
 *    created or an event is sent (uncommitted drafts can never deploy prod);
 *  - job runs, read-only ad-hoc commands, non-prod targets, and blank
 *    (repo-less) projects keep working.
 */
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

vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })) },
}));

import { inngest } from "../inngest/client";
import { triggerDbtRun, triggerDbtJobRun } from "./dbt-run.service";
import { DbtProtectedEnvironmentError } from "./dbt-environments.service";
import { DbtJob, DbtProject, DbtRun } from "../database/workspace-schema";

const sendMock = inngest.send as unknown as ReturnType<typeof vi.fn>;

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
  vi.clearAllMocks();
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtRun.deleteMany({}),
    DbtJob.deleteMany({}),
  ]);
});

function envs() {
  return [
    {
      name: "dev",
      connectionId: new Types.ObjectId(),
      targetSchema: "dbt_dev",
      threads: 4,
    },
    {
      name: "prod",
      connectionId: new Types.ObjectId(),
      targetSchema: "dbt_prod",
      threads: 4,
    },
  ];
}

async function seedProject(opts: { repo?: boolean } = {}) {
  return DbtProject.create({
    workspaceId: WS,
    name: `p-${new Types.ObjectId().toString()}`,
    environments: envs(),
    defaultEnvironment: "dev",
    createdBy: "u1",
    ...(opts.repo === false
      ? {}
      : { repo: { owner: "acme", repo: "analytics", branch: "main" } }),
  });
}

function adhocParams(projectId: string, environment: string) {
  return {
    workspaceId: WS.toString(),
    projectId,
    environment,
    commands: ["build --select stg_orders --full-refresh"],
    trigger: "agent" as const,
    triggeredBy: "agent",
    workingTreeUserId: "u1",
  };
}

describe("triggerDbtRun protected-environment guard", () => {
  it("refuses an ad-hoc warehouse write into prod on a repo project", async () => {
    const project = await seedProject();
    await expect(
      triggerDbtRun(adhocParams(project._id.toString(), "prod")),
    ).rejects.toThrow(DbtProtectedEnvironmentError);
    // Nothing persisted, nothing enqueued.
    expect(await DbtRun.countDocuments({})).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("allows the same ad-hoc build against a non-prod environment", async () => {
    const project = await seedProject();
    const run = await triggerDbtRun(adhocParams(project._id.toString(), "dev"));
    expect(run.status).toBe("queued");
    expect(run.commands).toEqual(["build --select stg_orders --full-refresh"]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("allows read-only ad-hoc commands against prod", async () => {
    const project = await seedProject();
    const run = await triggerDbtRun({
      ...adhocParams(project._id.toString(), "prod"),
      commands: ["compile --select stg_orders"],
    });
    expect(run.status).toBe("queued");
  });

  it("allows prod runs through a saved job (the sanctioned deploy path)", async () => {
    const project = await seedProject();
    const job = await DbtJob.create({
      workspaceId: WS,
      projectId: project._id,
      name: "Deploy prod",
      environment: "prod",
      commands: ["build --full-refresh"],
      enabled: true,
      createdBy: "u1",
    });
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
    });
    expect(run.status).toBe("queued");
    expect(run.jobId?.toString()).toBe(job._id.toString());
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("exempts projects without a repo binding", async () => {
    const project = await seedProject({ repo: false });
    const run = await triggerDbtRun({
      ...adhocParams(project._id.toString(), "prod"),
      workingTreeUserId: undefined,
    });
    expect(run.status).toBe("queued");
  });
});
