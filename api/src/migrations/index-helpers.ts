/**
 * Shared helpers for migrations (not a migration: the runner only loads
 * files named yyyy-mm-dd-hhmmss_name.ts).
 */
import type { Collection, Document } from "mongodb";

/** MongoDB's NamespaceNotFound: the collection does not exist yet. */
function isNamespaceNotFound(error: unknown): boolean {
  const { code, message } = (error ?? {}) as {
    code?: number;
    message?: string;
  };
  return code === 26 || /ns does not exist/i.test(message ?? "");
}

/**
 * A collection's indexes, or [] when the collection does not exist yet.
 * `listIndexes`/`indexes` throw NamespaceNotFound on a missing collection,
 * which on a fresh database (new developer, preview DB, self-hosted install)
 * failed every migration that inspected indexes before creating them.
 */
/**
 * One listIndexes entry. `key` values are `any` on purpose: each migration
 * reads the key as the shape it created (numeric directions, "text", …), as
 * it did with the raw driver call this replaces.
 */
export type IndexInfo = Document & { key: Record<string, any>; name: string };

export async function indexesOf<T extends Document>(
  collection: Collection<T>,
): Promise<IndexInfo[]> {
  try {
    return (await collection.listIndexes().toArray()) as IndexInfo[];
  } catch (error) {
    if (isNamespaceNotFound(error)) return [];
    throw error;
  }
}
