import type * as React from "react";

/** ok | warn | bad (or green | amber | red), plus loading and neutral. */
export type Tone =
  | "ok"
  | "warn"
  | "bad"
  | "green"
  | "amber"
  | "red"
  | "warning"
  | "error"
  | "fresh"
  | "stale"
  | "loading"
  | "neutral";

/** Join class names, skipping falsy ones. */
export function cx(...parts: Array<string | false | null | undefined>): string;

export function normalizeTone(tone: Tone | string | undefined): "ok" | "warn" | "bad" | "loading" | "neutral";

/**
 * The order RefreshAllButton runs bindings in: `first`, the rest by name,
 * then `last`. Patterns ending in `*` match a prefix; `skip` drops bindings.
 */
export function refreshOrder(
  bindings: readonly string[],
  options?: { first?: readonly string[]; last?: readonly string[]; skip?: readonly string[] },
): string[];

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "outline" | "primary" | "ghost";
  size?: "md" | "sm";
}
export const Button: React.ForwardRefExoticComponent<ButtonProps & React.RefAttributes<HTMLButtonElement>>;

export function StatusDot(props: { tone?: Tone; className?: string }): React.ReactElement;

export function PageHeader(props: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}): React.ReactElement;

export interface CardProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}
export function Card(props: CardProps): React.ReactElement;

export function KpiTile(props: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  /** Colours the delta. */
  tone?: Tone;
  hint?: React.ReactNode;
  className?: string;
}): React.ReactElement;

export function KpiRow(props: { className?: string; children?: React.ReactNode }): React.ReactElement;

export interface MultiSelectOption<V extends string = string> {
  value: V;
  label: string;
  /** A colour swatch shown next to the label (e.g. a chart series colour). */
  color?: string;
}

export interface MultiSelectProps<V extends string = string> {
  options: ReadonlyArray<V | MultiSelectOption<V>>;
  value: readonly V[];
  onChange: (next: V[]) => void;
  allLabel?: string;
  /**
   * true (default): an empty selection means "all".
   * false: "all" is every value selected; the All row selects every option.
   */
  emptyMeansAll?: boolean;
  /** An "Only" button on each row that selects just that value. */
  showOnly?: boolean;
  /** Chips shown in the trigger before "+n". Default 2. */
  maxChips?: number;
  /** Which edge the menu aligns to before flipping. Default "start". */
  align?: "start" | "end";
  className?: string;
  "aria-label"?: string;
}
export function MultiSelect<V extends string = string>(props: MultiSelectProps<V>): React.ReactElement;

export interface FreshnessSource {
  key?: string;
  label: React.ReactNode;
  note?: React.ReactNode;
  detail?: React.ReactNode;
  /** Right-aligned, e.g. "Synced 09:05" or "2h ago". */
  value?: React.ReactNode;
  tone?: Tone;
}

export interface FreshnessBadgeProps {
  tone?: Tone;
  headline: React.ReactNode;
  /** Panel heading, e.g. "Data as of 09:05". */
  title?: React.ReactNode;
  /** Right of the heading, e.g. "12m ago". */
  meta?: React.ReactNode;
  schedule?: React.ReactNode;
  sources?: FreshnessSource[];
  /** A callout above the sources, e.g. a "Load latest" button. */
  action?: React.ReactNode;
  footer?: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}
export function FreshnessBadge(props: FreshnessBadgeProps): React.ReactElement;

export interface RefreshAllButtonProps {
  /** The app's binding names (see the README for the build-time define). */
  bindings: readonly string[];
  /** Human labels per binding name; unlisted names show as-is. */
  labels?: Record<string, string>;
  /** Run these first (heaviest/slowest). `*` suffix = prefix match. */
  first?: readonly string[];
  /** Run these last (e.g. the freshness snapshot). */
  last?: readonly string[];
  /** Never rebuild these on demand (static, or too big for a request). */
  skip?: readonly string[];
  /** Bindings rebuilt at once. Default 3; keep it low. */
  concurrency?: number;
  /** Appended to the description, e.g. "Data also refreshes at 06:30." */
  schedule?: string;
  /** Override the rebuild (tests, custom engines). Default refreshBinding. */
  refresh?: (name: string) => Promise<unknown>;
  className?: string;
}
export function RefreshAllButton(props: RefreshAllButtonProps): React.ReactElement;
