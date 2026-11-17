/**
 * Close user deactivation, read from the organization's memberships.
 *
 * `/user/` lists every user who was ever in the organization, deactivated or
 * not, and carries no status. Close keeps the status on the membership:
 * `GET /organization/{id}/` returns `memberships` (active) and
 * `inactive_memberships` (deactivated). The in-process connector only learns
 * it from the `membership.deactivated` webhook, which it writes as a delete:
 * the warehouse row gets `is_deleted = true` and loses its name and email.
 *
 * The folder reads the memberships on every `users` chunk instead, so a poll
 * alone gets it right. Each user row gets:
 * - `is_active`: true for an active membership, false for an inactive one,
 *   null when the user is in neither list (another organization's user);
 * - for a deactivated user, `is_deleted = true` and `_mako_deleted_at` (the
 *   read time), so the warehouse marks the row deleted as the built-in
 *   connector does. Name and email are kept: they are still true, and the
 *   user's past activities still need them.
 */
import { type CloseClient, CloseHttpError } from "./client.ts";

type Row = Record<string, unknown>;
type Membership = { user_id?: unknown };
type OrganizationBody = {
  memberships?: Membership[];
  inactive_memberships?: Membership[];
};

export const CLOSE_MEMBERSHIP_FIELDS = "id,memberships,inactive_memberships";

/** User id -> true (active) or false (deactivated), over every organization. */
export async function readMembershipStatus(
  api: CloseClient,
  log: (message: string) => void,
): Promise<Map<string, boolean> | null> {
  let orgIds: string[];
  try {
    const me = await api.get<{ organizations?: Array<{ id?: unknown }> }>(
      "/me/",
    );
    orgIds = (me?.organizations ?? [])
      .map(org => (org && typeof org.id === "string" ? org.id : ""))
      .filter(Boolean);
  } catch (error) {
    return unknownOnlyIfForbidden(error, "/me/", log);
  }
  const status = new Map<string, boolean>();
  for (const orgId of orgIds) {
    let body: OrganizationBody;
    try {
      body = await api.get<OrganizationBody>(`/organization/${orgId}/`, {
        _fields: CLOSE_MEMBERSHIP_FIELDS,
      });
    } catch (error) {
      return unknownOnlyIfForbidden(error, `/organization/${orgId}/`, log);
    }
    // Inactive first, so a user active anywhere reads as active.
    for (const m of body?.inactive_memberships ?? []) {
      if (typeof m?.user_id === "string" && !status.has(m.user_id)) {
        status.set(m.user_id, false);
      }
    }
    for (const m of body?.memberships ?? []) {
      if (typeof m?.user_id === "string") status.set(m.user_id, true);
    }
  }
  return status;
}

/**
 * A key that may not read the organization (403, 404) leaves the status
 * unknown: users still sync, with `is_active` null. Anything else (401, a
 * 429 or 5xx past every retry) fails the chunk, so the engine retries it
 * instead of writing deactivated users as active.
 */
function unknownOnlyIfForbidden(
  error: unknown,
  endpoint: string,
  log: (message: string) => void,
): null {
  if (
    error instanceof CloseHttpError &&
    (error.status === 403 || error.status === 404)
  ) {
    log(`Cannot read ${endpoint} (${error.status}): users.is_active is null`);
    return null;
  }
  throw error;
}

/** The user rows with `is_active`, and deactivated users marked deleted. */
export function withMembershipStatus(
  records: unknown[],
  status: Map<string, boolean> | null,
  readAt: string,
): Row[] {
  return records.map(record => {
    const row = { ...(record as Row) };
    const active = status?.get(String(row.id));
    row.is_active = active ?? null;
    if (active === false) {
      row.is_deleted = true;
      row._mako_deleted_at = readAt;
    }
    return row;
  });
}
