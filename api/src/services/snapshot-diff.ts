/**
 * Snapshot comparison helper shared by the apps and dashboards draft/published
 * splits.
 *
 * Mongoose `minimize` (on by default) strips empty objects (e.g.
 * `dependencies: {}`) when persisting a Mixed `published` field, so a naive
 * JSON compare against a freshly-built draft snapshot reports phantom
 * differences. `canonicalizeSnapshot` recursively drops `undefined`/`null` and
 * empty objects and sorts object keys so both sides normalize identically.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = canonicalize((value as Record<string, unknown>)[key]);
      if (v === undefined || v === null) continue;
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v).length === 0
      ) {
        continue; // drop empty objects (Mongoose minimize parity)
      }
      out[key] = v;
    }
    return out;
  }
  return value;
}

export function canonicalizeSnapshot(snapshot: unknown): string {
  return JSON.stringify(canonicalize(snapshot ?? null));
}

/** True when two snapshots are equal after canonicalization. */
export function snapshotsEqual(a: unknown, b: unknown): boolean {
  return canonicalizeSnapshot(a) === canonicalizeSnapshot(b);
}
