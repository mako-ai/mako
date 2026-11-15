/** The logger and the one error answer shared by the three workflow routers. */
import type { Context } from "hono";
import { loggers } from "../../logging";
import { HatchetError } from "../../workflows/hatchet";
import { fail, failFromThrown } from "../lib/respond";

export const logger = loggers.api("workflows");
/**
 * Every route answers an error the same way. An upstream failure is a 500
 * with its reason, never a 502: the proxy in front of Mako replaces an
 * origin's 502 with its own page, and the reason is lost.
 */
export function onRouteError(error: unknown, c: Context): Response {
  if (error instanceof HatchetError) {
    const status =
      error.status >= 400 && error.status < 500 ? error.status : 500;
    return fail(c, status as 500, error.message);
  }
  logger.error("Workflows route error", { error });
  return failFromThrown(c, error, "Internal error");
}
