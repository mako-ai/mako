import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Typography,
} from "@mui/material";
import { RefreshCw } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { buildPreviewHtml, PREVIEW_MESSAGE } from "../../app-runtime/preview";
import {
  appLocationFromHostSearch,
  appLocationToHostSearch,
} from "../../app-runtime/app-location";
import {
  ensureBindingLoaded,
  queryAppDuckDB,
  disposeAppDuckDB,
  bindingTableName,
  checkSandboxDuckDbSql,
  resolveSandboxRowLimit,
  applySandboxRowLimit,
} from "../../app-runtime/duckdb";
import type { AppDataBinding } from "@mako/schemas";

/**
 * Read-only public app renderer (/share/:token).
 *
 * Reuses the sandboxed iframe preview, but the parent bridge only serves
 * materialized (parquet) bindings fetched from the public share artifact
 * endpoints — live bindings are refused, so anonymous viewers can never
 * trigger query execution against workspace databases.
 */

export interface PublicAppContent {
  type: "app";
  title: string;
  description?: string;
  entrypoint: string;
  files: Array<{ path: string; contents: string }>;
  dependencies: Record<string, string>;
  dataBindings: Array<{
    id: string;
    name: string;
    materialization: "live" | "parquet";
    ready: boolean;
    rowCount: number | null;
    materializedAt: string | null;
    artifactUrl: string | null;
  }>;
}

interface Props {
  token: string;
  content: PublicAppContent;
  reloadContent: () => Promise<PublicAppContent | null>;
}

/** Adapt a public binding to the shape the app DuckDB loader expects. */
function toLoadableBinding(
  binding: PublicAppContent["dataBindings"][number],
): AppDataBinding | null {
  if (!binding.ready || !binding.artifactUrl) return null;
  return {
    id: binding.id,
    name: binding.name,
    connectionId: "",
    language: "sql",
    code: "",
    materialization: "parquet",
    cache: {
      parquetUrl: binding.artifactUrl,
      parquetBuildStatus: "ready",
      artifactRevision: binding.materializedAt || binding.id,
    },
  } as AppDataBinding;
}

function latestMaterializedAt(content: PublicAppContent): string | null {
  const timestamps = content.dataBindings
    .map(binding => binding.materializedAt)
    .filter((value): value is string => !!value)
    .sort();
  return timestamps[timestamps.length - 1] ?? null;
}

