/**
 * DbtLineageView — DAG of the project's manifest parent_map, layered
 * left-to-right (sources → staging → marts). Node color reflects last-run
 * status; clicking a model node opens its file tab.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Link,
  Typography,
  useTheme,
} from "@mui/material";
import { X as CloseIcon, ExternalLink as OpenIcon } from "lucide-react";
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
import {
  useDbtStore,
  type DbtLineage,
  type DbtLineageNode,
} from "../store/dbtStore";
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

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
      if (resourceType === "exposure") return theme.palette.secondary.main;
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
          borderRadius: node.resourceType === "exposure" ? 22 : 8,
          border: `2px ${node.resourceType === "exposure" ? "dashed" : "solid"} ${colorFor(node.lastStatus, node.resourceType)}`,
          background:
            node.id === selectedNodeId
              ? theme.palette.action.selected
              : theme.palette.background.paper,
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
  }, [lineage, theme, selectedNodeId]);

  const handleNodeClick = useCallback((_event: unknown, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const selectedNode: DbtLineageNode | undefined = useMemo(
    () => lineage?.nodes.find(n => n.id === selectedNodeId),
    [lineage, selectedNodeId],
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
    <Box sx={{ height: "100%", width: "100%", display: "flex" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
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
      {selectedNode && (
        <Box
          sx={{
            width: 320,
            flexShrink: 0,
            borderLeft: "1px solid",
            borderColor: "divider",
            overflow: "auto",
            p: 2,
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              mb: 1,
            }}
          >
            <Typography variant="subtitle2" sx={{ wordBreak: "break-word" }}>
              {selectedNode.name}
            </Typography>
            <IconButton size="small" onClick={() => setSelectedNodeId(null)}>
              <CloseIcon size={16} />
            </IconButton>
          </Box>
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mb: 1.5 }}>
            <Chip size="small" label={selectedNode.resourceType} />
            {selectedNode.materialized && (
              <Chip
                size="small"
                variant="outlined"
                label={selectedNode.materialized}
              />
            )}
            {selectedNode.lastStatus && (
              <Chip
                size="small"
                variant="outlined"
                label={selectedNode.lastStatus}
              />
            )}
            {selectedNode.tags?.map(tag => (
              <Chip key={tag} size="small" variant="outlined" label={tag} />
            ))}
          </Box>

          {selectedNode.description ? (
            <Typography variant="body2" sx={{ mb: 1.5 }}>
              {selectedNode.description}
            </Typography>
          ) : (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 1.5 }}
            >
              No description in the manifest.
            </Typography>
          )}

          {selectedNode.owner && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 0.5 }}
            >
              Owner: {selectedNode.owner}
            </Typography>
          )}
          {selectedNode.url && (
            <Link
              href={selectedNode.url}
              target="_blank"
              rel="noopener"
              variant="caption"
              sx={{ display: "block", mb: 1.5 }}
            >
              {selectedNode.url}
            </Link>
          )}

          {selectedNode.columns && selectedNode.columns.length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontWeight: 600 }}
              >
                Columns ({selectedNode.columns.length})
              </Typography>
              <Box sx={{ mt: 0.5 }}>
                {selectedNode.columns.map(col => (
                  <Box key={col.name} sx={{ mb: 0.75 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600 }}>
                      {col.name}
                      {col.type ? (
                        <Box
                          component="span"
                          sx={{ color: "text.secondary", fontWeight: 400 }}
                        >
                          {" "}
                          · {col.type}
                        </Box>
                      ) : null}
                    </Typography>
                    {col.description && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: "block" }}
                      >
                        {col.description}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Box>
            </>
          )}

          {selectedNode.filePath && (
            <Button
              size="small"
              variant="outlined"
              fullWidth
              startIcon={<OpenIcon size={14} />}
              onClick={() => {
                if (selectedNode.filePath) {
                  focusDbtFileTab(projectId, selectedNode.filePath);
                }
              }}
              sx={{ mt: 1.5 }}
            >
              Open file
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}
