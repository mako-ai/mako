/**
 * Ancestor lookups for console folders (access inheritance, display
 * paths), scoped to one workspace, batched, and safe against cycles.
 *
 * The walks this replaces did one `findById` per level per console (the
 * console sync endpoint loops over up to 100 consoles), were not filtered
 * by workspaceId, and had no visited set: a `parentId` cycle (possible via
 * moves) spun forever, and the recursive path builder overflowed the stack.
 *
 * Here a cache fetches each missing level for ALL requested chains in one
 * `$in` query (scoped by workspace), and walks stop at a repeated folder
 * or at MAX_FOLDER_DEPTH.
 */
import { Types } from "mongoose";

import { consolesChartsRepo } from "../repositories/consoles-charts";

/** Deeper than any real tree; a longer chain is treated as corrupt. */
export const MAX_FOLDER_DEPTH = 64;

export interface FolderNode {
  id: string;
  name: string;
  access?: string;
  isPrivate?: boolean;
  parentId?: string;
}

interface RawFolder {
  _id: Types.ObjectId | string;
  name?: string;
  access?: string;
  isPrivate?: boolean;
  parentId?: Types.ObjectId | string | null;
}

export type FolderLoader = (ids: Types.ObjectId[]) => Promise<RawFolder[]>;

function toNode(raw: RawFolder): FolderNode {
  return {
    id: String(raw._id),
    name: raw.name ?? "",
    access: raw.access,
    isPrivate: raw.isPrivate,
    parentId: raw.parentId ? String(raw.parentId) : undefined,
  };
}

/** A folder's own effective access ("workspace" | "private" | ...). */
export function folderAccess(node: FolderNode): string {
  return node.access || (node.isPrivate ? "private" : "workspace");
}

export class FolderChainCache {
  /** null = looked up and not found (in this workspace). */
  private readonly nodes = new Map<string, FolderNode | null>();

  private constructor(private readonly load: FolderLoader) {}

  /** Lookups scoped to `workspaceId`. */
  static forWorkspace(workspaceId: string | Types.ObjectId): FolderChainCache {
    const ws = String(workspaceId);
    return new FolderChainCache(async ids => {
      const folders = await consolesChartsRepo.findConsoleFoldersByIds(
        ws,
        ids.map(id => id.toString()),
      );
      return folders.map(f => ({
        _id: f.id,
        name: f.name,
        access: f.access,
        isPrivate: f.isPrivate,
        parentId: f.parentId ?? null,
      }));
    });
  }

  /** From a custom loader (tests). */
  static withLoader(load: FolderLoader): FolderChainCache {
    return new FolderChainCache(load);
  }

  /** Seed with folders already loaded for this workspace. */
  seed(folders: RawFolder[]): this {
    for (const folder of folders) {
      const node = toNode(folder);
      this.nodes.set(node.id, node);
    }
    return this;
  }

  /**
   * Make every ancestor of the given folders available, one query per tree
   * level across all of them.
   */
  async prefetch(
    folderIds: Iterable<string | undefined | null>,
  ): Promise<void> {
    let frontier = this.missing(folderIds);
    for (
      let depth = 0;
      depth < MAX_FOLDER_DEPTH && frontier.length > 0;
      depth++
    ) {
      const found = await this.load(frontier.map(id => new Types.ObjectId(id)));
      for (const id of frontier) this.nodes.set(id, null);
      for (const raw of found) {
        const node = toNode(raw);
        this.nodes.set(node.id, node);
      }
      frontier = this.missing(
        found.map(raw => (raw.parentId ? String(raw.parentId) : undefined)),
      );
    }
  }

  private missing(ids: Iterable<string | undefined | null>): string[] {
    const out = new Set<string>();
    for (const id of ids) {
      if (!id || this.nodes.has(id) || !Types.ObjectId.isValid(id)) continue;
      out.add(id);
    }
    return [...out];
  }

  /**
   * The folder and its ancestors, nearest first, from what is loaded. Stops
   * at a missing folder, a cycle, or MAX_FOLDER_DEPTH. Call prefetch first.
   */
  chain(folderId: string | undefined | null): FolderNode[] {
    const out: FolderNode[] = [];
    const seen = new Set<string>();
    let current = folderId ? String(folderId) : undefined;
    while (current && !seen.has(current) && out.length < MAX_FOLDER_DEPTH) {
      seen.add(current);
      const node = this.nodes.get(current);
      if (!node) break;
      out.push(node);
      current = node.parentId;
    }
    return out;
  }

  /** Ancestors loaded on demand (one query per level). */
  async chainOf(folderId: string | undefined | null): Promise<FolderNode[]> {
    await this.prefetch([folderId]);
    return this.chain(folderId);
  }
}
