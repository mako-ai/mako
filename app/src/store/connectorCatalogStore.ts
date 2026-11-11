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
import { api, toErrorMessage, unwrapBody } from "../api";

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
 * same everywhere. A `ws:<slug>` type is a different connector in every
 * workspace, and a slug can be renamed away and reused, so it is keyed by
 * the workspace the schema was fetched for: the one the API client sends.
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
 * Keys whose cached schema was refetched: a built-in's once per page load,
 * a `ws:` type's once per catalog load (a push changes it).
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
  /** Keyed by `connectorSchemaKey` (per workspace for `ws:` types). */
  schemas: Record<string, ConnectorSchemaResponse>;
  schemaLoading: Record<string, boolean>;
  /** Fetch types from the API (always fetches fresh data, not persisted) */
  fetchCatalog: (workspaceId: string, force?: boolean) => Promise<void>;
  /** Fetch schema for connector type (schemas are cached and persisted) */
  fetchSchema: (
    type: string,
    force?: boolean,
  ) => Promise<ConnectorSchemaResponse | null>;
  /**
   * Rename a workspace connector's folder (`connectors/<slug>/`). The
   * connector keeps its id and its connections; the catalog is reloaded.
   * Answers the new slug, or the server's sentence when it refuses.
   */
  renameWorkspaceConnector: (
    workspaceId: string,
    slug: string,
    nextSlug: string,
  ) => Promise<{ slug: string } | { error: string }>;
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
        // The workspace this request is sent for, read before it leaves.
        const workspaceId = activeWorkspaceId();
        try {
          // Spec-typed call: path, and the `{ success, data }` response shape
          // (including each connector's fields) are checked against the
          // backend OpenAPI document at compile time.
          const { data, error } = await api.GET("/api/connectors/types");
          if (!error && data?.success) {
            const prefix = `${workspaceId}::`;
            const listed = new Set(
              data.data.map(t => connectorSchemaKey(t.type, workspaceId)),
            );
            // A new catalog: this workspace's `ws:` forms are checked again.
            for (const key of [...revalidated]) {
              if (key.startsWith(prefix)) revalidated.delete(key);
            }
            set(state => {
              state.types = data.data;
              state.loading = false;
              // A workspace connector renamed away or deleted loses its
              // cached form (a later folder may reuse the slug with other
              // fields). Only this workspace's entries are judged.
              if (!workspaceId) return;
              for (const key of Object.keys(state.schemas)) {
                if (key.startsWith(prefix) && !listed.has(key)) {
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
        if (cached && !force) {
          // Stale-while-revalidate: the cached schema renders at once and is
          // refetched once (see `revalidated`), so a connector's changed
          // fields reach the form without a version bump.
          if (!revalidated.has(key)) {
            revalidated.add(key);
            void get().fetchSchema(type, true);
          }
          return Promise.resolve(cached);
        }
        revalidated.add(key);
        // A request already on its way answers this caller too. Answering
        // null here made a form that asks twice (StrictMode, an effect that
        // re-runs) report a failure while the schema was arriving.
        const pending = inFlight.get(key);
        if (pending) return pending;

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
              // Unchanged: keep the object, so readers do not re-render.
              const before = get().schemas[key];
              if (JSON.stringify(before) !== JSON.stringify(json.data)) {
                set(state => {
                  state.schemas[key] = json.data;
                });
              }
              return get().schemas[key] ?? json.data;
            }
          } catch (err) {
            // No such workspace connector any more (deleted, or renamed and
            // the name not kept): its cached form goes with it.
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
        return request;
      },
      renameWorkspaceConnector: async (workspaceId, slug, nextSlug) => {
        try {
          const body = unwrapBody(
            await api.POST(
              "/api/workspaces/{workspaceId}/objects/{kind}/rename",
              {
                params: { path: { workspaceId, kind: "connector" } },
                body: { ref: slug, slug: nextSlug },
              },
            ),
          ) as { result?: { after?: { slug?: string } } };
          // Types moved from ws:<old> to ws:<new>: the new catalog says so,
          // and drops the form cached under the old type.
          await get().fetchCatalog(workspaceId, true);
          return { slug: body.result?.after?.slug ?? nextSlug };
        } catch (error) {
          return {
            error: toErrorMessage(error, "The connector could not be renamed."),
          };
        }
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
      // v4: Wise's SCA private key became a multi-line field; from v4 on,
      // fetchSchema revalidates persisted schemas once per page load.
      // v5: `ws:` schemas are keyed by workspace. Entries stored under the
      // bare type are dropped (they could be another workspace's form);
      // built-in schemas are kept. Older caches are dropped whole, as the
      // earlier bumps intended.
      version: 5,
      migrate: (persisted, version) => {
        const schemas =
          (persisted as { schemas?: Record<string, ConnectorSchemaResponse> })
            ?.schemas ?? {};
        return {
          schemas:
            version < 4
              ? {}
              : Object.fromEntries(
                  Object.entries(schemas).filter(
                    ([key]) => !isWorkspaceType(key),
                  ),
                ),
        };
      },
      partialize: state => ({ schemas: state.schemas }), // Only persist schemas, not types
    },
  ),
);
