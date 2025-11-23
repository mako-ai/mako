import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";

export interface TreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren?: boolean;
  icon?: string;
  metadata?: any;
}

type NodeKey = string; // e.g., "root" or `${kind}:${id}`

interface DatabaseContentState {
  nodes: Record<string, Record<NodeKey, TreeNode[]>>; // dbId -> nodeKey -> children
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  fetchRoot: (workspaceId: string, databaseId: string) => Promise<TreeNode[]>;
  fetchChildren: (
    workspaceId: string,
    databaseId: string,
    node: { id: string; kind: string; metadata?: any },
  ) => Promise<TreeNode[]>;
  fetchConsoleTemplate: (
    workspaceId: string,
    databaseId: string,
    node?: { id: string; kind: string; metadata?: any },
  ) => Promise<{ language: string; template: string } | null>;
}

function makeNodeKey(node?: { id: string; kind: string }): NodeKey {
  if (!node) return "root";
  return `${node.kind}:${node.id}`;
}

export const useDatabaseContentStore = create<DatabaseContentState>()(
  persist(
    immer((set, get) => ({
      nodes: {},
      loading: {},
      error: {},

      async fetchRoot(workspaceId, databaseId) {
        const key = `${databaseId}:root`;
        set(s => {
          s.loading[key] = true;
          s.error[key] = null;
        });
        try {
          const res = await apiClient.get<{
            success: boolean;
            data: TreeNode[];
          }>(`/workspaces/${workspaceId}/databases/${databaseId}/tree`);
          const data = res.success ? (res as any).data : [];
          set(s => {
            s.nodes[databaseId] = s.nodes[databaseId] || {};
            s.nodes[databaseId]["root"] = data;
          });
          return data;
        } catch (e: any) {
          set(s => {
            s.error[key] = e?.message || "Failed to load tree";
          });
          return [];
        } finally {
          set(s => {
            delete s.loading[key];
          });
        }
      },

      async fetchChildren(workspaceId, databaseId, node) {
        const nodeKey = makeNodeKey(node);
        const key = `${databaseId}:${nodeKey}`;
        set(s => {
          s.loading[key] = true;
          s.error[key] = null;
        });
        try {
          const params = new URLSearchParams();
          params.set("nodeId", node.id);
          params.set("kind", node.kind);
          if (node.metadata) {
            params.set("metadata", JSON.stringify(node.metadata));
          }
          const res = await apiClient.get<{
            success: boolean;
            data: TreeNode[];
          }>(
            `/workspaces/${workspaceId}/databases/${databaseId}/tree?${params.toString()}`,
          );
          const data = res.success ? (res as any).data : [];
          set(s => {
            s.nodes[databaseId] = s.nodes[databaseId] || {};
            s.nodes[databaseId][nodeKey] = data;
          });
          return data;
        } catch (e: any) {
          set(s => {
            s.error[key] = e?.message || "Failed to load children";
          });
          return [];
        } finally {
          set(s => {
            delete s.loading[key];
          });
        }
      },

      async fetchConsoleTemplate(workspaceId, databaseId, node) {
        try {
          const params: Record<string, string> = {};
          if (node) {
            params.nodeId = node.id;
            params.kind = node.kind;
            if (node.metadata) params.metadata = JSON.stringify(node.metadata);
          }
          const res = await apiClient.get<{
            success: boolean;
            data: { language: string; template: string };
          }>(
            `/workspaces/${workspaceId}/databases/${databaseId}/console-template`,
            params,
          );
          if (res.success) {
            return (res as any).data;
          }
        } catch (e) {
          // noop; let caller fallback
        }
        return null;
      },
    })),
    {
      name: "database-content-store",
      partialize: state => ({ nodes: state.nodes }),
    },
  ),
);
