import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  Chip,
  Alert,
} from "@mui/material";
import {
  RefreshCw as RefreshIcon,
  Save as SaveIcon,
  FileCode as FileIcon,
} from "lucide-react";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppStore } from "../store/appStore";
import { buildPreviewHtml, PREVIEW_MESSAGE } from "../app-runtime/preview";

function languageForPath(path: string): string {
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".jsx") || path.endsWith(".js") || path.endsWith(".mjs")) {
    return "javascript";
  }
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

export default function AppRenderer({ appId }: { appId: string }) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const appEntity = useAppStore(s => s.openApps[appId]);
  const previewNonce = useAppStore(s => s.previewNonce[appId] ?? 0);
  const previewErrors = useAppStore(s => s.previewErrors[appId]);
  const focusedFile = useAppStore(s => s.focusedFile[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const writeFile = useAppStore(s => s.writeFile);
  const persistApp = useAppStore(s => s.persistApp);
  const bumpPreview = useAppStore(s => s.bumpPreview);
  const setPreviewErrors = useAppStore(s => s.setPreviewErrors);
  const runBinding = useAppStore(s => s.runBinding);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  // Select the focused file (from explorer), else entrypoint, else first file.
  useEffect(() => {
    if (!appEntity) return;
    if (focusedFile && appEntity.files.some(f => f.path === focusedFile)) {
      setSelectedPath(focusedFile);
      return;
    }
    setSelectedPath(prev => {
      if (prev && appEntity.files.some(f => f.path === prev)) return prev;
      return (
        appEntity.files.find(f => f.path === appEntity.entrypoint)?.path ??
        appEntity.files[0]?.path ??
        null
      );
    });
  }, [appEntity, focusedFile]);

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

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!selectedPath) return;
      writeFile(appId, selectedPath, value ?? "");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (workspaceId) {
        saveTimer.current = setTimeout(() => {
          void persistApp(workspaceId, appId);
        }, 1200);
      }
    },
    [appId, selectedPath, workspaceId, writeFile, persistApp],
  );

  const handleSave = useCallback(() => {
    if (workspaceId) void persistApp(workspaceId, appId);
  }, [workspaceId, appId, persistApp]);

  if (!appEntity) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading app…</Typography>
      </Box>
    );
  }

  const selectedFile = appEntity.files.find(f => f.path === selectedPath);
  const errors = previewErrors || [];

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
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
        <Tooltip title="Save">
          <IconButton size="small" onClick={handleSave}>
            <SaveIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Rebuild preview">
          <IconButton size="small" onClick={() => bumpPreview(appId)}>
            <RefreshIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* File list */}
        <Box
          sx={{
            width: 200,
            flexShrink: 0,
            borderRight: "1px solid",
            borderColor: "divider",
            overflowY: "auto",
          }}
        >
          {appEntity.files.map(file => (
            <Box
              key={file.path}
              onClick={() => setSelectedPath(file.path)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                px: 1,
                py: 0.5,
                cursor: "pointer",
                fontSize: "0.8rem",
                backgroundColor:
                  selectedPath === file.path
                    ? "action.selected"
                    : "transparent",
                "&:hover": { backgroundColor: "action.hover" },
              }}
            >
              <FileIcon size={14} strokeWidth={1.5} />
              <Typography
                variant="caption"
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {file.path}
              </Typography>
            </Box>
          ))}
        </Box>

        {/* Editor */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            borderRight: "1px solid",
            borderColor: "divider",
          }}
        >
          {selectedFile ? (
            <MonacoEditor
              height="100%"
              path={selectedFile.path}
              language={languageForPath(selectedFile.path)}
              value={selectedFile.contents}
              onChange={handleEditorChange}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                automaticLayout: true,
                scrollBeyondLastLine: false,
              }}
            />
          ) : (
            <Box sx={{ p: 2, color: "text.secondary" }}>
              <Typography variant="body2">No file selected</Typography>
            </Box>
          )}
        </Box>

        {/* Preview */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
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
      </Box>
    </Box>
  );
}
