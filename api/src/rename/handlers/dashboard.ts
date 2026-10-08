/**
 * Dashboard rename handler (see ../types.ts for the contract).
 *
 * Dashboards live only in Mongo and every URL carries the id (`/d/<id>`,
 * share and embed tokens), so a rename is a clean title update: no alias,
 * no file. `renameDashboard` is the one function behind the explorer's
 * rename, the agent's `rename_object` and the objects route; the generic
 * `PUT /dashboards/:id` remains the editor's full-definition save.
 *
 * The viewer-facing `published` snapshot carries its own `title`, so the
 * rename patches that copy in place too. The alternative — publishing the
 * working definition to carry the name across — would silently ship every
 * unpublished edit along with a rename, and not patching it would leave
 * share links showing the old name until the next publish.
 */
import { Types } from "mongoose";
import { Dashboard, type IDashboard } from "../../database/workspace-schema";
import { DashboardManager } from "../../utils/dashboard-manager";
import { publishRealtimeEvent } from "../../services/realtime.service";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type ResolvedRef,
} from "../types";

function isAdmin(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

function canRead(doc: IDashboard, ctx: RenameContext): boolean {
  // A workspace API key has no per-user ACL (server-dashboard-tools parity).
  if (!ctx.userId) return true;
  return DashboardManager.canRead(doc, ctx.userId, ctx.role);
}

function canWrite(doc: IDashboard, ctx: RenameContext): boolean {
  if (!ctx.userId) return true;
  return DashboardManager.canWrite(
    doc,
    ctx.userId,
    isAdmin(ctx.role),
    ctx.role,
  );
}

function locationOf(doc: IDashboard): RenameLocation {
  return { title: doc.title, url: `/d/${doc._id.toString()}` };
}

/** By id, or by a title exactly ONE readable dashboard has. */
async function findDashboard(
  ctx: RenameContext,
  ref: string,
): Promise<IDashboard | null> {
  if (!Types.ObjectId.isValid(ctx.workspaceId)) return null;
  const ws = new Types.ObjectId(ctx.workspaceId);
  if (Types.ObjectId.isValid(ref)) {
    const doc = await Dashboard.findOne({
      _id: new Types.ObjectId(ref),
      workspaceId: ws,
    });
    return doc && canRead(doc, ctx) ? doc : null;
  }
  const matches = (
    await Dashboard.find({ workspaceId: ws, title: ref.trim() })
  ).filter(doc => canRead(doc, ctx));
  return matches.length === 1 ? matches[0] : null;
}

export async function renameDashboard(input: {
  workspaceId: string;
  dashboardId: string;
  title: string;
  userId?: string;
  role?: string;
  clientId?: string;
}): Promise<IDashboard> {
  const title = input.title.trim();
  if (!title) throw new RenameError("A dashboard needs a title.");
  const ctx: RenameContext = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
  };
  const existing = await findDashboard(ctx, input.dashboardId);
  if (!existing) throw new RenameError("Dashboard not found", 404);
  if (!canWrite(existing, ctx)) {
    throw new RenameError(
      "You do not have permission to edit this dashboard",
      403,
    );
  }
  // Same edit-lock rule as the save routes: a rename is a write.
  const lock = existing.editLock;
  if (
    lock &&
    lock.expiresAt > new Date() &&
    input.userId !== undefined &&
    lock.userId !== input.userId
  ) {
    throw new RenameError(
      `Dashboard is locked for editing by ${lock.userName || "another user"}`,
      409,
    );
  }

  const $set: Record<string, unknown> = { title };
  if (existing.published) $set["published.title"] = title;
  const updated = await Dashboard.findOneAndUpdate(
    { _id: existing._id, workspaceId: existing.workspaceId },
    { $set, $inc: { version: 1 } },
    { new: true },
  );
  if (!updated) throw new RenameError("Dashboard not found", 404);

  // Poke open tabs (poke-then-pull) so other viewers pick up the title.
  publishRealtimeEvent(input.workspaceId, {
    type: "dashboard.updated",
    dashboardId: updated._id.toString(),
    version: updated.version,
    updatedBy: input.userId ?? "agent",
    clientId: input.clientId,
    origin: "save",
  });
  return updated;
}

export const dashboardRenameHandler: RenameHandler = {
  kind: "dashboard",
  describe:
    "dashboard: `title` = new title (published/shared copies pick it up too); no `slug`. Links use `/d/<id>` and never break.",

  async resolve(ctx, ref): Promise<ResolvedRef | null> {
    const doc = await findDashboard(ctx, ref);
    if (!doc) return null;
    return {
      kind: "dashboard",
      id: doc._id.toString(),
      via: "current",
      current: locationOf(doc),
    };
  },

  async rename(ctx, request) {
    if (request.slug !== undefined) {
      throw new RenameError("Dashboards have no slug; give `title`.");
    }
    if (request.title === undefined) throw new RenameError("Give a new title.");
    const existing = await findDashboard(ctx, request.ref);
    if (!existing) throw new RenameError("Dashboard not found", 404);
    const before = locationOf(existing);
    const updated = await renameDashboard({
      workspaceId: ctx.workspaceId,
      dashboardId: existing._id.toString(),
      title: request.title,
      userId: ctx.userId,
      role: ctx.role,
    });
    return {
      kind: "dashboard",
      id: updated._id.toString(),
      before,
      after: locationOf(updated),
      aliasesAdded: [],
      warnings: [],
    };
  },
};
