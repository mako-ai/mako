import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody } from "../api";

export interface ConnectorEntityLayoutSuggestion {
  partitionField?: string;
  partitionGranularity?: "day" | "hour" | "month" | "year";
  clusterFields?: string[];
}

export interface ConnectorEntityField {
  name: string;
  type: string;
}

export type EntityIncrementalMode =
  | "native"
  | "client-filter"
  | "created-anchor"
  | "none";

export interface ConnectorEntityMetadata {
  name: string;
  label?: string;
  description?: string;
  subEntities?: ConnectorEntityMetadata[];
  layoutSuggestion?: ConnectorEntityLayoutSuggestion;
  /** Field list resolved from the connector schema (name + logical type). */
  fields?: ConnectorEntityField[];
  /** Dedup/merge key columns this entity syncs on (defaults to ["id"]). */
  keyColumns?: string[];
  /** Per-entity incremental-pull capability (Airbyte-style stream badge). */
  incrementalMode?: EntityIncrementalMode;
  /** API query param / field the connector uses for since-filtering, if any. */
  anchorField?: string;
}

/** Older connectors may return a flat string list instead of metadata. */
export type AvailableConnectorEntity = string | ConnectorEntityMetadata;

export interface FlattenedConnectorEntity {
  name: string;
  label: string;
  partitionField: string;
  partitionGranularity: "day" | "hour" | "month" | "year";
  clusterFields: string[];
  fields?: ConnectorEntityField[];
  keyColumns: string[];
  incrementalMode?: EntityIncrementalMode;
  anchorField?: string;
}

function fallbackLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Flatten connector entity metadata into one selectable row per syncable
 * entity. Parents with sub-entities (e.g. Close "activities") cannot be
 * synced bare, so they are expanded into `parent:Sub` rows.
 */
export function flattenConnectorEntities(
  list: AvailableConnectorEntity[],
): FlattenedConnectorEntity[] {
  const result: FlattenedConnectorEntity[] = [];

  for (const item of list) {
    const meta: ConnectorEntityMetadata =
      typeof item === "string" ? { name: item } : item;
    const layout = meta.layoutSuggestion;
    const subEntities = meta.subEntities ?? [];

    if (subEntities.length > 0) {
      for (const sub of subEntities) {
        const subLayout = sub.layoutSuggestion ?? layout;
        result.push({
          name: `${meta.name}:${sub.name}`,
          label: sub.label || fallbackLabel(sub.name),
          partitionField: subLayout?.partitionField || "_syncedAt",
          partitionGranularity: subLayout?.partitionGranularity || "day",
          clusterFields: subLayout?.clusterFields ?? [],
          fields: sub.fields ?? meta.fields,
          keyColumns: sub.keyColumns ?? meta.keyColumns ?? ["id"],
          incrementalMode: sub.incrementalMode ?? meta.incrementalMode,
          anchorField: sub.anchorField ?? meta.anchorField,
        });
      }
      continue;
    }

    result.push({
      name: meta.name,
      label: meta.label || fallbackLabel(meta.name),
      partitionField: layout?.partitionField || "_syncedAt",
      partitionGranularity: layout?.partitionGranularity || "day",
      clusterFields: layout?.clusterFields ?? [],
      fields: meta.fields,
      keyColumns: meta.keyColumns ?? ["id"],
      incrementalMode: meta.incrementalMode,
      anchorField: meta.anchorField,
    });
  }

  return result;
}

interface AvailableEntitiesState {
  byConnector: Record<string, AvailableConnectorEntity[]>; // key = `${workspaceId}:${connectorId}`
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  fetch: (
    workspaceId: string,
    connectorId: string,
    force?: boolean,
  ) => Promise<AvailableConnectorEntity[]>;
  clear: (workspaceId: string, connectorId: string) => void;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

function makeKey(workspaceId: string, connectorId: string) {
  return `${workspaceId}:${connectorId}`;
}

export const useAvailableEntitiesStore = create<AvailableEntitiesState>()(
  immer((set, get) => ({
    byConnector: {},
    loading: {},
    error: {},
    fetch: async (workspaceId, connectorId, force = false) => {
      const key = makeKey(workspaceId, connectorId);

      // Return cached unless forcing
      const cached = get().byConnector[key];
      if (cached && !force) return cached;

      set(state => {
        state.loading[key] = true;
        state.error[key] = null;
      });

      try {
        const json = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/connectors/{id}/entities",
            { params: { path: { workspaceId, id: connectorId } } },
          ),
        ) as ApiResponse<AvailableConnectorEntity[]>;
        if (json.success) {
          const list: AvailableConnectorEntity[] = json.data || [];
          set(state => {
            state.byConnector[key] = list;
            delete state.loading[key];
            state.error[key] = null;
          });
          return list;
        }
        throw new Error(json.error || "Failed to fetch entities");
      } catch (err: any) {
        set(state => {
          state.error[key] = err?.message || "Failed to fetch entities";
          delete state.loading[key];
        });
        return [];
      }
    },
    clear: (workspaceId, connectorId) =>
      set(state => {
        const key = makeKey(workspaceId, connectorId);
        delete state.byConnector[key];
        delete state.loading[key];
        delete state.error[key];
      }),
  })),
);
