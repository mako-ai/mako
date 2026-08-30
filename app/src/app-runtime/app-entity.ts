/**
 * The v1 app definition shape, kept for the public-share viewer + preview
 * runtime after the Apps v1 editor was removed. Matches what the (kept)
 * read-only API routes serialize.
 */
import type { AppDataBinding, AppFile } from "@mako/schemas";

export interface AppEntity {
  _id: string;
  workspaceId: string;
  title: string;
  description?: string;
  template: string;
  runtime: "cdn" | "webcontainer";
  entrypoint: string;
  files: AppFile[];
  dependencies: Record<string, string>;
  dataBindings: AppDataBinding[];
  version: number;
  /** EntityVersion number last published (draft/published split). */
  publishedVersion?: number;
  publishedAt?: string;
  /** Set when the Apps migration stamped this app — read-only in v1. */
  migratedToV2ProjectId?: string;
  /** Server-computed: viewer cannot modify this app. */
  readOnly?: boolean;
  /** True when the working draft differs from the published version. */
  hasUnpublishedChanges?: boolean;
  access: "private" | "workspace";
  /** Role granted to workspace members when access is "workspace". */
  workspaceRole?: "viewer" | "editor";
  /** Per-user collaborators (viewer/editor). */
  sharedWith?: Array<{
    userId: string;
    role: "viewer" | "editor";
    addedAt?: string;
  }>;
  /** Public link sharing metadata (no secrets). */
  publicShare?: {
    enabled: boolean;
    token?: string;
    hasPassword?: boolean;
    createdAt?: string;
  };
  owner_id?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
