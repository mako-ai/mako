/**
 * Git authors for console commits: a Mako user id → name + email, cached.
 * Shared beyond consoles (flows, skills, notebooks, dbt commit as the user).
 */
import { authRepo } from "../../repositories/auth";
import { BoundedMap } from "../../utils/bounded-map";
import type { GitAuthor } from "../repository.service";

// Bounded, and expiring so a renamed user's commits pick up the new name.
const authorCache = new BoundedMap<string, GitAuthor | undefined>({
  maxEntries: 5_000,
  ttlMs: 10 * 60_000,
});

/** Git author for a Mako user id; undefined (→ Mako) when unknown. */
export async function authorForUser(
  userId: string | undefined | null,
): Promise<GitAuthor | undefined> {
  if (!userId) return undefined;
  if (authorCache.has(userId)) return authorCache.get(userId);
  let author: GitAuthor | undefined;
  try {
    const user = await authRepo.findUserById(userId);
    if (user?.email) {
      author = {
        name: user.name?.trim() || user.email.split("@")[0] || user.email,
        email: user.email,
      };
    }
  } catch (error) {
    if ((error as Error | null)?.name !== "CastError") return undefined;
  }
  authorCache.set(userId, author);
  return author;
}
