/**
 * Filename-safe slugs for config-as-code identities.
 *
 * A slug is minted ONCE from a display name and then never moves: it is the
 * filename a resource lives under in the workspace repo, so changing it
 * would rename (and orphan) the file. Display names stay editable inside
 * the file. See apps.md §23.
 *
 * dbt jobs established the rules; flows reuse them verbatim so a workspace
 * repo reads consistently across `dbt/jobs/*.yml` and `flows/*.yml`.
 */

/**
 * Lowercase, strip accents, collapse everything else to single dashes.
 * `fallback` is returned when the name has no slug-able characters at all
 * (e.g. a name that is entirely emoji or CJK, which NFKD cannot fold).
 */
export function slugifyName(
  name: string,
  options?: { maxLength?: number; fallback?: string },
): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    // Combining marks left behind by NFKD (é → e + U+0301).
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, options?.maxLength ?? 64)
    // A trailing dash can reappear after slicing mid-word.
    .replace(/-+$/g, "");
  return slug || (options?.fallback ?? "item");
}

/**
 * First free `<base>`, `<base>-2`, `<base>-3`… for which `isTaken` is false.
 * Used to reserve a slug against rows that already hold one.
 */
export async function reserveSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  options?: { limit?: number; label?: string },
): Promise<string> {
  const limit = options?.limit ?? 100;
  let candidate = base;
  for (let i = 2; i <= limit; i++) {
    if (!(await isTaken(candidate))) return candidate;
    candidate = `${base}-${i}`;
  }
  throw new Error(
    `Could not find a free slug for ${options?.label ?? `"${base}"`}`,
  );
}
