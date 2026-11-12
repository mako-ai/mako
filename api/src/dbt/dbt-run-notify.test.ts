/**
 * dbt job run notifications: the terminal event, rule matching (job rule,
 * project default, both), cadence, idempotency and the outbound payload.
 *
 * Real models against mongodb-memory-server; only Inngest is mocked.
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
import {
  DbtJob,
  DbtProject,
  DbtRun,
  NotificationDelivery,
  NotificationRule,
  type DbtRunStatus,
  type IDbtRunStepResult,
  type NotificationResourceType,
  type NotificationTrigger,
} from "../database/workspace-schema";
import {
  buildOutboundPayload,
  fanOutTerminalRunNotifications,
  sanitizeRuleForClient,
} from "../services/flow-run-notification.service";
import type {
  FlowRunTerminalEventData,
  NotificationDeliverJobData,
} from "../services/flow-run-notification.types";
import {
  buildDbtRunTerminalEvent,
  dbtJobAutoDisabledEventId,
  dbtRunTerminalEventId,
  emitDbtJobAutoDisabledEvent,
  emitDbtRunTerminalEvent,
} from "./dbt-run-notify";
import {
  buildDbtSlackText,
  dbtOutcomeWord,
  dbtSummaryLine,
} from "../services/flow-run-notification.helpers";
import { renderEmail } from "../emails/render";
import { RunNotificationTemplate } from "../emails/RunNotificationEmail";

const sendMock = inngest.send as unknown as ReturnType<typeof vi.fn>;

interface SentEvent {
  id?: string;
  name: string;
  data: unknown;
}

function sentEvents(name: string): SentEvent[] {
  return sendMock.mock.calls
    .map(call => call[0] as SentEvent)
    .filter(event => event.name === name);
}

function deliveries(): NotificationDeliverJobData[] {
  return sentEvents("notification/deliver").map(
    event => event.data as NotificationDeliverJobData,
  );
}

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
let projectId: Types.ObjectId;
let jobId: Types.ObjectId;
let clock = Date.parse("2026-01-01T00:00:00.000Z");

async function seedRun(
  status: DbtRunStatus,
  options: {
    job?: Types.ObjectId | null;
    stepResults?: IDbtRunStepResult[];
    error?: string;
    trigger?: "schedule" | "manual" | "agent";
  } = {},
): Promise<string> {
  clock += 60_000;
  const createdAt = new Date(clock);
  const run = await DbtRun.create({
    workspaceId: WS,
    projectId,
    ...(options.job === null ? {} : { jobId: options.job ?? jobId }),
    environment: "prod",
    commands: ["build"],
    status,
    trigger: options.trigger ?? "schedule",
    triggeredBy: "scheduler",
    stepResults: options.stepResults ?? [],
    error: options.error,
    completedAt: new Date(clock + 30_000),
    durationMs: 30_000,
    createdAt,
  });
  return run._id.toString();
}

async function seedRule(
  resourceType: NotificationResourceType,
  resourceId: Types.ObjectId,
  options: {
    triggers?: NotificationTrigger[];
    everyFailure?: boolean;
    enabled?: boolean;
  } = {},
): Promise<string> {
  const rule = await NotificationRule.create({
    workspaceId: WS,
    resourceType,
    resourceId,
    enabled: options.enabled ?? true,
    triggers: options.triggers ?? ["failure", "success"],
    ...(options.everyFailure ? { everyFailure: true } : {}),
    channel: { type: "email", recipients: ["alerts@example.com"] },
    createdBy: "tester",
  });
  return rule._id.toString();
}

/** Finish a run the way the executor does: build its event, then fan out. */
async function finishRun(
  status: DbtRunStatus,
  options: Parameters<typeof seedRun>[1] = {},
): Promise<{ runId: string; queued: number }> {
  const runId = await seedRun(status, options);
  const event = await buildDbtRunTerminalEvent(runId);
  if (!event) return { runId, queued: 0 };
  const { deliveriesQueued } = await fanOutTerminalRunNotifications(event);
  return { runId, queued: deliveriesQueued };
}

