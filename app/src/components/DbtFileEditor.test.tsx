// @vitest-environment jsdom
import type React from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Monaco can't render in jsdom — stub the editor to a plain node.
vi.mock("@monaco-editor/react", () => ({ default: () => null }));
// Avoid pulling the (Monaco-bound) language registration.
vi.mock("../lib/dbt-monaco", () => ({
  DBT_JINJA_LANGUAGE_ID: "jinja-sql",
  registerDbtJinjaLanguage: vi.fn(),
  registerDbtCompletions: vi.fn(),
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws1" } }),
}));
vi.mock("../contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));
vi.mock("../dbt-runtime/shell", () => ({ focusDbtFileTab: vi.fn() }));
// Streamdown pulls heavy ESM (shiki) that jsdom can't load — render children raw.
vi.mock("./StreamingMarkdown", () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown-preview">{children}</div>
  ),
}));
// EntityBreadcrumbs returns null without a matching console tab; surface its
// `trailing` slot so the markdown Preview switch is testable in isolation.
vi.mock("./EntityBreadcrumbs", () => ({
  default: ({ trailing }: { trailing?: React.ReactNode }) => (
    <div data-testid="breadcrumbs">{trailing}</div>
  ),
}));
// The real results grid pulls MUI DataGrid's stylesheet, which the jsdom
// runner can't load. Assert on the rows handed to it instead.
vi.mock("./ResultsTable", () => ({
  default: ({ results }: { results: { results: unknown[] } }) => (
    <div data-testid="results-grid">{JSON.stringify(results.results)}</div>
  ),
}));

import DbtFileEditor from "./DbtFileEditor";
import { useDbtStore } from "../store/dbtStore";

const runCommandMock = vi.fn(async () => ({
  ok: true,
  exitCode: 0,
  subcommand: "build",
  stepResults: [],
  logs: [],
}));
const compileModelMock = vi.fn(async () => ({
  ok: true,
  exitCode: 0,
  compiledSql: "select 1",
  logs: [],
}));
const previewModelMock = vi.fn(async () => ({
  ok: true,
  exitCode: 0,
  limit: 500,
  columns: ["id", "name"],
  rows: [{ id: 1, name: "acme" }],
  node: "foo",
  logs: [],
}));

beforeAll(() => {
  // jsdom lacks ResizeObserver / matchMedia, which MUI + resizable-panels touch.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof matchMedia;
});

beforeEach(() => {
  useDbtStore.getState().reset();
  vi.clearAllMocks();
  useDbtStore.setState({
    projects: [
      {
        _id: "p1",
        name: "P",
        dbtVersion: "1.9",
        environments: [{ name: "dev" }],
        defaultEnvironment: "dev",
      },
    ] as never,
    filesByProject: {
      p1: {
        "models/foo.sql": { content: "select 1", dirty: false, loaded: true },
      },
    } as never,
    filePathsByProject: { p1: ["models/foo.sql"] } as never,
    runCommand: runCommandMock as never,
    compileModel: compileModelMock as never,
    previewModel: previewModelMock as never,
    readFile: vi.fn(async () => "select 1") as never,
    persistFile: vi.fn(async () => true) as never,
    writeFile: vi.fn() as never,
    fetchProjects: vi.fn(async () => {}) as never,
  });
});

afterEach(() => cleanup());

