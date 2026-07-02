import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Tooltip,
  Typography,
  Chip,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Snackbar,
} from "@mui/material";
import {
  RefreshCw as RefreshIcon,
  Share2 as ShareIcon,
  History as HistoryIcon,
  UploadCloud as PublishIcon,
  CheckCircle2 as PublishedIcon,
  DatabaseZap as RematerializeIcon,
} from "lucide-react";
import { containsDbtSchemaToken } from "@mako/schemas";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { useTheme } from "../contexts/ThemeContext";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import { useAppStore } from "../store/appStore";
import { useVersionStore } from "../store/versionStore";
import { useConsoleStore } from "../store/consoleStore";
import ShareDialog from "./ShareDialog";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { buildPreviewHtml, PREVIEW_MESSAGE } from "../app-runtime/preview";
import { appLocationFromHostSearch } from "../app-runtime/app-location";
import {
  ensureBindingLoaded,
  queryAppDuckDB,
  disposeAppDuckDB,
  bindingTableName,
  checkSandboxDuckDbSql,
  resolveSandboxRowLimit,
  applySandboxRowLimit,
} from "../app-runtime/duckdb";

/**
 * Full-screen live preview of a React app. File editing happens in dedicated
 * `app-file` tabs (opened from the sidebar explorer); this tab only renders the
 * sandboxed preview and bridges data-binding requests to the workspace.
 */
