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
 * - for a deactivated user, `is_deleted = true` and `_mako_deleted_at`, so
 *   the warehouse marks the row deleted as the built-in connector does.
 *   Name and email are kept: they are still true, and the user's past
 *   activities still need them;
 * - for every other user, `_mako_deleted_at = null`, so a reactivated user
 *   clears the mark (an upsert only writes the columns a batch carries).
 *
 * `_mako_deleted_at` is the user's `date_updated`. Close keeps no
 * deactivation time outside its 30-day event log, and the read time would
 * move forward on every poll. `date_updated` is stable across polls.
 *
 * A membership read that fails, 403 and 404 included, fails the chunk: a
 * row without the status would reset `is_deleted` to its default, false.
 */
import type { CloseClient } from "./client.ts";

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
): Promise<Map<string, boolean>> {
  const me = await api.get<{ organizations?: Array<{ id?: unknown }> }>("/me/");
  const orgIds = (me?.organizations ?? [])
    .map(org => (org && typeof org.id === "string" ? org.id : ""))
    .filter(Boolean);
  if (orgIds.length === 0) {
    throw new Error(
      "Close /me/ lists no organization: cannot read memberships",
    );
  }
  const status = new Map<string, boolean>();
  for (const orgId of orgIds) {
    const body = await api.get<OrganizationBody>(`/organization/${orgId}/`, {
      _fields: CLOSE_MEMBERSHIP_FIELDS,
    });
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

/** The user rows with `is_active`, and deactivated users marked deleted. */
export function withMembershipStatus(
  records: unknown[],
  status: Map<string, boolean>,
): Row[] {
  return records.map(record => {
    const row = { ...(record as Row) };
    const active = status.get(String(row.id));
    row.is_active = active ?? null;
    if (active === false) {
      row.is_deleted = true;
      row._mako_deleted_at = row.date_updated ?? row.date_created ?? null;
    } else {
      row._mako_deleted_at = null;
    }
    return row;
  });
}
