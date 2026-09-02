/**
 * `POST /api/apps-box/<workspaceId>/events` — a sandbox reporting on itself.
 *
 * Intentionally public (no session): the caller is a process INSIDE the box —
 * the dev-server launcher, a git hook, the box agent — and it authenticates
 * with the same scoped `mgt_` token the box already uses for git. The token
 * names the workspace and the user, which is exactly the (workspace, user)
 * pair that identifies a box, so the box cannot report as anyone but itself.
 */
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
import { synthesizeProjectFromFolder } from "../apps/worktree.service";
import { AppProject } from "../database/workspace-schema";
import { Types } from "mongoose";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { loggers } from "../logging";

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

appsBoxRoutes.post("/:workspaceId/events", async c => {
  const token = bearer(c);
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  let payload;
  try {
    payload = verifyGitToken(token);
  } catch (error) {
    if (error instanceof GitTokenError) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    throw error;
  }
  const workspaceId = c.req.param("workspaceId");
  if (payload.wsId !== workspaceId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Bad patch", issues: parsed.error.issues }, 400);
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
    return c.json({ error: "Could not record box state" }, 500);
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
  const token = bearer(c);
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  let payload;
  try {
    payload = verifyGitToken(token);
  } catch (error) {
    if (error instanceof GitTokenError) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    throw error;
  }
  const workspaceId = c.req.param("workspaceId");
  if (payload.wsId !== workspaceId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: { slug?: unknown; name?: unknown; persist?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  const name = typeof body.name === "string" ? body.name : "";
  const persist = body.persist === true;
  if (!slug || !name || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)) {
    return c.json({ error: "slug and a valid binding name are required" }, 400);
  }

  const project =
    (await AppProject.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      slug,
    })) ?? (await synthesizeProjectFromFolder(workspaceId, slug));
  if (!project) return c.json({ error: "App not found" }, 404);

  let built: { filePath: string; rowCount: number; materializedAt?: Date };
  try {
    // Guarded: a binding that cannot succeed must not be re-queried as fast as
    // a page can re-request it. See live-binding-guard.ts — 41 abandoned
    // BigQuery jobs in 48 minutes is what this exists to stop.
    built = await withLiveBindingGuard(
      { workspaceId, slug, name },
      async () => {
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
      },
    );
  } catch (error) {
    if (error instanceof LiveBindingCoolingDown) {
      // 503 + Retry-After, not 502: the query was not attempted, and this is
      // temporary by construction. Distinguishable in logs from a real failure.
      return c.json(
        {
          error: `This binding failed ${error.failures} time(s) in a row and is not being re-run yet: ${error.message}`,
          retryAfterMs: error.retryAfterMs,
        },
        503,
        { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) },
      );
    }
    logger.warn("Apps live binding failed", {
      workspaceId,
      slug,
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { error: error instanceof Error ? error.message : "Live query failed" },
      502,
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
