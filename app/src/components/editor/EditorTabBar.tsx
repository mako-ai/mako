import { memo, useCallback, useMemo, type SyntheticEvent } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { Box, IconButton } from "@mui/material";
import { Close as CloseIcon } from "@mui/icons-material";
import { useDragSensors } from "../../hooks/useDragSensors";
import type { ConsoleTab } from "../../store/lib/types";
import { EditorTabIcon } from "./EditorTabIcon";
import { SortableConsoleTab } from "./SortableConsoleTab";
import { CompactTabs } from "./styles";

const TAB_LABEL_SX = {
  display: "flex",
  alignItems: "center",
  gap: 0.5,
  minWidth: 0,
  maxWidth: "100%",
} as const;

// Cursor-style separator: thin vertical rule on a tab's trailing edge.
const TAB_SEPARATOR = {
  content: '""',
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: "1px",
  backgroundColor: "divider",
  pointerEvents: "none",
} as const;

function tabSx(isActiveTab: boolean, showSeparator: boolean) {
  return {
    minHeight: 36,
    py: 0.25,
    px: 1.25,
    textTransform: "none",
    position: "relative",
    "& .tab-close-btn": {
      visibility: isActiveTab ? "visible" : "hidden",
    },
    "&:hover .tab-close-btn": {
      visibility: "visible",
    },
    "&::after": showSeparator ? TAB_SEPARATOR : {},
  } as const;
}

interface EditorTabBarProps {
  consoleTabs: ConsoleTab[];
  activeConsoleId: string | null;
  connectionIconById: Map<string, string>;
  onSelect: (tabId: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  onClose: (tabId: string) => void;
  /** Double-click on a title pins a preview tab (isDirty = "kept"). */
  onPin: (tabId: string) => void;
}

/** Desktop tab bar: drag-to-reorder tabs with per-kind icons. */
export const EditorTabBar = memo(function EditorTabBar({
  consoleTabs,
  activeConsoleId,
  connectionIconById,
  onSelect,
  onReorder,
  onClose,
  onPin,
}: EditorTabBarProps) {
  // Keep click-to-select working: a mouse drag starts after 4px; on touch a
  // long-press, so the tab bar still swipes sideways.
  const dndSensors = useDragSensors(4);
  const sortableTabIds = useMemo(
    () => consoleTabs.map(t => t.id),
    [consoleTabs],
  );
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      onReorder(String(active.id), String(over.id));
    },
    [onReorder],
  );

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        minHeight: 36,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={handleTabDragEnd}
      >
        <SortableContext
          items={sortableTabIds}
          strategy={horizontalListSortingStrategy}
        >
          <CompactTabs
            value={activeConsoleId}
            onChange={(_: SyntheticEvent, newValue: string) =>
              onSelect(newValue)
            }
            variant="scrollable"
            scrollButtons={false}
          >
            {consoleTabs.map((tab, index) => {
              const isActiveTab = activeConsoleId === tab.id;
              const nextTab = consoleTabs[index + 1];
              const isLastTab = index === consoleTabs.length - 1;
              // Separator hidden when this tab or the next one is active,
              // and on the very last tab.
              const showSeparator =
                !isActiveTab && !isLastTab && nextTab?.id !== activeConsoleId;
              return (
                <SortableConsoleTab
                  key={tab.id}
                  value={tab.id}
                  sx={tabSx(isActiveTab, showSeparator)}
                  label={
                    <Box sx={TAB_LABEL_SX}>
                      <EditorTabIcon
                        tab={tab}
                        connectionIconUrl={
                          tab.connectionId
                            ? connectionIconById.get(tab.connectionId)
                            : undefined
                        }
                      />
                      <span
                        style={{
                          fontStyle: tab.isDirty ? "normal" : "italic",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          display: "inline-block",
                          maxWidth: "150px",
                        }}
                        onDoubleClick={e => {
                          e.stopPropagation();
                          onPin(tab.id);
                        }}
                        title={tab.title}
                      >
                        {tab.title}
                      </span>
                      <IconButton
                        aria-label={`Close ${tab.title}`}
                        component="span"
                        size="small"
                        className="tab-close-btn"
                        onClick={e => {
                          e.stopPropagation();
                          onClose(tab.id);
                        }}
                        onPointerDown={e => {
                          // Prevent the Tab's drag listener from starting
                          // a drag when the user clicks the close button.
                          e.stopPropagation();
                        }}
                        sx={{ p: 0.25, ml: 0 }}
                      >
                        <CloseIcon fontSize="inherit" />
                      </IconButton>
                    </Box>
                  }
                />
              );
            })}
          </CompactTabs>
        </SortableContext>
      </DndContext>
    </Box>
  );
});
