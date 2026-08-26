/**
 * `POST /api/apps-v2-box/<workspaceId>/events` — a sandbox reporting on itself.
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
import { GitTokenError, verifyGitToken } from "../apps-v2/git-token.service";
import { patchBoxState } from "../apps-v2/box-state.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2-box");

export const appsV2BoxRoutes = createRouter();

const ChangeSchema = z.union([
  z.string().max(4096),
  z.object({
    path: z.string().max(4096),
    status: z.enum(["added", "modified", "deleted", "renamed"]).optional(),
  }),
]);

const PatchSchema = z.object({
  source: z.string().max(40).optional(),
  branch: z.string().max(400).optional(),
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
});

function bearer(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (!scheme || !value || scheme.toLowerCase() !== "bearer") return null;
  return value.trim();
}

appsV2BoxRoutes.post("/:workspaceId/events", async c => {
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
    logger.warn("Apps v2 box event failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Could not record box state" }, 500);
  }
});