export default function AppRenderer({
  appId,
  tabId,
}: {
  appId: string;
  tabId?: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const isWorkspaceAdmin = useIsWorkspaceAdmin();
  const workspaceId = currentWorkspace?.id;
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishComment, setPublishComment] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishedNotice, setPublishedNotice] = useState<string | null>(null);
  const [rematerializing, setRematerializing] = useState(false);

  // The sandboxed preview inherits the host theme: the current mode seeds the
  // srcdoc, and later toggles are pushed via postMessage (rebuilding the
  // preview takes seconds, so theme changes must never bump the srcdoc).
  const { effectiveMode } = useTheme();
  const effectiveModeRef = useRef(effectiveMode);
  effectiveModeRef.current = effectiveMode;

  const appEntity = useAppStore(s => s.openApps[appId]);
  const previewNonce = useAppStore(s => s.previewNonce[appId] ?? 0);
  const previewErrors = useAppStore(s => s.previewErrors[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const bumpPreview = useAppStore(s => s.bumpPreview);
  const setPreviewErrors = useAppStore(s => s.setPreviewErrors);
  const runBinding = useAppStore(s => s.runBinding);
  const materializeAllBindings = useAppStore(s => s.materializeAllBindings);
  const persistApp = useAppStore(s => s.persistApp);
  const saveVersion = useVersionStore(s => s.saveVersion);

  // dbt preview environment override (per-user view state): only surfaced
  // when a binding is linked to a dbt project and uses {{ dbt_schema }}.
  const dbtProjectId = appEntity?.dataBindings.find(
    b => b.dbtProjectId && containsDbtSchemaToken(b.code),
  )?.dbtProjectId;
  const previewDbtEnv = useAppStore(s => s.previewDbtEnv[appId] ?? null);
  const dbtEnvInfo = useAppStore(s =>
    dbtProjectId ? s.dbtEnvInfo[dbtProjectId] : undefined,
  );
  const fetchDbtEnvInfo = useAppStore(s => s.fetchDbtEnvInfo);
  const setPreviewDbtEnvironment = useAppStore(s => s.setPreviewDbtEnvironment);

  useEffect(() => {
    if (workspaceId && dbtProjectId && !dbtEnvInfo) {
      void fetchDbtEnvInfo(workspaceId, dbtProjectId);
    }
  }, [workspaceId, dbtProjectId, dbtEnvInfo, fetchDbtEnvInfo]);

  const prodEnvName = dbtEnvInfo
    ? dbtEnvInfo.environments.some(env => env.name === "prod")
      ? "prod"
      : dbtEnvInfo.defaultEnvironment
    : null;
  const effectiveDbtEnv =
    previewDbtEnv &&
    dbtEnvInfo?.environments.some(env => env.name === previewDbtEnv)
      ? previewDbtEnv
      : prodEnvName;
  const dbtOverrideActive = Boolean(
    effectiveDbtEnv && prodEnvName && effectiveDbtEnv !== prodEnvName,
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // App router state lives on the owning tab's metadata (`appLocation`), so the
  // single source of truth for the URL stays UrlSync (which derives the address
  // bar from the active tab). Seeding the iframe reads it once, on boot; later
  // navigations flow over postMessage and must never bump the srcdoc.
  const initialAppLocationRef = useRef<string | null>(
    tabId
      ? ((useConsoleStore.getState().tabs[tabId]?.metadata?.appLocation as
          | string
          | undefined) ?? null)
      : null,
  );

  // Persist an app-initiated location change onto the tab. UrlSync then writes
  // it to the shareable URL; this is a no-op when nothing changed.
  const applyAppLocation = useCallback(
    (location: string) => {
      if (!tabId) return;
      const store = useConsoleStore.getState();
      const tab = store.tabs[tabId];
      if (!tab || tab.metadata?.appLocation === location) return;
      store.updateMetadata(tabId, {
        ...(tab.metadata ?? {}),
        appLocation: location,
      });
    },
    [tabId],
  );

  // Owner or workspace admin may publish (mirrors the Share dialog's canManage).
  const canManage =
    !!appEntity &&
    ((appEntity.owner_id ?? appEntity.createdBy) === user?.id ||
      isWorkspaceAdmin);

  // Promote the current draft to the published definition that shared links and
  // viewers render. Flush pending edits first so the checkpoint matches the
  // preview, then refresh so the toolbar's published state stops being stale.
  const handlePublishConfirm = useCallback(async () => {
    if (!workspaceId) return;
    setPublishing(true);
    try {
      await persistApp(workspaceId, appId);
      const result = await saveVersion(
        workspaceId,
        "app",
        appId,
        publishComment.trim(),
      );
      await fetchApp(workspaceId, appId);
      setPublishOpen(false);
      setPublishComment("");
      setPublishedNotice(
        result.success
          ? result.version
            ? `Published version ${result.version}`
            : "Published"
          : (result.error ?? "Failed to publish"),
      );
    } finally {
      setPublishing(false);
    }
  }, [workspaceId, appId, persistApp, saveVersion, publishComment, fetchApp]);

  const hasParquetBindings = !!appEntity?.dataBindings.some(
    b => b.materialization === "parquet",
  );

  // Rebuild every parquet binding's artifact in one shot. Recovers an app whose
  // materialized cache was lost (e.g. a DB restore) — the query definitions and
  // bindings are untouched; only the Parquet artifacts + cache are regenerated.
  const handleRematerialize = useCallback(async () => {
    if (!workspaceId || rematerializing) return;
    setRematerializing(true);
    setPublishedNotice("Rebuilding data for all bindings…");
    try {
      const result = await materializeAllBindings(workspaceId, appId);
      if (result.total === 0) {
        setPublishedNotice("No materialized bindings to rebuild.");
      } else if (result.failed === 0) {
        setPublishedNotice(
          `Rebuilt data for ${result.ready} binding${result.ready === 1 ? "" : "s"}.`,
        );
      } else {
        setPublishedNotice(
          `Rebuilt ${result.ready}/${result.total}. Failed: ${result.errors.join("; ")}`,
        );
      }
    } catch (error) {
      setPublishedNotice(
        error instanceof Error ? error.message : "Failed to rebuild data.",
      );
    } finally {
      setRematerializing(false);
    }
  }, [workspaceId, appId, rematerializing, materializeAllBindings]);

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
        // Preview env override: materialized artifacts always hold PROD data,
        // so a dbt-linked parquet binding falls back to a live (row-capped)
        // execution against the override schema — the prod artifact is never
        // touched or poisoned.
        const dbtLiveOverride =
          dbtOverrideActive &&
          Boolean(binding?.dbtProjectId) &&
          containsDbtSchemaToken(binding?.code ?? "");
        // Materialized binding -> read its table from DuckDB-WASM.
        if (binding?.materialization === "parquet" && !dbtLiveOverride) {
          const rowLimit = resolveSandboxRowLimit(data.rowLimit);
          void ensureBindingLoaded(appId, binding)
            .then(() =>
              queryAppDuckDB(
                appId,
                // +1 so we can tell the iframe when the read was truncated.
                rowLimit == null
                  ? `SELECT * FROM "${bindingTableName(binding.name)}"`
                  : `SELECT * FROM "${bindingTableName(binding.name)}" LIMIT ${rowLimit + 1}`,
              ),
            )
            .then(result => {
              const limited = applySandboxRowLimit(result.rows, rowLimit);
              post({
                type: PREVIEW_MESSAGE.bindingResult,
                requestId: data.requestId,
                success: true,
                rows: limited.rows,
                truncated: limited.truncated,
                rowLimit,
              });
            })
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
        const rowLimit = resolveSandboxRowLimit(data.rowLimit);
        void Promise.all(
          parquetBindings.map(b =>
            ensureBindingLoaded(appId, b).catch(() => false),
          ),
        )
          .then(() => queryAppDuckDB(appId, data.sql))
          .then(result => {
            const limited = applySandboxRowLimit(result.rows, rowLimit);
            post({
              type: PREVIEW_MESSAGE.duckDbResult,
              requestId: data.requestId,
              success: true,
              rows: limited.rows,
              fields: result.fields,
              // True size of the query result, before the bridge cap.
              rowCount: result.rows.length,
              truncated: limited.truncated,
              rowLimit,
            });
          })
          .catch(err =>
            post({
              type: PREVIEW_MESSAGE.duckDbResult,
              requestId: data.requestId,
              success: false,
              error: err instanceof Error ? err.message : "DuckDB query failed",
            }),
          );
      } else if (data.type === PREVIEW_MESSAGE.navigate) {
        if (typeof data.location === "string") applyAppLocation(data.location);
      } else if (data.type === PREVIEW_MESSAGE.error) {
        setBooting(false);
        setPreviewErrors(appId, [
          { message: data.message, source: data.source, at: Date.now() },
        ]);
      } else if (data.type === PREVIEW_MESSAGE.ready) {
        setBooting(false);
        setPreviewErrors(appId, []);
        // Covers a theme toggle that raced the (slow) preview boot.
        post({
          type: PREVIEW_MESSAGE.setTheme,
          theme: effectiveModeRef.current,
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [
    appId,
    workspaceId,
    appEntity,
    runBinding,
    setPreviewErrors,
    applyAppLocation,
    dbtOverrideActive,
  ]);

  // Browser back/forward changes the host URL without a reload; mirror the new
  // app location into the tab and push it to the (already-booted) iframe.
  useEffect(() => {
    const onPopState = () => {
      const location = appLocationFromHostSearch(window.location.search);
      applyAppLocation(location);
      iframeRef.current?.contentWindow?.postMessage(
        { type: PREVIEW_MESSAGE.location, location },
        "*",
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyAppLocation]);

  // Keep the booted preview's theme in sync with the host toggle.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: PREVIEW_MESSAGE.setTheme, theme: effectiveMode },
      "*",
    );
  }, [effectiveMode]);

  // dbt preview env changed: re-run the booted app's data hooks against the
  // new schema (data-refresh epoch) instead of rebuilding the srcdoc — fast,
  // and the running app keeps its UI state.
  const lastDbtEnvRef = useRef<string | null>(null);
  useEffect(() => {
    const current = effectiveDbtEnv ?? null;
    if (lastDbtEnvRef.current !== null && lastDbtEnvRef.current !== current) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: PREVIEW_MESSAGE.dataRefresh },
        "*",
      );
    }
    lastDbtEnvRef.current = current;
  }, [effectiveDbtEnv]);

  // Rebuild the preview document whenever files/deps change (nonce bumps).
  // The theme is read from a ref on purpose: it only seeds the boot paint and
  // must not trigger an expensive rebuild on toggle (set-theme handles that).
  const srcDoc = useMemo(() => {
    if (!appEntity) return "";
    return buildPreviewHtml(appEntity, {
      theme: effectiveModeRef.current,
      location: initialAppLocationRef.current,
    });
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
        {appEntity.hasUnpublishedChanges && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label="Unpublished changes"
          />
        )}
        {/* NOTE: deliberately NOT wrapped in a Tooltip — a tooltip anchored on
            the Select stays visible while its menu is open and covers the
            first menu items. The chip below carries the explanation. */}
        {dbtProjectId && dbtEnvInfo && effectiveDbtEnv && (
          <Select
            size="small"
            variant="outlined"
            value={effectiveDbtEnv}
            onChange={e =>
              setPreviewDbtEnvironment(
                appId,
                e.target.value === prodEnvName ? null : e.target.value,
              )
            }
            sx={{ fontSize: "0.72rem", height: 26, ml: 0.5 }}
          >
            {dbtEnvInfo.environments
              .filter(
                env =>
                  !env.ownerUserId ||
                  env.ownerUserId === user?.id ||
                  env.name === effectiveDbtEnv,
              )
              .map(env => (
                <MenuItem key={env.name} value={env.name}>
                  {env.name === prodEnvName
                    ? `${env.name} (default)`
                    : env.ownerUserId
                      ? `${env.name} (personal)`
                      : env.name}
                </MenuItem>
              ))}
          </Select>
        )}
        {dbtOverrideActive && (
          <Tooltip
            title={
              "dbt data environment for THIS preview only (your view). " +
              "Published/shared viewers always read prod."
            }
          >
            <Chip
              size="small"
              color="info"
              variant="outlined"
              label={`Previewing dbt env: ${effectiveDbtEnv}`}
            />
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        {canManage &&
          (appEntity.hasUnpublishedChanges ? (
            <Button
              size="small"
              variant="contained"
              startIcon={<PublishIcon size={16} strokeWidth={1.5} />}
              onClick={() => setPublishOpen(true)}
            >
              Publish
            </Button>
          ) : (
            <Tooltip title="Draft matches the published version">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  color="inherit"
                  disabled
                  startIcon={<PublishedIcon size={16} strokeWidth={1.5} />}
                >
                  Published
                </Button>
              </span>
            </Tooltip>
          ))}
        {canManage && hasParquetBindings && (
          <Tooltip title="Re-materialize every query's Parquet file">
            <span>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={rematerializing}
                startIcon={
                  rematerializing ? (
                    <CircularProgress size={14} />
                  ) : (
                    <RematerializeIcon size={16} strokeWidth={1.5} />
                  )
                }
                onClick={() => void handleRematerialize()}
              >
                {rematerializing ? "Materializing…" : "Materialize"}
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip title="Version history">
          <IconButton size="small" onClick={() => setHistoryOpen(true)}>
            <HistoryIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Share">
          <IconButton size="small" onClick={() => setShareOpen(true)}>
            <ShareIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Rebuild preview">
          <IconButton size="small" onClick={() => bumpPreview(appId)}>
            <RefreshIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
      </Box>

      <VersionHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        entityType="app"
        entityId={appId}
        onRestore={() => {
          if (workspaceId) {
            void fetchApp(workspaceId, appId).then(() => bumpPreview(appId));
          }
        }}
      />

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        resourceType="app"
        resourceId={appId}
        resourceName={appEntity.title}
        ownerId={appEntity.owner_id ?? appEntity.createdBy}
        access={appEntity.access}
        workspaceRole={appEntity.workspaceRole ?? "viewer"}
        publicShare={appEntity.publicShare ?? { enabled: false }}
        canManage={
          (appEntity.owner_id ?? appEntity.createdBy) === user?.id ||
          isWorkspaceAdmin
        }
        onSharingChanged={changes =>
          useAppStore.getState().applySharingChanges(appId, changes)
        }
      />

      <Dialog
        open={publishOpen}
        onClose={() => !publishing && setPublishOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Publish {appEntity.title}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Snapshots the current draft into version history and publishes it as
            the live version that shared links and viewers see.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Comment (optional)"
            placeholder="e.g. Add revenue chart"
            value={publishComment}
            onChange={e => setPublishComment(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handlePublishConfirm();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPublishOpen(false)} disabled={publishing}>
            Cancel
          </Button>
          <Button
            onClick={handlePublishConfirm}
            variant="contained"
            disabled={publishing}
          >
            {publishing ? "Publishing..." : "Publish"}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!publishedNotice}
        autoHideDuration={4000}
        onClose={() => setPublishedNotice(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message={publishedNotice ?? ""}
      />

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
        sx={{
          flex: 1,
          minHeight: 0,
          bgcolor: "background.default",
          position: "relative",
        }}
      >
        <iframe
          ref={iframeRef}
          title={`app-preview-${appId}`}
          data-mako-app-preview={appId}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox"
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
