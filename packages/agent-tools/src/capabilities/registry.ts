/**
 * Combined agent capability registry across every migrated domain.
 *
 * Domains not yet migrated (flows, charts, skills, web, and the browser-only
 * dashboard tools) keep their existing hand-maintained policy in mode
 * registry / bridge policy / read-only sets until they get a registry of
 * their own.
 */
import { APP_CAPABILITIES } from "./app-capabilities";
import { CONNECTOR_CAPABILITIES } from "./connector-capabilities";
import { CONSOLE_CAPABILITIES } from "./console-capabilities";
import { DASHBOARD_CAPABILITIES } from "./dashboard-capabilities";
import { DBT_CAPABILITIES } from "./dbt-capabilities";
import { NOTEBOOK_CAPABILITIES } from "./notebook-capabilities";
import { QUERY_CAPABILITIES } from "./query-capabilities";
import type { AgentCapabilityDefinition, AgentSurface } from "./types";

export const AGENT_CAPABILITIES: readonly AgentCapabilityDefinition[] = [
  ...DBT_CAPABILITIES,
  ...APP_CAPABILITIES,
  ...CONSOLE_CAPABILITIES,
  ...DASHBOARD_CAPABILITIES,
  ...QUERY_CAPABILITIES,
  ...NOTEBOOK_CAPABILITIES,
  ...CONNECTOR_CAPABILITIES,
];

export const AGENT_CAPABILITY_BY_NAME: ReadonlyMap<
  string,
  AgentCapabilityDefinition
> = new Map(AGENT_CAPABILITIES.map(capability => [capability.name, capability]));

export function agentCapabilitiesForSurface(
  surface: AgentSurface,
): readonly AgentCapabilityDefinition[] {
  return AGENT_CAPABILITIES.filter(capability =>
    capability.surfaces.includes(surface),
  );
}
