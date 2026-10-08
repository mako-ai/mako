/**
 * Catalog of connector *code* (built-in + workspace types), not
 * configured source connections. Keep this filename.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import {
  effectiveIncrementalMode,
  type IncrementalCapabilities,
  type IncrementalMode,
} from "@mako/schemas";
import { api, unwrapBody } from "../api";

export type { IncrementalCapabilities, IncrementalMode };
export { effectiveIncrementalMode };

export interface WebhookProvisioningCapability {
  supported: boolean;
  providerLabel: string;
  storesSecretAutomatically: boolean;
  actionHint?: string;
}

export interface WebhookCapabilities {
  supported: boolean;
  provisioning: WebhookProvisioningCapability;
  secretHelpText?: string;
}

export interface ConnectorType {
  type: string;
  name: string;
  version: string;
  description: string;
  supportedEntities: string[];
  webhook: WebhookCapabilities;
  incremental: IncrementalCapabilities;
}

export interface ConnectorSchemaResponse {
  fields: Array<any>;
  /** Schema for transfer-level queries (for connectors like GraphQL/PostHog) */
  transferQueries?: {
    label: string;
    required: boolean;
    fields: Array<any>;
  };
}

interface CatalogResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

/** A workspace connector's type (`ws:<slug>`): its form is per workspace. */
function isWorkspaceType(type: string): boolean {
  return type.startsWith("ws:");
}

/** The workspace the API client sends as `x-workspace-id` (api/client.ts). */
function activeWorkspaceId(): string | null {
  try {
    return typeof localStorage === "undefined"
      ? null
      : localStorage.getItem("activeWorkspaceId");
  } catch {
    return null;
  }
}

/**
 * The cache key of a connector's form schema. A built-in type's form is the
 * same everywhere; a `ws:<slug>` type is a DIFFERENT connector in every
 * workspace (and the same slug can be reused after a rename), so it is
 * keyed by the workspace the schema was fetched for — the one the API
 * client sends — never shown in another.
 */
export function connectorSchemaKey(
  type: string,
  workspaceId: string | null = activeWorkspaceId(),
): string {
  return isWorkspaceType(type) ? `${workspaceId ?? "?"}::${type}` : type;
}

/** The cached form schema of `type` for the active workspace, if any. */
export function cachedConnectorSchema(
  schemas: Record<string, ConnectorSchemaResponse>,
  type: string,
): ConnectorSchemaResponse | undefined {
  return schemas[connectorSchemaKey(type)];
}

/** One request per key at a time; every caller gets its answer. */
const inFlight = new Map<string, Promise<ConnectorSchemaResponse | null>>();
/**
 * `ws:` keys whose cached form was checked against the server since the
 * catalog was last loaded. Once is enough: a form re-renders when its
 * schema arrives, and re-checking on every render would never settle.
 */
const revalidated = new Set<string>();

/** Test hook: forget in-flight requests and revalidation marks. */
export function resetConnectorSchemaRequests(): void {
  inFlight.clear();
  revalidated.clear();
}

interface CatalogState {
  types: ConnectorType[] | null;
  loading: boolean;
  error: string | null;
  /** Keyed by `connectorSchemaKey` (workspace-scoped for `ws:` types). */
  schemas: Record<string, ConnectorSchemaResponse>;
  schemaLoading: Record<string, boolean>;
  /** Fetch types from the API (always fetches fresh data, not persisted) */
  fetchCatalog: (workspaceId: string, force?: boolean) => Promise<void>;
  /** Fetch schema for connector type (schemas are cached and persisted) */
  fetchSchema: (
    type: string,
    force?: boolean,
  ) => Promise<ConnectorSchemaResponse | null>;
  /** Clear types from memory (useful when logging out or switching workspaces) */
  clearTypes: () => void;
}

