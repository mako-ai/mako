import { useEffect, useMemo, useRef } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  Chip,
  Alert,
} from "@mui/material";
import { RefreshCw as RefreshIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppStore } from "../store/appStore";
import { buildPreviewHtml, PREVIEW_MESSAGE } from "../app-runtime/preview";

/**
 * Full-screen live preview of a React app. File editing happens in dedicated
 * `app-file` tabs (opened from the sidebar explorer); this tab only renders the
 * sandboxed preview and bridges data-binding requests to the workspace.
 */
export default function AppRenderer({ appId }: { appId: string }) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const appEntity = useAppStore(s => s.openApps[appId]);
  const previewNonce = useAppStore(s => s.previewNonce[appId] ?? 0);
  const previewErrors = useAppStore(s => s.previewErrors[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const bumpPreview = useAppStore(s => s.bumpPreview);
  const setPreviewErrors = useAppStore(s => s.setPreviewErrors);
  const runBinding = useAppStore(s => s.runBinding);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  // Bridge: respond to data-binding requests from the sandboxed iframe.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        iframeRef.current &&
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }
      const data = event.data || {};
      if (data.type === PREVIEW_MESSAGE.runBinding && workspaceId) {
        void runBinding(workspaceId, appId, data.binding).then(result => {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: PREVIEW_MESSAGE.bindingResult,
              requestId: data.requestId,
              success: result.success,
              rows: result.rows,
              error: result.error,
            },
            "*",
          );
        });
      } else if (data.type === PREVIEW_MESSAGE.error) {
        setPreviewErrors(appId, [
          { message: data.message, source: data.source, at: Date.now() },
        ]);
      } else if (data.type === PREVIEW_MESSAGE.ready) {
        setPreviewErrors(appId, []);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [appId, workspaceId, runBinding, setPreviewErrors]);

  // Rebuild the preview document whenever files/deps change (nonce bumps).
  const srcDoc = useMemo(() => {
    if (!appEntity) return "";
    return buildPreviewHtml(appEntity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appEntity?._id, previewNonce]);

  if (!appEntity) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading app…</Typography>
      </Box>
    );
  }

  const errors = previewErrors || [];

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Slim toolbar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {appEntity.title}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          label={appEntity.runtime === "cdn" ? "CDN preview" : "WebContainer"}
        />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Rebuild preview">
          <IconButton size="small" onClick={() => bumpPreview(appId)}>
            <RefreshIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
      </Box>

      {errors.length > 0 && (
        <Alert severity="error" sx={{ borderRadius: 0, py: 0.25 }}>
          <Typography
            variant="caption"
            sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {errors[0].message}
          </Typography>
        </Alert>
      )}

      {/* Full-screen preview */}
      <Box sx={{ flex: 1, minHeight: 0, bgcolor: "#fff" }}>
        <iframe
          ref={iframeRef}
          title={`app-preview-${appId}`}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          style={{ width: "100%", height: "100%", border: "none" }}
        />
      </Box>
    </Box>
  );
}