describe("DbtFileEditor", () => {
  it("auto-compiles on mount and dispatches the right command from the run menu", async () => {
    const user = userEvent.setup();
    render(<DbtFileEditor tabId="t1" projectId="p1" path="models/foo.sql" />);

    // dbt Studio parity: the active model auto-compiles on open (no button),
    // using the derived model name "foo" + default environment "dev".
    await waitFor(() =>
      expect(compileModelMock).toHaveBeenCalledWith(
        "ws1",
        "p1",
        "foo",
        "dev",
        false,
      ),
    );

    // Wait for the on-mount parse/auto-compile to settle (button re-enabled).
    const runButton = await screen.findByRole("button", {
      name: /build, run, or test this model/i,
    });
    await waitFor(() =>
      expect((runButton as HTMLButtonElement).disabled).toBe(false),
    );

    await user.click(runButton);

    // The menu lists {Build,Run,Test} × {model, model+, +model, +model+}.
    // "Build model" (node only) → `build --select foo`.
    const items = await screen.findAllByRole("menuitem");
    const buildModel = items.find(i => i.textContent === "Build model");
    expect(buildModel).toBeDefined();
    await user.click(buildModel as HTMLElement);

    await waitFor(() =>
      expect(runCommandMock).toHaveBeenCalledWith(
        "ws1",
        "p1",
        "build --select foo",
        "dev",
        false,
      ),
    );
  });

  it("previews rows into the Results tab from the toolbar button", async () => {
    const user = userEvent.setup();
    render(<DbtFileEditor tabId="t1" projectId="p1" path="models/foo.sql" />);

    // Nothing previewed yet — Results points at the button that fills it.
    await user.click(await screen.findByRole("tab", { name: "Results" }));
    expect(screen.getByText(/There's nothing here/i)).toBeTruthy();

    const previewButton = await screen.findByRole("button", {
      name: /preview this model/i,
    });
    await waitFor(() =>
      expect((previewButton as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(previewButton);

    await waitFor(() =>
      expect(previewModelMock).toHaveBeenCalledWith(
        "ws1",
        "p1",
        "foo",
        "dev",
        false,
      ),
    );

    // Preview jumps to Results and hands the rows to the grid.
    const grid = await screen.findByTestId("results-grid");
    expect(JSON.parse(grid.textContent as string)).toEqual([
      { id: 1, name: "acme" },
    ]);
  });

  it("previews on Cmd+Enter without materializing anything", async () => {
    const user = userEvent.setup();
    render(<DbtFileEditor tabId="t1" projectId="p1" path="models/foo.sql" />);

    await waitFor(() => expect(compileModelMock).toHaveBeenCalled());

    // Monaco is stubbed, so the shortcut arrives at the tab's key handler.
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() =>
      expect(previewModelMock).toHaveBeenCalledWith(
        "ws1",
        "p1",
        "foo",
        "dev",
        false,
      ),
    );
    // ⌘↵ is read-only: no build/run reached the warehouse.
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("ignores Cmd+Enter in a background console tab", async () => {
    const user = userEvent.setup();
    // Console tabs stay mounted while hidden (display:none), so the shortcut's
    // document listener must only answer for the tab the user is looking at.
    render(
      <div data-mako-tab-id="t1">
        <DbtFileEditor tabId="t1" projectId="p1" path="models/foo.sql" />
      </div>,
    );

    await waitFor(() => expect(compileModelMock).toHaveBeenCalled());
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(previewModelMock).not.toHaveBeenCalled();
  });

  it("builds the model from the split button's primary action", async () => {
    const user = userEvent.setup();
    render(<DbtFileEditor tabId="t1" projectId="p1" path="models/foo.sql" />);

    const buildButton = await screen.findByRole("button", {
      name: /^build this model$/i,
    });
    await waitFor(() =>
      expect((buildButton as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(buildButton);

    await waitFor(() =>
      expect(runCommandMock).toHaveBeenCalledWith(
        "ws1",
        "p1",
        "build --select foo",
        "dev",
        false,
      ),
    );

    // The invocation lands in the Commands rail with its node results.
    await user.click(screen.getByRole("tab", { name: "Commands" }));
    expect(
      await screen.findByText("dbt build --select foo", {
        selector: "h6",
      }),
    ).toBeTruthy();
  });

  it("renders a markdown preview by default for .md files and toggles to the editor", async () => {
    const user = userEvent.setup();
    useDbtStore.setState({
      filesByProject: {
        p1: {
          "models/README.md": {
            content: "# Hello docs",
            dirty: false,
            loaded: true,
          },
        },
      } as never,
      filePathsByProject: { p1: ["models/README.md"] } as never,
    });

    render(<DbtFileEditor tabId="t1" projectId="p1" path="models/README.md" />);

    // Preview is on by default → markdown content is rendered.
    const preview = await screen.findByTestId("markdown-preview");
    expect(preview.textContent).toBe("# Hello docs");

    // Flipping the Preview switch off swaps to the (Monaco) editor pane.
    const previewSwitch = screen.getByRole("checkbox", {
      name: /preview/i,
    }) as HTMLInputElement;
    expect(previewSwitch.checked).toBe(true);
    await user.click(previewSwitch);

    await waitFor(() =>
      expect(screen.queryByTestId("markdown-preview")).toBeNull(),
    );
  });
});
