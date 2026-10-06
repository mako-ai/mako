// @vitest-environment jsdom
/**
 * Editing a database connection: a save that only renames it must not run
 * the pre-save connection test. It did, so renaming a connection whose
 * database was unreachable at that moment stopped on "Connection test
 * failed … Save anyways" — while the REST rename went straight through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const h = vi.hoisted(() => {
  const catalog = {
    fetchTypes: vi.fn().mockResolvedValue(undefined),
    fetchSchema: vi.fn().mockResolvedValue(undefined),
    types: [],
    // One object for the whole run: the dialog's load effect depends on it.
    schemas: {
      postgresql: {
        fields: [
          { name: "host", type: "string", label: "Host", required: true },
          { name: "port", type: "number", label: "Port" },
          { name: "database", type: "string", label: "Database" },
          { name: "username", type: "string", label: "Username" },
          { name: "password", type: "password", label: "Password" },
          { name: "ssl", type: "boolean", label: "SSL" },
        ],
      },
    },
  };
  const schema = {
    testConnection: vi.fn(),
    fetchDatabase: vi.fn(),
    saveDatabase: vi.fn(),
  };
  const agent = {
    status: "offline",
    ensureChecked: vi.fn().mockResolvedValue(undefined),
    checkAgent: vi.fn().mockResolvedValue("offline"),
  };
  return { catalog, schema, agent, workspace: { id: "ws1" } };
});

vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: h.workspace }),
}));
vi.mock("../store/databaseCatalogStore", () => ({
  useDatabaseCatalogStore: () => h.catalog,
}));
vi.mock("../store/schemaStore", () => ({
  useSchemaStore: () => h.schema,
}));
vi.mock("../store/localAgentStore", () => ({
  useLocalAgentStore: (selector: (s: typeof h.agent) => unknown) =>
    selector(h.agent),
}));
vi.mock("../lib/desktop", () => ({ isMakoDesktop: () => false }));
vi.mock("../lib/analytics", () => ({ trackEvent: vi.fn() }));

import CreateDatabaseDialog from "./CreateDatabaseDialog";

const STORED = {
  name: "Warehouse PG",
  type: "postgresql",
  // What the e2e connection held: a cloud connection at a local address,
  // unreachable from the test server — the case that showed the prompt.
  connection: { host: "127.0.0.1", port: 5999, database: "warehouse" },
};

async function openEditDialog() {
  const onSuccess = vi.fn();
  render(
    <CreateDatabaseDialog
      open
      databaseId="507f1f77bcf86cd799439041"
      onClose={() => undefined}
      onSuccess={onSuccess}
    />,
  );
  const name = (await screen.findByLabelText(
    /Database Name/,
  )) as HTMLInputElement;
  await waitFor(() => expect(name.value).toBe("Warehouse PG"));
  // The schema-driven fields render once loading settles.
  await screen.findByLabelText(/Host/);
  return { name, onSuccess };
}

describe("CreateDatabaseDialog — edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.schema.fetchDatabase.mockResolvedValue(STORED);
    h.schema.testConnection.mockResolvedValue({
      success: false,
      error: "connect ECONNREFUSED 127.0.0.1:5999",
    });
  });
  afterEach(cleanup);

  it("saves a rename without testing the connection", async () => {
    h.schema.saveDatabase.mockResolvedValue({
      success: true,
      data: { _id: "507f1f77bcf86cd799439041" },
    });
    const { name, onSuccess } = await openEditDialog();

    fireEvent.change(name, { target: { value: "Analytics Warehouse" } });
    fireEvent.click(screen.getByRole("button", { name: "Update Database" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(h.schema.saveDatabase).toHaveBeenCalledTimes(1);
    const [workspaceId, values, id, options] =
      h.schema.saveDatabase.mock.calls[0];
    expect(workspaceId).toBe("ws1");
    expect(id).toBe("507f1f77bcf86cd799439041");
    expect(values.name).toBe("Analytics Warehouse");
    expect(values.connection).toMatchObject(STORED.connection);
    expect(options).toEqual({ verifyBeforeSave: false });
    expect(h.schema.testConnection).not.toHaveBeenCalled();
    expect(screen.queryByText("Connection test failed")).toBeNull();
  });

  it("still tests first when the config changed", async () => {
    h.schema.saveDatabase.mockResolvedValue({
      success: false,
      code: "connection_test_failed",
      error: "connect ECONNREFUSED 127.0.0.1:5432",
    });
    const { name } = await openEditDialog();

    fireEvent.change(name, { target: { value: "Analytics Warehouse" } });
    fireEvent.change(screen.getByLabelText(/Port/), {
      target: { value: "5432" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Database" }));

    expect(await screen.findByText("Connection test failed")).toBeTruthy();
    expect(h.schema.saveDatabase).toHaveBeenCalledTimes(1);
    expect(h.schema.saveDatabase.mock.calls[0][3]).toEqual({
      verifyBeforeSave: true,
    });
  });
});
