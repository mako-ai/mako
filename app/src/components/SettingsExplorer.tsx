import { Box, Typography } from "@mui/material";
import ExplorerShell from "./ExplorerShell";
import { useAuth } from "../contexts/auth-context";
import {
  selectTabBySettingsSection,
  useConsoleStore,
} from "../store/consoleStore";
import { SETTINGS_SECTION_ICONS } from "../lib/entity-icons";
import type { SettingsSection } from "../store/lib/types";
import { SECTION_LABELS, SECTION_ORDER } from "../pages/settings/sections";
import { useWorkspace } from "../contexts/workspace-context";

export default function SettingsExplorer() {
  const { user } = useAuth();
  const isSuperAdmin = Boolean(user?.isSuperAdmin);
  const { currentWorkspace } = useWorkspace();

  const activeTab = useConsoleStore(state =>
    state.activeTabId ? state.tabs[state.activeTabId] : null,
  );

  const openSection = (section: SettingsSection) => {
    const state = useConsoleStore.getState();
    const existing = selectTabBySettingsSection(section)(state);
    if (existing) {
      state.setActiveTab(existing.id);
      return;
    }
    const id = state.openTab({
      title: SECTION_LABELS[section],
      content: "",
      kind: "settings",
      settingsSection: section,
    });
    state.setActiveTab(id);
  };

  const appsV2 = currentWorkspace?.settings?.appsV2Enabled === true;
  const sections = SECTION_ORDER.filter(
    s => (s !== "admin" || isSuperAdmin) && (s !== "sandbox" || appsV2),
  );

  return (
    <ExplorerShell title="Settings">
      {() => (
        <Box sx={{ py: 0.5 }}>
          {sections.map(section => {
            const Icon = SETTINGS_SECTION_ICONS[section];
            const isActive =
              activeTab?.kind === "settings" &&
              activeTab.settingsSection === section;
            return (
              <Box
                key={section}
                onClick={() => openSection(section)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  px: 1.25,
                  py: 0.75,
                  cursor: "pointer",
                  borderRadius: 0,
                  bgcolor: isActive ? "action.selected" : "transparent",
                  color: isActive ? "text.primary" : "text.secondary",
                  "&:hover": {
                    bgcolor: isActive ? "action.selected" : "action.hover",
                  },
                }}
              >
                <Box
                  sx={{
                    width: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={16} strokeWidth={1.5} />
                </Box>
                <Typography
                  variant="body2"
                  sx={{
                    flex: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {SECTION_LABELS[section]}
                </Typography>
              </Box>
            );
          })}
        </Box>
      )}
    </ExplorerShell>
  );
}
