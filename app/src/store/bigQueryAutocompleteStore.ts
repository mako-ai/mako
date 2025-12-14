import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";

export interface BigQueryColumnInfo {
  name: string;
  type: string;
}

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const now = () => Date.now();

const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_DATASET_KEYS = 50;
const MAX_TABLE_KEYS = 200;
const MAX_COLUMN_KEYS = 100;

function isFresh(entry: CacheEntry<any> | undefined) {
  if (!entry) return false;
  return now() - entry.fetchedAt < MAX_CACHE_AGE_MS;
}

function pruneCache<T>(
  cache: Record<string, CacheEntry<T>>,
  maxKeys: number,
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache);
  if (keys.length <= maxKeys) return cache;

  const sorted = keys
    .map(k => ({ k, t: cache[k]?.fetchedAt || 0 }))
    .sort((a, b) => a.t - b.t);

  const toDelete = sorted.slice(0, Math.max(0, keys.length - maxKeys));
  const next = { ...cache };
  toDelete.forEach(({ k }) => {
    delete next[k];
  });
  return next;
}

const inFlight = new Map<string, Promise<any>>();

function makeKey(parts: Array<string | number | undefined>) {
  return parts.map(p => String(p ?? "")).join("|");
}

interface BigQueryAutocompleteState {
  datasets: Record<string, CacheEntry<string[]>>; // key: conn|prefix|limit
  tables: Record<string, CacheEntry<string[]>>; // key: conn|dataset|prefix|limit
  columns: Record<string, CacheEntry<BigQueryColumnInfo[]>>; // key: conn|dataset|table

  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  fetchDatasets: (args: {
    workspaceId: string;
    connectionId: string;
    prefix?: string;
    limit?: number;
  }) => Promise<string[]>;

  fetchTables: (args: {
    workspaceId: string;
    connectionId: string;
    datasetId: string;
    prefix?: string;
    limit?: number;
  }) => Promise<string[]>;

  fetchColumns: (args: {
    workspaceId: string;
    connectionId: string;
    datasetId: string;
    tableId: string;
  }) => Promise<BigQueryColumnInfo[]>;
}

