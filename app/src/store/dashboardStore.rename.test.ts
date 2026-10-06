// @vitest-environment jsdom
/**
 * A dashboard renamed while its tab is open (the tree, another window, the
 * agent): the tab takes the new title — label, store, JSON — and, edited or
 * not, the new version, so its next save neither conflicts ("modified by
 * another user") nor writes the old title back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// zustand `persist` reads the global localStorage at module load; Node 22+
// leaves it undefined (and it shadows jsdom's). In-memory, before imports.
vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
      key: (i: number) => [...memory.keys()][i] ?? null,
      get length() {
        return memory.size;
      },
    },
  });
});

const http = vi.hoisted(() => ({
  GET: vi.fn(),
  PATCH: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  DELETE: vi.fn(),
}));
vi.mock("../api", async importOriginal => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: http };
});
vi.mock("../dashboard-runtime/gateway", () => ({
  disposeDashboardRuntime: vi.fn(async () => {}),
}));

import { computeDashboardStateHash } from "../utils/stateHash";
import type { Dashboard } from "../dashboard-runtime/types";
import { useDashboardStore } from "./dashboardStore";
import { useConsoleStore } from "./consoleStore";

const WS = "w1";
const ID = "d1";

const ok = (body: unknown) => ({
  data: body,
  error: undefined,
  response: { ok: true, status: 200 },
});

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    _id: ID,
    workspaceId: WS,
    title: "Untitled Dashboard",
    dataSources: [],
    widgets: [],
    relationships: [],
    globalFilters: [],
    crossFilter: { enabled: true, resolution: "intersect", engine: "mosaic" },
    materializationSchedule: { enabled: false, cron: null },
    layout: { columns: 12, rowHeight: 100 },
    version: 3,
    access: "private",
    createdBy: "u1",
    createdAt: "",
    updatedAt: "",
    ...over,
  } as unknown as Dashboard;
}

function openWith(local: Dashboard, editing: boolean) {
  const base = dashboard();
  useDashboardStore.setState({
    openDashboards: { [ID]: local },
    savedStateHashes: { [ID]: computeDashboardStateHash(base) },
    editingDashboards: editing ? { [ID]: true } : {},
    historyMap: {
      [ID]: { stack: [dashboard({ title: "Untitled Dashboard" })], index: 0 },
    },
  });
  useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
  useConsoleStore.getState().openTab({
    title: "Untitled Dashboard",
    content: "",
    kind: "dashboard",
    metadata: { dashboardId: ID },
  });
}

const dashboardTab = () =>
  Object.values(useConsoleStore.getState().tabs).find(
    t => t.kind === "dashboard",
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncRemoteDashboard — a rename reaches the open tab", () => {
  it("an edited tab takes the new title and version and keeps its draft", async () => {
    openWith(dashboard({ description: "unsaved edit" }), true);
    http.GET.mockResolvedValueOnce(
      ok({ data: dashboard({ title: "Ops Overview v2", version: 4 }) }),
    );

    await useDashboardStore.getState().syncRemoteDashboard(WS, ID);

    const open = useDashboardStore.getState().openDashboards[ID];
    expect(open.title).toBe("Ops Overview v2");
    expect(open.version).toBe(4); // the next save is not a false conflict
    expect(open.description).toBe("unsaved edit");
    // Still dirty (its own edit), against the renamed baseline.
    expect(computeDashboardStateHash(open)).not.toBe(
      useDashboardStore.getState().savedStateHashes[ID],
    );
    // An undo does not rename it back.
    expect(useDashboardStore.getState().historyMap[ID].stack[0].title).toBe(
      "Ops Overview v2",
    );
    expect(dashboardTab()?.title).toBe("Ops Overview v2");
  });

  it("a clean tab reloads, and its label follows", async () => {
    openWith(dashboard(), false);
    http.GET.mockResolvedValueOnce(
      ok({ data: dashboard({ title: "Ops Overview v2", version: 4 }) }),
    );

    await useDashboardStore.getState().syncRemoteDashboard(WS, ID);

    expect(useDashboardStore.getState().openDashboards[ID].title).toBe(
      "Ops Overview v2",
    );
    expect(dashboardTab()?.title).toBe("Ops Overview v2");
  });

  it("a real concurrent edit is left alone (the save's conflict dialog decides)", async () => {
    openWith(dashboard({ description: "mine" }), true);
    http.GET.mockResolvedValueOnce(
      ok({
        data: dashboard({
          title: "Renamed",
          version: 4,
          description: "theirs",
        }),
      }),
    );

    await useDashboardStore.getState().syncRemoteDashboard(WS, ID);

    const open = useDashboardStore.getState().openDashboards[ID];
    expect(open.title).toBe("Untitled Dashboard");
    expect(open.version).toBe(3);
    expect(open.description).toBe("mine");
  });
});