const FAILED_MODEL: IDbtRunStepResult = {
  uniqueId: "model.shop.fct_orders",
  name: "fct_orders",
  resourceType: "model",
  status: "error",
  executionTimeMs: 1200,
  message: "Database Error: column order_id not found",
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockResolvedValue({ ids: [] });
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtJob.deleteMany({}),
    DbtRun.deleteMany({}),
    NotificationRule.deleteMany({}),
    NotificationDelivery.deleteMany({}),
  ]);
  const project = await DbtProject.create({
    workspaceId: WS,
    name: "shop",
    createdBy: "tester",
  });
  projectId = project._id;
  const job = await DbtJob.create({
    workspaceId: WS,
    projectId,
    name: "Nightly build",
    slug: "nightly-build",
    environment: "prod",
    commands: ["build"],
    createdBy: "tester",
  });
  jobId = job._id;
  process.env.CLIENT_URL = "https://app.example.com";
});

describe("buildDbtRunTerminalEvent", () => {
  it("describes a failed job run", async () => {
    const runId = await seedRun("error", {
      stepResults: [
        FAILED_MODEL,
        {
          ...FAILED_MODEL,
          uniqueId: "model.shop.ok",
          name: "ok",
          status: "success",
        },
        {
          uniqueId: "test.shop.not_null_orders_id",
          name: "not_null_orders_id",
          resourceType: "test",
          status: "fail",
          executionTimeMs: 300,
          message: "Got 3 results, configured to fail if != 0",
        },
      ],
      error: "dbt build exited with code 1",
    });

    const event = await buildDbtRunTerminalEvent(runId);

    expect(event).toMatchObject({
      workspaceId: WS.toString(),
      resourceType: "dbt_job",
      resourceId: jobId.toString(),
      resourceName: "Nightly build",
      projectId: projectId.toString(),
      environment: "prod",
      runId,
      status: "error",
      success: false,
      triggerType: "schedule",
      durationMs: 30_000,
      errorMessage: "dbt build exited with code 1",
      failedStepCount: 2,
      failedSteps: [
        {
          name: "fct_orders",
          resourceType: "model",
          status: "error",
          message: "Database Error: column order_id not found",
        },
        {
          name: "not_null_orders_id",
          resourceType: "test",
          status: "fail",
          message: "Got 3 results, configured to fail if != 0",
        },
      ],
      deepLink: `https://app.example.com/x/${projectId}/job/${jobId}?run=${runId}`,
    });
    expect(event?.previousStatus).toBeUndefined();
  });

  it("keeps 10 failed steps and bounds every message", async () => {
    const runId = await seedRun("error", {
      stepResults: Array.from({ length: 40 }, (_, index) => ({
        ...FAILED_MODEL,
        uniqueId: `model.shop.m${index}`,
        name: `m${index}`,
        message: "y".repeat(5000),
      })),
      error: "z".repeat(5000),
    });

    const event = await buildDbtRunTerminalEvent(runId);

    expect(event?.failedStepCount).toBe(40);
    expect(event?.failedSteps).toHaveLength(10);
    for (const step of event?.failedSteps ?? []) {
      expect(step.message?.length).toBeLessThanOrEqual(300);
    }
    expect(event?.errorMessage?.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(event).length).toBeLessThan(6000);
  });

  it("reports the previous terminal status, ignoring cancelled runs", async () => {
    await seedRun("error");
    await seedRun("cancelled");
    await seedRun("running");
    const runId = await seedRun("success");

    const event = await buildDbtRunTerminalEvent(runId);

    expect(event?.previousStatus).toBe("error");
    expect(event?.success).toBe(true);
    expect(event?.failedSteps).toBeUndefined();
  });

  it("looks at the same job only", async () => {
    const otherJob = await DbtJob.create({
      workspaceId: WS,
      projectId,
      name: "Hourly",
      slug: "hourly",
      environment: "prod",
      commands: ["run"],
      createdBy: "tester",
    });
    await seedRun("error", { job: otherJob._id });
    const runId = await seedRun("error");

    expect((await buildDbtRunTerminalEvent(runId))?.previousStatus).toBe(
      undefined,
    );
  });

  it("returns null for runs that notify nobody", async () => {
    expect(
      await buildDbtRunTerminalEvent(await seedRun("cancelled")),
    ).toBeNull();
    expect(await buildDbtRunTerminalEvent(await seedRun("running"))).toBeNull();
    expect(await buildDbtRunTerminalEvent(await seedRun("queued"))).toBeNull();
    expect(
      await buildDbtRunTerminalEvent(await seedRun("error", { job: null })),
    ).toBeNull();
    expect(
      await buildDbtRunTerminalEvent(new Types.ObjectId().toString()),
    ).toBeNull();
    expect(await buildDbtRunTerminalEvent("not-an-id")).toBeNull();
  });
});

