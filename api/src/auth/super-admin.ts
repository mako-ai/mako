/**
 * Super Admin Access Control
 *
 * Cross-workspace admin powers (e.g. curating the global AI model catalog)
 * are gated on an allow-list of emails supplied via the `SUPER_ADMIN_EMAILS`
 * env var (comma-separated). Access control is server-side on every request;
 * the client-side `isSuperAdmin` flag surfaced on `/api/auth/me` is purely
 * cosmetic (hide/show the Super Admin row in the settings explorer).
 */

import type { Context, Next } from "hono";

/**
 * Returns true if the provided email appears in `SUPER_ADMIN_EMAILS`.
 * Matching is case-insensitive and trims whitespace.
 */
export function isSuperAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const raw = process.env.SUPER_ADMIN_EMAILS ?? "";
  if (!raw.trim()) return false;
  const allow = new Set(
    raw
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return allow.has(email.toLowerCase());
}

/**
 * Hono middleware that 403s unless the authenticated user's email is in the
 * super-admin allow-list. MUST be composed after `authMiddleware` so
 * `c.get("user")` is populated.
 */
export async function requireSuperAdmin(c: Context, next: Next) {
  const user = c.get("user") as { id: string; email?: string } | undefined;
  if (!user || !isSuperAdminEmail(user.email)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}
