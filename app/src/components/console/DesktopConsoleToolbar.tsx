import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Tooltip,
} from "@mui/material";
import { PlayArrow as PlayIcon } from "@mui/icons-material";
import {
  Save as SaveIcon,
  Undo as UndoIcon,
  Redo as RedoIcon,
  History as HistoryIcon,
  Info as InfoOutlineIcon,
  Square as StopIcon,
  ChevronDown as ChevronDownIcon,
  Copy as CopyIcon,
  FolderInput as MoveIcon,
  Clock3 as ScheduleIcon,
  Share2 as Share2Icon,
} from "lucide-react";
import { ConnectionSelector } from "../ConnectionSelector";
import type { ConsoleToolbarProps } from "./toolbar-props";

const TOOL_ICON_PROPS = { strokeWidth: 2, size: 22 } as const;

/**
 * Wraps a toolbar control in a Tooltip with a <span> so the tooltip still
 * shows while the control is disabled.
 */
function Tip({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip title={title}>
      <span>{children}</span>
    </Tooltip>
  );
}

function ScheduleGlyph({ hasSchedule }: { hasSchedule: boolean }) {
  return (
    <Badge
      color="success"
      variant="dot"
      invisible={!hasSchedule}
      overlap="circular"
    >
      <ScheduleIcon size={16} />
    </Badge>
  );
}

/**
 * Desktop toolbar. Hidden (not unmounted) on phones, where the one-row
 * mobile toolbar replaces it.
 */
