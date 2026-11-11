/**
 * The connection proxy end to end: the runtime's own `lib/mako.ts`
 * `connection()` (deploy/workflows/runtime/defaults), run inside the
 * AsyncLocalStorage worker.mjs sets, calls Mako's runtime route over real
 * HTTP with the worker's key or a person's own key. In-memory Mongo; only the
 * service on the other side is replaced (setTransportForTests).
 *
 * Pins: live reads are off on a connection that never had the field; once
 * on, a read passes for an unlisted workflow; an unlisted write is refused
 * and recorded; with `workflow:*` listed any deployed workflow writes (they
 * share one identity), the worker naming none does not; an allowed write is
 * recorded before it is sent, with its outcome after, and is not sent when
 * it cannot be recorded; a person's own run acts as
 * the person, whatever workflow it names; agents and unidentified callers
 * only read; a name two connections share is refused. What is a read, where
 * a path may go and that no answer carries the key are pinned without a
 * database in callable.test.ts.
 *
 * Needs the runtime's packages: npm install --prefix deploy/workflows/runtime
 *
 * Run with: pnpm --filter api exec tsx src/connections/proxy.db.test.ts
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { ConnectionWriteEvent } from "../access/connection-write-event";
import { hashApiKey } from "../auth/api-key.middleware";
import { User } from "../database/schema";
import {
  SourceConnection,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import { workflowRuntimeRoutes } from "../routes/workflows";
import { encryptString } from "../services/crypto.service";
import { databaseConnectionService } from "../services/database-connection.service";
import { ConnectionRequestError, setTransportForTests } from "./forward";
import { connectorRegistry } from "../connectors/registry";
import { createSourceConnection } from "../connectors/source-connection-create.service";
import { connectionRequest } from "./proxy.service";
import { setKey } from "../workflows/on-push";
import {
  type RunDetail,
  isRunExecuting,
  setFirstReadRetryForTests,
  workflowOfRunDetail,
} from "../workflows/runs";
import capturedRun from "./fixtures/hatchet-workflow-run.json";
import capturedOnFailure from "./fixtures/hatchet-workflow-run-on-failure.json";

/**
 * Real `GET /api/v1/stable/workflow-runs/{id}` answers, captured on the
 * preview stack (fixtures/README.md): a scheduled run while its first step
 * runs, and the same run while its onFailure task runs. And the workflow
 * they are runs of.
 */
const CAPTURED_RUN = capturedRun as unknown as {
  run: { metadata: { id: string } };
};
const CAPTURED_WORKFLOW = "RunBindingProof";

const WORKER_KEY = "revops_worker_proxy_key_tests_only";
const PERSON_KEY = "revops_person_proxy_key_tests_only";
const CLOSE_KEY = "api_closekey_do_not_leak_4f9a2c";
const TENANT = "11111111-1111-1111-1111-111111111111";
const HATCHET_TOKEN = `x.${Buffer.from(
  JSON.stringify({ sub: TENANT, server_url: "https://hatchet.example" }),
).toString("base64url")}.y`;
/** Runs Hatchet knows, by who Mako recorded as starting them. */
const PERSON_RUN = "0f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const AGENT_RUN = "1f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const OLD_API_RUN = "2f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SCHEDULED_RUN = "3f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const UNKNOWN_RUN = "4f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** A run Hatchet does not answer at first, as right after it starts. */
const LATE_RUN = "af6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** A run of other-flow, by a person (the app). */
const OTHER_RUN = "5f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** A scheduled run that ended long ago: its id must lend no write. */
const OLD_SCHEDULED_RUN = "6f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** A scheduled run still waiting for a slot: it writes in its first second. */
const QUEUED_RUN = "7f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** A failed run whose onFailure task is running. */
const ON_FAILURE_RUN = "8f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** A run whose status changes in the test, and Hatchet stops answering for. */
const LONG_RUN = "9f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

