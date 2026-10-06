/**
 * What a dashboard save's "Changes since last save" diffs against: the latest saved
 * version, with the dashboard's CURRENT title. A rename is already saved —
 * it writes the title (and the published copy's) without a version — so
 * the version's old title would list the rename as a pending change (the
 * e2e's Save dialog did). Only explicit saves, renames and restores write
 * the row's title, so the row's is the saved one.
 */
export function dashboardDiffBase(
  latestSnapshot: Record<string, unknown> | null,
  live: { title?: string } | null,
): Record<string, unknown> | null {
  if (!latestSnapshot) return null;
  if (!live?.title || live.title === latestSnapshot.title) {
    return latestSnapshot;
  }
  return { ...latestSnapshot, title: live.title };
}
