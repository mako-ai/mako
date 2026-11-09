/**
 * Is the person (or share) a published token was minted for STILL allowed
 * to see the app? The token's signature proves who it was minted for; this
 * decides, on every use, whether that still holds — so removing a member,
 * unsharing the app, or disabling or rotating its share link takes effect
 * within ACCESS_CACHE_MS, however long the token itself lives.
 */
import { AppProject } from "../database/workspace-schema";
import { resolveAppViewer } from "./app-viewer.service";
import { shareFingerprint, type PreviewGrant } from "./preview.service";
import { timingSafeEqual } from "node:crypto";

/** How stale a verdict may be: a page's burst of requests costs one check. */
const ACCESS_CACHE_MS = 60_000;
const MAX_ENTRIES = 10_000;
const verdicts = new Map<string, { allowed: boolean; at: number }>();

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function check(grant: PreviewGrant): Promise<boolean> {
  const project = await AppProject.findById(grant.projectId);
  if (!project) return false;
  if (grant.share) {
    const share = project.publicShare;
    return !!(
      share?.enabled &&
      share.token &&
      sameString(shareFingerprint(share.token), grant.share)
    );
  }
  if (grant.viewer) {
    const viewer = await resolveAppViewer(project, grant.viewer);
    return !!viewer?.app.role;
  }
  // Minted for nobody in particular: only the short TTL bounds it.
  return true;
}

export async function publishedGrantAllowed(
  grant: PreviewGrant,
  now = Date.now(),
): Promise<boolean> {
  const key = `${grant.projectId}:${grant.share ? `s:${grant.share}` : `u:${grant.viewer?.id ?? ""}`}`;
  const hit = verdicts.get(key);
  if (hit && now - hit.at < ACCESS_CACHE_MS) return hit.allowed;
  const allowed = await check(grant);
  if (verdicts.size >= MAX_ENTRIES) verdicts.clear();
  verdicts.set(key, { allowed, at: now });
  return allowed;
}

/** Tests only. */
export function clearPublishedGrantAccessCache(): void {
  verdicts.clear();
}
