import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Tooltip,
  Typography,
  Alert,
  Snackbar,
} from "@mui/material";
import {
  RefreshCw as RefreshIcon,
  Share2 as ShareIcon,
  History as HistoryIcon,
  UploadCloud as PublishIcon,
  CheckCircle2 as PublishedIcon,
  DatabaseZap as RematerializeIcon,
  MoreVertical as MoreIcon,
  Info as InfoIcon,
} from "lucide-react";
import { containsDbtSchemaToken } from "@mako/schemas";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { useTheme } from "../contexts/ThemeContext";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import { useAppStore } from "../store/appStore";
import { useVersionStore } from "../store/versionStore";
import { useConsoleStore } from "../store/consoleStore";
import ShareDialog from "./ShareDialog";
import { SaveCommentDialog } from "./SaveCommentDialog";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { useSaveCommentSuggestion } from "../hooks/useSaveCommentSuggestion";
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
import { ensureBindingLoadedForPreview } from "../app-runtime/binding-preview";

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
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const publishSuggestion = useSaveCommentSuggestion();
  const [publishedNotice, setPublishedNotice] = useState<string | null>(null);
  const [rematerializing, setRematerializing] = useState(false);
  const [rematerializeProgress, setRematerializeProgress] = useState<{
    total: number;
    settled: number;
    ready: number;
    failed: number;
    phase: "building" | "loading";
  } | null>(null);

  // The sandboxed preview inherits the host theme: the current mode seeds the
  // srcdoc, and later toggles are pushed via postMessage (rebuilding the
  // preview takes seconds, so theme changes must never bump the srcdoc).
  const { effectiveMode } = useTheme();
  const effectiveModeRef = useRef(effectiveMode);
  effectiveModeRef.current = effectiveMode;

  const appEntity = useAppStore(s => s.openApps[appId]);
  const appLoadError = useAppStore(s => s.openAppErrors[appId]);
  const previewNonce = useAppStore(s => s.previewNonce[appId] ?? 0);
  const previewErrors = useAppStore(s => s.previewErrors[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const bumpPreview = useAppStore(s => s.bumpPreview);
  const setPreviewErrors = useAppStore(s => s.setPreviewErrors);
  const runBinding = useAppStore(s => s.runBinding);
  const materializeBinding = useAppStore(s => s.materializeBinding);
  const materializeAllBindings = useAppStore(s => s.materializeAllBindings);
  const persistApp = useAppStore(s => s.persistApp);
  const generateSaveComment = useAppStore(s => s.generateSaveComment);
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

  // Open the publish dialog and kick off the AI commit-message suggestion.
  // The draft is flushed first so the server-side diff (draft vs last saved
  // version) matches what's on screen.
  const openPublishDialog = useCallback(() => {
    setPublishOpen(true);
    if (!workspaceId) return;
    publishSuggestion.begin(async signal => {
      await persistApp(workspaceId, appId);
      if (signal.aborted) return { comment: null, diff: null };
      return generateSaveComment(workspaceId, appId, signal);
    });
  }, [workspaceId, appId, persistApp, generateSaveComment, publishSuggestion]);

  const closePublishDialog = useCallback(() => {
    publishSuggestion.cancel();
    setPublishOpen(false);
  }, [publishSuggestion]);

  // Promote the current draft to the published definition that shared links and
  // viewers render. Flush pending edits first so the checkpoint matches the
  // preview, then refresh so the toolbar's published state stops being stale.
  const handlePublishConfirm = useCallback(
    async (comment: string) => {
      if (!workspaceId) return;
      setPublishing(true);
      try {
        await persistApp(workspaceId, appId);
        const result = await saveVersion(
          workspaceId,
          "app",
          appId,
          comment.trim(),
        );
        await fetchApp(workspaceId, appId);
        publishSuggestion.cancel();
        setPublishOpen(false);
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
    },
    [workspaceId, appId, persistApp, saveVersion, fetchApp, publishSuggestion],
  );

  const hasParquetBindings = !!appEntity?.dataBindings.some(
    b => b.materialization === "parquet",
  );

  // Rebuild every parquet binding's artifact in one shot. Recovers an app whose
  // materialized cache was lost (e.g. a DB restore) — the query definitions and
  // bindings are untouched; only the Parquet artifacts + cache are regenerated.
  // Wait for every binding to settle, load fresh DuckDB tables, then post a
  // data-refresh — never rebuild the preview mid-flight with partial data.
  const handleRematerialize = useCallback(async () => {
    if (!workspaceId || rematerializing) return;
    setRematerializing(true);
    setRematerializeProgress({
      total: 0,
      settled: 0,
      ready: 0,
      failed: 0,
      phase: "building",
    });
    setPublishedNotice("Rebuilding data for all bindings…");
    try {
      const result = await materializeAllBindings(workspaceId, appId, {
        onProgress: progress =>
          setRematerializeProgress({ ...progress, phase: "building" }),
      });
      if (result.total === 0) {
        setPublishedNotice("No materialized bindings to rebuild.");
        return;
      }

      // Pull every ready snapshot into DuckDB before telling the booted app
      // to re-query — same pattern as the public share refresh path.
      setRematerializeProgress(prev =>
        prev ? { ...prev, phase: "loading" } : prev,
      );
      setPublishedNotice("Loading refreshed data…");
      const freshApp = useAppStore.getState().openApps[appId];
      if (freshApp) {
        await Promise.all(
          freshApp.dataBindings
            .filter(binding => binding.materialization === "parquet")
            .map(binding => {
              const load = ensureBindingLoadedForPreview(
                workspaceId,
                appId,
                binding,
              );
              return load.catch(() => false);
            }),
        );
      }
      iframeRef.current?.contentWindow?.postMessage(
        { type: PREVIEW_MESSAGE.dataRefresh },
        "*",
      );

      if (result.failed === 0) {
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
      setRematerializeProgress(null);
    }
  }, [workspaceId, appId, rematerializing, materializeAllBindings]);

  // True from the moment a (re)built srcdoc is handed to the iframe until the
  // bootstrap posts ready/error. Loading deps from the CDN and transpiling
  // with Babel can take several seconds; show progress instead of a white box.
  const [booting, setBooting] = useState(true);

  // If the iframe never posts ready/error (crash, hung CDN), clear the overlay
  // so users aren't stuck on a black "Building preview…" screen.
  useEffect(() => {
    if (!booting) return;
    const timer = window.setTimeout(() => setBooting(false), 20_000);
    return () => window.clearTimeout(timer);
  }, [booting, previewNonce]);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  // Preload materialized (parquet) bindings into the app's DuckDB instance.
  // Preview-env aware: while a dbt override is active, dbt-linked bindings
  // load a live (row-capped) run against the override schema instead of the
  // prod Parquet artifact — re-runs when the effective env changes so the
  // tables swap in both directions.
  useEffect(() => {
    if (!appEntity) return;
    for (const binding of appEntity.dataBindings) {
      if (binding.materialization === "parquet") {
        const load = workspaceId
          ? ensureBindingLoadedForPreview(workspaceId, appId, binding)
          : ensureBindingLoaded(appId, binding);
        void load.catch(() => {
          /* surfaced when the app actually queries it */
        });
      }
    }
  }, [appId, appEntity, workspaceId, effectiveDbtEnv]);

  // Auto-materialize: when a parquet binding's reads are about to hit the
  // artifact path but no artifact exists (never materialized, or the cache
  // was lost), queue its build automatically instead of leaving the app on a
  // "table does not exist" error — e.g. switching the dbt preview env back to
  // prod before the first build. Scoped tightly:
  // - dbt-linked bindings serving a LIVE override run are skipped (building
  //   would be pointless there: artifacts always hold prod data);
  // - an errored build is NOT retried (no rebuild loops for broken queries —
  //   the binding editor surfaces the error);
  // - one attempt per binding per mount; the server-side per-binding claim
  //   dedupes against builds already in flight.
  const autoMaterializeAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!appEntity || !workspaceId) return;
    for (const binding of appEntity.dataBindings) {
      if (binding.materialization !== "parquet") continue;
      const servesLiveOverride =
        dbtOverrideActive &&
        Boolean(binding.dbtProjectId) &&
        containsDbtSchemaToken(binding.code);
      if (servesLiveOverride) continue;
      const status = binding.cache?.parquetBuildStatus;
      const hasArtifact =
        status === "ready" && Boolean(binding.cache?.parquetUrl);
      if (hasArtifact || status === "error") continue;
      if (autoMaterializeAttempted.current.has(binding.id)) continue;
      autoMaterializeAttempted.current.add(binding.id);
      setPublishedNotice(`Building data for "${binding.name}"…`);
      void materializeBinding(workspaceId, appId, binding.id).then(result => {
        if (result.status === "ready") {
          // materializeBinding already refetched the app and bumped the
          // preview, so the fresh artifact loads on the rebuilt preview.
          setPublishedNotice(`Data for "${binding.name}" is ready.`);
        } else if (result.status === "error") {
          setPublishedNotice(
            `Failed to build "${binding.name}": ${result.error ?? "unknown error"}`,
          );
        }
      });
    }
  }, [appId, appEntity, workspaceId, dbtOverrideActive, materializeBinding]);

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
        // Materialized binding -> read its table from DuckDB-WASM. The
        // preview-aware loader also evicts rows a previous env override left
        // behind when no prod artifact exists to reload (stale-data guard).
        if (binding?.materialization === "parquet" && !dbtLiveOverride) {
          const rowLimit = resolveSandboxRowLimit(data.rowLimit);
          void ensureBindingLoadedForPreview(workspaceId, appId, binding)
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
        // Preview-env aware: dbt-linked tables hold override data while a
        // preview env is active (see ensureBindingLoadedForPreview).
        void Promise.all(
          parquetBindings.map(b =>
            (workspaceId
              ? ensureBindingLoadedForPreview(workspaceId, appId, b)
              : ensureBindingLoaded(appId, b)
            ).catch(() => false),
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
  // Keyed on the nonce (not just the srcdoc string): a manual "Rebuild
  // preview" with unchanged code regenerates an identical string, which
  // Object.is-equal deps would ignore.
  useEffect(() => {
    if (srcDoc) setBooting(true);
  }, [srcDoc, previewNonce]);

  if (!appEntity) {
    if (appLoadError) {
      return (
        <EntityLoadErrorState
          error={appLoadError}
          entityLabel="app"
          onRetry={() => {
            if (workspaceId) void fetchApp(workspaceId, appId);
          }}
        />
      );
    }
    return <EntityLoadingState label="Loading app…" />;
  }

  const errors = previewErrors || [];

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Slim toolbar. Kept deliberately sparse so it fits narrow screens:
          secondary info (runtime) and rare actions (materialize, history)
          live in the overflow menu; draft state is a dot, not a chip. */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 0.5,
          minWidth: 0,
          overflow: "hidden",
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography
          variant="body2"
          noWrap
          sx={{ fontWeight: 600, minWidth: 0, flexShrink: 1 }}
        >
          {appEntity.title}
        </Typography>
        {appEntity.hasUnpublishedChanges && (
          <Tooltip title="Unpublished changes — viewers still see the last published version">
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                bgcolor: "warning.main",
                flexShrink: 0,
              }}
            />
          </Tooltip>
        )}
        {/* NOTE: deliberately NOT wrapped in a Tooltip — a tooltip anchored on
            the Select stays visible while its menu is open and covers the
            first menu items. The info icon next to it carries the
            explanation while an override is active. */}
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
            sx={{
              fontSize: "0.72rem",
              height: 26,
              ml: 0.5,
              flexShrink: 0,
              ...(dbtOverrideActive && { color: "info.main" }),
            }}
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
              `Previewing dbt env "${effectiveDbtEnv}" — for THIS preview ` +
              "only (your view). Published/shared viewers always read prod."
            }
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                color: "info.main",
                flexShrink: 0,
              }}
            >
              <InfoIcon size={15} strokeWidth={1.5} />
            </Box>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        {canManage &&
          (appEntity.hasUnpublishedChanges ? (
            <Button
              size="small"
              variant="contained"
              startIcon={<PublishIcon size={16} strokeWidth={1.5} />}
              onClick={openPublishDialog}
              sx={{ flexShrink: 0 }}
            >
              Publish
            </Button>
          ) : (
            <Tooltip title="Published — draft matches the published version">
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  color: "success.main",
                  flexShrink: 0,
                }}
              >
                <PublishedIcon size={18} strokeWidth={1.5} />
              </Box>
            </Tooltip>
          ))}
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
        <Tooltip title="More">
          <IconButton
            size="small"
            onClick={e => setMoreAnchor(e.currentTarget)}
          >
            <MoreIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
      </Box>

      <Menu
        anchorEl={moreAnchor}
        open={!!moreAnchor}
        onClose={() => setMoreAnchor(null)}
      >
        <MenuItem
          onClick={() => {
            setMoreAnchor(null);
            setHistoryOpen(true);
          }}
        >
          <ListItemIcon>
            <HistoryIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          <ListItemText>Version history</ListItemText>
        </MenuItem>
        {canManage && hasParquetBindings && (
          <MenuItem
            disabled={rematerializing}
            onClick={() => {
              setMoreAnchor(null);
              void handleRematerialize();
            }}
          >
            <ListItemIcon>
              {rematerializing ? (
                <CircularProgress size={14} />
              ) : (
                <RematerializeIcon size={16} strokeWidth={1.5} />
              )}
            </ListItemIcon>
            <ListItemText
              primary={rematerializing ? "Materializing…" : "Materialize data"}
              secondary="Rebuild every query's Parquet file"
            />
          </MenuItem>
        )}
        <Divider />
        <MenuItem disabled sx={{ "&.Mui-disabled": { opacity: 1 } }}>
          <ListItemText
            secondary={`Runtime: ${
              appEntity.runtime === "cdn" ? "CDN preview" : "WebContainer"
            }`}
          />
        </MenuItem>
      </Menu>

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

      <SaveCommentDialog
        open={publishOpen}
        title={`Publish ${appEntity.title}`}
        description="Snapshots the current draft into version history and publishes it as the live version that shared links and viewers see."
        confirmLabel={publishing ? "Publishing..." : "Publish"}
        busy={publishing}
        defaultComment={publishSuggestion.comment}
        loading={publishSuggestion.loading}
        diff={publishSuggestion.diff}
        onCancel={closePublishDialog}
        onSave={comment => void handlePublishConfirm(comment)}
      />

      <Snackbar
        open={!!publishedNotice && !rematerializing}
        autoHideDuration={4000}
        onClose={() => setPublishedNotice(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message={publishedNotice ?? ""}
      />

      {rematerializeProgress && (
        <Box sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
          <LinearProgress
            variant={
              rematerializeProgress.total > 0 &&
              rematerializeProgress.phase === "building"
                ? "determinate"
                : "indeterminate"
            }
            value={
              rematerializeProgress.total > 0
                ? (rematerializeProgress.settled /
                    rematerializeProgress.total) *
                  100
                : undefined
            }
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", px: 1.5, py: 0.5 }}
          >
            {rematerializeProgress.phase === "loading"
              ? "Loading refreshed data into the preview…"
              : rematerializeProgress.total > 0
                ? `Rebuilding data ${rematerializeProgress.settled}/${rematerializeProgress.total}` +
                  (rematerializeProgress.failed > 0
                    ? ` (${rematerializeProgress.failed} failed)`
                    : "")
                : "Rebuilding data for all bindings…"}
          </Typography>
        </Box>
      )}

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
          // Keyed on the nonce so "Rebuild preview" always reboots: with
          // unchanged code the regenerated srcDoc string is identical, so a
          // srcdoc-prop update alone would be skipped by React entirely.
          key={previewNonce}
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
