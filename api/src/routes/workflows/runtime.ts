/**
 * The runtime routes for the worker: `workflows/` source, SQL, model and
 * agent calls. They accept a workspace API key with the `workflows:runtime`
 * scope, which a person cannot put on a key; the key decides the workspace.
 */
import { connectionRequest } from "../../connections/proxy.service";
import { ConnectionRequestError } from "../../connections/forward";
import type { Context } from "hono";
import { Types } from "mongoose";
import { WORKFLOWS_DIR } from "../../apps/app-paths";
import { ensureCommitLocally } from "../../apps/cloud-repo.service";
import { isOid, runGitBuffer } from "../../apps/git";
import { repoDirFor, resolveCommit } from "../../apps/repository.service";
import {
  hasWorkspaceApiKeyScope,
  queryAccessFromScopes,
  resolveWorkspaceApiKeyScopes,
} from "../../auth/api-key-scopes";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { checkBillingLimits } from "../../billing/usage-limit.middleware";
import { type IWorkflowRunRef } from "../../database/schema";
import { Workspace } from "../../database/workspace-schema";
import { getRequestContext } from "../../logging/context";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { createRouter } from "../../openapi/core";
import { trackUsage } from "../../services/llm-usage.service";
import { workspaceService } from "../../services/workspace.service";
import { runStepAgent } from "../../workflows/agent";
import {
  HatchetError,
  isHatchetId,
  readWorkspaceTenant,
} from "../../workflows/hatchet";
import {
  WORKFLOW_QUERY_MAX_ROWS,
  WORKFLOW_QUERY_MAX_TIMEOUT_MS,
  WorkflowQueryError,
  runWorkflowQuery,
} from "../../workflows/query";
import { runStartedBy } from "../../workflows/runs";
import { sandboxRunOfKey } from "../../workflows/sandbox";
import { keyIdOf, mintPass } from "../../workflows/pass";
import { isWorkerKey } from "../../workflows/worker-key";
import { fail } from "../lib/respond";
import { logger, onRouteError } from "./shared";

// --- Runtime routes (the worker only) ----------------------------------------

export const workflowRuntimeRoutes = createRouter();
workflowRuntimeRoutes.onError(onRouteError);

const MAX_BUILD_ERROR_CHARS = 8000;
const GATEWAY_BASE_URL = (
  process.env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1/ai"
).replace(/\/+$/, "");

// Decision models are served only by the gateway's v4 API (the base
// `@ai-sdk/gateway` v4 uses), and only to clients that state the gateway
// protocol version. A custom base without a version is left as it is.
const DECISION_GATEWAY_BASE_URL = GATEWAY_BASE_URL.replace(
  /\/v\d+\/ai$/,
  "/v4/ai",
);
const GATEWAY_PROTOCOL_VERSION = "0.0.1";

/**
 * Where a language-model call goes. The gateway answers in the shape of the
 * spec version its path names: `/v1/ai` returns flat token counts
 * (`inputTokens: 13`), `/v3/ai` the per-side objects (`inputTokens:
 * { total: 13 }`) that ai@6 reads. `@ai-sdk/gateway` passes the gateway's
 * result through untouched, so a v3 client sent to `/v1/ai` read every
 * call's usage as 0 tokens. Follow the version the client states; a client
 * that states none (a plain fetch) keeps the configured base.
 */
export function languageModelGatewayBase(
  specificationVersion: string | undefined,
): string {
  const version = Number(specificationVersion);
  if (!Number.isInteger(version) || version < 3) return GATEWAY_BASE_URL;
  return GATEWAY_BASE_URL.replace(/\/v\d+\/ai$/, `/v${version}/ai`);
}

type Worker = { workspaceId: string; userId: string };

/**
 * The run and step a deployed step's request comes from, as its workflow pass
 * names them (workflows/pass.ts): a model call's cost is counted against
 * them, and a write is recorded under the run. Nothing a request says about
 * itself is believed; a person's own run has none.
 */
