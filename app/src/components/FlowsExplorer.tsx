import { useEffect, useMemo, useState } from "react";
import {
  Box,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Tooltip,
  Skeleton,
  Menu,
  MenuItem,
} from "@mui/material";
import {
  Plus as AddIcon,
  CirclePause as PauseIcon,
  Clock as ScheduleIcon,
  RotateCw as RefreshIcon,
  Webhook as WebhookIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useConsoleStore } from "../store/consoleStore";
import ResourceTree, {
  type ResourceTreeNode,
  type ResourceTreeSection,
} from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

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
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const flows = useMemo(
    () => (currentWorkspace ? flowsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, flowsMap],
  );
  const isLoading = currentWorkspace
    ? !!loadingMap[currentWorkspace.id]
    : false;
  const error = currentWorkspace ? errorMap[currentWorkspace.id] || null : null;

  const { tabs, activeTabId, openTab, setActiveTab } = useConsoleStore();
  const consoleTabs = Object.values(tabs);
  const activeConsoleId = activeTabId;

  useEffect(() => {
    if (currentWorkspace) {
      init(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, init]);

  const handleRefresh = async () => {
    if (currentWorkspace?.id) {
      await refresh(currentWorkspace.id);
    }
  };

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const handleCreateNew = (
    flowType: "scheduled" | "webhook" | "db-scheduled",
  ) => {
    const title =
      flowType === "scheduled"
        ? "New Scheduled Flow"
        : flowType === "webhook"
          ? "New Webhook Flow"
          : "New Database Sync";
    const id = openTab({
      title,
      content: "",
      kind: "flow-editor",
      metadata: { isNew: true, flowType },
    });
    setActiveTab(id);
    handleMenuClose();
  };

  const handleEditFlow = (flowId: string) => {
    selectFlow(flowId);
    const flow = flows.find(f => f._id === flowId);
    if (flow) {
      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        (tab: any) => tab.metadata?.flowId === flowId,
      );

      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        const id = openTab({
          title: getFlowTitle(flow),
          content: "",
          kind: "flow-editor",
          metadata: {
            flowId,
            isNew: false,
            flowType:
              flow.sourceType === "database" ? "db-scheduled" : flow.type,
            enabled:
              flow.type === "webhook"
                ? flow.webhookConfig?.enabled
                : flow.schedule?.enabled,
          },
        });
        setActiveTab(id);
      }
    }
  };

  const getFlowTitle = (flow: any): string => {
    if (flow.sourceType === "database") {
      const destName = flow.tableDestination?.tableName || "Table";
      return `Query → ${destName}`;
    }
    const sourceName = flow.dataSourceId?.name || "Source";
    const destName = flow.destinationDatabaseId?.name || "Destination";
    return `${sourceName} → ${destName}`;
  };

  const getFlowStatus = (flow: any) => {
    const isEnabled =
      flow.type === "webhook"
        ? flow.webhookConfig?.enabled !== false
        : flow.schedule?.enabled === true;
    if (!isEnabled) {
      return {
        label: "Disabled",
        color: "default" as const,
        letter: "D",
      };
    }
    if (flow.lastError) {
      return {
        label: "Failed",
        color: "error" as const,
        letter: "F",
      };
    }
    if (flow.lastSuccessAt) {
      return {
        label: "Success",
        color: "success" as const,
        letter: "S",
      };
    }
    return {
      label: "Pending",
      color: "warning" as const,
      letter: "A",
    };
  };

  const flowById = useMemo(() => {
    const map = new Map<string, any>();
    for (const flow of flows) {
      map.set(flow._id, flow);
    }
    return map;
  }, [flows]);

  const sections = useMemo<ResourceTreeSection[]>(() => {
    return [
      {
        key: "flows",
        label: "",
        hideSectionHeader: true,
        nodes: flows.map(flow => ({
          id: flow._id,
          name: getFlowTitle(flow),
          path: getFlowTitle(flow),
          isDirectory: false,
        })),
      },
    ];
  }, [flows]);

  const getItemIcon = (node: ResourceTreeNode) => {
    const flow = flowById.get(node.id);
    if (!flow) return null;
    if (flow.type === "webhook") {
      return (
        <WebhookIcon
          size={20}
          strokeWidth={1.5}
          style={{
            color:
              flow.webhookConfig?.enabled !== false
                ? undefined
                : "var(--mui-palette-text-disabled)",
          }}
        />
      );
    }
    if (flow.schedule?.enabled === true) {
      return <ScheduleIcon size={20} strokeWidth={1.5} />;
    }
    return (
      <PauseIcon
        size={20}
        strokeWidth={1.5}
        style={{ color: "var(--mui-palette-text-disabled)" }}
      />
    );
  };

  const getRightAdornment = (node: ResourceTreeNode) => {
    const flow = flowById.get(node.id);
    if (!flow) return null;
    const status = getFlowStatus(flow);
    return (
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        <Tooltip
          title={
            flow.syncMode === "incremental" ? "Incremental Sync" : "Full Sync"
          }
        >
          <Typography
            variant="caption"
            sx={{
              fontWeight: "bold",
              color: "text.secondary",
              cursor: "help",
            }}
          >
            {flow.syncMode === "incremental" ? "I" : "F"}
          </Typography>
        </Tooltip>
        <Tooltip title={status.label}>
          <Typography
            variant="caption"
            sx={{
              fontWeight: "bold",
              color:
                status.letter === "S"
                  ? "success.main"
                  : status.letter === "F"
                    ? "error.main"
                    : status.letter === "A"
                      ? "warning.main"
                      : "text.disabled",
              cursor: "help",
            }}
          >
            {status.letter}
          </Typography>
        </Tooltip>
      </Box>
    );
  };

  const activeFlowTabId = useMemo(() => {
    const tab = consoleTabs.find(
      (t: any) =>
        t.id === activeConsoleId &&
        t.kind === "flow-editor" &&
        t.metadata?.flowId,
    );
    return (tab as any)?.metadata?.flowId ?? null;
  }, [consoleTabs, activeConsoleId]);

  const renderSkeletonItems = () => (
    <List dense>
      {Array.from({ length: 3 }).map((_, index) => (
        <ListItem key={`skeleton-${index}`} disablePadding>
          <ListItemButton disabled>
            <ListItemText
              primary={
                <Skeleton
                  variant="text"
                  width={`${60 + Math.random() * 40}%`}
                  height={20}
                />
              }
              secondary={
                <Box
                  component="span"
                  sx={{
                    display: "inline-flex",
                    gap: 0.5,
                    alignItems: "center",
                  }}
                >
                  <Skeleton variant="text" width={120} height={16} />
                  <Skeleton
                    variant="rectangular"
                    width={50}
                    height={16}
                    sx={{ borderRadius: 1 }}
                  />
                </Box>
              }
            />
          </ListItemButton>
        </ListItem>
      ))}
    </List>
  );

  const actions = (
    <>
      <Tooltip title="Add Flow">
        <IconButton size="small" onClick={handleMenuOpen}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={handleRefresh} disabled={isLoading}>
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Flows"
        actions={actions}
        searchPlaceholder="Search flows..."
        error={error}
        onErrorClose={() => {
          if (currentWorkspace?.id) clearError(currentWorkspace.id);
        }}
        loading={isLoading && flows.length === 0}
        skeleton={renderSkeletonItems()}
      >
        {({ searchQuery }) =>
          flows.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
              <Typography variant="body2">No flows configured.</Typography>
            </Box>
          ) : (
            <ResourceTree
              sections={sections}
              mode="sidebar"
              searchQuery={searchQuery}
              activeItemId={activeFlowTabId || undefined}
              getItemIcon={getItemIcon}
              getRightAdornment={getRightAdornment}
              hideFolderIcon
              isFolderExpanded={() => true}
              onToggleFolder={() => {}}
              onExpandFolder={() => {}}
              getFolderExpansionKey={node => node.id}
              onItemClick={node => handleEditFlow(node.id)}
            />
          )
        }
      </ExplorerShell>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
      >
        <MenuItem onClick={() => handleCreateNew("db-scheduled")}>
          <ListItemIcon>
            <ScheduleIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Database Sync</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleCreateNew("scheduled")}>
          <ListItemIcon>
            <ScheduleIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Connector Sync</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleCreateNew("webhook")}>
          <ListItemIcon>
            <WebhookIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Webhook Sync</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
