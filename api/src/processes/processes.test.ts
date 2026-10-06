/**
 * Process runtime — what these pin:
 *
 *   - the DSAR reference process end to end: agents → approval (paused, nothing
 *     running) → deterministic destructive steps → verify → artifact;
 *   - memoization: a completed step never re-executes (retries, re-execution
 *     after a wait, "retry run" after a failure);
 *   - the effect ledger: an interrupted destructive call is never re-run
 *     blindly (reconcile, or fail for manual reconciliation);
 *   - approvals (approve/edit/reject), tasks, durable sleeps, event waits,
 *     cancellation, version changes under a waiting run;
 *   - provisioning: agents cannot use destructive tools or tools outside the
 *     envelope;
 *   - the AI SDK harness against a mock model (tool call → submit_result);
 *   - the three vibe-code processes run unchanged on the same runtime.
 *
 * Real Mongo (memory server), LocalEngine, scripted agents.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MockLanguageModelV3 } from "ai/test";
import { setRuntimeDeps } from "./runtime/deps";
import { LocalEngine, setExecutionEngine } from "./runtime/engine";
import {
  HumanRequest,
  ProcessEvent,
  ProcessInstallation,
  ProcessRun,
  ProcessVersion,
} from "./runtime/models";
import { clearVersionCache, extractOutline } from "./runtime/version";
import { registerProcessDefinition, getProcessDefinition } from "./registry";
import {
  cancelRun,
  emitProcessEvent,
  getRunDetail,
  respondToHumanRequest,
  retryRun,
  startRun,
  updateInstallation,
  runDueSchedules,
} from "./service";
import { defineProcess, defineTool, trigger, z, PermanentError } from "./sdk";
import { scriptedHarness, type ScriptApi } from "./agents/scripted-harness";
import { aiSdkHarness } from "./agents/ai-sdk-harness";
import type { AgentHarness } from "./agents/harness";
import { resetSampleSystems, sampleSystems } from "./tools/sample-systems";
import { markProcessRuntimeConfigured } from ".";
import { WorkspaceMember } from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const ADMIN = { id: "user-admin", email: "admin@example.com" };
let clock = new Date("2026-10-05T08:00:00Z");
let engine: LocalEngine;

/** Default harness for tests: dispatch to a per-agent script by step name. */
const scripts = new Map<string, (api: ScriptApi) => Promise<unknown>>();
const dispatchHarness: AgentHarness = {
  id: "test-dispatch",
  run: (req, rt) => {
    const name = [...scripts.keys()].find(k => req.stepKey.startsWith(k));
    if (!name) throw new Error(`No test script for agent step ${req.stepKey}`);
    return scriptedHarness(
      scripts.get(name) as (api: ScriptApi) => Promise<unknown>,
    ).run(req, rt);
  },
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await HumanRequest.syncIndexes();
  await ProcessEvent.syncIndexes();
  await ProcessInstallation.syncIndexes();
  await ProcessRun.syncIndexes();
  await ProcessVersion.syncIndexes();
  await WorkspaceMember.create({
    workspaceId: new Types.ObjectId(WS),
    userId: ADMIN.id,
    role: "owner",
  });
  markProcessRuntimeConfigured();
  setRuntimeDeps({
    defaultHarness: () => dispatchHarness,
    defaultModel: async () => "test/model",
    now: () => clock,
    resolveConnection: async (_ws, id) => ({
      id,
      kind: "database",
      type: "postgres",
      name: "test",
    }),
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  clock = new Date("2026-10-05T08:00:00Z");
  engine = new LocalEngine({ backoffMs: 0, timers: false, now: () => clock });
  setExecutionEngine(engine);
  scripts.clear();
  resetSampleSystems();
  clearVersionCache();
  await Promise.all([
    HumanRequest.deleteMany({}),
    ProcessEvent.deleteMany({}),
    ProcessInstallation.deleteMany({}),
    ProcessRun.deleteMany({}),
    ProcessVersion.deleteMany({}),
  ]);
});

async function settle() {
  await engine.idle();
}

async function runDoc(id: string) {
  return ProcessRun.findById(id).lean();
}

async function pendingRequest(runId: string) {
  return HumanRequest.findOne({
    runId: new Types.ObjectId(runId),
    status: "pending",
  }).lean();
}

async function events(runId: string, type?: string) {
  return ProcessEvent.find({
    runId: new Types.ObjectId(runId),
    ...(type ? { type } : {}),
  })
    .sort({ ts: 1, _id: 1 })
    .lean();
}

// ── DSAR reference ─────────────────────────────────────────────────────────

function dsarScripts() {
  scripts.set("investigate-subject", async a => {
    const crm = (await a.call("crm__contact__search", {
      email: "jane.doe@example.org",
      name: "Jane Doe",
    })) as { contacts: Array<{ id: string }> };
    await a.call("marketing__contact__lookup", {
      email: "jane.doe@example.org",
    });
    const support = (await a.call("support__ticket__search", {
      requesterEmail: "jane.doe@example.org",
    })) as { tickets: Array<{ id: string }> };
    await a.call("billing__customer__lookup", {
      email: "jane.doe@example.org",
    });
    return {
      identityConfidence: "high",
      records: [
        ...crm.contacts.map(c => ({
          system: "crm",
          recordId: c.id,
          matchedOn: "email / name + company",
          dataCategories: ["contact"],
        })),
        ...support.tickets.map(t => ({
          system: "support",
          recordId: t.id,
          matchedOn: "requester email",
          dataCategories: ["support"],
        })),
      ],
      openQuestions: [],
    };
  });
  scripts.set("create-action-plan", async () => ({
    identityConfidence: "high",
    systems: [
      {
        system: "crm",
        recordIds: ["ct_101", "ct_102"],
        dataCategories: ["contact"],
        proposedAction: "delete",
        reason: "Art. 17",
      },
      {
        system: "support",
        recordIds: ["tk_9001", "tk_9002"],
        dataCategories: ["support"],
        proposedAction: "redact",
        reason: "Art. 17",
      },
      {
        system: "marketing",
        recordIds: ["jane.doe@example.org"],
        dataCategories: ["email"],
        proposedAction: "suppress",
        reason: "Honour opt-out",
      },
      {
        system: "billing",
        recordIds: ["cus_77"],
        dataCategories: ["invoices"],
        proposedAction: "retain",
        reason: "Statutory retention",
      },
    ],
    warnings: [],
  }));
  scripts.set("verify-erasure", async a => {
    const crm = (await a.call("crm__contact__search", {
      email: "jane.doe@example.org",
    })) as {
      contacts: unknown[];
    };
    return {
      complete: crm.contacts.length === 0,
      remaining: [],
      summary: "No personal data left outside retained billing records.",
    };
  });
}

describe("DSAR erasure (reference process)", () => {
  it("investigates, pauses for approval, executes once, verifies and reports", async () => {
    dsarScripts();
    const { run } = await startRun({
      workspaceId: WS,
      processId: "dsar-erasure",
      input: {
        requestId: "DSR-1",
        email: "jane.doe@example.org",
        name: "Jane Doe",
        replyTo: "jane.doe@example.org",
      },
      trigger: { type: "manual", by: ADMIN.id },
    });
    await settle();

    // Paused: nothing running, waiting on a human.
    let doc = await runDoc(run.id);
    expect(doc?.status).toBe("waiting");
    expect(doc?.waitingOn?.kind).toBe("approval");
    const request = await pendingRequest(run.id);
    expect(request?.title).toBe("Approve erasure plan");
    expect(sampleSystems(WS).contacts.has("ct_101")).toBe(true); // nothing deleted yet

    // The approver removes ct_102 from the plan (edit), then approves.
    const plan = request?.payload as {
      systems: Array<{ system: string; recordIds: string[] }>;
    };
    const edited = {
      ...plan,
      systems: plan.systems.map(s =>
        s.system === "crm" ? { ...s, recordIds: ["ct_101"] } : s,
      ),
    };
    await respondToHumanRequest(WS, request!._id.toString(), ADMIN, {
      decision: "approve",
      data: edited,
      comment: "Keep the work address record for now",
    });
    await settle();

    doc = await runDoc(run.id);
    expect(doc?.status).toBe("completed");
    expect(doc?.output).toMatchObject({
      requestId: "DSR-1",
      outcome: "erased",
    });

    const state = sampleSystems(WS);
    expect(state.contacts.has("ct_101")).toBe(false);
    expect(state.contacts.has("ct_102")).toBe(true); // edited out by the approver
    expect(state.tickets.get("tk_9001")?.redacted).toBe(true);
    expect(state.marketing.get("jane.doe@example.org")?.suppressed).toBe(true);

    // Each destructive call executed exactly once.
    const destructive = (await events(run.id, "tool.completed")).filter(
      e => e.data.effect === "destructive",
    );
    expect(destructive.map(e => e.data.tool).sort()).toEqual([
      "crm.contact.delete",
      "support.ticket.redact",
      "support.ticket.redact",
    ]);

    // The business timeline, as the UI shows it.
    const detail = await getRunDetail(WS, run.id);
    expect(detail.steps.map(s => [s.name, s.kind, s.status])).toEqual([
      ["Investigate subject", "agent", "completed"],
      ["Create action plan", "agent", "completed"],
      ["Approve erasure plan", "approval", "completed"],
      ["delete in crm", "step", "completed"],
      ["redact in support", "step", "completed"],
      ["suppress in marketing", "step", "completed"],
      ["Verify erasure", "agent", "completed"],
      ["Write report", "step", "completed"],
      ["Send confirmation", "step", "completed"],
    ]);
    const investigate = detail.steps[0];
    expect(investigate.tools.map(t => t.tool)).toEqual([
      "crm.contact.search",
      "marketing.contact.lookup",
      "support.ticket.search",
      "billing.customer.lookup",
    ]);
    expect(investigate.agent?.turns.length).toBeGreaterThan(0);
    expect(detail.steps[7].artifacts[0]?.name).toBe("erasure-report.md");
    const approval = detail.steps[2].output as {
      by: { email: string };
      approved: boolean;
    };
    expect(approval.approved).toBe(true);
    expect(approval.by.email).toBe(ADMIN.email);
    expect(
      detail.events.some(e => e.type === "human.responded" && e.data.edited),
    ).toBe(true);
  });

  it("a rejected plan completes the run without touching any system", async () => {
    dsarScripts();
    const { run } = await startRun({
      workspaceId: WS,
      processId: "dsar-erasure",
      input: { requestId: "DSR-2", email: "jane.doe@example.org" },
      trigger: { type: "manual" },
    });
    await settle();
    const request = await pendingRequest(run.id);
    await respondToHumanRequest(WS, request!._id.toString(), ADMIN, {
      decision: "reject",
      comment: "Identity not verified",
    });
    await settle();
    const doc = await runDoc(run.id);
    expect(doc?.status).toBe("completed");
    expect(doc?.output).toMatchObject({
      outcome: "rejected",
      comment: "Identity not verified",
    });
    expect(sampleSystems(WS).contacts.size).toBe(4);
  });

  it("the outline is derived from the code", () => {
    const outline = extractOutline(
      getProcessDefinition("dsar-erasure")!.run.toString(),
    );
    expect(outline.map(o => `${o.kind}:${o.name}`)).toEqual([
      "agent:Investigate subject",
      "agent:Create action plan",
      "task:Confirm subject identity",
      "approval:Approve erasure plan",
      "step:… in …",
      "agent:Verify erasure",
      "step:Write report",
      "step:Send confirmation",
    ]);
    expect(outline[4].dynamic).toBe(true);
  });
});

// ── memoization, retries, ledger ───────────────────────────────────────────

const counters = { a: 0, b: 0, flaky: 0, fail: true, destructive: 0 };

const destroy = defineTool({
  name: "test.thing.destroy",
  description: "Destroy a thing",
  effect: "destructive",
  input: z.object({ id: z.string() }),
  async execute({ id }) {
    counters.destructive++;
    return { id, destroyed: true };
  },
});

const destroyWithReconcile = defineTool({
  name: "test.thing.destroy_checked",
  description: "Destroy a thing (reconcilable)",
  effect: "destructive",
  input: z.object({ id: z.string() }),
  async execute({ id }) {
    counters.destructive++;
    return { id, destroyed: true };
  },
  async reconcile({ id }) {
    return { done: true, output: { id, destroyed: true } };
  },
});

registerProcessDefinition(
  defineProcess({
    id: "test-memo",
    name: "Memo test",
    triggers: [trigger.manual()],
    input: z.object({}),
    tools: [destroy, destroyWithReconcile],
    run: async ctx => {
      const a = await ctx.step("A", async () => ++counters.a);
      const b = await ctx.step("Flaky", async () => {
        counters.flaky++;
        if (counters.flaky < 3) throw new Error("transient");
        return a + 1;
      });
      await ctx.step("Fails until fixed", async () => {
        counters.b++;
        if (counters.fail) throw new PermanentError("broken");
      });
      return { a, b };
    },
  }),
);

registerProcessDefinition(
  defineProcess({
    id: "test-ledger",
    name: "Ledger test",
    triggers: [trigger.manual()],
    input: z.object({ reconcilable: z.boolean() }),
    tools: [destroy, destroyWithReconcile],
    run: async (ctx, input) =>
      ctx.step("Destroy", s =>
        input.reconcilable
          ? s.call(destroyWithReconcile, { id: "x" })
          : s.call(destroy, { id: "x" }),
      ),
  }),
);

describe("durability", () => {
  beforeEach(() => {
    Object.assign(counters, {
      a: 0,
      b: 0,
      flaky: 0,
      fail: true,
      destructive: 0,
    });
  });

  it("retries a flaky step, fails permanently, then 'retry run' resumes at the failed step", async () => {
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-memo",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    let doc = await runDoc(run.id);
    expect(doc?.status).toBe("failed");
    expect(doc?.error?.stepKey).toBe("fails-until-fixed");
    expect(counters).toMatchObject({ a: 1, flaky: 3, b: 1 }); // PermanentError: no retries

    counters.fail = false;
    await retryRun(WS, run.id, ADMIN.id);
    await settle();
    doc = await runDoc(run.id);
    expect(doc?.status).toBe("completed");
    expect(doc?.output).toEqual({ a: 1, b: 2 });
    // A and Flaky came from the journal, not re-executed.
    expect(counters).toMatchObject({ a: 1, flaky: 3, b: 2 });
    expect(doc?.attempt).toBe(1);
  });

  it("never re-runs an interrupted destructive call without reconcile", async () => {
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-ledger",
      input: { reconcilable: false },
      trigger: { type: "manual" },
    });
    // Simulate a crash mid-call: the ledger says "started", no outcome.
    await ProcessEvent.create({
      runId: new Types.ObjectId(run.id),
      workspaceId: new Types.ObjectId(WS),
      ts: new Date(),
      type: "tool.started",
      stepKey: "destroy",
      data: { tool: "test.thing.destroy", callKey: "destroy:0" },
      dedupeKey: "tool.start:destroy:0",
    });
    await settle();
    const doc = await runDoc(run.id);
    expect(doc?.status).toBe("failed");
    expect(doc?.error?.message).toMatch(/outcome is unknown/);
    expect(counters.destructive).toBe(0);
  });

  it("reconciles an interrupted destructive call instead of repeating it", async () => {
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-ledger",
      input: { reconcilable: true },
      trigger: { type: "manual" },
    });
    await ProcessEvent.create({
      runId: new Types.ObjectId(run.id),
      workspaceId: new Types.ObjectId(WS),
      ts: new Date(),
      type: "tool.started",
      stepKey: "destroy",
      data: { tool: "test.thing.destroy_checked", callKey: "destroy:0" },
      dedupeKey: "tool.start:destroy:0",
    });
    await settle();
    const doc = await runDoc(run.id);
    expect(doc?.status).toBe("completed");
    expect(counters.destructive).toBe(0);
    const completed = await events(run.id, "tool.completed");
    expect(completed[0].data.reconciled).toBe(true);
  });

  it("a completed destructive call is returned from the ledger on step retry", async () => {
    let throwAfter = true;
    registerProcessDefinition(
      defineProcess({
        id: "test-ledger-retry",
        name: "Ledger retry",
        triggers: [trigger.manual()],
        input: z.object({}),
        tools: [destroy],
        run: async ctx =>
          ctx.step("Destroy then fail", async s => {
            await s.call(destroy, { id: "y" });
            if (throwAfter) {
              throwAfter = false;
              throw new Error("crash after the side effect");
            }
            return "ok";
          }),
      }),
    );
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-ledger-retry",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    expect((await runDoc(run.id))?.status).toBe("completed");
    expect(counters.destructive).toBe(1);
  });
});