describe("emitDbtRunTerminalEvent", () => {
  it("emits exactly one event for a failed run, with a stable id", async () => {
    const runId = await seedRun("error", { stepResults: [FAILED_MODEL] });

    await emitDbtRunTerminalEvent(runId);

    const events = sentEvents("flow.run.terminal");
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(dbtRunTerminalEventId(runId));
    expect(events[0].data).toMatchObject({
      resourceType: "dbt_job",
      resourceId: jobId.toString(),
      runId,
      success: false,
    });
  });

  it("uses the same event id on a retry, so Inngest keeps one", async () => {
    const runId = await seedRun("error");

    await emitDbtRunTerminalEvent(runId);
    await emitDbtRunTerminalEvent(runId);

    const ids = sentEvents("flow.run.terminal").map(event => event.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("emits nothing for cancelled, active and job-less runs", async () => {
    await emitDbtRunTerminalEvent(await seedRun("cancelled"));
    await emitDbtRunTerminalEvent(await seedRun("running"));
    await emitDbtRunTerminalEvent(await seedRun("error", { job: null }));
    await emitDbtRunTerminalEvent(new Types.ObjectId().toString());

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const runId = await seedRun("error");
    sendMock.mockRejectedValue(new Error("inngest is down"));
    await expect(emitDbtRunTerminalEvent(runId)).resolves.toBeUndefined();

    await expect(emitDbtRunTerminalEvent("not-an-id")).resolves.toBeUndefined();
    await expect(
      emitDbtRunTerminalEvent(undefined as unknown as string),
    ).resolves.toBeUndefined();

    const findSpy = vi.spyOn(DbtRun, "findById").mockImplementation(() => {
      throw new Error("mongo is down");
    });
    try {
      await expect(emitDbtRunTerminalEvent(runId)).resolves.toBeUndefined();
    } finally {
      findSpy.mockRestore();
    }
  });
});

describe("rule matching", () => {
  it("delivers a job rule", async () => {
    const ruleId = await seedRule("dbt_job", jobId);

    const { runId, queued } = await finishRun("error");

    expect(queued).toBe(1);
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0]).toMatchObject({
      ruleId,
      runId,
      trigger: "failure",
      resourceType: "dbt_job",
      resourceId: jobId.toString(),
    });
  });

  it("delivers a project default to every job of the project", async () => {
    const ruleId = await seedRule("dbt_project", projectId);

    const { queued } = await finishRun("error");

    expect(queued).toBe(1);
    expect(deliveries()[0].ruleId).toBe(ruleId);
    // The delivery is logged under the job the run belongs to.
    const row = await NotificationDelivery.findOne({}).lean();
    expect(row?.resourceType).toBe("dbt_job");
    expect(row?.resourceId.toString()).toBe(jobId.toString());
  });

  it("delivers both when a job rule and a project default exist", async () => {
    const jobRule = await seedRule("dbt_job", jobId);
    const projectRule = await seedRule("dbt_project", projectId);

    const { queued } = await finishRun("error");

    expect(queued).toBe(2);
    expect(
      deliveries()
        .map(delivery => delivery.ruleId)
        .sort(),
    ).toEqual([jobRule, projectRule].sort());
  });

  it("skips rules of other jobs, other projects, other workspaces and disabled rules", async () => {
    await seedRule("dbt_job", new Types.ObjectId());
    await seedRule("dbt_project", new Types.ObjectId());
    await seedRule("dbt_job", jobId, { enabled: false });
    await NotificationRule.create({
      workspaceId: new Types.ObjectId(),
      resourceType: "dbt_job",
      resourceId: jobId,
      enabled: true,
      triggers: ["failure"],
      channel: { type: "email", recipients: ["alerts@example.com"] },
      createdBy: "tester",
    });
    // A flow rule that happens to share the id never matches a dbt run.
    await seedRule("flow", jobId);

    const { queued } = await finishRun("error");

    expect(queued).toBe(0);
    expect(deliveries()).toHaveLength(0);
  });

  it("respects the rule's triggers", async () => {
    await seedRule("dbt_job", jobId, { triggers: ["success"] });

    expect((await finishRun("error")).queued).toBe(0);
    expect((await finishRun("success")).queued).toBe(1);
    expect(deliveries()[0].trigger).toBe("success");
  });
});

describe("cadence", () => {
  it("posts the first failure, stays quiet on repeats, posts the recovery once", async () => {
    await seedRule("dbt_job", jobId);

    expect((await finishRun("success")).queued).toBe(0); // healthy, no post
    expect((await finishRun("error")).queued).toBe(1); // first failure
    expect((await finishRun("error")).queued).toBe(0); // repeated failure
    expect((await finishRun("error")).queued).toBe(0);
    expect((await finishRun("success")).queued).toBe(1); // recovery
    expect((await finishRun("success")).queued).toBe(0); // still healthy
    expect((await finishRun("error")).queued).toBe(1); // fails again

    expect(deliveries().map(delivery => delivery.trigger)).toEqual([
      "failure",
      "success",
      "failure",
    ]);
  });

  it("posts when the very first run of a job fails", async () => {
    await seedRule("dbt_project", projectId);

    expect((await finishRun("error")).queued).toBe(1);
  });

  it("ignores a cancelled run between two failures", async () => {
    await seedRule("dbt_job", jobId);

    expect((await finishRun("error")).queued).toBe(1);
    expect((await finishRun("cancelled")).queued).toBe(0);
    expect((await finishRun("error")).queued).toBe(0);
  });

  it("posts every failed run when the rule has everyFailure", async () => {
    await seedRule("dbt_job", jobId, { everyFailure: true });

    expect((await finishRun("error")).queued).toBe(1);
    expect((await finishRun("error")).queued).toBe(1);
    expect((await finishRun("error")).queued).toBe(1);
    expect((await finishRun("success")).queued).toBe(1); // recovery, once
    expect((await finishRun("success")).queued).toBe(0);
  });

  it("applies everyFailure per rule", async () => {
    const loud = await seedRule("dbt_job", jobId, { everyFailure: true });
    await seedRule("dbt_project", projectId);

    expect((await finishRun("error")).queued).toBe(2);
    sendMock.mockClear();
    expect((await finishRun("error")).queued).toBe(1);
    expect(deliveries()[0].ruleId).toBe(loud);
  });

  it("leaves flows and scheduled queries on every run", async () => {
    const flowId = new Types.ObjectId();
    await seedRule("flow", flowId);
    const event = (runId: string): FlowRunTerminalEventData => ({
      workspaceId: WS.toString(),
      resourceType: "flow",
      resourceId: flowId.toString(),
      resourceName: "Orders sync",
      runId,
      status: "failed",
      success: false,
      completedAt: new Date().toISOString(),
    });

    expect(
      (await fanOutTerminalRunNotifications(event("r1"))).deliveriesQueued,
    ).toBe(1);
    expect(
      (await fanOutTerminalRunNotifications(event("r2"))).deliveriesQueued,
    ).toBe(1);
  });
});

describe("auto-disable announcement", () => {
  /** The event the executor emits when `runId` disabled its job. */
  async function disabledEvent(runId: string, failures = 10) {
    sendMock.mockClear();
    await emitDbtJobAutoDisabledEvent(runId, failures);
    const [sent] = sentEvents("flow.run.terminal");
    return sent;
  }

  it("emits one event on the terminal path, with an id of its own", async () => {
    const runId = await seedRun("error", { stepResults: [FAILED_MODEL] });

    const sent = await disabledEvent(runId);

    expect(sentEvents("flow.run.terminal")).toHaveLength(1);
    expect(sent.id).toBe(dbtJobAutoDisabledEventId(runId));
    // Not the run's own id, or Inngest would drop one of the two.
    expect(sent.id).not.toBe(dbtRunTerminalEventId(runId));
    expect(sent.data).toMatchObject({
      resourceType: "dbt_job",
      resourceId: jobId.toString(),
      projectId: projectId.toString(),
      runId,
      success: false,
      jobDisabled: { consecutiveFailures: 10 },
    });
  });

  it("uses the same event id on a retry, so Inngest keeps one", async () => {
    const runId = await seedRun("error");
    await emitDbtJobAutoDisabledEvent(runId, 10);
    await emitDbtJobAutoDisabledEvent(runId, 10);
    const ids = sentEvents("flow.run.terminal").map(event => event.id);
    expect(ids).toEqual([
      dbtJobAutoDisabledEventId(runId),
      dbtJobAutoDisabledEventId(runId),
    ]);
  });

  it("emits nothing for a successful, cancelled, active or job-less run, and never throws", async () => {
    for (const runId of [
      await seedRun("success"),
      await seedRun("cancelled"),
      await seedRun("running"),
      await seedRun("error", { job: null }),
      "not-an-id",
    ]) {
      await emitDbtJobAutoDisabledEvent(runId, 10);
    }
    expect(sentEvents("flow.run.terminal")).toHaveLength(0);

    const runId = await seedRun("error");
    sendMock.mockRejectedValueOnce(new Error("inngest is down"));
    await expect(
      emitDbtJobAutoDisabledEvent(runId, 10),
    ).resolves.toBeUndefined();
  });

  it("reaches a rule on the default cadence, which heard nothing since the first failure", async () => {
    const ruleId = await seedRule("dbt_job", jobId, { triggers: ["failure"] });

    expect((await finishRun("error")).queued).toBe(1); // first failure
    for (let i = 0; i < 8; i++) {
      expect((await finishRun("error")).queued).toBe(0); // silent repeats
    }
    const last = await finishRun("error"); // the 10th: disables the job
    expect(last.queued).toBe(0);

    const sent = await disabledEvent(last.runId);
    const result = await fanOutTerminalRunNotifications(
      sent.data as FlowRunTerminalEventData,
    );

    expect(result.deliveriesQueued).toBe(1);
    const [delivery] = deliveries();
    expect(delivery.ruleId).toBe(ruleId);
    expect(delivery.trigger).toBe("failure");
    expect(delivery.payload.jobDisabled).toEqual({ consecutiveFailures: 10 });
  });

  it("is one more message for an everyFailure rule: the failure and the announcement, each once", async () => {
    await seedRule("dbt_job", jobId, {
      triggers: ["failure"],
      everyFailure: true,
    });
    await finishRun("error");
    const last = await finishRun("error");
    const sent = await disabledEvent(last.runId, 2);
    const event = sent.data as FlowRunTerminalEventData;

    await fanOutTerminalRunNotifications(event);
    // A second fan-out of the same announcement queues nothing new.
    await fanOutTerminalRunNotifications(event);

    const rows = await NotificationDelivery.find({ runId: last.runId }).lean();
    expect(rows.map(row => row.idempotencyKey).sort()).toEqual(
      [
        `dbt_job:${jobId}:${last.runId}:failure:email:${rows[0].ruleId}`,
        `dbt_job:${jobId}:${last.runId}:auto-disabled:failure:email:${rows[0].ruleId}`,
      ].sort(),
    );
    const ids = sentEvents("notification/deliver").map(event => event.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("reaches the project default too, and skips success-only and disabled rules", async () => {
    const projectRule = await seedRule("dbt_project", projectId, {
      triggers: ["failure"],
    });
    await seedRule("dbt_job", jobId, { triggers: ["success"] });
    await seedRule("dbt_job", jobId, {
      triggers: ["failure"],
      enabled: false,
    });
    await seedRun("error");
    const runId = await seedRun("error");

    const sent = await disabledEvent(runId);
    const result = await fanOutTerminalRunNotifications(
      sent.data as FlowRunTerminalEventData,
    );

    expect(result.deliveriesQueued).toBe(1);
    expect(deliveries().map(delivery => delivery.ruleId)).toEqual([
      projectRule,
    ]);
  });

  it("says the job was disabled, after how many failures, and what failed last", async () => {
    await seedRun("error");
    const runId = await seedRun("error", { stepResults: [FAILED_MODEL] });
    const sent = await disabledEvent(runId);
    const payload = buildOutboundPayload({
      event: sent.data as FlowRunTerminalEventData,
      resourceName: "Nightly build",
      trigger: "failure",
    });

    expect(dbtOutcomeWord(payload)).toBe("disabled");
    expect(dbtSummaryLine(payload)).toBe(
      "Disabled after 10 failed runs in a row. No scheduled run starts " +
        "until someone enables the job again.",
    );
    const slack = buildDbtSlackText(payload);
    expect(slack.split("\n")[0]).toBe(
      "*dbt job disabled: Nightly build* (prod)",
    );
    expect(slack).toContain("Disabled after 10 failed runs in a row.");
    expect(slack).toContain("fct_orders (model, error)");
    expect(slack).toContain(`?run=${runId}|Open the run in Mako>`);

    const email = await renderEmail(RunNotificationTemplate, payload);
    expect(email.subject).toBe('Mako: dbt job "Nightly build" disabled (prod)');
    expect(email.text).toContain("Disabled after 10 failed runs in a row.");
  });

  it("leaves a plain failure payload without jobDisabled", async () => {
    const runId = await seedRun("error");
    const event = await buildDbtRunTerminalEvent(runId);
    if (!event) throw new Error("expected an event");
    const payload = buildOutboundPayload({
      event,
      resourceName: "Nightly build",
      trigger: "failure",
    });
    expect(payload).not.toHaveProperty("jobDisabled");
    expect(dbtOutcomeWord(payload)).toBe("failed");
  });
});

describe("idempotency", () => {
  it("keeps one delivery per run and rule when the fan-out runs twice", async () => {
    await seedRule("dbt_job", jobId);
    await seedRule("dbt_project", projectId);
    const runId = await seedRun("error");
    const event = await buildDbtRunTerminalEvent(runId);
    if (!event) throw new Error("expected an event");

    await fanOutTerminalRunNotifications(event);
    await fanOutTerminalRunNotifications(event);

    // 2 rules, 2 rows, 2 distinct event ids: Inngest drops the resent pair.
    expect(await NotificationDelivery.countDocuments({})).toBe(2);
    const ids = sentEvents("notification/deliver").map(sent => sent.id);
    expect(ids.every(id => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    const keys = deliveries().map(delivery => delivery.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("queues nothing once the delivery has been sent", async () => {
    await seedRule("dbt_job", jobId);
    const runId = await seedRun("error");
    const event = await buildDbtRunTerminalEvent(runId);
    if (!event) throw new Error("expected an event");

    await fanOutTerminalRunNotifications(event);
    await NotificationDelivery.updateMany({}, { $set: { status: "sent" } });
    sendMock.mockClear();
    const again = await fanOutTerminalRunNotifications(event);

    expect(again.deliveriesQueued).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(await NotificationDelivery.countDocuments({})).toBe(1);
  });

  it("sends again when an earlier attempt stopped between the row and the send", async () => {
    await seedRule("dbt_job", jobId);
    const runId = await seedRun("error");
    const event = await buildDbtRunTerminalEvent(runId);
    if (!event) throw new Error("expected an event");

    sendMock.mockRejectedValueOnce(new Error("inngest is down"));
    await expect(fanOutTerminalRunNotifications(event)).rejects.toThrow();
    const retry = await fanOutTerminalRunNotifications(event);

    expect(retry.deliveriesQueued).toBe(1);
    expect(await NotificationDelivery.countDocuments({})).toBe(1);
  });

  it("keys a delivery on the run and the rule", async () => {
    const ruleId = await seedRule("dbt_job", jobId);

    const { runId } = await finishRun("error");

    expect(deliveries()[0].idempotencyKey).toBe(
      `dbt_job:${jobId}:${runId}:failure:email:${ruleId}`,
    );
  });
});

describe("outbound payload", () => {
  it("carries the failing steps and the run link on failure", async () => {
    await seedRule("dbt_job", jobId);

    const { runId } = await finishRun("error", {
      stepResults: [FAILED_MODEL],
      error: "dbt build exited with code 1",
      trigger: "manual",
    });

    const payload = deliveries()[0].payload;
    expect(payload).toEqual({
      version: 1,
      event: "flow.run.terminal",
      trigger: "failure",
      resourceType: "dbt_job",
      resourceId: jobId.toString(),
      resourceName: "Nightly build",
      runId,
      completedAt: expect.any(String),
      durationMs: 30_000,
      errorMessage: "dbt build exited with code 1",
      triggerType: "manual",
      workspaceId: WS.toString(),
      deepLink: `https://app.example.com/x/${projectId}/job/${jobId}?run=${runId}`,
      projectId: projectId.toString(),
      environment: "prod",
      failedSteps: [
        {
          name: "fct_orders",
          resourceType: "model",
          status: "error",
          message: "Database Error: column order_id not found",
        },
      ],
      failedStepCount: 1,
    });
  });

  it("marks a recovery and carries no failure detail", async () => {
    await seedRule("dbt_job", jobId);
    await finishRun("error", { stepResults: [FAILED_MODEL] });
    sendMock.mockClear();

    await finishRun("success");

    const payload = deliveries()[0].payload;
    expect(payload.trigger).toBe("success");
    expect(payload.recovered).toBe(true);
    expect(payload.failedSteps).toBeUndefined();
    expect(payload.errorMessage).toBeUndefined();
  });

  it("masks credentials quoted in dbt messages", async () => {
    await seedRule("dbt_job", jobId);

    await finishRun("error", {
      stepResults: [
        {
          ...FAILED_MODEL,
          message:
            "could not connect to postgresql://dbt:s3cretpassw0rd@db.example.com/app",
        },
      ],
      error: "connection failed password=s3cretpassw0rd",
    });

    expect(JSON.stringify(deliveries()[0].payload)).not.toContain(
      "s3cretpassw0rd",
    );
  });

  it("builds a dbt payload for the test route without a run", () => {
    const payload = buildOutboundPayload({
      event: {
        workspaceId: WS.toString(),
        resourceType: "dbt_project",
        resourceId: projectId.toString(),
        runId: "test-run",
        status: "failed",
        success: false,
        completedAt: new Date().toISOString(),
      },
      resourceName: "shop",
      trigger: "failure",
    });

    expect(payload.deepLink).toBe(
      `https://app.example.com/x/${projectId}/runs`,
    );
    expect(payload.projectId).toBe(projectId.toString());
    expect(payload.failedSteps).toEqual([]);
  });
});

describe("sanitizeRuleForClient", () => {
  it("returns everyFailure for dbt rules only", async () => {
    await seedRule("dbt_job", jobId, { everyFailure: true });
    await seedRule("dbt_project", projectId);
    await seedRule("flow", new Types.ObjectId());
    const rules = await NotificationRule.find({}).sort({ createdAt: 1 });

    expect(sanitizeRuleForClient(rules[0]).everyFailure).toBe(true);
    expect(sanitizeRuleForClient(rules[1]).everyFailure).toBe(false);
    expect("everyFailure" in sanitizeRuleForClient(rules[2])).toBe(false);
  });
});
