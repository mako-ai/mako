import type { Context } from "hono";
import { loggers } from "../logging";

const logger = loggers.auth();

/**
 * An auth failure whose message is meant for the user ("Invalid email or
 * password", "Invalid or expired verification code").
 *
 * The auth routes used to return `error.message` for EVERY thrown error, so
 * an internal failure reached the client verbatim — a failed SendGrid call
 * surfaced as `400 {"error":"fetch failed"}`. Now only an `AuthError` carries
 * its message out; anything else is logged and answered with a generic 500.
 */
export class AuthError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 503;

  constructor(
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/**
 * The response for an error thrown by an auth handler: an {@link AuthError}'s
 * own message and status, else a generic 500 (the real error is logged).
 */
export function authErrorResponse(c: Context, error: unknown, action: string) {
  if (error instanceof AuthError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  logger.error(`Auth ${action} failed`, { error, path: c.req.path });
  return c.json(
    { success: false, error: "Something went wrong. Please try again." },
    500,
  );
}
