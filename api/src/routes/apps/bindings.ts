/**
 * Data bindings: listing, serving artifacts and snapshots, materializing,
 * the laptop dev-build loop and asynchronous binding jobs.
 */
import { isValidBindingName } from "../../apps/binding-name";
import { withQueryLabels } from "../../services/bigquery-labels";
import { createRoute, z } from "@hono/zod-openapi";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import {
  bindingArtifactKeyByName,
  getBindingState,
  materializeAppBinding,
  readBindings,
} from "../../apps/bindings.service";
import { DevBuildError, planDevBuild } from "../../apps/binding-dev-build";
import {
  getBindingJob,
  serializeBindingJob,
  type BindingJobDoc,
} from "../../apps/binding-jobs";
import { enqueueBindingJob } from "../../inngest/functions/apps-binding-job";
import { getArtifactStore } from "../../services/artifact-store.service";
import {
  serveJsonArtifact,
  serveParquetArtifact,
} from "../../services/artifact-delivery.service";
import { snapshotArtifactKey } from "../../services/binding-snapshot";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  ProjectParam,
  handleError,
  loadDevBuildProject,
  loadProject,
  actorOf,
} from "./shared";
import { fail } from "../lib/respond";

export const appsBindingRoutes = createRouter();

appsBindingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bindings",
    tags: ["Apps"],
    summary: "List the app's data bindings (front matter + build state)",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const bindings = await readBindings(loaded.project, actorOf(loaded));
      const projectId = loaded.project._id.toString();
      const workspaceId = loaded.project.workspaceId?.toString();
      const out = [];
      for (const b of bindings) {
        const state = await getBindingState(projectId, b.name, workspaceId);
        out.push({
          name: b.name,
          connectionId: b.connectionId,
          language: "sql" as const,
          materialization: b.materialization,
          code: b.code,
          schedule: b.schedule ?? null,
          lastMaterializedAt: state?.lastMaterializedAt ?? null,
          rowCount: state?.lastRowCount ?? null,
          history: state?.history ?? [],
        });
      }
      return c.json({ success: true as const, bindings: out }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsBindingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bindings/{name}/artifact",
    tags: ["Apps"],
    summary: "Serve a binding's materialized parquet artifact",
    description:
      "Redirects to a short-lived signed bucket URL when the artifact " +
      "store supports it (the browser downloads directly from the bucket); " +
      "streams the bytes otherwise. Follow redirects.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: {
      ...OPEN_RESPONSES,
      302: { description: "Redirect to a short-lived signed artifact URL" },
    },
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { name } = c.req.valid("param");
      if (!isValidBindingName(name)) {
        return fail(c, 400, "Invalid binding name");
      }
      const key = await bindingArtifactKeyByName(
        loaded.project,
        name,
        loaded.userId ?? "",
      );
      const response = key
        ? await serveParquetArtifact(getArtifactStore(), key, {
            cacheControl: "no-store",
          })
        : null;
      if (!response) {
        return fail(c, 404, `Binding "${name}" is not materialized`);
      }
      return response;
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsBindingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bindings/{name}/snapshot",
    tags: ["Apps"],
    summary: "Serve a binding's preview snapshot (committed definition)",
    description:
      "The first N rows of the committed binding's stored parquet, in build " +
      "order (schema + total row count), for `useQuery(name, { snapshot: " +
      "true })` to paint before DuckDB-WASM loads. 404 when the binding was " +
      "never built, was built before snapshots existed, or has a column " +
      "type a snapshot cannot carry — callers wait for the parquet.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { name } = c.req.valid("param");
      if (!isValidBindingName(name)) {
        return fail(c, 400, "Invalid binding name");
      }
      const parquetKey = await bindingArtifactKeyByName(
        loaded.project,
        name,
        loaded.userId ?? "",
      );
      const response = parquetKey
        ? await serveJsonArtifact(
            getArtifactStore(),
            snapshotArtifactKey(parquetKey),
            { cacheControl: "no-store" },
          )
        : null;
      if (!response) {
        return fail(c, 404, `Snapshot for binding "${name}" is not available`);
      }
      return response;
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsBindingRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/bindings/{name}/materialize",
    tags: ["Apps"],
    summary: "Materialize a data binding (bindings-as-files) to parquet",
    description:
      "Synchronous by default. With `?async=1` it answers 202 with a " +
      "`jobId` at once and builds in the background — for builds longer " +
      "than the edge's 100 s request limit; poll " +
      "`GET …/binding-jobs/{jobId}`.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
      query: z.object({
        async: z.enum(["0", "1", "true", "false"]).optional(),
      }),
    },
    responses: {
      ...OPEN_RESPONSES,
      202: { description: "Queued: poll the returned binding job" },
    },
  }),
  async c => {
    try {
      const { name } = c.req.valid("param");
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { async: asyncFlag } = c.req.valid("query");
      if (asyncFlag === "1" || asyncFlag === "true") {
        if (!isValidBindingName(name)) {
          return fail(c, 400, "Invalid binding name");
        }
        const job = await enqueueBindingJob({
          workspaceId: loaded.project.workspaceId.toString(),
          projectId: loaded.project._id.toString(),
          name,
          kind: "materialize",
          actorId: actorOf(loaded),
          userId: loaded.userId,
          canWrite: true,
          request: {},
        });
        return c.json(
          { success: true as const, ...serializeBindingJob(job) },
          202,
        );
      }
      const result = await withQueryLabels({ mako_trigger: "manual" }, () =>
        materializeAppBinding(loaded.project, name, actorOf(loaded)),
      );
      return c.json({ success: true as const, ...result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsBindingRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/bindings/{name}/dev-build",
    tags: ["Apps"],
    summary: "Build a binding from local (uncommitted) SQL for `vite dev`",
    description:
      "The laptop dev loop behind `makoData()`: send the local " +
      "`bindings/<name>.sql` text and get back the parquet of exactly that " +
      "query, run read-only through the workspace connection its front " +
      "matter names. The text is the whole input: no sandbox and (for a " +
      "caller with edit access) no repo state is read, so a binding that " +
      "exists only in the local checkout builds. Text whose content-addressed " +
      "build is already stored (the published binding) is served from that " +
      "artifact; anything else — an edit, a new binding, a refresh, or " +
      "`dbtEnvironment` rendering `{{ dbt_schema }}` " +
      "against a dev dbt environment (per relation: ones the environment " +
      "has not built read prod, unless `dbtDefer: false`) — is a draft: " +
      "built and streamed back, reused for 30 minutes (same connection + " +
      "rendered SQL) unless `refresh`, never stored as the app's artifact, " +
      "so published viewers never see it. A draft that keeps failing " +
      "answers 503 with Retry-After instead of re-running. May redirect to " +
      "a short-lived signed artifact URL; follow redirects. With " +
      "`async: true`, a build (not a stored artifact) answers 202 with a " +
      "`jobId` to poll at `GET …/binding-jobs/{jobId}` instead.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              source: z
                .string()
                .min(1)
                .max(512 * 1024),
              dbtEnvironment: z.string().min(1).max(64).optional(),
              dbtDefer: z.boolean().optional(),
              refresh: z.boolean().optional(),
              async: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      ...OPEN_RESPONSES,
      202: { description: "Queued: poll the returned binding job" },
      302: { description: "Redirect to a short-lived signed artifact URL" },
    },
  }),
  async c => {
    try {
      const { name } = c.req.valid("param");
      const {
        source,
        dbtEnvironment,
        dbtDefer,
        refresh,
        async: asyncBuild,
      } = c.req.valid("json");
      const loaded = await loadDevBuildProject(c, { checkWrite: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const request = {
        project: loaded.project,
        name,
        actorId: actorOf(loaded),
        userId: loaded.userId,
        canWrite: loaded.canWrite,
        source,
        dbtEnvironment,
        dbtDefer,
        refresh,
        unregistered: loaded.unregistered,
      };
      // Refusals and a stored artifact answer at once either way; only an
      // actual build is handed to a job when the caller can poll for it.
      const plan = await planDevBuild(request);
      if (plan.kind === "build" && asyncBuild) {
        const job = await enqueueBindingJob({
          workspaceId: loaded.project.workspaceId.toString(),
          projectId: loaded.project._id.toString(),
          name,
          kind: "dev-build",
          actorId: request.actorId,
          userId: request.userId,
          canWrite: request.canWrite,
          ...(loaded.unregistered ? { unregistered: true } : {}),
          request: { source, dbtEnvironment, dbtDefer, refresh },
        });
        return c.json(
          { success: true as const, ...serializeBindingJob(job) },
          202,
        );
      }
      const result = plan.kind === "build" ? await plan.run() : plan;
      if (result.kind === "artifact") {
        const response = await serveParquetArtifact(
          getArtifactStore(),
          result.artifactKey,
          {
            cacheControl: "no-store",
            extraHeaders: {
              "x-mako-build":
                result.source === "draft-cache" ? "draft-cache" : "artifact",
            },
          },
        );
        if (response) return response;
        return fail(c, 404, `Binding "${name}" is not materialized`);
      }
      const stream = createReadStream(result.filePath);
      stream.on("close", () => void fs.rm(result.filePath, { force: true }));
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apache.parquet",
          "cache-control": "no-store",
          "x-mako-build": result.kind,
          "x-mako-row-count": String(result.rowCount),
          "x-mako-materialized-at": result.builtAt.toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof DevBuildError) {
        return c.json(
          {
            success: false,
            error: error.message,
            ...(error.retryAfterMs !== undefined
              ? { retryAfterMs: error.retryAfterMs }
              : {}),
          },
          error.status,
          error.retryAfterMs !== undefined
            ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) }
            : undefined,
        );
      }
      return handleError(c, error);
    }
  },
);

appsBindingRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/bindings/{name}/dev-snapshot",
    tags: ["Apps"],
    summary: "Preview snapshot of the artifact a local binding text maps to",
    description:
      "The laptop `makoData()` plugin's `__data/<name>.snapshot.json`: send " +
      "the same body as `dev-build`, get the snapshot of exactly the stored " +
      "artifact that `dev-build` would answer with for that text (the " +
      "committed artifact, or a cached draft) — never another definition's. " +
      "404 when that text has no stored artifact yet (a build is needed) or " +
      "the artifact has no snapshot. Never builds anything.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              source: z
                .string()
                .min(1)
                .max(512 * 1024),
              dbtEnvironment: z.string().min(1).max(64).optional(),
              dbtDefer: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { name } = c.req.valid("param");
      const { source, dbtEnvironment, dbtDefer } = c.req.valid("json");
      const loaded = await loadDevBuildProject(c, { checkWrite: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const notAvailable = () =>
        fail(c, 404, `Snapshot for binding "${name}" is not available`);
      let plan: Awaited<ReturnType<typeof planDevBuild>>;
      try {
        plan = await planDevBuild({
          project: loaded.project,
          name,
          actorId: actorOf(loaded),
          userId: loaded.userId,
          canWrite: loaded.canWrite,
          source,
          dbtEnvironment,
          dbtDefer,
          refresh: false,
          unregistered: loaded.unregistered,
        });
      } catch (error) {
        // A refusal for a build is no snapshot either; the parquet request
        // beside this one reports the reason.
        if (error instanceof DevBuildError) return notAvailable();
        throw error;
      }
      // "build": nothing stored for this text yet — do not start one here.
      if (plan.kind !== "artifact") return notAvailable();
      const response = await serveJsonArtifact(
        getArtifactStore(),
        snapshotArtifactKey(plan.artifactKey),
        { cacheControl: "no-store" },
      );
      return response ?? notAvailable();
    } catch (error) {
      return handleError(c, error);
    }
  },
);