// ── human, waits, cancel, versions ─────────────────────────────────────────

registerProcessDefinition(
  defineProcess({
    id: "test-human",
    name: "Human test",
    triggers: [trigger.manual(), trigger.event("order.placed")],
    input: z.object({ orderId: z.string() }),
    run: async (ctx, input) => {
      const info = await ctx.task("Provide shipping details", {
        form: z.object({
          carrier: z.enum(["dhl", "ups"]),
          express: z.boolean(),
        }),
      });
      await ctx.wait("Cool-off", { for: "1h" });
      const paid = await ctx.wait<{ amount: number }>("Payment", {
        event: "payment.received",
        match: { orderId: input.orderId },
        timeout: "2d",
      });
      return { carrier: info.data.carrier, paid: paid?.amount ?? null };
    },
  }),
);

describe("human tasks, waits and events", () => {
  it("task → durable sleep → event wait → complete", async () => {
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-human",
      input: { orderId: "o-1" },
      trigger: { type: "manual" },
    });
    await settle();
    expect((await runDoc(run.id))?.waitingOn?.kind).toBe("task");

    const task = await pendingRequest(run.id);
    await expect(
      respondToHumanRequest(WS, task!._id.toString(), ADMIN, {
        decision: "submit",
        data: { carrier: "fedex", express: true },
      }),
    ).rejects.toThrow(/Invalid data/);
    await respondToHumanRequest(WS, task!._id.toString(), ADMIN, {
      decision: "submit",
      data: { carrier: "dhl", express: true },
    });
    await settle();
    let doc = await runDoc(run.id);
    expect(doc?.waitingOn?.kind).toBe("sleep");

    // Not yet: re-executing before the deadline stays asleep.
    await engine.wake(run.id);
    expect((await runDoc(run.id))?.waitingOn?.kind).toBe("sleep");
    clock = new Date(clock.getTime() + 61 * 60_000);
    await engine.wake(run.id);
    doc = await runDoc(run.id);
    expect(doc?.waitingOn).toMatchObject({
      kind: "event",
      event: "payment.received",
    });

    // A non-matching event is ignored; the matching one resumes the run.
    expect(
      (
        await emitProcessEvent(WS, "payment.received", {
          orderId: "o-2",
          amount: 5,
        })
      ).delivered,
    ).toEqual([]);
    const result = await emitProcessEvent(WS, "payment.received", {
      orderId: "o-1",
      amount: 42,
    });
    expect(result.delivered).toEqual([run.id]);
    await settle();
    doc = await runDoc(run.id);
    expect(doc?.status).toBe("completed");
    expect(doc?.output).toEqual({ carrier: "dhl", paid: 42 });
  });

  it("event triggers start only enabled processes, idempotently", async () => {
    expect(
      (await emitProcessEvent(WS, "order.placed", { orderId: "o-9" })).started,
    ).toEqual([]);
    await updateInstallation(WS, "test-human", { enabled: true }, ADMIN.id);
    const first = await emitProcessEvent(
      WS,
      "order.placed",
      { orderId: "o-9" },
      { idempotencyKey: "evt-1" },
    );
    const again = await emitProcessEvent(
      WS,
      "order.placed",
      { orderId: "o-9" },
      { idempotencyKey: "evt-1" },
    );
    expect(first.started).toHaveLength(1);
    expect(again.started).toEqual(first.started);
    expect(await ProcessRun.countDocuments({ processId: "test-human" })).toBe(
      1,
    );
  });

  it("cancelling a waiting run cancels its request and refuses late responses", async () => {
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-human",
      input: { orderId: "o-3" },
      trigger: { type: "manual" },
    });
    await settle();
    const task = await pendingRequest(run.id);
    await cancelRun(WS, run.id, ADMIN.id);
    expect((await runDoc(run.id))?.status).toBe("cancelled");
    await expect(
      respondToHumanRequest(WS, task!._id.toString(), ADMIN, {
        decision: "submit",
        data: { carrier: "ups", express: false },
      }),
    ).rejects.toThrow(/already cancelled/);
  });

  it("only assignees (or admins) may respond", async () => {
    registerProcessDefinition(
      defineProcess({
        id: "test-assignees",
        name: "Assignees",
        triggers: [trigger.manual()],
        input: z.object({}),
        run: async ctx =>
          ctx.approval("Sign off", {
            data: { x: 1 },
            assignees: ["cfo@example.com"],
          }),
      }),
    );
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-assignees",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    const request = await pendingRequest(run.id);
    await expect(
      respondToHumanRequest(WS, request!._id.toString(), ADMIN, {
        decision: "approve",
      }),
    ).rejects.toThrow(/assignees/);
    await respondToHumanRequest(
      WS,
      request!._id.toString(),
      { id: "u-cfo", email: "CFO@example.com" },
      { decision: "approve" },
    );
    await settle();
    expect((await runDoc(run.id))?.output).toMatchObject({
      approved: true,
      outcome: "approved",
    });
  });

  it("an unanswered approval expires into outcome 'expired'", async () => {
    registerProcessDefinition(
      defineProcess({
        id: "test-expiry",
        name: "Expiry",
        triggers: [trigger.manual()],
        input: z.object({}),
        run: async ctx =>
          ctx.approval("Quick yes", { data: {}, timeout: "1h" }),
      }),
    );
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-expiry",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    await engine.wake(run.id);
    const doc = await runDoc(run.id);
    expect(doc?.output).toMatchObject({ approved: false, outcome: "expired" });
    expect((await HumanRequest.findOne({ runId: run.id }).lean())?.status).toBe(
      "expired",
    );
  });

  it("records a version change when a waiting run resumes on new code", async () => {
    const definition = defineProcess({
      id: "test-versions",
      name: "Versions",
      triggers: [trigger.manual()],
      input: z.object({}),
      run: async ctx => {
        await ctx.approval("Go?", { data: {} });
        return "v1";
      },
    });
    registerProcessDefinition(definition);
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-versions",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    // "Deploy" new code while the run waits.
    definition.run = async ctx => {
      await ctx.approval("Go?", { data: {} });
      return "v2";
    };
    const request = await pendingRequest(run.id);
    await respondToHumanRequest(WS, request!._id.toString(), ADMIN, {
      decision: "approve",
    });
    await settle();
    const doc = await runDoc(run.id);
    expect(doc?.output).toBe("v2");
    const changed = await events(run.id, "run.version_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].data).toMatchObject({ fromVersion: 1, toVersion: 2 });
    expect(
      await ProcessVersion.countDocuments({ processId: "test-versions" }),
    ).toBe(2);
  });
});

