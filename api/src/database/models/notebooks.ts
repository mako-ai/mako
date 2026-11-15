import mongoose, { Schema, Document, Types } from "mongoose";
import {
  type ResourceShareRole,
  type IResourceShareEntry,
  ResourceShareEntrySchema,
} from "./shared";

/**
 * NotebookFolder model interface — organizational folders for notebooks
 * (My Notebooks vs Workspace sections mirror consoles).
 */
export interface INotebookFolder extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  parentId?: Types.ObjectId;
  ownerId?: string;
  access: "private" | "workspace";
  createdAt: Date;
}

/**
 * NotebookFolder Schema
 */
const NotebookFolderSchema = new Schema<INotebookFolder>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: "NotebookFolder",
    },
    ownerId: {
      type: String,
      ref: "User",
    },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

NotebookFolderSchema.index({ workspaceId: 1, parentId: 1 });
NotebookFolderSchema.index({ workspaceId: 1, access: 1 });

export const NotebookFolder = mongoose.model<INotebookFolder>(
  "NotebookFolder",
  NotebookFolderSchema,
);

/**
 * NotebookIndex — Mongo metadata sidecar for GCS/filesystem notebook bodies.
 * One row per notebook id (UUID string matching the object-store filename).
 */
export interface INotebookIndex extends Document {
  notebookId: string;
  workspaceId: Types.ObjectId;
  name: string;
  folderId?: Types.ObjectId;
  ownerId: string;
  access: "private" | "workspace";
  /** Repo-relative path of the committed .deepnote checkpoint (apps.md §24). */
  path?: string;
  /** Blob sha of the last checkpoint (sync levelling). */
  checkpointBlobSha?: string;
  /** Role workspace members get when `access === "workspace"`. */
  workspaceRole?: ResourceShareRole;
  sharedWith?: IResourceShareEntry[];
  updatedAt: Date;
}

/**
 * NotebookIndex Schema
 */
const NotebookIndexSchema = new Schema<INotebookIndex>(
  {
    notebookId: { type: String, required: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    folderId: {
      type: Schema.Types.ObjectId,
      ref: "NotebookFolder",
    },
    ownerId: { type: String, ref: "User", required: true },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
    path: { type: String },
    checkpointBlobSha: { type: String },
    workspaceRole: {
      type: String,
      enum: ["viewer", "editor"],
      default: "viewer",
    },
    sharedWith: {
      type: [ResourceShareEntrySchema],
      default: [],
    },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
  },
);

NotebookIndexSchema.index({ workspaceId: 1, notebookId: 1 }, { unique: true });
NotebookIndexSchema.index({ workspaceId: 1, folderId: 1 });
NotebookIndexSchema.index({ workspaceId: 1, access: 1, ownerId: 1 });

export const NotebookIndex = mongoose.model<INotebookIndex>(
  "NotebookIndex",
  NotebookIndexSchema,
);