export function DesktopConsoleToolbar(
  props: ConsoleToolbarProps & { isMobile: boolean },
) {
  const {
    isMobile,
    connectionId,
    databaseId,
    isClusterMode,
    clusterDatabases,
    isLoadingDatabases,
    onConnectionChange,
    onDatabaseSelect,
    isReadOnly,
    isSaved,
    hasSchedule,
    hasUnsavedChanges,
    hasFilePath,
    isSaving,
    isExecuting,
    isCancelling,
    isDiffMode,
    canUndo,
    canRedo,
    enableVersionControl,
    historyAvailable,
    shareAvailable,
    onExecute,
    onCancel,
    onSave,
    canSaveAsCopy,
    onSaveAsCopy,
    canRenameMove,
    onRenameMove,
    onUndo,
    onRedo,
    onHistoryClick,
    onShareClick,
    onSchedule,
    onInfo,
    headerExtras,
  } = props;
  // Save split-button menu anchor
  const [saveMenuAnchor, setSaveMenuAnchor] = useState<null | HTMLElement>(
    null,
  );
  const saveMenuOpen = Boolean(saveMenuAnchor);
  const busy = Boolean(isSaving) || isExecuting;

  return (
    <Box
      sx={{
        display: isMobile ? "none" : "flex",
        justifyContent: "space-between",
        alignItems: "center",
        backgroundColor: "background.paper",
        p: 0.5,
        gap: 0.5,
        // Let the connection selector wrap below the actions on narrow screens
        flexWrap: { xs: "wrap", md: "nowrap" },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          // Wrap the action buttons onto a second line on phones instead of
          // clipping them off the right edge.
          flexWrap: { xs: "wrap", md: "nowrap" },
        }}
      >
        {/* On mobile the run/cancel affordance is the floating FAB, so the
            inline toolbar button is desktop-only to save horizontal space. */}
        {!isMobile &&
          (isExecuting ? (
            <Button
              variant="contained"
              size="small"
              color="error"
              startIcon={<StopIcon size={18} />}
              onClick={onCancel}
              disabled={isCancelling}
              disableElevation
              sx={{ minWidth: "120px" }}
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </Button>
          ) : (
            <Tip
              title={
                !connectionId
                  ? "Select a database connection to run queries"
                  : ""
              }
            >
              <Button
                variant="contained"
                size="small"
                startIcon={<PlayIcon />}
                onClick={onExecute}
                disabled={!connectionId}
                disableElevation
                sx={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "200px",
                  minWidth: "120px",
                }}
              >
                Run (⌘/Ctrl+Enter)
              </Button>
            </Tip>
          ))}

        {isReadOnly && (
          <Chip
            label="Read-only"
            size="small"
            variant="outlined"
            sx={{ ml: 1, height: 24, fontSize: "0.75rem" }}
          />
        )}

        {!isReadOnly && onSchedule && (
          <Tip
            title={
              !isSaved
                ? "Save this console before scheduling it"
                : hasSchedule
                  ? "Update scheduled query"
                  : "Create scheduled query"
            }
          >
            <Button
              size="small"
              variant="outlined"
              startIcon={
                isMobile ? undefined : (
                  <ScheduleGlyph hasSchedule={hasSchedule} />
                )
              }
              onClick={onSchedule}
              disabled={!isSaved}
              sx={{
                ml: 1,
                whiteSpace: "nowrap",
                minWidth: isMobile ? 0 : undefined,
                px: isMobile ? 1 : undefined,
              }}
            >
              {isMobile ? (
                <ScheduleGlyph hasSchedule={hasSchedule} />
              ) : (
                "Schedule"
              )}
            </Button>
          </Tip>
        )}

        {onSave && !isReadOnly && (
          <Box sx={{ ml: 1, display: "inline-flex", alignItems: "center" }}>
            <Tip
              title={
                !hasUnsavedChanges
                  ? "No changes to save"
                  : hasFilePath
                    ? "Save (⌘/Ctrl+S)"
                    : "Save (first save) (⌘/Ctrl+S)"
              }
            >
              <IconButton
                size="small"
                onClick={onSave}
                disabled={busy || !hasUnsavedChanges}
                sx={{
                  borderTopRightRadius: 0,
                  borderBottomRightRadius: 0,
                  pr: 0.5,
                }}
              >
                <SaveIcon {...TOOL_ICON_PROPS} />
              </IconButton>
            </Tip>
            <Tip title="More save options">
              <IconButton
                size="small"
                onClick={e => setSaveMenuAnchor(e.currentTarget)}
                disabled={busy}
                sx={{
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  pl: 0,
                  pr: 0.5,
                }}
                aria-haspopup="menu"
                aria-expanded={saveMenuOpen ? "true" : undefined}
              >
                <ChevronDownIcon strokeWidth={2} size={14} />
              </IconButton>
            </Tip>
            <Menu
              anchorEl={saveMenuAnchor}
              open={saveMenuOpen}
              onClose={() => setSaveMenuAnchor(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              transformOrigin={{ vertical: "top", horizontal: "left" }}
            >
              <MenuItem
                disabled={busy || !canSaveAsCopy}
                onClick={() => {
                  setSaveMenuAnchor(null);
                  onSaveAsCopy();
                }}
              >
                <ListItemIcon>
                  <CopyIcon size={16} strokeWidth={2} />
                </ListItemIcon>
                <ListItemText
                  primary="Save a Copy..."
                  secondary="⌘/Ctrl+Shift+S"
                />
              </MenuItem>
              <MenuItem
                disabled={busy || !canRenameMove || !hasFilePath}
                onClick={() => {
                  setSaveMenuAnchor(null);
                  onRenameMove();
                }}
              >
                <ListItemIcon>
                  <MoveIcon size={16} strokeWidth={2} />
                </ListItemIcon>
                <ListItemText
                  primary="Rename / Move..."
                  secondary={!hasFilePath ? "Save the file first" : undefined}
                />
              </MenuItem>
            </Menu>
          </Box>
        )}

        {headerExtras}

        {enableVersionControl && (
          <>
            <Divider orientation="vertical" flexItem />

            <Tip title="Undo (⌘/Ctrl+Z)">
              <IconButton
                size="small"
                onClick={onUndo}
                disabled={isDiffMode || !canUndo}
              >
                <UndoIcon {...TOOL_ICON_PROPS} />
              </IconButton>
            </Tip>

            <Tip title="Redo (⌘/Ctrl+Shift+Z)">
              <IconButton
                size="small"
                onClick={onRedo}
                disabled={isDiffMode || !canRedo}
              >
                <RedoIcon {...TOOL_ICON_PROPS} />
              </IconButton>
            </Tip>

            {onHistoryClick && (
              <Tip
                title={
                  historyAvailable
                    ? "Version History"
                    : "Save this console to start tracking version history"
                }
              >
                <IconButton
                  size="small"
                  onClick={e => onHistoryClick(e.currentTarget)}
                  disabled={isDiffMode || !historyAvailable}
                >
                  <HistoryIcon {...TOOL_ICON_PROPS} />
                </IconButton>
              </Tip>
            )}

            {onShareClick && (
              <Tip
                title={
                  shareAvailable
                    ? "Share"
                    : "Save this console before sharing it"
                }
              >
                <IconButton
                  size="small"
                  onClick={onShareClick}
                  disabled={isDiffMode || !shareAvailable}
                >
                  <Share2Icon {...TOOL_ICON_PROPS} />
                </IconButton>
              </Tip>
            )}
          </>
        )}
        <Divider orientation="vertical" flexItem />
        <IconButton aria-label="Console info" onClick={onInfo} size="small">
          <InfoOutlineIcon {...TOOL_ICON_PROPS} />
        </IconButton>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        {/* Connection selector */}
        <ConnectionSelector
          value={connectionId || ""}
          onChange={onConnectionChange}
          size="compact"
          showLabel={false}
          placeholder="Select connection"
          width={160}
        />

        {/* Database selector (only shown for cluster mode connections) */}
        {isClusterMode && (
          <>
            <Divider orientation="vertical" flexItem />
            <FormControl
              size="small"
              variant="standard"
              sx={{ minWidth: 80, m: 0, p: 0 }}
            >
              <Select
                variant="standard"
                disableUnderline
                labelId="database-name-select-label"
                value={databaseId || ""}
                onChange={e => onDatabaseSelect(e.target.value || undefined)}
                disabled={isLoadingDatabases || clusterDatabases.length === 0}
                displayEmpty
              >
                {isLoadingDatabases ? (
                  <MenuItem value="" disabled>
                    Loading...
                  </MenuItem>
                ) : clusterDatabases.length === 0 ? (
                  <MenuItem value="" disabled>
                    No databases
                  </MenuItem>
                ) : (
                  clusterDatabases.map(db => (
                    <MenuItem key={db.id} value={db.id}>
                      {db.label || db.id}
                    </MenuItem>
                  ))
                )}
              </Select>
            </FormControl>
          </>
        )}
      </Box>
    </Box>
  );
}
