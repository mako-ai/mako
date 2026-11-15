import { Box, Tooltip } from "@mui/material";
import {
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
} from "lucide-react";
import AccessIcon from "../AccessIcon";
import { resolveAccessState } from "../access-state";
import StarToggle from "../starred/StarToggle";
import type { ResourceTreeNode } from "../ResourceTree";
import { AppIcon, fileIcon, parseNodeId } from "./node-model";

/**
 * Tri-state dev-server dot beside an app row: amber while a boot is in
 * flight, green when the box says it serves, red when the last start failed.
 * Nothing → no dot.
 */
function DevServerDot({
  running,
  booting,
  failed,
}: {
  running: boolean;
  booting: boolean;
  failed: boolean;
}) {
  if (!running && !booting && !failed) return null;
  return (
    <Tooltip
      title={
        booting
          ? "Dev server starting…"
          : running
            ? "Dev server running"
            : "Last dev start failed"
      }
    >
      <Box
        component="span"
        sx={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          bgcolor: booting
            ? "warning.main"
            : running
              ? "success.main"
              : "error.main",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
    </Tooltip>
  );
}

/** An app row's trailing adornment: its dev-server dot and star toggle. */
export function AppRowAdornment({
  running,
  booting,
  lastStartFailed,
  starred,
  onToggleStar,
}: {
  running: boolean;
  booting: boolean;
  lastStartFailed: boolean;
  starred: boolean;
  onToggleStar: () => void;
}) {
  const failed = !running && !booting && lastStartFailed;
  return (
    <Box
      component="span"
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
    >
      <DevServerDot running={running} booting={booting} failed={failed} />
      <StarToggle starred={starred} onToggle={onToggleStar} />
    </Box>
  );
}

/** Row icon for the Apps tree: app (with its access overlay), file, folder. */
export function appsTreeItemIcon(
  node: ResourceTreeNode,
  ctx: { isExpanded: boolean } | undefined,
  userId: string | undefined,
) {
  const parsed = parseNodeId(node.id);
  if (parsed.kind === "app") {
    const state = resolveAccessState(node, userId);
    // The overlay says who can see it, wherever the row sits — a folder
    // header no longer does.
    if (parsed.pinned || state !== "workspace") {
      return (
        <AccessIcon
          Glyph={AppIcon}
          state={
            node.access === "private" &&
            node.owner_id === userId &&
            node.path?.startsWith("users/")
              ? "private"
              : state
          }
          kindLabel="App"
        />
      );
    }
    return <AppIcon size={16} strokeWidth={1.5} />;
  }
  if (parsed.kind === "file") {
    return fileIcon(node.name, node.path ?? node.name);
  }
  return ctx?.isExpanded ? (
    <FolderOpenIcon size={16} strokeWidth={1.5} />
  ) : (
    <FolderIcon size={16} strokeWidth={1.5} />
  );
}
