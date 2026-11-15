/**
 * The per-app environment variable vault (env.service).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { ensureProjectRow } from "../../apps/worktree.service";
import {
  AppEnvValidationError,
  deleteAppEnvVar,
  listAppEnvVars,
  setAppEnvVar,
} from "../../apps/env.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { ProjectParam, handleError, loadProject, actorOf } from "./shared";
import { fail } from "../lib/respond";

export const appsEnvRoutes = createRouter();

// ---------------------------------------------------------------------------
// Environment variables — the per-app env vault (env.service).
//
// Editor-gated end to end: env is a build/dev concern, and gating the list at
// write access means there is never a question of who may see which value.
// Secrets never echo their value back even to editors — the API accepts them
// and injects them, it does not retrieve them.
// ---------------------------------------------------------------------------

appsEnvRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/env",
    tags: ["Apps"],
    summary: "List the app's environment variables",
    description:
      "Non-secret vars include their value; secret vars return only their key. Values reach the sandbox dev server (all vars) and the publish build (non-secret only) at process launch.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const vars = await listAppEnvVars(loaded.project);
      return c.json({ success: true as const, vars }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsEnvRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/env",
    tags: ["Apps"],
    summary: "Set (upsert) one environment variable on the app",
    description:
      "Values are encrypted at rest. `secret: true` keeps the value out of the publish build and forbids the VITE_ prefix (Vite inlines VITE_* into the public bundle). A running dev server picks the change up on its next restart.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              key: z.string().min(1).max(128),
              value: z.string().max(8192),
              secret: z.boolean().default(false),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { key, value, secret } = c.req.valid("json");
      // The vault lives on the project row; folder-only apps get theirs now
      // (a fourth row-creating act alongside restrict/publish/share, §13.6).
      const project = await ensureProjectRow(loaded.project, actorOf(loaded));
      const vars = await setAppEnvVar(project, { key, value, secret });
      return c.json({ success: true as const, vars }, 200);
    } catch (error) {
      if (error instanceof AppEnvValidationError) {
        return fail(c, 400, error.message);
      }
      return handleError(c, error);
    }
  },
);

appsEnvRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/env/{key}",
    tags: ["Apps"],
    summary: "Delete one environment variable from the app",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        key: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .openapi({ param: { name: "key", in: "path" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { key } = c.req.valid("param");
      const removed = await deleteAppEnvVar(loaded.project, key);
      if (!removed) {
        return fail(c, 404, "Variable not found");
      }
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
