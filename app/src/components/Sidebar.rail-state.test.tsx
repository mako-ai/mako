// @vitest-environment jsdom
/**
 * The rail answers two questions and must not conflate them.
 *
 * Reported: the address bar said /apps/ubiflow and an app tab was open, but
 * the rail highlighted Settings — read as "Settings is the active app".
 *
 * The divergence itself is CORRECT and deliberate: the open explorer is a
 * panel you are browsing, not the thing you are looking at. Browsing the
 * Databases tree while editing a console is a real workflow, and a reload
 * restores the panel you had rather than the one the URL implies (UrlSync's
 * isReload note — an earlier attempt at "the URL wins on reload" would have
 * reintroduced the bug that comment documents, reloading with an app tab open
 * bouncing you off Source Control).
 *
 * So the fix is signalling, not behaviour: the rail marks BOTH the open panel
 * and the explorer that holds the open tab. This pins that they are reported
 * independently, which is the property the single-highlight version lacked.
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

const state = (el: HTMLElement | null) => ({
  openExplorer: el?.getAttribute("data-open-explorer"),
  ownsActiveTab: el?.getAttribute("data-owns-active-tab"),
});

describe("sidebar rail: open panel vs the explorer holding the open tab", () => {
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

  it("marks Apps as holding the open tab while Settings is the open panel", () => {
    const { container } = render(<Sidebar />);

    // Settings: the panel on screen, but NOT what the user is looking at.
    expect(state(rail(container, "settings"))).toEqual({
      openExplorer: "true",
      ownsActiveTab: "false",
    });

    // Apps: not the open panel, but it holds the open tab. Without this the
    // rail said only "Settings", which is what read as "the active app".
    expect(state(rail(container, "apps"))).toEqual({
      openExplorer: "false",
      ownsActiveTab: "true",
    });
  });

  it("reports both on one item when the panel and the open tab agree", () => {
    useUIStore.setState({ leftPane: "apps", leftPaneOpen: true });
    const { container } = render(<Sidebar />);

    expect(state(rail(container, "apps"))).toEqual({
      openExplorer: "true",
      ownsActiveTab: "true",
    });
  });

  it("marks nothing when the open tab has no sidebar home", () => {
    // Settings and plan tabs deliberately map to no explorer, so nothing
    // should claim to hold them.
    useConsoleStore.setState({
      activeTabId: "t2",
      tabs: {
        t2: {
          id: "t2",
          kind: "settings",
          title: "Members",
          content: "",
          settingsSection: "members",
        },
      } as never,
    });
    const { container } = render(<Sidebar />);

    const marked = container.querySelectorAll(
      '[data-owns-active-tab="true"]',
    ).length;
    expect(marked).toBe(0);
    // The open panel is still reported — collapsing that would be the
    // opposite bug.
    expect(state(rail(container, "settings")).openExplorer).toBe("true");
  });

  it("clears the open-panel mark when the pane is collapsed", () => {
    useUIStore.setState({ leftPane: "settings", leftPaneOpen: false });
    const { container } = render(<Sidebar />);

    expect(state(rail(container, "settings")).openExplorer).toBe("false");
    // …but the app tab is still open, so the rail still says where it lives.
    expect(state(rail(container, "apps")).ownsActiveTab).toBe("true");
  });
});

/**
 * Reported by Joan: a console tab open, Flows in the explorer, and the rail lit
 * Consoles in blue. The blue highlight must name the panel on screen; the
 * explorer holding the tab gets only a quieter hint.
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

  it("highlights exactly the explorer on screen while a console tab is focused", () => {
    const { container } = render(<Sidebar />);

    expect(highlighted(container)).toEqual(["flows"]);
    expect(state(rail(container, "consoles"))).toEqual({
      openExplorer: "false",
      ownsActiveTab: "true",
    });

    // And it is the rendered colour, not just the data hook: the brand colour
    // (what reads as "highlighted in blue") is on Flows, not on Consoles.
    const brand = normalizeColor(createTheme().palette.primary.main);
    const color = (view: string) => {
      const el = rail(container, view);
      if (!el) throw new Error(`${view} rail button missing`);
      return getComputedStyle(el).color;
    };
    expect(color("flows")).toBe(brand);
    expect(color("consoles")).not.toBe(brand);
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
    expect(state(rail(container, "flows")).openExplorer).toBe("false");
    expect(state(rail(container, "consoles")).ownsActiveTab).toBe("true");
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

    it(`gives the brand colour only to the open explorer (${mode})`, () => {
      const open = railButtonColors(theme, { isActive: true });
      const holdsTab = railButtonColors(theme, { ownsActiveTab: true });
      const idle = railButtonColors(theme, {});

      expect(open.color).toBe(theme.palette.primary.main);
      expect(open.backgroundColor).toBe(theme.palette.action.selected);

      // The tab-owner hint must never look like the highlight.
      expect(holdsTab.color).not.toBe(theme.palette.primary.main);
      expect(holdsTab.backgroundColor).toBe("transparent");
      expect(holdsTab.color).not.toBe(idle.color);
    });

    it(`an explorer that is open AND holds the tab is plainly highlighted (${mode})`, () => {
      expect(
        railButtonColors(theme, { isActive: true, ownsActiveTab: true }),
      ).toEqual(railButtonColors(theme, { isActive: true }));
    });
  }
});
