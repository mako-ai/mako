// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchCdcStatus = vi.fn();
vi.mock("../store/flowStore", () => ({
  useFlowStore: (select: (s: unknown) => unknown) => select({ fetchCdcStatus }),
}));

import { SyncStatusLine } from "./SyncStatusLine";

describe("SyncStatusLine", () => {
  afterEach(() => {
    cleanup();
    fetchCdcStatus.mockReset();
  });

  it("says one part per trigger that is on", async () => {
    const minutesAgo = (m: number) =>
      new Date(Date.now() - m * 60000).toISOString();
    fetchCdcStatus.mockResolvedValue({ lastMaterializedAt: minutesAgo(2) });
    render(
      <SyncStatusLine
        workspaceId="w"
        flowId="f"
        poll
        webhook
        resync
        lastPollAt={minutesAgo(12)}
        lastResyncAt={null}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("sync-status-line").textContent).toBe(
        "Webhooks: last change 2 min ago · Polled 12 min ago · Resynced never",
      ),
    );
  });

  it("leaves out triggers that are off and does not ask for CDC status without webhooks", () => {
    render(
      <SyncStatusLine
        workspaceId="w"
        flowId="f"
        poll
        webhook={false}
        resync={false}
        lastPollAt={null}
      />,
    );
    expect(screen.getByTestId("sync-status-line").textContent).toBe(
      "Polled never",
    );
    expect(fetchCdcStatus).not.toHaveBeenCalled();
  });

  it("renders nothing when no trigger is on", () => {
    const { container } = render(
      <SyncStatusLine
        workspaceId="w"
        flowId="f"
        poll={false}
        webhook={false}
        resync={false}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
