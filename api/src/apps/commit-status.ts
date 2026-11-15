/**
 * What the two GitHub commit-status reporters share (deploy-commit-status.ts
 * for app deploys, skill-commit-status.ts for hidden skills): the
 * description limit, the link back into Mako, and how a failed post is
 * logged.
 */
import type { loggers } from "../logging";

/** GitHub caps a status description at 140 characters. */
const DESCRIPTION_MAX_CHARS = 140;

/** One line, at most `max` characters (an ellipsis marks a cut). */
export function clipStatusDescription(
  text: string,
  max = DESCRIPTION_MAX_CHARS,
): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** The GitHub App lacks "Commit statuses: write" (or the repo is gone). */
export function isStatusPermissionError(message: string): boolean {
  return (
    /GitHub 40[34]\b/.test(message) ||
    /Resource not accessible by integration/i.test(message)
  );
}

/** `path` in the Mako app (CLIENT_URL, else PUBLIC_URL); none when unset. */
export function makoClientUrl(path: string): string | undefined {
  const base = (process.env.CLIENT_URL || process.env.PUBLIC_URL || "").replace(
    /\/+$/,
    "",
  );
  return base ? `${base}${path}` : undefined;
}

/**
 * Log a status post that failed and say why. A missing permission is logged
 * once per workspace per process (`warned` remembers whom); anything else
 * every time. Never throws.
 */
export function logStatusPostFailure(
  logger: ReturnType<typeof loggers.api>,
  what: string,
  error: unknown,
  warned: Set<string>,
  meta: { workspaceId: string } & Record<string, unknown>,
): "permission" | "error" {
  const message = error instanceof Error ? error.message : String(error);
  const permission = isStatusPermissionError(message);
  if (!permission || !warned.has(meta.workspaceId)) {
    if (permission) warned.add(meta.workspaceId);
    logger.warn(what, {
      ...meta,
      error: message,
      ...(permission
        ? {
            hint: 'Grant the GitHub App "Commit statuses: Read and write" and accept it on the installation',
          }
        : {}),
    });
  }
  return permission ? "permission" : "error";
}
