import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  LinearProgress,
  Typography,
} from "@mui/material";
import { useAppsStore } from "../../store/appsStore";
import { TAB_KIND_ICONS } from "../../lib/entity-icons";
import { usePreviewActivity } from "./usePreviewActivity";

/** Streams the dev boot log (npm install → vite) while a server starts. */
export function DevBootLog({
  workspaceId,
  appId,
}: {
  workspaceId: string;
  appId: string;
}) {
  const fetchDevLog = useAppsStore(s => s.fetchDevLog);
  const [text, setText] = useState("");
  const offsetRef = useRef(0);
  useEffect(() => {
    let alive = true;
    offsetRef.current = 0;
    const ansi = new RegExp(
      String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]",
      "g",
    );
    const tick = async () => {
      const { size, chunk } = await fetchDevLog(
        workspaceId,
        appId,
        offsetRef.current,
      );
      if (!alive) return;
      offsetRef.current = size;
      if (chunk) {
        setText(t =>
          (t + chunk.replace(ansi, "").replace(/\r/g, "")).slice(-20000),
        );
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [workspaceId, appId, fetchDevLog]);
  return <BuildLogPanel text={text} title="Dev server starting…" />;
}

/** Live build output during a publish — the streamed npm/vite log. */
export function BuildLogPanel({
  text,
  title = "Building & publishing…",
}: {
  text: string;
  title?: string;
}) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    // Follow the tail as the build streams.
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  // The build output carries ANSI color codes; strip them for a plain reader.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "#1e1e1e",
        color: "#d4d4d4",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 1,
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          flexShrink: 0,
        }}
      >
        <CircularProgress size={14} sx={{ color: "#d4d4d4" }} />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Box>
      <Box
        component="pre"
        ref={ref}
        sx={{
          flex: 1,
          m: 0,
          p: 1.5,
          overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {clean || "Starting build…"}
      </Box>
    </Box>
  );
}

/**
 * What an app tab shows while it opens: the app's name over an indeterminate
 * bar, so a loading app reads as "opening", never as an empty or
 * never-built one.
 */
export function AppOpeningState({ title }: { title?: string }) {
  const AppIcon = TAB_KIND_ICONS.app;
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1.5,
        p: 4,
        textAlign: "center",
        bgcolor: "background.default",
        color: "text.secondary",
      }}
    >
      <AppIcon size={32} strokeWidth={1.5} />
      <Typography
        variant="subtitle1"
        sx={{
          color: "text.primary",
        }}
      >
        {title ?? "App"}
      </Typography>
      <LinearProgress sx={{ width: 160, borderRadius: 1 }} />
      <Typography variant="caption">Opening…</Typography>
    </Box>
  );
}

type AppPreviewState = ReturnType<
  typeof useAppsStore.getState
>["previewByApp"][string];

/**
 * The dev-mode preview: build log while booting, the live iframe, or the
 * getting-started copy. Shared by the desktop split and the phone layout.
 */
export function DevPreviewPane({
  workspaceId,
  appId,
  appTitle,
  preview,
  hiddenPaused,
  previewNonce,
}: {
  workspaceId: string;
  appId: string;
  appTitle: string | undefined;
  preview: AppPreviewState | undefined;
  hiddenPaused: boolean;
  previewNonce: number;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const previewActivity = usePreviewActivity(workspaceId, appId, frameRef);
  return preview?.building && preview.publishing ? (
    <BuildLogPanel text={preview.buildOutput ?? ""} />
  ) : preview?.building ? (
    // A 60-second cold boot behind a bare spinner reads as frozen.
    // The boot writes a real log (npm install → vite); stream its
    // tail here so starting reads as PROGRESS.
    <DevBootLog workspaceId={workspaceId} appId={appId} />
  ) : preview?.mode === "dev" && preview.reachable === false ? (
    <Alert severity="warning" sx={{ m: 2 }}>
      A dev server for this app is running in the sandbox but rejects the
      preview host — it was started outside Mako without{" "}
      <code>server.allowedHosts</code> including{" "}
      <code>&quot;.e2b.app&quot;</code>. Use{" "}
      <strong>Restart dev session</strong> to let Mako run it, or add that host
      to the app&apos;s <code>vite.config</code>.
    </Alert>
  ) : hiddenPaused ? (
    <Alert severity="info" sx={{ m: 2 }}>
      Preview paused after 10 minutes in the background — its sockets are
      released so the sandbox can sleep. It resumes when you come back.
    </Alert>
  ) : preview?.url ? (
    // Pointing at, moving over or clicking into the preview is real use of
    // the sandbox (usePreviewActivity); an open but untouched tab is not.
    <Box
      sx={{ width: "100%", height: "100%", display: "flex" }}
      onPointerEnter={previewActivity.onPointerEnter}
      onPointerMove={previewActivity.onPointerMove}
    >
      <iframe
        key={`dev-${previewNonce}`}
        ref={frameRef}
        title="App preview"
        src={preview.url}
        // The two preview tiers need DIFFERENT sandboxes.
        //
        // Static builds are served by Mako from Mako's own origin, so
        // `allow-same-origin` would hand app code our origin and let
        // it escape the sandbox entirely — it stays off, and the
        // opaque origin is why those assets are served with
        // `Access-Control-Allow-Origin: *`.
        //
        // The live dev server (§12.4) is a genuinely foreign origin
        // (`<port>-<sandbox>.e2b.app`), so `allow-same-origin` grants
        // it only ITS OWN origin, never ours. It is required there:
        // with an opaque origin, Vite's HMR socket and its
        // cross-origin module scripts do not work.
        // External record links open normal tabs. Keep the app itself isolated.
        sandbox={
          preview.mode === "dev"
            ? "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-same-origin"
            : "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        }
        style={{ border: 0, width: "100%", height: "100%" }}
      />
    </Box>
  ) : (
    <Box sx={{ p: 3, maxWidth: 560 }}>
      <Typography variant="subtitle1" gutterBottom>
        {appTitle ?? "App"}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          marginBottom: "16px",
        }}
      >
        Browse and edit this app&apos;s files from the Apps explorer on the left
        — every file opens in its own tab. Ask the agent in chat to build
        features (it works on your branch and commits every turn), or use the
        terminal below — it is a real machine with a real git checkout.
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
        }}
      >
        <strong>Start dev session</strong> runs the app live, so edits show up
        as you make them. <strong>Publish</strong> builds it and deploys — that
        is the version everyone else sees. A failed build publishes nothing and
        leaves the current version untouched.
      </Typography>
    </Box>
  );
}
