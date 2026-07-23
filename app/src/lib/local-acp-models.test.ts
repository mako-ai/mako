import { describe, expect, it } from "vitest";
import {
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
  localAcpModelsFromProviders,
  LOCAL_ACP_CLAUDE_MODEL_ID,
} from "./local-acp-models";

describe("local-acp-models", () => {
  it("detects local ACP model ids", () => {
    expect(isLocalAcpModelId(LOCAL_ACP_CLAUDE_MODEL_ID)).toBe(true);
    expect(isLocalAcpModelId("anthropic/claude-sonnet-4")).toBe(false);
    expect(localAcpModelIdToProviderId(LOCAL_ACP_CLAUDE_MODEL_ID)).toBe(
      "claude",
    );
  });

  it("always lists Claude Code + Codex, enriching from status", () => {
    const offline = localAcpModelsFromProviders(null);
    expect(offline).toHaveLength(2);
    expect(offline.map(m => m.id)).toContain(LOCAL_ACP_CLAUDE_MODEL_ID);
    expect(offline[0].description).toMatch(/start Local Agent/i);

    const models = localAcpModelsFromProviders([
      {
        id: "claude",
        label: "Claude Code",
        description: "x",
        authProduct: "Claude",
        installHint: "npm i -g @agentclientprotocol/claude-agent-acp",
        adapterCommand: "claude-agent-acp",
        adapterFound: true,
        connected: true,
        authRequired: false,
        authMethods: [],
      },
    ]);
    expect(models).toHaveLength(2);
    const claude = models.find(m => m.id === LOCAL_ACP_CLAUDE_MODEL_ID);
    expect(claude?.provider).toBe("local");
    expect(claude?.description).not.toMatch(/adapter missing/i);
  });
});
