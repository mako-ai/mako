import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CircularProgress,
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
import {
  ensureBindingLoaded,
  queryAppDuckDB,
  disposeAppDuckDB,
  bindingTableName,
  checkSandboxDuckDbSql,
  SANDBOX_DUCKDB_ROW_LIMIT,
} from "../app-runtime/duckdb";

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

  // True from the moment a (re)built srcdoc is handed to the iframe until the
  // bootstrap posts ready/error. Loading deps from the CDN and transpiling
  // with Babel can take several seconds; show progress instead of a white box.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  // Preload materialized (parquet) bindings into the app's DuckDB instance.
  useEffect(() => {
    if (!appEntity) return;
    for (const binding of appEntity.dataBindings) {
      if (binding.materialization === "parquet") {
        void ensureBindingLoaded(appId, binding).catch(() => {
          /* surfaced when the app actually queries it */
        });
      }
    }
  }, [appId, appEntity]);

  // Dispose the DuckDB instance when the tab unmounts.
  useEffect(() => {
    return () => {
      void disposeAppDuckDB(appId);
    };
  }, [appId]);

  // Bridge: respond to data + DuckDB requests from the sandboxed iframe.
  useEffect(() => {
    const post = (message: Record<string, unknown>) =>
      iframeRef.current?.contentWindow?.postMessage(message, "*");

    const handler = (event: MessageEvent) => {
      if (
        iframeRef.current &&
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }
      const data = event.data || {};

      if (data.type === PREVIEW_MESSAGE.runBinding && workspaceId) {
        const binding = appEntity?.dataBindings.find(
          b => b.name === data.binding,
        );
        // Materialized binding -> read its table from DuckDB-WASM.
        if (binding?.materialization === "parquet") {
          void ensureBindingLoaded(appId, binding)
            .then(() =>
              queryAppDuckDB(
                appId,
                // +1 so we can tell the iframe when the read was truncated.
                `SELECT * FROM "${bindingTableName(binding.name)}" LIMIT ${SANDBOX_DUCKDB_ROW_LIMIT + 1}`,
              ),
            )
            .then(result =>
              post({
                type: PREVIEW_MESSAGE.bindingResult,
                requestId: data.requestId,
                success: true,
                rows: result.rows.slice(0, SANDBOX_DUCKDB_ROW_LIMIT),
                truncated: result.rows.length > SANDBOX_DUCKDB_ROW_LIMIT,
              }),
            )
            .catch(err =>
              post({
                type: PREVIEW_MESSAGE.bindingResult,
                requestId: data.requestId,
                success: false,
                error:
                  err instanceof Error ? err.message : "DuckDB read failed",
              }),
            );
          return;
        }
        // Live binding -> server execute.
        void runBinding(workspaceId, appId, data.binding).then(result =>
          post({
            type: PREVIEW_MESSAGE.bindingResult,
            requestId: data.requestId,
            success: result.success,
            rows: result.rows,
            error: result.error,
          }),
        );
      } else if (data.type === PREVIEW_MESSAGE.runDuckDb) {
        // Untrusted boundary: the sandboxed app supplies this SQL. Only allow
        // single read-only statements (blocks INSTALL/LOAD/ATTACH/COPY/...).
        const safety = checkSandboxDuckDbSql(String(data.sql ?? ""));
        if (!safety.ok) {
          post({
            type: PREVIEW_MESSAGE.duckDbResult,
            requestId: data.requestId,
            success: false,
            error: safety.error,
          });
          return;
        }
        const parquetBindings = (appEntity?.dataBindings || []).filter(
          b => b.materialization === "parquet",
        );
        void Promise.all(
          parquetBindings.map(b =>
            ensureBindingLoaded(appId, b).catch(() => false),
          ),
        )
          .then(() => queryAppDuckDB(appId, data.sql))
          .then(result =>
            post({
              type: PREVIEW_MESSAGE.duckDbResult,
              requestId: data.requestId,
              success: true,
              rows: result.rows.slice(0, SANDBOX_DUCKDB_ROW_LIMIT),
              fields: result.fields,
              truncated: result.rows.length > SANDBOX_DUCKDB_ROW_LIMIT,
            }),
          )
          .catch(err =>
            post({
              type: PREVIEW_MESSAGE.duckDbResult,
              requestId: data.requestId,
              success: false,
              error: err instanceof Error ? err.message : "DuckDB query failed",
            }),
          );
      } else if (data.type === PREVIEW_MESSAGE.error) {
        setBooting(false);
        setPreviewErrors(appId, [
          { message: data.message, source: data.source, at: Date.now() },
        ]);
      } else if (data.type === PREVIEW_MESSAGE.ready) {
        setBooting(false);
        setPreviewErrors(appId, []);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [appId, workspaceId, appEntity, runBinding, setPreviewErrors]);

  // Rebuild the preview document whenever files/deps change (nonce bumps).
  const srcDoc = useMemo(() => {
    if (!appEntity) return "";
    return buildPreviewHtml(appEntity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appEntity?._id, previewNonce]);

  // Every new srcdoc boots from scratch (deps re-import, Babel re-transpiles).
  useEffect(() => {
    if (srcDoc) setBooting(true);
  }, [srcDoc]);

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
      <Box
        sx={{ flex: 1, minHeight: 0, bgcolor: "#fff", position: "relative" }}
      >
        <iframe
          ref={iframeRef}
          title={`app-preview-${appId}`}
          data-mako-app-preview={appId}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          style={{ width: "100%", height: "100%", border: "none" }}
        />
        {booting && errors.length === 0 && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1.5,
              bgcolor: "background.default",
            }}
          >
            <CircularProgress size={28} />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Building preview…
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Fetching dependencies and compiling in the browser
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
