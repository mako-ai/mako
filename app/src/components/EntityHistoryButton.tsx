/**
 * A "History" button that opens an entity's git history popover — for header
 * bars that show actions as text buttons (flows, source connections). The
 * console and notebook toolbars open the same popover from an icon.
 */
import { useState } from "react";
import { Button } from "@mui/material";
import { History as HistoryIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import type { HistoryEntityKind } from "../store/entityHistoryStore";
import EntityHistoryPopover from "./EntityHistoryPopover";

export function EntityHistoryButton({
  entity,
  id,
  onRestored,
  label = "History",
}: {
  entity: HistoryEntityKind;
  id: string;
  onRestored?: () => void;
  label?: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!currentWorkspace) return null;
  return (
    <>
      <Button
        size="small"
        startIcon={<HistoryIcon size={16} />}
        onClick={e => setAnchor(e.currentTarget)}
        sx={{ textTransform: "none", fontSize: "0.75rem" }}
      >
        {label}
      </Button>
      <EntityHistoryPopover
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        workspaceId={currentWorkspace.id}
        entity={entity}
        id={id}
        onRestored={onRestored}
      />
    </>
  );
}
