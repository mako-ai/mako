/**
 * Who the viewer is, from their workspace membership (apps.md §27): the job
 * role and country set on the Members page become the viewer's claims. One
 * Mongo read per document/data request; the published token carries the
 * user id, the builder routes' `?as=<email>` resolves through the User.
 */
import { Types } from "mongoose";
import { User } from "../database/schema";
import { WorkspaceMember } from "../database/workspace-schema";
import {
  normalizeEmail,
  viewerFromMember,
  type ResolvedViewer,
  type ViewerIdentity,
} from "./viewers.service";

/**
 * The viewer for `identity` in `workspaceId`. A signed-in person who is not
 * a member (or has no job role) resolves with `role: null` — they read only
 * what is unscoped. Never throws for a missing membership.
 */
export async function resolveViewerFor(input: {
  workspaceId: string;
  viewer: ViewerIdentity;
}): Promise<ResolvedViewer> {
  const workspaceId = new Types.ObjectId(input.workspaceId);
  let userId = input.viewer.id;
  if (!userId) {
    const user = await User.findOne({
      email: normalizeEmail(input.viewer.email),
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId }>();
    userId = user?._id.toString();
  }
  const member = userId
    ? await WorkspaceMember.findOne({ workspaceId, userId })
        .select("jobRole country")
        .lean<{ jobRole?: string; country?: string }>()
    : null;
  return viewerFromMember({
    email: input.viewer.email,
    jobRole: member?.jobRole ?? null,
    country: member?.country ?? null,
  });
}