function workflowRunOf(_c: Context): IWorkflowRunRef | undefined {
  const context = getRequestContext();
  const workflowId = context?.workflow;
  const run = context?.workflowRun;
  if (!workflowId || !run || !isHatchetId(run.runId)) return undefined;
  return {
    workflowId,
    runId: run.runId,
    ...(run.step ? { step: run.step.slice(0, 100) } : {}),
  };
}

// Mako's own auth resolves the key; a session or a key without the worker's
// scope is turned away here (scoped-key-routes.ts already refuses the latter).
workflowRuntimeRoutes.use("*", unifiedAuthMiddleware);

/** The worker behind the request: its workspace and who set it up. */
function workerOf(c: AuthenticatedContext): Worker | null {
  const key = c.get("apiKey") as
    { scopes?: string[]; createdBy?: string } | undefined;
  const workspace = c.get("workspace");
  if (c.get("authType") !== "apiKey" || !key || !workspace) return null;
  const scopes = resolveWorkspaceApiKeyScopes(key.scopes);
  if (!hasWorkspaceApiKeyScope(scopes, "workflows:runtime")) return null;
  return {
    workspaceId: workspace._id.toString(),
    userId: String(key.createdBy),
  };
}

/**
 * A person running workflow code themselves (`mako workflow run`, a sandbox
 * run) with their own login or API key. They act as themselves, exactly as
 * over /api/mcp: the same reads and writes, billed to the workspace. The
 * workflow name they send (X-Mako-Workflow) grants nothing.
 */
function personOf(c: AuthenticatedContext): Worker | null {
  const user = c.get("user") as { id?: string } | undefined;
  const workspace = c.get("workspace");
  const kind = c.get("authType");
  if ((kind !== "apiKey" && kind !== "mcpOAuth") || !user?.id || !workspace) {
    return null;
  }
  return { workspaceId: workspace._id.toString(), userId: String(user.id) };
}

/**
 * A runtime handler: it runs only for a worker key, and is given its worker.
 * `supervisor` routes (what to run, the Hatchet token, the source, passes)
 * are the pod's own and refuse a workflow pass: a step must not get the
 * Hatchet token, nor a pass for another workflow.
 */
const asWorker =
  (
    handler: (c: Context, worker: Worker) => Promise<Response>,
    { person = false, supervisor = false } = {},
  ) =>
  async (c: AuthenticatedContext) => {
    const worker = workerOf(c);
    if (worker && supervisor && c.get("workflowPass")) {
      return fail(
        c,
        403,
        "A workflow pass cannot call the worker's own routes",
      );
    }
    if (worker) return handler(c, worker);
    if (supervisor) return fail(c, 401, "Invalid worker key");
    const self = person ? personOf(c) : null;
    if (!self) return fail(c, 401, "Invalid worker key");
    // A person acts as themselves only while they belong to the workspace:
    // a key outlives its owner's membership, its rights do not.
    if (!(await workspaceService.getMember(self.workspaceId, self.userId))) {
      return fail(
        c,
        403,
        "This key's owner is no longer a member of this workspace, so it cannot run workflow code here.",
      );
    }
    return handler(c, self);
  };

/** The pod's own routes: the worker key, never a workflow pass. */
const asSupervisor = (
  handler: (c: Context, worker: Worker) => Promise<Response>,
) => asWorker(handler, { supervisor: true });

/** The SQL, model and agent routes, which a person's own run calls too. */
const asWorkerOrPerson = (
  handler: (c: Context, worker: Worker) => Promise<Response>,
) => asWorker(handler, { person: true });