export const useBigQueryAutocompleteStore = create<BigQueryAutocompleteState>()(
  persist(
    immer((set, get) => ({
      datasets: {},
      tables: {},
      columns: {},
      loading: {},
      error: {},

      fetchDatasets: async ({ workspaceId, connectionId, prefix, limit }) => {
        const effectivePrefix = String(prefix || "");
        const effectiveLimit = clamp(Number(limit || 100), 1, 200);
        const key = makeKey([
          "datasets",
          connectionId,
          effectivePrefix,
          effectiveLimit,
        ]);

        const cached = get().datasets[key];
        if (isFresh(cached)) return cached.value;

        const inflightKey = `bq:${key}`;
        const existing = inFlight.get(inflightKey);
        if (existing) return (await existing) as string[];

        set(s => {
          s.loading[inflightKey] = true;
          s.error[inflightKey] = null;
        });

        const promise = (async () => {
          try {
            const params = new URLSearchParams();
            if (effectivePrefix) params.set("prefix", effectivePrefix);
            params.set("limit", String(effectiveLimit));

            const res = await apiClient.get<{
              success: boolean;
              data: { kind: "datasets"; datasets: string[] };
            }>(
              `/workspaces/${workspaceId}/databases/${connectionId}/autocomplete?${params.toString()}`,
            );

            const datasets = res.success
              ? ((res as any).data.datasets as string[])
              : [];

            set(s => {
              s.datasets[key] = { value: datasets, fetchedAt: now() };
              s.datasets = pruneCache(s.datasets, MAX_DATASET_KEYS);
            });

            return datasets;
          } catch (e: any) {
            set(s => {
              s.error[inflightKey] =
                e?.message || "Failed to fetch BigQuery datasets";
            });
            return [];
          } finally {
            set(s => {
              delete s.loading[inflightKey];
            });
            inFlight.delete(inflightKey);
          }
        })();

        inFlight.set(inflightKey, promise);
        return await promise;
      },

      fetchTables: async ({
        workspaceId,
        connectionId,
        datasetId,
        prefix,
        limit,
      }) => {
        const effectivePrefix = String(prefix || "");
        const effectiveLimit = clamp(Number(limit || 100), 1, 200);
        const key = makeKey([
          "tables",
          connectionId,
          datasetId,
          effectivePrefix,
          effectiveLimit,
        ]);

        const cached = get().tables[key];
        if (isFresh(cached)) return cached.value;

        const inflightKey = `bq:${key}`;
        const existing = inFlight.get(inflightKey);
        if (existing) return (await existing) as string[];

        set(s => {
          s.loading[inflightKey] = true;
          s.error[inflightKey] = null;
        });

        const promise = (async () => {
          try {
            const params = new URLSearchParams();
            params.set("datasetId", datasetId);
            if (effectivePrefix) params.set("prefix", effectivePrefix);
            params.set("limit", String(effectiveLimit));

            const res = await apiClient.get<{
              success: boolean;
              data: { kind: "tables"; datasetId: string; tables: string[] };
            }>(
              `/workspaces/${workspaceId}/databases/${connectionId}/autocomplete?${params.toString()}`,
            );

            const tables = res.success
              ? ((res as any).data.tables as string[])
              : [];

            set(s => {
              s.tables[key] = { value: tables, fetchedAt: now() };
              s.tables = pruneCache(s.tables, MAX_TABLE_KEYS);
            });

            return tables;
          } catch (e: any) {
            set(s => {
              s.error[inflightKey] =
                e?.message || "Failed to fetch BigQuery tables";
            });
            return [];
          } finally {
            set(s => {
              delete s.loading[inflightKey];
            });
            inFlight.delete(inflightKey);
          }
        })();

        inFlight.set(inflightKey, promise);
        return await promise;
      },

      fetchColumns: async ({
        workspaceId,
        connectionId,
        datasetId,
        tableId,
      }) => {
        const key = makeKey(["columns", connectionId, datasetId, tableId]);

        const cached = get().columns[key];
        if (isFresh(cached)) return cached.value;

        const inflightKey = `bq:${key}`;
        const existing = inFlight.get(inflightKey);
        if (existing) return (await existing) as BigQueryColumnInfo[];

        set(s => {
          s.loading[inflightKey] = true;
          s.error[inflightKey] = null;
        });

        const promise = (async () => {
          try {
            const params = new URLSearchParams();
            params.set("datasetId", datasetId);
            params.set("tableId", tableId);
            // Fetch a bounded set of columns; server also enforces limits.
            params.set("limit", "200");

            const res = await apiClient.get<{
              success: boolean;
              data: {
                kind: "columns";
                datasetId: string;
                tableId: string;
                columns: BigQueryColumnInfo[];
              };
            }>(
              `/workspaces/${workspaceId}/databases/${connectionId}/autocomplete?${params.toString()}`,
            );

            const columns = res.success
              ? ((res as any).data.columns as BigQueryColumnInfo[]) || []
              : [];

            set(s => {
              s.columns[key] = { value: columns, fetchedAt: now() };
              s.columns = pruneCache(s.columns, MAX_COLUMN_KEYS);
            });

            return columns;
          } catch (e: any) {
            set(s => {
              s.error[inflightKey] =
                e?.message || "Failed to fetch BigQuery columns";
            });
            return [];
          } finally {
            set(s => {
              delete s.loading[inflightKey];
            });
            inFlight.delete(inflightKey);
          }
        })();

        inFlight.set(inflightKey, promise);
        return await promise;
      },
    })),
    {
      name: "bigquery-autocomplete-store",
      version: 1,
      partialize: state => ({
        datasets: state.datasets,
        tables: state.tables,
        columns: state.columns,
      }),
    },
  ),
);