export const useConnectorCatalogStore = create<CatalogState>()(
  persist(
    immer((set, get) => ({
      types: null,
      loading: false,
      error: null,
      schemas: {},
      schemaLoading: {},
      fetchCatalog: async (_workspaceId: string, _force = false) => {
        // Always fetch fresh data from the API
        set(state => {
          state.loading = true;
          state.error = null;
        });
        try {
          // Spec-typed call: path, and the `{ success, data }` response shape
          // (including each connector's fields) are checked against the
          // backend OpenAPI document at compile time.
          const { data, error } = await api.GET("/api/connectors/types");
          if (!error && data?.success) {
            set(state => {
              state.types = data.data;
              state.loading = false;
              // A workspace connector renamed away or deleted: its cached
              // form goes (a later folder may reuse the slug with other
              // fields). Only this workspace's entries are judged.
              const workspaceId = activeWorkspaceId();
              const live = new Set(
                (data.data as ConnectorType[]).map(t =>
                  connectorSchemaKey(t.type, workspaceId),
                ),
              );
              const prefix = `${workspaceId ?? "?"}::`;
              revalidated.clear();
              for (const key of Object.keys(state.schemas)) {
                if (key.startsWith(prefix) && !live.has(key)) {
                  delete state.schemas[key];
                }
              }
            });
          } else {
            set(state => {
              state.error =
                (error as { error?: string } | undefined)?.error ||
                "Failed to load connector types";
              state.loading = false;
            });
          }
        } catch (err: any) {
          set(state => {
            state.error = err.message || "Failed to load connector types";
            state.loading = false;
          });
        }
      },
      fetchSchema: (type: string, force = false) => {
        const key = connectorSchemaKey(type);
        const cached = get().schemas[key];
        const pending = inFlight.get(key);
        // A request already on its way answers this caller too. (Returning
        // null here made a form that asked twice show "Failed to load
        // connector schema" while the schema was arriving.)
        if (pending) {
          return cached && !force ? Promise.resolve(cached) : pending;
        }
        if (cached && !force) {
          // A built-in's form is fixed for this build. A workspace
          // connector's changes with every push (a rename, an edited spec):
          // served from cache, and checked against the server once.
          if (!isWorkspaceType(type) || revalidated.has(key)) {
            return Promise.resolve(cached);
          }
        }
        if (isWorkspaceType(type)) revalidated.add(key);
        const request = (async (): Promise<ConnectorSchemaResponse | null> => {
          set(state => {
            state.schemaLoading[key] = true;
          });
          try {
            const json = unwrapBody(
              await api.GET("/api/connectors/{type}/schema", {
                params: { path: { type } },
              }),
            ) as CatalogResponse<ConnectorSchemaResponse>;
            if (json.success) {
              const before = get().schemas[key];
              if (
                !before ||
                JSON.stringify(before) !== JSON.stringify(json.data)
              ) {
                set(state => {
                  state.schemas[key] = json.data;
                });
              }
              return get().schemas[key] ?? json.data;
            }
            // The connector is gone (deleted, renamed and the name reused
            // elsewhere): its cached form must not linger.
            if (isWorkspaceType(type)) {
              set(state => {
                delete state.schemas[key];
              });
            }
          } catch (err) {
            // 404: no such connector here any more — drop its cached form.
            if (
              isWorkspaceType(type) &&
              (err as { status?: number } | null)?.status === 404
            ) {
              set(state => {
                delete state.schemas[key];
              });
            }
            console.error("Failed to fetch schema", err);
          } finally {
            inFlight.delete(key);
            set(state => {
              delete state.schemaLoading[key];
            });
          }
          return null;
        })();
        inFlight.set(key, request);
        // Revalidating a cached `ws:` form: answer now, update on arrival.
        return cached && !force ? Promise.resolve(cached) : request;
      },
      clearTypes: () =>
        set(state => {
          state.types = null;
        }),
    })),
    {
      name: "connector-catalog-store",
      // v3: invalidate schemas cached before PostHog transferQueries became
      // optional — a stale required:true blocks saving builtin-only flows.
      // v4: `ws:` schemas are keyed by workspace; unscoped ones are dropped
      // (one workspace's form must never show in another).
      version: 4,
      migrate: (persisted, version) => {
        const schemas =
          (persisted as { schemas?: Record<string, ConnectorSchemaResponse> })
            ?.schemas ?? {};
        if (version < 3) return { schemas: {} };
        return {
          schemas: Object.fromEntries(
            Object.entries(schemas).filter(([key]) => !isWorkspaceType(key)),
          ),
        };
      },
      partialize: state => ({ schemas: state.schemas }), // Only persist schemas, not types
    },
  ),
);
