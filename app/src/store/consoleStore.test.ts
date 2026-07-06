// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ConsoleRevisionSyncEntry } from "../lib/api-types";
import { computeConsoleStateHash } from "../utils/stateHash";
import {
  hasPendingAgentReview,
  hasUnsavedLocalEdits,
  useConsoleStore,
} from "./consoleStore";

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
    // The accepted content is adopted as the working draft...
    expect(tab.content).toBe(agentContent);
    expect(tab.draftRevision).toBe(2);
    // ...but the explicit-save baseline is NOT advanced to the agent draft.
    // (Regression guard: this used to be set to hash(agentContent), which made
    // hasUnsavedChanges false → Save disabled → no way to checkpoint into
    // version history.)
    expect(tab.savedStateHash).toBe(savedStateHash);
    expect(computeConsoleStateHash(tab.content)).not.toBe(savedStateHash);
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("clears the pending agent review on accept", async () => {
    const id = "agent-accept-clears-review";
    const savedStateHash = computeConsoleStateHash("select 1;");
    openSavedConsole({ id, content: "select 1;", savedStateHash });

    useConsoleStore
      .getState()
      .beginAgentReview(agentEntry(id, "select 2;", { savedStateHash }));
    expect(hasPendingAgentReview(id)).toBe(true);

    await useConsoleStore
      .getState()
      .resolveAgentReview("workspace", id, "accept");
    expect(hasPendingAgentReview(id)).toBe(false);
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
    // Reload / re-open: the server returns the LAST EXPLICIT-SAVE hash, not the
    // mutable draft. An agent draft sitting on top of it must read dirty.
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

  it("does not synthesize a saved baseline for server-loaded legacy agent drafts", () => {
    const id = "agent-server-open-console";
    useConsoleStore.getState().openTab(
      {
        id,
        title: "Legacy agent draft",
        content: "select 2;",
        isSaved: true,
        filePath: "Legacy agent draft",
        draftRevision: 2,
        version: 1,
        kind: "console",
      },
      { preserveMissingSavedStateHash: true },
    );

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.savedStateHash).toBeUndefined();
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });
});
