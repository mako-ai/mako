import mongoose, { Schema, Document, Types } from "mongoose";

// ---------------------------------------------------------------------------
// Favourites — one person's bookmark tree, never a location
// ---------------------------------------------------------------------------

export type FavouriteKind = "app" | "console" | "notebook";

/**
 * Browser-bookmark shape (Firefox's `moz_bookmarks`): folders and items are
 * rows in one self-referential table, so nesting, reordering and "move into
 * folder" are each one update. An item points at an entity by kind + id and
 * carries nothing of its own — a favourite that no longer resolves is simply
 * not shown. Starring never moves the entity: the entity's place is its
 * folder in git; this is a view over it.
 */
export interface IFavourite extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: string;
  /** Parent folder row, or null at the root. */
  parentId: string | null;
  type: "folder" | "item";
  /** Folders only. */
  title?: string;
  /** Items only. */
  kind?: FavouriteKind;
  refId?: string;
  /** Order among siblings. */
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

const FavouriteSchema = new Schema<IFavourite>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    userId: { type: String, required: true },
    parentId: { type: String, default: null },
    type: { type: String, enum: ["folder", "item"], required: true },
    title: { type: String, trim: true },
    // "dashboard" rows from the removed dashboards feature may still exist;
    // listFavourites() filters them out.
    kind: { type: String, enum: ["app", "console", "notebook"] },
    refId: { type: String },
    position: { type: Number, required: true, default: 0 },
  },
  { collection: "favourites", timestamps: true },
);

FavouriteSchema.index({ workspaceId: 1, userId: 1, parentId: 1, position: 1 });
// An entity is in one place in a person's favourites, so "unstar" is
// unambiguous and the star toggle has one row to look at.
FavouriteSchema.index(
  { workspaceId: 1, userId: 1, kind: 1, refId: 1 },
  { unique: true, partialFilterExpression: { type: "item" } },
);

export const Favourite = mongoose.model<IFavourite>(
  "Favourite",
  FavouriteSchema,
);
