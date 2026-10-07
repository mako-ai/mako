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

/**
 * Device names Windows reserves in every directory, with any extension:
 * `flows/con.yml` cannot be created by a Windows checkout at all (git
 * refuses or the clone breaks), so a file name a workspace repo hands out
 * must never be one.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function isWindowsReservedName(slug: string): boolean {
  return WINDOWS_RESERVED.test(slug);
}

/**
 * A slug that is also a valid object id (24 hex digits). Lookups take an id
 * before a name, so such a slug can name ANOTHER object than the one it is
 * the file of — never hand one out.
 */
export function looksLikeObjectId(slug: string): boolean {
  return /^[0-9a-f]{24}$/i.test(slug);
}

/**
 * Why a slug that passes a kind's character rules is still not a name a
 * file may be given, or null when it may be.
 */
export function unsafeSlugReason(slug: string): string | null {
  if (isWindowsReservedName(slug)) {
    return `"${slug}" is a device name Windows reserves (a checkout could not create that file); choose another name.`;
  }
  if (looksLikeObjectId(slug)) {
    return `"${slug}" looks like an object id, and ids resolve before names; choose another name.`;
  }
  return null;
}
