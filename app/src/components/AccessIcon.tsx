/**
 * The object icon, carrying who can see the entity as a corner overlay.
 *
 * Width in this sidebar is scarce — entity names are long and the panel is
 * taking space the editor wants — so visibility gets no column of its own. It
 * rides inside the glyph's own box, which costs nothing.
 *
 * SHAPE is the channel, not colour. An earlier pass tinted the whole glyph and
 * two collisions showed up immediately: the "workspace" blue was the very same
 * hue as the selected-row background (so blue meant both "open" and "shared
 * with the workspace"), and the "shared" amber was the literal `warning`
 * token, which made a shared item look like a problem. This theme has no spare
 * hue — `secondary` is crimson — so the fix is to stop leaning on colour.
 *
 * Private gets NO overlay at all: it is the common case, and silence is the
 * right amount of attention for it. The tooltip always states the access in
 * words, so nothing depends on spotting a 9px glyph.
 */
import { Box, Tooltip } from "@mui/material";
import { Globe, User, type LucideIcon } from "lucide-react";

import { ACCESS_LABEL, type AccessState } from "./access-state";

/**
 * `User` (one figure), not `Users` (two overlapping ones): at this size a
 * two-figure glyph collapses into a smudge, while a single silhouette stays
 * readable — and it is the truer description anyway, since "shared with you"
 * means somebody else owns it. Both overlays render in the same muted grey, so
 * shape is the ONLY thing telling them apart and it has to survive 10px.
 */
const OVERLAY: Partial<Record<AccessState, LucideIcon>> = {
  workspace: Globe,
  shared: User,
};

interface AccessIconProps {
  /** The entity glyph, from `lib/entity-icons` — never picked ad hoc. */
  Glyph: LucideIcon;
  state: AccessState;
  /** Names the kind in the tooltip, e.g. "App · Private — only you". */
  kindLabel: string;
  size?: number;
}

export default function AccessIcon({
  Glyph,
  state,
  kindLabel,
  size = 16,
}: AccessIconProps) {
  const Overlay = OVERLAY[state];
  return (
    <Tooltip title={`${kindLabel} · ${ACCESS_LABEL[state]}`} placement="right">
      <Box
        component="span"
        sx={{ position: "relative", display: "inline-flex", lineHeight: 0 }}
      >
        {/* 1.5 matches the file and folder glyphs sitting beside it. */}
        <Glyph size={size} strokeWidth={1.5} />
        {Overlay ? (
          <Box
            component="span"
            sx={{
              position: "absolute",
              right: -3,
              bottom: -3,
              display: "inline-flex",
              borderRadius: "50%",
              // A ring of the panel's own background separates the overlay
              // from the glyph underneath it at this size.
              bgcolor: "background.default",
              color: "text.secondary",
              p: "1px",
            }}
          >
            <Overlay size={Math.round(size * 0.62)} strokeWidth={2.5} />
          </Box>
        ) : null}
      </Box>
    </Tooltip>
  );
}
