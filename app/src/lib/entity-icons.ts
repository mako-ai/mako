/**
 * Entity icons — single source of truth.
 *
 * Every surface that renders an icon for an explorer section, a tab kind,
 * or a settings section MUST import it from here instead of picking a
 * lucide icon ad hoc. Consumers: Sidebar rail, Editor tab bar, command
 * palette, SettingsExplorer. Both maps are exhaustive over their key
 * unions (`satisfies Record<...>`), so adding a `LeftPaneView` or
 * `TabKind` without deciding its icon is a compile error — the same
 * regression guard pattern as `tab-routing.ts`.
 *
 * Special cases that stay with their owners (they depend on runtime
 * state, not the kind): connector/connection favicon images (`tab.icon`,
 * `connectionIconUrl`) and flow-editor subtype icons (webhook/paused/
 * scheduled) in Editor.tsx and FlowsExplorer.
 */

import {
  AppWindowMac,
  ArrowLeftRight,
  BookOpen,
  Bot,
  BrainCircuit,
  CalendarClock,
  ChartPie,
  ClipboardList,
  CloudUpload,
  Database,
  FileCode,
  GitBranch,
  Github,
  Server,
  History,
  KeySquare,
  MessageCircleMore,
  MessageSquareText,
  Notebook,
  Palette,
  Plug,
  Gauge,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareChevronRight,
  SquareTerminal,
  Table,
  Terminal,
  Users,
  Wallet,
  GitCompare,
  type LucideIcon,
} from "lucide-react";
import DbtIcon from "../components/icons/DbtIcon";
import type {
  LeftPaneView,
  SettingsSection,
  TabKind,
} from "../store/lib/types";

/** Sidebar rail / "Go to ..." icons, one per explorer section. */
export const EXPLORER_ICONS = {
  databases: Database,
  consoles: SquareChevronRight,
  flows: ArrowLeftRight,
  // The dbt mark itself (the extension's activity-bar icon), not a generic
  // git glyph — GitBranch now belongs to Source Control, where it means what
  // it says.
  dbt: DbtIcon,
  "source-control": GitBranch,
  connectors: Plug,
  dashboards: ChartPie,
  apps: AppWindowMac,
  notebooks: Notebook,
  settings: Settings,
} as const satisfies Record<LeftPaneView, LucideIcon>;

/** Chat pane icon (sidebar rail + palette command). */
export const CHAT_ICON: LucideIcon = MessageCircleMore;

/**
 * Icon per tab kind, as rendered in the Editor tab bar. Entity rows in
 * explorers and palette results use the same map so a dashboard looks the
 * same everywhere it appears.
 */
export const TAB_KIND_ICONS = {
  console: SquareTerminal,
  settings: Settings,
  connectors: CloudUpload,
  members: Users,
  "flow-editor": ArrowLeftRight,
  dashboard: ChartPie,
  "dashboard-data-source": Database,
  "table-data": Table,
  app: AppWindowMac,
  "app-file": FileCode,
  "app-diff": GitCompare,
  "console-diff": GitCompare,
  plan: ClipboardList,
  "dbt-file": FileCode,
  "dbt-job": CalendarClock,
  "dbt-console": Terminal,
  "dbt-runs": History,
  notebook: Notebook,
} as const satisfies Record<NonNullable<TabKind>, LucideIcon>;

export function tabKindIcon(kind: TabKind | undefined): LucideIcon {
  return TAB_KIND_ICONS[kind ?? "console"];
}

/** Settings explorer / settings command icons, one per section. */
export const SETTINGS_SECTION_ICONS = {
  prompt: MessageSquareText,
  skills: BookOpen,
  mcp: Plug,
  agents: Bot,
  "coding-agents": BrainCircuit,
  models: Sparkles,
  limits: Gauge,
  billing: Wallet,
  members: Users,
  "api-keys": KeySquare,
  appearance: Palette,
  github: Github,
  sandbox: Server,
  admin: ShieldCheck,
} as const satisfies Record<SettingsSection, LucideIcon>;
