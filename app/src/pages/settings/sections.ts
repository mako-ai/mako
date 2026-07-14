import type { SettingsSection } from "../../store/lib/types";

/**
 * Display metadata for each settings sub-section.
 *
 * The keys of this record are the canonical list of settings sections. The
 * SettingsExplorer renders the items in the order declared here.
 */
export const SECTION_LABELS: Record<SettingsSection, string> = {
  prompt: "Custom Prompt",
  skills: "Skills",
  mcp: "MCP Servers",
  agents: "Connect Agents",
  "coding-agents": "Coding Agents",
  models: "AI Models",
  limits: "Limits",
  billing: "Billing",
  members: "Members",
  "api-keys": "API Keys",
  appearance: "Appearance",
  github: "GitHub",
  admin: "Super Admin",
};

/**
 * Default ordering for the settings explorer list (and the "/settings"
 * landing tab).
 */
export const SECTION_ORDER: SettingsSection[] = [
  "prompt",
  "skills",
  "mcp",
  "agents",
  "coding-agents",
  "models",
  "limits",
  "billing",
  "members",
  "api-keys",
  "appearance",
  "github",
  "admin",
];

export function isSettingsSection(value: string): value is SettingsSection {
  return value in SECTION_LABELS;
}