type FakeRun = {
  metadata: Record<string, string>;
  /** The workflow as declared; Hatchet keeps its step ids lowercase. */
  workflow: string;
  status: string;
  tasks?: Array<{ step: string; status: string }>;
};
/** Runs Hatchet knows: who Mako recorded as starting them, of which workflow. */
const RUNS: Record<string, FakeRun> = {
  [PERSON_RUN]: {
    metadata: { trigger: "ui", startedBy: "person" },
    workflow: "fr-offer-to-cash",
    status: "RUNNING",
  },
  [OTHER_RUN]: {
    metadata: { trigger: "ui", startedBy: "person" },
    workflow: "other-flow",
    status: "RUNNING",
  },
  [AGENT_RUN]: {
    metadata: { trigger: "agent", startedBy: "agent" },
    workflow: "fr-offer-to-cash",
    status: "RUNNING",
  },
  // Started before Mako kept startedBy: an API call is an agent's.
  [OLD_API_RUN]: {
    metadata: { trigger: "api" },
    workflow: "fr-offer-to-cash",
    status: "RUNNING",
  },
  [SCHEDULED_RUN]: {
    metadata: {},
    workflow: "fr-offer-to-cash",
    status: "RUNNING",
  },
  [OLD_SCHEDULED_RUN]: {
    metadata: { trigger: "schedule", startedBy: "trigger" },
    workflow: "fr-offer-to-cash",
    status: "COMPLETED",
    tasks: [{ step: "send", status: "COMPLETED" }],
  },
  [QUEUED_RUN]: {
    metadata: { trigger: "schedule", startedBy: "trigger" },
    workflow: "fr-offer-to-cash",
    status: "QUEUED",
    tasks: [{ step: "send", status: "QUEUED" }],
  },
  [ON_FAILURE_RUN]: {
    metadata: { trigger: "schedule", startedBy: "trigger" },
    workflow: "fr-offer-to-cash",
    status: "FAILED",
    tasks: [
      { step: "send", status: "FAILED" },
      { step: "fr-offer-to-cash-on-failure", status: "RUNNING" },
    ],
  },
  [LONG_RUN]: {
    metadata: { trigger: "schedule", startedBy: "trigger" },
    workflow: "fr-offer-to-cash",
    status: "RUNNING",
  },
  [LATE_RUN]: {
    metadata: { trigger: "schedule", startedBy: "trigger" },
    workflow: "fr-offer-to-cash",
    status: "RUNNING",
  },
};

