import { describe, expect, it } from "vitest";
import {
  buildLocalAcpModelId,
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
  localAcpModelPreference,
  localAcpModelsFromProviders,
  resolveLocalAcpModelValue,
  LOCAL_ACP_CLAUDE_MODEL_ID,
} from "./local-acp-models";

describe("local-acp-models", () => {
  it("detects local ACP model ids and preferences", () => {
    expect(isLocalAcpModelId(LOCAL_ACP_CLAUDE_MODEL_ID)).toBe(true);
    expect(isLocalAcpModelId("local-acp/claude/fable")).toBe(true);
    expect(isLocalAcpModelId("anthropic/claude-sonnet-4")).toBe(false);
    expect(localAcpModelIdToProviderId(LOCAL_ACP_CLAUDE_MODEL_ID)).toBe(
      "claude",
    );
    expect(localAcpModelIdToProviderId("local-acp/claude/fable")).toBe(
      "claude",
    );
    expect(localAcpModelPreference(LOCAL_ACP_CLAUDE_MODEL_ID)).toBeNull();
    expect(localAcpModelPreference("local-acp/claude/default")).toBeNull();
    expect(localAcpModelPreference("local-acp/claude/fable")).toBe("fable");
    expect(buildLocalAcpModelId("claude", "fable")).toBe(
      "local-acp/claude/fable",
    );
  });

  it("expands Claude Code into Sonnet/Opus/Fable rows when adapter found", () => {
    const offline = localAcpModelsFromProviders(null);
    expect(offline).toHaveLength(2);
    expect(offline.map(m => m.id)).toContain(LOCAL_ACP_CLAUDE_MODEL_ID);

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
      {
        id: "codex",
        label: "Codex",
        description: "y",
        authProduct: "ChatGPT",
        installHint: "npm i -g @agentclientprotocol/codex-acp",
        adapterCommand: "codex-acp",
        adapterFound: false,
        connected: false,
        authRequired: false,
        authMethods: [],
      },
    ]);
    const ids = models.map(m => m.id);
    expect(ids).toContain("local-acp/claude/claude-fable-5");
    expect(ids).toContain("local-acp/claude/claude-sonnet-4-5");
    expect(ids).toContain("local-acp/claude/claude-opus-4-6");
    expect(ids.some(id => id.startsWith("local-acp/claude"))).toBe(true);
    expect(
      models.find(m => m.id === "local-acp/claude/claude-fable-5")?.name,
    ).toMatch(/Fable/i);
    // Codex adapter missing → single placeholder row
    expect(ids.filter(id => id.startsWith("local-acp/codex"))).toEqual([
      "local-acp/codex",
    ]);
  });

  it("lists all Codex models including GPT-5.6 Sol/Terra/Luna", () => {
    const models = localAcpModelsFromProviders([
      {
        id: "claude",
        label: "Claude Code",
        description: "x",
        authProduct: "Claude",
        installHint: "hint",
        adapterCommand: "claude-agent-acp",
        adapterFound: false,
        connected: false,
        authRequired: false,
        authMethods: [],
      },
      {
        id: "codex",
        label: "Codex",
        description: "y",
        authProduct: "ChatGPT",
        installHint: "npm i -g @agentclientprotocol/codex-acp",
        adapterCommand: "codex-acp",
        adapterFound: true,
        connected: true,
        authRequired: false,
        authMethods: [],
        availableModels: [
          { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
        ],
      },
    ]);
    const ids = models.map(m => m.id);
    expect(ids).toContain("local-acp/codex/gpt-5.6-sol");
    expect(ids).toContain("local-acp/codex/gpt-5.6-terra");
    expect(ids).toContain("local-acp/codex/gpt-5.6-luna"); // fallback
    expect(ids).toContain("local-acp/codex"); // Default
  });

  it("resolves opus/sonnet aliases to canonical Claude ids", () => {
    expect(
      resolveLocalAcpModelValue("opus", [
        { value: "claude-sonnet-4-5", name: "Sonnet" },
        { value: "claude-opus-4-6", name: "Opus" },
      ]),
    ).toBe("claude-opus-4-6");
    expect(resolveLocalAcpModelValue("opus", [])).toBe("claude-opus-4-6");
  });

  it("prefers adapter-advertised model ids over short aliases", () => {
    const models = localAcpModelsFromProviders([
      {
        id: "claude",
        label: "Claude Code",
        description: "x",
        authProduct: "Claude",
        installHint: "hint",
        adapterCommand: "claude-agent-acp",
        adapterFound: true,
        connected: true,
        authRequired: false,
        authMethods: [],
        availableModels: [
          { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { value: "claude-fable-5", name: "Claude Fable 5" },
        ],
      },
    ]);
    const ids = models.map(m => m.id);
    expect(ids).toContain("local-acp/claude/claude-fable-5");
    expect(ids).not.toContain("local-acp/claude/fable");
    expect(ids).not.toContain("local-acp/claude/sonnet");
  });
});
