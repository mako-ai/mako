/**
 * Says when the app's files or status are the last commit because the server
 * was too busy to read the live box (`busy: true` on GET …/files or
 * …/status). Without it, uncommitted edits seem to vanish until the next
 * poll. It disappears on the next live answer.
 */
import { Alert } from "@mui/material";
import { useAppsStore } from "../../store/appsStore";

export const BUSY_READ_NOTICE = "Showing last saved version, live box busy";

export function AppBusyReadNotice({ appId }: { appId: string | null }) {
  const busy = useAppsStore(s => (appId ? s.busyReadByApp[appId] : undefined));
  if (!busy) return null;
  return (
    <Alert severity="info" sx={{ mx: 1, my: 0.5, py: 0 }}>
      {BUSY_READ_NOTICE}
    </Alert>
  );
}
