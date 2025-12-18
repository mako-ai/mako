import type { AgentKind, ConsoleDataV2 } from "../agent-v2";

interface SelectionContext {
  sessionActiveAgent?: AgentKind;
  userMessage: string;
  consoles?: ConsoleDataV2[];
  workspaceHasBigQuery?: boolean;
  workspaceHasMongoDB?: boolean;
  workspaceHasPostgres?: boolean;
}

/**
 * Agent selection based on session state
 * First message always goes to triage, subsequent messages use pinned agent
 */
export const selectInitialAgent = (context: SelectionContext): AgentKind => {
  // If session already has a pinned agent, use it
  if (context.sessionActiveAgent) {
    return context.sessionActiveAgent;
  }

  // First message in a session always goes to triage
  // The triage agent will analyze the request and handoff to the appropriate specialist
  return "triage";
};

// Pattern matching functions removed - triage agent handles all routing decisions

/**
 * Analyze confidence level of the selection
 * Useful for logging and debugging
 */
export const getSelectionConfidence = (
  context: SelectionContext,
  selectedAgent: AgentKind,
): {
  agent: AgentKind;
  confidence: "high" | "medium" | "low";
  reason: string;
} => {
  // High confidence when using pinned agent
  if (context.sessionActiveAgent === selectedAgent) {
    return {
      agent: selectedAgent,
      confidence: "high",
      reason: "Using pinned session agent",
    };
  }

  // High confidence for triage on first message
  return {
    agent: selectedAgent,
    confidence: "high",
    reason: "First message - routing to triage for analysis",
  };
};
