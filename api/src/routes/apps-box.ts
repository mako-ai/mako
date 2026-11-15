/**
 * `POST /api/apps-box/<workspaceId>/events` — a sandbox reporting on itself.
 *
 * Intentionally public (no session): the caller is a process INSIDE the box —
 * the dev-server launcher, a git hook, the box agent — and it authenticates
 * with the same scoped `mgt_` token the box already uses for git. The token
 * names the workspace and the user, which is exactly the (workspace, user)
 * pair that identifies a box, so the box cannot report as anyone but itself.
 */
import { withQueryLabels } from "../services/bigquery-labels";
import { createRouter } from "../openapi/core";
import type { Context } from "hono";
import { z } from "zod";
import { GitTokenError, verifyGitToken } from "../apps/git-token.service";
import { patchBoxState } from "../apps/box-state.service";
import {
  buildBindingParquet,
  materializeAppBinding,
  readBindingMaterialization,
} from "../apps/bindings.service";
import {
  LiveBindingCoolingDown,
  withLiveBindingGuard,
} from "../apps/live-binding-guard";
import { resolveProjectRef } from "../apps/worktree.service";
import {
  LIVE_BINDING_STREAM_CONTENT_TYPE,
  bindingProgressResponse,
  wantsBindingProgress,
} from "../apps/binding-progress";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { loggers } from "../logging";
import { isValidBindingName } from "../apps/binding-name";
import { fail } from "./lib/respond";

const logger = loggers.api("apps-box");

export const appsBoxRoutes = createRouter();

const ChangeSchema = z.union([
  z.string().max(4096),
  z.object({
    path: z.string().max(4096),
    status: z.enum(["added", "modified", "deleted", "renamed"]).optional(),
    // The agent reports staging per change; zod strips undeclared keys, and
    // dropping these made every 2s agent tick wipe the Source Control
    // staged/unstaged grouping that a direct git action had just set.
    staged: z.boolean().optional(),
    unstaged: z.boolean().optional(),
  }),
]);

const PatchSchema = z.object({
  source: z.string().max(40).optional(),
  branch: z.string().max(400).optional(),
  head: z.string().max(64).optional(),
  ahead: z.number().int().min(0).optional(),
  changes: z.array(ChangeSchema).max(5000).optional(),
  devServers: z
    .array(z.object({ slug: z.string().max(200), port: z.number().int() }))
    .max(100)
    .optional(),
  devServer: z
    .object({
      slug: z.string().max(200),
      port: z.number().int(),
      state: z.enum(["serving", "down"]),
    })
    .optional(),
  sandboxId: z.string().max(64).optional(),
  terminals: z.array(z.string().max(64)).max(200).optional(),
});

function bearer(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (!scheme || !value || scheme.toLowerCase() !== "bearer") return null;
  return value.trim();
}

/**
 * The box's `mgt_` token, verified and scoped to this workspace — or null
 * (no bearer, a bad token, another workspace's token).
 */
function boxTokenFor(
  c: Context,
  workspaceId: string,
): ReturnType<typeof verifyGitToken> | null {
  const token = bearer(c);
  if (!token) return null;
  let payload: ReturnType<typeof verifyGitToken>;
  try {
    payload = verifyGitToken(token);
  } catch (error) {
    if (error instanceof GitTokenError) return null;
    throw error;
  }
  return payload.wsId === workspaceId ? payload : null;
}

appsBoxRoutes.post("/:workspaceId/events", async c => {
  const workspaceId = c.req.param("workspaceId");
  const payload = boxTokenFor(c, workspaceId);
  if (!payload) return fail(c, 401, "Unauthorized");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "Expected a JSON body");
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, "Bad patch", { issues: parsed.error.issues });
  }
  const { source, ...patch } = parsed.data;

  try {
    const state = await patchBoxState({
      workspaceId,
      userId: payload.userId,
      patch,
      source: source ?? "box",
    });
    return c.json({ ok: true, updatedAt: state.updatedAt }, 200);
  } catch (error) {
    logger.warn("Apps box event failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(c, 500, "Could not record box state");
  }
});

/**
 * Live binding: run its query NOW and stream fresh parquet. Called by the dev
 * server's data middleware inside the sandbox, authenticated with the same
 * scoped `mgt_` token used for git — so it runs as the box's actor against
 * that actor's connections. Dev/edit only: a published app is served without
 * this token and has no authorized data path yet (apps.md §13.4.1).
 *
 * With `persist: true` (the middleware's answer to the SDK's `refresh()`),
 * the same query is a real materialization: the artifact is stored and the
 * run recorded, exactly as `app_materialize` would — then streamed back so
 * the box's staged copy is the same bytes. A `-- materialization: live`
 * binding stores nothing either way; it is fresh on every read by design.
 */