// ── provisioning ───────────────────────────────────────────────────────────

describe("tool provisioning", () => {
  it("refuses destructive tools in agents", async () => {
    registerProcessDefinition(
      defineProcess({
        id: "test-agent-destructive",
        name: "Agent destructive",
        triggers: [trigger.manual()],
        input: z.object({}),
        tools: [destroy],
        run: async ctx =>
          ctx.agent("Rogue", {
            instructions: "x",
            prompt: "x",
            tools: [destroy],
            output: z.object({}),
          }),
      }),
    );
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-agent-destructive",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    const doc = await runDoc(run.id);
    expect(doc?.status).toBe("failed");
    expect(doc?.error?.message).toMatch(/Agents may not use destructive tool/);
  });

  it("refuses tools outside the envelope in steps", async () => {
    counters.destructive = 0;
    registerProcessDefinition(
      defineProcess({
        id: "test-envelope",
        name: "Envelope",
        triggers: [trigger.manual()],
        input: z.object({}),
        run: async ctx => ctx.step("Sneaky", s => s.call(destroy, { id: "z" })),
      }),
    );
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-envelope",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    expect((await runDoc(run.id))?.error?.message).toMatch(
      /not in the tool envelope/,
    );
    expect(counters.destructive).toBe(0);
  });

  it("resolves only declared, bound connection slots", async () => {
    const probe = defineTool({
      name: "test.db.probe",
      description: "probe",
      effect: "read",
      connections: ["warehouse"],
      input: z.object({}),
      execute: async (_i, t) => (await t.connection("warehouse")).id,
    });
    registerProcessDefinition(
      defineProcess({
        id: "test-slots",
        name: "Slots",
        triggers: [trigger.manual()],
        input: z.object({}),
        tools: [probe],
        run: async ctx => ctx.step("Probe", s => s.call(probe, {})),
      }),
    );
    const first = await startRun({
      workspaceId: WS,
      processId: "test-slots",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    expect((await runDoc(first.run.id))?.error?.message).toMatch(/not bound/);
    const connectionId = new Types.ObjectId().toString();
    await updateInstallation(
      WS,
      "test-slots",
      { bindings: { warehouse: connectionId } },
      ADMIN.id,
    );
    const second = await startRun({
      workspaceId: WS,
      processId: "test-slots",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    expect((await runDoc(second.run.id))?.output).toBe(connectionId);
  });
});

// ── AI SDK harness ─────────────────────────────────────────────────────────

describe("aiSdkHarness", () => {
  it("runs a tool loop and validates the submitted result", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        const toolCall =
          call === 1
            ? {
                toolName: "crm__contact__search",
                input: JSON.stringify({ email: "hank@globex.example" }),
              }
            : {
                toolName: "submit_result",
                input: JSON.stringify({ found: 1 }),
              };
        return {
          content: [{ type: "tool-call", toolCallId: `t${call}`, ...toolCall }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: {
            inputTokens: {
              total: 100,
              noCache: 100,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 10, text: 10, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const harness = aiSdkHarness({ resolveModel: () => model });
    registerProcessDefinition(
      defineProcess({
        id: "test-ai-sdk",
        name: "AI SDK",
        triggers: [trigger.manual()],
        input: z.object({}),
        tools: [sampleTool()],
        run: async ctx =>
          ctx.agent("Find Hank", {
            instructions: "Find the contact.",
            prompt: "hank@globex.example",
            tools: [sampleTool()],
            output: z.object({ found: z.number() }),
            harness,
          }),
      }),
    );
    const { run } = await startRun({
      workspaceId: WS,
      processId: "test-ai-sdk",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    const doc = await runDoc(run.id);
    expect(doc?.status).toBe("completed");
    expect(doc?.output).toEqual({ found: 1 });
    expect(doc?.usage).toMatchObject({
      modelCalls: 2,
      inputTokens: 200,
      toolCalls: 1,
    });
    const detail = await getRunDetail(WS, run.id);
    expect(detail.steps[0].agent?.turns).toHaveLength(2);
    expect(detail.steps[0].tools[0]).toMatchObject({
      tool: "crm.contact.search",
      status: "completed",
    });
  });
});

let sampleSearchTool: ReturnType<typeof defineTool> | null = null;
function sampleTool() {
  sampleSearchTool ??= getProcessDefinition("dsar-erasure")!.tools!.find(
    t => t.name === "crm.contact.search",
  )!;
  return sampleSearchTool;
}

// ── vibe-code processes on the unchanged runtime ───────────────────────────

describe("library processes", () => {
  it("churn-risk-review: parallel agents, one email per CSM", async () => {
    scripts.set("assess-", async a => {
      const account = JSON.parse(a.request.prompt) as { id: string };
      await a.call("product__usage__weekly", { accountId: account.id });
      return {
        accountId: account.id,
        riskScore: 80,
        drivers: ["usage falling"],
        recommendedActions: ["Call the sponsor"],
      };
    });
    const { run } = await startRun({
      workspaceId: WS,
      processId: "churn-risk-review",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    const doc = await runDoc(run.id);
    expect(doc?.status).toBe("completed");
    expect(doc?.output).toMatchObject({ flagged: 2, emailed: 2 });
  });

  it("lead-enrichment: agents per lead, editable human review, CRM write-back", async () => {
    scripts.set("research-", async a => {
      const lead = JSON.parse(a.request.prompt) as {
        id: string;
        company?: string;
      };
      return {
        leadId: lead.id,
        segment: lead.company ? "enterprise" : "consumer",
        fitScore: lead.company ? 85 : 5,
        decision: lead.company ? "qualified" : "disqualified",
        reasoning: "test",
      };
    });
    const { run } = await startRun({
      workspaceId: WS,
      processId: "lead-enrichment",
      input: {},
      trigger: { type: "manual" },
    });
    await settle();
    const request = await pendingRequest(run.id);
    expect(request?.kind).toBe("approval");
    await respondToHumanRequest(WS, request!._id.toString(), ADMIN, {
      decision: "approve",
    });
    await settle();
    expect((await runDoc(run.id))?.output).toEqual({ reviewed: 3, written: 3 });
    expect(sampleSystems(WS).leads.get("ld_2")?.status).toBe("disqualified");
    expect(sampleSystems(WS).leads.get("ld_3")?.score).toBe(85);
  });

  it("competitor-watch: compares with the previous run's output", async () => {
    scripts.set("research-", async a => {
      const c = JSON.parse(a.request.prompt) as { name: string };
      return {
        competitor: c.name,
        launches: ["v2"],
        messaging: "faster",
        sources: [],
      };
    });
    const seen: unknown[] = [];
    scripts.set("write-brief", async a => {
      seen.push(JSON.parse(a.request.prompt).lastWeek);
      return {
        headline: "Example Co shipped v2",
        changes: [],
        markdown: "# Brief",
      };
    });
    const input = {
      competitors: [{ name: "Example Co", urls: ["https://example.com"] }],
      recipients: ["pm@example.com"],
    };
    for (let i = 0; i < 2; i++) {
      const { run } = await startRun({
        workspaceId: WS,
        processId: "competitor-watch",
        input,
        trigger: { type: "manual" },
      });
      await settle();
      expect((await runDoc(run.id))?.status).toBe("completed");
    }
    expect(seen[0]).toBeNull();
    expect(seen[1]).toMatchObject([{ competitor: "Example Co" }]);
  });

  it("schedules start once per due tick, only when enabled", async () => {
    await updateInstallation(
      WS,
      "churn-risk-review",
      { enabled: true },
      ADMIN.id,
    );
    scripts.set("assess-", async a => {
      const account = JSON.parse(a.request.prompt) as { id: string };
      return {
        accountId: account.id,
        riskScore: 10,
        drivers: [],
        recommendedActions: [],
      };
    });
    // Enabled on a Monday 08:00 → next due is next Monday 07:00 Zurich.
    expect(await runDueSchedules(new Date("2026-10-06T08:00:00Z"))).toBe(0);
    const monday = new Date("2026-10-12T06:00:00Z");
    expect(await runDueSchedules(monday)).toBe(1);
    expect(await runDueSchedules(monday)).toBe(0);
    await settle();
  });
});
