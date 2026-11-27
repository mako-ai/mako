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
 *
 * Someone who signs in WITHOUT a link has no workspace in the request, so
 * nothing above fires; onboarding offers them `findAutoJoinOffers` instead
 * of making them create a look-alike workspace of their own.
 */
import { Types } from "mongoose";
import { User } from "../database/schema";
import {
  workspaceRepo,
  type WorkspaceAutoJoin,
  type WorkspaceMemberRecord,
} from "../repositories/workspaces";
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
): WorkspaceAutoJoin | null {
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
): Promise<WorkspaceMemberRecord | null> {
  if (!Types.ObjectId.isValid(workspaceId)) {
    return null;
  }
  const existing = await workspaceRepo.findMember(workspaceId, user.id);
  if (existing) {
    return existing;
  }

  const domain = user.email ? emailDomain(user.email) : null;
  if (!domain) {
    return null;
  }
  const workspace = await workspaceRepo.findById(workspaceId);
  const autoJoin = workspace?.settings?.autoJoin;
  if (!autoJoin || !autoJoin.domains?.includes(domain)) {
    return null;
  }

  const { member, inserted } = await workspaceRepo.addMemberIfNotExists({
    workspaceId,
    userId: user.id,
    role: autoJoin.role === "member" ? "member" : "viewer",
    joinedAt: new Date(),
  });
  if (inserted) {
    logger.info("Auto-joined a member by email domain", {
      workspaceId,
      userId: user.id,
      domain,
      role: member.role,
    });
  }
  return member;
}

export interface AutoJoinOffer {
  workspaceId: string;
  workspaceName: string;
  domain: string;
  role: "member" | "viewer";
}

/**
 * Workspaces the person can join by email domain alone, for onboarding to
 * offer: the workspace auto-joins their domain, they are not a member yet,
 * and one of its owners/admins has a verified address on that domain. The
 * last rule stops a stranger who lists someone else's domain from showing up
 * in that company's onboarding as a look-alike workspace.
 */
export async function findAutoJoinOffers(user: {
  id: string;
  email?: string | null;
}): Promise<AutoJoinOffer[]> {
  const domain = user.email ? emailDomain(user.email) : null;
  if (!domain) return [];
  const workspaces = await Workspace.find({
    "settings.autoJoin.domains": domain,
  })
    .select("name settings.autoJoin")
    .lean<
      Array<{
        _id: Types.ObjectId;
        name: string;
        settings?: { autoJoin?: IWorkspaceAutoJoin };
      }>
    >();
  if (workspaces.length === 0) return [];

  const members = await WorkspaceMember.find({
    workspaceId: { $in: workspaces.map(w => w._id) },
    $or: [{ userId: user.id }, { role: { $in: ["owner", "admin"] } }],
  })
    .select("workspaceId userId")
    .lean<Array<{ workspaceId: Types.ObjectId; userId: string }>>();
  const admins = await User.find({
    _id: { $in: members.map(m => m.userId) },
    emailVerified: true,
  })
    .select("email")
    .lean<Array<{ _id: string; email: string }>>();
  const onDomain = new Set(
    admins.filter(a => emailDomain(a.email) === domain).map(a => a._id),
  );

  const joined = new Set<string>();
  const vouched = new Set<string>();
  for (const m of members) {
    const ws = m.workspaceId.toString();
    if (m.userId === user.id) joined.add(ws);
    else if (onDomain.has(m.userId)) vouched.add(ws);
  }
  return workspaces
    .filter(w => vouched.has(w._id.toString()) && !joined.has(w._id.toString()))
    .map(w => ({
      workspaceId: w._id.toString(),
      workspaceName: w.name,
      domain,
      role: w.settings?.autoJoin?.role === "member" ? "member" : "viewer",
    }));
}
