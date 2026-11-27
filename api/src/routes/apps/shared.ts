/**
 * What every Apps sub-router shares: the path params, the project loaders
 * (id / path / slug → row, with the caller's read or write access checked)
 * and the one error mapping.
 */
import { z } from "@hono/zod-openapi";
import { parseEntityId } from "../../database/pg/id-codec";
import { type IAppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../../repositories/apps-metadata";
import { workspaceService } from "../../services/workspace.service";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { canReadResource, canWriteResource } from "../../utils/resource-acl";
import { WorkspaceRepoNotBoundError } from "../../services/workspace-repos.service";
import {
  WorktreeConflictError,
  resolveProjectRef,
  AppFolderError,
  appRootFor,
} from "../../apps/worktree.service";
import { resolveAppRef } from "../../apps/app-index.service";
import { parseAppRepoPath } from "../../apps/app-paths";
import { RepoRequiredError } from "../../apps/config";
import { type ViewerIdentity } from "../../apps/app-viewer.service";
import { BindingNotFoundError } from "../../apps/bindings.service";
import {
  unregisteredDraftAccess,
  unregisteredDraftProject,
} from "../../apps/unregistered-draft-app";
import { timed } from "../../middleware/server-timing";
import { fail } from "../lib/respond";

const logger = loggers.api("apps");

export const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
export const ProjectParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

export function actingUserId(c: AuthenticatedContext): string | undefined {
  return c.get("user")?.id;
}

export async function memberRoleFor(
  workspaceId: string,
  userId: string | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  const member = await timed("auth.role", () =>
    workspaceService.getMember(workspaceId, userId),
  );
  return member?.role;
}

export async function loadProject(
  c: AuthenticatedContext,
  opts: { write: boolean },
): Promise<
  { project: IAppProject; userId?: string } | { errorResponse: Response }
> {
  const workspaceId = c.req.param("workspaceId") as string;
  const id = c.req.param("id");
  if (!id) {
    return {
      errorResponse: fail(c, 400, "Invalid app id"),
    };
  }
  // Apps are addressable by id, by repo path (`apps/sales/report`) and by
  // slug (the folder's own name — unambiguous for a top-level app, and for a
  // nested one when no other app shares the name). Opening one must not
  // require a database write: a folder-only app is synthesized, and a row
  // appears only when someone restricts, publishes, or shares it.
  const project = await resolveProjectRef(workspaceId, id);
  if (!project) {
    return {
      errorResponse: fail(c, 404, "App not found"),
    };
  }
  const userId = actingUserId(c);
  if (userId) {
    const role = await memberRoleFor(workspaceId, userId);
    if (opts.write && !canWriteResource(project, userId, role)) {
      // Distinguish "can't touch it" from "doesn't exist". If the caller can
      // READ the app but not write it, a write-gated action (like starting a
      // dev preview) must NOT masquerade as "App not found" — the app is
      // right there in their list. Say it's read-only instead. Only when the
      // app is invisible to them too do we fall through to the 404, which
      // deliberately does not reveal that a private app exists.
      if (canReadResource(project, userId, role)) {
        return {
          errorResponse: fail(
            c,
            403,
            "You have read-only access to this app. Ask an editor or the owner to run it in dev mode (or to share edit access with you).",
          ),
        };
      }
      return {
        errorResponse: fail(c, 404, "App not found"),
      };
    }
    if (!opts.write && !canReadResource(project, userId, role)) {
      return {
        errorResponse: fail(c, 404, "App not found"),
      };
    }
  }
  return { project, userId };
}

/**
 * The view token's fast path: an app id whose row is published and readable
 * by the caller. One Mongo read, no repo index and no git.
 *
 * Opening an app in Mako asks for its token by id, and the full resolver
 * spent 0.8–1.1 s on prod freshening the workspace mirror (a git fetch when
 * the last one is over 3 s old) to learn what the row already holds. For an
 * id, resolveProjectRef returns this same row: the index only corrects its
 * path and slug, and neither the grant nor the ACL reads them. Anything else
 * (a slug, a path, no row, unpublished, not readable) returns null and takes
 * loadProject, so its answers and 404s stay exactly as they were.
 */
export async function loadPublishedRowById(
  c: AuthenticatedContext,
): Promise<{ project: IAppProject; userId?: string } | null> {
  const workspaceId = c.req.param("workspaceId") as string;
  const id = c.req.param("id")?.trim() ?? "";
  if (!parseEntityId(id) || !parseEntityId(workspaceId)) {
    return null;
  }
  const rowRec = await appsMetadataRepo.findProjectById(id, workspaceId);
  if (!rowRec?.publishedSha) return null;
  const row = toAppProjectCompat(rowRec);
  const userId = actingUserId(c);
  if (userId) {
    // The workspace middleware already read this member for this request.
    const role =
      c.get("memberRole") ?? (await memberRoleFor(workspaceId, userId));
    if (!canReadResource(row, userId, role)) return null;
  }
  return { project: row, userId };
}

/**
 * loadProject for the laptop dev-build loop (dev-build and its binding jobs):
 * an app that is not on main yet — a new folder only in the developer's
 * checkout — is a draft-only project (unregistered-draft-app.ts) instead of a
 * 404, so `makoData()` shows data before anything is pushed. Every other
 * answer of loadProject (a real app, a 403, a 404 for an app the caller may
 * not see) is unchanged.
 */
export async function loadDevBuildProject(
  c: AuthenticatedContext,
  opts: { checkWrite: boolean },
): Promise<
  | {
      project: IAppProject;
      userId?: string;
      canWrite: boolean;
      unregistered: boolean;
    }
  | { errorResponse: Response }
> {
  const loaded = await loadProject(c, { write: false });
  if (!("errorResponse" in loaded)) {
    const canWrite = opts.checkWrite
      ? !("errorResponse" in (await loadProject(c, { write: true })))
      : false;
    return { ...loaded, canWrite, unregistered: false };
  }
  if (loaded.errorResponse.status !== 404) return loaded;
  const workspaceId = c.req.param("workspaceId") as string;
  const userId = actingUserId(c);
  const access = unregisteredDraftAccess(
    userId,
    await memberRoleFor(workspaceId, userId),
  );
  if (access === "none") return loaded;
  const project = await unregisteredDraftProject(
    workspaceId,
    c.req.param("id") ?? "",
    userId,
  );
  if (!project) return loaded;
  return {
    project,
    userId,
    canWrite: access === "write",
    unregistered: true,
  };
}

export function toProjectJson(
  p: IAppProject,
  manifest?: { title: string; description?: string },
) {
  const path = appRootFor(p);
  const location = parseAppRepoPath(path);
  return {
    id: p._id.toString(),
    slug: p.slug,
    path,
    scope: location?.scope ?? "workspace",
    title: manifest?.title ?? p.title ?? p.slug ?? "",
    description: manifest?.description,
    access: p.access,
    owner_id: p.owner_id,
    defaultBranch: p.defaultBranch,
    publishedSha: p.publishedSha,
    publishedAt: p.publishedAt,
    chatEnabled: p.chatEnabled === true,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function manifestForProject(
  workspaceId: string,
  project: IAppProject,
): Promise<{ title: string; description?: string } | undefined> {
  const folder = await resolveAppRef(workspaceId, project._id.toString());
  return folder
    ? { title: folder.title, description: folder.description }
    : undefined;
}

export function handleError(c: AuthenticatedContext, error: unknown) {
  if (error instanceof WorktreeConflictError) {
    return fail(c, 409, error.message);
  }
  if (error instanceof AppFolderError) {
    return fail(c, error.status, error.message);
  }
  if (error instanceof RepoRequiredError) {
    return fail(c, error.status as 412, error.message, { code: error.code });
  }
  if (error instanceof WorkspaceRepoNotBoundError) {
    return fail(c, 404, error.message);
  }
  if (error instanceof BindingNotFoundError) {
    return fail(c, 404, error.message);
  }
  logger.error("Apps route error", { error });
  return fail(
    c,
    500,
    error instanceof Error ? error.message : "Internal error",
  );
}

export function isWorkspaceAdminRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** The signed-in person, as the published serving layer wants them. */
export function viewerOf(c: AuthenticatedContext): ViewerIdentity | null {
  const user = c.get("user");
  return user?.email ? { id: user.id, email: user.email } : null;
}

/**
 * The caller's workspace role: the one the membership middleware already
 * read for this request, else a lookup (API keys carry none).
 */
export async function callerRole(
  c: AuthenticatedContext,
  workspaceId: string,
  userId: string | undefined,
): Promise<string | undefined> {
  return (
    (c.get("memberRole") as string | undefined) ??
    (await memberRoleFor(workspaceId, userId))
  );
}

/** Who acts in the sandbox and in git: the user, or the API key itself. */
export function actorOf(loaded: { userId?: string }): string {
  return loaded.userId ?? "api-key";
}

/** The signed-in caller as a commit author (their email); none for a key. */
export function commitAuthorOf(
  c: AuthenticatedContext,
): { name: string; email: string } | undefined {
  const user = c.get("user");
  return user?.email ? { name: user.email, email: user.email } : undefined;
}
