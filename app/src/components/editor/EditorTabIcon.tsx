import { Box } from "@mui/material";
import {
  Clock as ScheduleIcon,
  Webhook as WebhookIcon,
  CirclePause as PauseIcon,
} from "lucide-react";
import { tabKindIcon } from "../../lib/entity-icons";
import type { ConsoleTab, TabKind } from "../../store/lib/types";

const ICON_PROPS = { size: 18, strokeWidth: 1.5 } as const;

/** Renders the canonical icon for a tab kind (see lib/entity-icons.ts). */
export function TabKindGlyph({ kind }: { kind: TabKind | undefined }) {
  const Icon = tabKindIcon(kind);
  return <Icon {...ICON_PROPS} />;
}

/**
 * The tab-bar icon: the canonical per-kind icon (lib/entity-icons.ts),
 * overridden by connector favicons (`tab.icon`), a console's connection icon,
 * and the flow-editor subtype icons (webhook / paused / scheduled).
 */
export function EditorTabIcon({
  tab,
  connectionIconUrl,
}: {
  tab: Pick<ConsoleTab, "icon" | "kind" | "metadata">;
  connectionIconUrl: string | undefined;
}) {
  if (tab.icon) {
    return (
      <Box
        component="img"
        src={tab.icon}
        alt="tab icon"
        sx={{ width: 18, height: 18 }}
      />
    );
  }
  if (tab.kind === "flow-editor") {
    if (tab.metadata?.flowType === "webhook") {
      return <WebhookIcon {...ICON_PROPS} />;
    }
    if (tab.metadata?.enabled === false) return <PauseIcon {...ICON_PROPS} />;
    return <ScheduleIcon {...ICON_PROPS} />;
  }
  if ((tab.kind ?? "console") === "console" && connectionIconUrl) {
    return (
      <Box
        component="img"
        src={connectionIconUrl}
        alt="db icon"
        sx={{ width: 18, height: 18, objectFit: "contain" }}
      />
    );
  }
  return <TabKindGlyph kind={tab.kind} />;
}
