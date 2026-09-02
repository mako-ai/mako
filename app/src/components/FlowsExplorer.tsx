import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Activity as CdcIcon,
  Clock3 as ScheduleIcon,
  Database as DatabaseIcon,
  Plus as AddIcon,
  RotateCw as RefreshIcon,
  SquareTerminal as ConsoleIcon,
  Webhook as WebhookIcon,
} from "lucide-react";
import { apiClient } from "../lib/api-client";
import type {
  ScheduledQueryListItem,
  ScheduledQueryListResponse,
} from "../lib/api-types";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useConsoleStore } from "../store/consoleStore";
import { focusFlowTab, getFlowTitle } from "../flow-runtime/shell";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import MobileExplorerBack from "./MobileExplorerBack";

interface FlowTreeNode extends ResourceTreeNode {
  itemType: "flow" | "scheduled-query";
  flowId?: string;
  consoleId?: string;
  flowKind?: "connector" | "webhook" | "db-sync" | "cdc";
  /** Unified IA: which triggers drive this sync (for the row icon). */
  triggerKind?: "schedule" | "webhook" | "hybrid";
}

const noopIsExpanded = () => false;
const noopToggle = () => undefined;

const classifyFlow = (flow: any): FlowTreeNode["flowKind"] => {
  if (flow.syncEngine === "cdc") return "cdc";
  if (flow.type === "webhook") return "webhook";
  if (flow.sourceType === "database") return "db-sync";
  return "connector";
};

/**
 * Unified IA: triggers are properties of one Sync, not separate flow types.
 * A webhook flow with an enabled poll cron is a hybrid.
 */
const classifyTriggers = (flow: any): FlowTreeNode["triggerKind"] => {
  const hasWebhook =
    flow.webhookConfig?.enabled === true &&
    typeof flow.webhookConfig?.endpoint === "string" &&
    flow.webhookConfig.endpoint.length > 0;
  // The periodic full reconcile (backfillSchedule) is a cron cadence too —
  // migrated legacy full-refresh syncs run on it exclusively.
  const hasSchedule =
    (flow.schedule?.enabled === true && Boolean(flow.schedule?.cron)) ||
    (flow.backfillSchedule?.enabled === true &&
      Boolean(flow.backfillSchedule?.cron));
  if (hasWebhook && hasSchedule) return "hybrid";
  if (hasWebhook) return "webhook";
  return "schedule";
};