// What the worker should run. It polls this: the commit, which workflows
// have their triggers on, and the Hatchet token to connect with, so the
// worker holds one credential only.
workflowRuntimeRoutes.get(
  "/head",
  asSupervisor(async (c, { workspaceId }) => {
    const [workspace, tenant] = await Promise.all([
      Workspace.findById(workspaceId)
        .select("workflows.live workflows.active")
        .lean(),
      readWorkspaceTenant(workspaceId),
    ]);
    const wanted = workspace?.workflows?.live;
    const live = wanted ? { sha: wanted.sha, tree: wanted.tree } : null;
    return c.json({
      hatchetToken: tenant?.token ?? null,
      live,
      active: workspace?.workflows?.active ?? [],
    });
  }),
);

// The worker reports each switch: the commit it now runs, or the commit it
// could not start and why. This is what the UI shows as live and build
// error. A report for a commit that is no longer wanted changes nothing.
workflowRuntimeRoutes.post(
  "/status",
  asSupervisor(async (c, { workspaceId }) => {
    const body = (await c.req.json().catch(() => null)) as {
      sha?: unknown;
      error?: unknown;
    } | null;
    if (typeof body?.sha !== "string" || !isOid(body.sha)) {
      return fail(c, 400, "Invalid report");
    }
    await Workspace.updateOne(
      { _id: new Types.ObjectId(workspaceId), "workflows.live.sha": body.sha },
      typeof body.error === "string"
        ? {
            $set: {
              "workflows.live.failed": {
                sha: body.sha,
                error: body.error.slice(-MAX_BUILD_ERROR_CHARS),
              },
            },
          }
        : {
            $set: { "workflows.live.running": { sha: body.sha } },
            $unset: { "workflows.live.failed": "" },
          },
    );
    return c.json({ ok: true });
  }),
);

// A pass for one step of one deployed run (workflows/pass.ts). The
// dispatcher (worker.mjs) asks before it starts the step program, which then
// calls Mako with the pass and never sees the worker key. Only the deployed
// worker key may ask, for a workflow deployed from main, and only for a run
// of that workflow that is executing now (runs.ts `runStartedBy`): a pass
// for a run that is not one is a 403.
workflowRuntimeRoutes.post(
  "/passes",
  asSupervisor(async (c, { workspaceId }) => {
    const key = c.get("apiKey") as
      { name?: string; scopes?: string[]; keyHash?: string } | undefined;
    if (!isWorkerKey(key) || !key?.keyHash) {
      return fail(c, 403, "Only the deployed worker's key asks for passes");
    }
    const body = (await c.req.json().catch(() => null)) as {
      workflow?: unknown;
      runId?: unknown;
      step?: unknown;
    } | null;
    const workflow = typeof body?.workflow === "string" ? body.workflow : "";
    const runId = typeof body?.runId === "string" ? body.runId : "";
    const step =
      typeof body?.step === "string" && body.step.trim()
        ? body.step.trim().slice(0, 100)
        : undefined;
    if (!workflow || !isHatchetId(runId)) {
      return fail(c, 400, "A workflow and a run id are required");
    }
    const workspace = await Workspace.findById(workspaceId)
      .select("workflows.live.names")
      .lean();
    if (!workspace?.workflows?.live?.names?.includes(workflow)) {
      return fail(c, 403, `${workflow} is not deployed`);
    }
    if (!(await runStartedBy(workspaceId, runId, workflow))) {
      logger.warn("Refused a pass for a run that is not executing", {
        workspaceId,
        workflow,
        runId,
      });
      return fail(
        c,
        403,
        `Run ${runId} is not an executing run of ${workflow}`,
      );
    }
    const { token, expiresAt } = mintPass({
      workspaceId,
      workflow,
      runId,
      step,
      keyId: keyIdOf(key.keyHash),
    });
    return c.json({ pass: token, expiresAt });
  }),
);

