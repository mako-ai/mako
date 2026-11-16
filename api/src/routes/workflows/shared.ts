/** The logger and the one error answer shared by the three workflow routers. */
import type { Context } from "hono";
import { loggers } from "../../logging";
import { HatchetError } from "../../workflows/hatchet";
import { fail, failFromThrown } from "../lib/respond";

export const logger = loggers.api("workflows");

/** Seconds a caller waits before asking again while Hatchet is down. */
export const HATCHET_RETRY_AFTER_SECONDS = 5;

/**
 * Every route answers an error the same way. An upstream failure is a 500
 * with its reason, never a 502: the proxy in front of Mako replaces an
 * origin's 502 with its own page, and the reason is lost.
 *
 * Hatchet unreachable is the exception: a 503 with Retry-After. It is a pod
 * restarting or being evicted (2026-11-16: 56 silent 500s in two bursts),
 * so the caller should ask again, and the log says why.
 */
export function onRouteError(error: unknown, c: Context): Response {
  if (error instanceof HatchetError) {
    if (error.unavailable) {
      logger.warn("Hatchet unavailable; answering 503", {
        path: c.req.path,
        error: error.message,
        cause:
          error.cause instanceof Error
            ? (error.cause.cause ?? error.cause).toString()
            : undefined,
      });
      c.header("Retry-After", String(HATCHET_RETRY_AFTER_SECONDS));
      return fail(c, 503, "Workflows are briefly unavailable; retrying.");
    }
    const status =
      error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status >= 500) {
      logger.warn("Hatchet request failed", {
        path: c.req.path,
        status: error.status,
        error: error.message,
      });
    }
    return fail(c, status as 500, error.message);
  }
  logger.error("Workflows route error", { error });
  return failFromThrown(c, error, "Internal error");
}