type Connection = {
  get: (path: string, options?: unknown) => Promise<unknown>;
  post: (path: string, body?: unknown, options?: unknown) => Promise<unknown>;
  request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
};
type Mako = { connection: (id: string) => Connection };

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/** The refusal's message, or "ok". */
const attempt = (run: () => Promise<unknown>): Promise<string> =>
  run().then(
    () => "ok",
    (error: Error) => error.message,
  );

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // The source connection manager reads through the main connection.
  process.env.DATABASE_URL = mongo.getUri();
  process.env.DATABASE_NAME = mongoose.connection.db?.databaseName ?? "test";
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);

  const sent: Sent[] = [];
  /** The allowed writes in the log when each request was sent. */
  const loggedAtSend: { status?: number }[][] = [];
  const transportBack: Parameters<typeof setTransportForTests>[0] = async (
    url,
    options,
  ) => {
    loggedAtSend.push(
      await ConnectionWriteEvent.find({ allowed: true }).sort({ at: 1 }).lean(),
    );
    sent.push({
      url,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ ok: true })),
    };
  };
  setTransportForTests(transportBack);
  // Hatchet answers the runs above; everything else is the real network.
  const realFetch = globalThis.fetch;
  const hatchetAsked: string[] = [];
  /** Hatchet answers every read with a 503 while set. */
  let hatchetDown = false;
  /** How many reads of LATE_RUN Hatchet answers 404 before it knows it. */
  let lateReads = 0;
  setFirstReadRetryForTests([0, 0, 0]);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!href.startsWith("https://hatchet.example/")) {
      return realFetch(input, init);
    }
    const id = href.match(/workflow-runs\/([0-9a-f-]{36})/)?.[1] ?? "";
    hatchetAsked.push(id);
    if (hatchetDown) {
      return Response.json({ message: "unavailable" }, { status: 503 });
    }
    if (id === LATE_RUN && lateReads-- > 0) {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    if (id === CAPTURED_RUN.run.metadata.id) return Response.json(CAPTURED_RUN);
    const run = RUNS[id];
    // Shaped as Hatchet's v1 run detail (CAPTURED_RUN is a real one).
    return run
      ? Response.json({
          run: {
            metadata: { id },
            status: run.status,
            additionalMetadata: run.metadata,
          },
          tasks: (run.tasks ?? [{ step: "send", status: run.status }]).map(
            task => ({
              actionId: `${run.workflow.toLowerCase()}:${task.step}`,
              status: task.status,
            }),
          ),
        })
      : Response.json({ message: "not found" }, { status: 404 });
  }) as typeof fetch;

  const app = new Hono();
  app.use("*", loggingMiddleware({}));
  app.route("/api/workflows/runtime", workflowRuntimeRoutes);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const ws = new Types.ObjectId();
    await User.create({ _id: "deployer", email: "deployer@example.com" });
    await WorkspaceMember.create({
      workspaceId: ws,
      userId: "deployer",
      role: "owner",
      joinedAt: new Date(),
    });
    const key = (name: string, value: string, scopes: string[]) => ({
      _id: new Types.ObjectId(),
      name,
      keyHash: hashApiKey(value),
      prefix: value.slice(0, 14),
      scopes,
      createdAt: new Date(),
      createdBy: "deployer",
    });
    await Workspace.collection.insertOne({
      _id: ws,
      name: "t",
      slug: `t-${ws}`,
      createdBy: "deployer",
      settings: {},
      apiKeys: [
        key("Workflows worker", WORKER_KEY, [
          "mcp",
          "query:write",
          "workflows:runtime",
        ]),
        // `mako workflow run` / a sandbox run: the person's own grant.
        key("Mine", PERSON_KEY, ["mcp", "workflows:run"]),
      ],
      workflows: {
        hatchetToken: encryptString(HATCHET_TOKEN),
        live: {
          sha: "a".repeat(40),
          tree: "t",
          names: ["fr-offer-to-cash", "other-flow", CAPTURED_WORKFLOW],
        },
      },
    });
    const settings = { sync_batch_size: 100, rate_limit_delay_ms: 0 };
    const close = await SourceConnection.create({
      workspaceId: ws,
      name: "ch_close",
      type: "close",
      config: { api_key: encryptString(CLOSE_KEY) },
      settings,
      createdBy: "deployer",
    });
    const twin = {
      workspaceId: ws,
      type: "close",
      config: { api_key: encryptString(CLOSE_KEY) },
      settings,
      createdBy: "deployer",
      liveReads: true,
    };
    const running = new AsyncLocalStorage<string>();
    (globalThis as { makoWorkflow?: unknown }).makoWorkflow = running;
    // The run each step runs in, as worker.mjs sets it: a person's, unless
    // a test says otherwise.
    const runStep = new AsyncLocalStorage<{ runId?: string }>();
    (globalThis as { makoRun?: unknown }).makoRun = runStep;
    runStep.enterWith({ runId: PERSON_RUN });
    const load = async (apiKey: string): Promise<Mako> => {
      process.env.MAKO_URL = `http://127.0.0.1:${port}`;
      process.env.MAKO_API_KEY = apiKey;
      const file = path.resolve(
        __dirname,
        "../../../deploy/workflows/runtime/defaults/lib/mako.ts",
      );
      return (await import(
        `${pathToFileURL(file).href}?proxy=${encodeURIComponent(apiKey)}`
      )) as Mako;
    };
    const events = async (expected: number) => {
      for (let i = 0; i < 60; i++) {
        const found = await ConnectionWriteEvent.find({})
          .sort({ at: 1 })
          .lean();
        if (found.length >= expected) return found;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return ConnectionWriteEvent.find({}).sort({ at: 1 }).lean();
    };

    const worker = await load(WORKER_KEY);

    // A connection made before live reads existed has no field: reads are off
    // until an admin turns them on. Writes do not depend on it.
    assert.match(
      await running.run("other-flow", () =>
        attempt(() => worker.connection("ch_close").get("/lead/")),
      ),
      /Live reads are off for ch_close/,
    );
    assert.equal(sent.length, 0, "a refused read is never sent");
    await SourceConnection.updateMany({}, { $set: { liveReads: true } });

    // A read passes for a workflow on no list, by connection name.
    const lead = await running.run("other-flow", () =>
      worker.connection("ch_close").request("GET", "/lead/", undefined),
    );
    assert.equal(lead.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.close.com/api/v1/lead/");
    assert.equal(
      sent[0].headers.authorization,
      `Basic ${Buffer.from(`${CLOSE_KEY}:`).toString("base64")}`,
    );
    assert.equal((await events(0)).length, 0, "reads are not in the write log");

    // An unlisted workflow's write is refused and recorded; nothing is sent.
    const before = sent.length;
    const refused = await runStep.run({ runId: OTHER_RUN }, () =>
      running.run("other-flow", () =>
        attempt(() =>
          worker.connection("ch_close").post("/task/", { text: "x" }),
        ),
      ),
    );
    assert.equal(
      refused,
      "workflow:other-flow is not allowed to write to ch_close. Ask one of this connection's managers or the workspace owner to allow All deployed workflows on the connection's Access tab.",
    );
    assert.equal(sent.length, before);
    let recorded = await events(1);
    assert.equal(recorded[0].principal, "workflow:other-flow");
    assert.equal(recorded[0].target, "POST /task/");
    assert.equal(recorded[0].allowed, false);

    // Deployed workflows are listed together: any of them writes, as itself.
    await SourceConnection.updateOne(
      { _id: close._id },
      { $set: { writers: [{ principal: "workflow:*" }] } },
    );
    assert.equal(
      await running.run("fr-offer-to-cash", () =>
        attempt(() =>
          worker
            .connection("ch_close")
            .post("/task/", { lead_id: "lead_1", text: "Call" }),
        ),
      ),
      "ok",
    );
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1)?.method, "POST");
    assert.deepEqual(JSON.parse(sent.at(-1)?.body ?? "{}"), {
      lead_id: "lead_1",
      text: "Call",
    });
    recorded = await events(2);
    assert.equal(recorded[1].principal, "workflow:fr-offer-to-cash");
    assert.equal(recorded[1].allowed, true);
    // Recorded before it was sent, its outcome after.
    assert.equal(loggedAtSend.at(-1)?.length, 1);
    assert.equal(loggedAtSend.at(-1)?.[0].status, undefined);
    assert.equal(recorded[1].status, 200);
    assert.equal(
      await runStep.run({ runId: OTHER_RUN }, () =>
        running.run("other-flow", () =>
          attempt(() => worker.connection("ch_close").post("/task/", {})),
        ),
      ),
      "ok",
    );
    // The worker naming no deployed workflow is not one of them.
    assert.match(
      await running.run("not-deployed", () =>
        attempt(() => worker.connection("ch_close").post("/task/", {})),
      ),
      /^worker:workflows is not allowed to write to ch_close/,
    );

    // A write the log cannot take is not sent; a refusal is still answered.
    const realCreate = ConnectionWriteEvent.create.bind(ConnectionWriteEvent);
    (ConnectionWriteEvent as unknown as { create: unknown }).create =
      async () => {
        throw new Error("log down");
      };
    const sentBeforeLogDown = sent.length;
    try {
      const down = await running
        .run("fr-offer-to-cash", () =>
          worker.connection("ch_close").request("POST", "/task/", {}),
        )
        .then(
          answer => ({
            status: answer.status,
            text: JSON.stringify(answer.body),
          }),
          (error: { status?: number; message: string }) => ({
            status: error.status,
            text: error.message,
          }),
        );
      assert.equal(down.status, 503, down.text);
      assert.match(
        down.text,
        /Mako could not record this write, so it was not sent\./,
      );
      assert.match(
        await running.run("not-deployed", () =>
          attempt(() => worker.connection("ch_close").post("/task/", {})),
        ),
        /^worker:workflows is not allowed/,
      );
    } finally {
      (ConnectionWriteEvent as unknown as { create: unknown }).create =
        realCreate;
    }
    assert.equal(sent.length, sentBeforeLogDown);

    // A deployed run an agent started only reads: its writes are refused as
    // the agent's, its reads pass. A run Mako cannot tell writes nothing.
    const sentBeforeAgentRun = sent.length;
    for (const run of [AGENT_RUN, OLD_API_RUN]) {
      assert.match(
        await runStep.run({ runId: run }, () =>
          running.run("fr-offer-to-cash", () =>
            attempt(() => worker.connection("ch_close").post("/task/", {})),
          ),
        ),
        /^This run was started by an agent/,
        run,
      );
    }
    assert.equal(
      await runStep.run({ runId: AGENT_RUN }, () =>
        running.run("fr-offer-to-cash", () =>
          attempt(() => worker.connection("ch_close").get("/lead/")),
        ),
      ),
      "ok",
    );
    for (const store of [{ runId: UNKNOWN_RUN }, {}]) {
      assert.match(
        await runStep.run(store, () =>
          running.run("fr-offer-to-cash", () =>
            attempt(() => worker.connection("ch_close").post("/task/", {})),
          ),
        ),
        /^Mako could not tell which run of fr-offer-to-cash/,
      );
    }
    assert.equal(sent.length, sentBeforeAgentRun + 1, "only the read was sent");
    const agentRunRows = await ConnectionWriteEvent.find({ allowed: false })
      .sort({ at: -1 })
      .limit(4)
      .lean();
    assert.deepEqual(agentRunRows.map(r => r.principal).reverse(), [
      "agent:workflow:fr-offer-to-cash",
      "agent:workflow:fr-offer-to-cash",
      "workflow:fr-offer-to-cash",
      "workflow:fr-offer-to-cash",
    ]);
    // A scheduled run writes; who started a run is asked once.
    const askedBefore = hatchetAsked.length;
    for (let i = 0; i < 2; i++) {
      assert.equal(
        await runStep.run({ runId: SCHEDULED_RUN }, () =>
          running.run("fr-offer-to-cash", () =>
            attempt(() => worker.connection("ch_close").post("/task/", {})),
          ),
        ),
        "ok",
      );
    }
    assert.deepEqual(hatchetAsked.slice(askedBefore), [SCHEDULED_RUN]);

    // The run named must be one executing this workflow: deployed code holds
    // the worker key and could name any run, an old scheduled one's above all.
    const write = (runId: string, workflow = "fr-offer-to-cash") =>
      runStep.run({ runId }, () =>
        running.run(workflow, () =>
          attempt(() => worker.connection("ch_close").post("/task/", {})),
        ),
      );
    const notTold = /^Mako could not tell which run of /;
    const sentBeforeBinding = sent.length;
    // A run that ended long ago lends nothing, nor does a run of another
    // workflow, even one that runs now.
    assert.match(await write(OLD_SCHEDULED_RUN), notTold);
    assert.match(await write(OTHER_RUN, "fr-offer-to-cash"), notTold);
    assert.match(await write(PERSON_RUN, "other-flow"), notTold);
    assert.equal(sent.length, sentBeforeBinding, "no borrowed write is sent");
    // A scheduled run that writes in its first second may still be QUEUED;
    // an onFailure task writes while its run already shows FAILED.
    assert.equal(await write(QUEUED_RUN), "ok");
    assert.equal(await write(ON_FAILURE_RUN), "ok");
    // The real run detail Hatchet answers (captured on the preview stack):
    // its steps' actionId are lowercase, the workflow is not.
    assert.equal(
      await write(CAPTURED_RUN.run.metadata.id, CAPTURED_WORKFLOW),
      "ok",
    );
    assert.equal(
      workflowOfRunDetail(CAPTURED_RUN as RunDetail),
      CAPTURED_WORKFLOW.toLowerCase(),
    );
    // While the onFailure task runs, Hatchet still shows the run RUNNING and
    // the failed step FAILED; the run is executing either way.
    const onFailure = capturedOnFailure as unknown as RunDetail;
    assert.equal(workflowOfRunDetail(onFailure), "runbindingproof");
    assert.equal(isRunExecuting(onFailure), true);

    // A run's first write is not refused because Hatchet does not know the
    // run yet (it can lag a run it just started): it is read again.
    lateReads = 2;
    const askedBeforeLate = hatchetAsked.length;
    assert.equal(await write(LATE_RUN), "ok");
    assert.deepEqual(hatchetAsked.slice(askedBeforeLate), [
      LATE_RUN,
      LATE_RUN,
      LATE_RUN,
    ]);
    // ...but not for ever: a run Hatchet never answers lends nothing.
    const askedBeforeUnknown = hatchetAsked.length;
    assert.match(await write(UNKNOWN_RUN), notTold);
    assert.equal(hatchetAsked.length - askedBeforeUnknown, 4, "read 4 times");

    // Who started a run and its workflow are kept; whether it still executes
    // is asked again after a while, and a Hatchet that does not answer then
    // does not refuse a run seen executing.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const askedAt = hatchetAsked.length;
      assert.equal(await write(LONG_RUN), "ok");
      assert.equal(await write(LONG_RUN), "ok");
      assert.deepEqual(hatchetAsked.slice(askedAt), [LONG_RUN], "asked once");
      now += 20_000;
      hatchetDown = true;
      assert.equal(
        await write(LONG_RUN),
        "ok",
        "Hatchet down: still executing",
      );
      // ...but not a run Mako never saw, nor one of another workflow.
      assert.match(await write(UNKNOWN_RUN), notTold);
      assert.match(await write(LONG_RUN, "other-flow"), notTold);
      // ...nor for ever.
      now += 31 * 60_000;
      assert.match(await write(LONG_RUN), notTold);
      hatchetDown = false;
      // Hatchet answers again: the run ended, so its id lends nothing now.
      RUNS[LONG_RUN].status = "COMPLETED";
      assert.match(await write(LONG_RUN), notTold);
      // A run whose onFailure task starts after the refusal writes again.
      RUNS[LONG_RUN].status = "FAILED";
      RUNS[LONG_RUN].tasks = [
        { step: "send", status: "FAILED" },
        { step: "fr-offer-to-cash-on-failure", status: "QUEUED" },
      ];
      assert.equal(await write(LONG_RUN), "ok");
    } finally {
      Date.now = realNow;
      hatchetDown = false;
    }

    // Idempotency-Key comes as a header; the old body field is not read.
    const raw = (body: object) =>
      fetch(
        `http://127.0.0.1:${port}/api/workflows/runtime/connections/ch_close/request`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WORKER_KEY}`,
            "Content-Type": "application/json",
            "X-Mako-Workflow": "other-flow",
          },
          body: JSON.stringify({ method: "GET", path: "/lead/", ...body }),
        },
      );
    assert.equal((await raw({ idempotencyKey: "old-1" })).status, 200);
    assert.equal(sent.at(-1)?.headers["idempotency-key"], undefined);
    assert.equal(
      (await raw({ headers: { "Idempotency-Key": "new-1" } })).status,
      200,
    );
    assert.equal(sent.at(-1)?.headers["idempotency-key"], "new-1");

    // A service's error shows its body, cut to 300 characters; Mako's own
    // refusals read as Mako wrote them (above).
    setTransportForTests(async () => ({
      status: 422,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ error: "bad lead" })),
    }));
    assert.equal(
      await running.run("other-flow", () =>
        attempt(() => worker.connection("ch_close").get("/lead/x/")),
      ),
      'GET /lead/x/ on ch_close answered 422: {"error":"bad lead"}',
    );
    setTransportForTests(async () => ({
      status: 500,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("x".repeat(1000)),
    }));
    assert.equal(
      await running.run("other-flow", () =>
        attempt(() => worker.connection("ch_close").get("/lead/")),
      ),
      `GET /lead/ on ch_close answered 500: ${"x".repeat(300)}…`,
    );
    setTransportForTests(transportBack);

    // A write that gets no answer is recorded with why.
    setTransportForTests(async () => {
      throw new Error("Refused: a private address");
    });
    assert.match(
      await running.run("fr-offer-to-cash", () =>
        attempt(() => worker.connection("ch_close").post("/task/", {})),
      ),
      /private address|failed/i,
    );
    setTransportForTests(transportBack);
    const failed = await ConnectionWriteEvent.findOne({})
      .sort({ at: -1 })
      .lean();
    assert.equal(failed?.allowed, true);
    assert.match(failed?.error ?? "", /a private address/);
    assert.equal(failed?.status, undefined);
    await ConnectionWriteEvent.deleteMany({});

    // A listed writer writes anywhere through the connection: no path limit.
    assert.equal(
      (
        await running.run("fr-offer-to-cash", () =>
          worker.connection("ch_close").request("DELETE", "/lead/lead_1/"),
        )
      ).status,
      200,
    );

    // A person's own run acts as the person: the workflow it names grants nothing.
    const person = await load(PERSON_KEY);
    assert.match(
      await running.run("fr-offer-to-cash", () =>
        attempt(() =>
          person.connection("ch_close").post("/task/", { text: "x" }),
        ),
      ),
      /^user:deployer is not allowed to write to ch_close/,
    );
    recorded = await events(2);
    assert.equal(recorded.at(-1)?.principal, "user:deployer");
    assert.equal(recorded.at(-1)?.allowed, false);
    // ...and reads like anyone.
    assert.equal(
      await running.run("fr-offer-to-cash", () =>
        attempt(() => person.connection("ch_close").get("/me/")),
      ),
      "ok",
    );

    // An agent only reads, whoever it acts for.
    const agentWrite = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "POST", path: "/task/" },
      readOnly: true,
      actor: "workflow:fr-offer-to-cash",
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(agentWrite, /^Agents only read/);
    // Recorded as the agent's attempt, which no writers list can name.
    recorded = await events(3);
    assert.equal(recorded.at(-1)?.principal, "agent:workflow:fr-offer-to-cash");
    assert.equal(recorded.at(-1)?.allowed, false);

    // A viewer never writes, even when listed.
    await WorkspaceMember.create({
      workspaceId: ws,
      userId: "vera",
      role: "viewer",
      joinedAt: new Date(),
    });
    await SourceConnection.updateOne(
      { _id: close._id },
      { $push: { writers: { principal: "user:vera" } } },
    );
    const sentBeforeViewer = sent.length;
    const viewerWrite = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "POST", path: "/task/" },
      actor: "user:vera",
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(viewerWrite, /^Viewers can't write through a connection/);
    assert.equal(sent.length, sentBeforeViewer);
    recorded = await events(4);
    assert.equal(recorded.at(-1)?.principal, "user:vera");
    assert.equal(recorded.at(-1)?.allowed, false);
    const agentRead = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "GET", path: "/lead/" },
      readOnly: true,
    });
    assert.equal(agentRead.read, true);

    // A sandbox run's key outlives its person's membership; its rights do
    // not: a former member's write and read are refused, recorded, not sent.
    const LEAVER_KEY = "revops_leaver_sandbox_key_tests_only";
    await User.create({ _id: "leaver", email: "leaver@example.com" });
    await WorkspaceMember.create({
      workspaceId: ws,
      userId: "leaver",
      role: "member",
      joinedAt: new Date(),
    });
    await SourceConnection.updateOne(
      { _id: close._id },
      { $push: { writers: { principal: "user:leaver" } } },
    );
    await setKey(
      String(ws),
      "leaver",
      "Workflows sandbox leaver run",
      LEAVER_KEY,
      {
        agentRun: false,
      },
    );
    const leaver = await load(LEAVER_KEY);
    assert.equal(
      await attempt(() => leaver.connection("ch_close").post("/task/", {})),
      "ok",
      "a member's own sandbox run writes while listed",
    );
    await WorkspaceMember.deleteOne({ workspaceId: ws, userId: "leaver" });
    const sentBeforeLeaver = sent.length;
    const leaverWrite = await leaver
      .connection("ch_close")
      .request("POST", "/task/", {})
      .then(
        () => ({ status: 200, message: "ok" }),
        (error: { status?: number; message: string }) => error,
      );
    assert.equal(leaverWrite.status, 403);
    assert.match(leaverWrite.message, /^user:leaver is not a member/);
    const leaverRead = await leaver
      .connection("ch_close")
      .request("GET", "/lead/")
      .then(
        () => ({ status: 200, message: "ok" }),
        (error: { status?: number; message: string }) => error,
      );
    assert.equal(leaverRead.status, 403);
    assert.equal(
      sent.length,
      sentBeforeLeaver,
      "nothing a former member asks is sent",
    );
    const leaverRows = await ConnectionWriteEvent.find({
      principal: "user:leaver",
    })
      .sort({ at: 1 })
      .lean();
    assert.deepEqual(
      leaverRows.map(r => [r.target, r.allowed]),
      [
        ["POST /task/", true],
        ["POST /task/", false],
        ["GET /lead/", false],
      ],
    );

    // No one identified: the write is refused.
    const nobody = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "POST", path: "/task/" },
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(nobody, /could not tell who is writing/);

    // Another workspace's connection does not exist here.
    const elsewhere = await connectionRequest({
      workspaceId: String(new Types.ObjectId()),
      connection: String(close._id),
      request: { method: "GET", path: "/lead/" },
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(elsewhere, /^No connection/);

    // Two connections with one name: a name is refused, the id still works.
    const [dupA] = await SourceConnection.create([
      { ...twin, name: "dup_name" },
      { ...twin, name: "dup_name" },
    ]);
    const byName = await connectionRequest({
      workspaceId: String(ws),
      connection: "dup_name",
      request: { method: "GET", path: "/lead/" },
    }).then(
      () => null,
      (error: ConnectionRequestError) => error,
    );
    assert.equal(byName?.status, 409);
    assert.equal(
      byName?.message,
      "Several connections are called dup_name; use its id.",
    );
    const byId = await connectionRequest({
      workspaceId: String(ws),
      connection: String(dupA._id),
      request: { method: "GET", path: "/lead/" },
    });
    assert.equal(byId.status, 200);

    // Live reads turned off again: reads are refused.
    await SourceConnection.updateOne(
      { _id: close._id },
      { $set: { liveReads: false } },
    );
    assert.match(
      await running.run("other-flow", () =>
        attempt(() => worker.connection("ch_close").get("/lead/")),
      ),
      /Live reads are off/,
    );

    // Every new connection starts with live reads off, a Custom API too.
    await connectorRegistry.ready();
    const custom = await createSourceConnection({
      workspaceId: String(ws),
      userId: "deployer",
      name: "new_custom",
      type: "custom_api",
      config: { base_url: "https://x.example.com", token: "t0ken_value" },
    });
    assert.equal(custom.liveReads, undefined);
    const builtin = await createSourceConnection({
      workspaceId: String(ws),
      userId: "deployer",
      name: "new_close",
      type: "close",
      config: { api_key: "k3y_value" },
    });
    assert.equal(builtin.liveReads, undefined);

    console.info("connection proxy tests passed");
  } finally {
    setTransportForTests(null);
    globalThis.fetch = realFetch;
    (
      server as unknown as { closeAllConnections(): void }
    ).closeAllConnections();
    server.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    // The source connection manager's own client to the main database.
    await databaseConnectionService.closeAllConnections();
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
