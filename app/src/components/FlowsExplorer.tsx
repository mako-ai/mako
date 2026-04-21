import { useEffect, useState } from "react";
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
  Alert,
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

  const flows = currentWorkspace ? flowsMap[currentWorkspace.id] || [] : [];
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

  // Helper to get a display title for a flow
  const getFlowTitle = (flow: any): string => {
    if (flow.sourceType === "database") {
      // Database-to-database flow
      const destName = flow.tableDestination?.tableName || "Table";
      return `Query → ${destName}`;
    }
    // Connector flow
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
      letter: "A", // Abandoned/Awaiting
    };
  };

  const renderSkeletonItems = () => {
    return Array.from({ length: 3 }).map((_, index) => (
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
    ));
  };

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Box
        sx={{
          px: 1,
          py: 0.25,
          minHeight: 37,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            height: "100%",
            minHeight: 32,
          }}
        >
          <Typography
            variant="h6"
            sx={{
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
              <IconButton size="small" onClick={handleMenuOpen}>
                <AddIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh">
              <IconButton
                size="small"
                onClick={handleRefresh}
                disabled={isLoading}
              >
                <RefreshIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      {/* Error Alert */}
      {error && (
        <Alert
          severity="error"
          onClose={() =>
            currentWorkspace?.id && clearError(currentWorkspace.id)
          }
          sx={{ mx: 2, mt: 2 }}
        >
          {error}
        </Alert>
      )}

      {/* Flows List */}
      <Box sx={{ flexGrow: 1, overflow: "auto" }}>
        {isLoading && flows.length === 0 ? (
          <List dense>{renderSkeletonItems()}</List>
        ) : flows.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">No flows configured.</Typography>
          </Box>
        ) : (
          <List dense>
            {flows.map(flow => {
              const status = getFlowStatus(flow);
              const isActive = !!(
                activeConsoleId &&
                consoleTabs.find(
                  (t: any) =>
                    t.id === activeConsoleId &&
                    t.kind === "flow-editor" &&
                    t.metadata?.flowId === flow._id,
                )
              );
              return (
                <ListItem key={flow._id} disablePadding>
                  <ListItemButton
                    selected={isActive}
                    onClick={() => handleEditFlow(flow._id)}
                    sx={{
                      px: 1,
                      py: 0.2,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 28 }}>
                      {flow.type === "webhook" ? (
                        <WebhookIcon
                          size={20}
                          strokeWidth={1.5}
                          style={{
                            fontSize: 24,
                            color:
                              flow.webhookConfig?.enabled !== false
                                ? "text.primary"
                                : "text.disabled",
                          }}
                        />
                      ) : flow.schedule?.enabled === true ? (
                        <ScheduleIcon
                          size={20}
                          strokeWidth={1.5}
                          style={{
                            fontSize: 24,
                            color: "text.primary",
                          }}
                        />
                      ) : (
                        <PauseIcon
                          size={20}
                          color="currentColor"
                          strokeWidth={1.5}
                          style={{
                            color: "var(--mui-palette-text-disabled)",
                          }}
                        />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={getFlowTitle(flow)}
                      secondary={null}
                      sx={{
                        pr: 6,
                        "& .MuiListItemText-primary": {
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        },
                      }}
                    />
                    <Box
                      sx={{
                        position: "absolute",
                        right: 16,
                        top: "50%",
                        transform: "translateY(-50%)",
                        display: "flex",
                        gap: 1,
                        alignItems: "center",
                      }}
                    >
                      <Tooltip
                        title={
                          flow.syncMode === "incremental"
                            ? "Incremental Sync"
                            : "Full Sync"
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
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>

      {/* Add New Flow Menu */}
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
    </Box>
  );
}
