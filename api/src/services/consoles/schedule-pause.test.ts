/**
 * A scheduled console that Mako refuses to let write stops after 3 runs
 * instead of failing every hour forever (schedule-pause.ts):
 *
 * - 3 refusals with one cause pause the schedule and send 2 notices (the
 *   first failure, then the pause), never one per run;
 * - transient failures never pause and notify on every run;
 * - a success resets the counts;
 * - setting the schedule again resumes it with fresh counts.
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
import { Types } from "mongoose";
import {
  ensureTestUser,
  ensureTestDatabaseConnection,
  setupPgTestDb,
  type PgTestDb,
} from "../../test-support/pg-test";

const sent = vi.hoisted(
  () => [] as Array<{ name: string; data: Record<string, unknown> }>,
);
vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(
      async (event: { name: string; data: Record<string, unknown> }) => {
        sent.push(event);
      },
    ),
    createFunction: vi.fn(() => ({})),
  },
}));

import { consolesChartsRepo } from "../../repositories/consoles-charts";
import { initRepo, repoDirFor } from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  decideWrite,
  isWriteRefusal,
  refusal,
  unidentifiedWriterRefusal,
} from "../../access/connection-writes";
import {
  PAUSE_AFTER_PERMANENT_FAILURES,
  notifyScheduledRunOutcome,
  permanentFailureFix,
  recordScheduledRunOutcome,
} from "./schedule-pause";
import { setConsoleSchedule } from "./schedule";

let pgh: PgTestDb;
let tmpRoot: string;
let WS: string;
const USER = new Types.ObjectId().toString();
const REFUSED = refusal(
  decideWrite([], `user:${USER}`, "INSERT INTO s.t VALUES (1)"),
  "Warehouse",
);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "schedule-pause-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  pgh = await setupPgTestDb();
}, 120_000);

afterAll(async () => {
  await pgh?.close();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  sent.length = 0;
  await pgh.reset();
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

async function scheduledConsole() {
  await ensureTestUser(pgh.db, { id: USER });
  const connection = await ensureTestDatabaseConnection(pgh.db, {
    workspaceId: WS,
  });
  const row = await consolesChartsRepo.createConsole({
    workspaceId: WS,
    name: "hourly",
    code: "INSERT INTO s.t VALUES (1)",
    language: "sql",
    connectionId: connection.id,
    createdBy: USER,
    owner_id: USER,
    isSaved: true,
    access: "workspace",
    isPrivate: false,
    executionCount: 0,
    schedule: { cron: "0 * * * *", timezone: "UTC" },
    scheduledRun: {
      nextAt: new Date(Date.now() - 1000),
      runCount: 0,
      consecutiveFailures: 0,
    },
  });
  return row.id;
}

/** One run as the executor finishes it: record, then notify. */
async function run(consoleId: string, error?: string) {
  const completedAt = new Date();
  const runDoc = await consolesChartsRepo.createScheduledQueryRun({
    workspaceId: WS,
    consoleId,
    triggeredAt: completedAt,
    completedAt,
    status: error === undefined ? "success" : "error",
    triggerType: "schedule",
    error: error === undefined ? undefined : { message: error },
  });
  const outcome = await recordScheduledRunOutcome({
    consoleId,
    error,
    now: completedAt,
    fields: {
      "scheduledRun.lastAt": completedAt,
      "scheduledRun.nextAt": new Date(Date.now() + 3_600_000),
    },
  });
  await notifyScheduledRunOutcome(outcome, {
    workspaceId: WS,
    consoleId,
    runId: runDoc.id,
    triggerType: "schedule",
  });
  return outcome;
}

async function scheduledRunOf(consoleId: string) {
  const row = await consolesChartsRepo.findConsoleById(WS, consoleId);
  return row?.scheduledRun;
}

function notices() {
  return sent.filter(e => e.name === "flow.run.terminal");
}

describe("isWriteRefusal", () => {
  it("matches every refusal wording and nothing else", () => {
    const writers = [{ principal: "user:anna", where: "s.allowed" }];
    const wordings = [
      REFUSED,
      refusal(decideWrite(writers as never, "user:anna", "CALL x()"), "W"),
      refusal(
        decideWrite(writers as never, "user:anna", "DELETE FROM s.other"),
        "W",
      ),
      unidentifiedWriterRefusal("W"),
    ];
    expect(new Set(wordings).size).toBe(4);
    for (const message of wordings) expect(isWriteRefusal(message)).toBe(true);
    expect(isWriteRefusal("connection reset by peer")).toBe(false);
    expect(isWriteRefusal(undefined)).toBe(false);
    expect(permanentFailureFix(REFUSED)).toMatch(/Access tab/);
    expect(permanentFailureFix("Query timed out")).toBeNull();
  });
});

