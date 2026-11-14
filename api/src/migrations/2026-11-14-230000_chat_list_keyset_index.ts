import { Db } from "mongodb";
import { loggers } from "../logging";

export const description =
  "Extend the chat list index with _id (chats workspaceId+createdBy+updatedAt+_id) so the paginated list's keyset sort is index-served, and drop the 3-key prefix it replaces";

const log = loggers.migration();

const KEYSET_INDEX = {
  workspaceId: 1,
  createdBy: 1,
  updatedAt: -1,
  _id: -1,
} as const;

/** Added by 2026-11-14-195942; a strict prefix of KEYSET_INDEX. */
const PREFIX_INDEX = { workspaceId: 1, createdBy: 1, updatedAt: -1 } as const;

function findIndexOnKeys(
  indexes: { name?: string; key: Record<string, unknown> }[],
  keyPattern: Record<string, number>,
): { name?: string } | undefined {
  const target = JSON.stringify(keyPattern);
  return indexes.find(idx => JSON.stringify(idx.key) === target);
}

/**
 * Idempotent (checked by key pattern). The new index is created before the
 * old one is dropped, so the list query always has an index to use.
 */
export async function up(db: Db): Promise<void> {
  const chats = db.collection("chats");
  let indexes: { name?: string; key: Record<string, unknown> }[] = [];
  try {
    indexes = await chats.listIndexes().toArray();
  } catch {
    // NamespaceNotFound: nothing exists yet, so nothing can conflict.
  }

  if (findIndexOnKeys(indexes, KEYSET_INDEX)) {
    log.info("Chat list keyset index already present, skipping create");
  } else {
    await chats.createIndex(KEYSET_INDEX);
    log.info("Created chat list keyset index", { key: KEYSET_INDEX });
  }

  const prefix = findIndexOnKeys(indexes, PREFIX_INDEX);
  if (prefix?.name) {
    await chats.dropIndex(prefix.name);
    log.info("Dropped redundant chat list prefix index", {
      name: prefix.name,
    });
  }
}
