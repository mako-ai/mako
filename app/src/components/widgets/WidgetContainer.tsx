import React, { useState } from "react";
import {
  Box,
  Typography,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  CircularProgress,
  Button,
} from "@mui/material";
import {
  GripHorizontal,
  MoreVertical,
  RefreshCw,
  Trash2,
  Copy,
  Settings,
} from "lucide-react";

class WidgetErrorBoundary extends React.Component<
  { children: React.ReactNode; onError?: (error: string) => void },
  { hasError: boolean; error: string | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error.message);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            p: 2,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: 1,
          }}
        >
          <Typography
            color="error"
            variant="caption"
            sx={{ fontFamily: "monospace" }}
          >
            {this.state.error || "Widget crashed"}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Retry
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}

interface WidgetContainerProps {
  title?: string;
  loading?: boolean;
  error?: string;
  isEditMode?: boolean;
  onRefresh?: () => void;
  onRemove?: () => void;
  onDuplicate?: () => void;
  onInspect?: () => void;
  children: React.ReactNode;
}

const WidgetContainer: React.FC<WidgetContainerProps> = ({
  title,
  loading,
  error,
  isEditMode = true,
  onRefresh,
  onRemove,
  onDuplicate,
  onInspect,
  children,
}) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        backgroundColor: "background.paper",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          px: 1,
          py: 0.5,
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          minHeight: 32,
          cursor: isEditMode ? "move" : "default",
        }}
        className={isEditMode ? "drag-handle" : undefined}
      >
        {isEditMode && (
          <GripHorizontal size={14} style={{ opacity: 0.4, flexShrink: 0 }} />
        )}
        <Typography
          variant="caption"
          sx={{
            flex: 1,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title || "Untitled"}
        </Typography>
        {loading && <CircularProgress size={14} />}
        {isEditMode && (
          <>
            {onRefresh && (
              <Tooltip title="Refresh widget">
                <IconButton size="small" onClick={onRefresh} sx={{ p: 0.25 }}>
                  <RefreshCw size={14} />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Options">
              <IconButton
                size="small"
                onClick={e => setAnchorEl(e.currentTarget)}
                sx={{ p: 0.25 }}
              >
                <MoreVertical size={14} />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={() => setAnchorEl(null)}
              slotProps={{ paper: { sx: { minWidth: 140 } } }}
            >
              {onInspect && (
                <MenuItem
                  onClick={() => {
                    setAnchorEl(null);
                    onInspect();
                  }}
                >
                  <Settings size={14} style={{ marginRight: 8 }} />
                  Inspect
                </MenuItem>
              )}
              {onRefresh && (
                <MenuItem
                  onClick={() => {
                    setAnchorEl(null);
                    onRefresh();
                  }}
                >
                  <RefreshCw size={14} style={{ marginRight: 8 }} />
                  Refresh
                </MenuItem>
              )}
              {onDuplicate && (
                <MenuItem
                  onClick={() => {
                    setAnchorEl(null);
                    onDuplicate();
                  }}
                >
                  <Copy size={14} style={{ marginRight: 8 }} />
                  Duplicate
                </MenuItem>
              )}
              {onRemove && (
                <MenuItem
                  onClick={() => {
                    setAnchorEl(null);
                    onRemove();
                  }}
                  sx={{ color: "error.main" }}
                >
                  <Trash2 size={14} style={{ marginRight: 8 }} />
                  Remove
                </MenuItem>
              )}
            </Menu>
          </>
        )}
      </Box>

      <Box
        sx={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}
      >
        <WidgetErrorBoundary>{children}</WidgetErrorBoundary>
        {error && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              p: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(255,255,255,0.72)",
              backdropFilter: "blur(1px)",
              pointerEvents: "none",
            }}
          >
            <Typography
              color="error"
              variant="caption"
              sx={{ fontFamily: "monospace" }}
            >
              {error}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default WidgetContainer;
