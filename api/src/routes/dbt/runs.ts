import { parseEntityId } from "../../database/pg/id-codec";
/** dbt run history, triggers, retries, cancels and logs. */
import { describeQueuedRun } from "../../dbt/dbt-run-queue";
import { Hono } from "hono";
import { Readable } from "stream";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { dbtRepo } from "../../repositories/dbt";
import {
  reconcileStaleQueuedRun,
  reconcileStaleQueuedRuns,
  requestDbtRunCancel,
  triggerDbtRunRetry,
} from "../../dbt/dbt-run.service";
import { getArtifactStore } from "../../services/artifact-store.service";
import {
  getUserId,
  badRequest,
  serverError,
  publishDbtEvent,
  findProject,
  runActorOf,
} from "./context";
import { fail } from "../lib/respond";
import { redactRunActor, type DbtRunActor } from "../../dbt/run-actor";

export const dbtRunRoutes = new Hono();

/** A run as the API returns it: its actor through the same redaction as MCP. */
function withRedactedActor<T extends { actor?: unknown }>(run: T): T {
  if (!run.actor) return run;
  return { ...run, actor: redactRunActor(run.actor as DbtRunActor) };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

dbtRunRoutes.get(
  "/projects/:projectId/runs",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const jobId = c.req.query("jobId");
      const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
      const runs = await dbtRepo.listRuns(
        {
          workspaceId: project.workspaceId,
          projectId: project._id,
          ...(jobId && parseEntityId(jobId) ? { jobId } : {}),
        },
        { limit },
      );
      // Present any run stuck in "queued" past the worker-pickup deadline as
      // errored so history never shows a perpetually-queued run. Read-only on
      // this GET path (persist: false) — the cron sweeper is the single writer.
      const reconciled = await reconcileStaleQueuedRuns(runs, {
        persist: false,
      });
      return c.json({
        success: true,
        runs: reconciled.map(withRedactedActor),
      });
    } catch (error) {
      return serverError(c, error, "Failed to list dbt runs");
    }
  },
);

dbtRunRoutes.get(
  "/projects/:projectId/runs/:runId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const runId = c.req.param("runId") as string;
      if (!parseEntityId(runId)) {
        return badRequest(c, "Invalid run id");
      }
      const logsSince = Math.max(
        0,
        Math.floor(Number(c.req.query("logsSince")) || 0),
      );
      const found = await dbtRepo.findRunWithLogs(
        runId,
        {
          projectId: project._id,
        },
        logsSince,
      );
      if (!found) {
        return fail(c, 404, "Run not found");
      }
      // Present a stuck-queued run as errored so the poller (DbtRunCard / Runs
      // view) sees a terminal status instead of spinning on "queued". Read-only
      // on this GET path (persist: false) — the cron sweeper is the writer.
      const run = await reconcileStaleQueuedRun(found, { persist: false });
      // logsSince = number of log lines the client already has (cursor).

      const logs = run.logs ?? [];
      // Why a queued run is waiting (the run holding its lane's slot).
      const queue =
        run.status === "queued" ? await describeQueuedRun(run) : null;
      return c.json({
        success: true,
        run: {
          ...withRedactedActor(run),
          logs,
          logCursor: run.logTotal,
          ...(queue ? { queue } : {}),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to fetch dbt run");
    }
  },
);

dbtRunRoutes.post(
  "/projects/:projectId/runs/:runId/cancel",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const runId = c.req.param("runId") as string;
      if (!parseEntityId(runId)) {
        return badRequest(c, "Invalid run id");
      }
      const result = await requestDbtRunCancel({
        workspaceId: project.workspaceId.toString(),
        runId,
        cancelledBy: getUserId(c),
      });
      if (!result) {
        return fail(c, 404, "Run not found");
      }
      // Idempotent: an already-terminal run echoes its current status (no
      // error), and the queued→running / finished-during-cancel races return
      // the real status rather than failing.
      publishDbtEvent(c, {
        type: "dbt.run.updated",
        projectId: project._id.toString(),
        runId,
      });
      return c.json({
        success: true,
        status: result.status,
        cancelledAt: result.cancelledAt,
        cancelledBy: result.cancelledBy,
      });
    } catch (error) {
      return serverError(c, error, "Failed to cancel dbt run");
    }
  },
);

dbtRunRoutes.post(
  "/projects/:projectId/runs/:runId/retry",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const runId = c.req.param("runId") as string;
      if (!parseEntityId(runId)) {
        return badRequest(c, "Invalid run id");
      }
      const run = await triggerDbtRunRetry({
        workspaceId: project.workspaceId.toString(),
        runId,
        triggeredBy: getUserId(c),
        actor: runActorOf(c),
      });
      if (!run) {
        return badRequest(
          c,
          "Run cannot be retried (must be a failed run with results)",
        );
      }
      publishDbtEvent(c, {
        type: "dbt.run.updated",
        projectId: project._id.toString(),
        runId: run._id.toString(),
        jobId: run.jobId?.toString(),
      });
      return c.json({ success: true, runId: run._id.toString() });
    } catch (error) {
      return serverError(c, error, "Failed to retry dbt run");
    }
  },
);

dbtRunRoutes.get(
  "/projects/:projectId/runs/:runId/artifacts/:kind",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const runId = c.req.param("runId") as string;
      const kind = c.req.param("kind") as string;
      if (!parseEntityId(runId)) {
        return badRequest(c, "Invalid run id");
      }
      if (
        ![
          "manifest",
          "semanticManifest",
          "runResults",
          "catalog",
          "sources",
        ].includes(kind)
      ) {
        return badRequest(
          c,
          "kind must be manifest | semanticManifest | runResults | catalog | sources",
        );
      }
      const run = await dbtRepo.findRunById(runId, {
        projectId: project._id,
      });
      const key =
        run?.artifactKeys?.[
          kind as
            | "manifest"
            | "semanticManifest"
            | "runResults"
            | "catalog"
            | "sources"
        ];
      if (!key) {
        return fail(c, 404, "Artifact not found");
      }
      const store = getArtifactStore();
      const stream = await store.openReadStream(key);
      if (!stream) {
        return fail(c, 404, "Artifact not found");
      }
      return new Response(
        Readable.toWeb(stream as Readable) as ReadableStream,
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, max-age=86400, immutable",
          },
        },
      );
    } catch (error) {
      return serverError(c, error, "Failed to stream dbt artifact");
    }
  },
);
