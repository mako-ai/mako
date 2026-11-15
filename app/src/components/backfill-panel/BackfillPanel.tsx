import { Box, Tabs } from "@mui/material";
import { useBackfillPanel, type BackfillPanelProps } from "./useBackfillPanel";
import { PanelTab } from "./backfill-styles";
import { BackfillTopBar } from "./BackfillTopBar";
import { BackfillKpiCards } from "./BackfillKpiCards";
import { BackfillObjectsTab } from "./BackfillObjectsTab";
import { BackfillRunsTab } from "./BackfillRunsTab";
import { BackfillEventsTab } from "./BackfillEventsTab";
import { BackfillDialogs } from "./BackfillDialogs";

export function BackfillPanel(props: BackfillPanelProps) {
  const model = useBackfillPanel(props);
  const { tab, setTab, webhookEventsTotalAll, runs } = model;
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Top bar */}
      <BackfillTopBar model={model} />

      {/* KPI cards + error */}
      <BackfillKpiCards model={model} />

      {/* Tabs — Objects / Backfill runs / Events */}
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          minHeight: 36,
          flexShrink: 0,
          px: 2,
        }}
      >
        <PanelTab label="Objects" />
        <PanelTab label={`Backfills (${runs.length})`} />
        <PanelTab label={`Events (${webhookEventsTotalAll})`} />
      </Tabs>

      {/* Tab content — scrollable */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {tab === 0 && <BackfillObjectsTab model={model} />}

        {tab === 1 && <BackfillRunsTab model={model} />}

        {tab === 2 && <BackfillEventsTab model={model} />}
      </Box>

      <BackfillDialogs model={model} />
    </Box>
  );
}
