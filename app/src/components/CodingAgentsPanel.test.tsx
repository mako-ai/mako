// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CodingAgentsPanel } from "./CodingAgentsPanel";

vi.mock("../store/localAgentStore", () => {
  const state = {
    status: "online" as const,
    checkAgent: vi.fn(async () => "online" as const),
  };
  return {
    useLocalAgentStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock("../store/acpStore", () => {
  const status = {
    available: true as const,
    defaultCwd: "/tmp",
    providers: [
      {
        id: "claude" as const,
        label: "Claude Code",
        description: "test",
        authProduct: "Claude",
        installHint: "install",
        adapterCommand: "claude-agent-acp",
        adapterFound: true,
        connected: false,
        authRequired: false,
        authMethods: [],
      },
    ],
    acpBridge: {
      version: 7,
      adapterEnsure: true,
      modelWarm: true,
    },
  };
  const state = {
    status,
    statusError: null,
    loadingStatus: false,
    sessions: [],
    activeSessionId: null,
    messagesBySession: {},
    permissionsBySession: {},
    sending: false,
    error: null,
    authGuidance: null,
    selectedProviderId: "claude" as const,
    cwdDraft: "/tmp",
    refreshStatus: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    setSelectedProvider: vi.fn(),
    setCwdDraft: vi.fn(),
    setActiveSession: vi.fn(),
    createSession: vi.fn(),
    forgetSession: vi.fn(),
    authenticate: vi.fn(),
    sendPrompt: vi.fn(),
    cancelActive: vi.fn(),
    closeActive: vi.fn(),
    respondPermission: vi.fn(),
    ensureEventSubscription: vi.fn(),
  };
  return {
    useAcpStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

describe("CodingAgentsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders setup guidance without a parallel session chat UI", async () => {
    render(<CodingAgentsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/main Chat/i)).toBeTruthy();
    });
    expect(screen.getByText("Local setup")).toBeTruthy();
    expect(screen.getByText(/Available in Chat/i)).toBeTruthy();
    expect(screen.queryByText("Start session")).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(
      screen.queryByPlaceholderText(/Message the coding agent/i),
    ).toBeNull();
  });
});
