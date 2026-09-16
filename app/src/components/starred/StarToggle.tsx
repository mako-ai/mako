/**
 * The star affordance at the right edge of an explorer row.
 *
 * Kept in its own file so `starred-section.tsx` exports only helpers: mixing
 * component and non-component exports breaks Fast Refresh, which is the same
 * reason `resource-tree/` splits `utils.ts` from `dnd.tsx`.
 */
import { IconButton, Tooltip } from "@mui/material";
import { Star as StarIcon } from "lucide-react";

interface StarToggleProps {
  starred: boolean;
  onToggle: () => void;
}

/**
 * Hidden until the row is hovered or the button focused — being IN the Starred
 * section is what says an entity is starred, so a standing glyph would be
 * noise.
 */
export default function StarToggle({ starred, onToggle }: StarToggleProps) {
  return (
    <Tooltip title={starred ? "Unstar" : "Star"}>
      <IconButton
        size="small"
        aria-label={starred ? "Unstar" : "Star"}
        aria-pressed={starred}
        // Must neither open the entity (row click) nor begin a drag (dnd-kit
        // arms on pointerdown on the draggable ancestor).
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          onToggle();
        }}
        sx={{
          p: 0.25,
          color: starred ? "warning.main" : "text.disabled",
          opacity: 0,
          ".MuiListItemButton-root:hover &, &:focus-visible": { opacity: 1 },
        }}
      >
        <StarIcon
          size={14}
          strokeWidth={2}
          fill={starred ? "currentColor" : "none"}
        />
      </IconButton>
    </Tooltip>
  );
}