// Model calls from a step go through Mako to the AI gateway: the worker holds
// no provider key, and the call is checked against the workspace's plan and
// counted in its usage like a chat turn. Only the gateway calls this file
// knows how to count are forwarded: unstreamed language models, and decision
// models (e.g. TypeSafe's `typesafe-ai/jev`).
async function forwardToGateway(
  c: Context,
  { workspaceId, userId }: Worker,
  kind: "language-model" | "decision-model",
  modelId: string,
): Promise<Response> {
  const limits = await checkBillingLimits(workspaceId, modelId);
  if (!limits.allowed) {
    return fail(
      c,
      (limits.statusCode ?? 402) as 402,
      limits.error?.message ?? "Usage limit reached",
    );
  }
  const headers = new Headers({
    Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY ?? ""}`,
  });
  c.req.raw.headers.forEach((value, name) => {
    // The gateway's own protocol headers and the content type, nothing else.
    if (name === "content-type" || name.startsWith("ai-")) {
      headers.set(name, value);
    }
  });
  const startedAt = Date.now();
  const workflowRun = workflowRunOf(c);
  const decision = kind === "decision-model";
  if (decision && !headers.has("ai-gateway-protocol-version")) {
    // `@ai-sdk/gateway` sends it; a plain fetch from a step does not.
    headers.set("ai-gateway-protocol-version", GATEWAY_PROTOCOL_VERSION);
  }
  const base = decision
    ? DECISION_GATEWAY_BASE_URL
    : languageModelGatewayBase(
        c.req.header("ai-language-model-specification-version"),
      );
  const res = await fetch(`${base}/${kind}`, {
    method: "POST",
    headers,
    body: await c.req.arrayBuffer(),
  }).catch(() => {
    throw new HatchetError("The AI gateway is unreachable", 502);
  });
  const body = await res.text();
  if (res.ok) {
    // A language model reports `{ total }` per side, a decision model a number.
    const tokens = (value: unknown): number =>
      typeof value === "number"
        ? value
        : ((value as { total?: number } | undefined)?.total ?? 0);
    let usage: { inputTokens?: unknown; outputTokens?: unknown } = {};
    let gatewayCost: unknown;
    try {
      const result = JSON.parse(body) as {
        usage?: typeof usage;
        providerMetadata?: { gateway?: { cost?: unknown } };
      };
      usage = result.usage ?? {};
      gatewayCost = result.providerMetadata?.gateway?.cost;
    } catch {
      // Not a model result: nothing to count.
    }
    const inputTokens = tokens(usage.inputTokens);
    const outputTokens = tokens(usage.outputTokens);
    // Mako's price list has no decision models; the gateway says what the
    // call cost, so a decision is billed at that.
    const costUsd = decision ? Number(gatewayCost) : NaN;
    void trackUsage({
      workspaceId,
      userId,
      invocationType: "workflow",
      modelId,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      durationMs: Date.now() - startedAt,
      ...(Number.isFinite(costUsd) ? { costUsd } : {}),
      workflowRun,
    });
  }
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  });
}

workflowRuntimeRoutes.post(
  "/ai/language-model",
  asWorkerOrPerson(async (c, worker) => {
    if (c.req.header("ai-language-model-streaming") === "true") {
      return fail(
        c,
        400,
        "Streaming is not available in a step; use generateText.",
      );
    }
    const modelId = c.req.header("ai-language-model-id") ?? "";
    return forwardToGateway(c, worker, "language-model", modelId);
  }),
);

workflowRuntimeRoutes.post(
  "/ai/decision-model",
  asWorkerOrPerson(async (c, worker) =>
    forwardToGateway(
      c,
      worker,
      "decision-model",
      c.req.header("ai-model-id") ?? "",
    ),
  ),
);

// Mako's own agent for a step (lib/mako `agent()`): a goal in, the answer and
// the tools it used out. It acts as the person who set the worker up.
workflowRuntimeRoutes.post(
  "/agent",
  asWorkerOrPerson(async (c, worker) => {
    const body = (await c.req.json().catch(() => null)) as {
      goal?: unknown;
      model?: unknown;
      maxSteps?: unknown;
    } | null;
    if (typeof body?.goal !== "string" || !body.goal.trim()) {
      return fail(c, 400, "A goal is required");
    }
    return c.json(
      await runStepAgent({
        ...worker,
        workflowRun: workflowRunOf(c),
        goal: body.goal,
        modelId: typeof body.model === "string" ? body.model : undefined,
        maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
      }),
    );
  }),
);

// SQL for a step (lib/mako `query()` / `execute()`): the statement runs
// once and its rows come back as the driver returns them, up to a cap, after
// the same checks as the agent's sql_execute_query (workflows/query.ts). A
// refused, failed, capped or timed-out query is a 400 with its reason.
workflowRuntimeRoutes.post(
  "/query",
  asWorkerOrPerson(async (c, worker) => {
    const body = (await c.req.json().catch(() => null)) as {
      connectionId?: unknown;
      query?: unknown;
      database?: unknown;
      maxRows?: unknown;
      timeoutMs?: unknown;
    } | null;
    if (typeof body?.connectionId !== "string" || !body.connectionId) {
      return fail(c, 400, "A connectionId is required");
    }
    if (typeof body.query !== "string" || !body.query.trim()) {
      return fail(c, 400, "A query is required");
    }
    const whole = (value: unknown, max: number) =>
      value === undefined ||
      (typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= max);
    if (!whole(body.maxRows, WORKFLOW_QUERY_MAX_ROWS)) {
      return fail(
        c,
        400,
        `maxRows must be a whole number from 1 to ${WORKFLOW_QUERY_MAX_ROWS}`,
      );
    }
    if (!whole(body.timeoutMs, WORKFLOW_QUERY_MAX_TIMEOUT_MS)) {
      return fail(
        c,
        400,
        `timeoutMs must be a whole number of milliseconds up to ${WORKFLOW_QUERY_MAX_TIMEOUT_MS}`,
      );
    }
    // The key's scopes, or a login's (query:read: it reads, as over /api/mcp).
    const key = c.get("apiKey") as
      { scopes?: string[]; recordWrites?: boolean } | undefined;
    const scopes = key?.scopes ?? c.get("mcpOAuthScopes");
    // A dry run's SQL only reads: a sandbox one by its key, a deployed one
    // by its run (Hatchet's metadata).
    const run = workflowRunOf(c);
    const dryRun =
      key?.recordWrites === true ||
      (run !== undefined &&
        (await runStartedBy(worker.workspaceId, run.runId, run.workflowId))
          ?.writes === "record");
    const access = queryAccessFromScopes(resolveWorkspaceApiKeyScopes(scopes));
    try {
      return c.json(
        await runWorkflowQuery(
          {
            ...worker,
            // Never more than the key allows.
            queryAccess: dryRun && access !== "none" ? "read" : access,
          },
          {
            connectionId: body.connectionId,
            query: body.query,
            database:
              typeof body.database === "string" && body.database
                ? body.database
                : undefined,
            maxRows: body.maxRows as number | undefined,
            timeoutMs: body.timeoutMs as number | undefined,
          },
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowQueryError) {
        return fail(
          c,
          400,
          dryRun
            ? `${error.message} (This is a dry run: its SQL only reads.)`
            : error.message,
        );
      }
      throw error;
    }
  }),
);

// One request to a service through a source connection (lib/mako
// `connection(id)`): Mako adds the stored credential, which workflow code
// never sees. A read needs live reads on for the connection; a write needs
// this workflow (by name, or "All deployed workflows") or, on a person's own run, this
// person on the connection's writers list (connections/proxy.service.ts); a
// dry run records its writes instead of sending them (202, `recorded:
// true`). The service's status comes back as is.
workflowRuntimeRoutes.post(
  "/connections/:connection/request",
  asWorkerOrPerson(async (c, worker) => {
    const body = (await c.req.json().catch(() => null)) as {
      method?: unknown;
      path?: unknown;
      query?: unknown;
      headers?: unknown;
      body?: unknown;
    } | null;
    if (typeof body?.method !== "string" || typeof body.path !== "string") {
      return fail(c, 400, "A method and a path are required");
    }
    const record = (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, never>)
        : undefined;
    // Idempotency-Key, like every caller header, comes in `headers`.
    const headers: Record<string, string> = { ...record(body.headers) };
    const key = c.get("apiKey") as
      | {
          agentRun?: boolean;
          recordWrites?: boolean;
          name?: string;
          createdBy?: unknown;
        }
      | undefined;
    // A sandbox run's key says what its writes do: refused (started with an
    // API key) or recorded (a dry run, by the run its name gives).
    const refuseRun = key?.agentRun === true;
    const dryRunKey = key?.recordWrites === true;
    const sandboxRun = dryRunKey ? sandboxRunOfKey(key) : null;
    const mcpLogin = c.get("authType") === "mcpOAuth";
    const run = workflowRunOf(c);
    const deployedRun = run
      ? { runId: run.runId, ...(run.step ? { step: run.step } : {}) }
      : undefined;
    try {
      return c.json(
        await connectionRequest({
          workspaceId: worker.workspaceId,
          connection: c.req.param("connection") ?? "",
          request: {
            method: body.method,
            path: body.path,
            query: record(body.query),
            headers,
            body: body.body,
          },
          // An MCP login calling here itself is an agent acting for the
          // person: it only reads. A sandbox run's key may say so too. A
          // person's API key, their own runs (an agent's included) and the
          // deployed worker keep their rights: Mako cannot tell who uses a
          // key, so a key given to an agent writes as its person.
          readOnly: mcpLogin || refuseRun || dryRunKey,
          // A deployed run: asked on a write, of the run the worker names,
          // which must be a run of the workflow the request is for and still
          // executing (runs.ts `runStartedBy`).
          runStarter: () =>
            runStartedBy(worker.workspaceId, run?.runId, run?.workflowId),
          // Where a dry run's writes are recorded: a sandbox run by its
          // key's name, a deployed one by the run the worker names (used
          // only when Hatchet says it is a dry run).
          record: dryRunKey
            ? sandboxRun
              ? { runId: sandboxRun, userId: worker.userId }
              : undefined
            : refuseRun || mcpLogin
              ? undefined
              : deployedRun,
          signal: c.req.raw.signal,
        }),
      );
    } catch (error) {
      if (error instanceof ConnectionRequestError) {
        return fail(c, error.status, error.message);
      }
      throw error;
    }
  }),
);

// `workflows/` at a commit, as a gzipped tarball. The key limits the worker to
// its own workspace's repository.
workflowRuntimeRoutes.get(
  "/source/:sha",
  asSupervisor(async (c, { workspaceId }) => {
    const sha = c.req.param("sha") ?? "";
    if (!isOid(sha)) return fail(c, 400, "Invalid commit");
    // A fresh API instance has an empty disk: restore the repository and this
    // commit from the mirror first.
    const workspace = await Workspace.findById(workspaceId)
      .select("workflows.live")
      .lean();
    // Only what the worker was told to run: no browsing the repository.
    if (sha !== workspace?.workflows?.live?.sha) {
      return fail(c, 404, "Not a deployed commit");
    }
    await ensureCommitLocally(workspaceId, sha);
    const repoDir = repoDirFor(workspaceId);
    const present = await resolveCommit(repoDir, sha).catch(() => null);
    if (!present) {
      // Another instance took the push and the mirror does not have it yet:
      // the worker asks again later.
      return fail(c, 404, "That commit is not on this instance");
    }
    const tarball = await runGitBuffer([
      "-C",
      repoDir,
      "archive",
      "--format=tar.gz",
      sha,
      WORKFLOWS_DIR,
    ]).catch(() => null);
    return tarball
      ? new Response(new Uint8Array(tarball), {
          status: 200,
          headers: { "Content-Type": "application/gzip" },
        })
      : fail(c, 404, "No workflows/ folder at that commit");
  }),
);
