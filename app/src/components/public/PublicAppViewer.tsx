import { useEffect, useMemo, useRef, useState } from "react";
import { Box, CircularProgress, Typography, Alert } from "@mui/material";
import { useTheme } from "../../contexts/ThemeContext";
import { buildPreviewHtml, PREVIEW_MESSAGE } from "../../app-runtime/preview";
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

export default function PublicAppViewer({ token, content }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [booting, setBooting] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Anonymous visitors have no saved theme preference, so the ThemeProvider
  // default ("system") makes effectiveMode track the OS preference — exactly
  // what a standalone app should inherit. Seed the srcdoc with it and push
  // later changes via postMessage (no srcdoc rebuild).
  const { effectiveMode } = useTheme();
  const effectiveModeRef = useRef(effectiveMode);
  effectiveModeRef.current = effectiveMode;

  const duckAppId = `share-${token}`;

  // Preload all ready parquet bindings.
  useEffect(() => {
    for (const binding of content.dataBindings) {
      const loadable = toLoadableBinding(binding);
      if (loadable) {
        void ensureBindingLoaded(duckAppId, loadable).catch(() => {
          /* surfaced when the app actually queries it */
        });
      }
    }
    return () => {
      void disposeAppDuckDB(duckAppId);
    };
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
        const loadable = binding ? toLoadableBinding(binding) : null;
        if (!loadable) {
          post({
            type: PREVIEW_MESSAGE.bindingResult,
            requestId: data.requestId,
            success: false,
            error: binding
              ? `Data for "${binding.name}" isn't available in the public view`
              : `No data binding named "${data.binding}"`,
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
  }, [duckAppId, content]);

  // Keep the booted preview's theme in sync with system/theme changes.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: PREVIEW_MESSAGE.setTheme, theme: effectiveMode },
      "*",
    );
  }, [effectiveMode]);

  // Theme comes from a ref on purpose: it only seeds the boot paint and must
  // not rebuild the (slow, Babel-compiled) preview — set-theme handles toggles.
  const srcDoc = useMemo(
    () =>
      buildPreviewHtml(
        {
          files: content.files,
          dependencies: content.dependencies,
          entrypoint: content.entrypoint,
        } as Parameters<typeof buildPreviewHtml>[0],
        { theme: effectiveModeRef.current },
      ),
    [content],
  );

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
