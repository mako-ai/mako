// @vitest-environment jsdom
/**
 * The source connection form and its workspace connector:
 *  - the schema request asked twice while on its way (StrictMode runs
 *    effects twice) shows no failure, and a real failure is still said;
 *  - a connection whose connector binding does not resolve shows the
 *    server's message and sends `type` with the save, which re-binds it;
 *  - renaming the connector moves the form to `ws:<new>`.
 */
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node 26 + jsdom has no usable localStorage; a Map-backed one is enough.
vi.hoisted(() => {
  const data = new Map<string, string>([["activeWorkspaceId", "wsA"]]);
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
    configurable: true,
  });
});
const http = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("../api", async importOriginal => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: http,
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "wsA", role: "member" } }),
}));

import SourceConnectionForm from "./SourceConnectionForm";
import {
  connectorSchemaKey,
  resetConnectorSchemaRequests,
  useConnectorCatalogStore,
} from "../store/connectorCatalogStore";
import { useSourceConnectionEntitiesStore } from "../store/sourceConnectionEntitiesStore";

const LOAD_ERROR = "Failed to load connector schema";
const schema = {
  fields: [{ name: "apiKey", label: "API key", type: "password" }],
};
const ok = (data: unknown) => ({
  data: { success: true, data },
  error: undefined,
  response: { ok: true, status: 200 },
});
const connection = (extra: Record<string, unknown> = {}) => ({
  _id: "c1",
  name: "Acme prod",
  type: "ws:acme",
  config: {},
  settings: {},
  ...extra,
});
const types = (slug: string) => [
  {
    type: `ws:${slug}`,
    name: `Connector ${slug}`,
    version: "1.0.0",
    description: `${slug}, from this workspace's repository`,
    supportedEntities: [],
  },
];
const schemaRequests = () =>
  http.GET.mock.calls
    .filter(([path]) => String(path).endsWith("/schema"))
    .map(([, options]) => options.params.path.type);
const cacheSchema = (type: string) =>
  useConnectorCatalogStore.setState({
    schemas: { [connectorSchemaKey(type, "wsA")]: schema },
  });

beforeEach(() => {
  http.GET.mockReset();
  http.POST.mockReset();
  http.GET.mockResolvedValue(ok(schema));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetConnectorSchemaRequests();
  useConnectorCatalogStore.setState({ schemas: {}, schemaLoading: {} });
});

describe("a workspace connector's schema", () => {
  it("asked twice while on its way: no failure is shown at any point, the fields render, one request", async () => {
    let release = () => {};
    http.GET.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve(ok(schema));
        }),
    );
    render(
      <StrictMode>
        <SourceConnectionForm
          onSubmit={() => undefined}
          connector={connection()}
          connectorTypes={types("acme")}
        />
      </StrictMode>,
    );
    // Still on its way: the second ask must not have reported a failure.
    await act(async () => {});
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    await act(async () => release());
    expect((await screen.findAllByText("API key")).length).toBeGreaterThan(0);
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    expect(schemaRequests()).toEqual(["ws:acme"]);
  });

  it("a real failure is still said", async () => {
    http.GET.mockResolvedValue({
      data: undefined,
      error: { error: "Connector not found" },
      response: { ok: false, status: 404 },
    });
    render(
      <StrictMode>
        <SourceConnectionForm
          onSubmit={() => undefined}
          connector={connection({ type: "ws:ghost" })}
        />
      </StrictMode>,
    );
    expect(await screen.findByText(LOAD_ERROR)).toBeTruthy();
  });
});

describe("a connection whose connector binding does not resolve", () => {
  const message =
    'This connection was saved under the connector "acme", whose folder is no longer on main.';
  const save = async (connector: Record<string, unknown>) => {
    const onSubmit = vi.fn();
    cacheSchema("ws:acme");
    render(
      <SourceConnectionForm
        onSubmit={onSubmit}
        connector={connector}
        connectorTypes={types("acme")}
      />,
    );
    await screen.findAllByText("API key");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
    });
    return onSubmit;
  };

  it("shows the server's message and sends the type with the save, changed or not", async () => {
    const onSubmit = await save(
      connection({
        connectorBinding: { ok: false, problem: "definition-gone", message },
      }),
    );
    expect(screen.getByText(message)).toBeTruthy();
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ type: "ws:acme" }),
    );
  });

  it("a connection that resolves shows no message and saves nothing when nothing changed", async () => {
    const onSubmit = await save(connection());
    expect(screen.queryByText(message)).toBeNull();
    await act(async () => {});
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("renaming the connector", () => {
  /** The form's connector header is the one for `ws:<slug>`. */
  const shows = async (slug: string) =>
    expect(
      (await screen.findAllByAltText(`ws:${slug} icon`)).length,
    ).toBeGreaterThan(0);

  it("from the form: the form moves to ws:<new>, and the workspace's connections are loaded again", async () => {
    const refresh = vi.fn(async () => []);
    const renameWorkspaceConnector = vi.fn(async () => ({ slug: "acme-crm" }));
    const stores = {
      refresh: useSourceConnectionEntitiesStore.getState().refresh,
      rename: useConnectorCatalogStore.getState().renameWorkspaceConnector,
    };
    useSourceConnectionEntitiesStore.setState({ refresh });
    useConnectorCatalogStore.setState({ renameWorkspaceConnector });
    cacheSchema("ws:acme");
    const onSubmit = vi.fn();
    render(
      <SourceConnectionForm
        onSubmit={onSubmit}
        connector={connection()}
        connectorTypes={[...types("acme"), ...types("acme-crm")]}
      />,
    );
    await shows("acme");
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
    fireEvent.change(screen.getByLabelText("Connector slug"), {
      target: { value: "acme-crm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await shows("acme-crm");
    expect(screen.queryAllByAltText("ws:acme icon")).toEqual([]);
    expect(renameWorkspaceConnector).toHaveBeenCalledWith(
      "wsA",
      "acme",
      "acme-crm",
    );
    expect(refresh).toHaveBeenCalledWith("wsA");
    await waitFor(() => expect(schemaRequests()).toContain("ws:acme-crm"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Connector slug")).toBeNull(),
    );
    // The move is the server's, not an edit of this connection: nothing to save.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    useSourceConnectionEntitiesStore.setState({ refresh: stores.refresh });
    useConnectorCatalogStore.setState({
      renameWorkspaceConnector: stores.rename,
    });
  });

  it("elsewhere: an open form follows its connection's new type", async () => {
    cacheSchema("ws:acme");
    const props = {
      onSubmit: () => undefined,
      connectorTypes: [...types("acme"), ...types("acme-crm")],
    };
    const view = render(
      <SourceConnectionForm {...props} connector={connection()} />,
    );
    await shows("acme");
    view.rerender(
      <SourceConnectionForm
        {...props}
        connector={connection({ type: "ws:acme-crm" })}
      />,
    );
    await shows("acme-crm");
    expect(screen.queryAllByAltText("ws:acme icon")).toEqual([]);
  });
});
