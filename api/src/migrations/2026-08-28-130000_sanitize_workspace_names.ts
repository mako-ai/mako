/**
 * Sanitize workspace names in place.
 *
 * The onboarding name field accepted unbounded free text, and users pasted
 * entire app prompts and SQL queries into it — thousand-character "names"
 * that poison every list rendering them (the super-admin feature-flag page
 * became unreadable). Creation/rename now enforce the rules at the API
 * boundary (see WorkspaceName in routes/workspaces.ts); this brings the
 * existing rows level with the same rules:
 *
 *   - control characters and newlines collapse to spaces
 *   - runs of whitespace collapse to one space, ends trimmed
 *   - length capped at WORKSPACE_NAME_MAX (80)
 *   - an empty result falls back to the slug (never a nameless workspace)
 *
 * Slugs are untouched — they are identities; the name is just the label.
 */
import { Db, ObjectId } from "mongodb";
import { loggers } from "../logging";

/** Mirrors WorkspaceName in routes/workspaces.ts — inlined so the migration
 *  CLI does not import the whole route graph. */
const WORKSPACE_NAME_MAX = 80;

const log = loggers.migration();

export const description =
  "Sanitize workspace names (collapse whitespace/control chars, cap at 80)";

const controlChars = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + "\\u007f]+",
  "g",
);

export function sanitizeWorkspaceName(raw: unknown, slug: string): string {
  const cleaned = String(raw ?? "")
    .replace(controlChars, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WORKSPACE_NAME_MAX)
    .trim();
  return cleaned || slug;
}

export async function up(db: Db): Promise<void> {
  const workspaces = db.collection<{
    _id: ObjectId;
    name?: string;
    slug?: string;
  }>("workspaces");
  const cursor = workspaces.find({}, { projection: { name: 1, slug: 1 } });
  let scanned = 0;
  let changed = 0;
  let batch: Array<{
    updateOne: {
      filter: { _id: ObjectId };
      update: { $set: { name: string } };
    };
  }> = [];
  for await (const doc of cursor) {
    scanned += 1;
    const next = sanitizeWorkspaceName(doc.name, doc.slug ?? "workspace");
    if (next === doc.name) continue;
    changed += 1;
    batch.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: { name: next } } },
    });
    if (batch.length >= 500) {
      await workspaces.bulkWrite(batch, { ordered: false });
      batch = [];
    }
  }
  if (batch.length > 0) {
    await workspaces.bulkWrite(batch, { ordered: false });
  }
  log.info("Workspace names sanitized", { scanned, changed });
}
