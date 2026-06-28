// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ConsoleRevisionSyncEntry } from "../lib/api-types";
import { computeConsoleStateHash } from "../utils/stateHash";
import { hasUnsavedLocalEdits, useConsoleStore } from "./consoleStore";

function resetConsoleStore(): void {
  useConsoleStore.setState({
    tabs: {},
    tabOrder: [],
    activeTabId: null,
    loading: {},
    error: {},
  });
  localStorage.clear();
}

function openSavedConsole(params: {
  id: string;
  content: string;
  savedStateHash?: string;
  draftRevision?: number;
  version?: number;
}): void {
  useConsoleStore.getState().openTab({
    id: params.id,
    title: "Saved console",
    content: params.content,
    isSaved: true,
    filePath: "Saved console",
    savedStateHash: params.savedStateHash,
    draftRevision: params.draftRevision ?? 1,
    version: params.version ?? 1,
    kind: "console",
  });
}

function agentEntry(
  id: string,
  content: string,
  overrides: Partial<ConsoleRevisionSyncEntry> = {},
): ConsoleRevisionSyncEntry {
  return {
    id,
    content,
    draftRevision: 2,
    isSaved: true,
    version: 1,
    lastDraftOrigin: "agent",
    ...overrides,
  };
}

describe("consoleStore saved baseline reconciliation", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  it("keeps Save enabled after accepting an agent draft for a saved console", async () => {
    const id = "agent-accept-console";
    const baseContent = "select 1;";
    const agentContent = "select 2;";
    const savedStateHash = computeConsoleStateHash(baseContent);
    openSavedConsole({ id, content: baseContent, savedStateHash });

    useConsoleStore
      .getState()
      .beginAgentReview(agentEntry(id, agentContent, { savedStateHash }));
    await useConsoleStore
      .getState()
      .resolveAgentReview("workspace", id, "accept");

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.content).toBe(agentContent);
    expect(tab.draftRevision).toBe(2);
    expect(tab.savedStateHash).toBe(savedStateHash);
    expect(computeConsoleStateHash(tab.content)).not.toBe(savedStateHash);
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("does not advance the saved baseline on a same-content agent sync echo", () => {
    const id = "agent-echo-console";
    const savedContent = "select 1;";
    const agentContent = "select 2;";
    const savedStateHash = computeConsoleStateHash(savedContent);
    openSavedConsole({ id, content: agentContent, savedStateHash });

    useConsoleStore.getState().beginAgentReview(agentEntry(id, agentContent));

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.draftRevision).toBe(2);
    expect(tab.savedStateHash).toBe(savedStateHash);
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("keeps legacy agent drafts dirty when no saved baseline hash exists", () => {
    const id = "agent-legacy-console";
    const agentContent = "select 2;";
    openSavedConsole({
      id,
      content: agentContent,
    });
    useConsoleStore.getState().updateSavedState(id, true, undefined);

    useConsoleStore.getState().beginAgentReview(agentEntry(id, agentContent));

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.draftRevision).toBe(2);
    expect(tab.savedStateHash).toBeUndefined();
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("preserves a server-provided saved baseline when opening a saved console", () => {
    const id = "agent-reload-console";
    const savedContent = "select 1;";
    const agentDraftContent = "select 2;";
    const savedStateHash = computeConsoleStateHash(savedContent);

    openSavedConsole({ id, content: agentDraftContent, savedStateHash });

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.savedStateHash).toBe(savedStateHash);
    expect(computeConsoleStateHash(tab.content)).not.toBe(savedStateHash);
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });
});
