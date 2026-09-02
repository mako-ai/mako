/**
 * The "back to Browse" chevron that leads an explorer's own header on the
 * phone. Renders nothing on desktop.
 *
 * The mobile Browse tab shows one explorer at a time under a header; the
 * explorer already draws a toolbar (title, add, refresh, search). Putting the
 * back button inside that toolbar keeps one bar instead of stacking a second
 * "‹ Apps" bar on top of "APPS + ⟳ 🔍".
 */
import { IconButton } from "@mui/material";
import { ChevronLeft as BackIcon } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useUIStore } from "../store/uiStore";

export default function MobileExplorerBack() {
  const isMobile = useIsMobile();
  const setBrowseView = useUIStore(state => state.setMobileBrowseView);
  if (!isMobile) return null;
  return (
    <IconButton
      aria-label="Back to Browse"
      onClick={() => setBrowseView("home")}
      sx={{ width: 40, height: 40, ml: -0.5, mr: 0.25, flexShrink: 0 }}
    >
      <BackIcon size={22} strokeWidth={1.5} />
    </IconButton>
  );
}
