// @vitest-environment jsdom
/**
 * The rail marks exactly one thing: the explorer panel on screen.
 *
 * Reported twice from opposite ends. First, an app tab open with the Settings
 * panel showing read as "Settings is the active app", so the explorer holding
 * the open tab got a hint. Then that hint — a full-contrast icon with no
 * background — made Apps look permanently selected next to its grey
 * neighbours, whatever the explorer showed. The tab owner is now not marked
 * at all; these tests pin that it renders exactly like an idle button.
 *
 * The divergence between panel and tab is itself deliberate: browsing the
 * Databases tree while editing a console is a real workflow, and a reload
 * restores the panel you had rather than the one the URL implies (UrlSync's
 * isReload note).
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createTheme } from "@mui/material";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
  resetIdentity: vi.fn(),
}));
vi.mock("../contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", email: "a@b.c" }, logout: vi.fn() }),
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: "ws1", name: "W" },
    workspaces: [],
    switchWorkspace: vi.fn(),
  }),
}));

import Sidebar from "./Sidebar";
import { useUIStore } from "../store/uiStore";
import { useConsoleStore } from "../store/consoleStore";
import { railButtonColors } from "./sidebar-rail";

/** The rail button for a view, by its stable data-view hook. */
const rail = (container: HTMLElement, view: string) =>
  container.querySelector<HTMLElement>(`[data-view="${view}"]`);

const style = (container: HTMLElement, view: string) => {
  const el = rail(container, view);
  if (!el) throw new Error(`${view} rail button missing`);
  const { color, backgroundColor } = getComputedStyle(el);
  return { color, backgroundColor };
};

describe("sidebar rail: no hint for the explorer holding the open tab", () => {
  beforeEach(() => {
    // The reported situation: Settings panel open, an APP tab in the editor.
    useUIStore.setState({ leftPane: "settings", leftPaneOpen: true });
    useConsoleStore.setState({
      activeTabId: "t1",
      tabs: {
        t1: {
          id: "t1",
          kind: "app",
          title: "Ubiflow",
          content: "",
          metadata: { appId: "app1" },
        },
      } as never,
    });
  });
  afterEach(cleanup);

  it("renders Apps like any idle button while an app tab is open", () => {
    const { container } = render(<Sidebar />);

    expect(
      rail(container, "settings")?.getAttribute("data-open-explorer"),
    ).toBe("true");
    expect(rail(container, "apps")?.getAttribute("data-open-explorer")).toBe(
      "false",
    );
    expect(style(container, "apps")).toEqual(style(container, "consoles"));
  });

  it("clears every mark when the pane is collapsed, app tab or not", () => {
    useUIStore.setState({ leftPane: "settings", leftPaneOpen: false });
    const { container } = render(<Sidebar />);

    expect(
      container.querySelectorAll('[data-open-explorer="true"]').length,
    ).toBe(0);
    expect(style(container, "apps")).toEqual(style(container, "settings"));
  });
});

/**
 * Reported by Joan: a console tab open, Flows in the explorer, and the rail lit
 * Consoles in blue. The highlight must name the panel on screen, and the rail
 * carries no brand colour ("no blue effect at all").
 */
describe("sidebar rail: the highlight follows the explorer, not the tab", () => {
  const consoleTab = {
    t1: {
      id: "t1",
      kind: "console",
      title: "Revenue",
      content: "",
      metadata: {},
    },
  } as never;

  beforeEach(() => {
    useUIStore.setState({ leftPane: "flows", leftPaneOpen: true });
    useConsoleStore.setState({ activeTabId: "t1", tabs: consoleTab });
  });
  afterEach(cleanup);

  /** Let the DOM normalise a theme colour (hex → rgb) for comparison. */
  const normalizeColor = (value: string) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.appendChild(probe);
    const normalized = getComputedStyle(probe).color;
    probe.remove();
    return normalized;
  };

  const highlighted = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-open-explorer="true"]')].map(el =>
      el.getAttribute("data-view"),
    );

  const current = (container: HTMLElement) =>
    [...container.querySelectorAll('[aria-current="true"]')].map(el =>
      el.getAttribute("data-view"),
    );

  it("highlights exactly the explorer on screen while a console tab is focused", () => {
    const { container } = render(<Sidebar />);

    expect(highlighted(container)).toEqual(["flows"]);
    expect(current(container)).toEqual(["flows"]);

    // The rendered styles, not just the data hooks: the selected background
    // sits on Flows, and no rail button is tinted with the brand colour —
    // the tab owner (Consoles) least of all.
    const theme = createTheme();
    const selectedBg = normalizeColor(theme.palette.action.selected);
    expect(style(container, "flows").backgroundColor).toBe(selectedBg);
    expect(style(container, "consoles")).toEqual(style(container, "dbt"));

    const brand = normalizeColor(theme.palette.primary.main);
    const tinted = [...container.querySelectorAll("[data-view]")].filter(
      el => getComputedStyle(el).color === brand,
    );
    expect(tinted).toEqual([]);
  });

  it("moves the highlight when switching sections, the tab staying focused", () => {
    const { container } = render(<Sidebar />);

    const dbt = rail(container, "dbt");
    if (!dbt) throw new Error("dbt rail button missing");
    act(() => {
      fireEvent.click(dbt);
    });

    expect(useConsoleStore.getState().activeTabId).toBe("t1");
    expect(highlighted(container)).toEqual(["dbt"]);
    expect(current(container)).toEqual(["dbt"]);
    expect(rail(container, "flows")?.getAttribute("data-open-explorer")).toBe(
      "false",
    );
  });

  it("follows an explorer switch made elsewhere (e.g. opening an entity)", () => {
    const { container } = render(<Sidebar />);

    act(() => {
      useUIStore.getState().setLeftPane("consoles");
    });

    expect(highlighted(container)).toEqual(["consoles"]);
  });
});

describe("railButtonColors", () => {
  for (const mode of ["light", "dark"] as const) {
    const theme = createTheme({ palette: { mode } });
    const open = railButtonColors(theme, { isActive: true });
    const idle = railButtonColors(theme, {});

    it(`uses no brand colour in any state, hover and focus included (${mode})`, () => {
      const brand = [
        theme.palette.primary.main,
        theme.palette.primary.light,
        theme.palette.primary.dark,
      ];
      for (const colors of [open, idle]) {
        for (const value of Object.values(colors)) {
          expect(brand).not.toContain(value);
        }
      }
    });

    it(`marks the open explorer with the neutral selected state (${mode})`, () => {
      expect(open.color).toBe(theme.palette.text.primary);
      expect(open.backgroundColor).toBe(theme.palette.action.selected);
    });

    it(`leaves every other button muted, with no background (${mode})`, () => {
      expect(idle.color).toBe(theme.palette.text.secondary);
      expect(idle.backgroundColor).toBe("transparent");
    });
  }
});
