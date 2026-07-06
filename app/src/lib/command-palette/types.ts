import type { LucideIcon } from "lucide-react";
import type { ThemeMode } from "../../contexts/ThemeContext";

/**
 * Context handed to commands when they run. Built by the CommandPalette
 * component so commands can reach values that live in React context
 * (theme mode, auth) as well as the current workspace.
 */
export interface PaletteRunContext {
  workspaceId: string;
  setThemeMode: (mode: ThemeMode) => void;
}

/** A user-invokable command shown in `>` mode (and mixed into default mode). */
export interface PaletteCommand {
  id: string;
  title: string;
  /** Section header the command is grouped under. */
  section: string;
  /** Extra match terms beyond the title. */
  keywords?: string[];
  icon: LucideIcon;
  run: (ctx: PaletteRunContext) => void;
}

/** A navigable entity (open tab, console, dashboard, ...) in default mode. */
export interface PaletteEntityItem {
  id: string;
  title: string;
  subtitle?: string;
  section: string;
  icon: LucideIcon;
  run: (ctx: PaletteRunContext) => void;
}

export type PaletteItem = PaletteCommand | PaletteEntityItem;

/** Score of one lowercase token against one lowercase text. 0 = no match. */
function tokenScore(token: string, text: string): number {
  if (text === token) return 4;
  if (text.startsWith(token)) return 3;
  // Word-boundary match ("con" matching "New Console")
  if (text.split(/[\s/_:-]+/).some(word => word.startsWith(token))) return 2;
  if (text.includes(token)) return 1;
  return 0;
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Simple relevance score: 0 = no match. Higher is better. Case-insensitive
 * and token-based — every word of the query must match somewhere in the
 * text ("theme light" matches "Theme: Light"). An empty query matches
 * everything (score 1) so default mode can list items.
 */
export function matchScore(query: string, text: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 1;
  const t = text.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(token, t);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/**
 * Score against a title plus optional keywords. Each query token may match
 * either the title or a keyword (keyword hits are capped so title matches
 * always rank higher); tokens that match nothing disqualify the item.
 */
export function scoreItem(
  query: string,
  title: string,
  keywords?: string[],
): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 1;
  const t = title.toLowerCase();
  const kws = (keywords ?? []).map(keyword => keyword.toLowerCase());
  let total = 0;
  for (const token of tokens) {
    let best = tokenScore(token, t);
    for (const keyword of kws) {
      best = Math.max(best, Math.min(tokenScore(token, keyword), 2));
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}
