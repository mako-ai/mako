// Agent type definitions

import type { Tool } from "@openai/agents";

export type DatabaseAgentKind = "mongo" | "bigquery" | "postgres" | "sqlite";

export type AgentKind = DatabaseAgentKind | "triage";

export interface AgentConfig {
  workspaceId: string;
  consoles?: any[];
  preferredConsoleId?: string;
}

export type AgentBuilder = (config: AgentConfig) => any;

export type AgentToolFactory = (config: AgentConfig) => Tool[];

export interface AgentMetadata {
  name: string;
  handoffDescription?: string;
  kind: AgentKind;
}

export interface AgentHandoffConfig {
  toolName: string;
  description: string;
}

export interface AgentRegistration {
  kind: DatabaseAgentKind;
  buildAgent: AgentBuilder;
  createTools?: AgentToolFactory;
  metadata: AgentMetadata;
  handoff?: AgentHandoffConfig;
  discoveryToolNames?: string[];
}

export interface AgentError {
  code: string;
  message: string;
  details?: any;
}
