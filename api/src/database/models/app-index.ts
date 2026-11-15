import mongoose, { Schema, Document, Types } from "mongoose";

// ---------------------------------------------------------------------------
// Apps index — derived from the tree at main, rebuilt on every push
// ---------------------------------------------------------------------------

/**
 * One row per app folder on `main`. Derived, disposable, rebuilt from git by
 * `syncAppsIndexFromRepo`; nothing here is authoritative. Flat on purpose
 * (string ids, no nested documents) so the Postgres move is a column copy.
 * The sidebar, search, the agent's list and the binding scheduler read this
 * instead of scanning the repo.
 */
export interface IAppIndexEntry extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** The app's identity (24 hex): manifest `id`, or derived from the path. */
  appId: string;
  /** Repo-relative folder: `apps/sales/report`, `users/<handle>/apps/x`. */
  path: string;
  /** Last path segment — the URL handle. */
  slug: string;
  scope: "workspace" | "private";
  /** Owner of the `users/<handle>/apps` tree (resolved userId), for `private`. */
  ownerId?: string;
  /** git tree oid of the folder: equal ⇒ identical content ⇒ no rebuild. */
  treeOid: string;
  title: string;
  description?: string;
  /** Whether `mako.json` declares the id (false = derived from the path). */
  hasManifestId: boolean;
  /**
   * Set when this folder declared an id another folder already holds — a
   * copy that kept its source's manifest. The row is filed under a derived
   * id instead and the UI offers to stamp a fresh one.
   */
  duplicateOf?: string;
  /** Scheduled bindings, so the scheduler never opens the repo. */
  schedules: Array<{ binding: string; cron: string; timezone?: string }>;
  /** Tables the app's bindings read (`FROM`/`JOIN`) — search input. */
  tables?: string[];
  /** The same tables per binding — which binding file reads which table. */
  bindingTables?: Array<{ binding: string; tables: string[] }>;
  /** Binding names on main — which binding state rows are current. */
  bindings?: string[];
  /** Who first committed the app's manifest, and when (discovery). */
  authorEmail?: string;
  firstCommitAt?: Date;
  /**
   * The app's own `thumbnail.{png,webp,jpg,jpeg,svg}` at its root, when it
   * ships one: the file name and its blob oid (content-addressed, so the
   * Apps home caches it forever under `?v=<oid>`).
   */
  thumbnail?: { file: string; oid: string };
  /** The main commit this row was built from. */
  indexedSha: string;
  createdAt: Date;
  updatedAt: Date;
}

const AppIndexEntrySchema = new Schema<IAppIndexEntry>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    appId: { type: String, required: true },
    path: { type: String, required: true },
    slug: { type: String, required: true },
    scope: {
      type: String,
      enum: ["workspace", "private"],
      required: true,
    },
    ownerId: { type: String },
    treeOid: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String },
    hasManifestId: { type: Boolean, required: true, default: false },
    duplicateOf: { type: String },
    schedules: {
      type: [
        new Schema(
          {
            binding: { type: String, required: true },
            cron: { type: String, required: true },
            timezone: { type: String },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    tables: { type: [String], default: undefined },
    bindingTables: {
      type: [
        new Schema(
          {
            binding: { type: String, required: true },
            tables: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    bindings: { type: [String], default: undefined },
    authorEmail: { type: String },
    firstCommitAt: { type: Date },
    thumbnail: {
      type: new Schema(
        {
          file: { type: String, required: true },
          oid: { type: String, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    indexedSha: { type: String, required: true },
  },
  { collection: "app_index", timestamps: true },
);

// An app id is unique across workspaces (a copied manifest must not alias
// another workspace's app); the per-workspace lookup index is plain.
AppIndexEntrySchema.index({ appId: 1 }, { unique: true });
AppIndexEntrySchema.index({ workspaceId: 1, appId: 1 });
AppIndexEntrySchema.index({ workspaceId: 1, path: 1 }, { unique: true });
AppIndexEntrySchema.index({ workspaceId: 1, slug: 1 });
// Link previews of `/apps/<slug>` tab URLs carry no workspace: find the
// app by its folder name across workspaces (share-og.service).
AppIndexEntrySchema.index({ slug: 1, scope: 1 });

export const AppIndexEntry = mongoose.model<IAppIndexEntry>(
  "AppIndexEntry",
  AppIndexEntrySchema,
);

/**
 * Which commit of main a workspace's app index reflects, plus the folders
 * that exist in its trees — including empty ones held by a `.gitkeep`, which
 * no app row would otherwise reveal.
 */
export interface IAppIndexHead extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  sha: string;
  schemaVersion?: number;
  /** Every folder in the app trees, as repo-relative paths (`apps/sales`). */
  folders: string[];
  updatedAt: Date;
}

const AppIndexHeadSchema = new Schema<IAppIndexHead>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
    },
    sha: { type: String, required: true },
    schemaVersion: { type: Number },
    folders: { type: [String], default: [] },
  },
  { collection: "app_index_heads", timestamps: true },
);

export const AppIndexHead = mongoose.model<IAppIndexHead>(
  "AppIndexHead",
  AppIndexHeadSchema,
);

/**
 * One app's embedding for semantic search (app-embeddings.service): the
 * vector of its search document (app-embedding-doc.ts) and the document's
 * hash, so an app is re-embedded only when what it says changed. Derived
 * and disposable like the index: drop it and the next index read refills it.
 * Scanned per workspace in memory (a hundred apps), so no vector index.
 */
export interface IAppEmbedding extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  appId: string;
  /** Path and tree the document was built from: equal ⇒ skip rebuilding. */
  path: string;
  treeOid: string;
  docHash: string;
  /** Embedding model label (getEmbeddingModelName): another ⇒ re-embed. */
  embeddingModel: string;
  vector: number[];
  /** The document's distinct words (app-search tokenize), for search. */
  terms?: string[];
  updatedAt: Date;
}

const AppEmbeddingSchema = new Schema<IAppEmbedding>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    appId: { type: String, required: true },
    path: { type: String, required: true },
    treeOid: { type: String, required: true },
    docHash: { type: String, required: true },
    embeddingModel: { type: String, required: true },
    vector: { type: [Number], required: true },
    terms: { type: [String], default: undefined },
  },
  { collection: "app_embeddings", timestamps: true },
);

AppEmbeddingSchema.index({ workspaceId: 1, appId: 1 }, { unique: true });

export const AppEmbedding = mongoose.model<IAppEmbedding>(
  "AppEmbedding",
  AppEmbeddingSchema,
);