describe("scheduled console pause", () => {
  it("pauses after 3 refusals and notifies on the first and the pause only", async () => {
    const id = await scheduledConsole();

    const first = await run(id, REFUSED);
    expect(first).toEqual({ notify: true, pausedReason: undefined });
    const second = await run(id, REFUSED);
    expect(second.notify).toBe(false);
    expect((await scheduledRunOf(id))?.pausedAt).toBeUndefined();

    const third = await run(id, REFUSED);
    expect(PAUSE_AFTER_PERMANENT_FAILURES).toBe(3);
    expect(third.notify).toBe(true);
    expect(third.pausedReason).toContain(REFUSED);
    expect(third.pausedReason).toContain("resume the schedule");

    const state = await scheduledRunOf(id);
    expect(state?.pausedAt).toBeInstanceOf(Date);
    expect(state?.pausedReason).toBe(third.pausedReason);
    expect(state?.lastError).toBe(third.pausedReason);
    expect(state?.nextAt).toBeUndefined();
    expect(state?.consecutiveFailures).toBe(3);
    expect(state?.permanentFailures).toBe(3);

    // The scheduler no longer picks it up: no run, so no more notices.
    const due = await consolesChartsRepo.findDueScheduledConsoles(
      new Date(Date.now() + 365 * 86_400_000),
    );
    expect(due.map(d => d.id)).not.toContain(id);

    const sentNotices = notices();
    expect(sentNotices).toHaveLength(2);
    expect(sentNotices[0].data.errorMessage).toBe(REFUSED);
    expect(sentNotices[1].data.errorMessage).toBe(third.pausedReason);
    // The schedule itself stays: resuming needs no new cron.
    expect(
      (await consolesChartsRepo.findConsoleById(WS, id))?.schedule?.cron,
    ).toBe("0 * * * *");
  });

  it("transient failures never pause and notify every run", async () => {
    const id = await scheduledConsole();
    for (let i = 0; i < 5; i++) {
      const outcome = await run(id, "connection reset by peer");
      expect(outcome.notify).toBe(true);
    }
    const state = await scheduledRunOf(id);
    expect(state?.pausedAt).toBeUndefined();
    expect(state?.nextAt).toBeInstanceOf(Date);
    expect(state?.consecutiveFailures).toBe(5);
    expect(state?.permanentFailures).toBe(0);
    expect(notices()).toHaveLength(5);
  });

  it("a transient failure or a success in between restarts the count", async () => {
    const id = await scheduledConsole();
    await run(id, REFUSED);
    await run(id, REFUSED);
    await run(id, "Query timed out");
    await run(id, REFUSED);
    await run(id, REFUSED);
    expect((await scheduledRunOf(id))?.pausedAt).toBeUndefined();

    await run(id);
    let state = await scheduledRunOf(id);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.permanentFailures).toBe(0);

    await run(id, REFUSED);
    await run(id, REFUSED);
    state = await scheduledRunOf(id);
    expect(state?.permanentFailures).toBe(2);
    expect(state?.pausedAt).toBeUndefined();
  });

  it("setting the schedule again resumes it with fresh counts", async () => {
    const id = await scheduledConsole();
    for (let i = 0; i < 3; i++) await run(id, REFUSED);
    expect((await scheduledRunOf(id))?.pausedAt).toBeInstanceOf(Date);

    const resumed = await setConsoleSchedule({
      workspaceId: WS,
      consoleId: id,
      cron: "0 * * * *",
      timezone: "UTC",
      actorUserId: USER,
    });
    expect(resumed).not.toBeNull();

    const state = await scheduledRunOf(id);
    expect(state?.pausedAt).toBeUndefined();
    expect(state?.pausedReason).toBeUndefined();
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.permanentFailures).toBe(0);
    expect(state?.nextAt).toBeInstanceOf(Date);

    // A fresh threshold: 2 more refusals do not pause it again.
    await run(id, REFUSED);
    await run(id, REFUSED);
    expect((await scheduledRunOf(id))?.pausedAt).toBeUndefined();
  });
});
