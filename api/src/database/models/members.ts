import mongoose, { Schema, Document, Types } from "mongoose";
import { randomUUID } from "crypto";

/**
 * WorkspaceMember model interface
 */
export interface IWorkspaceMember extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: Date;
  /** True only for the first workspace auto-created during user onboarding */
  isDefaultMembership?: boolean;
}

/**
 * WorkspaceMember Schema
 */
const WorkspaceMemberSchema = new Schema<IWorkspaceMember>({
  workspaceId: {
    type: Schema.Types.ObjectId,
    ref: "Workspace",
    required: true,
  },
  userId: {
    type: String,
    ref: "User",
    required: true,
  },
  role: {
    type: String,
    enum: ["owner", "admin", "member", "viewer"],
    required: true,
  },
  joinedAt: {
    type: Date,
    default: Date.now,
  },
  isDefaultMembership: {
    type: Boolean,
    required: false,
  },
});

// Indexes
WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
WorkspaceMemberSchema.index({ userId: 1 });
// Prevent duplicate default workspace creation during concurrent onboarding
// requests. The key must differ from the plain `{ userId: 1 }` index above:
// Mongoose drops an unnamed index whose key duplicates an earlier one, so a
// `{ userId: 1 }` partial index here was silently never created. Existing
// deployments get it from migration
// 2026-11-14-195939_workspace_member_default_membership_unique.
WorkspaceMemberSchema.index(
  { userId: 1, isDefaultMembership: 1 },
  { unique: true, partialFilterExpression: { isDefaultMembership: true } },
);

export const WorkspaceMember = mongoose.model<IWorkspaceMember>(
  "WorkspaceMember",
  WorkspaceMemberSchema,
);

/**
 * WorkspaceInvite model interface
 */
export interface IWorkspaceInvite extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  email: string;
  token: string;
  role: "admin" | "member" | "viewer";
  invitedBy: string;
  expiresAt: Date;
  acceptedAt?: Date;
}

/**
 * WorkspaceInvite Schema
 */
const WorkspaceInviteSchema = new Schema<IWorkspaceInvite>({
  workspaceId: {
    type: Schema.Types.ObjectId,
    ref: "Workspace",
    required: true,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
    default: () => randomUUID().replace(/-/g, ""),
  },
  role: {
    type: String,
    enum: ["admin", "member", "viewer"],
    required: true,
  },
  invitedBy: {
    type: String,
    ref: "User",
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  },
  acceptedAt: {
    type: Date,
  },
});

// Indexes
WorkspaceInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
WorkspaceInviteSchema.index({ workspaceId: 1, email: 1 });

export const WorkspaceInvite = mongoose.model<IWorkspaceInvite>(
  "WorkspaceInvite",
  WorkspaceInviteSchema,
);

// ---------------------------------------------------------------------------
// Personal folder handles — `users/<handle>/…` in the workspace repo
// ---------------------------------------------------------------------------

/**
 * The readable name of one person's tree in a workspace repo:
 * `joan@realadvisor.com` → `users/joan/`. A handle is the ONLY thing a
 * `users/<segment>/` folder resolves through — a folder named anything else
 * is nobody's tree — so who owns a personal app, console or notebook is
 * decided by this mapping, never by what a folder happens to be called.
 *
 * Its own collection rather than a field on the membership: a handle must
 * outlive the membership. When someone leaves, their `users/joan/` stays in
 * git; if the handle went with the membership doc, the next `joan@…` to join
 * would inherit that tree. Rows are never deleted, so a returning member
 * gets their handle (and their folder) back, and a newcomer gets `joan-2`.
 */
export interface IWorkspaceUserHandle extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: string;
  handle: string;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceUserHandleSchema = new Schema<IWorkspaceUserHandle>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    userId: { type: String, ref: "User", required: true },
    handle: { type: String, required: true },
  },
  { collection: "workspace_user_handles", timestamps: true },
);

// One handle per person per workspace, one person per handle.
WorkspaceUserHandleSchema.index(
  { workspaceId: 1, userId: 1 },
  { unique: true },
);
WorkspaceUserHandleSchema.index(
  { workspaceId: 1, handle: 1 },
  { unique: true },
);

export const WorkspaceUserHandle = mongoose.model<IWorkspaceUserHandle>(
  "WorkspaceUserHandle",
  WorkspaceUserHandleSchema,
);
