import mongoose, { Schema, Document, Types } from "mongoose";
import {
  type IResourceShareEntry,
  type IPublicShare,
  ResourceShareEntrySchema,
  PublicShareSchema,
} from "./shared";

// ---------------------------------------------------------------------------
// Apps (git-backed — see apps.md)
//
// Separate from the retired legacy `MakoApp` documents: new
// collections, no shared fields. Source files live in a Mako-managed
// bare git repository per project (api/src/apps/repository.service.ts);
// these documents hold only control-plane metadata.
// ---------------------------------------------------------------------------

/**
 * One environment variable of an app (apps.md §13.21).
 *
 * The value is ALWAYS stored encrypted (crypto.service), like connection
 * credentials. `secret` decides where the value may flow: non-secret vars
 * reach the sandbox dev server AND the publish build (a `VITE_`-prefixed one
 * is inlined into the public bundle — Maps keys, Supabase anon keys, and the
 * rest of the publishable-credential class); secret vars reach only sandbox
 * dev processes and are refused the `VITE_` prefix outright, because a
 * published app is a static bundle and anything Vite inlines is public.
 */
export interface IAppEnvVar {
  key: string;
  valueEncrypted: string;
  secret: boolean;
}

const AppEnvVarSchema = new Schema<IAppEnvVar>(
  {
    key: { type: String, required: true },
    valueEncrypted: { type: String, required: true },
    secret: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

/** Stages of an app deploy, in order (apps/deploy-progress.ts). */
export const APP_DEPLOY_STAGES = [
  "queued",
  "bindings",
  "build",
  "publishing",
] as const;
export type AppDeployStage = (typeof APP_DEPLOY_STAGES)[number];

export interface IAppDeployProgress {
  sha: string;
  stage: AppDeployStage;
  /** When this sha's deploy was requested (or first seen running). */
  startedAt: Date;
  stageStartedAt: Date;
  /** Heartbeat: last write of any kind for this deploy. */
  updatedAt: Date;
  /** Parquet bindings for this sha: how many are ready, which is running. */
  bindings?: { total: number; prepared: number; current?: string };
}

/**
 * An Apps project: control-plane record for one git-backed app.
 * One bare repo per project (per-app ACLs make the repo the authorization
 * boundary); source contents are never stored in Mongo.
 */
export interface IAppProject extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  title: string;
  /**
   * The app's own folder name — the last segment of `path`, and its URL
   * handle. Not unique per workspace any more: `apps/sales/report` and
   * `users/<handle>/apps/report` may coexist. Optional only for pre-migration docs.
   */
  slug?: string;
  /**
   * Repo-relative folder the app lives in (`apps/sales/report`,
   * `users/<handle>/apps/scratch`). Maintained by the apps index sync from the
   * tree at main; a move in git updates it here. Absent on legacy rows until
   * the backfill migration, where it is `apps/<slug>`.
   */
  path?: string;
  description?: string;
  /** Same Google-style ACL model as v1 apps (utils/resource-acl.ts). */
  access: "private" | "workspace";
  workspaceRole?: "viewer" | "editor";
  sharedWith?: IResourceShareEntry[];
  owner_id?: string;
  createdBy: string;
  defaultBranch: string;
  /**
   * Mako-hosted GitHub mirror (cloud tier): a private repo under the
   * connected GitHub repo that every commit is mirror-pushed to. Absent
   * for projects created before cloud repos existed or when the cloud app is
   * not configured. Auth comes from cloud-app-auth.ts (Mako's own app), NOT
   * the per-workspace BYO installation.
   */
  cloudRepo?: { owner: string; repo: string };
  /** Commit SHA of the last published deployment (§13.3). */
  publishedSha?: string;
  /**
   * "Chat with app" on the live link. Off unless `true` — the owner (or a
   * workspace admin) opts each app in from the Share dialog.
   */
  chatEnabled?: boolean;
  /** When publishedSha was last repointed (publish or rollback). */
  publishedAt?: Date;
  /**
   * Why the most recent deploy attempt did not go live — build output or
   * the binding that could not be prepared. Cleared by the next successful
   * repoint. This is what app_publish_status / app_build_log report when
   * the publish sandbox is asleep, so diagnosing a stalled deploy needs
   * neither a box nor bucket inspection.
   */
  lastDeployError?: {
    sha: string;
    stage: "bindings" | "build" | "publish";
    message: string;
    at: Date;
  };
  /**
   * Where the in-flight deploy of `sha` is (apps/deploy-progress.ts). Set
   * when a deploy is enqueued, moved through bindings → build → publishing,
   * and cleared when that sha goes live or fails (lastDeployError then
   * holds the reason). `updatedAt` is a heartbeat: each binding prepared
   * bumps it, so a stage with no heartbeat for long reads as stalled.
   */
  deployProgress?: IAppDeployProgress;
  /**
   * Stale artifacts a release went live on whose rebuild failed, by binding
   * name. Viewers read old numbers until a later build clears the entry.
   * app_publish_status reports the entries for the live commit.
   */
  bindingRefreshErrors?: Record<
    string,
    { sha: string; message: string; attempts: number; at: Date }
  >;
  /**
   * Anonymous read-only link to the PUBLISHED deployment, optionally password
   * protected. Same primitive v1 apps used, so the management
   * routes and the /api/share/:token consumption side are shared verbatim.
   */
  publicShare?: IPublicShare;
  /** Per-app environment variables, values encrypted at rest (env.service). */
  env?: IAppEnvVar[];
  createdAt: Date;
  updatedAt: Date;
}

const AppProjectSchema = new Schema<IAppProject>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: { type: String, required: true, trim: true },
    slug: { type: String, trim: true },
    path: { type: String, trim: true },
    description: { type: String },
    access: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
    workspaceRole: { type: String, enum: ["viewer", "editor"] },
    sharedWith: { type: [ResourceShareEntrySchema], default: undefined },
    owner_id: { type: String, index: true },
    // Empty when the row was materialized by a system actor (the push-deploy
    // worker, an API key with no acting user) for a repo-imported folder:
    // the app is ownerless until the first person acts on it
    // (ensureProjectRow claims it). resource-acl falls back from owner_id to
    // createdBy, so a sentinel here would become a permanent fake owner.
    createdBy: { type: String, default: "" },
    defaultBranch: { type: String, default: "main" },
    cloudRepo: {
      type: new Schema(
        {
          owner: { type: String, required: true },
          repo: { type: String, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    publishedSha: { type: String },
    chatEnabled: { type: Boolean },
    publishedAt: { type: Date },
    lastDeployError: {
      type: new Schema(
        {
          sha: { type: String, required: true },
          stage: {
            type: String,
            enum: ["bindings", "build", "publish"],
            required: true,
          },
          message: { type: String, required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    bindingRefreshErrors: { type: Schema.Types.Mixed, default: undefined },
    deployProgress: {
      type: new Schema(
        {
          sha: { type: String, required: true },
          stage: {
            type: String,
            enum: APP_DEPLOY_STAGES,
            required: true,
          },
          startedAt: { type: Date, required: true },
          stageStartedAt: { type: Date, required: true },
          updatedAt: { type: Date, required: true },
          bindings: {
            type: new Schema(
              {
                total: { type: Number, required: true },
                prepared: { type: Number, required: true },
                current: { type: String },
              },
              { _id: false },
            ),
            default: undefined,
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
    publicShare: { type: PublicShareSchema, default: undefined },
    env: { type: [AppEnvVarSchema], default: undefined },
  },
  { collection: "app_projects", timestamps: true },
);

AppProjectSchema.index({ workspaceId: 1, updatedAt: -1 });
// Anonymous share lookup is by token alone, so it must be indexed and unique
// across the collection — same shape as v1 apps.
AppProjectSchema.index(
  { "publicShare.token": 1 },
  { unique: true, sparse: true },
);
// The folder is the identity's ADDRESS, not the identity (that is `_id`, which
// the manifest carries). Two apps cannot share a path; two may share a slug
// once folders nest, so the old unique slug index is dropped by the
// app-folders migration and replaced by this one.
// Partial, not sparse: a COMPOUND sparse index still indexes a row whose
// `path` is missing (workspaceId is present), so two rows with the path
// unset — mid-move, or orphaned state rows — would collide on `null`.
AppProjectSchema.index(
  { workspaceId: 1, path: 1 },
  { unique: true, partialFilterExpression: { path: { $exists: true } } },
);
AppProjectSchema.index({ workspaceId: 1, slug: 1 });

export const AppProject = mongoose.model<IAppProject>(
  "AppProject",
  AppProjectSchema,
);

/**
 * What Mako last said on GitHub about one app's deploy of one commit
 * (deploy-commit-status). Keyed by the app's id, NOT its row: an app that
 * only exists as a folder on main has no row until its first deploy, and
 * its first commit must be resolvable all the same.
 *
 * `pending` is the only state anything but the deploy's own outcome may
 * change, and only by compare-and-set: resolving a commit a cancelled run
 * left pending must never overwrite the failure (or success) that run's
 * own outcome already recorded.
 */
export type AppDeployCommitState =
  "pending" | "success" | "failure" | "superseded";

export interface IAppDeployCommitStatus extends Document {
  workspaceId: Types.ObjectId;
  appId: string;
  sha: string;
  state: AppDeployCommitState;
  createdAt: Date;
  updatedAt: Date;
}

const AppDeployCommitStatusSchema = new Schema<IAppDeployCommitStatus>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    appId: { type: String, required: true },
    sha: { type: String, required: true },
    state: {
      type: String,
      enum: ["pending", "success", "failure", "superseded"],
      required: true,
    },
  },
  { collection: "app_deploy_commit_statuses", timestamps: true },
);

AppDeployCommitStatusSchema.index(
  { workspaceId: 1, appId: 1, sha: 1 },
  { unique: true },
);
AppDeployCommitStatusSchema.index({ workspaceId: 1, appId: 1, state: 1 });

export const AppDeployCommitStatus = mongoose.model<IAppDeployCommitStatus>(
  "AppDeployCommitStatus",
  AppDeployCommitStatusSchema,
);

// ---------------------------------------------------------------------------
// App lifecycle + curation — keyed by app id, not by project row
// ---------------------------------------------------------------------------

/**
 * Curation and lifecycle state of one app (app-lifecycle.service.ts). Keyed
 * by the app's id, NOT its `AppProject` row: most apps are folders that never
 * got a row, and an admin must be able to verify one (or the lifecycle job
 * pause one) without materializing state it does not need.
 *
 * Nothing here is derived from git; nothing in git is derived from it. The
 * archive move itself is a commit — `archivedFrom` / `archivedTo` are only a
 * receipt, so a restore knows where the folder came from.
 */
export interface IAppLifecycleState extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  appId: string;
  /** Marked verified by a workspace admin: who and when. */
  verifiedAt?: Date;
  verifiedBy?: string;
  /** When the job first found the app stale and told its owner. */
  staleSince?: Date;
  /** Who the stale notice went to (emails), for the plan report. */
  staleNotifiedTo?: string[];
  /** Binding schedules skipped by the scheduler since then (unviewed). */
  schedulesPausedAt?: Date;
  /** The archive commit's receipt. */
  archivedAt?: Date;
  archivedFrom?: string;
  archivedTo?: string;
  /**
   * Restored from `archive/` by someone (Apps home → Archived → Restore):
   * the planner gives it a fresh grace period from here.
   */
  restoredAt?: Date;
  restoredBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AppLifecycleStateSchema = new Schema<IAppLifecycleState>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    appId: { type: String, required: true },
    verifiedAt: { type: Date },
    verifiedBy: { type: String },
    staleSince: { type: Date },
    staleNotifiedTo: { type: [String], default: undefined },
    schedulesPausedAt: { type: Date },
    archivedAt: { type: Date },
    archivedFrom: { type: String },
    archivedTo: { type: String },
    restoredAt: { type: Date },
    restoredBy: { type: String },
  },
  { collection: "app_lifecycle", timestamps: true },
);

AppLifecycleStateSchema.index({ workspaceId: 1, appId: 1 }, { unique: true });
// The binding scheduler reads the paused set on every tick.
AppLifecycleStateSchema.index(
  { schedulesPausedAt: 1 },
  { partialFilterExpression: { schedulesPausedAt: { $exists: true } } },
);

export const AppLifecycleState = mongoose.model<IAppLifecycleState>(
  "AppLifecycleState",
  AppLifecycleStateSchema,
);

/**
 * Which branch a person's sandbox is on. That is the whole record.
 *
 * It used to carry `baseSha`, `wipOid`, `revision` and `leaseEpoch` — a mirror
 * of a shadow-commit ref that tracked uncommitted work, plus a fencing token
 * to stop a stale sandbox clobbering it. All of that existed because the
 * sandbox had no git remote, so the server had to model the working copy
 * instead of letting the working copy be a working copy. The sandbox pushes
 * now, so git holds the state and there is nothing left to mirror.
 *
 * Even the branch here is only a cache, for showing the right thing while the
 * sandbox is asleep. When it is awake, the sandbox is authoritative: someone
 * can type `git checkout` in the terminal, and that is a legitimate way to
 * switch branches, not a state to correct.
 */
export interface IAppWorktree extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** @deprecated §10: worktrees are per (workspace, actor); unset on new docs. */
  projectId?: Types.ObjectId;
  userId: string;
  /** Last known branch. The sandbox wins whenever it is running. */
  branch: string;
  createdAt: Date;
  updatedAt: Date;
}

const AppWorktreeSchema = new Schema<IAppWorktree>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "AppProject",
    },
    userId: { type: String, required: true },
    branch: { type: String, required: true, default: "main" },
  },
  { collection: "app_worktrees", timestamps: true },
);

// §10 monorepo: ONE worktree per (workspace, actor). The old per-project
// unique index is dropped by the workspace-monorepo migration.
AppWorktreeSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const AppWorktree = mongoose.model<IAppWorktree>(
  "AppWorktree",
  AppWorktreeSchema,
);
