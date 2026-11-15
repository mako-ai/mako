import { Schema } from "mongoose";
import { decryptString, encryptString } from "../../services/crypto.service";

// Encryption: ONE implementation, in services/crypto.service. These names
// are kept for the many callers that import them from here.
export const encrypt = encryptString;
export const decrypt = decryptString;

/** One principal allowed to write, optionally only to one schema or table. */
export interface IConnectionWriter {
  /** `user:<id>` or `workflow:<name>`; `group:` fits the same field later. */
  principal: string;
  /** Absent: anywhere. `finance`: that schema or dataset. `finance.invoices`: that table. */
  where?: string;
  addedBy?: string;
  addedAt?: Date;
}

/** One entry of a writers list, on database and source connections alike. */
export const ConnectionWriterSchema = new Schema<IConnectionWriter>(
  {
    principal: { type: String, required: true },
    where: { type: String },
    addedBy: { type: String },
    addedAt: { type: Date },
  },
  { _id: false },
);

/**
 * Google Workspace-style sharing primitives, shared by consoles and apps.
 *
 * - `sharedWith` entries grant a specific user `viewer` (read) or `editor`
 *   (read + write) access regardless of the resource's `access` scope.
 * - `workspaceRole` is the role every workspace member gets when the
 *   resource's `access` is "workspace" (workspace members with the `viewer`
 *   member role are always capped to viewer).
 * - `publicShare` (apps only) exposes the resource read-only at
 *   /share/:token, optionally protected by a bcrypt-hashed password. Public
 *   viewers see materialized snapshot artifacts by default. When the owner
 *   opts in with `allowLiveQueries`, an app's public viewer may also re-run the
 *   app's *published* (owner-defined, never viewer-supplied) live bindings
 *   server-side under the owner's connection — read-only and row-capped, so
 *   "live" never means "arbitrary".
 */
export type ResourceShareRole = "viewer" | "editor";

export interface IResourceShareEntry {
  userId: string;
  role: ResourceShareRole;
  addedAt: Date;
  addedBy?: string;
}

export interface IPublicShare {
  enabled: boolean;
  token?: string;
  passwordHash?: string | null;
  /** AES-encrypted copy so owners/admins can reveal the password in the UI. */
  passwordEncrypted?: string | null;
  createdAt?: Date;
  createdBy?: string;
  /**
   * Apps only. When true, the public viewer may execute the app's published
   * live bindings server-side (read-only, row-capped, rate-limited) instead of
   * being limited to frozen snapshots. Default false — existing shares stay
   * snapshot-only. The query is always the owner's published SQL; the viewer
   * never supplies SQL.
   */
  allowLiveQueries?: boolean;
}

/**
 * Shared sharing sub-schemas (consoles, apps).
 */
export const ResourceShareEntrySchema = new Schema<IResourceShareEntry>(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ["viewer", "editor"], default: "editor" },
    addedAt: { type: Date, default: Date.now },
    addedBy: { type: String },
  },
  { _id: false },
);

export const PublicShareSchema = new Schema<IPublicShare>(
  {
    enabled: { type: Boolean, default: false },
    token: { type: String },
    passwordHash: { type: String, default: null },
    passwordEncrypted: { type: String, default: null },
    createdAt: { type: Date },
    createdBy: { type: String },
    allowLiveQueries: { type: Boolean, default: false },
  },
  { _id: false },
);
