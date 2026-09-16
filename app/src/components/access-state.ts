/**
 * Who can see an entity, and how that reads on a row.
 *
 * Helpers only — the component lives in `AccessIcon.tsx`, because a file that
 * exports both a component and plain functions breaks Fast Refresh. Same split
 * as `resource-tree/utils.ts` vs `dnd.tsx`.
 */
export type AccessState = "private" | "workspace" | "shared";

/**
 * Derived from the fields every explorer's rows already carry. Mirrors the
 * sectioning rule: workspace access wins; otherwise a foreign owner means it
 * was shared with you; otherwise it is yours alone.
 */
export function resolveAccessState(
  node: { access?: string | null; owner_id?: string | null },
  userId: string | undefined,
): AccessState {
  if ((node.access ?? "workspace") === "workspace") return "workspace";
  if (node.owner_id && userId && node.owner_id !== userId) return "shared";
  return "private";
}

export const ACCESS_LABEL: Record<AccessState, string> = {
  private: "Private — only you",
  workspace: "Visible to the whole workspace",
  shared: "Shared with you",
};
