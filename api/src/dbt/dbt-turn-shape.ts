/**
 * Whether a chat turn is "dbt-shaped" — i.e. whether `.makorules` resolution
 * is even worth attempting for it.
 *
 * `detectAgentId` always resolves to "unified" (there is no separate runtime
 * agent per tab kind), so gating rules injection on the resolved agent id is
 * a no-op — it fires on every turn, dbt or not. The real signal for "is this
 * turn about a dbt project" lives in the turn context: which tabs are open,
 * and what kind of tab is active. This predicate is pure and framework-free
 * so it can be unit-tested without booting the route.
 */

export interface DbtShapedTabContext {
  dbtProjectId?: string;
}

export interface DbtShapedTurnInput {
  openTabs?: DbtShapedTabContext[];
  tabKind?: string;
}

export function isDbtShapedTurn({
  openTabs,
  tabKind,
}: DbtShapedTurnInput): boolean {
  if ((openTabs ?? []).some(tab => tab.dbtProjectId)) return true;
  if (tabKind?.startsWith("dbt-")) return true;
  return false;
}
