import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";

export interface DatabaseTypeItem {
  type: string;
  displayName: string;
  consoleLanguage: string;
  iconUrl: string;
  defaultTemplate?: string;
}

export interface FieldSchema {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "password" | "textarea" | "select";
  required?: boolean;
  default?: any;
  helperText?: string;
  placeholder?: string;
  rows?: number;
  options?: Array<{ label: string; value: any }>;
  path?: string;
  advanced?: boolean;
  group?: string;
  visibleWhen?: { field: string; equals: unknown };
}

export interface DatabaseSchemaResponse {
  fields: FieldSchema[];
}

interface CatalogResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface CatalogState {
  types: DatabaseTypeItem[] | null;
  schemas: Record<string, DatabaseSchemaResponse>;
  loading: boolean;
  error: string | null;
  fetchTypes: (force?: boolean) => Promise<void>;
  fetchSchema: (
    type: string,
    force?: boolean,
  ) => Promise<DatabaseSchemaResponse | null>;
}

export const useDatabaseCatalogStore = create<CatalogState>()(
  persist(
    immer((set, get) => ({
      types: null,
      schemas: {},
      loading: false,
      error: null,
      fetchTypes: async (force = false) => {
        const state = get();
        if (state.types && !force) return;
        set(s => {
          s.loading = true;
          s.error = null;
        });
        try {
          const data =
            await apiClient.get<CatalogResponse<DatabaseTypeItem[]>>(
              "/databases/types",
            );
          if (data.success) {
            set(s => {
              s.types = data.data;
              s.loading = false;
            });
          } else {
            set(s => {
              s.error = data.error || "Failed to load database types";
              s.loading = false;
            });
          }
        } catch (err: any) {
          set(s => {
            s.error = err?.message || "Failed to load database types";
            s.loading = false;
          });
        }
      },
      fetchSchema: async (type: string, force = false) => {
        const state = get();
        if (state.schemas[type] && !force) return state.schemas[type];
        try {
          const res = await apiClient.get<
            CatalogResponse<DatabaseSchemaResponse>
          >(`/databases/${type}/schema`);
          if (res.success) {
            set(s => {
              s.schemas[type] = res.data;
            });
            return res.data;
          }
        } catch (err) {
          console.error("Failed to fetch database schema", err);
        }
        return null;
      },
    })),
    { name: "database-catalog-store", version: 3 },
  ),
);
