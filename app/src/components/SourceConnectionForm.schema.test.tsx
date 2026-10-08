// @vitest-environment jsdom
/**
 * The workspace connector form under StrictMode (effects run twice, as in
 * development): the schema request is asked for twice while on its way.
 * It used to answer the second ask with null, the form said "Failed to
 * load connector schema" and never took it back once the schema arrived.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const http = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("../api", async importOriginal => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: { GET: http.GET },
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "wsA" } }),
}));

import SourceConnectionForm from "./SourceConnectionForm";
import {
  resetConnectorSchemaRequests,
  useConnectorCatalogStore,
} from "../store/connectorCatalogStore";

afterEach(() => {
  cleanup();
  resetConnectorSchemaRequests();
  useConnectorCatalogStore.setState({ schemas: {}, schemaLoading: {} });
});

describe("SourceConnectionForm — a workspace connector's schema", () => {
  it("asked twice while on its way: the fields render and no load error is shown", async () => {
    http.GET.mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve({
                data: {
                  success: true,
                  data: {
                    fields: [
                      { name: "apiKey", label: "API key", type: "password" },
                    ],
                  },
                },
                error: undefined,
                response: { ok: true, status: 200 },
              }),
            20,
          ),
        ),
    );
    render(
      <StrictMode>
        <SourceConnectionForm
          onSubmit={() => undefined}
          connector={{
            _id: "c1",
            name: "Acme prod",
            type: "ws:acme-crm",
            config: {},
            settings: {},
          }}
          connectorTypes={[
            {
              type: "ws:acme-crm",
              name: "acme-api",
              version: "1.0.0",
              description: "acme-crm — from this workspace's repository",
              supportedEntities: [],
            },
          ]}
        />
      </StrictMode>,
    );
    expect((await screen.findAllByText("API key")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Failed to load connector schema")).toBeNull();
    expect(http.GET).toHaveBeenCalledTimes(1);
  });

  it("a real failure is still said", async () => {
    http.GET.mockResolvedValue({
      data: undefined,
      error: { error: "Connector not found" },
      response: { ok: false, status: 404 },
    });
    render(
      <SourceConnectionForm
        onSubmit={() => undefined}
        connector={{
          _id: "c2",
          name: "Ghost",
          type: "ws:ghost",
          config: {},
          settings: {},
        }}
        connectorTypes={[]}
      />,
    );
    expect(
      await screen.findByText("Failed to load connector schema"),
    ).toBeTruthy();
  });
});
