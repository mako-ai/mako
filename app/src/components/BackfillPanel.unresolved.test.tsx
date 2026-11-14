// @vitest-environment jsdom
/**
 * A flow whose source or destination connection no longer resolves reaches
 * the app with that reference as `null`. The panel must open without the
 * name, not take the window down.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const store = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    flows: {
      ws1: [
        {
          _id: "f1",
          name: "Orphaned sync",
          dataSourceId: null,
          destinationDatabaseId: null,
        },
      ],
    },
  };
  // Every fetch the panel asks the store for answers nothing.
  return new Proxy(state, {
    get: (target, key: string) =>
      key in target ? target[key] : async () => null,
  });
});
vi.mock("../store/flowStore", () => {
  const useFlowStore = () => store;
  useFlowStore.getState = () => store;
  return { useFlowStore };
});
vi.mock("./EntityHistoryButton", () => ({ EntityHistoryButton: () => null }));

import { BackfillPanel } from "./BackfillPanel";

afterEach(() => cleanup());

describe("BackfillPanel", () => {
  it("opens a flow whose connections did not resolve", async () => {
    render(<BackfillPanel workspaceId="ws1" flowId="f1" />);
    expect(await screen.findByRole("button", { name: /Reset/ })).toBeTruthy();
    // No name to show for either side, so no "source → destination" line.
    expect(screen.queryByText("→")).toBeNull();
  });
});
