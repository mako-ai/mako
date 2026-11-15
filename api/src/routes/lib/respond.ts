/**
 * The one error-response shape for API routes: `{ success: false, error }`,
 * plus optional machine-readable fields (`code`, …).
 *
 * Routes historically answered failures as either `{ success: false, error }`
 * (most) or a bare `{ error }` (chats, billing, usage, workflows); clients had
 * to handle both. New and refactored handlers answer through `fail` so the
 * shape cannot drift again. Adding `success: false` to a bare `{ error }` body
 * is additive — clients reading `error` keep working.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface FailureBody {
  success: false;
  error: string;
  code?: string;
}

export function fail<S extends ContentfulStatusCode, E extends object = object>(
  c: Context,
  status: S,
  error: string,
  extra?: E,
) {
  return c.json(
    { success: false as const, error, ...(extra ?? ({} as E)) },
    status,
  );
}

/**
 * A 500 carrying the thrown error's message, or `fallback` when the thrown
 * value is not an Error — the shape most route catch blocks have always
 * answered with. Prefer a fixed message for new code.
 */
export function failFromThrown(c: Context, error: unknown, fallback: string) {
  return fail(c, 500, error instanceof Error ? error.message : fallback);
}

/** The message of an unknown thrown value, for logs (never raw to clients on 5xx). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
