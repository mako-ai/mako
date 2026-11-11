// @vitest-environment jsdom
/**
 * "Rename…" on a flow hands the dialog the flow (by id) and the file names
 * the other flows in the list hold, so a taken one is refused as it is
 * typed; a renamed flow's open tab gets its new title and the list refetches.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.hoisted(() => vi.fn());
const updateTitle = vi.hoisted(() => vi.fn());
const dialog = vi.hoisted(() => ({
  target: null as unknown,
  onRenamed: null as null | ((result: unknown) => void),
}));
const flows = vi.hoisted(() => [
  { _id: "f1", name: "Close", slug: "close" },
  { _id: "f2", name: "Stripe", slug: "stripe" },
  { _id: "f3", name: "Only in git", slug: null },
]);
vi.mock("../store/flowStore", () => ({
  useFlowStore: () => ({
    flows: { ws1: flows },
    loading: {},
    error: {},
    init: vi.fn(),
    refresh,
    selectFlow: vi.fn(),
    clearError: vi.fn(),
  }),
}));
vi.mock("../store/consoleStore", () => {
  const store = {
    tabs: {
      t1: { kind: "flow-editor", metadata: { flowId: "f1" } },
      t2: { kind: "flow-editor", metadata: { flowId: "f2" } },
    },
    activeTabId: null,
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    loadConsole: vi.fn(),
    updateTitle,
  };
  const useConsoleStore = () => store;
  useConsoleStore.getState = () => store;
  return { useConsoleStore };
});
vi.mock("../store/explorerRevealStore", () => ({
  useExplorerRevealStore: () => null,
  selectRevealFor: () => () => null,
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws1" } }),
}));
vi.mock("../lib/api-client", () => ({
  apiClient: { get: vi.fn(async () => ({ scheduledQueries: [] })) },
}));
// The tree, reduced to each row's own menu items.
vi.mock("./ResourceTree", async () => {
  const { MenuList } = await import("@mui/material");
  return {
    default: (props: {
      sections: Array<{ nodes: Array<{ id: string; name: string }> }>;
      getContextMenuItems: (
        node: unknown,
        helpers: { closeMenu: () => void },
      ) => ReactNode;
    }) =>
      props.sections.flatMap(section =>
        section.nodes.map(node => (
          <MenuList key={node.id} aria-label={node.name}>
            {props.getContextMenuItems(node, { closeMenu: () => undefined })}
          </MenuList>
        )),
      ),
  };
});
vi.mock("./RenameObjectDialog", () => ({
  RenameObjectDialog: (props: {
    target: unknown;
    onRenamed: (result: unknown) => void;
  }) => {
    Object.assign(dialog, props);
    return null;
  },
}));

import { FlowsExplorer } from "./FlowsExplorer";

afterEach(() => cleanup());

describe("Rename… in the flows explorer", () => {
  it("names the flow by id, with the other flows' file names; then retitles its tab and refetches", () => {
    render(<FlowsExplorer />);
    fireEvent.click(
      screen.getByLabelText("Close").querySelector("li") as HTMLElement,
    );
    expect(dialog.target).toEqual({
      kind: "flow",
      ref: "f1",
      title: "Close",
      slug: "close",
      others: [
        { slug: "stripe", title: "Stripe" },
        { slug: null, title: "Only in git" },
      ],
    });
    dialog.onRenamed?.({ id: "f1", after: { title: "Close CRM" } });
    expect(updateTitle.mock.calls).toEqual([["t1", "Close CRM"]]);
    expect(refresh).toHaveBeenCalledWith("ws1");
  });
});
