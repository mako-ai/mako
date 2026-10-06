/**
 * executeRun — one (re-)execution of a process run on some Driver.
 *
 * Engines call this every time a run should make progress: on start, after a
 * signal or timer (LocalEngine), or on every Inngest invocation (where the
 * handler is replayed from the top and memoized steps return instantly).
 */
import { Types } from "mongoose";
import { getProcessDefinition } from "../registry";
import { append, errorMessage, toJson, type JournalScope } from "./journal";
import { ProcessRun, TERMINAL_STATUSES, HumanRequest } from "./models";
import { Suspend, type Driver } from "./driver";
import { createProcessContext, ProcessStepError } from "./context";
import { ensureVersion } from "./version";

const HOUSEKEEPING = { retries: 3 };

export type ExecuteOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "suspended"
  | "skipped";

export async function executeRun(
  runId: string,
  driver: Driver,
): Promise<ExecuteOutcome> {
  const run = await ProcessRun.findById(runId).lean();
  if (!run) return "skipped";
  if (TERMINAL_STATUSES.includes(run.status)) return "skipped";

  const definition = getProcessDefinition(run.processId);
  const journalFor = (versionId: string): JournalScope => ({
    runId,
    workspaceId: run.workspaceId.toString(),
    versionId,
  });

  if (!definition) {
    await driver.run(
      "$missing-definition",
      async () => {
        await markFailed(
          runId,
          journalFor(run.versionId.toString()),
          run.attempt,
          `Process "${run.processId}" is not registered in this deployment`,
        );
      },
      HOUSEKEEPING,
    );
    return "failed";
  }

  const version = await ensureVersion(definition);
  const journal = journalFor(version.id);

  await driver.run(
    "$start",
    async () => {
      if (version.id !== run.versionId.toString()) {
        await append(journal, {
          type: "run.version_changed",
          dedupeKey: `run.version_changed:${version.id}`,
          data: {
            fromVersionId: run.versionId.toString(),
            fromVersion: run.versionNumber,
            toVersionId: version.id,
            toVersion: version.number,
          },
        });
      }
      const started = await ProcessRun.updateOne(
        { _id: run._id, status: "queued" },
        { $set: { status: "running", startedAt: run.startedAt ?? new Date() } },
      );
      if (started.modifiedCount > 0) {
        await append(journal, {
          type: "run.started",
          dedupeKey: `run.started:${run.attempt}`,
          data: { attempt: run.attempt, engine: driver.engine },
        });
      }
    },
    HOUSEKEEPING,
  );

  const ctx = createProcessContext({
    run,
    definition,
    versionId: version.id,
    driver,
  });

  try {
    const input = definition.input.parse(run.input);
    const output = await definition.run(ctx, input);
    await driver.run(
      "$complete",
      async () => {
        const json = toJson(output, "Process output");
        const updated = await ProcessRun.updateOne(
          { _id: run._id, status: { $nin: TERMINAL_STATUSES } },
          {
            $set: {
              status: "completed",
              output: json,
              waitingOn: null,
              error: null,
              endedAt: new Date(),
            },
          },
        );
        if (updated.modifiedCount > 0) {
          await append(journal, {
            type: "run.completed",
            dedupeKey: `run.completed`,
            data: { output: json },
          });
        }
      },
      HOUSEKEEPING,
    );
    return "completed";
  } catch (error) {
    if (error instanceof Suspend) throw error;
    const fresh = await ProcessRun.findById(runId).select("status").lean();
    if (fresh?.status === "cancelled") return "cancelled";
    const message = errorMessage(error);
    const stepKey =
      error instanceof ProcessStepError ? error.stepKey : undefined;
    await driver.run(
      "$fail",
      async () => markFailed(runId, journal, run.attempt, message, stepKey),
      HOUSEKEEPING,
    );
    return "failed";
  }
}

async function markFailed(
  runId: string,
  journal: JournalScope,
  attempt: number,
  message: string,
  stepKey?: string,
): Promise<void> {
  const updated = await ProcessRun.updateOne(
    {
      _id: new Types.ObjectId(runId),
      status: { $nin: TERMINAL_STATUSES },
    },
    {
      $set: {
        status: "failed",
        error: { message, ...(stepKey ? { stepKey } : {}) },
        waitingOn: null,
        endedAt: new Date(),
      },
    },
  );
  if (updated.modifiedCount > 0) {
    await append(journal, {
      type: "run.failed",
      dedupeKey: `run.failed:${attempt}`,
      stepKey,
      data: { error: message, attempt },
    });
    // A failed run cannot be waiting on anyone.
    await HumanRequest.updateMany(
      { runId: new Types.ObjectId(runId), status: "pending" },
      { $set: { status: "cancelled" } },
    );
  }
}
