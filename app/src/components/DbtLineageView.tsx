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
  InputAdornment,
  Link,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import {
  X as CloseIcon,
  ExternalLink as OpenIcon,
  Filter as FilterIcon,
} from "lucide-react";
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

/**
 * One comma-separated piece of a dbt graph selector, e.g. `2+stg_orders+`.
 * `degree === null` means unbounded (`+`), `0` means "no graph traversal in
 * this direction", and `N` means N hops.
 */
interface SelectorSpec {
  upstream: number | null;
  downstream: number | null;
  match: (node: DbtLineageNode) => boolean;
}

function parseSelectorPart(raw: string): SelectorSpec | null {
  let s = raw.trim();
  if (!s) return null;

  let upstream: number | null = 0;
  let downstream: number | null = 0;

  const up = s.match(/^(\d*)\+/);
  if (up) {
    upstream = up[1] === "" ? null : Number(up[1]);
    s = s.slice(up[0].length);
  }
  const down = s.match(/\+(\d*)$/);
  if (down) {
    downstream = down[1] === "" ? null : Number(down[1]);
    s = s.slice(0, s.length - down[0].length);
  }

  const core = s.trim();
  if (!core) return null;

  let match: (node: DbtLineageNode) => boolean;
  if (core.startsWith("tag:")) {
    const tag = core.slice(4).toLowerCase();
    match = node => !!node.tags?.some(t => t.toLowerCase() === tag);
  } else if (core.startsWith("path:")) {
    const prefix = core.slice(5);
    match = node => !!node.filePath && node.filePath.startsWith(prefix);
  } else {
    const lower = core.toLowerCase();
    match = node =>
      node.name.toLowerCase() === lower ||
      node.id.toLowerCase().endsWith(`.${lower}`);
  }
  return { upstream, downstream, match };
}

/** Traverse `adjacency` from `seed` up to `degree` hops, adding ids to `out`. */
function traverse(
  seed: string,
  adjacency: Map<string, string[]>,
  degree: number | null,
  out: Set<string>,
): void {
  if (degree === 0) return;
  const seen = new Set<string>([seed]);
  let frontier = [seed];
  let depth = 0;
  while (frontier.length > 0) {
    if (degree !== null && depth >= degree) break;
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          out.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
}

/**
 * Resolve a dbt-style selector (`+model+`, `2+model`, `tag:x`, `path:models/`,
 * comma = union) to the visible node ids, or `null` for "show everything".
 */
function resolveSelector(
  lineage: DbtLineage,
  selector: string,
): Set<string> | null {
  const specs = selector
    .split(",")
    .map(parseSelectorPart)
    .filter((s): s is SelectorSpec => s !== null);
  if (specs.length === 0) return null;

  const childrenMap = new Map<string, string[]>();
  const parentsMap = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const edge of lineage.edges) {
    push(childrenMap, edge.source, edge.target);
    push(parentsMap, edge.target, edge.source);
  }

  const result = new Set<string>();
  for (const spec of specs) {
    for (const node of lineage.nodes) {
      if (!spec.match(node)) continue;
      result.add(node.id);
      traverse(node.id, parentsMap, spec.upstream, result);
      traverse(node.id, childrenMap, spec.downstream, result);
    }
  }
  return result;
}

export default function DbtLineageView({ projectId }: { projectId: string }) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const theme = useTheme();

  const fetchLineage = useDbtStore(s => s.fetchLineage);
  const [lineage, setLineage] = useState<DbtLineage | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectorText, setSelectorText] = useState("");
  const [appliedSelector, setAppliedSelector] = useState("");

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

  // Apply the dbt graph selector (client-side BFS over the fetched DAG).
  const visibleLineage = useMemo<DbtLineage | null>(() => {
    if (!lineage) return null;
    const selected = resolveSelector(lineage, appliedSelector);
    if (!selected) return lineage;
    const nodes = lineage.nodes.filter(n => selected.has(n.id));
    const edges = lineage.edges.filter(
      e => selected.has(e.source) && selected.has(e.target),
    );
    return { ...lineage, nodes, edges };
  }, [lineage, appliedSelector]);

  const applySelector = useCallback(() => {
    setAppliedSelector(selectorText.trim());
  }, [selectorText]);

  const clearSelector = useCallback(() => {
    setSelectorText("");
    setAppliedSelector("");
  }, []);

  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (!visibleLineage || visibleLineage.nodes.length === 0) {
      return { nodes: [], edges: [] };
    }
    const layers = computeLayers(visibleLineage);
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

    const flowNodes: Node[] = visibleLineage.nodes.map(node => {
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

    const flowEdges: Edge[] = visibleLineage.edges.map(edge => ({
      id: `${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      animated: false,
      style: { stroke: theme.palette.divider },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [visibleLineage, theme, selectedNodeId]);

  const handleNodeClick = useCallback((_event: unknown, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const selectedNode: DbtLineageNode | undefined = useMemo(
    () => visibleLineage?.nodes.find(n => n.id === selectedNodeId),
    [visibleLineage, selectedNodeId],
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

  const totalCount = lineage.nodes.length;
  const visibleCount = visibleLineage?.nodes.length ?? 0;

  return (
    <Box sx={{ height: "100%", width: "100%", display: "flex" }}>
      <Box
        sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <TextField
            size="small"
            fullWidth
            placeholder="Graph selector — e.g. +stg_orders+, 2+orders, tag:nightly, path:models/staging"
            value={selectorText}
            onChange={e => setSelectorText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") applySelector();
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <FilterIcon size={14} />
                </InputAdornment>
              ),
              sx: { fontSize: "0.8rem" },
            }}
          />
          <Tooltip title="Focus the graph on the selected nodes">
            <span>
              <Button size="small" variant="outlined" onClick={applySelector}>
                Update graph
              </Button>
            </span>
          </Tooltip>
          {appliedSelector && (
            <Button size="small" onClick={clearSelector}>
              Clear
            </Button>
          )}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ whiteSpace: "nowrap" }}
          >
            {appliedSelector
              ? `${visibleCount} / ${totalCount}`
              : `${totalCount} nodes`}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0 }}>
          {visibleCount === 0 ? (
            <Box sx={{ p: 3, color: "text.secondary" }}>
              <Typography variant="body2">
                No nodes match <Box component="code">{appliedSelector}</Box>.
                Try another selector or clear it.
              </Typography>
            </Box>
          ) : (
            <ReactFlow
              key={appliedSelector || "all"}
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
          )}
        </Box>
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