export function FlowsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const {
    flows: flowsMap,
    loading: loadingMap,
    error: errorMap,
    init,
    refresh,
    selectFlow,
    clearError,
  } = useFlowStore();
  const { tabs, activeTabId, openTab, setActiveTab, loadConsole } =
    useConsoleStore();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [scheduledQueries, setScheduledQueries] = useState<
    ScheduledQueryListItem[]
  >([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [scheduledError, setScheduledError] = useState<string | null>(null);

  const workspaceId = currentWorkspace?.id;
  const flows = useMemo(
    () => (workspaceId ? flowsMap[workspaceId] || [] : []),
    [workspaceId, flowsMap],
  );
  const isLoading = workspaceId ? !!loadingMap[workspaceId] : false;
  const error = workspaceId ? errorMap[workspaceId] || null : null;

  const fetchScheduledQueries = useCallback(async () => {
    if (!workspaceId) return;
    setScheduledLoading(true);
    setScheduledError(null);

    try {
      const response = await apiClient.get<ScheduledQueryListResponse>(
        `/workspaces/${workspaceId}/scheduled-queries`,
      );
      setScheduledQueries(response.scheduledQueries || []);
    } catch (err) {
      setScheduledError(
        err instanceof Error ? err.message : "Failed to load scheduled queries",
      );
    } finally {
      setScheduledLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    void init(workspaceId);
    void fetchScheduledQueries();
  }, [workspaceId, init, fetchScheduledQueries]);

  const handleRefresh = async () => {
    if (!workspaceId) return;
    await refresh(workspaceId);
    await fetchScheduledQueries();
  };

  const handleCreateNew = (flowType: "scheduled-query" | "sync") => {
    if (flowType === "scheduled-query") {
      const id = openTab({
        title: "New Scheduled Query",
        content: "",
        metadata: { openScheduleOnSave: true },
      });
      setActiveTab(id);
      setAnchorEl(null);
      return;
    }

    const id = openTab({
      title: "New Sync",
      content: "",
      kind: "flow-editor",
      metadata: { isNew: true, flowType },
    });
    setActiveTab(id);
    setAnchorEl(null);
  };

  const handleFlowClick = (flowId: string) => {
    selectFlow(flowId);
    const flow = flows.find(item => item._id === flowId);
    if (!flow) return;
    focusFlowTab(flow);
  };

  const sections = useMemo(() => {
    const scheduledNodes: FlowTreeNode[] = scheduledQueries.map(query => ({
      id: query.id,
      name: query.name,
      path: query.id,
      isDirectory: false,
      itemType: "scheduled-query",
      consoleId: query.id,
    }));

    // One "Sync" section (triggers/engine are row metadata, not sections)
    // + "Scheduled Queries".
    const syncNodes: FlowTreeNode[] = flows.map(flow => ({
      id: flow._id,
      name: getFlowTitle(flow),
      path: flow._id,
      isDirectory: false,
      itemType: "flow",
      flowId: flow._id,
      flowKind: classifyFlow(flow),
      triggerKind: classifyTriggers(flow),
    }));

    return [
      {
        key: "sync",
        label: "Sync",
        icon: <CdcIcon size={16} strokeWidth={1.5} />,
        nodes: syncNodes,
      },
      {
        key: "scheduled-query",
        label: "Scheduled Queries",
        icon: <ConsoleIcon size={16} strokeWidth={1.5} />,
        nodes: scheduledNodes,
      },
    ].filter(section => section.nodes.length > 0);
  }, [flows, scheduledQueries]);

  const activeItemId = useMemo(() => {
    if (!activeTabId) return null;
    const activeTab = tabs[activeTabId];
    if (!activeTab) return null;
    if (activeTab.kind === "flow-editor" && activeTab.metadata?.flowId) {
      return activeTab.metadata.flowId as string;
    }
    if (activeTab.kind === "console" && activeTab.schedule) {
      return activeTab.id;
    }
    return null;
  }, [activeTabId, tabs]);

  const reveal = useExplorerRevealStore(selectRevealFor("flows"));

  const getItemIcon = useCallback((node: ResourceTreeNode) => {
    const flowNode = node as FlowTreeNode;
    if (flowNode.itemType === "scheduled-query") {
      return <ConsoleIcon size={16} strokeWidth={1.5} />;
    }
    // The row icon reflects the trigger set (schedule / webhook / hybrid)
    // or the database source — never the internal engine.
    if (flowNode.flowKind === "db-sync") {
      return <DatabaseIcon size={16} strokeWidth={1.5} />;
    }
    switch (flowNode.triggerKind) {
      case "webhook":
        return <WebhookIcon size={16} strokeWidth={1.5} />;
      case "hybrid":
        return <CdcIcon size={16} strokeWidth={1.5} />;
      default:
        return <ScheduleIcon size={16} strokeWidth={1.5} />;
    }
  }, []);

  const handleItemClick = async (node: ResourceTreeNode) => {
    const flowNode = node as FlowTreeNode;
    if (!workspaceId) return;

    if (flowNode.itemType === "scheduled-query" && flowNode.consoleId) {
      await loadConsole(workspaceId, flowNode.consoleId, {
        openScheduledRuns: true,
      });
      return;
    }

    if (flowNode.flowId) {
      handleFlowClick(flowNode.flowId);
    }
  };

  const combinedError = error || scheduledError;
  const isBusy = isLoading || scheduledLoading;

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <MobileExplorerBack />
          <Typography
            variant="h6"
            sx={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textTransform: "uppercase",
            }}
          >
            Flows
          </Typography>
          <Box sx={{ display: "flex", gap: 0 }}>
            <Tooltip title="Add Flow">
              <IconButton
                size="small"
                onClick={event => setAnchorEl(event.currentTarget)}
              >
                <AddIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh">
              <IconButton
                size="small"
                onClick={handleRefresh}
                disabled={isBusy}
              >
                <RefreshIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      {combinedError && (
        <Alert
          severity="error"
          onClose={() => {
            if (workspaceId) {
              clearError(workspaceId);
            }
            setScheduledError(null);
          }}
          sx={{ mx: 2, mt: 2 }}
        >
          {combinedError}
        </Alert>
      )}

      <Box sx={{ flexGrow: 1, overflow: "auto" }}>
        {isBusy && sections.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">Loading...</Typography>
          </Box>
        ) : sections.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">No flows configured.</Typography>
          </Box>
        ) : (
          <ResourceTree
            sections={sections}
            mode="sidebar"
            activeItemId={activeItemId}
            revealNodeId={reveal?.nodeId}
            revealNonce={reveal?.nonce}
            getItemIcon={getItemIcon}
            enableDragDrop={false}
            enableRename={false}
            enableDelete={false}
            enableMove={false}
            enableInfo={false}
            enableNewFolder={false}
            onItemClick={node => {
              void handleItemClick(node);
            }}
            isFolderExpanded={noopIsExpanded}
            onToggleFolder={noopToggle}
            onExpandFolder={noopToggle}
            getFolderExpansionKey={node => node.id}
            canManageItem={() => false}
          />
        )}
      </Box>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem onClick={() => handleCreateNew("sync")}>Sync</MenuItem>
        <MenuItem onClick={() => handleCreateNew("scheduled-query")}>
          Scheduled Query
        </MenuItem>
      </Menu>
    </Box>
  );
}
