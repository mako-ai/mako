/**
 * Personal folder handles: who `users/<segment>/` belongs to.
 *
 * Every personal tree in a workspace repo — apps, consoles, notebooks — sits
 * under `users/<handle>/`, where the handle is the person's email local part
 * (`joan@realadvisor.com` → `joan`), with `-2`, `-3`… on a collision inside
 * the workspace. The workspace keeps the mapping (`workspace_user_handles`);
 * this module is its pure half: deriving and assigning handles, and the
 * directory every path parser resolves an owner through.
 *
 * The security rule is that a folder NAME grants nothing. Ownership is the
 * mapping's answer for the segment, and a segment the mapping does not know
 * — a typo, a folder someone pushed by hand, an old `users/<userId>/` — is
 * nobody's tree: not listed as anyone's, not writable as anyone's. Callers
 * compare the resolved userId with the actor's, never the raw segment.
 */

/** A handle as it appears in a path: lowercase, git- and URL-safe. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/;

/** The longest base handle; leaves room for a `-NN` collision suffix. */
const MAX_BASE_LENGTH = 40;

export function isHandle(value: string): boolean {
  return HANDLE_RE.test(value) && !value.includes("..");
}

/**
 * The handle an email asks for, before collisions: the local part,
 * lowercased, without a `+tag`, with anything a path should not carry
 * turned into `-`. Never empty.
 */
export function handleFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").split("+")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/[._-]+$/, "");
  return cleaned || "user";
}

export interface HandleRow {
  userId: string;
  handle: string;
}

export interface HandleCandidate {
  userId: string;
  email: string;
  /** Membership start: the earlier member keeps the bare handle. */
  joinedAt?: Date | string | number;
}

/**
 * Handles for the people in `candidates` who have none yet. Deterministic:
 * oldest member first (then userId), so the first `joan` keeps `joan` and
 * the next gets `joan-2`, whichever instance or script runs it.
 *
 * `reserved` holds strings no handle may take: every user id the workspace
 * knows. A handle spelled like someone's id would let a stale
 * `users/<thatId>/` folder (pre-migration, or pushed by hand) resolve to the
 * wrong person, so such a candidate is skipped like a taken one.
 */
export function assignHandles(
  candidates: HandleCandidate[],
  existing: HandleRow[],
  reserved: ReadonlySet<string> = new Set(),
): HandleRow[] {
  const has = new Set(existing.map(r => r.userId));
  const taken = new Set(existing.map(r => r.handle));
  const time = (c: HandleCandidate) =>
    c.joinedAt === undefined ? Number.MAX_SAFE_INTEGER : +new Date(c.joinedAt);
  const ordered = candidates
    .filter(c => !has.has(c.userId))
    .sort((a, b) => time(a) - time(b) || a.userId.localeCompare(b.userId));
  const out: HandleRow[] = [];
  for (const c of ordered) {
    if (has.has(c.userId)) continue; // a duplicate candidate
    const base = handleFromEmail(c.email);
    let handle = base;
    for (let n = 2; taken.has(handle) || reserved.has(handle); n++) {
      handle = `${base}-${n}`;
    }
    taken.add(handle);
    has.add(c.userId);
    out.push({ userId: c.userId, handle });
  }
  return out;
}

/**
 * The mapping, ready for the synchronous path parsers. Built once per read
 * (see user-handles.service.ts) and passed down, so no parser ever reaches
 * for Mongo and none can skip the lookup.
 */
export class OwnerDirectory {
  private readonly byHandle = new Map<string, string>();
  private readonly byUser = new Map<string, string>();

  constructor(rows: Iterable<HandleRow>) {
    for (const row of rows) {
      this.byHandle.set(row.handle, row.userId);
      this.byUser.set(row.userId, row.handle);
    }
  }

  /**
   * The userId whose tree `users/<segment>/` is, or null when the segment is
   * not a handle of this workspace. Exact match: `users/Joan/` is not
   * `users/joan/`, as it is not in git.
   */
  ownerOf(segment: string | undefined | null): string | null {
    if (!segment) return null;
    return this.byHandle.get(segment) ?? null;
  }

  /** The handle naming this person's tree, if they have one. */
  handleOf(userId: string | undefined | null): string | undefined {
    if (!userId) return undefined;
    return this.byUser.get(userId);
  }

  get size(): number {
    return this.byHandle.size;
  }

  /** Every (userId, handle) the workspace has assigned. */
  rows(): HandleRow[] {
    return [...this.byUser].map(([userId, handle]) => ({ userId, handle }));
  }
}

/** An empty directory: every `users/<x>/` is nobody's. */
export const NO_OWNERS = new OwnerDirectory([]);
