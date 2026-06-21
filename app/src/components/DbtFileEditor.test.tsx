// @vitest-environment jsdom
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
vi.mock("../dbt-runtime/shell", () => ({ focusDbtFileTab: vi.fn() }));

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
});