export default function PublicAppViewer({
  token,
  content,
  reloadContent,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [booting, setBooting] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  // Anonymous visitors have no saved theme preference, so the ThemeProvider
  // default ("system") makes effectiveMode track the OS preference — exactly
  // what a standalone app should inherit. Seed the srcdoc with it and push
  // later changes via postMessage (no srcdoc rebuild).
  const { effectiveMode } = useTheme();
  const effectiveModeRef = useRef(effectiveMode);
  effectiveModeRef.current = effectiveMode;

  const duckAppId = `share-${token}`;

  // The public viewer owns its `/share/:token` URL directly (no tab system),
  // so it seeds the app's location from the address bar on load and writes it
  // back on navigate — making deep links + reloads restore the same view.
  const initialAppLocationRef = useRef<string>(
    appLocationFromHostSearch(window.location.search),
  );

  const writeAppLocation = useCallback((location: string, replace: boolean) => {
    const next = window.location.pathname + appLocationToHostSearch(location);
    if (next === window.location.pathname + window.location.search) return;
    if (replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
  }, []);

  // Tear down the app's DuckDB instance only when the viewer unmounts. This
  // MUST NOT depend on `content`: the refresh poll calls reloadContent() (and
  // thus setContent) on every attempt, so a content-keyed cleanup would
  // dispose + recreate the instance every few seconds — wiping every loaded
  // table out from under the running app and breaking its queries mid-refresh.
  useEffect(() => {
    return () => {
      void disposeAppDuckDB(duckAppId);
    };
  }, [duckAppId]);

  // (Re)load ready parquet bindings whenever content changes. ensureBindingLoaded
  // is revision-cached (no-op when unchanged) and reloads in place when a new
  // snapshot is ready, so bindings still mid-rematerialization keep their
  // previously-loaded table instead of being dropped.
  useEffect(() => {
    for (const binding of content.dataBindings) {
      const loadable = toLoadableBinding(binding);
      if (loadable) {
        void ensureBindingLoaded(duckAppId, loadable).catch(() => {
          /* surfaced when the app actually queries it */
        });
      }
    }
  }, [duckAppId, content]);

  // Bridge: serve binding + DuckDB requests from snapshot data only.
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

      if (data.type === PREVIEW_MESSAGE.runBinding) {
        const binding = content.dataBindings.find(b => b.name === data.binding);
        if (!binding) {
          post({
            type: PREVIEW_MESSAGE.bindingResult,
            requestId: data.requestId,
            success: false,
            error: `No data binding named "${data.binding}"`,
          });
          return;
        }
        // Live binding -> run the app's PUBLISHED query server-side (read-only,
        // row-capped, time-bounded). The viewer never supplies SQL. Parquet
        // bindings fall through to the snapshot-artifact path below.
        if (binding.materialization !== "parquet") {
          void fetch(
            `/api/share/${token}/binding/${encodeURIComponent(binding.id)}/execute`,
            { method: "POST", credentials: "include" },
          )
            .then(async res => {
              const json = await res.json().catch(() => null);
              if (!res.ok || !json?.success) {
                throw new Error(json?.error || "Live query failed");
              }
              post({
                type: PREVIEW_MESSAGE.bindingResult,
                requestId: data.requestId,
                success: true,
                rows: json.rows || [],
              });
            })
            .catch(err =>
              post({
                type: PREVIEW_MESSAGE.bindingResult,
                requestId: data.requestId,
                success: false,
                error: err instanceof Error ? err.message : "Live query failed",
              }),
            );
          return;
        }
        const loadable = toLoadableBinding(binding);
        if (!loadable) {
          post({
            type: PREVIEW_MESSAGE.bindingResult,
            requestId: data.requestId,
            success: false,
            error: `Data for "${binding.name}" isn't available in the public view`,
          });
          return;
        }
        const rowLimit = resolveSandboxRowLimit(data.rowLimit);
        void ensureBindingLoaded(duckAppId, loadable)
          .then(() =>
            queryAppDuckDB(
              duckAppId,
              rowLimit == null
                ? `SELECT * FROM "${bindingTableName(loadable.name)}"`
                : `SELECT * FROM "${bindingTableName(loadable.name)}" LIMIT ${rowLimit + 1}`,
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
              error: err instanceof Error ? err.message : "DuckDB read failed",
            }),
          );
      } else if (data.type === PREVIEW_MESSAGE.runDuckDb) {
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
        const loadables = content.dataBindings
          .map(toLoadableBinding)
          .filter((b): b is AppDataBinding => !!b);
        const rowLimit = resolveSandboxRowLimit(data.rowLimit);
        void Promise.all(
          loadables.map(b =>
            ensureBindingLoaded(duckAppId, b).catch(() => false),
          ),
        )
          .then(() => queryAppDuckDB(duckAppId, data.sql))
          .then(result => {
            const limited = applySandboxRowLimit(result.rows, rowLimit);
            post({
              type: PREVIEW_MESSAGE.duckDbResult,
              requestId: data.requestId,
              success: true,
              rows: limited.rows,
              fields: result.fields,
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
        if (typeof data.location === "string") {
          writeAppLocation(data.location, !!data.replace);
        }
      } else if (data.type === PREVIEW_MESSAGE.error) {
        setBooting(false);
        setPreviewError(String(data.message || "App failed to load"));
      } else if (data.type === PREVIEW_MESSAGE.ready) {
        setBooting(false);
        setPreviewError(null);
        // Covers a theme change that raced the (slow) preview boot.
        post({
          type: PREVIEW_MESSAGE.setTheme,
          theme: effectiveModeRef.current,
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [duckAppId, content, writeAppLocation, token]);

  // Reflect browser back/forward into the booted iframe.
  useEffect(() => {
    const onPopState = () => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: PREVIEW_MESSAGE.location,
          location: appLocationFromHostSearch(window.location.search),
        },
        "*",
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Keep the booted preview's theme in sync with system/theme changes.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: PREVIEW_MESSAGE.setTheme, theme: effectiveMode },
      "*",
    );
  }, [effectiveMode]);

  // Rebuild the (slow, Babel-compiled) preview only when the app's *code*
  // changes — never on data-only refreshes. The refresh poll swaps in a fresh
  // `content` object every few seconds; keying the srcdoc on the whole object
  // would reboot the iframe each time and reset the running app's UI state.
  // Data bindings reach the app over the message bridge, not the srcdoc, so
  // they're deliberately excluded from this signature.
  const codeSignature = useMemo(
    () =>
      JSON.stringify({
        entrypoint: content.entrypoint,
        dependencies: content.dependencies,
        files: content.files,
      }),
    [content],
  );

  // Theme comes from a ref on purpose: it only seeds the boot paint and must
  // not rebuild the preview — set-theme handles toggles. The app code is parsed
  // back from `codeSignature` so the memo recomputes only when the code changes.
  const srcDoc = useMemo(() => {
    const code = JSON.parse(codeSignature) as Parameters<
      typeof buildPreviewHtml
    >[0];
    return buildPreviewHtml(code, {
      theme: effectiveModeRef.current,
      location: initialAppLocationRef.current,
    });
  }, [codeSignature]);

  const hasMaterializedBindings = content.dataBindings.some(
    binding => binding.materialization === "parquet",
  );

  const handleRefresh = async () => {
    if (!hasMaterializedBindings) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch(`/api/share/${token}/refresh`, {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => null);
      if (res.status === 429) {
        const retryMin = Math.ceil((json?.retryAfterMs ?? 60000) / 60000);
        setRefreshNote(
          `Data was refreshed recently — try again in ~${retryMin} min.`,
        );
        return;
      }
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "Failed to refresh");
      }

      setRefreshNote("Refreshing data…");
      const before = latestMaterializedAt(contentRef.current);
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 8000));
        const fresh = await reloadContent();
        if (fresh && latestMaterializedAt(fresh) !== before) {
          // Pull the new snapshots into DuckDB *before* telling the booted app
          // to re-query — otherwise its hooks could read the previous table.
          // ensureBindingLoaded reloads in place (revision changed), and the
          // shared per-table lock dedupes this with the content-change effect.
          await Promise.all(
            fresh.dataBindings.map(binding => {
              const loadable = toLoadableBinding(binding);
              return loadable
                ? ensureBindingLoaded(duckAppId, loadable).catch(() => false)
                : Promise.resolve(false);
            }),
          );
          iframeRef.current?.contentWindow?.postMessage(
            { type: PREVIEW_MESSAGE.dataRefresh },
            "*",
          );
          setRefreshNote(null);
          return;
        }
      }
      setRefreshNote(
        "Refresh is still running. Reload in a moment to see the latest snapshot.",
      );
    } catch (error) {
      setRefreshNote(
        error instanceof Error ? error.message : "Failed to refresh data.",
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {content.title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Shared read-only view
        </Typography>
        <Box sx={{ flex: 1 }} />
        {refreshNote && (
          <Typography variant="caption" color="text.secondary">
            {refreshNote}
          </Typography>
        )}
        <Button
          size="small"
          variant="outlined"
          startIcon={
            refreshing ? (
              <CircularProgress size={14} />
            ) : (
              <RefreshCw size={14} />
            )
          }
          onClick={() => void handleRefresh()}
          disabled={!hasMaterializedBindings || refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh data"}
        </Button>
      </Box>

      {previewError && (
        <Alert severity="error" sx={{ borderRadius: 0, py: 0.25 }}>
          <Typography
            variant="caption"
            sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {previewError}
          </Typography>
        </Alert>
      )}

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
          title={`public-app-${token}`}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox"
          style={{ width: "100%", height: "100%", border: "none" }}
        />
        {booting && !previewError && (
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
              Loading app…
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
