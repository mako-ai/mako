/**
 * The handler shell shared by resource-route registrars (folder routes,
 * version routes): resolve the actor from the router's auth context, run
 * the backend op, and turn its outcome into the `{ success, ... }`
 * envelope — with one try/catch and one place to map kind-specific errors
 * (consoles' RepoRequiredError).
 *
 * Registrars own the route definitions and input parsing; backends own the
 * storage semantics; this owns everything in between.
 */
import type { Context } from "hono";

import { loggers } from "../../logging";

const logger = loggers.api("resource-op");

/** Who is asking. `role` is the workspace member role set by the router. */
export interface ResourceOpContext {
  workspaceId: string;
  userId: string;
  role: string | undefined;
}

/** What a backend op reports; the runner turns it into the envelope. */
export type ResourceOpResult =
  | { ok: true; payload?: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

export interface OpRunnerConfig {
  /** Label for error logs (usually the OpenAPI tag). */
  tag: string;
  /**
   * "user-required": reject requests with no session user. "allow-system":
   * API-key requests act as "system" (notebooks).
   */
  actor?: "user-required" | "allow-system";
  /** Called after any successful mutation (e.g. publish a realtime event). */
  afterChange?: (workspaceId: string) => void;
  /** Map a thrown kind-specific error to a response. */
  onError?: (c: Context, error: unknown) => Response | undefined;
}

/**
 * On success the op's `payload` is spread into the envelope
 * (`{ success: true, ...payload }`), so each kind keeps its historical
 * response shape (`data`, `versions`/`total`, `version`, …).
 */
export function createOpRunner(config: OpRunnerConfig) {
  return async (
    c: Context,
    op: (ctx: ResourceOpContext) => Promise<ResourceOpResult>,
    successStatus: 200 | 201 = 200,
  ): Promise<Response> => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const user = c.get("user") as { id?: unknown } | undefined;
    if (!user && config.actor !== "allow-system") {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const ctx: ResourceOpContext = {
      workspaceId,
      userId: String(user?.id ?? "system"),
      role: c.get("memberRole") as string | undefined,
    };
    try {
      const result = await op(ctx);
      if (!result.ok) {
        return c.json({ success: false, error: result.error }, result.status);
      }
      config.afterChange?.(workspaceId);
      return c.json({ success: true, ...result.payload }, successStatus);
    } catch (error) {
      const mapped = config.onError?.(c, error);
      if (mapped) return mapped;
      logger.error(`Resource route error (${config.tag})`, {
        path: c.req.path,
        error,
      });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  };
}
