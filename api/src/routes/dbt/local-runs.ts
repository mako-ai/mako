/** `mako dbt run|build|test` from a laptop checkout, built by the runner. */
import { Hono } from "hono";
import { z } from "zod";
import { resolveWorkspaceApiKeyScopes } from "../../auth/api-key-scopes";
import {
  LocalRunError,
  findOwnLocalRun,
  sliceRunLogs,
  startLocalDbtRun,
  type LocalRunAuthority,
} from "../../dbt/local-run.service";
import {
  LocalOverlayError,
  normalizeLocalOverlay,
} from "../../dbt/local-overlay";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  reconcileStaleQueuedRun,
  requestDbtRunCancel,
} from "../../dbt/dbt-run.service";
import {
  badRequest,
  serverError,
  publishDbtEvent,
  runActorOf,
} from "./context";
import { fail } from "../lib/respond";

export const dbtLocalRunRoutes = new Hono();

// ---------------------------------------------------------------------------
// `mako dbt run|build|test` — a laptop checkout, built by the runner
// ---------------------------------------------------------------------------

const localRunSchema = z.object({
  projectId: z.string().optional(),
  command: z.enum(["run", "build", "test"]),
  select: z.string().min(1).max(256),
  environment: z.string().min(1).max(64).optional(),
  fullRefresh: z.boolean().optional(),
  defer: z.boolean().optional(),
  sourceLabel: z.string().max(200).optional(),
  baseSha: z.string().optional(),
  files: z.record(z.string(), z.string()).default({}),
  deletes: z.array(z.string()).default([]),
});

/** Who is asking, and with what authority (see local-run.service). */
function localRunCaller(
  c: AuthenticatedContext,
): { userId: string; authority: LocalRunAuthority } | null {
  const userId = c.get("user")?.id?.toString();
  if (!userId) return null;
  const authType = c.get("authType");
  if (authType === "session") {
    return { userId, authority: { kind: "session" } };
  }
  const raw =
    authType === "mcpOAuth"
      ? (c as unknown as { get(key: string): unknown }).get("mcpOAuthScopes")
      : c.get("apiKey")?.scopes;
  return {
    userId,
    authority: { kind: "token", scopes: resolveWorkspaceApiKeyScopes(raw) },
  };
}

function localRunFailure(c: AuthenticatedContext, error: unknown) {
  if (error instanceof LocalRunError) {
    return fail(c, error.status, error.message);
  }
  if (error instanceof LocalOverlayError) {
    return badRequest(c, error.message);
  }
  return serverError(c, error, "Failed to start dbt run");
}

dbtLocalRunRoutes.post("/local-runs", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const caller = localRunCaller(c);
    if (!workspaceId || !caller) {
      return fail(c, 401, "Unauthorized");
    }
    const parsed = localRunSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
    }
    const body = parsed.data;
    const overlay = normalizeLocalOverlay(body);
    const result = await startLocalDbtRun({
      workspaceId,
      userId: caller.userId,
      actor: runActorOf(c),
      authority: caller.authority,
      projectId: body.projectId,
      command: body.command,
      select: body.select,
      environment: body.environment,
      fullRefresh: body.fullRefresh,
      defer: body.defer,
      sourceLabel: body.sourceLabel,
      overlay,
    });
    publishDbtEvent(c, {
      type: "dbt.run.updated",
      projectId: result.projectId,
      runId: result.run._id.toString(),
    });
    if (result.provisionedEnvironment) {
      publishDbtEvent(c, {
        type: "dbt.project.updated",
        projectId: result.projectId,
      });
    }
    return c.json({
      success: true,
      runId: result.run._id.toString(),
      projectId: result.projectId,
      environment: result.run.environment,
      commands: result.run.commands,
      defer: Boolean(result.run.deferToProduction),
      sourceBranch: result.run.sourceBranch,
      ...(result.provisionedEnvironment
        ? { provisionedEnvironment: result.provisionedEnvironment }
        : {}),
    });
  } catch (error) {
    return localRunFailure(c, error);
  }
});

dbtLocalRunRoutes.get("/local-runs/:runId", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const caller = localRunCaller(c);
    if (!workspaceId || !caller) {
      return fail(c, 401, "Unauthorized");
    }
    const logsSince = Math.max(
      0,
      Math.floor(Number(c.req.query("logsSince")) || 0),
    );
    const found = await findOwnLocalRun({
      logsSince,
      workspaceId,
      userId: caller.userId,
      runId: c.req.param("runId") as string,
    });
    if (!found) {
      return fail(c, 404, "Run not found");
    }
    const run = await reconcileStaleQueuedRun(found, {
      persist: false,
    });
    // logsSince = the absolute line number the client has read up to (the
    // previous answer's logCursor) — it survives the executor's log cap.
    const page = sliceRunLogs(run.logs ?? [], run.logTotal, logsSince);
    return c.json({
      success: true,
      run: {
        _id: run._id.toString(),
        projectId: run.projectId.toString(),
        status: run.status,
        environment: run.environment,
        commands: run.commands,
        sourceBranch: run.sourceBranch,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        error: run.error,
        stepResults: run.stepResults ?? [],
        logs: page.logs,
        logCursor: page.logCursor,
        ...(page.logsSkipped ? { logsSkipped: page.logsSkipped } : {}),
      },
    });
  } catch (error) {
    return serverError(c, error, "Failed to fetch dbt run");
  }
});

dbtLocalRunRoutes.post(
  "/local-runs/:runId/cancel",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const caller = localRunCaller(c);
      if (!workspaceId || !caller) {
        return fail(c, 401, "Unauthorized");
      }
      const runId = c.req.param("runId") as string;
      const found = await findOwnLocalRun({
        workspaceId,
        userId: caller.userId,
        runId,
      });
      if (!found) {
        return fail(c, 404, "Run not found");
      }
      const result = await requestDbtRunCancel({
        workspaceId,
        runId,
        cancelledBy: caller.userId,
      });
      if (!result) {
        return fail(c, 404, "Run not found");
      }
      publishDbtEvent(c, {
        type: "dbt.run.updated",
        projectId: found.projectId.toString(),
        runId,
      });
      return c.json({ success: true, status: result.status });
    } catch (error) {
      return serverError(c, error, "Failed to cancel dbt run");
    }
  },
);