const BindingJobParam = ProjectParam.extend({
  jobId: z.string().openapi({ param: { name: "jobId", in: "path" } }),
});

/** The caller's job on this app, or an error response. */
async function loadBindingJob(
  c: AuthenticatedContext,
  jobId: string,
): Promise<{ job: BindingJobDoc } | { errorResponse: Response }> {
  // A dev-build job of an app not on main yet is polled under the same
  // synthesized id it was queued under.
  const loaded = await loadDevBuildProject(c, { checkWrite: false });
  if ("errorResponse" in loaded) return loaded;
  const job = await getBindingJob(
    loaded.project._id.toString(),
    jobId,
    new Date(),
    loaded.project.workspaceId?.toString(),
  );
  // Another member's job is as good as missing: a draft job's result is
  // their uncommitted SQL. Match actorId verbatim (or userId across an
  // in-flight auth cutover where the caller's session switched to UUIDv7).
  const callerActor = actorOf(loaded);
  const ownedByCaller =
    job !== null &&
    (job.actorId === callerActor ||
      (loaded.userId !== undefined && job.userId === loaded.userId));
  if (!ownedByCaller) {
    return {
      errorResponse: fail(c, 404, "No such binding job"),
    };
  }
  return { job };
}

appsBindingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/binding-jobs/{jobId}",
    tags: ["Apps"],
    summary: "Status of an asynchronous binding build",
    description:
      "`queued` → `running` → `ready` (fetch `…/artifact`) or `error` " +
      "(`error`, and `errorStatus`: what the synchronous call would have " +
      "answered). Jobs are kept for an hour.",
    security: AUTH_SECURITY,
    request: { params: BindingJobParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { jobId } = c.req.valid("param");
      const loaded = await loadBindingJob(c, jobId);
      if ("errorResponse" in loaded) return loaded.errorResponse;
      return c.json(
        { success: true as const, ...serializeBindingJob(loaded.job) },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsBindingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/binding-jobs/{jobId}/artifact",
    tags: ["Apps"],
    summary: "The parquet an asynchronous binding build produced",
    security: AUTH_SECURITY,
    request: { params: BindingJobParam },
    responses: {
      ...OPEN_RESPONSES,
      302: { description: "Redirect to a short-lived signed artifact URL" },
    },
  }),
  async c => {
    try {
      const { jobId } = c.req.valid("param");
      const loaded = await loadBindingJob(c, jobId);
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { job } = loaded;
      if (job.status !== "ready" || !job.result) {
        return fail(c, 409, `Binding job is ${job.status}`, {
          status: job.status,
        });
      }
      const response = await serveParquetArtifact(
        getArtifactStore(),
        job.result.artifactKey,
        {
          cacheControl: "no-store",
          extraHeaders: { "x-mako-build": job.result.build },
        },
      );
      if (response) return response;
      return fail(c, 404, "The build's artifact is gone");
    } catch (error) {
      return handleError(c, error);
    }
  },
);
