/**
 * Who is looking at a published app (apps.md §28).
 *
 * The platform tells an app exactly what it knows about the person behind
 * a request and nothing more: who they are (id, email), where they are
 * (the workspace and their ACCESS role in it), and what they may do to this
 * app (their share role). Everything else — team, territory, seniority,
 * whatever an app needs to shape its view — is data the app looks up in
 * the warehouse by email. Mako carries no org chart.
 *
 * Identity comes from the session or from the HMAC-signed `pub.` token,
 * never from anything the browser can edit. An anonymous share resolves to
 * `null`: there is nobody to describe.
 */
import { Types } from "mongoose";
import {
  AppProject,
  Workspace,
  WorkspaceMember,
  type IAppProject,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import { normalizeEmail } from "../utils/email.utils";
import {
  getResourceOwnerId,
  resolveResourceRole,
  type EffectiveResourceRole,
  type WorkspaceMemberRole,
} from "../utils/resource-acl";
import type { ViewerIdentity } from "./preview.service";

export type { ViewerIdentity };

/** The viewer as the app sees it — `__data/viewer.json`, `useViewer()`. */
export interface AppViewer {
  id: string;
  email: string;
  workspace: {
    id: string;
    name: string;
    /** Access role in the workspace; null when not (or no longer) a member. */
    role: WorkspaceMemberRole | null;
  };
  app: {
    id: string;
    slug: string | null;
    /** What they may do to this app; null when the ACL admits them no more. */
    role: EffectiveResourceRole;
  };
}

/**
 * Resolve the viewer for `project`. One workspace read and one membership
 * read; callers keep it off the per-asset path (document + `__data/` only).
 */
export async function resolveAppViewer(
  project: Pick<IAppProject, "_id" | "workspaceId" | "slug"> &
    Parameters<typeof resolveResourceRole>[0],
  identity: ViewerIdentity | null | undefined,
): Promise<AppViewer | null> {
  if (!identity) return null;
  const workspaceId = project.workspaceId.toString();
  const [workspace, member] = await Promise.all([
    Workspace.findById(workspaceId).select("name").lean<{ name?: string }>(),
    WorkspaceMember.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: identity.id,
    })
      .select("role")
      .lean<{ role?: WorkspaceMemberRole }>(),
  ]);
  const memberRole = member?.role ?? null;
  // The ACL's workspace-scope fallback assumes the caller already passed the
  // membership check. Someone who is no longer a member (a token minted
  // before they were removed) keeps only what names them explicitly.
  const namedExplicitly =
    getResourceOwnerId(project) === identity.id ||
    (project.sharedWith ?? []).some(s => s.userId === identity.id);
  const appRole =
    memberRole || namedExplicitly
      ? resolveResourceRole(project, identity.id, memberRole ?? undefined)
      : null;
  return {
    id: identity.id,
    email: normalizeEmail(identity.email),
    workspace: {
      id: workspaceId,
      name: workspace?.name ?? "",
      role: memberRole,
    },
    app: {
      id: project._id.toString(),
      slug: project.slug ?? null,
      role: appRole,
    },
  };
}

/**
 * The viewer a given EMAIL would resolve to — the builder's "preview as"
 * (`GET /apps/{id}/viewer?as=`, `MAKO_VIEWER_AS` in a laptop `vite dev`).
 * Null when no Mako user has that email.
 */
export async function resolveAppViewerByEmail(
  project: Parameters<typeof resolveAppViewer>[0],
  email: string,
): Promise<AppViewer | null> {
  const user = await User.findOne({ email: normalizeEmail(email) })
    .select("_id email")
    .lean<{ _id: string; email: string }>();
  if (!user) return null;
  return resolveAppViewer(project, {
    id: user._id.toString(),
    email: user.email,
  });
}

/** Convenience for routes that only hold a project id. */
export async function resolveAppViewerById(
  projectId: string,
  identity: ViewerIdentity | null | undefined,
): Promise<AppViewer | null> {
  if (!identity) return null;
  const project = await AppProject.findById(projectId);
  return project ? resolveAppViewer(project, identity) : null;
}
