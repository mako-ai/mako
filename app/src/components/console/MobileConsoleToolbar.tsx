import { useState } from "react";
import {
  Box,
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
import {
  Save as SaveIcon,
  Undo as UndoIcon,
  Redo as RedoIcon,
  History as HistoryIcon,
  Info as InfoOutlineIcon,
  Copy as CopyIcon,
  FolderInput as MoveIcon,
  Clock3 as ScheduleIcon,
  Share2 as Share2Icon,
  MoreHorizontal as MoreIcon,
} from "lucide-react";
import { ConnectionSelector } from "../ConnectionSelector";
import type { ConsoleToolbarProps } from "./toolbar-props";

const SQUARE_BUTTON_SX = {
  width: 40,
  height: 40,
  border: 1,
  borderColor: "divider",
  borderRadius: 1,
} as const;

const MENU_ICON_PROPS = { size: 18, strokeWidth: 2 } as const;
const SAVE_FIRST = "Save the console first";

/**
 * Mobile toolbar — ONE row: connection, save, overflow. Everything else
 * (undo, redo, history, share, schedule, info, save-as) lives in the overflow
 * menu; the run affordance is the FAB. This is what gets the first line of
 * SQL back above the fold on a phone.
 */
export function MobileConsoleToolbar(props: ConsoleToolbarProps) {
  const {
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
    isDiffMode,
    canUndo,
    canRedo,
    enableVersionControl,
    historyAvailable,
    shareAvailable,
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
  // Mobile overflow menu: everything the one-row phone toolbar cannot show.
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const closeMenu = () => setMenuAnchor(null);
  /** Close the menu, then run the action. */
  const fromMenu = (action: () => void) => () => {
    closeMenu();
    action();
  };
  const canSave = Boolean(onSave) && !isReadOnly;
  const busy = Boolean(isSaving) || isExecuting;

  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          pb: 1,
          backgroundColor: "background.paper",
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ConnectionSelector
            value={connectionId || ""}
            onChange={onConnectionChange}
            size="compact"
            showLabel={false}
            placeholder="Select connection"
            fullWidth
          />
        </Box>
        {isClusterMode && (
          <FormControl size="small" variant="outlined" sx={{ minWidth: 96 }}>
            <Select
              value={databaseId || ""}
              onChange={e => onDatabaseSelect(e.target.value || undefined)}
              disabled={isLoadingDatabases || clusterDatabases.length === 0}
              displayEmpty
              aria-label="Database"
            >
              {clusterDatabases.map(db => (
                <MenuItem key={db.id} value={db.id}>
                  {db.label || db.id}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        {canSave && (
          <Tooltip title={!hasUnsavedChanges ? "No changes to save" : "Save"}>
            <span>
              <IconButton
                aria-label="Save"
                onClick={onSave}
                disabled={busy || !hasUnsavedChanges}
                sx={SQUARE_BUTTON_SX}
              >
                <SaveIcon strokeWidth={1.75} size={20} />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <IconButton
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuAnchor ? "true" : undefined}
          onClick={e => setMenuAnchor(e.currentTarget)}
          sx={SQUARE_BUTTON_SX}
        >
          <MoreIcon strokeWidth={1.75} size={20} />
        </IconButton>
        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={closeMenu}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          {enableVersionControl && (
            <MenuItem
              disabled={isDiffMode || !canUndo}
              onClick={fromMenu(onUndo)}
            >
              <ListItemIcon>
                <UndoIcon {...MENU_ICON_PROPS} />
              </ListItemIcon>
              <ListItemText primary="Undo" />
            </MenuItem>
          )}
          {enableVersionControl && (
            <MenuItem
              disabled={isDiffMode || !canRedo}
              onClick={fromMenu(onRedo)}
            >
              <ListItemIcon>
                <RedoIcon {...MENU_ICON_PROPS} />
              </ListItemIcon>
              <ListItemText primary="Redo" />
            </MenuItem>
          )}
          {enableVersionControl && onHistoryClick && (
            <MenuItem
              disabled={isDiffMode || !historyAvailable}
              onClick={() => {
                const anchor = menuAnchor;
                closeMenu();
                if (anchor) onHistoryClick(anchor);
              }}
            >
              <ListItemIcon>
                <HistoryIcon {...MENU_ICON_PROPS} />
              </ListItemIcon>
              <ListItemText
                primary="Version history"
                secondary={historyAvailable ? undefined : SAVE_FIRST}
              />
            </MenuItem>
          )}
          {enableVersionControl && onShareClick && (
            <MenuItem
              disabled={isDiffMode || !shareAvailable}
              onClick={fromMenu(onShareClick)}
            >
              <ListItemIcon>
                <Share2Icon {...MENU_ICON_PROPS} />
              </ListItemIcon>
              <ListItemText
                primary="Share"
                secondary={shareAvailable ? undefined : SAVE_FIRST}
              />
            </MenuItem>
          )}
          {!isReadOnly && onSchedule && (
            <MenuItem disabled={!isSaved} onClick={fromMenu(onSchedule)}>
              <ListItemIcon>
                <ScheduleIcon {...MENU_ICON_PROPS} />
              </ListItemIcon>
              <ListItemText
                primary={hasSchedule ? "Update schedule" : "Schedule"}
                secondary={isSaved ? undefined : SAVE_FIRST}
              />
            </MenuItem>
          )}
          {canSave && <Divider />}
          {canSave && (
            <MenuItem
              disabled={busy || !canSaveAsCopy}
              onClick={fromMenu(onSaveAsCopy)}
            >
              <ListItemIcon>
                <CopyIcon {...MENU_ICON_PROPS} />
              </ListItemIcon>
              <ListItemText primary="Save a copy…" />
            </MenuItem>
          )}
          {canSave && (
            <MenuItem
              disabled={busy || !canRenameMove || !hasFilePath}
              onClick={fromMenu(onRenameMove)}
            >
              <ListItemIcon>
                <MoveIcon {...MENU_ICON_PROPS} />
              </ListItemIcon>
              <ListItemText primary="Rename / Move…" />
            </MenuItem>
          )}
          <Divider />
          <MenuItem onClick={fromMenu(onInfo)}>
            <ListItemIcon>
              <InfoOutlineIcon {...MENU_ICON_PROPS} />
            </ListItemIcon>
            <ListItemText primary="Console info" />
          </MenuItem>
        </Menu>
      </Box>
      {headerExtras && (
        <Box sx={{ px: 1, pb: 1, backgroundColor: "background.paper" }}>
          {headerExtras}
        </Box>
      )}
    </>
  );
}
