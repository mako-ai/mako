import { Db } from "mongodb";

export const description =
  "Create user_attributions (write-once, 1:1 with users; first-party signup attribution from the mako_attr cookie) with a sparse gclid index";

/**
 * Documents are keyed by user id (_id) and inserted once at signup by
 * api/src/auth/signup-attribution.ts. The sparse gclid index supports
 * ad-click reconciliation lookups; most rows (organic signups) have no gclid.
 * Idempotent: createIndex is a no-op when the index already exists.
 */
export async function up(db: Db): Promise<void> {
  const attributions = db.collection("user_attributions");
  await attributions.createIndex(
    { gclid: 1 },
    { sparse: true, name: "user_attributions_gclid" },
  );
  await attributions.createIndex(
    { capturedAt: 1 },
    { name: "user_attributions_captured_at" },
  );
}
