import { Db } from "mongodb";

export const description =
  "Create user_attributions (write-once, 1:1 with users; first-party signup attribution from the mako_attr cookie) with a sparse gclid index";

/**
 * Documents are keyed by user id (_id) and inserted once at signup by
 * api/src/auth/signup-attribution.ts. The sparse gclid index supports
 * ad-click reconciliation lookups; most rows (organic signups) have no gclid.
 *
 * Idempotent AND convergent: Mongoose autoIndex may have already created these
 * indexes under auto-generated names (e.g. `gclid_1`) if the app booted before
 * this migration ran — createIndex with a different name on the same keys then
 * fails with "Index already exists with a different name". So we drop any
 * same-keys index with a non-canonical name first, then create the named one.
 */

interface IndexInfo {
  key?: Record<string, unknown>;
  name?: string;
}

async function ensureNamedIndex(
  db: Db,
  collectionName: string,
  keys: Record<string, number>,
  name: string,
  options: Record<string, unknown> = {},
): Promise<void> {
  const collection = db.collection(collectionName);
  const exists =
    (
      await db
        .listCollections({ name: collectionName }, { nameOnly: true })
        .toArray()
    ).length > 0;
  const indexes: IndexInfo[] = exists ? await collection.indexes() : [];

  for (const idx of indexes) {
    const sameKeys = JSON.stringify(idx.key) === JSON.stringify(keys);
    if (sameKeys && idx.name !== name && idx.name) {
      await collection.dropIndex(idx.name);
    }
  }

  // No-op when the canonical index already exists.
  await collection.createIndex(keys, { ...options, name });
}

export async function up(db: Db): Promise<void> {
  await ensureNamedIndex(
    db,
    "user_attributions",
    { gclid: 1 },
    "user_attributions_gclid",
    {
      sparse: true,
    },
  );
  await ensureNamedIndex(
    db,
    "user_attributions",
    { capturedAt: 1 },
    "user_attributions_captured_at",
  );
}
