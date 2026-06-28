// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store module pulls in the network clients at import time. None of them
// are exercised by the agent-review ACCEPT path under test (it returns before
// any PUT), but they must resolve for the module to load.
vi.mock("../lib/api-client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putWithStatus: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../api", () => ({
  api: {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  },
  unwrapBody: (x: unknown) => x,
}));

vi.mock("../lib/local-agent-client", () => ({
  isLocalConnectionId: () => false,
  localAgentClient: {},
}));

vi.mock("../lib/realtime-client-id", () => ({
  realtimeClientId: "test-client",
}));

import {
  useConsoleStore,
  hasUnsavedLocalEdits,
  hasPendingAgentReview,
} from "./consoleStore";
import { computeConsoleStateHash } from "../utils/stateHash";
import type { ConsoleRevisionSyncEntry } from "../lib/api-types";

const WS = "workspace-1";

function openSavedConsole(id: string, content: string) {
  useConsoleStore.getState().openTab({
    id,
    title: "report.sql",
    content,
    isSaved: true,
    filePath: "report.sql",
    connectionId: "conn-1",
    databaseId: "db-1",
    databaseName: "main",
    draftRevision: 1,
    version: 1,
  });
}

function agentEntry(
  id: string,
  content: string,
  draftRevision: number,
): ConsoleRevisionSyncEntry {
  return {
    id,
    content,
    draftRevision,
    connectionId: "conn-1",
    databaseId: "db-1",
    databaseName: "main",
    isSaved: true,
    lastDraftOrigin: "agent",
  };
}

beforeEach(() => {
  useConsoleStore.getState().clearAllConsoles();
  vi.clearAllMocks();
});

describe("resolveAgentReview('accept') — explicit-save baseline", () => {
  it("keeps the Save button enabled after accepting an agent edit on a saved console", async () => {
    const id = "65b000000000000000000001";
    const baseSql = "SELECT 1;";
    const agentSql = "SELECT 2;";

    openSavedConsole(id, baseSql);
    const baselineHash = useConsoleStore.getState().tabs[id].savedStateHash;
    expect(baselineHash).toBe(
      computeConsoleStateHash(baseSql, "conn-1", "db-1", "main"),
    );
    // Clean tab at rest: nothing to save yet.
    expect(hasUnsavedLocalEdits(id)).toBe(false);

    // Agent (modify_console) edit arrives as a reviewable diff. The store
    // content stays on the baseline until the user resolves the review.
    useConsoleStore.getState().beginAgentReview(agentEntry(id, agentSql, 2));
    expect(hasPendingAgentReview(id)).toBe(true);
    expect(useConsoleStore.getState().tabs[id].content).toBe(baseSql);

    // User accepts the agent's change.
    await useConsoleStore.getState().resolveAgentReview(WS, id, "accept");

    const tab = useConsoleStore.getState().tabs[id];
    // The accepted content is adopted...
    expect(tab.content).toBe(agentSql);
    expect(tab.draftRevision).toBe(2);
    // ...but the explicit-save baseline is NOT advanced to the agent draft.
    // (Regression guard: this used to be set to hash(agentSql), which made
    // hasUnsavedChanges false → Save disabled → no way to checkpoint into
    // version history.)
    expect(tab.savedStateHash).toBe(baselineHash);
    expect(tab.savedStateHash).not.toBe(
      computeConsoleStateHash(agentSql, "conn-1", "db-1", "main"),
    );
    // Net effect the Save button reads: there ARE unsaved changes to checkpoint.
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("clears the pending review on accept", async () => {
    const id = "65b000000000000000000002";
    openSavedConsole(id, "SELECT 1;");
    useConsoleStore.getState().beginAgentReview(agentEntry(id, "SELECT 2;", 2));
    expect(hasPendingAgentReview(id)).toBe(true);

    await useConsoleStore.getState().resolveAgentReview(WS, id, "accept");
    expect(hasPendingAgentReview(id)).toBe(false);
  });
});
