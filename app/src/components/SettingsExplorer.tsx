import { Box, Typography } from "@mui/material";
import {
  Sparkles as ModelsIcon,
  MessageSquareText as PromptIcon,
  Wallet as BillingIcon,
  Users as MembersIcon,
  KeySquare as ApiKeyIcon,
  Palette as AppearanceIcon,
  ShieldCheck as AdminIcon,
} from "lucide-react";
import ExplorerShell from "./ExplorerShell";
import { useAuth } from "../contexts/auth-context";
import {
  selectTabBySettingsSection,
  useConsoleStore,
} from "../store/consoleStore";
import type { SettingsSection } from "../store/lib/types";
import { SECTION_LABELS, SECTION_ORDER } from "../pages/settings/sections";

const SECTION_ICONS: Record<
  SettingsSection,
  (props: { size?: number; strokeWidth?: number }) => JSX.Element
> = {
  prompt: props => <PromptIcon {...props} />,
  models: props => <ModelsIcon {...props} />,
  billing: props => <BillingIcon {...props} />,
  members: props => <MembersIcon {...props} />,
  "api-keys": props => <ApiKeyIcon {...props} />,
  appearance: props => <AppearanceIcon {...props} />,
  admin: props => <AdminIcon {...props} />,
};

export default function SettingsExplorer() {
  const { user } = useAuth();
  const isSuperAdmin = Boolean(user?.isSuperAdmin);

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

  const sections = SECTION_ORDER.filter(s => s !== "admin" || isSuperAdmin);

  return (
    <ExplorerShell title="Settings">
      {() => (
        <Box sx={{ py: 0.5 }}>
          {sections.map(section => {
            const Icon = SECTION_ICONS[section];
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
