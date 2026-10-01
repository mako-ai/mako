/**
 * Domain auto-join (apps.md §28).
 *
 * The flow it exists for: someone gets a published app's link, clicks, signs
 * in, and is in — no invitation, no admin action per person. A workspace
 * lists the email domains it trusts and the ACCESS role every newcomer from
 * those domains gets (viewer or member, never more); the first request that
 * would otherwise be refused for "not a member" creates the membership
 * instead. Exact domain match only: a sub-domain is somebody else's.
 *
 * That is all the platform knows about a newcomer. What they should see
 * inside an app is the app's business (`useViewer()` + the warehouse).
 */
import { Types } from "mongoose";
import {
  Workspace,
  WorkspaceMember,
  type IWorkspaceAutoJoin,
  type IWorkspaceMember,
} from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.workspace();

const DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Clean a submitted auto-join block: domains lowercased, de-duplicated,
 * a leading `@` tolerated, junk dropped. Null when nothing valid is left —
 * which also means "turn auto-join off".
 */
export function normalizeAutoJoin(
  input: { domains?: unknown; role?: unknown } | null,
): IWorkspaceAutoJoin | null {
  if (!input || typeof input !== "object") return null;
  const raw = Array.isArray(input.domains) ? input.domains : [];
  const domains: string[] = [];
  for (const d of raw) {
    if (typeof d !== "string") continue;
    const clean = d.trim().toLowerCase().replace(/^@/, "");
    if (DOMAIN_RE.test(clean) && !domains.includes(clean)) domains.push(clean);
  }
  if (domains.length === 0) return null;
  return { domains, role: input.role === "member" ? "member" : "viewer" };
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return (
    email
      .slice(at + 1)
      .trim()
      .toLowerCase() || null
  );
}

/**
 * The person's membership in `workspaceId`, creating it when the workspace
 * auto-joins their email domain. Null when they are not a member and the
 * domain is not trusted. Safe to call on every request: one read for a
 * member, and the (workspaceId, userId) unique index makes a concurrent
 * first contact create exactly one row.
 */
export async function ensureAutoJoin(
  workspaceId: string,
  user: { id: string; email?: string | null },
): Promise<IWorkspaceMember | null> {
  if (!Types.ObjectId.isValid(workspaceId)) return null;
  const wsId = new Types.ObjectId(workspaceId);
  const existing = await WorkspaceMember.findOne({
    workspaceId: wsId,
    userId: user.id,
  });
  if (existing) return existing;

  const domain = user.email ? emailDomain(user.email) : null;
  if (!domain) return null;
  const workspace = await Workspace.findById(wsId)
    .select("settings.autoJoin")
    .lean<{ settings?: { autoJoin?: IWorkspaceAutoJoin } }>();
  const autoJoin = workspace?.settings?.autoJoin;
  if (!autoJoin || !autoJoin.domains?.includes(domain)) return null;

  try {
    const member = await WorkspaceMember.create({
      workspaceId: wsId,
      userId: user.id,
      role: autoJoin.role === "member" ? "member" : "viewer",
      joinedAt: new Date(),
    });
    logger.info("Auto-joined a member by email domain", {
      workspaceId,
      userId: user.id,
      domain,
      role: member.role,
    });
    return member;
  } catch (error) {
    // Lost a race with another first request: the row now exists.
    if ((error as { code?: number }).code === 11000) {
      return WorkspaceMember.findOne({ workspaceId: wsId, userId: user.id });
    }
    throw error;
  }
}