appsBoxRoutes.post("/:workspaceId/live-binding", async c => {
  const workspaceId = c.req.param("workspaceId");
  const payload = boxTokenFor(c, workspaceId);
  if (!payload) return fail(c, 401, "Unauthorized");

  let body: { slug?: unknown; name?: unknown; persist?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return fail(c, 400, "Expected a JSON body");
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  const name = typeof body.name === "string" ? body.name : "";
  const persist = body.persist === true;
  if (!slug || !name || !isValidBindingName(name)) {
    return fail(c, 400, "slug and a valid binding name are required");
  }

  // `slug` is whatever the box's launcher knows the app by — its path, its
  // folder name or its id all resolve.
  const project = await resolveProjectRef(workspaceId, slug);
  if (!project) return fail(c, 404, "App not found");

  // Guarded: a binding that cannot succeed must not be re-queried as fast as
  // a page can re-request it. See live-binding-guard.ts — 41 abandoned
  // BigQuery jobs in 48 minutes is what this exists to stop.
  const build = (): Promise<{
    filePath: string;
    rowCount: number;
    materializedAt?: Date;
  }> =>
    withLiveBindingGuard({ workspaceId, slug, name }, () =>
      withQueryLabels({ mako_trigger: "live" }, async () => {
        const store =
          persist &&
          (await readBindingMaterialization(project, name, payload.userId)) ===
            "parquet";
        if (!store) return buildBindingParquet(project, name, payload.userId);
        const result = await materializeAppBinding(
          project,
          name,
          payload.userId,
          {
            keepFile: true,
          },
        );
        return { ...result, filePath: result.filePath as string };
      }),
    );

  // The dev server inside the box relays phases to the page (binding-
  // progress.ts): phase lines, then the parquet bytes on the same stream.
  if (
    wantsBindingProgress(
      c.req.header("accept"),
      LIVE_BINDING_STREAM_CONTENT_TYPE,
    )
  ) {
    return bindingProgressResponse(
      async () => {
        try {
          const built = await build();
          return {
            status: 200,
            body: {
              rowCount: built.rowCount,
              ...(built.materializedAt
                ? { materializedAt: built.materializedAt.toISOString() }
                : {}),
            },
            tailFile: built.filePath,
          };
        } catch (error) {
          return liveBindingFailure(error, { workspaceId, slug, name });
        }
      },
      { contentType: LIVE_BINDING_STREAM_CONTENT_TYPE },
    );
  }

  let built: { filePath: string; rowCount: number; materializedAt?: Date };
  try {
    built = await build();
  } catch (error) {
    const failure = liveBindingFailure(error, { workspaceId, slug, name });
    return c.json(
      { success: false as const, ...failure.body },
      failure.status,
      failure.retryAfterMs !== undefined
        ? { "retry-after": String(Math.ceil(failure.retryAfterMs / 1000)) }
        : undefined,
    );
  }

  const stream = createReadStream(built.filePath);
  stream.on("close", () => void rm(built.filePath, { force: true }));
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apache.parquet",
      "cache-control": "no-store",
      "x-mako-row-count": String(built.rowCount),
      ...(built.materializedAt
        ? { "x-mako-materialized-at": built.materializedAt.toISOString() }
        : {}),
    },
  });
});

/**
 * How a live-binding failure is answered — as the HTTP response above and as
 * the phase stream's outcome.
 */
function liveBindingFailure(
  error: unknown,
  where: { workspaceId: string; slug: string; name: string },
):
  | {
      status: 503;
      body: { error: string; retryAfterMs: number };
      retryAfterMs: number;
    }
  | { status: 502; body: { error: string }; retryAfterMs?: undefined } {
  if (error instanceof LiveBindingCoolingDown) {
    // 503 + Retry-After, not 502: the query was not attempted, and this is
    // temporary by construction. Distinguishable in logs from a real failure.
    return {
      status: 503,
      body: {
        error: `This binding failed ${error.failures} time(s) in a row and is not being re-run yet: ${error.message}`,
        retryAfterMs: error.retryAfterMs,
      },
      retryAfterMs: error.retryAfterMs,
    };
  }
  logger.warn("Apps live binding failed", {
    ...where,
    error: error instanceof Error ? error.message : String(error),
  });
  return {
    status: 502,
    body: {
      error: error instanceof Error ? error.message : "Live query failed",
    },
  };
}
