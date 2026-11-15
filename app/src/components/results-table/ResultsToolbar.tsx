import React, { useState } from "react";
import {
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import {
  Sheet as TableIcon,
  Braces as JsonIcon,
  BarChart3 as ChartIcon,
  LayoutGrid as CardsIcon,
  ClipboardCopy as CopyIcon,
  Download as DownloadIcon,
  FileCode2 as StructureIcon,
} from "lucide-react";

export type ViewMode = "table" | "json" | "chart";
// "structure" is an extra, uncontrolled-only mode available when a
// `structureView` slot is provided (table data tabs); "cards" is the mobile
// record-card view. Both are local-only and intentionally not part of the
// persisted console ViewMode (the controlled `viewMode` prop stays table/json/
// chart so the API and store contracts are unchanged).
export type ResultsViewMode = ViewMode | "structure" | "cards";

const ICON_PROPS = { strokeWidth: 1.5, size: 22 } as const;

const VIEW_BUTTONS: Array<{
  value: ResultsViewMode;
  title: string;
  label: string;
  Icon: typeof TableIcon;
}> = [
  { value: "cards", title: "Cards view", label: "cards view", Icon: CardsIcon },
  { value: "table", title: "Table view", label: "table view", Icon: TableIcon },
  { value: "json", title: "JSON view", label: "json view", Icon: JsonIcon },
  { value: "chart", title: "Chart view", label: "chart view", Icon: ChartIcon },
  {
    value: "structure",
    title: "Structure",
    label: "structure view",
    Icon: StructureIcon,
  },
];

interface ResultsToolbarProps {
  viewMode: ResultsViewMode;
  onViewModeChange: (mode: ResultsViewMode) => void;
  isMobile: boolean;
  hideChartView: boolean;
  hasStructureView: boolean;
  onCopy: () => void;
  onDownload?: (format: "csv" | "ndjson") => void;
}

/** View switch (cards / table / json / chart / structure), copy and download. */
export function ResultsToolbar({
  viewMode,
  onViewModeChange,
  isMobile,
  hideChartView,
  hasStructureView,
  onCopy,
  onDownload,
}: ResultsToolbarProps) {
  const [downloadAnchorEl, setDownloadAnchorEl] = useState<HTMLElement | null>(
    null,
  );
  const visible: Record<ResultsViewMode, boolean> = {
    cards: isMobile,
    table: true,
    json: !isMobile,
    chart: !hideChartView,
    structure: hasStructureView,
  };

  const handleDownloadSelection = (format: "csv" | "ndjson") => {
    setDownloadAnchorEl(null);
    onDownload?.(format);
  };

  return (
    <Box
      sx={{
        p: 0.5,
        gap: 1,
        display: "flex",
        justifyContent: "flex-start",
        alignItems: "center",
        borderBottom: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.default",
      }}
    >
      <ToggleButtonGroup
        value={viewMode}
        exclusive
        onChange={(
          _event: React.MouseEvent<HTMLElement>,
          next: ResultsViewMode,
        ) => {
          if (next !== null) onViewModeChange(next);
        }}
        size="small"
        aria-label="view mode"
      >
        {VIEW_BUTTONS.filter(b => visible[b.value]).map(
          ({ value, title, label, Icon }) => (
            <Tooltip key={value} title={title}>
              <ToggleButton value={value} aria-label={label}>
                <Icon {...ICON_PROPS} />
              </ToggleButton>
            </Tooltip>
          ),
        )}
      </ToggleButtonGroup>
      {viewMode !== "structure" && (
        <Tooltip title="Copy to clipboard">
          <IconButton
            size="small"
            onClick={onCopy}
            sx={{ minWidth: "32px", width: "32px", height: "32px", p: 0 }}
          >
            <CopyIcon {...ICON_PROPS} />
          </IconButton>
        </Tooltip>
      )}
      {onDownload && viewMode !== "structure" && (
        <>
          <Button
            size="small"
            variant="outlined"
            onClick={event => setDownloadAnchorEl(event.currentTarget)}
            startIcon={<DownloadIcon strokeWidth={1.5} size={16} />}
            sx={{ ml: 0.5 }}
          >
            Download
          </Button>
          <Menu
            anchorEl={downloadAnchorEl}
            open={Boolean(downloadAnchorEl)}
            onClose={() => setDownloadAnchorEl(null)}
          >
            <MenuItem onClick={() => handleDownloadSelection("csv")}>
              Download CSV
            </MenuItem>
            <MenuItem onClick={() => handleDownloadSelection("ndjson")}>
              Download NDJSON
            </MenuItem>
          </Menu>
        </>
      )}
    </Box>
  );
}
