/**
 * DbtLineageView — DAG of the project's manifest parent_map, layered
 * left-to-right (sources → staging → marts). Node color reflects last-run
 * status; clicking a model node opens its file tab.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, CircularProgress, Typography, useTheme } from "@mui/material";
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkspace } from "../contexts/workspace-context";
import { useDbtStore, type DbtLineage } from "../store/dbtStore";
import { focusDbtFileTab } from "../dbt-runtime/shell";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 44;
const COLUMN_GAP = 90;
const ROW_GAP = 24;

/** Longest-path layering: column = max(parent column) + 1. */
function computeLayers(lineage: DbtLineage): Map<string, number> {
  const parents = new Map<string, string[]>();
  for (const node of lineage.nodes) parents.set(node.id, []);
  for (const edge of lineage.edges) {
    parents.get(edge.target)?.push(edge.source);
  }

  const layers = new Map<string, number>();
  const visiting = new Set<string>();

  const layerOf = (id: string): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard — manifests are acyclic
    visiting.add(id);
    const nodeParents = parents.get(id) ?? [];
    const layer =
      nodeParents.length === 0 ? 0 : Math.max(...nodeParents.map(layerOf)) + 1;
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  };

  for (const node of lineage.nodes) layerOf(node.id);
  return layers;
}

export default function DbtLineageView({ projectId }: { projectId: string }) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const theme = useTheme();

  const fetchLineage = useDbtStore(s => s.fetchLineage);
  const [lineage, setLineage] = useState<DbtLineage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    void fetchLineage(workspaceId, projectId).then(result => {
      if (!cancelled) {
        setLineage(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, projectId, fetchLineage]);

  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (!lineage || lineage.nodes.length === 0) {
      return { nodes: [], edges: [] };
    }
    const layers = computeLayers(lineage);
    const rowsPerLayer = new Map<number, number>();

    const colorFor = (status?: string, resourceType?: string) => {
      if (status === "success" || status === "pass") {
        return theme.palette.success.main;
      }
      if (status === "error" || status === "fail") {
        return theme.palette.error.main;
      }
      if (resourceType === "source") return theme.palette.info.main;
      return theme.palette.divider;
    };

    const flowNodes: Node[] = lineage.nodes.map(node => {
      const layer = layers.get(node.id) ?? 0;
      const row = rowsPerLayer.get(layer) ?? 0;
      rowsPerLayer.set(layer, row + 1);
      return {
        id: node.id,
        position: {
          x: layer * (NODE_WIDTH + COLUMN_GAP),
          y: row * (NODE_HEIGHT + ROW_GAP),
        },
        data: { label: node.name },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          fontSize: 12,
          borderRadius: 8,
          border: `2px solid ${colorFor(node.lastStatus, node.resourceType)}`,
          background: theme.palette.background.paper,
          color: theme.palette.text.primary,
        },
      };
    });

    const flowEdges: Edge[] = lineage.edges.map(edge => ({
      id: `${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      animated: false,
      style: { stroke: theme.palette.divider },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [lineage, theme]);

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      const meta = lineage?.nodes.find(n => n.id === node.id);
      if (meta?.filePath) {
        focusDbtFileTab(projectId, meta.filePath);
      }
    },
    [lineage, projectId],
  );

  if (loading) {
    return (
      <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (!lineage || lineage.nodes.length === 0) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">
          No lineage yet — run the project once (dbt builds the manifest during
          a run) and refresh.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", width: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={handleNodeClick}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        colorMode={theme.palette.mode === "dark" ? "dark" : "light"}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Box>
  );
}
