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
    selectedProviderId: "claude" as const,
    cwdDraft: "/tmp",
    refreshStatus: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    setSelectedProvider: vi.fn(),
    setCwdDraft: vi.fn(),
    setActiveSession: vi.fn(),
    createSession: vi.fn(),
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

  it("renders without hitting max update depth", async () => {
    render(<CodingAgentsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Tokens bill to your Claude/i)).toBeTruthy();
    });
    expect(screen.getByText("New session")).toBeTruthy();
    expect(screen.getByText(/Start a session to chat/i)).toBeTruthy();
  });
});
