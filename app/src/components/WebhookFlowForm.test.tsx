// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookFlowForm } from "./WebhookFlowForm";
import { useFlowStore } from "../store/flowStore";
import { useSchemaStore } from "../store/schemaStore";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useAvailableEntitiesStore } from "../store/availableEntitiesStore";

vi.mock("idb-keyval", () => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}));

vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: "ws_1", role: "admin" },
  }),
}));

const baseFlow = {
  _id: "6a449f90718eeb15279df8a4",
  workspaceId: "ws_1",
  dataSourceId: { _id: "src_1", name: "Stripe", type: "stripe" },
  destinationDatabaseId: { _id: "dest_1", name: "BigQuery", type: "bigquery" },
  type: "webhook",
  schedule: {},
  webhookConfig: {
    endpoint: "https://example.test/webhook",
    secret: "redacted",
    enabled: true,
  },
  syncMode: "incremental",
  syncEngine: "cdc",
  runCount: 0,
  createdBy: "user_1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  deleteMode: "soft",
  entityLayouts: [
    {
      entity: "customers",
      label: "Customers",
      partitionField: "_syncedAt",
      partitionGranularity: "day",
      clusterFields: [],
      enabled: true,
    },
  ],
};

interface UpdateFlowPayload {
  tableDestination?: {
    connectionId?: string;
    schema?: string;
    tableName?: string;
  };
}

type UpdateFlowMock = ReturnType<
  typeof vi.fn<
    (
      workspaceId: string,
      flowId: string,
      payload: UpdateFlowPayload,
    ) => Promise<void>
  >
>;

const setupStores = (updateFlow: UpdateFlowMock) => {
  useFlowStore.setState({
    flows: {
      ws_1: [
        {
          ...baseFlow,
          tableDestination: {
            connectionId: "dest_1",
            database: "my_dataset",
            tableName: "stripe_",
            createIfNotExists: true,
          },
        } as any,
      ],
    },
    loading: {},
    error: {},
    fetchConnectors: vi.fn(async () => [
      { _id: "src_1", name: "Stripe", type: "stripe" },
    ]),
    updateFlow,
    setSyncEngine: vi.fn(async () => true),
    fetchFlows: vi.fn(async () => []),
    resyncCdcFlow: vi.fn(async () => true),
    clearError: vi.fn(),
  } as any);
  useSchemaStore.setState({
    connections: {
      ws_1: [
        {
          id: "dest_1",
          name: "BigQuery",
          description: "",
          database: "",
          type: "bigquery",
          active: true,
          displayName: "BigQuery",
          hostKey: "bigquery",
          hostName: "bigquery",
        },
      ],
    },
    ensureConnections: vi.fn(async () => []),
  } as any);
  useConnectorCatalogStore.setState({
    types: [
      {
        type: "stripe",
        name: "Stripe",
        version: "1",
        description: "",
        supportedEntities: ["customers"],
        webhook: {
          supported: true,
          provisioning: {
            supported: false,
            providerLabel: "Stripe",
            storesSecretAutomatically: false,
          },
        },
      },
    ],
    fetchCatalog: vi.fn(async () => undefined),
  } as any);
  useAvailableEntitiesStore.setState({
    byConnector: {
      "ws_1:src_1": [
        {
          name: "customers",
          label: "Customers",
          layoutSuggestion: {
            partitionField: "_syncedAt",
            partitionGranularity: "day",
            clusterFields: [],
          },
          fields: [{ name: "_syncedAt", type: "timestamp" }],
        },
      ],
    },
  } as any);
};

describe("WebhookFlowForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("hydrates BigQuery dataset from legacy database field and submits it as schema", async () => {
    const updateFlow = vi.fn(
      async (
        _workspaceId: string,
        _flowId: string,
        _payload: UpdateFlowPayload,
      ) => undefined,
    );
    setupStores(updateFlow);

    render(<WebhookFlowForm flowId="6a449f90718eeb15279df8a4" />);

    await screen.findByDisplayValue("my_dataset");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(updateFlow).toHaveBeenCalled());
    expect(updateFlow.mock.calls[0]?.[2].tableDestination).toMatchObject({
      connectionId: "dest_1",
      schema: "my_dataset",
      tableName: "stripe_",
    });
  });
});
