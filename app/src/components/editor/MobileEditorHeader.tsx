import { useState } from "react";
import {
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import {
  ChevronDown as ChevronDownIcon,
  SquareTerminal as QueryPaneIcon,
  Table as ResultsPaneIcon,
  AppWindow as PreviewPaneIcon,
  TerminalSquare as TerminalPaneIcon,
  Plus as PlusIcon,
  X as CloseTabIcon,
} from "lucide-react";
import { useAppsStore } from "../../store/appsStore";
import { useUIStore } from "../../store/uiStore";
import type { ConsoleTab } from "../../store/lib/types";
import { TabKindGlyph } from "./EditorTabIcon";
import {
  MOBILE_FLOAT_BTN_SX,
  MOBILE_PANE_TOGGLE_SX,
  MOBILE_WINDOW_PILL_SX,
} from "./styles";

const PANE_ICON_PROPS = { size: 19, strokeWidth: 1.5 } as const;

interface MobileEditorHeaderProps {
  consoleTabs: ConsoleTab[];
  activeTab: ConsoleTab | undefined;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewConsole: () => void;
}

/**
 * Claude-style floating window switcher (mobile): window pill + per-kind
 * pane toggle + new-console, and the open-tabs menu the pill opens. The
 * explorer is the Browse tab, so there is no hamburger here.
 *
 * A console tab shows EITHER its editor or its results, and an app tab in
 * dev mode EITHER its preview or its terminal — switched by the icon toggle
 * beside the window pill, never by the (fixed) bottom nav.
 */
export function MobileEditorHeader({
  consoleTabs,
  activeTab,
  onSelect,
  onClose,
  onNewConsole,
}: MobileEditorHeaderProps) {
  const [windowMenuAnchor, setWindowMenuAnchor] = useState<null | HTMLElement>(
    null,
  );
  const mobileConsolePane = useUIStore(state => state.mobileConsolePane);
  const setMobileConsolePane = useUIStore(state => state.setMobileConsolePane);
  const mobileAppPane = useUIStore(state => state.mobileAppPane);
  const setMobileAppPane = useUIStore(state => state.setMobileAppPane);

  // Which toggle (if any) the active tab gets. Apps only have two panes while
  // a dev session is open; a merely viewed app is just its published build.
  const activeMobileKind = activeTab ? (activeTab.kind ?? "console") : null;
  const activeMobileAppId =
    activeMobileKind === "app"
      ? (activeTab?.metadata?.appId as string | undefined)
      : undefined;
  const activeMobileAppEditing = useAppsStore(state =>
    activeMobileAppId
      ? (state.editingByApp[activeMobileAppId] ?? false)
      : false,
  );

  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          px: 1,
          py: 0.75,
          minHeight: 52,
        }}
      >
        <Button
          aria-label="Switch window"
          onClick={e => setWindowMenuAnchor(e.currentTarget)}
          endIcon={<ChevronDownIcon size={16} />}
          sx={MOBILE_WINDOW_PILL_SX}
        >
          <Box
            component="span"
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {activeTab?.title || "Console"}
          </Box>
        </Button>
        {activeMobileKind === "console" ? (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mobileConsolePane}
            onChange={(_event, value) => {
              if (value) setMobileConsolePane(value);
            }}
            aria-label="Console pane"
            sx={MOBILE_PANE_TOGGLE_SX}
          >
            <ToggleButton value="query" aria-label="Query">
              <QueryPaneIcon {...PANE_ICON_PROPS} />
            </ToggleButton>
            <ToggleButton value="results" aria-label="Results">
              <ResultsPaneIcon {...PANE_ICON_PROPS} />
            </ToggleButton>
          </ToggleButtonGroup>
        ) : activeMobileKind === "app" && activeMobileAppEditing ? (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mobileAppPane}
            onChange={(_event, value) => {
              if (value) setMobileAppPane(value);
            }}
            aria-label="App pane"
            sx={MOBILE_PANE_TOGGLE_SX}
          >
            <ToggleButton value="preview" aria-label="Preview">
              <PreviewPaneIcon {...PANE_ICON_PROPS} />
            </ToggleButton>
            <ToggleButton value="terminal" aria-label="Terminal">
              <TerminalPaneIcon {...PANE_ICON_PROPS} />
            </ToggleButton>
          </ToggleButtonGroup>
        ) : null}
        <Tooltip title="New console">
          <IconButton
            aria-label="New console"
            onClick={onNewConsole}
            sx={MOBILE_FLOAT_BTN_SX}
          >
            <PlusIcon size={20} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Mobile window switcher menu — lists open tabs + new console. */}
      <Menu
        anchorEl={windowMenuAnchor}
        open={Boolean(windowMenuAnchor)}
        onClose={() => setWindowMenuAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
        slotProps={{ paper: { sx: { maxHeight: 360, minWidth: 240 } } }}
      >
        {consoleTabs.map(tab => (
          <MenuItem
            key={tab.id}
            selected={tab.id === activeTab?.id}
            onClick={() => {
              onSelect(tab.id);
              setWindowMenuAnchor(null);
            }}
            sx={{ pr: 1 }}
          >
            <ListItemIcon>
              {tab.icon ? (
                <Box
                  component="img"
                  src={tab.icon}
                  alt=""
                  sx={{ width: 18, height: 18 }}
                />
              ) : (
                <TabKindGlyph kind={tab.kind} />
              )}
            </ListItemIcon>
            <ListItemText
              primary={tab.title}
              slotProps={{
                primary: {
                  noWrap: true,
                  sx: { maxWidth: 180 },
                },
              }}
            />
            <IconButton
              size="small"
              aria-label={`Close ${tab.title}`}
              onClick={e => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              sx={{ ml: 1 }}
            >
              <CloseTabIcon size={16} />
            </IconButton>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            onNewConsole();
            setWindowMenuAnchor(null);
          }}
        >
          <ListItemIcon>
            <PlusIcon size={18} strokeWidth={1.5} />
          </ListItemIcon>
          <ListItemText primary="New console" />
        </MenuItem>
      </Menu>
    </>
  );
}
