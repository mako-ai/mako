import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import { useTheme } from "../contexts/ThemeContext";
import { buildPreviewHtml, PREVIEW_MESSAGE } from "../app-runtime/preview";
import {
  appLocationFromHostSearch,
  appLocationToHostSearch,
} from "../app-runtime/app-location";
import { disposeAppDuckDB } from "../app-runtime/duckdb";
import {
  hydrateReadyBindings,
  serveSandboxDuckDbRequest,
  type TokenViewerBinding,
} from "../app-runtime/preview-duckdb";

/**
 * Draft-app preview for signed preview tokens (/preview/:token).
 *
 * The machine-facing sibling of PublicSharePage: rendered outside
 * AuthWrapper with no session, driven by the intentionally-public
 * /api/preview/:token endpoints (see api/src/routes/app-preview.routes.ts).
 * An external agent mints the token over MCP (create_preview_token), opens
 * this page in a browser — its own local one or the server-side render pool
 * — and reads render state through two machine-observable channels:
 *
 *   - `window.__MAKO_PREVIEW_STATE__` = { status, errors[] } for polling
 *   - console lines prefixed `[mako-preview-error]` / `[mako-preview-ready]`
 *
 * useQuery bindings execute live against the DRAFT's stored code (fresh data,
 * no publish required). Materialized (parquet) bindings ALSO hydrate their
 * artifact into this page's DuckDB instance, so useDuckDB apps run their real
 * data layer here — the agent can verify data-populated UI headlessly.
 */

interface PreviewContent {
  type: "app";
  title: string;
  description?: string;
  entrypoint: string;
  expiresAt: string;
  files: Array<{ path: string; contents: string }>;
  dependencies: Record<string, string>;
  dataBindings: TokenViewerBinding[];
}

type PreviewStatus = "booting" | "ready" | "error";

declare global {
  interface Window {
    __MAKO_PREVIEW_STATE__?: { status: PreviewStatus; errors: string[] };
  }
}

function publishPreviewState(status: PreviewStatus, errors: string[]) {
  window.__MAKO_PREVIEW_STATE__ = { status, errors };
  if (status === "ready") {
    // Machine-observable channel: headless drivers watch for this marker.
    // eslint-disable-next-line no-console
    console.log("[mako-preview-ready]");
  }
  for (const error of errors) {
    console.error("[mako-preview-error]", JSON.stringify({ message: error }));
  }
}

export default function AppPreviewPage() {
  const { token = "" } = useParams<{ token: string }>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [content, setContent] = useState<PreviewContent | null>(null);
  const [booting, setBooting] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const { effectiveMode } = useTheme();
  const effectiveModeRef = useRef(effectiveMode);
  effectiveModeRef.current = effectiveMode;

  const initialAppLocationRef = useRef<string>(
    appLocationFromHostSearch(window.location.search),
  );

  // Load the draft definition once per token.
  useEffect(() => {
    if (!token) {
      setLoadError("Invalid preview link");
      setLoading(false);
      publishPreviewState("error", ["Invalid preview link"]);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/preview/${token}`);
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) {
          throw new Error(json?.error || "Preview link is invalid or expired");
        }
        setContent(json.data as PreviewContent);
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Failed to load preview";
        setLoadError(message);
        publishPreviewState("error", [message]);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const writeAppLocation = useCallback((location: string, replace: boolean) => {
    const next = window.location.pathname + appLocationToHostSearch(location);
    if (next === window.location.pathname + window.location.search) return;
    if (replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
  }, []);

  // DuckDB instance for materialized bindings (torn down with the page).
  const duckAppId = `preview-${token}`;
  useEffect(() => {
    return () => {
      void disposeAppDuckDB(duckAppId);
    };
  }, [duckAppId]);

  // Hydrate ready parquet artifacts so useDuckDB runs the real data layer.
  useEffect(() => {
    if (!content) return;
    hydrateReadyBindings(duckAppId, content.dataBindings);
  }, [duckAppId, content]);

  // Bridge: useQuery bindings run live server-side through the token
  // endpoint; useDuckDB runs against the hydrated artifacts in-page.
  useEffect(() => {
    if (!content) return;
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
        void fetch(
          `/api/preview/${token}/binding/${encodeURIComponent(binding.id)}/execute`,
          { method: "POST" },
        )
          .then(async res => {
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) {
              throw new Error(json?.error || "Query failed");
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
              error: err instanceof Error ? err.message : "Query failed",
            }),
          );
      } else if (data.type === PREVIEW_MESSAGE.runDuckDb) {
        const readyBindings = content.dataBindings.filter(
          b => b.ready && b.artifactUrl,
        );
        if (readyBindings.length === 0) {
          const parquetNames = content.dataBindings
            .filter(b => b.materialization === "parquet")
            .map(b => `"${b.name}"`);
          post({
            type: PREVIEW_MESSAGE.duckDbResult,
            requestId: data.requestId,
            success: false,
            error:
              parquetNames.length > 0
                ? `No materialized artifact for ${parquetNames.join(", ")} yet — run materialize_binding first, then reload the preview.`
                : "useDuckDB needs a 'parquet' data binding. Create one (materialization: 'parquet') and run materialize_binding, or read live data with useQuery instead.",
          });
          return;
        }
        serveSandboxDuckDbRequest({
          duckAppId,
          bindings: content.dataBindings,
          requestId: data.requestId,
          sql: data.sql,
          rowLimit: data.rowLimit,
          post,
        });
      } else if (data.type === PREVIEW_MESSAGE.navigate) {
        if (typeof data.location === "string") {
          writeAppLocation(data.location, !!data.replace);
        }
      } else if (data.type === PREVIEW_MESSAGE.error) {
        setBooting(false);
        const message = String(data.message || "App failed to load");
        setPreviewError(message);
        publishPreviewState("error", [message]);
      } else if (data.type === PREVIEW_MESSAGE.ready) {
        setBooting(false);
        setPreviewError(null);
        publishPreviewState("ready", []);
        post({
          type: PREVIEW_MESSAGE.setTheme,
          theme: effectiveModeRef.current,
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [content, token, duckAppId, writeAppLocation]);

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

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: PREVIEW_MESSAGE.setTheme, theme: effectiveMode },
      "*",
    );
  }, [effectiveMode]);

  const srcDoc = useMemo(() => {
    if (!content) return "";
    // buildPreviewHtml only reads entrypoint/dependencies/files (same partial
    // cast PublicAppViewer uses — the full AppEntity never leaves the server).
    const code = {
      entrypoint: content.entrypoint,
      dependencies: content.dependencies,
      files: content.files,
    } as Parameters<typeof buildPreviewHtml>[0];
    return buildPreviewHtml(code, {
      theme: effectiveModeRef.current,
      location: initialAppLocationRef.current,
    });
  }, [content]);

  if (loading) {
    return (
      <Box
        sx={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (loadError || !content) {
    return (
      <Box
        sx={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
          px: 3,
        }}
      >
        <Typography variant="h6">Preview unavailable</Typography>
        <Typography variant="body2" color="text.secondary">
          {loadError || "Preview link is invalid or expired"}
        </Typography>
      </Box>
    );
  }

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
          Draft preview (expires{" "}
          {new Date(content.expiresAt).toLocaleTimeString()})
        </Typography>
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
          title={`preview-app-${token}`}
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
